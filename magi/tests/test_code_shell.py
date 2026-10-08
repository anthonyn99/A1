"""Track W2: the agents' shell, in Codex's elevated Windows sandbox.

The sandbox tests run the REAL `codex sandbox` on this PC (skipped where it
is not set up): writes stay in the copy, Read mode changes nothing, a timed-
out command and a background server are really stopped.
"""

from __future__ import annotations

import asyncio
import shutil
import socket
import tempfile
import time
from pathlib import Path

import pytest

from magi.code import shell as SH
from magi.code import ws_mcp as W
from magi.code.agents import browser
from magi.code.agents import claude_cli as CC
from magi.code.agents import codex_cli as CX
from magi.code.agents.base import Mode, Outcome, Task
from tests.test_code_agents import _Ans, _ScriptedUnit


def test_settings_default_on_without_internet(tmp_path, monkeypatch):
    monkeypatch.setattr(SH, "_store", lambda: tmp_path / "shell.json")
    assert SH.get("p") == {"enabled": True, "internet": False}
    assert SH.put("p", True, True) == {"enabled": True, "internet": True}
    assert SH.get("p")["internet"] is True
    assert SH.put("p", False, "yes") == {"enabled": False, "internet": False}, "only a real true"
    SH.put("p", True, False)
    assert "p" not in (tmp_path / "shell.json").read_text(), "the default is not stored"


def test_claudes_server_builds_the_same_command_line():
    sp = {"codex": "C:/codex.cmd", "bash": "C:/Git/bin/bash.exe", "cwd": "C:/copy", "write": True,
          "internet": True, "scratch": "C:/s", "cache": "C:/c", "writable": [r"C:\s", r"C:\c", r"C:\other copy"]}
    assert W._shell_argv(sp, "x.sh") == SH.argv(sp, "x.sh")
    a = SH.argv(sp, "x.sh")
    assert "sandbox_mode=workspace-write" in a and "windows.sandbox=elevated" in a
    assert "sandbox_workspace_write.network_access=true" in a
    assert "sandbox_workspace_write.writable_roots=['C:/s', 'C:/c', 'C:/other copy']" in a
    assert a[-4:] == ["C:/Git/bin/bash.exe", "--noprofile", "--norc", "x.sh"]


def test_codex_follows_the_projects_internet_switch(tmp_path):
    on = Task("t", "q", tmp_path, Mode.WRITE, shell={"internet": True})
    off = Task("t", "q", tmp_path, Mode.WRITE)
    assert "sandbox_workspace_write.network_access=true" in CX.build_argv("codex", on)
    assert "sandbox_workspace_write.network_access=false" in CX.build_argv("codex", off)


def test_claude_is_told_about_its_shell_and_read_mode_is_not_plan_mode(tmp_path):
    sp = {"internet": False}
    w = Task("t", "q", tmp_path, Mode.WRITE, mcp_servers=(CC.WS_SERVER,), shell=sp)
    f = CC.write_frame(w)
    assert "You have a shell" in f and "Internet is OFF" in f and "not part of this mode" not in f
    r = Task("t", "q", tmp_path, Mode.READ, shell=sp)
    a = CC.build_argv("claude", r)
    assert a[a.index("--permission-mode") + 1] == "default"
    assert a[a.index("--tools") + 1] == CC.READ_TOOLS, "still no file-changing tool"
    plain = CC.build_argv("claude", Task("t", "q", tmp_path, Mode.READ))
    assert plain[plain.index("--permission-mode") + 1] == "plan"
    assert "read-only" in CC.shell_how(r)


# ── the real sandbox on this PC ──────────────────────────────────────────

@pytest.fixture
def sandbox_dirs():
    ok, why = SH.availability(wait=True)
    if not ok:
        pytest.skip(f"no sandboxed shell on this PC: {why}")
    base = Path(tempfile.gettempdir()) / "magi-sandbox" / f"test-shell-{time.time_ns()}"
    copy, real = base / "copy", base / "real"
    copy.mkdir(parents=True)
    real.mkdir()
    (real / "keep.txt").write_text("keep\n")
    yield base, copy, real
    shutil.rmtree(base, ignore_errors=True)


