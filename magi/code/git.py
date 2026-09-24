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
* **A token is handed over, never stored (Phase 10).** A push, and a pull or
  fetch on a project with a GitHub account, clears git's credential helpers
  and points GIT_ASKPASS at magi/github/askpass.py, which reads the token
  from the OS credential store when git asks -- and only for the host the
  account belongs to. It never enters .git/config, argv, or git's
  environment. Nothing is ever force-pushed.
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


def _run(cwd: Path, *args: str, auth: "Auth | None" = None, **kw):
    """Like run() but returns the CompletedProcess, for callers that read
    stderr or the exit code themselves. `auth` is for network commands: see
    Auth below."""
    argv = ["git", "-c", "core.quotepath=off", "-c", "color.ui=false"]
    env = _env()
    if auth is not None:
        argv += auth.config()
        env.update(auth.env())
    argv += ["-C", str(cwd), *args]
    try:
        return proc.run(argv, capture_output=True, env=env, **kw)
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
        "github": github_of(top, st.branch) if remotes else None,
    }


_TRACK = re.compile(r"(ahead|behind) (\d+)")


def branches(root: Path) -> list[dict[str, Any]]:
    """Every local branch with its upstream and how far it is from it, as of
    the last fetch -- one `for-each-ref`, no network. `gone` is an upstream
    that was deleted on the remote."""
    top = toplevel(root)
    if top is None:
        raise GitError("not_git", "This folder is not a git repository.")
    # run(), not out(): out() strips, and str.strip() counts \x1f as
    # whitespace -- it ate the first row's separator when that branch was
    # not the current one (a blank %(HEAD)).
    raw = run(top, "for-each-ref", "--sort=-committerdate",
              "--format=%(HEAD)\x1f%(refname:short)\x1f%(upstream:short)\x1f%(upstream:track)"
              "\x1f%(objectname:short)\x1f%(committerdate:unix)\x1f%(contents:subject)",
              "refs/heads").decode("utf-8", "replace")
    rows = []
    for line in raw.splitlines():
        f = line.split("\x1f")
        if len(f) < 7:
            continue
        track = dict((k, int(v)) for k, v in _TRACK.findall(f[3]))
        rows.append({"current": f[0] == "*", "name": f[1], "upstream": f[2],
                     "ahead": track.get("ahead", 0), "behind": track.get("behind", 0),
                     "gone": "gone" in f[3], "head": f[4],
                     "date": int(f[5]) if f[5].isdigit() else None, "subject": f[6][:200]})
    return rows


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


def pull(root: Path, auth: "Auth | None" = None) -> Pull:
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
        r = _run(top, "pull", "--rebase", "--autostash", "--no-edit", timeout=NET_TIMEOUT,
                 auth=_for_remote(top, auth))
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


def fetch_only(root: Path, auth: "Auth | None" = None) -> Pull:
    """For a tree MAGI must not rewrite (its own): learn how far behind it
    is, and say so, without touching a file."""
    top = toplevel(root)
    if top is None or not out(top, "remote"):
        return Pull(True, skipped=True, text="No remote — nothing to fetch.")
    up = _upstream(top)
    if not up:
        return Pull(True, skipped=True, text="Not tracking a remote branch — not fetched.")
    with lock(top):
        r = _run(top, "fetch", "--quiet", timeout=NET_TIMEOUT, auth=_for_remote(top, auth))
    if r.returncode != 0:
        return Pull(True, skipped=True, text=f"Could not fetch {up} ({_err(r).splitlines()[-1] if _err(r) else 'error'}); answering from the folder as it is.")
    st = status(top)
    b = st.behind or 0
    return Pull(True, skipped=True, text=(
        f"{_plural(b, 'commit')} behind {up} — not pulled: this is MAGI's own repository, "
        "whose working tree other sessions are using." if b else f"Up to date with {up}."))


# ── credentials: one GitHub account, handed to git only when it asks ─────

