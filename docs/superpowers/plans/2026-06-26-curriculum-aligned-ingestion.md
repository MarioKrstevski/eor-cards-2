# Curriculum-Aligned Document Ingestion — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the H2-only document split with a level-aligned ingestion flow: a pre-process "reconcile" gate that diffs the uploaded `.docx` heading outline against the curriculum subtree under a chosen main topic, lets the reviewer add missing nodes, then attaches each content chunk to the **deepest matched curriculum node** (rolling up when a level has no match).

**Architecture:** Two new **pure functions** carry the logic and are unit-tested in isolation: `curriculum_aligner.align()` (diff + heading→node resolution map) and `doc_processor.attach_content_to_curriculum()` (group content blocks by deepest matched node, preserving document order). The upload endpoint parks the job in `awaiting_reconcile` after a headings-only parse; a `/reconcile` endpoint returns the live diff; `/continue` runs the real pipeline. A new `ReconcileModal.tsx` drives the UX.

**Tech Stack:** FastAPI, SQLAlchemy 2.0, SQLite, python-docx, React 19 + TS, pytest.

**Spec:** `docs/superpowers/specs/2026-06-26-curriculum-aligned-ingestion-design.md`

---

## Conventions

- Run tests on BOTH interpreters (this venv is split): `.venv/bin/python -m pytest backend/tests -q` (3.9) **and** `.venv/bin/python3.12 -m pytest backend/tests -q` (3.12, the one the server runs). A task isn't done until both are green.
- Tests are pure unit tests where possible — no API keys, no real docx. The aligner and attach functions take **plain data** (dicts/lists), never a DB session, so they test trivially.
- Two-user MVP; **DB will be wiped** before first real use, so no migration code is needed — model changes apply on next boot (`Base.metadata.create_all`).
- Work on a branch: `git switch -c feat/curriculum-aligned-ingestion` before Task 1.
- Commit after every task.

## Key data shapes (from the current code — do not re-derive)

- A parsed element (`parse_docx`/`parse_html`) is a dict. Headings are
  `{"type": "heading", "text": str, "level": int}` (level 1–4). Content is
  `{"type": "paragraph"|"list_item"|"image"|"table"|..., "text": str, ...}`.
- `build_content_html(elements)` numbers `[Image N]` placeholders by counting
  `type=="image"` elements **in list order**; Step 5 matches `SectionImage.position`
  to that index. ⇒ **within a section, elements MUST stay in original document order.**
- Curriculum node (DB `Curriculum`): `id, parent_id, name, level (0-based), path
  ("A > B > C"), version`. Root/main-topic `level=0`.

## Heading identity (shared convention used by outline + attach)

Both `parse_heading_outline` and `attach_content_to_curriculum` walk the same
element list in the same order, so the **Nth heading in document order** gets the
same integer id (`hid`). The aligner's resolution map is keyed by `hid`. This is
the glue: align decides `hid → node_id|None`; attach walks content and rolls up
using those decisions.

## File structure

- **Create** `backend/services/curriculum_aligner.py` — `normalize_topic()`, `align()`. Pure.
- **Modify** `backend/services/doc_processor.py` — add `parse_heading_outline()`, `attach_content_to_curriculum()`. Pure.
- **Modify** `backend/models.py` — `Upload.heading_outline` (JSON).
- **Modify** `backend/main.py` — exempt `awaiting_reconcile` from the orphan sweep.
- **Modify** `backend/routers/documents.py` — upload scans + parks; new `/reconcile`, `/continue`; `_run_processing` accepts a resolution map and uses `attach_content_to_curriculum`.
- **Create** `frontend/src/components/ReconcileModal.tsx` + wire into `WorkspacePage.tsx`, `api.ts`, `types.ts`.
- **Create** tests under `backend/tests/`.

---

## Task 1: Schema — `Upload.heading_outline`

**Files:** Modify `backend/models.py`

- [ ] **Step 1: Add the column.** In the `Upload` model, add a nullable JSON column next to the existing fields:

```python
    heading_outline: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
```

(`JSON` and `Optional` are already imported in models.py — verify; if not, add `from sqlalchemy import JSON` / `from typing import Optional`.)

