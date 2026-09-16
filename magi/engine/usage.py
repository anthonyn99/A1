"""What went wrong for a unit recently, and when a usage limit lifts.

The doctor probes a site's page, and a usage limit is almost never ON that
page: ChatGPT's upload cap lives in the send button's tooltip once a file is
attached, Grok's appears in place of an answer after a send. A doctor that only
looks at an idle page reports every one of those units healthy. What does know
is the run history -- every failed answer is saved with its reason and a
snapshot of the page -- so the doctor reads it back.

Two things this has to get right:

* Older hits were recorded as timeouts. Before the send button's tooltip was
  read, ChatGPT's upload cap came back as "no new answer within 45s", and
  Grok's limit card as an empty response. Their saved snapshots still carry
  the site's own wording, so a failure whose snapshot matches the site's
  rate_limit_selectors is reported as the limit it was.

* A limit is not permanent. Sites say how long ("6 hours 50 minutes before
  limit is gone", "resets at 5:00 PM"), so the reset time is worked out from
  the moment it was seen, and a later successful answer marks it cleared.
"""

from __future__ import annotations

import asyncio
import json
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..errors import FailureKind

WINDOW_HOURS = 48
MAX_ISSUES = 4

_HM = re.compile(r"(\d+)\s*(?:hours?|hrs?|h)\b(?:\s*(?:and\s*)?(\d+)\s*(?:minutes?|mins?|m)\b)?", re.I)
_M = re.compile(r"(\d+)\s*(?:minutes?|mins?)\b", re.I)
_CLOCK = re.compile(r"\b(?:until|at|after)\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?", re.I)


def parse_reset(detail: str, seen_at: datetime) -> datetime | None:
    """When the site said the limit lifts, as an absolute UTC time, or None."""
    text = detail or ""
    m = _HM.search(text)
    if m:
        return seen_at + timedelta(hours=int(m.group(1)), minutes=int(m.group(2) or 0))
    m = _M.search(text)
    if m:
        return seen_at + timedelta(minutes=int(m.group(1)))
    m = _CLOCK.search(text)
    if m:
        # A wall-clock time is in the local zone of the machine that saw it,
        # which is this one.
        hour = int(m.group(1)) % 12 + (12 if m.group(3).lower() == "p" else 0)
        local = seen_at.astimezone()
        at = local.replace(hour=hour, minute=int(m.group(2) or 0), second=0, microsecond=0)
        if at <= local:
            at += timedelta(days=1)
        return at.astimezone(timezone.utc)
    return None


def _limit_patterns(selectors: list[str]) -> list[re.Pattern]:
    """The `text=/.../flags` rate-limit selectors, as plain regexes."""
    out = []
    for sel in selectors or []:
        m = re.fullmatch(r"text=/(.*)/([a-z]*)", sel.strip())
        if not m:
            continue
        try:
            out.append(re.compile(m.group(1), re.I if "i" in m.group(2) else 0))
        except re.error:
            continue
    return out


def _snapshot_limit(artifacts_json: str | None, patterns: list[re.Pattern]) -> str:
    """The limit wording in a failure's saved page, or ""."""
    if not patterns or not artifacts_json:
        return ""
    try:
        paths = json.loads(artifacts_json) or []
    except ValueError:
        return ""
    for p in paths:
        if not str(p).endswith(".html"):
            continue
        try:
            html = Path(p).read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        # Tags and scripts out, so a pattern cannot match inside a bundle, and
        # every element on its own line, so the quote is the notice itself and
        # not the prompt sitting in the element beside it.
        html = re.sub(r"<(script|style)[^>]*>.*?</\1>", "\n", html, flags=re.S | re.I)
        lines = [
            re.sub(r"\s+", " ", ln).strip()
            for ln in re.sub(r"<[^>]+>", "\n", html).split("\n")
        ]
        for ln in filter(None, lines):
            if len(ln) > 400:
                continue
            for pat in patterns:
                if pat.search(ln):
                    return ln
    return ""


def _parse_at(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _recent_sync(db_path: str, provider_id: str, rate_limit_selectors: list[str]) -> dict:
    now = datetime.now(timezone.utc)
    since = (now - timedelta(hours=WINDOW_HOURS)).isoformat()
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        last_ok = con.execute(
            "SELECT MAX(ended_at) FROM answers WHERE provider_id=? AND ok=1",
            (provider_id,),
        ).fetchone()[0]
        rows = con.execute(
            """SELECT failure_kind, error_detail, degraded_reason, ended_at, artifacts
               FROM answers
               WHERE provider_id=? AND ok=0 AND ended_at>=?
                 AND COALESCE(failure_kind,'') != ?
               ORDER BY ended_at DESC LIMIT 25""",
            (provider_id, since, str(FailureKind.CANCELLED)),
        ).fetchall()
    finally:
        con.close()

    last_ok_at = _parse_at(last_ok)
    patterns = _limit_patterns(rate_limit_selectors)
    issues: list[dict] = []
    seen: set[str] = set()
    for r in rows:
        at = _parse_at(r["ended_at"])
        if at is None:
            continue
        kind = r["failure_kind"] or "unusable"
        detail = r["error_detail"] or r["degraded_reason"] or ""
        # Halting a run closes the browsers under the units, and each records
        # that as its own failure. It is not a problem with the unit.
        if "has been closed" in detail:
            continue
        if kind != str(FailureKind.RATE_LIMITED):
            said = _snapshot_limit(r["artifacts"], patterns)
            if said:
                kind, detail = str(FailureKind.RATE_LIMITED), f"The site said: {said}"
        # The newest of each kind is the one worth reading.
        if kind in seen:
            continue
        seen.add(kind)
        resets = parse_reset(detail, at) if kind == str(FailureKind.RATE_LIMITED) else None
        issues.append({
            "kind": kind,
            "limit": kind == str(FailureKind.RATE_LIMITED),
            "detail": detail,
            "at": at.isoformat(),
            "resets_at": resets.isoformat() if resets else None,
            "reset_passed": bool(resets and resets <= now),
            "cleared": bool(last_ok_at and last_ok_at > at),
        })
        if len(issues) >= MAX_ISSUES:
            break
    return {
        "window_hours": WINDOW_HOURS,
        "last_ok_at": last_ok_at.isoformat() if last_ok_at else None,
        "issues": issues,
    }


async def recent(db_path: str, provider_id: str, rate_limit_selectors: list[str]) -> dict:
    """Recent failures for one unit, newest of each kind first. Never raises."""
    try:
        return await asyncio.to_thread(
            _recent_sync, str(db_path), provider_id, rate_limit_selectors
        )
    except Exception as e:  # noqa: BLE001 -- the doctor must still report
        return {"window_hours": WINDOW_HOURS, "last_ok_at": None, "issues": [],
                "error": f"{type(e).__name__}: {str(e)[:200]}"}