def remote_info(url: str) -> dict[str, Any]:
    """Where a remote URL points, with any credentials in it stripped.

    `https://user:tok@github.com/o/r.git` -> host github.com, owner o, repo r,
    has_password True -- and `safe` is the URL WITHOUT the userinfo, which is
    the only form that is ever shown or returned.
    """
    u = (url or "").strip()
    info: dict[str, Any] = {"scheme": "", "host": "", "owner": "", "repo": "",
                            "has_password": False, "safe": ""}
    m = re.match(r"^(https?|ssh|git)://(?:([^@/]*)@)?([^/]+)/(.*)$", u, re.I)
    if m:
        scheme, userinfo, host, path = m.groups()
        info["scheme"] = scheme.lower()
        info["has_password"] = bool(userinfo and ":" in userinfo)
        info["host"] = host.lower()
        info["safe"] = f"{scheme}://{host}/{path}"
    else:
        m = re.match(r"^(?:([^@/:]+)@)?([^/:\\]+):(.+)$", u)        # scp-like git@host:o/r
        if not m or len(m.group(2)) == 1:                          # C:\... is a path
            info["safe"] = u
            return info
        info["scheme"], info["host"], path = "ssh", m.group(2).lower(), m.group(3)
        info["safe"] = u
    parts = [p for p in re.sub(r"\.git/?$", "", path.rstrip("/")).split("/") if p]
    if len(parts) >= 2:
        info["owner"], info["repo"] = parts[-2], parts[-1]
    return info


def _askpass_script() -> Path:
    """The shell script git runs as GIT_ASKPASS: exec the venv's windowless
    Python on magi/github/askpass.py. Git for Windows runs `#!/bin/sh`
    scripts itself (verified), and pythonw means no console window flashes
    on the desktop at every push. Rewritten only when it would change."""
    import sys
    from ..settings import data_dir
    py = Path(sys.executable)
    pyw = py.with_name("pythonw.exe")
    exe = (pyw if pyw.exists() else py).as_posix()
    helper = (Path(__file__).resolve().parent.parent / "github" / "askpass.py").as_posix()
    body = f'#!/bin/sh\nexec "{exe}" -I "{helper}" "$@"\n'.encode()
    d = data_dir() / "github"
    d.mkdir(parents=True, exist_ok=True)
    f = d / "askpass.sh"
    try:
        if f.read_bytes() == body:
            return f
    except OSError:
        pass
    f.write_bytes(body)
    return f


@dataclass
class Auth:
    """Which GitHub account a network git command uses.

    Nothing in here is secret: the account is named by its credential-store
    service, and the token is read by askpass.py when git asks for it.

    `config()` clears git's credential helper list first. Git Credential
    Manager is configured machine-wide on the engine PC, and without this a
    push would silently go out as whoever GCM remembers (docs/magi-plan.md
    §0, Phase 9 facts) -- and git would hand the token to GCM to keep after
    a successful push, which is exactly where it must not end up.
    """
    login: str
    service: str
    host: str = "github.com"

    def config(self) -> list[str]:
        # Not `credential.interactive=never`: that also stops git asking
        # GIT_ASKPASS, so the token is never requested at all (found in
        # test_github_push). GIT_TERMINAL_PROMPT=0 already keeps git off
        # the terminal. sslVerify (Phase 14): a repository's own config
        # saying `http.sslVerify=false` would let a proxy in the middle read
        # the token as it goes out; the command line outranks it.
        return ["-c", "credential.helper=", "-c", "core.askPass=",
                "-c", "http.sslVerify=true"]

    def env(self) -> dict[str, str]:
        return {"GIT_ASKPASS": str(_askpass_script()), "MAGI_GH_SERVICE": self.service,
                "MAGI_GH_LOGIN": self.login, "MAGI_GH_HOST": self.host}


def _remote_of(top: Path, branch: str) -> str:
    r = _run(top, "config", "--get", f"branch.{branch}.remote", timeout=30) if branch else None
    name = r.stdout.decode("utf-8", "replace").strip() if r is not None and r.returncode == 0 else ""
    if name:
        return name
    remotes = out(top, "remote").split()
    return "origin" if "origin" in remotes else (remotes[0] if len(remotes) == 1 else "")


def _remote_url(top: Path, remote: str) -> str:
    r = _run(top, "remote", "get-url", "--push", remote, timeout=30) if remote else None
    return r.stdout.decode("utf-8", "replace").strip() if r is not None and r.returncode == 0 else ""


def _for_remote(top: Path, auth: Auth | None) -> Auth | None:
    """`auth` only if the remote really is on the account's host -- a token
    is never offered to a server it was not issued by."""
    if auth is None:
        return None
    br = out(top, "branch", "--show-current")
    info = remote_info(_remote_url(top, _remote_of(top, br)))
    return auth if info["host"] == auth.host.lower() and info["scheme"] in ("https", "http") else None


