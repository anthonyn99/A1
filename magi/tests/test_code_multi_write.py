"""Track V3: one write task changes two or more workspaces.

Each workspace gets its own private copy; the card has a section per
workspace; the change goes on whole or not at all (sandbox.apply_all); the
commit and push cover every repository it went to. Real git repositories,
fake agents -- nothing here needs an account.
"""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import pytest

from magi.code import routes as R
from magi.code import sandbox as SB
from magi.code import tasks as T
from magi.code import ws_mcp as W
from magi.code.agents import chain, edits
from magi.code.agents import claude_cli as CC
from magi.code.agents import codex_cli as CX
from magi.code.agents.base import CodingAgent, Mode, Outcome, Result, Task


def _git(cwd, *a):
    r = subprocess.run(["git", "-C", str(cwd), *a], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def _repo(root: Path, files: dict[str, str]) -> Path:
    root.mkdir()
    _git(root, "init", "-q")
    _git(root, "config", "user.name", "t")
    _git(root, "config", "user.email", "t@t")
    _git(root, "config", "core.autocrlf", "false")
    for rel, text in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text)
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "init")
    return root


@pytest.fixture
def two(tmp_path, monkeypatch):
    monkeypatch.setattr(SB, "BASE", tmp_path / "sandboxes")
    monkeypatch.setattr(SB, "patch_dir", lambda d: tmp_path / "patches")
    monkeypatch.setattr(T, "_profile", lambda: "test")
    main = _repo(tmp_path / "main", {"app.py": "x = 1\n"})
    other = _repo(tmp_path / "other", {"lib.py": "y = 1\n", "old.txt": "old\n"})
    return main, other


class Both(CodingAgent):
    """Edits the main copy and @other's copy, the way a CLI would."""
    kind = "cli"

    def __init__(self, main: dict[str, str], other: dict[str, str | None]):
        self.id = self.label = "fake"
        self.main, self.other = main, other
        self.seen: list[Task] = []

    async def run(self, task, *, emit, cancel):
        self.seen.append(task)
        copies = dict(task.writes)
        for rel, text in self.main.items():
            (task.root / rel).write_text(text)
        for rel, text in self.other.items():
            p = copies["other"] / rel
            if text is None:
                p.unlink()
            else:
                p.write_text(text)
        return Result(Outcome.OK, text="done")


async def _run(main, other, agent, *, answer=None, approve="manual", meanwhile=None):
    keep = chain.expand
    chain.expand = lambda order, settings: [agent]
    try:
        part = T.Part(name="other", project_id="p_other", root=str(other))
        t = await T.start(project_id="p_main", root=main, prompt="edit both", order=[],
                          settings=None, mode="write", approve=approve, writes=[part])
        seen = []
        async for ev in T.stream(t):
            seen.append(ev)
            if ev["k"] == "approval":
                assert (main / "app.py").read_text() == "x = 1\n"
                assert (other / "lib.py").read_text() == "y = 1\n"
                if meanwhile:
                    meanwhile()
                if answer is not None:
                    assert T.decide(t, answer) == (True, "")
        return t, seen
    finally:
        chain.expand = keep


def test_one_card_two_sections_applied_together(two):
    main, other = two
    a = Both({"app.py": "x = 2\n"}, {"lib.py": "y = 2\n", "old.txt": None})
    t, seen = asyncio.run(_run(main, other, a, answer=True))
    task = a.seen[0]
    assert task.root != main and dict(task.writes)["other"] != other, "copies, never the folders"
    ap = next(e for e in seen if e["k"] == "approval")
    assert {f["path"] for f in ap["files"]} == {"app.py", "@other/lib.py", "@other/old.txt"}
    assert [s["name"] for s in ap["sections"]] == ["", "other"]
    assert ap["sections"][1]["paths"] == ["@other/lib.py", "@other/old.txt"]
    assert (main / "app.py").read_text() == "x = 2\n"
    assert (other / "lib.py").read_text() == "y = 2\n" and not (other / "old.txt").exists()
    assert t.result["write"] == "applied"
    assert {x["name"] for x in t.result["repos"]} == {"", "other"}
    assert not task.root.exists() and not dict(task.writes)["other"].exists(), "copies removed"
    assert _git(other, "worktree", "list").count("\n") == 0


def test_deny_changes_neither(two):
    main, other = two
    a = Both({"app.py": "x = 2\n"}, {"lib.py": "y = 2\n"})
    t, _ = asyncio.run(_run(main, other, a, answer=False))
    assert t.result["write"] == "denied"
    assert (main / "app.py").read_text() == "x = 1\n" and (other / "lib.py").read_text() == "y = 1\n"


