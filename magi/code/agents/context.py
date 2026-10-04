"""Gathering a workspace for an agent that cannot read it.

A CLI agent reads the files it needs itself. A browser unit cannot -- it is a
chat window -- so MAGI does the reading for it. What it is given is meant to
add up to the same access a CLI has, within what a chat window can take:

  * **Every file's name.** The FILE INDEX lists the whole workspace, so the
    unit never has to guess whether a file exists. A tree cut at a line count
    was the old way, and it stopped alphabetically before V1/ -- the unit
    reported, correctly, that StudyOS was not in what it had been shown.
  * **The relevant files whole.** Files are ranked by the task's RARE words,
    weighted by how few files contain them, so "under", "exactly" and
    "forward" (in a third of the repo) weigh nothing and "StudyOS" weighs a
    lot. The top files are uploaded as files (browser.py), never cut.
  * **Anything else on request.** `NEED: path`, `NEED: path:400-800` and
    `NEED: dir/` are resolved here (resolve_request) and sent next round.

When a file has to be pasted rather than uploaded, it is pasted in numbered
pieces of whole lines, each saying how to ask for the next -- never cut
silently. A file the unit reasons about as though whole when its end is
missing is worse than one it knows it has not seen.

Three rules, all enforced here rather than trusted to a caller:

  * **Contained.** Every path is resolved and must sit inside the workspace
    root. A task that names "../../secrets.txt" gets nothing.
  * **No secrets.** Environment files, keys and credential stores are never
    read or listed, whatever the task asks for. The unit on the other end is a
    chat session on a third-party service; what it is shown has left this
    machine.
  * **Bounded.** Pasted text has a hard byte budget (a composer has limits);
    uploads have a file count and a byte total (browser.py).
"""

from __future__ import annotations

import math
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

from ... import proc
from .. import workspace as W

BUDGET = 48_000          # default bytes of pasted context, total
MAX_FILES = 8            # files a task names, taken at most
INDEX_SHARE = 0.30       # of a paste budget, the most the index may take
MAX_READ = 2_000_000     # a "text" file bigger than this is data, not source
SCAN_LIMIT = 1_000_000   # files bigger than this are not scanned for ranking
COMMON = 0.15            # a word in more than this share of files is noise
MAX_TERMS = 12
RANKED = 40              # files kept in a plan's ranking
LINES_PER_FILE = 3

_SECRET_NAMES = re.compile(
    r"(^|[\\/])(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*|\.npmrc|\.pypirc|"
    r"credentials(\.json)?|\.credentials\.json|auth\.json|secrets?\.(json|ya?ml|toml)|"
    r".*\.p12|.*\.pfx|\.git-credentials|token\.txt)$", re.I)
_TEXT_EXT = {
    ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".css", ".scss",
    ".json", ".md", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".txt", ".sh", ".ps1",
    ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".c", ".h", ".cpp", ".hpp",
    ".sql", ".xml", ".vue", ".svelte", ".lua", ".swift", ".dart",
    ".jsonc", ".jsonl", ".csv", ".bat", ".cmd", ".svg", ".graphql", ".proto",
    ".conf", ".properties", ".gradle", ".tf", ".psm1", ".pyi", ".less", ".sass",
}
_TEXT_NAMES = {"dockerfile", "makefile", ".gitignore", ".gitattributes",
               ".editorconfig", "readme", "license", "procfile"}
