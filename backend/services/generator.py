"""Card generation: produce cloze flashcards from section content."""
from __future__ import annotations
import re
import logging
import anthropic
from backend.config import DEFAULT_MODEL, resolve_model, effort_kwargs
from backend.services.ai_utils import CLOZE_RE, response_text, usage_dict

logger = logging.getLogger(__name__)

ANCHOR_INSTRUCTION = """CRITICAL RULE — Anchor term: Every card must contain a visible, unclosed "anchor" \
that tells the student what topic/condition/concept they are being tested on. \
Determine the anchor from the topic path, section heading, and content context. \
The anchor is usually the disease, condition, or concept name. \
NEVER cloze the anchor — it must remain readable so the student knows what \
they are studying and can recall the associated facts.

CLOZE VS BOLD DECISION RULE:
- CLOZE ({{c1::term}}) = any independently testable clinical element: anatomical structures, \
physiological terms, condition modifiers, dysfunction types, drug names, lab values, time frames, \
mechanisms, findings. If a student could be tested on recalling it, it must be clozed.
- <b>bold HTML tag</b> = ONLY for structural orientation labels (section headers within a card) \
and explicit emphasis qualifiers already present in the source text. \
NEVER use bold as a substitute for clozing. If a term qualifies for both, it should be CLOZED, not bolded.

FORMATTING RULE — ABSOLUTE: Output plain text only. \
NEVER use markdown formatting. \
** characters are FORBIDDEN — outputting **term** is a formatting error. \
* characters are FORBIDDEN for emphasis. \
No #, no backticks, no markdown of any kind. \
For any emphasis, use only HTML tags: <b>term</b>. \
The output format is: number|card text|additional context (optional) \
The additional context after the second | is optional. When the rules specify \
additional context, sibling footers, or supplementary information for a card, \
place it after a second | delimiter on the same line. \
Do NOT concatenate additional context directly into the card text. \
The card text (between first and second |) must contain ONLY the primary testable content. \
CLOZE INDEX RULE — ABSOLUTE: Every card uses {{c1::term}} for ALL cloze deletions. \
Always c1, regardless of the card number. Never use c2, c3, c4, etc. \
Example: 1|Primary card text with {{c1::clozes}}.|Other items: item A, item B, item C"""


def _inline_with_emphasis(node) -> str:
    """Inner text of an element, keeping only <b>/<i>/<u> emphasis tags and
    dropping any nested lists (rendered separately). Whitespace collapsed."""
    from bs4 import NavigableString, Tag
    parts = []
    for child in node.children:
        if isinstance(child, NavigableString):
            parts.append(str(child))
        elif isinstance(child, Tag):
            if child.name in ("ul", "ol"):
                continue
            if child.name in ("b", "i", "u"):
                parts.append(f"<{child.name}>{_inline_with_emphasis(child)}</{child.name}>")
            else:
                parts.append(_inline_with_emphasis(child))
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def structured_source_from_html(html: str) -> str:
    """Render a section's content_html as plain source text that PRESERVES the
    two cues a flat dump loses: bullet nesting (via indentation) and bold/italic
    emphasis (kept as <b>/<i>/<u>). No paragraph numbers — cards no longer cite
    source refs. Used as the source block in the generation prompt."""
    from bs4 import BeautifulSoup, Tag
    soup = BeautifulSoup(html or "", "html.parser")
    lines: list[str] = []

    def emit(depth: int, marker: str, text: str):
        if text:
            lines.append(f"{'  ' * depth}{marker}{text}")

    def walk_list(list_tag, depth):
        for li in list_tag.find_all("li", recursive=False):
            emit(depth, "- ", _inline_with_emphasis(li))
            for sub in li.find_all(["ul", "ol"], recursive=False):
                walk_list(sub, depth + 1)

    for el in soup.children:
        if isinstance(el, Tag):
            if el.name in ("ul", "ol"):
                walk_list(el, 0)
            elif el.name == "div" and "image-placeholder" in (el.get("class") or []):
                continue
            else:
                depth = 0
                m = re.search(r"margin-left:\s*([\d.]+)em", el.get("style", "") or "")
                if m:
                    depth = max(0, round(float(m.group(1)) / 1.5))
                emit(depth, "", _inline_with_emphasis(el))
        else:
            t = re.sub(r"\s+", " ", str(el)).strip()
            if t:
                emit(0, "", t)
    return "\n".join(lines)


def _render_source_text(section_data: dict) -> str:
    """Source block for the prompt: structure-preserving when content_html is
    available, else the plain content_text (no numbering either way)."""
    html = section_data.get("content_html")
    if html:
        rendered = structured_source_from_html(html)
        if rendered.strip():
            return rendered
    return (section_data.get("content_text") or "").strip()


