"""A composer that never shows gets ONE reload before the unit fails.

THE RUNS THIS COMES FROM (2026-11-17, 2026-11-18)
ChatGPT failed with "No 'input' selector matched on ChatGPT. Tried 6." Its
failure snapshots showed the page still loading: once its pre-load placeholder
(`textarea#pending-home-input`, sidebar skeletons), once the real box mounted
just after the 30 s wait. The selectors were right; the page was slow.

Pinned here: a miss reloads once and waits again; a hit never reloads; a login
control or a challenge never reloads (a reload fixes neither).
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from magi.providers import browser_base as bb


def _site():
    return SimpleNamespace(ready_timeout_s=1, input=["#box"], login_selectors=[],
                           challenge_selectors=[], url="https://x", nav_timeout_s=1)


def _run(monkeypatch, results, *, signed_out=False, challenge=False):
    calls = {"resolve": 0, "nav": 0}
    seq = list(results)

    async def fake_resolve(page, cands, timeout_ms=0):
        calls["resolve"] += 1
        return seq.pop(0)

    async def fake_open(page, site, tries=2):
        calls["nav"] += 1

    async def fake_out(page, sels):
        return signed_out

    async def fake_chal(page, sels):
        return challenge

    monkeypatch.setattr(bb.resolve, "resolve", fake_resolve)
    monkeypatch.setattr(bb.resolve, "signed_out", fake_out)
    monkeypatch.setattr(bb.resolve, "is_challenge_page", fake_chal)
    monkeypatch.setattr(bb, "open_site", fake_open)
    box = asyncio.run(bb.find_composer(object(), _site()))
    return box, calls


def test_hit_never_reloads(monkeypatch):
    box, calls = _run(monkeypatch, ["BOX"])
    assert box == "BOX" and calls == {"resolve": 1, "nav": 0}


def test_miss_reloads_once_then_finds(monkeypatch):
    box, calls = _run(monkeypatch, [None, "BOX"])
    assert box == "BOX" and calls == {"resolve": 2, "nav": 1}


def test_miss_twice_fails_after_one_reload(monkeypatch):
    box, calls = _run(monkeypatch, [None, None])
    assert box is None and calls == {"resolve": 2, "nav": 1}


def test_signed_out_does_not_reload(monkeypatch):
    box, calls = _run(monkeypatch, [None], signed_out=True)
    assert box is None and calls["nav"] == 0


def test_challenge_does_not_reload(monkeypatch):
    box, calls = _run(monkeypatch, [None], challenge=True)
    assert box is None and calls["nav"] == 0