_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]{3,}")
_PATHISH = re.compile(r"[\w./\\-]+\.[A-Za-z0-9]{1,6}")
# A cheap first filter; rarity (COMMON) does the real work.
_STOP = {
    "what", "does", "this", "that", "with", "from", "have", "where", "which", "when",
    "file", "files", "code", "function", "explain", "about", "into", "there", "their",
    "should", "would", "could", "please", "make", "look", "show", "find", "work",
    "project", "change", "add", "fix", "the", "and", "for", "how", "why",
    "tell", "exactly", "details", "detail", "forward", "see", "sees", "seen", "able",
    "currently", "certain", "despite", "present", "ensure", "need", "needs", "also",
    "them", "they", "these", "those", "were", "been", "being", "will", "just", "only",
    "some", "more", "most", "very", "than", "then", "your", "you're", "want", "like",
    "issue", "problem", "thing", "things", "something", "anything", "everything",
    "identify", "support", "verify", "correctly", "relevant", "included", "under",
}
_NEED = re.compile(r"^\s*(?:[-*]\s*)?`?NEED:\s*`?(.+?)`?\s*$", re.I | re.M)
# Track V: "FIND: text" (or "FIND: /regex/") searches every file, like a CLI
# agent's Grep. Answered as path:line: text, capped.
_FINDLINE = re.compile(r"^\s*(?:[-*]\s*)?`?FIND:\s*(.+?)\s*$", re.I | re.M)
FIND_PREFIX = "FIND:"
FIND_MAX_HITS = 80
FIND_MAX_CHARS = 12_000
FIND_MAX_S = 20.0          # a search never holds the task longer than this
# A regex from an agent must not be able to hang a search: Python's re has
# no timeout, and nested repetition -- "(a+)+$" -- backtracks exponentially
# on one long line. Refused, and every line is searched only so far.
_NESTED_REPEAT = re.compile(r"\((?:\\.|[^()\\])*[*+}](?:\\.|[^()\\])*\)\s*[*+{]")
SEARCH_LINE_MAX = 2000

_RANGE = re.compile(r"^(.+?):(\d+)\s*-\s*(\d+)$")


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


def _texty(p: Path) -> bool:
    return p.suffix.lower() in _TEXT_EXT or p.name.lower() in _TEXT_NAMES


def _rel(root: Path, p: Path) -> str:
    return p.relative_to(root.resolve()).as_posix()


# ── reading ────────────────────────────────────────────────────────────────

def read_whole(root: Path, p: Path) -> str | None:
    """The whole file, never truncated -- or None if it may not or cannot be
    read as text (outside the root, a secret, binary, or huge)."""
    rp = contained(root, p)
    if rp is None or not rp.is_file() or is_secret(rp) or not _texty(rp):
        return None
    try:
        if rp.stat().st_size > MAX_READ:
            return None
        raw = rp.read_bytes()
    except OSError:
        return None
    if b"\x00" in raw[:8192]:
        return None          # binary
    return raw.decode("utf-8", errors="replace")


def pieces(text: str, max_chars: int) -> list[tuple[int, int, str]]:
    """`text` as consecutive chunks of whole lines, (first, last, chunk) with
    1-based line numbers. Every line is in exactly one chunk; a single line
    longer than `max_chars` is a chunk of its own rather than being split."""
    out: list[tuple[int, int, str]] = []
    buf: list[str] = []
    size, start = 0, 1
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines, 1):
        if buf and size + len(line) > max_chars:
            out.append((start, i - 1, "".join(buf)))
            buf, size, start = [], 0, i
        buf.append(line)
        size += len(line)
    if buf:
        out.append((start, len(lines), "".join(buf)))
    return out


def line_count(text: str) -> int:
    return len(text.splitlines())


# ── the file index ─────────────────────────────────────────────────────────

def listing(root: Path) -> list[str]:
    """Every file in the workspace as a relative posix path, secrets left out.
    git's view when it is a repository (tracked, plus new files not yet added,
    minus what .gitignore excludes); a walk otherwise."""
    rootr = root.resolve()
    out: list[str] = []
    try:
        r = proc.run(["git", "-C", str(rootr), "ls-files", "--cached", "--others",
                      "--exclude-standard", "-z"],
                     capture_output=True, timeout=20)
        if r.returncode == 0:
            out = [x for x in r.stdout.decode("utf-8", "replace").split("\0") if x]
    except Exception:
        out = []
    if not out:
        for dirpath, dirs, names in os.walk(rootr):
            dirs[:] = sorted(d for d in dirs if d not in W._SKIP_DIRS)
            for n in sorted(names):
                out.append((Path(dirpath) / n).relative_to(rootr).as_posix())
            if len(out) > 20_000:
                break
    seen, uniq = set(), []
    for x in out:
        if x in seen or is_secret(Path(x)):
            continue
        seen.add(x)
        uniq.append(x)
    return sorted(uniq)


