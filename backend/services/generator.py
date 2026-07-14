"""Card generation: produce cloze flashcards from section content."""
from __future__ import annotations
import re
import logging
import anthropic
from backend.config import DEFAULT_MODEL, resolve_model, effort_kwargs
from backend.services.ai_utils import CLOZE_RE, response_text, usage_dict, OutputTruncated
from backend.services.llm import complete_text

logger = logging.getLogger(__name__)

# NOTE: ANCHOR_INSTRUCTION is intentionally NO LONGER wired into any prompt — these
# rules now live in the editable rule set (card_gen_v6). Kept here as dead/reference
# code in case we want to reinstate a hardcoded system prefix later.
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


def _inline_text(node) -> str:
    """Inner text of an element, dropping ALL tags (and nested lists, which are
    rendered separately). Only horizontal whitespace is collapsed — a <br> (Word
    soft line break) is preserved as a real "\\n" so multi-line content stays on
    separate lines instead of running together (see _push_lines)."""
    from bs4 import NavigableString, Tag
    parts = []
    for child in node.children:
        if isinstance(child, NavigableString):
            parts.append(str(child))
        elif isinstance(child, Tag):
            if child.name == "br":
                parts.append("\n")
            elif child.name in ("ul", "ol"):
                continue
            else:
                parts.append(_inline_text(child))
    return re.sub(r"[ \t]+", " ", "".join(parts)).strip()


def _push_lines(out: list, depth: int, marker: str, text: str) -> None:
    """Append `text` to `out` as one line per hard break ("\\n"), indented by
    `depth`. `marker` (e.g. "- ") goes on the FIRST visual line only; continuation
    lines (from Word soft breaks) sit at the same indent with no marker — exactly
    what pasting the section from Word would look like. Blank segments dropped."""
    if not text:
        return
    first = True
    for seg in text.split("\n"):
        seg = seg.strip()
        if not seg:
            continue
        out.append(f"{'  ' * depth}{marker if first else ''}{seg}")
        first = False


def structured_source_from_html(html: str) -> str:
    """Render a section's content_html as a clean, paste-like outline: bullets
    ("- ") with one indent level per nesting depth, headings/paragraphs on their
    own lines. HTML tags are stripped (no <b>, no markdown) so it looks just like
    pasting the section into a chat. Used as the source block in the prompt."""
    from bs4 import BeautifulSoup, Tag
    soup = BeautifulSoup(html or "", "html.parser")
    lines: list[str] = []

    def emit(depth: int, marker: str, text: str):
        _push_lines(lines, depth, marker, text)

    def walk_list(list_tag, depth):
        for li in list_tag.find_all("li", recursive=False):
            emit(depth, "- ", _inline_text(li))
            for sub in li.find_all(["ul", "ol"], recursive=False):
                walk_list(sub, depth + 1)

    for el in soup.children:
        if isinstance(el, Tag):
            if el.name in ("ul", "ol"):
                walk_list(el, 0)
            elif el.name == "li":  # bare <li> not wrapped in a list
                emit(0, "- ", _inline_text(el))
                for sub in el.find_all(["ul", "ol"], recursive=False):
                    walk_list(sub, 1)
            elif el.name == "div" and "image-placeholder" in (el.get("class") or []):
                continue
            else:
                depth = 0
                m = re.search(r"margin-left:\s*([\d.]+)em", el.get("style", "") or "")
                if m:
                    depth = max(0, round(float(m.group(1)) / 1.5))
                emit(depth, "", _inline_text(el))
        else:
            t = re.sub(r"\s+", " ", str(el)).strip()
            if t:
                emit(0, "", t)
    return "\n".join(lines)


def _inline_md(node) -> str:
    """Inner text of an element as Markdown inline: <b>/<strong> -> **bold**,
    <i>/<em> -> *italic*, nested lists skipped (rendered separately). Mirrors what
    the section modal shows (which renders the same <b>/<i> tags)."""
    from bs4 import NavigableString, Tag
    parts = []
    for child in node.children:
        if isinstance(child, NavigableString):
            parts.append(str(child))
        elif isinstance(child, Tag):
            if child.name == "br":
                parts.append("\n")  # Word soft break — kept as a real newline
                continue
            if child.name in ("ul", "ol"):
                continue
            inner = _inline_md(child)
            stripped = inner.strip()
            if not stripped:
                parts.append(inner)
            elif child.name in ("b", "strong"):
                parts.append(f"**{stripped}**")
            elif child.name in ("i", "em"):
                parts.append(f"*{stripped}*")
            else:
                parts.append(inner)
    return re.sub(r"[ \t]+", " ", "".join(parts)).strip()


_UNIT_PX = {"in": 96.0, "pt": 96 / 72.0, "em": 16.0, "px": 1.0, "cm": 37.8}


