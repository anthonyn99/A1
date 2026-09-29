"""Phase U4: choose each unit's model, and a bad pick never fails a run.

* `picker.list_options` / `picker.choose` drive the real pickers U1 cut from
  the live sites (tests/fixtures/units/), made clickable by a small script
  that behaves the way each site did: the button opens the menu, a choosable
  row takes the check and renames the button, a locked row does nothing,
  Escape closes. Grok's "refuses" variant keeps Fast however hard you click.
* A pick is confirmed on the menu's own mark, never on the label's wording
  (Gemini's label says "Gemini Flash" for the "3.6 Flash" option, and
  "Flash" must never pass for "Flash-Lite").
* Anything unavailable comes back as "Asked for X, got Y" -- never raises.
* The choice is per person: accounts.json in each profile's data folder.
* A run whose pick failed still answers, and carries the note.
"""

from __future__ import annotations

import asyncio
import json
import re
from contextlib import asynccontextmanager
from pathlib import Path

import pytest

from magi.browser import picker, resolve
from magi.settings import load_settings

FIX = Path(__file__).parent / "fixtures" / "units"


# ── clickable fixtures ───────────────────────────────────────────────────

# How each site marks a choice, as the script needs it: which menu, which
# rows can be chosen, how the button's label reads after a choice.
DRIVE = {
    "claude": dict(menu="[role='menu']:not([data-nested])", sub="[role='menu'][data-nested]",
                   more="[aria-haspopup='menu']", opt="[role='menuitemradio'][data-model-id]",
                   mark="aria", label="attr:aria-label", fmt="Model: {name} Medium"),
    "gemini": dict(menu="[data-test-id='gem-mode-menu']", opt="[role='menuitem'][data-mode-id]",
                   mark="gemini", label="attr:aria-label",
                   fmt="Open mode picker, currently Gemini {short}"),
    "grok": dict(menu="[role='menu']", opt="[role='menuitemradio']", mark="aria",
                 label="text:#model-select-trigger .truncate", fmt="{name}"),
}

_SCRIPT = r"""
<script>
(() => {
  const C = __CFG__;
  const btn = document.querySelector(C.button);
  const menu = document.querySelector(C.menu);
  const sub = C.sub ? document.querySelector(C.sub) : null;
  window.__opens = 0;
  const hide = () => { menu.style.display = "none"; if (sub) sub.style.display = "none"; };
  hide();
  btn.addEventListener("click", () => { window.__opens++; menu.style.display = ""; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  if (sub) {
    for (const more of menu.querySelectorAll(C.more)) {
      if (/More models/.test(more.textContent)) {
        more.addEventListener("mouseenter", () => { sub.style.display = ""; });
      }
    }
  }
  const nameOf = (it) => {
    const w = document.createTreeWalker(it, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.textContent.replace(/[-]/g, "").trim();
      if (t) return t;
    }
    return "";
  };
  document.addEventListener("click", (e) => {
    const it = e.target.closest(C.opt);
    if (!it || !(menu.contains(it) || (sub && sub.contains(it)))) return;
    const name = nameOf(it);
    if (C.refuse && C.refuse.includes(name)) { hide(); return; }
    const all = document.querySelectorAll(C.opt);
    if (C.mark === "aria") {
      all.forEach((o) => { o.setAttribute("aria-checked", "false"); });
      it.setAttribute("aria-checked", "true");
    } else {
      document.querySelectorAll("[aria-label='Selected']").forEach((x) => x.remove());
      const s = document.createElement("gem-icon");
      s.setAttribute("aria-label", "Selected");
      it.prepend(s);
    }
    const text = C.fmt.replace("{name}", name).replace("{short}", name.replace(/^[\d.]+\s*/, ""));
    if (C.label.startsWith("attr:")) btn.setAttribute(C.label.slice(5), text);
    else document.querySelector(C.label.slice(5)).textContent = text;
    hide();
  });
})();
</script>
"""


def _clickable(fixture: str, unit: str, *, refuse: list[str] | None = None) -> str:
    s = load_settings()
    kind = "claude" if unit.startswith("claude") else unit
    cfg = dict(DRIVE[kind], button=s.site(unit).model_button[0], refuse=refuse or [])
    cfg.setdefault("sub", "")
    html = (FIX / f"{fixture}.html").read_text(encoding="utf-8")
    if fixture == "claude-pro-more":
        # U1 cut the submenu without the button; it is the same one as on
        # the Pro menu capture.
        menu = (FIX / "claude-pro-menu.html").read_text(encoding="utf-8")
        btn = re.search(r"<button[^>]*model-selector-dropdown.*?</button>", menu, re.S).group(0)
        html = html.replace("<body>", "<body>" + btn, 1)
    return html + _SCRIPT.replace("__CFG__", json.dumps(cfg))


