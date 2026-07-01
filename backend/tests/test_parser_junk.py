"""parse_card_output must not glue trailing model prose / code fences into the
last card, while genuine wrapped extras still join."""
from backend.services.generator import parse_card_output


def test_trailing_fence_and_prose_not_glued():
    raw = (
        "1|{{c1::Aspirin}} inhibits COX|Extra fact here|source:P1\n"
        "```\n"
        "These cards cover the cardiology section.\n"
    )
    cards, needs_review = parse_card_output(raw)
    assert needs_review is False
    assert len(cards) == 1
    assert "These cards" not in cards[0]["front_html"]
    assert "```" not in cards[0]["front_html"]
    assert "These cards" not in (cards[0]["extra"] or "")
    assert "```" not in (cards[0]["extra"] or "")


def test_legit_multiline_extra_still_joins():
    raw = (
        "1|{{c1::Metoprolol}} is a beta blocker|First line of extra\n"
        "that wraps onto a second line|source:P2\n"
    )
    cards, _ = parse_card_output(raw)
    assert len(cards) == 1
    assert "wraps onto a second line" in cards[0]["extra"]
    assert cards[0]["source_ref"] == "P2"