def _left_indent_px(el) -> float:
    """Left indentation of an element from its inline style, normalized to px.
    Handles `margin-left:Xunit` and the `margin: t r b l` shorthand (Outlook/Word
    paste uses inch margins on flat <li> to express nesting)."""
    style = el.get("style", "") or ""
    m = re.search(r"margin-left:\s*([\d.]+)\s*(in|em|px|pt|cm)", style)
    if not m:
        m = re.search(
            r"margin:\s*[\d.]+\s*\w+\s+[\d.]+\s*\w+\s+[\d.]+\s*\w+\s+([\d.]+)\s*(in|em|px|pt|cm)",
            style,
        )
    if not m:
        return 0.0
    return float(m.group(1)) * _UNIT_PX.get(m.group(2), 1.0)


def markdown_source_from_html(html: str) -> str:
    """Render a section's content_html as Markdown that mirrors the section modal:
    nested bullet lists (2 spaces per level), **bold**/*italic* preserved,
    headings as #, paragraphs on their own lines. This is what the AI receives, so
    it sees the same structure and emphasis the reviewer sees.

    Nesting comes from real <ul><li> when present, OR — for Outlook/Word paste,
    which emits flat <li>/<p> with margin-left indentation — from the left margin,
    ranked per section so each distinct indent becomes one nesting level."""
    from bs4 import BeautifulSoup, Tag
    soup = BeautifulSoup(html or "", "html.parser")
    lines: list[str] = []

    # Rank distinct left-indents of the top-level blocks so margin-based
    # indentation (paste) maps to 0,1,2,… nesting depth.
    indents = sorted({
        round(_left_indent_px(el))
        for el in soup.children
        if isinstance(el, Tag) and el.name in ("li", "p", "div")
        and not (el.name == "div" and "image-placeholder" in (el.get("class") or []))
    })
    depth_of = {v: i for i, v in enumerate(indents)}
    margin_depth = lambda el: depth_of.get(round(_left_indent_px(el)), 0)

    def walk_list(list_tag, depth):
        for li in list_tag.find_all("li", recursive=False):
            # Continuation items (grouped under a bullet in the source) carry no
            # marker — they render as an indented line at the same depth.
            marker = "" if "cont" in (li.get("class") or []) else "- "
            _push_lines(lines, depth, marker, _inline_md(li))
            for sub in li.find_all(["ul", "ol"], recursive=False):
                walk_list(sub, depth + 1)

    for el in soup.children:
        if isinstance(el, Tag):
            if el.name in ("ul", "ol"):
                walk_list(el, 0)
            elif el.name == "li":  # bare <li> not wrapped in a list (paste)
                _push_lines(lines, margin_depth(el), "- ", _inline_md(el))
                for sub in el.find_all(["ul", "ol"], recursive=False):
                    walk_list(sub, margin_depth(el) + 1)
            elif re.fullmatch(r"h[1-6]", el.name or ""):
                _push_lines(lines, 0, f"{'#' * int(el.name[1])} ", _inline_md(el))
            elif el.name == "div" and "image-placeholder" in (el.get("class") or []):
                idx = el.get("data-img-index")
                lines.append(f"[Image {idx}]" if idx else "[Image]")
            else:
                # Paragraph — keep its text (incl. any manual bullet glyph), indent
                # by its (ranked) left margin so the modal's nesting is preserved.
                # Soft line breaks inside it become their own lines (_push_lines).
                _push_lines(lines, margin_depth(el), "", _inline_md(el))
        else:
            t = re.sub(r"\s+", " ", str(el)).strip()
            if t:
                lines.append(t)
    return "\n".join(lines)


def _strip_image_markers(text: str) -> str:
    """Remove reference-image placeholders ("[Image N]") from the AI source — a
    reference image carries no meaning to pass the model, and EXTRACT images
    already had their text merged into the content. The image still shows in the
    section modal (content_html is untouched)."""
    text = re.sub(r'(?m)^\s*-?\s*\[Image\s*\d*\]\s*$', '', text)  # whole-line markers
    text = re.sub(r'\s*\[Image\s*\d*\]', '', text)                # inline markers
    return re.sub(r'\n{3,}', '\n\n', text).strip()


def build_content_source(content_html: str, heading: str | None = None) -> str:
    """The faithful source block we freeze at parse time and send the AI verbatim:
    the section heading as the first line (so the model sees the same anchor the
    reviewer pastes into chat), then the indented body rendered from content_html.
    Stored on Section.content_source so payload == inspect == stored, no re-render
    at send time."""
    body = _strip_image_markers(markdown_source_from_html(content_html or ""))
    heading = (heading or "").strip()
    if heading and body:
        return f"{heading}\n{body}"
    return heading or body


