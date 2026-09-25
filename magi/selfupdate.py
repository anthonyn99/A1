"""Keep every engine on the latest pushed code, with nobody running anything.

The engine loads its Python once, at start, so a fix pushed to A1 used to be
inert on every PC until someone there pulled, installed any new package and
restarted -- by hand, in a terminal. Veda's engine sat on old code for days
that way (the GitHub sign-in and Studio's Video both waited on it).

Three pieces, all in here so they cannot disagree:

  * `code_rev()` -- a fingerprint of the ENGINE code in the committed tree
    (magi/, minus tests and docs). The engine reports the one it started with
    on /api/health; comparing it with the one on disk says whether a restart
    would change anything.
  * `update_checkout()` -- fetch, pull when behind, and install requirements
    when requirements.txt changed since the last install. Used by the
    watchdog on its timer and by the restarter, so the console's "Restart
    engine" button picks up everything too.
  * `tick()` -- the watchdog's half: pull if behind, and restart the engine
    through its own /api/restart when the running code is stale. Never
    forced: /api/restart refuses (409) while a deliberation, Studio card,
    brainstorm, Code Mode task or sign-in is live, and the next tick simply
    tries again.

Everything here fails closed. A pull that cannot finish cleanly is undone and
logged; the engine keeps running the code it has. Nothing is ever reset,
checked out over, or force-pushed.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import proc
from .settings import ROOT, data_dir

REPO = ROOT.parent                     # ...\A1
FETCH_EVERY_S = 240                    # how often a watchdog tick asks GitHub
SETTLE_S = 60                          # a new rev must hold this long before a restart
GIT_TIMEOUT = 120
PIP_TIMEOUT = 900

# Engine code is magi/ minus what never runs in the engine. A commit that only
# touches a test or a doc must not bounce everyone's engine.
_IGNORED = ("magi/tests/", "magi/data/", "magi/profiles/", "magi/artifacts/")


def _git_exe() -> str | None:
    g = shutil.which("git")
    if g:
        return g
    for c in (r"C:\Program Files\Git\cmd\git.exe", r"C:\Program Files (x86)\Git\cmd\git.exe"):
        if Path(c).exists():
            return c
    return None


def _git(*args: str, timeout: int = GIT_TIMEOUT) -> subprocess.CompletedProcess:
    exe = _git_exe()
    if not exe:
        return subprocess.CompletedProcess(args, 127, b"", b"git not found")
    try:
        return proc.run([exe, "-C", str(REPO), *args], capture_output=True,
                        timeout=timeout, creationflags=proc.NO_WINDOW)
    except Exception as e:  # noqa: BLE001
        return subprocess.CompletedProcess(args, 1, b"", str(e).encode())


def _out(r: subprocess.CompletedProcess) -> str:
    return (r.stdout or b"").decode("utf-8", "replace").strip()


def _err(r: subprocess.CompletedProcess) -> str:
    return ((r.stderr or b"") + (r.stdout or b"")).decode("utf-8", "replace").strip()


def code_rev() -> str:
    """Fingerprint of the committed engine code. "" when there is no git."""
    r = _git("ls-tree", "-r", "HEAD", "--", "magi")
    if r.returncode != 0:
        return ""
    keep = [ln for ln in _out(r).splitlines()
            if not any(f"\t{p}" in ln for p in _IGNORED) and not ln.endswith(".md")]
    return hashlib.sha1("\n".join(keep).encode()).hexdigest()[:16]


def _log(line: str) -> None:
    p = data_dir() / "update.log"
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        old = p.read_text(encoding="utf-8", errors="replace").splitlines()[-300:] if p.exists() else []
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
        p.write_text("\n".join(old + [f"{stamp}  {line}"]) + "\n", encoding="utf-8")
    except OSError:
        pass


# ── one updater at a time, per checkout ──────────────────────────────────────
# Both profiles' watchdogs can share one A1 folder on a PC, and the restarter
# can run while a watchdog does. Two concurrent pulls would fight over the index.

def _lock_path() -> Path:
    return REPO / "magi" / "data" / ".update.lock"


def _acquire() -> bool:
    p = _lock_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        if p.exists() and time.time() - p.stat().st_mtime > 1800:
            p.unlink()                  # a crashed updater's lock
        fd = os.open(str(p), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except OSError:
        return False


def _release() -> None:
    try:
        _lock_path().unlink()
    except OSError:
        pass


# ── the checkout ─────────────────────────────────────────────────────────────

def _pull() -> tuple[bool, str]:
    """Fetch; pull --rebase --autostash when behind. (changed?, message)."""
    if not _git_exe():
        return False, "git not found"
    if (REPO / ".git" / "rebase-merge").exists() or (REPO / ".git" / "rebase-apply").exists() \
            or (REPO / ".git" / "MERGE_HEAD").exists():
        return False, "repository is mid-rebase/merge -- left alone"
    up = _out(_git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"))
    if not up:
        return False, "branch tracks no remote -- nothing to pull"
    f = _git("fetch", "--quiet")
    if f.returncode != 0:
        return False, f"fetch failed: {_err(f)[-200:]}"
    behind = _out(_git("rev-list", "--count", f"HEAD..{up}"))
    if not behind or behind == "0":
        return False, "up to date"
    before = _out(_git("rev-parse", "HEAD"))
    r = _git("pull", "--rebase", "--autostash", "--no-edit", "--quiet")
    if r.returncode != 0:
        # Undo rather than leave it half-done; the engine keeps its code.
        if (REPO / ".git" / "rebase-merge").exists() or (REPO / ".git" / "rebase-apply").exists():
            _git("rebase", "--abort")
        return False, f"pull failed and was undone: {_err(r)[-300:]}"
    after = _out(_git("rev-parse", "HEAD"))
    return before != after, f"pulled {behind} commit(s) from {up}"


def _req_marker() -> Path:
    return REPO / "magi" / ".venv" / ".requirements.sha1"


def ensure_requirements() -> str:
    """pip install -r requirements.txt when it changed since the last install."""
    req = REPO / "magi" / "requirements.txt"
    py = REPO / "magi" / ".venv" / "Scripts" / "python.exe"
    if not req.exists() or not py.exists():
        return "no venv/requirements -- skipped"
    want = hashlib.sha1(req.read_bytes()).hexdigest()
    try:
        if _req_marker().read_text().strip() == want:
            return "requirements unchanged"
    except OSError:
        pass
    try:
        r = proc.run([str(py), "-m", "pip", "install", "--disable-pip-version-check", "-q",
                      "-r", str(req)], capture_output=True, timeout=PIP_TIMEOUT,
                     creationflags=proc.NO_WINDOW)
    except Exception as e:  # noqa: BLE001
        return f"pip failed: {e}"
    if r.returncode != 0:
        return f"pip failed: {_err(r)[-300:]}"
    try:
        _req_marker().write_text(want)
    except OSError:
        pass
    return "requirements installed"


def update_checkout() -> str:
    """Pull and install. Safe to call any time; returns what it did."""
    if not _acquire():
        return "another updater is running"
    try:
        changed, msg = _pull()
        pip = ensure_requirements()
        line = f"{msg}; {pip}"
        if changed or "installed" in pip or "failed" in line:
            _log(line)
        return line
    finally:
        _release()


# ── the watchdog's half ──────────────────────────────────────────────────────

def _state_path() -> Path:
    return data_dir() / "update.json"


def _state() -> dict:
    try:
        return json.loads(_state_path().read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save(st: dict) -> None:
    try:
        _state_path().parent.mkdir(parents=True, exist_ok=True)
        _state_path().write_text(json.dumps(st), encoding="utf-8")
    except OSError:
        pass


def _health(port: int) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=4) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception:
        return None


def _ask_restart(port: int) -> tuple[bool, str]:
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/restart", method="POST",
                                 headers={"X-MAGI-Update": "1"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return True, r.read().decode("utf-8", "replace")[:200]
    except urllib.error.HTTPError as e:
        return False, f"{e.code} {e.read().decode('utf-8', 'replace')[:200]}"
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def tick(port: int, now: float | None = None) -> str:
    """One watchdog pass. Returns a short note of what happened."""
    now = time.time() if now is None else now
    st = _state()
    if now - st.get("fetched_at", 0) >= FETCH_EVERY_S:
        st["fetched_at"] = now
        _save(st)
        update_checkout()
    h = _health(port)
    if h is None:
        return "engine not answering"
    disk = code_rev()
    running = h.get("code_rev") or ""
    if not disk or running == disk:
        if st.pop("pending", None) is not None:
            _save(st)
        return "current"
    # Stale. Wait for the new code to settle -- a burst of commits restarts
    # once, at the end -- then ask the engine to restart itself.
    pend = st.get("pending") or {}
    if pend.get("rev") != disk:
        st["pending"] = {"rev": disk, "since": now}
        _save(st)
        return "new code seen; settling"
    if now - pend.get("since", now) < SETTLE_S:
        return "settling"
    ensure_requirements()
    ok, why = _ask_restart(port)
    if ok:
        _log(f"restarted engine for new code {running or 'old'} -> {disk}")
        st.pop("pending", None)
        _save(st)
        return "restarting"
    return f"restart deferred: {why}"


if __name__ == "__main__":          # python -m magi.selfupdate  -> pull + install now
    print(update_checkout())
    sys.exit(0)
