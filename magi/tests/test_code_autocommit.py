"""Auto commit / auto push (Phase 12).

Real git in tmp_path throughout -- a bare repository stands in for GitHub --
and A1 itself only ever as the answer to "is this MAGI's own repository?",
never written to. The prefs a project has are faked by pointing
autocommit.prefs_source at a dict, which is exactly the seam routes.py uses.
"""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import pytest

from magi.code import autocommit as AC
from magi.code import git as G
from magi.code import sandbox as SB
from magi.code import tasks as T
from magi.code.agents import chain
from magi.code.agents.base import CodingAgent, Mode, Outcome, Result


def _git(cwd: Path, *args: str) -> str:
    r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True,
                       encoding="utf-8")
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def _cfg(r: Path) -> None:
    for k, v in (("user.name", "t"), ("user.email", "t@t"), ("core.autocrlf", "false")):
        _git(r, "config", k, v)


PREFS: dict[str, dict] = {}


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    AC.PENDING.clear()
    AC.LAST.clear()
    PREFS.clear()

    async def src(pid):
        return PREFS.get(pid)
    monkeypatch.setattr(AC, "prefs_source", src)
    yield
    for p in AC.PENDING.values():
        if p.timer is not None:
            p.timer.cancel()
    AC.PENDING.clear()


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "proj"
    r.mkdir()
    _git(r, "init", "-q", "-b", "main")
    _cfg(r)
    for n in ("a.py", "b.py", "c.py", "other.py"):
        (r / n).write_text(f"{n} = 1\n")
    _git(r, "add", "-A")
    _git(r, "commit", "-qm", "init")
    return r


@pytest.fixture
def cloned(tmp_path):
    bare = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(bare)], check=True)
    seed = tmp_path / "other"
    seed.mkdir()
    _git(seed, "init", "-q", "-b", "main")
    _cfg(seed)
    (seed / "app.py").write_text("x = 1\n")
    (seed / "shared.py").write_text("s = 1\n")
    _git(seed, "add", "-A")
    _git(seed, "commit", "-qm", "init")
    _git(seed, "remote", "add", "origin", str(bare))
    _git(seed, "push", "-q", "-u", "origin", "main")
    ours = tmp_path / "ours"
    subprocess.run(["git", "clone", "-q", str(bare), str(ours)], check=True)
    _cfg(ours)
    return {"bare": bare, "other": seed, "ours": ours}


def _on(pid="p", push=False, window=3, github=""):
    PREFS[pid] = {"autoCommit": True, "autoPush": push, "batchWindowMin": window,
                  "github": github}


async def _apply(repo, files, draft, task="t1", pid="p"):
    for f in files:
        (repo / f).write_text(f"{f} changed by {task}\n")
    return await AC.on_applied(project_id=pid, repo=str(repo), files=files, draft=draft,
                               task_id=task)


def _log(repo, n=1):
    return _git(repo, "log", f"-{n}", "--format=%s")


def _committed_files(repo, ref="HEAD"):
    return sorted(_git(repo, "show", "--name-only", "--format=", ref).split())


# ── what may be switched on ────────────────────────────────────────────────

def test_off_by_default_and_push_needs_commit():
    from magi.code import workspace as W
    g = AC.guard_prefs(W.DEFAULT_PREFS, None)
    assert g["autoCommit"] is False and g["autoPush"] is False
    assert AC.guard_prefs({"autoCommit": False, "autoPush": True}, None)["autoPush"] is False
    assert AC.guard_prefs({"autoCommit": True, "autoPush": True}, None)["autoPush"] is True


def test_the_window_is_clamped():
    assert AC.guard_prefs({"batchWindowMin": 0}, None)["batchWindowMin"] == 3   # 0 = unset
    assert AC.guard_prefs({"batchWindowMin": -5}, None)["batchWindowMin"] == 1
    assert AC.guard_prefs({"batchWindowMin": 999}, None)["batchWindowMin"] == 30
    assert AC.guard_prefs({"batchWindowMin": "x"}, None)["batchWindowMin"] == 3


def test_a1_is_never_switched_on_whatever_is_sent():
    from magi.settings import ROOT
    g = AC.guard_prefs({"autoCommit": True, "autoPush": True}, ROOT)
    assert g["autoCommit"] is False and g["autoPush"] is False


