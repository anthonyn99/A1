"""PC app + site launcher for Veda's TaskHub AI prep (the ✨ button).

TaskHub's AI prep builds a KIT per flagged task: a prompt, a draft, the sites
and the PC apps she will need. A browser tab cannot start a desktop program,
and it may open only ONE new tab per click, so the kit's apps and sites are
handed to this bridge, which already runs on her PC from logon.

  GET  /api/apps     -> { ok, apps:[{id, name}] }   every Start Menu / Desktop app
  POST /api/launch   { apps:[id], urls:[url], focus?:url } -> { ok, opened, unknown }
  POST /api/close    { apps:[id], force? } -> { ok, closed, notRunning, stillOpen, failed }  (Neo)
  GET  /api/running  -> { ok, running:[{id, name}] }     which of her apps are open (Neo)

── ORDER: THE AI TAB ENDS UP IN FRONT ────────────────────────────────────────
Apps open first, then the sites, then `focus` (the AI assistant, prompt typed
in) LAST. A browser makes the newest tab the active one, so the assistant is
the tab she lands on with the sites waiting beside it. That is why the page
hands the assistant URL to this bridge instead of opening it itself whenever
the bridge is reachable: a tab the page opened first would end up buried
behind the sites opened after it.

── WHAT A REQUEST MAY NAME ───────────────────────────────────────────────────
Never a path, never a command. Apps are named by an opaque id that only this
module's own scan can resolve (a hash of the shortcut's path), and sites must
be plain http(s) URLs. So the worst a request can do is open a shortcut that is
already in her Start Menu, or a web page.

── WHO MAY ASK ───────────────────────────────────────────────────────────────
The bridge answers every origin for its AI jobs (Access-Control-Allow-Origin:
*), which is fine for those. It is NOT fine for launching programs: any page
she visits could POST to 127.0.0.1. Both routes here therefore require the
request's Origin header — set by the browser, not forgeable by a page — to be
TaskHub's own origin (see ALLOWED_ORIGINS). No Origin at all (curl, a script
on this machine) is refused too, so the gate cannot be skipped by omission.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

ALLOWED_ORIGINS = {
    "https://anthonyn99.github.io",
    "http://localhost",
    "http://127.0.0.1",
}

MAX_APPS = 3
MAX_URLS = 5
LAUNCH_GAP_S = 0.15          # windows fired in the same instant fight for focus
CACHE_TTL_S = 600

# Shortcut names that are never something to "open for a task".
_SKIP_WORDS = ("uninstall", "readme", "read me", "help", "website", "release notes",
               "license", "documentation", "manual", "changelog", "what's new",
               "support", "repair", "reset ")


LOG_FILE = Path(__file__).resolve().parent / "launch.log"


def log(event: str, origin: str | None, detail) -> None:
    """One line per request to launch.log (gitignored), so "the button did
    nothing" can be answered: did the request arrive, from which origin, and
    what opened. Never raises — a log failure must not break a launch."""
    try:
        line = json.dumps({"t": time.strftime("%Y-%m-%d %H:%M:%S"), "event": event,
                           "origin": origin or "", "detail": detail}, ensure_ascii=False)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def origin_allowed(origin: str | None) -> bool:
    if not origin:
        return False
    o = origin.strip().rstrip("/").lower()
    if o in ALLOWED_ORIGINS:
        return True
    # localhost on any port (a dev server)
    p = urlparse(o)
    return p.scheme in ("http", "https") and p.hostname in ("localhost", "127.0.0.1") and not p.path


def shortcut_roots() -> list[Path]:
    roots = []
    appdata = os.environ.get("APPDATA")
    progdata = os.environ.get("PROGRAMDATA")
    profile = os.environ.get("USERPROFILE")
    public = os.environ.get("PUBLIC")
    if appdata:
        roots.append(Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs")
    if progdata:
        roots.append(Path(progdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs")
    if profile:
        roots.append(Path(profile) / "Desktop")
        roots.append(Path(profile) / "OneDrive" / "Desktop")
    if public:
        roots.append(Path(public) / "Desktop")
    return roots


def app_id(path: Path) -> str:
    return hashlib.sha1(str(path).lower().encode("utf-8")).hexdigest()[:12]


def _skip(name: str) -> bool:
    n = name.lower()
    return any(w in n for w in _SKIP_WORDS)


def start_apps() -> list[dict]:
    """Windows' own Start-menu list (Get-StartApps): [{"Name", "AppID"}].

    This is the source that sees MICROSOFT STORE apps. Those have no .lnk at all
    (on Windows 11 that includes Notepad, Calculator, Store WhatsApp/Spotify), so
    a shortcut scan alone silently missed them. Every entry, Store or desktop,
    opens the same way: shell:AppsFolder\<AppID>.
    """
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress"],
            capture_output=True, text=True, timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        data = json.loads(r.stdout or "[]")
    except (OSError, ValueError, subprocess.SubprocessError):
        return []
    if isinstance(data, dict):
        data = [data]
    return [d for d in data if isinstance(d, dict)]


def _safe_appid(a) -> bool:
    return (isinstance(a, str) and 0 < len(a) < 400
            and not any(c in a for c in '"\r\n\t\x00'))


def scan_apps(roots: list[Path] | None = None, start: list[dict] | None = None) -> dict[str, dict]:
    """{id: {"name", "path"}} for every launchable app. Paths stay here.

    Start-menu apps first (they include Store apps), then .lnk shortcuts for
    anything only on a Desktop. One entry per app name.
    """
    out: dict[str, dict] = {}
    seen_names: set[str] = set()
    for d in (start if start is not None else (start_apps() if roots is None else [])):
        name = str(d.get("Name") or "").strip()
        aid = d.get("AppID")
        if not name or _skip(name) or not _safe_appid(aid) or name.lower() in seen_names:
            continue
        seen_names.add(name.lower())
        target = "shell:AppsFolder\\" + aid
        out[app_id(Path(target))] = {"name": name[:80], "path": target}
    for root in roots if roots is not None else shortcut_roots():
        try:
            if not root.is_dir():
                continue
            files = sorted(root.rglob("*.lnk"))
        except OSError:
            continue
        for f in files:
            name = f.stem.strip()
            if not name or _skip(name):
                continue
            key = name.lower()
            if key in seen_names:          # same app in Start Menu AND on the Desktop
                continue
            seen_names.add(key)
            out[app_id(f)] = {"name": name[:80], "path": str(f)}
    return out


_cache: dict = {"at": 0.0, "apps": {}}
_cache_lock = threading.Lock()


def apps(force: bool = False) -> dict[str, dict]:
    with _cache_lock:
        if force or not _cache["apps"] or time.time() - _cache["at"] > CACHE_TTL_S:
            _cache["apps"] = scan_apps()
            _cache["at"] = time.time()
        return _cache["apps"]


def public_list() -> list[dict]:
    return sorted(({"id": i, "name": a["name"]} for i, a in apps().items()),
                  key=lambda a: a["name"].lower())


def is_web_url(u) -> bool:
    # 16000, not 4000: a kit's Gmail draft link carries the whole email, and a
    # long one was silently dropped from the sites that open.
    if not isinstance(u, str) or len(u) > 16000:
        return False
    p = urlparse(u.strip())
    return p.scheme in ("http", "https") and bool(p.hostname)


FOCUS_URL_MAX = 16000                      # the assistant URL carries the whole prompt


def browser_command() -> str | None:
    """The default browser's open command, e.g.
    '"C:\\...\\brave.exe" --single-argument %1'.

    URLs go through this rather than os.startfile because ShellExecute is not
    safe with long URLs (the ~2083-char INTERNET_MAX_URL_LENGTH), and the
    assistant URL carries a prompt of up to 6000 characters, percent-encoded.
    A process command line allows 32767.
    """
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice") as k:
            prog = winreg.QueryValueEx(k, "ProgId")[0]
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, prog + r"\shell\open\command") as k:
            cmd = winreg.QueryValueEx(k, "")[0]
        return cmd if "%1" in cmd else None
    except OSError:
        return None


def _open_url(url: str) -> None:
    cmd = browser_command()
    # The URL is percent-encoded http(s) (is_web_url checked it), so it holds no
    # quote or space that could break out of the template's argument.
    if cmd and '"' not in url and " " not in url:
        subprocess.Popen(cmd.replace("%1", url),
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    else:
        os.startfile(url)                  # noqa: S606


def is_web_url_long(u) -> bool:
    """is_web_url for the assistant URL, which may be longer than 4000 chars."""
    if not isinstance(u, str) or len(u) > FOCUS_URL_MAX:
        return False
    p = urlparse(u.strip())
    return p.scheme in ("http", "https") and bool(p.hostname)


def _start(target: str) -> None:          # indirection so tests never open anything
    if is_web_url(target):
        _open_url(target)
    else:
        os.startfile(target)               # noqa: S606 — a scanned .lnk / shell:AppsFolder id


def launch(app_ids, urls, *, focus=None, starter=None, table=None) -> dict:
    starter = starter or _start
    table = table if table is not None else apps()
    ids = [str(i) for i in (app_ids or []) if isinstance(i, str)][:MAX_APPS]
    # A stale id (the shortcut was renamed or removed) gets one rescan before
    # being reported unknown.
    if table is not None and any(i not in table for i in ids) and table is _cache.get("apps"):
        table = apps(force=True)
    good_urls = [u.strip() for u in (urls or []) if is_web_url(u)][:MAX_URLS]
    focus_url = focus.strip() if is_web_url_long(focus) else None
    opened, unknown, failed = [], [], []
    # Apps first: their windows take a moment to appear, and the browser should
    # be what is in front at the end.
    for i in ids:
        a = table.get(i)
        if not a:
            unknown.append(i)
            continue
        try:
            starter(a["path"])
            opened.append(a["name"])
        except OSError:
            failed.append(a["name"])
        time.sleep(LAUNCH_GAP_S)
    for u in good_urls:
        try:
            starter(u)
            opened.append(u)
        except OSError:
            failed.append(u)
        time.sleep(LAUNCH_GAP_S)
    # The assistant LAST, so it is the active tab (see the module docstring).
    if focus_url:
        if good_urls:
            time.sleep(LAUNCH_GAP_S * 2)
        try:
            starter(focus_url)
            opened.append("focus")
        except OSError:
            failed.append("focus")
    return {"ok": True, "opened": opened, "unknown": unknown, "failed": failed}


# ══ closing apps (Neo: "close Spotify") ═══════════════════════════════════════
#   POST /api/close    { apps:[id], force?:false, browser?:false }
#                      -> { ok, closed, notRunning, stillOpen, failed, unknown }
#   GET  /api/running  -> { ok, running:[{id, name}] }     which of her apps are open now
#
# The same rules as launching: a request names only ids from this module's own
# scan, never a process or a path, and only TaskHub's origin may ask. An app id
# becomes processes by what the app IS on disk:
#   · a .lnk          → its target .exe (read through WScript.Shell)
#   · a Store app     → shell:AppsFolder\<family>!<app> → that package's folder
#   · a desktop app Windows lists by AppID → the .exe inside it, when it names one
# and, for every kind, a windowed process whose own description is the app's
# name ("Microsoft Word" for Word, "Discord" for Discord's Update.exe shortcut).
#
# Graceful first: CloseMainWindow is the same as clicking ✕, so an app with
# unsaved work asks "save changes?" and stays open. That is reported as
# stillOpen, never as closed. Only force:true ("force quit Spotify") kills.
#
# Never: Windows' own processes, this bridge's Python, or anything not matched
# to one of her apps. The default browser (the one TaskHub runs in) is closed
# only when the request says browser:true, i.e. she named it herself.

CLOSE_WAIT_S = 2.5               # time an app gets to close before it counts as "asking to save"
MAX_CLOSE = 12

# Processes nothing here may ever close, whatever an app entry resolves to.
DENY_PROCS = {"explorer", "dwm", "csrss", "winlogon", "wininit", "lsass", "services", "smss",
              "svchost", "sihost", "fontdrvhost", "system", "idle", "registry", "conhost",
              "ctfmon", "taskhostw", "runtimebroker", "startmenuexperiencehost",
              "shellexperiencehost", "searchhost", "searchapp", "textinputhost",
              "applicationframehost", "lockapp", "securityhealthsystray", "taskmgr",
              "python", "pythonw", "py", "pyw", "python3", "pythonw3", "python3.11", "pythonw3.11"}

# FOLDERID GUIDs that Get-StartApps puts at the front of a desktop app's AppID.
_WINDIR = os.environ.get("SystemRoot") or r"C:\Windows"
_KNOWN_FOLDERS = {
    "{6d809377-6af0-444b-8957-a3773f02200e}": os.environ.get("ProgramW6432") or os.environ.get("ProgramFiles") or r"C:\Program Files",
    "{7c5a40ef-a0fb-4bfc-874a-c0f2e0b9fa8e}": os.environ.get("ProgramFiles(x86)") or r"C:\Program Files (x86)",
    "{f38bf404-1d43-42f2-9305-67de0b28fc23}": _WINDIR,
    "{1ac14e77-02e7-4e5d-b744-2eb1ae5198b7}": os.path.join(_WINDIR, "System32"),
    "{d65231b0-b2f1-4857-a4ce-a8e7c6ea7d27}": os.path.join(_WINDIR, "SysWOW64"),
}


def _ps_json(script: str, stdin: str = "", timeout: int = 20):
    """Run a PowerShell snippet and parse its JSON output (None on any failure)."""
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                           input=stdin, capture_output=True, text=True, timeout=timeout,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return json.loads(r.stdout or "null")
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def list_processes() -> list[dict]:
    """Windowed processes: [{Id, ProcessName, Path, Description}]. Only those
    with a main window, because those are the ones a person means by "open"."""
    data = _ps_json("Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | "
                    "Select-Object Id, ProcessName, Path, Description | ConvertTo-Json -Compress")
    if isinstance(data, dict):
        data = [data]
    return [d for d in (data or []) if isinstance(d, dict) and isinstance(d.get("Id"), int)]


def _lnk_targets(paths: list[str]) -> dict[str, str]:
    if not paths:
        return {}
    data = _ps_json("$s = New-Object -ComObject WScript.Shell; $o = @{}; "
                    "foreach ($p in ($input | Out-String | ConvertFrom-Json)) "
                    "{ try { $o[$p] = $s.CreateShortcut($p).TargetPath } catch {} }; "
                    "$o | ConvertTo-Json -Compress", stdin=json.dumps(paths), timeout=40)
    return {k: v for k, v in data.items() if isinstance(v, str)} if isinstance(data, dict) else {}


_pkg_cache: dict = {"at": 0.0, "map": {}}


def _store_locations() -> dict[str, str]:
    """{PackageFamilyName (lower): InstallLocation} for her Store apps."""
    if time.time() - _pkg_cache["at"] > CACHE_TTL_S or not _pkg_cache["map"]:
        data = _ps_json("Get-AppxPackage | Select-Object PackageFamilyName, InstallLocation | "
                        "ConvertTo-Json -Compress", timeout=30)
        if isinstance(data, dict):
            data = [data]
        _pkg_cache["map"] = {str(d.get("PackageFamilyName") or "").lower(): str(d.get("InstallLocation") or "")
                             for d in (data or []) if isinstance(d, dict) and d.get("InstallLocation")}
        _pkg_cache["at"] = time.time()
    return _pkg_cache["map"]


def aumid_target(aumid: str, store: dict[str, str] | None = None) -> str:
    """The .exe, or folder (ending in a backslash), an AppsFolder AppID points at; '' when unknown."""
    a = str(aumid or "")
    low = a.lower()
    for guid, folder in _KNOWN_FOLDERS.items():
        if low.startswith(guid):
            rest = a[len(guid):].lstrip("\\/")
            return os.path.join(folder, rest).lower() if rest.lower().endswith(".exe") else ""
    if "!" in a:                                     # a Store app: <PackageFamilyName>!<AppId>
        loc = (store if store is not None else _store_locations()).get(a.split("!", 1)[0].lower(), "")
        return (loc.rstrip("\\") + "\\").lower() if loc else ""
    if re.match(r"^[a-z]:\\", low) and low.endswith(".exe"):
        return low
    return ""


def resolve_targets(table: dict[str, dict], lnk_reader=None, store=None) -> None:
    """Fill in each entry's "exe" (a lower-case .exe path or folder prefix, or "")
    once. Cached on the entry, so the PowerShell calls happen once per scan."""
    todo = [a for a in table.values() if "exe" not in a]
    if not todo:
        return
    lnks = [a["path"] for a in todo if str(a.get("path", "")).lower().endswith(".lnk")]
    got = (lnk_reader or _lnk_targets)(lnks) if lnks else {}
    for a in todo:
        p = str(a.get("path", ""))
        if p.lower().endswith(".lnk"):
            a["exe"] = str(got.get(p) or "").lower()
        elif p.lower().startswith("shell:appsfolder\\"):
            a["exe"] = aumid_target(p[len("shell:AppsFolder\\"):], store)
        else:
            a["exe"] = ""


def _words(s) -> list[str]:
    return [w for w in re.sub(r"[^a-z0-9+#]+", " ", str(s or "").lower()).split() if w]


def proc_matches(app: dict, proc: dict) -> bool:
    """Is this running process (one of) this app?"""
    pname = str(proc.get("ProcessName") or "").lower()
    if pname in DENY_PROCS:
        return False
    path = str(proc.get("Path") or "").lower()
    exe = str(app.get("exe") or "")
    if exe and path:
        if exe.endswith("\\") and path.startswith(exe):
            return True
        if path == exe:
            return True
    # By what the process calls itself: its description IS the app's name, or
    # the name with the maker in front ("Microsoft Word" for Word). Not a name
    # that merely starts the description: "Visual Studio" is not VS Code.
    # Never a name shorter than three letters.
    name = _words(app.get("name"))
    if not name or len("".join(name)) < 3:
        return False
    desc = _words(proc.get("Description"))
    if desc and (desc == name or desc[1:] == name):
        return True
    return _words(pname) == name


def browser_exe() -> str:
    """The default browser's .exe (lower case), or ''. TaskHub runs in it."""
    cmd = browser_command() or ""
    m = re.match(r'^\s*"([^"]+\.exe)"', cmd) or re.match(r"^\s*(\S+\.exe)", cmd, re.I)
    return m.group(1).lower() if m else ""


