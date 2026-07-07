"""Step-by-Step (SBS) card generation — an isolated, phased alternative to the
single-shot generator. Same rules, but split so the model does one job at a time:

  1. SEGMENT (AI)  — decide the units: which are standalone vs sibling sets, and
                     carry each member's verbatim source text + footer label.
  2. AUTHOR  (AI)  — write only the cloze card stem for each member, given the plan.
  3. ASSEMBLE (code) — build sibling footers deterministically from the plan,
                       set blank Column 3 for standalones, normalize/validate.

Nothing here touches the existing generation flow. Forced tool calls run on
Anthropic (anthropic_model coercion) so structured output is guaranteed valid.
"""
from __future__ import annotations
import re
import logging

import anthropic

from backend.config import ANTHROPIC_API_KEY, anthropic_model, DEFAULT_MODEL
from backend.services.ai_utils import tool_use_input, usage_dict
from backend.services.generator import _render_source_text, strip_card_html, fix_markdown_bold

# Units of measurement that should stay OUTSIDE the cloze as a hint to the student
# ("{{c1::14–18}} weeks", not "{{c1::14–18 weeks}}").
_UNIT = r"(?:weeks?|days?|hours?|months?|years?|minutes?|mg|mcg|mL|mmHg|%)"
_CLOZE_UNIT_STYLED = re.compile(
    r"(\{\{c1::[^{}]+?)\s+(" + _UNIT + r")\}\}(\*\*</span>|</b></span>)"
)
_CLOZE_UNIT_BARE = re.compile(r"\{\{c1::([^{}]+?)\s+(" + _UNIT + r")\}\}")


def _units_out(front: str) -> str:
    """Pull a trailing unit of measurement out of the cloze so the unit stays
    visible: '{{c1::14–18 weeks}}**</span>' -> '{{c1::14–18}}**</span> weeks'."""
    front = _CLOZE_UNIT_STYLED.sub(r"\1}}\3 \2", front)     # styled span form
    front = _CLOZE_UNIT_BARE.sub(r"{{c1::\1}} \2", front)   # any bare cloze that slipped through
    return front


def _strip_trailing_footer(front: str) -> str:
    """Sibling stems must contain ONLY the active member; the footer is built in
    code from the plan. If the author still appended an 'Other …:' footer to the
    stem, remove it so it isn't duplicated with the extra field."""
    return re.sub(r"(?:<br\s*/?>|\s)*(?:\*\*|<b>)?Other\b.*$", "", front, flags=re.I | re.S).rstrip()

logger = logging.getLogger(__name__)

# ── Phase assignment for the default prompt's sections ────────────────────────
# heading (verbatim, as it appears in the prompt) -> phase. Anything before the
# first heading (the preamble) is treated as "shared".
DEFAULT_PHASE_MAP = {
    "OUTPUT FORMATTING & RAW-TEXT CONSTRAINTS": "author",
    "SOURCE CONVERSION & VISUAL INTERPRETATION": "segment",
    "GRANULARITY & THE BINARY SIBLING RULE": "segment",
    "STRUCTURAL ORIENTATION & ANCHOR RULES": "segment",
    "COLUMN 3 (ADDITIONAL CONTEXT) CONSTRAINTS": "segment",
    "CONTENT TRANSFORMATION & REWORDING RULES": "author",
    "CLOZE CONSTRUCTION & ANCHOR RULES": "author",
    "LANGUAGE & ABBREVIATION RULES": "author",
    "CONTENT INTEGRITY & STYLE RULES": "shared",
    "SOURCE & PLATFORM ATTRIBUTION REMOVAL": "author",
    "CLOZE STYLING RULES": "author",
}
PHASES = ("segment", "author", "shared")


