"""Every git operation MAGI performs on a real workspace.

Agents never get git. They edit a sandbox and hand back a diff (sandbox.py);
everything that touches the REAL repository -- pulling before work, reading
its state, committing an approved change -- happens here, performed by MAGI
itself. So no agent, CLI or browser, needs a git binary, a shell or a
credential, and the list of things that can move your branch is this file.

Four rules this module keeps:

* **Bytes in, bytes out.** `run()` never decodes what git says about file
  contents; a patch or a Latin-1 path must round-trip exactly. The sandbox
  uses the same runner.
* **Staging takes an explicit path list.** There is no `add -A`, no
  `add .`, no pathspec magic: `stage()` refuses anything that is not a plain
  repository-relative path, and runs with `--literal-pathspecs` so a file
  called `*` is that file and not a wildcard.
* **Your hooks run on your tree.** A commit here is YOUR commit, made on your
  behalf, so the repository's own hooks run. Only the sandbox turns them off
  (it passes `hooks_path`), because a throwaway copy has no business setting
  off A1's pre-commit.
* **Nothing ever waits for a password.** Network operations run with every
  interactive prompt disabled. The engine has no terminal; a credential
  prompt would hang the task forever instead of failing it with a reason.
"""

from __future__ import annotations

import os
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import proc

NET_TIMEOUT = 120          # seconds for a pull or fetch
_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


class GitError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _env() -> dict[str, str]:
    """The environment for a git that must never stop to ask anything."""
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"          # git's own username/password prompt
    env["GCM_INTERACTIVE"] = "never"          # Git Credential Manager's window
    env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
    env["GIT_EDITOR"] = "true"                # a rebase that wants an editor gets none
    env["GIT_MERGE_AUTOEDIT"] = "no"
    return env


def run(cwd: Path, *args: str, input: bytes | None = None, timeout: int = 120,
        check: bool = True, hooks_path: str | None = None) -> bytes:
    """git in `cwd`, bytes in and out, prefixes and quoting pinned.

    `hooks_path` is for the sandbox only; see the module docstring.
    """
    argv = ["git"]
    if hooks_path is not None:
        argv += ["-c", f"core.hooksPath={hooks_path}"]
    argv += ["-c", "core.quotepath=off", "-c", "diff.noprefix=false",
             "-c", "diff.mnemonicPrefix=false", "-c", "color.ui=false",
             "-C", str(cwd), *args]
    try:
        r = proc.run(argv, input=input, capture_output=True, timeout=timeout, env=_env())
    except FileNotFoundError:
        raise GitError("no_git", "git is not installed on the engine's machine.")
    except Exception as e:  # subprocess.TimeoutExpired, mostly
        raise GitError("timeout", f"git {args[0]} did not finish in {timeout}s ({type(e).__name__}).")
    if check and r.returncode != 0:
        raise GitError("git", f"git {args[0]} failed: {_err(r)}")
    return r.stdout or b""


def _run(cwd: Path, *args: str, **kw):
    """Like run() but returns the CompletedProcess, for callers that read
    stderr or the exit code themselves."""
    argv = ["git", "-c", "core.quotepath=off", "-c", "color.ui=false", "-C", str(cwd), *args]
    try:
        return proc.run(argv, capture_output=True, env=_env(), **kw)
    except FileNotFoundError:
        raise GitError("no_git", "git is not installed on the engine's machine.")
    except Exception as e:
        raise GitError("timeout", f"git {args[0]} did not finish ({type(e).__name__}).")


def _err(r) -> str:
    out = ((r.stderr or b"") + b"\n" + (r.stdout or b"")).decode("utf-8", "replace").strip()
    return out[-600:]


def out(cwd: Path, *args: str) -> str:
    return run(cwd, *args).decode("utf-8", "replace").strip()


def toplevel(root: Path) -> Path | None:
    """The repository's top level, or None if `root` is not in a work tree."""
    r = _run(Path(root), "rev-parse", "--show-toplevel", timeout=30)
    if r.returncode != 0 or not r.stdout.strip():
        return None
    return Path(r.stdout.decode("utf-8", "replace").strip())


def lock(top: Path) -> threading.Lock:
    """One git writer per repository at a time: a pull and a commit on the
    same tree would otherwise race for index.lock and one would fail with a
    message about a file you never heard of."""
    key = os.path.normcase(str(Path(top).resolve()))
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.Lock())


# ── status ────────────────────────────────────────────────────────────────

