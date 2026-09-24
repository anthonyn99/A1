"""Keeping Claude Code and Codex current (updates.py).

No real update runs here: `proc.run` is scripted, and the CLI's version is
whatever the script says it is before and after.
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import pytest

from magi.code.agents import claude_cli as CC
from magi.code.agents import codex_cli as CX
from magi.code.agents import login, models as M, slots, updates as U


@pytest.fixture
def world(tmp_path, monkeypatch):
    """Both CLIs installed at old versions, npm at hand, nothing running."""
    monkeypatch.setattr(M, "data_dir", lambda: tmp_path)
    monkeypatch.setattr(slots, "cli_path", lambda a: f"C:/npm/{a}.cmd")
    monkeypatch.setattr(U, "_npm", lambda: "C:/node/npm.cmd")
    monkeypatch.setattr(U, "JOBS", {})
    monkeypatch.setattr(U, "_latest", {})
    monkeypatch.setattr(U, "_last_auto", {})
    monkeypatch.setattr(M, "_cli_ver", {})
    monkeypatch.setattr(login, "JOBS", {})
    from magi.code import tasks
    monkeypatch.setattr(tasks, "running", lambda: [])
    w = SimpleNamespace(installed={"claude": "2.1.278", "codex": "0.155.1"},
                        published={"claude": "2.1.281", "codex": "0.156.1"},
                        calls=[], envs=[], fail=False)

    def run(argv, **kw):
        w.calls.append(list(argv))
        exe = argv[0]
        if argv[1:] == ["--version"]:
            agent = "claude" if "claude" in exe else "codex"
            return SimpleNamespace(returncode=0, stdout=f"{w.installed[agent]} (x)\n", stderr="")
        if argv[1:2] == ["view"]:
            agent = "claude" if "claude-code" in argv[2] else "codex"
            return SimpleNamespace(returncode=0, stdout=w.published[agent] + "\n", stderr="")
        # the update itself
        w.envs.append(kw.get("env") or {})
        agent = "claude" if "claude" in exe else "codex"
        if w.fail:
            return SimpleNamespace(returncode=1, stdout="", stderr="EBUSY: resource busy or locked")
        w.installed[agent] = w.published[agent]
        return SimpleNamespace(returncode=0, stdout="Successfully updated", stderr="")
    monkeypatch.setattr(U.proc, "run", run)
    monkeypatch.setattr(M, "proc", U.proc, raising=False)
    import magi.proc as P
    monkeypatch.setattr(P, "run", run)
    return w


def test_status_says_how_far_behind(world):
    st = U.status("claude", check=True)
    assert (st["installed"], st["latest"], st["outdated"]) == ("2.1.278", "2.1.281", True)
    world.installed["claude"] = "2.1.281"
    M.cli_version("claude", fresh=True)
    assert U.status("claude")["outdated"] is False


def test_the_latest_version_is_asked_of_npm_at_most_every_few_hours(world):
    U.latest("codex")
    U.latest("codex")
    assert sum(1 for c in world.calls if c[1:2] == ["view"]) == 1
    U.latest("codex", force=True)
    assert sum(1 for c in world.calls if c[1:2] == ["view"]) == 2


def test_a_model_waiting_on_the_cli_is_named(world):
    M.note_cli_min("claude-opus-5-5", "2.1.280")
    assert [w["id"] for w in U.status("claude")["waiting"]] == ["claude-opus-5-5"]
    world.installed["claude"] = "2.1.281"
    M.cli_version("claude", fresh=True)
    assert U.status("claude")["waiting"] == []


def test_update_claude_with_its_own_updater(world, monkeypatch):
    monkeypatch.setenv("DISABLE_AUTOUPDATER", "1")          # as a MAGI task run has it
    job = U.start("claude", wait=True)
    assert job.state == "done" and (job.before, job.after) == ("2.1.278", "2.1.281")
    assert "Updated Claude Code from 2.1.278 to 2.1.281" in job.text
    assert ["C:/npm/claude.cmd", "update"] in world.calls
    assert "DISABLE_AUTOUPDATER" not in world.envs[-1], "MAGI's runs switch it off; the update must not"
    assert M.cli_version("claude") == "2.1.281", "the new version is read at once, not in 10 minutes"


def test_update_codex_through_npm(world):
    job = U.start("codex", wait=True)
    assert job.state == "done" and job.after == "0.156.1"
    assert ["C:/node/npm.cmd", "install", "-g", "@openai/codex@latest"] in world.calls


def test_a_failed_update_says_why(world):
    world.fail = True
    job = U.start("claude", wait=True)
    assert job.state == "failed" and "EBUSY" in job.text


def test_never_while_a_task_runs(world, monkeypatch):
    from magi.code import tasks
    monkeypatch.setattr(tasks, "running", lambda: ["t"])
    with pytest.raises(ValueError, match="task is running"):
        U.start("claude")
    assert not any(c[1:] == ["update"] for c in world.calls)


def test_never_during_a_sign_in(world):
    login.JOBS["j"] = SimpleNamespace(state="waiting")
    with pytest.raises(ValueError, match="sign-in"):
        U.start("codex")


def test_an_agent_sits_out_while_its_cli_is_replaced(world):
    U.JOBS["claude"] = U.Job(agent="claude")                  # running
    ok, why = asyncio.run(CC.ClaudeCLIAgent("system").available())
    assert not ok and "being updated" in why
    U.JOBS["codex"] = U.Job(agent="codex")
    ok, why = asyncio.run(CX.CodexCLIAgent("c1").available())
    assert not ok and "being updated" in why


def test_auto_updates_when_idle_and_behind(world):
    started = U.auto_tick()
    assert sorted(started) == ["claude", "codex"]
    for j in list(U.JOBS.values()):
        for _ in range(100):
            if j.state != "running":
                break
            time.sleep(0.02)
    assert world.installed == world.published


def test_auto_update_can_be_turned_off(world):
    M.set_auto_update(False)
    assert U.auto_tick() == []
    assert not any(c[1:2] == ["view"] for c in world.calls), "off means not even a check"


def test_auto_update_waits_for_idle(world, monkeypatch):
    from magi.code import tasks
    monkeypatch.setattr(tasks, "running", lambda: ["t"])
    assert U.auto_tick() == []


def test_auto_checks_every_few_hours_unless_a_model_is_waiting(world):
    world.published = dict(world.installed)          # nothing newer
    now = time.time()
    assert U.auto_tick(now) == []
    views = sum(1 for c in world.calls if c[1:2] == ["view"])
    assert U.auto_tick(now + 600) == [] and sum(1 for c in world.calls if c[1:2] == ["view"]) == views
    M.note_cli_min("claude-opus-5-5", "2.1.280")      # a model is now waiting
    world.published["claude"] = "2.1.281"
    U._latest.clear()
    assert U.auto_tick(now + 700) == ["claude"]


def test_the_switch_is_validated(world):
    with pytest.raises(ValueError):
        M.set_auto_update("yes")
    assert M.prefs()["auto_update"] is True
