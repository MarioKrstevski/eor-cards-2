# Design: Add Google Gemini (gemini-3.5-flash) for card generation only

**Date:** 2026-06-24
**Status:** Approved (pending implementation)
**Scope:** Make `gemini-3.5-flash` selectable as the model for the per-section
card-generation call. Nothing else (scoring, vignettes/teaching cases, vision
classification, dedup, heading detection) changes provider — all stay on Claude.

## Motivation

The reviewer noticed Gemini Flash produces good flashcard results and wants to
test it on real sections. The app is built entirely on the `anthropic.Anthropic`
SDK and Anthropic-specific behaviors (forced tool calls, `cache_control`
ephemeral caching, `stop_reason == "max_tokens"`, the `effort` param, cache-aware
usage extraction), so adding Gemini is a real integration, not a `MODELS`-dict
entry. We confine the integration to the one place Gemini is wanted — card
generation — and leave every proven Claude path untouched.

## Constraints / context

- Two-user MVP, no auth. Cost display is informational.
- Card-generation output is **plain pipe-delimited text**
  (`number|card text|extra|source:...`), parsed by `parse_card_output`. It is NOT
  a tool call, so no structured-output translation is needed for Gemini.
- The model selection string (e.g. `claude-sonnet-4-6:medium`) is already plumbed
  through generation jobs as `model` and surfaced in Settings via
  `model_choices()` built from the `MODELS` dict.
- **Risk found during design:** per-section scoring runs on the *same* `model` as
  generation (`score_cards(client, …, model)` in `generate.py` ~lines 637/668)
  and uses a forced Anthropic tool call (`submit_scores`). Selecting Gemini for
  generation would otherwise drag scoring onto Gemini and break it. The design
  routes scoring back to Claude whenever the generation model is Gemini.

## Approach chosen

**Native `google-genai` SDK behind a thin provider-dispatch wrapper.**
Rejected alternatives: OpenAI-compatible endpoint via `openai` SDK (less faithful
usage/token reporting for a Google model); LiteLLM unified SDK (changes the
working Claude call shape too, overkill for a single call site). The chosen
approach quarantines the new provider in one module and leaves the Claude
pipeline byte-for-byte unchanged.

## Components

### 1. Dependency & config

- `requirements.txt`: add `google-genai`.
- `backend/config.py`:
  - Read `GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")`.
  - Add to `MODELS`:
    ```python
    "gemini-3.5-flash": {
        "display": "Gemini 3.5 Flash",
        "input_per_1m": <flash-input-estimate>,   # editable; informational
        "output_per_1m": <flash-output-estimate>,
    },
    ```
    Pricing values are best-estimate Flash rates, clearly commented as editable.
  - Add a provider helper, e.g. `def provider_for(model: str) -> str:` returning
    `"google"` if the (base) id starts with `gemini`, else `"anthropic"`.
- The model id is centralized so if Google's API expects a different string than
  `gemini-3.5-flash`, it is a one-line change in `MODELS`.
- `model_choices()` lists Gemini automatically with no effort variants
  (`gemini-3.5-flash` is not in `EFFORT_CAPABLE`). `effort_kwargs` returns `{}` for
  it. `compute_cost` works unchanged (keyed by model id, with the existing
  `:effort` suffix stripping).

### 2. `backend/services/llm.py` (new)

Single uniform entry point used by `generator.py`:

```
complete_text(model, system_text, user_text, *, temperature, max_tokens)
    -> (text: str, usage: dict, stop_reason: str)
```

- **Anthropic branch** (`provider_for(model) == "anthropic"`): constructs the
  same call `generator.py` makes today —
  `client.messages.create(model=resolve_model(model)[0], **effort_kwargs(model),
  max_tokens=…, temperature=…, system=[{type:text, text:system_text,
  cache_control:{type:ephemeral}}], messages=[{role:user, content:user_text}])`.
  Returns the text block, `usage_dict(response)`, and `response.stop_reason`.
  Client constructed from `ANTHROPIC_API_KEY`.
- **Google branch**: `google.genai` client from `GEMINI_API_KEY`,
  `generate_content(model=<base id>, contents=user_text,
  config={system_instruction: system_text, temperature, max_output_tokens:
  max_tokens})`. Maps `usage_metadata` → the same `usage` dict shape
  (`input_tokens`, `output_tokens`, `cache_read_input_tokens: 0`,
  `cache_creation_input_tokens: 0`). Normalizes `finish_reason == MAX_TOKENS`
  → `stop_reason = "max_tokens"`, otherwise `"end_turn"`, so callers' truncation
  logic is provider-agnostic.
