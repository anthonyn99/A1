"""Tests for prep_bridge.py (Tony's A1 Prep Bridge). Opens nothing: the
launcher's launch() and public_list() are replaced for the run.

Run:  python test_prep_bridge.py
"""

import json
import threading
import urllib.error
import urllib.request

import launcher
import prep_bridge

passed = failed = 0


def t(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok  ", name)
    else:
        failed += 1
        print("  FAIL", name, detail)


calls = []
launcher.launch = lambda apps, urls, focus=None: (calls.append((apps, urls, focus))
                                                   or {"ok": True, "opened": urls or [], "unknown": [], "failed": []})
launcher.public_list = lambda: [{"id": "abc", "name": "Word"}]
launcher.log = lambda *a: None

srv = prep_bridge.Server(("127.0.0.1", 0), prep_bridge.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % srv.server_address[1]
TASKHUB = "https://anthonyn99.github.io"


def req(path, method="GET", origin=None, body=None):
    r = urllib.request.Request(base + path, method=method,
                               data=json.dumps(body).encode() if body is not None else None)
    if origin:
        r.add_header("Origin", origin)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            return resp.status, dict(resp.headers), json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), json.loads(e.read() or b"{}")


st, h, j = req("/health")
t("health answers, and says it is the prep bridge", st == 200 and j.get("bridge") == "prep")

st, h, j = req("/api/apps", origin=TASKHUB)
t("TaskHub gets the app list", st == 200 and j["apps"][0]["name"] == "Word")
t("...with CORS for its origin only", h.get("Access-Control-Allow-Origin") == TASKHUB)
t("...and the private-network header", h.get("Access-Control-Allow-Private-Network") == "true")

st, h, j = req("/api/apps", origin="https://evil.example")
t("another site is refused", st == 403 and "Access-Control-Allow-Origin" not in h)
st, h, j = req("/api/apps")
t("no Origin at all is refused", st == 403)

st, h, j = req("/api/launch", "POST", TASKHUB, {"apps": ["abc"], "urls": ["https://mail.google.com/mail/u/0/?fs=1"], "focus": "https://chatgpt.com/?q=x"})
t("TaskHub's launch reaches the launcher", st == 200 and calls[-1] == (["abc"], ["https://mail.google.com/mail/u/0/?fs=1"], "https://chatgpt.com/?q=x"))
n = len(calls)
st, h, j = req("/api/launch", "POST", "https://evil.example", {"apps": ["abc"], "urls": []})
t("another site cannot launch", st == 403 and len(calls) == n)

st, h, j = req("/api/launch", "OPTIONS", TASKHUB)
t("the preflight is answered", st == 204 and h.get("Access-Control-Allow-Private-Network") == "true")

# A second bridge on a port already in use must fail to bind, not shadow it.
try:
    prep_bridge.Server(("127.0.0.1", srv.server_address[1]), prep_bridge.Handler).server_close()
    t("a taken port is refused", False)
except OSError:
    t("a taken port is refused", True)

srv.shutdown()
print("\n%d passed, %d failed" % (passed, failed))
raise SystemExit(1 if failed else 0)
