"""TradeHub's two standing prompts, run by the engine on a schedule (2026-11-09).

Tony asked the council the same two things by hand every week:

  * "What factor(s) moved the market the most today?"  -- after the close,
    every trading day;
  * the "Weekly Trading Catalyst Tier List (Next Week)" -- on Saturdays.

This module runs them itself and hands the answers to TradeHub, where
Analysis > Debrief shows them (tabs "Movers" and "Next week") the way it shows
the morning's MAGI answer. Nothing has to be open: the engine runs the council
(the same Orchestrator a console run uses) and posts the finished run to the
taskhub-reminders worker, which writes dashboards/tb_debrief_auto.

When:
  movers  -- trading days (NYSE calendar, half days included), at the close
             plus MOVERS_DELAY_MIN: 5:00 PM ET, 2:00 PM ET on a 1 PM close.
             An hour lets the wrap-ups (AP, Reuters, CNBC's close stories)
             publish and get indexed, so the units' searches find today's
             story instead of the midday one. If the PC was off, it runs when
             the engine is next up, until 4 AM ET the next morning.
  weekly  -- Saturday WEEKLY_AT_ET (10:00 AM ET): Friday's close is in and the
             coming week's earnings dates are set. Missed, it runs any time
             until Monday 4 AM ET.
Each runs once per its day (per week for weekly); state is in
data_dir()/autoprompts.json. A council the person started first goes first:
a due job waits while any run is live.

What and with whom:
  The prompt text and the units come from TradeHub's Analysis settings, which
  TradeHub pushes to trade-dashboard /analysis-config (`auto`: the two prompts
  found by name; `magiUnits` / `aiUrl`: the destination). MAGI's units are
  used as ticked; a single chat-site destination (ChatGPT, Claude...) is the
  matching unit here, so the answer can still be read back -- a chat site's
  own tab cannot be. With no config reachable, the prompts below and every
  enabled unit are used, so the schedule never silently stops.

Only Tony's engine runs these (TradeHub is his); Veda's never does.
"""

from __future__ import annotations

import asyncio
import json
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from ..settings import active_profile, api_token, data_dir

ET = ZoneInfo("America/New_York")
FILE = "autoprompts.json"
CONFIG_URL = "https://trade-dashboard.av1-2.workers.dev/analysis-config"
PUSH_URL = "https://taskhub-reminders.av1.workers.dev/magi-auto"
UA = "MAGI-engine/1.0 (autoprompts)"
PROFILE = "tony"

MOVERS_DELAY_MIN = 60
MOVERS_LAST_HOUR = 4            # catch-up ends 4 AM ET the next day
WEEKLY_AT_ET = (10, 0)          # Saturday 10:00 ET
FIRST_TICK_S = 90
TICK_S = 60
RUN_TIMEOUT_S = 45 * 60         # a council that has not finished by then is abandoned
HTTP_TIMEOUT_S = 20
JOBS = ("movers", "weekly")

# Used when TradeHub's copy cannot be read. Tony's own wording.
DEFAULT_PROMPTS = {
    "movers": {
        "name": "Today's market movers",
        "text": "What factor(s) moved the market the most today? Research and give me the latest.",
    },
    "weekly": {
        "name": "Next week's catalysts",
        "text": (
            "# Weekly Trading Catalyst Tier List (Next Week)\n\n"
            "Determine the **5 most important macro and market catalysts for the upcoming trading week "
            "(Monday–Friday)**.\n\nYour goal is to tell me **what will most likely drive the market**, "
            "ranked by importance for a **1–5 trading day horizon**.\n\n## Output Rules\n\n"
            "* Keep it concise.\n* Rank catalysts from **Priority #1 (Most Important)** to **Priority #5**."
        ),
    },
}

# A single chat-site destination, as the MAGI unit that drives that site.
SITE_UNITS = (
    ("chatgpt.com", "chatgpt"), ("chat.openai.com", "chatgpt"),
    ("claude.ai", "claude"), ("gemini.google.com", "gemini"),
    ("perplexity.ai", "perplexity"), ("grok.com", "grok"), ("x.com/i/grok", "grok"),
    ("chat.deepseek.com", "deepseek"), ("deepseek.com", "deepseek"),
)