- [ ] **Step 2: Verify it loads.** Run: `.venv/bin/python3.12 -c "from backend.models import Upload; print(hasattr(Upload, 'heading_outline'))"` → `True`. (No migration: the DB will be wiped; `create_all` adds it on next boot.)

- [ ] **Step 3: Commit.**
```bash
git add backend/models.py
git commit -m "feat: add Upload.heading_outline JSON column"
```

---

## Task 2: `parse_heading_outline()` (doc_processor)

Build a nested H1–H4 outline from a flat element list, assigning each heading a sequential `hid`.

**Files:** Modify `backend/services/doc_processor.py`; Test `backend/tests/test_outline.py`

- [ ] **Step 1: Write failing test** (`backend/tests/test_outline.py`):

```python
from backend.services.doc_processor import parse_heading_outline


def _h(level, text):
    return {"type": "heading", "level": level, "text": text}


def test_outline_nests_and_assigns_hids():
    elements = [
        _h(1, "Infectious Disease"),
        _h(2, "Parasitic Infections"),
        _h(3, "Giardiasis/GI Parasites"),
        {"type": "paragraph", "text": "Amebiasis..."},
        _h(3, "Toxoplasmosis"),
        _h(1, "Cardiology"),
    ]
    outline = parse_heading_outline(elements)
    # top level = the two H1s
    assert [n["text"] for n in outline] == ["Infectious Disease", "Cardiology"]
    # hids are assigned in document order across all headings
    inf = outline[0]
    assert inf["hid"] == 0 and inf["level"] == 1
    para = inf["children"][0]            # Parasitic Infections (H2)
    assert para["text"] == "Parasitic Infections" and para["level"] == 2 and para["hid"] == 1
    assert [c["text"] for c in para["children"]] == ["Giardiasis/GI Parasites", "Toxoplasmosis"]
    assert para["children"][0]["hid"] == 2
    assert para["children"][1]["hid"] == 3
    assert outline[1]["hid"] == 4        # Cardiology


def test_outline_handles_skipped_levels():
    # H2 jumps straight to H4 (no H3)
    outline = parse_heading_outline([_h(2, "A"), _h(4, "deep")])
    assert outline[0]["text"] == "A"
    assert outline[0]["children"][0]["text"] == "deep"
    assert outline[0]["children"][0]["level"] == 4
```

- [ ] **Step 2: Run → FAIL.** `.venv/bin/python3.12 -m pytest backend/tests/test_outline.py -v` (import error).

- [ ] **Step 3: Implement** in `doc_processor.py` (place after `build_heading_tree`):

```python
def parse_heading_outline(elements: list[dict]) -> list[dict]:
    """Nested H1–H4 outline from a flat element list. Each heading node is
    {"hid": int, "level": int, "text": str, "children": [...]}. `hid` is the
    heading's 0-based index in document order — the SAME counter
    attach_content_to_curriculum uses, so the aligner can key decisions by hid.

    Headings attach to the nearest previous heading of a shallower level (so a
    skipped level just nests under whatever is open)."""
    roots: list[dict] = []
    stack: list[dict] = []  # open ancestor heading nodes, increasing level
    hid = 0
    for elem in elements:
        if elem.get("type") != "heading":
            continue
        level = elem.get("level", 1)
        node = {"hid": hid, "level": level, "text": elem.get("text", ""), "children": []}
        hid += 1
        while stack and stack[-1]["level"] >= level:
            stack.pop()
        if stack:
            stack[-1]["children"].append(node)
        else:
            roots.append(node)
        stack.append(node)
    return roots
```

- [ ] **Step 4: Run → PASS** on both interpreters.
- [ ] **Step 5: Commit.**
```bash
git add backend/services/doc_processor.py backend/tests/test_outline.py
git commit -m "feat: parse_heading_outline — nested H1-H4 outline with stable hids"
```

---

## Task 3: `normalize_topic()` (curriculum_aligner)

Normalized matching that also strips the L1 exam-weight suffix (e.g. `Cardiovascular – 18%`).

**Files:** Create `backend/services/curriculum_aligner.py`; Test `backend/tests/test_aligner.py`

- [ ] **Step 1: Write failing test** (`backend/tests/test_aligner.py`):

