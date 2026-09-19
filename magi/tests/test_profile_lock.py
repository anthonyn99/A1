"""Two jobs on the SAME unit must take turns, never kill each other.

launcher.launch treats any Chrome it finds on a profile as an orphan and
kills it. Before the per-profile lock, a Studio Report and Flashcards both on
ChatGPT meant the second launch killed the first job's live browser, and the
first reported "No new answer appeared within 45s ... the send may not have
registered" -- observed 2026-09-19. Different units must still run in
parallel: that is the whole point of a council.
"""

import asyncio
import sys
from contextlib import asynccontextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from magi.browser import launcher  # noqa: E402


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _fake_unlocked(log):
    @asynccontextmanager
    async def fake(site_id, cfg, **kw):
        log.append(("open", site_id))
        await asyncio.sleep(0.05)
        yield object()
        log.append(("close", site_id))
    return fake


def test_same_unit_jobs_take_turns(monkeypatch):
    log = []
    monkeypatch.setattr(launcher, "_launch_unlocked", _fake_unlocked(log))
    monkeypatch.setattr(launcher, "_profile_locks", {})

    async def job():
        async with launcher.launch("chatgpt", None):
            await asyncio.sleep(0.05)

    async def main():
        await asyncio.gather(job(), job())

    _run(main())
    assert log == [("open", "chatgpt"), ("close", "chatgpt"),
                   ("open", "chatgpt"), ("close", "chatgpt")], log


def test_different_units_still_run_together(monkeypatch):
    log = []
    monkeypatch.setattr(launcher, "_launch_unlocked", _fake_unlocked(log))
    monkeypatch.setattr(launcher, "_profile_locks", {})

    async def job(site):
        async with launcher.launch(site, None):
            await asyncio.sleep(0.05)

    async def main():
        await asyncio.gather(job("chatgpt"), job("gemini"))

    _run(main())
    assert log[:2] == [("open", "chatgpt"), ("open", "gemini")], log
