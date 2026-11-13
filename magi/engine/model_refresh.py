"""Every unit's model list, re-read once a week without a tap.

The Units sheet's Model dropdown lists what MAGI last saw on the site, and its
Refresh reads this account's own (locked ones marked) by opening the site once,
nothing sent (app.py units_refresh_models). A site that adds a model -- a new
Sonnet, a new Gemini mode -- is invisible until someone taps Refresh. So the
engine taps it for every unit with a picker, once a week:

  * The slot is **Monday 4:00 AM local**: before the 6 AM kickstart and the
    6 AM daily Analysis, when nothing else wants a browser. A PC that was off
    or asleep then catches up at the first moment after (the slot is "the
    most recent Monday 4 AM", done once).
  * Units go one at a time. One busy in a run is retried every few minutes;
    a read that fails (signed out, menu did not open) keeps the old list, as
    Refresh does, and is not retried until next week.
  * Code Mode's Claude and Codex catalogs (code/agents/models.py) refresh
    themselves every few hours already; the weekly pass forces them too, so
    every model list in MAGI is fresh on Monday morning.

State: data/<profile>/model_refresh.json ({slot, units: {id: {at, ok, msg}}}).
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta
from pathlib import Path

from ..settings import data_dir

WEEKDAY = 0                      # Monday
HOUR, MINUTE = 4, 0              # local time
FIRST_TICK_S = 120               # let the engine settle after a start
IDLE_S = 900                     # nothing due: look again in 15 minutes
BUSY_S = 180                     # a unit in a run: try it again in 3 minutes
GAP_S = 20                       # between two units' browsers


def slot_for(now: datetime) -> datetime:
    """The most recent Monday 4:00 AM at or before `now` (naive local). Pure."""
    d = now.replace(hour=HOUR, minute=MINUTE, second=0, microsecond=0)
    d -= timedelta(days=(d.weekday() - WEEKDAY) % 7)
    if d > now:
        d -= timedelta(days=7)
    return d


def next_slot(now: datetime) -> datetime:
    return slot_for(now) + timedelta(days=7)


def _path() -> Path:
    return data_dir() / "model_refresh.json"


def load_state() -> dict:
    try:
        d = json.loads(_path().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def save_state(d: dict) -> None:
    p = _path()
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=1), encoding="utf-8")
    tmp.replace(p)


def pending(state: dict, slot: datetime, unit_ids: list[str]) -> list[str]:
    """Units not yet read for this slot, in order. Pure."""
    key = slot.isoformat()
    done = state.get("units", {}) if state.get("slot") == key else {}
    return [u for u in unit_ids if u not in done]


def pickable_units(settings) -> list[str]:
    from ..browser import picker
    return [pid for pid, site in settings.sites.items() if picker.has_picker(site)]


def refresh_code_catalogs() -> None:
    """Code Mode's Claude and Codex model lists, re-read now (HTTP, no model call)."""
    from ..code.agents import models, slots
    for agent in slots.AGENTS:
        for slot in slots.list_slots(agent):
            try:
                models.catalog(agent, slot, force=True)
            except Exception:  # noqa: BLE001 -- the cached list stays
                pass


async def read_unit(settings, build_providers, pid: str) -> tuple[str, str]:
    """('ok' | 'busy' | 'failed', message): one Refresh, as the button does."""
    from .. import accounts
    from ..browser import launcher
    if launcher.in_use(pid):
        return "busy", "in a run"
    p = build_providers(settings, [pid])[0]
    try:
        opts = await p.read_models()
    except Exception as e:  # noqa: BLE001 -- keep the old list
        return "failed", str(e)[:200]
    if not opts:
        return "failed", "the model menu did not open; old list kept"
    accounts.save_models(pid, opts)
    return "ok", f"{len(opts)} models"


async def tick(settings, build_providers, *, now: datetime | None = None) -> float:
    """Does what is due; returns seconds until the next look."""
    now = now or datetime.now()
    slot = slot_for(now)
    state = load_state()
    if state.get("slot") != slot.isoformat():
        state = {"slot": slot.isoformat(), "units": {}, "code": False}
    if not state.get("code"):
        await asyncio.to_thread(refresh_code_catalogs)
        state["code"] = True
        save_state(state)
    todo = pending(state, slot, pickable_units(settings))
    busy = False
    for i, pid in enumerate(todo):
        if i:
            await asyncio.sleep(GAP_S)
        status, msg = await read_unit(settings, build_providers, pid)
        if status == "busy":
            busy = True
            continue
        state["units"][pid] = {"at": datetime.now().isoformat(timespec="seconds"),
                               "ok": status == "ok", "msg": msg}
        save_state(state)
    if busy:
        return float(BUSY_S)
    return float(min(IDLE_S, max(60.0, (next_slot(now) - datetime.now()).total_seconds())))


def status(now: datetime | None = None) -> dict:
    now = now or datetime.now()
    st = load_state()
    return {"last_slot": st.get("slot"), "units": st.get("units", {}),
            "next": next_slot(now).isoformat(timespec="minutes")}


async def auto_loop(settings, build_providers) -> None:
    await asyncio.sleep(FIRST_TICK_S)
    while True:
        try:
            wait = await tick(settings, build_providers)
        except Exception:  # noqa: BLE001 -- this must never take the engine down
            wait = float(IDLE_S)
        await asyncio.sleep(wait)
