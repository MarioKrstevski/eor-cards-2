# How "Validate & Fix" Works — Step by Step

This walks through what happens when you run **Validate & fix** on a section or topic: what the tool checks, how it decides, and how it repairs cards. (For the exact rules and prompt wording, see `card_validation_rules.md`.)

---

## The steps

When you click **Validate & fix**, the tool reviews every card and decides what to do, step by step:

**1. It scores each card** against a set of 7 quality checks — for example: Does the card test *one* clear concept (or is it really several cards crammed into one)? Is there enough visible context for a student to actually answer it? Are the cloze blanks built correctly? Is bold used only where it belongs? Is the extra/context field complete? Is the wording clean (no source names or stray formatting)? The card's **topic path** is given to the reviewer so it knows which condition the card is about.

**2. It shows the result as a small colored score** next to each card — out of 7. Green means it passed everything, amber means one issue, red means two or more. Hover over the score to see exactly which checks passed or failed, and why.

**3. If a card has problems, it fixes them in a loop.** First it checks the card and notes exactly which rules failed. Then it rewrites the card to address those specific issues, and **re-checks the new version against all the rules again**. If something still isn't right, it fixes it once more and tests again — repeating this **check → fix → re-check** cycle up to **3 times**. After each attempt it compares the scores and **keeps the best version** it produced. Throughout, it works only from the original study notes (so it won't invent content) and keeps the card's styling intact.

**4. If a card is actually several separate facts, it splits it** into individual "sibling" cards so each tests one thing — then runs the same quality-check-and-fix process on each of the new cards too. (Tightly-linked sets — triads, "may also present with…" clusters, first-line management groups — are deliberately kept as one card and *not* split.)

**5. Everything stays reviewable.** You can filter to show *only the cards it changed*, see a clear before/after for any fix, and undo any change you don't agree with — so the tool does the heavy lifting and you just review the handful it touched, instead of re-reading the whole deck.

---

## What the fixer is told

When a card fails, the repair step receives **both**:
- the **standing fix-instruction** for each failed rule (how to fix that kind of problem), and
- the reviewer's **specific reason** for *this* card (the same "why" you see when you hover the score).

It's also told that the **section's study notes are the only authoritative source of facts** — the card's existing extra field is reference only, so it can't invent or carry over anything that isn't in the notes.

---

## A worked example

### The card (with 2 problems)

> **First-line treatment for `{{c1::community-acquired pneumonia}}` in healthy outpatients is a `{{c1::macrolide}}`, <b>such</b> as azithromycin.**

Two issues:
- **No visible anchor** — the *condition itself* (community-acquired pneumonia) is hidden in a blank, so when the card is studied there's nothing telling the student what's being asked.
- **Wrong bolding** — the ordinary word "**such**" is bolded.

### Step 1 — Check
The reviewer is given the card plus its topic path (`Internal Medicine > Pulmonology > Pneumonia`) and grades all 7 rules:
- Studyable → ❌ "The condition is clozed, so there's no visible anchor."
- Bold appropriateness → ❌ "'such' is an ordinary word and shouldn't be bold."
- (the other 5 rules pass)

**Score: 5/7 → red badge.**

### Step 2 — Decide
Two fixable problems (not a split case) → it enters the fix loop.

### Step 3 — Fix (attempt 1): what it sends
It sends the AI the section's study notes, the current card, and the specific failures with instructions, roughly:
> *"This card failed: (1) keep the condition visible as the anchor, cloze only the specific recall target; (2) remove bold from ordinary words. Rewrite as one card, using only the study notes."*

### Step 3 — what comes back
> **First-line treatment for community-acquired pneumonia in healthy outpatients is a `{{c1::macrolide}}` such as azithromycin.**

(Condition now visible, only "macrolide" hidden, "such" no longer bold.) The styling is then auto-applied so the blank shows blue + bold.

### Step 3 — re-check
It scores the new version → **7/7, all pass.** Nothing left to fix, so it stops early (it didn't need attempts 2 or 3). *If something had still failed, it would rewrite and re-check again, up to 3 attempts, keeping whichever attempt scored highest.*

### Step 4 — Store
The card is updated in place, now showing a **green 7/7**, and flagged as "changed by validator."

### Step 5 — Review
You filter to **only the changed cards**, see **before (5/7) → after (7/7)**, and if you disagreed you'd hit **Revert** to restore the original. One card reviewed instead of the whole deck.

---

## Good to know

- It's **on-demand** — it only runs when you click Validate & fix; it doesn't run automatically during generation.
- It runs at the **model you've selected** in settings (use the strongest setting for the best judgments and fixes).
- Auto-fix **overwrites** the card in place (no separate approval step) — but every change is reviewable and revertible.
- **Splits replace** the original card with its siblings; to undo a split, select the siblings and use **Combine**.
