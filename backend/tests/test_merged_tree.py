from backend.services.curriculum_aligner import align, build_merged_tree
from backend.services.doc_processor import parse_heading_outline

MAIN = {"id": 1, "parent_id": None, "name": "EM", "level": 0, "path": "EM"}
NODES = [MAIN,
    {"id": 2, "parent_id": 1, "name": "Cardiovascular", "level": 1, "path": "EM > Cardiovascular"},
    {"id": 3, "parent_id": 2, "name": "Arrhythmias", "level": 2, "path": "EM > Cardiovascular > Arrhythmias"},
    {"id": 4, "parent_id": 3, "name": "Atrial", "level": 3, "path": "EM > Cardiovascular > Arrhythmias > Atrial"}]

def _outline():
    return parse_heading_outline([
        {"type": "heading", "level": 1, "text": "Cardiovascular — 18%"},
        {"type": "heading", "level": 2, "text": "Arrhythmias"},
        {"type": "heading", "level": 3, "text": "Atrial"},
        {"type": "heading", "level": 3, "text": "Ventricular"},
    ])

def test_merged_tree_statuses_and_graft():
    r = align(_outline(), MAIN, NODES)
    root = build_merged_tree(_outline(), MAIN, NODES, r)
    assert root["status"] == "matched" and root["node_id"] == 1 and root["depth"] == 0
    cardio = root["children"][0]
    assert cardio["name"] == "Cardiovascular" and cardio["status"] == "matched" and cardio["depth"] == 1
    arr = cardio["children"][0]
    assert arr["name"] == "Arrhythmias"
    names = [(c["name"], c["status"]) for c in arr["children"]]
    assert ("Atrial", "matched") in names
    assert ("Ventricular", "new") in names
    vent = [c for c in arr["children"] if c["name"] == "Ventricular"][0]
    assert vent["hid"] is not None and vent["node_id"] is None and vent["depth"] == 3

def test_merged_tree_missing_node():
    outline = parse_heading_outline([
        {"type": "heading", "level": 1, "text": "Cardiovascular"},
        {"type": "heading", "level": 2, "text": "Arrhythmias"}])
    r = align(outline, MAIN, NODES)
    root = build_merged_tree(outline, MAIN, NODES, r)
    arr = root["children"][0]["children"][0]
    atrial = [c for c in arr["children"] if c["name"] == "Atrial"][0]
    assert atrial["status"] == "missing"