def strip_card_html(card_text: str) -> str:
    """Strip HTML tags and reveal cloze terms to produce plain text."""
    text = CLOZE_RE.sub(r'\1', card_text)
    return re.sub(r'<[^>]+>', '', text).strip()


def extract_cloze_terms(card_text: str) -> list[str]:
    """Extract cloze deletion terms from card HTML."""
    return CLOZE_RE.findall(card_text)


def fix_markdown_bold(text: str) -> str:
    """Convert any **term** markdown bold to <b>term</b> HTML bold."""
    return re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)


def format_extra_as_list(text: str) -> str:
    """Format extra/additional context into line-separated HTML list items."""
    if '<br' in text.lower() or '<div' in text.lower() or '<li' in text.lower():
        return text
    if '; ' in text:
        label_match = re.match(r'^(.*?:\s*)', text)
        label = label_match.group(1) if label_match else ''
        items_text = text[len(label):]
        items = [item.strip() for item in items_text.split(';') if item.strip()]
        if len(items) > 1:
            items_html = ''.join(f'<br>• {item}' for item in items)
            return f'{label}{items_html}'
    # Dash-separated list: require at least 2 real separators, and never split
    # numeric ranges like "25 - 50 mg" or "2 - 3 weeks"
    list_sep = re.compile(r'(?<!\d)\s+-\s+(?!\d)')
    if len(list_sep.findall(text)) >= 2:
        parts = list_sep.split(text)
        label = parts[0].strip()
        items = [p.strip() for p in parts[1:] if p.strip()]
        if len(items) > 1:
            items_html = ''.join(f'<br>• {item}' for item in items)
            return f'{label}{items_html}' if label else items_html.lstrip('<br>')
    return text


def validate_card_text(card_text: str) -> tuple[str, bool]:
    """Normalize cloze indices to c1 and check the card is well-formed.

    Returns (normalized_text, is_valid). Invalid = no cloze at all, or
    residual markdown formatting that survived fix_markdown_bold.
    """
    normalized = re.sub(r'\{\{c\d+::', '{{c1::', card_text)
    has_cloze = bool(re.search(r'\{\{c1::', normalized))
    has_markdown = bool(re.search(r'\*\*|(?:^|\s)#{1,3}\s', normalized))
    return normalized, has_cloze and not has_markdown


def parse_card_output(raw: str) -> tuple[list[dict], bool]:
    """Parse the numbered|card format output from Claude.

    Returns (cards, needs_review) where needs_review is True if NEEDS_REVIEW
    marker was present in the output. Each card also carries its own
    "needs_review" flag when it fails validation (no cloze / markdown residue).
    """
    # Join wrapped lines: any line that doesn't start a new "N|" card is a
    # continuation of the previous one — without this, multi-line extras are
    # silently dropped.
    logical_lines: list[str] = []
    for line in raw.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        if line == "NEEDS_REVIEW" or re.match(r'^\d+\|', line):
            logical_lines.append(line)
        elif logical_lines and logical_lines[-1] != "NEEDS_REVIEW":
            logical_lines[-1] += " " + line
        else:
            logger.warning("Unparseable line in card output dropped: %.120s", line)

    cards = []
    needs_review = False
    for line in logical_lines:
        if line == "NEEDS_REVIEW":
            needs_review = True
            continue
        match = re.match(r'^(\d+)\|(.+)$', line)
        if match:
            parts = match.group(2).split('|')
            card_text = fix_markdown_bold(parts[0].strip())
            card_text, card_valid = validate_card_text(card_text)
            extra = None
            source_ref = None
            non_source_parts = []
            for p in parts[1:]:
                if p.strip().startswith("source:"):
                    source_ref = p.strip()[len("source:"):].strip() or None
                else:
                    non_source_parts.append(p)
            if non_source_parts:
                raw_extra = "|".join(non_source_parts).strip()
                if raw_extra:
                    extra = format_extra_as_list(fix_markdown_bold(raw_extra))
            cards.append({
                "card_number": int(match.group(1)),
                "front_html": card_text,
                "front_text": strip_card_html(card_text),
                "extra": extra,
                "source_ref": source_ref,
                "needs_review": not card_valid,
            })
    return cards, needs_review


