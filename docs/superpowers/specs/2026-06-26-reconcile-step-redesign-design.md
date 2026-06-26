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
  depth D, with a single clear best (the top score must beat the runner-up by a
  margin, else treat as new to avoid ambiguous grabs). `difflib` is stdlib — no
  new dependency.
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
- Parse **headings only** (a lightweight `parse_headings_only(filepath)` that
  reads heading styles without decoding images — fast for big docs), run `align`
  + `build_merged_tree`.
- Return `{scan_token, tree, summary, fuzzy, main_topic}`.
- The modal holds Include selection client-side and re-fetches nothing (no
  per-Add round trip). **Edit-leaf** (fuzzy) uses the existing curriculum rename
  endpoint immediately (persistent); the modal updates that row locally.

### 4. Continue endpoint: `POST /api/topic-trees/continue`

Body: `{scan_token, included_hids: [int]}`.
1. Load the sidecar + temp docx (404 if the token expired/missing).
2. **Expand** `included_hids` to include any new ancestors (auto-include) using
   the stored outline.
3. **Update the curriculum first:** create the included new nodes, **parents
   before children**, via the curriculum model (deriving level/path/version from
   the parent — a curriculum node id for top new nodes, or a freshly-created id
   for nested ones). Persistent.
4. **Re-align** the stored outline against the now-updated curriculum subtree.
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
stay harmlessly, or be removed). `/paste` and `ai-headings` remain on the legacy
direct path, unchanged.

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
- Honest per-depth **summary** bar (matched / fuzzy / new / missing).
- **Continue** → `continueProcessing(scan_token, includedHids)`; on success set
  the returned `processing_job_id` to resume the existing poller. **Cancel** →
  `DELETE scan` + close.
- `WorkspacePage` upload handler calls `scanDocument(...)` (not `uploadDocument`)
  and opens the modal with `{scan_token, tree, summary}`.

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
- Auto-include expansion: selecting a nested new hid expands to its new ancestors,
  parents-before-children ordering.
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