@dataclass
class Entry:
    kind: str            # "changed" | "renamed" | "unmerged" | "untracked" | "ignored"
    xy: str              # two status letters, "." for unchanged; "??" / "!!"
    path: str
    orig: str = ""       # renamed/copied: where it came from
    score: str = ""      # renamed/copied: "R100", "C75"

    @property
    def staged(self) -> bool:
        return self.kind in ("changed", "renamed") and self.xy[0] != "."

    @property
    def unstaged(self) -> bool:
        return self.kind in ("changed", "renamed") and self.xy[1] != "."

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "xy": self.xy, "path": self.path,
                **({"orig": self.orig, "score": self.score} if self.orig else {})}


@dataclass
class Status:
    oid: str = ""                 # "" on a repository with no commits
    branch: str = ""              # "" when detached
    detached: bool = False
    upstream: str = ""
    ahead: int | None = None      # None when there is no upstream to compare with
    behind: int | None = None
    entries: list[Entry] = field(default_factory=list)
    state: str = ""               # "merge" | "rebase" | "cherry-pick" | "revert" | ""

    @property
    def conflicts(self) -> list[str]:
        return [e.path for e in self.entries if e.kind == "unmerged"]

    @property
    def untracked(self) -> list[str]:
        return [e.path for e in self.entries if e.kind == "untracked"]

    @property
    def dirty(self) -> int:
        """Files that differ from the last commit, untracked ones included."""
        return sum(1 for e in self.entries if e.kind != "ignored")


def parse_status(raw: bytes) -> Status:
    """`git status --porcelain=v2 -z --branch` -> Status.

    With -z every record ends in NUL and paths are never quoted, so a path
    with spaces, quotes or non-ASCII letters is read exactly. A rename is
    the one record that spans two NUL-terminated fields: the new path, then
    the original.
    """
    st = Status()
    fields = raw.decode("utf-8", "surrogateescape").split("\0")
    i = 0
    while i < len(fields):
        rec = fields[i]
        i += 1
        if not rec:
            continue
        tag = rec[0]
        if tag == "#":
            key, _, val = rec[2:].partition(" ")
            if key == "branch.oid":
                st.oid = "" if val == "(initial)" else val
            elif key == "branch.head":
                st.detached = val == "(detached)"
                st.branch = "" if st.detached else val
            elif key == "branch.upstream":
                st.upstream = val
            elif key == "branch.ab":
                m = re.match(r"\+(\d+) -(\d+)", val)
                if m:
                    st.ahead, st.behind = int(m.group(1)), int(m.group(2))
        elif tag == "1":
            # 1 XY sub mH mI mW hH hI path
            p = rec.split(" ", 8)
            st.entries.append(Entry("changed", p[1], p[8]))
        elif tag == "2":
            # 2 XY sub mH mI mW hH hI Xscore path <NUL> origPath
            p = rec.split(" ", 9)
            orig = fields[i] if i < len(fields) else ""
            i += 1
            st.entries.append(Entry("renamed", p[1], p[9], orig=orig, score=p[8]))
        elif tag == "u":
            # u XY sub m1 m2 m3 mW h1 h2 h3 path
            p = rec.split(" ", 10)
            st.entries.append(Entry("unmerged", p[1], p[10]))
        elif tag == "?":
            st.entries.append(Entry("untracked", "??", rec[2:]))
        elif tag == "!":
            st.entries.append(Entry("ignored", "!!", rec[2:]))
    return st


def in_progress(top: Path) -> str:
    """Which multi-step operation the repository is in the middle of, if any."""
    gd = Path(out(top, "rev-parse", "--absolute-git-dir"))
    if (gd / "rebase-merge").exists() or (gd / "rebase-apply").exists():
        return "rebase"
    for name, what in (("MERGE_HEAD", "merge"), ("CHERRY_PICK_HEAD", "cherry-pick"),
                       ("REVERT_HEAD", "revert")):
        if (gd / name).exists():
            return what
    return ""


def status(top: Path) -> Status:
    st = parse_status(run(top, "status", "--porcelain=v2", "-z", "--branch",
                          "--untracked-files=normal", timeout=60))
    st.state = in_progress(top)
    return st


