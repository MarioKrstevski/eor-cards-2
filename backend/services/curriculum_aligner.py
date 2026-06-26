"""Aligns a document heading outline against a curriculum subtree.

Pure functions — no DB session. The caller loads Curriculum rows and passes them
as plain dicts so this module is trivially unit-testable.
"""
from __future__ import annotations
import re

_WEIGHT_SUFFIX = re.compile(r"\s*[—–-]\s*\d+\s*%\s*$")  # em "— 18%" / en "– 18%" / hyphen "- 10%"


def normalize_topic(s: str) -> str:
    """Normalize a topic/heading name for matching: drop a trailing exam-weight
    suffix, lowercase, collapse whitespace, tighten slashes."""
    s = _WEIGHT_SUFFIX.sub("", s or "")
    s = s.lower().strip()
    s = re.sub(r"\s*/\s*", "/", s)
    s = re.sub(r"\s+", " ", s)
    return s


def _children(nodes_by_parent, parent_id):
    return nodes_by_parent.get(parent_id, [])


def align(outline: list[dict], main_topic: dict, nodes: list[dict]) -> dict:
    nodes_by_parent: dict = {}
    for n in nodes:
        nodes_by_parent.setdefault(n["parent_id"], []).append(n)

    resolution: dict[int, int | None] = {}
    missing: list[dict] = []
    matched_node_ids: set[int] = set()
    warnings: list[str] = []
    present_by_depth: dict[int, int] = {}

    def walk(heading_nodes: list[dict], parent_node: dict | None, depth: int):
        seen_norm: set[str] = set()
        for h in heading_nodes:
            present_by_depth[depth] = present_by_depth.get(depth, 0) + 1
            match = None
            if parent_node is not None:
                norm = normalize_topic(h["text"])
                for cand in _children(nodes_by_parent, parent_node["id"]):
                    if cand["level"] == depth and normalize_topic(cand["name"]) == norm:
                        if norm in seen_norm:
                            warnings.append(f"Duplicate heading '{h['text']}' at depth {depth}")
                        match = cand
                        seen_norm.add(norm)
                        break
            if match:
                resolution[h["hid"]] = match["id"]
                matched_node_ids.add(match["id"])
                walk(h["children"], match, depth + 1)
            else:
                resolution[h["hid"]] = None
                missing.append({
                    "hid": h["hid"], "name": h["text"], "depth": depth,
                    "parent_id": parent_node["id"] if parent_node else None,
                })
                walk(h["children"], None, depth + 1)

    walk(outline, main_topic, 1)

    expected_by_depth: dict[int, int] = {}
    not_in_doc: list[dict] = []
    matched_parents = {main_topic["id"]} | matched_node_ids
    for n in nodes:
        if n["id"] == main_topic["id"]:
            continue
        expected_by_depth[n["level"]] = expected_by_depth.get(n["level"], 0) + 1
        if n["parent_id"] in matched_parents and n["id"] not in matched_node_ids:
            not_in_doc.append({"node_id": n["id"], "name": n["name"], "depth": n["level"]})

    depths = sorted(set(present_by_depth) | set(expected_by_depth))
    levels = [{"depth": d, "expected": expected_by_depth.get(d, 0),
               "present": present_by_depth.get(d, 0)} for d in depths]

    return {
        "resolution": resolution,
        "levels": levels,
        "missing_in_curriculum": missing,
        "not_in_document": not_in_doc,
        "warnings": warnings,
    }
