import re
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional
import anthropic
from backend.db import get_db
from backend.models import Card, FixBatch, FixProposal, ReviewMarkType, CardStatus, Section, utcnow
from backend.services.fix_service import run_fix_batch
from backend.services.card_ops import assign_note_ids, score_new_cards
from backend.config import ANTHROPIC_API_KEY

router = APIRouter()


class CreateBatchRequest(BaseModel):
    mark_type_id: Optional[int] = None  # None = in-place run on the given card_ids (e.g. regenerate→split), no mark required
    card_ids: list[int]
    prompt: str
    model: str


class UpdateProposalRequest(BaseModel):
    reviewer_action: str  # edit/keep/delete/split


class ConfirmBatchRequest(BaseModel):
    proposal_ids: Optional[list[int]] = None  # None = confirm all resolved
    keep_original: bool = False  # on split, keep the original card instead of rejecting it


class RerunBatchRequest(BaseModel):
    prompt: str


def proposal_dict(p: FixProposal, include_original: bool = True) -> dict:
    d = {
        "id": p.id,
        "batch_id": p.batch_id,
        "original_card_id": p.original_card_id,
        "ai_action": p.ai_action,
        "proposed_front_html": p.proposed_front_html,
        "proposed_extra": p.proposed_extra,
        "new_cards_json": p.new_cards_json,
        "reviewer_action": p.reviewer_action,
        "is_resolved": p.is_resolved,
    }
    if include_original and p.original_card:
        d["original_front_html"] = p.original_card.front_html
        d["original_extra"] = p.original_card.extra
        d["original_tags"] = p.original_card.tags
        d["original_section_id"] = p.original_card.section_id
        d["in_fix_batch"] = p.original_card.in_fix_batch
    return d


def batch_dict(b: FixBatch, include_proposals: bool = False) -> dict:
    d = {
        "id": b.id,
        "mark_type_id": b.mark_type_id,
        "mark_type_name": b.mark_type.name if b.mark_type else None,
        "mark_type_color": b.mark_type.color if b.mark_type else None,
        "prompt": b.prompt,
        "model": b.model,
        "status": b.status,
        "total_cards": b.total_cards,
        "processed_cards": b.processed_cards,
        "error_message": b.error_message,
        "created_at": b.created_at.isoformat() if b.created_at else None,
        "finished_at": b.finished_at.isoformat() if b.finished_at else None,
    }
    if include_proposals:
        d["proposals"] = [proposal_dict(p) for p in (b.proposals or [])]
    return d


@router.get("")
def list_batches(db: Session = Depends(get_db)):
    batches = (
        db.query(FixBatch)
        .options(joinedload(FixBatch.mark_type))
        .order_by(FixBatch.created_at.desc())
        .all()
    )
    return [batch_dict(b) for b in batches]


@router.get("/{batch_id}")
def get_batch(batch_id: int, db: Session = Depends(get_db)):
    batch = (
        db.query(FixBatch)
        .options(
            joinedload(FixBatch.mark_type),
            joinedload(FixBatch.proposals).joinedload(FixProposal.original_card),
        )
        .filter(FixBatch.id == batch_id)
        .first()
    )
    if not batch:
        raise HTTPException(404)
    return batch_dict(batch, include_proposals=True)


