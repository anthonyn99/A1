"""Edits from an agent that cannot open files: a fixed format MAGI applies.

A browser unit is a chat window. In write mode it answers with blocks like

    FILE: src/app.py
    <<<<<<< SEARCH
    def total(xs):
        return sum(xs)
    =======
    def total(xs):
        return sum(x for x in xs if x is not None)
    >>>>>>> REPLACE

and MAGI makes the change in the sandbox. SEARCH/REPLACE rather than whole
files because the unit is shown files cut to a budget (context.py): a whole
file written back from a truncated view would delete everything past the cut.
An empty SEARCH creates a new file.

Track V adds the file operations a CLI agent has and a chat window does not,
one line each, inside a code block like the rest:

    DELETE: path/to/file-or-folder
    MOVE: old/path -> new/path       (a rename is a move)
    COPY: old/path -> new/path

Only inside a fenced code block: a line of prose that happens to start
"Delete:" must never delete anything. They apply in the order written,
interleaved with the SEARCH/REPLACE blocks, so "MOVE a -> b" followed by an
edit of b works.

All or nothing: every block is checked -- path contained and allowed, SEARCH
found exactly once, a move's destination free -- against a picture of the
folder as the earlier blocks leave it, before any file is written, so a reply
with one bad block does not leave a half-edited sandbox for the next agent to
inherit.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from .. import security
from . import context

_FILE = re.compile(r"^[\s>*_`#-]*FILE:\s*`?([^`*\n]+?)`?[\s*_]*$", re.I)
_S = re.compile(r"^\s*<{5,9}\s*SEARCH\s*$")
_M = re.compile(r"^\s*={5,9}\s*$")
_R = re.compile(r"^\s*>{5,9}\s*REPLACE\s*$")
_OP = re.compile(r"^\s*(DELETE|MOVE|RENAME|COPY):\s*(.+?)\s*$", re.I)
_ARROW = re.compile(r"\s+(?:->|→|=>)\s+")
_FENCE = re.compile(r"^\s*(```|~~~)")
MAX_OP_FILES = 5_000           # files one DELETE/MOVE/COPY of a folder may touch

# Every block goes INSIDE a fenced code block. Found live: MAGI reads a unit's
# reply from the rendered page, and rendered markdown eats this format outside
# a code block -- "=======" under a line becomes a heading rule, ">>>>>>>" a
# nested quote, and a paragraph's line breaks become spaces. Inside a code
# block the text survives exactly.
FORMAT_HELP = (
    "To change files, reply with one fenced code block (```) per change. The "
    "block's content must be exactly this shape:\n\n"
    "```\n"
    "FILE: path/relative/to/project\n"
    "<<<<<<< SEARCH\n"
    "the exact existing lines to replace, copied from the file\n"
    "=======\n"
    "the new lines\n"
    ">>>>>>> REPLACE\n"
    "```\n\n"
    "To delete, move (rename) or copy a file or a whole folder, put one line per "
    "operation in a code block:\n\n"
    "```\n"
    "DELETE: path/to/file-or-folder\n"
    "MOVE: old/path -> new/path\n"
    "COPY: old/path -> new/path\n"
    "```\n\n"
    "Rules: always inside a code block. SEARCH must match the file exactly and only once -- include enough "
    "surrounding lines to make it unique. Use an empty SEARCH to create a new "
    "file. Paths are relative to the project folder. Only edit files you were "
    "shown, or create new ones. Blocks apply in the order you write them, so "
    "you may MOVE a file and then edit it at its new path; a MOVE or COPY never "
    "overwrites, so DELETE the destination first if you mean to replace it. "
    "After the blocks, add a short summary of what you changed and why.")


@dataclass
class Edit:
    path: str
    search: str = ""
    replace: str = ""
    # "edit" (SEARCH/REPLACE) | "delete" | "move" | "copy"; `to` for the last two.
    op: str = "edit"
    to: str = ""


def _clean_path(s: str) -> str:
    return s.strip().strip("`'\"*_").strip()


def parse(text: str) -> list[Edit]:
    out: list[Edit] = []
    path = ""
    lines = (text or "").replace("\r\n", "\n").split("\n")
    fenced = False
    i = 0
    while i < len(lines):
        if _FENCE.match(lines[i]):
            fenced = not fenced
            i += 1
            continue
        op = _OP.match(lines[i]) if fenced else None
        if op:
            kind = op.group(1).lower()
            arg = op.group(2)
            if kind == "delete":
                if _clean_path(arg):
                    out.append(Edit(_clean_path(arg), op="delete"))
            else:
                ends = _ARROW.split(arg, maxsplit=1)
                if len(ends) == 2 and _clean_path(ends[0]) and _clean_path(ends[1]):
                    out.append(Edit(_clean_path(ends[0]), op="copy" if kind == "copy" else "move",
                                    to=_clean_path(ends[1])))
            i += 1
            continue
        m = _FILE.match(lines[i])
        if m:
            path = m.group(1).strip()
            i += 1
            continue
        if _S.match(lines[i]) and path:
            j = i + 1
            search: list[str] = []
            while j < len(lines) and not _M.match(lines[j]):
                search.append(lines[j])
                j += 1
            k = j + 1
            replace: list[str] = []
            while k < len(lines) and not _R.match(lines[k]):
                replace.append(lines[k])
                k += 1
            if j < len(lines) and k < len(lines):
                out.append(Edit(path, "\n".join(search), "\n".join(replace)))
                i = k + 1
                continue
        i += 1
    return out


def looks_like_edits(text: str) -> bool:
    """A reply that attempted the format, whether or not it survived."""
    t = text or ""
    return bool(re.search(r"FILE:", t) and re.search(r"<{5,}\s*SEARCH|REPLACE\b", t))


def _find(content: str, search: str) -> tuple[int, int] | None:
    """(start, end) of the one place `search` occurs, or None.

    Exact first; then ignoring trailing whitespace per line, which is what a
    chat window most often loses when it renders code.
    """
    if content.count(search) == 1:
        s = content.index(search)
        return s, s + len(search)
    if content.count(search) > 1:
        return None
    want = [ln.rstrip() for ln in search.split("\n")]
    have = content.split("\n")
    hits = []
    for a in range(len(have) - len(want) + 1):
        if [ln.rstrip() for ln in have[a:a + len(want)]] == want:
            hits.append(a)
    if len(hits) != 1:
        return None
    a = hits[0]
    start = sum(len(x) + 1 for x in have[:a])
    end = start + sum(len(x) + 1 for x in have[a:a + len(want)]) - 1
    return start, end


def _is_link(p: Path) -> bool:
    try:
        return p.is_symlink() or bool(getattr(os.path, "isjunction", lambda _: False)(p))
    except OSError:
        return True


class _View:
    """The folder as the blocks so far leave it: disk, plus what is staged.
    `staged[path]` is the file's new bytes, or None for deleted."""

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.staged: dict[Path, bytes | None] = {}

    def target(self, rel: str) -> tuple[Path | None, str]:
        rel = rel.replace("\\", "/").strip()
        while rel.startswith("./"):
            rel = rel[2:]
        rel = rel.rstrip("/")
        if not [x for x in rel.split("/") if x not in ("", ".")]:
            return None, "that is the project folder itself"
        why = security.check_path(rel, root=self.root)
        if why:
            return None, why
        t = context.contained(self.root, Path(rel))
        if t is None:
            return None, "outside the project"
        return t, ""

    def is_file(self, p: Path) -> bool:
        if p in self.staged:
            return self.staged[p] is not None
        return p.is_file()

    def read(self, p: Path) -> bytes | None:
        if p in self.staged:
            return self.staged[p]
        try:
            return p.read_bytes() if p.is_file() else None
        except OSError:
            return None

    def files_under(self, d: Path) -> list[Path] | str:
        """Every file under folder `d` as the view has it, or why not."""
        out: set[Path] = set()
        if d.is_dir() and not _is_link(d):
            for dp, dirs, names in os.walk(d, followlinks=False):
                for n in dirs + names:
                    if _is_link(Path(dp) / n):
                        return f"{(Path(dp) / n).relative_to(self.root).as_posix()} is a link"
                out.update(Path(dp) / n for n in names)
                if len(out) > MAX_OP_FILES:
                    return f"more than {MAX_OP_FILES} files"
        for p, v in self.staged.items():
            try:
                p.relative_to(d)
            except ValueError:
                continue
            if v is None:
                out.discard(p)
            else:
                out.add(p)
        return sorted(out)

    def is_dir(self, d: Path) -> bool:
        got = self.files_under(d)
        return isinstance(got, list) and bool(got)


