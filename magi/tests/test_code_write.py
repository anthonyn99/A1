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


def test_a_reply_mangled_by_markdown_is_recognised_not_called_no_change():
    """Captured live from ChatGPT before the format required code fences: the
    rendered page ate '=======' and '>>>>>>> REPLACE' and every line break."""
    lossy = ("FILE: calc.py<<<<<<< SEARCHdef total(xs):return sum(xs)"
             "def total(values):return sum(values)REPLACEChanged only total().")
    assert edits.parse(lossy) == []
    assert edits.looks_like_edits(lossy)
    assert not edits.looks_like_edits("total() adds the numbers up.")


def test_the_format_help_demands_code_fences():
    assert "inside a code block" in edits.FORMAT_HELP
    assert "```\nFILE:" in edits.FORMAT_HELP


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


def test_claude_write_env_drops_the_scrub_that_blocks_edits():
    """Found live: with the scrub set, every edit is refused as ungranted.
    Write mode has no shell for the scrub to protect; read mode keeps it."""
    w = claude_cli.env_for_task("system", Task("t", "q", Path("."), Mode.WRITE))
    r = claude_cli.env_for_task("system", Task("t", "q", Path("."), Mode.READ))
    assert "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB" not in w
    assert r.get("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB") == "1"
    assert "ANTHROPIC_API_KEY" not in w, "API keys are still stripped"


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


def test_every_disabled_codex_feature_exists_in_the_installed_cli():
    """MAGI updates the CLI by itself; a renamed feature must be noticed here
    rather than silently leaving the shell on (or failing every task)."""
    import shutil
    import subprocess
    exe = shutil.which("codex") or shutil.which("codex.cmd")
    if not exe:
        pytest.skip("Codex CLI not installed")
    out = subprocess.run([exe, "features", "list"], capture_output=True, text=True,
                         timeout=60, encoding="utf-8", errors="replace").stdout
    known = {ln.split()[0] for ln in out.splitlines() if ln.strip()}
    assert set(codex_cli.DISABLED_FEATURES) <= known, set(codex_cli.DISABLED_FEATURES) - known


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


# ── Phase 9: pull before work, commit after apply ──────────────────────────

@pytest.fixture
def cloned(tmp_path, monkeypatch):
    """Our workspace is a clone of a bare 'origin'; `other` pushes to it."""
    monkeypatch.setattr(SB, "BASE", tmp_path / "sandboxes")
    monkeypatch.setattr(SB, "patch_dir", lambda d: tmp_path / "patches")
    monkeypatch.setattr(T, "_profile", lambda: "test")
    bare = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(bare)], check=True)
    other = tmp_path / "other"
    subprocess.run(["git", "clone", "-q", str(bare), str(other)], capture_output=True)
    for k, v in (("user.name", "t"), ("user.email", "t@t"), ("core.autocrlf", "false")):
        _git(other, "config", k, v)
    _git(other, "symbolic-ref", "HEAD", "refs/heads/main")
    (other / "app.py").write_text("x = 1\n")
    _git(other, "add", "-A")
    _git(other, "commit", "-qm", "init")
    _git(other, "push", "-q", "-u", "origin", "main")
    ours = tmp_path / "ours"
    subprocess.run(["git", "clone", "-q", str(bare), str(ours)], check=True)
    for k, v in (("user.name", "t"), ("user.email", "t@t"), ("core.autocrlf", "false")):
        _git(ours, "config", k, v)
    (other / "pushed.py").write_text("p = 1\n")
    _git(other, "add", "-A")
    _git(other, "commit", "-qm", "pushed from the other machine")
    _git(other, "push", "-q")
    return {"ours": ours, "other": other}


class Reader(CodingAgent):
    kind = "cli"

    def __init__(self):
        self.id = self.label = "reader"
        self.saw: list[bool] = []

    async def run(self, task, *, emit, cancel):
        self.saw.append((task.root / "pushed.py").exists())
        return Result(Outcome.OK, text="read it")


async def _run_mode(root, agents, mode):
    chain_expand = chain.expand
    chain.expand = lambda order, settings: agents
    try:
        t = await T.start(project_id="p", root=root, prompt="look", order=[],
                          settings=None, mode=mode)
        seen = [ev async for ev in T.stream(t)]
        return t, seen
    finally:
        chain.expand = chain_expand


def test_a_read_task_pulls_before_the_agent_looks(cloned):
    a = Reader()
    t, seen = asyncio.run(_run_mode(cloned["ours"], [a], "read"))
    pull = next(e for e in seen if e["k"] == "pull")
    assert pull["ok"] and pull["commits"] == 1
    assert _kinds(seen).index("pull") < _kinds(seen).index("agent")
    assert a.saw == [True], "the agent must see what the other machine pushed"


def test_a_write_task_pulls_then_edits_the_pulled_tree(cloned):
    a = Editor({"app.py": "x = 2\n"})
    t, seen = asyncio.run(_run(cloned["ours"], [a], answer=True))
    assert next(e for e in seen if e["k"] == "pull")["commits"] == 1
    assert t.result["write"] == "applied"
    assert (cloned["ours"] / "pushed.py").exists()