def test_write_mode_writes_only_in_the_copy(sandbox_dirs):
    base, copy, real = sandbox_dirs
    sp = SH.spec(cwd=copy, scratch=base / "scratch", write=True, internet=False)
    target = str(real / "keep.txt").replace("\\", "/")
    r = asyncio.run(SH.run(sp, f"echo new > made.txt && echo ok; echo x > '{target}'; echo rc=$?"))
    assert "ok" in r["output"] and "rc=1" in r["output"]
    assert (copy / "made.txt").exists() and (real / "keep.txt").read_text() == "keep\n"


def test_read_mode_changes_nothing(sandbox_dirs):
    base, copy, real = sandbox_dirs
    sp = SH.spec(cwd=real, scratch=base / "scratch", write=False, internet=False)
    r = asyncio.run(SH.run(sp, "cat keep.txt; echo y > new.txt; echo rc=$?; rm keep.txt; echo rm=$?"))
    assert "keep" in r["output"] and "rc=1" in r["output"] and "rm=1" in r["output"]
    assert not (real / "new.txt").exists() and (real / "keep.txt").exists()


def test_a_command_that_runs_too_long_is_stopped(sandbox_dirs):
    base, copy, _ = sandbox_dirs
    sp = SH.spec(cwd=copy, scratch=base / "scratch", write=True, internet=False)
    t0 = time.monotonic()
    r = asyncio.run(SH.run(sp, "sleep 60; echo never", timeout_s=4))
    assert r["timed_out"] and "never" not in r["output"] and time.monotonic() - t0 < 40


def _listening(port: int) -> bool:
    s = socket.socket()
    s.settimeout(1)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


def test_claudes_background_server_is_reachable_and_really_stopped(sandbox_dirs):
    """Found 2026-10-08: a plain kill does not reach a sandbox-user process;
    closing its job does. And close() (the task ending) stops everything."""
    base, copy, _ = sandbox_dirs
    (copy / "index.html").write_text("HELLO-SHELL")
    sp = SH.spec(cwd=copy, scratch=base / "scratch", write=True, internet=False)
    s = W.Server(copy, shell=sp)
    def free() -> int:
        k = socket.socket()
        k.bind(("127.0.0.1", 0))
        n = k.getsockname()[1]
        k.close()
        return n
    port = free()
    txt, err = s.call("start_process", {"command": f"python -m http.server {port} --bind 127.0.0.1",
                                        "name": "web"})
    assert not err and "web-1" in txt
    for _ in range(30):
        if _listening(port):
            break
        time.sleep(0.5)
    txt, err = s.call("shell", {"command": f"curl -s http://127.0.0.1:{port}/index.html"})
    assert not err and "HELLO-SHELL" in txt
    assert "running" in s.call("process_output", {"id": "web-1"})[0]
    s.call("stop_process", {"id": "web-1"})
    time.sleep(2)
    assert not _listening(port)
    port2 = free()
    s.call("start_process", {"command": f"python -m http.server {port2} --bind 127.0.0.1"})
    for _ in range(30):
        if _listening(port2):
            break
        time.sleep(0.5)
    s.close()
    time.sleep(2)
    assert not _listening(port2), "the task's end stops what is still running"


# ── browser units ────────────────────────────────────────────────────────

def test_a_unit_runs_shell_lines_and_gets_the_output(sandbox_dirs, monkeypatch, tmp_path):
    from magi.providers import registry
    base, copy, _ = sandbox_dirs
    (copy / "a.txt").write_text("alpha\n")
    sp = SH.spec(cwd=copy, scratch=base / "scratch", write=True, internet=False)
    unit = _ScriptedUnit([_Ans("SHELL: wc -l a.txt\nSHELL: echo $((6*7))", ok=False),
                          _Ans("a.txt has 1 line.")])
    monkeypatch.setattr(registry, "build_provider", lambda s, u: unit)
    monkeypatch.setattr(browser, "_staging_root", lambda: tmp_path / "stage")
    events = []

    async def emit(e):
        events.append(e)
    task = Task("t", "How many lines in a.txt?", copy, Mode.WRITE, shell=sp)
    res = asyncio.run(browser.BrowserUnitAgent("deepseek", "DeepSeek", settings=None)
                      .run(task, emit=emit, cancel=asyncio.Event()))
    assert res.outcome == Outcome.OK and len(unit.asks) == 2
    assert "SHELL: npm test" in unit.asks[0]["prompt"], "told how, up front"
    second = unit.asks[1]["prompt"]
    assert "1 a.txt" in second and "42" in second
    assert [e["target"] for e in events if e.get("name") == "Shell"] == ["wc -l a.txt", "echo $((6*7))"]


