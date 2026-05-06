from backend.config import MODELS, DEFAULT_MODEL, AVG_OUTPUT_TOKENS_PER_SECTION


def count_tokens(text: str) -> int:
    """Approximate token count using chars/4."""
    return max(1, len(text) // 4)


def estimate_cost(sections: list[dict], rules_text: str, model: str = DEFAULT_MODEL) -> dict:
    """Estimate the cost of generating cards for the given sections.

    Each section dict should have a "content_text" key.
    Returns a dict with estimated costs and token counts.
    """
    pricing = MODELS.get(model, MODELS[DEFAULT_MODEL])
    total_input = 0
    for section in sections:
        prompt = rules_text + "\n" + section.get("content_text", "")
        total_input += count_tokens(prompt)
    total_output = AVG_OUTPUT_TOKENS_PER_SECTION * len(sections)
    cost = (
        total_input / 1_000_000 * pricing["input_per_1m"]
        + total_output / 1_000_000 * pricing["output_per_1m"]
    )
    return {
        "section_count": len(sections),
        "estimated_input_tokens": total_input,
        "estimated_output_tokens": total_output,
        "estimated_cost_usd": round(cost, 4),
        "model": model,
    }
