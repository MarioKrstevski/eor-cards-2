"""Document processing: parse .docx and HTML into structured elements, split by H2."""
import re
import base64
import io
from typing import Optional


def parse_docx(filepath: str) -> list[dict]:
    """Parse a .docx file into a list of element dicts.

    Each element has:
    - type: paragraph, heading, table, image
    - text: plain text content
    - html: HTML representation
    - level: heading level (1-6) for headings, None otherwise
    - heading_context: breadcrumb of parent headings (for nested content)
    - data_uri: base64 data URI for images
    - alt_text: alt text hint for images
    """
    import docx
    from docx.opc.constants import RELATIONSHIP_TYPE as RT

    doc = docx.Document(filepath)
    elements = []
    current_headings = {}  # level -> heading text

    for para in doc.paragraphs:
        style_name = (para.style.name or "").lower()
        text = para.text.strip()

        if not text and not para.runs:
            continue

        # Check for images in paragraph runs
        _WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
        for run in para.runs:
            if run._element.findall('.//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}drawing'):
                # Extract inline images
                for drawing in run._element.findall('.//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}drawing'):
                    # Read alt text from wp:docPr descr attribute
                    doc_pr = drawing.find(f'.//{{{_WP_NS}}}docPr')
                    alt_text = None
                    if doc_pr is not None:
                        raw_descr = doc_pr.get('descr', '').strip()
                        if raw_descr:
                            alt_text = raw_descr

                    for blip in drawing.findall('.//{http://schemas.openxmlformats.org/drawingml/2006/main}blip'):
                        embed = blip.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed')
                        if embed:
                            try:
                                rel = para.part.rels[embed]
                                image_data = rel.target_part.blob
                                content_type = rel.target_part.content_type or "image/png"
                                b64 = base64.b64encode(image_data).decode('utf-8')
                                data_uri = f"data:{content_type};base64,{b64}"
                                elements.append({
                                    "type": "image",
                                    "text": "",
                                    "html": "",
                                    "data_uri": data_uri,
                                    "alt_text": alt_text,
                                    "heading_context": _build_heading_context(current_headings),
                                })
                            except (KeyError, AttributeError):
                                pass

        if not text:
            continue

        # Detect heading level
        level = None
        if "heading" in style_name:
            match = re.search(r'(\d)', style_name)
            if match:
                level = int(match.group(1))

        if level is not None:
            # Update heading context
            current_headings[level] = text
            # Clear lower-level headings
            for l in list(current_headings.keys()):
                if l > level:
                    del current_headings[l]

            elements.append({
                "type": "heading",
                "text": text,
                "html": f"<h{level}>{text}</h{level}>",
                "level": level,
                "heading_context": _build_heading_context(current_headings),
            })
        else:
            # Build HTML with basic formatting from runs
            html_parts = []
            for run in para.runs:
                t = run.text
                if not t:
                    continue
                if run.bold:
                    t = f"<b>{t}</b>"
                if run.italic:
                    t = f"<i>{t}</i>"
                if run.underline:
                    t = f"<u>{t}</u>"
                html_parts.append(t)
            html = "".join(html_parts) or text

            # Detect list items by style name or numbering XML
            is_list = False
            list_type = "ul"  # default unordered
            indent_level = 0

            if "list" in style_name:
                is_list = True
                if "number" in style_name or "ordered" in style_name:
                    list_type = "ol"
            else:
                # Check for Word numbering (numPr element)
                num_pr = para._element.find('.//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}numPr')
                if num_pr is not None:
                    is_list = True
                    # Check numId to distinguish bullet vs number
                    num_id_el = num_pr.find('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}numId')
                    if num_id_el is not None:
                        num_id_val = int(num_id_el.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}val', '0'))
                        # numId 0 means no numbering
                        if num_id_val == 0:
                            is_list = False

            if is_list:
                # Get indentation level from ilvl
                ilvl_el = para._element.find('.//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}ilvl')
                if ilvl_el is not None:
                    indent_level = int(ilvl_el.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}val', '0'))
                else:
                    # Try indentation from paragraph properties
                    ind_el = para._element.find('.//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}ind')
                    if ind_el is not None:
                        left = ind_el.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}left', '0')
                        indent_level = max(0, int(left) // 720)  # 720 twips ≈ 0.5 inch

            if is_list:
                elements.append({
                    "type": "list_item",
                    "text": text,
                    "html": html,
                    "list_type": list_type,
                    "indent_level": indent_level,
                    "heading_context": _build_heading_context(current_headings),
                })
            else:
                # Check for indentation on regular paragraphs
                ind_el = para._element.find('.//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}ind')
                if ind_el is not None:
                    left = ind_el.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}left', '0')
                    indent_level = max(0, int(left) // 720)

                if indent_level > 0:
                    elements.append({
                        "type": "paragraph",
                        "text": text,
                        "html": f'<p style="margin-left:{indent_level * 1.5}em">{html}</p>',
                        "heading_context": _build_heading_context(current_headings),
                    })
                else:
                    elements.append({
                        "type": "paragraph",
                        "text": text,
                        "html": f"<p>{html}</p>",
                        "heading_context": _build_heading_context(current_headings),
                    })

    # Process tables
    for table in doc.tables:
        rows = []
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells]
            rows.append(cells)
        if rows:
            text = _table_to_text(rows)
            html = _table_to_html(rows)
            elements.append({
                "type": "table",
                "text": text,
                "html": html,
                "rows": rows,
                "heading_context": _build_heading_context(current_headings),
            })

    return elements