def _render_index(files: list[str], depth: int) -> str:
    """One line per directory. Directories deeper than `depth` are folded into
    their ancestor's line as `name/ (N files)`."""
    groups: dict[str, list[str]] = {}
    folded: dict[str, dict[str, int]] = {}
    for f in files:
        parts = f.split("/")
        d = parts[:-1]
        if len(d) <= depth:
            groups.setdefault("/".join(d), []).append(parts[-1])
        else:
            host = "/".join(d[:depth])
            sub = d[depth]
            folded.setdefault(host, {}).setdefault(sub, 0)
            folded[host][sub] += 1
    lines = []
    for host in sorted(set(groups) | set(folded)):
        items = list(groups.get(host, []))
        items += [f"{s}/ ({n} files)" for s, n in sorted(folded.get(host, {}).items())]
        lines.append(f"{host + '/' if host else './'}: " + "  ".join(items))
    return "\n".join(lines)


def file_index(files: list[str], limit: int) -> str:
    """The deepest rendering that fits in `limit` characters."""
    deepest = max((f.count("/") for f in files), default=0)
    for depth in range(deepest, -1, -1):
        text = _render_index(files, depth)
        if len(text) <= limit or depth == 0:
            if depth < deepest:
                text += ("\n(folders shown as `name/ (N files)` are folded to fit; "
                         "ask `NEED: path/to/folder/` to list one)")
            return text[:limit] if len(text) > limit else text
    return ""


# ── ranking ────────────────────────────────────────────────────────────────

def named_files(root: Path, prompt: str, files: list[str] | None = None) -> list[Path]:
    """Files the task mentions by name or path, resolved inside the root."""
    files = files if files is not None else listing(root)
    out: list[Path] = []
    for tok in _PATHISH.findall(prompt):
        tok = tok.strip("`'\".,;:()[]")
        cand = contained(root, Path(tok))
        if cand and cand.is_file() and not is_secret(cand):
            out.append(cand)
            continue
        # A bare filename: find it, but only if it is unambiguous.
        if "/" not in tok and "\\" not in tok:
            hits = [f for f in files if f.rsplit("/", 1)[-1] == tok]
            if len(hits) == 1:
                c = contained(root, Path(hits[0]))
                if c:
                    out.append(c)
    seen, uniq = set(), []
    for p in out:
        if p not in seen:
            seen.add(p)
            uniq.append(p)
    return uniq[:MAX_FILES]


def candidates(text: str) -> list[str]:
    """Words worth searching for, identifiers first, at most 40."""
    words: list[str] = []
    low: set[str] = set()
    for w in _WORD.findall(text):
        lw = w.lower()
        if lw in _STOP or lw in low:
            continue
        low.add(lw)
        words.append(w)
    words.sort(key=lambda w: not ("_" in w or any(c.isupper() for c in w[1:])))
    return words[:40]


def keywords(prompt: str) -> list[str]:
    return candidates(prompt)[:MAX_TERMS]


@dataclass
class Plan:
    """What a browser unit should be shown, decided once per task."""
    head: str
    files: list[str]                       # every file, for the index
    ranked: list[Path]                     # most relevant first
    terms: list[tuple[str, float]] = field(default_factory=list)
    lines: dict[str, list[str]] = field(default_factory=dict)   # rel -> hits


def _scan(root: Path, files: list[str]) -> dict[str, str]:
    rootr = root.resolve()
    out = {}
    for f in files:
        p = rootr / f
        if not _texty(p):
            continue
        try:
            if p.stat().st_size > SCAN_LIMIT:
                continue
            raw = p.read_bytes()
        except OSError:
            continue
        if b"\x00" in raw[:8192]:
            continue
        out[f] = raw.decode("utf-8", errors="replace")
    return out


