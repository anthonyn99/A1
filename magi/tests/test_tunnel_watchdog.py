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
    # The loop moved out of cloud() into its own function, shared by the
    # fresh-tunnel and adopted-tunnel paths.
    import inspect
    loop = inspect.getsource(serve._keep_tunnel)
    assert "_watch_tunnel(tunnel, cf_log, token)" in loop
    assert "tunnel.wait()" not in loop[: loop.index("except KeyboardInterrupt")]


def test_a_resolver_that_cannot_see_the_tunnel_does_not_make_it_dead(monkeypatch):
    """2026-09-28: Veda's PC negative-cached every fresh hostname, so the
    watchdog judged healthy tunnels dead and replaced one every ~5 minutes --
    275 magi-link writes that day. The probe must not ask the OS resolver
    first when Cloudflare DoH knows the address."""
    from magi import tunnel

    monkeypatch.setattr(tunnel, "doh_resolve", lambda host, ua: ["104.16.0.1"])

    class Resp:
        status = 401

        def read(self):
            return b""

    monkeypatch.setattr(tunnel._PinnedHTTPS, "request", lambda self, *a, **k: None)
    monkeypatch.setattr(tunnel._PinnedHTTPS, "getresponse", lambda self: Resp())

    def os_resolver(*a, **k):
        raise OSError("getaddrinfo failed (negative-cached)")

    monkeypatch.setattr(tunnel.urllib.request, "urlopen", os_resolver)
    assert serve._public_state("https://a.trycloudflare.com") == "ok"


def test_the_os_resolver_is_only_a_fallback_for_the_watchdog(monkeypatch):
    from magi import tunnel

    monkeypatch.setattr(tunnel, "doh_resolve", lambda host, ua: [])
    asked = []

    def os_resolver(*a, **k):
        asked.append(1)
        raise OSError("down")

    monkeypatch.setattr(tunnel.urllib.request, "urlopen", os_resolver)
    assert serve._public_state("https://a.trycloudflare.com") == "dead"
    assert asked, "with DoH empty the OS resolver is the fallback"
    asked.clear()
    # ...but verify-before-publish never touches it (that plants the cache entry)
    assert serve._tunnel_status("https://a.trycloudflare.com") is None
    assert not asked


def test_a_churning_tunnel_is_braked(monkeypatch, tmp_path):
    """However the churn starts, it must not spend the KV budget unchecked."""
    sleeps: list[float] = []
    monkeypatch.setattr(serve.time, "sleep", lambda s: sleeps.append(s))
    monkeypatch.setattr(serve, "_watch_tunnel", lambda *a: "dead")
    monkeypatch.setattr(serve, "_withdraw", lambda token: None)
    monkeypatch.setattr(serve.tunnel_mod, "clear", lambda: None)
    monkeypatch.setattr(serve.tunnel_mod, "reap", lambda *a, **k: 0)
    opened = {"n": 0}

    def popen(*a, **k):
        opened["n"] += 1
        if opened["n"] > serve.CHURN_MAX:
            raise KeyboardInterrupt
        t = FakeTunnel()
        t.terminated = True   # never prints a url -> loop straight round
        return t

    monkeypatch.setattr(serve.proc, "popen", popen)
    monkeypatch.setattr(serve, "_serve_only", lambda port, why: 0)
    serve._keep_tunnel(FakeTunnel(), tmp_path / "cf.log", "tok", 8000)
    assert max(sleeps) >= serve.CHURN_COOLDOWN_S
    assert sleeps.count(max(sleeps)) == 1, "only the replacement past CHURN_MAX waits"


def test_a_refused_publish_is_retried_while_the_tunnel_is_healthy(fast, tmp_path, monkeypatch):
    """magi-link's hourly cap answers 429. A tunnel that then STAYS healthy
    must still get published, or the phone says offline indefinitely."""
    log = tmp_path / "cf.log"
    log.write_text("INF Registered tunnel connection")
    serve._CURRENT.update(verified="https://a.trycloudflare.com", publish_tried=str(fast["t"]))
    monkeypatch.setattr(serve, "_public_state", lambda url: "ok")
    monkeypatch.setattr(serve.tunnel_mod, "mark_published", lambda *a: None)
    calls = []

    def publish(url, token):
        calls.append(fast["t"])
        if len(calls) == 1:
            raise OSError("HTTP Error 429: Too Many Requests")
        raise KeyboardInterrupt   # second attempt proves the retry

    monkeypatch.setattr(serve, "_publish", publish)

    def sleep(s):   # bounded, so a missing retry fails instead of hanging
        fast["t"] += s
        if fast["t"] - 1_000_000.0 > 3 * serve.PUBLISH_RETRY_S + 600:
            raise KeyboardInterrupt

    monkeypatch.setattr(serve.time, "sleep", sleep)
    with pytest.raises(KeyboardInterrupt):
        serve._watch_tunnel(FakeTunnel(), log, "tok")
    assert len(calls) == 2
    assert calls[0] - 1_000_000.0 >= serve.PUBLISH_RETRY_S, "retried before the retry interval"
    assert calls[1] - calls[0] >= serve.PUBLISH_RETRY_S


def test_an_unverified_tunnel_is_never_published_by_the_retry(fast, tmp_path, monkeypatch):
    log = tmp_path / "cf.log"
    log.write_text("INF Registered tunnel connection")
    monkeypatch.setattr(serve, "_public_state", lambda url: "ok")
    monkeypatch.setattr(serve, "_publish", lambda *a: pytest.fail("published an unverified url"))
    ticks = {"n": 0}
    real_sleep = serve.time.sleep

    def sleep(s):
        ticks["n"] += 1
        if ticks["n"] > 400:
            raise KeyboardInterrupt
        real_sleep(s)

    monkeypatch.setattr(serve.time, "sleep", sleep)
    with pytest.raises(KeyboardInterrupt):
        serve._watch_tunnel(FakeTunnel(), log, "tok")
