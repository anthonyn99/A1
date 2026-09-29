"""Choosing a unit's model on its own site (Phase U4).

Three sites have a picker a free or Pro account can drive -- Claude (both
accounts), Gemini and Grok (docs/magi-plan.md, Track S, "Phase U1"). ChatGPT,
Perplexity and DeepSeek have none, so their only choice is "Site default".

THE ONE RULE: A PICK NEVER FAILS A RUN
--------------------------------------
Everything here returns a value and never raises. An option the account
cannot use (locked, gone, a menu that did not open) leaves the chat on
whatever the site gives, the unit answers anyway, and the card says "Asked
for X, got Y". Losing a member's whole answer because a menu moved would be
a far worse outcome than an answer from the wrong model that says so.

WHAT COUNTS AS "GOT IT"
-----------------------
The menu's own selected mark (`model_selected`), read on the option we
wanted -- never the label's wording. Labels and options name the same model
differently (Gemini's label says "Gemini Flash", its option "3.6 Flash";
Claude's label adds the effort, "Sonnet 5.5 Medium"), and a word match would
confuse "Flash" with "Flash-Lite". So a pick is confirmed by opening the menu
again and seeing the check on the right row. That costs one extra click, but
only when the model actually changes: the sites remember the last pick, and
`_CONFIRMED` remembers which label that pick produced, so a steady-state run
reads the label once and touches no menu at all.

Sites remember a pick across chats, so "Site default" means "leave it as
it is", not "put it back": after choosing Haiku once, Site default stays on
Haiku until you pick something else here or on claude.ai.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from playwright.async_api import Page

from . import resolve

# The option's name: its first non-empty text node. innerText is useless
# here -- Claude's row runs name, description and badge together
# ("Sonnet 5.5Most efficient for simpler tasks") -- but the name is always
# the first text inside the row, on every site U1 looked at.
_OPTION_JS = """(e, sels) => {
  const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
  let name = "";
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = n.textContent.replace(/[\\ue000-\\uf8ff]/g, "").trim();
    if (t) { name = t; break; }
  }
  const is = (list) => list.some((s) => { try { return e.matches(s); } catch (x) { return false; } });
  return {
    id: e.getAttribute("data-model-id") || e.getAttribute("data-mode-id") || "",
    name: name.slice(0, 60),
    selected: is(sels.selected),
    locked: is(sels.locked),
  };
}"""

MENU_WAIT_MS = 3000
# Long enough for a framework re-render after a click, short enough not to
# show up in a run's time.
SETTLE_S = 0.6

# (site id) -> (option key, the label the site showed once that pick was
# confirmed). Per engine process: a restart costs one menu open per unit.
_CONFIRMED: dict[str, tuple[str, str]] = {}


@dataclass
class Picked:
    """What `choose` did. `note` is "" when the chat is on the wanted model."""

    ok: bool
    note: str = ""
    changed: bool = False   # a click actually moved the site to another model
    label: str = ""         # the site's label afterwards, when it shows one


def has_picker(site) -> bool:
    return bool(site.model_button and site.model_option)


def key_of(opt: dict) -> str:
    """How an option is matched: its id where the site gives one (Claude's
    API id, Gemini's mode id), its name where it does not (Grok)."""
    return str(opt.get("id") or opt.get("name") or "").strip()


def known(site) -> list[dict]:
    """The options U1 saw, from `model_known` ("id | name"), until a Refresh
    replaces them with what the account really offers."""
    out = []
    for raw in getattr(site, "model_known", None) or []:
        oid, _, name = str(raw).partition("|")
        oid, name = oid.strip(), name.strip()
        if not name:
            oid, name = "", oid
        out.append({"id": oid, "name": name, "locked": False})
    return out


def _same(opt: dict, want: dict) -> bool:
    if want.get("id") and opt.get("id"):
        return opt["id"] == want["id"]
    return (opt.get("name") or "").strip().lower() == (want.get("name") or "").strip().lower()


def asked_note(want: dict, got: str) -> str:
    """The card's words for a pick that did not land. Never a failure."""
    return f"Asked for {want.get('name') or key_of(want)}, got {got or 'the site default'}"


async def _read(page: Page, site) -> list[tuple[dict, object]]:
    """Every option row on screen now, choosable ones first, with its element."""
    sels = {"selected": list(site.model_selected), "locked": list(site.model_locked)}
    rows, seen = [], set()
    for group in (site.model_option, site.model_locked):
        for css in group:
            try:
                loc = page.locator(css)
                n = await loc.count()
            except Exception:
                continue
            for i in range(n):
                el = loc.nth(i)
                try:
                    # A closed submenu's rows can be in the DOM; clicking one
                    # would wait out the timeout and read as a failed pick.
                    if not await el.is_visible():
                        continue
                    info = await el.evaluate(_OPTION_JS, sels)
                except Exception:
                    continue
                k = (info["id"], info["name"])
                if not info["name"] or k in seen:
                    continue
                seen.add(k)
                rows.append((info, el))
    return rows


async def _open(page: Page, site) -> bool:
    btn = await resolve.resolve(page, site.model_button, timeout_ms=MENU_WAIT_MS)
    if btn is None:
        return False
    try:
        await btn.locator.first.click(timeout=MENU_WAIT_MS)
    except Exception:
        return False
    first = list(site.model_option) + list(site.model_locked)
    return await resolve.resolve(page, first, timeout_ms=MENU_WAIT_MS) is not None


async def _open_more(page: Page, site) -> bool:
    """Hover "More models" (Claude Pro's older models live in a submenu)."""
    more = await resolve.resolve(page, site.model_more, timeout_ms=0)
    if more is None:
        return False
    try:
        await more.locator.first.hover(timeout=MENU_WAIT_MS)
        await asyncio.sleep(SETTLE_S)
        return True
    except Exception:
        return False


async def _close(page: Page) -> None:
    for _ in range(2):
        try:
            await page.keyboard.press("Escape")
        except Exception:
            return


async def list_options(page: Page, site) -> list[dict]:
    """Everything the picker offers this account, locked rows included and
    marked, with the currently selected one flagged. [] when there is no
    picker or it would not open. Leaves the menu closed."""
    if not has_picker(site):
        return []
    try:
        if not await _open(page, site):
            return []
        rows = [info for info, _ in await _read(page, site)]
        if site.model_more and await _open_more(page, site):
            have = {(r["id"], r["name"]) for r in rows}
            rows += [i for i, _ in await _read(page, site) if (i["id"], i["name"]) not in have]
        return [{"id": r["id"], "name": r["name"], "locked": bool(r["locked"] and not r["selected"]),
                 "selected": bool(r["selected"])} for r in rows]
    except Exception:
        return []
    finally:
        await _close(page)


async def _find(page: Page, site, want: dict):
    for info, el in await _read(page, site):
        if _same(info, want):
            return info, el
    if site.model_more and await _open_more(page, site):
        for info, el in await _read(page, site):
            if _same(info, want):
                return info, el
    return None, None


async def choose(page: Page, site, want: dict) -> Picked:
    """Put this chat on `want` ({"id", "name"}), and say whether it worked.

    Never raises. The steady state -- the site already on the pick, the
    label the same as when it was last confirmed -- reads one label and
    opens nothing."""
    if not want or not key_of(want):
        return Picked(ok=True)
    if not has_picker(site):
        return Picked(ok=False, note=asked_note(want, await resolve.model_label(page, site)))
    key = key_of(want)
    label = await resolve.model_label(page, site)
    seen = _CONFIRMED.get(site.id)
    if label and seen and seen == (key, label):
        return Picked(ok=True, label=label)

    try:
        if not await _open(page, site):
            await _close(page)
            return Picked(ok=False, note=asked_note(want, label) + " (its model menu did not open)",
                          label=label)
        info, el = await _find(page, site, want)
        if info is None:
            await _close(page)
            return Picked(ok=False, note=asked_note(want, label) + " (no longer offered)", label=label)
        if info["selected"]:
            await _close(page)
            _CONFIRMED[site.id] = (key, label)
            return Picked(ok=True, label=label)
        if info["locked"]:
            await _close(page)
            return Picked(ok=False, note=asked_note(want, label) + " (locked on this account)",
                          label=label)
        try:
            await el.click(timeout=MENU_WAIT_MS)
        except Exception:
            await _close(page)
            return Picked(ok=False, note=asked_note(want, label), label=label)
        await asyncio.sleep(SETTLE_S)
        await _close(page)

        # Confirm on the menu's own mark, not the label's wording.
        after = await resolve.model_label(page, site)
        if not await _open(page, site):
            await _close(page)
            # Nothing to confirm with; the label moved, so the click took.
            ok = bool(after and after != label)
            return Picked(ok=ok, changed=ok, label=after,
                          note="" if ok else asked_note(want, after))
        info, _ = await _find(page, site, want)
        await _close(page)
        if info is not None and info["selected"]:
            _CONFIRMED[site.id] = (key, after)
            return Picked(ok=True, changed=True, label=after)
        # A site that takes the click and then refuses (an upgrade dialog on
        # a plan that cannot use it) leaves the old model selected.
        await _close(page)
        return Picked(ok=False, note=asked_note(want, after or label), label=after or label)
    except Exception:
        await _close(page)
        return Picked(ok=False, note=asked_note(want, label), label=label)


def forget(site_id: str | None = None) -> None:
    """Drop the remembered confirmations (a new pick, or tests)."""
    if site_id is None:
        _CONFIRMED.clear()
    else:
        _CONFIRMED.pop(site_id, None)
