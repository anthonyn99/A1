"""The workspace, measured: every file with its exact size and line count.

Found live, 2026-09-29: asked to "rank the A1 programs by file size", Claude
(Read mode) could not. Its tools are Read, Glob and Grep -- none reports a
size -- so it fell back to counting lines, its Glob stopped at 250 of 417
matches, it guessed at code extensions and so skipped every .html (which is
what an A1 "program" IS), and it ended by asking for a PowerShell command to
be run and pasted back. Read mode deliberately has no shell, and giving it one
to answer "how big is it" would be the wrong trade.

So MAGI measures instead, and hands the agent the numbers. When a task is
about sizes, lengths, the largest/smallest, ranking or comparing files, this
block rides with the prompt (CLI agents) or the gathered context (browser
agents). It is exact, it costs no agent turns, and it is the same for every
agent in the chain.

What it lists: git's own file list -- tracked files plus untracked ones that
are not ignored -- so node_modules, .venv, build output and MAGI's browser
profiles (the "54,590 files" the agent tripped over) never appear. Secret-
looking files (.env, keys) are left out, as everywhere else in Code Mode.
"""

from __future__ import annotations

import collections
import os
import re
from pathlib import Path

from ... import proc
from .context import is_secret

# Asked about how big things are, or to order/compare them.
_WANTS = re.compile(
    r"\b(size[sd]?|sizes|bytes?|kb|mb|gb|kilobytes?|megabytes?|how (big|large|long|many (files|lines))|"
    r"large(st|r)?|bigg(est|er)|small(est|er)|heav(iest|ier)|lines? of code|loc|line counts?|"
    r"longest|shortest|rank(ed|ing|s)?|sort(ed)? by|compare|comparison|footprint|weigh[st]?)\b",
    re.I)

MAX_LISTED = 150         # largest files named individually
MAX_ROOT = 80            # files at the top level, all named
MAX_BYTES = 22_000       # the general block, so it can never crowd out the task
# A type the task NAMES ("rank the .html files") is listed in full, ahead of
# everything else, with its own allowance: found live, the general list was
# cut at 15 of A1's 39 .html files and the agent could only rank those.
MAX_TYPE_ROWS = 400
MAX_TYPE_BYTES = 40_000

# Words people use for a file type, to the extensions they mean.
_TYPE_WORDS = {
    "html": (".html", ".htm"), "python": (".py",), "py": (".py",),
    "javascript": (".js", ".mjs", ".cjs"), "js": (".js", ".mjs", ".cjs"),
    "typescript": (".ts", ".tsx"), "ts": (".ts", ".tsx"), "rust": (".rs",),
    "css": (".css",), "json": (".json",), "markdown": (".md",), "md": (".md",),
    "powershell": (".ps1", ".psm1"), "yaml": (".yaml", ".yml"), "go": (".go",),
    "java": (".java",), "csharp": (".cs",), "shell": (".sh",), "toml": (".toml",),
}
_EXT = re.compile(r"(?<![\w/\\])\.([a-z0-9]{1,6})\b", re.I)
_TYPE_PHRASE = re.compile(r"\b(" + "|".join(_TYPE_WORDS) + r")\s+(files?|pages?|scripts?|programs?|modules?)\b",
                          re.I)
_BINARY_SNIFF = 8192
_LINE_READ_CAP = 64 * 1024 * 1024   # a file past this is not read for lines


def wants(prompt: str) -> bool:
    return bool(_WANTS.search(prompt or ""))


def named_types(prompt: str) -> list[str]:
    """Extensions the task names: ".html", "html files", "python scripts"."""
    out: list[str] = []
    for m in _EXT.finditer(prompt or ""):
        e = "." + m.group(1).lower()
        if e not in out:
            out.append(e)
    for m in _TYPE_PHRASE.finditer(prompt or ""):
        for e in _TYPE_WORDS[m.group(1).lower()]:
            if e not in out:
                out.append(e)
    return out


def _files(root: Path) -> list[str]:
    """git ls-files, tracked + untracked-not-ignored, relative to root."""
    try:
        r = proc.run(["git", "-C", str(root), "ls-files", "-z", "--cached", "--others",
                      "--exclude-standard", "--deduplicate"],
                     capture_output=True, timeout=60)
    except Exception:
        return []
    if r.returncode != 0:
        return []
    names = [n for n in r.stdout.decode("utf-8", "replace").split("\0") if n]
    return sorted(set(names))


def _lines(p: Path, size: int) -> int | None:
    """Line count for a text file; None for binary (or too big to read)."""
    if size > _LINE_READ_CAP:
        return None
    try:
        with open(p, "rb") as f:
            head = f.read(_BINARY_SNIFF)
            if b"\0" in head:
                return None
            n = head.count(b"\n")
            last = head[-1:] if head else b""
            for chunk in iter(lambda: f.read(1 << 20), b""):
                n += chunk.count(b"\n")
                last = chunk[-1:]
            return n + (1 if last and last != b"\n" else 0)
    except OSError:
        return None


