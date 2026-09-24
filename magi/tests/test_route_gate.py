"""Every route, walked through the REAL middleware, over a tunnel-shaped request.

test_gate.py pins the question "did this arrive over the tunnel?". This pins
the other half: that the answer actually guards every endpoint. It walks
app.routes -- including the Code Mode router, which FastAPI nests inside an
included-router object -- so a route added tomorrow is covered without anyone
remembering to list it.

The Phase 14 sweep found /docs, /redoc and /openapi.json served ungated over
the tunnel (they sit outside /api/, which is all the gate looks at), handing
out a map of every endpoint. test_only_the_console_lives_outside_api keeps
anything new from landing out there unnoticed.
"""

from __future__ import annotations

import re

import pytest
from starlette.routing import BaseRoute, Route, WebSocketRoute
from starlette.testclient import TestClient

from magi import settings
from magi.app import app

TOKEN = "t0ken-for-the-gate-test"
TUNNEL = {"host": "abc-def.trycloudflare.com"}
FORWARDED = {"host": "127.0.0.1:8000", "cf-ray": "8a1b2c3d"}


def _walk(routes) -> list[BaseRoute]:
    out: list[BaseRoute] = []
    for r in routes:
        inner = getattr(r, "original_router", None) or getattr(r, "app", None)
        sub = getattr(inner, "routes", None)
        if isinstance(sub, list) and not isinstance(r, Route):
            out += _walk(sub)
        else:
            out.append(r)
    return out


ROUTES = _walk(app.routes)
API = [(m, r.path) for r in ROUTES if isinstance(r, Route) and r.path.startswith("/api/")
       for m in sorted(r.methods or ()) if m not in ("HEAD", "OPTIONS")]


def _fill(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "x", path)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv(settings.api_token_env(), TOKEN)
    # No `with`: the lifespan (browser, tunnel, updates) must not start.
    return TestClient(app, raise_server_exceptions=False)


def test_the_walk_sees_code_mode():
    """Guard against a vacuous pass: the nested router must be flattened."""
    code = {p for _, p in API if p.startswith("/api/code/")}
    assert len(code) >= 50, len(code)
    assert "/api/code/sync" in code and "/api/code/tasks/{task_id}/approve" in code


@pytest.mark.parametrize("method,path", API)
def test_every_api_route_needs_the_token_over_the_tunnel(client, method, path):
    url = _fill(path)
    for headers in (TUNNEL, FORWARDED, {**TUNNEL, "X-MAGI-Token": "wrong"},
                    {**TUNNEL, "X-MAGI-Token": TOKEN[:-1]}):
        r = client.request(method, url, headers=headers, json={})
        assert r.status_code == 401, (method, url, headers, r.status_code)
        assert TOKEN not in r.text
    r = client.request(method, url + "?token=wrong", headers=TUNNEL, json={})
    assert r.status_code == 401, (method, url, "query token")


def test_the_right_token_passes(client):
    """The test above could pass on a gate that refuses everything."""
    assert client.get("/api/health", headers=TUNNEL).status_code == 401
    ok = client.get("/api/health", headers={**TUNNEL, "X-MAGI-Token": TOKEN})
    assert ok.status_code == 200 and TOKEN not in ok.text


def test_encoded_and_doubled_paths_do_not_slip_the_gate(client):
    for url in ("/%61pi/code/state", "/api/%63ode/state", "//api/code/state",
                "/api//code/state", "/api/code/state/"):
        r = client.get(url, headers=TUNNEL)
        assert r.status_code in (401, 404), (url, r.status_code)
        assert r.status_code == 401 or "projects" not in r.text


def test_only_the_console_lives_outside_api():
    outside = sorted((r.path, tuple(sorted(r.methods or ()))) for r in ROUTES
                     if isinstance(r, Route) and not r.path.startswith("/api/"))
    assert outside == [("/", ("GET", "HEAD"))] or outside == [("/", ("GET",))], outside


def test_no_websocket_routes():
    """The gate is an HTTP middleware; a WebSocket route would bypass it."""
    assert not [r for r in ROUTES if isinstance(r, WebSocketRoute)]


@pytest.mark.parametrize("url", ["/openapi.json", "/docs", "/redoc"])
def test_no_schema_pages(client, url):
    assert client.get(url, headers=TUNNEL).status_code == 404


# ── Origin (Phase 14) ──────────────────────────────────────────────────────
# Loopback needs no token, so a browser page from anywhere else must not be
# able to call in: not a site's sandboxed iframe (Origin "null", which used
# to be allowed for file:// pages), not a "simple" POST that CORS never stops
# from being SENT.

LOCAL = {"host": "127.0.0.1:8000"}


@pytest.mark.parametrize("origin", ["null", "https://evil.example", "http://localhost:3000",
                                    "https://anthonyn99.github.io.evil.example",
                                    "http://127.0.0.1:8001"])
def test_a_foreign_origin_is_refused_on_loopback(client, origin):
    for method, url in (("GET", "/api/health"), ("GET", "/api/token"),
                        ("POST", "/api/code/tasks/x/approve"), ("POST", "/api/code/projects/x/push")):
        r = client.request(method, url, headers={**LOCAL, "origin": origin},
                           content=b"approve=1", )
        assert r.status_code == 403, (origin, method, url, r.status_code)
        assert TOKEN not in r.text


def test_the_pages_console_and_the_engines_own_page_are_let_in(client):
    for origin in ("https://anthonyn99.github.io", "http://127.0.0.1:8000"):
        r = client.get("/api/health", headers={**LOCAL, "origin": origin})
        assert r.status_code == 200, origin
    # No Origin at all: curl, the MCP server, a same-origin GET.
    assert client.get("/api/health", headers=LOCAL).status_code == 200


def test_dns_rebinding_still_meets_the_token(client):
    """evil.example rebound to 127.0.0.1 is same-origin with itself -- and
    not loopback by Host, so the token gate decides."""
    h = {"host": "evil.example:8000", "origin": "http://evil.example:8000"}
    assert client.get("/api/health", headers=h).status_code == 401


def test_null_is_no_longer_a_default_origin():
    from magi.app import _allowed_origins
    assert "null" not in _allowed_origins()


def test_the_middleware_asks_the_agent_guard_on_loopback(client, monkeypatch):
    """agent_guard decides who is an agent (test_agent_guard.py); this pins
    that its answer is acted on, with the request's own ports."""
    from magi import agent_guard
    seen = []
    monkeypatch.setattr(agent_guard, "refuse",
                        lambda m, p, c, s: seen.append((m, p, c, s)) or True)
    r = client.post("/api/code/tasks/x/approve", headers=LOCAL, json={})
    assert r.status_code == 403 and "coding agent" in r.text
    assert seen and seen[0][:2] == ("POST", "/api/code/tasks/x/approve") and seen[0][2]
    seen.clear()
    # Over the tunnel it is the token's call, not the guard's.
    assert client.get("/api/health", headers=TUNNEL).status_code == 401 and not seen
