from backend.services.doc_processor import is_title_junk

DOC = "Emergency Medicine EOR.New Blueprint FINAL.docx"
TOPIC = "Emergency Medicine"


def test_blueprint_banner_is_junk():
    assert is_title_junk("New PAEA Blueprint, Effective July 2026", DOC, TOPIC)


def test_effective_date_line_is_junk():
    assert is_title_junk("Emergency Medicine EOR — New Blueprint, Effective July 2026")


def test_doc_name_match_is_junk():
    assert is_title_junk("Emergency Medicine EOR.New Blueprint FINAL", DOC, TOPIC)


def test_topic_name_is_junk():
    assert is_title_junk("Emergency Medicine", DOC, TOPIC)


def test_title_fragment_contained_in_doc_name_is_junk():
    assert is_title_junk("Emergency Medicine EOR", DOC, TOPIC)


def test_real_content_is_not_junk():
    assert not is_title_junk("Migraine is a unilateral headache.", DOC, TOPIC)


def test_short_words_are_not_junk():
    # "RF" would be a substring of many titles but is too short to count
    assert not is_title_junk("RF", DOC, TOPIC)
    assert not is_title_junk("Medicine", DOC, TOPIC)


def test_prose_with_effective_but_no_year_is_not_junk():
    assert not is_title_junk("Beta blockers are effective in reducing mortality.")
