from __future__ import annotations
import json
import anthropic
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import cast, String
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db
from backend.models import Card, CardStatus, Section, SectionImage, RuleSet, AIUsageLog
from backend.services.generator import strip_card_html, regenerate_single_card
from backend.config import ANTHROPIC_API_KEY, DEFAULT_MODEL, compute_cost

router = APIRouter()


class RegenerateCardRequest(BaseModel):
    model: str = DEFAULT_MODEL
    prompt: Optional[str] = None


class CardPatch(BaseModel):
    front_html: Optional[str] = None
    front_html_v1: Optional[str] = None
    front_html_v2: Optional[str] = None
    front_html_v3: Optional[str] = None
    tags: Optional[list[str]] = None
    tags_mapped: Optional[list[str]] = None
    extra: Optional[str] = None
    vignette: Optional[str] = None
    teaching_case: Optional[str] = None
    ref_img_id: Optional[int] = None
    ref_img_position: Optional[str] = None
    status: Optional[CardStatus] = None
    is_reviewed: Optional[bool] = None


def card_to_dict(card: Card, db: Session | None = None) -> dict:
    resolved_img = None
    ref_img_id = getattr(card, "ref_img_id", None)
    if ref_img_id and db:
        section_img = db.get(SectionImage, ref_img_id)
        if section_img:
            resolved_img = section_img.data_uri
    return {
        "id": card.id,
        "section_id": card.section_id,
        "card_number": card.card_number,
        "front_html": card.front_html,
        "front_html_v1": card.front_html_v1,
        "front_html_v2": card.front_html_v2,
        "front_html_v3": card.front_html_v3,
        "front_text": card.front_text,
        "tags": card.tags,
        "tags_mapped": card.tags_mapped,
        "extra": card.extra,
        "vignette": card.vignette,
        "teaching_case": card.teaching_case,
        "ref_img": resolved_img,
        "ref_img_id": ref_img_id,
        "ref_img_position": card.ref_img_position,
        "source_ref": card.source_ref,
        "note_id": card.note_id,
        "status": card.status,
        "is_reviewed": card.is_reviewed,
        "review_mark_id": card.review_mark_id if hasattr(card, 'review_mark_id') else None,
        "in_fix_batch": card.in_fix_batch if hasattr(card, 'in_fix_batch') else False,
        "needs_review": card.needs_review if hasattr(card, 'needs_review') else False,
        "created_at": card.created_at.isoformat() if card.created_at else None,
        "updated_at": card.updated_at.isoformat() if card.updated_at else None,
        "section_heading": card.section.heading if card.section else None,
        "curriculum_topic_path": card.section.curriculum_topic_path if card.section else None,
    }


