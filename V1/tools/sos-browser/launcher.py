"""PC app + site launcher for Veda's TaskHub AI prep (the ✨ button).

TaskHub's AI prep builds a KIT per flagged task: a prompt, a draft, the sites
and the PC apps she will need. A browser tab cannot start a desktop program,
and it may open only ONE new tab per click, so the kit's apps and sites are
handed to this bridge, which already runs on her PC from logon.

  GET  /api/apps     -> { ok, apps:[{id, name}] }   every Start Menu / Desktop app
  POST /api/launch   { apps:[id], urls:[url] } -> { ok, opened, unknown }

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
    if not isinstance(u, str) or len(u) > 4000:
        return False
    p = urlparse(u.strip())
    return p.scheme in ("http", "https") and bool(p.hostname)


def _start(target: str) -> None:          # indirection so tests never open anything
    os.startfile(target)                   # noqa: S606 — a scanned .lnk / shell:AppsFolder id, or an http(s) url


def launch(app_ids, urls, *, starter=None, table=None) -> dict:
    starter = starter or _start
    table = table if table is not None else apps()
    ids = [str(i) for i in (app_ids or []) if isinstance(i, str)][:MAX_APPS]
    # A stale id (the shortcut was renamed or removed) gets one rescan before
    # being reported unknown.
    if table is not None and any(i not in table for i in ids) and table is _cache.get("apps"):
        table = apps(force=True)
    good_urls = [u.strip() for u in (urls or []) if is_web_url(u)][:MAX_URLS]
    opened, unknown, failed = [], [], []
    for u in good_urls:
        try:
            starter(u)
            opened.append(u)
        except OSError:
            failed.append(u)
        time.sleep(LAUNCH_GAP_S)
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
    return {"ok": True, "opened": opened, "unknown": unknown, "failed": failed}
