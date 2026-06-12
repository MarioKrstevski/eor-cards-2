from backend.config import MODELS, DEFAULT_MODEL, AVG_OUTPUT_TOKENS_PER_SECTION

# Fixed per-section prompt overhead: ANCHOR_INSTRUCTION (~400 tokens) +
# paragraph numbering + heading tree + scoring pass input (card texts re-sent)
PER_SECTION_OVERHEAD_TOKENS = 900
# Scoring output per section (JSON array of scores)
SCORING_OUTPUT_TOKENS_PER_SECTION = 300


def count_tokens(text: str) -> int:
    """Approximate token count using chars/4."""
    return max(1, len(text) // 4)


def estimate_cost(sections: list[dict], rules_text: str, model: str = DEFAULT_MODEL) -> dict:
    """Estimate the cost of generating cards for the given sections.

    Each section dict should have a "content_text" key.
    Accounts for prompt caching: the system prompt (rules) is written once at a
    1.25x premium, then read at 0.1x for every subsequent section.
    """
    pricing = MODELS.get(model, MODELS[DEFAULT_MODEL])
    rules_tokens = count_tokens(rules_text)

    total_input = 0
    for section in sections:
        total_input += count_tokens(section.get("content_text", "")) + PER_SECTION_OVERHEAD_TOKENS

    # Cached system prompt: one write + (n-1) reads
    n = max(len(sections), 1)
    cache_write = rules_tokens
    cache_read = rules_tokens * (n - 1)

    total_output = (AVG_OUTPUT_TOKENS_PER_SECTION + SCORING_OUTPUT_TOKENS_PER_SECTION) * len(sections)
    cost = (
        total_input / 1_000_000 * pricing["input_per_1m"]
        + cache_write / 1_000_000 * pricing["input_per_1m"] * 1.25
        + cache_read / 1_000_000 * pricing["input_per_1m"] * 0.1
        + total_output / 1_000_000 * pricing["output_per_1m"]
    )
    return {
        "section_count": len(sections),
        "estimated_input_tokens": total_input + cache_write + cache_read,
        "estimated_output_tokens": total_output,
        "estimated_cost_usd": round(cost, 4),
        "model": model,
    }


def estimate_supplemental_cost(groups: dict, rules_text: str, model: str) -> dict:
    """Estimate cost for supplemental (vignette + teaching case) generation.

    groups maps condition name -> list of cards (each with front_text).
    The rules prompt is sent (cached) per group; every card's text is included.
    """
    pricing = MODELS.get(model, MODELS[DEFAULT_MODEL])
    rules_tokens = count_tokens(rules_text)
    n = max(len(groups), 1)

    def card_text(c) -> str:
        if isinstance(c, dict):
            return c.get("front_text") or ""
        return getattr(c, "front_text", None) or ""

    total_input = 0
    for group_cards in groups.values():
        cards_tokens = sum(count_tokens(card_text(c)) for c in group_cards)
        total_input += cards_tokens + 200  # instructions overhead

    cache_write = rules_tokens
    cache_read = rules_tokens * (n - 1)
    # Output: one vignette + teaching case per condition, ~800 tokens each pair
    total_output = 1200 * len(groups)

    cost = (
        total_input / 1_000_000 * pricing["input_per_1m"]
        + cache_write / 1_000_000 * pricing["input_per_1m"] * 1.25
        + cache_read / 1_000_000 * pricing["input_per_1m"] * 0.1
        + total_output / 1_000_000 * pricing["output_per_1m"]
    )
    return {
        "condition_groups": len(groups),
        "estimated_input_tokens": total_input + cache_write + cache_read,
        "estimated_output_tokens": total_output,
        "estimated_cost_usd": round(cost, 4),
        "model": model,
    }