def state(root: Path) -> dict[str, Any]:
    """Everything the console's repository strip shows, from local git only.

    No fetch: this is called every time you open Code Mode, and a network
    round trip there would be a delay on every visit. Ahead/behind are as of
    the last fetch, and `fetched_at` says when that was.
    """
    top = toplevel(root)
    if top is None:
        raise GitError("not_git", "This folder is not a git repository.")
    st = status(top)
    gd = Path(out(top, "rev-parse", "--absolute-git-dir"))
    fh = gd / "FETCH_HEAD"
    subject = ""
    if st.oid:
        subject = out(top, "log", "-1", "--format=%s")
    remotes = [r for r in out(top, "remote").splitlines() if r.strip()]
    return {
        "top": str(top),
        "branch": st.branch,
        "detached": st.detached,
        "head": st.oid[:7],
        "subject": subject[:200],
        "upstream": st.upstream,
        "remotes": remotes,
        "ahead": st.ahead,
        "behind": st.behind,
        "dirty": st.dirty,
        "staged": sum(1 for e in st.entries if e.staged),
        "untracked": len(st.untracked),
        "conflicts": st.conflicts[:20],
        "state": st.state,
        "fetched_at": fh.stat().st_mtime if fh.exists() else None,
    }


# ── staging and committing ────────────────────────────────────────────────

def check_paths(paths: list[str]) -> list[str]:
    """Plain repository-relative file paths, or GitError.

    This is where "never `add -A`, never `add .`" is kept: a path that names
    the whole tree, climbs out of it, or uses pathspec magic is refused rather
    than interpreted.
    """
    if not paths:
        raise GitError("no_paths", "Nothing to stage: no files were named.")
    clean: list[str] = []
    for p in paths:
        s = str(p).replace("\\", "/").strip()
        parts = [x for x in s.split("/") if x not in ("",)]
        if (not s or s in (".", "./", "*") or s.startswith((":", "/", "-"))
                or re.match(r"^[A-Za-z]:", s) or ".." in parts or "." in parts
                or s.startswith(".git/") or s == ".git"):
            raise GitError("bad_path", f"Refusing to stage {p!r}: only plain file paths "
                           "inside the repository are staged, one by one.")
        clean.append("/".join(parts))
    return sorted(set(clean))


def stage(top: Path, paths: list[str]) -> list[str]:
    """`git add` exactly these paths -- a deleted file stages its deletion."""
    names = check_paths(paths)
    run(top, "--literal-pathspecs", "add", "--", *names, timeout=120)
    return names


@dataclass
class Commit:
    sha: str
    subject: str
    files: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {"sha": self.sha, "short": self.sha[:7], "subject": self.subject,
                "files": self.files}


def commit(top: Path, paths: list[str], message: str) -> Commit:
    """Commit exactly `paths`, whatever else happens to be staged.

    `git commit --only -- <paths>` records those files and nothing else: if
    you had other changes staged by hand, they stay staged and stay out of
    this commit. The paths are `git add`-ed first only because `--only`
    refuses a file git has never seen. If anything fails -- a hook says no,
    git does not know who you are -- the index is put back exactly as it was.
    """
    msg = (message or "").strip()
    if not msg:
        raise GitError("no_message", "Write a commit message first.")
    names = check_paths(paths)
    with lock(top):
        busy = in_progress(top)
        if busy:
            raise GitError("in_progress", f"The repository is in the middle of a {busy}. "
                           "Finish or abort it before committing.")
        saved = out(top, "write-tree")
        try:
            stage(top, names)
            r = _run(top, "--literal-pathspecs", "diff", "--cached", "--quiet", "HEAD",
                     "--", *names, timeout=60)
            if r.returncode == 0:
                raise GitError("nothing", "These files already match the last commit; "
                               "there is nothing to commit.")
            r = _run(top, "--literal-pathspecs", "commit", "-q", "-F", "-", "--only",
                     "--", *names, input=msg.encode("utf-8"), timeout=300)
            if r.returncode != 0:
                e = _err(r)
                if "tell me who you are" in e or "empty ident" in e:
                    raise GitError("identity", "git does not know who you are in this "
                                   "repository. Set user.name and user.email, then commit.")
                raise GitError("commit", f"The commit was refused: {e}")
        except BaseException:
            run(top, "read-tree", saved, check=False)
            raise
        sha = out(top, "rev-parse", "HEAD")
    return Commit(sha=sha, subject=msg.splitlines()[0][:200], files=names)


_FENCE = re.compile(r"```.*?```", re.S)


def draft_message(prompt: str, summary: str) -> str:
    """A commit message to start from; the console lets you edit it.

    The subject is what you ASKED for -- that is the intent a commit subject
    records, and it is already a short sentence. The body is what the agent
    says it did, minus any code blocks (a browser unit's reply carries its
    SEARCH/REPLACE blocks, which the diff already records).
    """
    first = next((ln.strip() for ln in (prompt or "").splitlines() if ln.strip()), "")
    subject = re.sub(r"\s+", " ", first).rstrip(" .")
    if len(subject) > 72:
        cut = subject[:71]
        subject = (cut.rsplit(" ", 1)[0] if " " in cut[30:] else cut) + "…"
    subject = subject[:1].upper() + subject[1:] if subject else "Changes made in MAGI Code Mode"
    body = _FENCE.sub("", summary or "")
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    if len(body) > 1500:
        body = body[:1500].rsplit(" ", 1)[0] + " …"
    return subject + ("\n\n" + body if body else "")