async def _on(html: str, fn):
    pw = pytest.importorskip("playwright.async_api")
    async with pw.async_playwright() as p:
        try:
            browser = await p.chromium.launch()
        except Exception as exc:
            pytest.skip(f"chromium unavailable: {exc}")
        try:
            page = await browser.new_page()
            await page.route("**/*", lambda r: r.abort())
            await page.set_content(html)
            return await fn(page)
        finally:
            await browser.close()


@pytest.fixture(autouse=True)
def _fresh_confirmations():
    picker.forget()
    yield
    picker.forget()


@pytest.fixture(autouse=True)
def _quick(monkeypatch):
    monkeypatch.setattr(picker, "SETTLE_S", 0.05)
    monkeypatch.setattr(picker, "MENU_WAIT_MS", 1500)


S = load_settings()


# ── which units have a picker, and what U1 saw ───────────────────────────

def test_only_claude_gemini_and_grok_have_a_picker():
    got = {u: picker.has_picker(S.site(u)) for u in
           ("chatgpt", "claude", "claude-pro", "gemini", "grok", "perplexity", "deepseek")}
    assert got == {"chatgpt": False, "claude": True, "claude-pro": True, "gemini": True,
                   "grok": True, "perplexity": False, "deepseek": False}


def test_the_known_lists_match_the_menus_u1_captured():
    """model_known is typed by hand; every entry must be a row in the real
    menu, with the same id, or the sheet offers something that is not there."""
    async def rows(unit, fx):
        async def go(page):
            return [(i["id"], i["name"]) for i, _ in await picker._read(page, S.site(unit))]
        return await _on((FIX / f"{fx}.html").read_text(encoding="utf-8"), go)

    for unit, fx in (("claude", "claude-menu"), ("claude-pro", "claude-pro-more"),
                     ("gemini", "gemini-menu"), ("grok", "grok-menu")):
        seen = asyncio.run(rows(unit, fx))
        for k in picker.known(S.site(unit)):
            assert (k["id"], k["name"]) in seen, (unit, k)


# ── reading the menu ─────────────────────────────────────────────────────

def test_list_options_reads_names_ids_locks_and_the_current_one():
    async def go(page):
        return await picker.list_options(page, S.site("claude"))
    opts = asyncio.run(_on(_clickable("claude-menu", "claude"), go))
    by = {o["name"]: o for o in opts}
    assert by["Sonnet 5.5"]["selected"] and by["Sonnet 5.5"]["id"] == "claude-sonnet-5-5"
    assert not by["Haiku 4.5"]["locked"] and not by["Haiku 4.5"]["selected"]
    assert by["Opus 5.5"]["locked"] and by["Fable 5.1"]["locked"]   # "Upgrade" on free


def test_list_options_opens_more_models_on_pro():
    async def go(page):
        return await picker.list_options(page, S.site("claude-pro"))
    names = [o["name"] for o in asyncio.run(_on(_clickable("claude-pro-more", "claude-pro"), go))]
    assert "Opus 5.5" in names and "Opus 4.8" in names and "Sonnet 4.6" in names


def test_list_options_closes_the_menu():
    async def go(page):
        await picker.list_options(page, S.site("grok"))
        return await page.locator("[role='menu']").first.is_visible()
    assert asyncio.run(_on(_clickable("grok-menu", "grok"), go)) is False


# ── choosing ─────────────────────────────────────────────────────────────

def test_choose_moves_claude_and_confirms_on_the_menu():
    async def go(page):
        r = await picker.choose(page, S.site("claude"),
                                {"id": "claude-haiku-4-5-20251001", "name": "Haiku 4.5"})
        return r, await resolve.model_label(page, S.site("claude"))
    r, label = asyncio.run(_on(_clickable("claude-menu", "claude"), go))
    assert r.ok and r.changed and r.note == ""
    assert label == "Haiku 4.5 Medium" == r.label


