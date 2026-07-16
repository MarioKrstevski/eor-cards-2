from __future__ import annotations

# Self-test for docx_check.check_docx.
#
# Constructs a minimal .docx in memory exhibiting three cases:
#   (a) A normal list bullet — no soft break.
#   (b) A list bullet that CONTAINS a <w:br/> soft break (correct; stays in one <w:p>).
#   (c) A list bullet followed by a SEPARATE non-numbered paragraph that is indented
#       (the split-bullet problem).
#
# Expected:
#   - (a) appears in list_items with has_soft_break=False.
#   - (b) appears in list_items with has_soft_break=True.
#   - (c) the follow-on paragraph appears in split_candidates.
#   - raw_xml contains entries for both the split_candidate and the soft-break paragraph.
#
# Run with:
#   PYTHONPATH=. .venv/bin/python backend/services/_test_docx_check.py

import io
import json
import zipfile

from lxml import etree

from backend.services.docx_check import check_docx

# ---------------------------------------------------------------------------
# Minimal OOXML builder helpers
# ---------------------------------------------------------------------------
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = f"{{{W_NS}}}"

NSMAP = {"w": W_NS}


def _el(tag: str, attrib: dict | None = None, text: str | None = None) -> etree._Element:
    e = etree.Element(f"{W}{tag}", nsmap=NSMAP)
    if attrib:
        for k, v in attrib.items():
            e.set(f"{W}{k}", v)
    if text is not None:
        e.text = text
    return e


def _sub(parent: etree._Element, tag: str, attrib: dict | None = None, text: str | None = None) -> etree._Element:
    e = _el(tag, attrib, text)
    parent.append(e)
    return e


def make_num_pr(num_id: str = "1", ilvl: str = "0") -> etree._Element:
    """Direct <w:numPr> block to inject into a <w:pPr>."""
    np = _el("numPr")
    _sub(np, "ilvl", {"val": ilvl})
    _sub(np, "numId", {"val": num_id})
    return np


def make_list_para(text: str, indent: int = 360, include_soft_break: bool = False) -> etree._Element:
    """Build a <w:p> with direct numPr (list item).

    If include_soft_break=True, the text is split by the string '\\n' and a
    <w:br/> (no type attr → soft/line break) is inserted between the runs.
    """
    p = _el("p")
    pPr = _sub(p, "pPr")
    ind = _sub(pPr, "ind", {"left": str(indent)})  # noqa: F841
    np = make_num_pr()
    pPr.append(np)

    if include_soft_break:
        parts = text.split("\\n", 1)
        # first run
        r1 = _sub(p, "r")
        _sub(r1, "t", text=parts[0])
        # soft break
        br = _sub(p, "r")
        _sub(br, "br")  # no type attribute → textWrapping / line break
        # second run
        if len(parts) > 1:
            r2 = _sub(p, "r")
            _sub(r2, "t", text=parts[1])
    else:
        r = _sub(p, "r")
        t = _sub(r, "t", text=text)

    return p


def make_plain_para(text: str, indent: int | None = None, style: str | None = None) -> etree._Element:
    """Build a <w:p> with NO numPr (plain paragraph)."""
    p = _el("p")
    pPr = _sub(p, "pPr")
    if style:
        _sub(pPr, "pStyle", {"val": style})
    if indent is not None:
        _sub(pPr, "ind", {"left": str(indent)})
    r = _sub(p, "r")
    _sub(r, "t", text=text)
    return p


def build_docx(body_paragraphs: list[etree._Element]) -> bytes:
    """Wrap paragraphs in a minimal document.xml and zip into a .docx bytes object."""
    doc = _el("document")
    body = _sub(doc, "body")
    for p in body_paragraphs:
        body.append(p)
    # sectPr is required by spec
    _sub(body, "sectPr")

    doc_xml = etree.tostring(doc, xml_declaration=True, encoding="UTF-8", standalone=True)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("word/document.xml", doc_xml)
        # Minimal [Content_Types].xml required for the zip to be a valid docx container
        content_types = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '</Types>'
        )
        zf.writestr("[Content_Types].xml", content_types)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Build the test document