def _render_source_text(section_data: dict) -> str:
    """Source block for the prompt. Prefer the frozen content_source (built at
    parse time); fall back to rendering content_html, then plain content_text
    (for sections created before content_source existed)."""
    frozen = section_data.get("content_source")
    if frozen and frozen.strip():
        return frozen
    html = section_data.get("content_html")
    if html:
        rendered = _strip_image_markers(markdown_source_from_html(html))
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
    # Only bulletize semicolon lists that start with a label ("Risk factors: ...");
    # plain prose containing semicolons must not be split.
    if '; ' in text and re.match(r'^[A-Za-z ()/]+:', text):
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
    # silently dropped. But obvious trailing model prose/code fences must NOT
    # be glued into the last card: once a markdown header or summary-prose
    # line appears, stop joining until the next real card line.
    junk_start = re.compile(r'^(#{1,6} |These\b|The above\b|Note:|In summary\b)')
    logical_lines: list[str] = []
    stop_joining = False
    for line in raw.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        if line == "NEEDS_REVIEW" or re.match(r'^\d+\|', line):
            logical_lines.append(line)
            stop_joining = False
        elif line == "```":
            logger.warning("Unparseable line in card output dropped: %.120s", line)
        elif junk_start.match(line):
            stop_joining = True
            logger.warning("Unparseable line in card output dropped: %.120s", line)
        elif logical_lines and logical_lines[-1] != "NEEDS_REVIEW" and not stop_joining:
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


# Scoping instruction for reviewer-guided single-card regenerates: make ONLY the
# requested change instead of rewriting the whole card. Only applied when a
# guiding prompt is present AND the caller opts in (guided=True) — the bulk
# validate/auto-fix loop passes fix_guidance() as extra_prompt and must keep
# its current full-rewrite behavior.
_GUIDED_EDIT_INSTRUCTION = (
    "You are making a TARGETED edit to an existing flashcard. Apply ONLY the change "
    "described in the guidance below. Preserve everything else EXACTLY — same facts, "
    "same cloze deletions and c1 indices, same wording, same bold/anchor formatting, "
    "same footer. Do not rewrite, re-cloze, rephrase, re-split, or reformat anything "
    "the guidance does not explicitly ask you to change. Output the same card with "
    "only the requested change applied."
)


def regenerate_single_card(
    client: anthropic.Anthropic,
    section_data: dict,
    existing_card_html: str,
    rules_text: str,
    extra_prompt: str | None = None,
    model: str = DEFAULT_MODEL,
    guided: bool = False,
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

    system_blocks = [{
        "type": "text",
        "text": rules_text,  # ANCHOR_INSTRUCTION no longer prepended (rules live in the rule set)
        "cache_control": {"type": "ephemeral"},
    }]
    if guided and extra_prompt:
        # Appended AFTER the cached rules block so the cache prefix is unchanged.
        system_blocks.append({"type": "text", "text": _GUIDED_EDIT_INSTRUCTION})

    response = client.messages.create(
        model=resolve_model(model)[0],
        **effort_kwargs(model),
        max_tokens=1024,
        temperature=0,
        system=system_blocks,
        messages=[{
            "role": "user",
            "content": chunk_prompt,
        }],
    )
    raw = response_text(response)
    cards, needs_review = parse_card_output(raw)
    return cards, needs_review, usage_dict(response)


# NOTE: intentionally NO LONGER appended to the generation user message — the
# output format, NEEDS_REVIEW, and always-c1 rules now live in the rule set.
# Kept as dead/reference code in case we want to reinstate it. (Cloze index is
# also normalized to c1 by the parser regardless.)
_GENERATION_OUTPUT_INSTRUCTION = (
    "Generate the cards following ALL the rules above. Output in the exact format:\n"
    "number|cloze card text|additional context (optional)\n\n"
    "If you cannot confidently generate quality cards for this content, output NEEDS_REVIEW on its own line at the end.\n"
    "Remember: ALL clozes on every card use {{c1::term}} — always c1, regardless of card number."
)


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
        # Reconnect the rules (system prompt) to the source at the point of the ask,
        # and anchor the sibling-split decision to the source's line structure —
        # this is what removes the coin-flip on whether to split multi-point content.
        "Now generate the cards from the Source text above, applying every rule and "
        "the exact output format from your instructions — and treat each separate "
        "line or indented sub-point in the source as its own distinct idea, giving it "
        "its own sibling card rather than merging multiple sub-points into one card."
    )
    system_text = rules_text  # ANCHOR_INSTRUCTION no longer prepended — its rules now live in the rule set
    return system_text, user_text


def generate_cards_for_section(
    section_data: dict,
    rules_text: str,
    model: str = DEFAULT_MODEL,
) -> tuple[list[dict], bool, dict]:
    """Generate cards for a single section. Routes to Claude or Gemini via
    complete_text. Returns (cards, needs_review, usage)."""
    system_text, chunk_prompt = build_generation_prompt(section_data, rules_text)

    total_usage = None
    stop_reason = None
    raw = ""
    for max_tokens in (8192, 16384):
        raw, usage, stop_reason = complete_text(
            model, system_text, chunk_prompt,
            temperature=0, max_tokens=max_tokens,
        )
        if total_usage:
            for k in total_usage:
                total_usage[k] += usage[k]
        else:
            total_usage = usage
        if stop_reason != "max_tokens":
            break
        logger.warning(
            "Section '%s' output truncated at %d tokens, retrying with higher cap",
            section_data.get("heading", "?"), max_tokens,
        )

    if stop_reason == "max_tokens":
        raise OutputTruncated(
            "Card generation output truncated at max_tokens — refusing partial result"
        )

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
