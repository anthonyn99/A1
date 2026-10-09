"""The daily Claude (Pro) kickstart: open the five-hour window on purpose.

Claude's five-hour allowance starts counting at the first message, not on the
clock. Tony used to send "hi" by hand in the morning so the resets fell where
he wanted them -- 7:00 opens 7-12, 12-17, 17-22, 22-03 -- instead of wherever
the day's first real question happened to land. This does it once a day, on
each person's engine (Tony's and Veda's) for that person's own Claude Pro
account in Code Mode, whether or not Claude (Pro) is ticked.

One account, one send a day, per PC: the "system" Code Mode slot is the
CLI's own ~/.claude, which every profile on a PC shares. So Veda's engine
running on Tony's PC sees Tony's login as its Pro account. A machine-wide
claim per credentials file (`_claim`) stops the second engine from sending
on an account the first one already kickstarted today.

How it sends, and why that way (measured 2026-09-29, Claude Code 2.1.284):

    claude -p --tools "" --model haiku --system-prompt "<one line>"
           --restricted --strict-mcp-config --no-session-persistence ...
    MAX_THINKING_TOKENS=0, stdin "k", cwd an empty folder

    -> ~670 input tokens, 4 output tokens, one request, reply "k".

  * Claude Code, not claude.ai: no browser, no window, nothing in the chat
    list, and claude.ai's own system prompt is thousands of tokens. Both
    spend the one allowance, so either starts the same window.
  * `--system-prompt` replaces Claude Code's ~15k-token default; `--tools ""`
    sends no tool schemas; Haiku is the cheapest model the plan carries.
  * MAX_THINKING_TOKENS=0: without it Haiku thought for 182 tokens about ".".
  * The system prompt pins the reply to one letter. A bare "." got an
    83-token "I'm ready to help!".
  * The empty cwd keeps any CLAUDE.md out of the prompt; --restricted keeps
    the user's settings (and the A1 Stop hook that commits and pushes) out.

When it sends is `decide()`, pure and tested. It never spends the day's
allowance past `week_cap`, never sends into a window that is already open
(it waits for that one to end), and a window you opened yourself after
"Not before" counts as done.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
from datetime import datetime
from pathlib import Path

from ..settings import ROOT, active_profile, data_dir

PROFILES = ("tony", "veda")
FILE = "kickstart.json"
CLAIMS = "_kickstart_claims"
WINDOW_S = 5 * 3600
MAX_TRIES = 3
SEND_TIMEOUT_S = 90
FIRST_TICK_S = 60
TICK_S = 300

MODEL = "haiku"
SYSTEM = "Answer with the single letter k and nothing else."
DEFAULTS = {"enabled": True, "message": "k", "not_before": "06:00", "week_cap": 80}

_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
_lock = asyncio.Lock()


# ── config and state (one file, per profile) ────────────────────────────────

def _path() -> Path:
    return data_dir() / FILE


def _load() -> dict:
    try:
        d = json.loads(_path().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(d: dict) -> None:
    p = _path()
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=1), encoding="utf-8")
    tmp.replace(p)


def config() -> dict:
    return clean({**DEFAULTS, **(_load().get("config") or {})})


def state() -> dict:
    s = _load().get("state")
    return s if isinstance(s, dict) else {}


def clean(cfg: dict) -> dict:
    """A config that is safe to act on. Raises ValueError on a bad field."""
    out = dict(DEFAULTS)
    if "enabled" in cfg:
        out["enabled"] = bool(cfg["enabled"])
    if "message" in cfg:
        m = str(cfg["message"] or "").strip()
        if not 1 <= len(m) <= 200:
            raise ValueError("The message must be 1-200 characters.")
        out["message"] = m
    if "not_before" in cfg:
        t = str(cfg["not_before"] or "").strip()
        if not _HHMM.match(t):
            raise ValueError("Not before must be a time like 06:00.")
        out["not_before"] = t
    if "week_cap" in cfg:
        try:
            c = int(cfg["week_cap"])
        except (TypeError, ValueError):
            raise ValueError("The weekly cap must be a whole number.") from None
        if not 10 <= c <= 100:
            raise ValueError("The weekly cap must be between 10 and 100.")
        out["week_cap"] = c
    return out


def save_config(changes: dict) -> dict:
    d = _load()
    cfg = clean({**config(), **(changes or {})})
    d["config"] = cfg
    _save(d)
    return cfg


def _put_state(s: dict) -> None:
    d = _load()
    d["state"] = s
    _save(d)


# ── the account ──────────────────────────────────────────────────────────────

def pro_slot() -> str | None:
    """The Code Mode Claude slot on the Pro plan, by plan (never position),
    as units.pro_account picks it."""
    try:
        from ..code.agents import models, slots
    except Exception:  # noqa: BLE001 -- Code Mode is optional
        return None
    for slot in slots.list_slots("claude"):
        if models.plan_of("claude", slot) == "pro":
            return slot
    return None


def available() -> bool:
    return active_profile() in PROFILES and pro_slot() is not None


# ── one send per account per day, across every engine on this PC ───────────

def _claims_dir() -> Path:
    d = ROOT / "data" / CLAIMS
    d.mkdir(parents=True, exist_ok=True)
    return d


def _account_key(slot: str) -> str:
    """Which login this slot is, as a short hash of its credentials file's
    path. Two profiles whose slots point at one file are one account."""
    try:
        from ..code.agents import usage_fetch
        p = str(usage_fetch._claude_creds(slot).resolve()).lower()
    except Exception:  # noqa: BLE001
        p = f"{active_profile()}:{slot}"
    return hashlib.sha1(p.encode("utf-8")).hexdigest()[:16]


def _claim(slot: str, day: str) -> str | None:
    """Claim today's send on this account. None when it is ours (new, or
    already ours); otherwise the profile that holds it. Atomic (O_EXCL), so
    two engines ticking in the same second cannot both win."""
    try:
        d = _claims_dir()
    except OSError:
        return None                           # no claims dir: behave as before
    for old in d.glob("*.json"):              # earlier days' claims are spent
        if not old.name.endswith(f"-{day}.json"):
            try:
                old.unlink()
            except OSError:
                pass
    f = d / f"{_account_key(slot)}-{day}.json"
    me = active_profile()
    try:
        fd = os.open(f, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        try:
            who = str(json.loads(f.read_text(encoding="utf-8")).get("profile") or "")
        except (OSError, ValueError):
            who = ""
        return None if who == me else (who or "another")
    except OSError:
        return None
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"profile": me, "at": time.time()}, fh)
    return None


def _release(slot: str, day: str) -> None:
    """Give the claim back after a failed send, so a retry (ours or the other
    engine's) can still open today's window."""
    try:
        f = _claims_dir() / f"{_account_key(slot)}-{day}.json"
        if json.loads(f.read_text(encoding="utf-8")).get("profile") == active_profile():
            f.unlink()
    except (OSError, ValueError):
        pass


def windows(slot: str, fresh: bool = True) -> dict | None:
    """{window: {utilization 0..1, resets_at epoch|None}}, or None when there
    is no reading at all. Fresh from the usage endpoint when the token allows
    it; otherwise the last stored figures, aged (a passed window is 0%). The
    week only grows inside its window and a kickstart costs ~nothing, so the
    stored figure is good enough to hold the cap. Blocking."""
    from ..code.agents import limits, usage_fetch
    if fresh:
        try:
            usage_fetch.refresh("claude", slot, force=True)
        except Exception:  # noqa: BLE001 -- the stored reading still stands
            pass
    got = limits.aged(limits.usage("claude", slot))
    return {k: v for k, v in got.items() if isinstance(v, dict)} or None


# ── the decision (pure) ──────────────────────────────────────────────────────

def _at(day: datetime, hhmm: str) -> datetime:
    h, m = (int(x) for x in hhmm.split(":"))
    return day.replace(hour=h, minute=m, second=0, microsecond=0)


def decide(now: datetime, cfg: dict, st: dict, wins: dict | None,
           blocked_until: float | None = None, force: bool = False) -> dict:
    """What to do right now. `now` is local and aware. Returns
    {"act": send|wait|skip|done|off, "status", "detail", "until"(epoch|None)}.

    `force` is "Send now": it goes past the day's done, Not before and an
    open window, but never past the weekly cap or a limit.
    """
    def out(act, status, detail="", until=None):
        return {"act": act, "status": status, "detail": detail, "until": until}

    if not cfg.get("enabled") and not force:
        return out("off", "off")
    today = now.date().isoformat()
    mine = st if st.get("day") == today else {}
    if mine.get("status") in ("sent", "already") and not force:
        return out("done", mine["status"], mine.get("detail", ""))
    nb = _at(now, cfg.get("not_before") or DEFAULTS["not_before"])
    if now < nb and not force:
        return out("wait", "early", "", nb.timestamp())
    if wins is None:
        return out("skip", "no_reading", "No usage reading for the Pro account yet.")
    week = max((float(w.get("utilization") or 0) for k, w in wins.items()
                if k.startswith("seven_day")), default=0.0)
    cap = int(cfg.get("week_cap") or DEFAULTS["week_cap"])
    if round(week * 100) >= cap:
        return out("skip", "capped", f"Week at {round(week * 100)}% (cap {cap}%)")
    if blocked_until and blocked_until > now.timestamp():
        return out("skip", "limited", "Claude is limited", blocked_until)
    five = wins.get("five_hour") or {}
    r = five.get("resets_at")
    if r and float(r) > now.timestamp() and not force:
        started = float(r) - WINDOW_S
        if started >= nb.timestamp():
            return out("done", "already", "You opened today's window yourself", float(r))
        return out("wait", "open", "", float(r))
    if int(mine.get("tries") or 0) >= MAX_TRIES and not force:
        return out("skip", "gave_up", mine.get("detail") or f"{MAX_TRIES} tries failed today")
    return out("send", "sending")


# ── the send ─────────────────────────────────────────────────────────────────

def build_argv(exe: str) -> list[str]:
    return [exe, "-p", "--output-format", "stream-json", "--verbose",
            "--restricted", "--strict-mcp-config", "--tools", "",
            "--model", MODEL, "--system-prompt", SYSTEM,
            "--no-session-persistence", "--disable-slash-commands",
            "--max-turns", "1"]


async def send(slot: str, message: str) -> dict:
    """One minimal message on the Pro account. -> {ok, detail, window_resets_at}."""
    from ..code.agents import claude_cli, limits, slots
    from ..code.agents._proc import Stream

    exe = slots.cli_path("claude")
    if not exe:
        return {"ok": False, "detail": "Claude Code CLI is not installed."}
    cwd = data_dir() / "kickstart"
    cwd.mkdir(parents=True, exist_ok=True)
    env = slots.env_for("claude", slot)
    env["MAX_THINKING_TOKENS"] = "0"
    try:
        s = Stream(build_argv(exe), cwd=cwd, env=env, stdin_text=message)
    except OSError as e:
        return {"ok": False, "detail": f"Could not start Claude Code: {e}"}
    cancel = asyncio.Event()
    timer = asyncio.get_running_loop().call_later(SEND_TIMEOUT_S, cancel.set)
    result, resets, limited = None, None, None
    try:
        async for raw in s.lines(cancel):
            ev = claude_cli.parse_line(raw)
            if not ev:
                continue
            if ev["k"] == "ratelimit":
                for win, w in (ev["windows"] or {}).items():
                    limits.note_usage("claude", slot, win,
                                      float(w.get("utilization") or 0), w.get("resetsAt"))
                    if win == "five_hour":
                        resets = w.get("resetsAt")
                if ev["status"] and not str(ev["status"]).startswith("allowed"):
                    limited = ev["resets_at"]
            elif ev["k"] == "result":
                result = ev
    finally:
        timer.cancel()
    if cancel.is_set():
        return {"ok": False, "detail": f"No answer within {SEND_TIMEOUT_S}s."}
    await s.wait()
    if limited is not None:
        limits.mark("claude", slot, limited, "kickstart")
        return {"ok": False, "limited": True, "detail": "Claude's usage limit was reached."}
    if result and result["ok"]:
        return {"ok": True, "detail": "", "window_resets_at": resets}
    said = ((result or {}).get("text") or "") + "\n" + "\n".join(s.stderr_tail)
    return {"ok": False, "detail": (said.strip()[-300:] or "Claude Code gave no result.")}


# ── one pass, and the loop ───────────────────────────────────────────────────

def _local_now() -> datetime:
    return datetime.now().astimezone()


async def tick(force: bool = False) -> dict | None:
    """Decide, and send if that is the decision. Returns the panel."""
    if available():
        async with _lock:
            sent = await _tick(force)
        if sent:
            await push_resets()
    return panel()


async def push_resets() -> None:
    """The send just opened a window and stored its reset time, so put it on
    TaskHub now. Left to its own 5-minute loop, the reset reached TaskHub
    minutes after MAGI said "Sent", and looked like it never would."""
    try:
        from . import claude_resets
        await claude_resets.tick()
    except Exception:  # noqa: BLE001 -- its own loop retries anyway
        pass


async def _tick(force: bool) -> bool:
    """One pass. -> True when a message was sent."""
    from ..code.agents import limits, updates
    slot = pro_slot()
    now = _local_now()
    today = now.date().isoformat()
    cfg, st = config(), state()
    mine = st if st.get("day") == today else {"day": today, "tries": 0}
    # A cheap pre-check first: nothing to do today means no usage read.
    d = decide(now, cfg, st, {}, force=force)
    if d["act"] in ("off", "done"):
        # Done today, or switched off: hold the account's claim anyway, so the
        # other profile's engine on this PC (same login) neither sends twice
        # nor kickstarts an account whose owner turned it off.
        _claim(slot, today)
    if d["act"] in ("off", "done"):
        return
    if d["status"] != "early":
        wins = await asyncio.to_thread(windows, slot)
        d = decide(now, cfg, st, wins, limits.blocked_until("claude", slot), force=force)
    if d["act"] == "send" and updates.updating("claude"):
        d = {"act": "wait", "status": "updating", "detail": "Claude Code is updating", "until": None}
    mine = {**mine, "at": time.time()}
    if d["act"] == "send":
        # Send now records the claim but is never blocked by one.
        holder = _claim(slot, today)
        if holder and not force:
            d = {"act": "done", "status": "already",
                 "detail": f"{holder.title()}'s engine on this PC handles this Claude login",
                 "until": None}
    if d["act"] == "send":
        r = await send(slot, cfg["message"])
        if not r["ok"]:
            _release(slot, today)
        if r["ok"]:
            mine.update(status="sent", detail="", until=None, sent_at=time.time(),
                        window_resets_at=r.get("window_resets_at"))
        else:
            mine.update(status="limited" if r.get("limited") else "failed",
                        detail=r["detail"], until=None,
                        tries=int(mine.get("tries") or 0) + 1)
    else:
        mine.update(status=d["status"], detail=d["detail"], until=d["until"])
        if d["status"] == "already":
            mine["window_resets_at"] = d["until"]
    _put_state(mine)
    return mine.get("status") == "sent" and d["act"] == "send"


def next_sleep(now: float | None = None) -> float:
    """Wake just after the thing being waited for (Not before, or the open
    window's reset), and never later than a normal tick."""
    now = now or time.time()
    until = state().get("until")
    try:
        u = float(until) if until else None
    except (TypeError, ValueError):
        u = None
    if u and u > now:
        return max(30.0, min(TICK_S, u - now + 15))
    return TICK_S


async def auto_loop() -> None:
    """Started with the engine; the first tick is "when the engine comes
    online". Does nothing without a Claude Pro account in this profile's
    Code Mode."""
    await asyncio.sleep(FIRST_TICK_S)
    while True:
        try:
            await tick()
        except Exception:  # noqa: BLE001 -- a kickstart must never take the engine down
            pass
        await asyncio.sleep(next_sleep())


def panel() -> dict | None:
    """What the Units sheet shows, or None where the feature does not exist
    (no Claude Pro account signed in to this profile's Code Mode)."""
    if not available():
        return None
    st = state()
    today = _local_now().date().isoformat()
    return {**config(), "state": st if st.get("day") == today else {},
            "last": st, "busy": _lock.locked(), "model": MODEL}