def plan(root: Path, text: str) -> Plan:
    rootr = root.resolve()
    git = W.git_info(rootr)
    head = f"PROJECT: {rootr.name}\nSTACK: {', '.join(W.detect_stack(rootr)) or 'unknown'}"
    if git.get("repo"):
        head += f"\nGIT: branch {git.get('branch')} @ {git.get('head')}"

    files = listing(rootr)
    named = named_files(rootr, text, files)
    bodies = _scan(rootr, files)
    n = max(1, len(bodies))

    # One pass per file counts every candidate at once: 40 separate substring
    # searches over a repo's 18 MB of text took twelve seconds.
    cands = candidates(text)
    counts: dict[str, dict[str, int]] = {}
    if cands:
        alt = re.compile("|".join(re.escape(w.lower()) for w in
                                  sorted(cands, key=len, reverse=True)))
        for f, b in bodies.items():
            c: dict[str, int] = {}
            for m in alt.findall(b.lower()):
                c[m] = c.get(m, 0) + 1
            if c:
                counts[f] = c

    # Rarity: a word in most files says nothing about which file is meant.
    terms: list[tuple[str, float]] = []
    for w in cands:
        lw = w.lower()
        df = sum(1 for c in counts.values() if lw in c)
        df += sum(1 for f in files if lw in f.lower() and f not in counts)
        if df == 0 or df > max(2, COMMON * n):
            continue
        terms.append((w, math.log((n + 1) / df)))
    terms.sort(key=lambda t: -t[1])
    terms = terms[:MAX_TERMS]

    scores: dict[str, float] = {}
    for f in files:
        c = counts.get(f, {})
        path = f.lower()
        s = 0.0
        for w, idf in terms:
            lw = w.lower()
            k = c.get(lw, 0)
            if k:
                s += idf * (1 + min(k, 5)) / 2
            if lw in path:
                s += 3 * idf
        if s > 0:
            scores[f] = s

    order = sorted(scores, key=lambda f: -scores[f])
    named_rel = [_rel(rootr, p) for p in named]
    ranked_rel = named_rel + [f for f in order if f not in named_rel]
    ranked = [rootr / f for f in ranked_rel[:RANKED]]

    lines: dict[str, list[str]] = {}
    hit = re.compile("|".join(re.escape(w) for w, _ in terms), re.I) if terms else None
    for f in ranked_rel[:RANKED]:
        b = bodies.get(f)
        if not b or hit is None:
            continue
        hits = []
        for i, line in enumerate(b.splitlines(), 1):
            if hit.search(line):
                hits.append(f"{f}:{i}: {line.strip()[:200]}")
                if len(hits) >= LINES_PER_FILE:
                    break
        if hits:
            lines[f] = hits
    return Plan(head=head, files=files, ranked=ranked, terms=terms, lines=lines)


# ── requests from the unit ─────────────────────────────────────────────────

def parse_needs(reply: str) -> list[str] | None:
    """The paths a reply asks for, if the reply IS a request -- NEED lines and
    at most a sentence or two besides. An answer that happens to mention a
    NEED line is still an answer."""
    reqs = []
    for line in (reply or "").splitlines():
        m = _NEED.match(line)
        if m:
            reqs.append(m.group(1).strip())
            continue
        m = _FINDLINE.match(line)
        if m and m.group(1).strip("`").strip():
            reqs.append(FIND_PREFIX + m.group(1).strip("`").strip())
    if not reqs:
        return None
    rest = _FINDLINE.sub("", _NEED.sub("", reply)).strip()
    if len(rest) > 400 or len([l for l in rest.splitlines() if l.strip()]) > 3:
        return None
    seen, out = set(), []
    for r in reqs:
        if r not in seen:
            seen.add(r)
            out.append(r)
    return out[:10]


_ADMITS = re.compile(
    r"\b(did not|didn't|do not|don't|could not|couldn't|cannot|can't)\s+"
    r"(have|see|get|access|open|read)\b|\bnot (attached|included|shown|provided)\b"
    r"|\binferred\b|\bwithout seeing\b", re.I)
_MENTION = re.compile(r"`([^`\s]{3,200})`")


def missing_mentions(reply: str, files: list[str], shown: set[str]) -> list[str]:
    """Files an ANSWER says it lacked: backticked names in it that are real
    files in the workspace and were not sent -- but only when it admits to
    lacking something. Units follow `NEED:` loosely; told "I did not have
    ai.js, so this is inferred", MAGI sends ai.js rather than accept a guess."""
    if not _ADMITS.search(reply or ""):
        return []
    by_name: dict[str, list[str]] = {}
    for f in files:
        by_name.setdefault(f.rsplit("/", 1)[-1], []).append(f)
    out: list[str] = []
    for tok in _MENTION.findall(reply):
        while tok.startswith("./"):
            tok = tok[2:]
        hits = [tok] if tok in files else (by_name.get(tok, []) if "/" not in tok else
                                          [f for f in files if f.endswith("/" + tok)])
        if len(hits) == 1 and hits[0] not in shown and hits[0] not in out:
            out.append(hits[0])
    return out[:10]