def test_a_conflict_in_one_workspace_applies_nothing_anywhere(two):
    main, other = two
    a = Both({"app.py": "x = 2\n"}, {"lib.py": "y = 2\n"})

    def clash():     # you edit the same line in the other folder meanwhile
        (other / "lib.py").write_text("y = 99\n")
    t, seen = asyncio.run(_run(main, other, a, answer=True, meanwhile=clash))
    assert t.result["write"] == "conflict"
    assert "@other" in next(e for e in seen if e["k"] == "conflict")["text"]
    assert (main / "app.py").read_text() == "x = 1\n", "whole or not at all"


def test_only_the_other_workspace_changed_is_still_one_card(two):
    main, other = two
    a = Both({}, {"lib.py": "y = 3\n"})
    t, seen = asyncio.run(_run(main, other, a, approve="auto"))
    dec = next(e for e in seen if e["k"] == "decision")
    assert dec["why"] == "auto" and [f["path"] for f in dec["files"]] == ["@other/lib.py"]
    assert (other / "lib.py").read_text() == "y = 3\n" and t.result["write"] == "applied"


def test_a_refused_file_in_one_workspace_refuses_the_whole_change(two):
    main, other = two
    a = Both({"app.py": "x = 2\n"}, {".env": "SECRET=1\n"})
    t, seen = asyncio.run(_run(main, other, a, answer=True))
    assert t.result["write"] == "refused" and "approval" not in [e["k"] for e in seen]
    ref = next(e for e in seen if e["k"] == "refused")
    assert ref["text"].startswith("@other:") and ref["refused"][0]["path"] == "@other/.env"
    assert (main / "app.py").read_text() == "x = 1\n"


def test_apply_all_puts_back_what_it_wrote_when_a_later_part_fails(two, monkeypatch):
    main, other = two
    a = Both({"app.py": "x = 2\n"}, {"lib.py": "y = 2\n"})
    real = SB._execute
    calls = []

    def flaky(sb, plan):
        calls.append(sb)
        if len(calls) == 2:
            raise SB.SandboxError("git", "disk full")
        real(sb, plan)
    monkeypatch.setattr(SB, "_execute", flaky)
    t, seen = asyncio.run(_run(main, other, a, answer=True))
    assert len(calls) == 2 and t.result["write"] == "conflict"
    assert "put back" in t.result["detail"]
    assert (main / "app.py").read_text() == "x = 1\n", "the first part was rolled back"
    assert (other / "lib.py").read_text() == "y = 1\n"


def test_commit_covers_every_repository(two, monkeypatch):
    main, other = two
    a = Both({"app.py": "x = 2\n"}, {"lib.py": "y = 2\n"})
    t, _ = asyncio.run(_run(main, other, a, answer=True))
    out = asyncio.run(T.commit(t, "Change both"))
    assert out["ok"] and len(out["commits"]) == 2
    for root in (main, other):
        assert _git(root, "log", "-1", "--format=%s") == "Change both"
        assert _git(root, "status", "--porcelain") == ""
    again = asyncio.run(T.commit(t, "again"))
    assert again["error"] == "already"


# ── each agent is handed the copies, and only the copies ─────────────────

def test_claude_and_codex_get_the_copies_writable_in_write_mode_only(tmp_path):
    copy, ref = tmp_path / "copy", tmp_path / "ref"
    w = Task("t", "q", tmp_path, Mode.WRITE, refs=[("ref", ref)], writes=[("other", copy)])
    c = CC.build_argv("claude", w)
    assert c[c.index("--add-dir") + 1] == str(copy) and str(ref) not in c
    x = CX.build_argv("codex", w)
    assert x[x.index("--add-dir") + 1] == str(copy) and str(ref) not in x
    r = Task("t", "q", tmp_path, Mode.READ, writes=[("other", copy)])
    assert "--add-dir" not in CX.build_argv("codex", r)
    p = w.prompt_for("claude:system", writes_how=CC.writes_how(w))
    assert "OTHER WORKSPACES YOU MAY CHANGE" in p and f"- @other: {copy}" in p


