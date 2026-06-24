"""Shared helpers for Anthropic API calls: retries, response extraction, parsing."""
import json
import re
import logging
import anthropic

logger = logging.getLogger(__name__)


class RetryableError(Exception):
    """Provider-agnostic transient error. The Gemini path in llm.py re-raises
    Google's transient (429/5xx/connection) errors as this so the existing
    RETRYABLE_ERRORS retry loop catches them without importing google SDK
    error classes into Anthropic call sites."""


# 429 rate limit, connection/timeout errors, and 5xx (includes 529 overloaded)
RETRYABLE_ERRORS = (
    anthropic.RateLimitError,
    anthropic.APIConnectionError,
    anthropic.InternalServerError,
    RetryableError,
)

# Cloze with optional Anki hint: {{c1::term}} or {{c1::term::hint}} -> term
CLOZE_RE = re.compile(r'\{\{c\d+::(.*?)(?:::[^}]*?)?\}\}')


class OutputTruncated(Exception):
    """The model hit max_tokens — output is incomplete and must not be committed."""


def strip_cloze(text: str) -> str:
    """Remove cloze markup, keeping the visible term (drops hints)."""
    return CLOZE_RE.sub(r'\1', text)


def response_text(response) -> str:
    """Extract the text from a response, raising on truncation or empty content."""
    if response.stop_reason == "max_tokens":
        raise OutputTruncated(
            f"Model output truncated at max_tokens — refusing partial result"
        )
    text = next((b.text for b in response.content if b.type == "text"), "")
    return text.strip()


def tool_use_input(response, tool_name: str) -> dict:
    """Return the input dict from a forced tool call, raising on truncation/absence.

    Used with tool_choice={"type":"tool",...} so the model returns structured
    data the API guarantees is valid JSON — no hand-written escaping to mangle.
    """
    if response.stop_reason == "max_tokens":
        raise OutputTruncated(
            "Tool output truncated at max_tokens — refusing partial result"
        )
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and block.name == tool_name:
            return block.input
    raise ValueError(f"Model did not call expected tool '{tool_name}'")


def usage_dict(response) -> dict:
    return {
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "cache_read_input_tokens": getattr(response.usage, "cache_read_input_tokens", 0) or 0,
        "cache_creation_input_tokens": getattr(response.usage, "cache_creation_input_tokens", 0) or 0,
    }


def parse_json_array(raw: str):
    """Parse a JSON array from model output, tolerating code fences and surrounding text.

    Returns the list, or None if no valid array could be extracted.
    """
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r'^```(?:json)?\s*', '', cleaned)
        cleaned = re.sub(r'\s*```$', '', cleaned)

    try:
        result = json.loads(cleaned)
        if isinstance(result, list):
            return result
    except json.JSONDecodeError:
        pass

    match = re.search(r'\[.*\]', cleaned, re.DOTALL)
    if match:
        try:
            result = json.loads(match.group())
            if isinstance(result, list):
                return result
        except json.JSONDecodeError:
            pass
    return None
