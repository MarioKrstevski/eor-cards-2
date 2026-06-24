# Gemini Card Generation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the reviewer select a section, choose the `gemini-3.5-flash` model, click Generate, and get cloze cards produced by Google Gemini — while every other AI call stays on Claude.

**Architecture:** A thin provider-dispatch wrapper (`backend/services/llm.py:complete_text`) routes the ONE bulk card-generation call to Anthropic or Google based on the model id. The Anthropic path is byte-for-byte what runs today. Every other AI call passes its model through a new `anthropic_model()` coercion helper, so a Gemini selection can only ever change bulk generation output. Card output is plain pipe-delimited text, so no parser changes.

**Tech Stack:** FastAPI, `anthropic` SDK (existing), `google-genai` SDK (new), pytest.

**Spec:** `docs/superpowers/specs/2026-06-24-gemini-card-generation-design.md`

---

## Conventions for this plan

- Run Python from the project venv: `.venv/bin/python -m pytest ...`. If pytest isn't found there, the venv may be split — use `PYTHONPATH=. .venv/bin/python -m pytest`.
- Tests are **pure unit tests** that mock the SDK clients — they must run with NO API keys set. Real API verification is the final manual task.
- Tests live in a new `backend/tests/` package (none exist yet).
- This is a two-user internal MVP. Keep edits minimal; follow existing patterns.
- Commit after every task. Work on a branch: `git switch -c feat/gemini-card-generation` before Task 1.

## File Structure

- **Create** `backend/services/llm.py` — `complete_text()` provider dispatch (the only Gemini-aware code path).
- **Create** `backend/tests/__init__.py`, `backend/tests/test_config_models.py`, `backend/tests/test_llm.py`, `backend/tests/test_coercion_sites.py`.
- **Modify** `backend/config.py` — `GEMINI_API_KEY`, `MODELS["gemini-3.5-flash"]`, `provider_for()`, `anthropic_model()`.
- **Modify** `backend/services/ai_utils.py` — add `RetryableError`, append to `RETRYABLE_ERRORS`.
- **Modify** `backend/services/generator.py` — route `generate_cards_for_section` through `complete_text`; drop its `client` param.
- **Modify** `backend/routers/generate.py` — drop `client` arg at the generation call; coerce scoring + supplemental model; route the `debug-run` (inspect) endpoint through `complete_text` so Gemini works there for side-by-side comparison.
- **Modify** `backend/routers/cards.py` — coerce the selected model on all regenerate / fix-batch / parse / score call sites.
- **Modify** `requirements.txt` — add `google-genai`.

---

## Task 1: Config — provider helpers, Gemini model entry, API key

**Files:**
- Modify: `backend/config.py`
- Create: `backend/tests/__init__.py`, `backend/tests/test_config_models.py`

- [ ] **Step 1: Write failing tests**

Create `backend/tests/__init__.py` (empty file).

Create `backend/tests/test_config_models.py`:

```python
from backend.config import (
    MODELS, model_choices, compute_cost, provider_for, anthropic_model,
    DEFAULT_MODEL, EFFORT_CAPABLE,
)


def test_gemini_in_models():
    assert "gemini-3.5-flash" in MODELS
    assert MODELS["gemini-3.5-flash"]["input_per_1m"] > 0
    assert MODELS["gemini-3.5-flash"]["output_per_1m"] > 0


def test_gemini_has_no_effort_variants():
    # gemini must NOT be effort-capable, so the dropdown shows exactly one entry.
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
    # must strip an :effort suffix before matching
    assert provider_for("claude-sonnet-4-6:medium") == "anthropic"


def test_anthropic_model_coerces_gemini_only():
    assert anthropic_model("gemini-3.5-flash") == DEFAULT_MODEL
    assert anthropic_model("claude-sonnet-4-6:medium") == "claude-sonnet-4-6:medium"
    assert anthropic_model("claude-haiku-4-5-20251001") == "claude-haiku-4-5-20251001"
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_config_models.py -v`
Expected: FAIL — `ImportError`/`KeyError` for `provider_for`, `anthropic_model`, and the gemini model.

- [ ] **Step 3: Implement in `backend/config.py`**

