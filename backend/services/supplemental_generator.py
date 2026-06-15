"""Generate vignettes and teaching cases for condition groups (grouped by leaf topic)."""
import logging
import anthropic
from backend.services.ai_utils import tool_use_input, usage_dict, strip_cloze as _strip_cloze
from backend.config import resolve_model, effort_kwargs

logger = logging.getLogger(__name__)

# Transport is owned by the system via this tool schema — NOT by the rules text.
# The client's prompt governs only the CONTENT and HTML of each field; whatever
# output-format instructions she pastes are inert because the model returns
# structured data through this tool (no hand-written JSON to mangle).
SUPPLEMENTAL_TOOL = {
    "name": "submit_supplementals",
    "description": "Return the vignette and teaching case for each condition group.",
    "input_schema": {
        "type": "object",
        "properties": {
            "conditions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "condition": {"type": "string", "description": "Condition or topic name"},
                        "card_ids": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "description": "The exact card ids (from the provided list) this content covers",
                        },
                        "vignette": {"type": "string", "description": "HTML using only b, u, i, br tags, per the rules"},
                        "teaching_case": {"type": "string", "description": "HTML using only b, u, i, br tags, per the rules"},
                    },
                    "required": ["condition", "card_ids", "vignette", "teaching_case"],
                },
            }
        },
        "required": ["conditions"],
    },
}

_TRANSPORT_INSTRUCTION = (
    "Return your result ONLY by calling the submit_supplementals tool. "
    "The rules above govern the CONTENT and the HTML formatting of each vignette and teaching_case field. "
    "Ignore any instructions in the rules about overall output format, delimiters, or labels "
    "(e.g. 'OUTPUT FORMAT', 'Condition:', 'VIGNETTE:', 'TEACHING CASE:') — the tool replaces all of that. "
    "Each vignette and teaching_case must contain HTML using only <b>, <u>, <i>, and <br> tags. "
    "Never include cloze syntax ({{c1::...}}) anywhere in the output."
)


def generate_supplemental_for_group(
    client: anthropic.Anthropic,
    topic_name: str,
    cards: list[dict],
    rules_text: str,
    model: str,
) -> tuple[list[dict], dict]:
    """Generate vignettes + teaching cases for cards in a topic group.

    The AI groups the cards by condition and returns, via a forced tool call,
    one vignette + teaching case per condition tagged with the covered card ids.

    Args:
        topic_name: The full curriculum tag path for this group
            (e.g., "Neurology > Headache Disorders > Headaches")
        cards: List of card dicts with "id", "card_number", and "front_text"
        rules_text: The client's vignette + teaching case rules (content/style only)
        model: Claude model to use

    Returns (condition_results, usage_dict) where condition_results is a list of
    dicts with keys: condition, card_ids, vignette, teaching_case.
    """
    card_list = "\n".join(
        f"Card (id:{c['id']}): {_strip_cloze(c['front_text'])}"
        for c in cards
    )

    card_context = f"""Curriculum topic path: {topic_name}
(The cards below all come from this topic; use the path to understand the clinical domain.)

Cards:

{card_list}

Read every card. Identify each unique condition. Group cards by condition.
For each condition, fill the vignette and teaching_case following ALL the rules in the system prompt,
and put the exact card ids you were given (the id: values above) into card_ids."""

    response = client.messages.create(
        model=resolve_model(model)[0],
        **effort_kwargs(model),
        # 16384 is the ceiling the SDK accepts for non-streaming requests;
        # anything higher raises "Streaming is required..." before the call.
        max_tokens=16384,
        temperature=0,
        system=[
            {"type": "text", "text": rules_text, "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": _TRANSPORT_INSTRUCTION},
        ],
        tools=[SUPPLEMENTAL_TOOL],
        tool_choice={"type": "tool", "name": "submit_supplementals"},
        messages=[{"role": "user", "content": card_context}],
    )

    usage = usage_dict(response)
    payload = tool_use_input(response, "submit_supplementals")
    results = payload.get("conditions") or []

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
