# Design: Curriculum-Aligned Document Ingestion

**Date:** 2026-06-26
**Status:** Approved (pending implementation)
**Scope:** Replace the current H2-only document split + shallow curriculum
matching with a level-aligned ingestion flow: a pre-process **reconcile gate**
that diffs the uploaded document's heading outline against the curriculum subtree
under a chosen main topic, lets the reviewer add missing nodes, and then attaches
each content chunk to the **deepest matched curriculum node** (rolling up when a
level has no match).

## Motivation

Today the document processor splits only at **Heading 2** (`split_by_h2`) and
matches the whole H2 section to one curriculum node by name
(`_match_section_to_curriculum`). Every card in that section inherits that single
tag. So in a section like "Parasitic Infections" containing H3s "Giardiasis/GI
Parasites" and "Toxoplasmosis", the Toxoplasmosis cards do **not** land on the
existing Toxoplasmosis curriculum leaf — they're all tagged "Parasitic
Infections". H3/H4 only influence AI wording (via `heading_tree`), never routing.

The reviewer wants document heading levels to align to curriculum depth
(main topic = depth 0; H1→depth 1, H2→depth 2, H3→depth 3, H4→depth 4), with a
pre-process step that surfaces gaps between document and curriculum so the
curriculum can be corrected before any content is processed.

## Constraints / context

- Two-user internal MVP, no auth.
- **No migration needed** — the DB can be wiped and re-seeded; existing
  sections/cards need not be preserved. This frees us to change `sections`
  semantics directly.
- The curriculum is versioned (v1/v2); the scan operates within the chosen main
  topic's subtree and version.
- The semantic merge engine (`duplicate_detector.py`, `merge_engine.py`) is
  already unwired dead code — re-upload/merge is explicitly out of scope.
- Existing card tagging already does `tags = section.curriculum_topic_path.split(" > ")`
  (`generate.py:587`), so once a section points at the correct deep node, cards
  inherit the correct tag with no card-side change.

## Confirmed behaviors (from brainstorming)

1. **Deepest matched node; unmatched rolls up.** Content attaches to the deepest
   curriculum node whose heading matches along the ancestry; if a level has no
   match, content rolls up to the nearest matched ancestor (ultimately the main
   topic at depth 0).
2. **Matching is name-based + position-aware.** A heading at level L matches a
   curriculum node at depth L only when that node is a descendant of the already
   matched parent heading's node. Same name in a different branch does not match.
3. **Adding a node in the reconcile modal edits the real curriculum** (persists,
   benefits future uploads). Intended.
4. **The content/card unit** is no longer "the H2 section" but "a curriculum node
   that ends up with content under it" after roll-up.

## Approach chosen

**Reconcile-then-attach, content keyed to the deepest matched curriculum node.**
Rejected: (B) materialize a full document-side tree mirroring the curriculum —
more moving parts than needed; (C) keep the H2 split and sub-tag H3/H4 — doesn't
deliver the level-aligned reconcile flow. (A) is the direct fit and reuses the
existing `sections`/`cards` tables.

## New upload flow (the reconcile gate)

1. **Upload** `.docx` + pick the **main topic** (one of 7) → that curriculum node
   is **depth 0**.
2. **Headings-only parse** (`parse_heading_outline`) — fast, no content/image/AI
   work. Produces the document's H1–H4 outline (nested).
3. **Align & diff** (`curriculum_aligner.align`) against the curriculum subtree
   under the main topic, level by level, matching by normalized name within the
   aligned parent.
4. **Job parks in `awaiting_reconcile`.** The reconcile modal renders the
   curriculum subtree annotated, with a per-level summary
   (`depth 1: 14 expected / 14 found ✓`, `depth 2: 9 expected / 10 found — 1
   missing in curriculum`, …) and inline **Add node** buttons. The reviewer
   resolves discrepancies; the tree updates live (re-fetch `/reconcile`).
5. **Continue** → the real pipeline runs: `attach_content_to_curriculum` groups
   content blocks by deepest matched node → creates `sections` (one per node with
   content) → images/tables → ready for generation. Cards later inherit the
   node's full path as tags.

## Components

### Schema changes (small)
- `uploads` → add **`heading_outline`** (JSON): the parsed H1–H4 outline saved at
  scan time, so the modal renders and **Continue** resumes without re-parsing.
- `processing_jobs.pipeline_step` → add **`awaiting_reconcile`** state.
- `sections` → **no new columns**; `curriculum_topic_id` / `curriculum_topic_path`
  now reference the **deepest matched node at any depth** (today they are
  effectively H2-level). `section.heading` becomes that node's heading; any deeper
  un-matched structure stays in `heading_tree`.