def test_a1_never_gets_a_pending_commit_even_with_prefs_on():
    from magi.settings import ROOT
    _on("a1", push=True)
    out = asyncio.run(AC.on_applied(project_id="a1", repo=str(ROOT), files=["x.py"],
                                    draft="Nope", task_id="t"))
    assert out is None and "a1" not in AC.PENDING


def test_the_route_guard_reads_the_binding_on_this_machine():
    from magi.code import routes as R
    from magi.settings import ROOT
    p = {"id": "a1", "bindings": [{"here": True, "root": str(ROOT)}]}
    g = asyncio.run(R._guarded(p, {"autoCommit": True, "autoPush": True}))
    assert g["autoCommit"] is False and g["autoPush"] is False


def test_off_means_nothing_is_scheduled(repo):
    PREFS["p"] = {"autoCommit": False}
    assert asyncio.run(_apply(repo, ["a.py"], "Edit a")) is None
    assert AC.PENDING == {}


def test_no_prefs_source_means_off(repo, monkeypatch):
    monkeypatch.setattr(AC, "prefs_source", None)
    assert asyncio.run(_apply(repo, ["a.py"], "Edit a")) is None


# ── the message ────────────────────────────────────────────────────────────

def test_message_has_the_magi_prefix_and_keeps_the_body():
    m = AC.message(["Fix the parser\n\nIt now skips blank lines."])
    assert m == "magi: Fix the parser\n\nIt now skips blank lines."
    assert not m.startswith(("auto:", "auto: claude code"))


def test_folded_tasks_list_every_ask():
    m = AC.message(["Fix the parser\n\nbody", "Add a test", "Rename x"])
    assert m.splitlines()[0] == "magi: Fix the parser (+2 more)"
    assert "- Add a test" in m and "- Rename x" in m and "- Fix the parser" in m


# ── debounce ───────────────────────────────────────────────────────────────

def test_n_applies_collapse_into_one_commit_and_restart_the_timer(repo):
    _on()

    async def go():
        first = await _apply(repo, ["a.py"], "Edit a", "t1")
        await asyncio.sleep(0.05)
        second = await _apply(repo, ["b.py", "a.py"], "Edit b", "t2")
        third = await _apply(repo, ["c.py"], "Edit c", "t3")
        assert third["due"] > first["due"], "a later apply restarts the window"
        assert third["files"] == ["a.py", "b.py", "c.py"]
        assert third["tasks"] == ["t1", "t2", "t3"]
        assert second["due"] >= first["due"]
        return await AC.fire("p")
    before = int(_git(repo, "rev-list", "--count", "HEAD"))
    last = asyncio.run(go())
    assert last["ok"] and last["code"] == "committed"
    assert int(_git(repo, "rev-list", "--count", "HEAD")) == before + 1
    assert _committed_files(repo) == ["a.py", "b.py", "c.py"]
    assert _log(repo) == "magi: Edit a (+2 more)"
    assert AC.PENDING == {}


def test_the_timer_really_fires_after_the_window(repo, monkeypatch):
    monkeypatch.setattr(AC, "MINUTE", 0.05)
    _on(window=1)

    async def go():
        await _apply(repo, ["a.py"], "Edit a")
        assert _log(repo) == "init", "nothing is committed before the window ends"
        for _ in range(100):
            await asyncio.sleep(0.02)
            if "p" in AC.LAST:
                return
    asyncio.run(go())
    assert AC.LAST["p"]["ok"], AC.LAST["p"]
    assert _log(repo) == "magi: Edit a"


def test_only_the_touched_files_are_committed(repo):
    _on()
    (repo / "other.py").write_text("edited by you, not by the task\n")

    async def go():
        await _apply(repo, ["a.py"], "Edit a")
        return await AC.fire("p")
    assert asyncio.run(go())["ok"]
    assert _committed_files(repo) == ["a.py"]
    assert "other.py" in _git(repo, "status", "--porcelain")


def test_the_repositorys_hooks_run(repo):
    hook = repo / ".git" / "hooks" / "pre-commit"
    hook.write_text("#!/bin/sh\necho no >&2\nexit 1\n")
    hook.chmod(0o755)
    _on()

    async def go():
        await _apply(repo, ["a.py"], "Edit a")
        return await AC.fire("p")
    last = asyncio.run(go())
    assert not last["ok"] and last["code"] == "commit"
    assert _log(repo) == "init"


