# Card Validation — How It Works

This explains the **"Validate & fix"** quality check: what each card is graded against, the exact instructions (prompts) we send the AI, and how failing cards get fixed. Everything here is editable — if you want to reword a rule, add one, or change a threshold, mark it up and send it back.

---

## The flow, in plain terms

1. **Score** — every card is read by a reviewer AI and graded against a fixed list of **7 rules**, pass/fail, with a short reason for each failure.
2. **Show** — each card gets an **X/7** badge (green = all pass, amber = 1 fail, red = 2+).
3. **Fix loop** — any failing card is rewritten to fix the specific failures, then **re-checked**; this repeats up to **3 times**, keeping the best-scoring version.
4. **Split** — if a card is really several separate facts, it's split into sibling cards (then each new card is checked too).
5. **Review** — you can filter to "only the cards it changed," see before/after, and revert anything.

Two of the checks are verified by plain code (not the AI): the markdown/format rule, and the blue+bold styling on every cloze (which is re-applied automatically so it can never be stripped).

---

## The instruction we send the reviewer AI (the "system prompt")

> You are a quality-assurance reviewer for PA (Physician Assistant) EOR exam cloze flashcards. You are given finished cards and must judge each one against a fixed rubric, rule by rule. Be strict but fair: the overarching question is whether a student preparing for the PA EOR exam could study this card efficiently and grab a single clean concept from it.
>
> RUBRIC (judge every card against every rule): *[the 7 rules below are inserted here]*
>
> For each card, return a verdict (pass true/false) for every rule key, plus a brief reason (one short clause) whenever a rule fails (reason may be empty when it passes). Set split_suggested true ONLY when single_concept fails AND the card is a genuine same-category list whose items each carry their own 4-plus-word explanation, which the sibling-card rules require to be separate cards. Never suggest splitting tightly-linked sets, triads, named pearls, diagnostic-criteria sets, symptom clusters, first-line management groups, single mechanisms, or cards that are merely long. When in doubt, do not split.

Each card is also given its **topic path** (e.g. `Surgery > GI > Cholecystitis`) so the reviewer knows which condition the card is about when judging it.

---

## The 7 rules

For each rule below: **"What it checks"** is the exact wording given to the reviewer AI to decide pass/fail. **"Fix instruction"** is what we tell the AI when it has to repair a card that failed this rule.

### 1. Single concept
**What it checks:** Decide using the sibling-card rules, biased toward NOT splitting. A card may legitimately be long or hold several clozes — length and cloze count are NOT reasons to fail. PASS (keep as one card) when the content is a tightly-linked clinical set tested as a unit: a classic triad, named pearl or mnemonic, diagnostic-criteria set, symptom cluster, first-line management group, a single mechanism or causal chain, or at most two items with short (3 words or fewer) qualifiers. FAIL (and set split_suggested) ONLY when the card bundles a list of items for which ALL of the following hold: (a) each item carries its own explanation content (a clause, sentence, sub-bullet, or qualifier of 4 or more words), (b) the items share one conceptual category (all symptoms, all treatments, all findings, all diagnostic steps, etc.), and (c) each item could stand as its own EOR exam question without the others. A hedged or optional list introduced by phrasing like 'may present with', 'maybe', 'can include', 'associated with', or 'such as' (e.g. 'may also have fever, chills, nausea/vomiting') is a single tightly-linked cluster — keep it as ONE card, do not split it. When uncertain, PASS.

**Fix instruction:** If this is a genuine list of same-category items that each carry their own 4-plus-word explanation, it should become sibling cards; otherwise keep it as one coherent concept without dropping any content.

### 2. Studyable in isolation
**What it checks:** A clear visible (unclozed) anchor/subject remains, AND enough surrounding context is visible that a student could actually answer the card. FAIL if the cloze hides so much that the stem is unanswerable, if there is no visible anchor, or if the card is so short/stripped it has no clinical context to study from.

**Fix instruction:** There isn't enough visible context to answer this card, or the cloze hides too much / the anchor is gone. Keep the condition or subject visible and add enough surrounding clinical context that the student can answer it; cloze only the specific recall target.

### 3. Cloze construction
**What it checks:** Uses `{{c1::...}}` cloze syntax correctly; does NOT cloze an entire sentence; does NOT cloze logical connectors (and/or/with/without) or filler words; no leftover markdown inside clozes. FAIL on any of these.

**Fix instruction:** Fix the cloze construction: use `{{c1::term}}` on the specific testable term only, never the whole sentence, never connectors/filler, and no markdown inside the cloze.

