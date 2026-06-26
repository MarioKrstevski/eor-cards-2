from backend.services.curriculum_aligner import normalize_topic


def test_normalize_basic():
    assert normalize_topic("  Parasitic   Infections ") == "parasitic infections"
    assert normalize_topic("Giardiasis / GI Parasites") == "giardiasis/gi parasites"


def test_normalize_strips_exam_weight_suffix():
    assert normalize_topic("Cardiovascular – 18%") == "cardiovascular"   # en-dash
    assert normalize_topic("EENOT – 7%") == "eenot"
    assert normalize_topic("Pulmonary - 10%") == "pulmonary"             # hyphen


def test_normalize_em_dash_matches_en_dash():
    # Documents use an EM-dash ("— 18%"); curriculum uses an EN-dash ("– 18%").
    # Both must normalize equal or depth-1 bands never match.
    assert normalize_topic("CARDIOVASCULAR — 18%") == normalize_topic("Cardiovascular – 18%")
    assert normalize_topic("CARDIOVASCULAR — 18%") == "cardiovascular"


from backend.services.curriculum_aligner import align

MAIN = {"id": 1, "parent_id": None, "name": "Emergency Medicine", "level": 0, "path": "Emergency Medicine"}
NODES = [
    MAIN,
    {"id": 2, "parent_id": 1, "name": "Infectious Disease", "level": 1, "path": "Emergency Medicine > Infectious Disease"},
    {"id": 3, "parent_id": 2, "name": "Parasitic Infections", "level": 2, "path": "Emergency Medicine > Infectious Disease > Parasitic Infections"},
    {"id": 4, "parent_id": 3, "name": "Toxoplasmosis", "level": 3, "path": "Emergency Medicine > Infectious Disease > Parasitic Infections > Toxoplasmosis"},
]

def _outline():
    from backend.services.doc_processor import parse_heading_outline
    return parse_heading_outline([
        {"type": "heading", "level": 1, "text": "Infectious Disease"},
        {"type": "heading", "level": 2, "text": "Parasitic Infections"},
        {"type": "heading", "level": 3, "text": "Giardiasis/GI Parasites"},
        {"type": "heading", "level": 3, "text": "Toxoplasmosis"},
    ])

def test_align_resolution_deepest_match_and_rollup():
    r = align(_outline(), MAIN, NODES)
    res = r["resolution"]
    assert res[0] == 2
    assert res[1] == 3
    assert res[2] is None
    assert res[3] == 4

def test_align_missing_in_curriculum_points_at_parent():
    r = align(_outline(), MAIN, NODES)
    miss = {m["name"]: m for m in r["missing_in_curriculum"]}
    assert "Giardiasis/GI Parasites" in miss
    assert miss["Giardiasis/GI Parasites"]["parent_id"] == 3
    assert miss["Giardiasis/GI Parasites"]["depth"] == 3

def test_align_position_aware_same_name_other_branch_does_not_match():
    nodes = NODES + [
        {"id": 5, "parent_id": 1, "name": "Cardiology", "level": 1, "path": "Emergency Medicine > Cardiology"},
        {"id": 6, "parent_id": 5, "name": "Toxoplasmosis", "level": 2, "path": "Emergency Medicine > Cardiology > Toxoplasmosis"},
    ]
    r = align(_outline(), MAIN, nodes)
    assert r["resolution"][3] == 4

def test_align_levels_expected_vs_present():
    r = align(_outline(), MAIN, NODES)
    by_depth = {l["depth"]: l for l in r["levels"]}
    assert by_depth[1]["present"] == 1
    assert by_depth[3]["present"] == 2
    assert by_depth[3]["expected"] >= 1
