"""
_test_docx_check.py — Self-contained smoke test for docx_check.check_docx().

Builds a minimal but non-trivial .docx in-memory (no Word required) and asserts
the return shape and key detector output.

Run:
    cd /path/to/v4 && PYTHONPATH=. .venv/bin/python backend/_test_docx_check.py
"""

from __future__ import annotations

import io
import zipfile

from lxml import etree

from backend.services.docx_check import check_docx

# ---------------------------------------------------------------------------
# Helpers to build a minimal .docx in memory
# ---------------------------------------------------------------------------

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W14 = "http://schemas.microsoft.com/office/word/2010/wordml"

CONTENT_TYPES = """\
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
"""

RELS = """\
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="word/document.xml"/>
</Relationships>
"""

WORD_RELS = """\
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>
"""


def _w(tag: str) -> str:
    return f"{{{W}}}{tag}"


def _para(
    text: str,
    style: str | None = None,
    is_list: bool = False,
    indent_left: int | None = None,
    soft_break: bool = False,
    bold_runs: bool = False,
    list_style_name: str | None = None,
) -> etree._Element:
    """Build a <w:p> element."""
    p = etree.Element(_w("p"))
    pPr = etree.SubElement(p, _w("pPr"))

    if style:
        ps = etree.SubElement(pPr, _w("pStyle"))
        ps.set(_w("val"), style)

    if is_list:
        numPr = etree.SubElement(pPr, _w("numPr"))
        ilvl = etree.SubElement(numPr, _w("ilvl"))
        ilvl.set(_w("val"), "0")
        numId = etree.SubElement(numPr, _w("numId"))
        numId.set(_w("val"), "1")

    if indent_left is not None:
        ind = etree.SubElement(pPr, _w("ind"))
        ind.set(_w("left"), str(indent_left))

    if list_style_name:
        # Add pStyle with "List" in the name (without direct numPr)
        ps2 = pPr.find(_w("pStyle"))
        if ps2 is None:
            ps2 = etree.SubElement(pPr, _w("pStyle"))
        ps2.set(_w("val"), list_style_name)

    r = etree.SubElement(p, _w("r"))
    if bold_runs:
        rPr = etree.SubElement(r, _w("rPr"))
        b = etree.SubElement(rPr, _w("b"))
        # No explicit val = bold is on
    t = etree.SubElement(r, _w("t"))
    t.text = text

    if soft_break:
        br = etree.SubElement(p, _w("br"))
        # no type attribute = textWrapping (soft break)

    return p


def _build_docx(paragraphs: list[etree._Element]) -> bytes:
    """Wrap the given <w:p> elements into a minimal .docx bytes blob."""
    doc = etree.Element(
        _w("document"),
        nsmap={"w": W},
    )
    body = etree.SubElement(doc, _w("body"))
    for p in paragraphs:
        body.append(p)

    doc_xml = etree.tostring(doc, xml_declaration=True, encoding="UTF-8", standalone=True)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", CONTENT_TYPES)
        zf.writestr("_rels/.rels", RELS)
        zf.writestr("word/_rels/document.xml.rels", WORD_RELS)
        zf.writestr("word/document.xml", doc_xml)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Build test document
# ---------------------------------------------------------------------------

def _build_test_doc() -> bytes:
    paras: list[etree._Element] = []

    # para 0: normal text
    paras.append(_para("Normal paragraph."))

    # para 1: list item (real list)
    paras.append(_para("First bullet point", is_list=True))

    # para 2: split candidate (non-list, indent>0, right after list)
    paras.append(_para("continuation of first bullet", indent_left=360))

    # para 3: list item with soft break
    p = _para("Bullet with soft break", is_list=True, soft_break=True)
    paras.append(p)

    # para 4: typed bullet (text, not real list)
    paras.append(_para("• This is a typed bullet item here"))

    # para 5: fake heading (all-bold, ≤60 chars, no sentence punctuation, not a Heading style)
    paras.append(_para("Important Concept Title", bold_runs=True))

    # para 6: heading H1
    paras.append(_para("Chapter One", style="Heading1"))

    # para 7: heading H3 — skips H2 (skipped_level)
    paras.append(_para("Sub-sub-section", style="Heading3"))

    # para 8: empty list item
    paras.append(_para("", is_list=True))

    # para 9: long paragraph (>400 chars)
    long_text = "A" * 450
    paras.append(_para(long_text))

    # para 10: weird chars — non-breaking space ( ) + zero-width space (​)
    paras.append(_para("Text with non-breaking space and​zero-width space"))

    # para 11: another normal paragraph
    paras.append(_para("Another normal paragraph at the end."))

    return _build_docx(paras)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_import() -> None:
    from backend.services import docx_check  # noqa: F401
    print("  import OK")


