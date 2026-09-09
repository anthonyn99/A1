"""Who has to present the API token.

The token exists to protect the TUNNEL. uvicorn binds 127.0.0.1, so a request
that did not arrive through cloudflared came from a process already on this PC
-- and demanding a shared secret to reach a server on your own machine, from a
page that same server just served you, is friction with nothing behind it.

That is not hypothetical: setting MAGI_API_TOKEN for the tunnel made `GET /`
return the console while every `GET /api/*` it made came back 401, so the
console could not talk to the backend it was running on.

These pin both directions -- the gate drops for local, and holds for anything
tunnel-shaped -- because getting the second one wrong exposes endpoints that
drive live paid accounts.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from magi.app import _arrived_over_the_tunnel  # noqa: E402


class _Req:
    def __init__(self, headers):
        self.headers = {k.lower(): v for k, v in headers.items()}


def _remote(**headers) -> bool:
    return _arrived_over_the_tunnel(_Req(headers))


def test_local_requests_are_not_gated():
    assert not _remote(host="127.0.0.1:8000")
    assert not _remote(host="localhost:8000")
    assert not _remote(host="127.0.0.1")


def test_ipv6_loopback_is_local():
    """Chrome really does dial ::1 for localhost.

    The bracketed form defeats a naive split(":"), and getting it wrong locks
    the console out of the backend on the very machine it runs on.
    """
    assert not _remote(host="[::1]:8000")
    assert not _remote(host="[::1]")


def test_tunnel_hostname_is_gated():
    assert _remote(host="abc-def.trycloudflare.com")


def test_cloudflare_headers_gate_even_on_a_loopback_host():
    """Either signal alone means remote, so one being spoofed is not enough.

    cloudflared attaches these to everything it forwards. Trusting the Host
    header alone would let a forwarded request that kept a loopback Host slip
    the gate entirely.
    """
    assert _remote(host="127.0.0.1:8000", **{"cf-ray": "8a1b2c3d"})
    assert _remote(host="127.0.0.1:8000", **{"cf-connecting-ip": "1.2.3.4"})


def test_lan_and_missing_host_are_gated():
    """Fail CLOSED: anything not provably loopback is treated as remote."""
    assert _remote(host="192.168.0.27:8000")
    assert _remote(host="magi.example.com")
    assert _remote()