def running(*, table=None, lister=None, lnk_reader=None, store=None) -> list[dict]:
    table = table if table is not None else apps()
    resolve_targets(table, lnk_reader, store)
    procs = (lister or list_processes)()
    out = [{"id": i, "name": a["name"]} for i, a in table.items() if any(proc_matches(a, p) for p in procs)]
    return sorted(out, key=lambda a: a["name"].lower())


def _close_gracefully(pid: int) -> bool:
    """WM_CLOSE to its main window, the same as clicking ✕. True when the
    window took the message (the app may still ask to save)."""
    r = _ps_json(f"$p = Get-Process -Id {int(pid)} -ErrorAction SilentlyContinue; "
                 "if ($p) { $p.CloseMainWindow() | ConvertTo-Json } else { 'true' }")
    return r is True or r == "true"


def _kill(pid: int) -> bool:
    try:
        r = subprocess.run(["taskkill", "/F", "/T", "/PID", str(int(pid))], capture_output=True, text=True,
                           timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def close(app_ids, *, force=False, allow_browser=False, table=None, lister=None, closer=None,
          killer=None, wait_s=None, lnk_reader=None, store=None, bexe=None) -> dict:
    """Close her apps by id. allow_browser: she named the browser itself."""
    table = table if table is not None else apps()
    lister = lister or list_processes
    ids = [str(i) for i in (app_ids or []) if isinstance(i, str)][:MAX_CLOSE]
    if table is _cache.get("apps") and any(i not in table for i in ids):
        table = apps(force=True)
    resolve_targets(table, lnk_reader, store)
    procs = lister()
    protect = "" if allow_browser else (browser_exe() if bexe is None else bexe)
    res = {"ok": True, "closed": [], "notRunning": [], "stillOpen": [], "failed": [], "unknown": []}
    asked: list[tuple[str, list[int]]] = []
    for i in ids:
        a = table.get(i)
        if not a:
            res["unknown"].append(i)
            continue
        mine = [p for p in procs if proc_matches(a, p)
                and not (protect and str(p.get("Path") or "").lower() == protect)]
        if not mine:
            res["notRunning"].append(a["name"])
            continue
        pids = [p["Id"] for p in mine]
        if force:
            ok = all([(killer or _kill)(pid) for pid in pids])
            res["closed" if ok else "failed"].append(a["name"])
            continue
        if not any([(closer or _close_gracefully)(pid) for pid in pids]):
            res["failed"].append(a["name"])
            continue
        asked.append((a["name"], pids))
    if asked:
        time.sleep(CLOSE_WAIT_S if wait_s is None else wait_s)
        alive = {p.get("Id") for p in lister()}
        for name, pids in asked:
            res["stillOpen" if any(pid in alive for pid in pids) else "closed"].append(name)
    return res
