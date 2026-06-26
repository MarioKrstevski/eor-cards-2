from backend.services.doc_processor import parse_heading_outline


def _h(level, text):
    return {"type": "heading", "level": level, "text": text}


def test_outline_nests_and_assigns_hids():
    elements = [
        _h(1, "Infectious Disease"),
        _h(2, "Parasitic Infections"),
        _h(3, "Giardiasis/GI Parasites"),
        {"type": "paragraph", "text": "Amebiasis..."},
        _h(3, "Toxoplasmosis"),
        _h(1, "Cardiology"),
    ]
    outline = parse_heading_outline(elements)
    assert [n["text"] for n in outline] == ["Infectious Disease", "Cardiology"]
    inf = outline[0]
    assert inf["hid"] == 0 and inf["level"] == 1
    para = inf["children"][0]
    assert para["text"] == "Parasitic Infections" and para["level"] == 2 and para["hid"] == 1
    assert [c["text"] for c in para["children"]] == ["Giardiasis/GI Parasites", "Toxoplasmosis"]
    assert para["children"][0]["hid"] == 2
    assert para["children"][1]["hid"] == 3
    assert outline[1]["hid"] == 4


def test_outline_handles_skipped_levels():
    outline = parse_heading_outline([_h(2, "A"), _h(4, "deep")])
    assert outline[0]["text"] == "A"
    assert outline[0]["children"][0]["text"] == "deep"
    assert outline[0]["children"][0]["level"] == 4
