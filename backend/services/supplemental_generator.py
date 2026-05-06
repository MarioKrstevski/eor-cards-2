"""Generate vignettes and teaching cases for condition groups (grouped by leaf topic)."""
import re
import anthropic

FORMAT_INSTRUCTION = """FORMATTING: Output HTML only, not markdown. Use <b> for bold, <u> for underline, \
<i> for italic, <br> for line breaks. Do NOT use markdown syntax (**, *, #, backticks). \
The output will be rendered as HTML in a browser."""


def generate_supplemental_for_group(
    client: anthropic.Anthropic,
    condition_name: str,
    cards: list[dict],
    rules_text: str,
    model: str,
) -> tuple[str, str, dict]:
    """Generate a shared vignette + teaching case for a condition group.

    Args:
        condition_name: The leaf topic name (e.g., "Atrial Fibrillation")
        cards: List of card dicts with "card_number" and "front_text"
        rules_text: The combined vignette+teaching case rules
        model: Claude model to use

    Returns (vignette, teaching_case, usage_dict).
    """
    card_list = "\n".join(
        f"Card {c['card_number']}: {c['front_text']}"
        for c in cards
    )

    card_context = f"""Condition: {condition_name}
Cards for this condition:

{card_list}

Generate the vignette (COLUMN 5) and teaching case (COLUMN 6) for this condition following ALL the rules above.

Output format — use these exact markers:
===VIGNETTE===
(your vignette here)
===TEACHING_CASE===
(your teaching case here)"""

    response = client.messages.create(
        model=model,
        max_tokens=4096,
        temperature=0,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": FORMAT_INSTRUCTION + "\n\n" + rules_text, "cache_control": {"type": "ephemeral"}},
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

    vignette, teaching_case = _parse_output(raw)
    return vignette, teaching_case, usage


def _parse_output(raw: str) -> tuple[str, str]:
    """Parse the ===VIGNETTE=== / ===TEACHING_CASE=== markers from Claude's output."""
    vignette = ""
    teaching_case = ""

    vig_match = re.search(r'===VIGNETTE===(.*?)===TEACHING_CASE===', raw, re.DOTALL)
    tc_match = re.search(r'===TEACHING_CASE===(.*?)$', raw, re.DOTALL)

    if vig_match:
        vignette = vig_match.group(1).strip()
    if tc_match:
        teaching_case = tc_match.group(1).strip()

    # Fallback: if markers weren't used, try to split on "COLUMN 5" / "COLUMN 6"
    if not vignette and not teaching_case:
        col5 = re.search(r'COLUMN\s*5[:\s]*(.*?)(?:COLUMN\s*6|$)', raw, re.DOTALL | re.IGNORECASE)
        col6 = re.search(r'COLUMN\s*6[:\s]*(.*?)$', raw, re.DOTALL | re.IGNORECASE)
        if col5:
            vignette = col5.group(1).strip()
        if col6:
            teaching_case = col6.group(1).strip()

    # Last resort: put everything in teaching_case
    if not vignette and not teaching_case:
        teaching_case = raw

    return vignette, teaching_case
