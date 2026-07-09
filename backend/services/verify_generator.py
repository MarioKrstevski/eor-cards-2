"""Generate → Verify → Fix → re-verify chain (own flow, isolated from Generate
and SBS). One click runs it all internally:

  1. GENERATE (AI)   — one-shot, the FULL generation prompt. Cards come back.
  2. VERIFY  (AI)    — fresh call, the WHOLE prompt again + the cards, forced to
                       flag which cards break the rules and why (structured).
  3. FIX     (AI)    — fresh call, ONLY the flagged cards + reasons. Returns
                       replacements, tagged with which originals they replace.
     [code MERGE]     — passed cards kept verbatim; code (not the model) decides
                       what's removed/replaced; combine/split tracked via derived_from.
  4. RE-VERIFY (AI)  — judgment only on the merged deck (no second fix).
  5. [code CHECKS]   — deterministic mechanical checks, reported for manual review.

Every stage is recorded in a trace for the downloadable report. Works on Claude
and Gemini (reuses the SBS structured-output dispatch, run_tool)."""
from __future__ import annotations
import re
import logging

from backend.config import DEFAULT_MODEL
from backend.services.generator import (
    generate_cards_for_section, strip_card_html, fix_markdown_bold,
)
from backend.services.sbs_generator import run_tool

logger = logging.getLogger(__name__)


# ── Structured schemas for the verify / fix / re-verify calls ─────────────────
VERIFY_TOOL = {
    "name": "submit_verdict",
    "description": "Flag which cards break the rules. Do NOT rewrite any card here.",
    "input_schema": {
        "type": "object",
        "properties": {
            "violations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "card_ids": {"type": "array", "items": {"type": "integer"},
                                     "description": "the card id(s) this violation involves; for a combine, list all cards that should merge"},
                        "rule_broken": {"type": "string"},
                        "reason": {"type": "string"},
                        "suggested_action": {"type": "string", "enum": ["combine", "split", "refocus", "reword", "other"]},
                    },
                    "required": ["card_ids", "reason", "suggested_action"],
                },
            },
            "passed_card_ids": {"type": "array", "items": {"type": "integer"}},
        },
        "required": ["violations", "passed_card_ids"],
    },
}

FIX_TOOL = {
    "name": "submit_fixes",
    "description": "Return corrected replacement cards for the flagged cards only.",
    "input_schema": {
        "type": "object",
        "properties": {
            "fixes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "replaces_card_ids": {"type": "array", "items": {"type": "integer"},
                                              "description": "the original card id(s) this fix replaces (combine: several; split/reword: one)"},
                        "cards": {
                            "type": "array",
                            "description": "the replacement card(s): 1 for combine/refocus/reword, N for split",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "front": {"type": "string", "description": "the corrected cloze card text with the required styling"},
                                    "extra": {"type": "string", "description": "the additional-context/footer field, or empty string"},
                                },
                                "required": ["front"],
                            },
                        },
                    },
                    "required": ["replaces_card_ids", "cards"],
                },
            }
        },
        "required": ["fixes"],
    },
}

REVERIFY_TOOL = {
    "name": "submit_final_verdict",
    "description": "Judge the corrected deck. Do NOT rewrite anything — verdict only.",
    "input_schema": {
        "type": "object",
        "properties": {
            "all_pass": {"type": "boolean"},
            "summary": {"type": "string"},
            "remaining_issues": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "card_ids": {"type": "array", "items": {"type": "integer"}},
                        "reason": {"type": "string"},
                    },
                    "required": ["reason"],
                },
            },
        },
        "required": ["all_pass", "summary"],
    },
}


def _cards_for_prompt(cards: list[dict]) -> str:
    """Render the deck for a verify/fix call: id + card text + extra."""
    lines = []
    for c in cards:
        cid = c.get("id", c.get("card_number"))
        lines.append(f"[card {cid}] {c.get('front_html', '')}")
        if c.get("extra"):
            lines.append(f"    extra: {c['extra']}")
    return "\n".join(lines)


def _finalize_front(front: str) -> tuple[str, str]:
    """Same deterministic cleanup the SBS assemble step uses: markdown ** -> <b>,
    normalize any cloze index to c1, and derive plain front_text."""
    front = fix_markdown_bold(front or "")
    front = re.sub(r"\{\{c\d+::", "{{c1::", front)
    return front, strip_card_html(front)


# ── The AI stages ─────────────────────────────────────────────────────────────
def run_generate(section_data: dict, rules_text: str, model: str):
    cards, needs_review, usage = generate_cards_for_section(section_data, rules_text, model)
    for i, c in enumerate(cards, 1):
        c["id"] = i
        c["card_number"] = i
    return cards, usage