```python
from backend.services.curriculum_aligner import normalize_topic


def test_normalize_basic():
    assert normalize_topic("  Parasitic   Infections ") == "parasitic infections"
    assert normalize_topic("Giardiasis / GI Parasites") == "giardiasis/gi parasites"


def test_normalize_strips_exam_weight_suffix():
    # seed curriculum L1 names carry an en-dash weight suffix
    assert normalize_topic("Cardiovascular – 18%") == "cardiovascular"
    assert normalize_topic("EENOT – 7%") == "eenot"
    assert normalize_topic("Pulmonary - 10%") == "pulmonary"   # hyphen variant too
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `backend/services/curriculum_aligner.py`:

```python
"""Aligns a document heading outline against a curriculum subtree.

Pure functions — no DB session. The caller loads Curriculum rows and passes them
as plain dicts so this module is trivially unit-testable.
"""
from __future__ import annotations
import re

_WEIGHT_SUFFIX = re.compile(r"\s*[–-]\s*\d+\s*%\s*$")  # " – 18%" / " - 10%"


def normalize_topic(s: str) -> str:
    """Normalize a topic/heading name for matching: drop a trailing exam-weight
    suffix, lowercase, collapse whitespace, tighten slashes."""
    s = _WEIGHT_SUFFIX.sub("", s or "")
    s = s.lower().strip()
    s = re.sub(r"\s*/\s*", "/", s)
    s = re.sub(r"\s+", " ", s)
    return s
```

- [ ] **Step 4: Run → PASS** both interpreters.
- [ ] **Step 5: Commit.**
```bash
git add backend/services/curriculum_aligner.py backend/tests/test_aligner.py
git commit -m "feat: normalize_topic with exam-weight suffix stripping"
```

---

## Task 4: `align()` — the diff + resolution map

**Files:** Modify `backend/services/curriculum_aligner.py`; Test append to `backend/tests/test_aligner.py`

**Contract:**
```
align(outline, main_topic, nodes) -> {
  "resolution": { hid: node_id | None },      # deepest position-aware match per heading
  "levels": [ { "depth": int, "expected": int, "present": int } , ... ],
  "missing_in_curriculum": [ { "hid": int, "name": str, "depth": int, "parent_id": int|None } ],
  "not_in_document": [ { "node_id": int, "name": str, "depth": int } ],
  "warnings": [ str ],                          # duplicate sibling names, etc.
}
```
- `outline`: from `parse_heading_outline`. `main_topic`: `{"id","name","level","path"}` (depth 0). `nodes`: list of all curriculum nodes in the subtree (each `{"id","parent_id","name","level","path"}`), including the main topic.
- **Matching rule:** a heading at outline-depth D (root headings are D=1) matches a curriculum node at `level == D` that is a **child of the matched parent node** (main_topic for D=1). A heading can only match if its parent heading matched (position-aware). Match = `normalize_topic` equal. First match wins; duplicate sibling matches → warning.
- A heading with no match → `resolution[hid] = None` and lands in `missing_in_curriculum` with `parent_id` = the matched parent node id (so the modal can Add it there). Its descendants auto-fail (parent chain broken) and also roll up.
- `not_in_document`: for each matched parent, curriculum children at the next depth whose names matched no heading.
- `levels`: per depth 1..maxDepth, `expected` = curriculum nodes at that depth under matched parents; `present` = headings at that outline-depth.

- [ ] **Step 1: Write failing tests** (append):

```python
from backend.services.curriculum_aligner import align

# main topic depth 0
MAIN = {"id": 1, "parent_id": None, "name": "Emergency Medicine", "level": 0, "path": "Emergency Medicine"}
NODES = [
    MAIN,
    {"id": 2, "parent_id": 1, "name": "Infectious Disease", "level": 1, "path": "Emergency Medicine > Infectious Disease"},
    {"id": 3, "parent_id": 2, "name": "Parasitic Infections", "level": 2, "path": "Emergency Medicine > Infectious Disease > Parasitic Infections"},
    {"id": 4, "parent_id": 3, "name": "Toxoplasmosis", "level": 3, "path": "Emergency Medicine > Infectious Disease > Parasitic Infections > Toxoplasmosis"},
]

