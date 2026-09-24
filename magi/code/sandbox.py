"""The throwaway copy an agent edits instead of your workspace.

    real workspace ──git stash create──► worktree in %TEMP%\\magi-sandbox
                                            │  agent edits freely here
                                            ▼
                                     diff (two trees)  ──► approval card
                                            │
                                  approve ──┘  deny → discarded
                                            ▼
                                  applied onto the real tree

Why a git worktree rather than a file copy: it is a full checkout in a second
or two without duplicating history, and the "before" and "after" are both git
trees, so the diff is git's own -- binary files, modes and deletions included
-- instead of something hand-rolled.

Four details that each matter:

* **Uncommitted work is included.** `git stash create` makes a commit of the
  working tree WITHOUT touching it or the stash list, so the agent starts from
  what is on your disk, not from HEAD. Untracked (non-ignored) files are
  copied in; secrets among them are not.
* **The baseline is a tree, not a commit.** After the copy, `git add -A` +
  `git write-tree` records exactly what the agent was given. The diff is that
  tree against the tree after the agent finished, so the untracked files MAGI
  copied in never show up as the agent's additions. No commit means no hooks,
  no author identity, and nothing on any branch.
* **Hooks never run.** Every git call here passes an empty `core.hooksPath`.
  The worktree shares the real repository's hooks, and A1's pre-commit and
  post-checkout hooks are not something a sandbox should set off.
* **Nothing outlives the task.** A marker file records every sandbox; the
  task removes its own in a `finally`, and startup sweeps any left by a crash
  or an engine restart.

Applying never stages or commits; committing is a separate step you ask for
(git.commit, the card's "Commit these files"). A clean patch goes
on with `git apply`; one whose context moved because you edited the same file
meanwhile gets a per-file three-way merge; a real conflict applies NOTHING and
keeps the patch on disk so the work is not lost.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import proc
from . import git as G
from .agents import context

BASE = Path(tempfile.gettempdir()) / "magi-sandbox"
UNTRACKED_FILE_CAP = 20_000_000      # bytes; a bigger untracked file is not copied
UNTRACKED_TOTAL_CAP = 300_000_000


class SandboxError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _nohooks() -> str:
    d = BASE / "no-hooks"
    d.mkdir(parents=True, exist_ok=True)
    return str(d)


def git(cwd: Path, *args: str, input: bytes | None = None, timeout: int = 120,
        check: bool = True) -> bytes:
    """git.run with hooks OFF -- the one thing a sandbox adds to it.

    Bytes, because a patch must round-trip exactly: decoding a Latin-1 file's
    diff as UTF-8 and re-encoding it would apply a different change.
    """
    try:
        return G.run(cwd, *args, input=input, timeout=timeout, check=check,
                     hooks_path=_nohooks())
    except G.GitError as e:
        raise SandboxError("git", e.message)


def _out(cwd: Path, *args: str) -> str:
    return git(cwd, *args).decode("utf-8", "replace").strip()


def _profile_dir(profile: str) -> Path:
    return BASE / (profile or "default")


@dataclass
class Sandbox:
    task_id: str
    repo: Path          # the real repository's top level
    prefix: str         # the workspace inside it, "" or "web/"
    path: Path          # the worktree's top level
    base_tree: str
    marker: Path
    copied: int = 0
    skipped: list[str] = field(default_factory=list)
    patch: bytes = b""
    final_tree: str = ""

    @property
    def cwd(self) -> Path:
        return self.path / self.prefix if self.prefix else self.path

    def snapshot(self) -> str:
        """The tree as it is now, including new files. Idempotent."""
        git(self.path, "add", "-A")
        return _out(self.path, "write-tree")

    def diff(self) -> bytes:
        """What the agent changed: the given tree against the tree now."""
        self.final_tree = self.snapshot()
        if self.final_tree == self.base_tree:
            self.patch = b""
        else:
            self.patch = git(self.path, "diff", "--binary", "--no-renames", "--no-color",
                             "--no-ext-diff", "--no-textconv", "--src-prefix=a/",
                             "--dst-prefix=b/", self.base_tree, self.final_tree)
        return self.patch

    def changed_files(self) -> list[str]:
        """For a hand-off: which files the previous agent had already touched."""
        try:
            now = self.snapshot()
            if now == self.base_tree:
                return []
            out = _out(self.path, "diff", "--name-status", "--no-renames",
                       self.base_tree, now)
            return [ln.replace("\t", " ") for ln in out.splitlines() if ln.strip()][:60]
        except SandboxError:
            return []

    def remove(self) -> None:
        _remove(self.repo, self.path, self.marker)


def _remove(repo: Path, path: Path, marker: Path | None) -> None:
    try:
        git(repo, "worktree", "remove", "--force", str(path), check=False, timeout=60)
    except Exception:
        pass
    if path.exists():
        # A CLI that is still exiting can hold a file open for a moment.
        for _ in range(3):
            shutil.rmtree(path, ignore_errors=True)
            if not path.exists():
                break
            time.sleep(0.5)
    try:
        git(repo, "worktree", "prune", check=False, timeout=30)
    except Exception:
        pass
    if marker is not None:
        try:
            marker.unlink(missing_ok=True)
        except OSError:
            pass


def repo_of(root: Path) -> tuple[Path, str]:
    """(repository top level, workspace prefix) or SandboxError."""
    try:
        inside = _out(root, "rev-parse", "--is-inside-work-tree")
    except SandboxError:
        inside = ""
    if inside != "true":
        raise SandboxError("not_git", (
            "Write mode needs the workspace to be a git repository, so every change "
            "can be shown as a diff and undone. Run `git init` there first."))
    top = Path(_out(root, "rev-parse", "--show-toplevel"))
    prefix = _out(root, "rev-parse", "--show-prefix")
    return top, prefix


def create(root: Path, task_id: str, profile: str) -> Sandbox:
    top, prefix = repo_of(root)
    try:
        _out(top, "rev-parse", "--verify", "HEAD")
    except SandboxError:
        raise SandboxError("no_commits", (
            "This repository has no commits yet. Make a first commit, then Write "
            "mode can start from it."))

    # A commit of the working tree as it is -- tracked edits included -- or
    # "" when the tree is clean. Touches neither the tree nor the stash list.
    base = _out(top, "stash", "create") or "HEAD"

    pdir = _profile_dir(profile)
    pdir.mkdir(parents=True, exist_ok=True)
    path = pdir / task_id
    marker = pdir / f"{task_id}.json"
    marker.write_text(json.dumps({"repo": str(top), "path": str(path),
                                  "created": time.time()}), encoding="utf-8")
    try:
        git(top, "worktree", "add", "--detach", str(path), base, timeout=300)
        sb = Sandbox(task_id=task_id, repo=top, prefix=prefix, path=path,
                     base_tree="", marker=marker)
        _copy_untracked(sb)
        sb.base_tree = sb.snapshot()
        return sb
    except BaseException:
        _remove(top, path, marker)
        raise


def _copy_untracked(sb: Sandbox) -> None:
    args = ["ls-files", "--others", "--exclude-standard", "-z"]
    if sb.prefix:
        args += ["--", sb.prefix]
    names = [n for n in git(sb.repo, *args).decode("utf-8", "replace").split("\0") if n]
    total = 0
    for rel in names:
        src = sb.repo / rel
        if context.is_secret(Path(rel)):
            sb.skipped.append(rel)
            continue
        try:
            size = src.stat().st_size
        except OSError:
            continue
        if not src.is_file() or size > UNTRACKED_FILE_CAP or total + size > UNTRACKED_TOTAL_CAP:
            sb.skipped.append(rel)
            continue
        dst = sb.path / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        total += size
        sb.copied += 1


def sweep(profile: str | None = None) -> int:
    """Remove every sandbox left behind. Call only when no task is running."""
    dirs = [_profile_dir(profile)] if profile else (
        [d for d in BASE.iterdir() if d.is_dir() and d.name != "no-hooks"]
        if BASE.is_dir() else [])
    n = 0
    for pdir in dirs:
        if not pdir.is_dir():
            continue
        for marker in pdir.glob("*.json"):
            try:
                m = json.loads(marker.read_text(encoding="utf-8"))
                _remove(Path(m["repo"]), Path(m["path"]), marker)
                n += 1
            except Exception:
                try:
                    marker.unlink(missing_ok=True)
                except OSError:
                    pass
        # A worktree whose marker was lost: its repository's own
        # `worktree prune` will forget it once the folder is gone.
        for d in pdir.iterdir():
            if d.is_dir():
                shutil.rmtree(d, ignore_errors=True)
                n += 1
    return n


# ── putting an approved change onto the real tree ─────────────────────────

@dataclass
class ApplyResult:
    ok: bool
    how: str = ""                  # "clean" | "merged" | "refused" | ""
    files: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    saved_patch: str = ""
    message: str = ""

    def to_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


def _blob(repo: Path, tree: str, path: str) -> str | None:
    r = proc.run(["git", "-C", str(repo), "rev-parse", "--verify", "--quiet",
                  f"{tree}:{path}"], capture_output=True, timeout=30)
    return r.stdout.decode().strip() if r.returncode == 0 and r.stdout.strip() else None


def _clean_blob_of_file(repo: Path, path: str) -> str | None:
    """The working file as git would store it (line endings normalised)."""
    f = repo / path
    if not f.is_file():
        return None
    return _out(repo, "hash-object", "-w", f"--path={path}", str(f))


def _smudged(repo: Path, path: str, blob: str) -> bytes:
    """A blob as it should look on disk here (CRLF where the repo says)."""
    return git(repo, "cat-file", "--filters", f"--path={path}", blob)


def _merge3(repo: Path, base: str, ours: str, theirs: str) -> tuple[str | None, bool]:
    """git merge-file on three blobs -> (merged blob, clean?)."""
    with tempfile.TemporaryDirectory(prefix="magi-merge-") as td:
        paths = []
        for name, blob in (("ours", ours), ("base", base), ("theirs", theirs)):
            p = Path(td) / name
            p.write_bytes(git(repo, "cat-file", "blob", blob))
            paths.append(str(p))
        r = proc.run(["git", "merge-file", "-p", *paths], capture_output=True, timeout=60)
        if r.returncode != 0:          # >0 = conflicts, <0 = error
            return None, False
        merged = git(repo, "hash-object", "-w", "--stdin", input=r.stdout)
        return merged.decode().strip(), True


def apply(sb: Sandbox, files: list[dict[str, Any]], save_dir: Path) -> ApplyResult:
    """Put the approved patch on the real tree -- all of it, or none of it."""
    if not sb.patch:
        return ApplyResult(True, "clean", message="Nothing to apply.")
    # Reviewed again NOW, against the real tree as it is at approval: the card
    # can wait five minutes, and a link or folder made in the real tree
    # meanwhile would change where an already-approved path lands.
    from . import security
    rv = security.review(sb.patch.decode("utf-8", "replace"), root=sb.repo, prefix=sb.prefix,
                         deny=review_deny(sb.repo))
    if not rv.ok:
        return ApplyResult(False, "refused", conflicts=[p for p, _ in rv.refused],
                           message=rv.message)
    names = [f["path"] for f in files]
    chk = proc.run(["git", "-c", f"core.hooksPath={_nohooks()}", "-C", str(sb.repo),
                    "apply", "--check", "--whitespace=nowarn", "-"],
                   input=sb.patch, capture_output=True, timeout=120)
    if chk.returncode == 0:
        git(sb.repo, "apply", "--whitespace=nowarn", "-", input=sb.patch)
        return ApplyResult(True, "clean", names)

    # The real tree moved while the agent worked. Merge file by file against
    # the tree the agent was given, and write only if every file is clean.
    writes: list[tuple[str, bytes | None]] = []
    conflicts: list[str] = []
    for f in files:
        p = f["path"]
        base = _blob(sb.repo, sb.base_tree, p)
        theirs = _blob(sb.repo, sb.final_tree, p)
        ours = _clean_blob_of_file(sb.repo, p)
        if ours == base:                       # you did not touch it: take theirs
            writes.append((p, _smudged(sb.repo, p, theirs) if theirs else None))
        elif ours == theirs:                   # already the same
            continue
        elif base and ours and theirs and not f.get("binary"):
            merged, clean = _merge3(sb.repo, base, ours, theirs)
            if clean and merged:
                writes.append((p, _smudged(sb.repo, p, merged)))
            else:
                conflicts.append(p)
        else:
            conflicts.append(p)

    if conflicts:
        save_dir.mkdir(parents=True, exist_ok=True)
        saved = save_dir / f"{sb.task_id}.patch"
        saved.write_bytes(sb.patch)
        return ApplyResult(False, "", [], conflicts, str(saved), (
            f"{len(conflicts)} file(s) changed on disk while the agent worked, in the "
            f"same places: {', '.join(conflicts[:6])}. Nothing was applied. The change "
            f"is saved as {saved} (git apply it by hand, or run the task again)."))

    for p, data in writes:
        target = sb.repo / p
        if data is None:
            target.unlink(missing_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    return ApplyResult(True, "merged", names)


def patch_dir(profile_data: Path) -> Path:
    return profile_data / "code-patches"


# What Code Mode may do in MAGI's own repository (A1). Decided by Tony,
# 2026-09-24 (Phase 14b), one answer per action -- each call site asks about
# its own action, never "is this A1?", so opening one cannot open another:
#   write   yes: sandbox -> diff -> your approval -> applied, like any project.
#   commit  no:  A1's Stop hook commits (`auto:`) at the end of every Claude
#                session, applied Code Mode changes included.
#   push    no:  the Stop hook pushes; A1 keeps exactly one pusher.
#   pull    no:  fetch only -- a rebase under live sessions and the hook is
#                worse than a stale answer.
#   auto    no:  auto commit/push, for the same reason as commit.
ENGINE_REPO = {"write": True, "commit": False, "push": False, "pull": False, "auto": False}

ENGINE_REPO_WHY = {
    "commit": "A1 commits itself: its auto-commit records every change and pushes it "
              "within minutes. Code Mode does not commit here.",
    "push": "A1 pushes itself (its auto-commit, and the Stop hook); Code Mode does not "
            "push A1.",
    "write": "MAGI's own repository is read-only to Code Mode.",
}

# A1 SHIPS what is applied: its always-on auto-commit pushes every change to
# main within a minute or two, GitHub Pages serves the pages, and these paths
# deploy on push (.github/workflows). Said on the approval card, per file.
ENGINE_REPO_DEPLOYS = ("workers/", "workers2/", "V1/workers/", "desktop/shield/")
# Refused in A1 outright: a workflow runs with the repository's secrets, and
# with the push automatic, approving the diff would be the only gate.
ENGINE_REPO_DENY = {".github/": "A1 pushes itself within minutes and a workflow runs "
                                "with the repository's secrets; change workflows in a "
                                "normal session, not through Code Mode"}


def review_deny(root: Path) -> dict[str, str]:
    """The extra deny-list for this repository (A1's; nothing elsewhere)."""
    return dict(ENGINE_REPO_DENY) if is_engine_repo(root) else {}


def engine_repo_allows(root: Path, action: str) -> bool:
    """May Code Mode do `action` here? Anything but A1: yes."""
    return ENGINE_REPO[action] or not is_engine_repo(root)


def is_engine_repo(root: Path) -> bool:
    """True for the repository MAGI itself lives in (A1). What Code Mode may
    do there is ENGINE_REPO, above."""
    from ..settings import ROOT
    try:
        top, _ = repo_of(root)
        mine, _ = repo_of(ROOT)
    except SandboxError:
        return False
    return os.path.normcase(str(top.resolve())) == os.path.normcase(str(mine.resolve()))
