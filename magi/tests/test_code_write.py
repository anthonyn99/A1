"""Write mode end to end: an agent edits a copy, you approve, the folder changes.

The agents here are fakes that edit whatever folder they are handed -- which
is the point: the tests prove that folder is the SANDBOX, that nothing reaches
the real one without an Approve, and that every way of not approving (deny,
silence, Halt, a refused diff) leaves it byte-for-byte as it was.
"""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import pytest

from magi.code import sandbox as SB
from magi.code import tasks as T
from magi.code.agents import chain, claude_cli, codex_cli, edits
from magi.code.agents.base import CodingAgent, Mode, Outcome, Result, Task


# ── the browser units' edit format ─────────────────────────────────────────

REPLY = """Here is the fix.

**FILE: src/calc.py**
```python
<<<<<<< SEARCH
def total(xs):
    return sum(xs)
=======
def total(xs):
    return sum(x for x in xs if x is not None)
>>>>>>> REPLACE
```

FILE: `docs/NOTES.md`
<<<<<<< SEARCH
=======
# Notes
>>>>>>> REPLACE

I made total() skip None."""


def test_edit_blocks_parse_through_markdown_decoration():
    got = edits.parse(REPLY)
    assert [(e.path, e.search.splitlines()[:1]) for e in got] == [
        ("src/calc.py", ["def total(xs):"]), ("docs/NOTES.md", [])]


def _proj(tmp_path) -> Path:
    root = tmp_path / "p"
    (root / "src").mkdir(parents=True)
    (root / "src" / "calc.py").write_bytes(b"def total(xs):\r\n    return sum(xs)\r\n")
    return root


def test_edits_apply_and_keep_crlf(tmp_path):
    root = _proj(tmp_path)
    changed, problems = edits.apply(root, edits.parse(REPLY))
    assert problems == []
    assert sorted(changed) == ["docs/NOTES.md", "src/calc.py"]
    assert (root / "src" / "calc.py").read_bytes() == (
        b"def total(xs):\r\n    return sum(x for x in xs if x is not None)\r\n")


def test_trailing_whitespace_lost_by_a_chat_window_still_matches(tmp_path):
    root = _proj(tmp_path)
    (root / "src" / "calc.py").write_text("def total(xs):   \n    return sum(xs)\n")
    blocks = [edits.Edit("src/calc.py", "def total(xs):\n    return sum(xs)", "def total(xs):\n    return 0")]
    changed, problems = edits.apply(root, blocks)
    assert problems == [] and (root / "src" / "calc.py").read_text() == "def total(xs):\n    return 0\n"


@pytest.mark.parametrize("block, why", [
    (edits.Edit("src/calc.py", "not in the file", "x"), "not found"),
    (edits.Edit("../outside.py", "", "x"), "climbs outside"),
    (edits.Edit(".git/config", "", "x"), ".git"),
    (edits.Edit("src/calc.py", "", "x"), "already exists"),
    (edits.Edit("src/missing.py", "a", "b"), "no such file"),
])
def test_one_bad_block_writes_nothing(tmp_path, block, why):
    root = _proj(tmp_path)
    before = (root / "src" / "calc.py").read_bytes()
    good = edits.Edit("src/new.py", "", "print(1)")
    changed, problems = edits.apply(root, [good, block])
    assert changed == [] and why in problems[0]
    assert not (root / "src" / "new.py").exists()
    assert (root / "src" / "calc.py").read_bytes() == before


def test_an_ambiguous_search_is_refused(tmp_path):
    root = _proj(tmp_path)
    (root / "a.py").write_text("x = 1\nx = 1\n")
    _, problems = edits.apply(root, [edits.Edit("a.py", "x = 1", "x = 2")])
    assert "more than once" in problems[0]


# ── the CLIs' write flags ──────────────────────────────────────────────────

def test_claude_write_mode_can_edit_but_not_run_anything():
    argv = claude_cli.build_argv("claude", Task("t", "q", Path("."), Mode.WRITE))
    assert argv[argv.index("--permission-mode") + 1] == "acceptEdits"
    tools = argv[argv.index("--tools") + 1].split(",")
    assert tools == ["Read", "Glob", "Grep", "Edit", "Write"]
    assert "Bash" not in tools
    assert "--restricted" in argv and "--strict-mcp-config" in argv


def test_claude_read_mode_is_unchanged():
    argv = claude_cli.build_argv("claude", Task("t", "q", Path("."), Mode.READ))
    assert argv[argv.index("--permission-mode") + 1] == "plan"
    assert argv[argv.index("--tools") + 1] == "Read,Glob,Grep"


