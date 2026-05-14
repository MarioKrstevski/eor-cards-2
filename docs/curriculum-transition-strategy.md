# Curriculum Transition Strategy
*EOR Card Studio — Discussion Document*
*Date: 2026-05-12*

---

## Situation

- We are building a flashcard deck (Anki) for PA students preparing for End of Rotation (EOR) exams.
- The current (PAEA) curriculum is the basis for all study notes and card generation.
- A new curriculum publishes in approximately one month. It is a **complete structural overhaul** — topics can move from major to minor, be split across multiple new topics, be merged, or disappear entirely. New topics may be introduced.
- We do not have access to the new curriculum in advance.
- The deck is being built for a specific, narrow student population. Word of mouth matters heavily. A low-quality release cannot be undone.

---

## Core Insight: Content vs. Tags

Cards have two components:

- **Content** — the actual medical question/knowledge (e.g. "What is the ejection fraction cutoff for HFrEF?"). This does not change between curricula. Medicine is medicine.
- **Tags** — the curriculum path that tells Anki where in the topic tree the card lives (e.g. `Cardiology > Heart Failure > HFrEF`). This is what changes when the curriculum restructures.

These are two separate problems that can be solved independently and at different times.

---

## What Students Expect (Selling Proposition)

When a student opens Anki and selects a topic from the new curriculum, they expect to get cards that make sense for that topic. If the cards are mostly off-topic or missing, the product fails its core promise. Given the narrow market, this cannot be fixed after a bad launch.

The acceptable error threshold is roughly **5% misplaced or missing cards**. Above that, the release should be delayed.

---

## Recommended Strategy

### Phase 1 — Now: Build the Asset (no change to current workflow)

Continue generating cards against the current curriculum. The card content is the primary value. Tags are just labels that can be replaced later. Do not slow down card generation waiting for the new curriculum.

### Phase 2 — When New Curriculum Publishes: AI Re-Classification

Once the new curriculum is published:

1. Import the new curriculum tree into the system.
2. Run an **AI batch re-classification job**: for each card (~5,000), Claude reads the card content and the new curriculum tree and assigns the most appropriate new topic path. This writes into a separate `tags_mapped` field — the original tags are preserved and untouched.
3. Generate a **coverage gap report**: which new curriculum topics have zero cards assigned to them? These are the gaps.

This step is automated and fast. It does not require going through 5,000 cards manually.

### Phase 3 — Decision Gate: Go or No-Go

The coverage gap report becomes the business decision tool:

| Outcome | Decision |
|---|---|
| Gaps are minor (a few topics, small card count) | Fill gaps, spot-check AI tags, ship |
| Gaps are moderate | Assess which topics need new study notes, timeline for gap-filling |
| Gaps are major (>5% of content is fundamentally misaligned) | Delay launch, commission new study notes for new topics |

This decision is made with real data, not guesses — after the new curriculum is seen.

---

## What the AI Re-Classification Can and Cannot Guarantee

**Can do:**
- Assign each card to the most likely new curriculum topic based on card content
- Handle many-to-many mappings (e.g. one old section's cards split across two new topics)
- Do this at scale, in one automated pass, in minutes not days

**Cannot do:**
- Guarantee a card covers exactly what the new curriculum teaches about that topic — we don't have new study notes yet
- Fill gaps where the new curriculum introduces genuinely new material not present in old study notes

The re-classification is a best-effort repositioning. The gap report tells you how much of a problem the "cannot do" part actually is.

---

## What the Software Can Do to Support This Transition

### During Phase 1 (Now — building cards)

- **Content quality tools** (already built): review marks, AI fix batches, proposals workflow — use these to keep card quality high now, so the re-tagging phase starts from a clean baseline.
- **Old curriculum tags** continue to be generated and stored normally. No changes needed.

### During Phase 2 (When new curriculum publishes)

- **New curriculum import** — import the new curriculum tree into the system (same mechanism as the current one, just marked as v2).
- **AI re-classification batch job** — one button triggers a background job that reads every active card + the full new curriculum tree and assigns the best matching new topic path. Results are stored in `tags_mapped`, completely separate from the original `tags`. Original tags are never touched.
- The job runs in the background like card generation already does — survives page refresh, shows progress.

### During Phase 3 (Decision gate)

- **Coverage gap report** — a dedicated report view showing:
  - Every new curriculum topic with the number of cards mapped to it
  - Topics with 0 cards highlighted as gaps
  - Ability to drill in and see which cards mapped to each topic
- **Tag review queue** — cards where the AI classification has low confidence, or cards that ended up in unexpected places, surfaced for human review first
- **Manual tag correction** — inline editing of `tags_mapped` on any card without re-running the whole batch
- **Side-by-side comparison** — for a given card, show old tag path vs. new tag path so a reviewer can quickly judge whether the remap makes sense

### Export

- **Export toggle** — when exporting to Anki CSV, choose: use `tags` (old curriculum) or `tags_mapped` (new curriculum)
- This means you can produce both versions of the deck from the same card library if needed

---

## Summary

Build now. Re-tag with AI when the new curriculum publishes. Use the coverage gap report to make the launch decision with real data. Do not launch until the gap analysis says the error rate is acceptable.

The risk of a bad launch in a narrow market outweighs the risk of a short delay. The system will be built to make that delay as short as possible.
