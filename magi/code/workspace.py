"""Projects, bindings, and looking at a directory without walking it.

A **project** is the logical thing: "A1". A **binding** is where that project
lives on this machine. They are separate because they have different lifetimes:
the project follows you between devices, the binding describes one engine and
never leaves it.

The path is the whole reason for the split. A path like C:/Users/antho/Desktop/A1
is true on the desk and meaningless on a phone, so syncing it would put a value
in front of you that cannot be acted on and looks like it can.

Nothing here writes into a project or runs anything. It registers paths,
validates them, and reads directory *names*.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .. import proc
from ..settings import ROOT

# Paths MAGI must never be pointed at, whatever is typed.
#
# Not a security boundary on its own -- the real containment is that the agent
# runs with cwd set to the binding root and a PreToolUse hook that resolves
# every path argument (later phase). This is the earlier, cheaper refusal: it
# stops an obviously wrong workspace being REGISTERED, where the mistake is
# still one line in a database rather than a hook decision under load.
_FORBIDDEN_NAMES = {
    "windows", "system32", "program files", "program files (x86)",
    "programdata", "$recycle.bin", "system volume information",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class WorkspaceError(Exception):
    """A refusal with a reason worth showing the user."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ── validation ─────────────────────────────────────────────────────────────

def resolve_root(raw: str) -> Path:
    """Turn what someone typed into a path, or refuse with a reason.

    Every refusal names the thing that is wrong, because "invalid path" sends
    you to check the spelling of a path that is spelled correctly.
    """
    s = (raw or "").strip().strip('"').strip("'")
    if not s:
        raise WorkspaceError("empty", "No folder given.")
    try:
        p = Path(os.path.expandvars(os.path.expanduser(s))).resolve()
    except Exception as exc:
        raise WorkspaceError("unreadable", f"That path could not be read: {exc}")

    if not p.exists():
        raise WorkspaceError("missing", f"{p} does not exist.")
    if not p.is_dir():
        raise WorkspaceError("not_a_dir", f"{p} is a file, not a folder.")

    # A drive root is almost always a slip -- and it is the one mistake where
    # "delete the build output" could mean the whole disk.
    if p.parent == p:
        raise WorkspaceError(
            "drive_root",
            f"{p} is a whole drive. Pick the project folder inside it.")

    parts_lower = [x.lower() for x in p.parts]
    for bad in _FORBIDDEN_NAMES:
        if bad in parts_lower:
            raise WorkspaceError(
                "system_path",
                f"{p} is inside a system folder ({bad}). MAGI will not work there.")

    # MAGI's own directory holds live browser sessions, the run database and
    # the engine's code. An agent editing the engine it is running inside is a
    # class of problem best not opened at all.
    try:
        if p == ROOT or ROOT in p.parents or p in ROOT.parents and p == ROOT.parent:
            pass
    except Exception:
        pass
    if p == ROOT or ROOT in p.parents:
        raise WorkspaceError(
            "inside_magi",
            "That folder is inside MAGI's own engine directory.")
    return p


# ── git ────────────────────────────────────────────────────────────────────