# ── pulling before work ───────────────────────────────────────────────────

@dataclass
class Pull:
    ok: bool
    skipped: bool = False
    commits: int = 0
    text: str = ""
    conflicts: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


def _upstream(top: Path) -> str:
    r = _run(top, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}", timeout=30)
    return r.stdout.decode("utf-8", "replace").strip() if r.returncode == 0 else ""


def _plural(n: int, one: str) -> str:
    return f"{n} {one}{'' if n == 1 else 's'}"


def pull(root: Path) -> Pull:
    """`git pull --rebase --autostash`, before an agent looks at anything.

    Answers about stale code are wrong answers, and edits made on stale code
    are conflicts waiting to happen -- so every task starts here (the §7A
    rule). Skipped, with a sentence, when there is nothing to pull from.

    A pull that cannot finish cleanly is undone rather than left half-done:
    a rebase that stops on a conflict is aborted, which also puts your
    autostashed edits back, so the tree is exactly as it was and the task
    stops with the files that clashed.
    """
    top = toplevel(root)
    if top is None:
        return Pull(True, skipped=True, text="Not a git repository — nothing to pull.")
    with lock(top):
        busy = in_progress(top)
        if busy:
            return Pull(False, text=f"The repository is in the middle of a {busy}. "
                        "Finish or abort it, then run the task again.")
        st = status(top)
        if st.detached:
            return Pull(True, skipped=True, text="Detached HEAD — not pulled.")
        if not out(top, "remote"):
            return Pull(True, skipped=True, text="No remote — nothing to pull.")
        up = _upstream(top)
        if not up:
            return Pull(True, skipped=True,
                        text=f"{st.branch or 'This branch'} does not track a remote branch — not pulled.")
        before = st.oid
        r = _run(top, "pull", "--rebase", "--autostash", "--no-edit", timeout=NET_TIMEOUT)
        if r.returncode != 0:
            why = _err(r)
            now = in_progress(top)
            conflicts = status(top).conflicts if now else []
            if now == "rebase":
                run(top, "rebase", "--abort", check=False, timeout=120)
            elif now == "merge":
                run(top, "merge", "--abort", check=False, timeout=120)
            head = why.splitlines()[-1] if why else "git pull failed"
            if conflicts:
                return Pull(False, conflicts=conflicts, text=(
                    f"Pulling {up} clashed with your local commits in "
                    f"{', '.join(conflicts[:6])}. The pull was undone; your folder is as it "
                    "was. Resolve it yourself (git pull --rebase), then run the task again."))
            return Pull(False, text=f"Could not pull {up}: {head}")
        text = (r.stdout or b"").decode("utf-8", "replace") + (r.stderr or b"").decode("utf-8", "replace")
        if "safe in the stash" in text:
            return Pull(False, text=(
                f"Pulled {up}, but your uncommitted edits clashed with it and are now in "
                "git stash (not in the folder). Run git stash pop and resolve, then run "
                "the task again."))
        n = 0
        if before:
            c = _run(top, "rev-list", "--count", f"{before}..@{{u}}", timeout=30)
            n = int(c.stdout.strip() or 0) if c.returncode == 0 else 0
        return Pull(True, commits=n, text=(
            f"Pulled {_plural(n, 'commit')} from {up}." if n else f"Up to date with {up}."))


def fetch_only(root: Path) -> Pull:
    """For a tree MAGI must not rewrite (its own): learn how far behind it
    is, and say so, without touching a file."""
    top = toplevel(root)
    if top is None or not out(top, "remote"):
        return Pull(True, skipped=True, text="No remote — nothing to fetch.")
    up = _upstream(top)
    if not up:
        return Pull(True, skipped=True, text="Not tracking a remote branch — not fetched.")
    with lock(top):
        r = _run(top, "fetch", "--quiet", timeout=NET_TIMEOUT)
    if r.returncode != 0:
        return Pull(True, skipped=True, text=f"Could not fetch {up} ({_err(r).splitlines()[-1] if _err(r) else 'error'}); answering from the folder as it is.")
    st = status(top)
    b = st.behind or 0
    return Pull(True, skipped=True, text=(
        f"{_plural(b, 'commit')} behind {up} — not pulled: this is MAGI's own repository, "
        "whose working tree other sessions are using." if b else f"Up to date with {up}."))