def run_verify(rules_text: str, cards: list[dict], model: str):
    system = rules_text
    user = (
        "You generated the flashcards below from a study note, using the rules in your "
        "instructions. Now review them with fresh eyes AGAINST THOSE SAME RULES and flag "
        "every card that breaks a rule — do not rewrite anything, only judge. Look "
        "especially for cards that were wrongly bundled together (should be split) or "
        "wrongly separated (should be combined), and cards that clozed the wrong target. "
        "For each violation give the card id(s), the reason, and a suggested_action. List "
        "the ids of all cards that are correct in passed_card_ids. Return via submit_verdict.\n\n"
        f"Cards:\n{_cards_for_prompt(cards)}"
    )
    data, usage = run_tool(system, user, VERIFY_TOOL, model)
    violations = data.get("violations", []) or []
    trace = {"stage": "verify", "system": system, "user": user, "output": data}
    return violations, data.get("passed_card_ids", []), usage, trace


def run_fix(rules_text: str, flagged: list[dict], violations: list[dict], model: str):
    system = rules_text
    viol_txt = "\n".join(
        f"- cards {v.get('card_ids')}: {v.get('reason','')} (suggested: {v.get('suggested_action','')})"
        for v in violations
    )
    user = (
        "These cards were flagged as breaking the rules. Fix ONLY these, following the "
        "rules and the suggested actions. For a combine, return ONE merged card whose "
        "replaces_card_ids lists all the merged ids. For a split, return the N cards and "
        "list the single id it replaces. For refocus/reword, return the one corrected "
        "card. Do not touch or re-emit any other cards. Return via submit_fixes.\n\n"
        f"Flagged reasons:\n{viol_txt}\n\n"
        f"Flagged cards:\n{_cards_for_prompt(flagged)}"
    )
    data, usage = run_tool(system, user, FIX_TOOL, model)
    trace = {"stage": "fix", "system": system, "user": user, "output": data}
    return data.get("fixes", []) or [], usage, trace


def run_reverify(rules_text: str, cards: list[dict], model: str):
    system = rules_text
    user = (
        "Here is the corrected deck after one fix pass. Judge it against the rules — "
        "verdict ONLY, do not rewrite. Say whether it all passes; if not, list the "
        "remaining issues. Return via submit_final_verdict.\n\n"
        f"Cards:\n{_cards_for_prompt(cards)}"
    )
    data, usage = run_tool(system, user, REVERIFY_TOOL, model)
    trace = {"stage": "reverify", "system": system, "user": user, "output": data}
    return data, usage, trace


# ── Code stages ───────────────────────────────────────────────────────────────
def merge_deck(original: list[dict], fixes: list[dict]) -> tuple[list[dict], list[dict]]:
    """Passed cards are kept VERBATIM; code (not the model) decides what's removed.
    Final = (cards whose id is in no fix's replaces list) + (all fix replacement
    cards, each carrying derived_from). Returns (final_cards, before_after)."""
    replaced: set[int] = set()
    for f in fixes:
        replaced.update(f.get("replaces_card_ids", []) or [])

    final: list[dict] = [dict(c) for c in original if c["id"] not in replaced]
    before_after: list[dict] = []
    for f in fixes:
        from_ids = f.get("replaces_card_ids", []) or []
        new_ids = []
        for nc in f.get("cards", []) or []:
            fh, ft = _finalize_front(nc.get("front", ""))
            card = {"front_html": fh, "front_text": ft,
                    "extra": (nc.get("extra") or None), "source_ref": None,
                    "needs_review": not bool(re.search(r"\{\{c1::", fh)),
                    "derived_from": from_ids}
            final.append(card)
            new_ids.append(card)
        before_after.append({"from": from_ids, "count": len(new_ids)})

    for i, c in enumerate(final, 1):
        c["card_number"] = i
    return final, before_after


_GENERIC_WORDS = {"symptoms", "signs", "findings", "causes", "treatment", "management",
                  "risk factors", "complications", "diagnosis", "evaluation"}
_UNIT_RE = re.compile(r"\{\{c1::[^{}]*?\d[^{}]*?\s+(weeks?|days?|hours?|months?|years?|minutes?|mg|mcg|mL|mmHg)\}\}", re.I)