def test_the_steady_state_opens_no_menu():
    """Second run on the same pick: one label read, zero clicks."""
    async def go(page):
        want = {"id": "claude-haiku-4-5-20251001", "name": "Haiku 4.5"}
        await picker.choose(page, S.site("claude"), want)
        before = await page.evaluate("window.__opens")
        r = await picker.choose(page, S.site("claude"), want)
        return r, before, await page.evaluate("window.__opens")
    r, before, after = asyncio.run(_on(_clickable("claude-menu", "claude"), go))
    assert r.ok and not r.changed
    assert before == 2 and after == before     # pick + confirm, then nothing


def test_already_selected_is_ok_without_a_click():
    async def go(page):
        r = await picker.choose(page, S.site("claude"),
                                {"id": "claude-sonnet-5-5", "name": "Sonnet 5.5"})
        return r, await page.evaluate("window.__opens")
    r, opens = asyncio.run(_on(_clickable("claude-menu", "claude"), go))
    assert r.ok and not r.changed and opens == 1


def test_gemini_matches_by_mode_id_not_the_label():
    async def go(page):
        r = await picker.choose(page, S.site("gemini"), {"id": "9d8ca3786ebdfbea", "name": "3.1 Pro"})
        return r, await resolve.model_label(page, S.site("gemini"))
    r, label = asyncio.run(_on(_clickable("gemini-menu", "gemini"), go))
    assert r.ok and r.changed and label == "Gemini Pro"


def test_flash_never_passes_for_flash_lite():
    """Label says "Gemini Flash"; asked for Flash-Lite, the pick must still
    click Flash-Lite rather than call the word match good enough."""
    async def go(page):
        r = await picker.choose(page, S.site("gemini"),
                                {"id": "cf41b0e0dd7d53e5", "name": "3.5 Flash-Lite"})
        sel = await page.locator(S.site("gemini").model_selected[0]).get_attribute("data-mode-id")
        return r, sel
    r, sel = asyncio.run(_on(_clickable("gemini-menu", "gemini"), go))
    assert r.ok and r.changed and sel == "cf41b0e0dd7d53e5"


def test_pro_reaches_an_older_model_through_more_models():
    async def go(page):
        return await picker.choose(page, S.site("claude-pro"),
                                   {"id": "claude-opus-4-8", "name": "Opus 4.8"})
    r = asyncio.run(_on(_clickable("claude-pro-more", "claude-pro"), go))
    assert r.ok and r.changed and r.label == "Opus 4.8 Medium"


def test_grok_matches_by_name():
    async def go(page):
        return await picker.choose(page, S.site("grok"), {"id": "", "name": "Expert"})
    r = asyncio.run(_on(_clickable("grok-menu", "grok"), go))
    assert r.ok and r.label == "Expert"


# ── unavailable: labelled, never failed ──────────────────────────────────

def test_a_locked_model_is_asked_for_and_not_got():
    async def go(page):
        return await picker.choose(page, S.site("claude"), {"id": "claude-opus-5-5", "name": "Opus 5.5"})
    r = asyncio.run(_on(_clickable("claude-menu", "claude"), go))
    assert not r.ok
    assert r.note == "Asked for Opus 5.5, got Sonnet 5.5 Medium (locked on this account)"


def test_a_model_that_is_gone():
    async def go(page):
        return await picker.choose(page, S.site("grok"), {"id": "", "name": "Grok 9"})
    r = asyncio.run(_on(_clickable("grok-menu", "grok"), go))
    assert not r.ok and r.note == "Asked for Grok 9, got Fast (no longer offered)"


def test_a_click_the_site_refuses_is_caught_by_the_read_back():
    """Grok on free may take the click and stay on Fast. The menu's mark
    says so, and the label is what actually answers."""
    async def go(page):
        return await picker.choose(page, S.site("grok"), {"id": "", "name": "Heavy"})
    r = asyncio.run(_on(_clickable("grok-menu", "grok", refuse=["Heavy"]), go))
    assert not r.ok and r.note == "Asked for Heavy, got Fast"


def test_a_page_without_the_button_never_raises():
    async def go(page):
        return await picker.choose(page, S.site("claude"), {"id": "claude-haiku-4-5-20251001",
                                                            "name": "Haiku 4.5"})
    r = asyncio.run(_on("<body><textarea></textarea></body>", go))
    assert not r.ok and r.note.startswith("Asked for Haiku 4.5, got the site default")


def test_a_site_without_a_picker_just_says_so():
    async def go(page):
        return await picker.choose(page, S.site("perplexity"), {"id": "", "name": "GPT-6 Sol"})
    r = asyncio.run(_on((FIX / "perplexity-idle.html").read_text(encoding="utf-8"), go))
    assert not r.ok and r.note == "Asked for GPT-6 Sol, got the site default"