- **Retry translation:** Gemini transient errors (HTTP 429 / 5xx / connection)
  are re-raised as the shared retryable error type the generation loop already
  catches, so backoff behavior is unchanged. (Either extend `RETRYABLE_ERRORS`
  in `ai_utils.py` to include the relevant `google.genai` error classes, or wrap
  them — implementation detail for the plan.)

Note: no Anthropic prompt caching on the Gemini path. Flash is cheap; acceptable.

### 3. `backend/services/generator.py`

- `generate_cards_for_section` and `regenerate_single_card` call
  `llm.complete_text(...)` instead of taking and using a raw `anthropic.Anthropic`
  client. They keep their existing logic:
  - Truncation-retry loop (`for max_tokens in (8192, 16384)`) driven by the
    returned `stop_reason == "max_tokens"`.
  - `parse_card_output` and all validation untouched.
- The two functions no longer take a `client` parameter. The ~6 call sites
  (`generate.py`, `cards.py`) drop that argument (mechanical). Any
  `anthropic.Anthropic(...)` construction lines that become unused *for
  generation* are removed only if not used for anything else nearby.

### 4. Scoring stays on Claude (safety wire)

- In the generation job (`generate.py`), compute a scoring model:
  `score_model = model if provider_for(model) == "anthropic" else DEFAULT_MODEL`.
  Pass `score_model` to `score_cards`, which keeps using the already-constructed
  `anthropic.Anthropic` client. The forced `submit_scores` tool call is unaffected.
- Apply the same guard to any other forced-tool-call path that reads the user's
  selected model (scorer bulk-score, supplemental generator): if the selected
  model is Gemini, fall back to `DEFAULT_MODEL` (Claude). This guarantees a Gemini
  selection can never route a tool-call path to Google. (Supplementals are out of
  the requested scope; this is a defensive fallback, not a feature.)

### 5. Frontend

No changes. Gemini appears in the existing Settings model dropdown (driven by
`/api/generate/models` → `model_choices()`). The selection flows through the
generation job as `model` exactly like a Claude selection.

## Data flow (card generation with Gemini selected)

1. User selects `gemini-3.5-flash` in Settings → stored in `SettingsContext`.
2. Start generation → job created with `model = "gemini-3.5-flash"`.
3. `process_section` → `generate_cards_for_section(section_data, rules_text,
   model)` → `llm.complete_text` → Google branch → plain pipe text.
4. `parse_card_output` → cards saved (unchanged).
5. Scoring: `score_model = DEFAULT_MODEL` (Claude) → `score_cards` on the
   Anthropic client → scores saved (unchanged).
6. Usage/cost: Gemini usage dict → `compute_cost("gemini-3.5-flash", …)` using
   the `MODELS` pricing.

## Error handling

- Gemini transient errors → shared retryable type → existing 20/40/80s backoff,
  4 attempts.
- Gemini truncation (`MAX_TOKENS`) → normalized `stop_reason` → existing
  retry-at-higher-cap loop; a still-truncated result is refused (not committed),
  matching current behavior.
- Missing `GEMINI_API_KEY` when a Gemini model is selected → clear startup/first-
  call error surfaced to the job's `error_message` (one failed section does not
  abort the whole job, per existing behavior).
- Auth/permission errors on the Anthropic scoring path are unchanged.

## Testing

- Unit: `provider_for()` mapping; `MODELS`/`model_choices()` includes Gemini with
  no effort variants; `compute_cost("gemini-3.5-flash", …)` returns expected
  numbers.
- Unit: `llm.complete_text` Google branch maps a stubbed `generate_content`
  response (usage_metadata + finish_reason) to the normalized
  `(text, usage, stop_reason)` shape; MAX_TOKENS → `"max_tokens"`.
- Unit: scoring-model selection picks `DEFAULT_MODEL` when `model` is Gemini and
  the selected Claude model otherwise.
- Integration (manual, requires key): run a real section through generation with
  `gemini-3.5-flash`, confirm cards parse and save, scoring runs on Claude, cost
  logged.

## Out of scope (explicitly)

- Gemini for scoring, vignettes/teaching cases, vision classification, dedup,
  heading detection.
- Anthropic prompt caching on the Gemini path.
- Any DB schema change or provider column.
- Frontend UI changes beyond the model auto-appearing in the dropdown.
