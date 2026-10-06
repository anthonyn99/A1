"""Each unit's limits and model, as far as MAGI has seen them (Phase U3).

Nothing here opens a browser. Every fact comes from something that already
happened on THIS engine, for THIS profile:

* runs and Brainstorm turns (`magi.db`): the model the site showed (U2), the
  last good answer, and the failures `engine/usage.recent` reads back --
  limits with the reset time the site gave;
* the last "Check now" (or doctor pass) per unit, kept beside the database in
  `unit_checks.json`: signed in or not, a notice on the page, the model label;
* for Claude (Pro), Code Mode's own usage numbers for the same account
  (`code/agents/limits`, read from Anthropic's usage endpoint). claude.ai and
  Claude Code share one allowance, so those percentages ARE this unit's.

The database and the checks file both live in the profile's own data folder,
so Tony's and Veda's units never see each other's state.

The rule from Phase U1 holds: show only what a site or an account said. No
count is invented for a unit that shows none; "near a limit" exists only
where there is a number (Claude Pro).
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .. import accounts
from ..browser import picker
from . import usage

CHECKS_FILE = "unit_checks.json"

# The only unit whose allowance MAGI can read as a number.
PRO_UNIT = "claude-pro"
# Sites whose cap is on the page at a plain load, so a later check that finds
# no notice means the cap is gone (engine/limit_watch.py).
SHOWS_CAP_ON_LOAD = frozenset({"claude"})

HEADLINE = {
    "limited": "Limited",
    "near": "Near limit",
    "signed_out": "Signed out",
    "fallback": "Fell back",
    "ok": "OK",
    "unknown": "Not used yet",
}


# ── checks ("Check now" and the doctor) ─────────────────────────────────────

def _checks_path(db_path: str | Path) -> Path:
    return Path(db_path).parent / CHECKS_FILE


def load_checks(db_path: str | Path) -> dict[str, dict]:
    try:
        d = json.loads(_checks_path(db_path).read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_check(db_path: str | Path, provider_id: str, report: Any,
               at: datetime | None = None) -> dict:
    """Keep what a health check saw. Only a check that reached the site is
    kept: "profile in use" or a failed navigation says nothing about the
    unit's account, and must not overwrite a real reading."""
    rec = {
        "at": (at or datetime.now(timezone.utc)).isoformat(),
        "reachable": bool(getattr(report, "reachable", False)),
        "logged_in": bool(getattr(report, "logged_in", False)),
        "challenged": bool(getattr(report, "challenged", False)),
        "usable": bool(getattr(report, "usable", False)),
        "limit": str(getattr(report, "limit", "") or "")[:300],
        "model": str(getattr(report, "model", "") or "")[:80],
        "error": str(getattr(report, "error", "") or "")[:300],
    }
    if not rec["reachable"]:
        return rec
    p = _checks_path(db_path)
    d = load_checks(db_path)
    d[provider_id] = rec
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=1), encoding="utf-8")
    tmp.replace(p)
    return rec


# ── what the runs saw ────────────────────────────────────────────────────────

def _facts_sync(db_path: str, provider_id: str) -> dict:
    """The newest model label and the newest time the unit was used at all,
    across council answers and Brainstorm turns."""
    con = sqlite3.connect(db_path)
    try:
        cands = list(con.execute(
            """SELECT model, model_fallback, ended_at FROM answers
               WHERE provider_id=? AND COALESCE(model,'')!=''
               ORDER BY ended_at DESC LIMIT 1""", (provider_id,)))
        seen = [con.execute(
            "SELECT MAX(ended_at) FROM answers WHERE provider_id=?", (provider_id,)
        ).fetchone()[0]]
        if usage._has_table(con, "brainstorm_turns"):
            cands += list(con.execute(
                """SELECT model, model_fallback, created_at FROM brainstorm_turns
                   WHERE provider_id=? AND COALESCE(model,'')!=''
                   ORDER BY created_at DESC LIMIT 1""", (provider_id,)))
            seen.append(con.execute(
                "SELECT MAX(created_at) FROM brainstorm_turns WHERE provider_id=?",
                (provider_id,)).fetchone()[0])
    finally:
        con.close()
    best = max(cands, key=lambda r: usage._sort_at(r[2]), default=None)
    last = max(filter(None, seen), key=usage._sort_at, default=None)
    return {
        "model": best[0] if best else "",
        "model_fallback": (best[1] or "") if best else "",
        "model_at": usage._parse_at(best[2]).isoformat() if best and usage._parse_at(best[2]) else None,
        "last_seen_at": usage._parse_at(last).isoformat() if usage._parse_at(last) else None,
    }


