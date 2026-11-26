"""Claude and Codex reset times, pushed to the owner's TaskHub.

Each engine serves one person, so Tony's engine pushes to Tony's TaskHub and
Veda's to hers. Reset times come from the profile's sign-in in Code Mode.
That is the only place a reset time can be read without opening a browser
(the oauth usage endpoint, see code/agents/usage_fetch.py).

Where it goes, and why that way:

    engine --POST--> taskhub-reminders /<agent>-resets --> Firestore
                       dashboards/<agent>_resets_<profile>   (TaskHub renders it)
                       reminders/<id>                        (the push at reset)

  * The engine has no Firebase credentials, and Firestore enforces App Check,
    so it cannot write there itself. The reminders worker already holds a
    service account and owns the reminder docs, so the write belongs there.
    It checks the engine's MAGI API token against the one the console
    published in dashboards/magi (or magi_veda), so no new secret exists.
  * The events are NOT written into dashboards/main or vedasdash. TaskHub
    rewrites those wholesale from React state, and external data in them has
    wedged a device before; it renders this doc in the week view instead,
    the way it renders catalysts and OneInbox cards. Each device converts the
    stored instant to its own clock, so a time zone change needs no push.

It posts only when what should be on the calendar changes: a new window
opening, a window ending (the old event goes), or a settings change. A few
posts a day; nothing on a quiet tick.
"""

from __future__ import annotations

import asyncio
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

from ..settings import active_profile, api_token, data_dir

ENDPOINT = "https://taskhub-reminders.av1.workers.dev"
PROFILES = ("tony", "veda")
AGENTS = ("claude", "codex")
DEFAULTS = {"enabled": True, "notify": True, "weekly": False}
CODEX_WINDOWS = {"5h": "five_hour", "7d": "seven_day", "30d": "thirty_day"}

FIRST_TICK_S = 45
TICK_S = 300
READ_EVERY_S = 600          # a usage read, only while no future reset is known
POST_TIMEOUT_S = 15

_locks = {agent: asyncio.Lock() for agent in AGENTS}


# ── config and state (one file, per profile) ────────────────────────────────

def _path(agent: str) -> Path:
    return data_dir() / f"{agent}_resets.json"


def _load(agent: str) -> dict:
    try:
        d = json.loads(_path(agent).read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(d: dict, agent: str) -> None:
    p = _path(agent)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=1), encoding="utf-8")
    tmp.replace(p)


def config(agent: str = "claude") -> dict:
    return clean({**DEFAULTS, **(_load(agent).get("config") or {})})


def clean(cfg: dict) -> dict:
    return {k: bool(cfg.get(k, v)) for k, v in DEFAULTS.items()}


def save_config(changes: dict, agent: str = "claude") -> dict:
    d = _load(agent)
    d["config"] = clean({**config(agent), **{k: v for k, v in (changes or {}).items()
                                        if k in DEFAULTS}})
    _save(d, agent)
    return d["config"]


def state(agent: str = "claude") -> dict:
    s = _load(agent).get("state")
    return s if isinstance(s, dict) else {}


def _put_state(s: dict, agent: str) -> None:
    d = _load(agent)
    d["state"] = s
    _save(d, agent)


# ── the account ──────────────────────────────────────────────────────────────

def account_slot(agent: str = "claude") -> str | None:
    """Prefer a signed-in Pro slot. Codex also prefers Plus to Free."""
    try:
        from ..code.agents import models, slots, usage_fetch
    except Exception:  # noqa: BLE001 -- Code Mode is optional
        return None
    names = slots.list_slots(agent)
    if agent == "codex":
        signed_in = [s for s in names if usage_fetch.codex_tokens(s).get("access_token")]
        rank = {"pro": 2, "plus": 1}
        return max(signed_in, key=lambda s: rank.get(models.plan_of(agent, s), 0), default=None)
    for s in names:
        if models.plan_of("claude", s) == "pro":
            return s
    for s in names:
        try:
            if usage_fetch._claude_creds(s).exists():
                return s
        except Exception:  # noqa: BLE001
            continue
    return None


def plan_of(slot: str, agent: str = "claude") -> str:
    try:
        from ..code.agents import models
        return models.plan_of(agent, slot) or ""
    except Exception:  # noqa: BLE001
        return ""


def label_of(slot: str, agent: str = "claude") -> str:
    try:
        from ..code.agents import slots
        return slots.label_of(agent, slot) or slot
    except Exception:  # noqa: BLE001
        return slot


def stored_windows(slot: str, agent: str = "claude") -> dict:
    from ..code.agents import limits
    wins = limits.aged(limits.usage(agent, slot))
    if agent == "codex":
        # A slot can keep an old Free-plan 30-day reading after upgrading to
        # Plus/Pro. That old future timestamp must not suppress fresh 5-hour
        # reads or put a reset card on the wrong day.
        plan = plan_of(slot, agent)
        if (plan and plan != "free") or (not plan and "5h" in wins):
            wins.pop("30d", None)
        return {kind: wins[key] for key, kind in CODEX_WINDOWS.items() if key in wins}
    return wins


def read_windows(slot: str, agent: str = "claude") -> None:
    """One usage read (throttled inside usage_fetch; never refreshes a token)."""
    from ..code.agents import usage_fetch
    try:
        usage_fetch.refresh(agent, slot)
    except Exception:  # noqa: BLE001 -- the stored reading still stands
        pass


# ── what should be on the calendar (pure) ────────────────────────────────────

