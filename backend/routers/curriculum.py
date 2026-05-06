from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, case
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db
from backend.models import Curriculum, Section, Card, CardStatus

router = APIRouter()


class CurriculumCreate(BaseModel):
    name: str
    parent_id: Optional[int] = None


class CurriculumUpdate(BaseModel):
    name: str


def node_to_dict(node: Curriculum, children: list = None) -> dict:
    return {
        "id": node.id,
        "name": node.name,
        "level": node.level,
        "path": node.path,
        "parent_id": node.parent_id,
        "sort_order": node.sort_order,
        "children": children or [],
    }


def build_tree(nodes: list[Curriculum]) -> list[dict]:
    by_id = {n.id: node_to_dict(n) for n in nodes}
    roots = []
    for n in nodes:
        if n.parent_id is None:
            roots.append(by_id[n.id])
        elif n.parent_id in by_id:
            by_id[n.parent_id]["children"].append(by_id[n.id])

    def sort_tree(nodes_list):
        nodes_list.sort(key=lambda x: x["sort_order"])
        for node in nodes_list:
            sort_tree(node["children"])
    sort_tree(roots)
    return roots


@router.get("")
def get_tree(db: Session = Depends(get_db)):
    nodes = db.query(Curriculum).all()
    return build_tree(nodes)


@router.post("", status_code=201)
def create_node(body: CurriculumCreate, db: Session = Depends(get_db)):
    parent = None
    if body.parent_id:
        parent = db.get(Curriculum, body.parent_id)
        if not parent:
            raise HTTPException(404, "Parent not found")
    level = (parent.level + 1) if parent else 0
    path = f"{parent.path} > {body.name}" if parent else body.name
    max_order = db.query(func.max(Curriculum.sort_order)).filter_by(parent_id=body.parent_id).scalar() or -1
    node = Curriculum(name=body.name, parent_id=body.parent_id, level=level, path=path, sort_order=max_order + 1)
    db.add(node)
    db.commit()
    db.refresh(node)
    return node_to_dict(node)


def _cascade_path_update(db, parent: Curriculum):
    """Recursively rebuild path strings for all children of a node."""
    children = db.query(Curriculum).filter_by(parent_id=parent.id).all()
    for child in children:
        child.path = f"{parent.path} > {child.name}"
        _cascade_path_update(db, child)


@router.patch("/{node_id}")
def rename_node(node_id: int, body: CurriculumUpdate, db: Session = Depends(get_db)):
    node = db.get(Curriculum, node_id)
    if not node:
        raise HTTPException(404)
    node.name = body.name
    if node.parent_id:
        parent = db.get(Curriculum, node.parent_id)
        node.path = f"{parent.path} > {body.name}"
    else:
        node.path = body.name
    _cascade_path_update(db, node)
    db.commit()
    db.refresh(node)
    return node_to_dict(node)


@router.get("/coverage")
def get_coverage(db: Session = Depends(get_db)):
    """Return card breakdown per curriculum topic_id."""
    rows = (
        db.query(
            Section.curriculum_topic_id,
            func.count(Card.id).label("total"),
            func.sum(case((Card.status == CardStatus.active, 1), else_=0)).label("active"),
            func.sum(case((Card.status == CardStatus.rejected, 1), else_=0)).label("rejected"),
            func.sum(case(
                ((Card.status == CardStatus.active) & ~Card.is_reviewed, 1),
                else_=0,
            )).label("unreviewed"),
        )
        .join(Card, Card.section_id == Section.id)
        .filter(Section.curriculum_topic_id.isnot(None))
        .group_by(Section.curriculum_topic_id)
        .all()
    )
    return {
        str(r.curriculum_topic_id): {
            "total": r.total,
            "active": r.active,
            "rejected": r.rejected,
            "unreviewed": r.unreviewed,
        }
        for r in rows
    }


@router.delete("/{node_id}", status_code=204)
def delete_node(node_id: int, db: Session = Depends(get_db)):
    node = db.get(Curriculum, node_id)
    if not node:
        raise HTTPException(404)
    if db.query(Curriculum).filter_by(parent_id=node_id).count():
        raise HTTPException(400, "Cannot delete node with children")

    parent = db.get(Curriculum, node.parent_id) if node.parent_id else None

    # Reassign sections to parent (or null)
    db.query(Section).filter(Section.curriculum_topic_id == node_id).update(
        {
            "curriculum_topic_id": parent.id if parent else None,
            "curriculum_topic_path": parent.path if parent else None,
        },
        synchronize_session=False,
    )
    db.delete(node)
    db.commit()
