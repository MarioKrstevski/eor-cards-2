"""Convert table elements to plain text content blocks."""


def convert_table_to_text(rows: list[list[str]]) -> str:
    """Convert a table (list of rows, each a list of cell strings) to readable plain text.

    Uses a markdown-style format with header separation.
    """
    if not rows:
        return ""

    lines = []
    for i, row in enumerate(rows):
        line = " | ".join(cell.strip() for cell in row)
        lines.append(line)
        if i == 0 and len(rows) > 1:
            # Add separator after header row
            separator = " | ".join("---" for _ in row)
            lines.append(separator)

    return "\n".join(lines)


def convert_table_elements(elements: list[dict]) -> list[dict]:
    """Process a list of elements, converting table elements to include
    both their original HTML and a text representation.

    Tables keep their type as 'table' but get enhanced text content.
    """
    processed = []
    for elem in elements:
        if elem.get("type") == "table" and elem.get("rows"):
            elem = dict(elem)  # copy to avoid mutating original
            elem["text"] = convert_table_to_text(elem["rows"])
        processed.append(elem)
    return processed
