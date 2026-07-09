"""Generate & Verify: the code stages (merge, deterministic checks, report). The
AI stages (generate/verify/fix/reverify) are not called here."""
from backend.services.verify_generator import (
    merge_deck, deterministic_checks, build_verify_report_md,
)


def _card(i, front, extra=None):
    return {"id": i, "card_number": i, "front_html": front, "front_text": front,
            "extra": extra}


def test_merge_keeps_passed_verbatim_and_applies_combine():
    original = [_card(1, "a"), _card(2, "b"), _card(3, "c"), _card(4, "d")]
    # combine 3 + 4 -> one new card
    fixes = [{"replaces_card_ids": [3, 4], "cards": [{"front": "merged {{c1::x}}", "extra": "ctx"}]}]
    final, before_after = merge_deck(original, fixes)
    # 1 and 2 kept verbatim, 3 & 4 gone, one merged card added
    fronts = [c["front_html"] for c in final]
    assert "a" in fronts and "b" in fronts and "c" not in fronts and "d" not in fronts
    merged = [c for c in final if c.get("derived_from")]
    assert len(merged) == 1 and merged[0]["derived_from"] == [3, 4]
    assert merged[0]["extra"] == "ctx"
    # renumbered 1..N
    assert [c["card_number"] for c in final] == [1, 2, 3]
    assert before_after == [{"from": [3, 4], "count": 1}]


def test_merge_split_one_into_two():
    original = [_card(1, "a"), _card(2, "b")]
    fixes = [{"replaces_card_ids": [2], "cards": [{"front": "{{c1::x}}"}, {"front": "{{c1::y}}"}]}]
    final, _ = merge_deck(original, fixes)
    assert len(final) == 3  # 1 kept + 2 split into 2
    assert sum(1 for c in final if c.get("derived_from") == [2]) == 2


def test_merge_normalizes_markdown_and_cloze_index():
    original = [_card(1, "a")]
    fixes = [{"replaces_card_ids": [1], "cards": [{"front": "**bold** {{c3::term}}"}]}]
    final, _ = merge_deck(original, fixes)
    fh = final[0]["front_html"]
    assert "<b>bold</b>" in fh and "**" not in fh
    assert "{{c1::term}}" in fh and "{{c3" not in fh


def test_deterministic_checks_catch_mechanical_issues():
    cards = [
        {"card_number": 1, "front_html": 'ok <span style="color:#1f77b4"><b>{{c1::x}}</b></span>'},
        {"card_number": 2, "front_html": "**still markdown** {{c1::y}}"},
        {"card_number": 3, "front_html": 'range <span style="color:#1f77b4"><b>{{c1::14 weeks}}</b></span>'},
        {"card_number": 4, "front_html": "no cloze here"},
        {"card_number": 5, "front_html": '<span style="color:#ff0000"><b>{{c1::z}}</b></span>'},
    ]
    res = {r["card_number"]: r["issues"] for r in deterministic_checks(cards)}
    assert 1 not in res  # clean card, no issues
    assert any("markdown" in i for i in res[2])
    assert any("unit" in i for i in res[3])
    assert any("no cloze" in i for i in res[4])
    assert any("color" in i for i in res[5])


def test_report_has_all_stages():
    trace = [
        {"stage": "generate", "output": [{"id": 1}]},
        {"stage": "verify", "system": "RULES", "user": "CARDS", "output": {"violations": []}},
        {"stage": "fix", "system": "R", "user": "F", "output": {"fixes": []},
         "before_after": [{"from": [3, 4], "count": 1}]},
        {"stage": "reverify", "system": "R", "user": "D", "output": {"all_pass": True}},
        {"stage": "deterministic", "output": []},
    ]
    final = [{"card_number": 1, "front_html": "f", "extra": None, "derived_from": [3, 4]}]
    md = build_verify_report_md("Abortion", "claude-sonnet-4-6", trace, final)
    for s in ["Stage 1", "Stage 2", "Stage 3", "Stage 4", "Stage 5", "Before → after", "Final deck", "(from [3, 4])"]:
        assert s in md, s
