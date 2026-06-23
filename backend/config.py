from __future__ import annotations

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
    "claude-sonnet-4-5": {
        "display": "Claude Sonnet 4.5",
        "input_per_1m": 3.0,
        "output_per_1m": 15.0,
    },
    # "claude-opus-4-6": {
    #     "display": "Claude Opus 4.6",
    #     "input_per_1m": 5.0,
    #     "output_per_1m": 25.0,
    # },
}

# ── Effort ─────────────────────────────────────────────────────────────────
# Sonnet 4.6 supports the `effort` parameter (low|medium|high|max); higher
# effort means more internal deliberation → slower + more tokens. `max` is
# valid on Sonnet 4.6 (and Opus 4.6+). Haiku 4.5 and Sonnet 4.5 do NOT support
# effort and error if it's passed, so they get no effort variants.
# A model selection is encoded as "<model_id>:<effort>" (e.g.
# "claude-sonnet-4-6:medium"). Bare model ids (no suffix) resolve to no effort
# override, which is the model's own default.
EFFORT_CAPABLE = {"claude-sonnet-4-6"}
EFFORT_LEVELS = ["low", "medium", "high", "max"]


def resolve_model(selection: str) -> tuple[str, str | None]:
    """Split a model selection into (api_model_id, effort_or_None).

    "claude-sonnet-4-6:medium" -> ("claude-sonnet-4-6", "medium")
    "claude-haiku-4-5-20251001" -> ("claude-haiku-4-5-20251001", None)
    Unknown/missing suffix -> (selection, None) so legacy values still work.
    """
    if not selection:
        return selection, None
    base, sep, suffix = selection.rpartition(":")
    if sep and suffix in EFFORT_LEVELS and base in EFFORT_CAPABLE:
        return base, suffix
    return selection, None


def effort_kwargs(selection: str) -> dict:
    """Extra messages.create() kwargs for a model selection — the effort
    output_config when one is set, else empty. Pair with model=resolve_model(...)[0].

    NOTE: we intentionally do NOT enable `thinking` here. Adaptive/extended
    thinking requires temperature=1, but every AI call in this app uses
    temperature=0 for deterministic output — the two are mutually exclusive
    (the API 400s: "temperature may only be set to 1 when thinking is enabled").
    Effort works fine at temperature=0."""
    _, effort = resolve_model(selection)
    return {"output_config": {"effort": effort}} if effort else {}


def _short_label(model_id: str, effort: str | None) -> str:
    # e.g. "claude-sonnet-4-6" + "medium" -> "sonnet-4.6:medium"
    name = model_id.replace("claude-", "")
    name = name.replace("-4-6", "-4.6").replace("-4-5", "-4.5")
    # drop date snapshot suffix like "-20251001"
    parts = name.split("-")
    if parts and parts[-1].isdigit() and len(parts[-1]) == 8:
        name = "-".join(parts[:-1])
    return f"{name}:{effort}" if effort else name


def model_choices() -> list[dict]:
    """Selectable model+effort combinations for the settings dropdown. Each
    carries the base model's pricing so cost display keeps working."""
    out = []
    for model_id, pricing in MODELS.items():
        efforts = EFFORT_LEVELS if model_id in EFFORT_CAPABLE else [None]
        for effort in efforts:
            sel = f"{model_id}:{effort}" if effort else model_id
            out.append({
                "id": sel,
                "display": _short_label(model_id, effort),
                "input_per_1m": pricing["input_per_1m"],
                "output_per_1m": pricing["output_per_1m"],
            })
    return out


DEFAULT_MODEL = "claude-sonnet-4-6:medium"   # default for card generation
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
    the API); cache writes bill at 1.25x input price, cache reads at 0.1x.
    Accepts either a bare model id or a "model:effort" selection."""
    base, _, _ = (model or "").rpartition(":")
    pricing = MODELS.get(model) or MODELS.get(base, {})
    in_price = pricing.get("input_per_1m", 0)
    input_cost = (input_tokens / 1_000_000) * in_price
    cache_write_cost = (cache_write_tokens / 1_000_000) * in_price * 1.25
    cache_read_cost = (cache_read_tokens / 1_000_000) * in_price * 0.1
    output_cost = (output_tokens / 1_000_000) * pricing.get("output_per_1m", 0)
    return round(input_cost + cache_write_cost + cache_read_cost + output_cost, 6)
