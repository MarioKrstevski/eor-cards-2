from backend.config import (
    MODELS, model_choices, compute_cost, provider_for, anthropic_model,
    DEFAULT_MODEL, EFFORT_CAPABLE,
)


def test_gemini_in_models():
    assert "gemini-3.5-flash" in MODELS
    assert MODELS["gemini-3.5-flash"]["input_per_1m"] > 0
    assert MODELS["gemini-3.5-flash"]["output_per_1m"] > 0


def test_gemini_has_no_effort_variants():
    assert "gemini-3.5-flash" not in EFFORT_CAPABLE
    gemini_choices = [c for c in model_choices() if c["id"].startswith("gemini")]
    assert [c["id"] for c in gemini_choices] == ["gemini-3.5-flash"]


def test_compute_cost_for_gemini():
    cost = compute_cost("gemini-3.5-flash", 1_000_000, 1_000_000)
    expected = MODELS["gemini-3.5-flash"]["input_per_1m"] + MODELS["gemini-3.5-flash"]["output_per_1m"]
    assert round(cost, 6) == round(expected, 6)


def test_provider_for():
    assert provider_for("gemini-3.5-flash") == "google"
    assert provider_for("claude-sonnet-4-6") == "anthropic"
    assert provider_for("claude-sonnet-4-6:medium") == "anthropic"


def test_anthropic_model_coerces_gemini_only():
    assert anthropic_model("gemini-3.5-flash") == DEFAULT_MODEL
    assert anthropic_model("claude-sonnet-4-6:medium") == "claude-sonnet-4-6:medium"
    assert anthropic_model("claude-haiku-4-5-20251001") == "claude-haiku-4-5-20251001"
