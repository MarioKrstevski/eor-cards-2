"""Merge new content blocks into existing ones, handling duplicates and expansions."""
import logging
from typing import Optional

logger = logging.getLogger(__name__)


def merge_content(
    existing_blocks: list[dict],
    new_blocks: list[dict],
    duplicate_results: list[dict],
) -> list[dict]:
    """Merge new content blocks into existing blocks based on duplicate detection results.

    Args:
        existing_blocks: List of existing block dicts with "text", "html", "position"
        new_blocks: List of new block dicts with "text", "html"
        duplicate_results: Output from detect_duplicates — list of
            {"index": int, "status": str, "match_index": int | None}

    Returns:
        Merged list of block dicts with updated positions and duplicate markers.
    """
    # Start with existing blocks
    merged = list(existing_blocks)

    # Track which existing blocks were matched (for EXPANDED replacement)
    expanded_replacements = {}

    for result in duplicate_results:
        idx = result["index"]
        status = result["status"]
        match_idx = result.get("match_index")

        if idx >= len(new_blocks):
            continue

        new_block = new_blocks[idx]

        if status == "DUPLICATE":
            # Mark as duplicate, don't add to merged
            new_block_copy = dict(new_block)
            new_block_copy["is_duplicate"] = True
            new_block_copy["duplicate_of_index"] = match_idx
            # We don't add duplicates to the merged output

        elif status == "EXPANDED":
            # Replace the existing block with the expanded version
            if match_idx is not None and match_idx < len(merged):
                expanded_replacements[match_idx] = new_block

        elif status == "NEW":
            # Append new content at the end
            merged.append(new_block)

    # Apply expanded replacements
    for idx, replacement in expanded_replacements.items():
        if idx < len(merged):
            merged[idx] = {
                **merged[idx],
                "text": replacement.get("text", merged[idx].get("text", "")),
                "html": replacement.get("html", merged[idx].get("html", "")),
                "was_expanded": True,
            }

    # Re-number positions
    for i, block in enumerate(merged):
        block["position"] = i

    return merged
