from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db
from backend.models import ReviewMarkType

router = APIRouter()


class MarkTypeCreate(BaseModel):
    name: str
    color: str = '#6b7280'
    sort_order: int = 0


class MarkTypeUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    sort_order: Optional[int] = None


def mark_type_dict(m: ReviewMarkType) -> dict:
    return {
        "id": m.id,
        "name": m.name,
        "color": m.color,
        "sort_order": m.sort_order,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


@router.get("")
def list_mark_types(db: Session = Depends(get_db)):
    marks = db.query(ReviewMarkType).order_by(ReviewMarkType.sort_order, ReviewMarkType.id).all()
    return [mark_type_dict(m) for m in marks]


@router.post("")
def create_mark_type(body: MarkTypeCreate, db: Session = Depends(get_db)):
    m = ReviewMarkType(name=body.name, color=body.color, sort_order=body.sort_order)
    db.add(m)
    db.commit()
    db.refresh(m)
    return mark_type_dict(m)


@router.patch("/{mark_id}")
def update_mark_type(mark_id: int, body: MarkTypeUpdate, db: Session = Depends(get_db)):
    m = db.get(ReviewMarkType, mark_id)
    if not m:
        raise HTTPException(404)
    if body.name is not None:
        m.name = body.name
    if body.color is not None:
        m.color = body.color
    if body.sort_order is not None:
        m.sort_order = body.sort_order
    db.commit()
    db.refresh(m)
    return mark_type_dict(m)


@router.delete("/{mark_id}")
def delete_mark_type(mark_id: int, db: Session = Depends(get_db)):
    m = db.get(ReviewMarkType, mark_id)
    if not m:
        raise HTTPException(404)
    # Clear mark from any cards using it
    from backend.models import Card
    db.query(Card).filter(Card.review_mark_id == mark_id).update({"review_mark_id": None})
    db.delete(m)
    db.commit()
    return {"ok": True}