def test_a_write_task_still_running_postpones_the_commit(repo, monkeypatch):
    _on()

    class Busy:
        project_id, mode, done = "p", "write", False
    monkeypatch.setitem(T.TASKS, "busy", Busy())

    async def go():
        await _apply(repo, ["a.py"], "Edit a")
        out = await AC.fire("p")
        assert out is None and AC.PENDING["p"].timer is not None
        assert AC.PENDING["p"].due - __import__("time").time() <= AC.BUSY_RETRY + 1
    asyncio.run(go())
    assert _log(repo) == "init"


def test_switched_off_before_it_fires_commits_nothing(repo):
    _on()

    async def go():
        await _apply(repo, ["a.py"], "Edit a")
        PREFS["p"]["autoCommit"] = False
        return await AC.fire("p")
    last = asyncio.run(go())
    assert last["code"] == "off" and _log(repo) == "init"


def test_cancel_leaves_the_files_applied_and_uncommitted(repo):
    _on()

    async def go():
        await _apply(repo, ["a.py"], "Edit a")
        assert AC.cancel("p")
        assert not AC.cancel("p")
    asyncio.run(go())
    assert _log(repo) == "init" and AC.LAST["p"]["code"] == "cancelled"
    assert (repo / "a.py").read_text().startswith("a.py changed")


def test_a_hand_commit_takes_its_task_out_of_the_pending_one(repo):
    _on()

    async def go():
        await _apply(repo, ["a.py"], "Edit a", "t1")
        await _apply(repo, ["b.py"], "Edit b", "t2")
        AC.forget_task("p", "t1", ["a.py"])
        assert AC.PENDING["p"].files == ["b.py"] and AC.PENDING["p"].tasks == ["t2"]
        AC.forget_task("p", "t2", ["b.py"])
        assert "p" not in AC.PENDING
    asyncio.run(go())


# ── refusals ───────────────────────────────────────────────────────────────

def test_unrelated_staged_changes_block_and_keep_it_pending(repo):
    _on()
    (repo / "other.py").write_text("staged by hand\n")
    _git(repo, "add", "other.py")

    async def go():
        await _apply(repo, ["a.py"], "Edit a")
        last = await AC.fire("p")
        assert not last["ok"] and last["code"] == "staged" and "other.py" in last["text"]
        p = AC.PENDING["p"]
        assert p.blocked and p.timer is None and p.to_dict()["due"] is None
        assert _log(repo) == "init"
        _git(repo, "restore", "--staged", "other.py")
        return await AC.fire("p", now=True)
    last = asyncio.run(go())
    assert last["ok"] and _committed_files(repo) == ["a.py"]
    assert "other.py" in _git(repo, "status", "--porcelain")


def test_staging_the_same_file_yourself_is_not_unrelated(repo):
    _on()

    async def go():
        await _apply(repo, ["a.py"], "Edit a")
        _git(repo, "add", "a.py")
        return await AC.fire("p")
    assert asyncio.run(go())["ok"]


def test_mid_rebase_blocks(repo):
    _on()
    gd = Path(_git(repo, "rev-parse", "--absolute-git-dir"))

    async def go():
        await _apply(repo, ["a.py"], "Edit a")
        (gd / "rebase-merge").mkdir()
        try:
            return await AC.fire("p")
        finally:
            (gd / "rebase-merge").rmdir()
    last = asyncio.run(go())
    assert last["code"] == "in_progress" and "rebase" in last["text"]
    assert _log(repo) == "init"


def test_mid_merge_blocks(repo):
    _on()
    gd = Path(_git(repo, "rev-parse", "--absolute-git-dir"))

    async def go():
        await _apply(repo, ["a.py"], "Edit a")
        (gd / "MERGE_HEAD").write_text(_git(repo, "rev-parse", "HEAD") + "\n")
        return await AC.fire("p")
    last = asyncio.run(go())
    assert last["code"] == "in_progress" and "merge" in last["text"]


def test_detached_head_blocks(repo):
    _on()
    _git(repo, "checkout", "-q", "--detach")

    async def go():
        await _apply(repo, ["a.py"], "Edit a")
        return await AC.fire("p")
    assert asyncio.run(go())["code"] == "detached"