@dataclass
class Request:
    asked: str
    rel: str = ""
    kind: str = "refused"     # "file" | "range" | "dir" | "find" | "refused"
    text: str = ""            # the file, the lines, or the folder's listing
    start: int = 0
    end: int = 0
    total: int = 0
    why: str = ""

    @property
    def key(self) -> str:
        if self.asked.startswith(FIND_PREFIX):
            return self.asked
        return f"{self.rel or self.asked}:{self.start}-{self.end}" if self.kind == "range" \
            else (self.rel or self.asked)


# Track V: reference folders -- other workspaces a task may read -- as
# {name: (folder, its listing)}. Asked for as "@name/path"; never written.
Refs = dict


def find(root: Path, pattern: str, files: list[str], refs: Refs | None = None) -> Request:
    """A FIND request: every line in the project's text files that matches
    -- and in the reference folders', named @name/path. Plain text matches
    case-insensitively; /.../ is a regular expression. Secrets and huge
    files are skipped, as everywhere else here. `start` = how many files
    matched, `total` = how many lines."""
    asked = FIND_PREFIX + pattern
    pat = pattern.strip()
    if len(pat) < 2:
        return Request(asked, why="too short to search for")
    try:
        if len(pat) > 2 and pat.startswith("/") and pat.endswith("/"):
            if _NESTED_REPEAT.search(pat[1:-1]):
                return Request(asked, why="nested repetition like (a+)+ is not searched; "
                               "simplify the pattern")
            rx = re.compile(pat[1:-1], re.I)
        else:
            rx = re.compile(re.escape(pat), re.I)
    except re.error as e:
        return Request(asked, why=f"not a usable pattern ({e})")
    places = [(root.resolve(), "", files)]
    places += [(Path(b).resolve(), f"@{n}/", fs) for n, (b, fs) in (refs or {}).items()]
    hits: list[str] = []
    n_hits = in_files = size = 0
    deadline = time.monotonic() + FIND_MAX_S
    stopped = False
    for base, label, names in places:
        for rel in names:
            if time.monotonic() > deadline:
                stopped = True
                break
            got = _find_in(base / rel, label + rel, rx)
            if got:
                in_files += 1
            for row in got:
                n_hits += 1
                if len(hits) < FIND_MAX_HITS and size < FIND_MAX_CHARS:
                    hits.append(row)
                    size += len(row) + 1
        if stopped:
            break
    cut = (f"\n(search stopped after {int(FIND_MAX_S)} s; not every file was searched)"
           if stopped else "")
    if not n_hits:
        return Request(asked, rel=pat, kind="find", text="(no matches)" + cut)
    more = n_hits - len(hits)
    body = "\n".join(hits) + (f"\n... {more} more matches not shown: FIND something more "
                              "specific, or NEED: the file" if more > 0 else "") + cut
    return Request(asked, rel=pat, kind="find", text=body, total=n_hits, start=in_files)


def _find_in(p: Path, label: str, rx: re.Pattern) -> list[str]:
    """`label:line: text` for each matching line of one file; [] if it is a
    secret, not text, too big or unreadable."""
    if is_secret(p) or not _texty(p):
        return []
    try:
        if p.stat().st_size > SCAN_LIMIT:
            return []
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return [f"{label}:{i}: {line.strip()[:200]}"
            for i, line in enumerate(text.splitlines(), 1)
            if rx.search(line[:SEARCH_LINE_MAX])]