def test_no_pick_touches_nothing():
    async def go(page):
        r = await picker.choose(page, S.site("claude"), {})
        return r, await page.evaluate("window.__opens")
    r, opens = asyncio.run(_on(_clickable("claude-menu", "claude"), go))
    assert r.ok and opens == 0


# ── stored per person ────────────────────────────────────────────────────

def test_the_pick_is_per_profile(tmp_path, monkeypatch):
    from magi import accounts
    from magi import settings as Sm

    monkeypatch.setattr(Sm, "ROOT", tmp_path)
    was = Sm.active_profile()
    try:
        Sm.set_active_profile("tony")
        accounts.set_model("claude", {"id": "claude-haiku-4-5-20251001", "name": "Haiku 4.5"})
        accounts.set_chairman("gemini")
        Sm.set_active_profile("veda")
        assert accounts.model_choice("claude") == {}
        accounts.set_model("claude", {"id": "claude-sonnet-5-5", "name": "Sonnet 5.5"})
        Sm.set_active_profile("tony")
        assert accounts.model_choice("claude")["name"] == "Haiku 4.5"
        assert accounts.chairman_override() == "gemini"     # beside it, not over it
        accounts.set_model("claude", None)                   # back to Site default
        assert accounts.model_choice("claude") == {}
        Sm.set_active_profile("veda")
        assert accounts.model_choice("claude")["name"] == "Sonnet 5.5"
    finally:
        Sm.set_active_profile(was)


def test_an_empty_refresh_keeps_the_old_list(tmp_path, monkeypatch):
    from magi import accounts
    from magi import settings as Sm

    monkeypatch.setattr(Sm, "ROOT", tmp_path)
    accounts.save_models("grok", [{"id": "", "name": "Fast"}, {"id": "", "name": "Expert"}])
    accounts.save_models("grok", [])
    assert [o["name"] for o in accounts.models_seen("grok")["options"]] == ["Fast", "Expert"]


# ── the routes ───────────────────────────────────────────────────────────

@pytest.fixture
def api(tmp_path, monkeypatch):
    from starlette.testclient import TestClient
    from magi import app as app_mod
    from magi import settings as Sm
    from magi.db import Database
    from magi.engine import units

    monkeypatch.setattr(Sm, "ROOT", tmp_path)
    monkeypatch.delenv(Sm.api_token_env(), raising=False)
    monkeypatch.setattr(app_mod.settings, "db_path", tmp_path / "magi.db")
    asyncio.run(Database(tmp_path / "magi.db").init())
    monkeypatch.setattr(units, "pro_account", lambda refresh=False: None)
    return TestClient(app_mod.app, raise_server_exceptions=False)


def test_models_route_starts_on_the_known_list_and_site_default(api):
    d = api.get("/api/units/gemini/models").json()
    assert d["pickable"] and d["pick"] == {} and d["models_at"] is None
    assert [m["name"] for m in d["models"]] == ["3.5 Flash-Lite", "3.6 Flash", "3.1 Pro"]
    d = api.get("/api/units/chatgpt/models").json()
    assert d["pickable"] is False and d["models"] == []


def test_choosing_saves_and_shows_in_the_units_list(api):
    r = api.post("/api/units/gemini/model", json={"id": "9d8ca3786ebdfbea", "name": "3.1 Pro"})
    assert r.status_code == 200 and r.json()["pick"]["name"] == "3.1 Pro"
    u = {x["id"]: x for x in api.get("/api/units/usage").json()["units"]}
    assert u["gemini"]["pick"]["id"] == "9d8ca3786ebdfbea"
    assert u["claude"]["pick"] == {} and u["claude"]["pickable"]
    r = api.post("/api/units/gemini/model", json={})
    assert r.json()["pick"] == {}


def test_a_site_without_a_picker_refuses_a_pick(api):
    r = api.post("/api/units/chatgpt/model", json={"name": "gpt-5-6"})
    assert r.status_code == 400
    assert api.post("/api/units/chatgpt/model", json={}).status_code == 200


def test_refresh_keeps_what_the_account_shows(api, monkeypatch):
    from magi.providers.browser_base import BrowserProvider

    async def fake(self):
        return [{"id": "", "name": "Fast", "locked": False}, {"id": "", "name": "Heavy", "locked": True}]
    monkeypatch.setattr(BrowserProvider, "read_models", fake)
    d = api.post("/api/units/grok/models/refresh").json()
    assert d["ok"] and d["models_at"]
    assert [(m["name"], m["locked"]) for m in d["models"]] == [("Fast", False), ("Heavy", True)]