@router.post("")
def create_batch(body: CreateBatchRequest, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    if body.mark_type_id is not None:
        # Mark-driven flow: validate the mark and only take cards carrying it.
        mark_type = db.get(ReviewMarkType, body.mark_type_id)
        if not mark_type:
            raise HTTPException(404, "Mark type not found")
        cards = db.query(Card).filter(
            Card.id.in_(body.card_ids),
            Card.review_mark_id == body.mark_type_id,
        ).all()
        if not cards:
            raise HTTPException(422, "No valid cards found with this mark type")
    else:
        # In-place flow (regenerate → split / combine): run on the given cards directly.
        cards = db.query(Card).filter(Card.id.in_(body.card_ids)).all()
        if not cards:
            raise HTTPException(422, "No valid cards found")

    card_ids = [c.id for c in cards]

    # Create batch
    batch = FixBatch(
        mark_type_id=body.mark_type_id,
        prompt=body.prompt,
        model=body.model,
        status="pending",
        total_cards=len(card_ids),
        processed_cards=0,
    )
    db.add(batch)
    db.flush()  # get id

    # Mark cards as in_fix_batch
    db.query(Card).filter(Card.id.in_(card_ids)).update({"in_fix_batch": True}, synchronize_session=False)
    db.commit()

    batch_id = batch.id
    background_tasks.add_task(_run_batch_thread, batch_id, card_ids)

    return {"batch_id": batch_id}


def _run_batch_thread(batch_id: int, card_ids: list[int]):
    """Wrapper to run fix batch in a background thread."""
    run_fix_batch(batch_id, card_ids)


@router.post("/{batch_id}/rerun")
def rerun_batch(batch_id: int, body: RerunBatchRequest, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    batch = db.get(FixBatch, batch_id)
    if not batch:
        raise HTTPException(404)
    if batch.status == "running":
        raise HTTPException(409, "Batch is currently running")

    # Derive card ids from THIS batch's own proposals — the global
    # mark/in_fix_batch query would pick up cards from other batches.
    card_ids = [
        row[0]
        for row in db.query(FixProposal.original_card_id)
        .filter(FixProposal.batch_id == batch_id)
        .distinct()
        .all()
    ]

    # Delete old proposals
    db.query(FixProposal).filter(FixProposal.batch_id == batch_id).delete()

    # Update prompt and reset
    batch.prompt = body.prompt
    batch.status = "pending"
    batch.processed_cards = 0
    batch.error_message = None
    batch.finished_at = None
    db.commit()

    background_tasks.add_task(_run_batch_thread, batch_id, card_ids)
    return {"batch_id": batch_id}


@router.patch("/{batch_id}/proposals/{proposal_id}")
def update_proposal(batch_id: int, proposal_id: int, body: UpdateProposalRequest, db: Session = Depends(get_db)):
    proposal = db.query(FixProposal).filter(
        FixProposal.id == proposal_id,
        FixProposal.batch_id == batch_id,
    ).first()
    if not proposal:
        raise HTTPException(404)
    proposal.reviewer_action = body.reviewer_action
    proposal.is_resolved = True
    db.commit()
    db.refresh(proposal)
    return proposal_dict(proposal)


@router.patch("/{batch_id}/proposals/{proposal_id}/content")
def update_proposal_content(batch_id: int, proposal_id: int, body: dict, db: Session = Depends(get_db)):
    """Allow reviewer to edit the proposed front_html/extra before confirming."""
    proposal = db.query(FixProposal).filter(
        FixProposal.id == proposal_id,
        FixProposal.batch_id == batch_id,
    ).first()
    if not proposal:
        raise HTTPException(404)
    if "proposed_front_html" in body:
        proposal.proposed_front_html = body["proposed_front_html"]
    if "proposed_extra" in body:
        proposal.proposed_extra = body["proposed_extra"]
    if "new_cards_json" in body:
        proposal.new_cards_json = body["new_cards_json"]
    db.commit()
    db.refresh(proposal)
    return proposal_dict(proposal)


@router.post("/{batch_id}/confirm")
def confirm_batch(batch_id: int, body: ConfirmBatchRequest, db: Session = Depends(get_db)):
    """Apply accepted proposals to actual cards."""
    batch = (
        db.query(FixBatch)
        .options(joinedload(FixBatch.proposals).joinedload(FixProposal.original_card))
        .filter(FixBatch.id == batch_id)
        .first()
    )
    if not batch:
        raise HTTPException(404)

    if body.proposal_ids:
        proposals = [p for p in batch.proposals if p.id in set(body.proposal_ids)]
    else:
        # "Confirm all" only applies proposals the reviewer has resolved —
        # unresolved ones must not silently apply their raw AI action.
        proposals = [p for p in batch.proposals if p.is_resolved]

    confirmed_card_ids = set()
    created_cards: list[Card] = []

    for proposal in proposals:
        card = proposal.original_card
        if not card:
            continue

        action = proposal.reviewer_action or proposal.ai_action

        if action == "keep":
            # No change to card content
            card.is_reviewed = True
            card.review_mark_id = None
            card.in_fix_batch = False

        elif action == "edit":
            if proposal.proposed_front_html:
                card.front_html = proposal.proposed_front_html
                card.front_text = re.sub(r'<[^>]+>', '', proposal.proposed_front_html)
            if proposal.proposed_extra is not None:
                card.extra = proposal.proposed_extra or None
            card.is_reviewed = True
            card.review_mark_id = None
            card.in_fix_batch = False

        elif action == "delete":
            card.status = CardStatus.rejected
            card.is_reviewed = True
            card.review_mark_id = None
            card.in_fix_batch = False

        elif action == "split":
            # Create new cards from new_cards_json; reject the original unless keep_original.
            # New cards inherit the original's tags and vignette/teaching case.
            if proposal.new_cards_json:
                for nc in proposal.new_cards_json:
                    new_card = Card(
                        section_id=card.section_id,
                        card_number=card.card_number,
                        front_html=nc.get("front_html", ""),
                        front_text=re.sub(r'<[^>]+>', '', nc.get("front_html", "")),
                        tags=card.tags,
                        tags_mapped=card.tags_mapped,
                        extra=nc.get("extra") or None,
                        vignette=card.vignette,
                        teaching_case=card.teaching_case,
                        status=CardStatus.active,
                        is_reviewed=True,
                    )
                    db.add(new_card)
                    created_cards.append(new_card)
            if not body.keep_original:
                card.status = CardStatus.rejected
            card.is_reviewed = True
            card.review_mark_id = None
            card.in_fix_batch = False

        confirmed_card_ids.add(card.id)
        proposal.is_resolved = True

    # Check if all proposals resolved → mark batch confirmed
    all_resolved = all(p.is_resolved for p in batch.proposals)
    if all_resolved:
        batch.status = "confirmed"

    db.commit()

    # Mint unique note ids + run an accuracy/EOR-yield score pass on split outputs.
    if created_cards:
        db.flush()
        assign_note_ids(created_cards)
        sec = db.get(Section, created_cards[0].section_id)
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        score_new_cards(db, client, created_cards, sec.curriculum_topic_path if sec else "", batch.model)
        db.commit()

    return {"confirmed": len(confirmed_card_ids), "batch_status": batch.status}


@router.post("/{batch_id}/cancel")
def cancel_batch(batch_id: int, db: Session = Depends(get_db)):
    batch = (
        db.query(FixBatch)
        .options(joinedload(FixBatch.proposals).joinedload(FixProposal.original_card))
        .filter(FixBatch.id == batch_id)
        .first()
    )
    if not batch:
        raise HTTPException(404)

    # Clear in_fix_batch on all cards
    card_ids = [p.original_card_id for p in batch.proposals]
    if card_ids:
        db.query(Card).filter(Card.id.in_(card_ids)).update({"in_fix_batch": False}, synchronize_session=False)

    batch.status = "cancelled"
    db.commit()
    return {"ok": True}


@router.post("/bulk-mark")
def bulk_mark_cards(body: dict, db: Session = Depends(get_db)):
    """Mark selected cards with a review mark type, or clear (mark_type_id=null for reviewed)."""
    card_ids = body.get("card_ids", [])
    mark_type_id = body.get("mark_type_id")  # None = mark as reviewed (clear mark)

    if not card_ids:
        raise HTTPException(422, "No card IDs provided")

    if mark_type_id is None:
        # Mark as reviewed + clear mark
        db.query(Card).filter(Card.id.in_(card_ids)).update(
            {"is_reviewed": True, "review_mark_id": None},
            synchronize_session=False
        )
    else:
        mt = db.get(ReviewMarkType, mark_type_id)
        if not mt:
            raise HTTPException(404, "Mark type not found")
        db.query(Card).filter(Card.id.in_(card_ids)).update(
            {"review_mark_id": mark_type_id},
            synchronize_session=False
        )

    db.commit()
    return {"updated": len(card_ids)}
