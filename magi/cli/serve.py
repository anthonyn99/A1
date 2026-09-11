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
import sys
import webbrowser
from datetime import datetime
from pathlib import Path

from .. import proc
from ..settings import ROOT

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
    log = ROOT / "data" / "autostart.log"
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


def cloud(port: int = 8000) -> int:
    """Local + reachable from anywhere, via a quick tunnel this publishes."""
    _ensure_streams()
    token = os.environ.get("MAGI_API_TOKEN", "").strip()

    _free_port(port)
    print("  starting backend…")
    _serve_in_background(port)
    if not _wait_healthy(port):
        print("  [X] backend never came up on 127.0.0.1:%d" % port)
        return 1

    # No token means no tunnel — publishing an UNGATED backend would expose
    # endpoints that drive live paid accounts to anyone who learns the url.
    # But the local backend is already up and is not the thing at risk, so it
    # keeps serving rather than the whole command failing.
    if not token:
        print("\n  MAGI_API_TOKEN is not set.")
        print("  A quick tunnel cannot sit behind Cloudflare Access, so this")
        print("  shared secret is the only thing gating endpoints that drive")
        print("  your paid accounts. Set one, then open a NEW terminal:\n")
        print('      setx MAGI_API_TOKEN "<a long random string>"\n')
        return _serve_only(port, "no tunnel opened — the API would be ungated.")

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
    cf_log = ROOT / "data" / "cloudflared.log"
    cf_log.parent.mkdir(parents=True, exist_ok=True)
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

    # Verifying and publishing happen on a BACKGROUND thread, and the local
    # server is never held up waiting for them.
    #
    # A quick tunnel's hostname is registered at the edge some seconds after
    # cloudflared prints it, and public DNS lags further still -- measured
    # here at longer than the 60s the first version allowed, which made it
    # give up, kill the tunnel and fall back to local-only on a tunnel that
    # was simply not ready yet. Under `magi autostart` that runs at logon,
    # racing a network stack that is itself still coming up, so a fixed
    # deadline is the wrong shape entirely: keep the tunnel and keep trying.
    def verify_and_publish() -> None:
        url = _CURRENT["url"]
        deadline = time.time() + 15 * 60
        delay = 3
        while time.time() < deadline:
            try:
                urllib.request.urlopen(
                    urllib.request.Request(f"{url}/api/health", headers={"User-Agent": UA}),
                    timeout=10)
                # A 200 means the server started WITHOUT the token and is wide
                # open. Publishing that hands the url -- and the accounts
                # behind it -- to anyone who reads the KV record.
                print("  [!] /api/health answered 200 without a token — the gate")
                print("      is OFF, so the tunnel was NOT published. The backend")
                print("      did not inherit MAGI_API_TOKEN; open a new terminal.")
                tunnel.terminate()
                return
            except urllib.error.HTTPError as e:
                if e.code != 401:
                    print(f"  [!] tunnel answered {e.code}; not publishing.")
                    tunnel.terminate()
                    return
                # 401 is the CORRECT answer: it proves the tunnel reaches the
                # backend AND that the token gate is armed.
                break
            except OSError:
                time.sleep(delay)
                delay = min(delay * 1.5, 30)
        else:
            print("  [!] the tunnel url never resolved in 15 minutes.")
            print("      Local access is unaffected.")
            tunnel.terminate()
            return

        try:
            _publish(url, token)
        except Exception as e:  # noqa: BLE001 — the cause is what matters here
            print(f"  [!] could not publish to magi-link: {e}")
            print("      Local access is unaffected.")
            return
        print(f"  published — https://anthonyn99.github.io/A1/magi.html now reaches this PC")

    _CURRENT["url"] = url
    threading.Thread(target=verify_and_publish, daemon=True).start()

    print(f"\n  MAGI → http://127.0.0.1:{port}  (and over the tunnel once it registers)")
    print("  This PC must stay awake and logged in — the Chrome profiles are here.")
    print("  Ctrl+C to stop.\n")

    # ── keep the tunnel alive ─────────────────────────────────────────────
    # A quick tunnel is not a durable thing: cloudflared drops out on a network
    # blip, on sleep/wake, or when Cloudflare recycles the hostname. The first
    # version simply stopped tunnelling at that point and served locally for
    # the rest of the session -- fine at the desk, useless from a phone, where
    # the tunnel is the ONLY route in. Since the phone is the case this exists
    # for, a dead tunnel is replaced rather than mourned.
    #
    # Each replacement gets a NEW hostname, which is exactly what magi-link is
    # for: republish, and the phone follows on its next look. Backoff is capped
    # so a long outage settles into one attempt a minute instead of a spin.
    delay = 5
    try:
        while True:
            tunnel.wait()
            print(f"  [!] the tunnel ended; restarting in {delay}s.")
            _withdraw(token)
            time.sleep(delay)
            delay = min(delay * 2, 60)
            try:
                handle = open(cf_log, "w", encoding="utf-8", errors="replace")
                tunnel = proc.popen(
                    _cloudflared_argv(port), stdout=handle, stderr=handle,
                )
            except FileNotFoundError:
                return _serve_only(port, "cloudflared has gone missing.")

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
            # A fresh hostname needs the same verify-then-publish the first one
            # got, so the same worker is reused rather than duplicated.
            _CURRENT["url"] = fresh
            threading.Thread(target=verify_and_publish, daemon=True).start()
            delay = 5
    except KeyboardInterrupt:
        pass
    finally:
        # Withdraw on the way out, so the console says "offline" instead of
        # hanging on a tunnel that closed with the process.
        _withdraw(token)
        tunnel.terminate()

    return _serve_only(port, "the tunnel was stopped.")


