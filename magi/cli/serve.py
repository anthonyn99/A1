"""`magi serve` and `magi cloud` — run the backend, optionally reachable remotely.

Between them these replace four scripts from the original project (MAGI.bat's
Python-probing launcher, MAGI-Login.bat, MAGI-Doctor.bat and the 140-line
MAGI-Cloud.ps1). Three things made that possible:

  · a pinned venv, so there is no interpreter to go hunting for;
  · magi.html being a static file the backend serves itself, so "deploy the UI"
    is not a step that exists any more; and
  · magi-link, so the tunnel url is PUBLISHED rather than compiled in --
    removing the rewrite/rebuild/redeploy cycle that made the old script long.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import sys
import webbrowser
from datetime import datetime
from pathlib import Path

from .. import ident, proc, tunnel as tunnel_mod
from ..settings import ROOT, active_profile, api_token, api_token_env, data_dir

# The account-2 worker that answers "where is MAGI right now?".
# See workers2/magi-link/worker.js.
LINK_API = os.environ.get("MAGI_LINK_API", "https://magi-link.av1-2.workers.dev/link")

QUICK_TUNNEL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

# Cloudflare blocks urllib's default User-Agent outright: a PUT to magi-link
# from Python-urllib came back 403 with error code 1010 ("banned based on your
# browser's signature"), while the identical request with a browser UA returned
# 200. The tunnel therefore came up fine and was never published -- the engine
# logged one line about it and carried on serving locally, so from a phone MAGI
# simply said "Engine offline" with nothing to explain why.
#
# This is not an attempt to look like a browser to anything that matters; it is
# the only way to talk to our OWN worker from a script.
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36")

# The tunnel hostname currently in play. The keep-alive loop below replaces the
# tunnel on failure, and each replacement gets a NEW hostname -- so the verify
# thread cannot close over the url it was started with, or a restarted tunnel
# would be checked and published under its dead predecessor's name.
_CURRENT: dict[str, str] = {"url": ""}

# ── the tunnel watchdog ──────────────────────────────────────────────────────
# How often the live tunnel is checked, and how many failed checks in a row
# (with the internet otherwise up) mean it is gone rather than blipping.
WATCH_EVERY_S = 120
DEAD_AFTER = 3
# magi-link forgets a record after 36h (workers2/magi-link TTL). A tunnel that
# stays healthy longer than that used to vanish from the phone anyway, because
# it was only ever published once. Refreshed well inside that window: four KV
# writes a day.
REPUBLISH_EVERY_S = 6 * 3600
# A gap this much longer than one watch interval means the PC was asleep.
SLEEP_GAP_S = 120
# cloudflared's words for "Cloudflare deleted this quick tunnel". It does not
# exit when this happens -- it retries a tunnel that no longer exists, forever,
# which is why waiting for the process to end never noticed (2026-09-13 and
# 2026-09-17, both after the laptop slept overnight).
TUNNEL_GONE = "Tunnel not found"


def _cloudflared_argv(port: int) -> list[str]:
    """The tunnel command, with every wildcard socket removed.

    Windows put up a "Windows Security Alert — allow cloudflared?" box at every
    single logon, and clicking Allow did not stop it: four allow rules
    (TCP+UDP x Private+Public) were already in place and it still asked. The
    prompt is not really about the rules, it is about cloudflared BINDING a
    socket that is not loopback, and a quick tunnel binds two:

      · QUIC. The default edge transport is UDP/QUIC, and an outbound UDP
        socket is bound to 0.0.0.0 with no peer -- indistinguishable from a
        listener, which is exactly what the firewall notifies on. `http2`
        carries the tunnel over ordinary outbound TCP instead, which is never
        announced. Quick tunnels support it fully; the cost is a little latency
        on reconnect, and this is a text API.

      · The metrics server, pinned to loopback on an ephemeral port so it can
        never land on a routable address.

    --no-autoupdate is part of the same fix rather than an aside: cloudflared
    replacing its own binary underneath the firewall rules is one of the few
    ways a settled prompt comes back.
    """
    return [
        "cloudflared", "tunnel",
        "--url", f"http://127.0.0.1:{port}",
        "--protocol", "http2",
        "--metrics", "127.0.0.1:0",
        "--no-autoupdate",
    ]


def _ensure_streams() -> None:
    """Give pythonw.exe somewhere to print, and leave a log behind.

    pythonw has NO CONSOLE, so sys.stdout and sys.stderr are None -- and the
    very first print() in cloud() then raises, killing the process before the
    server binds. That is exactly how the first autostart failed: the shortcut
    installed cleanly, launched pythonw, and nothing was ever listening, with
    no window and no error to say why.

    Redirecting to a file fixes that and is what a background service should do
    anyway: when the engine misbehaves at logon there is now something to read,
    which is the whole problem with an invisible process.

    Truncated per run rather than appended: this answers "why did it not come
    up THIS time", and an ever-growing log buries that under every previous
    boot.
    """
    if sys.stdout is not None and sys.stderr is not None:
        return
    log = data_dir() / "autostart.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    # line_buffering so a crash still leaves the lines that led up to it.
    f = open(log, "w", encoding="utf-8", errors="replace", buffering=1)
    sys.stdout = f
    sys.stderr = f
    print(f"=== MAGI autostart {datetime.now().isoformat(timespec='seconds')} ===")


def _free_port(port: int) -> None:
    """Kill whatever is already listening, so a stale window is not a crash.

    An earlier MAGI left running is the single most common reason the server
    fails to start, and "address already in use" does not tell you that.
    """
    with contextlib.closing(socket.socket()) as s:
        s.settimeout(0.4)
        if s.connect_ex(("127.0.0.1", port)) != 0:
            return
    if os.name != "nt":
        return
    out = proc.run(
        ["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True
    ).stdout
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[1].endswith(f":{port}") and parts[3] == "LISTENING":
            print(f"  port {port} was held by pid {parts[4]} — stopping it")
            proc.run(["taskkill", "/f", "/pid", parts[4]], capture_output=True)
            time.sleep(1)


def _serve_in_background(port: int) -> threading.Thread:
    import uvicorn

    from ..app import app

    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    )
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    return t


def _wait_healthy(port: int, timeout: float = 30) -> bool:
    """Block until the server answers at all — 401 counts, and is the point.

    A token-gated server replies 401 to an unauthenticated probe. That is a
    healthy server, so treating only 200 as "up" would hang forever in exactly
    the configuration this function exists to support.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=3)
            return True
        except urllib.error.HTTPError:
            return True
        except OSError:
            time.sleep(0.4)
    return False


