"""A restart brings back the SAME person's engine, on the same port.

The console's Restart and magi/restarter.py used to know only Tony: his
scheduled task ("MAGI Engine") and a bare `magi cloud`. On Veda's PC that
would have started Tony's profile, or nothing. Found getting her PC ready
for a one-command install (2026-09-24).
"""

from __future__ import annotations

import pytest

from magi import restarter as R
from magi import settings


@pytest.fixture
def captured(monkeypatch):
    runs, starts = [], []

    class _Fail:
        returncode = 1
        stdout = ""

    monkeypatch.setattr(R, "_alive", lambda pid: False)
    monkeypatch.setattr(R, "_port_free", lambda port: True)
    # The restarter pulls first (selfupdate); a test must never touch the repo.
    from magi import selfupdate
    monkeypatch.setattr(selfupdate, "update_checkout", lambda: "stubbed")
    monkeypatch.setattr(R.proc, "run", lambda argv, **kw: runs.append(argv) or _Fail())
    monkeypatch.setattr(R.proc, "popen", lambda argv, **kw: starts.append(argv))
    before = settings.active_profile()
    yield runs, starts
    settings.set_active_profile(before)


def test_veda_is_restarted_as_veda(captured, tmp_path):
    runs, starts = captured
    assert R.main(["1", "8000", str(tmp_path), "veda"]) == 0
    assert runs[0][-1] == "MAGI Engine (veda)", "her scheduled task, not Tony's"
    argv = starts[0]
    assert argv[argv.index("cloud"):] == ["cloud", "--port", "8000", "--profile", "veda"]


def test_tony_keeps_his_names(captured, tmp_path):
    runs, starts = captured
    assert R.main(["1", "8000", str(tmp_path)]) == 0
    assert runs[0][-1] == "MAGI Engine"
    assert starts[0][starts[0].index("cloud"):] == ["cloud", "--port", "8000"]


def test_the_endpoint_passes_the_profile_and_port():
    from pathlib import Path
    src = (Path(__file__).resolve().parents[1] / "app.py").read_text(encoding="utf-8")
    body = src[src.index('@app.post("/api/restart")'):]
    body = body[:body.index("\n@app.")]
    assert 'ident.engine_identity().get("port")' in body and "active_profile()]" in body


# ── every other way an engine gets started ──────────────────────────────────
# autostart's "start it now", the watchdog's fallback and the logon task used
# a bare `magi cloud` -- Tony on 8000, on any PC. Found checking Veda's
# autostart (her setup runs autostart before anything else starts her engine).

def test_engine_args_carry_the_profile_and_its_port(monkeypatch):
    from magi import watchdog as W
    before = settings.active_profile()
    try:
        monkeypatch.setattr(W, "_configured_port", lambda default=8000: 8001)
        settings.set_active_profile("veda")
        assert W.engine_args() == ["-m", "magi", "cloud", "--port", "8001", "--profile", "veda"]
        settings.set_active_profile("tony")
        assert W.engine_args(8000) == ["-m", "magi", "cloud", "--port", "8000"]
    finally:
        settings.set_active_profile(before)


def test_her_logon_task_starts_her_engine():
    from magi.cli import serve as S
    before = settings.active_profile()
    try:
        settings.set_active_profile("veda")
        script = S._task_script(S.ROOT / ".venv" / "Scripts" / "pythonw.exe", S.ROOT.parent, 8000)
        assert "'-m magi cloud --profile veda'" in script
        assert "'MAGI Engine (veda)'" in script and "'-m magi.watchdog --profile veda'" in script
        assert "'-m magi cloud --port 8001 --profile veda'" in \
            S._task_script(S.ROOT / "x", S.ROOT.parent, 8001)
        settings.set_active_profile("tony")
        assert "'-m magi cloud'" in S._task_script(S.ROOT / "x", S.ROOT.parent, 8000), \
            "Tony's registered command line is unchanged"
    finally:
        settings.set_active_profile(before)


def test_no_bare_engine_start_is_left():
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    for f in ("watchdog.py", "cli/serve.py", "restarter.py"):
        src = (root / f).read_text(encoding="utf-8")
        assert '"-m", "magi", "cloud"]' not in src, f


def test_per_profile_files_follow_the_profile_set_after_import():
    """tunnel.json, watchdog.log and uploads were fixed at IMPORT time --
    Tony's -- so a veda engine wrote its tunnel record over his."""
    from magi import app as A, tunnel as T, watchdog as W
    before = settings.active_profile()
    try:
        settings.set_active_profile("veda")
        for p in (T._state(), W._log(), A._uploads()):
            assert p.parent.name == "veda" or p.parent.parent.name == "veda", p
    finally:
        settings.set_active_profile(before)