def deterministic_checks(cards: list[dict]) -> list[dict]:
    """Mechanical, no-API checks reported for manual review (not auto-applied)."""
    out = []
    for c in cards:
        html = c.get("front_html", "") or ""
        issues = []
        if "**" in html:
            issues.append("markdown ** present (should be HTML <b>)")
        if "—" in html or "--" in html:
            issues.append("em dash / double hyphen present")
        for hexcode in set(re.findall(r"color:\s*(#[0-9a-fA-F]{3,6})", html)):
            if hexcode.lower() != "#1f77b4":
                issues.append(f"non-standard cloze color {hexcode}")
        # A bare {{c1::...}} not wrapped in the blue-bold span
        for m in re.finditer(r"\{\{c1::", html):
            prefix = html[max(0, m.start() - 40):m.start()]
            if '<span style="color:#1f77b4"><b>' not in prefix:
                issues.append("cloze not wrapped in the blue-bold span")
                break
        if not re.search(r"\{\{c1::", html):
            issues.append("no cloze on card")
        for gw in _GENERIC_WORDS:
            if re.search(r"\{\{c1::\s*" + re.escape(gw) + r"\s*\}\}", html, re.I):
                issues.append(f"generic word '{gw}' clozed")
        if _UNIT_RE.search(html):
            issues.append("unit of measurement inside the cloze")
        if issues:
            out.append({"card_number": c.get("card_number"), "issues": issues})
    return out


def generate_and_verify(section_data: dict, rules_text: str, model: str = DEFAULT_MODEL):
    """Run the full chain. Returns (final_cards, trace)."""
    trace: list[dict] = []

    cards, _u1 = run_generate(section_data, rules_text, model)
    trace.append({"stage": "generate", "output": [
        {"id": c["id"], "front_html": c.get("front_html"), "extra": c.get("extra")} for c in cards]})

    violations, passed_ids, _u2, vtrace = run_verify(rules_text, cards, model)
    trace.append(vtrace)

    flagged_ids = sorted({cid for v in violations for cid in (v.get("card_ids") or [])})
    if not flagged_ids:
        final = cards
        trace.append({"stage": "result", "note": "Verify found no violations — no fix pass run."})
    else:
        flagged = [c for c in cards if c["id"] in flagged_ids]
        fixes, _u3, ftrace = run_fix(rules_text, flagged, violations, model)
        final, before_after = merge_deck(cards, fixes)
        ftrace["before_after"] = before_after
        trace.append(ftrace)
        _verdict, _u4, rtrace = run_reverify(rules_text, final, model)
        trace.append(rtrace)

    det = deterministic_checks(final)
    trace.append({"stage": "deterministic", "output": det})
    return final, trace


def build_verify_report_md(section_heading: str, model: str, trace: list[dict], final_cards: list[dict]) -> str:
    """Self-contained Markdown report of every stage — for reading how the pipeline
    behaved (the whole point of this flow)."""
    import json

    def fence(obj):
        if isinstance(obj, str):
            return f"```\n{obj}\n```"
        return f"```json\n{json.dumps(obj, indent=2, ensure_ascii=False)}\n```"

    out = [f"# Generate & Verify report — {section_heading}", "",
           f"- Model: `{model}`", f"- Final cards: {len(final_cards)}", ""]
    titles = {
        "generate": "Stage 1 — GENERATE (one-shot): the cards produced",
        "verify": "Stage 2 — VERIFY: which cards broke the rules, and why",
        "fix": "Stage 3 — FIX: corrected cards (before → after)",
        "reverify": "Stage 4 — RE-VERIFY: final judgment (verdict only, no more fixes)",
        "result": "Result",
        "deterministic": "Stage 5 — Deterministic checks (mechanical, manual review)",
    }
    for t in trace:
        stage = t.get("stage", "?")
        out.append(f"## {titles.get(stage, stage)}")
        out.append("")
        if t.get("note"):
            out.append(f"> {t['note']}"); out.append("")
        if "system" in t:
            out.append("### Prompt sent (rules)"); out.append(fence(t["system"])); out.append("")
            out.append("### Input"); out.append(fence(t.get("user", ""))); out.append("")
        if t.get("before_after"):
            out.append("### Before → after")
            for ba in t["before_after"]:
                out.append(f"- cards {ba['from']} → {ba['count']} new card(s)")
            out.append("")
        out.append("### Output"); out.append(fence(t.get("output", ""))); out.append("")

    out.append("## Final deck (as stored)"); out.append("")
    for c in final_cards:
        src = f" (from {c['derived_from']})" if c.get("derived_from") else ""
        out.append(f"**Card {c.get('card_number')}**{src}")
        out.append(f"- front: `{c.get('front_html','')}`")
        out.append(f"- extra: `{c.get('extra') or ''}`")
        out.append("")
    return "\n".join(out)
