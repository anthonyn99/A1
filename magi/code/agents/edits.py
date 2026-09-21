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

All or nothing: every block is checked -- path contained and allowed, SEARCH
found exactly once -- before any file is written, so a reply with one bad block
does not leave a half-edited sandbox for the next agent to inherit.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .. import security
from . import context

_FILE = re.compile(r"^[\s>*_`#-]*FILE:\s*`?([^`*\n]+?)`?[\s*_]*$", re.I)
_S = re.compile(r"^\s*<{5,9}\s*SEARCH\s*$")
_M = re.compile(r"^\s*={5,9}\s*$")
_R = re.compile(r"^\s*>{5,9}\s*REPLACE\s*$")

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
    "Rules: always inside a code block. SEARCH must match the file exactly and only once -- include enough "
    "surrounding lines to make it unique. Use an empty SEARCH to create a new "
    "file. Paths are relative to the project folder. Only edit files you were "
    "shown, or create new ones. After the blocks, add a short summary of what "
    "you changed and why.")


@dataclass
class Edit:
    path: str
    search: str
    replace: str


def parse(text: str) -> list[Edit]:
    out: list[Edit] = []
    path = ""
    lines = (text or "").replace("\r\n", "\n").split("\n")
    i = 0
    while i < len(lines):
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


def apply(root: Path, edits: list[Edit]) -> tuple[list[str], list[str]]:
    """Apply into `root` (the sandbox). -> (files changed, problems).

    If there is any problem, nothing is written.
    """
    problems: list[str] = []
    staged: dict[Path, tuple[str, str]] = {}      # path -> (new LF text, eol)
    for e in edits:
        rel = e.path.replace("\\", "/")
        if rel.startswith("./"):
            rel = rel[2:]
        why = security.check_path(rel, root=root)
        if why:
            problems.append(f"{e.path}: {why}")
            continue
        target = context.contained(root, Path(rel))
        if target is None:
            problems.append(f"{e.path}: outside the project")
            continue
        if target in staged:
            text, eol = staged[target]
        elif target.exists():
            raw = target.read_bytes()
            if b"\x00" in raw[:4096]:
                problems.append(f"{e.path}: a binary file")
                continue
            dec = raw.decode("utf-8", "replace")
            eol = "\r\n" if "\r\n" in dec else "\n"
            text = dec.replace("\r\n", "\n")
        else:
            text, eol = None, "\n"
        if not e.search.strip():
            if text:
                problems.append(f"{e.path}: already exists (an empty SEARCH only creates new files)")
                continue
            staged[target] = (e.replace + ("\n" if not e.replace.endswith("\n") else ""), eol)
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
        staged[target] = (text[:at[0]] + e.replace + text[at[1]:], eol)

    if problems:
        return [], problems
    changed = []
    for target, (text, eol) in staged.items():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(text.replace("\n", eol).encode("utf-8"))
        changed.append(target.relative_to(root.resolve()).as_posix())
    return changed, []
