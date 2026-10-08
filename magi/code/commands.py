"""Named commands agents may run (Track V6).

The project's check (check.py) is ONE command the agents may run. This is a
short list of more -- build, lint, one test file -- set the same way: on the
engine PC only (the routes are local-only, like the check's), stored here,
never synced. An agent names one of them, never a command line:

    Claude          the workspace server's run_command tool (ws_mcp.py)
    browser units   a `RUN: name [argument]` request line (browser.py)
    Codex           has its own sandboxed shell already; nothing changes

and it runs in the task's PRIVATE COPY, inside the agents' Windows job, with
the copy's dependency links -- exactly how the check runs. Write mode only:
in Read mode there is no copy, and a build writing into your real folder is
not reading.

An argument is allowed only for a command marked `arg: true`, and only a
plain relative path or word: letters, digits and `._/-@+=`, no leading `-`
(it would read as an option), no `..`, nothing absolute, no spaces or shell
characters. It replaces `{arg}` in the command, or is appended, quoted.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

MAX_COMMANDS = 8
MAX_COMMAND = 500
NAME = re.compile(r"^[a-z][a-z0-9-]{0,29}$")
ARG = re.compile(r"^[A-Za-z0-9._/@+=-]{1,200}$")


class CommandError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def _store() -> Path:
    from ..settings import data_dir
    d = data_dir() / "code"
    d.mkdir(parents=True, exist_ok=True)
    return d / "commands.json"


def _read() -> dict[str, Any]:
    try:
        d = json.loads(_store().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def clean(rows: Any, strict: bool = True) -> list[dict[str, Any]]:
    """[{name, command, arg, timeout_min}], validated. `strict` raises on the
    first bad row; reading what is stored drops bad rows instead."""
    from .check import DEFAULT_TIMEOUT_MIN, MAX_TIMEOUT_MIN
    if rows in (None, ""):
        return []
    if not isinstance(rows, list):
        raise CommandError("Send a list of commands.")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in rows:
        try:
            if not isinstance(r, dict):
                raise CommandError("Each command is a name and a command line.")
            name = str(r.get("name") or "").strip().lower()
            cmd = str(r.get("command") or "").strip()
            if not NAME.match(name):
                raise CommandError(f"{name or 'A command'}: name it with lowercase letters, digits "
                                   "and hyphens, starting with a letter (at most 30).")
            if name in seen:
                raise CommandError(f"{name} is listed twice.")
            if not cmd or len(cmd) > MAX_COMMAND or any(c in cmd for c in "\r\n\x00"):
                raise CommandError(f"{name}: one line, under {MAX_COMMAND} characters.")
            try:
                t = int(r.get("timeout_min") or DEFAULT_TIMEOUT_MIN)
            except (TypeError, ValueError):
                t = DEFAULT_TIMEOUT_MIN
            seen.add(name)
            out.append({"name": name, "command": cmd, "arg": r.get("arg") is True,
                        "timeout_min": max(1, min(MAX_TIMEOUT_MIN, t))})
        except CommandError:
            if strict:
                raise
    if len(out) > MAX_COMMANDS:
        if strict:
            raise CommandError(f"At most {MAX_COMMANDS} commands.")
        out = out[:MAX_COMMANDS]
    return out


def get(project_id: str) -> list[dict[str, Any]]:
    return clean(_read().get(project_id), strict=False)


def put(project_id: str, rows: Any) -> list[dict[str, Any]]:
    c = clean(rows)
    d = _read()
    if c:
        d[project_id] = c
    else:
        d.pop(project_id, None)
    f = _store()
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=1), encoding="utf-8")
    os.replace(tmp, f)
    return c


def forget(project_id: str) -> None:
    d = _read()
    if d.pop(project_id, None) is not None:
        _store().write_text(json.dumps(d, indent=1), encoding="utf-8")


def check_arg(arg: Any) -> str:
    """The argument as given, if it is safe to put on a command line."""
    a = str(arg or "").strip().replace("\\", "/")
    if not ARG.match(a) or a.startswith(("-", "/")) or ".." in a.split("/"):
        raise CommandError("The argument must be a plain relative path or word: letters, digits "
                           "and ._/-@+=, not starting with - or /, and no '..'.")
    return a


def render(cmd: dict[str, Any], arg: Any = None) -> str:
    """The command line to run for `cmd` with `arg` (CommandError if the
    argument is not allowed or not safe)."""
    line = cmd["command"]
    if arg in (None, ""):
        if "{arg}" in line:
            raise CommandError(f"{cmd['name']} needs an argument.")
        return line
    if not cmd.get("arg"):
        raise CommandError(f"{cmd['name']} takes no argument.")
    a = check_arg(arg)
    quoted = f'"{a}"'
    return line.replace("{arg}", quoted) if "{arg}" in line else f"{line} {quoted}"


def find(cmds: list[dict[str, Any]], name: Any) -> dict[str, Any]:
    n = str(name or "").strip().lower()
    for c in cmds:
        if c["name"] == n:
            return c
    raise CommandError(f"There is no command called {n or '(none)'}. There are: "
                       + (", ".join(c["name"] for c in cmds) or "none") + ".")


def describe(cmds: list[dict[str, Any]]) -> str:
    """One line per command, for an agent's prompt or tool description."""
    return "\n".join(f"- {c['name']}" + (" <path>" if c["arg"] else "") + f": `{c['command']}`"
                     for c in cmds)


def suggest(root: Path | None) -> list[dict[str, Any]]:
    """Commands this folder already names: its package.json scripts."""
    out: list[dict[str, Any]] = []
    if root is None:
        return out
    try:
        pkg = json.loads((root / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pkg = {}
    for k in list((pkg.get("scripts") or {}).keys())[:12]:
        name = re.sub(r"[^a-z0-9-]+", "-", str(k).lower()).strip("-")[:30]
        if name and NAME.match(name):
            out.append({"name": name, "command": f"npm run {k}", "arg": False})
    return out
