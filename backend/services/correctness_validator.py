"""Correctness validator: grade generated cards against the card-generation
rules (a QA rubric distilled from card_gen_v6) and report per-rule pass/fail.

Used by the on-demand "Validate Cards" action. A separate fix loop (in the
cards router) regenerates failing cards with the failed-rule guidance.
"""
from __future__ import annotations

import logging
import re

import anthropic

from backend.config import resolve_model, effort_kwargs
from backend.services.ai_utils import tool_use_input, usage_dict, strip_cloze, response_text

logger = logging.getLogger(__name__)

# Each rule: key (stored), title (shown on hover), criteria (how the judge
# decides pass/fail), guidance (appended to the fix prompt when it fails).
RULES = [
    {
        "key": "single_concept",
        "title": "Single concept",
        "criteria": (
            "Decide using the sibling-card rules, biased toward NOT splitting. A card may legitimately "
            "be long or hold several clozes — length and cloze count are NOT reasons to fail. "
            "PASS (keep as one card) when the content is a tightly-linked clinical set tested as a unit: "
            "a classic triad, named pearl or mnemonic, diagnostic-criteria set, symptom cluster, "
            "first-line management group, a single mechanism or causal chain, or at most two items with "
            "short (3 words or fewer) qualifiers. FAIL (and set split_suggested) ONLY when the card "
            "bundles a list of items for which ALL of the following hold: (a) each item carries its own "
            "explanation content (a clause, sentence, sub-bullet, or qualifier of 4 or more words), "
            "(b) the items share one conceptual category (all symptoms, all treatments, all findings, "
            "all diagnostic steps, etc.), and (c) each item could stand as its own EOR exam question "
            "without the others. When uncertain, PASS."
        ),
        "guidance": "If this is a genuine list of same-category items that each carry their own 4-plus-word explanation, it should become sibling cards; otherwise keep it as one coherent concept without dropping any content.",
    },
    {
        "key": "studyable",
        "title": "Studyable in isolation",
        "criteria": "A clear visible (unclozed) anchor/subject remains, AND enough surrounding context is visible that a student could actually answer the card. FAIL if the cloze hides so much that the stem is unanswerable, if there is no visible anchor, or if the card is so short/stripped it has no clinical context to study from.",
        "guidance": "There isn't enough visible context to answer this card, or the cloze hides too much / the anchor is gone. Keep the condition or subject visible and add enough surrounding clinical context that the student can answer it; cloze only the specific recall target.",
    },
    {
        "key": "cloze_construction",
        "title": "Cloze construction",
        "criteria": "Uses {{c1::...}} cloze syntax correctly; does NOT cloze an entire sentence; does NOT cloze logical connectors (and/or/with/without) or filler words; no leftover markdown inside clozes. FAIL on any of these.",
        "guidance": "Fix the cloze construction: use {{c1::term}} on the specific testable term only, never the whole sentence, never connectors/filler, and no markdown inside the cloze.",
    },
    {
        "key": "bold_appropriate",
        "title": "Bold appropriateness",
        "criteria": (
            "Judge NON-clozed words only. Clozed terms are ALWAYS wrapped in the blue span + bold "
            "(<span style=\"color:#1f77b4\"><b>{{c1::...}}</b></span>) by design — that is required styling, "
            "NOT a bold violation; ignore the bold inside clozes entirely. For the remaining (non-clozed) "
            "words: the card's anchor/condition and legitimate structural labels or source emphasis qualifiers "
            "(most common, first line, gold standard) may be bold. FAIL only when an ordinary, filler, or "
            "connector word that is NOT clozed is bolded (e.g. 'and', 'with', 'better', 'include', 'the'), or "
            "when the visible anchor/condition is clearly present but not bolded."
        ),
        "guidance": "Keep EVERY clozed term wrapped exactly in <span style=\"color:#1f77b4\"><b>{{c1::...}}</b></span> — never remove the bold or color from a cloze. Only adjust NON-cloze bolding: bold the card's anchor/condition, remove bold from ordinary/filler words.",
    },
    {
        "key": "extra_quality",
        "title": "Additional-context quality",
        "criteria": "The additional context (extra) field is drawn only from the same source sentence/bullet group, is clearly labeled when it carries reinforcement content, and is complete (when this is a sibling card, the labeled footer lists every other sibling item with full explanations). FAIL if the extra is missing where it should carry sibling/source content, is an unlabeled fragment, or is incomplete.",
        "guidance": "Improve the additional context field: include the related items from the same source group, label it clearly (e.g. 'Other symptoms:'), and make it complete. Leave it blank only when nothing from the same source group applies.",
    },
    {
        "key": "neutral_unattributed",
        "title": "Neutral & unattributed",
        "criteria": "Neutral standardized clinical language. FAIL if it contains source/platform names (Smartypance, UWorld, Rosh, etc.), instructional/conversational phrasing ('think of', 'buzzword', 'classic presentation'), or empty framing phrases ('is a hallmark feature', 'is a key clinical finding').",
        "guidance": "Re-express in neutral clinical language: remove any source/platform names, instructional phrasing, and empty framing phrases; state the clinical fact directly.",
    },
    {
        "key": "format_markup",
        "title": "Format & markup",
        "criteria": "HTML-only formatting — no markdown (no ** or * for bold, no # headings, no backticks) — and no em dashes or double hyphens. (This rule is verified in code.)",
        "guidance": "Use HTML tags only for emphasis (<b>...</b>); remove all markdown (**, *, #, backticks) and any em dashes or double hyphens.",
    },
]

