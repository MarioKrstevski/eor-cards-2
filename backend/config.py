import os
from dotenv import load_dotenv

load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/app.db")

MODELS = {
    # ── Add or remove models here. Order determines display order in Settings. ──
    "claude-haiku-4-5-20251001": {
        "display": "Claude Haiku 4.5",
        "input_per_1m": 1.0,
        "output_per_1m": 5.0,
    },
    "claude-sonnet-4-6": {
        "display": "Claude Sonnet 4.6",
        "input_per_1m": 3.0,
        "output_per_1m": 15.0,
    },
    # "claude-opus-4-6": {
    #     "display": "Claude Opus 4.6",
    #     "input_per_1m": 5.0,
    #     "output_per_1m": 25.0,
    # },
}

DEFAULT_MODEL = "claude-sonnet-4-6"          # default for card generation
DEFAULT_PROCESSING_MODEL = "claude-haiku-4-5-20251001"  # default for document processing
AVG_OUTPUT_TOKENS_PER_SECTION = 800
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
SEED_DIR = os.path.join(os.path.dirname(__file__), "..", "seed")


def compute_cost(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_write_tokens: int = 0,
    cache_read_tokens: int = 0,
) -> float:
    """Cost in USD. input_tokens is the UNCACHED portion only (as reported by
    the API); cache writes bill at 1.25x input price, cache reads at 0.1x."""
    pricing = MODELS.get(model, {})
    in_price = pricing.get("input_per_1m", 0)
    input_cost = (input_tokens / 1_000_000) * in_price
    cache_write_cost = (cache_write_tokens / 1_000_000) * in_price * 1.25
    cache_read_cost = (cache_read_tokens / 1_000_000) * in_price * 0.1
    output_cost = (output_tokens / 1_000_000) * pricing.get("output_per_1m", 0)
    return round(input_cost + cache_write_cost + cache_read_cost + output_cost, 6)
