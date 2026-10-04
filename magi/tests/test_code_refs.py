"""Track V: a task may READ other workspaces ("Also read") -- never change them.

* Only workspaces registered on this engine, by id, with a folder here
  (routes._task_refs); never a path from the request.
* Claude in Read mode: `--add-dir` (its tools cannot write anywhere there).
  Claude in Write mode: ws_mcp's ref_list / ref_read / ref_find -- there is
  no tool that writes to a reference folder.
* Codex: the paths, in the prompt. Browser units: the folders' indexes in
  the context, `NEED: @name/...`, FIND across them; an edit to @name/... is
  refused.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from magi.code import routes as R
from magi.code import sandbox as SB
from magi.code import tasks as T
from magi.code import ws_mcp as W
from magi.code.agents import browser as B, chain, claude_cli as CC, context, edits
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
def ref(tmp_path):
    r = tmp_path / "orca"
    (r / "src").mkdir(parents=True)
    (r / "src" / "app.py").write_text("def handler():\n    return 'orca'\n")
    (r / "README.md").write_text("Orca\n")
    (r / ".env").write_text("SECRET=1\n")
    (r / "node_modules" / "x").mkdir(parents=True)
    (r / "node_modules" / "x" / "i.js").write_text("handler\n")
    return r


# ── the route: ids only, folders here only ────────────────────────────────

class FakeDB:
    def __init__(self, projects):
        self.projects = projects

    async def code_project(self, pid, eng):
        return self.projects.get(pid)


def _proj(pid, name, root):
    return {"id": pid, "name": name, "bindings": [{"here": True, "root": str(root)}]}


def test_refs_are_registered_workspaces_by_id_with_safe_unique_names(tmp_path, monkeypatch):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir(), b.mkdir()
    db = FakeDB({"p_main": _proj("p_main", "Main", tmp_path),
                 "p1": _proj("p1", "ORCA Repo!", a), "p2": _proj("p2", "orca repo", b),
                 "away": {"id": "away", "name": "Away", "bindings": [{"here": False, "root": "x"}]},
                 "gone": _proj("gone", "Gone", tmp_path / "nope")})
    monkeypatch.setattr(R, "_db", lambda: db)
    run = lambda raw: asyncio.run(R._task_refs(raw, "p_main", "eng"))
    assert run(None) == ([], "") and run([]) == ([], "")
    got, why = run(["p1", "p_main", "p1", "p2"])          # main and repeats dropped
    assert why == "" and got == [("orca-repo", a), ("orca-repo-2", b)]
    assert run(["away"])[1] and run(["gone"])[1] and run(["nobody"])[1]
    assert run("p1")[1] and run(["p"] * (R.MAX_TASK_REFS + 1))[1]
    # A path is not an id: it names no registered project.
    assert run([str(a)])[1]


def test_the_engine_says_it_takes_refs():
    import inspect
    assert '"refs"' in inspect.getsource(R.code_state)


# ── what each agent is told, and Claude's flags ───────────────────────────

def test_every_cli_agent_is_told_the_folders_and_how_it_reads_them(tmp_path, ref):
    t = Task("t", "Compare the handlers.", tmp_path, Mode.READ, refs=[("orca", ref)])
    p = t.prompt_for("codex:codex1")
    assert "REFERENCE FOLDERS" in p and f"- @orca: {ref}" in p and "never change" in p
    assert p.index("Compare the handlers.") < p.index("REFERENCE FOLDERS")
    assert "Read, Glob and Grep" in t.prompt_for("claude:system", refs_how=CC.refs_how(t))
    w = Task("t", "q", tmp_path, Mode.WRITE, refs=[("orca", ref)])
    assert "ref_read" in CC.refs_how(w) and "@orca/" in CC.refs_how(w)
    assert "REFERENCE FOLDERS" not in Task("t", "q", tmp_path).prompt_for("x")


def test_claude_reads_refs_with_add_dir_in_read_mode_only(tmp_path, ref):
    r = CC.build_argv("claude", Task("t", "q", tmp_path, Mode.READ, refs=[("orca", ref)]))
    assert r[r.index("--add-dir") + 1] == str(ref)
    w = CC.build_argv("claude", Task("t", "q", tmp_path, Mode.WRITE, refs=[("orca", ref)]))
    assert "--add-dir" not in w, "acceptEdits would approve edits inside an added directory"


# ── ws_mcp: the ref tools read, and only read ─────────────────────────────

def _srv(tmp_path, ref):
    copy = tmp_path / "copy"
    copy.mkdir(exist_ok=True)
    return W.Server(copy, refs=[{"name": "orca", "root": str(ref)}]), copy


def test_ref_tools_list_read_and_find(tmp_path, ref):
    s, _ = _srv(tmp_path, ref)
    names = [t["name"] for t in s.tools()]
    assert names[-3:] == ["ref_list", "ref_read", "ref_find"]
    text, err = s.call("ref_list", {"path": "@orca"})
    assert not err and text.splitlines() == ["@orca/README.md", "@orca/src/app.py"]
    text, err = s.call("ref_read", {"path": "@orca/src/app.py"})
    assert not err and text.splitlines()[1] == "     2\t    return 'orca'"
    text, _ = s.call("ref_read", {"path": "@orca/src/app.py", "offset": 2, "limit": 1})
    assert text.startswith("     2\t") and "[lines 2-2 of 2" not in text
    text, err = s.call("ref_find", {"pattern": "handler"})
    assert not err and text == "@orca/src/app.py:1: def handler():"   # node_modules skipped
    text, _ = s.call("ref_find", {"pattern": "orca", "path": "@orca/README.md"})
    assert text == "@orca/README.md:1: Orca"


def test_ref_reads_page_long_files(tmp_path, ref, monkeypatch):
    monkeypatch.setattr(W, "REF_READ_LINES", 3)
    (ref / "long.txt").write_text("".join(f"l{i}\n" for i in range(1, 11)))
    s, _ = _srv(tmp_path, ref)
    text, _ = s.call("ref_read", {"path": "@orca/long.txt"})
    assert "[lines 1-3 of 10; read on with offset=4]" in text
    text, _ = s.call("ref_read", {"path": "@orca/long.txt", "offset": 99})
    assert "has 10 lines" in text


@pytest.mark.parametrize("path, why", [
    ("@orca/.env", "secret"),
    ("@orca/../escape.txt", "stays inside"),
    ("@orca/.git/config", ".git/"),
    ("@other/x", "No reference folder @other"),
    ("src/app.py", "start with @"),
    ("", "required"),
])
def test_ref_tools_refuse_secrets_escapes_and_unknown_folders(tmp_path, ref, path, why):
    s, _ = _srv(tmp_path, ref)
    text, err = s.call("ref_read", {"path": path})
    assert err and why in text


def test_a_link_inside_a_ref_that_points_out_is_not_followed(tmp_path, ref):
    out = tmp_path / "private"
    out.mkdir()
    (out / "diary.txt").write_text("private\n")
    _junction(ref / "peek", out)
    s, _ = _srv(tmp_path, ref)
    text, err = s.call("ref_read", {"path": "@orca/peek/diary.txt"})
    assert err and "outside @orca" in text
    assert "peek" not in s.call("ref_list", {"path": "@orca"})[0]
    assert "private" not in s.call("ref_find", {"pattern": "private"})[0]


def test_the_file_tools_never_touch_a_reference_folder(tmp_path, ref):
    s, copy = _srv(tmp_path, ref)
    (copy / "a.txt").write_text("a\n")
    for name, args in [("delete_path", {"path": "@orca/README.md"}),
                       ("move_path", {"from": "a.txt", "to": "@orca/a.txt"}),
                       ("copy_path", {"from": "a.txt", "to": "@ORCA/a.txt"}),
                       ("make_dir", {"path": "@orca"})]:
        text, err = s.call(name, args)
        assert err and "read-only" in text, (name, text)
    assert not (copy / "@orca").exists() and (ref / "README.md").exists()
    assert not any(t.get("annotations", {}).get("destructiveHint") for t in W.REF_TOOLS)


def test_no_refs_no_ref_tools(tmp_path):
    s = W.Server(tmp_path)
    assert not [t for t in s.tools() if t["name"].startswith("ref_")]
    assert s.call("ref_list", {"path": "@x"})[1] is True


# ── tasks: refs reach the agents and the transcript ──────────────────────

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
    r.mkdir()
    _git(r, "init", "-q")
    _git(r, "config", "user.name", "t")
    _git(r, "config", "user.email", "t@t")
    (r / "app.py").write_text("x = 1\n")
    _git(r, "add", "-A")
    _git(r, "commit", "-qm", "init")
    return r


class Peek(CodingAgent):
    kind = "cli"
    id = label = "claude:system"

    def __init__(self):
        self.task = None
        self.side = None

    async def run(self, task, *, emit, cancel):
        self.task = task
        if task.mcp_config:
            cfg = json.loads(task.mcp_config.read_text())
            self.side = json.loads(Path(cfg["mcpServers"]["magi_workspace"]["args"][-1]).read_text())
        await emit({"k": "tool", "name": "Read", "target": str(task.refs[0][1] / "src" / "app.py")})
        return Result(Outcome.OK, text="read")


def _run(repo, agent, mode, refs):
    expand = chain.expand
    chain.expand = lambda order, settings: [agent]

    async def go():
        t = await T.start(project_id="p", root=repo, prompt="compare", order=[], settings=None,
                          mode=mode, refs=refs)
        seen = []
        async for ev in T.stream(t):
            seen.append(ev)
            if ev["k"] == "approval":
                T.decide(t, False)
        return t, seen
    try:
        return asyncio.run(go())
    finally:
        chain.expand = expand


@pytest.mark.parametrize("mode", ["read", "write"])
def test_refs_reach_the_agent_and_read_as_at_names(repo, ref, mode):
    a = Peek()
    t, seen = _run(repo, a, mode, [("orca", ref)])
    assert a.task.refs == [("orca", ref)]
    start = next(e for e in seen if e["k"] == "start")
    assert start["refs"] == ["orca"]
    assert any(e["k"] == "note" and "@orca" in e.get("text", "") for e in seen)
    tool = next(e for e in seen if e["k"] == "tool" and e["name"] == "Read")
    assert tool["target"] == "@orca/src/app.py"
    if mode == "write":
        assert a.side["refs"] == [{"name": "orca", "root": str(ref)}]
    else:
        assert a.side is None


# ── browser units ─────────────────────────────────────────────────────────

def test_need_and_find_reach_into_a_ref_under_its_name(tmp_path, ref):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "main.py").write_text("handler = None\n")
    refs = {"orca": (ref, context.listing(ref))}
    f = context.resolve_request(root, "@orca/src/app.py", context.listing(root), refs)
    assert f.kind == "file" and f.rel == "@orca/src/app.py" and "return 'orca'" in f.text
    r = context.resolve_request(root, "@orca/src/app.py:2-2", None, refs)
    assert r.kind == "range" and r.rel == "@orca/src/app.py" and r.text.strip() == "return 'orca'"
    d = context.resolve_request(root, "@orca/", None, refs)
    assert d.kind == "dir" and "@orca/src/app.py" in d.text.splitlines()
    assert context.resolve_request(root, "@orca/.env", None, refs).kind == "refused"
    assert context.resolve_request(root, "@orca/../proj/main.py", None, refs).kind == "refused"
    fd = context.resolve_request(root, "FIND:handler", context.listing(root), refs)
    assert fd.total == 2 and "main.py:1:" in fd.text and "@orca/src/app.py:1:" in fd.text
    assert "node_modules" not in fd.text


def test_the_context_block_carries_each_refs_index(tmp_path, ref):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "main.py").write_text("x\n")
    refs = {"orca": (ref, context.listing(ref))}
    comp = context.compose(root, context.plan(root, "x"), [], upload=False, budget=30_000, refs=refs)
    assert "REFERENCE FOLDER @orca (read-only;" in comp.text and "app.py" in comp.text
    t = Task("t", "q", root, Mode.READ, refs=[("orca", ref)])
    prompt = B.BrowserUnitAgent("gemini", "Gemini", None).build_prompt(t, comp.text)
    assert "NEED: @name/path" in prompt and str(ref) not in prompt.split("PROJECT CONTEXT")[0]


def test_a_browser_edit_to_a_ref_is_refused_not_made_as_a_folder(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "a.py").write_text("a\n")
    for blk in (edits.Edit("@orca/new.py", "", "x"), edits.Edit("a.py", op="move", to="@orca/a.py"),
                edits.Edit("@Orca/README.md", op="delete")):
        changed, problems = edits.apply(root, [blk], readonly=("orca",))
        assert changed == [] and "read-only" in problems[0], problems
    assert not (root / "@orca").exists()
    # Without refs, an "@x" folder is just a folder (npm scopes are real).
    assert edits.apply(root, [edits.Edit("@scope/pkg.js", "", "y")])[1] == []
