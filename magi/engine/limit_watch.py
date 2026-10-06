"""Claude (free)'s message cap, recognised without anyone tapping "Check now".

Claude (Pro) is read from Code Mode's usage numbers. The free account has no
such numbers, but its cap is written on the page itself: a plain load of
claude.ai/new shows "You are out of free messages until 11:40 AM" (verified
2026-10-06, nothing sent). So this loop watches the cap the cheap way:

  * Nothing is opened while the unit is fine. A run that hits the cap records
    it, with its reset time (engine/usage.py), and that is how this loop learns
    of one.
  * While the unit is limited it sleeps until the reset time, then opens the
    site once (the same probe as "Check now", signed in as you, nothing sent).
    Cleared: the card goes back to OK. Still capped: the new time is read off
    the page and the loop sleeps until that one.
  * A cap with no reset time is looked at every 30 minutes.

A probe never runs while a run or Brainstorm holds the unit's profile; it
tries again a minute later.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from . import units, usage
from ..browser import launcher

WATCHED = ("claude",)            # the FREE account; Pro has its own numbers
FIRST_TICK_S = 90
IDLE_S = 600                     # nothing limited: re-read the verdict (no browser)
NO_RESET_S = 1800                # limited, no reset time known
AFTER_RESET_S = 75               # the site needs a moment to lift its wall
BUSY_S = 60
MIN_GAP_S = 300                  # never two probes closer than this per unit


def next_wait(entry: dict, now: datetime, last_probe: datetime | None,
              was_limited: bool) -> tuple[float, bool]:
    """(seconds until the next look, whether to probe NOW). Pure.

    `was_limited` is whether the previous pass saw the unit limited: a wall
    that has just run out of time is probed once to confirm it is gone."""
    limit = entry.get("limit")
    gap = (now - last_probe).total_seconds() if last_probe else 1e9
    if not limit:
        # The wall's time ran out since the last pass: confirm once.
        if was_limited and gap >= MIN_GAP_S:
            return 0.0, True
        return float(IDLE_S), False
    reset = usage._parse_at(limit.get("resets_at"))
    if reset is None:
        return (0.0, True) if gap >= NO_RESET_S else (NO_RESET_S - gap, False)
    until = (reset - now).total_seconds() + AFTER_RESET_S
    if until > 0:
        return until, False
    return (0.0, True) if gap >= MIN_GAP_S else (MIN_GAP_S - gap, False)


async def probe(settings, build_providers, provider_id: str) -> bool:
    """One "Check now" for a unit. True when the site was reached."""
    if launcher.in_use(provider_id):
        return False
    p = build_providers(settings, [provider_id])[0]
    try:
        r = await p.health_check()
    except Exception:  # noqa: BLE001 -- keep the old reading
        return False
    return units.save_check(settings.db_path, provider_id, r)["reachable"]


async def auto_loop(settings, build_providers) -> None:
    await asyncio.sleep(FIRST_TICK_S)
    last: dict[str, datetime] = {}
    limited: dict[str, bool] = {}
    while True:
        wait = float(IDLE_S)
        for pid in WATCHED:
            try:
                if pid not in settings.sites:
                    continue
                p = build_providers(settings, [pid])[0]
                entry = await units.unit(settings.db_path, p)
                now = datetime.now(timezone.utc)
                w, go = next_wait(entry, now, last.get(pid), limited.get(pid, False))
                if go:
                    if await probe(settings, build_providers, pid):
                        last[pid] = datetime.now(timezone.utc)
                        entry = await units.unit(settings.db_path, p)
                        w, _ = next_wait(entry, datetime.now(timezone.utc),
                                         last[pid], False)
                    else:
                        w = float(BUSY_S)
                limited[pid] = bool(entry.get("limit"))
                wait = min(wait, max(30.0, w))
            except Exception:  # noqa: BLE001 -- this must never take the engine down
                pass
        await asyncio.sleep(wait)
