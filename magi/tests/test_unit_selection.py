"""Nothing drives a unit that is not ticked. Every path, not just the council.

Studio was caught doing it once (see test_studio_pick.py) and fixed. This
sweeps the three that were still doing it afterwards:

  · the DOCTOR opened a real Chrome against every configured site, signed in
    as you, regardless of the selection;
  · REFINE reached Gemini through its API key even with Gemini unticked --
    the tick boxes are about models, not about transports;
  · the brainstorm FINALIZE fallback picked a chairman from every enabled
    unit when the critique pass produced no eligible member.

Each is quiet -- no History row, no unit card lighting up -- which is exactly
why they survived the first sweep.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import magi.app as app  # noqa: E402


# ── the refiner ─────────────────────────────────────────────────────────────

def _with_key(monkeypatch, present: bool = True):
    monkeypatch.setattr(app.gemini_api, "load_api_key", lambda: "k" if present else "")


def test_the_api_refiner_is_refused_when_its_unit_is_unticked(monkeypatch):
    """Reaching Gemini by API key is still using Gemini.

    The tick boxes name MODELS. A key is a different door into the same
    company, the same account and the same instruction being ignored.
    """
    _with_key(monkeypatch)
    got = app._refiner_id(["chatgpt", "claude"])
    assert got != app.REFINER_PROVIDER_ID
    assert got in ("chatgpt", "claude")


def test_the_api_refiner_is_used_when_gemini_is_selected(monkeypatch):
    """It answers in a second; the browser path spends several launching Chrome."""
    _with_key(monkeypatch)
    assert app._refiner_id(["chatgpt", "gemini"]) == app.REFINER_PROVIDER_ID


def test_with_no_key_the_fallback_stays_inside_the_selection(monkeypatch):
    _with_key(monkeypatch, present=False)
    assert app._refiner_id(["deepseek"]) == "deepseek"


def test_no_selection_at_all_still_works(monkeypatch):
    """The CLI and older clients send nothing; the button must not break."""
    _with_key(monkeypatch)
    assert app._refiner_id(None) == app.REFINER_PROVIDER_ID


def test_an_explicit_provider_id_cannot_route_around_the_tick_boxes(monkeypatch):
    _with_key(monkeypatch)
    assert app._resolve_refiner("claude", ["chatgpt"]) != "claude"
    assert app._resolve_refiner(app.REFINER_PROVIDER_ID, ["chatgpt"]) != app.REFINER_PROVIDER_ID


def test_an_explicit_provider_id_is_honoured_when_it_is_selected(monkeypatch):
    _with_key(monkeypatch)
    assert app._resolve_refiner("claude", ["chatgpt", "claude"]) == "claude"
    # ...including by the unit the API provider belongs to.
    assert app._resolve_refiner(
        app.REFINER_PROVIDER_ID, ["gemini"]
    ) == app.REFINER_PROVIDER_ID


def test_every_api_provider_declares_which_unit_it_is():
    """A new API-backed provider with no mapping would silently be ungated."""
    from magi.providers.registry import API_PROVIDERS

    assert set(API_PROVIDERS) <= set(app.API_PROVIDER_UNIT), (
        "add it to API_PROVIDER_UNIT, or unticking its unit will not stop it"
    )


# ── the doctor ──────────────────────────────────────────────────────────────

def test_the_doctor_endpoint_takes_a_selection():
    """It opens a real signed-in browser per unit, so it has to be scoped."""
    import inspect

    sig = inspect.signature(app.doctor)
    assert "providers" in sig.parameters
    body = inspect.getsource(app.doctor)
    assert "providers.split" in body


# ── the brainstorm fallback ─────────────────────────────────────────────────

def test_the_finalize_fallback_chairman_stays_inside_the_session(monkeypatch):
    """An emergency is not a licence to drive a unit that was unticked."""
    import inspect

    body = inspect.getsource(app.finalize_brainstorm)
    assert "pick_generator_id(settings, None, provider_ids)" in body
