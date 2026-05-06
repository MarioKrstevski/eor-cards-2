# PA Doctrine — AI-Enhanced Anki Cloze Generation Rules (Version 1.1)

> This file extends rules.md with additional granularity instructions derived from output analysis.
> The original rules.md remains unchanged. This file is used as the generation and validation prompt.

---

## Anchor Term Rule
Every card must have a visible "anchor" — the condition, disease, or concept name that tells the student what they're being tested on. NEVER cloze the anchor. The student needs to see it to know what to recall.

---

## Generation Instructions

Convert the following into numbered Anki Cloze cards formatted for Excel. Output exactly two columns separated by a single pipe | character with no spaces before or after the pipe. Each row must contain exactly one pipe character total. Column 1 must contain the card number only. Column 2 must contain the cloze card text only. Do not include any additional pipe characters anywhere in the output.

Use mechanism-cluster granularity. Split distinct mechanistic links, but do not atomize symptom lists, timing sequences within a single phase description, or tightly related manifestations arising from the same causal pathway. Do not combine unrelated rows. Do not expand or interpret physiological content. Do not omit any mechanisms. Do not include blank lines or any extra text before or after the cards.

Split compound sentences into separate cards when they contain distinct mechanisms or testable concepts. Create one card per independently testable mechanism unit and bundle tightly linked targets into the same card when they belong to the same causal chain.

Preserve the original wording exactly outside of inserting the cloze and do not rewrite, simplify, or clean grammar. Each card must be fully understandable in isolation. If any wording depends on prior context to make sense, replace the dependent wording with its explicit referent using only terms already present in the original text, without adding new information or changing meaning.

Cloze only the independently testable element or elements within the mechanism unit and do not cloze entire sentences unless the whole sentence is the testable concept. Keep causal and directional verbs visible as contextual anchors unless the verb itself is the independently testable element. When multiple blanks belong to the same mechanism unit on the same card, use the same cloze index for those blanks.

Cloze single words if they are independently testable such as structures, hormones, actions, or directionality, and avoid clozing filler words.

---

## Mechanism Splitting — Explicit Rules

A single sentence may contain multiple mechanism units. Split them into separate cards **only when they represent distinct causal steps**.

**The four mechanism unit types are:**

1. **Onset / Timing** — when something begins, peaks, or resolves
2. **Cause** — what hormone, pathology, or trigger is responsible
3. **Cause → Effect** — how the cause produces a physiological change
4. **Effect → Symptom / Finding** — how the physiological change produces a clinical result

**Worked example — split these because they are distinct causal steps:**

Source: *"Primary dysmenorrhea is caused by excess prostaglandin production, which leads to uterine contractions and crampy menstrual pain."*

| Card | Tests |
|---|---|
| Primary dysmenorrhea is caused by excess {{prostaglandin}} production. | Cause (hormone) |
| Excess {{prostaglandin}} production leads to {{uterine contractions}}. | Cause → structural effect |
| Excess {{prostaglandin}} production leads to {{crampy menstrual pain}}. | Cause → clinical symptom |

**Exception — do NOT split timing sequences within a single phase description:**

When a sentence describes onset → peak → resolution as sequential phases of the same clinical event, keep all three on one card with separate cloze markers. These are one mechanism unit describing a timeline, not three separate mechanisms.

Source: *"The pain typically starts 1–2 days before menses, peaks within the first 24 hours, and resolves within 2–3 days."*

**CORRECT — one card:**
The pain typically starts <b><span style="color:#2ca02c;">{{cN::1–2 days before menses}}</span></b>, peaks within <b><span style="color:#2ca02c;">{{cN::the first 24 hours}}</span></b>, and resolves within <b><span style="color:#2ca02c;">{{cN::2–3 days}}</span></b>.

**INCORRECT — three separate cards:** Do not split start/peak/resolution into separate cards. Boards test the full timeline as one unit.

---

## Symptom Clusters — Bundle, Never Omit

When the source lists multiple symptoms from the same causal mechanism, bundle them under one cloze index on one card. Do not create a separate card per symptom. Do not omit the list.

**Example:**
Primary dysmenorrhea is often accompanied by <b><span style="color:#d62728;">{{c7::nausea}}</span></b>, <b><span style="color:#d62728;">{{c7::vomiting}}</span></b>, <b><span style="color:#d62728;">{{c7::diarrhea}}</span></b>, <b><span style="color:#d62728;">{{c7::headache}}</span></b>, or <b><span style="color:#d62728;">{{c7::fatigue}}</span></b>.