def test_browser_units_edit_another_workspace_by_name(tmp_path):
    root, copy = tmp_path / "main", tmp_path / "copy"
    root.mkdir(), copy.mkdir()
    (copy / "a.py").write_text("v = 1\n")
    blocks = [edits.Edit("@other/a.py", "v = 1", "v = 2"),
              edits.Edit("@other/new.py", "", "n = 1"),
              edits.Edit("@other/a.py", "", "", op="move", to="@other/lib/a.py"),
              edits.Edit("@other/lib/a.py", "", "", op="copy", to="b.py")]
    changed, problems = edits.apply(root, blocks, readonly=("ref",), writable={"other": copy})
    assert problems == []
    assert set(changed) == {"@other/a.py", "@other/new.py", "@other/lib/a.py", "b.py"}
    assert (copy / "lib" / "a.py").read_text() == "v = 2\n" and not (copy / "a.py").exists()
    assert (root / "b.py").read_text() == "v = 2\n"
    assert not (root / "@other").exists(), "never a folder called @other in the project"
    # A reference folder stays read-only, and the rules hold inside the copy.
    _, bad = edits.apply(root, [edits.Edit("@ref/x.py", "", "x")], readonly=("ref",),
                         writable={"other": copy})
    assert bad and "read-only" in bad[0]
    _, bad = edits.apply(root, [edits.Edit("@other/../escape.py", "", "x")],
                         writable={"other": copy})
    assert bad and not (tmp_path / "escape.py").exists()
    _, bad = edits.apply(root, [edits.Edit("@other/.git/config", "", "x")],
                         writable={"other": copy})
    assert bad


def test_claude_workspace_tools_reach_the_other_copy(tmp_path):
    root, copy = tmp_path / "main", tmp_path / "copy"
    root.mkdir(), copy.mkdir()
    (copy / "a.py").write_text("v\n")
    s = W.Server(root, writes=[{"name": "other", "root": str(copy)}])
    txt, err = s.call("move_path", {"from": "@other/a.py", "to": "@other/lib/a.py"})
    assert not err and txt == "Moved @other/a.py to @other/lib/a.py."
    assert (copy / "lib" / "a.py").exists()
    txt, err = s.call("copy_path", {"from": "@other/lib/a.py", "to": "a.py"})
    assert not err and (root / "a.py").exists()
    for bad in ("@other/../x", "@other/.git/x", "@other"):
        assert s.call("delete_path", {"path": bad})[1], bad
    # A copy MAGI did not name is no copy: refused like any absolute path.
    t2 = W.Server(root, writes=[{"name": "ghost", "root": str(tmp_path / "nope")}])
    assert t2.writes == {}


# ── the route: registered ids only, one repository each ──────────────────

class FakeDB:
    def __init__(self, projects):
        self.projects = projects

    async def code_project(self, pid, eng):
        return self.projects.get(pid)


def _proj(pid, name, root, gh=""):
    return {"id": pid, "name": name, "prefs": {"github": gh},
            "bindings": [{"here": True, "root": str(root)}]}


def test_writes_are_registered_repositories_of_their_own(two, monkeypatch):
    main, other = two
    sub = main / "web"
    sub.mkdir()
    db = FakeDB({"p_main": _proj("p_main", "Main", main),
                 "p_other": _proj("p_other", "Other Repo", other, gh="tony"),
                 "p_sub": _proj("p_sub", "Web", sub),
                 "p_plain": _proj("p_plain", "Plain", main.parent)})
    monkeypatch.setattr(R, "_db", lambda: db)
    run = lambda raw: asyncio.run(R._task_writes(raw, "p_main", main, "eng"))
    parts, why = run(["p_other"])
    assert why == "" and [(p.name, p.project_id, p.github) for p in parts] == [
        ("other-repo", "p_other", "tony")]
    assert "same repository" in run(["p_sub"])[1]
    assert run(["p_plain"])[1], "not a git repository"
    assert run([str(other)])[1], "a path is not an id"
    assert run(["p_other"] * (R.MAX_TASK_WRITES + 1))[1]


def test_the_engine_says_it_takes_writes():
    import inspect
    src = inspect.getsource(R.code_state)
    assert '"writes"' in src
    start = inspect.getsource(R.start_task)
    assert 'mode == "write" and raw_writes' in start, "Read mode only reads them"


def test_claude_write_prompt_without_other_workspaces_does_not_crash(tmp_path):
    """Found live in V6: writes_how read task.writes[0] on every Write task,
    so every Claude write task died at once with IndexError."""
    w = Task("t", "q", tmp_path, Mode.WRITE, mcp_servers=(CC.WS_SERVER,))
    assert CC.writes_how(w) == ""
    p = w.prompt_for("claude:system", frame=CC.write_frame(w), refs_how=CC.refs_how(w),
                     writes_how=CC.writes_how(w))
    assert "OTHER WORKSPACES" not in p