@router.get("")
def list_cards(
    section_id: Optional[int] = None,
    section_ids: Optional[str] = None,  # comma-separated
    topic_tree_id: Optional[int] = None,
    status: Optional[CardStatus] = None,
    is_reviewed: Optional[bool] = None,
    mark_type_id: Optional[int] = None,
    tag: Optional[str] = None,
    topic: Optional[str] = None,
    search_q: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    q = db.query(Card).options(
        joinedload(Card.section),
    )
    if topic_tree_id:
        q = q.join(Card.section).filter(Section.topic_tree_id == topic_tree_id)
    if section_id:
        q = q.filter(Card.section_id == section_id)
    if section_ids:
        ids = [int(x) for x in section_ids.split(',') if x.strip().isdigit()]
        if ids:
            q = q.filter(Card.section_id.in_(ids))
    if topic:
        if not topic_tree_id:
            q = q.join(Card.section)
        q = q.filter(Section.curriculum_topic_path.startswith(topic))
    if status:
        q = q.filter(Card.status == status)
    if is_reviewed is not None:
        q = q.filter(Card.is_reviewed == is_reviewed)
    if mark_type_id is not None:
        q = q.filter(Card.review_mark_id == mark_type_id)
    if tag:
        q = q.filter(cast(Card.tags, String).contains(json.dumps(tag)))
    if search_q:
        q = q.filter(Card.front_text.ilike(f"%{search_q}%"))

    # Order
    if section_id:
        q = q.order_by(Card.card_number)
    else:
        q = q.join(Card.section, isouter=True).order_by(Section.sort_order, Card.card_number)

    total = q.count()
    cards = q.offset(offset).limit(limit).all()
    return {"cards": [card_to_dict(c, db) for c in cards], "total": total, "limit": limit, "offset": offset}


@router.patch("/{card_id}")
def patch_card(card_id: int, body: CardPatch, db: Session = Depends(get_db)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404)
    if body.front_html is not None:
        card.front_html = body.front_html
        card.front_text = strip_card_html(body.front_html)
    if body.front_html_v1 is not None:
        card.front_html_v1 = body.front_html_v1
    if body.front_html_v2 is not None:
        card.front_html_v2 = body.front_html_v2
    if body.front_html_v3 is not None:
        card.front_html_v3 = body.front_html_v3
    if body.tags is not None:
        card.tags = body.tags
    if body.tags_mapped is not None:
        card.tags_mapped = body.tags_mapped
    if body.extra is not None:
        card.extra = body.extra
    if body.vignette is not None:
        card.vignette = body.vignette
    if body.teaching_case is not None:
        card.teaching_case = body.teaching_case
    if body.ref_img_id is not None:
        card.ref_img_id = body.ref_img_id if body.ref_img_id != 0 else None
    if body.ref_img_position is not None:
        card.ref_img_position = body.ref_img_position
    if body.status is not None:
        card.status = body.status
    if body.is_reviewed is not None:
        card.is_reviewed = body.is_reviewed
    db.commit()
    db.refresh(card)
    return card_to_dict(card, db)


@router.post("/{card_id}/regenerate")
def regenerate_card(card_id: int, body: RegenerateCardRequest, db: Session = Depends(get_db)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404)
    section = db.get(Section, card.section_id)
    if not section:
        raise HTTPException(404, "Section not found")
    rs = db.query(RuleSet).filter_by(rule_type='generation', is_default=True).first()
    rules = rs.content if rs else "Generate cloze cards. Use {{c1::term}} format."
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    cards_data, needs_review, usage = regenerate_single_card(
        client,
        section_data={
            "content_text": section.content_text,
            "heading": section.heading,
            "curriculum_topic_path": section.curriculum_topic_path,
        },
        existing_card_html=card.front_html,
        rules_text=rules,
        extra_prompt=body.prompt or None,
        model=body.model,
    )
    if cards_data:
        card.front_html = cards_data[0]["front_html"]
        card.front_text = cards_data[0]["front_text"]
        if cards_data[0].get("extra") is not None:
            card.extra = cards_data[0]["extra"]
        card.source_ref = cards_data[0].get("source_ref")
        card.is_reviewed = False
    db.commit()
    if usage:
        db.add(AIUsageLog(
            operation="card_regen",
            model=body.model,
            input_tokens=usage.get("input_tokens", 0),
            output_tokens=usage.get("output_tokens", 0),
            cost_usd=compute_cost(body.model, usage.get("input_tokens", 0), usage.get("output_tokens", 0)),
            card_id=card_id,
            section_id=card.section_id,
        ))
        db.commit()
    db.refresh(card)
    return card_to_dict(card, db)


@router.post("/{card_id}/reject")
def reject_card(card_id: int, db: Session = Depends(get_db)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404)
    card.status = CardStatus.rejected
    card.is_reviewed = True
    db.commit()
    db.refresh(card)
    return card_to_dict(card, db)


class BulkReviewRequest(BaseModel):
    card_ids: list[int]
    is_reviewed: bool = True


@router.post("/bulk-review")
def bulk_mark_reviewed(body: BulkReviewRequest, db: Session = Depends(get_db)):
    if body.card_ids:
        db.query(Card).filter(Card.id.in_(body.card_ids)).update(
            {"is_reviewed": body.is_reviewed}, synchronize_session=False
        )
        db.commit()
    return {"updated": len(body.card_ids)}


@router.post("/bulk-delete", status_code=200)
def bulk_delete_cards(body: BulkReviewRequest, db: Session = Depends(get_db)):
    if body.card_ids:
        db.query(Card).filter(Card.id.in_(body.card_ids)).delete(synchronize_session=False)
        db.commit()
    return {"deleted": len(body.card_ids)}


@router.delete("/{card_id}", status_code=204)
def delete_card(card_id: int, db: Session = Depends(get_db)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404)
    db.delete(card)
    db.commit()
