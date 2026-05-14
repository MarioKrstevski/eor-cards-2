from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db
from backend.models import Presentation, Card, Section, SectionImage, slugify

router = APIRouter()


class PresentationCreate(BaseModel):
    name: str
    card_version: str = "base"
    source_type: str = "cards"       # 'cards' | 'topic'
    card_ids: Optional[list[int]] = None
    topic_tree_id: Optional[int] = None


def presentation_to_dict(p: Presentation) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "slug": p.slug,
        "card_version": p.card_version,
        "source_type": p.source_type,
        "card_ids": p.card_ids,
        "topic_tree_id": p.topic_tree_id,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    }


def _card_to_player_dict(card: Card, version: str, db: Session) -> dict:
    """Return a trimmed card dict with front_html swapped out for the requested version."""
    resolved_img = None
    if card.ref_img_id:
        img = db.get(SectionImage, card.ref_img_id)
        if img:
            resolved_img = img.data_uri

    version_html = {
        "base": card.front_html,
        "v1": card.front_html_v1,
        "v2": card.front_html_v2,
        "v3": card.front_html_v3,
    }.get(version, card.front_html) or card.front_html

    return {
        "id": card.id,
        "card_number": card.card_number,
        "front_html": version_html,
        "extra": card.extra,
        "vignette": card.vignette,
        "teaching_case": card.teaching_case,
        "tags": card.tags,
        "ref_img": resolved_img,
        "ref_img_id": card.ref_img_id,
        "ref_img_position": card.ref_img_position,
        "topic_path": card.section.curriculum_topic_path if card.section else None,
    }


@router.get("")
def list_presentations(db: Session = Depends(get_db)):
    items = db.query(Presentation).order_by(Presentation.created_at.desc()).all()
    return [presentation_to_dict(p) for p in items]


@router.post("", status_code=201)
def create_presentation(body: PresentationCreate, db: Session = Depends(get_db)):
    if not body.name.strip():
        raise HTTPException(400, "Name is required")
    if body.source_type == "cards" and not body.card_ids:
        raise HTTPException(400, "card_ids required when source_type=cards")
    if body.source_type == "topic" and not body.topic_tree_id:
        raise HTTPException(400, "topic_tree_id required when source_type=topic")

    slug = slugify(body.name)
    # Ensure slug uniqueness by appending a counter
    base_slug = slug
    counter = 1
    while db.query(Presentation).filter_by(slug=slug).first():
        slug = f"{base_slug}-{counter}"
        counter += 1

    p = Presentation(
        name=body.name.strip(),
        slug=slug,
        card_version=body.card_version,
        source_type=body.source_type,
        card_ids=body.card_ids,
        topic_tree_id=body.topic_tree_id,
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return presentation_to_dict(p)


@router.delete("/{presentation_id}", status_code=204)
def delete_presentation(presentation_id: int, db: Session = Depends(get_db)):
    p = db.get(Presentation, presentation_id)
    if not p:
        raise HTTPException(404)
    db.delete(p)
    db.commit()


@router.get("/{slug}/cards")
def get_presentation_cards(slug: str, db: Session = Depends(get_db)):
    """Public endpoint — returns cards for the Anki player page."""
    p = db.query(Presentation).filter_by(slug=slug).first()
    if not p:
        raise HTTPException(404, "Presentation not found")

    version = p.card_version
    q = db.query(Card).options(joinedload(Card.section)).filter(
        Card.status == "active"
    )

    if p.source_type == "cards" and p.card_ids:
        q = q.filter(Card.id.in_(p.card_ids))
    elif p.source_type == "topic" and p.topic_tree_id:
        q = q.join(Card.section).filter(Section.topic_tree_id == p.topic_tree_id)
    else:
        return {"presentation": presentation_to_dict(p), "cards": []}

    cards = q.order_by(Card.section_id, Card.card_number).all()

    # Filter to only cards that have the requested version populated (skip for base)
    if version != "base":
        version_attr = {"v1": "front_html_v1", "v2": "front_html_v2", "v3": "front_html_v3"}.get(version)
        if version_attr:
            cards = [c for c in cards if getattr(c, version_attr, None)]

    return {
        "presentation": presentation_to_dict(p),
        "cards": [_card_to_player_dict(c, version, db) for c in cards],
    }
