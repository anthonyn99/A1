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

from ..settings import ROOT

# The account-2 worker that answers "where is MAGI right now?".
# See workers2/magi-link/worker.js.
LINK_API = os.environ.get("MAGI_LINK_API", "https://magi-link.av1-2.workers.dev/link")

QUICK_TUNNEL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


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
        return _serve_only(port, "cloudflared is not installed "
                                 "(winget install --id Cloudflare.cloudflared).")

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
        proc.terminate()
        return _serve_only(port, "cloudflared never printed a tunnel url.")
    threading.Thread(target=lambda: [_ for _ in proc.stderr], daemon=True).start()
    print(f"  {url}")

    # cloudflared prints the url BEFORE the edge has finished registering it,
    # and public DNS lags further behind. Publishing inside that window points
    # the UI at a name that does not resolve yet: the page loads and every call
    # fails, which reads exactly like a broken backend.
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
        deadline = time.time() + 15 * 60
        delay = 3
        while time.time() < deadline:
            try:
                urllib.request.urlopen(f"{url}/api/health", timeout=10)
                # A 200 means the server started WITHOUT the token and is wide
                # open. Publishing that hands the url -- and the accounts
                # behind it -- to anyone who reads the KV record.
                print("  [!] /api/health answered 200 without a token — the gate")
                print("      is OFF, so the tunnel was NOT published. The backend")
                print("      did not inherit MAGI_API_TOKEN; open a new terminal.")
                proc.terminate()
                return
            except urllib.error.HTTPError as e:
                if e.code != 401:
                    print(f"  [!] tunnel answered {e.code}; not publishing.")
                    proc.terminate()
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
            proc.terminate()
            return

        try:
            _publish(url, token)
        except Exception as e:  # noqa: BLE001 — the cause is what matters here
            print(f"  [!] could not publish to magi-link: {e}")
            print("      Local access is unaffected.")
            return
        print(f"  published — https://anthonyn99.github.io/A1/magi.html now reaches this PC")

    threading.Thread(target=verify_and_publish, daemon=True).start()

    print(f"\n  MAGI → http://127.0.0.1:{port}  (and over the tunnel once it registers)")
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

    # cloudflared exiting must not take the console down with it: the engine is
    # the thing that matters and it is still perfectly usable on this PC.
    return _serve_only(port, "the tunnel process ended.")


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
    r = subprocess.run(
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
    subprocess.Popen(
        [str(pyw), "-m", "magi", "cloud"], cwd=str(root),
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if _wait_healthy(port, timeout=60):
        print(f"\n  MAGI is up. Open http://127.0.0.1:{port} — bookmark it and")
        print("  you never need magi.bat again.\n")
        return 0
    print("\n  [!] Installed, but the backend has not answered yet.")
    print("      Check `magi autostart status` in a moment.\n")
    return 0