### 4. Bold appropriateness
**What it checks:** Judge NON-clozed words only. Clozed terms are ALWAYS wrapped in the blue span + bold (`<span style="color:#1f77b4"><b>{{c1::...}}</b></span>`) by design — that is required styling, NOT a bold violation; ignore the bold inside clozes entirely. For the remaining (non-clozed) words: the card's anchor/condition and legitimate structural labels or source emphasis qualifiers (most common, first line, gold standard) may be bold. FAIL only when an ordinary, filler, or connector word that is NOT clozed is bolded (e.g. 'and', 'with', 'better', 'include', 'the'), or when the visible anchor/condition is clearly present but not bolded.

**Fix instruction:** Keep EVERY clozed term wrapped exactly in `<span style="color:#1f77b4"><b>{{c1::...}}</b></span>` — never remove the bold or color from a cloze. Only adjust NON-cloze bolding: bold the card's anchor/condition, remove bold from ordinary/filler words.

### 5. Additional-context (extra field) quality
**What it checks:** The additional context (extra) field is drawn only from the same source sentence/bullet group, is clearly labeled when it carries reinforcement content, and is complete (when this is a sibling card, the labeled footer lists every other sibling item with full explanations). FAIL if the extra is missing where it should carry sibling/source content, is an unlabeled fragment, or is incomplete.

**Fix instruction:** Improve the additional context field: include the related items from the same source group, label it clearly (e.g. 'Other symptoms:'), and make it complete. Leave it blank only when nothing from the same source group applies.

### 6. Neutral & unattributed
**What it checks:** Neutral standardized clinical language. FAIL if it contains source/platform names (Smartypance, UWorld, Rosh, etc.), instructional/conversational phrasing ('think of', 'buzzword', 'classic presentation'), or empty framing phrases ('is a hallmark feature', 'is a key clinical finding').

**Fix instruction:** Re-express in neutral clinical language: remove any source/platform names, instructional phrasing, and empty framing phrases; state the clinical fact directly.

### 7. Format & markup *(verified by code, not the AI)*
**What it checks:** HTML-only formatting — no markdown (no `**` or `*` for bold, no `#` headings, no backticks) — and no em dashes or double hyphens.

**Fix instruction:** Use HTML tags only for emphasis (`<b>...</b>`); remove all markdown (`**`, `*`, `#`, backticks) and any em dashes or double hyphens.

---

## When a card gets split (sibling cards)

A card is only split when rule **1 (single concept)** fails *and* the reviewer marks it as a genuine same-category list (see rule 1). When that happens, this is the instruction we send to produce the sibling cards:

> You are splitting one overloaded flashcard into multiple focused sibling cards. *[the section's source notes, the card, and its extra are included here]* Split this into 2 or more separate, focused cloze cards, each testing one independently testable concept. These cards are closely related siblings, so give each card an additional context field that briefly references the related concepts covered by the other sibling cards, so each card still stands on its own and the link between them is preserved.
>
> **SCOPE:** Split ONLY the content already in this card into siblings. Use the source text solely to keep the facts accurate and the wording faithful — do NOT introduce items, bullets, or facts from elsewhere in the section.
>
> **GROUNDING:** The section source is the ONLY authoritative source of facts. The existing card and its additional-context (extra) field are reference only, NOT a source of facts — include only content supported by the section, and drop anything in the card or its extra that is not in the section.

---

## How a failing card gets fixed

When a card fails one or more rules (other than a split), it's rewritten with a message like this (built automatically from the failed rules):

> This card failed the following quality rules. Fix ALL of them while preserving the clinical content:
> - *[the Fix instruction for each failed rule, plus the reviewer's specific reason for this card]*
>
> **SCOPE:** Rewrite ONLY the content this card already covers. Use the source text solely to keep the facts accurate and to restore any missing context for THIS card — do NOT pull in other items, bullets, or facts from elsewhere in the section, and do not broaden the card's scope.
>
> **GROUNDING:** The section source is the ONLY authoritative source of facts. The existing card and its additional-context (extra) field are reference for what the card was about — NOT a source of facts. Include only content supported by the section source; if the card or its extra contains anything not present in the section, drop it.

The rewrite always works from the **original study notes** for that section, so it stays faithful and doesn't invent content.

---

## Two checks done by code (not the AI)

- **Format & markup** (rule 7) is verified directly in code, so the AI can't "talk its way out" of a markdown slip.
- **Cloze styling** is re-applied automatically after every fix/split: every cloze is wrapped in exactly `<span style="color:#1f77b4"><b>{{c1::...}}</b></span>`, so the blue+bold can never be accidentally stripped.

---

## For review

If you'd like to change anything — reword a rule, add a new check, loosen/tighten when a split happens, change which words count as "ordinary" for bolding, etc. — edit this file (or note it inline) and send it back. Each rule has a short **What it checks** (used for grading) and a **Fix instruction** (used for repair); both can be adjusted independently.
