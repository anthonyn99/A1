"""Keeping Claude Code and Codex current on the engine PC.

A model the account lists can still be refused by an older CLI ("Claude
Code 2.1.278 does not support this model; version 2.1.280 or newer is
required", found live), so the CLIs' versions are part of what decides
which models MAGI can use. This module says how far behind each one is and
updates it -- when you press **Update now**, or by itself when
`auto_update` is on (the default).

    Claude Code   claude update                      (its own updater)
    Codex         npm install -g @openai/codex@latest

Rules that keep an update from ever getting in the way:

  * **Never mid-work.** Not while a Code Mode task is running, not during a
    sign-in, and an agent reports itself unavailable while its CLI is being
    replaced -- the chain simply uses the next one for a minute. Windows
    cannot overwrite a running .exe anyway; this makes that a non-event.
  * **Automatic updates only while idle,** checked every 10 minutes, asking
    npm for the latest version at most every 6 hours -- and at once when a
    model is waiting on a newer version.
  * **Nothing here touches a login.** Sign-ins live in the slot folders
    (slots.py), not in the install; an update keeps every account signed in.
  * The install is the one on PATH (`slots.cli_path`) -- the copy MAGI runs.
    The Claude desktop app and the VS Code extension carry their own.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field

from ... import proc
from . import models, slots

PACKAGE = {"claude": "@anthropic-ai/claude-code", "codex": "@openai/codex"}
NAME = {"claude": "Claude Code", "codex": "Codex CLI"}
LATEST_TTL = 6 * 3600
CHECK_EVERY = 10 * 60
UPDATE_TIMEOUT = 10 * 60

_latest: dict[str, tuple[float, str]] = {}
_lock = threading.Lock()


@dataclass
class Job:
    agent: str
    auto: bool = False
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])
    state: str = "running"          # running | done | failed
    before: str = ""
    after: str = ""
    text: str = ""
    started: float = field(default_factory=time.time)
    ended: float | None = None

    def to_dict(self) -> dict:
        return asdict(self)


JOBS: dict[str, Job] = {}           # the latest job per agent


def _npm() -> str | None:
    for n in ("npm.cmd", "npm"):
        p = shutil.which(n)
        if p:
            return p
    return None


def latest(agent: str, *, force: bool = False) -> str:
    """The newest published version (`npm view`), cached 6 hours."""
    hit = _latest.get(agent)
    if hit and not force and time.time() - hit[0] < LATEST_TTL:
        return hit[1]
    v = ""
    npm = _npm()
    if npm and agent in PACKAGE:
        try:
            r = proc.run([npm, "view", PACKAGE[agent], "version"], capture_output=True, text=True,
                         timeout=60, stdin=subprocess.DEVNULL, encoding="utf-8", errors="replace")
            out = (r.stdout or "").strip().splitlines()
            cand = out[-1].strip() if out else ""
            v = cand if models._ver(cand) and r.returncode == 0 else ""
        except Exception:  # noqa: BLE001 -- no answer is "unknown", not an error
            v = ""
    _latest[agent] = (time.time(), v if v else (hit[1] if hit else ""))
    return _latest[agent][1]


def updating(agent: str) -> bool:
    j = JOBS.get(agent)
    return bool(j and j.state == "running")


def busy() -> str:
    """Why an update must wait, or ""."""
    from .. import tasks
    if tasks.running():
        return "A Code Mode task is running; the update waits for it to finish."
    from . import login
    if any(getattr(j, "state", "") in ("starting", "waiting") for j in login.JOBS.values()):
        return "A sign-in is in progress; the update waits for it."
    return ""


def status(agent: str, *, check: bool = False) -> dict:
    installed = models.cli_version(agent) if slots.cli_path(agent) else ""
    newest = latest(agent, force=check) if installed else ""
    behind = bool(installed and newest and models._ver(newest) > models._ver(installed))
    j = JOBS.get(agent)
    return {"agent": agent, "name": NAME[agent], "installed": installed, "latest": newest,
            "outdated": behind, "waiting": models.waiting_on_cli(agent),
            "job": j.to_dict() if j else None}


def _argv(agent: str) -> list[str] | None:
    if agent == "claude":
        exe = slots.cli_path("claude")
        return [exe, "update"] if exe else None
    npm = _npm()
    return [npm, "install", "-g", f"{PACKAGE['codex']}@latest"] if npm else None


def _env() -> dict[str, str]:
    env = dict(os.environ)
    # MAGI's task runs switch the updater off; the update itself must not.
    env.pop("DISABLE_AUTOUPDATER", None)
    return env


def _run(job: Job) -> None:
    argv = _argv(job.agent)
    try:
        if not argv:
            raise RuntimeError(f"{NAME[job.agent]} or npm is not installed on this PC.")
        r = proc.run(argv, capture_output=True, text=True, timeout=UPDATE_TIMEOUT, env=_env(),
                     stdin=subprocess.DEVNULL, encoding="utf-8", errors="replace")
        out = ((r.stdout or "") + "\n" + (r.stderr or "")).strip()
        job.after = models.cli_version(job.agent, fresh=True)
        if r.returncode != 0 or not job.after:
            job.state = "failed"
            tail = out[-400:] or f"exited {r.returncode}"
            job.text = f"The update did not finish: {tail}"
        else:
            job.state = "done"
            job.text = (f"Updated {NAME[job.agent]} from {job.before} to {job.after}."
                        if job.after != job.before else
                        f"{NAME[job.agent]} {job.after} is already the latest.")
            _latest[job.agent] = (time.time(), max(job.after, latest(job.agent),
                                                   key=models._ver))
    except subprocess.TimeoutExpired:
        job.state, job.text = "failed", "The update took longer than 10 minutes and was stopped."
    except Exception as e:  # noqa: BLE001 -- the job must end with a sentence
        job.state, job.text = "failed", f"The update did not run: {e}"
    finally:
        job.ended = time.time()
        models.cli_version(job.agent, fresh=True)


def start(agent: str, *, auto: bool = False, wait: bool = False) -> Job:
    """Begin updating one CLI. Raises ValueError with the reason it cannot."""
    if agent not in PACKAGE:
        raise ValueError(f"Unknown agent {agent!r}.")
    if not slots.cli_path(agent):
        raise ValueError(f"{NAME[agent]} is not installed on this PC.")
    with _lock:
        if updating(agent):
            return JOBS[agent]
        why = busy()
        if why:
            raise ValueError(why)
        job = Job(agent=agent, auto=auto, before=models.cli_version(agent, fresh=True))
        JOBS[agent] = job
    t = threading.Thread(target=_run, args=(job,), name=f"update-{agent}", daemon=True)
    t.start()
    if wait:
        t.join()
    return job


_last_auto: dict[str, float] = {}


def auto_tick(now: float | None = None) -> list[str]:
    """One pass of the automatic updater. Returns the agents it started.
    Blocking (npm, --version); run it in an executor."""
    now = now or time.time()
    if not models.prefs().get("auto_update", True) or busy():
        return []
    started = []
    for agent in PACKAGE:
        if not slots.cli_path(agent) or updating(agent):
            continue
        waiting = bool(models.waiting_on_cli(agent))
        # Ask npm at most every LATEST_TTL -- sooner when a model is waiting.
        due = waiting or now - _last_auto.get(agent, 0) >= LATEST_TTL
        if not due:
            continue
        _last_auto[agent] = now
        st = status(agent, check=True)
        if st["outdated"] or (waiting and st["latest"]):
            try:
                start(agent, auto=True)
                started.append(agent)
            except ValueError:
                pass
    return started


async def auto_loop(first_delay: float = 90.0) -> None:
    """Started with the engine. Quiet unless there is something to update."""
    await asyncio.sleep(first_delay)
    loop = asyncio.get_running_loop()
    while True:
        try:
            await loop.run_in_executor(None, auto_tick)
        except Exception:  # noqa: BLE001 -- an update check must never take the engine down
            pass
        await asyncio.sleep(CHECK_EVERY)