Add the key near the other env reads (after `ANTHROPIC_API_KEY`):

```python
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
```

Add to the `MODELS` dict (after the `claude-sonnet-4-5` entry, before the closing brace):

```python
    # Google Gemini — only honored for the bulk card-generation call (see
    # services/llm.py). Pricing is a best-estimate for Flash and is editable;
    # cost display is informational for this MVP. If Google's API expects a
    # different id string, change ONLY this key.
    "gemini-3.5-flash": {
        "display": "Gemini 3.5 Flash",
        "input_per_1m": 0.30,
        "output_per_1m": 2.50,
    },
```

Add these helpers near `resolve_model` (after it):

```python
def provider_for(selection: str) -> str:
    """Which SDK a model selection routes to. Strips any :effort suffix first."""
    base, _ = resolve_model(selection or "")
    return "google" if base.startswith("gemini") else "anthropic"


def anthropic_model(selection: str) -> str:
    """Coerce a selection to a Claude model for every call EXCEPT bulk card
    generation. A Gemini selection becomes DEFAULT_MODEL; Claude passes through.
    This is the single chokepoint that keeps forced-tool-call and editing paths
    on Anthropic."""
    return selection if provider_for(selection) == "anthropic" else DEFAULT_MODEL
```

Note: `anthropic_model` references `DEFAULT_MODEL`, which is defined further down the file. Since `anthropic_model` is only *called* at runtime (not at import), placement is fine, but to be safe place these helpers AFTER the `DEFAULT_MODEL = ...` line, or keep them where `resolve_model` is and rely on module-level name resolution at call time (both work). Prefer placing them immediately after `DEFAULT_MODEL` is assigned.

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest backend/tests/test_config_models.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/config.py backend/tests/__init__.py backend/tests/test_config_models.py
git commit -m "feat: add gemini-3.5-flash model + provider_for/anthropic_model helpers"
```

---

## Task 2: Shared retryable error type

**Files:**
- Modify: `backend/services/ai_utils.py`
- Test: `backend/tests/test_config_models.py` (append) — trivial, or skip a dedicated test.

- [ ] **Step 1: Implement in `backend/services/ai_utils.py`**

Add a provider-agnostic retryable error and include it in the tuple the generation loop catches:

```python
class RetryableError(Exception):
    """Provider-agnostic transient error. The Gemini path in llm.py re-raises
    Google's transient (429/5xx/connection) errors as this so the existing
    RETRYABLE_ERRORS retry loop catches them without importing google SDK
    error classes into Anthropic call sites."""
```

Then change the `RETRYABLE_ERRORS` tuple to include it:

```python
RETRYABLE_ERRORS = (
    anthropic.RateLimitError,
    anthropic.APIConnectionError,
    anthropic.InternalServerError,
    RetryableError,
)
```

(Define `RetryableError` ABOVE the `RETRYABLE_ERRORS` assignment.)

- [ ] **Step 2: Verify import still works**

Run: `.venv/bin/python -c "from backend.services.ai_utils import RETRYABLE_ERRORS, RetryableError; print(RetryableError in RETRYABLE_ERRORS)"`
Expected: prints `True`.

- [ ] **Step 3: Commit**

```bash
git add backend/services/ai_utils.py
git commit -m "feat: add provider-agnostic RetryableError to RETRYABLE_ERRORS"
```

---

## Task 3: The `complete_text` provider wrapper

**Files:**
- Create: `backend/services/llm.py`
- Create: `backend/tests/test_llm.py`

- [ ] **Step 1: Write failing tests** (`backend/tests/test_llm.py`)

The Anthropic branch is mocked at the `anthropic.Anthropic` client; the Google branch is mocked at the `google.genai.Client`. No real keys needed. `google-genai` may not be installed yet — guard that test with an importorskip so this task isn't blocked by Task 7's dependency install (the Google branch is re-verified in the manual task).

```python
import types
import pytest
from unittest.mock import MagicMock, patch

from backend.services import llm


