from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, case
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db
from backend.models import Curriculum, CurriculumMapping, Section, Card, CardStatus

router = APIRouter()


class CurriculumCreate(BaseModel):
    name: str
    parent_id: Optional[int] = None
    version: str = 'v1'


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
        "version": node.version,
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
def get_tree(version: str = Query('v1'), db: Session = Depends(get_db)):
    nodes = db.query(Curriculum).filter(Curriculum.version == version).all()
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
    version = parent.version if parent else body.version
    max_order = db.query(func.max(Curriculum.sort_order)).filter_by(parent_id=body.parent_id).scalar() or -1
    node = Curriculum(name=body.name, parent_id=body.parent_id, level=level, path=path, sort_order=max_order + 1, version=version)
    db.add(node)
    db.commit()
    db.refresh(node)
    return node_to_dict(node)


@router.post("/import", status_code=201)
def import_curriculum(body: dict, db: Session = Depends(get_db)):
    """Import a curriculum tree from JSON. Replaces all nodes for the given version.

    Body: { "version": "v2", "nodes": [...] }  — nodes use the same tree format as curriculum.json
    """
    version = body.get("version", "v2")
    nodes = body.get("nodes", [])
    if not nodes:
        raise HTTPException(400, "No nodes provided")

    # Delete existing nodes for this version
    db.query(Curriculum).filter(Curriculum.version == version).delete(synchronize_session=False)
    db.flush()

    def _seed(node_list, parent_id, level, parent_path):
        for idx, node in enumerate(node_list):
            path = f"{parent_path} > {node['name']}" if parent_path else node["name"]
            c = Curriculum(
                parent_id=parent_id, name=node["name"], level=level,
                path=path, sort_order=idx, version=version,
            )
            db.add(c)
            db.flush()
            if node.get("children"):
                _seed(node["children"], c.id, level + 1, path)

    _seed(nodes, None, 0, "")
    db.commit()
    count = db.query(Curriculum).filter(Curriculum.version == version).count()
    return {"version": version, "imported": count}


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
    db.flush()  # make cascaded paths visible to the queries below
    # Cascade the new paths to Sections pointing at this node or any descendant —
    # otherwise sections keep a stale curriculum_topic_path (and stale card tags).
    affected = db.query(Curriculum).filter(
        Curriculum.version == node.version,
        Curriculum.path.startswith(node.path + " > "),
    ).all()
    path_by_id = {n.id: n.path for n in affected}
    path_by_id[node.id] = node.path
    for section in db.query(Section).filter(
        Section.curriculum_topic_id.in_(path_by_id.keys())
    ).all():
        section.curriculum_topic_path = path_by_id[section.curriculum_topic_id]
    db.commit()
    db.refresh(node)
    return node_to_dict(node)


@router.get("/coverage")
def get_coverage(version: str = Query('v1'), db: Session = Depends(get_db)):
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
    # Per-topic section counts (independent of cards) for the "all sections done" topic checkmark.
    sec_rows = (
        db.query(
            Section.curriculum_topic_id,
            func.count(Section.id).label("sections_total"),
            func.sum(case((Section.is_done == True, 1), else_=0)).label("sections_done"),  # noqa: E712
        )
        .filter(Section.curriculum_topic_id.isnot(None))
        .group_by(Section.curriculum_topic_id)
        .all()
    )
    out: dict[str, dict] = {}
    for r in rows:
        out[str(r.curriculum_topic_id)] = {
            "total": r.total,
            "active": r.active,
            "rejected": r.rejected,
            "unreviewed": r.unreviewed,
            "sections_total": 0,
            "sections_done": 0,
        }
    for s in sec_rows:
        d = out.setdefault(str(s.curriculum_topic_id), {
            "total": 0, "active": 0, "rejected": 0, "unreviewed": 0,
            "sections_total": 0, "sections_done": 0,
        })
        d["sections_total"] = int(s.sections_total or 0)
        d["sections_done"] = int(s.sections_done or 0)
    return out


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


# ── Curriculum Mappings ───────────────────────────────────────────────────────

class MappingCreate(BaseModel):
    from_node_id: int
    to_node_id: int


def mapping_to_dict(m: CurriculumMapping) -> dict:
    return {
        "id": m.id,
        "from_node_id": m.from_node_id,
        "to_node_id": m.to_node_id,
        "from_path": m.from_node.path if m.from_node else None,
        "to_path": m.to_node.path if m.to_node else None,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


@router.get("/mappings")
def list_mappings(from_node_id: Optional[int] = None, db: Session = Depends(get_db)):
    q = db.query(CurriculumMapping)
    if from_node_id is not None:
        q = q.filter(CurriculumMapping.from_node_id == from_node_id)
    return [mapping_to_dict(m) for m in q.all()]


@router.post("/mappings", status_code=201)
def create_mapping(body: MappingCreate, db: Session = Depends(get_db)):
    # Prevent duplicates
    existing = db.query(CurriculumMapping).filter_by(
        from_node_id=body.from_node_id, to_node_id=body.to_node_id
    ).first()
    if existing:
        return mapping_to_dict(existing)
    m = CurriculumMapping(from_node_id=body.from_node_id, to_node_id=body.to_node_id)
    db.add(m)
    db.commit()
    db.refresh(m)
    return mapping_to_dict(m)


@router.delete("/mappings/{mapping_id}", status_code=204)
def delete_mapping(mapping_id: int, db: Session = Depends(get_db)):
    m = db.get(CurriculumMapping, mapping_id)
    if not m:
        raise HTTPException(404)
    db.delete(m)
    db.commit()


@router.post("/mappings/apply")
def apply_mappings(db: Session = Depends(get_db)):
    """Walk all cards, find their v2 curriculum path in mappings, populate tags_mapped."""
    mappings = db.query(CurriculumMapping).all()
    if not mappings:
        return {"updated": 0, "message": "No mappings defined"}

    # Build: from_path -> list of to_path
    from_to: dict[str, list[str]] = {}
    for m in mappings:
        from_node = db.get(Curriculum, m.from_node_id)
        to_node = db.get(Curriculum, m.to_node_id)
        if from_node and to_node:
            from_to.setdefault(from_node.path, []).append(to_node.path)

    updated = 0
    cards = db.query(Card).filter(Card.tags.isnot(None)).all()
    for card in cards:
        if not card.tags:
            continue
        card_path = " > ".join(card.tags)
        to_paths = from_to.get(card_path)
        if to_paths:
            # Union of all path segments across all mapped nodes (preserving order)
            seen: set[str] = set()
            segments: list[str] = []
            for path in to_paths:
                for seg in path.split(" > "):
                    if seg not in seen:
                        seen.add(seg)
                        segments.append(seg)
            card.tags_mapped = segments
            updated += 1

    db.commit()
    return {"updated": updated, "total_cards": len(cards), "mappings_defined": len(mappings)}
