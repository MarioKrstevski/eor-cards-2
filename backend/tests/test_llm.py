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
    kwargs = fake_client.messages.create.call_args.kwargs
    assert kwargs["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert kwargs["model"] == "claude-sonnet-4-6"
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
    assert stop == "max_tokens"


def test_google_branch_maps_response():
    pytest.importorskip("google.genai")
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
    assert m.call_args.kwargs["max_tokens"] == 8192


def test_generate_cards_raises_on_persistent_truncation():
    section = {"heading": "X", "content_text": "y"}
    with _patch.object(generator, "complete_text",
                       return_value=("1|partial", {"input_tokens": 1, "output_tokens": 1,
                                     "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
                                     "max_tokens")):
        with pytest.raises(OutputTruncated):
            generator.generate_cards_for_section(section, "RULES", "gemini-3.5-flash")
