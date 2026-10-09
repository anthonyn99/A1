"""Track V: every agent can move, copy, delete and search -- and run the
project's check when you let it.

* Claude: the workspace MCP server (code/ws_mcp.py), write mode only,
  confined to the task's private copy by the server itself.
* Browser units: DELETE / MOVE / COPY blocks (agents/edits.py), and FIND
  requests answered from the whole project (agents/context.py).
* The copy is cleaned of links before anything walks or deletes it
  (sandbox.drop_links): a junction to your real node_modules must never be
  followed by a recursive delete.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from magi.code import check as C
from magi.code import sandbox as SB
from magi.code import tasks as T
from magi.code import ws_mcp as W
from magi.code.agents import chain, claude_cli, context, edits
from magi.code.agents.base import CodingAgent, Mode, Outcome, Result, Task

WIN = sys.platform == "win32"


def _junction(link: Path, target: Path) -> None:
    if WIN:
        r = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)],
                           capture_output=True)
        assert r.returncode == 0, r.stderr
    else:
        os.symlink(target, link, target_is_directory=True)


@pytest.fixture
def ws(tmp_path):
    root = tmp_path / "copy"
    (root / "src" / "lib").mkdir(parents=True)
    (root / "src" / "a.py").write_text("a = 1\n")
    (root / "src" / "lib" / "b.py").write_text("b = 2\n")
    (root / "README.md").write_text("hello\n")
    (root / ".git").write_text("gitdir: elsewhere\n")      # a worktree's .git FILE
    return root


# ── ws_mcp: where it may go ────────────────────────────────────────────────

@pytest.mark.parametrize("bad, why", [
    ("", "required"),
    (".", "project folder itself"),
    ("./", "project folder itself"),
    ("../x", "'..'"),
    ("src/../../x", "'..'"),
    ("C:/Windows/x", "relative"),
    ("/etc/passwd", "relative"),
    (".git", ".git/"),
    (".GIT/config", ".GIT/"),
    ("src/.claude/settings.json", ".claude/"),
    (".codex/config.toml", ".codex/"),
    ("nul.txt", "not a valid Windows file name"),
    ("ab:stream", "not a valid Windows file name"),
    ("a:stream", "relative"),
    ("x\x00y", "not a usable path"),
    (42, "required"),
])
def test_paths_outside_the_copy_or_into_denied_folders_are_refused(ws, bad, why):
    with pytest.raises(W.ToolError) as e:
        W.resolve(ws, bad)
    assert why in str(e.value)


def test_a_path_through_a_junction_is_refused_and_the_target_is_untouched(ws, tmp_path):
    outside = tmp_path / "real_node_modules"
    outside.mkdir()
    (outside / "keep.js").write_text("keep\n")
    _junction(ws / "node_modules", outside)
    s = W.Server(ws)
    for name, args in [("delete_path", {"path": "node_modules"}),
                       ("delete_path", {"path": "node_modules/keep.js"}),
                       ("move_path", {"from": "node_modules/keep.js", "to": "k.js"}),
                       ("copy_path", {"from": "README.md", "to": "node_modules/x.md"})]:
        text, err = s.call(name, args)
        assert err and "link" in text, (name, text)
    # A folder HOLDING the junction is refused whole, not walked into.
    (ws / "deps").mkdir()
    _junction(ws / "deps" / "inner", outside)
    text, err = s.call("delete_path", {"path": "deps"})
    assert err and "link" in text
    text, err = s.call("copy_path", {"from": "deps", "to": "deps2"})
    assert err and "link" in text
    assert (outside / "keep.js").read_text() == "keep\n"


def test_a_short_name_for_git_is_refused_by_its_resolved_name(ws):
    short = None
    if WIN:
        r = subprocess.run(["cmd.exe", "/d", "/c", "dir", "/x", "/a", str(ws)],
                           capture_output=True, text=True)
        for ln in r.stdout.splitlines():
            if ln.rstrip().endswith(" .git"):
                bits = ln.split()
                if len(bits) >= 2 and "~" in bits[-2]:
                    short = bits[-2]
    if not short:
        pytest.skip("8.3 short names are off on this volume")
    with pytest.raises(W.ToolError) as e:
        W.resolve(ws, short)
    assert ".git" in str(e.value)


# ── ws_mcp: what it does ───────────────────────────────────────────────────

def test_move_copy_delete_and_make_dir(ws):
    s = W.Server(ws)
    assert s.call("move_path", {"from": "src/a.py", "to": "pkg/a2.py"}) == \
        ("Moved src/a.py to pkg/a2.py.", False)
    assert not (ws / "src" / "a.py").exists() and (ws / "pkg" / "a2.py").read_text() == "a = 1\n"
    text, err = s.call("copy_path", {"from": "src", "to": "src_copy"})
    assert not err and (ws / "src_copy" / "lib" / "b.py").read_text() == "b = 2\n"
    text, err = s.call("delete_path", {"path": "src_copy"})
    assert not err and "1 files" in text and not (ws / "src_copy").exists()
    assert s.call("delete_path", {"path": "README.md"}) == ("Deleted README.md.", False)
    assert s.call("make_dir", {"path": "new/deep"})[1] is False and (ws / "new" / "deep").is_dir()
    text, err = s.call("move_path", {"from": "src\\lib", "to": "lib"})     # backslashes too
    assert not err and (ws / "lib" / "b.py").exists()


def test_it_never_overwrites_or_nests_a_folder_in_itself(ws):
    s = W.Server(ws)
    text, err = s.call("move_path", {"from": "src/a.py", "to": "README.md"})
    assert err and "already exists" in text and (ws / "README.md").read_text() == "hello\n"
    text, err = s.call("copy_path", {"from": "src/a.py", "to": "README.md"})
    assert err and "already exists" in text
    text, err = s.call("move_path", {"from": "src", "to": "src/inner"})
    assert err and "into itself" in text and (ws / "src" / "a.py").exists()
    text, err = s.call("copy_path", {"from": "src", "to": "src/inner"})
    assert err and "into itself" in text
    text, err = s.call("delete_path", {"path": "nope.txt"})
    assert err and "no such" in text
    text, err = s.call("make_dir", {"path": "README.md"})
    assert err and "file of that name" in text


def test_the_worktrees_git_file_cannot_be_touched(ws):
    s = W.Server(ws)
    for name, args in [("delete_path", {"path": ".git"}),
                       ("move_path", {"from": ".git", "to": "g"}),
                       ("copy_path", {"from": "README.md", "to": ".git/x"})]:
        assert s.call(name, args)[1] is True
    assert (ws / ".git").read_text() == "gitdir: elsewhere\n"


def test_tools_list_offers_run_check_only_when_allowed(ws):
    names = [t["name"] for t in W.Server(ws).tools()]
    assert names == ["move_path", "copy_path", "delete_path", "make_dir"]
    text, err = W.Server(ws).call("run_check", {})
    assert err and "Unknown tool" in text
    s = W.Server(ws, {"command": "echo hi", "timeout_min": 1})
    tools = {t["name"]: t for t in s.tools()}
    assert "run_check" in tools and "`echo hi`" in tools["run_check"]["description"]
    # The tool takes no arguments: the agent can ask for THE check, never name a command.
    assert tools["run_check"]["inputSchema"]["properties"] == {}


def test_run_check_runs_your_command_with_deps_linked_then_unlinked(ws, tmp_path):
    real = tmp_path / "real"
    (real / "node_modules").mkdir(parents=True)
    (real / "node_modules" / "dep.js").write_text("dep\n")
    script = ws / "t.py"
    script.write_text("import os, sys\n"
                      "print('dep there' if os.path.exists('node_modules/dep.js') else 'no dep')\n"
                      "sys.exit(3)\n")
    py = sys.executable
    s = W.Server(ws, {"command": f'"{py}" t.py', "timeout_min": 1}, real)
    text, err = s.call("run_check", {"ignored": "rm -rf /"})
    assert not err
    assert "FAILED (exit 3)" in text and "dep there" in text
    assert not os.path.lexists(ws / "node_modules"), "the link is removed after the run"
    assert (real / "node_modules" / "dep.js").exists()
    script.write_text("print('ok')\n")
    text, _ = s.call("run_check", {})
    assert "PASSED" in text and "ok" in text


def test_run_check_stops_at_its_limit(ws, monkeypatch):
    monkeypatch.setattr(W, "MAX_RUN_S", 1)
    (ws / "slow.py").write_text("import time\ntime.sleep(30)\n")
    s = W.Server(ws, {"command": f'"{sys.executable}" slow.py', "timeout_min": 10})
    text, err = s.call("run_check", {})
    assert not err and "stopped" in text


def test_run_check_keeps_secrets_and_magis_token_out_of_the_env(ws, monkeypatch):
    monkeypatch.setenv("MAGI_API_TOKEN", "t0k")
    monkeypatch.setenv("SOME_API_KEY", "k3y")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "c1")
    (ws / "env.py").write_text("import os\nprint(sorted(k for k in os.environ if k in "
                               "('MAGI_API_TOKEN','SOME_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','CI')))\n")
    s = W.Server(ws, {"command": f'"{sys.executable}" env.py', "timeout_min": 1})
    text, _ = s.call("run_check", {})
    assert "['CI']" in text


def test_it_speaks_mcp_over_stdio_as_python_minus_I(ws, tmp_path):
    """Run for real, as the CLI starts it: `python -I` (nothing from the
    workspace importable), config from a file."""
    cfg = tmp_path / "ws.json"
    cfg.write_text(json.dumps({"root": str(ws), "real": None, "check": None}))
    msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
             "params": {"name": "move_path", "arguments": {"from": "README.md", "to": "docs/R.md"}}},
            {"jsonrpc": "2.0", "id": 4, "method": "nope"}]
    r = subprocess.run([sys.executable, "-I", str(Path(W.__file__)), "--config", str(cfg)],
                       input="\n".join(json.dumps(m) for m in msgs) + "\n",
                       capture_output=True, text=True, encoding="utf-8", timeout=60)
    out = [json.loads(ln) for ln in r.stdout.splitlines() if ln.strip()]
    assert [o["id"] for o in out] == [1, 2, 3, 4], r.stderr
    assert out[0]["result"]["serverInfo"]["name"] == "magi-workspace"
    assert len(out[1]["result"]["tools"]) == 4
    assert out[2]["result"]["isError"] is False and (ws / "docs" / "R.md").exists()
    assert out[3]["error"]["code"] == -32601


def test_the_deny_list_matches_security_and_the_dep_dirs_match_check():
    from magi.code import security
    assert W.DENY_DIRS == set(security._DENY_DIRS)
    assert W.DEP_DIRS == C.DEP_DIRS == SB.DEP_LINK_NAMES


# ── wiring: the config, the argv, the frame, the transcript ───────────────

def test_write_mcp_config_names_the_workspace_server_and_its_own_file(tmp_path, monkeypatch):
    monkeypatch.setattr(T, "_mcp_path", lambda tid: tmp_path / "mcp" / f"{tid}.json")
    assert T.write_mcp_config("t1", "p", tmp_path, "") is None
    ws = {"root": str(tmp_path / "copy"), "real": str(tmp_path / "real"),
          "check": {"command": "npm test", "timeout_min": 5}}
    f = T.write_mcp_config("t1", "p", tmp_path, "", workspace=ws)
    cfg = json.loads(f.read_text())
    srv = cfg["mcpServers"]["magi_workspace"]
    assert srv["args"][0] == "-I" and srv["args"][1].endswith("ws_mcp.py")
    side = Path(srv["args"][srv["args"].index("--config") + 1])
    assert side == T._ws_path("t1") and json.loads(side.read_text()) == ws
    assert T.mcp_servers_in(f) == ("magi_workspace",)
    assert T.mcp_servers_in(None) == () and T.mcp_servers_in(tmp_path / "nope.json") == ()


def test_claude_allows_every_server_in_the_config_by_name(tmp_path):
    t = Task("t", "q", tmp_path, Mode.WRITE, mcp_config=tmp_path / "c.json",
             mcp_servers=("magi_github", "magi_workspace"))
    argv = claude_cli.build_argv("claude", t)
    assert argv[argv.index("--allowedTools") + 1] == "mcp__magi_github,mcp__magi_workspace"
    # Still no shell, still the exact file-tool list.
    assert argv[argv.index("--tools") + 1] == claude_cli.WRITE_TOOLS
    assert "Bash" not in " ".join(argv)


def test_the_write_frame_says_what_claude_can_do_and_nothing_more(tmp_path):
    plain = Task("t", "q", tmp_path, Mode.WRITE)
    assert claude_cli.write_frame(plain) is None
    assert claude_cli.write_frame(Task("t", "q", tmp_path, Mode.READ,
                                       mcp_servers=("magi_workspace",))) is None
    tools = Task("t", "q", tmp_path, Mode.WRITE, mcp_servers=("magi_workspace",))
    f = claude_cli.write_frame(tools)
    assert "move_path" in f and "delete_path" in f and "run_check" not in f
    assert "do not claim to have run any" in f
    both = Task("t", "q", tmp_path, Mode.WRITE, mcp_servers=("magi_workspace",),
                agent_check="npm test")
    f = claude_cli.write_frame(both)
    assert "run_check" in f and "`npm test`" in f and "only command you can run" in f
    assert both.prompt_for("claude:system", frame=f).startswith(f)
    # Codex and the browser units keep the plain frame.
    assert both.prompt_for("codex:codex1").startswith("You are working in a private copy")
    assert "magi_workspace" not in both.prompt_for("codex:codex1")


def test_workspace_tool_calls_read_as_plain_words_in_the_transcript():
    line = json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "mcp__magi_workspace__move_path",
         "input": {"from": "a.py", "to": "b/a.py"}},
        {"type": "tool_use", "name": "mcp__magi_workspace__run_check", "input": {}},
        {"type": "tool_use", "name": "mcp__magi_github__github_issue", "input": {"number": 3}}]}})
    ev = claude_cli.parse_line(line)["events"]
    assert ev[0] == {"k": "tool", "name": "Move", "target": "a.py → b/a.py"}
    assert ev[1]["name"] == "Run check"
    assert ev[2]["name"] == "mcp__magi_github__github_issue"


# ── a whole write task, the agent using the tools ─────────────────────────

def _git(cwd, *a):
    r = subprocess.run(["git", "-C", str(cwd), *a], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


@pytest.fixture
def repo(tmp_path, monkeypatch):
    monkeypatch.setattr(SB, "BASE", tmp_path / "sandboxes")
    monkeypatch.setattr(SB, "patch_dir", lambda d: tmp_path / "patches")
    monkeypatch.setattr(T, "_profile", lambda: "test")
    monkeypatch.setattr(T, "_mcp_path", lambda tid: tmp_path / "mcp" / f"{tid}.json")
    r = tmp_path / "proj"
    (r / "old").mkdir(parents=True)
    _git(r, "init", "-q")
    _git(r, "config", "user.name", "t")
    _git(r, "config", "user.email", "t@t")
    _git(r, "config", "core.autocrlf", "false")
    (r / "old" / "util.py").write_text("u = 1\n")
    (r / "dead.py").write_text("d = 0\n")
    _git(r, "add", "-A")
    _git(r, "commit", "-qm", "init")
    return r


class ToolUser(CodingAgent):
    """Does what Claude would: calls the workspace server MAGI configured."""
    kind = "cli"
    id = label = "claude:system"

    def __init__(self, calls):
        self.calls = calls
        self.seen: dict = {}

    async def run(self, task, *, emit, cancel):
        cfg = json.loads(task.mcp_config.read_text())
        side = cfg["mcpServers"]["magi_workspace"]["args"][-1]
        self.seen = {"servers": task.mcp_servers, "check": task.agent_check,
                     "side": json.loads(Path(side).read_text()), "root": task.root,
                     "side_path": Path(side), "cfg_path": task.mcp_config}
        srv = W.from_config(Path(side))
        for name, args in self.calls:
            text, err = srv.call(name, args)
            assert not err, text
        return Result(Outcome.OK, text="done")


async def _run(repo, agent, check=None):
    expand = chain.expand
    chain.expand = lambda order, settings: [agent]
    try:
        t = await T.start(project_id="p", root=repo, prompt="tidy up", order=[],
                          settings=None, mode="write", check=check)
        seen = []
        async for ev in T.stream(t):
            seen.append(ev)
            if ev["k"] == "approval":
                assert (repo / "dead.py").exists(), "nothing changes before approval"
                T.decide(t, True)
        return t, seen
    finally:
        chain.expand = expand


def test_a_write_task_moves_and_deletes_through_the_copy_then_your_approval(repo):
    a = ToolUser([("move_path", {"from": "old/util.py", "to": "lib/util.py"}),
                  ("delete_path", {"path": "dead.py"})])
    t, seen = asyncio.run(_run(repo, a))
    assert a.seen["root"] != repo, "the tools serve the copy, never your folder"
    assert Path(a.seen["side"]["root"]) == a.seen["root"]
    assert a.seen["servers"] == ("magi_workspace",) and a.seen["check"] == ""
    ap = next(e for e in seen if e["k"] == "approval")
    assert {(f["path"], f["status"]) for f in ap["files"]} == {
        ("old/util.py", "deleted"), ("lib/util.py", "added"), ("dead.py", "deleted")}
    assert t.result["write"] == "applied"
    assert (repo / "lib" / "util.py").read_text() == "u = 1\n"
    assert not (repo / "old" / "util.py").exists() and not (repo / "dead.py").exists()
    # Both config files go when the task ends.
    assert not a.seen["side_path"].exists() and not a.seen["cfg_path"].exists()


def test_the_check_reaches_the_tools_only_when_agents_may_run_it(repo):
    a = ToolUser([])
    asyncio.run(_run(repo, a, check={"command": "npm test", "timeout_min": 5}))
    assert a.seen["side"]["check"] is None and a.seen["check"] == ""
    b = ToolUser([])
    asyncio.run(_run(repo, b, check={"command": "npm test", "timeout_min": 5, "agents": True}))
    assert b.seen["side"]["check"] == {"command": "npm test", "timeout_min": 5}
    assert b.seen["check"] == "npm test"
    assert b.seen["side"]["real"] == str(repo)


def test_read_mode_has_no_workspace_tools(repo, monkeypatch):
    # Without the agents' shell (Track W2 gives read mode a shell-only
    # server, on a PC that has one): nothing else reaches read mode.
    from magi.code import shell as SH
    monkeypatch.setattr(SH, "get", lambda pid: {"enabled": False, "internet": False})
    got = {}

    class Reader(CodingAgent):
        kind = "cli"
        id = label = "claude:system"

        async def run(self, task, *, emit, cancel):
            got["cfg"], got["servers"] = task.mcp_config, task.mcp_servers
            return Result(Outcome.OK, text="read")
    expand = chain.expand
    chain.expand = lambda order, settings: [Reader()]

    async def go():
        t = await T.start(project_id="p", root=repo, prompt="look", order=[],
                          settings=None, mode="read")
        async for _ in T.stream(t):
            pass
    try:
        asyncio.run(go())
    finally:
        chain.expand = expand
    assert got == {"cfg": None, "servers": ()}


# ── sandbox: links out before anything walks the copy ─────────────────────

def test_drop_links_removes_the_link_never_its_target(tmp_path):
    real = tmp_path / "real_nm"
    real.mkdir()
    (real / "x.js").write_text("x\n")
    top = tmp_path / "copy"
    (top / "deep" / "er").mkdir(parents=True)
    _junction(top / "node_modules", real)
    _junction(top / "deep" / "er" / "link", real)
    # names= only takes the dependency links at the top.
    assert [Path(p).name for p in SB.drop_links(top, names=SB.DEP_LINK_NAMES)] == ["node_modules"]
    assert os.path.lexists(top / "deep" / "er" / "link")
    got = SB.drop_links(top)
    assert [Path(p).name for p in got] == ["link"]
    assert (real / "x.js").read_text() == "x\n"
    assert (top / "deep" / "er").is_dir()


def test_removing_a_sandbox_with_a_left_over_junction_keeps_the_real_folder(repo, tmp_path):
    (repo / ".gitignore").write_text("node_modules/\n")
    _git(repo, "add", ".gitignore")
    _git(repo, "commit", "-qm", "ignore deps")
    real_nm = repo / "node_modules"
    real_nm.mkdir()
    (real_nm / "pkg.js").write_text("pkg\n")
    sb = SB.create(repo, "tjunc", "test")
    assert not os.path.lexists(sb.cwd / "node_modules"), "ignored folders are not copied"
    try:
        _junction(sb.cwd / "node_modules", real_nm)      # a killed run_check left it
        assert sb.snapshot() == sb.base_tree, "the link is not part of the change"
        _junction(sb.cwd / "node_modules", real_nm)
    finally:
        sb.remove()
    assert not sb.path.exists()
    assert (real_nm / "pkg.js").read_text() == "pkg\n"


# ── browser units: DELETE / MOVE / COPY ───────────────────────────────────

OPS = """Cleaning up.