def _outline():
    from backend.services.doc_processor import parse_heading_outline
    return parse_heading_outline([
        {"type": "heading", "level": 1, "text": "Infectious Disease"},
        {"type": "heading", "level": 2, "text": "Parasitic Infections"},
        {"type": "heading", "level": 3, "text": "Giardiasis/GI Parasites"},  # no node
        {"type": "heading", "level": 3, "text": "Toxoplasmosis"},            # node id 4
    ])

def test_align_resolution_deepest_match_and_rollup():
    r = align(_outline(), MAIN, NODES)
    res = r["resolution"]
    # hids: 0 Infectious Disease, 1 Parasitic Infections, 2 Giardiasis, 3 Toxoplasmosis
    assert res[0] == 2
    assert res[1] == 3
    assert res[2] is None              # Giardiasis/GI Parasites — no node → roll up
    assert res[3] == 4                 # Toxoplasmosis → its leaf

def test_align_missing_in_curriculum_points_at_parent():
    r = align(_outline(), MAIN, NODES)
    miss = {m["name"]: m for m in r["missing_in_curriculum"]}
    assert "Giardiasis/GI Parasites" in miss
    # its aligned parent is Parasitic Infections (id 3) at depth 3
    assert miss["Giardiasis/GI Parasites"]["parent_id"] == 3
    assert miss["Giardiasis/GI Parasites"]["depth"] == 3

def test_align_position_aware_same_name_other_branch_does_not_match():
    nodes = NODES + [
        {"id": 5, "parent_id": 1, "name": "Cardiology", "level": 1, "path": "Emergency Medicine > Cardiology"},
        {"id": 6, "parent_id": 5, "name": "Toxoplasmosis", "level": 2, "path": "Emergency Medicine > Cardiology > Toxoplasmosis"},
    ]
    r = align(_outline(), MAIN, nodes)
    # Toxoplasmosis under Parasitic Infections must resolve to 4, NOT 6
    assert r["resolution"][3] == 4

def test_align_levels_expected_vs_present():
    r = align(_outline(), MAIN, NODES)
    by_depth = {l["depth"]: l for l in r["levels"]}
    assert by_depth[1]["present"] == 1   # one H1
    assert by_depth[3]["present"] == 2   # two H3
    assert by_depth[3]["expected"] >= 1  # Toxoplasmosis exists under matched parent
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `align()` (append to `curriculum_aligner.py`):

```python
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
        # parent_node is the curriculum node the parent heading matched to, or
        # None if the chain is broken (then nothing below can match).
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

    # not_in_document: curriculum nodes whose parent was matched (or main topic)
    # but no heading matched them. Expected counts per depth (under matched parents).
    not_in_doc: list[dict] = []
    expected_by_depth: dict[int, int] = {}
    matched_parents = {main_topic["id"]} | matched_node_ids
    for n in nodes:
        if n["id"] == main_topic["id"]:
            continue
        if n["parent_id"] in matched_parents:
            d = n["level"]
            expected_by_depth[d] = expected_by_depth.get(d, 0) + 1
            if n["id"] not in matched_node_ids:
                not_in_doc.append({"node_id": n["id"], "name": n["name"], "depth": d})

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
```

- [ ] **Step 4: Run → PASS** both interpreters (4 new tests).
- [ ] **Step 5: Commit.**
```bash
git add backend/services/curriculum_aligner.py backend/tests/test_aligner.py
git commit -m "feat: curriculum align() — resolution map + per-level diff"
```

---

## Task 5: `attach_content_to_curriculum()` (doc_processor)

Group content blocks by deepest matched node, rolling up, preserving document order.

**Files:** Modify `backend/services/doc_processor.py`; Test `backend/tests/test_attach.py`

**Contract:** `attach_content_to_curriculum(elements, resolution, main_topic_id) -> list[dict]` where each group is `{"node_id": int, "elements": [...]}`. Walk `elements` with the SAME hid counter as the outline; maintain a stack of `(level, hid)`; for each **non-heading** element, find the deepest ancestor heading whose `resolution[hid]` is not None → that node; else `main_topic_id`. Group elements by resolved node id, **preserving original document order within each group**. Heading elements themselves are not content but may be retained for `build_heading_tree`/context per group (include them in their own group so heading_tree still builds).

- [ ] **Step 1: Write failing test** (`backend/tests/test_attach.py`):

