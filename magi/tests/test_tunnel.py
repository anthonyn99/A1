"""The quick tunnel: how it is launched, and how it is replaced when it dies.

Both behaviours here were bought with real symptoms. The launch flags exist
because Windows put up a firewall prompt at every single logon and clicking
Allow did not stop it; the shared _CURRENT slot exists because the keep-alive
loop gets a NEW hostname on every restart, and the verify thread must publish
the live one, not the dead one it was born with.
"""

from magi.cli import serve


def test_tunnel_binds_nothing_a_firewall_would_notice():
    """No wildcard socket -- that is the whole point of these flags.

    A quick tunnel's default QUIC transport binds an unconnected UDP socket to
    0.0.0.0, which Windows cannot distinguish from a listener, so it announces
    it. http2 carries the same tunnel over ordinary outbound TCP. The metrics
    server is the other bind, pinned to loopback.
    """
    argv = serve._cloudflared_argv(8000)
    assert argv[:2] == ["cloudflared", "tunnel"]
    assert "--url" in argv and "http://127.0.0.1:8000" in argv

    i = argv.index("--protocol")
    assert argv[i + 1] == "http2"

    j = argv.index("--metrics")
    assert argv[j + 1].startswith("127.0.0.1:")

    # cloudflared replacing its own binary underneath the firewall rules is one
    # of the few ways a settled prompt comes back.
    assert "--no-autoupdate" in argv


def test_the_current_url_is_shared_not_captured():
    """A restarted tunnel must be verified under its own hostname.

    The verify/publish worker is started fresh for each tunnel but is the same
    closure, so if it read the url it was defined beside it would check a
    hostname that stopped existing -- and either publish nothing or publish the
    dead one. It reads this slot instead.
    """
    assert serve._CURRENT["url"] == ""
    src = serve.cloud.__doc__ is not None  # sanity: we have the real module
    assert src

    import inspect
    body = inspect.getsource(serve.cloud)
    assert 'url = _CURRENT["url"]' in body
    # Set for the first tunnel and for every replacement.
    assert body.count('_CURRENT["url"] =') == 2
