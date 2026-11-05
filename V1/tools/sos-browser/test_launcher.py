"""Tests for launcher.py — the bridge routes TaskHub's ✨ uses to open apps.

Covers the decisions a well-meaning edit could quietly undo:

  "a request never names a path"
      Apps are opaque ids resolved only against this module's own scan. An
      unknown id launches nothing; a URL must be http(s).

  "only TaskHub may ask"
      The bridge answers any origin for AI jobs. These two routes must not:
      any page she visits could otherwise make her PC open programs. A missing
      Origin is refused too, so the gate cannot be skipped by omission.

Nothing is ever actually opened: os.startfile is stubbed throughout.

Run:  python test_launcher.py
"""

from __future__ import annotations

import json
import shutil as _shutil
import sys
import tempfile as _tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import launcher  # noqa: E402
import server  # noqa: E402

# Same rule as test_server.py: never let a test journal over the real jobs.json.
_tmp_jobs = Path(_tempfile.mkdtemp(prefix="sos-test-jobs-"))
server.JOBS_FILE = _tmp_jobs / "jobs.json"
import atexit  # noqa: E402
atexit.register(lambda: _shutil.rmtree(_tmp_jobs, ignore_errors=True))

launcher.LAUNCH_GAP_S = 0
launcher.CLOSE_WAIT_S = 0
launcher.LOG_FILE = _tmp_jobs / "launch.log"     # never append test traffic to the real log
started: list[str] = []
launcher._start = lambda target: started.append(target)

PASS = FAIL = 0


