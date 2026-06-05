"""Generate vignettes and teaching cases for condition groups (grouped by leaf topic)."""
import json
import re
import logging
import anthropic

logger = logging.getLogger(__name__)


def _strip_cloze(text: str) -> str:
    """Remove cloze deletion markup, keeping the visible term. {{c1::term}} -> term"""
    return re.sub(r'\{\{c\d+::(.*?)\}\}', r'\1', text)


def generate_supplemental_for_group(
    client: anthropic.Anthropic,
    topic_name: str,
    cards: list[dict],
    rules_text: str,
    model: str,
) -> tuple[list[dict], dict]:
    """Generate vignettes + teaching cases for cards in a topic group.

    The AI identifies conditions within the cards, groups them, and returns
    a JSON array with vignette + teaching case per condition, tagged with card IDs.

    Args:
        topic_name: The leaf topic name (e.g., "Prenatal Care/Pregnancy")
        cards: List of card dicts with "id", "card_number", and "front_text"
        rules_text: The combined vignette+teaching case rules
        model: Claude model to use

    Returns (condition_results, usage_dict) where condition_results is a list of
    dicts with keys: condition, card_ids, vignette, teaching_case.
    """
    card_list = "\n".join(
        f"Card (id:{c['id']}): {_strip_cloze(c['front_text'])}"
        for c in cards
    )

    card_context = f"""Topic: {topic_name}
Cards:

{card_list}

Read every card. Identify each unique condition. Group cards by condition.
For each condition, generate the vignette (COLUMN 5) and teaching case (COLUMN 6) following ALL the rules above.

CRITICAL OUTPUT RULES:
- Output ONLY valid JSON — no text before or after the JSON array.
- Use HTML tags (<b>, <br>, <i>, <u>) inside string values. NO markdown (**bold**, #headers).
- Do NOT include cloze syntax ({{{{c1::}}}} or similar) anywhere in the output.
- Escape quotes inside strings properly.

Output a JSON array with this exact structure:
[
  {{
    "condition": "Condition Name",
    "card_ids": [12, 34, 56],
    "vignette": "<b>You are seeing...</b> ...",
    "teaching_case": "<b><u>Patient Presentation</u></b><br>..."
  }}
]"""

    response = client.messages.create(
        model=model,
        max_tokens=16384,
        temperature=0,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": rules_text, "cache_control": {"type": "ephemeral"}},
                    {"type": "text", "text": card_context},
                ],
            }
        ],
    )

    raw = response.content[0].text.strip()
    usage = {
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "cache_read_input_tokens": getattr(response.usage, "cache_read_input_tokens", 0) or 0,
        "cache_creation_input_tokens": getattr(response.usage, "cache_creation_input_tokens", 0) or 0,
    }

    results = _parse_json_output(raw, cards)
    return results, usage


def _parse_json_output(raw: str, cards: list[dict]) -> list[dict]:
    """Parse the JSON array from Claude's output."""
    # Strip markdown code fences if present
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r'^```(?:json)?\s*', '', cleaned)
        cleaned = re.sub(r'\s*```$', '', cleaned)

    try:
        results = json.loads(cleaned)
        if isinstance(results, list):
            return results
    except json.JSONDecodeError:
        logger.warning("Failed to parse supplemental JSON output, attempting extraction")

    # Fallback: try to extract JSON array from the text
    match = re.search(r'\[.*\]', cleaned, re.DOTALL)
    if match:
        try:
            results = json.loads(match.group())
            if isinstance(results, list):
                return results
        except json.JSONDecodeError:
            pass

    # Last resort: treat entire output as one condition for all cards
    logger.warning("Could not parse supplemental output as JSON, using fallback")
    all_ids = [c["id"] for c in cards]
    return [{
        "condition": "Unknown",
        "card_ids": all_ids,
        "vignette": raw,
        "teaching_case": "",
    }]