def test_shell_lines_do_nothing_without_a_shell():
    assert browser._parse_shells("SHELL: ls\nSHELL: ls\nSHELL: `pwd`") == ["ls", "pwd"]


def test_internet_off_means_off(sandbox_dirs):
    if not shutil.which("node"):
        pytest.skip("node not installed")
    base, copy, _ = sandbox_dirs
    sp = SH.spec(cwd=copy, scratch=base / "scratch", write=True, internet=False)
    js = ("require('https').get('https://registry.npmjs.org/left-pad',r=>{console.log('STATUS',"
          "r.statusCode);process.exit(0)}).on('error',e=>{console.log('NETERR',e.code);process.exit(1)})")
    (copy / "net.js").write_text(js)
    r = asyncio.run(SH.run(sp, "node net.js", timeout_s=30))
    assert "NETERR" in r["output"] and "STATUS" not in r["output"], r["output"]


def test_the_transcript_names_shell_calls_by_what_they_ran():
    assert CC._WS_NAMES["shell"] == "Shell" and CC._WS_NAMES["start_process"] == "Start"
    assert CC._target({"command": "npm test"}) == "npm test"
    assert CC._target({"id": "web-1"}) == "web-1"


def test_git_works_on_your_repository_from_the_sandbox(sandbox_dirs):
    """Found live: git refused ('dubious ownership') -- the sandbox is
    another Windows user. Trusted through git's env config, for these runs."""
    import subprocess
    base, copy, real = sandbox_dirs
    subprocess.run(["git", "init", "-q", str(real)], check=True)
    subprocess.run(["git", "-C", str(real), "-c", "user.name=x", "-c", "user.email=x@x", "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(real), "-c", "user.name=x", "-c", "user.email=x@x",
                    "commit", "-qm", "one"], check=True)
    sp = SH.spec(cwd=real, scratch=base / "scratch", write=False, internet=False)
    r = asyncio.run(SH.run(sp, "git rev-list --count HEAD"))
    assert r["ok"] and r["output"].strip().endswith("1"), r["output"]
    s = W.Server(real, shell=sp, readonly=True)
    txt, err = s.call("shell", {"command": "git log --oneline | wc -l"})
    assert not err and txt.strip().endswith("1"), txt


def test_the_sandbox_path_drops_windowsapps_and_puts_a_real_python_first(monkeypatch, tmp_path):
    """Found on Tony's PC: `python` was the Store's Python Install Manager
    under C:\Program Files\WindowsApps -- "Permission denied" in the sandbox.
    And the WindowsApps filter only split on '/', so it never matched."""
    monkeypatch.setenv("PATH", r"C:\Program Files\WindowsApps\Py_1.0\bin;C:\Users\x\AppData\Local\Microsoft\WindowsApps;C:\keep")
    sp = {"scratch": str(tmp_path), "cache": str(tmp_path), "path_first": [r"C:\RealPython"],
          "codex": "c", "bash": "b", "cwd": str(tmp_path), "write": True, "internet": False, "writable": []}
    path = next(v for k, v in SH.env_for(sp).items() if k.upper() == "PATH").split(";")
    assert path[0] == r"C:\RealPython" and r"C:\keep" in path
    assert not any("windowsapps" in p.lower() for p in path)
    s = W.Server(tmp_path, shell=sp)
    path2 = next(v for k, v in s._shell_env().items() if k.upper() == "PATH").split(";")
    assert path2[0] == r"C:\RealPython" and not any("windowsapps" in p.lower() for p in path2)
    assert all("windowsapps" not in p.lower() for p in SH.python_dirs())
