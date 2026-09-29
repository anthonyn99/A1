"""Phase U1: the model / limit selectors match the pages they were read from.

U1 was a read-only recon of every browser unit's model picker, model label
and limit wording (docs/magi-plan.md, Track S, "Phase U1"). Its output is the
`model_*`, `think_toggle`, `limit_notice`, `downgrade_notice`,
`usage_readout` and `prompt_too_long` keys in config/selectors.yaml, and the
sanitized DOM cut from each live page into tests/fixtures/units/. Nothing in
the engine reads these keys yet -- U2-U4 do -- so this file is what stops a
later edit from quietly breaking a selector those phases will rely on.

Every assertion is a fact seen on the real site on 2026-09-28 (or in a saved
failure snapshot), not a guess.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

from magi.settings import CONFIG_DIR, load_settings

FIX = Path(__file__).parent / "fixtures" / "units"
U1_KEYS = ("model_button", "model_option", "model_selected", "model_label",
           "downgrade_notice", "usage_readout")
BROWSER_UNITS = ("chatgpt", "claude", "claude-pro", "gemini", "perplexity",
                 "grok", "deepseek")


def _sites() -> dict:
    return yaml.safe_load((CONFIG_DIR / "selectors.yaml").read_text(encoding="utf-8"))["sites"]


@pytest.fixture(scope="module")
def page():
    pw = pytest.importorskip("playwright.sync_api")
    with pw.sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception as exc:
            pytest.skip(f"chromium unavailable: {exc}")
        pg = browser.new_page()
        pg.route("**/*", lambda r: r.abort())
        yield pg
        browser.close()


def _load(page, name: str):
    page.set_content((FIX / f"{name}.html").read_text(encoding="utf-8"))
    return page


def _first(page, candidates: list[str]):
    """The resolver's rule: first candidate with a match wins."""
    for sel in candidates:
        loc = page.locator(sel)
        if loc.count():
            return loc
    return None


def _label(page, site: dict) -> str:
    loc = _first(page, site["model_label"]).last
    how = site.get("model_label_from", "text")
    raw = loc.get_attribute(how[5:]) if how.startswith("attr:") else loc.inner_text()
    raw = " ".join((raw or "").split())
    pat = site.get("model_label_pattern")
    if pat:
        m = re.search(pat, raw)
        assert m, f"{pat!r} did not match {raw!r}"
        raw = m.group(1)
    return raw


def _texts(loc) -> list[str]:
    return [" ".join(t.split()) for t in loc.all_inner_texts()]


# ── the contract U2-U4 build on ──────────────────────────────────────────

def test_every_browser_unit_answers_every_u1_question():
    """An absent key would read as "not looked at"; [] means "looked, none"."""
    sites = _sites()
    for sid in BROWSER_UNITS:
        for key in U1_KEYS:
            assert key in sites[sid], f"{sid} has no {key!r} (use [] for 'none on this site')"
            assert isinstance(sites[sid][key], list), f"{sid}.{key} must be a list"


def test_the_engine_loads_every_u1_key():
    """U2 wired them in: what the file says is what the engine reads."""
    s, sites = load_settings(), _sites()
    for sid in BROWSER_UNITS:
        for key in U1_KEYS:
            assert getattr(s.site(sid), key) == sites[sid][key], f"{sid}.{key}"
    assert s.site("claude").model_label_from == "attr:aria-label"
    assert s.site("grok").model_label_from == "text"
    assert s.site("perplexity").prompt_too_long
    assert s.site("claude-pro").input == s.site("claude").input


def test_claude_pro_inherits_the_claude_picker():
    sites = _sites()
    for key in ("model_button", "model_option", "model_selected", "model_label_pattern"):
        assert sites["claude-pro"][key] == sites["claude"][key]


# ── per site, against the page it was read from ──────────────────────────

def test_chatgpt_free_has_no_picker_but_names_the_answering_model(page):
    site = _sites()["chatgpt"]
    assert site["model_button"] == [] and site["model_option"] == []
    _load(page, "chatgpt-switch-menu")
    assert "Try again" in page.inner_text("body")
    assert not re.search(r"gpt-\d", page.inner_text("body"), re.I), \
        "the Switch model menu lists no models on the free account"
    _load(page, "chatgpt-answer")
    assert _label(page, site) == "gpt-5-6-mini"
    _load(page, "chatgpt-idle")
    t = _first(page, site["think_toggle"])
    assert t.count() == 1 and t.get_attribute("aria-pressed") == "false"


