"""Aligns a document heading outline against a curriculum subtree.

Pure functions — no DB session. The caller loads Curriculum rows and passes them
as plain dicts so this module is trivially unit-testable.
"""
from __future__ import annotations
import re
from difflib import SequenceMatcher

FUZZY_THRESHOLD = 0.8
FUZZY_MARGIN = 0.05

_WEIGHT_SUFFIX = re.compile(r"\s*[—–-]\s*\d+\s*%\s*$")  # em "— 18%" / en "– 18%" / hyphen "- 10%"
_PARENTHETICAL = re.compile(r"\s*\([^()]*\)")  # "(intimate partner violence, …)" / "(EENOT)"


def normalize_topic(s: str) -> str:
    """Normalize a topic/heading name for matching: drop a trailing exam-weight
    suffix, drop parenthetical elaborations/abbreviations (they're examples, not
    the canonical name, e.g. "Violence and abuse (intimate partner violence…)" ==
    "Violence and Abuse"), lowercase, collapse whitespace, tighten slashes."""
    s = _WEIGHT_SUFFIX.sub("", s or "")
    s = _PARENTHETICAL.sub("", s)
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
    fuzzy: list[dict] = []
    present_by_depth: dict[int, int] = {}

    def walk(heading_nodes, parent_node, depth):
        cands = [c for c in (_children(nodes_by_parent, parent_node["id"]) if parent_node else [])
                 if c["level"] == depth]
        claimed: set = set()        # candidate node ids claimed in THIS group
        decided: dict = {}          # hid -> matched candidate dict (or None)

        # Pass 1: exact (normalized) — claim greedily in document order
        for h in heading_nodes:
            present_by_depth[depth] = present_by_depth.get(depth, 0) + 1
            norm = normalize_topic(h["text"])
            match = None
            if parent_node is not None:
                for c in cands:
                    if c["id"] not in claimed and normalize_topic(c["name"]) == norm:
                        match = c
                        claimed.add(c["id"])
                        break
            decided[h["hid"]] = match

        # Pass 2: fuzzy on still-unmatched headings vs still-unclaimed candidates
        for h in heading_nodes:
            if decided[h["hid"]] is not None or parent_node is None:
                continue
            norm = normalize_topic(h["text"])
            scored = sorted(
                ((SequenceMatcher(None, norm, normalize_topic(c["name"])).ratio(), c)
                 for c in cands if c["id"] not in claimed),
                key=lambda x: x[0], reverse=True,
            )
            if scored and scored[0][0] >= FUZZY_THRESHOLD and (
                    len(scored) == 1 or scored[0][0] - scored[1][0] >= FUZZY_MARGIN):
                c = scored[0][1]
                claimed.add(c["id"])
                decided[h["hid"]] = c
                fuzzy.append({"hid": h["hid"], "node_id": c["id"], "doc_name": h["text"],
                              "curr_name": c["name"], "score": round(scored[0][0], 3)})

        # Resolve + recurse
        for h in heading_nodes:
            match = decided[h["hid"]]
            if match:
                resolution[h["hid"]] = match["id"]
                matched_node_ids.add(match["id"])
                walk(h["children"], match, depth + 1)
            else:
                resolution[h["hid"]] = None
                missing.append({"hid": h["hid"], "name": h["text"], "depth": depth,
                                "parent_id": parent_node["id"] if parent_node else None})
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
        "fuzzy": fuzzy,
    }


def build_merged_tree(outline: list[dict], main_topic: dict, nodes: list[dict],
                      align_result: dict) -> dict:
    """One tree rooted at the main topic. Curriculum nodes tagged matched/fuzzy/
    missing; new document headings grafted under their parent treenode (nested).
    Depth = nesting depth (root=0). Pure."""
    resolution = align_result["resolution"]
    fuzzy = align_result.get("fuzzy", [])
    fuzzy_node_ids = {f["node_id"]: f for f in fuzzy}
    matched_node_ids = {v for v in resolution.values() if v is not None}

    by_id: dict[int, dict] = {}
    for n in nodes:
        if n["id"] == main_topic["id"]:
            status = "matched"
        elif n["id"] in fuzzy_node_ids:
            status = "fuzzy"
        elif n["id"] in matched_node_ids:
            status = "matched"
        else:
            status = "missing"
        by_id[n["id"]] = {"status": status, "name": n["name"], "depth": n["level"],
                          "node_id": n["id"], "hid": None, "doc_name": None,
                          "score": None, "color": n.get("color"), "children": []}
    for f in fuzzy:
        tn = by_id.get(f["node_id"])
        if tn:
            tn["doc_name"] = f["doc_name"]; tn["score"] = f["score"]
    for n in nodes:
        if n["id"] == main_topic["id"]:
            continue
        parent = by_id.get(n["parent_id"])
        if parent:
            parent["children"].append(by_id[n["id"]])

    root = by_id[main_topic["id"]]

    def graft(heading_nodes, parent_tn):
        for h in heading_nodes:
            nid = resolution.get(h["hid"])
            if nid is not None:
                tn = by_id.get(nid, parent_tn)
                graft(h["children"], tn)
            else:
                tn = {"status": "new", "name": h["text"], "depth": parent_tn["depth"] + 1,
                      "node_id": None, "hid": h["hid"], "doc_name": None,
                      "score": None, "color": None, "children": []}
                parent_tn["children"].append(tn)
                graft(h["children"], tn)

    graft(outline, root)
    return root


def json_tree_to_outline(nodes, main_topic_name: str = "") -> list[dict]:
    """Convert a nested topic JSON (curriculum.json shape: [{"name", "children"}])
    into the outline shape align() consumes ({hid, level, text, children}, hids
    depth-first, level = 1-based depth below the main topic).

    Ergonomics: a single root (dict, or one-element list) whose name matches the
    main topic is auto-unwrapped to its children, so pasting either the topic's
    children or the whole topic works.
    """
    if isinstance(nodes, dict):
        nodes = [nodes]
    if not isinstance(nodes, list):
        raise ValueError("Expected a JSON list of {name, children} objects")
    if (len(nodes) == 1 and isinstance(nodes[0], dict) and main_topic_name
            and normalize_topic(str(nodes[0].get("name", ""))) == normalize_topic(main_topic_name)):
        nodes = nodes[0].get("children") or []

    hid = 0

    def walk(items, depth: int) -> list[dict]:
        nonlocal hid
        out = []
        for item in items:
            if not isinstance(item, dict) or not str(item.get("name", "")).strip():
                raise ValueError("Each topic must be an object with a non-empty 'name'")
            node = {"hid": hid, "level": depth, "text": str(item["name"]).strip(), "children": []}
            hid += 1
            node["children"] = walk(item.get("children") or [], depth + 1)
            out.append(node)
        return out

    return walk(nodes, 1)


def expand_includes(included_hids, outline: list[dict]) -> list[int]:
    """Expand selected new-node hids to include their outline ancestors, ordered
    parents-before-children (so curriculum nodes can be created in order)."""
    parent_of: dict[int, int | None] = {}
    order: list[int] = []  # document order of all heading hids

    def walk(nodes, parent_hid):
        for h in nodes:
            parent_of[h["hid"]] = parent_hid
            order.append(h["hid"])
            walk(h["children"], h["hid"])
    walk(outline, None)

    wanted: set[int] = set()
    for hid in included_hids:
        cur = hid
        while cur is not None and cur not in wanted:
            wanted.add(cur)
            cur = parent_of.get(cur)
    return [hid for hid in order if hid in wanted]
