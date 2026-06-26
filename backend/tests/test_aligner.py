from backend.services.curriculum_aligner import normalize_topic


def test_normalize_basic():
    assert normalize_topic("  Parasitic   Infections ") == "parasitic infections"
    assert normalize_topic("Giardiasis / GI Parasites") == "giardiasis/gi parasites"


def test_normalize_strips_exam_weight_suffix():
    assert normalize_topic("Cardiovascular – 18%") == "cardiovascular"
    assert normalize_topic("EENOT – 7%") == "eenot"
    assert normalize_topic("Pulmonary - 10%") == "pulmonary"