# ── autostart ───────────────────────────────────────────────────────────────
# MAGI is the one A1 program that is not just a page: the console cannot work
# unless the engine is running on this PC, because the four Chrome profiles
# live here. Having to launch magi.bat first makes it the only program in the
# suite with a manual step, and a page that is dead until you remember to do
# something is a page you stop opening.
#
# So the backend becomes a logon item and the .bat becomes optional. After
# this, opening the console is exactly like opening TaskHub.
#
# A STARTUP SHORTCUT, NOT A SCHEDULED TASK. A task was the first attempt and is
# the nicer object -- delays, battery policy, inspectable run history -- but
# Register-ScheduledTask fails with "Access is denied" without elevation, and
# an autostart that needs an admin prompt to install is not an autostart. The
# Startup folder is per-user, needs no rights at all, and is somewhere Tony can
# see and delete by hand.
#
# pythonw.exe, not python.exe: a console window on every logon is precisely the
# thing this exists to remove.
SHORTCUT_NAME = "MAGI.lnk"


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


def autostart(action: str = "on", port: int = 8000) -> int:
    if os.name != "nt":
        print("  autostart is Windows-only (it writes a Startup-folder shortcut).")
        return 1

    lnk = _startup_dir() / SHORTCUT_NAME

    if action == "status":
        print()
        print(f"  startup shortcut: {'present' if lnk.exists() else 'not installed'}")
        print(f"  {lnk}")
        alive = _wait_healthy(port, timeout=2)
        print(f"  backend on 127.0.0.1:{port}: {'up' if alive else 'not responding'}")
        print()
        return 0

    if action == "off":
        try:
            lnk.unlink()
            print(f"\n  Removed {lnk.name} — MAGI will no longer start at logon.")
        except FileNotFoundError:
            print("\n  Nothing to remove; it was not installed.")
        print("  Any engine already running is left alone.\n")
        return 0

    root = ROOT.parent                      # the A1 repo root
    pyw = ROOT / ".venv" / "Scripts" / "pythonw.exe"
    if not pyw.exists():
        print(f"\n  [X] {pyw} is missing. Run `magi setup` first.\n")
        return 1

    lnk.parent.mkdir(parents=True, exist_ok=True)
    code, out = _run_ps(
        "$w = New-Object -ComObject WScript.Shell; "
        f"$s = $w.CreateShortcut('{lnk}'); "
        f"$s.TargetPath = '{pyw}'; "
        "$s.Arguments = '-m magi cloud'; "
        f"$s.WorkingDirectory = '{root}'; "
        "$s.Description = 'MAGI council engine'; "
        "$s.WindowStyle = 7; "
        "$s.Save(); "
        "if (Test-Path $s.FullName) { 'ok' } else { throw 'shortcut not written' }"
    )
    # Checked rather than assumed: the scheduled-task attempt reported success
    # while silently failing, because the script printed its own confirmation
    # regardless of what the cmdlet did.
    if code != 0 or "ok" not in out:
        print(f"\n  [X] could not write the shortcut:\n{out}\n")
        return 1

    print(f"\n  Installed {lnk.name} — the engine now starts when you log in.")

    if _wait_healthy(port, timeout=2):
        print(f"  Already running. Open http://127.0.0.1:{port}\n")
        return 0

    # Start it now rather than making them log out to see it work.
    print("  Starting it now…")
    proc.popen([str(pyw), "-m", "magi", "cloud"], cwd=str(root))
    if _wait_healthy(port, timeout=60):
        print(f"\n  MAGI is up. Open http://127.0.0.1:{port} — bookmark it and")
        print("  you never need magi.bat again.\n")
        return 0
    print("\n  [!] Installed, but the backend has not answered yet.")
    print("      Check `magi autostart status` in a moment.\n")
    return 0