- `topic_trees` → one per main topic, `curriculum_id` = the depth-0 node.
- `cards` → unchanged.

### New service — `backend/services/curriculum_aligner.py`
The diff/align logic, kept separate so it is unit-testable in isolation.
- `align(outline, main_topic_node, db) -> AlignmentResult` where `AlignmentResult`
  carries:
  - **per-level diff**: for each depth, `expected` (curriculum node count),
    `present` (document heading count), and the lists `matched`,
    `missing_in_curriculum` (in doc, not in curriculum — offers **Add**),
    `not_in_document` (in curriculum, not in doc — **inform only**).
  - **resolution map**: heading-id → resolved curriculum node id (the deepest
    matched node along its ancestry), used at attach time.
- Normalization reuses the existing `_normalize_for_match` rules (lowercase,
  collapse whitespace, normalize slashes). **Exact normalized match only**;
  near-misses are discrepancies, not silent guesses. Duplicate sibling names →
  match the first, flag the rest as a warning.

### `backend/services/doc_processor.py` changes
- Add `parse_heading_outline(path) -> list[dict]` — headings-only nested outline.
- Replace the `split_by_h2` step in the pipeline with
  `attach_content_to_curriculum(elements, resolution_map, main_topic_node) ->
  list[section_group]`: each content block attaches to its deepest matched
  ancestor heading's node, rolling up to the nearest matched ancestor (pre-heading
  "Preamble" content → main topic). Blocks sharing a node form one section.
- `split_by_h2` and `_match_section_to_curriculum` are retired from the pipeline
  (kept only if still referenced elsewhere; otherwise removed).

### Endpoints — `backend/routers/documents.py`
- `POST /documents/upload` → save file, create upload + topic_tree (main topic),
  `parse_heading_outline`, store `heading_outline`, run `align`, set job
  `awaiting_reconcile`, return the diff. **No content processing.**
- `GET /documents/{upload_id}/reconcile` → re-run `align` (reflects nodes just
  added) and return the diff.
- `POST /documents/{upload_id}/continue` → run the real pipeline
  (attach → sections/blocks → images/tables → ready), set job out of
  `awaiting_reconcile`.
- **Add node** reuses the existing `POST /curriculum` endpoint; the modal then
  re-fetches `/reconcile`.

### Frontend
- New `ReconcileModal.tsx`: annotated curriculum subtree for the main topic,
  per-level expected/present summary, inline **Add node**, and a "N headings will
  roll up to their parent" note. **Continue** / **Cancel**.
- Upload flow in `WorkspacePage.tsx` opens `ReconcileModal` after upload instead
  of processing immediately; **Continue** calls `/continue`.

## Data flow (Parasitic Infections example)

Document under main topic **Emergency Medicine** (depth 0):
```
H2 Parasitic Infections        (curriculum node exists, depth 2)
   H3 Giardiasis/GI Parasites  (NO node)        → content rolls up
   H3 Toxoplasmosis            (node exists, depth 3)
```
After Continue:
- Toxoplasmosis content → section keyed to the **Toxoplasmosis** leaf →
  cards tagged `… > Parasitic Infections > Toxoplasmosis`.
- Giardiasis/GI Parasites content → rolls up to **Parasitic Infections** →
  cards tagged `… > Parasitic Infections` (until the reviewer adds that leaf in
  the modal, then it routes there).

## Error handling

- **Unresolved discrepancies at Continue** are allowed (non-blocking) — content
  rolls up per the rule; the modal shows the roll-up count so it is a conscious
  choice, not silent loss.
- **Empty document / no matched main topic** → friendly error, job marked failed,
  nothing created.
- **Document deeper than curriculum** → rolls up; modal offers Add.
- **Skipped heading levels** (H2→H4) → handled by the same deepest-match rule,
  no special case.

## Testing

- `curriculum_aligner.align`: synthetic outline + curriculum subtree → correct
  per-level diff (`matched` / `missing_in_curriculum` / `not_in_document`) and
  resolution map, including roll-up and position-aware (same-name-different-branch
  does not match).
- `attach_content_to_curriculum`: the Parasitic Infections example → Toxoplasmosis
  blocks on the Toxoplasmosis leaf, Giardiasis/GI Parasites blocks rolled up to
  Parasitic Infections, Preamble → main topic.
- `parse_heading_outline`: element list → correct H1–H4 nesting (incl. skipped
  levels).
- Integration: upload → `awaiting_reconcile` → add a node → continue → sections
  attached to the right nodes; a generated card inherits the right path.

## Out of scope

- Re-upload / semantic merge (engine already unwired).
- Fuzzy/near-miss name matching (exact normalized only).
- Any change to card generation, scoring, or supplemental logic beyond inheriting
  the corrected section path.
- Data migration (DB is wiped).