def t(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   " + name)
    else:
        FAIL += 1
        print("  FAIL " + name + (("\n       " + str(extra)[:300]) if extra else ""))


# ── scan ──────────────────────────────────────────────────────────────────────
print("\nscan")
_root = Path(_tempfile.mkdtemp(prefix="sos-test-lnk-"))
_desk = Path(_tempfile.mkdtemp(prefix="sos-test-desk-"))
atexit.register(lambda: (_shutil.rmtree(_root, ignore_errors=True), _shutil.rmtree(_desk, ignore_errors=True)))
for rel in ["Microsoft Word.lnk", "Office/Excel.lnk", "Zoom/Zoom.lnk", "Zoom/Uninstall Zoom.lnk",
            "Python/Python 3.11 Documentation.lnk", "Thing/Readme.lnk", "notes.txt"]:
    f = _root / rel
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(b"x")
(_desk / "Zoom.lnk").write_bytes(b"x")
(_desk / "Spotify.lnk").write_bytes(b"x")

table = launcher.scan_apps([_root, _desk])
names = sorted(a["name"] for a in table.values())
t("finds every shortcut in nested folders", names == ["Excel", "Microsoft Word", "Spotify", "Zoom"], names)
t("drops uninstallers, readmes and docs", not any("Uninstall" in n or "Readme" in n or "Documentation" in n for n in names))
t("one entry per app name across Start Menu and Desktop", names.count("Zoom") == 1)
ids = list(table)
t("ids are 12 hex chars and contain no path", all(len(i) == 12 and all(c in "0123456789abcdef" for c in i) for i in ids))
t("ids are stable across scans", sorted(ids) == sorted(launcher.scan_apps([_root, _desk])))
t("a missing root is skipped, not an error", launcher.scan_apps([_root / "nope"]) == {})

# Store apps (Notepad on Windows 11) have no .lnk; they come from Get-StartApps.
start = [{"Name": "Notepad", "AppID": "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"},
         {"Name": "Zoom", "AppID": "zoom.us.Zoom"},
         {"Name": "Evil", "AppID": 'x" & calc'},
         {"Name": "Uninstall Thing", "AppID": "thing!App"},
         {"Name": "", "AppID": "noname!App"}]
mixed = launcher.scan_apps([_root, _desk], start=start)
by_name = {a["name"]: a for a in mixed.values()}
t("Store apps are included and open via shell:AppsFolder",
  by_name.get("Notepad", {}).get("path") == "shell:AppsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App", by_name.get("Notepad"))
t("a Start-menu app wins over the same name's .lnk", by_name["Zoom"]["path"] == "shell:AppsFolder\\zoom.us.Zoom")
t("AppIDs with quotes, uninstallers and blank names are dropped",
  "Evil" not in by_name and "Uninstall Thing" not in by_name and len(mixed) == 5, sorted(by_name))

# ── launch ────────────────────────────────────────────────────────────────────
print("\nlaunch")
word = next(i for i, a in table.items() if a["name"] == "Microsoft Word")
started.clear()
r = launcher.launch([word, "deadbeef0000"], ["https://joinhandshake.com", "file:///C:/Windows/system32/cmd.exe",
                                             "javascript:alert(1)", "C:\\Windows\\notepad.exe", "ms-word:ofe|u|x"], table=table)
t("opens the known app by its own scanned path", str(_root / "Microsoft Word.lnk") in started, started)
t("unknown ids open nothing and are reported", r["unknown"] == ["deadbeef0000"])
t("only http(s) urls are opened", [s for s in started if not s.endswith(".lnk")] == ["https://joinhandshake.com"], started)
t("result names what opened, apps first", r["opened"] == ["Microsoft Word", "https://joinhandshake.com"], r)
started.clear()
launcher.launch(list(table) * 3, [f"https://e{i}.com/" for i in range(9)], table=table)
t("caps: 3 apps, 5 urls", sum(s.endswith(".lnk") for s in started) == 3 and sum(s.startswith("https") for s in started) == 5, started)
started.clear()
ai = "https://www.perplexity.ai/search?q=" + "x%20" * 2500          # ~10k chars, a long prompt
r = launcher.launch([word], ["https://a.com/", "https://b.com/"], focus=ai, table=table)
t("order: apps, then sites, then the assistant LAST (the active tab)",
  started == [str(_root / "Microsoft Word.lnk"), "https://a.com/", "https://b.com/", ai], started[:3])
t("a long assistant url (prompt inside) is allowed", len(ai) > 4000 and started[-1] == ai)
started.clear()
launcher.launch([], [], focus="javascript:alert(1)", table=table)
launcher.launch([], [], focus="https://x.com/?q=" + "a" * 20000, table=table)
t("focus must be http(s) and under the cap", started == [])
started.clear()
r = launcher.launch(["../../etc", {"id": "x"}, 5], None, table=table)
t("junk ids launch nothing", started == [] and r["opened"] == [])

# ── close (Neo: "close Spotify") ──────────────────────────────────────────────
# No process is ever touched: the lister, closer and killer are stubs.
print("\nclose")
ctable = {
    "sp": {"name": "Spotify", "path": r"C:\Users\v\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Spotify.lnk"},
    "wd": {"name": "Word", "path": "shell:AppsFolder\\Microsoft.Office.WINWORD.EXE.15"},
    "np": {"name": "Notepad", "path": "shell:AppsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"},
    "ch": {"name": "Google Chrome", "path": "shell:AppsFolder\\{6D809377-6AF0-444B-8957-A3773F02200E}\\Google\\Chrome\\Application\\chrome.exe"},
    "dc": {"name": "Discord", "path": r"C:\Users\v\Desktop\Discord.lnk"},
    "ex": {"name": "File Explorer", "path": "shell:AppsFolder\\Microsoft.Windows.Explorer"},
}
lnk = {ctable["sp"]["path"]: r"C:\Users\v\AppData\Roaming\Spotify\Spotify.exe",
       ctable["dc"]["path"]: r"C:\Users\v\AppData\Local\Discord\Update.exe"}
store = {"microsoft.windowsnotepad_8wekyb3d8bbwe": r"C:\Program Files\WindowsApps\Microsoft.WindowsNotepad_11.2409_x64__8wekyb3d8bbwe"}
procs = [
    {"Id": 11, "ProcessName": "Spotify", "Path": r"C:\Users\v\AppData\Roaming\Spotify\Spotify.exe", "Description": "Spotify"},
    {"Id": 12, "ProcessName": "WINWORD", "Path": r"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE", "Description": "Microsoft Word"},
    {"Id": 13, "ProcessName": "Notepad", "Path": r"C:\Program Files\WindowsApps\Microsoft.WindowsNotepad_11.2409_x64__8wekyb3d8bbwe\Notepad\Notepad.exe", "Description": "Notepad.exe"},
    {"Id": 14, "ProcessName": "Discord", "Path": r"C:\Users\v\AppData\Local\Discord\app-1.0\Discord.exe", "Description": "Discord"},
    {"Id": 15, "ProcessName": "explorer", "Path": r"C:\Windows\explorer.exe", "Description": "Windows Explorer"},
    {"Id": 16, "ProcessName": "pythonw", "Path": r"C:\Python311\pythonw.exe", "Description": "Spotify"},
]
alive = {p["Id"] for p in procs}
closed_pids, killed = [], []


def lister():
    return [p for p in procs if p["Id"] in alive]


def closer(pid):                         # like clicking ✕: Word asks to save, the rest go
    closed_pids.append(pid)
    if pid != 12:
        alive.discard(pid)
    return True


def killer(pid):
    killed.append(pid)
    alive.discard(pid)
    return True


t("a name that only starts the description is not that app (Visual Studio is not VS Code)",
  not launcher.proc_matches({"name": "Visual Studio", "exe": ""}, {"ProcessName": "Code", "Path": "", "Description": "Visual Studio Code"})
  and launcher.proc_matches({"name": "Visual Studio Code", "exe": ""}, {"ProcessName": "Code", "Path": "", "Description": "Visual Studio Code"}))
kw = dict(table=ctable, lister=lister, closer=closer, killer=killer, wait_s=0, lnk_reader=lambda ps: lnk, store=store)
t("a Store app resolves to its package folder",
  launcher.aumid_target("Microsoft.WindowsNotepad_8wekyb3d8bbwe!App", store).endswith("8wekyb3d8bbwe\\"))
t("a desktop AppID under Program Files resolves to its exe",
  launcher.aumid_target(ctable["ch"]["path"][len("shell:AppsFolder\\"):]).endswith("\\google\\chrome\\application\\chrome.exe"))
run = launcher.running(table=ctable, lister=lister, lnk_reader=lambda ps: lnk, store=store)
t("running: every open app is found, by path, package or description",
  [a["name"] for a in run] == ["Discord", "Notepad", "Spotify", "Word"], run)
t("running: Windows' Explorer and the bridge's Python never count", "File Explorer" not in [a["name"] for a in run])
r = launcher.close(["sp", "np", "ch"], **kw)
t("graceful close: open apps close, a closed one is 'not running'",
  r["closed"] == ["Spotify", "Notepad"] and r["notRunning"] == ["Google Chrome"] and not killed, r)
t("the bridge's own python is never touched even when it claims to be Spotify", 16 not in closed_pids)
r = launcher.close(["wd"], **kw)
t("an app that asks to save stays open and says so", r["stillOpen"] == ["Word"] and r["closed"] == [] and 12 in alive, r)
r = launcher.close(["wd"], force=True, **kw)
t("force quits it", r["closed"] == ["Word"] and killed == [12] and 12 not in alive, r)
r = launcher.close(["dc"], **kw)
t("a launcher shortcut (Discord's Update.exe) still closes the app by its description", r["closed"] == ["Discord"], r)
r = launcher.close(["ex", "nope0000", {"x": 1}], **kw)
t("Explorer is never closed; unknown ids are reported", 15 not in closed_pids and r["unknown"] == ["nope0000"], r)
procs.append({"Id": 20, "ProcessName": "chrome", "Path": r"C:\Program Files\Google\Chrome\Application\chrome.exe", "Description": "Google Chrome"})
alive.add(20)
bx = r"c:\program files\google\chrome\application\chrome.exe"
r = launcher.close(["ch"], bexe=bx, **kw)
t("the browser TaskHub runs in is left alone unless she named it", r["notRunning"] == ["Google Chrome"] and 20 in alive, r)
r = launcher.close(["ch"], bexe=bx, allow_browser=True, **kw)
t("…and closes when she did", r["closed"] == ["Google Chrome"] and 20 not in alive, r)

# ── origin gate ───────────────────────────────────────────────────────────────
print("\norigin gate")
t("TaskHub's origin is allowed", launcher.origin_allowed("https://anthonyn99.github.io"))
t("localhost dev server is allowed", launcher.origin_allowed("http://localhost:5173"))
t("no origin is refused", not launcher.origin_allowed(None) and not launcher.origin_allowed(""))
t("another site is refused", not launcher.origin_allowed("https://evil.example"))
t("a look-alike is refused", not launcher.origin_allowed("https://anthonyn99.github.io.evil.example"))
t("null (sandboxed iframe / file page) is refused", not launcher.origin_allowed("null"))

# ── routes, through the real handler ──────────────────────────────────────────
print("\nroutes")
launcher._cache.update(at=10 ** 12, apps=table)      # serve the fixture, never the real Start Menu
srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_address[1]}"


