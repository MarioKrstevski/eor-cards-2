import re
from pathlib import Path

CARDS = Path("backend/routers/cards.py").read_text()


def test_body_model_only_appears_coerced():
    """Every `body.model` use must be wrapped in anthropic_model(...).
    The one allowed bare use is `body.model_fields_set` (a pydantic attr, not
    the model id)."""
    text = CARDS
    text = text.replace("anthropic_model(body.model)", "")
    text = re.sub(r"body\.model_fields_set", "", text)
    leftover = re.findall(r"body\.model\b", text)
    assert leftover == [], (
        f"{len(leftover)} un-coerced `body.model` use(s) remain in cards.py — "
        "wrap each in anthropic_model(...)"
    )
