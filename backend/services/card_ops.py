"""Shared helpers for cards created outside the main generation job
(split / combine): unique note ids + an accuracy/EOR-yield score pass."""
import logging
import time

import anthropic
from sqlalchemy.orm import Session

from backend.models import Card
from backend.services.scorer import score_cards

logger = logging.getLogger(__name__)


def assign_note_ids(cards: list[Card]) -> None:
    """Give each card a unique note_id (millisecond base + index), matching how
    the generation pipeline mints them. Skips cards that already have one."""
    base = int(time.time() * 1000)
    # Seed past any existing note_id so a same-millisecond mint (or a clock that
    # ran ahead when older ids were created) can't collide with stored ids.
    db = Session.object_session(cards[0]) if cards else None
    if db is not None:
        from sqlalchemy import func
        base = max(base, (db.query(func.max(Card.note_id)).scalar() or 0) + 1)
    for i, c in enumerate(cards):
        if c.note_id is None:
            c.note_id = base + i


def score_new_cards(
    db: Session,
    client: anthropic.Anthropic,
    cards: list[Card],
    curriculum_path: str,
    model: str,
) -> None:
    """Best-effort accuracy + EOR-yield scoring for freshly created cards. Cards
    must already be flushed (have ids). Failures are logged, never raised."""
    cards = [c for c in cards if c.id is not None]
    if not cards:
        return
    try:
        payload = [{"id": c.id, "front_text": c.front_text, "extra": c.extra} for c in cards]
        scores, _usage = score_cards(client, payload, curriculum_path or "", model)
        by_id = {c.id: c for c in cards}
        for s in scores:
            c = by_id.get(s.get("card_id"))
            if c:
                c.accuracy_score = s.get("accuracy")
                c.accuracy_note = s.get("accuracy_note")
                c.eor_yield = s.get("eor_yield")
        db.commit()
    except Exception:
        logger.exception("Scoring new (split/combine) cards failed")