```python
from backend.services.doc_processor import attach_content_to_curriculum

def _h(level, text): return {"type": "heading", "level": level, "text": text}
def _p(text): return {"type": "paragraph", "text": text}

# resolution mirrors Task 4: hids 0..3
RES = {0: 2, 1: 3, 2: None, 3: 4}
MAIN_ID = 1

ELEMENTS = [
    _h(1, "Infectious Disease"),      # hid 0 -> node 2
    _h(2, "Parasitic Infections"),    # hid 1 -> node 3
    _h(3, "Giardiasis/GI Parasites"), # hid 2 -> None (roll up to 3)
    _p("Amebiasis is..."),
    _p("Giardiasis is..."),
    _h(3, "Toxoplasmosis"),           # hid 3 -> node 4
    _p("Toxo is..."),
]

def test_attach_rollup_and_leaf():
    groups = {g["node_id"]: g for g in attach_content_to_curriculum(ELEMENTS, RES, MAIN_ID)}
    # Giardiasis content rolled up to Parasitic Infections (node 3)
    texts_3 = [e["text"] for e in groups[3]["elements"] if e["type"] == "paragraph"]
    assert texts_3 == ["Amebiasis is...", "Giardiasis is..."]
    # Toxo content on its leaf (node 4)
    texts_4 = [e["text"] for e in groups[4]["elements"] if e["type"] == "paragraph"]
    assert texts_4 == ["Toxo is..."]

def test_attach_preamble_goes_to_main_topic():
    groups = {g["node_id"]: g for g in attach_content_to_curriculum(
        [_p("intro before any heading")], {}, MAIN_ID)}
    assert groups[MAIN_ID]["elements"][0]["text"] == "intro before any heading"

def test_attach_preserves_document_order_within_group():
    # interleave so node 3 gathers non-contiguous blocks; order must hold
    els = [_h(2, "Parasitic Infections"), _p("a"), _h(3, "Toxoplasmosis"), _p("t"),
           _p("b")]  # 'b' has no heading after toxo? it's under Toxoplasmosis
    res = {0: 3, 1: 4}
    groups = {g["node_id"]: g for g in attach_content_to_curriculum(els, res, MAIN_ID)}
    assert [e["text"] for e in groups[3]["elements"] if e["type"] == "paragraph"] == ["a"]
    assert [e["text"] for e in groups[4]["elements"] if e["type"] == "paragraph"] == ["t", "b"]
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** (append to `doc_processor.py`):

```python
def attach_content_to_curriculum(elements: list[dict], resolution: dict,
                                 main_topic_id: int) -> list[dict]:
    """Group elements by the deepest matched curriculum node along each block's
    heading ancestry (rolling up; pre-heading content → main_topic_id). Returns
    [{"node_id": int, "elements": [...]}], groups in first-seen order, elements
    within a group in original document order (so build_content_html image
    numbering and SectionImage.position stay aligned)."""
    groups: dict[int, list[dict]] = {}
    order: list[int] = []
    stack: list[tuple[int, int]] = []  # (level, hid) of open headings
    hid = 0

    def emit(node_id: int, elem: dict):
        if node_id not in groups:
            groups[node_id] = []
            order.append(node_id)
        groups[node_id].append(elem)

    for elem in elements:
        if elem.get("type") == "heading":
            level = elem.get("level", 1)
            while stack and stack[-1][0] >= level:
                stack.pop()
            cur_hid = hid
            stack.append((level, cur_hid))
            hid += 1
            # Resolve this heading to its own node if matched, else nearest matched
            # ancestor, else main topic — so the heading row lands with its content.
            node_id = _resolve_node(stack, resolution, main_topic_id)
            emit(node_id, elem)
        else:
            node_id = _resolve_node(stack, resolution, main_topic_id)
            emit(node_id, elem)

    return [{"node_id": nid, "elements": groups[nid]} for nid in order]


def _resolve_node(stack: list[tuple[int, int]], resolution: dict, main_topic_id: int) -> int:
    for _level, h in reversed(stack):
        nid = resolution.get(h)
        if nid is not None:
            return nid
    return main_topic_id
