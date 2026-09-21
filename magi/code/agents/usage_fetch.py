"""What each coding account has left, asked of the provider directly.

Before this, Claude's percentages came only from the `rate_limit_event` a run
emits, and Codex's from its last session log -- so both were exactly as old as
the last task. A 90% from last night stayed on screen after the window had
reset, which is worse than showing nothing: it tells you not to use an
account that is fresh.

These are the same two reads the CLIs make for their own `/usage` and
`/status` screens:

    Claude   GET https://api.anthropic.com/api/oauth/usage
    Codex    GET https://chatgpt.com/backend-api/wham/usage

Each is authorised with the slot's own token, read from the slot's own login
file on this machine, and sent only to the provider that issued it. No model
call, nothing billed, no API key.

Two rules keep this from ever getting in a CLI's way:

  * **Never refresh a token.** Both providers rotate refresh tokens; a second
    refresher racing the CLI can sign the CLI out. An expired access token
    means "skip this read" -- the CLI renews it the next time it runs.
  * **Throttled.** At most one read per slot per MIN_INTERVAL, whatever calls
    it; a failure is remembered for the same interval so a dead endpoint is
    not hammered every minute.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

from . import limits, slots

MIN_INTERVAL = 60.0
TIMEOUT = 10

CLAUDE_URL = "https://api.anthropic.com/api/oauth/usage"
CODEX_URL = "https://chatgpt.com/backend-api/wham/usage"

_last: dict[str, tuple[float, dict]] = {}


def _claude_creds(slot: str) -> Path:
    d = slots.slot_dir("claude", slot)
    if d is None:
        d = Path(os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude"))
    return d / ".credentials.json"


def _iso(ts: Any) -> float | None:
    if isinstance(ts, (int, float)):
        return float(ts)
    if isinstance(ts, str) and ts:
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def parse_claude(body: dict) -> dict[str, dict]:
    """The usage response -> {window: {utilization 0..1, resets_at}}.

    Only the windows that are set. The response carries a dozen codenamed
    windows that are null for a normal subscription; showing them would be
    noise, and inventing names for them would be guessing.
    """
    out: dict[str, dict] = {}
    for win in ("five_hour", "seven_day", "seven_day_opus"):
        w = body.get(win)
        if isinstance(w, dict) and isinstance(w.get("utilization"), (int, float)):
            out[win] = {"utilization": float(w["utilization"]) / 100.0,
                        "resets_at": _iso(w.get("resets_at"))}
    return out


def _window_name(seconds: float) -> str:
    mins = int((seconds or 0) // 60)
    if mins <= 0:
        return "window"
    if mins < 60:
        return f"{mins}m"
    if mins < 1440:
        return f"{mins // 60}h"
    return f"{mins // 1440}d"


def parse_codex(body: dict) -> tuple[dict[str, dict], bool | None]:
    """-> (windows, allowed). A free account has one 30-day window; Plus has
    a five-hour primary and a weekly secondary."""
    rl = body.get("rate_limit") or {}
    out: dict[str, dict] = {}
    for which in ("primary_window", "secondary_window"):
        w = rl.get(which)
        if isinstance(w, dict) and isinstance(w.get("used_percent"), (int, float)):
            out[_window_name(w.get("limit_window_seconds", 0))] = {
                "utilization": float(w["used_percent"]) / 100.0,
                "resets_at": _iso(w.get("reset_at"))}
    allowed = None
    if "allowed" in rl or "limit_reached" in rl:
        allowed = bool(rl.get("allowed", True)) and not rl.get("limit_reached")
    return out, allowed


def _get(url: str, headers: dict[str, str]) -> dict | None:
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError):
        return None


def fetch_claude(slot: str) -> dict[str, dict]:
    try:
        cred = json.loads(_claude_creds(slot).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    oauth = cred.get("claudeAiOauth") or {}
    tok = oauth.get("accessToken")
    exp = float(oauth.get("expiresAt") or 0) / 1000.0
    if not tok or (exp and exp < time.time() + 30):
        return {}      # expired: the CLI renews it on its next run, not us
    body = _get(CLAUDE_URL, {
        "Authorization": f"Bearer {tok}",
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
        "User-Agent": "magi-usage/1"})
    return parse_claude(body) if isinstance(body, dict) else {}


def fetch_codex(slot: str) -> tuple[dict[str, dict], bool | None]:
    d = slots.slot_dir("codex", slot)
    try:
        auth = json.loads((d / "auth.json").read_text(encoding="utf-8")) if d else {}
    except (OSError, ValueError):
        return {}, None
    tok = (auth.get("tokens") or {})
    if not tok.get("access_token"):
        return {}, None
    body = _get(CODEX_URL, {
        "Authorization": f"Bearer {tok['access_token']}",
        "chatgpt-account-id": tok.get("account_id") or "",
        "originator": "codex_cli_rs",
        "User-Agent": "magi-usage/1"})
    return parse_codex(body) if isinstance(body, dict) else ({}, None)


def refresh(agent: str, slot: str, *, force: bool = False) -> dict[str, dict]:
    """Fresh windows for one slot, stored for the UI. Blocking; run it in an
    executor. Returns {} when nothing could be read (the stored figures, aged
    by limits.snapshot, are what the UI shows then)."""
    k = limits.key(agent, slot)
    now = time.time()
    hit = _last.get(k)
    if hit and not force and now - hit[0] < MIN_INTERVAL:
        return hit[1]
    windows: dict[str, dict] = {}
    allowed: bool | None = None
    if agent == "claude":
        windows = fetch_claude(slot)
        if windows:
            allowed = all(w["utilization"] < 1.0 for w in windows.values())
    elif agent == "codex":
        windows, allowed = fetch_codex(slot)
    _last[k] = (now, windows)
    for win, w in windows.items():
        limits.note_usage(agent, slot, win, w["utilization"], w["resets_at"])
    # The provider says there is room: a remembered limit is out of date.
    if windows and allowed and limits.blocked_until(agent, slot):
        limits.clear(agent, slot)
    return windows


def refresh_all(force: bool = False) -> None:
    for agent in slots.AGENTS:
        for slot in slots.list_slots(agent):
            try:
                refresh(agent, slot, force=force)
            except Exception:  # noqa: BLE001 -- a usage read must never break a page
                pass