# UTF-8, stated. Without `encoding`, text=True decodes with the Windows
# ANSI codepage (cp1252), and git speaks UTF-8. The first byte cp1252 has no
# mapping for -- 0x90, in a 475 KB `git grep` over A1 -- killed subprocess's
# reader thread. It does not raise in the caller: the output just comes back
# truncated or empty, so a fingerprint or a context block is silently wrong.
# errors="replace" means a bad byte costs one character, never the output.
def _git(root: Path, *args: str, timeout: int = 10) -> str:
    """Read-only git. Returns "" rather than raising: a folder that is not a
    repository is a perfectly normal workspace, not an error."""
    try:
        r = proc.run(["git", "-C", str(root), *args],
                     capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        return (r.stdout or "").strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def git_info(root: Path) -> dict[str, Any]:
    inside = _git(root, "rev-parse", "--is-inside-work-tree") == "true"
    if not inside:
        return {"repo": False}
    return {
        "repo": True,
        "branch": _git(root, "rev-parse", "--abbrev-ref", "HEAD"),
        "head": _git(root, "rev-parse", "HEAD")[:12],
        "remote": _git(root, "remote", "get-url", "origin"),
    }


def fingerprint(root: Path) -> str:
    """A cheap answer to "has this project changed since I last looked?".

    Two git calls, not a filesystem walk. `ls-files -s` lists the index, whose
    entries change when files are added, removed or staged, and HEAD covers
    commits -- so together they move for every change that matters to a
    project's SHAPE, which is what the skeleton caches.

    A dirty working tree does not move it, and that is deliberate: editing one
    file should not invalidate a cached directory listing.
    """
    head = _git(root, "rev-parse", "HEAD") or "nogit"
    index = _git(root, "ls-files", "-s")
    if index:
        import hashlib
        return head[:12] + ":" + hashlib.sha256(index.encode()).hexdigest()[:16]
    # Not a repository: fall back to the top level only, which is still O(1)
    # in the depth of the tree.
    try:
        names = sorted(x.name for x in root.iterdir())
        import hashlib
        return "nogit:" + hashlib.sha256("|".join(names).encode()).hexdigest()[:16]
    except Exception:
        return "unknown"


# ── the shape of a project ────────────────────────────────────────────────

# Directories that are never interesting and are usually enormous. Skipped
# rather than counted: a node_modules with 40,000 files would dominate every
# listing and tell you nothing about the project.
_SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "env",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", "dist", "build",
    ".next", ".nuxt", "target", "vendor", ".gradle", ".idea", ".vscode",
    "Pods", ".terraform", "coverage", ".cache",
}

_STACK_MARKERS = [
    ("package.json", "node"), ("pyproject.toml", "python"),
    ("requirements.txt", "python"), ("Cargo.toml", "rust"),
    ("go.mod", "go"), ("pom.xml", "java"), ("build.gradle", "java"),
    ("Gemfile", "ruby"), ("composer.json", "php"), ("*.csproj", "dotnet"),
    ("Dockerfile", "docker"), ("wrangler.toml", "cloudflare"),
]


def detect_stack(root: Path) -> list[str]:
    found: list[str] = []
    try:
        names = {x.name for x in root.iterdir()}
    except Exception:
        return found
    for marker, label in _STACK_MARKERS:
        hit = (any(n.endswith(marker[1:]) for n in names)
               if marker.startswith("*") else marker in names)
        if hit and label not in found:
            found.append(label)
    return found


def build_tree(root: Path, depth: int = 3, cap: int = 600) -> dict[str, Any]:
    """The project's shape, to a bounded depth and a bounded size.

    `cap` is a hard stop on entries, not a suggestion. A project with 50,000
    files should produce a truncated listing and say so, rather than a
    response nobody can send to a model or render in a browser.
    """
    count = 0
    truncated = False

    def walk(d: Path, level: int) -> list[dict[str, Any]]:
        nonlocal count, truncated
        if level > depth or truncated:
            return []
        out: list[dict[str, Any]] = []
        try:
            entries = sorted(d.iterdir(), key=lambda x: (x.is_file(), x.name.lower()))
        except (PermissionError, OSError):
            return []
        for e in entries:
            if count >= cap:
                truncated = True
                return out
            name = e.name
            if name.startswith(".") and name not in {".github", ".claude"}:
                continue
            if e.is_dir():
                if name in _SKIP_DIRS:
                    continue
                count += 1
                out.append({"n": name, "d": True, "c": walk(e, level + 1)})
            else:
                count += 1
                out.append({"n": name, "d": False})
        return out

    return {"tree": walk(root, 1), "truncated": truncated, "entries": count}


def skeleton(root: Path, depth: int = 3) -> dict[str, Any]:
    return {
        "root": str(root),
        "stack": detect_stack(root),
        "git": git_info(root),
        **build_tree(root, depth=depth),
        "built_at": _now(),
    }


# ── the directory picker ───────────────────────────────────────────────────

