"""API-backed Gemini provider.

Weighted toward the response-shaped failures, because they are the ones that
can silently become an "answer": a blocked prompt and a truncated generation
both come back as a well-formed HTTP 200 with no text in it. The Provider
contract says a failure and an opinion must never be the same value, so those
must map to ok=False rather than to an empty success.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from magi.errors import FailureKind  # noqa: E402
from magi.providers.base import ProviderState, RunContext  # noqa: E402
from magi.providers.gemini_api import (  # noqa: E402
    DEFAULT_MODEL,
    ENV_KEYS,
    GeminiAPIProvider,
    MissingKey,
    load_api_key,
)

extract = GeminiAPIProvider._extract
error_message = GeminiAPIProvider._error_message


def _ok_payload(text: str) -> dict:
    return {"candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": "STOP"}]}


# ------------------------------------------------------------------ extract


def test_extracts_plain_text():
    assert extract(_ok_payload("Explain the GIL.")) == ("Explain the GIL.", None)


def test_joins_multiple_parts():
    payload = {
        "candidates": [{"content": {"parts": [{"text": "Explain "}, {"text": "the GIL."}]}}]
    }
    assert extract(payload) == ("Explain the GIL.", None)


def test_blocked_prompt_is_a_failure_not_empty_text():
    """The failure this test file exists for: HTTP 200, no candidates."""
    text, err = extract({"promptFeedback": {"blockReason": "SAFETY"}})
    assert text == ""
    assert err and "SAFETY" in err


def test_truncated_generation_is_a_failure():
    payload = {"candidates": [{"content": {"parts": []}, "finishReason": "MAX_TOKENS"}]}
    text, err = extract(payload)
    assert text == ""
    assert err and "MAX_TOKENS" in err


def test_empty_text_with_stop_is_still_a_failure():
    payload = {"candidates": [{"content": {"parts": [{"text": "   "}]}, "finishReason": "STOP"}]}
    text, err = extract(payload)
    assert text == ""
    assert err


def test_api_error_body_is_reported():
    text, err = extract({"error": {"message": "API key not valid"}})
    assert text == ""
    assert "API key not valid" in err


def test_no_candidates_without_block_reason():
    text, err = extract({"candidates": []})
    assert text == ""
    assert err


# ------------------------------------------------------------------ key load


def test_env_var_wins_over_dotenv(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "from-env")
    assert load_api_key() == "from-env"


def test_missing_key_raises_missingkey(monkeypatch):
    for k in ENV_KEYS:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(
        "magi.providers.gemini_api.load_api_key", lambda: "", raising=True
    )
    with pytest.raises(MissingKey):
        GeminiAPIProvider()


# ---------------------------------------------------------------------- ask


def _provider() -> GeminiAPIProvider:
    return GeminiAPIProvider(api_key="test-key")


def test_ask_returns_ok_answer(monkeypatch):
    p = _provider()
    monkeypatch.setattr(p, "_post_sync", lambda prompt: ("Rewritten request.", None))
    ans = asyncio.run(p.ask("q", ctx=RunContext(run_id="r", question="q")))
    assert ans.ok
    assert ans.text == "Rewritten request."
    assert ans.state is ProviderState.DONE
    assert ans.provider_kind == "api"


def test_ask_never_returns_error_text_as_an_answer(monkeypatch):
    """A failure must carry empty text -- never the error string as content."""
    p = _provider()
    monkeypatch.setattr(p, "_post_sync", lambda prompt: ("", "Gemini API rate limit"))
    ans = asyncio.run(p.ask("q", ctx=RunContext(run_id="r", question="q")))
    assert not ans.ok
    assert ans.text == ""
    assert ans.failure is FailureKind.RATE_LIMITED


def test_bad_key_maps_to_a_fixable_failure(monkeypatch):
    p = _provider()
    monkeypatch.setattr(
        p, "_post_sync", lambda prompt: ("", "Gemini rejected the API key (HTTP 403).")
    )
    ans = asyncio.run(p.ask("q", ctx=RunContext(run_id="r", question="q")))
    assert ans.failure is FailureKind.NOT_LOGGED_IN


def test_overloaded_model_maps_to_rate_limited(monkeypatch):
    """503 is the model shedding load, not a broken key -- it must be
    retryable, not something the user goes hunting through config for."""
    p = _provider()
    monkeypatch.setattr(
        p, "_post_sync", lambda prompt: ("", "Gemini model 'x' is temporarily overloaded")
    )
    ans = asyncio.run(p.ask("q", ctx=RunContext(run_id="r", question="q")))
    assert ans.failure is FailureKind.RATE_LIMITED


# ------------------------------------------------------------ error messages


def test_error_message_extracted_from_api_body():
    """A retired model names its replacement in error.message; that sentence is
    the whole value of the 404, so it must survive to the user."""
    body = (
        '{"error": {"code": 404, "message": "This model models/gemini-2.5-flash '
        'is no longer available to new users. Please update your code to use '
        'models/gemini-3.6-flash.", "status": "NOT_FOUND"}}'
    )
    assert "gemini-3.6-flash" in error_message(body)


def test_error_message_falls_back_to_raw_body():
    assert error_message("not json at all") == "not json at all"


def test_default_model_is_pinned_not_an_alias():
    """`gemini-flash-latest` measured 14-30s and 503s under load, against ~3s
    for the pinned version -- an alias silently repointing would undo the
    entire point of this provider."""
    assert "latest" not in DEFAULT_MODEL


def test_unreachable_maps_to_navigation(monkeypatch):
    p = _provider()
    monkeypatch.setattr(
        p, "_post_sync", lambda prompt: ("", "Could not reach the Gemini API: dns")
    )
    ans = asyncio.run(p.ask("q", ctx=RunContext(run_id="r", question="q")))
    assert ans.failure is FailureKind.NAVIGATION
