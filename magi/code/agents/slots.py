"""Account slots for the CLI agents: any account, per agent.

Each CLI keeps its login in a directory, and both CLIs let that directory be
chosen:

    Claude Code   CLAUDE_CONFIG_DIR  -> <dir>/.credentials.json
    Codex         CODEX_HOME         -> <dir>/auth.json

So a slot is just a directory, the same way a browser unit's account is its
Chrome profile directory. Codex is therefore NOT tied to the ChatGPT account
the council's ChatGPT unit uses -- its slot is signed in on its own, to any
ChatGPT account -- and an agent can have several slots, which is what lets the
chain rotate through ACCOUNTS before it moves on to a different model.

One special slot: Claude's `system`, which points at this PC's existing Claude
Code login (~/.claude). It exists so Code Mode works on day one without
anyone having to sign anything in. It is never deleted by MAGI.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from ... import proc
from ...settings import profiles_dir

AGENTS = ("claude", "codex")
SYSTEM_SLOT = "system"
_SLOT_OK = re.compile(r"^[a-z0-9][a-z0-9_-]{0,23}$")


def cli_root() -> Path:
    d = profiles_dir() / "cli"
    d.mkdir(parents=True, exist_ok=True)
    return d


def slot_dir(agent: str, slot: str) -> Path | None:
    """Where this slot's login lives. None means "the CLI's own default"."""
    if agent == "claude" and slot == SYSTEM_SLOT:
        return None
    return cli_root() / f"{agent}-{slot}"


def check_slot_name(slot: str) -> str:
    s = (slot or "").strip().lower()
    if not _SLOT_OK.match(s):
        raise ValueError("Use letters, digits, '-' or '_' (up to 24).")
    return s


def env_for(agent: str, slot: str) -> dict[str, str]:
    """The environment a CLI runs under for this slot.

    Starts from this process's environment and then removes what must not
    leak in: an API key in the environment would outrank the slot's login in
    both CLIs, silently billing an account nobody chose -- and the whole point
    of this is that nothing is billed per token.
    """
    env = dict(os.environ)
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
              "OPENAI_API_KEY", "CODEX_API_KEY"):
        env.pop(k, None)
    d = slot_dir(agent, slot)
    if agent == "claude":
        if d is not None:
            env["CLAUDE_CONFIG_DIR"] = str(d)
        # The agent's own shell commands cannot read the credentials it runs
        # on, so a prompt-injected "cat the token" has nothing to find.
        env["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"] = "1"
        env["DISABLE_AUTOUPDATER"] = "1"
    elif agent == "codex":
        env["CODEX_HOME"] = str(d)
    return env


def cli_path(agent: str) -> str | None:
    """The executable, or None if it is not installed."""
    for name in (agent + ".cmd", agent + ".exe", agent):
        p = shutil.which(name)
        if p:
            return p
    return None


@dataclass
class SlotStatus:
    agent: str
    slot: str
    installed: bool
    signed_in: bool
    account: str = ""     # email where the CLI reports it
    plan: str = ""        # e.g. "pro"
    detail: str = ""

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def list_slots(agent: str) -> list[str]:
    out = [SYSTEM_SLOT] if agent == "claude" else []
    root = cli_root()
    for d in sorted(root.glob(f"{agent}-*")):
        if d.is_dir():
            name = d.name[len(agent) + 1:]
            if name and name != SYSTEM_SLOT:
                out.append(name)
    return out


def status(agent: str, slot: str, timeout: int = 20) -> SlotStatus:
    """Is this slot signed in, and as whom? No model call -- both CLIs answer
    this from their stored login."""
    exe = cli_path(agent)
    if not exe:
        return SlotStatus(agent, slot, False, False,
                          detail=f"The {agent} CLI is not installed.")
    d = slot_dir(agent, slot)
    if d is not None and not d.exists():
        return SlotStatus(agent, slot, True, False, detail="Not signed in yet.")
    try:
        if agent == "claude":
            r = proc.run([exe, "auth", "status"], env=env_for(agent, slot),
                         capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                         stdin=subprocess.DEVNULL)
            try:
                data = json.loads(r.stdout or "{}")
            except ValueError:
                data = {}
            if data.get("loggedIn"):
                return SlotStatus(agent, slot, True, True,
                                  account=str(data.get("email") or ""),
                                  plan=str(data.get("subscriptionType") or ""))
            return SlotStatus(agent, slot, True, False, detail="Not signed in.")
        r = proc.run([exe, "login", "status"], env=env_for(agent, slot),
                     capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                     stdin=subprocess.DEVNULL)
        text = ((r.stdout or "") + (r.stderr or "")).strip()
        low = text.lower()
        if r.returncode == 0 and "not logged in" not in low:
            m = re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", text)
            return SlotStatus(agent, slot, True, True,
                              account=m.group(0) if m else "",
                              detail=text.splitlines()[0] if text else "")
        return SlotStatus(agent, slot, True, False, detail="Not signed in.")
    except subprocess.TimeoutExpired:
        return SlotStatus(agent, slot, True, False, detail="The status check timed out.")
    except Exception as exc:  # noqa: BLE001 -- the cause is what the UI shows
        return SlotStatus(agent, slot, True, False, detail=str(exc))


def create(agent: str, slot: str) -> Path:
    if agent not in AGENTS:
        raise ValueError(f"Unknown agent {agent!r}.")
    slot = check_slot_name(slot)
    if agent == "claude" and slot == SYSTEM_SLOT:
        raise ValueError("'system' is this PC's own Claude login and always exists.")
    d = slot_dir(agent, slot)
    d.mkdir(parents=True, exist_ok=True)
    return d


def remove(agent: str, slot: str) -> None:
    """Forget MAGI's copy of this login. Never touches the system slot."""
    if agent == "claude" and slot == SYSTEM_SLOT:
        raise ValueError("The system slot is this PC's own login; sign out of it in Claude Code.")
    d = slot_dir(agent, check_slot_name(slot))
    if d and d.exists() and d.parent == cli_root():
        shutil.rmtree(d, ignore_errors=True)


def login_argv(agent: str) -> list[str]:
    """What to run for a sign-in.

    Codex uses its device-code flow: it prints a code and a URL, and the sign
    in happens on ANY device -- including the phone you are holding, which is
    the only way signing in can work when you are not at the PC.
    """
    exe = cli_path(agent) or agent
    if agent == "codex":
        return [exe, "login", "--device-auth"]
    # --claudeai stated, not left to the default: the alternative, --console,
    # is Anthropic Console sign-in with API usage billing, and nothing in Code
    # Mode is billed per token. Claude has no device-code flow, so this opens
    # the sign-in page on the engine PC, like a browser unit's Sign in does.
    return [exe, "auth", "login", "--claudeai"]
