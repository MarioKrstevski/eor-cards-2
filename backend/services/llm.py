"""Provider dispatch for the ONE bulk card-generation call. Claude path is the
exact call generator.py used before; Gemini path is the only Google-aware code.
Output is plain text (pipe-delimited cards) — no structured/tool output here."""
from __future__ import annotations
import logging

import anthropic

try:
    from google import genai
    from google.genai import types as genai_types
    from google.genai import errors as genai_errors
except ModuleNotFoundError:  # installed in a later task; google branch unused until then
    genai = None
    genai_types = None
    genai_errors = None

from backend.config import (
    ANTHROPIC_API_KEY, GEMINI_API_KEY, provider_for, resolve_model, effort_kwargs,
)
from backend.services.ai_utils import usage_dict, RetryableError

logger = logging.getLogger(__name__)

# Hard per-call ceiling so a stalled/overloaded model fails in bounded time
# instead of pending up to the SDK default (~10 min). 300s comfortably covers a
# legitimate large generation while killing true hangs (the symptom behind
# "inspect debug-run pending forever").
_TIMEOUT_S = 300


def complete_text(model, system_text, user_text, *, temperature, max_tokens, timeout=_TIMEOUT_S):
    """Run one text completion. Returns (text, usage_dict, stop_reason).

    Does NOT raise on truncation — returns stop_reason == "max_tokens" and lets
    the caller decide (so generator.py keeps its retry-then-raise behavior).
    Transient errors are raised as RetryableError so the existing retry loop
    catches them regardless of provider. `timeout` (seconds) caps a single call;
    interactive callers (inspect) pass a shorter one so a stalled model fails fast.
    """
    if provider_for(model) == "google":
        return _complete_google(model, system_text, user_text, temperature, max_tokens, timeout)
    return _complete_anthropic(model, system_text, user_text, temperature, max_tokens, timeout)


def _complete_anthropic(model, system_text, user_text, temperature, max_tokens, timeout=_TIMEOUT_S):
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY, timeout=timeout)
    response = client.messages.create(
        model=resolve_model(model)[0],
        **effort_kwargs(model),
        max_tokens=max_tokens,
        temperature=temperature,
        system=[{
            "type": "text",
            "text": system_text,
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{"role": "user", "content": user_text}],
    )
    text = next((b.text for b in response.content if b.type == "text"), "")
    return text, usage_dict(response), response.stop_reason


def _google_client(timeout=_TIMEOUT_S):
    """A genai client with the SDK's internal retry DISABLED (attempts=1) so a
    transient 503 fails fast and our own retry loop (generate.py) controls the
    backoff cadence, plus a hard request timeout so a stalled call can't pend
    forever. Without attempts=1 the SDK silently retries ~30-60s per call."""
    http_options = None
    try:
        http_options = genai_types.HttpOptions(
            retry_options=genai_types.HttpRetryOptions(attempts=1),
            timeout=int(timeout * 1000),  # google-genai timeout is in milliseconds
        )
    except Exception:  # older/newer SDK without these fields — fall back to default
        http_options = None
    if http_options is not None:
        return genai.Client(api_key=GEMINI_API_KEY, http_options=http_options)
    return genai.Client(api_key=GEMINI_API_KEY)


def _complete_google(model, system_text, user_text, temperature, max_tokens, timeout=_TIMEOUT_S):
    if genai is None:
        raise RuntimeError("google-genai not installed")
    client = _google_client(timeout)
    base = resolve_model(model)[0]
    try:
        response = client.models.generate_content(
            model=base,
            contents=user_text,
            config=genai_types.GenerateContentConfig(
                system_instruction=system_text,
                temperature=temperature,
                max_output_tokens=max_tokens,
            ),
        )
    except genai_errors.APIError as e:
        code = getattr(e, "code", None) or getattr(e, "status_code", None)
        if code in (429, 500, 502, 503, 504, 529):
            raise RetryableError(f"Gemini transient error {code}: {e}") from e
        raise

    finish = ""
    if getattr(response, "candidates", None):
        finish = str(getattr(response.candidates[0], "finish_reason", "") or "")
    stop_reason = "max_tokens" if "MAX_TOKENS" in finish.upper() else "end_turn"

    um = getattr(response, "usage_metadata", None)
    usage = {
        "input_tokens": getattr(um, "prompt_token_count", 0) or 0,
        "output_tokens": getattr(um, "candidates_token_count", 0) or 0,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
    }
    # `response.text` is a convenience accessor that, in recent google-genai
    # versions, can raise/warn when the candidate was truncated or blocked
    # (empty parts). Access it defensively so a truncated Gemini result still
    # returns partial text + stop_reason rather than throwing.
    try:
        text = response.text or ""
    except Exception:
        parts = []
        for c in (getattr(response, "candidates", None) or []):
            for p in (getattr(getattr(c, "content", None), "parts", None) or []):
                t = getattr(p, "text", None)
                if t:
                    parts.append(t)
        text = "".join(parts)
    return text, usage, stop_reason
