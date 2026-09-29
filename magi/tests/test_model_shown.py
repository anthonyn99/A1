"""Phase U2: the model that answered, and the two U1 bugs fixed with it.

* `resolve.model_label` reads the model a site shows, against the pages U1
  cut from the live sites (tests/fixtures/units/). A site that names none
  (Perplexity free, DeepSeek) reads "" -- no chip, never a guess.
* `fallback_note` flags a fallback only on the site's own evidence.
* `resolve.notice` / `rate_limited` no longer read the user's own prompt as
  the site talking (U1 bug 1: DeepSeek lost 3 of 3 critique rounds to
  proposals that said "rate limits").
* Perplexity's prompt-length cap is its own failure, not a timeout (U1 bug 2).
* The model is stored on answers and brainstorm turns and read back.
"""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest

from magi.browser import completion, resolve
from magi.errors import FailureKind, ProviderError, explain
from magi.providers.base import Answer, ProviderState
from magi.providers.browser_base import fallback_note
from magi.settings import load_settings
from tests.test_completion import FakeLocator, FakePage, make_site

FIX = Path(__file__).parent / "fixtures" / "units"


async def _on_pages(pages: list[str], fn):
    """Run `fn(page)` on each HTML string in one real browser; results in order."""
    pw = pytest.importorskip("playwright.async_api")
    async with pw.async_playwright() as p:
        try:
            browser = await p.chromium.launch()
        except Exception as exc:
            pytest.skip(f"chromium unavailable: {exc}")
        try:
            page = await browser.new_page()
            await page.route("**/*", lambda r: r.abort())
            out = []
            for html in pages:
                await page.set_content(html)
                out.append(await fn(page))
            return out
        finally:
            await browser.close()


def _fixture(name: str) -> str:
    return (FIX / f"{name}.html").read_text(encoding="utf-8")


# ── the label ────────────────────────────────────────────────────────────

LABELS = [
    ("chatgpt", "chatgpt-answer", "gpt-5-6-mini"),   # the slug on the turn
    ("chatgpt", "chatgpt-idle", ""),                 # no answer, no slug yet
    ("claude", "claude-idle", "Sonnet 5.5 Medium"),
    ("claude-pro", "claude-idle", "Sonnet 5.5 Medium"),
    ("gemini", "gemini-idle", "Gemini Flash"),
    ("grok", "grok-idle", "Fast"),
    ("perplexity", "perplexity-idle", ""),           # button says only "Model"
    ("deepseek", "deepseek-idle", ""),
]


@pytest.mark.asyncio
async def test_model_label_reads_what_each_site_shows():
    s = load_settings()
    got = []
    for unit, fx, _ in LABELS:
        got += await _on_pages([_fixture(fx)], lambda pg, u=unit: resolve.model_label(pg, s.site(u)))
    assert got == [want for _, _, want in LABELS]


@pytest.mark.asyncio
async def test_chatgpt_label_is_the_newest_answer():
    """Two answers in one chat: the one that just answered is the last."""
    html = ("<div data-message-author-role='assistant' data-message-model-slug='gpt-5-6'>a</div>"
            "<div data-message-author-role='assistant' data-message-model-slug='gpt-5-6-mini'>b</div>")
    site = load_settings().site("chatgpt")
    [got] = await _on_pages([html], lambda pg: resolve.model_label(pg, site))
    assert got == "gpt-5-6-mini"


@pytest.mark.asyncio
async def test_a_label_the_pattern_does_not_fit_is_no_label():
    """Never a half-parsed string on a chip: no match reads as none."""
    site = load_settings().site("claude")
    html = "<button data-testid='model-selector-dropdown' aria-label='Something else'>x</button>"
    [got] = await _on_pages([html], lambda pg: resolve.model_label(pg, site))
    assert got == ""


@pytest.mark.asyncio
async def test_a_missing_label_never_raises():
    class Broken:
        def locator(self, sel):
            raise RuntimeError("page is gone")
    assert await resolve.model_label(Broken(), load_settings().site("claude")) == ""


# ── fallback: only on the site's own evidence ────────────────────────────

