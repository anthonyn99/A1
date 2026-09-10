"""Subprocess helpers that never flash a console window.

Every helper process MAGI starts -- PowerShell to find a Chrome holding a
profile, taskkill to free a port, cloudflared to open a tunnel -- pops a
console window on Windows unless it is told not to. A council run launches four
providers and each one shelled out twice, so hitting Convene strobed the
desktop with black windows for several seconds before settling.

That is not cosmetic. MAGI's whole premise is that runs are INVISIBLE: the
four browsers are headless precisely so a run does not take over the machine,
and then the plumbing around them undid it.

So nothing in this package calls subprocess directly. `run` and `popen` are
the only entry points, and both set CREATE_NO_WINDOW, which makes the fix
structural rather than something to remember at each call site.
"""

from __future__ import annotations

import subprocess

# 0 on non-Windows, where the flag does not exist and no window is created.
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def run(cmd: list[str], **kw):
    """subprocess.run with the console window suppressed."""
    kw.setdefault("creationflags", NO_WINDOW)
    return subprocess.run(cmd, **kw)


def popen(cmd: list[str], **kw):
    """subprocess.Popen with the console window suppressed."""
    kw.setdefault("creationflags", NO_WINDOW)
    return subprocess.Popen(cmd, **kw)


def powershell(script: str, timeout: int = 20) -> str:
    """Run a PowerShell one-liner and return its stdout, or "" on any failure.

    -NoProfile matters for speed as much as predictability: a user profile can
    add seconds to startup, and this runs on the path that launches every
    provider.
    """
    try:
        return run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=timeout,
        ).stdout
    except Exception:
        return ""