def regenerate_single_card(
    client: anthropic.Anthropic,
    section_data: dict,
    existing_card_html: str,
    rules_text: str,
    extra_prompt: str | None = None,
    model: str = DEFAULT_MODEL,
) -> tuple[list[dict], bool, dict]:
    """Regenerate one card from the same section, optionally guided by extra_prompt."""
    topic = section_data.get('curriculum_topic_path') or ''
    topic_line = f"Curriculum context (for reference only): {topic}\n" if topic else ''

    source_text = _render_source_text(section_data)

    chunk_prompt = (
        f"You are regenerating a single flashcard from the source content below.\n\n"
        f"{topic_line}Section: {section_data.get('heading', '')}\n\n"
        f"Source text:\n{source_text}\n\n"
        f"The existing card (improve or replace it):\n{existing_card_html}\n"
    )
    if extra_prompt:
        chunk_prompt += f"\nAdditional guidance: {extra_prompt}\n"
    chunk_prompt += "\nGenerate ONE improved replacement card. Output exactly:\n1|cloze card text|additional context (optional)"

    response = client.messages.create(
        model=resolve_model(model)[0],
        **effort_kwargs(model),
        max_tokens=1024,
        temperature=0,
        system=[{
            "type": "text",
            "text": ANCHOR_INSTRUCTION + "\n\n" + rules_text,
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{
            "role": "user",
            "content": chunk_prompt,
        }],
    )
    raw = response_text(response)
    cards, needs_review = parse_card_output(raw)
    return cards, needs_review, usage_dict(response)


def build_generation_prompt(section_data: dict, rules_text: str) -> tuple[str, str]:
    """Build the exact (system_text, user_text) sent to Claude for one section.

    Single source of truth so the debug/inspect endpoint shows byte-for-byte
    what the real generation call sends. section_data should have:
    content_html (preferred) or content_text, heading, curriculum_topic_path,
    heading_tree (optional).
    """
    topic = section_data.get('curriculum_topic_path') or ''
    topic_line = f"Curriculum context (for reference only): {topic}\n" if topic else ''

    heading_tree = section_data.get('heading_tree')
    tree_section = ""
    if heading_tree:
        tree_section = f"\nSection structure:\n{_format_heading_tree(heading_tree)}\n"

    source_text = _render_source_text(section_data)

    user_text = (
        f"Now generate cards from the following study note content.\n\n"
        f"{topic_line}Section: {section_data.get('heading', '')}\n"
        f"{tree_section}\n"
        f"Source text:\n{source_text}\n\n"
        f"Generate the cards following ALL the rules above. Output in the exact format:\n"
        f"number|cloze card text|additional context (optional)\n\n"
        f"If you cannot confidently generate quality cards for this content, output NEEDS_REVIEW on its own line at the end.\n"
        f"Remember: ALL clozes on every card use {{{{c1::term}}}} — always c1, regardless of card number."
    )
    system_text = ANCHOR_INSTRUCTION + "\n\n" + rules_text
    return system_text, user_text


def generate_cards_for_section(
    client: anthropic.Anthropic,
    section_data: dict,
    rules_text: str,
    model: str = DEFAULT_MODEL,
) -> tuple[list[dict], bool, dict]:
    """Generate cards for a single section using Claude.

    section_data should have: content_text, heading, curriculum_topic_path, heading_tree (optional)
    Returns (cards, needs_review, usage).
    """
    system_text, chunk_prompt = build_generation_prompt(section_data, rules_text)

    # Retry once with a higher cap if the output hits max_tokens — a truncated
    # response would otherwise silently drop the cards on its final line.
    total_usage = None
    for max_tokens in (8192, 16384):
        response = client.messages.create(
            model=resolve_model(model)[0],
            **effort_kwargs(model),
            max_tokens=max_tokens,
            temperature=0,
            system=[{
                "type": "text",
                "text": system_text,
                "cache_control": {"type": "ephemeral"},
            }],
            messages=[{
                "role": "user",
                "content": chunk_prompt,
            }],
        )
        usage = usage_dict(response)
        if total_usage:
            for k in total_usage:
                total_usage[k] += usage[k]
        else:
            total_usage = usage
        if response.stop_reason != "max_tokens":
            break
        logger.warning(
            "Section '%s' output truncated at %d tokens, retrying with higher cap",
            section_data.get("heading", "?"), max_tokens,
        )

    raw = response_text(response)
    cards, needs_review = parse_card_output(raw)
    return cards, needs_review, total_usage


def _format_heading_tree(tree: list[dict], indent: int = 0) -> str:
    """Format a heading tree into indented text for the prompt."""
    lines = []
    for node in tree:
        prefix = "  " * indent
        lines.append(f"{prefix}- {node['heading']}")
        if node.get("children"):
            lines.append(_format_heading_tree(node["children"], indent + 1))
    return "\n".join(lines)
