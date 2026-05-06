from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db
from backend.models import Section, ContentBlock, SectionImage

router = APIRouter()


class SectionUpdate(BaseModel):
    heading: Optional[str] = None
    content_text: Optional[str] = None
    content_html: Optional[str] = None
    curriculum_topic_id: Optional[int] = None
    curriculum_topic_path: Optional[str] = None
    is_verified: Optional[bool] = None
    flags: Optional[list] = None


def section_to_dict(s: Section) -> dict:
    return {
        "id": s.id,
        "topic_tree_id": s.topic_tree_id,
        "heading": s.heading,
        "slug": s.slug,
        "heading_tree": s.heading_tree,
        "content_text": s.content_text,
        "content_html": s.content_html,
        "curriculum_topic_id": s.curriculum_topic_id,
        "curriculum_topic_path": s.curriculum_topic_path,
        "image_count": s.image_count,
        "table_count": s.table_count,
        "flags": s.flags,
        "is_verified": s.is_verified,
        "sort_order": s.sort_order,
        "card_count": len(s.cards) if s.cards else 0,
        "content_blocks": [
            {
                "id": cb.id,
                "text": cb.text,
                "html": cb.html,
                "block_type": cb.block_type,
                "heading_context": cb.heading_context,
                "position": cb.position,
                "is_duplicate": cb.is_duplicate,
            }
            for cb in sorted(s.content_blocks, key=lambda b: b.position)
        ],
        "images": [
            {
                "id": img.id,
                "data_uri": img.data_uri,
                "category": img.category,
                "extracted_text": img.extracted_text,
                "alt_text_hint": img.alt_text_hint,
                "position": img.position,
            }
            for img in sorted(s.images, key=lambda i: i.position)
        ],
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "updated_at": s.updated_at.isoformat() if s.updated_at else None,
    }


@router.get("/{section_id}")
def get_section(section_id: int, db: Session = Depends(get_db)):
    section = db.get(Section, section_id)
    if not section:
        raise HTTPException(404)
    return section_to_dict(section)


@router.patch("/{section_id}")
def update_section(section_id: int, body: SectionUpdate, db: Session = Depends(get_db)):
    section = db.get(Section, section_id)
    if not section:
        raise HTTPException(404)
    if body.heading is not None:
        section.heading = body.heading
    if body.content_text is not None:
        section.content_text = body.content_text
    if body.content_html is not None:
        section.content_html = body.content_html
    if body.curriculum_topic_id is not None:
        section.curriculum_topic_id = body.curriculum_topic_id
    if body.curriculum_topic_path is not None:
        section.curriculum_topic_path = body.curriculum_topic_path
    if body.is_verified is not None:
        section.is_verified = body.is_verified
    if body.flags is not None:
        section.flags = body.flags
    db.commit()
    db.refresh(section)
    return section_to_dict(section)


@router.post("/{section_id}/verify")
def verify_section(section_id: int, db: Session = Depends(get_db)):
    """Mark section as verified (AI verification is a future enhancement)."""
    section = db.get(Section, section_id)
    if not section:
        raise HTTPException(404)
    section.is_verified = True
    db.commit()
    return {"is_valid": True, "flags": section.flags or []}