def github_of(top: Path, branch: str | None = None) -> dict[str, Any]:
    """owner/repo of the current branch's remote, for the console's
    Repository pill. Local only; the URL comes back without credentials."""
    br = out(top, "branch", "--show-current") if branch is None else branch
    remote = _remote_of(top, br)
    info = remote_info(_remote_url(top, remote))
    return {"remote": remote, "host": info["host"], "owner": info["owner"],
            "repo": info["repo"], "url": info["safe"], "scheme": info["scheme"]}


@dataclass
class Push:
    ok: bool
    code: str = ""
    text: str = ""
    commits: int = 0
    remote: str = ""          # "origin"
    branch: str = ""          # the remote branch pushed to
    repo: str = ""            # "owner/name", when the remote says
    old: str = ""
    new: str = ""
    by: str = ""              # the GitHub login it went out as
    sha: str = ""             # the full commit pushed: what the Actions watch follows

    def to_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


_AUTH_FAIL = re.compile(r"Authentication failed|Invalid username or (password|token)|"
                        r"could not read (Username|Password)|unable to get password|terminal prompts disabled|"
                        r"Permission to .* denied|Write access to repository not granted|"
                        r"returned error: 40[13]", re.I)


def push(root: Path, auth: Auth | None) -> Push:
    """Push the current branch to its remote branch -- never forced.

    Refused, with a sentence, when the repository is mid-merge/rebase, HEAD
    is detached, or the remote has commits you do not (pull first: a push
    here never rewrites anything on GitHub). An HTTPS remote needs an
    account (`auth`) on that remote's host; with no account nothing is
    pushed at all, rather than going out as whatever login this machine
    happens to remember. A local path or SSH remote uses the machine's own
    access and no token.

    The refspec is spelled out without a `+`, so no config on the remote
    (`remote.origin.push = +refs/...`) can turn this into a force push.
    """
    top = toplevel(root)
    if top is None:
        return Push(False, "not_git", "This folder is not a git repository.")
    with lock(top):
        busy = in_progress(top)
        if busy:
            return Push(False, "in_progress", f"The repository is in the middle of a {busy}. "
                        "Finish or abort it, then push.")
        st = status(top)
        if st.detached:
            return Push(False, "detached", "HEAD is detached — check out a branch to push.")
        if not st.oid:
            return Push(False, "no_commits", "There are no commits to push yet.")
        remote = _remote_of(top, st.branch)
        url = _remote_url(top, remote)
        if not url:
            return Push(False, "no_remote", "This repository has no remote to push to.")
        info = remote_info(url)
        repo = f"{info['owner']}/{info['repo']}" if info["owner"] else ""
        res = Push(False, remote=remote, repo=repo)
        if info["has_password"]:
            res.code, res.text = "password_in_url", (
                f"The URL of {remote} has a password or token written into it. MAGI will not "
                "push with a credential it did not give — remove it from the URL first.")
            return res
        use: Auth | None = None
        if info["scheme"] in ("https", "http"):
            if auth is None:
                res.code, res.text = "no_account", (
                    f"Pick the GitHub account to push {repo or remote} as. MAGI does not push "
                    "with whatever login this machine happens to remember.")
                return res
            if info["host"] != auth.host.lower():
                res.code, res.text = "wrong_host", (
                    f"{remote} is on {info['host']}, not {auth.host}; {auth.login}'s token is "
                    "only ever sent to the host that issued it.")
                return res
            use = auth
            res.by = auth.login

        mb = _run(top, "config", "--get", f"branch.{st.branch}.merge", timeout=30)
        merge = mb.stdout.decode("utf-8", "replace").strip() if mb.returncode == 0 else ""
        rbranch = merge[len("refs/heads/"):] if merge.startswith("refs/heads/") else st.branch
        res.branch = rbranch

        f = _run(top, "fetch", "--quiet", remote, timeout=NET_TIMEOUT, auth=use)
        if f.returncode != 0:
            return _push_failed(res, _err(f), use, "fetch")
        tracking = f"refs/remotes/{remote}/{rbranch}"
        exists = _run(top, "rev-parse", "--verify", "--quiet", tracking, timeout=30).returncode == 0
        if exists:
            behind = int(out(top, "rev-list", "--count", f"HEAD..{tracking}") or 0)
            if behind:
                res.code, res.text = "behind", (
                    f"{remote}/{rbranch} has {_plural(behind, 'commit')} you do not. Pull first "
                    "(the next task's pull does it), then push. MAGI never force-pushes.")
                return res
            ahead = int(out(top, "rev-list", "--count", f"{tracking}..HEAD") or 0)
            res.old = out(top, "rev-parse", tracking)[:7]
            if not ahead:
                res.ok, res.code = True, "up_to_date"
                res.text = f"Nothing to push: {remote}/{rbranch} already has it."
                return res
        else:
            ahead = int(out(top, "rev-list", "--count", "HEAD", "--not",
                            f"--remotes={remote}") or 0)

        argv = ["push", "--porcelain", remote, f"refs/heads/{st.branch}:refs/heads/{rbranch}"]
        if not st.upstream:
            argv.insert(1, "--set-upstream")
        p = _run(top, *argv, timeout=NET_TIMEOUT * 2, auth=use)
        if p.returncode != 0:
            return _push_failed(res, _err(p), use, "push")
        res.ok, res.code, res.commits = True, "pushed", ahead
        res.sha = out(top, "rev-parse", "HEAD")
        res.new = res.sha[:7]
        res.text = (f"Pushed {_plural(ahead, 'commit')} to {repo or remote} ({rbranch})"
                    + (f" as {res.by}." if res.by else "."))
        return res


