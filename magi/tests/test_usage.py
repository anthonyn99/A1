"""Usage read from Claude Code's transcripts.

The numbers here end up on a screen someone uses to decide whether to run
another deliberation, so the ways they can go wrong all matter: a window that
never closes, a rate computed off a window one minute old, a half-written line
counted twice, and above all a percentage of a limit that is not in the data.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from magi.usage import BLOCK_S, UsageTracker  # noqa: E402


def _line(ts: float, model: str = "claude-opus-5", inp: int = 100,
          out: int = 50, kind: str = "assistant") -> str:
    return json.dumps({
        "type": kind,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ts)) + "Z",
        "message": {"model": model, "usage": {
            "input_tokens": inp, "output_tokens": out,
            "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}},
    })


def _write(root: Path, name: str, lines: list[str]) -> Path:
    d = root / "proj"
    d.mkdir(parents=True, exist_ok=True)
    f = d / name
    f.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return f


def test_counts_only_assistant_turns(tmp_path):
    now = time.time()
    _write(tmp_path, "a.jsonl", [
        _line(now - 60),
        _line(now - 50, kind="user"),          # not an assistant turn
        _line(now - 40, model="<synthetic>"),  # a placeholder that cost nothing
        _line(now - 30),
    ])
    d = UsageTracker(root=tmp_path).read(now=now)
    assert d["session"]["messages"] == 2
    assert d["session"]["tokens"]["total"] == 300


def test_a_five_hour_gap_opens_a_new_window(tmp_path):
    now = time.time()
    _write(tmp_path, "a.jsonl", [
        _line(now - 6 * 3600),     # older than the window: its own block
        _line(now - 120),
    ])
    d = UsageTracker(root=tmp_path).read(now=now)
    assert len(d["blocks"]) == 2
    assert d["session"]["messages"] == 1, "the live window took in an old message"


def test_a_window_that_has_expired_is_not_live(tmp_path):
    now = time.time()
    _write(tmp_path, "a.jsonl", [_line(now - (BLOCK_S + 3600))])
    d = UsageTracker(root=tmp_path).read(now=now)
    assert d["session"]["active"] is False
    assert d["session"]["last_active"], "an idle window still says when it last ran"


def test_a_rate_needs_a_window_worth_dividing_by(tmp_path):
    """46 million tokens an hour, off one message, is not a useful number.

    The rate divides by time since the block OPENED, and a block opens on the
    hour -- so this is only wrong in the minutes right after the hour turns,
    which is exactly when the first message of a window tends to land.
    """
    # A message one minute into a block, read one minute later.
    top_of_hour = (time.time() // 3600) * 3600
    _write(tmp_path, "a.jsonl", [_line(top_of_hour + 30)])

    fresh = UsageTracker(root=tmp_path).read(now=top_of_hour + 60)
    assert fresh["session"]["tokens_per_hour"] is None, (
        "a minute-old window was extrapolated into an hourly rate"
    )

    later = UsageTracker(root=tmp_path).read(now=top_of_hour + 3600)
    assert later["session"]["tokens_per_hour"] == 150, (
        "150 tokens in the first hour of the window is 150 an hour"
    )


def test_nothing_reports_a_percentage_of_a_limit(tmp_path):
    """The limit is not in the transcripts, so it cannot be in the output."""
    now = time.time()
    _write(tmp_path, "a.jsonl", [_line(now - 60)])
    d = UsageTracker(root=tmp_path).read(now=now)
    # `source` is a filesystem path, and under pytest it contains this test's
    # own name -- which is enough to fail the check it is part of.
    d.pop("source", None)
    flat = json.dumps(d).lower()
    for word in ("percent", "limit", "remaining", "quota"):
        assert word not in flat, f"the payload implies a known limit: {word}"


def test_appends_are_read_incrementally(tmp_path):
    """A week of transcripts is scanned once, not on every poll."""
    now = time.time()
    f = _write(tmp_path, "a.jsonl", [_line(now - 300)])
    t = UsageTracker(root=tmp_path, ttl_s=0)
    assert t.read(now=now)["session"]["messages"] == 1
    offset_after_first = t._files[str(f)].offset

    with f.open("a", encoding="utf-8") as fh:
        fh.write(_line(now - 100) + "\n")
    d = t.read(now=now)
    assert d["session"]["messages"] == 2, "the appended turn was missed"
    assert t._files[str(f)].offset > offset_after_first


def test_a_half_written_line_is_not_lost_or_double_counted(tmp_path):
    """The file is being appended to WHILE it is read."""
    now = time.time()
    d = tmp_path / "proj"
    d.mkdir(parents=True)
    f = d / "a.jsonl"
    whole = _line(now - 200)
    f.write_text(whole + "\n" + whole[:40], encoding="utf-8")   # torn tail

    t = UsageTracker(root=tmp_path, ttl_s=0)
    assert t.read(now=now)["session"]["messages"] == 1
    with f.open("a", encoding="utf-8") as fh:
        fh.write(whole[40:] + "\n")                             # the rest lands
    assert t.read(now=now)["session"]["messages"] == 2


def test_a_rewritten_file_is_reread_from_the_start(tmp_path):
    now = time.time()
    f = _write(tmp_path, "a.jsonl", [_line(now - 300), _line(now - 290)])
    t = UsageTracker(root=tmp_path, ttl_s=0)
    t.read(now=now)
    f.write_text(_line(now - 100) + "\n", encoding="utf-8")     # shorter now
    d = t.read(now=now)
    assert d["session"]["messages"] == 3, (
        "a shrunk file was read from a stale offset instead of from the top"
    )


def test_no_transcripts_is_not_an_error(tmp_path):
    d = UsageTracker(root=tmp_path / "nothing-here").read()
    assert d["ok"] is True
    assert d["session"]["active"] is False
    assert d["error"] is None
