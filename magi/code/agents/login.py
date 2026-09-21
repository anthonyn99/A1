"""Signing a CLI agent's account slot in, from the console.

Codex has a device-code flow: it prints a URL and a one-time code, and the
sign-in happens on ANY device -- including the phone in your hand. So MAGI
reads the code out of the CLI's output and shows it in the console.

Claude does not; `claude auth login --claudeai` opens its sign-in page on the
engine PC. That is the same shape as a browser unit's Sign in, and the console
says so rather than leaving you watching a phone for a page that opens
somewhere else.

Either way MAGI never sees a password: the CLI and the provider's own page do
the signing in, and MAGI only watches for the slot to report signed in.
"""

from __future__ import annotations

import re
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from ... import proc
from . import slots

_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_URL = re.compile(r"https://auth\.openai\.com/\S+")
_CODE = re.compile(r"\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b")
TIMEOUT_S = 15 * 60      # Codex device codes expire in fifteen minutes


@dataclass
class LoginJob:
    id: str
    agent: str
    slot: str
    started: float = field(default_factory=time.time)
    state: str = "starting"     # starting | waiting | done | failed | cancelled
    url: str = ""
    code: str = ""
    where: str = ""             # "any device" | "engine PC"
    account: str = ""
    detail: str = ""
    _p: Any = None          # the CLI process (a Popen from magi.proc)

    def to_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if not k.startswith("_")}


JOBS: dict[str, LoginJob] = {}


def start(agent: str, slot: str) -> LoginJob:
    if agent not in slots.AGENTS:
        raise ValueError(f"Unknown agent {agent!r}.")
    if not slots.cli_path(agent):
        raise ValueError(f"The {agent} CLI is not installed.")
    if not (agent == "claude" and slot == slots.SYSTEM_SLOT):
        slots.create(agent, slot)

    # One sign-in per slot at a time: two device codes for one slot is two
    # things to type and only one of them wins.
    for j in JOBS.values():
        if j.agent == agent and j.slot == slot and j.state in ("starting", "waiting"):
            return j

    job = LoginJob(id=uuid.uuid4().hex[:10], agent=agent, slot=slot,
                   where="any device" if agent == "codex" else "engine PC")
    JOBS[job.id] = job
    job._p = proc.popen(
        slots.login_argv(agent), env=slots.env_for(agent, slot),
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1)
    threading.Thread(target=_watch, args=(job,), daemon=True).start()
    return job


def _watch(job: LoginJob) -> None:
    buf = ""
    p = job._p
    deadline = job.started + TIMEOUT_S

    def read_output():
        nonlocal buf
        try:
            for line in p.stdout:
                buf += _ANSI.sub("", line)
                if not job.url:
                    m = _URL.search(buf)
                    if m:
                        job.url = m.group(0)
                if not job.code:
                    m = _CODE.search(buf)
                    if m:
                        job.code = m.group(0)
                if job.state == "starting" and (job.code or job.agent == "claude"):
                    job.state = "waiting"
        except (OSError, ValueError):
            pass

    threading.Thread(target=read_output, daemon=True).start()

    while time.time() < deadline and job.state in ("starting", "waiting"):
        time.sleep(3)
        if p.poll() is not None:
            break
    if job.state == "cancelled":
        return

    st = slots.status(job.agent, job.slot)
    if st.signed_in:
        job.state, job.account = "done", st.account
        return
    if time.time() >= deadline:
        job.detail = "The sign-in code expired."
        _kill(p)
    else:
        job.detail = (buf.strip().splitlines() or ["The sign-in did not complete."])[-1][:200]
    job.state = "failed"


def cancel(job_id: str) -> LoginJob | None:
    job = JOBS.get(job_id)
    if job and job.state in ("starting", "waiting"):
        job.state = "cancelled"
        _kill(job._p)
    return job


def _kill(p: Any) -> None:
    if not p or p.poll() is not None:
        return
    try:
        proc.run(["taskkill", "/PID", str(p.pid), "/T", "/F"],
                 capture_output=True, timeout=10)
    except Exception:
        try:
            p.kill()
        except Exception:
            pass