# ---------------------------------------------------------------------------
paragraphs = [
    # (a) Normal bullet — no soft break
    make_list_para("Bullet A: normal list item with no soft break"),
    # (b) Bullet with a soft break inside (correct — stays one <w:p>)
    make_list_para("Bullet B: first line\\nstill Bullet B: second line (soft break inside)", include_soft_break=True),
    # (c) Bullet followed by a SEPARATE non-numbered indented paragraph (the broken split)
    make_list_para("Bullet C: list item that was originally followed by a soft break"),
    make_plain_para("Orphaned continuation of Bullet C (wrong paragraph break)", indent=360),
    # An unrelated plain paragraph (no indent, not after a list item in sequence) — should NOT be flagged
    make_list_para("Bullet D: another list item"),
    make_plain_para("Regular paragraph with no indent — not a split candidate"),
]

docx_bytes = build_docx(paragraphs)

# ---------------------------------------------------------------------------
# Run the check
# ---------------------------------------------------------------------------
report = check_docx(docx_bytes)

print("=" * 70)
print("REPORT SUMMARY")
print("=" * 70)
print(json.dumps(report["summary"], indent=2))

print("\n" + "=" * 70)
print("LIST ITEMS")
print("=" * 70)
for item in report["list_items"]:
    print(json.dumps(item, indent=2))

print("\n" + "=" * 70)
print("SPLIT CANDIDATES (flagged problems)")
print("=" * 70)
if report["split_candidates"]:
    for c in report["split_candidates"]:
        print(json.dumps(c, indent=2))
else:
    print("(none)")

print("\n" + "=" * 70)
print(f"RAW XML SNIPPETS ({len(report['raw_xml'])} entries)")
print("=" * 70)
for entry in report["raw_xml"]:
    print(f"\n--- index={entry['index']} kind={entry['kind']} ---")
    print(entry["xml"][:600], "..." if len(entry["xml"]) > 600 else "")

print("\n" + "=" * 70)
print("NOTES")
print("=" * 70)
for note in report["notes"]:
    print(f"• {note}")

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------
print("\n" + "=" * 70)
print("ASSERTIONS")
print("=" * 70)

list_items = report["list_items"]
assert len(list_items) >= 3, f"Expected >=3 list items, got {len(list_items)}"

# (a) Bullet A — no soft break
bullet_a = next((i for i in list_items if "Bullet A" in i["text"]), None)
assert bullet_a is not None, "Bullet A not found in list_items"
assert not bullet_a["has_soft_break"], f"Bullet A should NOT have soft break, got {bullet_a}"
print(f"PASS  Bullet A in list_items, has_soft_break=False")

# (b) Bullet B — has soft break
bullet_b = next((i for i in list_items if "Bullet B" in i["text"]), None)
assert bullet_b is not None, "Bullet B not found in list_items"
assert bullet_b["has_soft_break"], f"Bullet B SHOULD have soft break, got {bullet_b}"
assert bullet_b["soft_break_count"] == 1, f"Bullet B should have 1 soft break, got {bullet_b['soft_break_count']}"
print(f"PASS  Bullet B in list_items, has_soft_break=True, soft_break_count=1")

# (c) Orphaned continuation paragraph in split_candidates
split_candidates = report["split_candidates"]
orphan = next((c for c in split_candidates if "Orphaned" in c["text"]), None)
assert orphan is not None, f"Orphaned continuation paragraph not found in split_candidates: {split_candidates}"
assert "Bullet C" in orphan["prev_bullet_text"], f"prev_bullet_text should mention Bullet C: {orphan}"
print(f"PASS  Orphaned paragraph in split_candidates, prev_bullet='{orphan['prev_bullet_text'][:40]}...'")

# raw_xml must include both kinds
raw_kinds = {e["kind"] for e in report["raw_xml"]}
assert "split_candidate" in raw_kinds, "raw_xml missing split_candidate entry"
assert "has_soft_break" in raw_kinds, "raw_xml missing has_soft_break entry"
print(f"PASS  raw_xml contains both 'split_candidate' and 'has_soft_break' entries")

# The regular un-indented paragraph after Bullet D should NOT be a split candidate
not_flagged = [c for c in split_candidates if "Regular paragraph" in c["text"]]
assert not not_flagged, f"Regular paragraph should NOT be a split candidate: {not_flagged}"
print(f"PASS  Un-indented paragraph after Bullet D not flagged as split_candidate")

print("\nAll assertions passed.")