def test_claude_permission_denials_reach_the_transcript():
    line = ('{"type":"system","subtype":"permission_denied","tool_name":"Write",'
            '"message":"C:\\\\x.txt is outside the working directory"}')
    ev = claude_cli.parse_line(line)
    assert ev == {"k": "denied", "name": "Write", "text": "C:\\x.txt is outside the working directory"}


def test_codex_write_mode_is_contained_to_the_worktree():
    argv = codex_cli.build_argv("codex", Task("t", "q", Path("C:/sb"), Mode.WRITE))
    assert argv[argv.index("--sandbox") + 1] == "workspace-write"
    cfg = [argv[i + 1] for i, a in enumerate(argv) if a == "-c"]
    assert "windows.sandbox=unelevated" in cfg, "without it, workspace-write is read-only on Windows"
    assert "sandbox_workspace_write.exclude_tmpdir_env_var=true" in cfg
    assert "sandbox_workspace_write.network_access=false" in cfg
    assert argv[argv.index("-C") + 1] == str(Path("C:/sb"))


def test_codex_network_features_are_off_in_every_mode():
    for mode in (Mode.READ, Mode.WRITE):
        argv = codex_cli.build_argv("codex", Task("t", "q", Path("."), mode))
        off = {argv[i + 1] for i, a in enumerate(argv) if a == "--disable"}
        assert {"browser_use", "computer_use", "apps", "plugins", "hooks"} <= off
    read = codex_cli.build_argv("codex", Task("t", "q", Path("."), Mode.READ))
    assert "-c" not in read


def test_write_prompt_tells_the_agent_it_is_reviewed():
    t = Task("t", "Rename foo to bar.", Path("."), Mode.WRITE, handoff_note="Earlier: X")
    p = t.full_prompt()
    assert p.index("private copy") < p.index("Earlier: X") < p.index("Rename foo")
    assert Task("t", "q", Path("."), Mode.READ).full_prompt() == "q"


# ── the task runner, with fake agents ──────────────────────────────────────

def _git(cwd, *a):
    r = subprocess.run(["git", "-C", str(cwd), *a], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


@pytest.fixture
def repo(tmp_path, monkeypatch):
    monkeypatch.setattr(SB, "BASE", tmp_path / "sandboxes")
    monkeypatch.setattr(SB, "patch_dir", lambda d: tmp_path / "patches")
    monkeypatch.setattr(T, "_profile", lambda: "test")
    r = tmp_path / "proj"
    r.mkdir()
    _git(r, "init", "-q")
    _git(r, "config", "user.name", "t")
    _git(r, "config", "user.email", "t@t")
    _git(r, "config", "core.autocrlf", "false")
    (r / "app.py").write_text("x = 1\n")
    _git(r, "add", "-A")
    _git(r, "commit", "-qm", "init")
    return r


class Editor(CodingAgent):
    """Writes files into whatever root it is given, then reports."""
    kind = "cli"

    def __init__(self, writes: dict[str, str], outcome=Outcome.OK, aid="fake"):
        self.id, self.label = aid, aid
        self.writes, self.outcome = writes, outcome
        self.roots: list[Path] = []
        self.notes: list[str] = []

    async def run(self, task, *, emit, cancel):
        self.roots.append(task.root)
        self.notes.append(task.handoff_note)
        assert task.mode == Mode.WRITE
        for rel, text in self.writes.items():
            p = task.root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text)
        return Result(self.outcome, text="done", detail="limit" if self.outcome != Outcome.OK else "")


async def _run(repo, agents, answer=None, *, halt_at_approval=False):
    chain_expand = chain.expand
    chain.expand = lambda order, settings: agents
    try:
        t = await T.start(project_id="p", root=repo, prompt="edit", order=[],
                          settings=None, mode="write")
        seen = []
        async for ev in T.stream(t):
            seen.append(ev)
            if ev["k"] == "approval":
                assert not (repo / "app.py").read_text().startswith("x = 2"), \
                    "nothing may change before the approval"
                if halt_at_approval:
                    t.cancel.set()
                elif answer is not None:
                    assert T.decide(t, answer) == (True, "")
                    assert T.decide(t, not answer) == (False, "Already answered.")
        return t, seen
    finally:
        chain.expand = chain_expand


def _kinds(seen):
    return [e["k"] for e in seen]


