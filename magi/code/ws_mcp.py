"""Workspace tools for the Claude CLI in Write mode, as an MCP server.

    python -I ws_mcp.py --config <file>

Claude's own file tools (Read, Glob, Grep, Edit, Write) can read, change and
create files, but not move, copy or delete them, and there is no shell in
Write mode. Codex has those through its shell; a browser unit has them
through edits.py's MOVE/COPY/DELETE blocks. This server gives Claude the
same:

  move_path   rename or move a file or folder
  copy_path   copy a file or folder
  delete_path delete a file or folder
  make_dir    make a folder
  run_check   run the project's check command and read its real output --
              only when you switched "Agents may run it" on for the project
  ref_list    \
  ref_read     } READ the task's reference folders (other workspaces you
  ref_find    /  ticked under "Also read"): paths like @orca/src/app.py

What keeps it safe is the same as everything else in Write mode: it works on
the task's PRIVATE COPY (sandbox.py), and nothing reaches your folder unless
you approve the diff. On top of that, this server refuses on its own:

  * any path outside the copy -- absolute, `..`, or through a link or a
    junction anywhere on the way (checked on the real disk, not the string);
  * `.git` and the folders security.py never lets a diff touch (the copy's
    own `.git` file is what ties it to its repository);
  * a folder tree that holds a link or a junction (deleting or copying
    through one would reach outside the copy).

Track V3: a task that also CHANGES other workspaces gives this server their
private copies too ("writes" in the config). The file tools take paths like
@name/src/app.py there, with the same refusals, inside THAT copy; a move or
copy may cross from one copy to another. Nothing else is reachable.

The reference tools only read. There is no tool that writes to a reference
folder, so nothing here can change one; they refuse a path that resolves
outside its folder (`..`, a link), the denied folders, and secret files
(the same names context.py never sends a chat unit).

The config file is written by MAGI (tasks.write_mcp_config) into the
engine's data folder, outside the copy, so the agent cannot change which
folder or which command this serves. The check command is YOURS (check.py:
set on the engine PC only, never synced); the agent can only ask for it to
run, never name another one. It runs inside the agents' Windows job (this
server is started by the Claude CLI, which is in it), so the code it runs
cannot reach the engine.

Stdlib only, run with `-I`: nothing in the workspace is importable into it.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

PROTOCOL = "2025-06-18"
SERVER = "magi_workspace"

# The folders a diff may never touch (security._DENY_DIRS), plus the agents'
# settings. Kept in step by test_ws_mcp.py.
DENY_DIRS = {".git", ".ssh", ".gnupg", ".aws", ".azure", ".claude", ".codex"}
_RESERVED = re.compile(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$", re.I)
MAX_PATH_CHARS = 1000
MAX_TREE_FILES = 20_000
MAX_COPY_BYTES = 200_000_000
# check.py's: the folders the copy leaves out, linked in for a check's run.
DEP_DIRS = ("node_modules", ".venv", "venv", "env", "vendor")
OUTPUT_TAIL = 8000
# The CLI is stopped after 30 minutes without output (_proc.STALL_S), and a
# tool call produces none: a run_check is kept well inside that.
MAX_RUN_S = 25 * 60
# Reading a reference folder (ref_*): what is skipped and how much comes back.
_SECRET_NAMES = re.compile(
    r"(^|[\\/])(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*|\.npmrc|\.pypirc|"
    r"credentials(\.json)?|\.credentials\.json|auth\.json|secrets?\.(json|ya?ml|toml)|"
    r".*\.p12|.*\.pfx|\.git-credentials|token\.txt)$", re.I)
HEAVY_DIRS = {"node_modules", ".venv", "venv", "env", "__pycache__", ".mypy_cache",
              ".pytest_cache", ".next", ".cache", ".tox", "dist", "build", "target"}
REF_LIST_MAX = 2000
REF_READ_LINES = 2000
REF_READ_CHARS = 120_000
REF_FILE_MAX = 2_000_000
REF_FIND_HITS = 150
REF_FIND_CHARS = 20_000
# Nothing here may run unbounded: a reference folder can be huge. A walk
# stops after this many files, a search after this many seconds, and both
# say so -- the agent narrows the path instead of the task hanging.
REF_WALK_MAX = 50_000
REF_FIND_S = 30.0
# A regex from an agent must not be able to hang a search: Python's re has
# no timeout, and nested repetition -- "(a+)+$" -- backtracks exponentially
# on one long line. Refused, and every line is searched only so far.
_NESTED_REPEAT = re.compile(r"\((?:\\.|[^()\\])*[*+}](?:\\.|[^()\\])*\)\s*[*+{]")
SEARCH_LINE_MAX = 2000

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
_SECRET_ENV = re.compile(r"(^MAGI_API_TOKEN$|API_KEY|_TOKEN$|SECRET|PASSWORD)", re.I)

_PATH = {"type": "string", "description": "Path relative to the project folder, e.g. src/app.py"}

TOOLS = [
    {"name": "move_path",
     "description": "Rename or move a file or folder inside the project. Fails if the "
                    "destination already exists. Parent folders are made as needed.",
     "inputSchema": {"type": "object", "properties": {"from": _PATH, "to": _PATH},
                     "required": ["from", "to"]},
     "annotations": {"destructiveHint": True, "openWorldHint": False}},
    {"name": "copy_path",
     "description": "Copy a file or folder inside the project. Fails if the destination "
                    "already exists.",
     "inputSchema": {"type": "object", "properties": {"from": _PATH, "to": _PATH},
                     "required": ["from", "to"]},
     "annotations": {"destructiveHint": False, "openWorldHint": False}},
    {"name": "delete_path",
     "description": "Delete a file, or a folder and everything in it.",
     "inputSchema": {"type": "object", "properties": {"path": _PATH}, "required": ["path"]},
     "annotations": {"destructiveHint": True, "openWorldHint": False}},
    {"name": "make_dir",
     "description": "Make a folder (and any missing parents). Git does not track empty "
                    "folders, so a new folder only reaches the project once a file is in it.",
     "inputSchema": {"type": "object", "properties": {"path": _PATH}, "required": ["path"]},
     "annotations": {"destructiveHint": False, "openWorldHint": False}},
]
_REF_PATH = {"type": "string",
             "description": "@name, or a path inside it, e.g. @orca/src/app.py"}
REF_TOOLS = [
    {"name": "ref_list",
     "description": "List the files in a reference folder (read-only), or in a folder inside "
                    "it. Dependency and build folders are skipped.",
     "inputSchema": {"type": "object", "properties": {"path": _REF_PATH}, "required": ["path"]},
     "annotations": {"readOnlyHint": True, "openWorldHint": False}},
    {"name": "ref_read",
     "description": "Read a text file in a reference folder (read-only), with line numbers. "
                    "Long files come in parts: pass offset (first line) and limit.",
     "inputSchema": {"type": "object", "properties": {
         "path": _REF_PATH, "offset": {"type": "integer"}, "limit": {"type": "integer"}},
         "required": ["path"]},
     "annotations": {"readOnlyHint": True, "openWorldHint": False}},
    {"name": "ref_find",
     "description": "Search the text files of the reference folders (all of them, or one "
                    "folder given as path) for a regular expression, case-insensitively. "
                    "Answers path:line: text.",
     "inputSchema": {"type": "object", "properties": {
         "pattern": {"type": "string"}, "path": _REF_PATH}, "required": ["pattern"]},
     "annotations": {"readOnlyHint": True, "openWorldHint": False}},
]

# Track V6: the project's named commands (code/commands.py), set on the
# engine PC. The agent names one; it never writes a command line.
RUN_COMMAND = {
    "name": "run_command",
    "description": "",          # filled in with the list (Server.tools)
    "inputSchema": {"type": "object", "properties": {
        "name": {"type": "string", "description": "One of the listed command names"},
        "arg": {"type": "string", "description": "Only for commands marked <path>: a relative "
                "path or word (letters, digits, ._/-@+=)"}},
        "required": ["name"]},
    "annotations": {"destructiveHint": False, "openWorldHint": False},
}
# Track W2: the agents' shell (code/shell.py), restated here -- this server
# imports nothing from MAGI. test_code_shell.py keeps the two equal.
SHELL_TOOLS = [
    {"name": "shell",
     "description": "",          # filled in (Server.tools): where it runs, internet or not
     "inputSchema": {"type": "object", "properties": {
         "command": {"type": "string", "description": "A bash command line (Git Bash)"},
         "timeout_s": {"type": "integer", "description": "Seconds before it is stopped (default 120, at most 600)"}},
         "required": ["command"]},
     "annotations": {"destructiveHint": True, "openWorldHint": False}},
    {"name": "start_process",
     "description": "Start a long-running command in the background -- a dev server, a watcher -- in "
                    "the same sandbox, and get an id. Read its output with process_output; stop it "
                    "with stop_process. Everything still running is stopped when the task ends.",
     "inputSchema": {"type": "object", "properties": {
         "command": {"type": "string"}, "name": {"type": "string"}}, "required": ["command"]},
     "annotations": {"destructiveHint": True, "openWorldHint": False}},
    {"name": "process_output",
     "description": "A background process's state and output so far (the end of it).",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]},
     "annotations": {"readOnlyHint": True, "openWorldHint": False}},
    {"name": "stop_process",
     "description": "Stop a background process and everything it started.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]},
     "annotations": {"destructiveHint": True, "openWorldHint": False}},
    {"name": "list_processes",
     "description": "The background processes of this task, running or ended.",
     "inputSchema": {"type": "object", "properties": {}},
     "annotations": {"readOnlyHint": True, "openWorldHint": False}},
]
SHELL_TIMEOUT_S = 120
SHELL_MAX_S = 600
MAX_PROCESSES = 4


def _shell_argv(sp: dict, script: str) -> list:
    """code/shell.py argv(), restated."""
    roots = "[" + ", ".join("'" + p.replace("\\", "/") + "'" for p in sp["writable"]) + "]"
    return [sp["codex"], "sandbox",
            "-c", "sandbox_mode=workspace-write",
            "-c", "windows.sandbox=elevated",
            "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
            "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
            "-c", f"sandbox_workspace_write.network_access={'true' if sp['internet'] else 'false'}",
            "-c", f"sandbox_workspace_write.writable_roots={roots}",
            "--", sp["bash"], "--noprofile", "--norc", script]


class _Job:
    """A Windows job with kill-on-close (code/shell.py Job, restated)."""

    def __init__(self) -> None:
        self.h = None
        if os.name != "nt":
            return
        import ctypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateJobObjectW.restype = ctypes.c_void_p
        self._c, self._k = ctypes, k32
        h = k32.CreateJobObjectW(None, None)
        if not h:
            return

        class _Basic(ctypes.Structure):
            _fields_ = [("a", ctypes.c_int64), ("b", ctypes.c_int64), ("LimitFlags", ctypes.c_uint32),
                        ("c", ctypes.c_size_t), ("d", ctypes.c_size_t), ("e", ctypes.c_uint32),
                        ("f", ctypes.c_size_t), ("g", ctypes.c_uint32), ("h", ctypes.c_uint32)]

        class _Ext(ctypes.Structure):
            _fields_ = [("Basic", _Basic), ("Io", ctypes.c_uint64 * 6), ("p1", ctypes.c_size_t),
                        ("p2", ctypes.c_size_t), ("p3", ctypes.c_size_t), ("p4", ctypes.c_size_t)]
        info = _Ext()
        info.Basic.LimitFlags = 0x2000            # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        k32.SetInformationJobObject.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        k32.SetInformationJobObject(h, 9, ctypes.byref(info), ctypes.sizeof(info))
        self.h = h

    def add(self, pid: int) -> bool:
        if not self.h:
            return False
        k, c = self._k, self._c
        k.OpenProcess.restype = c.c_void_p
        hp = k.OpenProcess(0x1F0FFF, False, pid)
        if not hp:
            return False
        k.AssignProcessToJobObject.argtypes = [c.c_void_p, c.c_void_p]
        ok = bool(k.AssignProcessToJobObject(self.h, hp))
        k.CloseHandle.argtypes = [c.c_void_p]
        k.CloseHandle(hp)
        return ok

    def close(self) -> None:
        if self.h:
            self._k.TerminateJobObject.argtypes = [self._c.c_void_p, self._c.c_uint]
            self._k.TerminateJobObject(self.h, 1)
            self._k.CloseHandle.argtypes = [self._c.c_void_p]
            self._k.CloseHandle(self.h)
            self.h = None


class _Proc:
    def __init__(self, pid_name: str, command: str, popen, job: "_Job"):
        self.id, self.command, self.p, self.job = pid_name, command, popen, job
        self.out: collections.deque = collections.deque()
        self.size = 0
        self.started = time.monotonic()
        self.read_to = 0          # characters already returned by process_output
        self.total = 0
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        try:
            for line in self.p.stdout:
                self.out.append(line)
                self.size += len(line)
                self.total += len(line)
                while self.size > OUTPUT_TAIL * 3 and len(self.out) > 1:
                    self.size -= len(self.out.popleft())
        except (OSError, ValueError):
            pass

    def text(self) -> str:
        return _ANSI.sub("", "".join(self.out)).replace("\r\n", "\n")


# commands.ARG and its rules, restated: this server imports nothing from MAGI
# (it runs with -I). test_code_commands.py keeps the two in step.
_CMD_ARG = re.compile(r"^[A-Za-z0-9._/@+=-]{1,200}$")

RUN_CHECK = {
    "name": "run_check",
    "description": "",          # filled in with the command (Server.tools)
    "inputSchema": {"type": "object", "properties": {}},
    "annotations": {"destructiveHint": False, "openWorldHint": False},
}


class ToolError(Exception):
    pass


def _is_link(p: Path) -> bool:
    try:
        return p.is_symlink() or bool(getattr(os.path, "isjunction", lambda _: False)(p))
    except OSError:
        return True


def resolve(root: Path, rel, *, must_exist: bool = False) -> Path:
    """`rel` as a path inside `root`, or ToolError saying why not."""
    if not isinstance(rel, str) or not rel.strip():
        raise ToolError("A path is required.")
    if len(rel) > MAX_PATH_CHARS or "\x00" in rel:
        raise ToolError("That is not a usable path.")
    s = rel.strip().replace("\\", "/")
    if s.startswith("/") or re.match(r"^[A-Za-z]:", s):
        raise ToolError(f"{rel}: use a path relative to the project folder.")
    parts = [p for p in s.split("/") if p not in ("", ".")]
    if not parts:
        raise ToolError("That is the project folder itself.")
    for part in parts:
        if part == "..":
            raise ToolError(f"{rel}: '..' leaves the project folder.")
        if part.lower() in DENY_DIRS:
            raise ToolError(f"{rel}: inside {part}/, which agents may not touch.")
        if _RESERVED.match(part) or part.endswith((" ", ".")) or ":" in part:
            raise ToolError(f"{rel}: '{part}' is not a valid Windows file name.")
    here = root
    for part in parts:
        here = here / part
        if _is_link(here):
            raise ToolError(f"{rel}: passes through a link, which could point outside the project.")
        if not os.path.lexists(here):
            break
    target = root.joinpath(*parts)
    try:
        inside = target.resolve().relative_to(root.resolve())
    except (ValueError, OSError):
        raise ToolError(f"{rel}: outside the project folder.")
    # Again on the resolved name: Windows' short names ("GIT~1") resolve to
    # the long one, which the string check above never saw.
    for part in inside.parts:
        if part.lower() in DENY_DIRS:
            raise ToolError(f"{rel}: inside {part}/, which agents may not touch.")
    if must_exist and not os.path.lexists(target):
        raise ToolError(f"{rel}: no such file or folder.")
    return target


def _tree_ok(top: Path) -> tuple[int, int]:
    """(files, bytes) under `top`, or ToolError if a link or junction is in it."""
    files = size = 0
    for d, dirs, names in os.walk(top, followlinks=False):
        for n in dirs + names:
            p = Path(d) / n
            if _is_link(p):
                raise ToolError(f"{p.relative_to(top.parent).as_posix()} is a link; "
                                "folders holding links are not moved, copied or deleted here.")
        for n in names:
            files += 1
            try:
                size += (Path(d) / n).stat().st_size
            except OSError:
                pass
            if files > MAX_TREE_FILES:
                raise ToolError(f"More than {MAX_TREE_FILES} files under that folder.")
    return files, size


def _rel(root: Path, p: Path) -> str:
    return p.relative_to(root).as_posix()


class Server:
    def __init__(self, root: Path, check: dict | None = None, real: Path | None = None,
                 refs: list | None = None, writes: list | None = None,
                 commands: list | None = None, shell: dict | None = None,
                 readonly: bool = False):
        self.root = Path(root)
        # Track V6: [{name, command, arg, timeout_min}] -- only what MAGI wrote.
        self.commands = [c for c in (commands or []) if isinstance(c, dict)
                         and c.get("name") and c.get("command")]
        # Track W2: the sandboxed shell (code/shell.py spec), and Read mode's
        # server, which offers no tool that changes files.
        self.shell = shell if isinstance(shell, dict) and shell.get("codex") and shell.get("bash") else None
        self.readonly = bool(readonly)
        self.procs: dict[str, _Proc] = {}
        # Track V3: {"orca": Path(<its private copy>)} -- only copies MAGI made.
        self.writes: dict[str, Path] = {}
        for w in writes or []:
            if isinstance(w, dict) and w.get("name") and w.get("root") and Path(w["root"]).is_dir():
                self.writes[str(w["name"])] = Path(w["root"])
        self.check = check if check and check.get("command") else None
        self.real = Path(real) if real else None
        # {"orca": Path("C:/.../ORCA")} -- only folders MAGI wrote here.
        self.refs: dict[str, Path] = {}
        for r in refs or []:
            if isinstance(r, dict) and r.get("name") and r.get("root"):
                self.refs[str(r["name"])] = Path(r["root"])

    # ── the reference folders: read only ──────────────────────────────────

    def ref_resolve(self, path) -> tuple[str, Path, Path]:
        """'@orca/src/x.py' -> (name, folder, target), or ToolError."""
        if not isinstance(path, str) or not path.strip():
            raise ToolError("A path is required, like @name/src/app.py.")
        s = path.strip().replace("\\", "/")
        if not s.startswith("@"):
            raise ToolError(f"{path}: reference paths start with @ -- one of "
                            + ", ".join("@" + n for n in self.refs) + ".")
        name, _, rest = s[1:].partition("/")
        base = self.refs.get(name)
        if base is None:
            raise ToolError(f"No reference folder @{name}. There are: "
                            + ", ".join("@" + n for n in self.refs) + ".")
        parts = [p for p in rest.split("/") if p not in ("", ".")]
        for part in parts:
            if part == ".." or ":" in part:
                raise ToolError(f"{path}: stays inside @{name}.")
            if part.lower() in DENY_DIRS:
                raise ToolError(f"{path}: inside {part}/, which is not read here.")
        target = base.joinpath(*parts)
        try:
            inside = target.resolve().relative_to(base.resolve())
        except (ValueError, OSError):
            raise ToolError(f"{path}: outside @{name} once links are followed.")
        for part in inside.parts:
            if part.lower() in DENY_DIRS:
                raise ToolError(f"{path}: inside {part}/, which is not read here.")
        if parts and _SECRET_NAMES.search(parts[-1]):
            raise ToolError(f"{path}: a secret or key file; never read here.")
        return name, base, target

    def _ref_files(self, name: str, base: Path, top: Path):
        """Files under `top`, as '@name/rel', skipping heavy and denied
        folders; at most REF_WALK_MAX of them (self.walk_cut says if cut)."""
        self.walk_cut = False
        n = 0
        for d, dirs, names in os.walk(top, followlinks=False):
            dirs[:] = sorted(x for x in dirs if x.lower() not in DENY_DIRS
                             and x not in HEAVY_DIRS and not _is_link(Path(d) / x))
            for fn in sorted(names):
                p = Path(d) / fn
                if _SECRET_NAMES.search(fn) or _is_link(p):
                    continue
                n += 1
                if n > REF_WALK_MAX:
                    self.walk_cut = True
                    return
                yield p, f"@{name}/" + p.relative_to(base).as_posix()

    def ref_list(self, a: dict) -> str:
        name, base, top = self.ref_resolve(a.get("path"))
        if top.is_file():
            return f"@{name}/{top.relative_to(base).as_posix()} is a file ({top.stat().st_size} bytes)."
        if not top.is_dir():
            raise ToolError(f"{a.get('path')}: no such folder.")
        rows, more = [], 0
        for _, rel in self._ref_files(name, base, top):
            if len(rows) < REF_LIST_MAX:
                rows.append(rel)
            else:
                more += 1
        if not rows:
            return "(no files)"
        more_s = f"{more}{'+' if self.walk_cut else ''}"
        return "\n".join(rows) + (f"\n… {more_s} more files: list a folder inside it" if more else "")

    def ref_read(self, a: dict) -> str:
        name, base, p = self.ref_resolve(a.get("path"))
        if not p.is_file():
            raise ToolError(f"{a.get('path')}: no such file.")
        if p.stat().st_size > REF_FILE_MAX:
            raise ToolError(f"{a.get('path')}: over {REF_FILE_MAX // 1_000_000} MB; not read here.")
        raw = p.read_bytes()
        if b"\x00" in raw[:8192]:
            raise ToolError(f"{a.get('path')}: a binary file.")
        lines = raw.decode("utf-8", "replace").splitlines()
        try:
            start = max(1, int(a.get("offset") or 1))
            limit = max(1, min(REF_READ_LINES, int(a.get("limit") or REF_READ_LINES)))
        except (TypeError, ValueError):
            raise ToolError("offset and limit are whole numbers.")
        out, size, i = [], 0, start
        for i in range(start, min(len(lines), start + limit - 1) + 1):
            row = f"{i:6}\t{lines[i - 1]}"
            if size + len(row) > REF_READ_CHARS:
                i -= 1
                break
            out.append(row)
            size += len(row) + 1
        if not out and lines:
            return f"(nothing at line {start}: the file has {len(lines)} lines)"
        last = start + len(out) - 1
        tail = (f"\n[lines {start}-{last} of {len(lines)}; read on with offset={last + 1}]"
                if last < len(lines) else "")
        return ("\n".join(out) or "(empty file)") + tail

    def ref_find(self, a: dict) -> str:
        pat = a.get("pattern")
        if not isinstance(pat, str) or len(pat.strip()) < 2:
            raise ToolError("Give a pattern of at least two characters.")
        if _NESTED_REPEAT.search(pat):
            raise ToolError("Nested repetition like (a+)+ is not searched; simplify the pattern.")
        try:
            rx = re.compile(pat, re.I)
        except re.error as e:
            raise ToolError(f"Not a usable regular expression: {e}")
        if a.get("path"):
            name, base, top = self.ref_resolve(a.get("path"))
            places = [(name, base, top)]
        else:
            places = [(n, b, b) for n, b in self.refs.items()]
        hits, n_hits, size = [], 0, 0
        deadline = time.monotonic() + REF_FIND_S
        stopped = ""
        self.walk_cut = False
        for name, base, top in places:
            if stopped:
                break
            files = [(top, f"@{name}/" + top.relative_to(base).as_posix())] if top.is_file() \
                else self._ref_files(name, base, top)
            for p, rel in files:
                if time.monotonic() >= deadline:
                    stopped = f"stopped after {int(REF_FIND_S)} s"
                    break
                try:
                    if p.stat().st_size > REF_FILE_MAX // 2:
                        continue
                    raw = p.read_bytes()
                except OSError:
                    continue
                if b"\x00" in raw[:4096]:
                    continue
                for i, line in enumerate(raw.decode("utf-8", "replace").splitlines(), 1):
                    if rx.search(line[:SEARCH_LINE_MAX]):
                        n_hits += 1
                        if len(hits) < REF_FIND_HITS and size < REF_FIND_CHARS:
                            row = f"{rel}:{i}: {line.strip()[:200]}"
                            hits.append(row)
                            size += len(row) + 1
            if not stopped and getattr(self, "walk_cut", False):
                stopped = f"stopped after {REF_WALK_MAX} files"
        tail = (f"\n[search {stopped}: give a narrower path to search the rest]"
                if stopped else "")
        if not n_hits:
            return "(no matches)" + tail
        more = n_hits - len(hits)
        return "\n".join(hits) + (f"\n… {more} more matches: narrow the pattern or the path"
                                  if more else "") + tail

    # ── the file tools ────────────────────────────────────────────────────

    def _mine(self, rel, must_exist: bool = False) -> Path:
        """resolve(), plus: "@name/..." names a reference folder, which the
        file tools never touch -- not a folder to create called "@name" --
        or (V3) another workspace this task changes, resolved in ITS copy."""
        if isinstance(rel, str):
            head, _, rest = rel.strip().replace("\\", "/").partition("/")
            if head.startswith("@"):
                base = next((b for n, b in self.writes.items() if n.lower() == head[1:].lower()),
                            None)
                if base is not None:
                    return resolve(base, rest, must_exist=must_exist)
                if head[1:].lower() in {n.lower() for n in self.refs}:
                    raise ToolError(f"{rel}: {head} is a reference folder, which is read-only.")
        return resolve(self.root, rel, must_exist=must_exist)

    def _show(self, p: Path) -> str:
        """How a path reads back to the agent: as given, @name/... included."""
        for n, b in self.writes.items():
            try:
                return f"@{n}/" + p.relative_to(b).as_posix()
            except ValueError:
                continue
        return _rel(self.root, p)

    def move_path(self, a: dict) -> str:
        src = self._mine(a.get("from"), must_exist=True)
        dst = self._mine(a.get("to"))
        if os.path.lexists(dst):
            raise ToolError(f"{a.get('to')}: already exists. Delete it first if you mean to replace it.")
        if src.is_dir():
            _tree_ok(src)
            try:
                dst.resolve().relative_to(src.resolve())
                raise ToolError("A folder cannot be moved into itself.")
            except ValueError:
                pass
        dst.parent.mkdir(parents=True, exist_ok=True)
        os.rename(src, dst)
        return f"Moved {self._show(src)} to {self._show(dst)}."

    def copy_path(self, a: dict) -> str:
        src = self._mine(a.get("from"), must_exist=True)
        dst = self._mine(a.get("to"))
        if os.path.lexists(dst):
            raise ToolError(f"{a.get('to')}: already exists.")
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            try:
                dst.resolve().relative_to(src.resolve())
                raise ToolError("A folder cannot be copied into itself.")
            except ValueError:
                pass
            n, size = _tree_ok(src)
            if size > MAX_COPY_BYTES:
                raise ToolError(f"That folder holds {size // 1_000_000} MB; too much to copy here.")
            shutil.copytree(src, dst, symlinks=True)
            return f"Copied {self._show(src)}/ ({n} files) to {self._show(dst)}/."
        shutil.copy2(src, dst)
        return f"Copied {self._show(src)} to {self._show(dst)}."

    def delete_path(self, a: dict) -> str:
        p = self._mine(a.get("path"), must_exist=True)
        if p.is_dir():
            n, _ = _tree_ok(p)
            shutil.rmtree(p)
            return f"Deleted {self._show(p)}/ ({n} files)."
        p.unlink()
        return f"Deleted {self._show(p)}."

    def make_dir(self, a: dict) -> str:
        p = self._mine(a.get("path"))
        if os.path.lexists(p) and not p.is_dir():
            raise ToolError(f"{a.get('path')}: a file of that name exists.")
        p.mkdir(parents=True, exist_ok=True)
        return f"Folder {self._show(p)}/ is there."

    # ── the project's check ───────────────────────────────────────────────

    def _link_deps(self) -> list[Path]:
        made: list[Path] = []
        if self.real is None or not self.real.is_dir():
            return made
        try:
            if self.real.resolve() == self.root.resolve():
                return made
        except OSError:
            return made
        for name in DEP_DIRS:
            src, dst = self.real / name, self.root / name
            if not src.is_dir() or os.path.lexists(dst):
                continue
            try:
                if os.name == "nt":
                    r = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(dst), str(src)],
                                       capture_output=True, timeout=20,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    if r.returncode != 0:
                        continue
                else:
                    os.symlink(src, dst, target_is_directory=True)
                made.append(dst)
            except (OSError, subprocess.SubprocessError):
                continue
        return made

    @staticmethod
    def _unlink_deps(links: list[Path]) -> None:
        # The LINK only, never what it points at (check.unlink_deps).
        for p in links:
            try:
                if os.name == "nt":
                    os.rmdir(p)
                else:
                    os.unlink(p)
            except OSError:
                pass

    # ── the shell (Track W2) ──────────────────────────────────────────────

    def _shell_env(self) -> dict:
        sp = self.shell
        env = {k: v for k, v in os.environ.items()
               if not _SECRET_ENV.search(k) and not k.startswith("CLAUDE_CODE_")}
        for k in [k for k in env if k.upper() == "PATH"]:
            env[k] = os.pathsep.join(x for x in env[k].split(os.pathsep)
                                     if "windowsapps" not in re.split(r"[\\/]", x.lower()))
        tmp = os.path.join(sp["scratch"], "tmp")
        cache = sp["cache"]
        env.update({"CI": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "PAGER": "cat",
                    "GIT_PAGER": "cat", "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1",
                    "TMP": tmp, "TEMP": tmp, "TMPDIR": tmp,
                    "npm_config_cache": os.path.join(cache, "npm"),
                    "PIP_CACHE_DIR": os.path.join(cache, "pip"),
                    "YARN_CACHE_FOLDER": os.path.join(cache, "yarn"),
                    "PNPM_HOME": os.path.join(cache, "pnpm"),
                    "PIP_DISABLE_PIP_VERSION_CHECK": "1", "npm_config_update_notifier": "false"})
        return env

    def _script(self, command: str) -> str:
        d = os.path.join(self.shell["scratch"], "scripts")
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, f"c{time.time_ns()}.sh")
        cwd = self.shell["cwd"].replace("\\", "/")
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write(f"cd '{cwd}' || exit 99\n{command}\n")
        return p

    def _popen(self, command: str):
        sp = self.shell
        os.makedirs(os.path.join(sp["scratch"], "tmp"), exist_ok=True)
        p = subprocess.Popen(_shell_argv(sp, self._script(command)),
                             cwd=sp["cwd"] if sp.get("write") else sp["scratch"],
                             env=self._shell_env(), stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                             encoding="utf-8", errors="replace", bufsize=1,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        job = _Job()
        job.add(p.pid)
        return p, job

    def _need_shell(self, command) -> str:
        if not self.shell:
            raise ToolError("There is no shell in this task.")
        if not isinstance(command, str) or not command.strip():
            raise ToolError("A command is required.")
        if len(command) > 20_000 or "\x00" in command:
            raise ToolError("That command is too long.")
        return command

    def shell_run(self, a: dict) -> str:
        command = self._need_shell(a.get("command"))
        try:
            limit = max(1, min(SHELL_MAX_S, int(a.get("timeout_s") or SHELL_TIMEOUT_S)))
        except (TypeError, ValueError):
            limit = SHELL_TIMEOUT_S
        t0 = time.monotonic()
        p, job = self._popen(command)
        tail: collections.deque = collections.deque()
        size = [0]

        def pump() -> None:
            try:
                for line in p.stdout:
                    tail.append(line)
                    size[0] += len(line)
                    while size[0] > OUTPUT_TAIL * 2 and len(tail) > 1:
                        size[0] -= len(tail.popleft())
            except (OSError, ValueError):
                pass
        reader = threading.Thread(target=pump, daemon=True)
        reader.start()
        timed_out = False
        try:
            p.wait(timeout=limit)
        except subprocess.TimeoutExpired:
            timed_out = True
        finally:
            job.close()                 # the command and anything it left behind
            try:
                p.wait(timeout=15)
            except subprocess.TimeoutExpired:
                pass
        reader.join(5)
        out = _ANSI.sub("", "".join(tail)).replace("\r\n", "\n").strip()
        if len(out) > OUTPUT_TAIL:
            out = "…" + out[-OUTPUT_TAIL:]
        secs = round(time.monotonic() - t0, 1)
        if timed_out:
            head = (f"Stopped after {limit}s, still running. For a server or a watcher use "
                    "start_process.")
        else:
            head = f"Exit code {p.returncode} ({secs}s)."
        return head + "\n\n" + (out or "(no output)")

    def start_process(self, a: dict) -> str:
        command = self._need_shell(a.get("command"))
        live = [x for x in self.procs.values() if x.p.poll() is None]
        if len(live) >= MAX_PROCESSES:
            raise ToolError(f"{MAX_PROCESSES} background processes are already running; stop one first.")
        name = re.sub(r"[^A-Za-z0-9_-]+", "-", str(a.get("name") or "proc"))[:20].strip("-") or "proc"
        pid_name = f"{name}-{len(self.procs) + 1}"
        p, job = self._popen(command)
        self.procs[pid_name] = _Proc(pid_name, command, p, job)
        time.sleep(1.5)
        return (f"Started {pid_name}. " + self._state(self.procs[pid_name])
                + "\nRead it with process_output, stop it with stop_process.")

    def _state(self, x: "_Proc") -> str:
        rc = x.p.poll()
        up = round(time.monotonic() - x.started)
        return (f"{x.id}: running for {up}s" if rc is None else f"{x.id}: ended with exit code {rc}")

    def _proc(self, a: dict) -> "_Proc":
        self._need_shell("x")
        x = self.procs.get(str(a.get("id") or ""))
        if x is None:
            raise ToolError("No such process. There are: " + (", ".join(self.procs) or "none") + ".")
        return x

    def process_output(self, a: dict) -> str:
        x = self._proc(a)
        text = x.text()
        if len(text) > OUTPUT_TAIL:
            text = "…" + text[-OUTPUT_TAIL:]
        return self._state(x) + "\n\n" + (text.strip() or "(no output yet)")

    def stop_process(self, a: dict) -> str:
        x = self._proc(a)
        x.job.close()
        try:
            x.p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        return f"Stopped {x.id}."

    def list_processes(self, a: dict) -> str:
        self._need_shell("x")
        return "\n".join(self._state(x) + f" -- {x.command[:120]}" for x in self.procs.values()) \
            or "(none)"

    def close(self) -> None:
        """The task is over (the CLI closed our stdin): stop everything."""
        for x in self.procs.values():
            x.job.close()

    def run_check(self, a: dict) -> str:
        if not self.check:
            raise ToolError("This project has no check that agents may run.")
        return self._run(self.check["command"], self.check.get("timeout_min"), "Check")

    def run_command(self, a: dict) -> str:
        """Track V6: one of the project's named commands, in the copy."""
        name = str(a.get("name") or "").strip().lower()
        c = next((x for x in self.commands if x["name"] == name), None)
        if c is None:
            raise ToolError(f"No command called {name or '(none)'}. There are: "
                            + (", ".join(x["name"] for x in self.commands) or "none") + ".")
        line = c["command"]
        arg = str(a.get("arg") or "").strip().replace("\\", "/")
        if arg:
            if not c.get("arg"):
                raise ToolError(f"{name} takes no argument.")
            if (not _CMD_ARG.match(arg) or arg.startswith(("-", "/"))
                    or ".." in arg.split("/")):
                raise ToolError("The argument must be a plain relative path or word: letters, "
                                "digits and ._/-@+=, not starting with - or /, and no '..'.")
            line = line.replace("{arg}", f'"{arg}"') if "{arg}" in line else f'{line} "{arg}"'
        elif "{arg}" in line:
            raise ToolError(f"{name} needs an argument.")
        return self._run(line, c.get("timeout_min"), f"Command {name}:")

    def _run(self, cmd: str, timeout_min, label: str) -> str:
        limit = min(MAX_RUN_S, max(60, int(timeout_min or 10) * 60))
        env = {k: v for k, v in os.environ.items()
               if not _SECRET_ENV.search(k) and not k.startswith("CLAUDE_CODE_")}
        env.update({"CI": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "PAGER": "cat",
                    "GIT_PAGER": "cat", "PYTHONUNBUFFERED": "1",
                    "PYTHONDONTWRITEBYTECODE": "1"})  # check.py _env: no stale pyc
        argv = (f'cmd.exe /d /s /c "{cmd}"' if os.name == "nt" else ["/bin/sh", "-c", cmd])
        tail: collections.deque[str] = collections.deque()
        size = [0]
        links = self._link_deps()
        t0 = time.monotonic()
        timed_out = False
        try:
            try:
                p = subprocess.Popen(argv, cwd=str(self.root), env=env, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                     encoding="utf-8", errors="replace", bufsize=1,
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            except OSError as e:
                return f"The check could not start: {e}"

            def pump() -> None:
                try:
                    for line in p.stdout:
                        tail.append(line)
                        size[0] += len(line)
                        while size[0] > OUTPUT_TAIL * 2 and len(tail) > 1:
                            size[0] -= len(tail.popleft())
                except (OSError, ValueError):
                    pass
            reader = threading.Thread(target=pump, daemon=True)
            reader.start()
            try:
                p.wait(timeout=limit)
            except subprocess.TimeoutExpired:
                timed_out = True
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"],
                                   capture_output=True, timeout=15,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                else:
                    p.kill()
                try:
                    p.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    pass
            reader.join(5)
        finally:
            self._unlink_deps(links)
        out = _ANSI.sub("", "".join(tail)).replace("\r\n", "\n").strip()
        if len(out) > OUTPUT_TAIL:
            out = "…" + out[-OUTPUT_TAIL:]
        secs = round(time.monotonic() - t0, 1)
        if timed_out:
            head = f"{label} `{cmd}` stopped: still running after {round(limit / 60)} min."
        else:
            head = (f"{label} `{cmd}` " + ("PASSED" if p.returncode == 0 else
                                         f"FAILED (exit {p.returncode})") + f" in {secs}s.")
        return head + "\n\n" + (out or "(no output)")

    # ── MCP ───────────────────────────────────────────────────────────────

    def tools(self) -> list[dict]:
        # Read mode (Track W2): the shell and the reference tools only.
        out = [] if self.readonly else [dict(t) for t in TOOLS]
        if self.shell:
            for t in SHELL_TOOLS:
                t = dict(t)
                if t["name"] == "shell":
                    sp = self.shell
                    t["description"] = (
                        "Run a bash command (Git Bash on Windows) in "
                        + ("the project's private copy" if sp.get("write") else
                           "the project folder, READ-ONLY (Read mode: nothing can be changed)")
                        + ", inside a Windows sandbox: it can write only "
                        + ("in the copy and a scratch folder" if sp.get("write") else "in a scratch folder")
                        + " -- never elsewhere on this PC. Internet: "
                        + ("ON (installs work: npm install, pip install into a .venv in the "
                           "project)" if sp.get("internet") else
                           "OFF (installing from the internet will fail; say so if a task needs it)")
                        + ". Install packages locally, never globally. Default timeout 120s; for "
                        "servers use start_process. Returns the exit code and the end of the output.")
                out.append(t)
        if self.readonly:
            out += [dict(t) for t in REF_TOOLS] if self.refs else []
            return out
        if self.refs:
            out += [dict(t) for t in REF_TOOLS]
        if self.check:
            t = dict(RUN_CHECK)
            t["description"] = (
                f"Run this project's check command (`{self.check['command']}`) in the "
                "project folder and get its exit code and the end of its output. Use it to "
                "see whether your change works, and fix what it reports. It is the only "
                "command you can run.")
            out.append(t)
        if self.commands:
            t = dict(RUN_COMMAND)
            t["description"] = (
                "Run one of this project's commands in the project folder and get its exit code "
                "and the end of its output. These are the only commands you can run:\n"
                + "\n".join(f"- {c['name']}" + (" <path>" if c.get("arg") else "")
                            + f": `{c['command']}`" for c in self.commands))
            out.append(t)
        return out

    def call(self, name: str, args: dict) -> tuple[str, bool]:
        fn = {"move_path": self.move_path, "copy_path": self.copy_path,
              "delete_path": self.delete_path, "make_dir": self.make_dir,
              "run_check": self.run_check, "run_command": self.run_command,
              "shell": self.shell_run, "start_process": self.start_process,
              "process_output": self.process_output, "stop_process": self.stop_process,
              "list_processes": self.list_processes,
              "ref_list": self.ref_list,
              "ref_read": self.ref_read, "ref_find": self.ref_find}.get(name)
        if fn is None or (name == "run_check" and not self.check) or \
                (name == "run_command" and not self.commands) or \
                (name in ("shell", "start_process", "process_output", "stop_process",
                          "list_processes") and not self.shell) or \
                (self.readonly and name in ("move_path", "copy_path", "delete_path",
                                            "make_dir", "run_check", "run_command")) or \
                (name.startswith("ref_") and not self.refs):
            return f"Unknown tool {name!r}.", True
        try:
            return fn(args if isinstance(args, dict) else {}), False
        except ToolError as e:
            return str(e), True
        except OSError as e:
            return f"{name} failed: {e.strerror or e}", True

    def handle(self, msg: dict) -> dict | None:
        mid = msg.get("id")
        method = msg.get("method")
        if mid is None:
            return None
        if method == "initialize":
            ver = (msg.get("params") or {}).get("protocolVersion") or PROTOCOL
            return {"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": ver, "capabilities": {"tools": {}},
                "serverInfo": {"name": "magi-workspace", "version": "1"}}}
        if method == "ping":
            return {"jsonrpc": "2.0", "id": mid, "result": {}}
        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": mid, "result": {"tools": self.tools()}}
        if method == "tools/call":
            p = msg.get("params") or {}
            text, err = self.call(str(p.get("name") or ""), p.get("arguments") or {})
            return {"jsonrpc": "2.0", "id": mid, "result": {
                "content": [{"type": "text", "text": text}], "isError": err}}
        return {"jsonrpc": "2.0", "id": mid,
                "error": {"code": -32601, "message": f"Method not found: {method}"}}

    def serve(self, fin=None, fout=None) -> None:
        fin = fin or sys.stdin
        fout = fout or sys.stdout
        try:
            for line in fin:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                reply = self.handle(msg) if isinstance(msg, dict) else None
                if reply is not None:
                    fout.write(json.dumps(reply) + "\n")
                    fout.flush()
        finally:
            # The CLI is gone: nothing this task started keeps running.
            # (Killed outright, the jobs' kill-on-close does the same.)
            self.close()


def from_config(path: Path) -> Server:
    cfg = json.loads(Path(path).read_text(encoding="utf-8"))
    root = Path(cfg["root"])
    if not root.is_dir():
        raise SystemExit(f"no such folder: {root}")
    return Server(root, cfg.get("check"), Path(cfg["real"]) if cfg.get("real") else None,
                  cfg.get("refs"), cfg.get("writes"), cfg.get("commands"),
                  cfg.get("shell"), cfg.get("readonly", False))


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    a = ap.parse_args(argv)
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    from_config(Path(a.config)).serve()


if __name__ == "__main__":
    main()