def test_a_pull_that_clashes_stops_the_task_before_any_agent(cloned):
    ours, other = cloned["ours"], cloned["other"]
    (other / "app.py").write_text("x = 'theirs'\n")
    _git(other, "commit", "-qam", "theirs")
    _git(other, "push", "-q")
    (ours / "app.py").write_text("x = 'mine'\n")
    _git(ours, "commit", "-qam", "mine")
    a = Editor({"app.py": "x = 2\n"})
    t, seen = asyncio.run(_run(ours, [a], answer=True))
    assert a.roots == [], "no agent runs on a tree that could not be pulled"
    assert t.result["outcome"] == "pull_failed" and t.result["conflicts"] == ["app.py"]
    assert (ours / "app.py").read_text() == "x = 'mine'\n"
    assert "agent" not in _kinds(seen)


def test_magi_own_repository_is_fetched_never_pulled(cloned, monkeypatch):
    monkeypatch.setattr(SB, "is_engine_repo", lambda root: True)
    a = Reader()
    t, seen = asyncio.run(_run_mode(cloned["ours"], [a], "read"))
    pull = next(e for e in seen if e["k"] == "pull")
    assert pull["skipped"] and "1 commit behind" in pull["text"]
    assert a.saw == [False], "fetched, not pulled: the folder is untouched"


def test_no_remote_is_a_note_not_a_failure(repo):
    t, seen = asyncio.run(_run(repo, [Editor({"app.py": "x = 2\n"})], answer=True))
    pull = next(e for e in seen if e["k"] == "pull")
    assert pull["ok"] and pull["skipped"] and "No remote" in pull["text"]
    assert t.result["write"] == "applied"


def test_commit_after_apply_takes_exactly_the_applied_files(repo):
    (repo / "mine.txt").write_text("my own untracked work\n")
    a = Editor({"app.py": "x = 2\n", "new.py": "y = 1\n"})
    t, seen = asyncio.run(_run(repo, [a], answer=True))
    applied = next(e for e in seen if e["k"] == "applied")
    assert applied["draft"].startswith("Edit")
    r = asyncio.run(T.commit(t, "Apply the edit"))
    assert r["ok"], r
    assert sorted(_git(repo, "show", "--name-only", "--format=", "HEAD").splitlines()) == \
        ["app.py", "new.py"]
    assert "?? mine.txt" in _git(repo, "status", "--porcelain")
    assert t.events[-1]["k"] == "committed"
    again = asyncio.run(T.commit(t, "Twice"))
    assert again["error"] == "already"
    assert _git(repo, "rev-list", "--count", "HEAD") == "2"


def test_a_denied_change_cannot_be_committed(repo):
    t, _ = asyncio.run(_run(repo, [Editor({"app.py": "x = 2\n"})], answer=False))
    r = asyncio.run(T.commit(t, "Sneak it in"))
    assert r["error"] == "not_applied"
    assert _git(repo, "rev-list", "--count", "HEAD") == "1"


# ── Phase 10: push is a third press, as the project's account ─────────────

def test_commit_then_push_sends_exactly_that_commit(cloned):
    ours = cloned["ours"]
    t, seen = asyncio.run(_run(ours, [Editor({"app.py": "x = 2\n"})], answer=True))
    early = asyncio.run(T.push(t))
    assert early["error"] == "not_committed"
    assert asyncio.run(T.commit(t, "Two"))["ok"]
    r = asyncio.run(T.push(t))
    assert r["ok"], r
    assert r["push"]["commits"] == 1 and r["push"]["code"] == "pushed"
    bare = ours.parent / "origin.git"
    assert _git(bare, "rev-parse", "main") == _git(ours, "rev-parse", "HEAD")
    assert t.events[-1]["k"] == "pushed"
    assert asyncio.run(T.push(t))["error"] == "already"


def test_a_refused_push_can_be_tried_again(cloned, monkeypatch):
    ours = cloned["ours"]
    t, _ = asyncio.run(_run(ours, [Editor({"app.py": "x = 2\n"})], answer=True))
    assert asyncio.run(T.commit(t, "Two"))["ok"]
    monkeypatch.setattr(T.G, "push", lambda root, auth: T.G.Push(False, "auth_refused", "no"))
    r = asyncio.run(T.push(t))
    assert not r["ok"] and r["error"] == "auth_refused" and not t.result.get("push")
    monkeypatch.undo()
    assert asyncio.run(T.push(t))["ok"]