def test_fallback_needs_evidence():
    assert fallback_note("", "gpt-5-6-mini") == ""            # the name alone proves nothing
    assert fallback_note("Sonnet 5.5 Medium", "Sonnet 5.5 Medium") == ""
    assert fallback_note("", "") == ""
    assert fallback_note("Sonnet 5.5 Medium", "") == ""       # label gone is not a switch
    assert fallback_note("Sonnet 5.5 Medium", "Haiku 4.5") == "Started on Sonnet 5.5 Medium"
    assert fallback_note("gpt-5-6", "gpt-5-6-mini") == "Started on gpt-5-6"
    note = fallback_note("", "gpt-5-6-mini", "Responses will use another model")
    assert note == "The site said: Responses will use another model"


# ── U1 bug 1: the user's own words are not a limit ───────────────────────

REAL_PROMPT = ("Critique these proposals. Proposal 2: Keep in mind retailer terms, "
               "rate limits, and bot defenses.")


@pytest.mark.asyncio
async def test_a_prompt_quoting_limit_words_is_not_a_limit():
    """The real case: brainstorm 797a9ae3cc13 (2026-09-25), DeepSeek, 3 of 3."""
    sels = load_settings().site("deepseek").rate_limit_selectors
    html = ("<div class='user-bubble'>Keep in mind retailer terms, rate limits, and bot "
            "defenses.</div><textarea placeholder='Message DeepSeek'></textarea>")
    [got] = await _on_pages([html], lambda pg: resolve.rate_limited(pg, sels, prompt=REAL_PROMPT))
    assert got == ""
    # Without the prompt the same page still reads as a limit -- the rule is
    # unchanged; knowing what was sent is what fixes it.
    [unscoped] = await _on_pages([html], lambda pg: resolve.rate_limited(pg, sels))
    assert "rate limits" in unscoped


@pytest.mark.asyncio
async def test_the_real_notice_is_found_behind_the_echo():
    """The first match is our prompt, the second is the site: take the second."""
    sels = load_settings().site("deepseek").rate_limit_selectors
    html = ("<div class='user-bubble'>Mind the rate limits.</div>"
            "<div class='toast'>Rate limit reached. Please wait a moment.</div>")
    [got] = await _on_pages([html], lambda pg: resolve.rate_limited(
        pg, sels, prompt="Mind the rate limits."))
    assert got == "Rate limit reached. Please wait a moment."


@pytest.mark.asyncio
async def test_the_composer_is_not_the_site_talking():
    sels = load_settings().site("claude").rate_limit_selectors
    html = "<div contenteditable='true' class='ProseMirror'><p>Limits will reset soon?</p></div>"
    [got] = await _on_pages([html], lambda pg: resolve.rate_limited(pg, sels))
    assert got == ""


@pytest.mark.asyncio
async def test_a_line_in_a_long_answer_is_not_a_limit():
    """DeepSeek critiquing proposals will SAY "rate limits" in its answer."""
    site = load_settings().site("deepseek")
    html = ("<div class='ds-markdown'><p>" + "The plan is sound overall. " * 12 +
            "</p><p>Watch the rate limits on the retailer API.</p></div>")
    [got] = await _on_pages([html], lambda pg: resolve.rate_limited(
        pg, site.rate_limit_selectors, answer=site.assistant_turn))
    assert got == ""


@pytest.mark.asyncio
async def test_a_card_that_replaces_the_answer_is_still_a_limit():
    """Grok's limit card IS the whole turn: it must still read as the limit."""
    site = load_settings().site("grok")
    card = ("<div data-testid='assistant-message'><div role='alert'>"
            "<div>3 hours before limit is gone</div></div></div>")
    grok_fixture = _fixture("grok-limit")
    got = await _on_pages([card, grok_fixture], lambda pg: resolve.rate_limited(
        pg, site.rate_limit_selectors, prompt=REAL_PROMPT, answer=site.assistant_turn))
    assert all("before limit is gone" in g for g in got), got


# ── U1 bug 2: Perplexity's length cap is not a timeout ──────────────────

@pytest.mark.asyncio
async def test_perplexity_length_cap_is_read():
    site = load_settings().site("perplexity")
    [got] = await _on_pages([_fixture("perplexity-too-long")],
                            lambda pg: resolve.notice(pg, site.prompt_too_long, prompt=REAL_PROMPT))
    assert "7,579 characters over the limit" in got


def test_prompt_too_long_has_its_own_remedy():
    cause, remedy = explain(FailureKind.PROMPT_TOO_LONG)
    assert "too long" in cause and "Shorten" in remedy
    assert "hard_timeout_s" not in remedy       # the old, wrong remedy