All symptoms share the same cloze index because they arise from the same causal pathway.

---

## High-Yield Content — Never Omit

The following content categories are always board-testable and must never be dropped, compressed, or merged with unrelated cards:

### 1. All Timing Markers
Every time point in the source text (onset, peak, resolution, age of onset) gets its own card. Green color (#2ca02c).

### 2. Symptom Clusters
All associated symptoms must be preserved on one card, bundled under one cloze index. Red color (#d62728).

### 3. Exam Findings
Physical examination findings are always their own card. Separate cards for normal vs. abnormal findings.
- Primary: pelvic exam normal → #7f3fbf (structure finding)
- Secondary: boggy uterus, nodularity, adnexal tenderness → each or bundled per causal link

### 4. Treatment Response Contrast
When the source contrasts how two conditions respond to the same treatment, this contrast requires two separate cards — one per condition. Never merge them.

**Example:**
- Primary dysmenorrhea symptoms generally improve with {{NSAIDs}}.
- Secondary dysmenorrhea symptoms often do not fully respond to {{NSAIDs}}.

These are a board classic contrast. Both cards must exist.

### 5. Explicit Subject Repetition
Every card must name the subject explicitly. Never use "it," "this condition," or "they."
- Always write "Primary dysmenorrhea" or "Secondary dysmenorrhea" — not a pronoun.
- If the source uses a pronoun, replace it with the explicit subject from the source text.

### 6. Cause and Underlying Pathology Lists
When the source lists multiple causes or underlying pathologies, preserve the full list on one card bundled under one cloze index.

**Example:**
Secondary dysmenorrhea is due to underlying pelvic pathology such as <b><span style="color:#d62728;">{{c11::endometriosis}}</span></b>, <b><span style="color:#d62728;">{{c11::adenomyosis}}</span></b>, <b><span style="color:#d62728;">{{c11::fibroids}}</span></b>, <b><span style="color:#d62728;">{{c11::PID}}</span></b>, or <b><span style="color:#d62728;">{{c11::IUD use}}</span></b>.

---

## Cloze HTML Styling

Apply inline HTML styling to clozed terms using bold and color coding.

Wrap each clozed term with:
```
<b><span style="color:#HEXCODE;">{{cX::term}}</span></b>
```

### Standardized 5-Color System

| Category | Hex Code | Examples |
|---|---|---|
| Structures / Anatomy | #7f3fbf | hypothalamus, coronary artery, kidney, corpus luteum, basal ganglia |
| Hormones / Labs / Biomarkers / Diagnostic Tests | #1f77b4 | estrogen, troponin, TSH, dopamine, CRP, β-hCG, pregnancy test, Pap smear, biopsy |
| Diseases / Diagnoses | #d62728 | ovarian failure, MI, asthma, appendicitis, schizophrenia |
| Timing / Phases / Thresholds | #2ca02c | Day 14, >200, 3 months, 6 weeks, Stage II, 5 days, 1 week, any point in the cycle |
| Treatments / Drugs / Procedures / Named Clinical Methods | #ff7f0e | OCPs, metoprolol, MRI, surgery, Sunday start method, quick start method, emergency contraception, backup contraception |

### Color Category Clarifications

**Diagnostic tests → Blue (#1f77b4)**
Pregnancy test, Pap smear, biopsy, culture, CBC, BMP — any test ordered to measure or detect something. These are labs/diagnostics, not procedures.

**Named clinical protocols and initiation methods → Orange (#ff7f0e)**
Sunday start, quick start method, Gardasil, any named protocol for starting or administering treatment. These are interventions even if they sound like labels.

**Timing values → Green (#2ca02c)**
Any numeric duration, cutoff, or phase: "5 days", "1 week", "Day 5", "any point in the cycle", ">5 days ago". If it answers "when" or "how long", it's green.

---

## Bolding Rules

- Bold non-clozed words **only** if they function as structural orientation labels already explicitly present in the original text
- A structural orientation label is a word or phrase that identifies a section header, stage name, phase name, timing marker, or categorical label
- Do not bold content words that represent mechanisms, diagnoses, structures, hormones, symptoms, treatments, or actions unless they are clozed

---

## What Never Gets Colored

- Filler words
- Grammar
- Linking verbs (unless they are clozed)
- "causes" / "leads to" / "is"
- Pronouns

---

## Cloze Numbering Rule

Card number N must use cN for ALL its clozes. No exceptions.

- Card 1 → all clozes are c1
- Card 10 → all clozes are c10
- Card 17 → all clozes are c17

Never mix cloze numbers within a single card.

---

## Output Format

```
number|cloze card text
```

- No spaces around the pipe
- No blank lines
- No commentary before or after cards
- No extra pipes anywhere in the output

---

## Validation Checklist

### 5-Second Rapid Validation

1. **One Pipe Per Line** — number|text, no spaces around pipe
2. **Number Clean** — left side is number only, no period or extra characters
3. **No Extra Pipes** — right side contains zero additional | characters
4. **Cloze Styled Correctly** — every cloze is `<b><span style="color:#HEXCODE;">{{cX::term}}</span></b>`
5. **No Extra Lines** — no blank rows, no commentary

### 3-Rule Quick Audit

**Rule 1 — Mechanism Integrity**
Does this card test a complete physiological mechanism unit? (Structure→action, Hormone→effect, Trigger→consequence, Direction of change)

**Rule 2 — Structural Anchor Check**
Does this card make sense in isolation? No pronouns, no missing subjects, no reliance on previous card.

**Rule 3 — Efficiency vs. Explosion**
Are distinct mechanism units split? Are tightly linked elements bundled? Is nothing omitted?

### Content Completeness Audit
Before finalizing, verify the output contains cards for:
- [ ] All onset/age/timing markers present in the source
- [ ] All peak, duration, and resolution timing markers present in the source — bundled as one card if they describe sequential phases of the same event
- [ ] All associated symptom clusters bundled under one cloze index
- [ ] All physical exam findings present in the source
- [ ] All treatment responses present in the source — both positive and negative
- [ ] All underlying causes or pathology lists present in the source
- [ ] Every card uses an explicit subject — no pronouns or vague referents
- [ ] Every card number N uses only cN cloze indices
- [ ] No two cards are identical or near-identical in wording
- [ ] No shallow anchor card exists when a detailed version of the same concept is already present

---

## Subject Color Coding — Always Apply

When the subject of a card is a disease, diagnosis, condition, structure, hormone, or any term belonging to the 5-color system, wrap it in bold color even when it is NOT the clozed term.

**Example:**
```
<b><span style="color:#d62728;">Primary dysmenorrhea</span></b> is caused by excess <b><span style="color:#1f77b4;">{{c3::prostaglandin}}</span></b> production.
```

### The Subject is NEVER Clozed

The subject is the term the card is about. It provides the context a student needs to answer the question. Clozing the subject removes the context and makes the card unanswerable.

**How to identify the subject:**
- It appears at the start of the card as what the sentence describes
- Removing it would make the card lose its meaning entirely
- It is color-coded but always left visible

**CORRECT — subject colored but not clozed:**
```
<b><span style="color:#ff7f0e;">Sunday start</span></b> method begins on {{first Sunday after menses}}.
<b><span style="color:#ff7f0e;">Oral contraceptives</span></b> can be started via {{Sunday start}} or {{quick start}}.
<b><span style="color:#d62728;">Primary dysmenorrhea</span></b> is caused by excess {{prostaglandin}} production.
```

**INCORRECT — subject clozed:**
```
The {{quick start}} method allows initiation at any point. ← wrong, "quick start" is the subject
{{Oral contraceptives}} can be started in two ways. ← wrong, OCP is the subject
```

The testable element is always what the subject DOES, HAS, or IS ASSOCIATED WITH — not the subject name itself.

---

## Clinical Decision Trees — One Card Per Branch

When the source contains conditional logic ("if X then Y", "if LMP was within 5 days", "if negative then"), each branch is independently testable and gets its own card. Never bundle multiple conditional branches into one card even if they appear in the same sentence or paragraph.

**What to cloze in each branch:**
Cloze the threshold value and the required action. Leave the condition type visible as context.
- The numeric cutoff (5 days, 7 days, 1 week) → green (#2ca02c)
- The required test or intervention (pregnancy test, emergency contraception, backup contraception) → appropriate color
- Leave "if", "then", condition qualifiers like "negative/positive" visible as context anchors

**CORRECT — one card per branch, clozing threshold + action:**
- With the quick start method, if LMP was within the past <b><span style="color:#2ca02c;">{{cN::5 days}}</span></b>, the pill can be started immediately with <b><span style="color:#2ca02c;">{{cN::1 week}}</span></b> of <b><span style="color:#ff7f0e;">backup contraception</span></b>.
- With the quick start method, if LMP was more than <b><span style="color:#2ca02c;">{{cN::5 days}}</span></b> ago, a <b><span style="color:#1f77b4;">{{cN::pregnancy test}}</span></b> is needed before starting.
- With the quick start method, if pregnancy test is negative and no unprotected intercourse since LMP, start with <b><span style="color:#2ca02c;">{{cN::1 week}}</span></b> of <b><span style="color:#ff7f0e;">backup contraception</span></b>.
- With the quick start method, if unprotected intercourse within last <b><span style="color:#2ca02c;">{{cN::5 days}}</span></b>, offer <b><span style="color:#ff7f0e;">{{cN::emergency contraception}}</span></b> first.

**INCORRECT — bundling branches:**
- If LMP <5 days start immediately; if >5 days get pregnancy test; if negative start with 1 week backup. ← too much on one card

Each "if → then" is a discrete clinical decision point that boards test independently.

---

## Tight Cloze Boundaries — Never Cloze Entire Phrases

Cloze only the single testable word or the tightest meaningful term. Never cloze the surrounding causal context.

**CORRECT:**
```
is caused by excess <b><span style="color:#1f77b4;">{{c3::prostaglandin}}</span></b> production
```

**INCORRECT:**
```
is caused by <b><span style="color:#1f77b4;">{{c3::excess prostaglandin production}}</span></b>
```

The causal verb ("leads to", "caused by", "results in") and surrounding words must remain visible as contextual anchors. Only the key testable term gets clozed.

More examples:
- CORRECT: leads to `{{uterine contractions}}` — verb stays visible
- INCORRECT: `{{leads to uterine contractions}}` — verb is swallowed
- CORRECT: begins within `{{1–2 years of menarche}}` — timing term only
- INCORRECT: `{{begins within 1–2 years of menarche}}` — too much clozed

**Do not cloze result qualifiers:**
Words like "negative", "positive", "conclusive", "normal", "abnormal" are outcome descriptors that provide context. Do not cloze them unless the qualifier itself is the entire testable concept of the card. Cloze the test, procedure, or finding instead.

- INCORRECT: `pregnancy test is {{negative}} → start with backup` — "negative" is context, not the testable fact
- CORRECT: `LMP >5 days ago → {{pregnancy test}} needed` — the test itself is testable
- EXCEPTION: `pelvic exam is {{normal}}` — here "normal" IS the entire finding and is correctly clozed

---

## Treatment Cards — Split vs Bundle

When the source contrasts two distinct treatments across separate clauses, create one card per treatment:
- "Symptoms improve with NSAIDs" → one card
- "Symptoms improve with hormonal contraceptives" → separate card

When the source lists multiple treatments as examples within a single clause using "such as X, Y, or Z", keep them bundled on one card under the same cloze index:
- "Treatment such as surgery, antibiotics, or targeted interventions" → one card, all bundled

Never split a "such as" list into separate cards. Never bundle two separate contrasting treatment clauses into one card.

---

## No Duplicate Cards

Never generate two cards with the same or nearly identical text. Before outputting the final list, scan every card against all others. If two cards test the same concept with the same wording, keep only one and renumber sequentially.

Red flags for duplicates:
- Same subject, same verb, same clozed term
- Only difference is the card number
- Two cards that would produce identical Anki review prompts

**Special case — anchor + detail duplicate:**
Do not generate a shallow anchor card followed immediately by a detailed version of the same concept. Example of what NOT to do:

Card A: Secondary dysmenorrhea is due to underlying pelvic {{pathology}}.
Card B: Secondary dysmenorrhea is due to underlying pelvic pathology such as {{endometriosis}}, {{adenomyosis}}...

Card A is redundant — Card B already contains the full concept. Only generate Card B.

If you catch yourself writing a card that already exists, skip it and continue to the next concept.

---

## Mental Shortcut

Before approving a card, ask:
- Would this help me answer a board-style question? If yes → keep it.
- If it feels like memorizing grammar → adjust.
- If it feels like I need three cards to understand it → bundle.