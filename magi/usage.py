"""Claude usage, read from Claude Code's own transcripts.

WHY THIS SOURCE. There is no usage API, and claude.ai does not put a figure on
the page -- a saved DOM of a logged-in session contains no usage or limit text
at all, so scraping it would mean driving a browser to read something that is
not there. What this machine does have is the JSONL transcript Claude Code
appends for every session under ~/.claude/projects/<slug>/<session>.jsonl, and
every assistant turn in it carries `message.usage` with the exact token counts
that were charged. Reading files costs nothing and needs no browser.

WHAT IT CAN AND CANNOT SAY. These files give real token totals and the
boundaries of the rolling 5-hour window. They do NOT contain the account's
limit, so nothing here reports a percentage of one: that number would have to
be invented, and an invented number about how much you have left is worse than
no number. They also only describe CLAUDE CODE on this device -- the same
subscription MAGI's Claude unit uses, but not a record of MAGI's own browser
turns, which Anthropic does not expose anywhere local. The console says so
rather than implying it is counting every Claude message you have ever sent.

THE 5-HOUR WINDOW. Usage is bucketed into rolling 5-hour blocks: a block opens
on the first message after a gap and runs five hours from the top of that hour.
That is the shape Anthropic's session limit uses, so "resets at" here lines up
with the reset a rate-limit message quotes.

Transcripts are append-only, so each file is read from the byte offset last
seen: a week of sessions is scanned once, not on every poll.

Ported from Veda's Claude Queue (src/runner/usage.js), which established both
the source and the window shape.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

HOUR_S = 3600.0
BLOCK_S = 5 * HOUR_S
WEEK_S = 7 * 24 * HOUR_S

#: Re-reading the disk more often than this buys nothing.
DEFAULT_TTL_S = 5.0

#: A file untouched for longer than the window can hold nothing still counted.
STALE_FILE_S = WEEK_S + HOUR_S

#: One tail read is capped so a huge appended chunk cannot blow up memory.
MAX_READ_BYTES = 8 * 1024 * 1024

#: A rate needs a denominator worth dividing by -- see tokens_per_hour.
RATE_MIN_ELAPSED_S = 10 * 60


def default_root() -> Path:
    env = os.environ.get("MAGI_USAGE_DIR")
    if env:
        return Path(env)
    return Path.home() / ".claude" / "projects"


def _floor_hour(ts: float) -> float:
    """Blocks start on the hour, so a window reads as 1pm-6pm, not 1:07-6:07."""
    return (ts // HOUR_S) * HOUR_S


def _empty() -> dict[str, int]:
    return {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "total": 0}


def _compact(u: dict) -> dict[str, int]:
    """The four numbers that matter.

    Kept as its own step because the raw block is large -- a per-iteration
    breakdown and server-tool counters -- and a week of them held in memory
    would be tens of megabytes to hold four integers each.
    """
    return {
        "input": int(u.get("input_tokens") or 0),
        "output": int(u.get("output_tokens") or 0),
        "cache_read": int(u.get("cache_read_input_tokens") or 0),
        "cache_write": int(u.get("cache_creation_input_tokens") or 0),
    }


def _add(totals: dict[str, int], t: dict[str, int]) -> None:
    totals["input"] += t["input"]
    totals["output"] += t["output"]
    totals["cache_read"] += t["cache_read"]
    totals["cache_write"] += t["cache_write"]
    totals["total"] += t["input"] + t["output"] + t["cache_read"] + t["cache_write"]


def _add_model(by_model: dict[str, dict], model: str | None, t: dict[str, int]) -> None:
    key = model or "unknown"
    by_model.setdefault(key, _empty())
    _add(by_model[key], t)


def _model_list(by_model: dict[str, dict]) -> list[dict]:
    """Model totals as a list, biggest first -- what the console renders."""
    return sorted(
        ({"model": m, "tokens": t["total"]} for m, t in by_model.items()),
        key=lambda r: -r["tokens"],
    )


@dataclass
class _Sample:
    ts: float
    model: str | None
    usage: dict[str, int]


@dataclass
class _Seen:
    offset: int = 0
    partial: str = ""


def to_blocks(samples: list[_Sample]) -> list[dict]:
    """Group samples into rolling 5-hour blocks.

    A sample opens a new block when it falls outside the current block's five
    hours, or when five hours of silence have passed since the previous
    message -- the same two conditions that end a session window upstream.
    """
    blocks: list[dict] = []
    for s in sorted(samples, key=lambda x: x.ts):
        cur = blocks[-1] if blocks else None
        if cur and (s.ts - cur["start"]) < BLOCK_S and (s.ts - cur["last_ts"]) < BLOCK_S:
            cur["last_ts"] = s.ts
            cur["messages"] += 1
            _add(cur["tokens"], s.usage)
            _add_model(cur["models"], s.model, s.usage)
            continue
        block = {
            "start": _floor_hour(s.ts),
            "first_ts": s.ts,
            "last_ts": s.ts,
            "messages": 1,
            "tokens": _empty(),
            "models": {},
        }
        _add(block["tokens"], s.usage)
        _add_model(block["models"], s.model, s.usage)
        blocks.append(block)
    return blocks


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


@dataclass
class UsageTracker:
    root: Path = field(default_factory=default_root)
    ttl_s: float = DEFAULT_TTL_S
    _files: dict[str, _Seen] = field(default_factory=dict)
    _samples: list[_Sample] = field(default_factory=list)
    _last_scan: float = 0.0
    _last_error: str | None = None

    # ── reading ────────────────────────────────────────────────────────────
    def _transcripts(self) -> list[Path]:
        """Every *.jsonl one directory deep -- Claude Code's own layout."""
        out: list[Path] = []
        try:
            dirs = [d for d in self.root.iterdir() if d.is_dir()]
        except OSError:
            return out          # no transcripts yet is not an error
        for d in dirs:
            try:
                out.extend(f for f in d.iterdir() if f.suffix == ".jsonl")
            except OSError:
                continue
        return out

    def _read_file(self, path: Path, now: float) -> None:
        key = str(path)
        try:
            st = path.stat()
        except OSError:
            return

        # Nothing in a file this old is still inside the week window.
        if now - st.st_mtime > STALE_FILE_S:
            self._files.pop(key, None)
            return

        seen = self._files.get(key) or _Seen()
        # Shrunk means rewritten, not appended: start over rather than read
        # from an offset now pointing into the middle of a different line.
        if st.st_size < seen.offset:
            seen = _Seen()
        if st.st_size == seen.offset:
            self._files[key] = seen
            return

        start = max(seen.offset, st.st_size - MAX_READ_BYTES)
        if start > seen.offset:
            seen.partial = ""   # skipped ahead; the held fragment is useless
        try:
            with path.open("rb") as fh:
                fh.seek(start)
                chunk = fh.read(st.st_size - start).decode("utf-8", "replace")
        except OSError:
            return              # being written right now; next scan gets it

        lines = (seen.partial + chunk).split("\n")
        # The last element is whatever follows the final newline: either empty
        # or a half-written record that must wait for the rest of itself.
        seen.partial = lines.pop() if lines else ""
        seen.offset = st.st_size
        self._files[key] = seen

        for line in lines:
            # Cheap reject before parsing: most lines are user turns and tool
            # results, and json.loads over all of them is the cost of a scan.
            if not line or '"usage"' not in line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get("type") != "assistant":
                continue
            msg = rec.get("message") or {}
            u = msg.get("usage")
            if not isinstance(u, dict):
                continue
            model = msg.get("model") or None
            # Claude Code writes placeholder assistant turns (model
            # "<synthetic>") that cost nothing. Counting them would put a
            # permanent zero-token row in the breakdown for no reason.
            if model == "<synthetic>":
                continue
            ts = _parse_ts(rec.get("timestamp"))
            if ts is None:
                continue
            self._samples.append(_Sample(ts, model, _compact(u)))

    def scan(self, now: float | None = None) -> None:
        now = time.time() if now is None else now
        try:
            for f in self._transcripts():
                self._read_file(f, now)
            self._last_error = None
        except Exception as exc:                      # pragma: no cover
            self._last_error = str(exc)
        cutoff = now - WEEK_S
        if any(s.ts < cutoff for s in self._samples):
            self._samples = [s for s in self._samples if s.ts >= cutoff]
        self._last_scan = now

    # ── reporting ──────────────────────────────────────────────────────────
    def read(self, now: float | None = None, force: bool = False) -> dict:
        now = time.time() if now is None else now
        if force or (now - self._last_scan) >= self.ttl_s:
            self.scan(now)

        blocks = to_blocks(self._samples)
        last = blocks[-1] if blocks else None
        live = last if (last and now < last["start"] + BLOCK_S) else None

        week_tokens, week_models, week_messages = _empty(), {}, 0
        for s in self._samples:
            _add(week_tokens, s.usage)
            _add_model(week_models, s.model, s.usage)
            week_messages += 1

        if live:
            session = {
                "active": True,
                "start": _iso(live["start"]),
                "first_message": _iso(live["first_ts"]),
                "last_message": _iso(live["last_ts"]),
                "reset_at": _iso(live["start"] + BLOCK_S),
                "ms_left": int(max(0.0, live["start"] + BLOCK_S - now) * 1000),
                "elapsed_ms": int(min(BLOCK_S, now - live["start"]) * 1000),
                "window_ms": int(BLOCK_S * 1000),
                "messages": live["messages"],
                "tokens": live["tokens"],
                "models": _model_list(live["models"]),
                # Straight-line rate over the elapsed part of the window: a
                # "how fast am I burning this" signal, deliberately NOT
                # extrapolated against a limit, which is not knowable here.
                #
                # None until the window has some width to divide by. A window
                # that opened a minute ago reported 46 MILLION tokens/hour off
                # two messages -- arithmetically correct and completely
                # useless, and the kind of number that makes someone distrust
                # every other number next to it.
                "tokens_per_hour": (
                    round(live["tokens"]["total"] / ((now - live["start"]) / HOUR_S))
                    if (now - live["start"]) >= RATE_MIN_ELAPSED_S
                    else None
                ),
            }
        else:
            session = {
                "active": False,
                # With no live block the next message opens a fresh window, so
                # nothing is counting down.
                "last_active": _iso(last["last_ts"]) if last else None,
                "window_ms": int(BLOCK_S * 1000),
                "messages": 0,
                "tokens": _empty(),
                "models": [],
            }

        return {
            "ok": True,
            "source": str(self.root),
            # Named so the console can say whose usage this is. It is Claude
            # Code on this device, not MAGI's browser turns.
            "scope": "claude-code-local",
            "updated_at": _iso(now),
            "session": session,
            "week": {
                "since": _iso(now - WEEK_S),
                "messages": week_messages,
                "tokens": week_tokens,
                "models": _model_list(week_models),
            },
            "blocks": [
                {
                    "start": _iso(b["start"]),
                    "end": _iso(b["start"] + BLOCK_S),
                    "messages": b["messages"],
                    "tokens": b["tokens"]["total"],
                }
                for b in blocks[-8:]
            ],
            "error": self._last_error,
        }


def _parse_ts(raw) -> float | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        txt = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
        return datetime.fromisoformat(txt).timestamp()
    except ValueError:
        return None


#: One tracker for the process, so byte offsets survive between requests --
#: which is the whole point of reading incrementally.
TRACKER = UsageTracker()
