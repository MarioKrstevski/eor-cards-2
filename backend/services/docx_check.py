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
import zipfile
from typing import Any

from lxml import etree

# Word namespace
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _w(tag: str) -> str:
    return f"{{{W}}}{tag}"


def _attr(el: etree._Element, tag: str) -> str | None:
    return el.get(_w(tag))


def check_docx(data: bytes) -> dict[str, Any]:
    """
    Inspect a .docx file (raw bytes) for list soft-break problems.

    Returns a dict with keys:
      summary, list_items, split_candidates, raw_xml, notes

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
    paragraphs: list[dict[str, Any]] = []
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
        soft_break_count = 0
        for br in child.iter(_w("br")):
            br_type = _attr(br, "type")
            if br_type in (None, "textWrapping"):
                soft_break_count += 1

        paragraphs.append(
            {
                "index": idx,  # position among ALL body children, not just <w:p>
                "is_list": is_list,
                "num_from_style": num_from_style,
                "text": text,
                "style": style_val,
                "indent_left": indent_left,
                "soft_breaks": soft_break_count,
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
                }
            )

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
    ]

    return {
        "summary": summary,
        "list_items": list_items,
        "split_candidates": split_candidates,
        "raw_xml": raw_xml_entries,
        "notes": notes,
    }