def test_basic_shape() -> None:
    doc = _build_test_doc()
    result = check_docx(doc)

    expected_keys = {
        "summary", "list_items", "soft_break_items", "split_candidates",
        "typed_bullets", "heading_issues", "empty_list_items",
        "long_paragraphs", "unparseable", "weird_chars", "raw_xml", "notes",
    }
    assert set(result.keys()) == expected_keys, f"Missing keys: {expected_keys - set(result.keys())}"

    summary = result["summary"]
    expected_summary_keys = {
        "total_paragraphs", "list_item_count", "with_soft_break_count",
        "split_candidate_count", "pages_estimated",
        "typed_bullet_count", "heading_issue_count", "empty_list_item_count",
        "long_paragraph_count", "weird_char_count", "unparseable",
    }
    assert set(summary.keys()) == expected_summary_keys, f"Missing summary keys: {expected_summary_keys - set(summary.keys())}"

    # unparseable in summary
    up_summary = summary["unparseable"]
    assert set(up_summary.keys()) == {"tables", "text_boxes", "drawings"}, f"Bad unparseable summary keys: {up_summary}"

    # top-level unparseable
    up = result["unparseable"]
    assert set(up.keys()) == {"tables", "text_boxes", "drawings"}, f"Bad unparseable keys: {up}"

    print("  basic_shape OK")


def test_paragraph_count() -> None:
    doc = _build_test_doc()
    result = check_docx(doc)
    # We built 12 paragraphs (indices 0-11)
    assert result["summary"]["total_paragraphs"] == 12, (
        f"Expected 12, got {result['summary']['total_paragraphs']}"
    )
    print("  paragraph_count OK")


def test_soft_break_items() -> None:
    doc = _build_test_doc()
    result = check_docx(doc)
    assert result["summary"]["with_soft_break_count"] == 1, (
        f"Expected 1 soft break paragraph, got {result['summary']['with_soft_break_count']}"
    )
    sb = result["soft_break_items"]
    assert len(sb) == 1
    assert sb[0]["text"] == "Bullet with soft break"
    assert sb[0]["soft_break_count"] == 1
    assert sb[0]["is_list"] is True
    assert "page" in sb[0]
    print("  soft_break_items OK")


def test_split_candidates() -> None:
    doc = _build_test_doc()
    result = check_docx(doc)
    sc = result["split_candidates"]
    assert len(sc) >= 1, f"Expected at least 1 split candidate, got {len(sc)}"
    # para 2 should be flagged
    texts = [c["text"] for c in sc]
    assert "continuation of first bullet" in texts, f"Expected split candidate not found; got: {texts}"
    assert "page" in sc[0]
    print("  split_candidates OK")


def test_typed_bullets() -> None:
    doc = _build_test_doc()
    result = check_docx(doc)
    tb = result["typed_bullets"]
    assert result["summary"]["typed_bullet_count"] == len(tb)
    assert len(tb) >= 1, f"Expected at least 1 typed bullet, got {len(tb)}"
    assert tb[0]["marker"] == "•"
    assert "page" in tb[0]
    assert "text" in tb[0]
    print("  typed_bullets OK")


def test_heading_issues() -> None:
    doc = _build_test_doc()
    result = check_docx(doc)
    hi = result["heading_issues"]
    assert result["summary"]["heading_issue_count"] == len(hi)

    kinds = [h["kind"] for h in hi]
    assert "fake_heading" in kinds, f"Expected fake_heading in {kinds}"
    assert "skipped_level" in kinds, f"Expected skipped_level in {kinds}"

    fh = [h for h in hi if h["kind"] == "fake_heading"]
    assert fh[0]["text"] == "Important Concept Title"
    assert "page" in fh[0]
    assert "detail" in fh[0]

    sl = [h for h in hi if h["kind"] == "skipped_level"]
    assert "Heading 3" in sl[0]["detail"] or "3" in sl[0]["detail"], f"Expected Heading 3 in detail: {sl[0]['detail']}"
    print("  heading_issues OK")


