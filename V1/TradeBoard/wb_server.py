#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════════
 wb_server.py — auto-syncing local server for the Trade Journal (Webull)
═══════════════════════════════════════════════════════════════════════════
 ONE process that:
   1. Serves journal.html at  http://localhost:8787
   2. Re-runs the Webull sync every 2 minutes in the background
   3. Serves broker_import.json / broker_positions.json + /status so the
      page auto-updates with no clicking

 WHY A SERVER? A double-clicked file:// page can't fetch local JSON on a
 timer (browsers require a click). Served over http://localhost it can, so
 the journal updates itself while it's open.

 Because Webull uses real API keys (no session/MFA), there is no daily
 re-login: start it and leave it. Auth errors (revoked/expired keys) show a
 desktop notification + the red pill in the page.

 RUN:   python wb_server.py         (or the "Start Trade Journal.bat")
 STOP:  Ctrl+C / close the window.
 Interval override:  set WEBULL_SYNC_INTERVAL (seconds, min 30).

 READ-ONLY — never places orders.
═══════════════════════════════════════════════════════════════════════════
"""

import http.server
import json
import os
import socketserver
import sys
import threading
import time
import traceback
import webbrowser
from datetime import datetime, timezone

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8787
SYNC_INTERVAL_SECONDS = max(30, int(os.environ.get("WEBULL_SYNC_INTERVAL", "120")))

sys.path.insert(0, HERE)
try:
    import wb_sync
except Exception as e:  # noqa: BLE001
    print(f"✗ Couldn't import wb_sync.py: {e}", file=sys.stderr)
    sys.exit(1)


# ── status shared with the page ──────────────────────────────────────────────
_status = {
    "last_sync": None,
    "last_error": None,
    "syncing": False,
    "trades": 0,
    "positions": 0,
    "interval": SYNC_INTERVAL_SECONDS,
    "needs_reauth": False,   # true when Webull rejects the API keys
    "broker": "Webull",
}
_status_lock = threading.Lock()


def _set_status(**kw):
    with _status_lock:
        _status.update(kw)


def _snapshot_status():
    with _status_lock:
        return dict(_status)


# ── desktop notification (Windows, best-effort) ──────────────────────────────
_notify_lock = threading.Lock()
_last_notify = {"key": None}


def notify(title, message, once_key=None):
    if once_key is not None:
        with _notify_lock:
            if _last_notify["key"] == once_key:
                return
            _last_notify["key"] = once_key
    try:
        import subprocess
        ps = (
            "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null;"
            "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent("
            "[Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
            "$x=$t.GetElementsByTagName('text');"
            f"$x.Item(0).AppendChild($t.CreateTextNode('{title}')) | Out-Null;"
            f"$x.Item(1).AppendChild($t.CreateTextNode('{message}')) | Out-Null;"
            "$n=[Windows.UI.Notifications.ToastNotification]::new($t);"
            "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Trade Journal').Show($n);"
        )
        subprocess.Popen(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:  # noqa: BLE001
        print(f"  [notify] {title}: {message}")


def _clear_notify_key():
    with _notify_lock:
        _last_notify["key"] = None


# ── background sync loop ─────────────────────────────────────────────────────
def _looks_like_auth_error(msg):
    m = msg.lower()
    return any(w in m for w in ("unauthorized", "401", "credential", "app_key",
                                "signature", "forbidden", "403"))


def sync_loop(trade, cfg):
    while True:
        _set_status(syncing=True)
        try:
            n_t, n_p = wb_sync.sync(trade=trade, cfg=cfg)
            _set_status(
                last_sync=datetime.now(timezone.utc).isoformat(),
                last_error=None, needs_reauth=False,
                trades=n_t, positions=n_p,
            )
            print(f"[{datetime.now().strftime('%H:%M:%S')}] synced: "
                  f"{n_t} trades, {n_p} positions")
            _clear_notify_key()
        except SystemExit:
            # wb_sync.die() inside the loop — treat as an error, keep looping
            _set_status(last_error="sync aborted (see console)")
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if _looks_like_auth_error(msg):
                _set_status(last_error="Webull rejected the API keys.", needs_reauth=True)
                print(f"[{datetime.now().strftime('%H:%M:%S')}] AUTH error: {msg}")
                print("  → Check/regenerate your keys in Webull API Management, "
                      "update webull_config.json, then restart this server.")
                notify("Trade Journal — Webull auth failed",
                       "API keys were rejected. Update webull_config.json and restart.",
                       once_key="auth")
            else:
                _set_status(last_error=msg, needs_reauth=False)
                print(f"[{datetime.now().strftime('%H:%M:%S')}] sync error: {msg}")
                traceback.print_exc(limit=1)
        finally:
            _set_status(syncing=False)
        time.sleep(SYNC_INTERVAL_SECONDS)


# ── web server ───────────────────────────────────────────────────────────────
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def log_message(self, *a):
        pass

    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if self.path.split("?")[0].endswith(".json"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        route = self.path.split("?")[0]
        if route == "/status":
            self._send_json(_snapshot_status())
            return
        if route in ("/", ""):
            self.path = "/journal.html"
        return super().do_GET()


def main():
    print("═" * 60)
    print(" Auto-syncing Trade Journal server — Webull")
    print("═" * 60)
    print(f" Sync interval : every {SYNC_INTERVAL_SECONDS}s")
    print(f" URL           : http://localhost:{PORT}")
    print("═" * 60 + "\n")

    # connect once; the client is reused by every sync
    cfg = wb_sync.load_config()
    trade = wb_sync.connect(cfg)

    print("Running first sync…")
    try:
        n_t, n_p = wb_sync.sync(trade=trade, cfg=cfg)
        _set_status(last_sync=datetime.now(timezone.utc).isoformat(),
                    trades=n_t, positions=n_p)
        print(f"✓ first sync: {n_t} trades, {n_p} positions\n")
    except Exception as e:  # noqa: BLE001
        print(f"⚠ first sync failed ({e}); the loop will retry.\n")

    t = threading.Thread(target=sync_loop, args=(trade, cfg), daemon=True)
    t.start()

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
        url = f"http://localhost:{PORT}/"
        print(f"Serving the journal at {url}")
        print("Open that in your browser (opening it now). Ctrl+C to stop.\n")
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001
            pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
