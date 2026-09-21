"""What an agent's diff may touch, decided before anyone is asked to approve it.

Phase 8's write path never lets an agent near the real workspace: it edits a
throwaway worktree (sandbox.py), MAGI diffs the worktree, and a person approves
the diff. This module is the step between the diff and the person. It refuses
what no diff should ever do, so the approval card is only ever asked about
things where a human reading the change is the right judge:

  * **Containment.** Every path in the diff -- both sides of the header, the
    ---/+++ lines, rename sources and targets -- must be relative, free of
    `..`, and (checked against the real tree) must not pass through a link
    that points out of the workspace.
  * **Deny-list.** `.git/`, credential folders, key and env files, and the
    agents' own settings folders (`.claude/`, `.codex/` -- a planted hook
    there runs on the next task) are refused whatever the diff says.
  * **No links, no submodules.** A symlink or a gitlink is an instruction to
    write somewhere else later; refused outright.
  * **Bounded.** A diff over the size or file cap is refused with a sentence,
    never truncated -- a half-shown diff approved in full is the failure this
    whole design exists to prevent.

One bad file refuses the whole diff. There is no "untick that one": a change
that tried to write into .git/ is not a change to trust with the rest.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .agents import context

MAX_PATCH_BYTES = 2_000_000      # the whole diff
MAX_FILES = 300                  # files in one approval
CARD_DIFF_BYTES = 60_000         # one file's diff as drawn on the card
CARD_TOTAL_BYTES = 600_000       # every file's diff together, on the card

# Folders that are never an agent's to write in, by any component of the path.
_DENY_DIRS = {
    ".git": "git's own internals",
    ".ssh": "a credentials folder",
    ".gnupg": "a credentials folder",
    ".aws": "a credentials folder",
    ".azure": "a credentials folder",
    ".claude": "an agent settings folder (hooks there run on the next task)",
    ".codex": "an agent settings folder (hooks there run on the next task)",
}
# Windows device names: "nul.txt" is not a file, it is the null device.
_RESERVED = re.compile(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$", re.I)
_DRIVE = re.compile(r"^[A-Za-z]:")


@dataclass
class FileChange:
    path: str
    status: str = "modified"          # added | modified | deleted | mode
    adds: int = 0
    dels: int = 0
    binary: bool = False
    new_mode: str = ""
    diff: str = ""
    truncated: bool = False
    paths: list[str] = field(default_factory=list)   # every path the chunk names

    def to_dict(self) -> dict[str, Any]:
        return {"path": self.path, "status": self.status, "adds": self.adds,
                "dels": self.dels, "binary": self.binary, "diff": self.diff,
                "truncated": self.truncated}


@dataclass
class Review:
    ok: bool
    files: list[FileChange] = field(default_factory=list)
    refused: list[tuple[str, str]] = field(default_factory=list)
    message: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"ok": self.ok, "message": self.message,
                "files": [f.to_dict() for f in self.files],
                "refused": [{"path": p, "why": w} for p, w in self.refused]}


# ── paths ──────────────────────────────────────────────────────────────────

_ESC = {"a": "\a", "b": "\b", "t": "\t", "n": "\n", "v": "\v", "f": "\f",
        "r": "\r", '"': '"', "\\": "\\"}


def unquote(s: str) -> str:
    """git's C-style quoting ("a/caf\\303\\251.txt") back to the real name.

    Checking the quoted form would let `.git\\146ig`-style spellings past a
    deny-list written for `.git/config`.
    """
    if not (len(s) >= 2 and s[0] == '"' and s[-1] == '"'):
        return s
    body, out, i = s[1:-1], bytearray(), 0
    while i < len(body):
        c = body[i]
        if c == "\\" and i + 1 < len(body):
            n = body[i + 1]
            if re.fullmatch(r"[0-7]{3}", body[i + 1:i + 4]):
                out.append(int(body[i + 1:i + 4], 8))
                i += 4
                continue
            out += _ESC.get(n, n).encode("utf-8")
            i += 2
            continue
        out += c.encode("utf-8")
        i += 1
    return out.decode("utf-8", "replace")


def _strip_side(p: str) -> str | None:
    """'a/src/x.py' -> 'src/x.py'; '/dev/null' -> None."""
    p = unquote(p.rstrip("\t").rstrip("\r"))
    if p == "/dev/null":
        return None
    if p[:2] in ("a/", "b/"):
        return p[2:]
    return p


def check_path(rel: str, *, root: Path | None = None, prefix: str = "") -> str | None:
    """Why this path may not be written, or None if it may."""
    p = rel.replace("\\", "/")
    if not p.strip():
        return "an empty path"
    if p.startswith("/") or _DRIVE.match(p):
        return "an absolute path, outside the workspace"
    parts = [x for x in p.split("/") if x not in ("", ".")]
    if ".." in parts:
        return "a path that climbs outside the workspace"
    if ":" in p:
        return "a hidden stream or an invalid name (contains ':')"
    if prefix and not (p + "/").startswith(prefix):
        return f"outside this workspace's folder ({prefix.rstrip('/')})"
    for part in parts:
        why = _DENY_DIRS.get(part.lower())
        if why:
            return f"inside {part}/ -- {why}"
        if _RESERVED.match(part) or part.endswith((" ", ".")):
            return f"'{part}' is not a usable file name on Windows"
    if parts and context.is_secret(Path(parts[-1])):
        return "a secret or key file"
    if root is not None and context.contained(root, Path(p)) is None:
        return "outside the workspace once links in the real folder are followed"
    return None


# ── the diff ───────────────────────────────────────────────────────────────

def _header_paths(line: str) -> list[str]:
    """Both paths from a `diff --git a/X b/Y` line, quoted or not."""
    rest = line[len("diff --git "):].rstrip("\n").rstrip("\r")
    if rest.startswith('"'):
        m = re.match(r'("(?:[^"\\]|\\.)*")\s+(.*)$', rest)
        if m:
            return [p for p in (_strip_side(m.group(1)), _strip_side(m.group(2))) if p]
    # Unquoted and not renamed: "a/X b/X", which splits exactly in half.
    if (len(rest) - 1) % 2 == 0:
        half = (len(rest) - 1) // 2
        a, sep, b = rest[:half], rest[half], rest[half + 1:]
        if sep == " " and a[2:] == b[2:] and a[:2] == "a/" and b[:2] == "b/":
            return [a[2:]]
    i = rest.rfind(" b/")
    if i > 0:
        return [p for p in (_strip_side(rest[:i]), _strip_side(rest[i + 1:])) if p]
    return [p for p in (_strip_side(rest),) if p]


def split_patch(patch: str) -> list[FileChange]:
    files: list[FileChange] = []
    cur: FileChange | None = None
    body: list[str] = []
    in_hunk = False

    def close():
        if cur is not None:
            cur.diff = "".join(body)
            files.append(cur)

    def name(p: str | None):
        if p and p not in cur.paths:
            cur.paths.append(p)

    for line in patch.splitlines(keepends=True):
        if line.startswith("diff --git "):
            close()
            cur, body, in_hunk = FileChange(path=""), [line], False
            for p in _header_paths(line):
                name(p)
            continue
        if cur is None:
            continue
        body.append(line)
        if line.startswith("@@"):
            in_hunk = True
            continue
        if in_hunk:
            if line.startswith("+"):
                cur.adds += 1
            elif line.startswith("-"):
                cur.dels += 1
            continue
        s = line.rstrip("\n").rstrip("\r")
        if s.startswith("new file mode "):
            cur.status, cur.new_mode = "added", s.split()[-1]
        elif s.startswith("deleted file mode "):
            cur.status = "deleted"
        elif s.startswith("new mode "):
            cur.new_mode = s.split()[-1]
            if cur.status == "modified":
                cur.status = "mode"
        elif s.startswith(("--- ", "+++ ")):
            name(_strip_side(s[4:]))
            if cur.status == "mode":
                cur.status = "modified"
        elif s.startswith(("rename from ", "rename to ", "copy from ", "copy to ")):
            name(unquote(s.split(" ", 2)[2]))
        elif s.startswith("GIT binary patch") or s.startswith("Binary files"):
            cur.binary = True
            if cur.status == "mode":
                cur.status = "modified"
    close()

    for f in files:
        # The name you would recognise: the new side, or the old for a delete.
        f.path = (f.paths[-1] if f.status != "deleted" else f.paths[0]) if f.paths else "?"
        f.path = f.path.replace("\\", "/")
    return files


def _card_diff(f: FileChange, budget: int) -> tuple[str, bool]:
    if f.binary:
        # base85 of a binary is not something anyone approves by reading.
        return "(binary file)", False
    cap = min(CARD_DIFF_BYTES, budget)
    if len(f.diff) <= cap:
        return f.diff, False
    cut = f.diff.rfind("\n", 0, cap)
    return f.diff[: cut + 1 if cut > 0 else cap], True


def review(patch: str, *, root: Path | None = None, prefix: str = "") -> Review:
    """Decide whether this diff may be put in front of a person at all."""
    size = len(patch.encode("utf-8", "replace"))
    if size > MAX_PATCH_BYTES:
        return Review(False, message=(
            f"This change is too large to review ({size / 1e6:.1f} MB; the limit is "
            f"{MAX_PATCH_BYTES / 1e6:.0f} MB). Nothing was applied. Ask for a smaller, "
            "more focused change."))
    files = split_patch(patch)
    if len(files) > MAX_FILES:
        return Review(False, message=(
            f"This change touches {len(files)} files; the limit is {MAX_FILES}. "
            "Nothing was applied. Split it into smaller tasks."))

    refused: list[tuple[str, str]] = []
    seen: set[str] = set()
    for f in files:
        if f.new_mode == "120000":
            refused.append((f.path, "creates a symbolic link, which could point anywhere"))
            continue
        if f.new_mode == "160000":
            refused.append((f.path, "adds a submodule link, not a file"))
            continue
        for p in f.paths:
            norm = p.replace("\\", "/")
            if norm in seen:
                continue
            seen.add(norm)
            why = check_path(norm, root=root, prefix=prefix)
            if why:
                refused.append((norm, why))
                break
    if refused:
        first = refused[0]
        more = f" (and {len(refused) - 1} more)" if len(refused) > 1 else ""
        return Review(False, refused=refused, message=(
            f"Refused: {first[0]} is {first[1]}{more}. Nothing was applied, "
            "and you were not asked -- this is never allowed."))

    budget = CARD_TOTAL_BYTES
    for f in files:
        f.diff, f.truncated = _card_diff(f, max(budget, 0))
        budget -= len(f.diff)
    return Review(True, files=files)
