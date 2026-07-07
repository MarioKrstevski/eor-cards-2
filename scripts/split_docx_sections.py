#!/usr/bin/env python3
"""Split a .docx into one file per section (heading -> next heading of the same
or higher level), LOSSLESSLY.

We do NOT rebuild the section from parsed text — that's where formatting/images
get dropped. Instead we CLONE the original .docx (keeping every style, image,
relationship byte-for-byte) and delete only the body paragraphs/tables outside
the section's range. Ancestor headings (e.g. the H1 above an H2) are kept so the
exported file still maps to the right curriculum topic when re-uploaded.

Usage:
    python scripts/split_docx_sections.py INPUT.docx OUTPUT_DIR [--level N]

--level chooses which heading level marks a "section" (default: the deepest
heading level present, i.e. the leaf topics).
"""
import os
import re
import sys
import shutil

import docx
from docx.oxml.ns import qn
from docx.oxml.text.paragraph import CT_P
from docx.text.paragraph import Paragraph


def _heading_level(el, doc):
    if not isinstance(el, CT_P):
        return None
    try:
        name = Paragraph(el, doc).style.name or ""
    except Exception:
        return None
    m = re.search(r"(\d)", name)
    return int(m.group(1)) if ("head" in name.lower() and m) else None


def split(path: str, out_dir: str, level: int | None = None) -> None:
    doc = docx.Document(path)
    children = list(doc.element.body.iterchildren())
    levels = [_heading_level(c, doc) for c in children]
    heads = [(i, lv) for i, lv in enumerate(levels) if lv]
    if not heads:
        print("No headings found — nothing to split.")
        return
    if level is None:
        level = max(lv for _, lv in heads)

    starts = [i for i, lv in heads if lv == level]
    os.makedirs(out_dir, exist_ok=True)
    print(f"Splitting at heading level {level}: {len(starts)} section(s)")

    for si in starts:
        # Section body runs from this heading to the next heading of level <= level.
        end = len(children)
        for j in range(si + 1, len(children)):
            if levels[j] and levels[j] <= level:
                end = j
                break
        keep = set(range(si, end))

        # Keep the nearest ancestor heading at each shallower level (for context).
        need = set(range(1, level))
        for j in range(si - 1, -1, -1):
            lv = levels[j]
            if lv in need:
                keep.add(j)
                need.discard(lv)
            if not need:
                break

        title = Paragraph(children[si], doc).text.strip()
        safe = re.sub(r"[^\w\- ]", "_", title)[:60].strip() or f"section_{si}"
        out = os.path.join(out_dir, safe + ".docx")

        shutil.copy(path, out)                     # byte-for-byte clone
        d2 = docx.Document(out)
        body2 = d2.element.body
        for idx, el in enumerate(list(body2.iterchildren())):
            # Remove paragraphs/tables outside the kept set; leave w:sectPr etc.
            if el.tag in (qn("w:p"), qn("w:tbl")) and idx not in keep:
                body2.remove(el)
        d2.save(out)
        print(f"  wrote {out}  ({len(keep)} blocks kept)")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    lvl = None
    if "--level" in sys.argv:
        lvl = int(sys.argv[sys.argv.index("--level") + 1])
    split(sys.argv[1], sys.argv[2], lvl)