def split_prompt_into_sections(text: str, phase_map: dict | None = None) -> list[dict]:
    """Split a full prompt into [{heading, phase, text}] by its ALL-CAPS section
    headers (the keys of phase_map). The preamble before the first header becomes
    a 'shared' section named 'Preamble'. Text is kept VERBATIM."""
    phase_map = phase_map or DEFAULT_PHASE_MAP
    headers = list(phase_map.keys())
    # Find each header's position (line that exactly equals the header).
    lines = text.split("\n")
    marks: list[tuple[int, str]] = []  # (line_index, header)
    for i, line in enumerate(lines):
        if line.strip() in phase_map:
            marks.append((i, line.strip()))
    sections: list[dict] = []
    # Preamble
    first = marks[0][0] if marks else len(lines)
    preamble = "\n".join(lines[:first]).strip()
    if preamble:
        sections.append({"heading": "Preamble", "phase": "shared", "text": preamble})
    for idx, (line_i, header) in enumerate(marks):
        end = marks[idx + 1][0] if idx + 1 < len(marks) else len(lines)
        body = "\n".join(lines[line_i:end]).strip()  # include the header line itself
        sections.append({"heading": header, "phase": phase_map[header], "text": body})
    return sections


def build_phase_system(sections: list[dict], phase: str) -> str:
    """Concatenate the shared sections + this phase's sections, in order, into the
    system prompt for the phase — so each AI call sees only its relevant rules."""
    parts = [s["text"] for s in sections if s.get("phase") in ("shared", phase)]
    return "\n\n".join(p for p in parts if p and p.strip())


# ── Forced-tool schemas ───────────────────────────────────────────────────────
SEGMENT_TOOL = {
    "name": "submit_plan",
    "description": "Return the segmentation plan for the section. Do NOT write cards.",
    "input_schema": {
        "type": "object",
        "properties": {
            "units": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "integer", "description": "unique unit id"},
                        "type": {"type": "string", "enum": ["standalone", "sibling_set"]},
                        "anchor": {"type": "string", "description": "the heading/subject anchor that must stay visible on each card"},
                        "footer_label": {"type": "string", "description": "for sibling_set: the 'Other …:' label derived from the parent heading; empty for standalone"},
                        "members": {
                            "type": "array",
                            "description": "one entry per card this unit produces; source_text is the VERBATIM source slice for that member",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "source_text": {"type": "string"},
                                },
                                "required": ["source_text"],
                            },
                        },
                    },
                    "required": ["id", "type", "anchor", "members"],
                },
            }
        },
        "required": ["units"],
    },
}

AUTHOR_TOOL = {
    "name": "submit_cards",
    "description": "Return the authored cloze card stem for each member of each unit.",
    "input_schema": {
        "type": "object",
        "properties": {
            "cards": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "unit_id": {"type": "integer"},
                        "member_index": {"type": "integer", "description": "0-based index into the unit's members"},
                        "front": {"type": "string", "description": "the styled cloze card stem (blue-bold spans per the styling rules). Do NOT include other sibling members or the footer here."},
                    },
                    "required": ["unit_id", "member_index", "front"],
                },
            }
        },
        "required": ["cards"],
    },
}


def _client() -> anthropic.Anthropic:
    return anthropic.Anthropic(api_key=ANTHROPIC_API_KEY, timeout=300)


def _section_source(section_data: dict) -> str:
    return _render_source_text(section_data)