def drives() -> list[str]:
    if os.name != "nt":
        return ["/"]
    out = []
    for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
        p = f"{letter}:\\"
        if os.path.exists(p):
            out.append(p)
    return out


def browse(raw: str | None) -> dict[str, Any]:
    """List the DIRECTORIES inside a path, for the console's own picker.

    A browser cannot enumerate a remote filesystem and MAGI does not use the
    native file picker, so this is how a folder gets chosen -- and it is the
    only shape that works from a phone, which is the point.

    Directory names only. It never returns file contents, and it never
    descends: one level per request, so a mistyped path costs one listing.
    """
    if not raw:
        return {"path": "", "up": None, "drives": drives(), "dirs": []}
    try:
        p = Path(os.path.expandvars(os.path.expanduser(raw.strip()))).resolve()
    except Exception as exc:
        raise WorkspaceError("unreadable", f"That path could not be read: {exc}")
    if not p.is_dir():
        raise WorkspaceError("not_a_dir", f"{p} is not a folder.")

    dirs: list[dict[str, Any]] = []
    try:
        for e in sorted(p.iterdir(), key=lambda x: x.name.lower()):
            if not e.is_dir():
                continue
            if e.name.startswith(".") and e.name not in {".github", ".claude"}:
                continue
            if e.name in _SKIP_DIRS:
                continue
            dirs.append({
                "name": e.name,
                "path": str(e),
                # Marked, because "which of these is the project?" is nearly
                # always answered by "the one that is a repository".
                "repo": (e / ".git").exists(),
            })
            if len(dirs) >= 400:
                break
    except PermissionError:
        raise WorkspaceError("denied", f"No permission to read {p}.")

    return {
        "path": str(p),
        "up": str(p.parent) if p.parent != p else None,
        "drives": drives(),
        "dirs": dirs,
    }


# ── the records ────────────────────────────────────────────────────────────

_NAME_OK = re.compile(r"^[^\x00-\x1f]{1,60}$")


@dataclass
class Project:
    id: str
    name: str
    aliases: list[str] = field(default_factory=list)
    prefs: dict[str, Any] = field(default_factory=dict)
    notes: str = ""

    def to_row(self) -> dict[str, Any]:
        return {
            "id": self.id, "name": self.name,
            "aliases": json.dumps(self.aliases),
            "prefs": json.dumps(self.prefs),
            "notes": self.notes[:4000],
        }


DEFAULT_PREFS = {
    # Read-only until you say otherwise. A new project's first agent should
    # not be able to change anything.
    "permissionMode": "plan",
    # Off, always. A1 already auto-commits through its own Stop hook, and two
    # systems staging the same tree is how one silently absorbs the other.
    "autoCommit": False,
    "autoPush": False,
    "commitStyle": "summary",
    "batchWindowMin": 3,
    # The GitHub login this project pushes (and pulls) as -- a name, never a
    # token (magi/github/accounts.py). "" until you pick one.
    "github": "",
}


def new_project_id() -> str:
    return "proj_" + uuid.uuid4().hex[:12]


def check_name(name: str) -> str:
    n = (name or "").strip()
    if not _NAME_OK.match(n):
        raise WorkspaceError("bad_name", "Give the project a name, under 60 characters.")
    return n


def resolve_project(projects: list[dict[str, Any]], phrase: str) -> dict[str, Any] | None:
    """"Work on A1." -- exact name, then alias, then folder name, then prefix.

    Deliberately not fuzzy beyond a prefix. Guessing which project someone
    meant is the one place where being clever picks the wrong folder to edit.
    """
    q = (phrase or "").strip().lower()
    if not q:
        return None
    for p in projects:
        if p.get("name", "").lower() == q:
            return p
    for p in projects:
        for a in p.get("aliases") or []:
            if str(a).lower() == q:
                return p
    for p in projects:
        for b in p.get("bindings") or []:
            if Path(b.get("root", "")).name.lower() == q:
                return p
    hits = [p for p in projects if p.get("name", "").lower().startswith(q)]
    return hits[0] if len(hits) == 1 else None
