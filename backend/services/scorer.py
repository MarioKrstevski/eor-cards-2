"""Score cards for medical accuracy and PA EOR exam yield."""
import logging
import anthropic
from backend.services.ai_utils import parse_json_array, response_text, usage_dict

logger = logging.getLogger(__name__)

SCORING_SYSTEM_PROMPT = """You are a PAEA End of Rotation (EOR) exam scoring specialist for physician assistant students.

ACCURACY (1-5):
5: Completely accurate; reflects current clinical guidelines and PA practice
4: Accurate with minor imprecision (acceptable simplification for a flashcard)
3: Mostly accurate but contains a notable oversimplification that could mislead
2: Contains a factual error that could lead to a wrong exam answer
1: Fundamentally inaccurate or dangerously misleading

EOR YIELD (Gold / Silver / Bronze / Skip):
Gold: Core concept tested repeatedly; knowing this directly changes answer selection
Silver: Tested intermittently; important supporting knowledge
Bronze: Rarely tested directly; usually inferable from other knowledge
Skip: Extremely unlikely to appear on this rotation's EOR exam

ROTATIONS (score ONLY relevant ones, omit irrelevant):
Internal Medicine, Surgery, Emergency Medicine, Pediatrics, Women's Health, Psychiatry/Behavioral Health, Family Medicine

SCORING DISCIPLINE:
- Do NOT inflate. "Good to know" does not equal Gold.
- Pure memorization without clinical application: downgrade.
- Narrow exceptions, rare syndromes, esoteric detail: downgrade.
- Judge by: "How often does knowing THIS fact change which answer a PA student selects on the actual EOR exam?"
- Consider PA scope of practice.

ACCURACY NOTES:
- If accuracy < 5, explain what is imprecise or wrong (1 sentence).
- If accuracy = 5, say "Accurate"."""


def score_cards(
    client: anthropic.Anthropic,
    cards: list,
    curriculum_path: str,
    model: str,
) -> tuple:
    """Score a batch of cards for accuracy and EOR yield.

    Args:
        client: Anthropic client
        cards: List of dicts with "id" and "front_text" (and optionally "extra")
        curriculum_path: The curriculum topic path for context
        model: Claude model to use

    Returns (scores, usage) where scores is a list of dicts with
    card_id, accuracy, accuracy_note, eor_yield.
    """
    def card_line(c):
        line = f"Card {c['id']}: {c['front_text']}"
        if c.get('extra'):
            line += f" | Extra: {c['extra']}"
        return line

    card_lines = "\n".join(card_line(c) for c in cards)

    user_message = f"""Score these cards for accuracy and PAEA EOR yield. Judge both the card text and its Extra content.
Curriculum path: {curriculum_path or 'General'}

{card_lines}

Return a JSON array only. One object per card, same order. No text outside the JSON.
[{{"card_id": 123, "accuracy": 5, "accuracy_note": "Accurate", "eor_yield": {{"Internal Medicine": "Gold"}}}}]"""

    response = client.messages.create(
        model=model,
        max_tokens=8192,
        temperature=0,
        system=SCORING_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
    )

    raw = response_text(response)
    scores = parse_json_array(raw)
    if scores is None:
        raise ValueError("Could not parse scoring output as JSON")

    # Drop hallucinated/transposed IDs — only accept scores for cards we sent
    sent_ids = {c["id"] for c in cards}
    valid = [s for s in scores if s.get("card_id") in sent_ids]
    if len(valid) < len(scores):
        logger.warning("Dropped %d score(s) with unknown card IDs", len(scores) - len(valid))

    return valid, usage_dict(response)