def run_segment(client, section_data: dict, sections: list[dict], model: str):
    """Phase 1 — produce the plan. Returns (units, usage)."""
    system = build_phase_system(sections, "segment")
    heading = section_data.get("heading", "")
    path = section_data.get("curriculum_topic_path", "")
    user = (
        f"Curriculum context (for reference only): {path}\n"
        f"Section: {heading}\n\n"
        f"Source text:\n{_section_source(section_data)}\n\n"
        "Segment this section into units for card generation, applying the rules above. "
        "Governing principle: ONE IDEA PER CARD. Each card must test a single thing a "
        "student would answer on the exam — not the anchor plus the value plus the "
        "causes at once. So:\n"
        "1. A sentence that contains several independently testable facts becomes "
        "SEVERAL standalone units (one idea each) — do not bundle them into one unit.\n"
        "2. A heading or label followed by two or more PARALLEL items of the same "
        "category that carry a colon, parentheses, or a qualifier (e.g. 'Management: "
        "Expectant… / Medical… / Surgical…', or a list of causes/risk factors/methods) "
        "is ONE sibling_set unit with one member per item — never split those parallel "
        "items into separate standalone units, and never cram them all into one card. "
        "Each member becomes its own card whose anchor says what it is about, with the "
        "other members carried in the footer.\n"
        "3. Only bare parallel labels with no punctuation/qualifiers are bundled into a "
        "single card; the Sequential/Diagnostic exclusion still makes workup steps "
        "standalone.\n"
        "For each unit give the VERBATIM source text of every member. Do NOT write any "
        "cards yet — return only the plan via submit_plan."
    )
    resp = client.messages.create(
        model=anthropic_model(model),
        max_tokens=8192,
        temperature=0,
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        tools=[SEGMENT_TOOL],
        tool_choice={"type": "tool", "name": "submit_plan"},
        messages=[{"role": "user", "content": user}],
    )
    plan = tool_use_input(resp, "submit_plan")
    trace = {"phase": "segment", "system": system, "user": user, "output": plan.get("units", [])}
    return plan.get("units", []), usage_dict(resp), trace


def _plan_for_author(units: list[dict]) -> str:
    lines = []
    for u in units:
        lines.append(f"Unit {u['id']} ({u['type']}), anchor: {u.get('anchor','')}")
        for i, m in enumerate(u.get("members", [])):
            lines.append(f"  member {i}: {m.get('source_text','')}")
    return "\n".join(lines)


def run_author(client, section_data: dict, units: list[dict], sections: list[dict], model: str):
    """Phase 2 — author the cloze stem for each member. Returns (cards, usage)."""
    system = build_phase_system(sections, "author")
    heading = section_data.get("heading", "")
    user = (
        f"Section: {heading}\n\n"
        "Here is the approved plan. Write ONE cloze card stem per member listed, via "
        "submit_cards, referencing unit_id and member_index. For sibling-set members, "
        "the stem must contain ONLY that member (the footer of other members is added "
        "separately — do not put other members in the stem). Apply the cloze, styling, "
        "rewording, and language rules.\n\n"
        f"PLAN:\n{_plan_for_author(units)}\n\n"
        f"Full source (for wording reference):\n{_section_source(section_data)}"
    )
    resp = client.messages.create(
        model=anthropic_model(model),
        max_tokens=8192,
        temperature=0,
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        tools=[AUTHOR_TOOL],
        tool_choice={"type": "tool", "name": "submit_cards"},
        messages=[{"role": "user", "content": user}],
    )
    out = tool_use_input(resp, "submit_cards")
    trace = {"phase": "author", "system": system, "user": user, "output": out.get("cards", [])}
    return out.get("cards", []), usage_dict(resp), trace


def _normalize_cloze(front: str) -> tuple[str, bool]:
    """Force all cloze indices to c1; flag needs_review if no cloze survives."""
    normalized = re.sub(r"\{\{c\d+::", "{{c1::", front or "")
    has_cloze = bool(re.search(r"\{\{c1::", normalized))
    return normalized, (not has_cloze)


def _build_footer(unit: dict, member_index: int) -> str:
    """Deterministic sibling footer: the OTHER members' verbatim source text under
    the plan's footer label. Guarantees completeness (no reliance on the model's
    memory) — the exact failure the single-shot flow had."""
    members = unit.get("members", [])
    others = [m.get("source_text", "").strip() for i, m in enumerate(members) if i != member_index]
    others = [o for o in others if o]
    if not others:
        return ""
    label = (unit.get("footer_label") or "").strip() or "Other items:"
    if not label.endswith(":"):
        label += ":"
    items = "".join(f"<br>• {o}" for o in others)
    return f"<b>{label}</b>{items}"