async def facts(db_path: str | Path, provider_id: str) -> dict:
    try:
        return await asyncio.to_thread(_facts_sync, str(db_path), provider_id)
    except Exception:  # noqa: BLE001 -- a panel must still render
        return {"model": "", "model_fallback": "", "model_at": None, "last_seen_at": None}


# ── Claude (Pro): Code Mode's numbers ────────────────────────────────────────

def _epoch_iso(v: Any) -> str | None:
    try:
        return datetime.fromtimestamp(float(v), timezone.utc).isoformat() if v else None
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def pro_account(refresh: bool = False) -> dict | None:
    """The Pro account Code Mode is signed in to, as usage windows, or None.

    Picked by PLAN, never by position: a free Claude slot's numbers are a
    different allowance and must not be shown as this unit's. Blocking (a
    refresh is one small HTTP GET, throttled to a minute); run it in a thread.
    """
    try:
        from ..code.agents import limits, models, slots, usage_fetch
    except Exception:  # noqa: BLE001 -- Code Mode is optional
        return None
    for slot in slots.list_slots("claude"):
        if models.plan_of("claude", slot) != "pro":
            continue
        if refresh:
            try:
                usage_fetch.refresh("claude", slot)
            except Exception:  # noqa: BLE001 -- the stored reading still stands
                pass
        wins = limits.aged(limits.usage("claude", slot))
        return {
            "agent": "claude",
            "slot": slot,
            "label": slots.label_of("claude", slot) or slot,
            "warn_at": models.prefs().get("warn_at", 80),
            "windows": {
                k: {"utilization": float(w.get("utilization") or 0.0),
                    "resets_at": _epoch_iso(w.get("resets_at")),
                    "read_at": _epoch_iso(w.get("at"))}
                for k, w in wins.items() if isinstance(w, dict)
            },
            "credits": models.credits("claude", slot) or None,
        }
    return None


# ── the verdict (pure) ───────────────────────────────────────────────────────

def _after(a: str | None, b: str | None) -> bool:
    """a is strictly later than b (None is the beginning of time)."""
    return bool(a) and usage._sort_at(a) > usage._sort_at(b)


def summarize(*, provider_id: str, display_name: str, recent: dict, facts: dict,
              check: dict | None, account: dict | None,
              now: datetime | None = None) -> dict:
    """One unit's panel entry. Pure: every input is passed in.

    The order of the states is the order of what matters to someone about to
    tick the unit: a limit (it will fail fast), close to one, signed out,
    last answer came from a fallback model, fine, never used.
    """
    now = now or datetime.now(timezone.utc)
    check = check or {}
    issues = list(recent.get("issues") or [])
    last_ok = recent.get("last_ok_at")
    checked_at = check.get("at")

    limit = None
    # 1. The account's own numbers: a window at 100% is a limit, whatever the
    #    runs have or have not hit yet.
    top = None
    for name, w in ((account or {}).get("windows") or {}).items():
        if top is None or w["utilization"] > top[1]["utilization"]:
            top = (name, w)
        if w["utilization"] >= 1.0 and not limit:
            limit = {"source": "account", "detail": f"{name.replace('_', ' ')} allowance used up",
                     "at": w.get("read_at"), "resets_at": w.get("resets_at")}
    # 2. A notice on the page at the last check, if nothing answered since.
    if not limit and check.get("limit") and not _after(last_ok, checked_at):
        reset = usage.parse_reset(check["limit"], usage._sort_at(checked_at))
        if not reset or reset > now:
            limit = {"source": "check", "detail": check["limit"], "at": checked_at,
                     "resets_at": reset.isoformat() if reset else None}
    # 3. A limit a run hit, not answered past and not past its reset time.
    if not limit:
        for i in issues:
            if (i.get("limit") and not i.get("cleared") and not i.get("reset_passed")
                    and not (provider_id in SHOWS_CAP_ON_LOAD and check.get("reachable")
                             and not check.get("limit") and _after(checked_at, i.get("at")))):
                limit = {"source": "run", "detail": i.get("detail") or "",
                         "at": i.get("at"), "resets_at": i.get("resets_at")}
                break

    too_long = next(({"at": i.get("at"), "detail": i.get("detail") or ""}
                     for i in issues
                     if i.get("kind") == "prompt_too_long" and not i.get("cleared")), None)

    near = None
    if top and not limit:
        warn = float((account or {}).get("warn_at") or 80) / 100.0
        if top[1]["utilization"] >= warn:
            near = {"window": top[0], **top[1]}

    signed_out = (check.get("reachable") and not check.get("logged_in")
                  and not _after(last_ok, checked_at))

    if limit:
        state = "limited"
    elif near:
        state = "near"
    elif signed_out:
        state = "signed_out"
    elif facts.get("model_fallback"):
        state = "fallback"
    elif last_ok or check.get("usable"):
        state = "ok"
    else:
        state = "unknown"

    # The model: the newer of what a run saw and what the last check read.
    model, model_at, fallback = facts.get("model") or "", facts.get("model_at"), facts.get("model_fallback") or ""
    if check.get("model") and _after(checked_at, model_at):
        model, model_at, fallback = check["model"], checked_at, ""

    return {
        "id": provider_id,
        "display_name": display_name,
        "state": state,
        "headline": HEADLINE[state],
        "limit": limit,
        "near": near,
        "too_long": too_long,
        "model": model,
        "model_fallback": fallback,
        "model_at": model_at,
        "last_ok_at": last_ok,
        # In a run or round only; a check is `checked_at`.
        "last_seen_at": facts.get("last_seen_at"),
        "checked_at": checked_at,
        "check": check or None,
        "account": account,
        "issues": issues,
        "window_hours": recent.get("window_hours", usage.WINDOW_HOURS),
    }


