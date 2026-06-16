"""Parse pasted flashcard text (e.g. copied from a Claude-chat session) into
structured card fields using Haiku. The model ONLY restructures — it splits the
blob into cards and routes each piece into the right field. It must NOT rewrite,
summarize, correct, or otherwise change the wording the user pasted."""
from __future__ import annotations

import anthropic

from backend.config import resolve_model, effort_kwargs, DEFAULT_PROCESSING_MODEL
from backend.services.ai_utils import tool_use_input, usage_dict

PARSE_TOOL = {
    "name": "submit_cards",
    "description": "Return the pasted content split into individual flashcards, verbatim.",
    "input_schema": {
        "type": "object",
        "properties": {
            "cards": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "front_html": {
                            "type": "string",
                            "description": "The card front, exactly as pasted. Preserve any {{c1::...}} cloze markers and HTML. Do not change wording.",
                        },
                        "extra": {
                            "type": "string",
                            "description": "The extra/additional-context text for this card, verbatim. Empty string if none.",
                        },
                        "tags": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Any tags explicitly present in the pasted text for this card. Empty if none.",
                        },
                        "source_ref": {
                            "type": "string",
                            "description": "A source reference like P1-P3 if present in the paste, else empty string.",
                        },
                    },
                    "required": ["front_html", "extra", "tags", "source_ref"],
                },
            }
        },
        "required": ["cards"],
    },
}

_SYSTEM = (
    "You are a strict parser, not an editor. You receive raw text the user pasted "
    "that contains one or more flashcards in some format. Your only job is to split "
    "it into individual cards and route each piece of text into the correct field "
    "(front_html, extra, tags, source_ref). "
    "CRITICAL: copy the text VERBATIM. Do NOT reword, summarize, translate, fix "
    "grammar/spelling, add or remove cloze markers, or invent content. If a field "
    "is not present in the paste, return an empty string (or empty list for tags). "
    "Preserve existing {{c1::...}} cloze syntax and any HTML tags exactly as given."
)


def parse_pasted_cards(
    client: anthropic.Anthropic,
    raw_text: str,
    model: str = DEFAULT_PROCESSING_MODEL,
) -> tuple[list[dict], dict]:
    """Returns (cards, usage). Each card: {front_html, extra, tags, source_ref}."""
    response = client.messages.create(
        model=resolve_model(model)[0],
        **effort_kwargs(model),
        max_tokens=16384,
        temperature=0,
        system=[{"type": "text", "text": _SYSTEM}],
        tools=[PARSE_TOOL],
        tool_choice={"type": "tool", "name": "submit_cards"},
        messages=[{"role": "user", "content": f"Pasted content to parse:\n\n{raw_text}"}],
    )
    usage = usage_dict(response)
    payload = tool_use_input(response, "submit_cards")
    cards = payload.get("cards") or []
    # Keep only cards that actually have a front.
    cleaned = []
    for c in cards:
        front = (c.get("front_html") or "").strip()
        if not front:
            continue
        cleaned.append({
            "front_html": front,
            "extra": (c.get("extra") or "").strip() or None,
            "tags": [t for t in (c.get("tags") or []) if isinstance(t, str) and t.strip()],
            "source_ref": (c.get("source_ref") or "").strip() or None,
        })
    return cleaned, usage