def assemble(units: list[dict], authored: list[dict]) -> list[dict]:
    """Phase 3 (code) — merge plan + authored stems into final card dicts.
    standalone -> blank extra; sibling_set -> deterministic footer from the plan."""
    unit_by_id = {u["id"]: u for u in units}
    # index authored by (unit_id, member_index)
    front_by_key = {}
    for a in authored:
        front_by_key[(a.get("unit_id"), a.get("member_index"))] = a.get("front", "")

    cards: list[dict] = []
    number = 0
    for u in units:
        uid = u["id"]
        is_sibling = u.get("type") == "sibling_set"
        for i, _member in enumerate(u.get("members", [])):
            front = front_by_key.get((uid, i))
            if not front:
                continue  # author skipped this member
            number += 1
            # Deterministic cleanup: sibling stems must not carry a footer; units
            # of measurement leave the cloze; markdown ** -> HTML <b>; cloze -> c1.
            if is_sibling:
                front = _strip_trailing_footer(front)
            front = _units_out(front)
            front = fix_markdown_bold(front)
            front_html, needs_review = _normalize_cloze(front)
            extra = _build_footer(u, i) if is_sibling else None
            cards.append({
                "card_number": number,
                "front_html": front_html,
                "front_text": strip_card_html(front_html),
                "extra": extra,
                "source_ref": None,
                "needs_review": needs_review,
            })
    return cards


def generate_sbs(section_data: dict, sections: list[dict], model: str = DEFAULT_MODEL):
    """Run the full 3-phase pipeline.
    Returns (cards, plan, usage_total, traces) where traces is a per-phase list of
    {phase, system/input, output} for the downloadable audit report."""
    client = _client()
    units, u1, t1 = run_segment(client, section_data, sections, model)
    authored, u2, t2 = run_author(client, section_data, units, sections, model)
    cards = assemble(units, authored)
    t3 = {
        "phase": "assemble",
        "input": {"plan_units": units, "authored_cards": authored},
        "output": cards,
        "note": "Deterministic code step: builds sibling footers from the plan, "
                "sets blank Column 3 for standalones, normalizes cloze index to c1.",
    }
    total = {k: (u1.get(k, 0) + u2.get(k, 0)) for k in set(u1) | set(u2)}
    return cards, units, total, [t1, t2, t3]


def build_report_md(section_heading: str, model: str, traces: list[dict], cards: list[dict]) -> str:
    """A self-contained Markdown audit of the run: for each step, the prompt/input
    it received and the output it produced — so it can be handed to an AI to review
    'why did it go wrong here'."""
    import json

    def fence(obj, lang="json"):
        if isinstance(obj, str):
            return f"```\n{obj}\n```"
        return f"```{lang}\n{json.dumps(obj, indent=2, ensure_ascii=False)}\n```"

    out = [f"# Step-by-Step card generation audit — {section_heading}", ""]
    out.append(f"- Model: `{model}`")
    out.append(f"- Final cards produced: {len(cards)}")
    out.append("")
    out.append("This file records every step: the exact prompt/input each step "
               "received and the output it returned. Hand it to an AI and ask it to "
               "check where the logic went wrong.")
    out.append("")

    titles = {"segment": "Step 1 — SEGMENT (AI): decide units, standalone vs sibling",
              "author": "Step 2 — AUTHOR (AI): write the cloze stem per member",
              "assemble": "Step 3 — ASSEMBLE (code): footers, blank Col 3, c1 normalize"}
    for t in traces:
        phase = t.get("phase", "?")
        out.append(f"## {titles.get(phase, phase)}")
        out.append("")
        if "system" in t:
            out.append("### Prompt (system — rules for this step)")
            out.append(fence(t["system"]))
            out.append("")
            out.append("### Input (user — section source + task)")
            out.append(fence(t.get("user", "")))
            out.append("")
        if "input" in t:
            out.append("### Input")
            out.append(fence(t["input"]))
            out.append("")
        if t.get("note"):
            out.append(f"> {t['note']}")
            out.append("")
        out.append("### Output")
        out.append(fence(t.get("output", "")))
        out.append("")

    out.append("## Final cards (as stored)")
    out.append("")
    for c in cards:
        out.append(f"**Card {c.get('card_number')}**")
        out.append(f"- front: `{c.get('front_html','')}`")
        out.append(f"- extra: `{c.get('extra') or ''}`")
        out.append("")
    return "\n".join(out)
