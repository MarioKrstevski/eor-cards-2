"""Silent edit-history capture layer.

Every public helper here is wrapped so a failure LOGS and returns without
raising — capture must NEVER break a card operation. Callers hook these after
their own commit; if capture throws, the card op has already succeeded and the
exception is swallowed here.

These write only to the SEPARATE history tables (GenerationSnapshot, EditEvent,
SectionFinalization) and never touch the Card table.
"""
from __future__ import annotations

import functools
import logging

from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.models import Card, EditEvent, GenerationSnapshot

logger = logging.getLogger(__name__)


def _safe(fn):
    """Wrap a capture helper so any exception is logged and swallowed.

    On failure we also try to roll back the session so a poisoned transaction
    doesn't spill into the caller's next commit. The rollback itself is guarded.
    """
    @functools.wraps(fn)
    def wrapper(db: Session, *args, **kwargs):
        try:
            return fn(db, *args, **kwargs)
        except Exception:
            logger.exception("capture.%s failed (swallowed)", fn.__name__)
            try:
                db.rollback()
            except Exception:
                logger.exception("capture.%s rollback failed (swallowed)", fn.__name__)
            return None
    return wrapper


def _next_seq_value(db: Session, card_id) -> int:
    """Highest existing seq for a card + 1 (0 if none). Not error-wrapped —
    callers are inside _safe helpers, so a failure here bubbles up and is
    swallowed there."""
    if card_id is None:
        return 0
    current = (
        db.query(func.max(EditEvent.seq))
        .filter(EditEvent.card_id == card_id)
        .scalar()
    )
    return 0 if current is None else current + 1


@_safe
def next_seq(db: Session, card_id) -> int:
    """Public, error-safe next-seq lookup (returns None on failure)."""
    return _next_seq_value(db, card_id)


def _card_front_extra(card: Card) -> tuple[str, str | None]:
    return (getattr(card, "front_html", "") or ""), getattr(card, "extra", None)


@_safe
def record_generation(db, section_id, rule_set_id, model, card_version, cards):
    """Write a GenerationSnapshot plus one `origin_generated` EditEvent per card.

    `cards` is a list of Card ORM objects that were just committed. Each card's
    initial front/extra is recorded at seq 0.
    """
    snap_cards = []
    for c in cards:
        front, extra = _card_front_extra(c)
        snap_cards.append({
            "card_number": getattr(c, "card_number", None),
            "front_html": front,
            "extra": extra,
        })

    db.add(GenerationSnapshot(
        section_id=section_id,
        rule_set_id=rule_set_id,
        model=model,
        card_version=card_version,
        cards_json=snap_cards,
    ))

    for c in cards:
        front, extra = _card_front_extra(c)
        db.add(EditEvent(
            section_id=section_id,
            card_id=getattr(c, "id", None),
            seq=0,  # origin
            kind="origin_generated",
            field="both",
            front_html=front,
            extra=extra,
            meta={
                "rule_set_id": rule_set_id,
                "model": model,
                "card_version": card_version,
            },
        ))
    db.commit()


@_safe
def record_origin(db, card: Card, kind: str, meta=None):
    """Write one origin EditEvent (origin_manual/origin_split/origin_combine) for
    a newly created card at seq 0, capturing its current front/extra."""
    front, extra = _card_front_extra(card)
    db.add(EditEvent(
        section_id=getattr(card, "section_id", None),
        card_id=getattr(card, "id", None),
        seq=0,  # origin
        kind=kind,
        field="both",
        front_html=front,
        extra=extra,
        meta=meta,
    ))
    db.commit()
