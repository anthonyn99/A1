"""Effort / thinking as part of the pick (2026-10-01).

U4 picks each unit's model; this picks the other half: Claude's Effort level
(Low..Max, a submenu of the model menu), Gemini's Extended thinking (an item
in the mode menu), ChatGPT's Think and DeepSeek's DeepThink (aria-pressed
toggles by the composer). Driven on the real U1 fixtures, made clickable by
a small script that behaves as each site did. Same rules as the model: a
choice is confirmed on the control's own state, never raises, and one that
does not land is said on the card ("Asked for High effort, left as ...").
"""

from __future__ import annotations

import asyncio
import json
import re

import pytest

from magi import accounts
from magi.browser import picker
from magi.settings import load_settings

from test_model_pick import FIX, _on  # noqa: F401 -- the browser harness

S = load_settings()


@pytest.fixture(autouse=True)
def _fresh():
    picker.forget()
    yield
    picker.forget()


@pytest.fixture(autouse=True)
def _quick(monkeypatch):
    monkeypatch.setattr(picker, "SETTLE_S", 0.05)
    monkeypatch.setattr(picker, "MENU_WAIT_MS", 1500)


# ── which units have what ────────────────────────────────────────────────

def test_the_kind_of_control_per_unit():
    got = {u: picker.effort_kind(S.site(u)) for u in
           ("chatgpt", "claude", "claude-pro", "gemini", "grok", "perplexity", "deepseek")}
    assert got == {"chatgpt": "toggle", "claude": "levels", "claude-pro": "levels",
                   "gemini": "menu_toggle", "grok": "", "perplexity": "", "deepseek": "toggle"}
    assert picker.effort_options(S.site("claude")) == ["Low", "Medium", "High", "Extra", "Max"]
    assert picker.effort_options(S.site("gemini")) == ["on", "off"]
    assert picker.effort_options(S.site("grok")) == []
    assert [picker.effort_label(S.site(u)) for u in ("claude", "gemini", "chatgpt", "deepseek")] == \
        ["Effort", "Extended thinking", "Think", "DeepThink"]


# ── clickable fixtures ───────────────────────────────────────────────────

_CLAUDE = r"""<script>
(() => {
  const btn = document.querySelector("button[data-testid='model-selector-dropdown']");
  const top = document.querySelector("[role='menu']:not([data-nested])");
  const sub = document.querySelector("[role='menu'][data-nested]");
  const hide = () => { top.style.display = "none"; sub.style.display = "none"; };
  hide();
  btn.addEventListener("click", () => { top.style.display = ""; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  for (const it of top.querySelectorAll("[aria-haspopup='menu']")) {
    if (/Effort/.test(it.textContent)) it.addEventListener("mouseenter", () => { sub.style.display = ""; });
  }
  const REFUSE = __REFUSE__;
  document.addEventListener("click", (e) => {
    const it = e.target.closest("[role='menuitemradio'][data-effort-id]");
    if (!it) return;
    if (!REFUSE) {
      sub.querySelectorAll("[data-effort-id]").forEach((o) => o.setAttribute("aria-checked", "false"));
      it.setAttribute("aria-checked", "true");
      const lvl = it.textContent.trim().split(/\s/)[0];
      btn.setAttribute("aria-label", "Model: Sonnet 5.5 " + lvl);
    }
    hide();
  });
})();
</script>"""


def _claude(refuse=False) -> str:
    html = (FIX / "claude-pro-effort.html").read_text(encoding="utf-8")
    menu = (FIX / "claude-pro-menu.html").read_text(encoding="utf-8")
    btn = re.search(r"<button[^>]*model-selector-dropdown.*?</button>", menu, re.S).group(0)
    return html.replace("<body>", "<body>" + btn, 1) + _CLAUDE.replace("__REFUSE__", json.dumps(refuse))


_GEMINI = r"""<script>
(() => {
  const btn = document.querySelector("button[aria-label^='Open mode picker']");
  const menu = document.querySelector("[data-test-id='gem-mode-menu']");
  const hide = () => { menu.style.display = "none"; };
  hide();
  btn.addEventListener("click", () => { menu.style.display = ""; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  document.addEventListener("click", (e) => {
    const it = e.target.closest("[role='menuitem']:not([data-mode-id])");
    if (!it) return;
    const on = it.querySelector("[aria-label='Selected']");
    if (on) on.remove();
    else { const s = document.createElement("gem-icon"); s.setAttribute("aria-label", "Selected"); it.prepend(s); }
    hide();
  });
})();
</script>"""


