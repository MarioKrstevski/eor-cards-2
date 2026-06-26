# Design: Reconcile Step Redesign (ephemeral scan + merged diff-tree + fuzzy match)

**Date:** 2026-06-26
**Status:** Approved (pending implementation)
**Supersedes:** the reconcile-modal + upload-gating portions of
`2026-06-26-curriculum-aligned-ingestion-design.md` (the pure-function core —
`parse_heading_outline`, `align`, `attach_content_to_curriculum` — is reused and
extended, not replaced).

## Motivation

The shipped reconcile step works but, in real use against a full Emergency
Medicine document, three problems surfaced:

1. **The document is "uploaded" before the reviewer confirms.** Today the upload
   endpoint saves the file AND creates topic-tree / upload / job rows, then parks.
   The reviewer wants the scan to be a true preview — parse + match only, nothing
   committed until Continue.
2. **The diff display was misleading** ("13 found / 13 expected · 13 missing · 13
   not in document"). Root cause was a matching bug (already fixed, see below);
   the summary should also read honestly (matched / fuzzy / new / missing).
3. **The modal is a flat add-missing list.** The reviewer wants a curriculum
   **tree** view with an All / Differences toggle, per-node status labels
   (Missing / New), opt-in **Include** checkboxes to add new nodes, and **fuzzy
   matching** for near-miss leaf names so cosmetic differences still connect but
   are surfaced for a decision.

### Already fixed (separate commit, not part of this redesign)
`normalize_topic`'s exam-weight regex only stripped en-dash/hyphen, but documents
use an **em-dash** (`CARDIOVASCULAR — 18%`) while the curriculum uses an en-dash
(`Cardiovascular – 18%`), so all 13 depth-1 bands failed to match. The regex now
includes the em-dash. With that fix, the live document matches 144/426 headings —
real signal the redesign builds on.

## Confirmed decisions (from brainstorming)

- **Nothing in the DB until Continue.** Scan saves a temp file + returns the diff;
  no topic-tree / upload / job / section rows. Cancel discards the temp file.
- **Include defaults OFF, opt-in,** with per-node checkbox, per-subtree "include
  all under here," and global "include all new." Including a node **auto-includes
  any new ancestors**.
- **Fuzzy matching at all levels** (not just leaves), default-accepted, surfaced
  with the name difference + an **Edit leaf** action.
- **Four node statuses:** matched (exact), fuzzy (near-match), missing
  (curriculum-only), new (document-only).

## Approach

**Ephemeral scan + a backend-built merged diff-tree.** The backend owns the
grafting/nesting/status logic and emits one merged tree; the modal is a thin
renderer with filtering + selection. (Rejected: assembling the merged tree in
TypeScript — it would duplicate the matcher's logic and drift.)

## Components

### 1. Matcher: fuzzy pass in `align` (`curriculum_aligner.py`)

Extend `align` so each document heading at depth D under a matched parent resolves
as:
- **exact** — normalized-equal to a child candidate (current behavior).
- **fuzzy** — no exact match, but `difflib.SequenceMatcher` ratio (on normalized
  names) ≥ `FUZZY_THRESHOLD` (0.85) against the unmatched sibling candidates at
  depth D, AND the best score beats the runner-up by `FUZZY_MARGIN` (0.05) — else
  treat as **new** (don't make an ambiguous grab). `difflib` is stdlib — no new
  dependency. Both constants live at module top, testable.
- **new** — neither.

`align` output gains:
- `resolution[hid]` → node_id for BOTH exact and fuzzy (so `attach` treats fuzzy
  as matched); None for new.
- `fuzzy`: `[{hid, node_id, doc_name, curr_name, score}]`.
- statuses retained for the tree builder (below).
Position-awareness and the matched-parent chain rule are unchanged (fuzzy only
runs among children of an already-matched parent).

### 2. Merged tree builder: `build_merged_tree(...)` (`curriculum_aligner.py`)

`build_merged_tree(outline, main_topic, nodes, align_result) -> list[treenode]`
where each `treenode` is:
```
{
  "status": "matched" | "fuzzy" | "missing" | "new",
  "name": str,                 # curriculum name (matched/fuzzy/missing) or doc name (new)
  "depth": int,
  "node_id": int | None,       # curriculum node (matched/fuzzy/missing); None for new
  "hid": int | None,           # document heading (fuzzy/new); None for missing
  "doc_name": str | None,      # for fuzzy: the document's heading text
  "score": float | None,       # for fuzzy
  "children": [...]
}
```
Construction: start from the curriculum subtree (matched / fuzzy / missing), then
**graft** new document headings under their matched parent (nested: a new H2 holds
its new H3 children), ordered sensibly. Pure function — unit-testable on plain
data. A `summary` (per-depth counts of each status) is derived from this tree.

### 3. Scan endpoint: `POST /api/topic-trees/scan`

- Form: `file`, `topic_tree_name` or `topic_tree_id`, `curriculum_id` (main
  topic). 400 if no main topic resolvable (same rule as before).
- Save the `.docx` to a **temp scan area** (`data/scans/<scan_token>.docx`) plus a
  sidecar `data/scans/<scan_token>.json` holding `{outline, main_topic_id,
  version, topic_tree_id|topic_tree_name, original_name, created_at}`.
  `scan_token` is a uuid. **No DB rows.**
- Parse with the **same `parse_docx`** the real pipeline uses, then
  `parse_heading_outline(elements)`. **Do NOT introduce a separate
  `parse_headings_only`** — `hid` numbering must be identical between scan and
  Continue, and the only safe guarantee is that both derive from `parse_docx`.
  The parsed **outline is stored in the sidecar and is authoritative**; Continue's
  re-align uses the *sidecar* outline (never a re-derived one), and
  `_run_processing` re-parses the same file with `parse_docx`, so the hids the
  resolution is keyed on line up exactly with the elements `attach` walks. (A
  headings-only fast path can be added LATER only behind a test asserting
  `parse_heading_outline(parse_docx(f))` hids == the fast path's hids on a fixture
  with empty-text headings, content-controls, and a heading near a table.)
- Run `align` + `build_merged_tree`. Return `{scan_token, tree, summary, fuzzy,
  main_topic}`.
- The modal holds Include selection client-side and re-fetches nothing (no
  per-Add round trip). **Edit-leaf** (fuzzy) uses the existing curriculum rename
  endpoint immediately (persistent); the modal updates that row locally.

### 4. Continue endpoint: `POST /api/topic-trees/continue`

Body: `{scan_token, included_hids: [int]}`.
1. Load the sidecar + temp docx (404 if the token expired/missing).
2. **Expand** `included_hids` to include any new ancestors via a **pure helper**
   `expand_includes(included_hids, outline) -> ordered_hids` (parents before
   children, walking the **outline** parent chain). Unit-testable in isolation.
3. **Update the curriculum first:** create the included new nodes in that order.
   **Parent linkage comes from the OUTLINE parent chain, NOT from `align`'s
   `missing[].parent_id`** (which is `None` for a new-node-under-a-new-node, so it
   cannot reconstruct nested new chains). For each included new hid, its parent is
   the nearest outline ancestor that is either (a) matched/fuzzy → that ancestor's
   `resolution[hid]` curriculum node id, or (b) new+included → the id just minted
   for that ancestor hid. Maintain an `hid → new_node_id` map as you create them.
   Derive level/path/version from the resolved parent node. Create nodes with the
   **raw document heading text** (so the post-create re-align matches them via
   normalization). Persistent.
4. **Re-align** the *sidecar* outline against the now-updated curriculum subtree
   (the new nodes now resolve the previously-new headings to their fresh ids).
5. **Create** the topic tree (if new) + upload row (move the temp docx into
   `uploads/`), create a `ProcessingJob`, and run the existing pipeline
   `_run_processing(job_id, resolution)` (full `parse_docx` →
   `attach_content_to_curriculum`). Unincluded new headings roll up to their
   parent; fuzzy/exact both attach to the matched node.
6. Return `{processing_job_id, topic_tree_id}`. Remove the temp scan files.

### 5. Temp-scan cleanup

A small sweep (in the startup lifespan, like the orphan sweep) deletes
`data/scans/*` older than N hours so abandoned previews don't accumulate. Cancel
in the UI calls a `DELETE /api/topic-trees/scan/{scan_token}` to remove
immediately (best-effort).

### 6. Retire the old gated-upload path

The `awaiting_reconcile`-parked `POST /upload` + `GET /{upload_id}/reconcile` +
the old `POST /{upload_id}/continue` are replaced by scan/continue. Remove the
`awaiting_reconcile` job state usage from upload (the orphan-sweep exemption can
stay harmlessly). `/paste` and `ai-headings` remain on the legacy direct path,
unchanged. The `uploads.heading_outline` column becomes unused (scan keeps the
outline in the sidecar) — leave it; harmless.

**Deploy note:** any upload currently parked at `awaiting_reconcile` on `main`
will be stranded when the old `/continue` is removed — delete/drain such parked
uploads before shipping (two-user MVP; trivial).

### 7. Frontend: redesigned `ReconcileModal.tsx`

- Renders `tree` recursively. Per node by status:
  - **matched** — normal row + level badge.
  - **fuzzy** — "found" styling + a **⚠ diff** chip showing `curriculum: "X"` vs
    `document: "Y"` (+ score) and an **Edit leaf** button (inline rename →
    `updateCurriculumNode`).
  - **missing** — greyed + **Missing** label, no control.
  - **new** — **New** badge + **Include** checkbox (default off). A new subtree
    shows **Include all under here**; a global **Include all new** at the top.
    Checking a node auto-checks its new ancestors (and unchecking an ancestor
    unchecks descendants).
- **Toggle: All / Differences.** All = full tree. Differences = only
  fuzzy/missing/new nodes, each with its ancestor chain shown greyed for context.
- **Single tree view — no separate lists.** The old modal's standalone "headings
  missing from curriculum" list (and any separate new/missing list) is **removed**;
  everything — matched, fuzzy, new (with Include), missing — is shown inline in the
  one tree. The Differences toggle is how the reviewer focuses on just the deltas.
- Honest per-depth **summary** bar (matched / fuzzy / new / missing) — counts only,
  not a list.
- **Continue** → `continueProcessing(scan_token, includedHids)`; on success set
  the returned `processing_job_id` to resume the existing poller. **Cancel** →
  `DELETE scan` + close.
- `WorkspacePage` upload handler calls `scanDocument(...)` (not `uploadDocument`)
  and opens the modal with `{scan_token, tree, summary}`.

**Breaking type/API changes (frontend must change in lockstep — list `types.ts`
in the plan):**
- `api.ts`: add `scanDocument(...) -> {scan_token, tree, summary, fuzzy, main_topic}`,
  `deleteScan(scan_token)`; **change** `continueProcessing` signature from
  `(uploadId)` to `(scan_token, included_hids)`. Edit-leaf reuses existing
  `updateCurriculumNode` (`PATCH /curriculum/{id}`).
- `types.ts`: the old `ReconcileDiff` (`missing_in_curriculum` / `not_in_document`)
  is **replaced** by `{tree: MergedNode[], summary, fuzzy}`. `MergedNode` carries
  `status/name/depth/node_id/hid/doc_name/score/children`.
- `ReconcileModal.tsx` is rewritten (single tree, statuses, toggle, Include);
  remove its reads of `diff.missing_in_curriculum` / `diff.not_in_document`.
- `WorkspacePage.tsx` reconcile state keys on `scan_token` (not `uploadId`).

## Data flow

Scan → modal (client-side Include selection; Edit-leaf persists immediately) →
Continue(`scan_token`, included hids) → curriculum updated → re-align → topic
tree/upload/sections created → poller resumes → cards inherit corrected paths.

## Error handling

- **Expired/abandoned scan token** at Continue → 404 with a clear "scan expired,
  please re-upload" message; modal surfaces it.
- **Ambiguous fuzzy** (two close candidates) → treated as **new**, not a guess.
- **Auto-include integrity:** a selected leaf always pulls in its new ancestors so
  the curriculum never gets an orphaned node.
- **Empty doc / no main topic** → friendly error, nothing created.
- **Continue idempotency:** the temp files are removed only after the topic
  tree/upload commit succeeds; a failure leaves the scan re-runnable.

## Testing

- `align` fuzzy pass: exact still wins; a near-miss (`"Atrial fib"` vs `"Atrial
  Fibrillation"`) resolves fuzzy with the node id + diff; an ambiguous/low-score
  case stays new; em-dash/caps differences resolve (regression for the fix).
- `build_merged_tree`: curriculum + grafted new headings produce correct statuses
  and nesting; per-depth summary counts; Differences-filter still yields ancestor
  context.
- `expand_includes(included_hids, outline)`: selecting a nested new hid expands to
  its new ancestors, parents-before-children ordering.
- **hid consistency:** `parse_heading_outline(parse_docx(fixture))` hids match what
  `attach_content_to_curriculum` derives walking the same `parse_docx(fixture)`
  elements (the linchpin — guards content mis-routing).
- **Re-align after include:** a new heading carrying an exam-weight suffix
  (`"Foo — 18%"`), once created and re-aligned, resolves to its fresh node id
  (both sides strip the suffix) — pins issue that node names are stored raw.
- Integration: scan (no DB rows created) → continue with a chosen include set →
  curriculum gains exactly those nodes → sections attach to matched/fuzzy/new-
  included leaves; unincluded new headings roll up. Assert no topic-tree/upload
  rows exist after scan but before continue.
- Temp-scan cleanup removes old files.

## Out of scope

- Cross-document merge / re-upload dedup (engine still unwired).
- Auto-correcting the document text; "fix the doc" is a manual reviewer action.
- Changing card generation/scoring beyond inheriting corrected section paths.
- Multi-select fuzzy resolution UI beyond accept / edit-leaf.