RULE_KEYS = [r["key"] for r in RULES]
RULE_BY_KEY = {r["key"]: r for r in RULES}

_SYSTEM = (
    "You are a quality-assurance reviewer for PA (Physician Assistant) EOR exam cloze flashcards. "
    "You are given finished cards and must judge each one against a fixed rubric, rule by rule. "
    "Be strict but fair: the overarching question is whether a student preparing for the PA EOR exam "
    "could study this card efficiently and grab a single clean concept from it.\n\n"
    "RUBRIC (judge every card against every rule):\n"
    + "\n".join(f"- {r['key']}: {r['criteria']}" for r in RULES)
    + "\n\nFor each card, return a verdict (pass true/false) for every rule key, plus a brief reason "
    "(one short clause) whenever a rule fails (reason may be empty when it passes). "
    "Set split_suggested true ONLY when single_concept fails AND the card is a genuine same-category "
    "list whose items each carry their own 4-plus-word explanation, which the sibling-card rules require "
    "to be separate cards. Never suggest splitting tightly-linked sets, triads, named pearls, "
    "diagnostic-criteria sets, symptom clusters, first-line management groups, single mechanisms, or "
    "cards that are merely long. When in doubt, do not split."
)

_TOOL = {
    "name": "submit_review",
    "description": "Return the per-rule pass/fail verdict for every card.",
    "input_schema": {
        "type": "object",
        "properties": {
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "card_id": {"type": "integer"},
                        "split_suggested": {"type": "boolean"},
                        "rules": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "key": {"type": "string", "enum": RULE_KEYS},
                                    "pass": {"type": "boolean"},
                                    "reason": {"type": "string"},
                                },
                                "required": ["key", "pass", "reason"],
                            },
                        },
                    },
                    "required": ["card_id", "split_suggested", "rules"],
                },
            }
        },
        "required": ["results"],
    },
}


# ── Cloze styling normalizer ─────────────────────────────────────────────────
# Every cloze must be wrapped exactly in the blue span + bold. A regenerate/split
# may drop or double-wrap it; this re-applies the wrapper deterministically so the
# styling can never be stripped, regardless of what the model returns.
_CLOZE_STYLE_OPEN = '<span style="color:#1f77b4"><b>'
_CLOZE_STYLE_CLOSE = '</b></span>'
_CLOZE = r"\{\{c\d+::.*?\}\}"
_UNWRAP_SPAN = re.compile(r'<span style="color:#1f77b4">\s*<b>\s*(' + _CLOZE + r")\s*</b>\s*</span>")
_UNWRAP_B = re.compile(r"<b>\s*(" + _CLOZE + r")\s*</b>")
_BARE_CLOZE = re.compile("(" + _CLOZE + ")")


def ensure_cloze_styling(html: str) -> str:
    """Wrap every cloze in exactly the blue span + bold (idempotent)."""
    if not html or "{{c" not in html:
        return html
    s = _UNWRAP_SPAN.sub(r"\1", html)   # remove existing blue-span wrappers
    s = _UNWRAP_B.sub(r"\1", s)          # remove any bare <b> around a cloze
    s = _BARE_CLOZE.sub(lambda m: _CLOZE_STYLE_OPEN + m.group(1) + _CLOZE_STYLE_CLOSE, s)
    return s


def _format_check(front_html: str, extra: str | None) -> tuple[bool, str]:
    """Deterministic check for rule format_markup. Returns (passed, reason)."""
    blob = f"{front_html or ''} {extra or ''}"
    if re.search(r"\*\*|(?<!\w)\*(?!\w)|(?:^|\s)#{1,3}\s|`", blob):
        return False, "Markdown found in output (use HTML only)."
    if "—" in blob or "--" in blob:
        return False, "Em dash or double hyphen found."
    return True, ""