def _mine(port: int) -> bool:
    """Is the server on this port THIS process?

    _wait_healthy answers "something is listening", which is not the same
    thing. A second engine that lost the bind race used to take that as its
    own health, carry on, and open a SECOND tunnel -- which is where the four
    orphaned cloudflareds found on 2026-09-19 came from. An engine that is not
    the one serving has nothing useful to do and must not tunnel.
    """
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/health", timeout=3
        ) as r:
            body = json.loads(r.read().decode("utf-8", "replace"))
        return body.get("instance") == ident.INSTANCE
    except urllib.error.HTTPError:
        # Token-gated from a different origin should not happen on loopback,
        # but an answer at all means SOMETHING is serving; treat it as foreign.
        return False
    except (OSError, ValueError):
        return False


def run(port: int = 8000, open_browser: bool = True) -> int:
    """Local only. The UI is same-origin at http://127.0.0.1:<port>."""
    _ensure_streams()
    _free_port(port)
    print(f"\n  MAGI → http://127.0.0.1:{port}")
    print("  Council members open their own Chrome windows while answering —")
    print("  that is normal. Ctrl+C to stop.\n")
    if open_browser:
        threading.Timer(1.5, webbrowser.open, [f"http://127.0.0.1:{port}"]).start()

    import uvicorn

    from ..app import app

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
    return 0


def _serve_only(port: int, why: str) -> int:
    """Fall back to local-only serving instead of exiting.

    Every tunnel failure below used to `return 1`, which killed the process --
    and with it the backend running in a daemon thread. That is tolerable when
    a person typed the command and can read the error, but `magi autostart`
    runs this at logon with nobody watching: a momentary cloudflared or DNS
    hiccup would leave NO backend at all, so opening the console on this very
    PC would fail too. Degrading to local-only keeps the thing that always
    works, working.
    """
    print(f"  [!] {why}")
    print(f"  Serving LOCALLY only — http://127.0.0.1:{port} still works.")
    print("  Re-run `magi cloud` once the tunnel problem is fixed.\n")
    threading.Event().wait()
    return 0