```

- [ ] **Step 4: Run → PASS** both interpreters.
- [ ] **Step 5: Commit.**
```bash
git add backend/services/doc_processor.py backend/tests/test_attach.py
git commit -m "feat: attach_content_to_curriculum — deepest-match grouping with rollup"
```

---

## Task 6: Exempt `awaiting_reconcile` from the orphan sweep

**Files:** Modify `backend/main.py` (`_sweep_orphaned_jobs`, ~line 196)

- [ ] **Step 1:** Read `_sweep_orphaned_jobs`. It marks `ProcessingJob`/`GenerationJob` rows with `status.in_([pending, running])` as failed. For the `ProcessingJob` query ONLY, add a predicate so parked jobs survive:

```python
                model_cls.status.in_([JobStatus.pending, JobStatus.running]),
                # parked reconcile jobs are waiting on a human — don't fail them
                *( [ProcessingJob.pipeline_step != "awaiting_reconcile"] if model_cls is ProcessingJob else [] ),
```

(Adjust to the actual loop shape — if the function handles the two job types separately, just add `ProcessingJob.pipeline_step != "awaiting_reconcile"` to the ProcessingJob filter. Read the function first and integrate cleanly.)

- [ ] **Step 2: Verify import.** `.venv/bin/python3.12 -c "import backend.main; print('ok')"` → `ok`.
- [ ] **Step 3: Commit.**
```bash
git add backend/main.py
git commit -m "feat: keep awaiting_reconcile jobs out of the startup orphan sweep"
```

---

## Task 7: Endpoints + pipeline integration (`documents.py`)

This is the wiring. Read `documents.py` fully first. Sub-steps:

**7a — `_run_processing` takes a resolution map and uses attach.**
- [ ] Change `_run_processing(job_id)` → `_run_processing(job_id, resolution: dict | None = None)`. After parse + tables, **replace** the H2 split block (lines ~478-585) with:
  - If `resolution is None` (legacy/paste path), keep current `split_by_h2` behavior (so `/paste` and `ai-headings` are untouched).
  - Else: load main topic node (`tt.curriculum_id`), call `groups = attach_content_to_curriculum(elements, {int(k): v for k,v in resolution.items()}, tt.curriculum_id)`. For each group:
    - `node = db.get(Curriculum, group["node_id"])`; `heading = node.name`; `curriculum_topic_id = node.id`; `curriculum_topic_path = node.path`.
    - `heading_tree = build_heading_tree(group["elements"])`; `content_html = build_content_html(group["elements"])`; `content_text` join.
    - Create the `Section` keyed by `curriculum_topic_id` (slug = `slugify(f"{node.path}")` or `f"{node.id}-{slugify(node.name)}"` to avoid collisions). **Do not** use the `existing_sections[heading]` merge branch (fresh creation only).
    - Create content blocks / SectionImage with `position` enumerated over `group["elements"]` in order (unchanged logic).
  - Step 5 (images) is unchanged — it already groups by section + sorts by position.

**7b — Upload scans + parks instead of processing.**
- [ ] In `POST /upload`: after saving file + creating `tt`/`upload`/`job`, do NOT background `_run_processing`. Instead:
  - `elements = parse_docx(filepath)` (headings present), `outline = parse_heading_outline(elements)`, store `upload.heading_outline = outline`.
  - `job.status = running; job.pipeline_step = "awaiting_reconcile"`. Commit.
  - Return `{upload_id, processing_job_id, topic_tree_id, reconcile: <diff>}` where `<diff>` comes from a shared `_build_reconcile(db, upload)` helper (below). The main topic is `tt.curriculum_id` — **require it** (400 if missing: "Pick a main curriculum topic for this upload").

**7c — `_build_reconcile(db, upload)` helper + `GET /documents/{upload_id}/reconcile`.**
- [ ] Helper: load `tt`, main topic node + its subtree (`Curriculum.path.startswith(main.path)`, same version), build `nodes` dicts, `outline = upload.heading_outline`, return `align(outline, main_dict, nodes)` plus the curriculum subtree (so the modal can render the tree). Endpoint returns it fresh (re-runs align → reflects nodes just added).

**7d — `POST /documents/{upload_id}/continue`.**
- [ ] Validate job is `awaiting_reconcile`. Recompute `align` (fresh, post-edits) to get `resolution`. Set `job.pipeline_step = "parsing"`, background `_run_processing(job.id, resolution)`. Return `{processing_job_id}`.

- [ ] **Step: verify** the app imports and existing tests still pass:
  `.venv/bin/python3.12 -c "import backend.routers.documents; print('ok')"` and `.venv/bin/python3.12 -m pytest backend/tests -q`.
- [ ] **Commit.** `git commit -am "feat: reconcile-gated upload — scan/park, /reconcile, /continue, attach pipeline"`

---

## Task 8: Frontend — `ReconcileModal` + upload wiring

**Files:** Create `frontend/src/components/ReconcileModal.tsx`; modify `frontend/src/api.ts`, `frontend/src/types.ts`, `frontend/src/pages/WorkspacePage.tsx`.

- [ ] **8a — `api.ts`:** add `getReconcile(uploadId)` → `GET /documents/${id}/reconcile`; `continueProcessing(uploadId)` → `POST /documents/${id}/continue`. The upload call already returns `reconcile`. Add a `types.ts` `ReconcileDiff` interface mirroring the align result (`levels`, `missing_in_curriculum`, `not_in_document`, `warnings`) + the curriculum subtree.
- [ ] **8b — `ReconcileModal.tsx`:** props `{ uploadId, diff, onClose, onContinue }`. Renders:
  - The per-level summary table (`depth N: expected/present`, ✓ or "k missing in curriculum / m not in document").
  - The curriculum subtree (reuse the existing tree-node rendering pattern from `LibraryPage`/`CurriculumPicker`), annotating each node as matched / not-in-document, and each `missing_in_curriculum` heading with an **Add node** button that calls the existing `createCurriculumNode({name, parent_id})` then re-fetches `getReconcile` and updates state.
  - A "N headings will roll up to their parent" note (count of `resolution`→None, i.e. `missing_in_curriculum.length`).
  - **Continue** (calls `continueProcessing`, then closes + starts polling the processing job like the current flow) and **Cancel**.
- [ ] **8c — `WorkspacePage.tsx`:** after a successful upload, open `ReconcileModal` with the returned `diff` instead of immediately polling. On Continue, resume the existing processing-job polling/badge logic.
- [ ] **Step: build check.** `cd frontend && npm run build` → succeeds.
- [ ] **Commit.** `git commit -am "feat: ReconcileModal + curriculum-aligned upload flow (frontend)"`

---

## Task 9: Integration test + manual verification

- [ ] **9a — Integration test** (`backend/tests/test_reconcile_flow.py`, uses a temp SQLite + FastAPI `TestClient`): seed a tiny curriculum (main topic + Parasitic Infections + Toxoplasmosis), insert an `Upload` with a `heading_outline` matching the Parasitic Infections example, call `GET /reconcile` → assert the diff (Giardiasis in `missing_in_curriculum`, Toxoplasmosis matched). Then drive `_run_processing(job_id, resolution)` directly with a stub element list and assert sections are created with the right `curriculum_topic_path` (Toxoplasmosis section → `…>Toxoplasmosis`; Giardiasis content → `…>Parasitic Infections`). Run on both interpreters.
- [ ] **9b — Orphan-sweep test:** insert a `ProcessingJob` with `pipeline_step="awaiting_reconcile", status=running`, call `_sweep_orphaned_jobs()`, assert it is still `running` (not failed); a normal running job IS failed.
- [ ] **9c — Manual:** wipe DB (`rm data/app.db`), restart backend, upload a real doc into a main topic, confirm the reconcile modal shows correct expected/present counts, add a missing leaf, Continue, and confirm cards generated from the Toxoplasmosis section are tagged to the Toxoplasmosis leaf.
- [ ] **Commit.** `git commit -am "test: integration + orphan-sweep coverage for reconcile flow"`

---

## Done when

- Upload opens a reconcile modal showing per-level expected/present and discrepancies; you can add missing leaves inline.
- Continue attaches content to the deepest matched curriculum node (rollup for unmatched); cards inherit the correct deep path (Toxoplasmosis → its leaf).
- `awaiting_reconcile` jobs survive a restart.
- `backend/tests` green on Python 3.9 AND 3.12; `npm run build` succeeds.
- `/paste` and `ai-headings` paths still work (legacy split untouched).