def test_approve_applies_to_the_real_folder(repo):
    a = Editor({"app.py": "x = 2\n", "new.py": "y = 1\n"})
    t, seen = asyncio.run(_run(repo, [a], answer=True))
    assert a.roots[0] != repo, "the agent must never be handed the real folder"
    ap = next(e for e in seen if e["k"] == "approval")
    assert {f["path"] for f in ap["files"]} == {"app.py", "new.py"}
    assert (repo / "app.py").read_text() == "x = 2\n"
    assert (repo / "new.py").read_text() == "y = 1\n"
    assert t.result["write"] == "applied"
    assert not a.roots[0].exists(), "the sandbox is removed afterwards"
    assert _git(repo, "worktree", "list").count("\n") == 0


def test_deny_leaves_the_folder_untouched(repo):
    a = Editor({"app.py": "x = 2\n"})
    t, seen = asyncio.run(_run(repo, [a], answer=False))
    assert (repo / "app.py").read_text() == "x = 1\n"
    assert t.result["write"] == "denied"
    assert {"k": "decision", "approved": False, "why": "denied"}.items() <= \
        next(e for e in seen if e["k"] == "decision").items()
    assert not a.roots[0].exists()


def test_silence_is_a_no(repo, monkeypatch):
    monkeypatch.setattr(T, "APPROVAL_TIMEOUT", 0.3)
    a = Editor({"app.py": "x = 2\n"})
    t, seen = asyncio.run(_run(repo, [a], answer=None))
    assert (repo / "app.py").read_text() == "x = 1\n"
    assert t.result["write"] == "timeout"


def test_halt_while_waiting_is_a_no(repo):
    a = Editor({"app.py": "x = 2\n"})
    t, seen = asyncio.run(_run(repo, [a], halt_at_approval=True))
    assert (repo / "app.py").read_text() == "x = 1\n"
    assert t.result["write"] == "halted"


def test_a_refused_diff_never_asks(repo):
    a = Editor({"app.py": "x = 2\n", ".env": "TOKEN=1\n"})
    t, seen = asyncio.run(_run(repo, [a], answer=True))
    assert "approval" not in _kinds(seen)
    assert "refused" in _kinds(seen)
    assert (repo / "app.py").read_text() == "x = 1\n"
    assert not (repo / ".env").exists()
    assert t.result["write"] == "refused"


def test_no_changes_means_nothing_to_approve(repo):
    t, seen = asyncio.run(_run(repo, [Editor({})], answer=True))
    assert "approval" not in _kinds(seen) and "nochange" in _kinds(seen)
    assert t.result["write"] == "none"


def test_a_handoff_continues_in_the_same_copy(repo):
    """Claude hits its limit halfway; Codex picks up in the SAME sandbox,
    sees the first edit on disk, and is told which files it already has."""
    first = Editor({"app.py": "x = 2\n"}, outcome=Outcome.LIMITED, aid="claude")
    second = Editor({"more.py": "z = 3\n"}, aid="codex")
    t, seen = asyncio.run(_run(repo, [first, second], answer=True))
    assert first.roots[0] == second.roots[0]
    assert "app.py" in second.notes[0]
    assert (repo / "app.py").read_text() == "x = 2\n"
    assert (repo / "more.py").read_text() == "z = 3\n"


def test_a_task_that_fails_discards_its_edits(repo):
    a = Editor({"app.py": "x = 2\n"}, outcome=Outcome.TASK_FAILED)
    t, seen = asyncio.run(_run(repo, [a], answer=True))
    assert "approval" not in _kinds(seen)
    assert (repo / "app.py").read_text() == "x = 1\n"
    assert t.result["write"] == "discarded"


def test_a_folder_that_is_not_a_repo_is_refused_cleanly(tmp_path, monkeypatch):
    monkeypatch.setattr(SB, "BASE", tmp_path / "sandboxes")
    monkeypatch.setattr(T, "_profile", lambda: "test")
    plain = tmp_path / "plain"
    plain.mkdir()
    a = Editor({"x.py": "1\n"})
    t, seen = asyncio.run(_run(plain, [a], answer=True))
    assert a.roots == [], "no agent runs without a sandbox"
    assert "git init" in t.result["detail"]
    assert not (plain / "x.py").exists()


def test_decide_without_a_pending_approval():
    t = T.TaskState(id="x", project_id="p", prompt="q", mode="write")
    assert T.decide(t, True) == (False, "This task is not waiting for an approval.")