def _fake_anthropic_response():
    block = types.SimpleNamespace(type="text", text="1|{{c1::term}} card.|")
    usage = types.SimpleNamespace(
        input_tokens=10, output_tokens=5,
        cache_read_input_tokens=0, cache_creation_input_tokens=0,
    )
    return types.SimpleNamespace(content=[block], usage=usage, stop_reason="end_turn")


def test_anthropic_branch_returns_text_usage_stop_reason():
    fake_client = MagicMock()
    fake_client.messages.create.return_value = _fake_anthropic_response()
    with patch.object(llm.anthropic, "Anthropic", return_value=fake_client):
        text, usage, stop = llm.complete_text(
            "claude-sonnet-4-6:medium", "SYS", "USER",
            temperature=0, max_tokens=8192,
        )
    assert text == "1|{{c1::term}} card.|"
    assert usage["input_tokens"] == 10 and usage["output_tokens"] == 5
    assert stop == "end_turn"
    # system was sent as a cache_control block; user as a message
    kwargs = fake_client.messages.create.call_args.kwargs
    assert kwargs["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert kwargs["model"] == "claude-sonnet-4-6"  # effort suffix resolved off
    assert kwargs["temperature"] == 0


def test_anthropic_branch_passes_through_max_tokens_stop_reason():
    resp = _fake_anthropic_response()
    resp.stop_reason = "max_tokens"
    fake_client = MagicMock()
    fake_client.messages.create.return_value = resp
    with patch.object(llm.anthropic, "Anthropic", return_value=fake_client):
        _, _, stop = llm.complete_text(
            "claude-sonnet-4-6", "SYS", "USER", temperature=0, max_tokens=8192,
        )
    assert stop == "max_tokens"  # wrapper does NOT raise; caller decides


def test_google_branch_maps_response():
    genai = pytest.importorskip("google.genai")  # skip until google-genai installed
    fake_resp = types.SimpleNamespace(
        text="1|{{c1::gem}} card.|",
        candidates=[types.SimpleNamespace(finish_reason="STOP")],
        usage_metadata=types.SimpleNamespace(
            prompt_token_count=12, candidates_token_count=7,
        ),
    )
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = fake_resp
    with patch.object(llm.genai, "Client", return_value=fake_client):
        text, usage, stop = llm.complete_text(
            "gemini-3.5-flash", "SYS", "USER", temperature=0, max_tokens=8192,
        )
    assert text == "1|{{c1::gem}} card.|"
    assert usage["input_tokens"] == 12 and usage["output_tokens"] == 7
    assert usage["cache_read_input_tokens"] == 0
    assert stop == "end_turn"


def test_google_branch_normalizes_truncation():
    pytest.importorskip("google.genai")
    fake_resp = types.SimpleNamespace(
        text="1|partial",
        candidates=[types.SimpleNamespace(finish_reason="MAX_TOKENS")],
        usage_metadata=types.SimpleNamespace(prompt_token_count=12, candidates_token_count=7),
    )
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = fake_resp
    with patch.object(llm.genai, "Client", return_value=fake_client):
        _, _, stop = llm.complete_text(
            "gemini-3.5-flash", "SYS", "USER", temperature=0, max_tokens=8192,
        )
    assert stop == "max_tokens"
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_llm.py -v`
Expected: FAIL — `ModuleNotFoundError: backend.services.llm` (Google tests may skip).

- [ ] **Step 3: Implement `backend/services/llm.py`**

```python
"""Provider dispatch for the ONE bulk card-generation call. Claude path is the
exact call generator.py used before; Gemini path is the only Google-aware code.
Output is plain text (pipe-delimited cards) — no structured/tool output here."""
from __future__ import annotations
import logging

import anthropic
from google import genai
from google.genai import types as genai_types
from google.genai import errors as genai_errors

from backend.config import (
    ANTHROPIC_API_KEY, GEMINI_API_KEY, provider_for, resolve_model, effort_kwargs,
)
from backend.services.ai_utils import usage_dict, RetryableError

logger = logging.getLogger(__name__)


def complete_text(model, system_text, user_text, *, temperature, max_tokens):
    """Run one text completion. Returns (text, usage_dict, stop_reason).

    Does NOT raise on truncation — returns stop_reason == "max_tokens" and lets
    the caller decide (so generator.py keeps its retry-then-raise behavior).
    Transient errors are raised as RetryableError so the existing retry loop
    catches them regardless of provider.
    """
    if provider_for(model) == "google":
        return _complete_google(model, system_text, user_text, temperature, max_tokens)
    return _complete_anthropic(model, system_text, user_text, temperature, max_tokens)


def _complete_anthropic(model, system_text, user_text, temperature, max_tokens):
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    response = client.messages.create(
        model=resolve_model(model)[0],
        **effort_kwargs(model),
        max_tokens=max_tokens,
        temperature=temperature,
        system=[{
            "type": "text",
            "text": system_text,
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{"role": "user", "content": user_text}],
    )
    text = next((b.text for b in response.content if b.type == "text"), "")
    return text, usage_dict(response), response.stop_reason


def _complete_google(model, system_text, user_text, temperature, max_tokens):
    client = genai.Client(api_key=GEMINI_API_KEY)
    base = resolve_model(model)[0]
    try:
        response = client.models.generate_content(
            model=base,
            contents=user_text,
            config=genai_types.GenerateContentConfig(
                system_instruction=system_text,
                temperature=temperature,
                max_output_tokens=max_tokens,
            ),
        )
    except genai_errors.APIError as e:
        # 429 / 5xx / transient → let the existing retry loop handle it.
        code = getattr(e, "code", None) or getattr(e, "status_code", None)
        if code in (429, 500, 502, 503, 504, 529):
            raise RetryableError(f"Gemini transient error {code}: {e}") from e
        raise

    finish = ""
    if getattr(response, "candidates", None):
        finish = str(getattr(response.candidates[0], "finish_reason", "") or "")
    stop_reason = "max_tokens" if "MAX_TOKENS" in finish.upper() else "end_turn"

    um = getattr(response, "usage_metadata", None)
    usage = {
        "input_tokens": getattr(um, "prompt_token_count", 0) or 0,
        "output_tokens": getattr(um, "candidates_token_count", 0) or 0,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
    }
    # `response.text` is a convenience accessor that, in recent google-genai
    # versions, can raise/warn when the candidate was truncated or blocked
    # (empty parts). Access it defensively so a truncated Gemini result still
    # returns partial text + stop_reason rather than throwing.
    try:
        text = response.text or ""
    except Exception:
        parts = []
        for c in (getattr(response, "candidates", None) or []):
            for p in (getattr(getattr(c, "content", None), "parts", None) or []):
                t = getattr(p, "text", None)
                if t:
                    parts.append(t)
        text = "".join(parts)
    return text, usage, stop_reason
```

> Note: `google-genai`'s exact error class / attribute names should be confirmed against the installed version during Task 7; adjust the `except` clause if the import path differs. The Anthropic branch and all tests that don't import google still pass regardless.

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest backend/tests/test_llm.py -v`
Expected: Anthropic tests PASS; Google tests SKIP if `google-genai` not yet installed (re-run after Task 7).

- [ ] **Step 5: Commit**

```bash
git add backend/services/llm.py backend/tests/test_llm.py
git commit -m "feat: add complete_text provider wrapper (anthropic + gemini)"
```

---

## Task 4: Route `generate_cards_for_section` through the wrapper

**Files:**
- Modify: `backend/services/generator.py:414-461`
- Test: `backend/tests/test_llm.py` (append a generator integration test)

- [ ] **Step 1: Write failing test** (append to `backend/tests/test_llm.py`)

```python
from unittest.mock import patch as _patch
from backend.services import generator
from backend.services.ai_utils import OutputTruncated


def test_generate_cards_uses_complete_text_and_parses():
    section = {"heading": "Headaches", "content_text": "Migraine is unilateral.",
               "curriculum_topic_path": "Neuro > Headache"}
    with _patch.object(generator, "complete_text",
                       return_value=("1|{{c1::Migraine}} is unilateral.|", {
                           "input_tokens": 3, "output_tokens": 4,
                           "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
                       }, "end_turn")) as m:
        cards, needs_review, usage = generator.generate_cards_for_section(
            section, "RULES", "gemini-3.5-flash",
        )
    assert len(cards) == 1 and "{{c1::Migraine}}" in cards[0]["front_html"]
    assert usage["output_tokens"] == 4
    # first attempt uses the 8192 cap
    assert m.call_args.kwargs["max_tokens"] == 8192


def test_generate_cards_raises_on_persistent_truncation():
    section = {"heading": "X", "content_text": "y"}
    with _patch.object(generator, "complete_text",
                       return_value=("1|partial", {"input_tokens": 1, "output_tokens": 1,
                                     "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
                                     "max_tokens")):
        with pytest.raises(OutputTruncated):
            generator.generate_cards_for_section(section, "RULES", "gemini-3.5-flash")
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_llm.py -k generate_cards -v`
Expected: FAIL — `generate_cards_for_section` still requires a `client` positional arg / has no `complete_text`.

- [ ] **Step 3: Edit `backend/services/generator.py`**

At the top imports, add `complete_text` and `OutputTruncated`:

```python
from backend.services.ai_utils import CLOZE_RE, response_text, usage_dict, OutputTruncated
from backend.services.llm import complete_text
```

Replace the body of `generate_cards_for_section` (currently lines ~414-461). New signature drops `client`:

```python
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
```

Leave `regenerate_single_card` UNCHANGED (it keeps its `client` param and Anthropic call — it is never reached with Gemini because callers coerce the model in Task 6). The `import anthropic` line stays (still used by `regenerate_single_card`'s type hint and call).

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest backend/tests/test_llm.py -k generate_cards -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/services/generator.py backend/tests/test_llm.py
git commit -m "feat: route generate_cards_for_section through complete_text wrapper"
```

---

## Task 5: Update the generation job + coerce scoring/supplemental in `generate.py`

**Files:**
- Modify: `backend/routers/generate.py` (lines ~489, ~641, ~672, ~817)

- [ ] **Step 1: Add the import**

In `backend/routers/generate.py`, extend the config import (line 16/20) to include `anthropic_model`:

```python
from backend.config import resolve_model, effort_kwargs, anthropic_model
```

- [ ] **Step 2: Drop the `client` arg at the generation call (line ~489)**

`generate_cards_for_section` no longer takes a client. Change:

```python
                    cards_data, needs_review, usage = generate_cards_for_section(
                        client,
                        section_data,
                        rules_text,
                        model,
                    )
```
to:
```python
                    cards_data, needs_review, usage = generate_cards_for_section(
                        section_data,
                        rules_text,
                        model,
                    )
```

The `client = anthropic.Anthropic(...)` constructed earlier in the job STAYS — it is still used by `score_cards` below.

- [ ] **Step 3: Coerce the scoring model (lines ~641 and ~672)**

In BOTH `score_cards(client, cards_for_scoring, ..., model)` calls, replace the `model` argument with `anthropic_model(model)`:

```python
                        scores, score_usage = score_cards(
                            client,
                            cards_for_scoring,
                            section_data.get("curriculum_topic_path", ""),
                            anthropic_model(model),
                        )
```

(Do this for the second occurrence too.)

- [ ] **Step 4: Coerce the supplemental model (line ~817)**

```python
                    return generate_supplemental_for_group(
                        client, topic_path, group_cards, rules_text, anthropic_model(model)
                    )
```

And for the supplemental usage log/cost at lines ~877-884, change `compute_cost(model, ...)` and the logged `model=` to `anthropic_model(model)` so cost is attributed to the model that actually ran:

```python
                    model=anthropic_model(model),
                    ...
                    cost_usd=compute_cost(anthropic_model(model), u["input"], u["output"], u["cw"], u["cr"]),
```

Leave the **card_generation** usage log at lines ~698-705 using the raw `model` — generation genuinely ran on the selected (possibly Gemini) model, so the cost attribution there is correct.

> Known, accepted: `_acc_section` folds the per-section *scoring* tokens (which ran on Claude) into the same bucket that's logged once as `card_generation` priced at the generation model. So with Gemini selected, the logged Gemini cost for a section includes its Claude scoring tokens priced at Gemini rates. Cost is informational for this MVP — no change; noted so it isn't surprising.

- [ ] **Step 5: Verify the app imports and the existing test suite passes**

Run: `.venv/bin/python -c "import backend.routers.generate"`
Expected: no error.
Run: `.venv/bin/python -m pytest backend/tests -v`
Expected: PASS (Google tests may skip).

- [ ] **Step 6: Commit**

```bash
git add backend/routers/generate.py
git commit -m "feat: drop client arg at generation call; coerce scoring/supplemental to Claude"
```

---

## Task 5b: Enable Gemini in the inspect/debug-run endpoint (side-by-side compare)

**Why:** The inspect-prompt UI (`CardsPanel.tsx`) lets the reviewer run one section's generation prompt against multiple selected models and compare raw outputs side by side. Its model picker is populated from `/generate/models` (`model_choices()`), so Gemini already appears there once Task 1 lands — **no frontend change needed**. But the backend `debug-run` endpoint does a direct Anthropic `messages.create`, which would 404 on a Gemini id. Route it through `complete_text`.

**Files:**
- Modify: `backend/routers/generate.py:99-147` (`debug_run`)

- [ ] **Step 1: Add the import** (if not already present from Task 5)

Ensure `from backend.services.llm import complete_text` is imported in `generate.py` (add it near the other service imports if absent).

- [ ] **Step 2: Replace the Anthropic call in `debug_run` (lines ~110-119)**

Replace:

```python
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    response = client.messages.create(
        model=resolve_model(body.model)[0],
        **effort_kwargs(body.model),
        max_tokens=16384,
        temperature=0,
        system=[{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user_text}],
    )
    raw = response_text(response)
    usage = usage_dict(response)
```

with:

```python
    # Route through the provider wrapper so Gemini can be compared side-by-side.
    # Unlike generation, the debug tool SHOWS truncated output (it does not raise)
    # so the reviewer can see exactly what each model returned.
    raw, usage, stop_reason = complete_text(
        body.model, system_text, user_text, temperature=0, max_tokens=16384,
    )
```

Then update the return to use `stop_reason` (the local var) instead of `response.stop_reason`:

```python
    return {
        "model": body.model,
        "raw_response": raw,
        "stop_reason": stop_reason,
        "usage": usage,
        "cost_usd": cost,
    }
```

The `cost`/`AIUsageLog` block in between is unchanged: it keeps `model=body.model` and `compute_cost(body.model, ...)` — debug-run genuinely runs on the selected model (Gemini or Claude), so attributing cost to `body.model` is correct. The removed `client = anthropic.Anthropic(...)` line is no longer needed in this function.

> Note: `response_text` and `usage_dict` may now be unused *in this function* but are still imported/used elsewhere in `generate.py` — do NOT remove the imports.

- [ ] **Step 3: Verify import + behavior**

Run: `.venv/bin/python -c "import backend.routers.generate"`
Expected: no error.
Run: `.venv/bin/python -m pytest backend/tests -v`
Expected: still green.

- [ ] **Step 4: Commit**

```bash
git add backend/routers/generate.py
git commit -m "feat: route inspect/debug-run through complete_text (Gemini side-by-side compare)"
```

---

## Task 6: Coerce the selected model everywhere in `cards.py`

**Goal:** Guarantee no Gemini selection reaches a raw `anthropic.Anthropic` client or a forced tool call in `cards.py`. The rule: in EVERY handler that makes an AI call with `body.model`, define a local `model = anthropic_model(body.model)` at the top and use that local everywhere (the AI call, `compute_cost`, and the usage-log `model=`).

**Sensitive AI calls in `cards.py` (all forced-tool-call or direct `messages.create` — verified by line):**

| Handler | Line(s) | AI call(s) using the selected model |
|---|---|---|
| `regenerate_card` (~330) | 340/351/363/366 | `regenerate_single_card`, log, `compute_cost` |
| `combine_preview` (~399) | 416/435/438 | direct `messages.create`, log, `compute_cost` |
| `combine_apply` (~452) | 486/514/519/522 | `score_new_cards`, log, `compute_cost` |
| `bulk_score_cards` (~597) | **601**/644/653/655 | `score_cards` (forced tool), log, `compute_cost` |
| `apply_fix_batch` (~683) | 735/776/791/792/799/832/931/934 | `judge_cards`, `regenerate_single_card`, `split_card`, log, `compute_cost` |
| `add_manual_cards` (~1035) | 1084/1147/1153 | `parse_pasted_cards`, log, `compute_cost` |

> **Blocker fix (was missed in an earlier draft):** `bulk_score_cards` (the Actions → Score Cards endpoint) sets `model_name = body.model` at **line 601** and feeds it to the forced-tool-call `score_cards` (644). Coerce there: `model_name = anthropic_model(body.model)` — the cleanest single-line fix in the file, since the handler already funnels everything through `model_name`.

**Files:**
- Modify: `backend/routers/cards.py`
- Test: `backend/tests/test_coercion_sites.py`

- [ ] **Step 1: Add the import**

Extend the config import in `backend/routers/cards.py` to include `anthropic_model` (it already imports `resolve_model, effort_kwargs, compute_cost` from `backend.config`).

- [ ] **Step 2: Apply coercion in each handler from the table**

In each of the six handlers, add `model = anthropic_model(body.model)` (or, in `bulk_score_cards`, change line 601 to `model_name = anthropic_model(body.model)`) at the top of the handler, then replace every subsequent `body.model` *within that handler* with the local `model`. This covers the AI call, the `compute_cost(...)`, and the usage-log `model=` in one move.

> Keep the `anthropic.Anthropic(...)` client constructions as-is — they are correct once the model is Claude. Do NOT touch non-AI uses of `body.model` if any (there are none in these handlers — every `body.model` here feeds an AI call, cost, or log that should reflect the model that actually ran = Claude).

- [ ] **Step 3: Write a call-aware guard test** (`backend/tests/test_coercion_sites.py`)

A line-by-line scan misses these sites because the call name and the `body.model` argument sit on *different* lines (e.g. `regenerate_single_card(` on 340, `model=body.model` on 351). This test instead asserts the file contains **no `body.model` token at all** outside of an `anthropic_model(body.model)` wrapper and the field-set check — a coarse but reliable guard that a forced-tool path can never receive a raw selection:

```python
import re
from pathlib import Path

CARDS = Path("backend/routers/cards.py").read_text()


def test_body_model_only_appears_coerced():
    """Every `body.model` use must be wrapped in anthropic_model(...).
    The one allowed bare use is `body.model_fields_set` (a pydantic attr, not
    the model id)."""
    # Strip the legitimate, fully-coerced pattern and the pydantic attr, then
    # assert nothing remains.
    text = CARDS
    text = text.replace("anthropic_model(body.model)", "")
    text = re.sub(r"body\.model_fields_set", "", text)
    leftover = re.findall(r"body\.model\b", text)
    assert leftover == [], (
        f"{len(leftover)} un-coerced `body.model` use(s) remain in cards.py — "
        "wrap each in anthropic_model(...)"
    )
```

This catches issue #1 (bulk-score) and any future regression regardless of line layout. (Note: it requires each coerced site to literally read `anthropic_model(body.model)`. If you used a local `model = anthropic_model(body.model)` and then `model` everywhere, that ALSO passes — the only `body.model` token left is inside the `anthropic_model(...)` call, which the test strips.)

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest backend/tests/test_coercion_sites.py -v`
Expected: PASS. If it fails, it reports the count of un-coerced `body.model` uses — find and wrap each.
Then: `.venv/bin/python -c "import backend.routers.cards"` → no error.

- [ ] **Step 5: Commit**

```bash
git add backend/routers/cards.py backend/tests/test_coercion_sites.py
git commit -m "feat: coerce selected model to Claude on all cards.py AI call sites (incl. bulk-score)"
```

---

## Task 7: Add the dependency and install

**Files:**
- Modify: `requirements.txt`

- [ ] **Step 1: Add to `requirements.txt`** (after the `anthropic` line)

```
google-genai>=1.0.0
```

- [ ] **Step 2: Install into the venv**

Run: `.venv/bin/python -m pip install "google-genai>=1.0.0"`
Expected: installs `google-genai` and its deps.

- [ ] **Step 3: Confirm the import + run the full suite (Google tests now active)**

Run: `.venv/bin/python -c "from google import genai; from google.genai import types, errors; print('ok')"`
Expected: `ok`. If `errors`/attribute names differ, adjust `backend/services/llm.py`'s `except` clause and re-run.

**Confirm the assumed SDK surface against the installed version** (the wrapper depends on these — adjust `llm.py` if any differ):
- `genai.Client(api_key=...)` and `client.models.generate_content(model=, contents=, config=...)`.
- `genai.types.GenerateContentConfig(system_instruction=, temperature=, max_output_tokens=)`.
- `response.usage_metadata.prompt_token_count` / `.candidates_token_count`.
- `response.candidates[0].finish_reason` (string or enum — the `"MAX_TOKENS" in finish.upper()` check tolerates both).
- `genai.errors.APIError` and its status attribute (commonly `.code`; the most likely thing to need a tweak in `_complete_google`'s `except`).

Quick smoke (with the real key set) to lock the surface:
```bash
GEMINI_API_KEY=... .venv/bin/python -c "from backend.services.llm import complete_text; print(complete_text('gemini-3.5-flash','You output one line.','Say: 1|{{c1::hi}}|',temperature=0,max_tokens=64))"
```
Expected: a `(text, usage, stop_reason)` tuple with non-zero token counts.
Run: `.venv/bin/python -m pytest backend/tests -v`
Expected: ALL pass, including the previously-skipped Google branch tests.

- [ ] **Step 4: Commit**

```bash
git add requirements.txt
git commit -m "build: add google-genai dependency"
```

---

## Task 8: Manual end-to-end verification (the acceptance bar)

This is the must-pass the reviewer cares about: **select a section → pick Gemini → Generate → cards appear.** Requires a real `GEMINI_API_KEY`.

- [ ] **Step 1: Set the key**

Add to `.env`: `GEMINI_API_KEY=...` (the reviewer's key).

- [ ] **Step 2: Start backend and frontend**

```bash
PYTHONPATH=. .venv/bin/uvicorn backend.main:app --reload   # :8000
cd frontend && npm run dev                                  # :5173
```

- [ ] **Step 3: Confirm the model is selectable**

Open the app, open Settings → the model dropdown shows **Gemini 3.5 Flash** (exactly one entry, no effort variants). Select it.

- [ ] **Step 4: Generate**

Pick a section (H2) in the sidebar, click **Generate**. Expected:
- Job runs and completes (`status: done`).
- Cards appear in the table, well-formed (cloze `{{c1::...}}`, pipe parsing intact).
- Scoring still populates accuracy/yield (this ran on Claude via coercion).
- No job error referencing a 404/invalid model.

- [ ] **Step 5: Confirm provider routing via usage log**

Check `GET /api/usage` (or the Usage modal): the `card_generation` operation for that run is logged under `gemini-3.5-flash`; the scoring/`card_generation`-blended cost is sane. If the job failed instantly with `actual_input_tokens: 0`, re-check the model id string and the `google-genai` error mapping.

- [ ] **Step 6: Inspect / side-by-side compare**

On a section, open **Inspect prompt**. In the model picker, select BOTH a Claude model and **Gemini 3.5 Flash**, run. Expected: both columns return raw `number|card|extra` output side by side; the Gemini column is populated (not an error). Optionally click **Apply** on the Gemini column and confirm cards are created (parsed by the pipe parser; any scoring runs on Claude).

- [ ] **Step 7: Regression — generate with a Claude model still works**

Switch back to a Claude model, generate another section, confirm unchanged behavior.

- [ ] **Step 8: Final commit / wrap-up**

If `.env` was the only remaining change, do NOT commit the key. Summarize results. Consider `@superpowers:finishing-a-development-branch` to merge.

---

## Done when

- The Settings dropdown AND the Inspect-prompt model picker offer Gemini 3.5 Flash.
- Selecting it and generating a section produces cards via Gemini.
- Inspect-prompt runs Claude and Gemini side by side for the same section.
- Scoring, regenerate, fix-batch, supplementals, and vision/dedup all still run on Claude (no forced-tool-call path ever hits Gemini).
- `.venv/bin/python -m pytest backend/tests` is green.
