import os
from dotenv import load_dotenv

load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/app.db")

MODELS = {
    # ── Add or remove models here. Order determines display order in Settings. ──
    "claude-haiku-4-5-20251001": {
        "display": "Claude Haiku 4.5",
        "input_per_1m": 0.80,
        "output_per_1m": 4.0,
    },
    "claude-sonnet-4-6": {
        "display": "Claude Sonnet 4.6",
        "input_per_1m": 3.0,
        "output_per_1m": 15.0,
    },
    # "claude-opus-4-6": {
    #     "display": "Claude Opus 4.6",
    #     "input_per_1m": 15.0,
    #     "output_per_1m": 75.0,
    # },
}

DEFAULT_MODEL = "claude-sonnet-4-6"          # default for card generation
DEFAULT_PROCESSING_MODEL = "claude-haiku-4-5-20251001"  # default for document processing
AVG_OUTPUT_TOKENS_PER_SECTION = 800
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
SEED_DIR = os.path.join(os.path.dirname(__file__), "..", "seed")


def compute_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    pricing = MODELS.get(model, {})
    input_cost = (input_tokens / 1_000_000) * pricing.get("input_per_1m", 0)
    output_cost = (output_tokens / 1_000_000) * pricing.get("output_per_1m", 0)
    return round(input_cost + output_cost, 6)
