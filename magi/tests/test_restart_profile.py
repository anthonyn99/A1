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
