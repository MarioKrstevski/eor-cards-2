"""
docx_check.py — Diagnostic service for detecting soft-break / list-split problems
in Word (.docx) files exported from Google Docs.

Problem background
------------------
Google Docs exports bulleted lists. A reviewer may have used Shift+Enter (soft
line break, <w:br/>) to wrap a long bullet onto a second visual line inside the
*same* bullet paragraph.  On export that soft break is sometimes incorrectly
emitted as a *new <w:p>* with no numbering — splitting one bullet into two.

This service:
  • walks every <w:p> in document order via OOXML (zipfile + lxml)
  • identifies list paragraphs (direct <w:numPr>)
  • counts legitimate soft breaks inside list paragraphs
  • flags non-list paragraphs that immediately follow a list paragraph and look
    like a broken-off continuation (heuristic based on indent + style name)
  • returns raw XML snippets for inspection

Heuristic limitations (noted in the returned `notes` field):
  • "split_candidate" detection is heuristic: a non-list paragraph right after a
    list paragraph with a positive indent OR a 'List'-containing style name.
    False positives are possible (e.g. a legitimately indented sub-heading after
    a bullet).
  • Numbering inherited purely via paragraph *style* (num_from_style=True) is
    noted but NOT treated as a list item for split detection, because we cannot
    easily resolve the style → numbering chain without loading the full styles
    part.  Direct numPr is the primary signal.
  • Only body-level <w:p> elements are inspected (not table cells, text boxes,
    headers/footers).
"""

from __future__ import annotations

import io
import re
import zipfile
from typing import Any

from lxml import etree

# Word namespace
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _w(tag: str) -> str:
    return f"{{{W}}}{tag}"


def _attr(el: etree._Element, tag: str) -> str | None:
    return el.get(_w(tag))


# Regex: text bullets (typed, not real Word list formatting)
_TYPED_BULLET_RE = re.compile(r"^\s*([•·◦▪‣∙▸►\-\*]|\(?\d+[.)])\s+\S")


def _is_all_bold(el: etree._Element) -> bool:
    """Return True if every run in the paragraph that has non-whitespace text is bold.

    "Bold" means the run has <w:rPr><w:b/></w:rPr> (or <w:b w:val="true/1">)
    and the val is NOT explicitly "false" or "0".
    The paragraph must have at least one such run.
    """
    has_text_run = False
    for r in el.iter(_w("r")):
        # Does this run have any non-whitespace text?
        run_text = "".join(t.text or "" for t in r.iter(_w("t")))
        if not run_text.strip():
            continue
        has_text_run = True
        # Is it bold?
        rPr = r.find(_w("rPr"))
        b_el = rPr.find(_w("b")) if rPr is not None else None
        if b_el is None:
            return False
        val = b_el.get(_w("val"))
        if val in ("false", "0"):
            return False
    return has_text_run


_SENTENCE_END_RE = re.compile(r"[.;,]$")


