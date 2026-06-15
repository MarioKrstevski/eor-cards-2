"""Detect duplicate or expanded content between existing and new text blocks."""
import time
import logging
import anthropic
from backend.config import DEFAULT_PROCESSING_MODEL, resolve_model, effort_kwargs
from backend.services.ai_utils import RETRYABLE_ERRORS, response_text

logger = logging.getLogger(__name__)


def detect_duplicates(
    client: anthropic.Anthropic,
    existing_texts: list[str],
    new_texts: list[str],
    model: str = DEFAULT_PROCESSING_MODEL,
) -> list[dict]:
    """Semantic comparison via Claude to detect duplicates.

    Args:
        client: Anthropic client
        existing_texts: List of existing paragraph texts
        new_texts: List of new paragraph texts to compare
        model: Model to use

    Returns:
        List of dicts for each new_text:
        [{"index": int, "text": str, "status": "DUPLICATE" | "NEW" | "EXPANDED", "match_index": int | None}]
    """
    if not existing_texts or not new_texts:
        return [{"index": i, "text": t, "status": "NEW", "match_index": None} for i, t in enumerate(new_texts)]

    existing_numbered = "\n".join(f"[E{i+1}] {t}" for i, t in enumerate(existing_texts))
    new_numbered = "\n".join(f"[N{i+1}] {t}" for i, t in enumerate(new_texts))

    prompt = f"""Compare these existing paragraphs with new paragraphs. For each new paragraph, determine if it is:
- DUPLICATE: essentially the same content as an existing paragraph
- EXPANDED: same topic as an existing paragraph but with additional information
- NEW: not present in existing content

EXISTING CONTENT:
{existing_numbered}

NEW CONTENT:
{new_numbered}

Output one line per new paragraph:
N1|STATUS|E_INDEX_OR_NONE
Example: N1|DUPLICATE|E3
Example: N2|NEW|NONE
Example: N3|EXPANDED|E1"""

    # Retry transient errors; on persistent failure, raise so the processing job
    # fails visibly instead of silently merging everything as NEW (which would
    # duplicate an entire re-uploaded document into the master tree).
    response = None
    for attempt in range(4):
        try:
            response = client.messages.create(
                model=resolve_model(model)[0],
                **effort_kwargs(model),
                max_tokens=4096,
                temperature=0,
                messages=[{"role": "user", "content": prompt}],
            )
            break
        except RETRYABLE_ERRORS as e:
            if attempt == 3:
                raise
            wait = 10 * (2 ** attempt)
            logger.warning("Retryable API error in duplicate detection (%s), retrying in %ds", type(e).__name__, wait)
            time.sleep(wait)

    raw = response_text(response)  # raises on truncation — missing lines would default to NEW
    results = []

    for line in raw.strip().split("\n"):
        line = line.strip()
        if not line or not line.startswith("N"):
            continue
        parts = line.split("|")
        if len(parts) < 3:
            continue
        try:
            idx = int(parts[0].replace("N", "")) - 1
            status = parts[1].strip().upper()
            if status not in ("DUPLICATE", "NEW", "EXPANDED"):
                status = "NEW"
            match_str = parts[2].strip()
            match_index = None
            if match_str != "NONE" and match_str.startswith("E"):
                try:
                    match_index = int(match_str.replace("E", "")) - 1
                except ValueError:
                    pass
            if 0 <= idx < len(new_texts):
                results.append({
                    "index": idx,
                    "text": new_texts[idx],
                    "status": status,
                    "match_index": match_index,
                })
        except (ValueError, IndexError):
            continue

    # Fill in any missing entries as NEW
    seen_indices = {r["index"] for r in results}
    for i, t in enumerate(new_texts):
        if i not in seen_indices:
            results.append({"index": i, "text": t, "status": "NEW", "match_index": None})

    results.sort(key=lambda r: r["index"])
    return results