def wanted(cfg: dict, wins: dict, now: float) -> list[dict]:
    """[{kind, at}] -- `at` in epoch seconds, on the minute, future only.

    On the minute because the endpoint's reset times wobble by fractions of a
    second between reads, and each wobble would otherwise be a new event."""
    if not cfg.get("enabled"):
        return []
    out = []
    for kind in ("five_hour", "thirty_day", "seven_day"):
        if kind == "thirty_day" and out:
            continue  # the 30-day window is the primary reset for Free
        if kind == "seven_day" and not cfg.get("weekly"):
            continue
        w = (wins or {}).get(kind)
        r = w.get("resets_at") if isinstance(w, dict) else None
        try:
            at = int(round(float(r) / 60.0) * 60) if r is not None else None
        except (TypeError, ValueError, OverflowError):
            at = None
        if at and at > now:
            out.append({"kind": kind, "at": at})
    return out


def needs_read(cfg: dict, wins: dict, now: float, last_read: float) -> bool:
    """A usage read is worth making only while a wanted reset is unknown: a
    reset time does not move once its window is open."""
    if not cfg.get("enabled") or now - (last_read or 0) < READ_EVERY_S:
        return False
    have = {i["kind"] for i in wanted(cfg, wins, now)}
    if "thirty_day" in have:
        return False
    return "five_hour" not in have or (cfg.get("weekly") and "seven_day" not in have)


def signature(cfg: dict, items: list[dict]) -> str:
    return json.dumps({"cfg": clean(cfg), "items": items}, sort_keys=True)


# ── the post ─────────────────────────────────────────────────────────────────

def post(profile: str, token: str, cfg: dict, items: list[dict], agent: str = "claude") -> dict:
    """Blocking. -> {ok, detail}."""
    body = json.dumps({"profile": profile, "token": token,
                       "enabled": bool(cfg.get("enabled")),
                       "notify": bool(cfg.get("notify")),
                       "resets": [{"kind": i["kind"], "at": i["at"] * 1000} for i in items]})
    req = urllib.request.Request(f"{ENDPOINT}/{agent}-resets", data=body.encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json",
                                          "User-Agent": "magi-engine"})
    try:
        with urllib.request.urlopen(req, timeout=POST_TIMEOUT_S) as r:
            d = json.loads(r.read().decode("utf-8") or "{}")
            return {"ok": bool(d.get("ok")), "detail": d.get("error") or ""}
    except urllib.error.HTTPError as e:
        try:
            d = json.loads(e.read().decode("utf-8") or "{}")
        except Exception:  # noqa: BLE001
            d = {}
        if e.code == 401:
            return {"ok": False, "detail": "TaskHub did not recognise this engine's token. "
                                           "Open MAGI once so the console publishes it."}
        return {"ok": False, "detail": d.get("error") or f"TaskHub answered {e.code}."}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "detail": f"Could not reach TaskHub: {e}"}


# ── one pass, and the loop ───────────────────────────────────────────────────

def available() -> bool:
    return active_profile() in PROFILES


def retry_after(fails: int) -> float:
    return min(1800.0, TICK_S * 2 ** max(0, fails - 1))


async def tick(force: bool = False, agent: str = "claude") -> dict | None:
    if available():
        async with _locks[agent]:
            await _tick(force, agent)
    return panel(agent)


async def _tick(force: bool, agent: str) -> None:
    cfg, st = config(agent), state(agent)
    now = time.time()
    slot = account_slot(agent)
    wins = stored_windows(slot, agent) if slot else {}
    if slot and cfg["enabled"] and (force or needs_read(cfg, wins, now, float(st.get("read_at") or 0))):
        await asyncio.to_thread(read_windows, slot, agent)
        st["read_at"] = now
        wins = stored_windows(slot, agent)
    items = wanted(cfg, wins, now)
    sig = signature(cfg, items)
    if sig == st.get("sig") and not force:
        _put_state(st, agent)
        return
    # A failing post backs off (5, 10, 20 min, then every 30) so a lasting
    # fault -- a token the console never published -- costs the worker a few
    # Firestore reads an hour, not one every tick all day.
    fails = int(st.get("fails") or 0)
    if fails and not force and now - float(st.get("at") or 0) < retry_after(fails):
        _put_state(st, agent)
        return
    token = api_token()
    if not token:
        r = {"ok": False, "detail": "This engine has no API token."}
    else:
        r = await asyncio.to_thread(post, active_profile(), token, cfg, items, agent)
    st.update(at=now, ok=r["ok"], detail=r["detail"], fails=0 if r["ok"] else fails + 1)
    if r["ok"]:
        st.update(sig=sig, items=items, pushed_at=now)
    _put_state(st, agent)


def next_sleep(now: float | None = None, agent: str = "claude") -> float:
    """Wake just after the next pushed reset, so its event goes promptly."""
    now = now or time.time()
    soon = [i["at"] for i in state(agent).get("items") or [] if i.get("at", 0) > now]
    if soon:
        return max(30.0, min(TICK_S, min(soon) - now + 20))
    return TICK_S


async def auto_loop(agent: str = "claude") -> None:
    await asyncio.sleep(FIRST_TICK_S)
    while True:
        try:
            await tick(agent=agent)
        except Exception:  # noqa: BLE001 -- this must never take the engine down
            pass
        await asyncio.sleep(next_sleep(agent=agent))


def panel(agent: str = "claude") -> dict | None:
    """Reset settings and status for the Units sheet."""
    if not available():
        return None
    st = state(agent)
    slot = account_slot(agent)
    plan = plan_of(slot, agent) if slot else ""
    unit = "chatgpt" if agent == "codex" else ("claude-pro" if plan == "pro" else "claude")
    return {**config(agent), "profile": active_profile(), "agent": agent,
            "account": ({"slot": slot, "label": label_of(slot, agent), "plan": plan} if slot else None),
            "unit": unit,
            "items": st.get("items") or [], "pushed_at": st.get("pushed_at"),
            "ok": st.get("ok"), "detail": st.get("detail") or "",
            "busy": _locks[agent].locked()}
