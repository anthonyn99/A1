"""The engine has to be running whenever the laptop is, and reachable at the
same address across a restart.

Three failures this pins, all of them observed:

  * 2026-09-19, after a reboot: the engine never started and nothing tried
    again. The Startup shortcut fires once at logon and has no opinion about
    what happens next -- so a crash, a bad import or a race with the network
    meant MAGI was simply down until someone noticed.
  * The watchdog's first version started the engine as its own child. Task
    Scheduler puts a task in a job object and kills what is left of it when
    the action exits, so the engine died with the watchdog: "engine is up",
    then nothing listening seconds later.
  * Every restart used to open a NEW quick tunnel, and a new random hostname
    takes seconds to minutes to register in DNS -- so phones lost MAGI on
    every restart, including the ones it does to itself.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

MAGI = REPO / "magi"
SERVE = (MAGI / "cli" / "serve.py").read_text(encoding="utf-8")
WATCHDOG = (MAGI / "watchdog.py").read_text(encoding="utf-8")
RESTARTER = (MAGI / "restarter.py").read_text(encoding="utf-8")
RESTART_PS1 = (MAGI / "restart.ps1").read_text(encoding="utf-8")
TUNNEL = (MAGI / "tunnel.py").read_text(encoding="utf-8")
PAGE = (REPO / "magi.html").read_text(encoding="utf-8")


# ── it starts by itself, and keeps starting ────────────────────────────────

def test_autostart_installs_both_tasks():
    # Per profile since profiles landed, but Tony's pair keeps the exact
    # names his already-registered tasks have -- renaming them would leave
    # an orphan running the old command line beside the new registration.
    assert 'def task_engine()' in WATCHDOG and '"MAGI Engine"' in WATCHDOG
    assert 'def task_watchdog()' in WATCHDOG and '"MAGI Watchdog"' in WATCHDOG
    assert 'task_engine()' in SERVE and 'task_watchdog()' in SERVE
    # The scheduled command must name the profile, or the task starts the
    # DEFAULT engine twice instead of one engine each.
    assert '{_task_args()}' in SERVE
    body = SERVE[SERVE.index("def _task_script"):SERVE.index("def autostart")]
    assert "-AtLogOn" in body, "the engine must start at logon"
    assert "RepetitionInterval" in body, "the watchdog must repeat, not fire once"
    # Without this Windows stops the engine after three days, which is a bug
    # nobody would connect to the cause a week later.
    assert "ExecutionTimeLimit ([TimeSpan]::Zero)" in body
    assert "-AllowStartIfOnBatteries" in body and "StopIfGoingOnBatteries = $false" in body


def test_installing_the_tasks_removes_the_old_shortcut():
    """Both would start an engine at logon, and the second one loses the port
    race and exits -- a confusing way to half-work."""
    body = SERVE[SERVE.index("def autostart"):]
    assert "lnk.unlink()" in body


def test_the_watchdog_starts_the_engine_as_a_TASK_not_a_child():
    assert '"schtasks", "/run", "/tn", task_engine()' in WATCHDOG, \
        "a child of the watchdog is killed when the watchdog's task ends"
    order = WATCHDOG.index("schtasks") < WATCHDOG.index("proc.popen")
    assert order, "the task must be tried FIRST; the direct start is the fallback"
    assert "_BREAKAWAY" in WATCHDOG, "the fallback needs to escape the job object too"


def test_the_watchdog_does_not_start_a_second_engine():
    body = WATCHDOG[WATCHDOG.index("def main"):]
    assert body.count("healthy(port)") >= 2, \
        "an engine mid-start is not a dead one; check twice before starting"


def test_the_restarter_uses_the_venv_and_the_task():
    assert 'schtasks", "/run", "/tn", task_engine()' in RESTARTER
    assert '".venv" / "Scripts" / "pythonw.exe"' in RESTARTER.replace('"magi" / ', ''), \
        "sys.executable alone starts the SYSTEM python, which has no deps"
    assert "if not _port_free(port) and not _alive(pid)" in RESTARTER, \
        "starting while another engine holds the port makes two engines"


# ── the address survives a restart ─────────────────────────────────────────

def test_restart_ps1_leaves_the_tunnel_running():
    assert "cloudflared.exe" in RESTART_PS1 and "continue" in RESTART_PS1, \
        "the tunnel must be excluded from the kill"
    assert "/f /t /pid" not in RESTART_PS1, \
        "a tree kill takes cloudflared with it, and the url changes again"


def test_adoption_proves_the_tunnel_reaches_THIS_engine():
    assert "ident.INSTANCE" in TUNNEL, \
        "a 401 is also what an orphan tunnel answers; adopt on identity"
    assert "def reaches_me" in TUNNEL and "trusted" in TUNNEL, \
        "a url learned from the remote record must not be handed the token blind"


def test_adoption_keeps_the_published_record():
    """Withdrawing or republishing would change what the phone sees, which is
    the whole thing adoption exists to avoid."""
    body = SERVE[SERVE.index("adopt the tunnel the previous engine"):SERVE.index("# Clear the old record")]
    assert "_withdraw" not in body
    assert "_publish" not in body


def test_strays_are_reaped_everywhere_one_can_appear():
    assert "def reap" in TUNNEL
    # startup fallback, and after each watchdog replacement
    assert SERVE.count("tunnel_mod.reap(") >= 2, \
        "a cloudflared left behind is a live public route into this machine"


def test_a_ghost_engine_refuses_to_run():
    assert "def _mine" in SERVE
    body = SERVE[SERVE.index("def cloud("):]
    assert "if not _mine(port):" in body, \
        "an engine that lost the port race opened a SECOND tunnel"


# ── the console comes back on its own ──────────────────────────────────────

def test_the_page_retries_while_the_engine_is_down():
    assert "function tryReconnect" in PAGE
    assert 'if (where === "down")' in PAGE, "the retry loop follows the link state"
    assert "document.hidden" in PAGE, "a phone in a pocket must not poll"
    assert re.search(r"visibilitychange", PAGE), "becoming visible should retry at once"


def test_a_silent_retry_does_not_flash_the_status():
    assert "async function connect(quiet = false)" in PAGE
    assert "connect(true)" in PAGE