def test_the_tasks_pull_and_push_use_the_projects_account(cloned, monkeypatch):
    auth = T.G.Auth(login="octo", service="magi-github:test:octo")
    asked, pulled = [], []
    monkeypatch.setattr(T, "git_auth", lambda login: asked.append(login) or (auth if login else None))
    real_pull = T.G.pull
    monkeypatch.setattr(T.G, "pull", lambda root, a=None: pulled.append(a) or real_pull(root, None))

    async def go():
        chain_expand = chain.expand
        chain.expand = lambda order, settings: [Reader()]
        try:
            t = await T.start(project_id="p", root=cloned["ours"], prompt="look", order=[],
                              settings=None, mode="read", github="octo")
            return [ev async for ev in T.stream(t)]
        finally:
            chain.expand = chain_expand
    asyncio.run(go())
    assert asked == ["octo"] and pulled == [auth]


def test_git_auth_is_none_for_an_unknown_or_blank_login(monkeypatch):
    from magi.github import accounts as A
    monkeypatch.setattr(A, "get", lambda login: None)
    assert T.git_auth("") is None
    assert T.git_auth("nobody") is None
    assert T.git_auth("not a login!") is None
    monkeypatch.setattr(A, "get", lambda login: {"login": login})
    monkeypatch.setattr(A, "_profile", lambda: "tony")
    a = T.git_auth("Octo")
    assert (a.login, a.service, a.host) == ("octo", "magi-github:tony:octo", "github.com")


# ── Phase 14b: A1 is writable, and nothing more ───────────────────────────
# Tony's answers (2026-09-24): write yes; commit, push, pull, auto no -- A1's
# Stop hook commits and pushes. Here `repo` stands in for A1.

def test_the_engine_repo_policy_is_write_only():
    assert SB.ENGINE_REPO == {"write": True, "commit": False, "push": False,
                              "pull": False, "auto": False}


def test_a1_takes_a_write_task_and_leaves_it_for_the_hook(repo, monkeypatch):
    monkeypatch.setattr(SB, "is_engine_repo", lambda root: True)
    (repo / "magi").mkdir()
    a = Editor({"app.py": "x = 2\n", "magi/engine.py": "print(1)\n"})
    t, seen = asyncio.run(_run(repo, [a], answer=True))
    appr = next(e for e in seen if e["k"] == "approval")
    assert appr["engine_files"] == ["magi/engine.py"], "the card says the engine changed"
    applied = next(e for e in seen if e["k"] == "applied")
    assert applied["by_hook"] is True
    assert (repo / "app.py").read_text() == "x = 2\n", "applied like any project"
    r = asyncio.run(T.commit(t, "Commit it anyway"))
    assert r["error"] == "read_only_project" and "auto-commit" in r["message"]
    assert _git(repo, "rev-list", "--count", "HEAD") == "1", "nothing committed"
    t.result["commit"] = {"short": "x"}          # even with a commit on record
    r = asyncio.run(T.push(t))
    assert r["error"] == "read_only_project"


def test_other_projects_are_unchanged(repo):
    t, seen = asyncio.run(_run(repo, [Editor({"app.py": "x = 2\n"})], answer=True))
    assert "by_hook" not in next(e for e in seen if e["k"] == "applied")
    assert "engine_files" not in next(e for e in seen if e["k"] == "approval")
    assert asyncio.run(T.commit(t, "Mine"))["ok"]


def test_the_write_route_and_view_let_a1_in(repo, monkeypatch):
    from magi.code import routes as R
    monkeypatch.setattr(SB, "is_engine_repo", lambda root: True)
    w = R._write_status(str(repo))
    assert w["ok"] and w["commit"] is False and w["push"] is False and "ships" in w["note"]
    monkeypatch.setitem(SB.ENGINE_REPO, "write", False)
    w = R._write_status(str(repo))
    assert not w["ok"] and "read-only" in w["why"]


def test_a1_refuses_github_and_names_what_deploys(repo, monkeypatch):
    """A1 pushes itself within minutes: approving there is shipping. A
    workflow edit (it runs with the repo's secrets) is refused outright; a
    deploying path is named on the card."""
    monkeypatch.setattr(SB, "is_engine_repo", lambda root: True)
    (repo / ".github" / "workflows").mkdir(parents=True)
    t, seen = asyncio.run(_run(repo, [Editor({".github/workflows/x.yml": "on: push\n"})], answer=True))
    ref = next(e for e in seen if e["k"] == "refused")
    assert ref["refused"][0]["path"] == ".github/workflows/x.yml"
    assert "secrets" in ref["refused"][0]["why"]
    assert not (repo / ".github" / "workflows" / "x.yml").exists()

    (repo / "workers" / "api").mkdir(parents=True)
    t, seen = asyncio.run(_run(repo, [Editor({"workers/api/worker.js": "x\n", "app.py": "x = 2\n"})],
                               answer=False))
    appr = next(e for e in seen if e["k"] == "approval")
    assert appr["ships"] is True and appr["deploy_files"] == ["workers/api/worker.js"]


def test_github_is_only_refused_in_a1(repo):
    (repo / ".github").mkdir()
    t, seen = asyncio.run(_run(repo, [Editor({".github/ci.yml": "on: push\n"})], answer=True))
    assert t.result["write"] == "applied"
