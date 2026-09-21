"""Remembered usage limits, per agent and account slot.

When an agent hits its allowance and says when it resets, the chain should
skip it until then -- not rediscover the same wall on the next task, spending
a CLI launch and a few seconds to be told what it was told ten minutes ago.

Local to the engine and never synced: a limit belongs to an account slot on
THIS machine, and the slot's login does not exist anywhere else.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from ...settings import data_dir

# When an agent says "limited" without saying until when, assume a short wait
# rather than none. Retrying immediately just hits the wall again; waiting a
# whole five-hour window on a guess would sideline a working agent all day.
DEFAULT_BACKOFF_S = 15 * 60


def _path() -> Path:
    return data_dir() / "agent_limits.json"


def _load() -> dict:
    try:
        return json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save(d: dict) -> None:
    p = _path()
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=1), encoding="utf-8")
    tmp.replace(p)


def key(agent: str, slot: str) -> str:
    return f"{agent}:{slot}"


def mark(agent: str, slot: str, resets_at: float | None, reason: str = "") -> float:
    """Record a limit. Returns when it lifts."""
    until = resets_at if resets_at and resets_at > time.time() else time.time() + DEFAULT_BACKOFF_S
    d = _load()
    d[key(agent, slot)] = {"until": until, "reason": reason, "at": time.time()}
    _save(d)
    return until


def clear(agent: str, slot: str) -> None:
    d = _load()
    if d.pop(key(agent, slot), None) is not None:
        _save(d)


def blocked_until(agent: str, slot: str) -> float | None:
    """When this slot is usable again, or None if it is usable now."""
    rec = _load().get(key(agent, slot))
    if not rec:
        return None
    until = float(rec.get("until") or 0)
    if until <= time.time():
        return None
    return until


def note_usage(agent: str, slot: str, window: str, utilization: float,
               resets_at: float | None) -> None:
    """Keep the latest utilisation an agent reported, for the UI.

    Claude reports this on every run (five-hour and seven-day windows), which
    is what lets MAGI show "71% of the week used" BEFORE the wall rather than
    only announcing it after.
    """
    d = _load()
    u = d.setdefault("_usage", {}).setdefault(key(agent, slot), {})
    u[window] = {"utilization": utilization, "resets_at": resets_at, "at": time.time()}
    _save(d)


def usage(agent: str, slot: str) -> dict:
    return (_load().get("_usage") or {}).get(key(agent, slot), {})


def snapshot() -> dict:
    """Everything, for /api/code/agents."""
    d = _load()
    now = time.time()
    return {
        "limits": {k: v for k, v in d.items()
                   if not k.startswith("_") and float(v.get("until") or 0) > now},
        "usage": d.get("_usage") or {},
    }