def _toggle_script(text: str, refuse=False) -> str:
    # By its text: the unit's selectors use Playwright's :has-text(), which
    # document.querySelector cannot parse.
    return ("<script>(() => { const t = [...document.querySelectorAll('[aria-pressed]')]"
            ".find((x) => x.textContent.trim() === " + json.dumps(text) + ");"
            + ("" if refuse else
               " t.addEventListener('click', () => t.setAttribute('aria-pressed',"
               " t.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'));")
            + " })();</script>")


def _toggle(fixture: str, unit: str, refuse=False) -> str:
    html = (FIX / f"{fixture}.html").read_text(encoding="utf-8")
    return html + _toggle_script(picker.effort_label(S.site(unit)), refuse)


def _state(page, css):
    return page.locator(css).first.get_attribute("aria-pressed")


# ── Claude: the Effort submenu ───────────────────────────────────────────

def test_claude_effort_is_chosen_and_confirmed():
    site = S.site("claude-pro")

    async def go(page):
        r = await picker.choose_effort(page, site, "High")
        checked = await page.locator("[data-effort-id][aria-checked='true']").get_attribute("data-effort-id")
        return r, checked
    r, checked = asyncio.run(_on(_claude(), go))
    assert r.ok and r.changed and r.note == ""
    assert checked == "high"


def test_claude_effort_already_on_opens_once_and_changes_nothing():
    async def go(page):
        return await picker.choose_effort(page, S.site("claude-pro"), "Medium")
    r = asyncio.run(_on(_claude(), go))
    assert r.ok and not r.changed


def test_claude_effort_that_does_not_take_says_so():
    async def go(page):
        return await picker.choose_effort(page, S.site("claude-pro"), "Max")
    r = asyncio.run(_on(_claude(refuse=True), go))
    assert not r.ok and r.note.startswith("Asked for Max effort")


def test_an_unknown_level_is_not_offered():
    async def go(page):
        return await picker.choose_effort(page, S.site("claude-pro"), "Turbo")
    r = asyncio.run(_on(_claude(), go))
    assert not r.ok and "not offered" in r.note


def test_a_confirmed_level_is_not_reopened_next_time():
    async def go(page):
        await picker.choose_effort(page, S.site("claude-pro"), "High")
        opens = await page.evaluate("() => 0")
        r = await picker.choose_effort(page, S.site("claude-pro"), "High")
        visible = await page.locator("[role='menu']:not([data-nested])").is_visible()
        return r, visible, opens
    r, visible, _ = asyncio.run(_on(_claude(), go))
    assert r.ok and not r.changed and not visible


# ── Gemini: Extended thinking in the mode menu ───────────────────────────

def test_gemini_extended_thinking_on_then_off():
    site = S.site("gemini")
    item = "[data-test-id='gem-mode-menu'] [role='menuitem']:not([data-mode-id])"

    async def go(page):
        on = await picker.choose_effort(page, site, "on")
        is_on = await page.locator(item + " [aria-label='Selected']").count()
        picker.forget("gemini")
        off = await picker.choose_effort(page, site, "off")
        is_off = await page.locator(item + " [aria-label='Selected']").count()
        return on, is_on, off, is_off
    on, is_on, off, is_off = asyncio.run(_on((FIX / "gemini-menu.html").read_text(encoding="utf-8") + _GEMINI, go))
    assert on.ok and on.changed and is_on == 1
    assert off.ok and off.changed and is_off == 0


# ── ChatGPT / DeepSeek: toggles by the composer ──────────────────────────

@pytest.mark.parametrize("unit,fixture", [("chatgpt", "chatgpt-idle"), ("deepseek", "deepseek-idle")])
def test_a_think_toggle_is_switched_and_confirmed(unit, fixture):
    site = S.site(unit)

    async def go(page):
        r = await picker.choose_effort(page, site, "on")
        return r, await _state(page, site.think_toggle[0])
    r, state = asyncio.run(_on(_toggle(fixture, unit), go))
    assert r.ok and r.changed and state == "true"


def test_a_toggle_already_off_is_left_alone():
    site = S.site("chatgpt")

    async def go(page):
        return await picker.choose_effort(page, site, "off")
    r = asyncio.run(_on(_toggle("chatgpt-idle", "chatgpt"), go))
    assert r.ok and not r.changed


def test_a_toggle_that_does_not_take_says_so():
    async def go(page):
        return await picker.choose_effort(page, S.site("deepseek"), "on")
    r = asyncio.run(_on(_toggle("deepseek-idle", "deepseek", refuse=True), go))
    assert not r.ok and r.note == "Asked for DeepThink on, left as the site had it"


