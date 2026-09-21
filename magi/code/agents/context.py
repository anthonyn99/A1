"""Gathering a workspace's relevant context for an agent that cannot read it.

A CLI agent reads the files it needs itself. A browser unit cannot -- it is a
chat window -- so MAGI does the reading for it and hands over what matters:
the shape of the project, the files the task names, and the lines that match
what the task is about.

Three rules, all enforced here rather than trusted to a caller:

  * **Contained.** Every path is resolved and must sit inside the workspace
    root. A task that names "../../secrets.txt" gets nothing.
  * **No secrets.** Environment files, keys and credential stores are never
    read, whatever the task asks for. The unit on the other end is a chat
    session on a third-party service; what it is shown has left this machine.
  * **Bounded.** A hard byte budget. A browser composer has limits, and a
    prompt that is mostly irrelevant file contents gets a worse answer than a
    short one with the right three files in it.
"""

from __future__ import annotations

import re
from pathlib import Path

from ... import proc
from .. import workspace as W

BUDGET = 48_000          # bytes of context, total
PER_FILE = 14_000        # no single file may eat the whole budget
MAX_FILES = 8

_SECRET_NAMES = re.compile(
    r"(^|[\\/])(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*|\.npmrc|\.pypirc|"
    r"credentials(\.json)?|\.credentials\.json|auth\.json|secrets?\.(json|ya?ml|toml)|"
    r".*\.p12|.*\.pfx|\.git-credentials|token\.txt)$", re.I)
_TEXT_EXT = {
    ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".css", ".scss",
    ".json", ".md", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".txt", ".sh", ".ps1",
    ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".c", ".h", ".cpp", ".hpp",
    ".sql", ".xml", ".vue", ".svelte", ".lua", ".swift", ".dart",
}
_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]{3,}")
_PATHISH = re.compile(r"[\w./\\-]+\.[A-Za-z0-9]{1,6}")
_STOP = {
    "what", "does", "this", "that", "with", "from", "have", "where", "which", "when",
    "file", "files", "code", "function", "explain", "about", "into", "there", "their",
    "should", "would", "could", "please", "make", "look", "show", "find", "work",
    "project", "change", "add", "fix", "the", "and", "for", "how", "why",
}


def is_secret(p: Path) -> bool:
    return bool(_SECRET_NAMES.search(p.name)) or any(
        part in {".ssh", ".gnupg", ".aws", ".azure"} for part in p.parts)


def contained(root: Path, p: Path) -> Path | None:
    """`p` resolved, if and only if it lies inside `root`. Symlinks are
    followed before the check, so a link pointing out is refused."""
    try:
        rp = (root / p).resolve() if not p.is_absolute() else p.resolve()
    except (OSError, RuntimeError):
        return None
    try:
        rp.relative_to(root.resolve())
    except ValueError:
        return None
    return rp


def _read(p: Path, limit: int) -> str | None:
    if p.suffix.lower() not in _TEXT_EXT or is_secret(p):
        return None
    try:
        raw = p.read_bytes()[: limit + 1]
    except OSError:
        return None
    if b"\x00" in raw[:4096]:
        return None          # binary
    text = raw.decode("utf-8", errors="replace")
    if len(raw) > limit:
        text = text[:limit] + "\n… [truncated]"
    return text


def named_files(root: Path, prompt: str) -> list[Path]:
    """Files the task mentions by name or path, resolved inside the root."""
    out: list[Path] = []
    for tok in _PATHISH.findall(prompt):
        tok = tok.strip("`'\".,;:()[]")
        cand = contained(root, Path(tok))
        if cand and cand.is_file() and not is_secret(cand):
            out.append(cand)
            continue
        # A bare filename: find it, but only if it is unambiguous.
        if "/" not in tok and "\\" not in tok:
            hits = [h for h in _git_ls(root, tok) if h.name == tok]
            if len(hits) == 1:
                out.append(hits[0])
    seen, uniq = set(), []
    for p in out:
        if p not in seen:
            seen.add(p)
            uniq.append(p)
    return uniq[:MAX_FILES]


def _git_ls(root: Path, name: str) -> list[Path]:
    try:
        r = proc.run(["git", "-C", str(root), "ls-files", f"*{name}"],
                     capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10)
        if r.returncode != 0:
            return []
        return [c for c in (contained(root, Path(x)) for x in r.stdout.splitlines()[:50]) if c]
    except Exception:
        return []


def keywords(prompt: str) -> list[str]:
    words = []
    for w in _WORD.findall(prompt):
        lw = w.lower()
        if lw in _STOP or lw in words:
            continue
        words.append(w)
    # Identifiers first: a camelCase or snake_case word is far more likely to
    # be the thing the task is about than an English one.
    words.sort(key=lambda w: (not (("_" in w) or (w[:1].islower() and any(c.isupper() for c in w)))))
    return words[:6]


def grep_hits(root: Path, words: list[str], cap: int = 40) -> list[str]:
    """`git grep` for the task's key words: fast, and it respects .gitignore."""
    if not words:
        return []
    args = ["git", "-C", str(root), "grep", "-n", "-I", "--max-count=4"]
    for w in words:
        args += ["-e", w]
    try:
        r = proc.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15)
    except Exception:
        return []
    out = []
    for line in (r.stdout or "").splitlines():
        path = line.split(":", 1)[0]
        if is_secret(Path(path)):
            continue
        out.append(line[:240])
        if len(out) >= cap:
            break
    return out


def _tree_lines(tree: list[dict], depth: int = 0, out: list[str] | None = None,
                limit: int = 180) -> list[str]:
    out = out if out is not None else []
    for n in tree:
        if len(out) >= limit:
            break
        out.append("  " * depth + n["n"] + ("/" if n.get("d") else ""))
        if n.get("d") and n.get("c") and depth < 2:
            _tree_lines(n["c"], depth + 1, out, limit)
    return out


def gather(root: Path, prompt: str) -> str:
    """The context block handed to a browser agent. Never over BUDGET bytes."""
    parts: list[str] = []
    used = 0

    def add(s: str) -> bool:
        nonlocal used
        if used + len(s) > BUDGET:
            return False
        parts.append(s)
        used += len(s)
        return True

    sk = W.skeleton(root, depth=3)
    git = sk.get("git") or {}
    head = f"PROJECT: {root.name}\nSTACK: {', '.join(sk.get('stack') or []) or 'unknown'}"
    if git.get("repo"):
        head += f"\nGIT: branch {git.get('branch')} @ {git.get('head')}"
    add(head + "\n\nLAYOUT (top levels):\n" + "\n".join(_tree_lines(sk.get("tree") or [])) + "\n")

    for p in named_files(root, prompt):
        body = _read(p, PER_FILE)
        if body is None:
            continue
        rel = p.relative_to(root.resolve()).as_posix()
        if not add(f"\n===== FILE: {rel} =====\n{body}\n"):
            break

    hits = grep_hits(root, keywords(prompt))
    if hits:
        add("\nMATCHING LINES (git grep):\n" + "\n".join(hits) + "\n")
    return "".join(parts)
