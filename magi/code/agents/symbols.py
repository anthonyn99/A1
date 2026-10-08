"""The project map (Track V7): what is defined where, for browser units.

A chat unit is shown the FILE INDEX and a few files whole; in a large
project that leaves it guessing where things live, and every guess costs a
NEED round. The map is a symbol outline -- classes, functions, types,
Markdown headings, each with its line -- so it can ask for exactly
`NEED: magi/code/tasks.py:409-520` instead of reading around.

Regexes, not parsers: a map that is right about the top level of every file
in eleven languages beats a perfect one for two. What it finds per file is
capped, the whole map has a share of the composer's budget, and the most
relevant files (the plan's ranking) come first.

Cached per workspace by each file's (mtime, size): the second task on the
same project reads no file it has already outlined unless it changed. The
cache lives in the engine's data folder, never in the workspace.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path

MAX_FILE = 2_000_000        # bytes; bigger is data, not source
MAX_SYMBOLS = 600           # per file, kept in the cache
SHOW_TOP = 60               # shown for each of the most relevant files
SHOW_OTHER = 16             # shown for every other file
TOP_FILES = 6
MAX_SECONDS = 8.0           # outlining a cold, huge project stops here
CACHE_VERSION = 2

_JS = [
    re.compile(r"^[ \t]{0,2}(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?function[ \t]*\*?[ \t]*([A-Za-z_$][\w$]*)", re.M),
    re.compile(r"^[ \t]{0,2}(?:export[ \t]+)?(?:default[ \t]+)?(?:abstract[ \t]+)?class[ \t]+([A-Za-z_$][\w$]*)", re.M),
    re.compile(r"^[ \t]{0,2}(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]*)?(?:function\b|\([^)\n]*\)[ \t]*=>|[A-Za-z_$][\w$]*[ \t]*=>)", re.M),
    re.compile(r"^[ \t]{0,2}(?:export[ \t]+)?(?:interface|type|enum)[ \t]+([A-Za-z_$][\w$]*)", re.M),
]
_PATTERNS: dict[str, list[re.Pattern]] = {
    "py": [re.compile(r"^(?:async[ \t]+)?(?:def|class)[ \t]+([A-Za-z_]\w*)", re.M),
           re.compile(r"^[ \t]{4}(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)", re.M)],
    "js": _JS,
    "go": [re.compile(r"^func[ \t]+(?:\([^)]*\)[ \t]*)?([A-Za-z_]\w*)", re.M),
           re.compile(r"^type[ \t]+([A-Za-z_]\w*)[ \t]+(?:struct|interface)", re.M)],
    "rs": [re.compile(r"^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:async[ \t]+)?(?:fn|struct|enum|trait|mod)[ \t]+([A-Za-z_]\w*)", re.M),
           re.compile(r"^impl(?:<[^>]*>)?[ \t]+([A-Za-z_][\w:<>, ]*?)[ \t]*\{", re.M)],
    "java": [re.compile(r"^[ \t]*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial|data|open)[ \t]+)*(?:class|interface|enum|record|object)[ \t]+([A-Za-z_]\w*)", re.M)],
    "rb": [re.compile(r"^[ \t]*(?:class|module|def)[ \t]+([\w.?!:]+)", re.M)],
    "php": [re.compile(r"^[ \t]*(?:(?:public|private|protected|static|abstract|final)[ \t]+)*(?:function|class|interface|trait)[ \t]+([A-Za-z_]\w*)", re.M)],
    "md": [re.compile(r"^#{1,3}[ \t]+(.{1,80}?)[ \t]*#*$", re.M)],
    "sh": [re.compile(r"^(?:function[ \t]+)?([A-Za-z_][\w-]*)[ \t]*\(\)[ \t]*\{", re.M),
           re.compile(r"^function[ \t]+([A-Za-z_][\w-]*)", re.M | re.I)],
}
_KIND = {
    ".py": "py", ".pyi": "py",
    ".js": "js", ".mjs": "js", ".cjs": "js", ".ts": "js", ".tsx": "js", ".jsx": "js",
    ".html": "js", ".vue": "js", ".svelte": "js",
    ".go": "go", ".rs": "rs",
    ".java": "java", ".kt": "java", ".cs": "java", ".scala": "java", ".swift": "java", ".dart": "java",
    ".rb": "rb", ".php": "php", ".md": "md",
    ".sh": "sh", ".ps1": "sh", ".psm1": "sh",
}


def kind_of(rel: str) -> str:
    return _KIND.get(os.path.splitext(rel)[1].lower(), "")


def outline_text(text: str, kind: str) -> list[tuple[str, int]]:
    """[(name, line)] in file order, at most MAX_SYMBOLS, each once."""
    pats = _PATTERNS.get(kind) or []
    if not pats:
        return []
    starts = [0]
    for m in re.finditer("\n", text):
        starts.append(m.end())

    def line_of(pos: int) -> int:
        lo, hi = 0, len(starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if starts[mid] <= pos:
                lo = mid
            else:
                hi = mid - 1
        return lo + 1

    found: dict[int, str] = {}
    for rx in pats:
        for m in rx.finditer(text):
            ln = line_of(m.start())
            if ln not in found:
                found[ln] = m.group(1).strip()[:60]
    # A Python method is shown under its class: "App.run".
    out: list[tuple[str, int]] = []
    cls = ""
    for ln in sorted(found):
        name = found[ln]
        if kind == "py":
            line = text[starts[ln - 1]:starts[ln] if ln < len(starts) else len(text)]
            if line.startswith(("class ", "async ", "def ")):
                cls = name if line.startswith("class ") else ""
            elif cls:
                name = f"{cls}.{name}"
            else:
                continue          # a nested def in a function: not part of the map
        out.append((name, ln))
        if len(out) >= MAX_SYMBOLS:
            break
    return out


def _cache_file(root: Path) -> Path:
    from ...settings import data_dir
    h = hashlib.sha1(os.path.normcase(str(root.resolve())).encode("utf-8")).hexdigest()[:16]
    d = data_dir() / "code" / "maps"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{h}.json"


def outline(root: Path, files: list[str], bodies: dict[str, str] | None = None,
            cache: Path | None = None) -> dict[str, list[tuple[str, int]]]:
    """{rel: [(name, line)]} for every file with a known kind. `bodies`:
    texts already read (context.plan's scan) -- reused, never re-read."""
    rootr = root.resolve()
    try:
        cf: Path | None = cache or _cache_file(rootr)
    except OSError:
        cf = None
    old: dict = {}
    if cf is not None:
        try:
            old = json.loads(cf.read_text(encoding="utf-8"))
            if not isinstance(old, dict) or old.get("v") != CACHE_VERSION:
                old = {}
        except (OSError, ValueError):
            old = {}
    have = old.get("files") or {}
    new: dict[str, list] = {}
    out: dict[str, list[tuple[str, int]]] = {}
    deadline = time.monotonic() + MAX_SECONDS
    for rel in files:
        k = kind_of(rel)
        if not k:
            continue
        p = rootr / rel
        try:
            st = p.stat()
        except OSError:
            continue
        if st.st_size > MAX_FILE:
            continue
        stamp = [st.st_mtime_ns, st.st_size]
        hit = have.get(rel)
        if hit and hit[0] == stamp:
            syms = [(n, ln) for n, ln in hit[1]]
        else:
            if time.monotonic() > deadline:
                continue
            text = (bodies or {}).get(rel)
            if text is None:
                try:
                    raw = p.read_bytes()
                except OSError:
                    continue
                if b"\x00" in raw[:8192]:
                    continue
                text = raw.decode("utf-8", errors="replace")
            syms = outline_text(text, k)
        new[rel] = [stamp, [[n, ln] for n, ln in syms]]
        if syms:
            out[rel] = syms
    if cf is not None and new != have:
        try:
            tmp = cf.with_suffix(".tmp")
            tmp.write_text(json.dumps({"v": CACHE_VERSION, "files": new}), encoding="utf-8")
            os.replace(tmp, cf)
        except OSError:
            pass
        if cache is None:
            _trim(cf.parent)
    return out


KEEP_MAPS = 40      # workspaces whose maps are kept; the least recently used go


def _trim(folder: Path) -> None:
    """Keep the maps folder small: every folder a task ever ran in gets a
    map (scratch copies included), so only the KEEP_MAPS most recent stay."""
    try:
        maps = sorted(folder.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return
    for p in maps[KEEP_MAPS:]:
        try:
            p.unlink()
        except OSError:
            pass


def pick(syms: list[tuple[str, int]], terms: list[str], k: int) -> tuple[list, int]:
    """At most `k` of a file's symbols: those naming a task word first, then
    the rest in file order. -> (chosen, in file order; how many left out)."""
    if len(syms) <= k:
        return list(syms), 0
    low = [t.lower() for t in terms if len(t) >= 3]
    hit = [s for s in syms if any(t in s[0].lower() for t in low)][:k]
    rest = [s for s in syms if s not in hit][:k - len(hit)]
    chosen = sorted(hit + rest, key=lambda s: s[1])
    return chosen, len(syms) - len(chosen)


def render(syms: dict[str, list[tuple[str, int]]], first: list[str], limit: int,
           terms: list[str] | None = None) -> str:
    """The map as lines, `first` (the plan's ranking) leading, within `limit`
    characters; says how many files did not fit. In a file with many
    symbols, the ones naming the task's words are the ones shown."""
    order = [f for f in first if f in syms] + sorted(f for f in syms if f not in set(first))
    lines: list[str] = []
    used = 0
    for i, rel in enumerate(order):
        shown, more = pick(syms[rel], terms or [], SHOW_TOP if i < TOP_FILES else SHOW_OTHER)
        row = (f"{rel}: " + ", ".join(f"{n}@{ln}" for n, ln in shown)
               + (f" (+{more} more)" if more else ""))
        if used + len(row) + 1 > limit:
            rest = len(order) - i
            lines.append(f"… {rest} more file{'s' if rest != 1 else ''} not shown "
                         "(ask NEED: path for one)")
            break
        lines.append(row)
        used += len(row) + 1
    return "\n".join(lines)