def test_site_default_touches_nothing():
    async def go(page):
        return await picker.choose_effort(page, S.site("chatgpt"), "")
    r = asyncio.run(_on(_toggle("chatgpt-idle", "chatgpt"), go))
    assert r.ok and not r.changed


# ── stored per person, offered by the sheet, guarded by the route ────────

def test_the_choice_is_stored_and_cleared(tmp_path, monkeypatch):
    store = {}
    monkeypatch.setattr(accounts, "_load", lambda: json.loads(json.dumps(store)))
    monkeypatch.setattr(accounts, "_save", lambda st: (store.clear(), store.update(st)))
    assert accounts.effort_choice("claude") == ""
    assert accounts.set_effort("claude", "High") == "High"
    assert accounts.effort_choice("claude") == "High"
    assert accounts.set_effort("claude", "") == ""
    assert "effort" not in store.get("claude", {})


def test_the_route_refuses_what_a_unit_does_not_offer(tmp_path, monkeypatch):
    from starlette.testclient import TestClient
    from magi import app as app_mod
    from magi import settings as Sm

    monkeypatch.delenv(Sm.api_token_env(), raising=False)
    saved = {}
    monkeypatch.setattr(accounts, "set_effort", lambda pid, v: saved.__setitem__(pid, v) or v)
    monkeypatch.setattr(app_mod, "_unit_menu", lambda pid: {"ok": True, "id": pid})
    api = TestClient(app_mod.app, raise_server_exceptions=False)
    assert api.post("/api/units/claude/effort", json={"value": "High"}).status_code == 200
    assert saved["claude"] == "High"
    assert api.post("/api/units/claude/effort", json={"value": "on"}).status_code == 400
    assert api.post("/api/units/grok/effort", json={"value": "on"}).status_code == 400
    assert api.post("/api/units/gemini/effort", json={"value": "on"}).status_code == 200
    assert api.post("/api/units/gemini/effort", json={}).status_code == 200
    assert saved["gemini"] == ""


# ── a toggle that opens a dialog (free ChatGPT, 2026-10-01) ──────────────
# The first switch to Think opened "Get smarter answers -- Upgrade to Plus /
# Turn on" over the composer, and the run timed out behind it.

_DIALOG = r"""<dialog id="dlg"><p>Get smarter answers</p>
<button id="up">Upgrade to Plus</button> <button id="on">__ON__</button></dialog>
<script>(() => {
  const t = [...document.querySelectorAll('[aria-pressed]')].find((x) => x.textContent.trim() === 'Think');
  const d = document.getElementById('dlg');
  window.__upgrade = 0;
  t.addEventListener('click', () => { t.setAttribute('aria-pressed', 'true'); d.showModal(); });
  document.getElementById('up').addEventListener('click', () => { window.__upgrade++; });
  document.getElementById('on').addEventListener('click', () => d.close());
})();</script>"""


def _dialog_page(confirm_text="Turn on") -> str:
    html = (FIX / "chatgpt-idle.html").read_text(encoding="utf-8")
    return html + _DIALOG.replace("__ON__", confirm_text)


def test_the_first_think_dialog_is_turned_on_never_upgraded():
    site = S.site("chatgpt")

    async def go(page):
        r = await picker.choose_effort(page, site, "on")
        return (r, await page.evaluate("document.getElementById('dlg').open"),
                await page.evaluate("window.__upgrade"), await _state(page, site.think_toggle[0]))
    r, still_open, upgrades, state = asyncio.run(_on(_dialog_page(), go))
    assert r.ok and state == "true"
    assert not still_open, "the dialog must not be left over the composer"
    assert upgrades == 0


def test_a_dialog_without_a_free_way_is_closed_not_clicked():
    """No "Turn on" in it: closed with Escape so the run can type."""
    site = S.site("chatgpt")

    async def go(page):
        await picker.choose_effort(page, site, "on")
        return (await page.evaluate("document.getElementById('dlg').open"),
                await page.evaluate("window.__upgrade"))
    still_open, upgrades = asyncio.run(_on(_dialog_page("Maybe later?"), go))
    assert not still_open and upgrades == 0


def test_chatgpt_has_a_think_confirm_and_it_is_not_an_upgrade():
    sels = S.site("chatgpt").think_confirm
    assert sels and all("Turn on" in s and "Upgrade" not in s for s in sels)