@pytest.mark.parametrize("unit,menu", [("claude", "claude-menu"), ("claude-pro", "claude-pro-menu")])
def test_claude_picker(page, unit, menu):
    site = _sites()[unit]
    _load(page, "claude-idle")
    assert _first(page, site["model_button"]).count() == 1
    assert _label(page, site) == "Sonnet 5.5 Medium"
    _load(page, menu)
    ids = [e.get_attribute("data-model-id") for e in _first(page, site["model_option"]).all()]
    sel = _first(page, site["model_selected"])
    assert sel.count() == 1 and sel.get_attribute("data-model-id") == "claude-sonnet-5-5"
    locked = [e.get_attribute("data-model-id") for e in _first(page, site["model_locked"]).all()]
    if unit == "claude":
        assert ids == ["claude-sonnet-5-5", "claude-haiku-4-5-20251001"]
        assert set(locked) == {"claude-fable-5-1", "claude-opus-5-5"}
    else:
        assert ids == ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"]
        assert locked == ["claude-fable-5-1"]   # needs usage credits, which are off
    assert _first(page, site["model_more"]).count() == 1
    assert _first(page, site["effort_open"]).count() == 1


def test_claude_submenus(page):
    site = _sites()["claude-pro"]
    _load(page, "claude-pro-effort")
    eff = _first(page, site["effort_option"])
    levels = ["Low", "Medium", "High", "Extra", "Max"]
    got = _texts(eff)
    assert len(got) == 5 and all(t.startswith(l) for t, l in zip(got, levels)), got
    assert [e.get_attribute("aria-checked") for e in eff.all()].index("true") == 1
    _load(page, "claude-pro-more")
    ids = [e.get_attribute("data-model-id") for e in _first(page, site["model_option"]).all()]
    assert "claude-opus-4-8" in ids and "claude-sonnet-4-6" in ids


def test_gemini_picker(page):
    site = _sites()["gemini"]
    _load(page, "gemini-idle")
    assert _label(page, site) == "Gemini Flash"
    _load(page, "gemini-menu")
    opts = _first(page, site["model_option"])
    assert [t.split(" ", 2)[:2] for t in _texts(opts)] == [["3.5", "Flash-Lite"], ["3.6", "Flash"], ["3.1", "Pro"]]
    assert all(e.get_attribute("data-mode-id") for e in opts.all())
    sel = _first(page, site["model_selected"])
    assert sel.count() == 1 and _texts(sel)[0].startswith("3.6 Flash")
    # The trap this pins: data-active is focus, and it is on Flash-Lite.
    assert page.locator("[data-test-id='gem-mode-menu'] [data-active='true']").inner_text().startswith("3.5")
    assert _texts(_first(page, site["think_toggle"]))[0].startswith("Extended thinking")


def test_perplexity_free_shows_models_it_will_not_let_you_pick(page):
    site = _sites()["perplexity"]
    _load(page, "perplexity-idle")
    b = _first(page, site["model_button"])
    assert b.count() == 1 and b.inner_text().strip() == "Model"   # no current model shown
    _load(page, "perplexity-menu")
    assert _first(page, site["model_locked"]).count() == 8
    assert site["model_option"] == [] and site["model_label"] == []
    _load(page, "perplexity-submenu")
    assert "Upgrade to access the latest AI models" in page.inner_text("body")
    _load(page, "perplexity-too-long")
    assert "7,579 characters over the limit" in _first(page, site["prompt_too_long"]).inner_text()


def test_grok_picker_and_limit_card(page):
    site = _sites()["grok"]
    _load(page, "grok-idle")
    assert _label(page, site) == "Fast"
    _load(page, "grok-menu")
    assert [t.strip() for t in _texts(_first(page, site["model_option"]))] == \
        ["Fast", "Build", "Auto", "Expert", "Heavy"]
    assert _texts(_first(page, site["model_selected"])) == ["Fast"]
    _load(page, "grok-limit")
    card = _first(page, site["limit_notice"])
    assert card.count() == 1
    assert re.search(r"\d+ hours? .*before limit is gone", card.inner_text())


def test_deepseek_has_only_toggles(page):
    site = _sites()["deepseek"]
    assert site["model_button"] == [] and site["model_label"] == []
    _load(page, "deepseek-idle")
    t = _first(page, site["think_toggle"])
    assert t.count() == 1 and t.get_attribute("aria-pressed") == "false"


def test_fixtures_carry_nothing_personal():
    for f in FIX.glob("*.html"):
        body = f.read_text(encoding="utf-8")
        assert not re.search(r"[\w.+-]+@[\w-]+\.\w+|Anthony|Nguyen", body), f.name


# ── found by U1 ──────────────────────────────────────────────────────────
# Both bugs were fixed in U2, with their tests in test_model_shown.py:
# a prompt quoting limit words (test_a_prompt_quoting_limit_words_is_not_a_limit)
# and Perplexity's length cap (test_perplexity_length_cap_is_read).