def parse_html(filepath: str) -> list[dict]:
    """Parse an HTML file into structured elements."""
    from bs4 import BeautifulSoup

    with open(filepath, "r", encoding="utf-8") as f:
        html_content = f.read()

    soup = BeautifulSoup(html_content, "html.parser")
    elements = []
    current_headings = {}

    for elem in soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'table', 'div', 'li', 'ul', 'ol']):
        tag = elem.name.lower()
        text = elem.get_text(strip=True)

        if not text:
            continue

        if tag.startswith('h') and len(tag) == 2 and tag[1].isdigit():
            level = int(tag[1])
            current_headings[level] = text
            for l in list(current_headings.keys()):
                if l > level:
                    del current_headings[l]
            elements.append({
                "type": "heading",
                "text": text,
                "html": str(elem),
                "level": level,
                "heading_context": _build_heading_context(current_headings),
            })
        elif tag == 'table':
            rows = []
            for tr in elem.find_all('tr'):
                cells = [td.get_text(strip=True) for td in tr.find_all(['td', 'th'])]
                rows.append(cells)
            if rows:
                elements.append({
                    "type": "table",
                    "text": _table_to_text(rows),
                    "html": str(elem),
                    "rows": rows,
                    "heading_context": _build_heading_context(current_headings),
                })
        elif tag in ('p', 'div', 'li'):
            elements.append({
                "type": "paragraph",
                "text": text,
                "html": str(elem),
                "heading_context": _build_heading_context(current_headings),
            })

    return elements


def split_by_h2(elements: list[dict]) -> list[tuple[str, list[dict]]]:
    """Split elements into groups by H2 headings.

    Returns list of (heading_text, elements_in_section).
    Content before the first H2 goes into a "Preamble" section.
    """
    sections = []
    current_heading = "Preamble"
    current_elements = []

    for elem in elements:
        if elem.get("type") == "heading" and elem.get("level") == 2:
            if current_elements:
                sections.append((current_heading, current_elements))
            current_heading = elem.get("text", "Untitled Section")
            current_elements = [elem]
        else:
            current_elements.append(elem)

    if current_elements:
        sections.append((current_heading, current_elements))

    return sections


