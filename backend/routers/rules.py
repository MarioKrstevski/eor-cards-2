from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db
from backend.models import RuleSet

router = APIRouter()


class RuleSetCreate(BaseModel):
    name: str
    content: str
    is_default: bool = False
    rule_type: str = "generation"
    card_version: str = "base"


class RuleSetUpdate(BaseModel):
    name: Optional[str] = None
    content: Optional[str] = None
    card_version: Optional[str] = None


class SetShownRequest(BaseModel):
    is_shown: bool


def ruleset_to_dict(rs: RuleSet) -> dict:
    return {
        "id": rs.id,
        "name": rs.name,
        "content": rs.content,
        "is_default": rs.is_default,
        "is_shown": rs.is_shown,
        "rule_type": rs.rule_type,
        "card_version": rs.card_version,
        "created_at": rs.created_at.isoformat() if rs.created_at else None,
    }


@router.get("")
def list_rules(rule_type: str = None, db: Session = Depends(get_db)):
    q = db.query(RuleSet)
    if rule_type:
        q = q.filter_by(rule_type=rule_type)
    return [ruleset_to_dict(rs) for rs in q.all()]


@router.post("", status_code=201)
def create_rule_set(body: RuleSetCreate, db: Session = Depends(get_db)):
    rs = RuleSet(name=body.name, content=body.content, is_default=False, rule_type=body.rule_type, card_version=body.card_version)
    db.add(rs)
    db.commit()
    db.refresh(rs)
    return ruleset_to_dict(rs)


@router.patch("/{rs_id}")
def update_rule_set(rs_id: int, body: RuleSetUpdate, db: Session = Depends(get_db)):
    rs = db.get(RuleSet, rs_id)
    if not rs:
        raise HTTPException(404)
    if body.name is not None:
        rs.name = body.name
    if body.content is not None:
        rs.content = body.content
    if body.card_version is not None:
        rs.card_version = body.card_version
    db.commit()
    db.refresh(rs)
    return ruleset_to_dict(rs)


@router.delete("/{rs_id}", status_code=204)
def delete_rule_set(rs_id: int, db: Session = Depends(get_db)):
    rs = db.get(RuleSet, rs_id)
    if not rs:
        raise HTTPException(404)
    if rs.is_default:
        raise HTTPException(400, "Cannot delete default rule set")
    db.delete(rs)
    db.commit()


@router.post("/{rs_id}/set-default")
def set_default(rs_id: int, db: Session = Depends(get_db)):
    rs = db.get(RuleSet, rs_id)
    if not rs:
        raise HTTPException(404)
    db.query(RuleSet).filter(RuleSet.rule_type == rs.rule_type, RuleSet.is_default == True).update({"is_default": False})
    rs.is_default = True
    db.commit()
    db.refresh(rs)
    return ruleset_to_dict(rs)


@router.patch("/{rs_id}/set-shown")
def set_shown(rs_id: int, body: SetShownRequest, db: Session = Depends(get_db)):
    rs = db.get(RuleSet, rs_id)
    if not rs:
        raise HTTPException(404)
    rs.is_shown = body.is_shown
    db.commit()
    db.refresh(rs)
    return ruleset_to_dict(rs)