# ── the NYSE calendar (mirrors newshub-api's mktComputeYear) ────────────────

def _nth_dow(y: int, m: int, wd: int, n: int) -> date:
    d = date(y, m, 1)
    d += timedelta(days=(wd - d.weekday()) % 7)
    return d + timedelta(weeks=n - 1)


def _last_dow(y: int, m: int, wd: int) -> date:
    d = date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)
    return d - timedelta(days=(d.weekday() - wd) % 7)


def _easter(y: int) -> date:
    a, b, c = y % 19, y // 100, y % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = (h + l - 7 * m + 114) % 31 + 1
    return date(y, month, day)


def _observed(d: date) -> date:
    return d - timedelta(days=1) if d.weekday() == 5 else d + timedelta(days=1) if d.weekday() == 6 else d


def nyse_year(y: int) -> tuple[set[date], set[date]]:
    """(holidays, half days) for one year."""
    hol: set[date] = set()
    ny = date(y, 1, 1)
    if ny.weekday() != 5:                 # a Saturday New Year is not observed
        hol.add(_observed(ny))
    hol.add(_nth_dow(y, 1, 0, 3))         # MLK
    hol.add(_nth_dow(y, 2, 0, 3))         # Presidents'
    hol.add(_easter(y) - timedelta(days=2))   # Good Friday
    hol.add(_last_dow(y, 5, 0))           # Memorial
    if y >= 2022:
        hol.add(_observed(date(y, 6, 19)))    # Juneteenth
    hol.add(_observed(date(y, 7, 4)))     # Independence
    hol.add(_nth_dow(y, 9, 0, 1))         # Labor
    tg = _nth_dow(y, 11, 3, 4)
    hol.add(tg)                           # Thanksgiving
    xm = _observed(date(y, 12, 25))
    hol.add(xm)                           # Christmas
    half = {tg + timedelta(days=1)}
    j4 = date(y, 7, 4)
    if 1 <= j4.weekday() <= 4:            # Tue-Fri: July 3 closes early
        half.add(date(y, 7, 3))
    c24 = date(y, 12, 24)
    if c24.weekday() <= 4 and xm != c24:
        half.add(c24)
    return hol, half


def is_trading_day(d: date) -> bool:
    return d.weekday() < 5 and d not in nyse_year(d.year)[0]


def close_et(d: date) -> datetime:
    """The regular close on trading day d, in New York time."""
    early = d in nyse_year(d.year)[1]
    return datetime(d.year, d.month, d.day, 13 if early else 16, 0, tzinfo=ET)


# ── what is due (pure: the clock and the record decide) ─────────────────────

def due(now: datetime, state: dict) -> list[tuple[str, str]]:
    """[(job, key)] due at `now` and not yet done; key = the day (or week) it is for."""
    n = now.astimezone(ET)
    out: list[tuple[str, str]] = []
    done = (state or {}).get("done") or {}

    # movers: today's close + delay, else yesterday's (still in its catch-up window).
    for d in (n.date(), n.date() - timedelta(days=1), n.date() - timedelta(days=2), n.date() - timedelta(days=3)):
        if not is_trading_day(d):
            continue
        start = close_et(d) + timedelta(minutes=MOVERS_DELAY_MIN)
        nxt = d + timedelta(days=1)
        end = datetime(nxt.year, nxt.month, nxt.day, MOVERS_LAST_HOUR, 0, tzinfo=ET)
        if start <= n < end and done.get("movers") != d.isoformat():
            out.append(("movers", d.isoformat()))
        break                              # only the most recent trading day counts

    # weekly: from Saturday 10:00 ET until Monday 4 AM ET, keyed by that Saturday.
    sat = n.date() - timedelta(days=(n.weekday() - 5) % 7)
    start = datetime(sat.year, sat.month, sat.day, *WEEKLY_AT_ET, tzinfo=ET)
    mon = sat + timedelta(days=2)
    end = datetime(mon.year, mon.month, mon.day, MOVERS_LAST_HOUR, 0, tzinfo=ET)
    if start <= n < end and done.get("weekly") != sat.isoformat():
        out.append(("weekly", sat.isoformat()))
    return out


