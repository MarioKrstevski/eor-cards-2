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


def test_fuzzy_matches_near_miss_and_reports_diff():
    main = {"id": 1, "parent_id": None, "name": "EM", "level": 0, "path": "EM"}
    nodes = [main,
        {"id": 2, "parent_id": 1, "name": "Atrial Fibrillation", "level": 1, "path": "EM > Atrial Fibrillation"}]
    from backend.services.doc_processor import parse_heading_outline
    outline = parse_heading_outline([{"type": "heading", "level": 1, "text": "Atrial Fibrillation (AFib)"}])
    r = align(outline, main, nodes)
    assert r["resolution"][0] == 2
    f = {x["hid"]: x for x in r["fuzzy"]}
    assert 0 in f and f[0]["node_id"] == 2
    assert f[0]["doc_name"] == "Atrial Fibrillation (AFib)"
    assert f[0]["curr_name"] == "Atrial Fibrillation"


def test_exact_beats_fuzzy_no_steal():
    main = {"id": 1, "parent_id": None, "name": "EM", "level": 0, "path": "EM"}
    nodes = [main,
        {"id": 2, "parent_id": 1, "name": "Atrial Fibrillation", "level": 1, "path": "EM > Atrial Fibrillation"},
        {"id": 3, "parent_id": 1, "name": "Atrial Flutter", "level": 1, "path": "EM > Atrial Flutter"}]
    from backend.services.doc_processor import parse_heading_outline
    outline = parse_heading_outline([
        {"type": "heading", "level": 1, "text": "Atrial Fibrilation"},
        {"type": "heading", "level": 1, "text": "Atrial Flutter"}])
    r = align(outline, main, nodes)
    assert r["resolution"][1] == 3
    assert r["resolution"][0] == 2
    assert not any(x["node_id"] == 3 for x in r["fuzzy"])


def test_ambiguous_fuzzy_stays_new():
    main = {"id": 1, "parent_id": None, "name": "EM", "level": 0, "path": "EM"}
    nodes = [main,
        {"id": 2, "parent_id": 1, "name": "Cardio A", "level": 1, "path": "EM > Cardio A"},
        {"id": 3, "parent_id": 1, "name": "Cardio B", "level": 1, "path": "EM > Cardio B"}]
    from backend.services.doc_processor import parse_heading_outline
    outline = parse_heading_outline([{"type": "heading", "level": 1, "text": "Cardio C"}])
    r = align(outline, main, nodes)
    assert r["resolution"][0] is None