```
MOVE: old/util.py -> lib/util.py
DELETE: dead.py
```

```
FILE: lib/util.py
<<<<<<< SEARCH
u = 1
=======
u = 2
>>>>>>> REPLACE
```

```
COPY: lib -> lib_backup
```

MOVE: README.md -> gone.md
DELETE: lib
(those two lines are prose, outside a code block: never acted on)"""


def test_ops_parse_only_inside_code_blocks_in_order():
    got = edits.parse(OPS)
    assert [(e.op, e.path, e.to) for e in got] == [
        ("move", "old/util.py", "lib/util.py"), ("delete", "dead.py", ""),
        ("edit", "lib/util.py", ""), ("copy", "lib", "lib_backup")]
    assert edits.parse("```\nRENAME: `a.py` → `b.py`\n```")[0].to == "b.py"
    assert edits.parse("```\nMOVE: a.py\n```") == []         # no destination


def _tree(root):
    return {p.relative_to(root).as_posix(): p.read_text() for p in root.rglob("*") if p.is_file()}


def test_ops_apply_in_order_against_the_folder_they_leave(tmp_path):
    root = tmp_path / "p"
    (root / "old").mkdir(parents=True)
    (root / "old" / "util.py").write_text("u = 1\n")
    (root / "dead.py").write_text("d\n")
    (root / "README.md").write_text("r\n")
    changed, problems = edits.apply(root, edits.parse(OPS))
    assert problems == []
    assert _tree(root) == {"lib/util.py": "u = 2\n", "lib_backup/util.py": "u = 2\n",
                           "README.md": "r\n"}
    assert not (root / "old").exists(), "a folder a move emptied is not left behind"
    assert set(changed) == {"old/util.py", "lib/util.py", "dead.py", "lib_backup/util.py"}


@pytest.mark.parametrize("block, why", [
    (edits.Edit("dead.py", op="move", to="README.md"), "already exists"),
    (edits.Edit("dead.py", op="copy", to="../x.py"), "climbs outside"),
    (edits.Edit("old", op="move", to="old/inner"), "inside itself"),
    (edits.Edit("nope.py", op="delete"), "no such file or folder"),
    (edits.Edit(".", op="delete"), "project folder itself"),
    (edits.Edit("./", op="delete"), "project folder itself"),
    (edits.Edit(".git", op="delete"), ".git"),
    (edits.Edit("dead.py", op="move", to=".claude/settings.json"), ".claude"),
    (edits.Edit("dead.py", op="delete"), None),     # fine alone; the edit after it is not
])
def test_one_bad_op_writes_nothing(tmp_path, block, why):
    root = tmp_path / "p"
    (root / "old").mkdir(parents=True)
    (root / "old" / "util.py").write_text("u = 1\n")
    (root / "dead.py").write_text("d\n")
    (root / "README.md").write_text("r\n")
    before = _tree(root)
    blocks = [edits.Edit("new.py", "", "n = 1"), block]
    if why is None:
        blocks.append(edits.Edit("dead.py", "d", "e"))      # edits a file just deleted
        why = "no such file"
    changed, problems = edits.apply(root, blocks)
    assert changed == [] and why in " ".join(problems), problems
    assert _tree(root) == before


def test_an_op_on_a_folder_holding_a_link_is_refused(tmp_path):
    root = tmp_path / "p"
    (root / "deps").mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("k\n")
    _junction(root / "deps" / "inner", outside)
    for op in ("delete", "move", "copy"):
        _, problems = edits.apply(root, [edits.Edit("deps", op=op, to="" if op == "delete" else "d2")])
        assert problems and "link" in problems[0], (op, problems)
    assert (outside / "keep.txt").read_text() == "k\n"


def test_a_binary_file_can_be_moved_byte_for_byte(tmp_path):
    root = tmp_path / "p"
    root.mkdir()
    blob = bytes(range(256)) * 4
    (root / "img.png").write_bytes(blob)
    changed, problems = edits.apply(root, [edits.Edit("img.png", op="move", to="assets/img.png")])
    assert problems == [] and (root / "assets" / "img.png").read_bytes() == blob


def test_the_format_help_teaches_the_ops():
    for w in ("DELETE: ", "MOVE: old/path -> new/path", "COPY: ", "never overwrites"):
        assert w in edits.FORMAT_HELP


# ── browser units: FIND ────────────────────────────────────────────────────

def test_find_requests_parse_beside_need():
    got = context.parse_needs("NEED: src/a.py\nFIND: def total\n- FIND: `/tot(al)?\\(/`")
    assert got == ["src/a.py", "FIND:def total", "FIND:/tot(al)?\\(/"]
    assert context.parse_needs("FIND: x\n" + "word " * 200) is None    # an answer, not a request


def test_find_searches_every_text_file_and_skips_secrets(tmp_path):
    root = tmp_path / "p"
    (root / "src").mkdir(parents=True)
    (root / "src" / "a.py").write_text("def total(xs):\n    return sum(xs)\n")
    (root / "src" / "b.js").write_text("// TOTAL is computed elsewhere\n")
    (root / ".env").write_text("TOTAL_SECRET=1\n")
    (root / "secrets.json").write_text('{"total": "hunter2"}\n')
    files = context.listing(root)
    assert "secrets.json" not in files
    # find() refuses secrets itself too, whatever file list it is handed.
    r = context.resolve_request(root, "FIND:total", files + ["secrets.json", ".env"])
    assert r.kind == "find" and r.total == 2 and r.start == 2
    assert "src/a.py:1: def total(xs):" in r.text and "src/b.js:1:" in r.text
    assert ".env" not in r.text and "hunter2" not in r.text
    rx = context.resolve_request(root, "FIND:/^def \\w+\\(/", files)
    assert rx.total == 1
    assert context.resolve_request(root, "FIND:nowhere", files).text == "(no matches)"
    bad = context.resolve_request(root, "FIND:/(/", files)
    assert bad.kind == "refused" and "pattern" in bad.why
    assert context.resolve_request(root, "FIND:x", files).kind == "refused"


def test_find_is_capped_and_says_how_much_more(tmp_path, monkeypatch):
    monkeypatch.setattr(context, "FIND_MAX_HITS", 3)
    root = tmp_path / "p"
    root.mkdir()
    (root / "a.txt").write_text("hit\n" * 10)
    r = context.resolve_request(root, "FIND:hit", context.listing(root))
    assert r.total == 10 and r.text.count("a.txt:") == 3 and "7 more matches" in r.text


def test_find_results_are_sent_in_the_context_block(tmp_path):
    root = tmp_path / "p"
    root.mkdir()
    (root / "a.py").write_text("needle = 1\n")
    pl = context.plan(root, "anything")
    req = context.resolve_request(root, "FIND:needle", pl.files)
    comp = context.compose(root, pl, [req], upload=False, budget=20_000)
    assert "===== FIND: needle (1 matching lines in 1 files) =====" in comp.text
    assert "a.py:1: needle = 1" in comp.text
    assert req.key == "FIND:needle"
