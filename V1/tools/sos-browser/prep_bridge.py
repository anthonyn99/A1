"""A1 Prep Bridge: TaskHub AI prep's PC launcher, on its own.

The full StudyOS bridge (server.py) runs on Veda's PC and, besides its AI
jobs, answers the two AI prep routes from launcher.py. Tony's PC has no
StudyOS, so this serves ONLY those two routes, on the same port, with the same
origin gate, and nothing else:

  GET  /health       -> { ok, bridge: "prep" }
  GET  /api/apps     -> { ok, apps:[{id, name}] }          (origin-gated)
  POST /api/launch   { apps, urls, focus? } -> launcher.launch  (origin-gated)

It runs from logon through the "A1 Prep Bridge" shortcut in the Startup folder
(pythonw, no window). Only the standard library is needed. If the port is
already taken (a StudyOS bridge is running), it exits quietly: that bridge
answers the same routes.

Run:  pythonw prep_bridge.py          (or python, to see errors)
"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import launcher

PORT = 8781
MAX_BODY = 64 * 1024


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):          # pythonw has no console; launch.log is the record
        pass

    def _send(self, obj, status=200):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        # Only TaskHub's origin may launch (checked per route); answering CORS
        # for it is what lets its fetch read the reply at all.
        origin = self.headers.get("Origin")
        if launcher.origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        # Chromium's Private Network Access preflight, for a public page that
        # asks 127.0.0.1.
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send({}, 204)

    def do_GET(self):
        p = urlparse(self.path).path
        if p == "/health":
            return self._send({"ok": True, "bridge": "prep"})
        if p == "/api/apps":
            if not launcher.origin_allowed(self.headers.get("Origin")):
                launcher.log("apps-refused", self.headers.get("Origin"), None)
                return self._send({"ok": False, "error": "origin not allowed"}, 403)
            listed = launcher.public_list()
            launcher.log("apps", self.headers.get("Origin"), len(listed))
            return self._send({"ok": True, "apps": listed})
        return self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        p = urlparse(self.path).path
        if p != "/api/launch":
            return self._send({"ok": False, "error": "not found"}, 404)
        if not launcher.origin_allowed(self.headers.get("Origin")):
            launcher.log("launch-refused", self.headers.get("Origin"), None)
            return self._send({"ok": False, "error": "origin not allowed"}, 403)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                return self._send({"ok": False, "error": "too big"}, 413)
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send({"ok": False, "error": "bad json"}, 400)
        if not isinstance(body, dict):
            return self._send({"ok": False, "error": "bad body"}, 400)
        res = launcher.launch(body.get("apps"), body.get("urls"), focus=body.get("focus"))
        launcher.log("launch", self.headers.get("Origin"),
                     {"asked": {"apps": body.get("apps"), "urls": body.get("urls"),
                                "focus": (str(body.get("focus"))[:80] if body.get("focus") else None)}, **res})
        return self._send(res)


class Server(ThreadingHTTPServer):
    # HTTPServer turns SO_REUSEADDR on, and on Windows that lets a second
    # server bind a port that is already in use. Exclusive, so a running
    # bridge is never shadowed and the bind below fails instead.
    allow_reuse_address = False

    def server_bind(self):
        import socket
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main() -> int:
    try:
        srv = Server(("127.0.0.1", PORT), Handler)
    except OSError:
        return 0                          # a bridge already answers on this port
    srv.daemon_threads = True
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