def next_run(now: datetime, job: str) -> datetime:
    """When `job` next becomes due (for the status line TradeHub shows)."""
    n = now.astimezone(ET)
    if job == "movers":
        d = n.date()
        for _ in range(10):
            if is_trading_day(d):
                t = close_et(d) + timedelta(minutes=MOVERS_DELAY_MIN)
                if t > n:
                    return t
            d += timedelta(days=1)
        return n
    sat = n.date() + timedelta(days=(5 - n.weekday()) % 7)
    t = datetime(sat.year, sat.month, sat.day, *WEEKLY_AT_ET, tzinfo=ET)
    return t if t > n else t + timedelta(days=7)


# ── the prompt and the units ────────────────────────────────────────────────

def pick_units(cfg: dict | None, available: list[str]) -> list[str]:
    """The units to ask: MAGI's ticked units, else the unit behind a single
    chat-site destination, else every unit available."""
    have = [u for u in available if u]
    cfg = cfg or {}
    want = [u for u in (cfg.get("magiUnits") or []) if u in have]
    if want:
        return want
    url = str(cfg.get("aiUrl") or "").lower()
    for host, unit in SITE_UNITS:
        if host in url and unit in have:
            return [unit]
    return have


def pick_prompt(cfg: dict | None, job: str) -> dict:
    auto = ((cfg or {}).get("auto") or {}).get(job) or {}
    text = str(auto.get("text") or "").strip()
    if text:
        return {"name": str(auto.get("name") or DEFAULT_PROMPTS[job]["name"])[:80], "text": text[:16000], "src": "tradehub"}
    return {**DEFAULT_PROMPTS[job], "src": "default"}


def result_body(job: str, key: str, prompt: dict, run: dict) -> dict:
    """What TradeHub stores and renders: the run as MAGI's own record has it
    ({run, answers, synthesis}, as Debrief's TBMagiAnswer reads), plus which
    day it is for. Answers are trimmed so one doc can never pass Firestore's
    1 MB."""
    answers = []
    for a in (run.get("answers") or []):
        a = dict(a)
        a["answer_text"] = str(a.get("answer_text") or "")[:60000]
        answers.append(a)
    syn = run.get("synthesis")
    if isinstance(syn, dict):
        syn = {**syn, "verdict_text": str(syn.get("verdict_text") or "")[:60000]}
    return {
        "job": job, "for": key, "name": prompt["name"], "src": prompt["src"],
        "at": int(time.time() * 1000),
        "run": run.get("run") or {}, "answers": answers, "synthesis": syn,
    }


# ── state ───────────────────────────────────────────────────────────────────

def _path() -> Path:
    return data_dir() / FILE


def load_state() -> dict:
    try:
        d = json.loads(_path().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(d: dict) -> None:
    p = _path()
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=1), encoding="utf-8")
    tmp.replace(p)


# ── the network: config in, result out ──────────────────────────────────────