def _publish(url: str, token: str) -> None:
    body = f'{{"url": {url!r}, "host": {socket.gethostname()!r}}}'.replace("'", '"')
    req = urllib.request.Request(
        LINK_API,
        data=body.encode(),
        method="PUT",
        headers={"content-type": "application/json", "X-MAGI-Token": token,
                 "User-Agent": UA},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        r.read()


def _withdraw(token: str) -> None:
    req = urllib.request.Request(
        LINK_API, method="DELETE",
        headers={"X-MAGI-Token": token, "User-Agent": UA}
    )
    with contextlib.suppress(Exception):
        urllib.request.urlopen(req, timeout=10).read()


def _public_state(url: str) -> str:
    """"ok" if the tunnel reaches the backend, "dead" if it does not.

    A 401 is the healthy answer: the request crossed the tunnel and the token
    gate turned it away. Anything else from Cloudflare (530, 404, 502) or no
    answer at all means the hostname no longer leads here.
    """
    try:
        urllib.request.urlopen(
            urllib.request.Request(f"{url}/api/health", headers={"User-Agent": UA}),
            timeout=15)
        return "ok"   # ungated, but reachable; the publish step refuses those
    except urllib.error.HTTPError as e:
        return "ok" if e.code == 401 else "dead"
    except OSError:
        return "dead"


def _internet_up() -> bool:
    """Whether this PC can reach Cloudflare at all.

    Without this, a Wi-Fi drop would look exactly like a dead tunnel and the
    watchdog would churn through tunnels that were fine all along.
    """
    try:
        urllib.request.urlopen(
            urllib.request.Request(LINK_API, headers={"User-Agent": UA}), timeout=10)
        return True
    except urllib.error.HTTPError:
        return True   # any HTTP answer at all proves the route is up
    except OSError:
        return False


def _log_says_gone(cf_log: Path) -> bool:
    """Has cloudflared said THIS tunnel is gone?

    Only lines written since this engine took charge count. An adopted log
    carries previous sessions' lines, and a "Tunnel not found" from a tunnel
    that died last week would make the watchdog kill a perfectly healthy
    adopted tunnel on its first pass -- silently undoing adoption.
    """
    try:
        start = int(_CURRENT.get("log_from") or 0)
        with open(cf_log, "rb") as f:
            f.seek(min(start, cf_log.stat().st_size))
            text = f.read(2_000_000).decode("utf-8", "replace")
        return TUNNEL_GONE in text
    except OSError:
        return False


def _watch_tunnel(tunnel, cf_log: Path, token: str) -> str:
    """Block until the tunnel has to be replaced; return why.

    Ends the cloudflared process itself when the tunnel is dead but the
    process is not, so the caller's replace-and-republish loop runs.
    """
    fails = 0
    last = time.time()
    while True:
        if tunnel.poll() is not None:
            return "cloudflared exited"
        # Slept in short steps so a wake from sleep is noticed at once rather
        # than a full interval later.
        woke = False
        for _ in range(WATCH_EVERY_S // 5):
            time.sleep(5)
            now = time.time()
            if now - last > SLEEP_GAP_S:
                woke = True
            last = now
            if woke or tunnel.poll() is not None:
                break
        if tunnel.poll() is not None:
            return "cloudflared exited"
        if woke:
            print("  [.] woke from sleep; checking the tunnel.")
            # A network stack coming back up needs a moment before a probe
            # means anything.
            time.sleep(20)

        url = _CURRENT.get("url", "")
        published = _CURRENT.get("published") == url

        why = ""
        if _log_says_gone(cf_log):
            why = "Cloudflare deleted the tunnel"
        elif published:
            if _public_state(url) == "ok":
                fails = 0
            else:
                fails += 1
                if fails >= DEAD_AFTER:
                    why = f"the tunnel stopped answering ({fails} checks)"
        if why:
            if not _internet_up():
                # Nothing to fix from here; check again next round.
                fails = 0
                continue
            print(f"  [!] {why}; replacing it.")
            _stop(tunnel)
            return why

        if published and time.time() - float(_CURRENT.get("published_at") or 0) > REPUBLISH_EVERY_S:
            try:
                _publish(url, token)
                _CURRENT["published_at"] = str(time.time())
            except Exception as e:  # noqa: BLE001
                print(f"  [!] could not refresh the magi-link record: {e}")


def _stop(tunnel) -> None:
    tunnel.terminate()
    try:
        tunnel.wait(timeout=10)
    except Exception:  # noqa: BLE001
        with contextlib.suppress(Exception):
            tunnel.kill()


def _link_record(token: str) -> dict | None:
    """What magi-link currently says, so adoption can keep that record rather
    than replace it (and so `age_s` keeps climbing across a restart)."""
    try:
        req = urllib.request.Request(
            LINK_API, headers={"X-MAGI-Token": token, "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001 -- no record is a normal answer here
        return None


# ── reaching a brand-new tunnel without asking Windows ──────────────────────
# cloudflared registers a quick tunnel in about four seconds. Publishing it
# used to take minutes, and none of that time was Cloudflare's.
#
# The verify step probed the new hostname through the OS resolver straight
# away -- before Cloudflare's DNS had the record -- and got NXDOMAIN. Windows'
# DNS Client caches a negative answer (MaxNegativeCacheTtl, up to fifteen
# minutes), so every retry after that was answered from the cache with "does
# not exist", long after the record did. The tunnel was up and reachable the
# whole time; MAGI had simply asked too early and been told to stop asking.
#
# So the probe no longer touches the OS resolver at all. It asks Cloudflare's
# own DNS-over-HTTPS resolver -- which learns trycloudflare records within
# seconds, and caches nothing on this machine -- and then connects straight to
# the address it returned, with the real hostname in SNI and Host so TLS and
# routing behave exactly as they will for the phone.
#
# The phone never had this problem: it only learns the hostname AFTER it is
# published, by which point the record exists.

def _doh_resolve(host: str) -> list[str]:
    """A records for `host` from Cloudflare DoH. [] means "not yet"."""
    req = urllib.request.Request(
        f"https://cloudflare-dns.com/dns-query?name={host}&type=A",
        headers={"accept": "application/dns-json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=5) as r:
        data = json.loads(r.read())
    return [a["data"] for a in data.get("Answer") or [] if a.get("type") == 1]


def _probe_via_ip(host: str, ip: str, path: str = "/api/health") -> int:
    """HTTP status from `host` reached at `ip`, bypassing name resolution."""
    import ssl

    ctx = ssl.create_default_context()
    with socket.create_connection((ip, 443), timeout=8) as raw:
        with ctx.wrap_socket(raw, server_hostname=host) as s:
            s.sendall(
                (f"GET {path} HTTP/1.1\r\nHost: {host}\r\n"
                 f"User-Agent: {UA}\r\nConnection: close\r\n\r\n").encode())
            head = s.recv(256)
    status_line = head.split(b"\r\n", 1)[0].decode("latin-1")
    return int(status_line.split()[1])


def _tunnel_status(url: str) -> int | None:
    """The tunnel's answer to /api/health, or None if it is not reachable yet."""
    from urllib.parse import urlparse

    host = urlparse(url).hostname or ""
    try:
        ips = _doh_resolve(host)
    except Exception:
        return None
    for ip in ips:
        try:
            return _probe_via_ip(host, ip)
        except Exception:
            continue
    return None


def _verify_and_publish(token: str, kill) -> None:
    """Wait for a fresh hostname to register, then publish it.

    Runs on a background thread: the local server is never held up by DNS.
    Reads the url from _CURRENT rather than closing over one, so a tunnel
    replaced while this was waiting is never published under the dead name.
    """
    url = _CURRENT["url"]
    started = time.time()
    deadline = started + 15 * 60
    while time.time() < deadline:
        # A replacement tunnel took over while this one waited: stop, so the
        # dead name is never published over the live one.
        if _CURRENT.get("url") != url:
            return
        code = _tunnel_status(url)
        if code is None:
            # Every second, not a growing backoff. The record usually lands
            # within ten, and a probe that skips no OS cache costs one DoH
            # request -- backing off to thirty seconds only delayed the
            # publish by up to thirty seconds past the moment it was live.
            time.sleep(1)
            continue
        if code == 200:
            # The server started WITHOUT the token and is wide open.
            # Publishing that hands the url -- and the accounts behind it --
            # to anyone who reads the KV record.
            print("  [!] /api/health answered 200 without a token -- the gate")
            print("      is OFF, so the tunnel was NOT published. The backend")
            print(f"      did not inherit {api_token_env()}; open a new terminal.")
            kill()
            return
        if code != 401:
            print(f"  [!] tunnel answered {code}; not publishing.")
            kill()
            return
        # 401 is the CORRECT answer: the tunnel reaches this backend AND the
        # token gate is armed.
        print(f"  tunnel reachable after {time.time() - started:.1f}s")
        break
    else:
        print("  [!] the tunnel url never resolved in 15 minutes.")
        print("      Local access is unaffected.")
        kill()
        return

    try:
        _publish(url, token)
    except Exception as e:  # noqa: BLE001 -- the cause is what matters here
        print(f"  [!] could not publish to magi-link: {e}")
        print("      Local access is unaffected.")
        return
    # Only for the url this worker verified: a replacement tunnel may have
    # taken over while it was waiting on DNS.
    if _CURRENT.get("url") == url:
        _CURRENT["published"] = url
        _CURRENT["published_at"] = str(time.time())
        # Written back to disk too. It used to live only in memory, so
        # tunnel.json said published_at: null for a tunnel that WAS
        # published -- which is exactly what sent a diagnosis down the
        # wrong path, looking for a publish failure that never happened.
        with contextlib.suppress(Exception):
            tunnel_mod.mark_published(url, time.time())
    print("  published -- https://anthonyn99.github.io/A1/magi.html now reaches this PC")


def _keep_tunnel(tunnel, cf_log: Path, token: str, port: int) -> int:
    """Watch the tunnel, and replace it when it dies.

    A quick tunnel is not a durable thing: cloudflared drops out on a network
    blip, on sleep/wake, or when Cloudflare recycles the hostname. The first
    version simply stopped tunnelling at that point and served locally for the
    rest of the session -- fine at the desk, useless from a phone, where the
    tunnel is the ONLY route in.

    Each replacement gets a NEW hostname, which is what magi-link is for:
    republish, and the phone follows on its next look. Every replacement also
    reaps whatever else is on this port, so strays cannot pile up.
    """
    print("  Ctrl+C to stop.\n")
    delay = 5
    try:
        while True:
            why = _watch_tunnel(tunnel, cf_log, token)
            print(f"  [!] the tunnel ended ({why}); restarting in {delay}s.")
            _withdraw(token)
            tunnel_mod.clear()
            time.sleep(delay)
            delay = min(delay * 2, 60)
            tunnel_mod.reap(port, keep=None)
            try:
                handle = open(cf_log, "w", encoding="utf-8", errors="replace")
                tunnel = proc.popen(
                    _cloudflared_argv(port), stdout=handle, stderr=handle,
                )
            except FileNotFoundError:
                return _serve_only(port, "cloudflared has gone missing.")
            _CURRENT["log_from"] = "0"

            fresh = None
            deadline = time.time() + 60
            while time.time() < deadline and tunnel.poll() is None:
                time.sleep(1.5)
                try:
                    m = QUICK_TUNNEL.search(
                        cf_log.read_text(encoding="utf-8", errors="replace"))
                except OSError:
                    continue
                if m:
                    fresh = m.group(0)
                    break
            if not fresh:
                tunnel.terminate()
                continue
            print(f"  {fresh}")
            _CURRENT["url"] = fresh
            tunnel_mod.record(tunnel.pid, fresh, port)
            # A replaced-but-not-dead cloudflared would linger otherwise, and
            # the orphan pile this change exists to end would rebuild itself.
            tunnel_mod.reap(port, keep=tunnel.pid)
            threading.Thread(
                target=_verify_and_publish, args=(token, tunnel.terminate), daemon=True
            ).start()
            delay = 5
    except KeyboardInterrupt:
        pass
    finally:
        # Withdraw on the way out, so the console says "offline" instead of
        # hanging on a tunnel that closed with the process.
        _withdraw(token)
        tunnel_mod.clear()
        tunnel.terminate()

    return _serve_only(port, "the tunnel was stopped.")


def cloud(port: int = 8000) -> int:
    """Local + reachable from anywhere, via a quick tunnel this publishes."""
    _ensure_streams()
    token = api_token()

    _free_port(port)
    print("  starting backend…")
    _serve_in_background(port)
    if not _wait_healthy(port):
        print("  [X] backend never came up on 127.0.0.1:%d" % port)
        return 1
    if not _mine(port):
        # Another engine owns the port. Two engines means two tunnels and two
        # writers to one database; the one that is not serving bows out.
        print("  [X] another MAGI engine is already serving 127.0.0.1:%d." % port)
        print("      This one is stopping rather than running as a ghost.")
        return 1

    # No token means no tunnel — publishing an UNGATED backend would expose
    # endpoints that drive live paid accounts to anyone who learns the url.
    # But the local backend is already up and is not the thing at risk, so it
    # keeps serving rather than the whole command failing.
    if not token:
        print(f"\n  {api_token_env()} is not set.")
        print("  A quick tunnel cannot sit behind Cloudflare Access, so this")
        print("  shared secret is the only thing gating endpoints that drive")
        print("  your paid accounts. Set one, then open a NEW terminal:\n")
        print(f'      setx {api_token_env()} "<a long random string>"\n')
        return _serve_only(port, "no tunnel opened — the API would be ungated.")

    # ── adopt the tunnel the previous engine left running ────────────────
    #
    # A quick tunnel's hostname is random and takes seconds to minutes to
    # register in DNS, so opening a new one costs every phone a long spell of
    # "Your PC is offline" -- on every restart, including the ones MAGI does
    # to itself. The tunnel points at the local port, which is not tied to this
    # process, so a surviving one is adopted instead: same url, same magi-link
    # record, nothing withdrawn and nothing republished.
    cf_log = data_dir() / "cloudflared.log"
    cf_log.parent.mkdir(parents=True, exist_ok=True)
    adopted = None
    if os.environ.get("MAGI_ADOPT_TUNNEL", "1") != "0":
        try:
            adopted = tunnel_mod.adopt(
                port, token, cf_log, UA, _link_record(token), internet_up=_internet_up,
            )
        except Exception as e:  # noqa: BLE001 — never let this stop the engine
            print(f"  [!] could not check for a running tunnel: {e}")
            adopted = None

    if adopted is not None:
        _CURRENT["url"] = adopted.url
        _CURRENT["published"] = adopted.url
        _CURRENT["published_at"] = str(adopted.published_at or time.time())
        # Only lines written from here on describe THIS tunnel.
        _CURRENT["log_from"] = str(adopted.log_size)
        print(f"  adopted the running tunnel — {adopted.url}")
        print(f"\n  MAGI → http://127.0.0.1:{port}  (and at the same url as before)")
        print("  This PC must stay awake and logged in — the Chrome profiles are here.")
        return _keep_tunnel(adopted.proc, cf_log, token, port)

    # Clear the old record BEFORE opening a new tunnel.
    #
    # The previous hostname is dead the moment this process starts -- _free_port
    # has just killed whatever held the port, and a quick tunnel dies with the
    # process that opened it. But magi-link keeps serving that hostname until
    # the replacement is verified and published, which takes as long as public
    # DNS takes to catch up: measured at several minutes. For that whole window
    # the phone follows the record to a hostname that answers 530, and the
    # console says "tunnel is dead" -- which reads as "your engine is broken"
    # when the truth is "it is thirty seconds into starting up".
    #
    # An unclean exit is the case that matters here. A clean one withdraws in
    # the `finally` below; a crash, a power cut or a force-kill does not, and
    # those are exactly the times MAGI is restarted.
    _withdraw(token)

    # Nothing here is worth keeping: reap every cloudflared on this port so a
    # stray from an earlier run cannot outlive this one.
    tunnel_mod.reap(port, keep=None)
    tunnel_mod.clear()
    print("  opening tunnel…")
    # cloudflared's output goes to a FILE, not a pipe.
    #
    # A pipe has to be drained or the writer blocks once the OS buffer fills,
    # and cloudflared is chatty -- it logs every connection, every precheck and
    # a heartbeat forever. The first version read the pipe only until it found
    # the url and then handed it to a drain thread, and tunnels launched that
    # way kept printing a hostname that never registered, while the same
    # command run with its stderr redirected to a file registered in ~6s.
    # Whatever the precise mechanism, a file has no such failure mode, needs no
    # reader, and leaves the one thing that was missing while diagnosing this:
    # cloudflared's own account of what it did.
    try:
        cf_handle = open(cf_log, "w", encoding="utf-8", errors="replace")
        tunnel = proc.popen(
            _cloudflared_argv(port), stdout=cf_handle, stderr=cf_handle,
        )
    except FileNotFoundError:
        return _serve_only(port, "cloudflared is not installed "
                                 "(winget install --id Cloudflare.cloudflared).")

    # The url appears a few seconds in, so poll the log rather than sleeping a
    # fixed amount.
    url = None
    deadline = time.time() + 60
    while time.time() < deadline and tunnel.poll() is None:
        time.sleep(1.5)
        try:
            m = QUICK_TUNNEL.search(cf_log.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        if m:
            url = m.group(0)
            break
    if not url:
        tunnel.terminate()
        return _serve_only(port, f"cloudflared never printed a tunnel url (see {cf_log}).")
    print(f"  {url}")

    # Verification and publishing happen on a background thread; the local
    # server is never held up waiting for DNS. See _verify_and_publish.
    _CURRENT["url"] = url
    _CURRENT["log_from"] = "0"
    tunnel_mod.record(tunnel.pid, url, port)
    threading.Thread(
        target=_verify_and_publish, args=(token, tunnel.terminate), daemon=True
    ).start()

    print(f"\n  MAGI -> http://127.0.0.1:{port}  (and over the tunnel once it registers)")
    print("  This PC must stay awake and logged in -- the Chrome profiles are here.")
    return _keep_tunnel(tunnel, cf_log, token, port)


# ── autostart ───────────────────────────────────────────────────────────────
# MAGI is the one A1 program that is not just a page: the console cannot work
# unless the engine is running on this PC, because the Chrome profiles live
# here. Having to launch magi.bat first makes it the only program in the suite
# with a manual step, and a page that is dead until you remember to do
# something is a page you stop opening.
#
# TWO SCHEDULED TASKS, not a Startup shortcut.
#
# The shortcut was the original choice because an early Register-ScheduledTask
# attempt failed with "Access is denied", and an autostart that needs an admin
# prompt is not an autostart. Re-tested 2026-09-19: a task registered for the
# CURRENT USER with an Interactive principal needs no elevation at all. What
# the shortcut cannot do is the thing that actually went wrong -- it fires once
# at logon and never again, so when the engine died (a bad import, a crash, a
# reboot that raced the network) MAGI stayed down until somebody noticed. That
# is exactly what happened after a restart on 2026-09-19.
#
#   MAGI Engine    — At log on. Starts the engine, restarts it if it fails,
#                    and is allowed to run on battery and forever.
#   MAGI Watchdog  — At log on and every 2 minutes after. Starts the engine if
#                    nothing answers on 127.0.0.1:8000 (magi/watchdog.py).
#
# Together: up within seconds of logging in, and never down for more than a
# couple of minutes while the laptop is on.
#
# pythonw.exe, not python.exe: a console window on every logon is precisely the
# thing this exists to remove.
SHORTCUT_NAME = "MAGI.lnk"
# Per profile, so two engines on one PC each get their own pair. Tony keeps
# the unsuffixed names, which is what his already-registered tasks are called.
from ..watchdog import task_engine, task_watchdog  # noqa: E402


def _task_args() -> str:
    """What the scheduled command needs in order to start the RIGHT engine.

    Empty for the default profile, so Tony's task keeps the exact command
    line it already has and re-registering is a no-op rather than a change.
    """
    from ..settings import DEFAULT_PROFILE, active_profile

    p = active_profile()
    return "" if p == DEFAULT_PROFILE else f" --profile {p}"


def _startup_dir() -> Path:
    return (
        Path(os.environ["APPDATA"])
        / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    )


def _run_ps(script: str) -> tuple[int, str]:
    r = proc.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True,
    )
    return r.returncode, (r.stdout or r.stderr).strip()


def _task_script(pyw: Path, root: Path, port: int) -> str:
    """PowerShell that (re)registers both tasks for the current user.

    -Force replaces an existing registration, so this is safe to run again and
    is how an upgrade lands. ExecutionTimeLimit 0 means "no limit": without it
    Windows kills the engine after three days, which is a bug that would take
    a week to notice.
    """
    # Raw: the script below is PowerShell, where a backslash is just a
    # character -- "DOMAIN\\user" must survive into it untouched.
    return rf"""
$ErrorActionPreference = 'Stop'
$pyw  = '{pyw}'
$root = '{root}'
$user = "$env:USERDOMAIN\$env:USERNAME"

$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
             -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$settings.DisallowStartOnRemoteAppSession = $false
$settings.StopIfGoingOnBatteries = $false

# 1. the engine itself, at logon
$action  = New-ScheduledTaskAction -Execute $pyw -Argument '-m magi cloud{_task_args()}' -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
Register-ScheduledTask -TaskName '{task_engine()}' -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Description 'MAGI council engine' -Force | Out-Null

# 2. the watchdog: at logon, then every 2 minutes for as long as the session
#    lasts. A repeating trigger has to be borrowed from a -Once trigger; there
#    is no -RepetitionInterval on -AtLogOn.
$wSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
             -MultipleInstances IgnoreNew
$wSettings.StopIfGoingOnBatteries = $false
$wAction = New-ScheduledTaskAction -Execute $pyw -Argument '-m magi.watchdog{_task_args()}' -WorkingDirectory $root
$repeat  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
           -RepetitionInterval (New-TimeSpan -Minutes 2)
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
Register-ScheduledTask -TaskName '{task_watchdog()}' -Action $wAction -Trigger @($atLogon, $repeat) `
    -Principal $principal -Settings $wSettings -Description 'Starts MAGI if it is not running' -Force | Out-Null

if ((Get-ScheduledTask -TaskName '{task_engine()}' -ErrorAction SilentlyContinue) -and
    (Get-ScheduledTask -TaskName '{task_watchdog()}' -ErrorAction SilentlyContinue)) {{ 'ok' }}
else {{ throw 'tasks did not register' }}
"""


def autostart(action: str = "on", port: int = 8000) -> int:
    if os.name != "nt":
        print("  autostart is Windows-only (it registers Scheduled Tasks).")
        return 1

    lnk = _startup_dir() / SHORTCUT_NAME

    if action == "status":
        code, out = _run_ps(
            f"@('{task_engine()}','{task_watchdog()}') | ForEach-Object {{ "
            "$t = Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue; "
            "if ($t) { $i = $t | Get-ScheduledTaskInfo; "
            "\"$($_): $($t.State), last run $($i.LastRunTime), result $($i.LastTaskResult)\" } "
            "else { \"$($_): NOT INSTALLED\" } }"
        )
        print()
        for line in (out or "").splitlines():
            print(f"  {line}")
        if lnk.exists():
            print(f"  (old Startup shortcut still present: {lnk})")
        alive = _wait_healthy(port, timeout=2)
        print(f"  backend on 127.0.0.1:{port}: {'up' if alive else 'not responding'}")
        print()
        return 0

    if action == "off":
        _run_ps(
            f"@('{task_engine()}','{task_watchdog()}') | ForEach-Object {{ "
            "Unregister-ScheduledTask -TaskName $_ -Confirm:$false "
            "-ErrorAction SilentlyContinue }"
        )
        with contextlib.suppress(FileNotFoundError):
            lnk.unlink()
        print("\n  Removed the MAGI tasks — the engine no longer starts by itself.")
        print("  Any engine already running is left alone.\n")
        return 0

    root = ROOT.parent                      # the A1 repo root
    pyw = ROOT / ".venv" / "Scripts" / "pythonw.exe"
    if not pyw.exists():
        print(f"\n  [X] {pyw} is missing. Run `magi setup` first.\n")
        return 1

    code, out = _run_ps(_task_script(pyw, root, port))
    # Checked rather than assumed: an earlier version printed its own success
    # message regardless of what the cmdlet did.
    if code != 0 or "ok" not in (out or ""):
        print(f"\n  [X] could not register the tasks:\n{out}\n")
        return 1

    # The Startup shortcut would now start a SECOND engine at logon, which the
    # new one would refuse to coexist with. The tasks replace it.
    if lnk.exists():
        with contextlib.suppress(OSError):
            lnk.unlink()
            print(f"  Removed the old {lnk.name}; the tasks replace it.")

    print(f"\n  Installed '{task_engine()}' and '{task_watchdog()}'.")
    print("  The engine starts when you log in, and is restarted within two")
    print("  minutes if it ever stops while the laptop is on.")

    if _wait_healthy(port, timeout=2):
        print(f"  Already running. Open http://127.0.0.1:{port}\n")
        return 0

    print("  Starting it now…")
    proc.popen([str(pyw), "-m", "magi", "cloud"], cwd=str(root))
    if _wait_healthy(port, timeout=60):
        print(f"\n  MAGI is up. Open http://127.0.0.1:{port}\n")
        return 0
    print("\n  [!] it did not answer within 60s; see magi\\data\\autostart.log\n")
    return 1
