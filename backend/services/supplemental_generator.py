"""Generate vignettes and teaching cases for condition groups (grouped by leaf topic)."""
import json
import re
import logging
import anthropic
from backend.services.ai_utils import parse_json_array, response_text, usage_dict, strip_cloze as _strip_cloze

logger = logging.getLogger(__name__)


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

    raw = response_text(response)
    usage = usage_dict(response)

    results = _parse_json_output(raw, cards)

    # Drop hallucinated/transposed IDs — only update cards actually in this group
    sent_ids = {c["id"] for c in cards}
    for r in results:
        cr_ids = r.get("card_ids") or []
        valid_ids = [i for i in cr_ids if i in sent_ids]
        if len(valid_ids) < len(cr_ids):
            logger.warning(
                "Condition '%s': dropped %d card ID(s) not in this group",
                r.get("condition", "?"), len(cr_ids) - len(valid_ids),
            )
        r["card_ids"] = valid_ids

    return results, usage


def _parse_json_output(raw: str, cards: list[dict]) -> list[dict]:
    """Parse the JSON array from Claude's output. Raises ValueError if unparseable."""
    results = parse_json_array(raw)
    if results is not None:
        return results

    # Fallback: fix unescaped newlines inside strings, then re-parse
    try:
        fixed = re.sub(r'(?<=": ")(.*?)(?="[,\}])', lambda m: m.group(0).replace('\n', '<br>'), raw.strip(), flags=re.DOTALL)
        results = json.loads(fixed)
        if isinstance(results, list):
            return results
    except json.JSONDecodeError:
        pass

    # Last resort: marker-based parsing — only safe when there is a SINGLE block,
    # since markers carry no card IDs. With multiple conditions we cannot know
    # which cards belong to which block; assigning blindly would attach wrong
    # medical content, so fail loud instead.
    blocks = re.split(r'===VIGNETTE===', raw)[1:]
    if len(blocks) == 1:
        tc_split = blocks[0].split('===TEACHING_CASE===', 1)
        vignette = tc_split[0].strip()
        teaching_case = tc_split[1].strip() if len(tc_split) > 1 else ""
        if vignette or teaching_case:
            logger.warning("JSON parse failed, recovered single condition via markers")
            return [{
                "condition": "Parsed",
                "card_ids": [c["id"] for c in cards],
                "vignette": vignette,
                "teaching_case": teaching_case,
            }]

    logger.error("Supplemental output unparseable. First 200 chars: %.200s", raw)
    raise ValueError("Could not parse supplemental output — no cards were updated")
