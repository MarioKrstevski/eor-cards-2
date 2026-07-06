from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, case, or_
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, Any
from backend.db import get_db
from backend.models import Curriculum, CurriculumMapping, Section, Card, CardStatus, TopicTree

router = APIRouter()


class CurriculumCreate(BaseModel):
    name: str
    parent_id: Optional[int] = None
    version: str = 'v1'


class CurriculumUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None  # 'green' | None (clear)
    # With color='green': also mark descendant topics green AND flip attached
    # sections (this node + descendants) from 'normal' to 'green' ("Keep").
    # Used by the Compare tool to mark an intruder subtree in one click.
    cascade_green: bool = False


class CompareRequest(BaseModel):
    main_topic_id: int
    nodes: Any  # nested [{name, children}] JSON (curriculum.json shape)


def node_to_dict(node: Curriculum, children: list = None) -> dict:
    return {
        "id": node.id,
        "name": node.name,
        "level": node.level,
        "path": node.path,
        "parent_id": node.parent_id,
        "sort_order": node.sort_order,
        "version": node.version,
        "color": node.color,
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
    # Scope sibling ordering by version too — root nodes (parent_id=None) exist
    # in both v1 and v2 trees and must not share a sort_order sequence.
    max_order = db.query(func.max(Curriculum.sort_order)).filter_by(parent_id=body.parent_id, version=version).scalar()
    if max_order is None:
        max_order = -1
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

    # Guard: replacing this version's nodes would orphan anything referencing them.
    version_ids = db.query(Curriculum.id).filter(Curriculum.version == version)
    n_sections = db.query(Section).filter(Section.curriculum_topic_id.in_(version_ids)).count()
    n_trees = db.query(TopicTree).filter(TopicTree.curriculum_id.in_(version_ids)).count()
    if n_sections or n_trees:
        raise HTTPException(
            409,
            f"{n_sections} sections / {n_trees} topic trees reference curriculum "
            f"version '{version}' — import would orphan them. Detach or delete them first.",
        )

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
    # Color-only update (explicitly sent, may be null to clear) — no path cascade.
    if "color" in body.model_fields_set:
        node.color = body.color
        if body.cascade_green and body.color == "green":
            # Compare-tool marking: this topic is an intruder (not in the new
            # blueprint) — mark its whole subtree green and flip its attached
            # sections to 'green' ("Keep"). Never overwrites 'orange'.
            descendants = db.query(Curriculum).filter(
                Curriculum.version == node.version,
                Curriculum.path.startswith(node.path + " > "),
            ).all()
            ids = [node.id] + [d.id for d in descendants]
            for d in descendants:
                d.color = "green"
            for section in db.query(Section).filter(
                Section.curriculum_topic_id.in_(ids),
                Section.section_status == "normal",
            ).all():
                section.section_status = "green"
    if body.name is None:
        db.commit()
        db.refresh(node)
        return node_to_dict(node)
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


@router.post("/compare")
def compare_curriculum(body: CompareRequest, db: Session = Depends(get_db)):
    """Diff a pasted nested-topic JSON (the expected blueprint) against the
    system's curriculum subtree under a main topic. Reuses the reconcile diff
    engine: 'missing' = in system but NOT in the JSON (the intruders to mark
    green), 'new' = in the JSON but absent from the system, 'fuzzy' = near-miss.
    Read-only — marking green happens via PATCH /{id} with cascade_green."""
    from backend.services.curriculum_aligner import (
        align, build_merged_tree, json_tree_to_outline,
    )

    main = db.get(Curriculum, body.main_topic_id)
    if not main:
        raise HTTPException(404, "Main topic not found")

    try:
        outline = json_tree_to_outline(body.nodes, main.name)
    except ValueError as e:
        raise HTTPException(422, f"Bad topic JSON: {e}")
    if not outline:
        raise HTTPException(422, "Topic JSON is empty")

    subtree = db.query(Curriculum).filter(
        Curriculum.version == main.version,
        or_(Curriculum.id == main.id, Curriculum.path.startswith(main.path + " > ")),
    ).all()
    nodes = [
        {"id": n.id, "parent_id": n.parent_id, "name": n.name, "level": n.level,
         "path": n.path, "color": n.color}
        for n in subtree
    ]
    main_dict = {"id": main.id, "parent_id": main.parent_id, "name": main.name,
                 "level": main.level, "path": main.path, "color": main.color}

    result = align(outline, main_dict, nodes)
    tree = build_merged_tree(outline, main_dict, nodes, result)
    return {
        "tree": tree,
        "summary": result["levels"],
        "fuzzy": result["fuzzy"],
        "main_topic": main_dict,
    }


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


class ResetRequest(BaseModel):
    nodes: Any  # nested [{name, children}] JSON — becomes the topic's new children


@router.post("/{node_id}/reset")
def reset_topic_children(node_id: int, body: ResetRequest, db: Session = Depends(get_db)):
    """TEMPORARY tooling: replace a MAIN TOPIC's entire subtree with the pasted
    blueprint JSON. Deletes all descendant topics and their attached sections
    (cards cascade), then seeds the JSON as the fresh children — a one-click
    'known-good reset' while validating the new-blueprint workflow."""
    from backend.services.curriculum_aligner import normalize_topic

    node = db.get(Curriculum, node_id)
    if not node:
        raise HTTPException(404)
    if node.level != 0:
        raise HTTPException(400, "Reset is only available on main topics (level 0)")

    nodes = body.nodes
    if isinstance(nodes, dict):
        nodes = [nodes]
    if not isinstance(nodes, list) or not nodes:
        raise HTTPException(422, "Expected a non-empty JSON list of {name, children} objects")
    # Pasting the whole topic (single root matching the main topic) is fine too.
    if (len(nodes) == 1 and isinstance(nodes[0], dict)
            and normalize_topic(str(nodes[0].get("name", ""))) == normalize_topic(node.name)):
        nodes = nodes[0].get("children") or []
        if not nodes:
            raise HTTPException(422, "The pasted topic has no children")

    # Wipe the existing subtree + attached sections (cards cascade via ORM).
    descendants = db.query(Curriculum).filter(
        Curriculum.version == node.version,
        Curriculum.path.startswith(node.path + " > "),
    ).all()
    removed_sections = 0
    if descendants:
        ids = [d.id for d in descendants]
        for section in db.query(Section).filter(Section.curriculum_topic_id.in_(ids)).all():
            db.delete(section)
            removed_sections += 1
        db.query(TopicTree).filter(TopicTree.curriculum_id.in_(ids)).update(
            {"curriculum_id": node.id}, synchronize_session=False,
        )
        for d in sorted(descendants, key=lambda x: -x.level):
            db.delete(d)
    db.flush()

    imported = 0

    def seed(items, parent, level):
        nonlocal imported
        for idx, item in enumerate(items):
            if not isinstance(item, dict) or not str(item.get("name", "")).strip():
                raise HTTPException(422, "Each topic must be an object with a non-empty 'name'")
            name = str(item["name"]).strip()
            child = Curriculum(
                parent_id=parent.id, name=name, level=level,
                path=f"{parent.path} > {name}", sort_order=idx, version=node.version,
            )
            db.add(child)
            db.flush()
            imported += 1
            seed(item.get("children") or [], child, level + 1)

    seed(nodes, node, 1)
    db.commit()
    return {
        "imported": imported,
        "removed_topics": len(descendants),
        "removed_sections": removed_sections,
    }


@router.delete("/green")
def delete_all_green(version: str = Query('v1'), db: Session = Depends(get_db)):
    """TEMPORARY convenience (compare-tool cleanup): delete every green-marked
    topic subtree in a version, including attached sections (cards cascade).
    Lets the reviewer wipe the old-blueprint carryovers and re-upload so they
    get re-created green through the reconcile flow."""
    greens = db.query(Curriculum).filter(
        Curriculum.version == version, Curriculum.color == "green",
    ).all()
    if not greens:
        return {"removed_topics": 0, "removed_sections": 0}
    green_ids = {g.id for g in greens}
    # Only the top-most green nodes — their subtrees cover nested greens.
    roots = [g for g in greens if g.parent_id not in green_ids]
    removed_topics = removed_sections = 0
    for g in roots:
        descendants = db.query(Curriculum).filter(
            Curriculum.version == version,
            Curriculum.path.startswith(g.path + " > "),
        ).all()
        ids = [g.id] + [d.id for d in descendants]
        for section in db.query(Section).filter(Section.curriculum_topic_id.in_(ids)).all():
            db.delete(section)  # ORM cascade: content blocks, images, cards
            removed_sections += 1
        db.query(TopicTree).filter(TopicTree.curriculum_id.in_(ids)).update(
            {"curriculum_id": g.parent_id}, synchronize_session=False,
        )
        for d in sorted(descendants, key=lambda x: -x.level):
            db.delete(d)
        db.delete(g)
        removed_topics += len(ids)
    db.commit()
    return {"removed_topics": removed_topics, "removed_sections": removed_sections}


@router.delete("/{node_id}", status_code=204)
def delete_node(node_id: int, subtree: bool = Query(False), db: Session = Depends(get_db)):
    node = db.get(Curriculum, node_id)
    if not node:
        raise HTTPException(404)

    if subtree:
        # Compare-tool "Remove": delete the whole intruder subtree AND its
        # attached sections (cards cascade via the ORM relationships), so a
        # fresh re-upload re-creates them through reconcile — green from the
        # start. Topic trees anchored inside the subtree re-anchor to the parent.
        parent = db.get(Curriculum, node.parent_id) if node.parent_id else None
        descendants = db.query(Curriculum).filter(
            Curriculum.version == node.version,
            Curriculum.path.startswith(node.path + " > "),
        ).all()
        ids = [node.id] + [d.id for d in descendants]
        for section in db.query(Section).filter(Section.curriculum_topic_id.in_(ids)).all():
            db.delete(section)  # ORM cascade: content blocks, images, cards
        db.query(TopicTree).filter(TopicTree.curriculum_id.in_(ids)).update(
            {"curriculum_id": parent.id if parent else None},
            synchronize_session=False,
        )
        for d in sorted(descendants, key=lambda x: -x.level):
            db.delete(d)
        db.delete(node)
        db.commit()
        return

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
    # Topic trees can point at curriculum nodes too — don't leave a dangling FK.
    db.query(TopicTree).filter(TopicTree.curriculum_id == node_id).update(
        {"curriculum_id": parent.id if parent else None},
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