def _human(n: int) -> str:
    for unit, div in (("GB", 1 << 30), ("MB", 1 << 20), ("KB", 1 << 10)):
        if n >= div:
            return f"{n / div:.1f} {unit}"
    return f"{n} B"


def measure(root: Path) -> list[dict]:
    """[{path, bytes, lines}] for every listed file that exists, largest first."""
    out = []
    for rel in _files(root):
        if is_secret(Path(rel)):
            continue
        p = root / rel
        try:
            st = p.stat()
        except OSError:
            continue           # listed by git but deleted on disk
        if not os.path.isfile(p):
            continue
        out.append({"path": rel, "bytes": st.st_size, "lines": _lines(p, st.st_size)})
    out.sort(key=lambda f: (-f["bytes"], f["path"]))
    return out


def block(root: Path, files: list[dict] | None = None, prompt: str = "") -> str:
    """The inventory as prompt text. "" when git has nothing to list."""
    files = measure(root) if files is None else files
    if not files:
        return ""
    typed = _typed_section(files, named_types(prompt))
    general = _general(files)
    return typed + "\n\n" + general if typed else general


def _row(f: dict) -> str:
    lines = f"{f['lines']:>7,} lines" if f["lines"] is not None else "    binary  "
    return f"{f['bytes']:>12,} B  {_human(f['bytes']):>9}  {lines}  {f['path']}"


def _typed_section(files: list[dict], exts: list[str]) -> str:
    """Every file of the types the task names, complete, largest first."""
    if not exts:
        return ""
    hits = [f for f in files if os.path.splitext(f["path"])[1].lower() in exts]
    label = " / ".join(exts)
    if not hits:
        return f"FILES OF THE TYPE YOU ASKED ABOUT ({label}): none in this workspace."
    total = sum(f["bytes"] for f in hits)
    head = (f"EVERY {label} FILE -- the type this task names, ALL {len(hits):,} of them, complete "
            f"and largest first ({total:,} bytes, {_human(total)} in all). Rank from this list.")
    rows, used = [], len(head)
    for f in hits[:MAX_TYPE_ROWS]:
        r = _row(f)
        if used + len(r) + 1 > MAX_TYPE_BYTES:
            rows.append(f"  ... cut at {len(rows)} of {len(hits)} to keep the prompt small")
            break
        rows.append(r)
        used += len(r) + 1
    else:
        if len(hits) > MAX_TYPE_ROWS:
            rows.append(f"  ... cut at {MAX_TYPE_ROWS} of {len(hits)}")
    return head + "\n" + "\n".join(rows)


def _general(files: list[dict]) -> str:
    total = sum(f["bytes"] for f in files)
    folders: dict[str, list[int]] = collections.defaultdict(lambda: [0, 0])
    exts: dict[str, list[int]] = collections.defaultdict(lambda: [0, 0])
    root_files = []
    for f in files:
        top, sep, _ = f["path"].partition("/")
        if sep:
            folders[top + "/"][0] += f["bytes"]
            folders[top + "/"][1] += 1
        else:
            root_files.append(f)
        ext = os.path.splitext(f["path"])[1].lower() or "(none)"
        exts[ext][0] += f["bytes"]
        exts[ext][1] += 1
    row = _row

    out = [
        "WORKSPACE INVENTORY -- measured by MAGI just now, not estimated. Exact bytes on disk "
        "and line counts for every file git lists here (tracked, plus untracked files that "
        "are not ignored). Ignored folders -- node_modules, virtualenvs, build output, "
        "browser profiles -- and secret files are not included. Use these numbers for any "
        "question about size, length or ranking; there is no need to measure again.",
        f"\nTOTAL: {len(files):,} files, {total:,} bytes ({_human(total)})",
        "\nFILES AT THE TOP LEVEL (largest first) -- in a project of standalone pages or "
        "scripts, these are usually its programs:",
    ]
    out += [row(f) for f in root_files[:MAX_ROOT]]
    if len(root_files) > MAX_ROOT:
        out.append(f"  ... and {len(root_files) - MAX_ROOT} more at the top level")
    out.append("\nBY FOLDER (top level; bytes, files):")
    for name, (b, n) in sorted(folders.items(), key=lambda kv: -kv[1][0]):
        out.append(f"{b:>12,} B  {_human(b):>9}  {n:>6,} files  {name}")
    out.append("\nBY FILE TYPE (bytes, files):")
    for ext, (b, n) in sorted(exts.items(), key=lambda kv: -kv[1][0])[:25]:
        out.append(f"{b:>12,} B  {_human(b):>9}  {n:>6,} files  {ext}")
    out.append(f"\nLARGEST FILES (top {min(MAX_LISTED, len(files))} of {len(files):,}):")
    head = "\n".join(out)
    rows = []
    used = len(head)
    for f in files[:MAX_LISTED]:
        r = row(f)
        if used + len(r) + 1 > MAX_BYTES:
            rows.append(f"  ... list cut at {len(rows)} files to keep the prompt small")
            break
        rows.append(r)
        used += len(r) + 1
    return head + "\n" + "\n".join(rows)