def fetch_config() -> dict | None:
    try:
        req = urllib.request.Request(CONFIG_URL, headers={"User-Agent": UA, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
            d = json.loads(r.read().decode("utf-8"))
            return d if isinstance(d, dict) and d.get("ok") else None
    except Exception:
        return None


def push(body: dict) -> tuple[bool, str]:
    data = json.dumps({"profile": PROFILE, "token": api_token(), "job": body["job"], "body": body}).encode("utf-8")
    req = urllib.request.Request(PUSH_URL, data=data, method="POST",
                                 headers={"User-Agent": UA, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
            d = json.loads(r.read().decode("utf-8") or "{}")
            return bool(d.get("ok")), str(d.get("error") or "")
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


# ── running one ─────────────────────────────────────────────────────────────

async def run_job(job: str, key: str, *, start_run, get_run, is_done, available, busy) -> dict:
    """Run one job end to end. The engine's own functions are passed in
    (app.py), so this module never imports the app and tests can fake them.
    Returns a record for the state file / status."""
    cfg = await asyncio.to_thread(fetch_config)
    prompt = pick_prompt(cfg, job)
    units = pick_units(cfg, available())
    if not units:
        return {"ok": False, "error": "no units are enabled", "at": int(time.time() * 1000)}
    # A council already going (the person's, or a queued one) goes first.
    waited = 0
    while busy() and waited < RUN_TIMEOUT_S:
        await asyncio.sleep(15)
        waited += 15
    run_id = await start_run(prompt["text"], units)
    t0 = time.time()
    while not is_done(run_id):
        if time.time() - t0 > RUN_TIMEOUT_S:
            return {"ok": False, "error": "the council did not finish in time", "run_id": run_id, "at": int(time.time() * 1000)}
        await asyncio.sleep(5)
    run = await get_run(run_id)
    if not run:
        return {"ok": False, "error": "the run was not recorded", "run_id": run_id, "at": int(time.time() * 1000)}
    responded = sum(1 for a in (run.get("answers") or []) if a.get("ok"))
    if not responded:
        return {"ok": False, "error": "no unit answered", "run_id": run_id, "at": int(time.time() * 1000)}
    body = result_body(job, key, prompt, run)
    ok, err = await asyncio.to_thread(push, body)
    return {"ok": ok, "error": err, "run_id": run_id, "units": units, "src": prompt["src"],
            "responded": responded, "at": int(time.time() * 1000)}


_lock = asyncio.Lock()


async def tick(*, now=None, force: str = "", **engine) -> list[dict]:
    """One pass: run whatever is due (or `force`, a job name). Never raises."""
    if active_profile() != PROFILE:
        return []
    if _lock.locked():
        return []
    async with _lock:
        state = load_state()
        now = now or datetime.now(ET)
        jobs = due(now, state)
        if force in JOBS and not any(j == force for j, _ in jobs):
            n = now.astimezone(ET)
            key = n.date().isoformat() if force == "movers" else (n.date() - timedelta(days=(n.weekday() - 5) % 7)).isoformat()
            jobs.append((force, key))
        out = []
        for job, key in jobs:
            try:
                rec = await run_job(job, key, **engine)
            except Exception as e:  # noqa: BLE001
                rec = {"ok": False, "error": f"{type(e).__name__}: {e}", "at": int(time.time() * 1000)}
            rec = {"job": job, "for": key, **rec}
            state.setdefault("last", {})[job] = rec
            # Done for that day only when the answer reached TradeHub. A failed
            # push or an empty council retries on the next tick... at most
            # MAX_TRIES times per day, so a broken unit cannot loop all evening.
            tries = state.setdefault("tries", {})
            tk = f"{job}:{key}"
            tries[tk] = tries.get(tk, 0) + 1
            if rec.get("ok") or tries[tk] >= MAX_TRIES:
                state.setdefault("done", {})[job] = key
            # Keep the tries map small.
            state["tries"] = {k: v for k, v in tries.items() if k.split(":", 1)[1] >= (now.astimezone(ET).date() - timedelta(days=9)).isoformat()}
            save_state(state)
            out.append(rec)
        return out


MAX_TRIES = 3


def status(now=None) -> dict:
    now = now or datetime.now(ET)
    st = load_state()
    return {
        "enabled": active_profile() == PROFILE,
        "jobs": {j: {"next": next_run(now, j).isoformat(), "done": (st.get("done") or {}).get(j),
                     "last": (st.get("last") or {}).get(j)} for j in JOBS},
    }


async def auto_loop(**engine) -> None:
    await asyncio.sleep(FIRST_TICK_S)
    while True:
        try:
            await tick(**engine)
        except Exception:
            pass
        await asyncio.sleep(TICK_S)