def test_empty_list_items() -> None:
    doc = _build_test_doc()
    result = check_docx(doc)
    eli = result["empty_list_items"]
    assert result["summary"]["empty_list_item_count"] == len(eli)
    assert len(eli) >= 1, f"Expected at least 1 empty list item, got {len(eli)}"
    assert "page" in eli[0]
    assert "index" in eli[0]
    print("  empty_list_items OK")


def test_long_paragraphs() -> None:
    doc = _build_test_doc()
    result = check_docx(doc)
    lp = result["long_paragraphs"]
    total = result["summary"]["long_paragraph_count"]
    assert total >= 1, f"Expected at least 1 long paragraph, got {total}"
    assert len(lp) >= 1
    assert lp[0]["char_count"] >= 400
    assert "page" in lp[0]
    assert "text" in lp[0]
    # sorted by char_count DESC
    if len(lp) > 1:
        assert lp[0]["char_count"] >= lp[1]["char_count"]
    print("  long_paragraphs OK")


def test_unparseable() -> None:
    doc = _build_test_doc()
    result = check_docx(doc)
    up = result["unparseable"]
    assert "tables" in up and "text_boxes" in up and "drawings" in up
    # Our minimal doc has none of these
    assert up["tables"] == 0
    assert up["text_boxes"] == 0
    assert up["drawings"] == 0
    # summary mirrors it
    assert result["summary"]["unparseable"] == up
    print("  unparseable OK")


def test_weird_chars() -> None:
    doc = _build_test_doc()
    result = check_docx(doc)
    wc = result["weird_chars"]
    total = result["summary"]["weird_char_count"]
    assert total >= 1, f"Expected at least 1 weird char paragraph, got {total}"
    assert len(wc) >= 1
    # Our para has non-breaking space + zero-width
    kinds_union = set()
    for item in wc:
        kinds_union.update(item["kinds"])
    assert "non-breaking space" in kinds_union, f"Expected non-breaking space in kinds: {kinds_union}"
    assert "zero-width" in kinds_union, f"Expected zero-width in kinds: {kinds_union}"
    assert "page" in wc[0]
    print("  weird_chars OK")


def test_notes() -> None:
    doc = _build_test_doc()
    result = check_docx(doc)
    notes = result["notes"]
    assert len(notes) >= 5, f"Expected at least 5 notes, got {len(notes)}"
    # Heuristic notes for new detectors exist
    notes_text = " ".join(notes)
    assert "typed_bullet" in notes_text.lower() or "typed" in notes_text.lower(), "Missing typed_bullets note"
    assert "fake_heading" in notes_text.lower() or "fake" in notes_text.lower(), "Missing fake_heading note"
    assert "weird_char" in notes_text.lower() or "weird" in notes_text.lower(), "Missing weird_chars note"
    print("  notes OK")


def test_invalid_file() -> None:
    try:
        check_docx(b"not a zip file")
        assert False, "Should have raised ValueError"
    except ValueError:
        pass
    print("  invalid_file OK")


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    tests = [
        test_import,
        test_basic_shape,
        test_paragraph_count,
        test_soft_break_items,
        test_split_candidates,
        test_typed_bullets,
        test_heading_issues,
        test_empty_list_items,
        test_long_paragraphs,
        test_unparseable,
        test_weird_chars,
        test_notes,
        test_invalid_file,
    ]
    failures = 0
    for fn in tests:
        name = fn.__name__
        try:
            print(f"[RUN] {name}")
            fn()
        except Exception as exc:
            print(f"  FAIL: {exc}")
            failures += 1

    print()
    if failures:
        print(f"FAILED: {failures}/{len(tests)} tests")
        raise SystemExit(1)
    else:
        print(f"All {len(tests)} tests passed.")
