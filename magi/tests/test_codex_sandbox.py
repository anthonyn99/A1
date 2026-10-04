"""Codex runs only in its elevated Windows sandbox (codex_sandbox.py).

Found 2026-10-04: in `unelevated`, a sandboxed command deleted a file on the
Desktop (read-only and workspace-write alike); `elevated` refuses it. MAGI
checks elevated works before using Codex -- bounded, never a hang -- and never
falls back.
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest

from magi.code.agents import codex_cli as CX, codex_sandbox as S, slots
from magi.code.agents.base import Mode, Task


def test_every_codex_run_names_the_elevated_sandbox_and_never_unelevated():
    for mode in (Mode.READ, Mode.WRITE):
        argv = CX.build_argv("codex", Task("t", "q", Path("."), mode))
        cfg = [argv[i + 1] for i, a in enumerate(argv) if a == "-c"]
        assert "windows.sandbox=elevated" in cfg
        assert not any("unelevated" in c for c in cfg)
    src = Path(CX.__file__).read_text(encoding="utf-8")
    assert '"windows.sandbox=unelevated"' not in src


def _fake_exe(tmp_path: Path, body: str) -> str:
    py = tmp_path / "fake.py"
    py.write_text(body)
    cmd = tmp_path / "fake.cmd"
    cmd.write_text(f'@"{sys.executable}" "{py}" %*\r\n')
    return str(cmd)


def test_a_check_that_hangs_ends_and_says_how_to_set_it_up(tmp_path):
    """The engine must not wait for ever on a UAC prompt nobody answers --
    nor on a pipe a grandchild keeps open after the shim is killed."""
    exe = _fake_exe(tmp_path, "import subprocess, sys, time\n"
                              "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(90)'])\n"
                              "time.sleep(90)\n")
    t0 = time.monotonic()
    ok, why = S._probe(exe, None, timeout=2)
    took = time.monotonic() - t0
    assert not ok and S.SETUP_COMMAND in why and "waited" in why
    assert took < 30, took


def test_a_check_that_answers_passes_and_one_that_fails_says_why(tmp_path):
    good = _fake_exe(tmp_path, f"print('{S._MARK}')\n")
    assert S._probe(good, None, timeout=20) == (True, "")
    (tmp_path / "bad").mkdir()
    bad = _fake_exe(tmp_path / "bad", "import sys\nprint('setup refused by user')\nsys.exit(1)\n")
    ok, why = S._probe(bad, None, timeout=20)
    assert not ok and "setup refused by user" in why and S.SETUP_COMMAND in why


def test_results_are_remembered_per_codex_version(monkeypatch):
    S.forget()
    calls = []
    monkeypatch.setattr(S, "_probe", lambda exe, env: calls.append(1) or (False, "no"))
    assert S.ready("x", {}, "1.0") == (False, "no") and S.ready("x", {}, "1.0") == (False, "no")
    assert len(calls) == 1, "a failure is not re-checked on every task"
    monkeypatch.setattr(S, "RETRY_FAILED_S", 0)
    S.ready("x", {}, "1.0")
    assert len(calls) == 2, "but it is checked again later"
    monkeypatch.setattr(S, "_probe", lambda exe, env: calls.append(1) or (True, ""))
    assert S.ready("x", {}, "2.0") == (True, "")
    S.ready("x", {}, "2.0")
    assert len(calls) == 3, "a pass is kept for that version"
    S.forget()


def test_codex_is_unavailable_with_the_reason_when_the_sandbox_is_not_ready(monkeypatch):
    monkeypatch.setattr(slots, "cli_path", lambda a: "codex")
    monkeypatch.setattr(slots, "status", lambda a, s: type("St", (), {"signed_in": True, "detail": ""})())
    monkeypatch.setattr(CX.models, "cap_block", lambda a, s: (None, ""))
    monkeypatch.setattr(CX.limits, "blocked_until", lambda a, s: None)
    monkeypatch.setattr(CX.models, "plan_used_up", lambda a, s: None)
    monkeypatch.setattr(S, "ready", lambda exe, env, v: (False, S.SETUP_HINT))
    ok, why = asyncio.run(CX.CodexCLIAgent("codex1").available())
    assert ok is False and S.SETUP_COMMAND in why
    monkeypatch.setattr(S, "ready", lambda exe, env, v: (True, ""))
    assert asyncio.run(CX.CodexCLIAgent("codex1").available())[0] is True


# ── the real thing: the installed Codex, its elevated sandbox ─────────────

EXE = slots.cli_path("codex")


@pytest.mark.skipif(not EXE or sys.platform != "win32", reason="needs Codex on Windows")
@pytest.mark.parametrize("smode", ["read-only", "workspace-write"])
def test_the_real_sandbox_refuses_a_delete_outside_its_folder(smode):
    """The regression that matters: MAGI updates Codex by itself, and a
    release that let a sandboxed delete through again must fail here."""
    S.forget()
    env = slots.env_for("codex", (slots.list_slots("codex") or ["codex1"])[0])
    if not S.ready(EXE, env, "test")[0]:
        pytest.skip("the elevated sandbox is not set up on this PC")
    base = Path(tempfile.gettempdir()) / "magi-sandbox" / f"deltest-{smode}"
    shutil.rmtree(base, ignore_errors=True)
    ws = base / "ws"
    ws.mkdir(parents=True)
    keep = base / "keep.txt"
    keep.write_text("keep\n")
    (base / "dir").mkdir()
    (base / "dir" / "f.txt").write_text("f\n")
    script = ws / "op.cmd"
    script.write_text("@echo off\r\ndel ..\\keep.txt\r\nrmdir /s /q ..\\dir\r\n"
                      "type ..\\keep.txt\r\necho done\r\n")
    cfg = ["-c", f"sandbox_mode={smode}"]
    for c in (CX.WRITE_CONFIG if smode == "workspace-write" else CX.SANDBOX_CONFIG):
        cfg += ["-c", c]
    try:
        r = subprocess.run([EXE, "sandbox", *cfg, "--", "cmd.exe", "/d", "/c", str(script)],
                           cwd=str(ws), env=env, capture_output=True, text=True, timeout=120)
        assert "done" in r.stdout, r.stdout + r.stderr
        assert "keep" in r.stdout, "reading outside still works"
        assert keep.exists(), "a sandboxed delete outside the folder went through"
        assert (base / "dir" / "f.txt").exists(), "a sandboxed rmdir outside went through"
    finally:
        shutil.rmtree(base, ignore_errors=True)
        S.forget()