# ── the route's worker ───────────────────────────────────────────────────────

async def unit(db_path: str | Path, provider, *, checks: dict | None = None,
               account: dict | None | bool = False) -> dict:
    """One provider's entry. `account=False` means "look it up" (Claude Pro
    only); pass a dict or None to reuse one already read."""
    if checks is None:
        checks = load_checks(db_path)
    rules = provider.site.rate_limit_selectors
    recent, f = await asyncio.gather(
        usage.recent(db_path, provider.id, rules), facts(db_path, provider.id))
    if account is False:
        account = (await asyncio.to_thread(pro_account, True)
                   if provider.id == PRO_UNIT else None)
    out = summarize(provider_id=provider.id, display_name=provider.display_name,
                    recent=recent, facts=f, check=checks.get(provider.id),
                    account=account if provider.id == PRO_UNIT else None)
    out.update(menu(provider))
    if provider.id == PRO_UNIT:
        # The daily kickstart's panel (absent without a Pro account in Code Mode).
        from . import kickstart
        try:
            ks = kickstart.panel()
        except Exception:  # noqa: BLE001 -- the Units sheet must still render
            ks = None
        if ks:
            out["kickstart"] = ks
    if provider.id in ("claude", PRO_UNIT):
        # Reset times -> TaskHub (engine/claude_resets.py), on whichever Claude
        # row the profile's Code Mode account belongs to.
        from . import claude_resets
        try:
            cr = claude_resets.panel()
        except Exception:  # noqa: BLE001 -- the Units sheet must still render
            cr = None
        if cr and cr["unit"] == provider.id:
            out["resets_push"] = cr
    return out


def menu(provider) -> dict:
    """The model picker's side of a unit (Phase U4): whether its site has
    one, what it offers (the account's own list once refreshed, U1's until
    then) and what this person chose ({} = Site default)."""
    site = getattr(provider, "site", None)
    pickable = bool(site is not None and picker.has_picker(site))
    seen = accounts.models_seen(provider.id) if pickable else {}
    # Effort / thinking, the other half of the pick (2026-10-01): its own
    # control on four sites, whether or not they have a model menu.
    kind = picker.effort_kind(site) if site is not None else ""
    return {
        "pickable": pickable,
        "pick": accounts.model_choice(provider.id) if pickable else {},
        "models": (seen.get("options") if seen else picker.known(site)) if pickable else [],
        "models_at": seen.get("at") if seen else None,
        "effort": {
            "kind": kind,
            "label": picker.effort_label(site) if kind else "",
            "options": picker.effort_options(site) if kind else [],
            "pick": accounts.effort_choice(provider.id) if kind else "",
        },
    }


async def all_units(db_path: str | Path, providers: list) -> list[dict]:
    checks = load_checks(db_path)
    acct = None
    if any(p.id == PRO_UNIT for p in providers):
        acct = await asyncio.to_thread(pro_account, True)
    return list(await asyncio.gather(*(
        unit(db_path, p, checks=checks, account=acct) for p in providers)))