def build_heading_tree(elements: list[dict]) -> list[dict]:
    """Build a nested heading tree (H3/H4) from a section's elements.

    Returns a list of dicts like:
    [{"heading": "Diagnosis", "level": 3, "children": [{"heading": "BNP Levels", "level": 4, "children": []}]}]
    """
    tree = []
    stack = []  # (level, node)

    for elem in elements:
        if elem.get("type") != "heading":
            continue
        level = elem.get("level", 3)
        if level < 3:
            continue  # skip H1/H2 — those are section boundaries

        node = {"heading": elem["text"], "level": level, "children": []}

        # Pop items from stack that are at same or deeper level
        while stack and stack[-1][0] >= level:
            stack.pop()

        if stack:
            stack[-1][1]["children"].append(node)
        else:
            tree.append(node)

        stack.append((level, node))

    return tree


def compare_heading_trees(existing: list[dict], new: list[dict]) -> dict:
    """Compare two heading trees and find matches, new headings, and missing headings.

    Returns:
    {
        "matched": [{"existing": heading, "new": heading}],
        "new": [heading],
        "missing": [heading],
    }
    """
    existing_headings = _flatten_headings(existing)
    new_headings = _flatten_headings(new)

    existing_set = set(existing_headings)
    new_set = set(new_headings)

    matched = [{"existing": h, "new": h} for h in existing_set & new_set]
    added = list(new_set - existing_set)
    missing = list(existing_set - new_set)

    return {"matched": matched, "new": added, "missing": missing}


def _flatten_headings(tree: list[dict]) -> list[str]:
    """Flatten a heading tree into a list of heading strings."""
    headings = []
    for node in tree:
        headings.append(node["heading"])
        if node.get("children"):
            headings.extend(_flatten_headings(node["children"]))
    return headings


def _build_heading_context(headings: dict) -> Optional[str]:
    """Build a heading context string from current heading hierarchy."""
    if not headings:
        return None
    parts = []
    for level in sorted(headings.keys()):
        parts.append(f"H{level}: {headings[level]}")
    return " > ".join(parts)


def build_content_html(elements: list[dict]) -> str:
    """Build HTML from elements, properly grouping list items into <ul>/<ol> tags."""
    html_parts = []
    list_stack = []  # stack of (list_type, indent_level)
    img_counter = 0

    for elem in elements:
        elem_type = elem.get("type", "paragraph")

        if elem_type == "list_item":
            target_indent = elem.get("indent_level", 0)
            lt = elem.get("list_type", "ul")

            # Close deeper lists
            while list_stack and list_stack[-1][1] > target_indent:
                html_parts.append(f"</li></{list_stack[-1][0]}>")
                list_stack.pop()

            if not list_stack or list_stack[-1][1] < target_indent:
                # Open new nested list
                html_parts.append(f"<{lt}>")
                list_stack.append((lt, target_indent))
            else:
                # Same level — close previous <li>
                html_parts.append("</li>")

            html_parts.append(f"<li>{elem.get('html', elem.get('text', ''))}")
        else:
            # Close all open lists before non-list content
            while list_stack:
                html_parts.append(f"</li></{list_stack[-1][0]}>")
                list_stack.pop()

            if elem_type == "image":
                img_counter += 1
                html_parts.append(
                    f'<div class="image-placeholder" data-img-index="{img_counter}">'
                    f'[Image {img_counter}]</div>'
                )
            else:
                html_parts.append(elem.get("html", elem.get("text", "")))

    # Close remaining open lists
    while list_stack:
        html_parts.append(f"</li></{list_stack[-1][0]}>")
        list_stack.pop()

    return "\n".join(html_parts)


def _table_to_text(rows: list[list[str]]) -> str:
    """Convert table rows to plain text."""
    lines = []
    for row in rows:
        lines.append(" | ".join(row))
    return "\n".join(lines)


def _table_to_html(rows: list[list[str]]) -> str:
    """Convert table rows to HTML table."""
    html_parts = ["<table>"]
    for i, row in enumerate(rows):
        html_parts.append("<tr>")
        tag = "th" if i == 0 else "td"
        for cell in row:
            html_parts.append(f"<{tag}>{cell}</{tag}>")
        html_parts.append("</tr>")
    html_parts.append("</table>")
    return "".join(html_parts)
