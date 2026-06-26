from backend.services.doc_processor import attach_content_to_curriculum

def _h(level, text): return {"type": "heading", "level": level, "text": text}
def _p(text): return {"type": "paragraph", "text": text}

RES = {0: 2, 1: 3, 2: None, 3: 4}
MAIN_ID = 1

ELEMENTS = [
    _h(1, "Infectious Disease"),      # hid 0 -> node 2 (matched: title, skip)
    _h(2, "Parasitic Infections"),    # hid 1 -> node 3 (matched: title, skip)
    _h(3, "Giardiasis/GI Parasites"), # hid 2 -> None (unmatched: keep, rolls to 3)
    _p("Amebiasis is..."),
    _p("Giardiasis is..."),
    _h(3, "Toxoplasmosis"),           # hid 3 -> node 4 (matched: title, skip)
    _p("Toxo is..."),
]

def test_attach_rollup_and_leaf():
    groups = {g["node_id"]: g for g in attach_content_to_curriculum(ELEMENTS, RES, MAIN_ID)}
    texts_3 = [e["text"] for e in groups[3]["elements"] if e["type"] == "paragraph"]
    assert texts_3 == ["Amebiasis is...", "Giardiasis is..."]
    texts_4 = [e["text"] for e in groups[4]["elements"] if e["type"] == "paragraph"]
    assert texts_4 == ["Toxo is..."]

def test_attach_preamble_goes_to_main_topic():
    groups = {g["node_id"]: g for g in attach_content_to_curriculum(
        [_p("intro before any heading")], {}, MAIN_ID)}
    assert groups[MAIN_ID]["elements"][0]["text"] == "intro before any heading"

def test_attach_preserves_document_order_within_group():
    els = [_h(2, "Parasitic Infections"), _p("a"), _h(3, "Toxoplasmosis"), _p("t"), _p("b")]
    res = {0: 3, 1: 4}
    groups = {g["node_id"]: g for g in attach_content_to_curriculum(els, res, MAIN_ID)}
    assert [e["text"] for e in groups[3]["elements"] if e["type"] == "paragraph"] == ["a"]
    assert [e["text"] for e in groups[4]["elements"] if e["type"] == "paragraph"] == ["t", "b"]

def test_attach_matched_heading_is_title_not_body():
    groups = {g["node_id"]: g for g in attach_content_to_curriculum(ELEMENTS, RES, MAIN_ID)}
    assert all(e["type"] != "heading" for e in groups[4]["elements"])
    assert "Toxoplasmosis" not in [e["text"] for e in groups[4]["elements"]]
    node3_headings = [e["text"] for e in groups[3]["elements"] if e["type"] == "heading"]
    assert node3_headings == ["Giardiasis/GI Parasites"]
    assert 2 not in groups
