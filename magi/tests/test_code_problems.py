"""Track W3: Problems -- the project's own checkers, read into one list."""

from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
import time
from pathlib import Path

import pytest

from magi.code import problems as PR
from magi.code import shell as SH
from magi.code import ws_mcp as W
from magi.code.agents.base import Mode, Task


def test_typescript_output():
    out = ("src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n"
           "src/x.ts(3,1): warning TS6133: 'y' is declared but its value is never read.\n")
    rows = PR.parse("TypeScript", out)
    assert rows[0] == {"source": "TypeScript", "file": "src/app.ts", "line": 12, "col": 5,
                       "severity": "error", "code": "TS2322",
                       "message": "Type 'string' is not assignable to type 'number'."}
    assert rows[1]["severity"] == "warning"


def test_eslint_json_with_paths_made_relative():
    data = [{"filePath": "C:\\proj\\src\\a.js", "messages": [
        {"ruleId": "no-unused-vars", "severity": 2, "message": "'x' is defined but never used.",
         "line": 3, "column": 7},
        {"ruleId": "semi", "severity": 1, "message": "Missing semicolon.", "line": 4, "column": 1}]}]
    rows = PR.parse("ESLint", "noise before\n" + json.dumps(data), "C:/proj")
    assert [(r["file"], r["line"], r["severity"], r["code"]) for r in rows] == [
        ("src/a.js", 3, "error", "no-unused-vars"), ("src/a.js", 4, "warning", "semi")]


def test_ruff_and_pyright_and_plain():
    ruff = "app.py:3:8: F401 [*] `os` imported but unused\nFound 1 error.\n"
    r = PR.parse("Ruff", ruff)
    assert r[0]["code"] == "F401" and r[0]["file"] == "app.py" and r[0]["line"] == 3
    pyright = json.dumps({"generalDiagnostics": [
        {"file": "C:\\proj\\m.py", "severity": "error", "message": "x is not defined",
         "range": {"start": {"line": 9, "character": 4}}, "rule": "reportUndefinedVariable"},
        {"file": "C:\\proj\\m.py", "severity": "information", "message": "fyi",
         "range": {"start": {"line": 0, "character": 0}}}]})
    p = PR.parse("Pyright", pyright, "C:/proj")
    assert len(p) == 1 and (p[0]["file"], p[0]["line"], p[0]["col"]) == ("m.py", 10, 5)
    plain = PR.parse("Python syntax", "pkg/bad.py:2:5: error: invalid syntax\n")
    assert plain[0]["message"] == "invalid syntax" and plain[0]["severity"] == "error"


def test_compare_ignores_moved_lines_and_counts_fixed():
    a = {"problems": [{"source": "Ruff", "file": "a.py", "line": 3, "col": 1, "code": "F401",
                       "message": "unused", "severity": "warning"},
                      {"source": "Ruff", "file": "a.py", "line": 9, "col": 1, "code": "E999",
                       "message": "boom", "severity": "error"}], "total": 2}
    b = {"problems": [{"source": "Ruff", "file": "a.py", "line": 5, "col": 1, "code": "F401",
                       "message": "unused", "severity": "warning"},
                      {"source": "Ruff", "file": "b.py", "line": 1, "col": 1, "code": "F821",
                       "message": "undefined name", "severity": "error"}], "total": 2}
    c = PR.compare(a, b)
    assert [r["file"] for r in c["new"]] == ["b.py"] and c["fixed"] == 1
    assert (c["before"], c["after"]) == (2, 2)


def test_every_agent_is_given_the_list(tmp_path):
    res = {"problems": [{"source": "Ruff", "file": "a.py", "line": 3, "col": 1, "code": "F401",
                         "message": "unused", "severity": "warning"}],
           "total": 1, "errors": 0, "warnings": 1, "ran": [{"name": "Ruff"}], "at": time.time()}
    b = PR.block(res)
    assert b.startswith("PROBLEMS") and "a.py:3:1: warning: unused [F401] (Ruff)" in b
    t = Task("t", "Fix it.", tmp_path, Mode.READ, problems=b)
    assert "a.py:3:1" in t.prompt_for("codex:codex1")
    assert PR.block(None) == "" and "none" in PR.block({**res, "problems": [], "total": 0})


def test_detect_needs_the_project_to_have_the_tool(tmp_path):
    (tmp_path / "tsconfig.json").write_text("{}")
    assert not any(c["name"] == "TypeScript" for c in PR.detect(tmp_path)), "no node_modules: nothing"
    (tmp_path / "node_modules" / ".bin").mkdir(parents=True)
    (tmp_path / "node_modules" / ".bin" / "tsc").write_text("")
    assert any(c["name"] == "TypeScript" for c in PR.detect(tmp_path))
    py = tmp_path / "py"
    py.mkdir()
    (py / "a.py").write_text("x = 1\n")
    names = [c["name"] for c in PR.detect(py)]
    assert names and set(names) <= {"Ruff", "Pyright", "Python syntax"}


@pytest.fixture
def folder():
    ok, why = SH.availability(wait=True)
    if not ok:
        pytest.skip(f"no sandboxed shell: {why}")
    d = Path(tempfile.gettempdir()) / "magi-sandbox" / f"test-problems-{time.time_ns()}"
    d.mkdir(parents=True)
    yield d
    shutil.rmtree(d, ignore_errors=True)


def test_a_real_run_in_the_sandbox_finds_a_syntax_error(folder, monkeypatch):
    (folder / "good.py").write_text("x = 1\n")
    (folder / "bad.py").write_text("def f(:\n    pass\n")
    monkeypatch.setattr(PR, "CACHE", {})
    monkeypatch.setattr(PR, "detect", _python_only)
    got = asyncio.run(PR.for_folder("p", folder, refresh=True))
    assert got["ok"] and got["errors"] >= 1
    assert any(r["file"] == "bad.py" and r["line"] == 1 for r in got["problems"]), got["problems"]
    assert not any(r["file"] == "good.py" for r in got["problems"])
    assert PR.CACHE["p"]["errors"] >= 1
    assert not list(folder.glob("**/__pycache__")), "read-only: nothing written in your folder"


_ORIG = PR.detect


def _python_only(root):
    """The checker every Python folder has, whatever else is on this PC."""
    return [c for c in _ORIG(root) if c["name"] == "Python syntax"] or _ORIG(root)


def test_claudes_problems_tool_runs_them_in_the_copy(folder):
    (folder / "bad.py").write_text("def f(:\n    pass\n")
    sp = SH.spec(cwd=folder, scratch=SH.scratch_for(f"t-{time.time_ns()}"), write=True, internet=False)
    checkers = _python_only(folder)
    s = W.Server(folder, shell=sp, problems=checkers)
    assert "problems" in [t["name"] for t in s.tools()]
    txt, err = s.call("problems", {})
    assert not err and "bad.py" in txt
    assert "problems" not in [t["name"] for t in W.Server(folder, shell=sp).tools()]