def judge_cards(
    client: anthropic.Anthropic,
    cards: list[dict],
    model: str,
    curriculum_path: str = "",
) -> tuple[list[dict], dict]:
    """Grade a batch of cards against all rules.

    cards: list of {"id", "front_html", "extra"}.
    curriculum_path: where these cards live (e.g. "Surgery > GI > Cholecystitis"),
    so the judge knows the anchor/topic context when scoring.
    Returns (results, usage). Each result: {"card_id", "split_suggested",
    "rules": [{"key", "pass", "reason"}]} with the format_markup rule overridden
    by the deterministic code check.
    """
    def card_block(c):
        front = c.get("front_html", "")
        plain = strip_cloze(front)
        extra = c.get("extra") or "(none)"
        return f"Card {c['id']}:\n  front_html: {front}\n  front_revealed: {plain}\n  extra: {extra}"

    topic_line = (
        f"Topic context — these cards belong under this curriculum path: {curriculum_path}\n"
        "Use it to judge whether the visible anchor/context is sufficient and which condition the card is about.\n\n"
        if curriculum_path else ""
    )
    user_message = (
        topic_line
        + "Review these cards. Judge every card against every rule in the rubric.\n\n"
        + "\n\n".join(card_block(c) for c in cards)
    )

    response = client.messages.create(
        model=resolve_model(model)[0],
        **effort_kwargs(model),
        max_tokens=16384,
        temperature=0,
        system=[{"type": "text", "text": _SYSTEM, "cache_control": {"type": "ephemeral"}}],
        tools=[_TOOL],
        tool_choice={"type": "tool", "name": "submit_review"},
        messages=[{"role": "user", "content": user_message}],
    )
    payload = tool_use_input(response, "submit_review")
    raw_results = payload.get("results") or []

    sent = {c["id"]: c for c in cards}
    out = []
    for r in raw_results:
        cid = r.get("card_id")
        if cid not in sent:
            continue
        # Normalize to exactly one verdict per rule key, in rule order.
        by_key = {rv.get("key"): rv for rv in (r.get("rules") or []) if rv.get("key") in RULE_BY_KEY}
        rules_out = []
        for rk in RULE_KEYS:
            rv = by_key.get(rk, {"pass": True, "reason": ""})
            rules_out.append({
                "key": rk,
                "title": RULE_BY_KEY[rk]["title"],
                "pass": bool(rv.get("pass", True)),
                "reason": (rv.get("reason") or "").strip(),
            })
        # Override format_markup with the deterministic check.
        c = sent[cid]
        ok, reason = _format_check(c.get("front_html", ""), c.get("extra"))
        for ru in rules_out:
            if ru["key"] == "format_markup":
                ru["pass"] = ok
                ru["reason"] = "" if ok else reason
        out.append({
            "card_id": cid,
            "split_suggested": bool(r.get("split_suggested", False)),
            "rules": rules_out,
        })
    return out, usage_dict(response)


def summarize(rules: list[dict]) -> tuple[int, int]:
    """Return (passed_count, total) for a card's rule list."""
    total = len(rules)
    passed = sum(1 for r in rules if r.get("pass"))
    return passed, total


def split_card(
    client: anthropic.Anthropic,
    section_data: dict,
    existing_card_html: str,
    existing_extra: str | None,
    rules_text: str,
    model: str,
) -> tuple[list[dict], dict]:
    """Split one overloaded card into multiple focused sibling cards. Returns
    (cards, usage) where each card is a parsed {front_html, front_text, extra,...}.
    """
    from backend.services.generator import ANCHOR_INSTRUCTION, _render_source_text, parse_card_output

    source = _render_source_text(section_data)
    topic = section_data.get("curriculum_topic_path") or ""
    topic_line = f"Curriculum context (for reference only): {topic}\n" if topic else ""

    user = (
        "You are splitting one overloaded flashcard into multiple focused sibling cards.\n\n"
        f"{topic_line}Section: {section_data.get('heading', '')}\n\n"
        f"Source text:\n{source}\n\n"
        f"The existing card to split:\n{existing_card_html}\n"
        + (f"Existing additional context:\n{existing_extra}\n" if existing_extra else "")
        + "\nSplit this into 2 or more separate, focused cloze cards, each testing one independently "
        "testable concept. These cards are closely related siblings, so give each card an additional "
        "context field that briefly references the related concepts covered by the other sibling cards, "
        "so each card still stands on its own and the link between them is preserved. "
        "SCOPE: Split ONLY the content already in this card into siblings. Use the source text solely to "
        "keep the facts accurate and the wording faithful — do NOT introduce items, bullets, or facts from "
        "elsewhere in the section. "
        "Output one card per line in the exact format:\n"
        "number|cloze card text|additional context (optional)"
    )
    response = client.messages.create(
        model=resolve_model(model)[0],
        **effort_kwargs(model),
        max_tokens=4096,
        temperature=0,
        system=[{"type": "text", "text": ANCHOR_INSTRUCTION + "\n\n" + rules_text, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user}],
    )
    cards, _needs_review = parse_card_output(response_text(response))
    return cards, usage_dict(response)


def fix_guidance(failed_rules: list[dict]) -> str:
    """Build the guidance string appended to the fix (regenerate) prompt."""
    lines = ["This card failed the following quality rules. Fix ALL of them while preserving the clinical content:"]
    for r in failed_rules:
        g = RULE_BY_KEY.get(r["key"], {}).get("guidance", "")
        reason = r.get("reason")
        lines.append(f"- {RULE_BY_KEY.get(r['key'], {}).get('title', r['key'])}: {g}" + (f" (issue: {reason})" if reason else ""))
    lines.append(
        "SCOPE: Rewrite ONLY the content this card already covers. Use the source text solely to keep the "
        "facts accurate and to restore any missing context for THIS card — do NOT pull in other items, "
        "bullets, or facts from elsewhere in the section, and do not broaden the card's scope."
    )
    return "\n".join(lines)