class CapPage(FakePage):
    def locator(self, selector):
        if selector == "TOOLONG":
            f = self._current()
            return FakeLocator([f["cap"]] if f.get("cap") else [])
        return super().locator(selector)


@pytest.mark.asyncio
async def test_completion_stops_on_the_cap_within_a_poll(monkeypatch):
    """Nothing ever streams after a refused send; this used to wait out 120s."""
    monkeypatch.setattr(completion, "LIMIT_CHECK_S", 0.0)
    cap = "Your query is 7,579 characters over the limit. Shorten it to submit."
    page = CapPage([{"turns": []}, {"turns": [], "cap": cap}])
    site = make_site(prompt_too_long=["TOOLONG"], stall_timeout_s=3, hard_timeout_s=5)
    import time
    t0 = time.monotonic()
    with pytest.raises(ProviderError) as e:
        await completion.wait_for_completion(
            page, site, baseline=completion.Baseline(turns=0, last_text=""), prompt="q")
    assert e.value.kind == FailureKind.PROMPT_TOO_LONG and "over the limit" in e.value.detail
    assert time.monotonic() - t0 < 1.5


@pytest.mark.asyncio
async def test_completion_ignores_a_limit_word_in_the_prompt(monkeypatch):
    """The fake page shows the prompt's own words in the LIMIT slot."""
    monkeypatch.setattr(completion, "LIMIT_CHECK_S", 0.0)

    class EchoPage(FakePage):
        def locator(self, selector):
            if selector == "LIMIT":
                return FakeLocator(["watch the rate limits"])
            return super().locator(selector)

    page = EchoPage([{"turns": ["old"]}, {"turns": ["old", "An answer."]}])
    site = make_site(rate_limit_selectors=["LIMIT"], stop_button=[])
    r = await completion.wait_for_completion(
        page, site, turns_before=1, prompt="Please watch the rate limits carefully.")
    assert r.text == "An answer."


# ── stored and read back ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_model_is_stored_on_answers_and_turns(tmp_path):
    from magi.db import Database
    db = Database(tmp_path / "magi.db")
    await db.init()
    await db.create_run("r1", "q", "claude")
    a = Answer("claude", "Claude", "hi", True, ProviderState.DONE,
               model="Haiku 4.5", model_fallback="Started on Sonnet 5.5 Medium")
    await db.save_answer("r1", a)
    await db.save_answer("r1", Answer("perplexity", "Perplexity", "x", True, ProviderState.DONE))
    run = await db.get_run("r1")
    by = {r["provider_id"]: r for r in run["answers"]}
    assert by["claude"]["model"] == "Haiku 4.5"
    assert by["claude"]["model_fallback"] == "Started on Sonnet 5.5 Medium"
    assert by["perplexity"]["model"] is None           # no chip, not ""-as-a-name

    await db.create_session("s1", "topic", ["grok"])
    await db.add_turn("s1", 1, "council", provider_id="grok", content="c", ok=True,
                      model="Fast")
    turns = (await db.get_session("s1"))["turns"]
    assert turns[0]["model"] == "Fast" and turns[0]["model_fallback"] is None


@pytest.mark.asyncio
async def test_an_old_database_gains_the_columns(tmp_path):
    """Additive: a database from before U2 migrates and keeps its rows."""
    from magi.db import Database
    path = tmp_path / "magi.db"
    db = Database(path)
    await db.init()
    await db.create_run("old", "q", None)
    await db.save_answer("old", Answer("grok", "Grok", "t", True, ProviderState.DONE))
    con = sqlite3.connect(path)
    for t in ("answers", "brainstorm_turns"):
        con.execute(f"ALTER TABLE {t} DROP COLUMN model")
        con.execute(f"ALTER TABLE {t} DROP COLUMN model_fallback")
    con.commit(); con.close()
    await Database(path).init()
    run = await Database(path).get_run("old")
    assert run["answers"][0]["answer_text"] == "t" and "model" in run["answers"][0]


def test_every_state_event_carries_the_model():
    """app.py's three on_event hooks all forward it (run, round, critique)."""
    src = (Path(__file__).parents[1] / "app.py").read_text(encoding="utf-8")
    assert src.count('"model": ev.model,') == 3
    assert src.count('prov["model"] = ev.model') == 3
    assert '"model": a.model,' in src
