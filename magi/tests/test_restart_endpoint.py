"""Restarting the engine from the console, and the two ways that must not work.

The engine loads its Python at import, so every fix under magi/ is inert until
it restarts -- which used to mean going to the PC and finding a windowless
pythonw in Task Manager. POST /api/restart is that act, from the panel that
already says whether MAGI is running on this device.

What is pinned here:
  * it is LOCAL ONLY. A button that restarts the machine's engine must not be
    reachable over the tunnel, token or no token -- and it answers 404 rather
    than 403, because an endpoint that says "unauthorised" advertises itself.
  * it REFUSES while work is in flight, unless forced. A restart mid-run loses
    the run and orphans its browsers.
  * it never kills anything: the engine exits itself and a detached helper
    starts the replacement (restarter.py), because a killer would be a child of
    the process it kills and `taskkill /t` would take it down mid-restart.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

APP = (REPO / "magi" / "app.py").read_text(encoding="utf-8")


def _endpoint() -> str:
    start = APP.index('@app.post("/api/restart")')
    end = APP.index('@app.get("/api/providers")', start)
    return APP[start:end]


def test_the_restart_is_refused_over_the_tunnel():
    body = _endpoint()
    assert "_arrived_over_the_tunnel(request)" in body, "the tunnel is not checked"
    assert re.search(r'HTTPException\(404', body), "must 404, not 403"
    gate = body.index("_arrived_over_the_tunnel")
    assert gate < body.index("proc.popen"), "the check must come before acting"


def test_work_in_flight_blocks_a_restart_unless_forced():
    body = _endpoint()
    assert "_runs.items()" in body and "_studio_jobs.items()" in body, \
        "a restart must notice runs AND Studio cards"
    assert "and not force" in body, "there is no way to override the refusal"
    assert "409" in body, "a busy engine should answer 409, not fail silently"


def test_nothing_is_killed_to_restart():
    body = _endpoint()
    assert "taskkill" not in body and "terminate()" not in body, \
        "kill the engine from inside its own tree and the killer dies with it"
    assert "magi.restarter" in body, "the detached restarter is what starts it again"
    assert "proc.popen" in body, "must go through magi.proc so nothing flashes a console"
    assert "os._exit(0)" in body, "the engine has to let go of the port itself"


def test_the_restarter_waits_for_the_port_before_starting():
    src = (REPO / "magi" / "restarter.py").read_text(encoding="utf-8")
    assert "_port_free" in src and "_alive" in src, \
        "starting before the old engine let go leaves the new one unable to bind"
    assert "pythonw.exe" in src, "the engine must come back windowless, as at logon"


def test_the_console_only_offers_it_where_it_can_work():
    page = (REPO / "magi.html").read_text(encoding="utf-8")
    assert 'show(restart, link.where === "local")' in page, \
        "offered on a phone, the button would 404 by design"
    assert "/api/restart" in page
    assert "r.status === 409" in page, "a busy engine's refusal must be shown, not swallowed"
