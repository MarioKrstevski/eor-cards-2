from backend.services.curriculum_aligner import expand_includes
from backend.services.doc_processor import parse_heading_outline

def test_expand_includes_pulls_ancestors_parents_first():
    outline = parse_heading_outline([
        {"type": "heading", "level": 1, "text": "H1"},   # hid 0
        {"type": "heading", "level": 2, "text": "H2"},   # hid 1
        {"type": "heading", "level": 3, "text": "H3"},   # hid 2
    ])
    assert expand_includes([2], outline) == [0, 1, 2]

def test_expand_includes_dedups_and_orders():
    outline = parse_heading_outline([
        {"type": "heading", "level": 1, "text": "A"},    # 0
        {"type": "heading", "level": 2, "text": "B"},    # 1
        {"type": "heading", "level": 2, "text": "C"},    # 2
    ])
    assert expand_includes([2, 1], outline) == [0, 1, 2]
