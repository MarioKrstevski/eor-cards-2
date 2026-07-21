"""Lab / edit-history endpoints (silent learning feature).

Reads and appends to the SEPARATE history tables (GenerationSnapshot, EditEvent,
SectionFinalization). None of these touch the Card table's operational fields —
they only record what happened. Mounted at /api/lab (no trailing slash).
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.db import get_db
from backend.models import (
    Card, CardStatus, EditEvent, GenerationSnapshot, Section,
    SectionFinalization, utcnow,
)
from backend.services import capture

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Append events ─────────────────────────────────────────────────────────────
class EventIn(BaseModel):
    kind: str
    field: Optional[str] = None
    front_html: Optional[str] = None
    extra: Optional[str] = None
    meta: Optional[dict] = None


class EventsBody(BaseModel):
    section_id: int
    card_id: int
    events: list[EventIn]


@router.post("/events")
def append_events(body: EventsBody, db: Session = Depends(get_db)):
    """Append edit events for a card, each with the next per-card seq."""
    seq = capture._next_seq_value(db, body.card_id)
    saved = 0
    for ev in body.events:
        db.add(EditEvent(
            section_id=body.section_id,
            card_id=body.card_id,
            seq=seq,
            kind=ev.kind,
            field=ev.field,
            front_html=ev.front_html,
            extra=ev.extra,
            meta=ev.meta,
        ))
        seq += 1
        saved += 1
    db.commit()
    return {"saved": saved}


# ── Per-card history ──────────────────────────────────────────────────────────
@router.get("/card/{card_id}/history")
def card_history(card_id: int, db: Session = Depends(get_db)):
    """Ordered edit events for one card (seq asc)."""
    events = (
        db.query(EditEvent)
        .filter(EditEvent.card_id == card_id)
        .order_by(EditEvent.seq.asc(), EditEvent.id.asc())
        .all()
    )
    return [
        {
            "seq": e.seq,
            "kind": e.kind,
            "field": e.field,
            "front_html": e.front_html,
            "extra": e.extra,
            "meta": e.meta,
            "created_at": e.created_at.isoformat() if e.created_at else None,
        }
        for e in events
    ]


@router.delete("/card/{card_id}/history")
def delete_card_history_after(card_id: int, after_seq: int, db: Session = Depends(get_db)):
    """Delete a card's edit events with seq > after_seq. Used by the History
    panel's "restore and discard newer edits": the restored version becomes the
    latest, and the events made after it are gone for good."""
    deleted = (
        db.query(EditEvent)
        .filter(EditEvent.card_id == card_id, EditEvent.seq > after_seq)
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"deleted": deleted}


# ── Finalize a section ────────────────────────────────────────────────────────
@router.post("/finalize/{section_id}")
def finalize_section(section_id: int, db: Session = Depends(get_db)):
    """Snapshot the section's current ACTIVE cards into a SectionFinalization."""
    section = db.get(Section, section_id)
    if not section:
        raise HTTPException(404, "Section not found")
    cards = (
        db.query(Card)
        .filter(Card.section_id == section_id, Card.status == CardStatus.active)
        .order_by(Card.card_number, Card.id)
        .all()
    )
    cards_json = [
        {
            "card_id": c.id,
            "card_number": c.card_number,
            "front_html": c.front_html,
            "extra": c.extra,
        }
        for c in cards
    ]
    fin = SectionFinalization(
        section_id=section_id,
        cards_json=cards_json,
        loop_status="pending",
    )
    db.add(fin)
    db.commit()
    db.refresh(fin)
    return {
        "id": fin.id,
        "section_id": fin.section_id,
        "loop_status": fin.loop_status,
        "card_count": len(cards_json),
        "cards_json": fin.cards_json,
        "created_at": fin.created_at.isoformat() if fin.created_at else None,
        "finished_at": fin.finished_at.isoformat() if fin.finished_at else None,
    }


# ── List finalizations (for the /admin list) ─────────────────────────────────
@router.get("/sections")
def list_finalizations(db: Session = Depends(get_db)):
    """SectionFinalizations joined with section heading + card count, newest first."""
    rows = (
        db.query(SectionFinalization, Section.heading)
        .outerjoin(Section, Section.id == SectionFinalization.section_id)
        .order_by(SectionFinalization.created_at.desc(), SectionFinalization.id.desc())
        .all()
    )
    out = []
    for fin, heading in rows:
        card_count = len(fin.cards_json or [])
        out.append({
            "id": fin.id,
            "section_id": fin.section_id,
            "section_heading": heading,
            "card_count": card_count,
            "loop_status": fin.loop_status,
            "created_at": fin.created_at.isoformat() if fin.created_at else None,
            "finished_at": fin.finished_at.isoformat() if fin.finished_at else None,
        })
    return out


# ── Section detail (for the /admin detail view) ──────────────────────────────
@router.get("/section/{section_id}")
def section_detail(section_id: int, db: Session = Depends(get_db)):
    """Latest generation snapshot, all edit events grouped by card, latest
    finalization for a section."""
    section = db.get(Section, section_id)

    latest_snap = (
        db.query(GenerationSnapshot)
        .filter(GenerationSnapshot.section_id == section_id)
        .order_by(GenerationSnapshot.created_at.desc(), GenerationSnapshot.id.desc())
        .first()
    )
    snapshot = None
    if latest_snap:
        snapshot = {
            "id": latest_snap.id,
            "rule_set_id": latest_snap.rule_set_id,
            "model": latest_snap.model,
            "card_version": latest_snap.card_version,
            "cards_json": latest_snap.cards_json,
            "created_at": latest_snap.created_at.isoformat() if latest_snap.created_at else None,
        }

    events = (
        db.query(EditEvent)
        .filter(EditEvent.section_id == section_id)
        .order_by(EditEvent.card_id.asc(), EditEvent.seq.asc(), EditEvent.id.asc())
        .all()
    )
    events_by_card: dict[str, list] = {}
    for e in events:
        key = str(e.card_id)
        events_by_card.setdefault(key, []).append({
            "seq": e.seq,
            "kind": e.kind,
            "field": e.field,
            "front_html": e.front_html,
            "extra": e.extra,
            "meta": e.meta,
            "created_at": e.created_at.isoformat() if e.created_at else None,
        })

    latest_fin = (
        db.query(SectionFinalization)
        .filter(SectionFinalization.section_id == section_id)
        .order_by(SectionFinalization.created_at.desc(), SectionFinalization.id.desc())
        .first()
    )
    finalization = None
    if latest_fin:
        finalization = {
            "id": latest_fin.id,
            "loop_status": latest_fin.loop_status,
            "cards_json": latest_fin.cards_json,
            "created_at": latest_fin.created_at.isoformat() if latest_fin.created_at else None,
            "finished_at": latest_fin.finished_at.isoformat() if latest_fin.finished_at else None,
        }

    return {
        "section_id": section_id,
        "section_heading": section.heading if section else None,
        "latest_snapshot": snapshot,
        "events_by_card": events_by_card,
        "latest_finalization": finalization,
    }


# ── Start the tuning loop (SCAFFOLD only) ────────────────────────────────────
@router.post("/finalizations/{finalization_id}/start")
def start_loop(finalization_id: int, db: Session = Depends(get_db)):
    """Flip loop_status to 'running'. The actual tuning loop is a later phase."""
    fin = db.get(SectionFinalization, finalization_id)
    if not fin:
        raise HTTPException(404, "Finalization not found")
    fin.loop_status = "running"
    db.commit()
    db.refresh(fin)
    return {
        "id": fin.id,
        "section_id": fin.section_id,
        "loop_status": fin.loop_status,
    }
