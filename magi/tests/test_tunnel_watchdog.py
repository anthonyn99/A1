"""The tunnel is replaced when it dies, not only when cloudflared exits.

Twice (2026-09-13 and 2026-09-17) the laptop slept overnight, Cloudflare deleted
the quick tunnel, and cloudflared sat retrying "Tunnel not found" forever. The
engine waited for the process to exit, which it never did, so the phone said
"engine offline" until MAGI was restarted by hand.
"""

from __future__ import annotations

import pytest

from magi.cli import serve


class FakeTunnel:
    def __init__(self):
        self.terminated = False

    def poll(self):
        return 0 if self.terminated else None

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        return 0

    def kill(self):
        self.terminated = True


@pytest.fixture
def fast(monkeypatch):
    """No real sleeping, and a clock that only moves when told to."""
    clock = {"t": 1_000_000.0}
    monkeypatch.setattr(serve.time, "sleep", lambda s: clock.__setitem__("t", clock["t"] + s))
    monkeypatch.setattr(serve.time, "time", lambda: clock["t"])
    monkeypatch.setattr(serve, "_CURRENT", {"url": "https://a.trycloudflare.com"})
    return clock


def test_a_deleted_tunnel_is_stopped_so_it_can_be_replaced(fast, tmp_path, monkeypatch):
    log = tmp_path / "cf.log"
    log.write_text('ERR Register tunnel error error="Unauthorized: Tunnel not found"')
    monkeypatch.setattr(serve, "_internet_up", lambda: True)
    t = FakeTunnel()
    why = serve._watch_tunnel(t, log, "tok")
    assert t.terminated, "the dead tunnel was left running, so nothing replaced it"
    assert "deleted" in why


def test_a_tunnel_that_stops_answering_is_replaced(fast, tmp_path, monkeypatch):
    log = tmp_path / "cf.log"
    log.write_text("INF Registered tunnel connection")
    serve._CURRENT.update(published="https://a.trycloudflare.com", published_at=str(fast["t"]))
    monkeypatch.setattr(serve, "_internet_up", lambda: True)
    monkeypatch.setattr(serve, "_public_state", lambda url: "dead")
    t = FakeTunnel()
    serve._watch_tunnel(t, log, "tok")
    assert t.terminated


def test_no_internet_is_not_a_dead_tunnel(fast, tmp_path, monkeypatch):
    """A Wi-Fi drop must not churn through tunnels that are fine."""
    log = tmp_path / "cf.log"
    log.write_text("Tunnel not found")
    t = FakeTunnel()
    checks = {"n": 0}

    def offline():
        checks["n"] += 1
        if checks["n"] >= 3:
            raise KeyboardInterrupt   # stop the test loop
        return False

    monkeypatch.setattr(serve, "_internet_up", offline)
    with pytest.raises(KeyboardInterrupt):
        serve._watch_tunnel(t, log, "tok")
    assert not t.terminated


def test_a_healthy_tunnel_is_republished_before_the_record_expires(fast, tmp_path, monkeypatch):
    """magi-link forgets a record after 36h; publishing once was not enough."""
    assert serve.REPUBLISH_EVERY_S < 36 * 3600
    log = tmp_path / "cf.log"
    log.write_text("INF Registered tunnel connection")
    serve._CURRENT.update(published="https://a.trycloudflare.com",
                          published_at=str(fast["t"] - serve.REPUBLISH_EVERY_S - 1))
    monkeypatch.setattr(serve, "_public_state", lambda url: "ok")
    published = []

    def publish(url, token):
        published.append(url)
        raise KeyboardInterrupt   # one refresh is enough to prove it

    monkeypatch.setattr(serve, "_publish", publish)
    with pytest.raises(KeyboardInterrupt):
        serve._watch_tunnel(FakeTunnel(), log, "tok")
    assert published == ["https://a.trycloudflare.com"]


def test_the_restart_loop_uses_the_watchdog_not_process_exit():
    src = (serve.__file__ and open(serve.__file__, encoding="utf-8").read())
    loop = src[src.index("# ── keep the tunnel alive"):]
    assert "_watch_tunnel(tunnel, cf_log, token)" in loop
    assert "tunnel.wait()" not in loop[: loop.index("except KeyboardInterrupt")]