def resolve_request(root: Path, asked: str, files: list[str] | None = None,
                    refs: Refs | None = None) -> Request:
    rootr = root.resolve()
    if asked.startswith(FIND_PREFIX):
        return find(rootr, asked[len(FIND_PREFIX):],
                    files if files is not None else listing(rootr), refs)
    # "@name/path": a reference folder's file, folder or lines -- the same
    # rules as the project's own, answered under its @name.
    want = asked.strip().strip("`'\"").replace("\\", "/")
    if want.startswith("@") and refs:
        name, _, rest = want[1:].partition("/")
        if name in refs:
            base, fs = refs[name]
            r = resolve_request(Path(base), rest or "./", fs)
            r.asked = asked
            if r.rel:
                r.rel = f"@{name}/" + ("" if r.rel == "./" else r.rel)
            if r.kind == "dir":
                r.text = "\n".join(f"@{name}/{x}" for x in r.text.splitlines())
            return r
    req = asked.strip().strip("`'\"").replace("\\", "/")
    start = end = 0
    m = _RANGE.match(req)
    if m:
        req, start, end = m.group(1), int(m.group(2)), int(m.group(3))
    while req.startswith("./"):
        req = req[2:]
    files = files if files is not None else listing(rootr)

    if req.endswith("/") or (contained(rootr, Path(req or ".")) or Path("/nonexistent")).is_dir():
        d = contained(rootr, Path(req.rstrip("/") or "."))
        if d is None:
            return Request(asked, why="not in the workspace")
        prefix = _rel(rootr, d)
        prefix = "" if prefix == "." else prefix + "/"
        under = [f for f in files if f.startswith(prefix)]
        if not under:
            return Request(asked, why="no such folder, or nothing in it")
        return Request(asked, rel=prefix or "./", kind="dir", text="\n".join(under))

    p = contained(rootr, Path(req))
    if p is None:
        return Request(asked, why="not in the workspace")
    if is_secret(p):
        return Request(asked, why="withheld: secrets are never sent")
    if not p.is_file():
        # A bare or slightly wrong path: accept it only if it is unambiguous.
        tail = req.rsplit("/", 1)[-1]
        hits = [f for f in files if f == req or f.endswith("/" + req) or
                ("/" not in req and f.rsplit("/", 1)[-1] == tail)]
        if len(hits) != 1:
            return Request(asked, why="no such file" if not hits else
                           "ambiguous: " + ", ".join(hits[:5]))
        p = rootr / hits[0]
    rel = _rel(rootr, p)
    body = read_whole(rootr, p)
    if body is None:
        return Request(asked, rel=rel, why="not a readable text file")
    total = line_count(body)
    if start:
        lo, hi = max(1, start), min(total, max(start, end))
        chunk = "".join(body.splitlines(keepends=True)[lo - 1:hi])
        return Request(asked, rel=rel, kind="range", text=chunk, start=lo, end=hi, total=total)
    return Request(asked, rel=rel, kind="file", text=body, total=total)


# ── composing what is sent ─────────────────────────────────────────────────

@dataclass
class Composed:
    text: str                                   # the PROJECT CONTEXT block
    uploads: list[tuple[str, str]] = field(default_factory=list)   # (rel, body)
    shown: list[str] = field(default_factory=list)                 # rels sent whole


def _piece_block(rel: str, body: str, budget: int) -> str:
    """As much of `body` as fits in whole lines, labelled with its range."""
    total = line_count(body)
    room = max(200, budget - 300)
    ps = pieces(body, room)
    lo, hi, chunk = ps[0]
    if len(ps) == 1:
        return f"\n===== FILE: {rel} =====\n{chunk}\n===== END {rel} =====\n"
    nxt = ps[1]
    return (f"\n===== FILE: {rel} (lines {lo}-{hi} of {total}) =====\n{chunk}"
            f"\n===== PART of {rel}: ask `NEED: {rel}:{nxt[0]}-{nxt[1]}` for the "
            f"next lines =====\n")


