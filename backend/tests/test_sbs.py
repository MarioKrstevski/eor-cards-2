"""Step-by-Step generation: prompt splitting, phase routing, deterministic
assembly/footers, and the audit report. AI phases are not called here."""
import os

from backend.services.sbs_generator import (
    split_prompt_into_sections, build_phase_system, assemble, build_report_md,
    DEFAULT_PHASE_MAP,
)

SEED = os.path.join(os.path.dirname(__file__), "..", "..", "seed", "sbs-default-prompt.txt")


def test_split_assigns_every_section_a_phase():
    txt = open(SEED).read()
    secs = split_prompt_into_sections(txt)
    assert len(secs) == 1 + len(DEFAULT_PHASE_MAP)  # preamble + each header
    assert secs[0]["heading"] == "Preamble" and secs[0]["phase"] == "shared"
    assert all(s["phase"] in ("segment", "author", "shared") for s in secs)
    # verbatim: each header's text starts with the header
    for s in secs[1:]:
        assert s["text"].startswith(s["heading"])


def test_phase_system_is_focused():
    secs = split_prompt_into_sections(open(SEED).read())
    seg = build_phase_system(secs, "segment")
    auth = build_phase_system(secs, "author")
    # segmentation-only rule stays out of the author phase, and vice versa
    assert "SEQUENTIAL/DIAGNOSTIC" in seg and "SEQUENTIAL/DIAGNOSTIC" not in auth
    assert "CLOZE STYLING" in auth and "CLOZE STYLING" not in seg
    # shared content appears in both
    assert "card generation engine" in seg and "card generation engine" in auth


def test_assemble_standalone_blank_and_c1():
    units = [{"id": 1, "type": "standalone", "anchor": "X",
              "members": [{"source_text": "fact"}]}]
    authored = [{"unit_id": 1, "member_index": 0, "front": "A {{c3::term}} here."}]
    cards = assemble(units, authored)
    assert len(cards) == 1
    assert cards[0]["extra"] is None            # standalone -> blank Col 3
    assert "{{c1::term}}" in cards[0]["front_html"]  # normalized c3 -> c1


def test_assemble_sibling_footer_from_plan():
    units = [{"id": 2, "type": "sibling_set", "anchor": "Mgmt",
              "footer_label": "Other management options",
              "members": [{"source_text": "Expectant"}, {"source_text": "Medical"},
                          {"source_text": "Surgical"}]}]
    authored = [{"unit_id": 2, "member_index": i, "front": f"card {{{{c1::x{i}}}}}"} for i in range(3)]
    cards = assemble(units, authored)
    assert len(cards) == 3
    # each footer contains the OTHER two members, not itself
    assert "Medical" in cards[0]["extra"] and "Surgical" in cards[0]["extra"] and "Expectant" not in cards[0]["extra"]
    assert cards[1]["extra"].startswith("<b>Other management options:</b>")


def test_assemble_skips_unauthored_members():
    units = [{"id": 1, "type": "sibling_set", "footer_label": "Other",
              "members": [{"source_text": "a"}, {"source_text": "b"}]}]
    authored = [{"unit_id": 1, "member_index": 0, "front": "only {{c1::a}}"}]  # member 1 missing
    cards = assemble(units, authored)
    assert len(cards) == 1  # skipped the unauthored one, no crash


def test_report_contains_prompt_input_output_per_step():
    traces = [
        {"phase": "segment", "system": "SEG RULES", "user": "SECTION SRC", "output": [{"id": 1}]},
        {"phase": "author", "system": "AUTH RULES", "user": "PLAN", "output": [{"unit_id": 1}]},
        {"phase": "assemble", "input": {"x": 1}, "output": [{"card_number": 1}], "note": "code"},
    ]
    cards = [{"card_number": 1, "front_html": "f", "extra": None}]
    md = build_report_md("Abortion", "claude-sonnet-4-6", traces, cards)
    assert "SEG RULES" in md and "SECTION SRC" in md      # step 1 prompt + input
    assert "AUTH RULES" in md and "PLAN" in md            # step 2 prompt + input
    assert "Step 1" in md and "Step 2" in md and "Step 3" in md
    assert "Final cards" in md
