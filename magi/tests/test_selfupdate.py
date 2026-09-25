"""Engines update themselves: pull what was pushed, restart only when idle.

The engine loads its Python once, so a pushed fix did nothing on a PC until
someone there pulled, installed and restarted by hand -- Veda's engine sat on
old code for days. The watchdog now does it, and these pin the rules that make
that safe: a restart happens only when the running code is really stale,
only after the new code has settled, never forced, and a refused restart
(something is running) is simply tried again next time.
"""

from __future__ import annotations

import pytest

from magi import selfupdate as U


@pytest.fixture
def box(tmp_path, monkeypatch):
    calls = {"restart": 0, "update": 0}
    monkeypatch.setattr(U, "_state_path", lambda: tmp_path / "update.json")
    monkeypatch.setattr(U, "update_checkout", lambda: calls.__setitem__("update", calls["update"] + 1) or "ok")
    monkeypatch.setattr(U, "ensure_requirements", lambda: "requirements unchanged")
    monkeypatch.setattr(U, "_log", lambda line: None)
    env = {"running": "aaa", "disk": "aaa", "restart_ok": True}
    monkeypatch.setattr(U, "_health", lambda port: {"code_rev": env["running"]} if env["running"] is not None else {})
    monkeypatch.setattr(U, "code_rev", lambda: env["disk"])

    def ask(port):
        calls["restart"] += 1
        return (True, "ok") if env["restart_ok"] else (False, "409 a deliberation still running.")
    monkeypatch.setattr(U, "_ask_restart", ask)
    return env, calls


def test_current_engine_is_left_alone(box):
    env, calls = box
    assert U.tick(8000, now=1000) == "current"
    assert calls["restart"] == 0


def test_stale_engine_restarts_only_after_the_code_settles(box):
    env, calls = box
    env["disk"] = "bbb"
    assert U.tick(8000, now=1000) == "new code seen; settling"
    assert U.tick(8000, now=1000 + U.SETTLE_S - 1) == "settling"
    assert calls["restart"] == 0
    assert U.tick(8000, now=1000 + U.SETTLE_S + 1) == "restarting"
    assert calls["restart"] == 1


def test_a_burst_of_commits_restarts_once_at_the_end(box):
    env, calls = box
    env["disk"] = "bbb"
    U.tick(8000, now=1000)
    env["disk"] = "ccc"                       # another push lands while settling
    assert U.tick(8000, now=1000 + U.SETTLE_S + 1) == "new code seen; settling"
    assert calls["restart"] == 0


def test_a_busy_engine_is_never_forced_and_is_retried(box):
    env, calls = box
    env["disk"] = "bbb"
    env["restart_ok"] = False
    U.tick(8000, now=0)
    assert U.tick(8000, now=U.SETTLE_S + 1).startswith("restart deferred")
    env["restart_ok"] = True
    assert U.tick(8000, now=U.SETTLE_S + 200) == "restarting"
    assert calls["restart"] == 2


def test_an_engine_from_before_self_update_counts_as_stale(box):
    env, calls = box
    env["running"] = None                     # no code_rev on /api/health
    U.tick(8000, now=0)
    assert U.tick(8000, now=U.SETTLE_S + 1) == "restarting"


def test_github_is_asked_on_a_timer_not_every_tick(box):
    env, calls = box
    U.tick(8000, now=10_000)
    U.tick(8000, now=10_000 + 30)
    assert calls["update"] == 1
    U.tick(8000, now=10_000 + U.FETCH_EVERY_S + 1)
    assert calls["update"] == 2


def test_code_rev_ignores_tests_and_docs():
    rev = U.code_rev()
    assert rev and len(rev) == 16
    r = U._git("ls-tree", "-r", "HEAD", "--", "magi")
    assert "magi/tests/" in U._out(r)          # they are in the tree...
    # ...but a change to one must not move the fingerprint: recompute with a
    # tests-only line added and it is unchanged.
    import hashlib
    lines = U._out(r).splitlines()
    keep = [ln for ln in lines if not any(f"\t{p}" in ln for p in U._IGNORED) and not ln.endswith(".md")]
    assert hashlib.sha1("\n".join(keep).encode()).hexdigest()[:16] == rev


def test_restart_endpoint_waits_for_brainstorms_and_sign_ins():
    from pathlib import Path
    src = (Path(U.__file__).parent / "app.py").read_text(encoding="utf-8")
    body = src[src.index("async def restart_engine"):src.index("async def list_providers")]
    assert "_brainstorm_jobs" in body and "_logins" in body
    assert '"code_rev": CODE_REV' in src
