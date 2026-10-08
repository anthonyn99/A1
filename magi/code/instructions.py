"""Project instructions (Track W1): CLAUDE.md and its kin, for every agent.

Claude Code in VS Code reads a project's CLAUDE.md files and follows them.
MAGI's Claude runs `--restricted` (no settings, hooks or memory files from the
repository -- A1's Stop hook must never fire from an agent), and Codex runs
`--ignore-rules`, so neither read them. MAGI reads them instead, the way
Claude Code does, and hands the text to EVERY agent -- Claude, Codex and the
browser units -- as PROJECT INSTRUCTIONS. Verified offline 2026-10-08 that
MAGI's Claude did not load CLAUDE.md itself, so nothing is said twice.

What is read, from the repository's top folder down to the workspace folder
(a parent's rules first, the nearest last -- nearer ones refine):

    CLAUDE.md   .claude/CLAUDE.md   CLAUDE.local.md   AGENTS.md

`@path` imports (Claude Code's syntax: `@docs/rules.md` on its own or in a
line) are followed two levels deep, only to files inside the repository, and
never to secrets. The whole text is capped; what is left out is said.
Read from the REAL folder at the start of each task; never cached, never
synced, never written anywhere.
"""

from __future__ import annotations

import re
from pathlib import Path

NAMES = ("CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md", "AGENTS.md")
MAX_CHARS = 24_000          # all of it, for a CLI agent
UNIT_CHARS = 10_000         # a browser unit's share of its composer
MAX_FILE = 200_000
IMPORT_DEPTH = 2
_IMPORT = re.compile(r"(?:^|(?<=\s))@((?:[\w.-]+/)*[\w.-]+\.(?:md|txt|markdown))\b", re.M)


def _inside(top: Path, p: Path) -> bool:
    try:
        p.resolve().relative_to(top.resolve())
        return True
    except (ValueError, OSError):
        return False


def _read(p: Path) -> str | None:
    try:
        if not p.is_file() or p.stat().st_size > MAX_FILE:
            return None
        raw = p.read_bytes()
    except OSError:
        return None
    if b"\x00" in raw[:4096]:
        return None
    return raw.decode("utf-8", "replace").strip()


def _expand(text: str, here: Path, top: Path, seen: set[Path], depth: int) -> str:
    """`text` with each @import that resolves inside `top` appended after it."""
    if depth <= 0:
        return text
    from .agents import context
    extra: list[str] = []
    for m in _IMPORT.finditer(text):
        rel = m.group(1)
        p = (here / rel) if not rel.startswith("/") else None
        if p is None or not _inside(top, p) or context.is_secret(p):
            continue
        rp = p.resolve()
        if rp in seen:
            continue
        body = _read(p)
        if body is None:
            continue
        seen.add(rp)
        body = _expand(body, p.parent, top, seen, depth - 1)
        extra.append(f"----- imported: {p.resolve().relative_to(top.resolve()).as_posix()} -----\n{body}")
    return text + ("\n\n" + "\n\n".join(extra) if extra else "")


def load(root: Path, top: Path | None = None, limit: int = MAX_CHARS) -> tuple[str, list[str]]:
    """(the instructions as one block of text, the files they came from).
    `top`: the repository's top folder (default: `root`). ("", []) if none."""
    root = Path(root)
    top = Path(top) if top else root
    if not _inside(top, root):
        top = root
    dirs: list[Path] = []
    d = root.resolve()
    tr = top.resolve()
    while True:
        dirs.append(d)
        if d == tr or d.parent == d:
            break
        d = d.parent
    dirs.reverse()
    parts: list[str] = []
    files: list[str] = []
    seen: set[Path] = set()
    bodies: set[str] = set()
    for d in dirs:
        for name in NAMES:
            p = d / name
            rp = p.resolve()
            if rp in seen:
                continue
            body = _read(p)
            if not body or body in bodies:
                continue
            seen.add(rp)
            bodies.add(body)
            rel = rp.relative_to(tr).as_posix() if _inside(tr, rp) else p.name
            files.append(rel)
            parts.append(f"===== {rel} =====\n" + _expand(body, p.parent, tr, seen, IMPORT_DEPTH))
    text = "\n\n".join(parts)
    if len(text) > limit:
        text = text[:limit].rsplit("\n", 1)[0] + (
            f"\n[... the rest of the project instructions ({len(text) - limit} more characters) "
            "did not fit; ask for the file by name if you need it.]")
    return text, files


def block(text: str) -> str:
    """How every agent is given them."""
    if not text:
        return ""
    return ("PROJECT INSTRUCTIONS (the project owner's own notes for anyone working on this "
            "project, from its CLAUDE.md / AGENTS.md files; follow them, except where they "
            "conflict with how this session works -- the private copy, the approval, what you "
            "can run -- which always wins):\n<<<\n" + text + "\n>>>")