def can_push(root: Path, auth: Auth | None) -> dict[str, Any]:
    """May this account push to this folder's remote? Asked of GitHub by git.

    REST cannot answer it for a fine-grained token: `permissions.push` on a
    repository is the OWNER's role, so a read-only token on your own repo
    reads as push: true (verified live, Phase 10). `git push --dry-run`
    fetches the receive-pack advertisement, which GitHub only serves to a
    credential with write access -- a 403 otherwise -- and sends nothing: no
    objects, no ref update. The ref named is one that is never created, and
    hooks are skipped (a dry run has nothing for them to check).

    -> {"push": True|False|None, "why": sentence}; None = could not tell.
    """
    top = toplevel(root)
    if top is None or auth is None:
        return {"push": None, "why": "No repository or no account."}
    br = out(top, "branch", "--show-current")
    remote = _remote_of(top, br)
    info = remote_info(_remote_url(top, remote))
    if info["host"] != auth.host.lower() or info["scheme"] not in ("https", "http"):
        return {"push": None, "why": "The remote is not on this account's host."}
    if not out(top, "rev-parse", "--verify", "--quiet", "HEAD"):
        return {"push": None, "why": "No commits yet to test with."}
    r = _run(top, "push", "--dry-run", "--no-verify", "--porcelain", remote,
             "HEAD:refs/heads/magi-write-check-never-created", auth=auth, timeout=60)
    if r.returncode == 0:
        return {"push": True, "why": ""}
    why = _err(r)
    if _AUTH_FAIL.search(why) or re.search(r"Repository not found", why, re.I):
        return {"push": False, "why": why.splitlines()[0][:200] if why else ""}
    return {"push": None, "why": (why.splitlines()[-1] if why else "git push --dry-run failed")[:200]}


def _push_failed(res: Push, why: str, auth: Auth | None, step: str) -> Push:
    lines = [ln for ln in why.splitlines() if ln.strip() and not ln.startswith(("To ", "Done"))]
    tail = lines[-1].strip() if lines else f"git {step} failed"
    target = res.repo or res.remote
    if re.search(r"\[rejected\]|non-fast-forward|fetch first|stale info", why):
        res.code, res.text = "behind", (f"GitHub has commits on {res.branch} you do not. Pull "
                                        "first, then push. MAGI never force-pushes.")
    elif re.search(r"protected branch|GH006", why):
        res.code, res.text = "protected", f"{res.branch} is protected on GitHub: {tail}"
    elif re.search(r"pre-push hook declined|hook declined", why, re.I):
        res.code, res.text = "hook", f"The repository's pre-push hook refused the push: {tail}"
    elif auth and re.search(r"Repository not found", why, re.I):
        res.code, res.text = "not_found", (
            f"GitHub says {target} does not exist — or {auth.login}'s token cannot see it. A "
            "fine-grained token only sees the repositories you picked for it.")
    elif _AUTH_FAIL.search(why):
        who = auth.login if auth else "this machine"
        res.code, res.text = "auth_refused", (
            f"GitHub refused {who} for {target}. A fine-grained token needs Contents: Read "
            "and write on this repository; an expired or revoked one needs replacing in Accounts.")
    else:
        res.code, res.text = step, f"Could not {step} {target}: {tail}"
    return res