def check_docx(data: bytes) -> dict[str, Any]:
    """
    Inspect a .docx file (raw bytes) for list soft-break problems and additional issues.

    Returns a dict with keys:
      summary, list_items, soft_break_items, split_candidates,
      typed_bullets, heading_issues, empty_list_items,
      long_paragraphs, unparseable, weird_chars, raw_xml, notes

    Raises ValueError on a non-docx or corrupt file.
    """
    # ── 1. Open the zip and parse document.xml ──────────────────────────────
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ValueError(f"Not a valid .docx (zip) file: {exc}") from exc

    try:
        with zf.open("word/document.xml") as fh:
            xml_bytes = fh.read()
    except KeyError as exc:
        raise ValueError("Not a valid .docx: word/document.xml not found") from exc

    try:
        root = etree.fromstring(xml_bytes)
    except etree.XMLSyntaxError as exc:
        raise ValueError(f"Malformed document.xml: {exc}") from exc

    # body is <w:body> direct child of <w:document>
    body = root.find(_w("body"))
    if body is None:
        raise ValueError("document.xml has no <w:body>")

    # ── 2. Collect paragraph info ─────────────────────────────────────────────
    # Best-effort page estimate: OOXML has no stored page numbers (Word paginates
    # at render time), but it does emit <w:lastRenderedPageBreak/> where the page
    # last broke, plus explicit <w:br w:type="page"/>. We count those in document
    # order to approximate a page number. If none are present (common for Google
    # Docs exports), the estimate stays at 1 and we flag it as unavailable.
    paragraphs: list[dict[str, Any]] = []
    current_page = 1
    saw_page_break = False
    for idx, child in enumerate(body):
        if child.tag != _w("p"):
            continue

        pPr = child.find(_w("pPr"))

        # --- is_list: direct numPr on the paragraph --------------------------
        num_pr = pPr.find(_w("numPr")) if pPr is not None else None
        is_list = num_pr is not None

        # --- num_from_style: best-effort detection ---------------------------
        # We flag this when the paragraph has a pStyle that contains "List"
        # but no direct numPr.  We cannot easily resolve style inheritance
        # without loading styles.xml, so this is approximate.
        style_val: str | None = None
        if pPr is not None:
            ps = pPr.find(_w("pStyle"))
            if ps is not None:
                style_val = _attr(ps, "val")
        num_from_style = (
            not is_list
            and style_val is not None
            and "list" in style_val.lower()
        )

        # --- text: concatenate all w:t ---------------------------------------
        texts = [t.text or "" for t in child.iter(_w("t"))]
        text = "".join(texts).strip()

        # --- indent_left (also accept w:start for newer OOXML) ---------------
        indent_left: int | None = None
        if pPr is not None:
            ind = pPr.find(_w("ind"))
            if ind is not None:
                raw = _attr(ind, "left") or _attr(ind, "start")
                if raw is not None:
                    try:
                        indent_left = int(raw)
                    except ValueError:
                        pass

        # --- soft_breaks: <w:br> that are line breaks (not page/column) ------
        # In the same walk, count page breaks (explicit <w:br type="page"> and
        # rendered <w:lastRenderedPageBreak/>) to advance the page estimate.
        soft_break_count = 0
        page_break_count = 0
        for br in child.iter(_w("br")):
            br_type = _attr(br, "type")
            if br_type in (None, "textWrapping"):
                soft_break_count += 1
            elif br_type == "page":
                page_break_count += 1
        page_break_count += sum(1 for _ in child.iter(_w("lastRenderedPageBreak")))

        # The paragraph starts on the current page; breaks inside it push the
        # following paragraphs onto later pages.
        page = current_page
        if page_break_count:
            current_page += page_break_count
            saw_page_break = True

        paragraphs.append(
            {
                "index": idx,  # position among ALL body children, not just <w:p>
                "is_list": is_list,
                "num_from_style": num_from_style,
                "text": text,
                "style": style_val,
                "indent_left": indent_left,
                "soft_breaks": soft_break_count,
                "page": page,
                "_el": child,  # keep reference for raw XML export (not serialised)
            }
        )

    # Re-index using a simpler counter that only counts <w:p> elements so the
    # index field is the paragraph's 0-based position among paragraphs (not
    # among all body children — tables etc. would shift the count).
    for p_idx, p in enumerate(paragraphs):
        p["index"] = p_idx

    total_paragraphs = len(paragraphs)

    # ── 3. Build list_items ───────────────────────────────────────────────────
    list_items = [
        {
            "index": p["index"],
            "text": p["text"],
            "has_soft_break": p["soft_breaks"] > 0,
            "soft_break_count": p["soft_breaks"],
        }
        for p in paragraphs
        if p["is_list"]
    ]

    # ── 3b. Build soft_break_items ────────────────────────────────────────────
    # Every paragraph (list OR non-list) that still contains a soft line break
    # (<w:br/>, Shift+Enter). This is the direct "find the soft breaks" list, as
    # opposed to split_candidates (which is a heuristic guess about bullets that
    # got broken onto a *new* paragraph on export).
    soft_break_items = [
        {
            "index": p["index"],
            "text": p["text"],
            "is_list": p["is_list"],
            "soft_break_count": p["soft_breaks"],
            "page": p["page"],
        }
        for p in paragraphs
        if p["soft_breaks"] > 0
    ]

    # ── 4. Build split_candidates ─────────────────────────────────────────────
    split_candidates = []
    for i, p in enumerate(paragraphs):
        if i == 0:
            continue
        prev = paragraphs[i - 1]
        if not prev["is_list"]:
            continue
        if p["is_list"]:
            continue  # normal next bullet
        if not p["text"]:
            continue  # blank paragraph — skip

        # Heuristic: looks like continuation if indented OR style contains "List"
        reasons = []
        if p["indent_left"] is not None and p["indent_left"] > 0:
            reasons.append(f"indent_left={p['indent_left']} (>0)")
        if p["style"] and "list" in p["style"].lower():
            reasons.append(f"style='{p['style']}' contains 'List'")

        if reasons:
            split_candidates.append(
                {
                    "index": p["index"],
                    "text": p["text"],
                    "style": p["style"],
                    "indent_left": p["indent_left"],
                    "prev_index": prev["index"],
                    "prev_bullet_text": prev["text"],
                    "reason": "; ".join(reasons),
                    "page": p["page"],
                }
            )

    # ── NEW DETECTOR 1: typed_bullets ─────────────────────────────────────────
    # Bullets typed as text instead of real Word list formatting.
    typed_bullets = []
    for p in paragraphs:
        if p["is_list"]:
            continue
        if not p["text"]:
            continue
        m = _TYPED_BULLET_RE.match(p["text"])
        if m:
            typed_bullets.append(
                {
                    "index": p["index"],
                    "text": p["text"],
                    "page": p["page"],
                    "marker": m.group(1),
                }
            )

    # ── NEW DETECTOR 2: heading_issues ────────────────────────────────────────
    # Two kinds: fake_heading (all-bold non-heading) and skipped_level.
    heading_issues = []

    # 2a. fake_heading
    for p in paragraphs:
        style = p["style"] or ""
        is_heading_style = style.lower().startswith("heading") or style.lower().startswith("title")
        if is_heading_style:
            continue
        text = p["text"]
        if not text:
            continue
        if len(text) > 60:
            continue
        if _SENTENCE_END_RE.search(text):
            continue
        if _is_all_bold(p["_el"]):
            heading_issues.append(
                {
                    "index": p["index"],
                    "text": text,
                    "page": p["page"],
                    "kind": "fake_heading",
                    "detail": "bold text used as a heading but not styled Heading 1-4",
                }
            )

    # 2b. skipped_level — walk headings in document order
    prev_level: int | None = None
    for p in paragraphs:
        style = p["style"] or ""
        level: int | None = None
        if style.lower().startswith("title"):
            level = 0
        elif style.lower().startswith("heading"):
            # Extract trailing digit, e.g. "Heading1" or "Heading 1"
            m = re.search(r"(\d+)$", style)
            if m:
                level = int(m.group(1))
        if level is None:
            continue
        if prev_level is not None and level > prev_level + 1:
            heading_issues.append(
                {
                    "index": p["index"],
                    "text": p["text"],
                    "page": p["page"],
                    "kind": "skipped_level",
                    "detail": f"jumps from Heading {prev_level} to Heading {level}",
                }
            )
        prev_level = level

    # ── NEW DETECTOR 3: empty_list_items ─────────────────────────────────────
    empty_list_items = [
        {
            "index": p["index"],
            "page": p["page"],
        }
        for p in paragraphs
        if p["is_list"] and not p["text"].strip()
    ]

    # ── NEW DETECTOR 4: long_paragraphs ──────────────────────────────────────
    LONG_PARA_THRESHOLD = 400
    long_para_all = [
        {
            "index": p["index"],
            "text": p["text"],
            "char_count": len(p["text"]),
            "page": p["page"],
        }
        for p in paragraphs
        if len(p["text"]) > LONG_PARA_THRESHOLD
    ]
    long_para_total = len(long_para_all)
    long_paragraphs = sorted(long_para_all, key=lambda x: x["char_count"], reverse=True)[:50]

    # ── NEW DETECTOR 5: unparseable ───────────────────────────────────────────
    # Count tables, text boxes, drawings using local-name iteration (namespace-agnostic).
    tables_count = sum(1 for el in root.iter() if etree.QName(el.tag).localname == "tbl")
    text_boxes_count = sum(1 for el in root.iter() if etree.QName(el.tag).localname == "txbxContent")
    drawings_count = sum(1 for el in root.iter() if etree.QName(el.tag).localname == "drawing")
    unparseable = {
        "tables": tables_count,
        "text_boxes": text_boxes_count,
        "drawings": drawings_count,
    }

    # ── NEW DETECTOR 6: weird_chars ───────────────────────────────────────────
    _ZERO_WIDTH = {"​", "‌", "‍", "﻿"}
    _NBSP = {" ", " "}
    _MOJIBAKE_PATTERNS = ["Ã", "â€", "Â "]
    _REPLACEMENT_CHAR = "�"

    def _weird_kinds(text: str) -> list[str]:
        kinds: list[str] = []
        if any(p in text for p in _MOJIBAKE_PATTERNS):
            kinds.append("mojibake")
        if _REPLACEMENT_CHAR in text:
            kinds.append("replacement char (�)")
        if any(c in text for c in _ZERO_WIDTH):
            kinds.append("zero-width")
        if any(c in text for c in _NBSP):
            kinds.append("non-breaking space")
        # C0/C1 control chars except tab(9), newline(10), carriage-return(13)
        if any((ord(c) < 32 and ord(c) not in (9, 10, 13)) or (127 <= ord(c) <= 159) for c in text):
            kinds.append("control char")
        return kinds

    weird_chars_all: list[dict[str, Any]] = []
    for p in paragraphs:
        kinds = _weird_kinds(p["text"])
        if kinds:
            weird_chars_all.append(
                {
                    "index": p["index"],
                    "text": p["text"],
                    "page": p["page"],
                    "kinds": kinds,
                }
            )
    weird_char_total = len(weird_chars_all)
    weird_chars = weird_chars_all[:100]

    # ── 5. raw_xml snippets ───────────────────────────────────────────────────
    # Up to 3 split_candidates + up to 2 paragraphs with soft breaks
    raw_xml_entries = []

    candidate_indices = {c["index"] for c in split_candidates}
    for p in paragraphs:
        if p["index"] in candidate_indices and len([e for e in raw_xml_entries if e["kind"] == "split_candidate"]) < 3:
            raw_xml_entries.append(
                {
                    "index": p["index"],
                    "kind": "split_candidate",
                    "xml": etree.tostring(p["_el"], pretty_print=True).decode(),
                }
            )

    soft_break_indices = {p["index"] for p in paragraphs if p["soft_breaks"] > 0}
    for p in paragraphs:
        if p["index"] in soft_break_indices and len([e for e in raw_xml_entries if e["kind"] == "has_soft_break"]) < 2:
            raw_xml_entries.append(
                {
                    "index": p["index"],
                    "kind": "has_soft_break",
                    "xml": etree.tostring(p["_el"], pretty_print=True).decode(),
                }
            )

    # ── 6. Summary ────────────────────────────────────────────────────────────
    with_soft_break_count = sum(1 for p in paragraphs if p["soft_breaks"] > 0)

    summary = {
        "total_paragraphs": total_paragraphs,
        "list_item_count": len(list_items),
        "with_soft_break_count": with_soft_break_count,
        "split_candidate_count": len(split_candidates),
        # True only if the file contained page-break markers we could count.
        # When False, the "page" fields are all 1 and should not be shown.
        "pages_estimated": saw_page_break,
        # New detector counts
        "typed_bullet_count": len(typed_bullets),
        "heading_issue_count": len(heading_issues),
        "empty_list_item_count": len(empty_list_items),
        "long_paragraph_count": long_para_total,
        "weird_char_count": weird_char_total,
        "unparseable": unparseable,
    }

    notes = [
        "split_candidates detection is HEURISTIC: a non-list paragraph immediately "
        "after a list paragraph is flagged only if it has indent_left > 0 OR its "
        "style name contains 'List'. False positives are possible (e.g. an indented "
        "sub-heading that is legitimately separate from the preceding bullet).",
        "Only direct <w:numPr> on the paragraph is treated as the primary list signal. "
        "Paragraphs that inherit numbering purely via their paragraph style are noted "
        "(num_from_style=True in the raw walk) but are NOT counted as list items for "
        "split detection, because resolving style → numbering requires loading styles.xml.",
        "Only body-level <w:p> elements are inspected (not table cells, text boxes, "
        "headers, or footers).",
        "A split_candidate does NOT necessarily mean a broken bullet — review the "
        "raw_xml entries to confirm before editing the source document.",
        "Page numbers are ESTIMATES inferred from <w:lastRenderedPageBreak/> and "
        "explicit page breaks in document order; Word does not store true page "
        "numbers. If the file has no such markers (common for Google Docs exports) "
        "the estimate is unavailable and page columns are hidden.",
        "typed_bullets detection is HEURISTIC: a paragraph starting with •, -, *, "
        "or a number followed by . or ) is flagged, but the paragraph must not already "
        "be a real list item. False positives are possible if the text genuinely starts "
        "with these characters for other reasons.",
        "fake_heading detection is HEURISTIC: a short paragraph (≤60 chars) with no "
        "sentence-ending punctuation where every text run is bold, but the style is not "
        "Heading 1-4. False positives are possible for bold emphasis phrases.",
        "weird_chars detection is HEURISTIC: non-breaking spaces, zero-width characters, "
        "replacement chars, mojibake patterns (Ã/â€), and C0/C1 control characters are "
        "flagged. Some of these may be intentional in specialized content.",
    ]

    return {
        "summary": summary,
        "list_items": list_items,
        "soft_break_items": soft_break_items,
        "split_candidates": split_candidates,
        "typed_bullets": typed_bullets,
        "heading_issues": heading_issues,
        "empty_list_items": empty_list_items,
        "long_paragraphs": long_paragraphs,
        "unparseable": unparseable,
        "weird_chars": weird_chars,
        "raw_xml": raw_xml_entries,
        "notes": notes,
    }