def call(method, path, origin=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if origin:
        req.add_header("Origin", origin)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


try:
    st, j = call("GET", "/api/apps", "https://anthonyn99.github.io")
    t("GET /api/apps lists names + ids only", st == 200 and j["ok"] and {"id", "name"} == set(j["apps"][0])
      and not any("path" in a or "\\" in a["name"] for a in j["apps"]), j)
    t("GET /api/apps from another site is 403", call("GET", "/api/apps", "https://evil.example")[0] == 403)
    t("GET /api/apps with no origin is 403", call("GET", "/api/apps")[0] == 403)
    started.clear()
    st, j = call("POST", "/api/launch", "https://evil.example", {"apps": [word], "urls": ["https://x.com"]})
    t("POST /api/launch from another site is 403 and opens nothing", st == 403 and started == [])
    st, j = call("POST", "/api/launch", None, {"apps": [word]})
    t("POST /api/launch with no origin is 403", st == 403 and started == [])
    st, j = call("POST", "/api/launch", "https://anthonyn99.github.io", {"apps": [word], "urls": ["https://x.com"]})
    t("POST /api/launch from TaskHub opens the kit", st == 200 and j["opened"] == ["Microsoft Word", "https://x.com"], j)
    # /api/close and /api/running: never the real process list here.
    launcher.list_processes = lambda: [{"Id": 99, "ProcessName": "WINWORD", "Path": "", "Description": "Microsoft Word"}]
    launcher._lnk_targets = lambda paths: {}
    launcher._close_gracefully = lambda pid: (_ for _ in ()).throw(AssertionError("refused request reached the closer"))
    st, j = call("POST", "/api/close", "https://evil.example", {"apps": [word]})
    t("POST /api/close from another site is 403", st == 403)
    st, j = call("POST", "/api/close", None, {"apps": [word]})
    t("POST /api/close with no origin is 403", st == 403)
    t("GET /api/running from another site is 403", call("GET", "/api/running", "https://evil.example")[0] == 403)
    st, j = call("GET", "/api/running", "https://anthonyn99.github.io")
    t("GET /api/running from TaskHub names the open apps", st == 200 and j["running"] == [{"id": word, "name": "Microsoft Word"}], j)
    launcher._close_gracefully = lambda pid: True
    st, j = call("POST", "/api/close", "https://anthonyn99.github.io", {"apps": [word]})
    t("POST /api/close from TaskHub closes it (stub)", st == 200 and j["ok"] and (j["closed"] + j["stillOpen"]) == ["Microsoft Word"], j)
    t("health still answers", call("GET", "/health")[1].get("ok") is True)
finally:
    srv.shutdown()

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