def compose(root: Path, pl: Plan, requests: list[Request], *, upload: bool,
            budget: int, max_uploads: int = 10, upload_bytes: int = 600_000,
            last: bool = False, refs: Refs | None = None) -> Composed:
    """The context block, plus (in upload mode) the files to attach.

    Order of priority: what the unit asked for, then what the task names, then
    the ranking. In paste mode nothing exceeds `budget`; a file that does not
    fit whole goes in numbered pieces, never silently cut."""
    rootr = root.resolve()
    parts: list[str] = []
    used = 0

    def add(s: str) -> bool:
        nonlocal used
        if used + len(s) > budget:
            return False
        parts.append(s)
        used += len(s)
        return True

    add(pl.head + "\n")
    # Uploads leave the composer to the index; pasting shares it with files.
    idx = file_index(pl.files, int(budget * (0.6 if upload else INDEX_SHARE)))
    add(f"\nFILE INDEX (every file in the workspace, {len(pl.files)} in all):\n{idx}\n")
    # Track V: the reference folders' own indexes, smaller, read-only.
    for name, (_, fs) in (refs or {}).items():
        ridx = file_index(fs, int(budget * 0.12 / max(1, len(refs))))
        add(f"\nREFERENCE FOLDER @{name} (read-only; {len(fs)} files; ask `NEED: @{name}/path`):"
            f"\n{ridx}\n")

    uploads: list[tuple[str, str]] = []
    up_bytes = 0
    shown: list[str] = []
    notes: list[str] = []

    def take_upload(rel: str, body: str) -> bool:
        nonlocal up_bytes
        if rel in shown or len(uploads) >= max_uploads or up_bytes + len(body) > upload_bytes:
            return False
        uploads.append((rel, body))
        up_bytes += len(body)
        shown.append(rel)
        return True

    # What the unit asked for comes first, whatever it costs.
    for r in requests:
        if r.kind == "refused":
            notes.append(f"- {r.asked}: {r.why}")
        elif r.kind == "dir":
            add(f"\n===== FOLDER: {r.rel} =====\n{r.text}\n")
        elif r.kind == "find":
            add(f"\n===== FIND: {r.rel} ({r.total} matching lines in {r.start} files) =====\n"
                f"{r.text}\n===== END FIND =====\n")
        elif r.kind == "range":
            add(f"\n===== FILE: {r.rel} (lines {r.start}-{r.end} of {r.total}) =====\n"
                f"{r.text}\n===== END lines {r.start}-{r.end} of {r.rel} =====\n")
        elif r.kind == "file":
            if upload and take_upload(r.rel, r.text):
                continue
            if r.rel in shown:
                continue
            # Shown in part or whole, either way it is not re-sent below: a
            # part ends by saying which lines to ask for next.
            if add(_piece_block(r.rel, r.text, budget - used)):
                shown.append(r.rel)
    if notes:
        add("\nREQUESTS NOT FILLED:\n" + "\n".join(notes) + "\n")

    for p in pl.ranked:
        rel = _rel(rootr, p)
        if rel in shown:
            continue
        body = read_whole(rootr, p)
        if body is None:
            continue
        if upload:
            take_upload(rel, body)
            continue
        if used + len(body) + 200 <= budget * 0.9:
            if add(f"\n===== FILE: {rel} =====\n{body}\n===== END {rel} =====\n"):
                shown.append(rel)
        elif budget - used > 4_000:
            if add(_piece_block(rel, body, min(budget - used, 30_000))):
                shown.append(rel)

    if upload and uploads:
        add("\nATTACHED FILES (uploaded with this message, complete and unabridged; "
            "each upload's name is its path with / written as __ and .txt added; "
            "always refer to a file by its real path, on the right):\n"
            + "\n".join(f"- {upload_name(rel)} = {rel} ({line_count(b)} lines)"
                        for rel, b in uploads) + "\n")

    hits = [h for rel, hs in pl.lines.items() if rel not in shown for h in hs]
    if hits:
        add("\nMATCHING LINES in other relevant files (ask `NEED: path` for the whole file):\n"
            + "\n".join(hits[:60]) + "\n")
    if last:
        add("\n(No further files can be sent for this task.)\n")
    return Composed(text="".join(parts), uploads=uploads, shown=shown)


def upload_name(rel: str) -> str:
    """The name a file is uploaded under: its path, flattened, plus .txt, so no
    site refuses it for its extension and its real path is still legible."""
    flat = re.sub(r"[^A-Za-z0-9._-]+", "_", rel.replace("/", "__"))
    return (flat[-150:] if len(flat) > 150 else flat) + ".txt"


def gather(root: Path, prompt: str, budget: int = BUDGET) -> str:
    """A pasted context block (no uploads). Never over `budget` bytes."""
    return compose(root, plan(root, prompt), [], upload=False, budget=budget).text
