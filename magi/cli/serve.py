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
import os
import re
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import webbrowser

# The account-2 worker that answers "where is MAGI right now?".
# See workers2/magi-link/worker.js.
LINK_API = os.environ.get("MAGI_LINK_API", "https://magi-link.av1-2.workers.dev/link")

QUICK_TUNNEL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


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
    out = subprocess.run(
        ["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True
    ).stdout
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[1].endswith(f":{port}") and parts[3] == "LISTENING":
            print(f"  port {port} was held by pid {parts[4]} — stopping it")
            subprocess.run(["taskkill", "/f", "/pid", parts[4]], capture_output=True)
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


def run(port: int = 8000, open_browser: bool = True) -> int:
    """Local only. The UI is same-origin at http://127.0.0.1:<port>."""
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


def _publish(url: str, token: str) -> None:
    body = f'{{"url": {url!r}, "host": {socket.gethostname()!r}}}'.replace("'", '"')
    req = urllib.request.Request(
        LINK_API,
        data=body.encode(),
        method="PUT",
        headers={"content-type": "application/json", "X-MAGI-Token": token},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        r.read()


def _withdraw(token: str) -> None:
    req = urllib.request.Request(
        LINK_API, method="DELETE", headers={"X-MAGI-Token": token}
    )
    with contextlib.suppress(Exception):
        urllib.request.urlopen(req, timeout=10).read()


def cloud(port: int = 8000) -> int:
    """Local + reachable from anywhere, via a quick tunnel this publishes."""
    token = os.environ.get("MAGI_API_TOKEN", "").strip()
    if not token:
        print("\n  MAGI_API_TOKEN is not set.\n")
        print("  A quick tunnel cannot sit behind Cloudflare Access, so this")
        print("  shared secret is the only thing gating endpoints that drive")
        print("  your paid accounts. Set one, then open a NEW terminal:\n")
        print('      setx MAGI_API_TOKEN "<a long random string>"\n')
        return 1

    _free_port(port)
    print("  starting backend…")
    _serve_in_background(port)
    if not _wait_healthy(port):
        print("  [X] backend never came up on 127.0.0.1:%d" % port)
        return 1

    print("  opening tunnel…")
    try:
        proc = subprocess.Popen(
            ["cloudflared", "tunnel", "--url", f"http://127.0.0.1:{port}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
    except FileNotFoundError:
        print("  [X] cloudflared is not installed.")
        print("      winget install --id Cloudflare.cloudflared")
        return 1

    # cloudflared prints the url on stderr a few seconds in. Read the stream
    # rather than sleeping a fixed amount, and keep draining it afterwards --
    # a full stderr pipe blocks the process that is holding the tunnel open.
    url = None
    deadline = time.time() + 60
    while time.time() < deadline and proc.poll() is None:
        line = proc.stderr.readline()
        if not line:
            continue
        m = QUICK_TUNNEL.search(line)
        if m:
            url = m.group(0)
            break
    if not url:
        print("  [X] cloudflared never printed a tunnel url")
        proc.terminate()
        return 1
    threading.Thread(target=lambda: [_ for _ in proc.stderr], daemon=True).start()
    print(f"  {url}")

    # cloudflared prints the url BEFORE the edge has finished registering it,
    # and public DNS lags further behind. Publishing inside that window points
    # the UI at a name that does not resolve yet: the page loads and every call
    # fails, which reads exactly like a broken backend.
    print("  waiting for DNS…")
    live = False
    for _ in range(20):
        try:
            urllib.request.urlopen(f"{url}/api/health", timeout=10)
            live = True
            break
        except urllib.error.HTTPError as e:
            # A 401 here is the CORRECT answer: it proves the tunnel reaches
            # the backend AND that the token gate is armed. A 200 would mean
            # the server started without the token and is wide open.
            if e.code == 401:
                live = True
                break
            live = True
            print("  [!] /api/health answered %d without a token — the gate is OFF." % e.code)
            print("      The backend did not inherit MAGI_API_TOKEN. Not publishing.")
            proc.terminate()
            return 1
        except OSError:
            time.sleep(3)
    if not live:
        print("  [X] tunnel url never resolved")
        proc.terminate()
        return 1

    try:
        _publish(url, token)
    except Exception as e:  # noqa: BLE001 — the cause is what matters here
        print(f"  [X] could not publish to magi-link: {e}")
        proc.terminate()
        return 1

    print("\n  Published. Open https://anthonyn99.github.io/A1/magi.html anywhere.")
    print("  This PC must stay awake and logged in — the Chrome profiles are here.")
    print("  Ctrl+C to stop.\n")
    try:
        proc.wait()
    except KeyboardInterrupt:
        pass
    finally:
        # Withdraw on the way out, so the UI says "offline" instead of hanging
        # on a tunnel that closed with the process.
        _withdraw(token)
        proc.terminate()
    return 0