def apply(root: Path, edits: list[Edit]) -> tuple[list[str], list[str]]:
    """Apply into `root` (the sandbox). -> (files changed, problems).

    If there is any problem, nothing is written.
    """
    problems: list[str] = []
    v = _View(root)
    for e in edits:
        src, why = v.target(e.path)
        if src is None:
            problems.append(f"{e.path}: {why}")
            continue

        if e.op == "delete":
            if v.is_file(src):
                v.staged[src] = None
                continue
            under = v.files_under(src)
            if isinstance(under, str):
                problems.append(f"DELETE {e.path}: {under}")
            elif not under:
                problems.append(f"DELETE {e.path}: no such file or folder")
            else:
                for f in under:
                    v.staged[f] = None
            continue

        if e.op in ("move", "copy"):
            dst, why = v.target(e.to)
            label = f"{e.op.upper()} {e.path} -> {e.to}"
            if dst is None:
                problems.append(f"{label}: {e.to}: {why}")
                continue
            if v.is_file(dst) or v.is_dir(dst):
                problems.append(f"{label}: {e.to} already exists")
                continue
            if v.is_file(src):
                v.staged[dst] = v.read(src)
                if e.op == "move":
                    v.staged[src] = None
                continue
            try:
                dst.relative_to(src)
                problems.append(f"{label}: a folder cannot go inside itself")
                continue
            except ValueError:
                pass
            under = v.files_under(src)
            if isinstance(under, str):
                problems.append(f"{label}: {under}")
                continue
            if not under:
                problems.append(f"{label}: no such file or folder")
                continue
            for f in under:
                nf = dst / f.relative_to(src)
                v.staged[nf] = v.read(f)
                if e.op == "move":
                    v.staged[f] = None
            continue

        # SEARCH/REPLACE
        target = src
        raw = v.read(target)
        if raw is not None and b"\x00" in raw[:4096]:
            problems.append(f"{e.path}: a binary file")
            continue
        if raw is not None:
            dec = raw.decode("utf-8", "replace")
            eol = "\r\n" if "\r\n" in dec else "\n"
            text = dec.replace("\r\n", "\n")
        else:
            text, eol = None, "\n"
        if not e.search.strip():
            if text:
                problems.append(f"{e.path}: already exists (an empty SEARCH only creates new files)")
                continue
            new = e.replace + ("\n" if not e.replace.endswith("\n") else "")
            v.staged[target] = new.replace("\n", eol).encode("utf-8")
            continue
        if text is None:
            problems.append(f"{e.path}: no such file")
            continue
        at = _find(text, e.search)
        if at is None:
            n = text.count(e.search)
            problems.append(f"{e.path}: the SEARCH text "
                            + ("matches more than once" if n > 1 else "was not found"))
            continue
        new = text[:at[0]] + e.replace + text[at[1]:]
        v.staged[target] = new.replace("\n", eol).encode("utf-8")

    if problems:
        return [], problems
    changed = []
    gone: list[Path] = []
    for target, data in v.staged.items():
        rel = target.relative_to(v.root).as_posix()
        if data is None:
            if target.is_file():
                target.unlink()
                gone.append(target)
                changed.append(rel)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        changed.append(rel)
    # Folders a DELETE or MOVE emptied: git does not track folders, but an
    # empty one left behind is litter in the copy the next agent reads.
    for p in sorted({g.parent for g in gone}, key=lambda x: len(x.parts), reverse=True):
        while p != v.root and v.root in p.parents:
            try:
                p.rmdir()
            except OSError:
                break
            p = p.parent
    return changed, []
