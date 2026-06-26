# Reconcile Step Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the reconcile step with an ephemeral scan (nothing committed to the DB until Continue), a fuzzy-matching aligner, one merged diff-tree (matched/fuzzy/missing/new) rendered in a single redesigned modal with an All/Differences toggle and opt-in Include checkboxes, and a Continue that creates the selected curriculum nodes, re-aligns, then processes.

**Architecture:** The matcher (`align`) gains a `difflib` fuzzy pass; new pure functions `build_merged_tree` and `expand_includes` carry the tree/selection logic (all unit-testable on plain data). The scan endpoint stores state as a temp file + sidecar JSON (no DB rows); Continue applies included nodes, re-aligns, and reuses the existing `_run_processing(job_id, resolution)`.

**Tech Stack:** FastAPI, SQLAlchemy, python-docx, React 19 + TS, pytest, stdlib `difflib`.

**Spec:** `docs/superpowers/specs/2026-06-26-reconcile-step-redesign-design.md`

---

## Conventions

- Tests run on BOTH interpreters (split venv): `.venv/bin/python -m pytest backend/tests -q` (3.9) AND `.venv/bin/python3.12 -m pytest backend/tests -q` (3.12, the server's). Both green to finish a task.
- Pure functions take plain dicts/lists — no DB, no keys, trivially testable.
- Branch: `git switch -c feat/reconcile-redesign` before Task 1. Commit per task.
- **Before manual testing:** delete any upload parked at `awaiting_reconcile` (the old gated path is retired). `.venv/bin/python3.12 -c "from backend.db import SessionLocal; from backend.models import ProcessingJob, JobStatus; db=SessionLocal(); [db.delete(j) for j in db.query(ProcessingJob).filter(ProcessingJob.pipeline_step=='awaiting_reconcile').all()]; db.commit()"` (or just `rm data/app.db` to start fresh — curriculum re-seeds).

## Key existing facts (don't re-derive)

- `curriculum_aligner.align(outline, main_topic, nodes)` returns `{resolution, levels, missing_in_curriculum, not_in_document, warnings}`. `resolution[hid] -> node_id|None`. `normalize_topic` already strips em/en-dash exam-weight suffixes. The `walk` matches a heading at outline-depth D against curriculum children with `level == D` of the matched parent.
- `parse_heading_outline(elements)` → nested outline, each node `{hid, level, text, children}`; `hid` = 0-based heading index over `parse_docx` elements. `attach_content_to_curriculum(elements, resolution, main_topic_id)` re-derives the SAME hids walking the same `parse_docx` elements — this is why scan and Continue must both use `parse_docx`.
- `_run_processing(job_id, resolution=None)` (documents.py) loads upload+tt from DB, reads `UPLOAD_DIR/upload.filename`, and when `resolution` is given creates sections via `attach_content_to_curriculum`.
- `create_node` (`POST /api/curriculum`) derives level/path/version from parent. `rename_node` = `PATCH /api/curriculum/{id}` (frontend `updateCurriculumNode`).
- `DATA_DIR`/`UPLOAD_DIR` in `config.py`. Add `SCAN_DIR = os.path.join(DATA_DIR, "scans")`.

## File structure

- Modify `backend/services/curriculum_aligner.py` — fuzzy pass in `align`; add `build_merged_tree`, `expand_includes`.
- Modify `backend/config.py` — `SCAN_DIR`.
- Modify `backend/routers/documents.py` — `POST /scan`, `POST /continue` (new shape), `DELETE /scan/{token}`; retire old gated path.
- Modify `backend/main.py` — temp-scan cleanup in lifespan.
- Rewrite `frontend/src/components/ReconcileModal.tsx`; modify `api.ts`, `types.ts`, `WorkspacePage.tsx`, `LibraryPage.tsx`.
- Tests under `backend/tests/`.

---

## Task 1: Fuzzy pass in `align`

**Files:** Modify `backend/services/curriculum_aligner.py`; Test append `backend/tests/test_aligner.py`.

The fuzzy match must run **after** all exact matches in a sibling group are claimed (so fuzzy never steals an exact match). Restructure `walk` to two passes per group.

- [ ] **Step 1: Add failing tests** (append to `test_aligner.py`):

```python
from backend.services.curriculum_aligner import align as _align2  # alias to avoid clobber; or reuse align

def test_fuzzy_matches_near_miss_and_reports_diff():
    main = {"id": 1, "parent_id": None, "name": "EM", "level": 0, "path": "EM"}
    nodes = [main,
        {"id": 2, "parent_id": 1, "name": "Atrial Fibrillation", "level": 1, "path": "EM > Atrial Fibrillation"}]
    from backend.services.doc_processor import parse_heading_outline
    outline = parse_heading_outline([{"type": "heading", "level": 1, "text": "Atrial Fibrillation (AFib)"}])
    r = align(outline, main, nodes)
    assert r["resolution"][0] == 2                      # fuzzy resolves to the node
    f = {x["hid"]: x for x in r["fuzzy"]}
    assert 0 in f and f[0]["node_id"] == 2
    assert f[0]["doc_name"] == "Atrial Fibrillation (AFib)"
    assert f[0]["curr_name"] == "Atrial Fibrillation"

def test_exact_beats_fuzzy_no_steal():
    main = {"id": 1, "parent_id": None, "name": "EM", "level": 0, "path": "EM"}
    nodes = [main,
        {"id": 2, "parent_id": 1, "name": "Atrial Fibrillation", "level": 1, "path": "EM > Atrial Fibrillation"},
        {"id": 3, "parent_id": 1, "name": "Atrial Flutter", "level": 1, "path": "EM > Atrial Flutter"}]
    from backend.services.doc_processor import parse_heading_outline
    # "Atrial Flutter" exact + "Atrial Fibrilation" (typo) fuzzy — fuzzy must NOT grab Flutter
    outline = parse_heading_outline([
        {"type": "heading", "level": 1, "text": "Atrial Fibrilation"},
        {"type": "heading", "level": 1, "text": "Atrial Flutter"}])
    r = align(outline, main, nodes)
    assert r["resolution"][1] == 3                      # Flutter exact
    assert r["resolution"][0] == 2                      # Fibrilation fuzzy -> Fibrillation
    assert not any(x["node_id"] == 3 for x in r["fuzzy"])

def test_ambiguous_fuzzy_stays_new():
    main = {"id": 1, "parent_id": None, "name": "EM", "level": 0, "path": "EM"}
    nodes = [main,
        {"id": 2, "parent_id": 1, "name": "Cardio A", "level": 1, "path": "EM > Cardio A"},
        {"id": 3, "parent_id": 1, "name": "Cardio B", "level": 1, "path": "EM > Cardio B"}]
    from backend.services.doc_processor import parse_heading_outline
    outline = parse_heading_outline([{"type": "heading", "level": 1, "text": "Cardio C"}])
    r = align(outline, main, nodes)
    assert r["resolution"][0] is None                  # two equally-close → new, no grab
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** At module top add constants:
```python
from difflib import SequenceMatcher
FUZZY_THRESHOLD = 0.85
FUZZY_MARGIN = 0.05
```
Add `fuzzy: list[dict] = []` next to `missing`/`warnings` in `align`, return it in the dict (`"fuzzy": fuzzy`). Replace the per-group loop body in `walk` with a **two-pass** version:

```python
    def walk(heading_nodes, parent_node, depth):
        cands = list(_children(nodes_by_parent, parent_node["id"])) if parent_node else []
        cands = [c for c in cands if c["level"] == depth]
        claimed = set()  # candidate node ids claimed in THIS group
        decided = {}     # hid -> matched candidate (or None)

        # Pass 1: exact
        for h in heading_nodes:
            present_by_depth[depth] = present_by_depth.get(depth, 0) + 1
            norm = normalize_topic(h["text"])
            match = None
            if parent_node is not None:
                for c in cands:
                    if c["id"] not in claimed and normalize_topic(c["name"]) == norm:
                        match = c; claimed.add(c["id"]); break
            decided[h["hid"]] = match

        # Pass 2: fuzzy on the still-unmatched headings, against still-unclaimed cands
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
                c = scored[0][1]; claimed.add(c["id"]); decided[h["hid"]] = c
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
```

Keep the existing `expected_by_depth`/`not_in_document`/`levels` computation unchanged. (Remove the old single-pass `seen_norm` dup-warning or keep a dup check — optional; not required by tests.)

- [ ] **Step 4: Run → PASS both interpreters** (whole `test_aligner.py`, prior tests still green).
- [ ] **Step 5: Commit** `feat: fuzzy match pass in align (difflib, threshold+margin)`.

---

## Task 2: `build_merged_tree`

**Files:** Modify `curriculum_aligner.py`; Test `backend/tests/test_merged_tree.py`.

Builds ONE tree rooted at the main topic: curriculum nodes tagged matched/fuzzy/missing, with new document headings grafted under their parent (nested). Node depth = nesting depth (root=0).

- [ ] **Step 1: Failing test** (`backend/tests/test_merged_tree.py`):

```python
from backend.services.curriculum_aligner import align, build_merged_tree
from backend.services.doc_processor import parse_heading_outline

MAIN = {"id": 1, "parent_id": None, "name": "EM", "level": 0, "path": "EM"}
NODES = [MAIN,
    {"id": 2, "parent_id": 1, "name": "Cardiovascular", "level": 1, "path": "EM > Cardiovascular"},
    {"id": 3, "parent_id": 2, "name": "Arrhythmias", "level": 2, "path": "EM > Cardiovascular > Arrhythmias"},
    {"id": 4, "parent_id": 3, "name": "Atrial", "level": 3, "path": "EM > Cardiovascular > Arrhythmias > Atrial"}]

def _outline():
    return parse_heading_outline([
        {"type": "heading", "level": 1, "text": "Cardiovascular — 18%"},  # fuzzy/exact (suffix stripped)
        {"type": "heading", "level": 2, "text": "Arrhythmias"},
        {"type": "heading", "level": 3, "text": "Atrial"},
        {"type": "heading", "level": 3, "text": "Ventricular"},           # NEW (no node)
    ])

def test_merged_tree_statuses_and_graft():
    r = align(_outline(), MAIN, NODES)
    root = build_merged_tree(_outline(), MAIN, NODES, r)
    assert root["status"] == "matched" and root["node_id"] == 1 and root["depth"] == 0
    cardio = root["children"][0]
    assert cardio["name"] == "Cardiovascular" and cardio["status"] == "matched" and cardio["depth"] == 1
    arr = cardio["children"][0]
    assert arr["name"] == "Arrhythmias"
    names = [(c["name"], c["status"]) for c in arr["children"]]
    assert ("Atrial", "matched") in names
    assert ("Ventricular", "new") in names              # grafted under Arrhythmias
    vent = [c for c in arr["children"] if c["name"] == "Ventricular"][0]
    assert vent["hid"] is not None and vent["node_id"] is None and vent["depth"] == 3

def test_merged_tree_missing_node():
    # curriculum has 'Atrial' but the document does not mention it
    outline = parse_heading_outline([
        {"type": "heading", "level": 1, "text": "Cardiovascular"},
        {"type": "heading", "level": 2, "text": "Arrhythmias"}])
    r = align(outline, MAIN, NODES)
    root = build_merged_tree(outline, MAIN, NODES, r)
    arr = root["children"][0]["children"][0]
    atrial = [c for c in arr["children"] if c["name"] == "Atrial"][0]
    assert atrial["status"] == "missing"
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** (append to `curriculum_aligner.py`):

```python
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
        if n["id"] in fuzzy_node_ids:
            status = "fuzzy"
        elif n["id"] in matched_node_ids:
            status = "matched"
        else:
            status = "missing"
        by_id[n["id"]] = {"status": status, "name": n["name"], "depth": n["level"],
                          "node_id": n["id"], "hid": None, "doc_name": None,
                          "score": None, "children": []}
    # fuzzy diff details onto the matched curriculum node
    for f in fuzzy:
        tn = by_id.get(f["node_id"])
        if tn:
            tn["doc_name"] = f["doc_name"]; tn["score"] = f["score"]
    # link curriculum children under parents (skip main topic as a child)
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
                      "score": None, "children": []}
                parent_tn["children"].append(tn)
                graft(h["children"], tn)

    graft(outline, root)
    return root
```

- [ ] **Step 4: Run → PASS both interpreters.**
- [ ] **Step 5: Commit** `feat: build_merged_tree (matched/fuzzy/missing/new diff tree)`.

---

## Task 3: `expand_includes`

**Files:** Modify `curriculum_aligner.py`; Test `backend/tests/test_expand_includes.py`.

Given a set of selected `new` heading hids, return them PLUS any new ancestor hids, ordered parents-before-children, using the outline parent chain.

- [ ] **Step 1: Failing test** (`backend/tests/test_expand_includes.py`):

```python
from backend.services.curriculum_aligner import expand_includes
from backend.services.doc_processor import parse_heading_outline

def test_expand_includes_pulls_ancestors_parents_first():
    outline = parse_heading_outline([
        {"type": "heading", "level": 1, "text": "H1"},   # hid 0
        {"type": "heading", "level": 2, "text": "H2"},   # hid 1
        {"type": "heading", "level": 3, "text": "H3"},   # hid 2
    ])
    # select only the deepest (hid 2) -> must pull in 1 then 0, ordered 0,1,2
    assert expand_includes([2], outline) == [0, 1, 2]

def test_expand_includes_dedups_and_orders():
    outline = parse_heading_outline([
        {"type": "heading", "level": 1, "text": "A"},    # 0
        {"type": "heading", "level": 2, "text": "B"},    # 1
        {"type": "heading", "level": 2, "text": "C"},    # 2
    ])
    assert expand_includes([2, 1], outline) == [0, 1, 2]
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** (append):

```python
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
    return [hid for hid in order if hid in wanted]  # document order = parents first
```

- [ ] **Step 4: Run → PASS both interpreters.**
- [ ] **Step 5: Commit** `feat: expand_includes (auto-include new ancestors, ordered)`.

---

## Task 4: `SCAN_DIR` config + scan endpoint

**Files:** Modify `backend/config.py`, `backend/routers/documents.py`.

- [ ] **Step 1: config.** Add to `config.py`: `SCAN_DIR = os.path.join(DATA_DIR, "scans")`.

- [ ] **Step 2: `POST /api/topic-trees/scan`.** Read `upload_document` for the form/validation pattern. New endpoint:
  - Form: `file`, `topic_tree_name`, `topic_tree_id`, `curriculum_id`. Resolve the main topic id + version: if `topic_tree_id` given → load tt → `curriculum_id = tt.curriculum_id`; else use the `curriculum_id` form field. **400** if no main topic.
  - `os.makedirs(SCAN_DIR, exist_ok=True)`; `scan_token = uuid.uuid4().hex`; save the docx to `SCAN_DIR/{scan_token}.docx`.
  - `elements = parse_docx(path)`; `outline = parse_heading_outline(elements)`.
  - Load main topic + subtree (reuse the `or_(id==main.id, path.startswith(main.path+" > "))` + version query from `_build_reconcile`). Build `nodes` dicts + `main_dict`.
  - `result = align(outline, main_dict, nodes)`; `tree = build_merged_tree(outline, main_dict, nodes, result)`.
  - Write sidecar `SCAN_DIR/{scan_token}.json` = `{"outline": outline, "main_topic_id": main.id, "version": main.version, "topic_tree_id": topic_tree_id, "topic_tree_name": topic_tree_name, "original_name": file.filename, "created_at": <iso>}`.
  - Return `{"scan_token": scan_token, "tree": tree, "summary": result["levels"], "fuzzy": result["fuzzy"], "main_topic": main_dict}`.
  - **No DB rows created.**

- [ ] **Step 3: `DELETE /api/topic-trees/scan/{scan_token}`** — best-effort remove the `.docx` + `.json` (ignore missing). Return 204.

- [ ] **Step 4: Verify** import + a smoke test via `TestClient` (or manual curl) that scan returns a tree and creates NO TopicTree/Upload rows. `.venv/bin/python3.12 -m pytest backend/tests -q` still green.
- [ ] **Step 5: Commit** `feat: ephemeral /scan endpoint (temp file + sidecar, no DB rows)`.

---

## Task 5: Continue endpoint (new shape) + retire old gated path

**Files:** Modify `backend/routers/documents.py`.

- [ ] **Step 1: `POST /api/topic-trees/continue`** with body `{scan_token: str, included_hids: list[int]}`:
  1. Load sidecar JSON + confirm `SCAN_DIR/{token}.docx` exists (404 "scan expired" if not).
  2. `from backend.services.curriculum_aligner import expand_includes, align`. `ordered = expand_includes(body.included_hids, sidecar["outline"])`.
  3. Build helpers from the outline: a `hid -> heading node` map and `hid -> parent_hid`. Re-run `align(outline, main_dict, current_subtree_nodes)` to get `resolution` (so each ordered hid knows whether its parent hid is matched→node_id).
  4. **Create included nodes parents-first.** Load the main topic ORM row `main = db.get(Curriculum, sidecar["main_topic_id"])` (do NOT rely on a plain dict for version). Build `parent_of` from the **outline** (hid → parent_hid, None for top-level) exactly as `expand_includes` does — parent linkage comes from the outline, NEVER from `align`'s `missing[].parent_id`. Maintain `minted: dict[hid, new_node_id]`. For each hid in `ordered` (skip any whose `resolution[hid]` is already a node — not new):
     - `parent_hid = parent_of.get(hid)` (may be `None`).
     - Resolve the **parent Curriculum row**: if `parent_hid is None` → the parent is `main`; elif `resolution.get(parent_hid)` is a node id → `db.get(Curriculum, that_id)`; else → `db.get(Curriculum, minted[parent_hid])`.
     - Create the node deriving from that parent ORM row (`level = parent.level + 1`, `path = parent.path + " > " + name`, `version = parent.version`), `name` = the **raw heading text** (`outline` node's `text`). `minted[hid] = new.id`. (Mirror `create_node` in `curriculum.py`.)
     - Commit after the loop.
  5. **Re-align** `align(outline, main_dict, refreshed_subtree_nodes)` → `resolution2` (now resolves the newly-created headings).
  6. Resolve/create the topic tree: if `sidecar.topic_tree_id` → load it; else create (name from `topic_tree_name`/original_name, slug, `curriculum_id = main_topic_id`) — reuse the slug-collision 409 logic from `upload_document`.
  7. Move the temp docx into `UPLOAD_DIR`: `stored_name = f"{uuid.hex}_{original_name}"`, `shutil.move(scan.docx, UPLOAD_DIR/stored_name)`. Create `Upload(topic_tree_id, original_name, filename=stored_name, status="processing")`, flush. Create `ProcessingJob(upload_id, status=pending, pipeline_step="parsing")`. Commit.
  8. `background_tasks.add_task(_run_processing, job.id, resolution2)`. Remove the sidecar `.json` (docx already moved). Return `{"processing_job_id": job.id, "topic_tree_id": tt.id}`.
  > Order matters: tt+upload+job committed and docx in UPLOAD_DIR BEFORE the background task runs (it loads them from DB/disk).

- [ ] **Step 2: Retire the old gated path.** **Delete the `POST /upload` route entirely** — both its consumers (`WorkspacePage`, `LibraryPage`) migrate to `scanDocument` in Task 9. Remove `GET /{upload_id}/reconcile`, the old `POST /{upload_id}/continue`, and `_build_reconcile` (no longer referenced). `/paste` and `ai-headings` use their own functions; `_run_processing` stays. Keep the orphan-sweep `awaiting_reconcile` exemption (harmless).
- [ ] **Imports:** add `import shutil` and `import json` to `documents.py` if not present.

- [ ] **Step 3: Verify** import + existing tests green on both interpreters. Confirm `/paste` and `ai-headings` still work (unchanged path).
- [ ] **Step 4: Commit** `feat: /continue creates included nodes, re-aligns, processes; retire gated upload`.

---

## Task 6: Temp-scan cleanup sweep

**Files:** Modify `backend/main.py`.

- [ ] **Step 1:** Add `_sweep_old_scans()` (delete files in `SCAN_DIR` older than ~6h by mtime; create dir if missing; swallow errors) and call it in the lifespan alongside `_sweep_orphaned_jobs()`.
- [ ] **Step 2:** Verify `import backend.main` ok on both interpreters.
- [ ] **Step 3: Commit** `feat: sweep abandoned temp scans on startup`.

---

## Task 7: Frontend — api.ts + types.ts

> **Frontend Tasks 7–9 are ONE build unit.** The TS build is intentionally RED after Tasks 7 and 8 (consumers not yet updated) and only goes green after Task 9. The per-task commits in 7/8 are WIP checkpoints — do not deploy between them. Verify `npm run build` only at the end of Task 9.

**Files:** Modify `frontend/src/api.ts`, `frontend/src/types.ts`. Also remove the now-dead `ReconcileSubtreeNode` interface from `types.ts` (it's only used by the old modal).

- [ ] **Step 1: types.ts.** Add:
```ts
export type MergedStatus = 'matched' | 'fuzzy' | 'missing' | 'new';
export interface MergedNode {
  status: MergedStatus; name: string; depth: number;
  node_id: number | null; hid: number | null;
  doc_name: string | null; score: number | null; children: MergedNode[];
}
export interface ScanResult {
  scan_token: string; tree: MergedNode;
  summary: { depth: number; expected: number; present: number }[];
  fuzzy: { hid: number; node_id: number; doc_name: string; curr_name: string; score: number }[];
  main_topic: { id: number; name: string; level: number; path: string };
}
```
Remove the old `ReconcileDiff` interface (and its `missing_in_curriculum`/`not_in_document`).
- [ ] **Step 2: api.ts.**
  - `scanDocument(file, {topicTreeId?, topicTreeName?, curriculumId?}) -> ScanResult` → multipart `POST /topic-trees/scan`.
  - `deleteScan(scanToken) -> void` → `DELETE /topic-trees/scan/${scanToken}`.
  - Change `continueProcessing` to `(scanToken: string, includedHids: number[]) -> {processing_job_id, topic_tree_id}` → `POST /topic-trees/continue`.
  - Remove `getReconcile`; update `uploadDocument`'s return type if anything referenced `reconcile`.
- [ ] **Step 3: Build check** `cd frontend && npm run build` (will fail until Task 8 updates consumers — OK to commit api/types together with Task 8, or stub). Prefer: do Tasks 7–9 then build once.
- [ ] **Step 4: Commit** `feat: scan/continue api + MergedNode types`.

---

## Task 8: Frontend — rewrite `ReconcileModal.tsx`

**Files:** Rewrite `frontend/src/components/ReconcileModal.tsx`.

Props: `{ scanToken: string; tree: MergedNode; summary; onClose; onContinue: (jobId: number) => void }`.
- [ ] State: `includedHids: Set<number>` (default empty); `view: 'all' | 'diff'`; local copy of `tree` so Edit-leaf rename can update a node's name in place.
- [ ] Recursive `<TreeNode>` render (reuse the indentation + 0-based level badge style from `CurriculumPicker`):
  - **matched** — normal.
  - **fuzzy** — found styling + ⚠ chip `curriculum: "{name}" vs document: "{doc_name}" ({score})` + **Edit leaf** button → inline rename via `updateCurriculumNode(node_id, {name})`, update local tree.
  - **missing** — greyed + "Missing" label.
  - **new** — "New" badge + **Include** checkbox bound to `includedHids` (toggle adds/removes the hid; toggling on also adds new-ancestor hids by walking `tree`; toggling off removes this hid + its new descendants). Per-subtree "Include all under here" button; global "Include all new" at top.
- [ ] **Toggle All / Differences.** In `diff` view, render only nodes whose subtree contains a fuzzy/missing/new descendant OR is itself one; show matched ancestors greyed for context.
- [ ] **Summary bar** (per depth) from `summary` + counts of statuses computed by walking the tree (matched/fuzzy/new/missing).
- [ ] **Continue** → `continueProcessing(scanToken, [...includedHids])`, then `onContinue(res.processing_job_id)`. **Cancel** → `deleteScan(scanToken)` then `onClose()`.
- [ ] Do NOT read `missing_in_curriculum`/`not_in_document` (removed). Drop the old imports: `ReconcileDiff`, `ReconcileSubtreeNode`, `getReconcile`, `createCurriculumNode` (creation now happens in backend Continue; the modal only uses `updateCurriculumNode`, `continueProcessing`, `deleteScan`).
- [ ] **Commit** `feat: rewrite ReconcileModal as merged diff-tree`.

---

## Task 9: Frontend — wire `WorkspacePage.tsx` AND `LibraryPage.tsx`

**Files:** Modify `frontend/src/pages/WorkspacePage.tsx`, `frontend/src/pages/LibraryPage.tsx`.

Both pages have a `handleUploadConfirm` that calls `uploadDocument` + `setProcessingJobId(result.processing_job_id)` (LibraryPage never opened a modal — it's already broken by the shipped gated upload, which this fixes). Apply the same change to BOTH:
- [ ] Replace the `uploadDocument(...)` call with `scanDocument(file, {...})`. On success set a `reconcile` state to `{scanToken, tree, summary}` and render `<ReconcileModal>`; do NOT set `processingJobId` (nothing parked). `LibraryPage` must import `ReconcileModal` + `scanDocument` (it currently imports neither).
- [ ] `ReconcileModal onContinue={(jobId) => { setReconcile(null); setUploading(true); setProcessingJobId(jobId); }}` resumes the existing poller (whose completion handler already calls `loadTopicTrees`, so a brand-new tree appears). `onClose={() => setReconcile(null)}`.
- [ ] In `WorkspacePage.tsx`: change the `ReconcileDiff` type import (line ~21) and the `reconcile` state type (line ~823, currently `{uploadId; diff}`) to `{scanToken: string; tree: MergedNode; summary: ...}`. Remove the `uploadDocument`/`getReconcile` imports if now unused.
- [ ] **Build:** `cd frontend && npm run build` → success (resolve all type errors across Tasks 7–9 here). This is the first green build of the frontend trio.
- [ ] **Commit** `feat: wire scan/continue upload flow in WorkspacePage + LibraryPage`.

---

## Task 10: Integration tests + manual verify

**Files:** `backend/tests/test_scan_continue_flow.py`.

- [ ] **10a — scan creates no DB rows:** with a temp SQLite + monkeypatched `SessionLocal`, seed a curriculum, `TestClient` `POST /topic-trees/scan` (multipart, a tiny generated .docx or a monkeypatched `parse_docx`), assert response has `tree`/`scan_token` AND zero `TopicTree`/`Upload` rows exist.
- [ ] **10b — continue applies includes + attaches:** seed curriculum missing a leaf the doc has; `POST /continue` with that leaf's hid in `included_hids`; assert the curriculum gained exactly that node, a section attaches to it, and an UNincluded new heading's content rolled up to the parent. (Drive `_run_processing` with monkeypatched `parse_docx` returning the fixture elements, as in the existing `test_reconcile_flow.py`.)
- [ ] **10c — expand/ancestor:** continue with only a deep new hid included → its new ancestors are also created.
- [ ] **10d — manual:** `rm data/app.db`, restart backend, upload the real EM doc into Emergency Medicine → reconcile modal shows the merged tree (13 matched bands, fuzzy/new/missing), toggle All/Differences works, Include a few new nodes, Continue → sections created, cards inherit correct paths.
- [ ] **Commit** `test: scan/continue integration coverage`.

---

## Done when

- Upload opens the new merged-tree modal; nothing is in the DB until Continue.
- Fuzzy near-misses show as found-with-diff and are Edit-leaf-able; exact never stolen by fuzzy; ambiguous → new.
- Include (opt-in, auto-include ancestors) + All/Differences toggle work; the old missing/new lists are gone.
- Continue creates selected curriculum nodes, re-aligns, processes; unincluded new → roll up.
- `backend/tests` green on 3.9 AND 3.12; `npm run build` succeeds.