def test_refresh_waits_for_no_run(api, monkeypatch):
    from magi.browser import launcher
    monkeypatch.setattr(launcher, "in_use", lambda sid: sid == "grok")
    d = api.post("/api/units/grok/models/refresh").json()
    assert d["ok"] is False and d["error"] == "busy"


# ── a run whose pick fails still answers ─────────────────────────────────

class _Loc:
    first = None

    def __init__(self):
        self.first = self


def test_a_failed_pick_answers_on_what_the_site_gave(tmp_path, monkeypatch):
    """The whole point of U4's rule: the run is not failed, the answer is
    kept, and the card says what was asked for and what answered."""
    from magi import accounts
    from magi import settings as Sm
    from magi.browser import completion, humanize, launcher, overlay
    from magi.engine import validate
    from magi.providers import browser_base
    from magi.providers.base import RunContext

    monkeypatch.setattr(Sm, "ROOT", tmp_path)
    accounts.set_model("claude", {"id": "claude-opus-5-5", "name": "Opus 5.5"})
    asked = []

    class Page:
        async def goto(self, *a, **k): pass

    class Ctx:
        pages = [Page()]

    @asynccontextmanager
    async def launch(*a, **k):
        yield Ctx()

    async def choose(page, site, want):
        asked.append(want)
        return picker.Picked(ok=False, note="Asked for Opus 5.5, got Sonnet 5.5 Medium (locked on this account)",
                             label="Sonnet 5.5 Medium")

    async def nothing(*a, **k): return None
    async def no(*a, **k): return False
    async def blank(*a, **k): return ""
    async def label(*a, **k): return "Sonnet 5.5 Medium"
    async def found(*a, **k): return resolve.Resolved(selector="x", locator=_Loc(), count=1, index=0)
    async def done(*a, **k):
        return completion.CompletionResult(text="Paris is the capital of France.",
                                           reason=completion.CompletionReason.STOP_BUTTON,
                                           elapsed_ms=10, chars=30, turns_before=0, turns_after=1)

    monkeypatch.setattr(launcher, "launch", launch)
    monkeypatch.setattr(picker, "choose", choose)
    monkeypatch.setattr(resolve, "is_challenge_page", no)
    monkeypatch.setattr(resolve, "signed_out", no)
    monkeypatch.setattr(resolve, "rate_limited", blank)
    monkeypatch.setattr(resolve, "notice", blank)
    monkeypatch.setattr(resolve, "model_label", label)
    monkeypatch.setattr(resolve, "resolve", lambda *a, **k: found())
    monkeypatch.setattr(overlay, "dismiss", nothing)
    monkeypatch.setattr(overlay, "focus_composer", nothing)
    monkeypatch.setattr(completion, "capture_baseline", nothing)
    monkeypatch.setattr(completion, "wait_for_completion", done)
    monkeypatch.setattr(humanize, "insert_text", nothing)
    monkeypatch.setattr(humanize, "send", nothing)
    monkeypatch.setattr(validate, "validate_answer",
                        lambda *a, **k: validate.Validation(ok=True))
    s = load_settings()
    s.pacing.sample_post_nav = lambda: 0

    p = browser_base.BrowserProvider(s.site("claude"), s)
    ans = asyncio.run(p.ask("What is the capital of France?",
                            ctx=RunContext(run_id="r", question="What is the capital of France?")))
    assert asked == [{"id": "claude-opus-5-5", "name": "Opus 5.5"}]
    assert ans.ok and ans.text.startswith("Paris")
    assert ans.model == "Sonnet 5.5 Medium"
    assert ans.model_fallback == "Asked for Opus 5.5, got Sonnet 5.5 Medium (locked on this account)"


def test_a_new_pick_is_not_mistaken_for_the_confirmed_one():
    """The steady-state shortcut is keyed on the pick AND the label: after
    Haiku was confirmed, asking for Sonnet must click again."""
    async def go(page):
        site = S.site("claude")
        await picker.choose(page, site, {"id": "claude-haiku-4-5-20251001", "name": "Haiku 4.5"})
        r = await picker.choose(page, site, {"id": "claude-sonnet-5-5", "name": "Sonnet 5.5"})
        return r, await resolve.model_label(page, site)
    r, label = asyncio.run(_on(_clickable("claude-menu", "claude"), go))
    assert r.ok and r.changed and label == "Sonnet 5.5 Medium"
