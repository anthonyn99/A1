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

What keeps it safe is the same as everything else in Write mode: it works on
the task's PRIVATE COPY (sandbox.py), and nothing reaches your folder unless
you approve the diff. On top of that, this server refuses on its own:

  * any path outside the copy -- absolute, `..`, or through a link or a
    junction anywhere on the way (checked on the real disk, not the string);
  * `.git` and the folders security.py never lets a diff touch (the copy's
    own `.git` file is what ties it to its repository);
  * a folder tree that holds a link or a junction (deleting or copying
    through one would reach outside the copy).

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
    def __init__(self, root: Path, check: dict | None = None, real: Path | None = None):
        self.root = Path(root)
        self.check = check if check and check.get("command") else None
        self.real = Path(real) if real else None

    # ── the file tools ────────────────────────────────────────────────────

    def move_path(self, a: dict) -> str:
        src = resolve(self.root, a.get("from"), must_exist=True)
        dst = resolve(self.root, a.get("to"))
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
        return f"Moved {_rel(self.root, src)} to {_rel(self.root, dst)}."

    def copy_path(self, a: dict) -> str:
        src = resolve(self.root, a.get("from"), must_exist=True)
        dst = resolve(self.root, a.get("to"))
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
            return f"Copied {_rel(self.root, src)}/ ({n} files) to {_rel(self.root, dst)}/."
        shutil.copy2(src, dst)
        return f"Copied {_rel(self.root, src)} to {_rel(self.root, dst)}."

    def delete_path(self, a: dict) -> str:
        p = resolve(self.root, a.get("path"), must_exist=True)
        if p.is_dir():
            n, _ = _tree_ok(p)
            shutil.rmtree(p)
            return f"Deleted {_rel(self.root, p)}/ ({n} files)."
        p.unlink()
        return f"Deleted {_rel(self.root, p)}."

    def make_dir(self, a: dict) -> str:
        p = resolve(self.root, a.get("path"))
        if os.path.lexists(p) and not p.is_dir():
            raise ToolError(f"{a.get('path')}: a file of that name exists.")
        p.mkdir(parents=True, exist_ok=True)
        return f"Folder {_rel(self.root, p)}/ is there."

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

    def run_check(self, a: dict) -> str:
        if not self.check:
            raise ToolError("This project has no check that agents may run.")
        cmd = self.check["command"]
        limit = min(MAX_RUN_S, max(60, int(self.check.get("timeout_min") or 10) * 60))
        env = {k: v for k, v in os.environ.items()
               if not _SECRET_ENV.search(k) and not k.startswith("CLAUDE_CODE_")}
        env.update({"CI": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "PAGER": "cat",
                    "GIT_PAGER": "cat", "PYTHONUNBUFFERED": "1"})
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
            head = f"Check `{cmd}` stopped: still running after {round(limit / 60)} min."
        else:
            head = (f"Check `{cmd}` " + ("PASSED" if p.returncode == 0 else
                                         f"FAILED (exit {p.returncode})") + f" in {secs}s.")
        return head + "\n\n" + (out or "(no output)")

    # ── MCP ───────────────────────────────────────────────────────────────

    def tools(self) -> list[dict]:
        out = [dict(t) for t in TOOLS]
        if self.check:
            t = dict(RUN_CHECK)
            t["description"] = (
                f"Run this project's check command (`{self.check['command']}`) in the "
                "project folder and get its exit code and the end of its output. Use it to "
                "see whether your change works, and fix what it reports. It is the only "
                "command you can run.")
            out.append(t)
        return out

    def call(self, name: str, args: dict) -> tuple[str, bool]:
        fn = {"move_path": self.move_path, "copy_path": self.copy_path,
              "delete_path": self.delete_path, "make_dir": self.make_dir,
              "run_check": self.run_check}.get(name)
        if fn is None or (name == "run_check" and not self.check):
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


def from_config(path: Path) -> Server:
    cfg = json.loads(Path(path).read_text(encoding="utf-8"))
    root = Path(cfg["root"])
    if not root.is_dir():
        raise SystemExit(f"no such folder: {root}")
    return Server(root, cfg.get("check"), Path(cfg["real"]) if cfg.get("real") else None)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    a = ap.parse_args(argv)
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    from_config(Path(a.config)).serve()


if __name__ == "__main__":
    main()