def test_nothing_to_commit_says_so(repo):
    _on()

    async def go():
        await AC.on_applied(project_id="p", repo=str(repo), files=["a.py"], draft="x",
                            task_id="t")
        return await AC.fire("p")
    last = asyncio.run(go())
    assert last["code"] == "nothing" and "p" not in AC.PENDING


# ── push ───────────────────────────────────────────────────────────────────

def test_push_only_after_a_clean_pull(cloned):
    ours, other = cloned["ours"], cloned["other"]
    _on(push=True)
    (other / "shared.py").write_text("s = 2  # theirs\n")
    _git(other, "commit", "-qam", "theirs, no clash")
    _git(other, "push", "-q")

    async def go():
        await _apply(ours, ["app.py"], "Edit app")
        return await AC.fire("p")
    last = asyncio.run(go())
    assert last["ok"] and last["push"]["ok"], last
    assert last["pull"]["ok"] and last["pull"]["commits"] == 1
    remote_head = _git(cloned["bare"], "rev-parse", "main")
    assert last["push"]["sha"] == remote_head, "the SHA the Actions watch follows"
    assert _git(cloned["bare"], "log", "-1", "--format=%s", "main") == "magi: Edit app"


def test_a_pull_that_clashes_means_no_push(cloned):
    ours, other = cloned["ours"], cloned["other"]
    _on(push=True)
    before = _git(cloned["bare"], "rev-parse", "main")
    (other / "app.py").write_text("x = 99  # theirs\n")
    _git(other, "commit", "-qam", "theirs, clashes")
    _git(other, "push", "-q")
    theirs = _git(cloned["bare"], "rev-parse", "main")

    async def go():
        await _apply(ours, ["app.py"], "Edit app")
        return await AC.fire("p")
    last = asyncio.run(go())
    assert last["code"] == "committed", "the commit is still made locally"
    assert last["push"]["ok"] is False and last["push"]["code"] == "pull_failed"
    assert "Not pushed" in last["text"]
    assert _git(cloned["bare"], "rev-parse", "main") == theirs != before
    assert G.in_progress(ours) == "", "the clashing pull was undone"


def test_auto_push_off_commits_but_does_not_push(cloned):
    _on(push=False)
    before = _git(cloned["bare"], "rev-parse", "main")

    async def go():
        await _apply(cloned["ours"], ["app.py"], "Edit app")
        return await AC.fire("p")
    last = asyncio.run(go())
    assert last["ok"] and "push" not in last
    assert _git(cloned["bare"], "rev-parse", "main") == before


def test_an_https_remote_with_no_account_is_not_pushed(cloned):
    ours = cloned["ours"]
    _git(ours, "remote", "set-url", "--push", "origin", "https://github.com/o/r.git")
    _on(push=True)

    async def go():
        await _apply(ours, ["app.py"], "Edit app")
        return await AC.fire("p")
    last = asyncio.run(go())
    assert last["code"] == "committed" and last["push"]["code"] == "no_account"


# ── wired into a real write task ───────────────────────────────────────────

class Editor(CodingAgent):
    kind = "cli"
    id = label = "fake"

    async def run(self, task, *, emit, cancel):
        assert task.mode == Mode.WRITE
        (task.root / "a.py").write_text("a = 2\n")
        return Result(Outcome.OK, text="Changed a.")


def test_an_approved_write_task_schedules_the_commit(repo, tmp_path, monkeypatch):
    monkeypatch.setattr(SB, "BASE", tmp_path / "sandboxes")
    monkeypatch.setattr(SB, "patch_dir", lambda d: tmp_path / "patches")
    monkeypatch.setattr(T, "_profile", lambda: "test")
    monkeypatch.setattr(chain, "expand", lambda order, settings: [Editor()])
    _on()

    async def go():
        t = await T.start(project_id="p", root=repo, prompt="Bump a", order=[],
                          settings=None, mode="write")
        seen = []
        async for ev in T.stream(t):
            seen.append(ev)
            if ev["k"] == "approval":
                T.decide(t, True)
        return t, seen
    t, seen = asyncio.run(go())
    ks = [e["k"] for e in seen]
    assert ks.index("applied") < ks.index("autocommit") < ks.index("end")
    ev = next(e for e in seen if e["k"] == "autocommit")
    assert ev["files"] == ["a.py"] and ev["message"].startswith("magi: Bump a")
    assert t.result["auto"]["files"] == ["a.py"]
    assert _log(repo) == "init", "nothing is committed before the window"
