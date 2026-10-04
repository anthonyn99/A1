"""Codex runs only in its ELEVATED Windows sandbox -- or not at all.

Found 2026-10-04 (Track V), on MAGI's own settings: in the `unelevated`
sandbox a command can DELETE files anywhere the user can -- a scratch file on
the Desktop went, from read-only AND workspace-write -- while writes and
renames outside are denied. A prompt-injected task could delete your files.
In the `elevated` sandbox (Codex's own sandbox users + ACLs + firewall rules)
the same delete is "Access is denied", reads still work everywhere (Codex
reads through its shell, and "Also read" folders by path), and writes still
land in the task's copy. Its firewall rules also keep the sandbox off
127.0.0.1, under the engine's own agent guard.

`elevated` needs a one-time setup per PC, done by Codex itself the first time
it is used, with a Windows admin prompt (UAC). An engine running windowless
must never sit waiting on that prompt, so before Codex is used MAGI asks
`ready()`: one sandboxed `echo`, at most PROBE_TIMEOUT_S, remembered per
Codex version (an update may need the setup again). Not ready -> Codex is
unavailable with the sentence that says how to set it up; the chain hands on.
MAGI never falls back to the unelevated sandbox.
"""

from __future__ import annotations

import subprocess
import tempfile
import threading
import time

from ... import proc

IMPL = "elevated"
PROBE_TIMEOUT_S = 60
RETRY_FAILED_S = 10 * 60        # a failed check is asked again after this
_MARK = "magi-sandbox-ok"
SETUP_COMMAND = "codex sandbox -c windows.sandbox=elevated -- cmd /c echo ready"
SETUP_HINT = ("Codex's protected sandbox is not set up on this PC. Once, in PowerShell, run "
              f"`{SETUP_COMMAND}` and choose Yes on the Windows prompt. Until then MAGI "
              "does not use Codex here.")

_lock = threading.Lock()
_cache: dict[str, tuple[bool, str, float]] = {}      # version -> (ok, why, at)


def probe_argv(exe: str) -> list[str]:
    return [exe, "sandbox", "-c", "sandbox_mode=read-only", "-c", f"windows.sandbox={IMPL}",
            "--", "cmd.exe", "/d", "/c", f"echo {_MARK}"]


def _probe(exe: str, env: dict, timeout: float | None = None) -> tuple[bool, str]:
    """Never longer than the timeout plus a few seconds. Not subprocess.run:
    on a timeout it kills only the .cmd shim, and then waits for ever on a
    pipe the grandchild (node, codex.exe) still holds. Here the whole tree
    is killed and every wait after that is bounded."""
    limit = PROBE_TIMEOUT_S if timeout is None else timeout
    try:
        p = proc.popen(probe_argv(exe), cwd=tempfile.gettempdir(), env=env,
                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    except OSError as e:
        return False, f"Codex's sandbox could not start: {e}"
    try:
        out, _ = p.communicate(timeout=limit)
    except subprocess.TimeoutExpired:
        try:
            proc.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True, timeout=15)
        except (OSError, subprocess.SubprocessError):
            p.kill()
        try:
            p.communicate(timeout=5)
        except (subprocess.TimeoutExpired, ValueError, OSError):
            pass
        return False, SETUP_HINT + " (The check waited a minute -- probably on that prompt.)"
    if _MARK in (out or ""):
        return True, ""
    tail = (out or "").strip().splitlines()[-1:] or [""]
    return False, SETUP_HINT + (f" (Codex said: {tail[0][:200]})" if tail[0] else "")


def ready(exe: str, env: dict, version: str) -> tuple[bool, str]:
    """(usable, why not). Cached: a pass for this Codex version for good, a
    failure for RETRY_FAILED_S. One check at a time."""
    with _lock:
        hit = _cache.get(version)
        if hit and (hit[0] or time.time() - hit[2] < RETRY_FAILED_S):
            return hit[0], hit[1]
        ok, why = _probe(exe, env)
        _cache[version] = (ok, why, time.time())
        return ok, why


def forget() -> None:
    with _lock:
        _cache.clear()
