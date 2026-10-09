"""Auto commit / auto push (Phase 12): the two presses after Approve, made by
MAGI on a timer. On for every project by default since 2026-10-08, with no
wait: the same as Claude Code's Stop hook committing and pushing at the end
of its turn. Either switch can still be turned off per project.

    write task applied ─► pending commit of exactly its files (window: 0 =
                          as soon as the task ends)
        ─► another applied task on the same project: its files fold in and
           the timer starts again
        ─► timer ends ─► checks ─► git.commit (explicit paths, --only, hooks
           run) with a `magi:` message
        ─► auto push on? ─► git.pull, which must come back clean
                         ─► git.push as the project's account, never forced
        ─► the console sees the pushed SHA on /projects/{id}/git and starts
           the Actions watch, as it does for a push you pressed

MAGI's own repository (A1) included. Its Stop hook commits everything at
the end of a Claude turn (`git add -A`); MAGI commits only the files it
applied (`--only`), so neither takes the other's work, and its push pulls
only when A1's tree is clean (a rebase under a live session's edits is what
sandbox.ENGINE_REPO's `pull: no` is about).

The checks are refusals, not repairs. A commit is not made -- and the line
says why -- when the repository is mid-merge/rebase, HEAD is detached, one of
the files is conflicted, or something ELSE is staged: `--only` would keep it
out of the commit, but staged work you did not mention is a sign someone is
in the middle of something, and MAGI committing around them is exactly the
collision this phase must not cause.

MAGI performs every git call itself, through git.py: no new git code paths,
and an agent never gets git or a token. In memory, like tasks: a pending
commit does not survive an engine restart -- the files stay applied and
uncommitted, which is what they were before the timer.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from . import git as G

PREFIX = "magi: "        # distinct from the hook's `auto:` and `auto: claude code`
DEFAULT_WINDOW_MIN = 0
BUSY_RETRY = 30          # seconds: a write task still running on the project
LAST_SHOWN = 30 * 60     # how long an outcome stays on the repository line
MINUTE = 60              # seconds in a window minute (tests shrink it)


@dataclass
class Pending:
    project_id: str
    top: str
    files: list[str] = field(default_factory=list)
    drafts: list[str] = field(default_factory=list)
    tasks: list[str] = field(default_factory=list)
    due: float = 0.0
    state: str = "waiting"          # waiting | committing | pushing
    # A refusal you can fix (something else staged, a rebase in progress):
    # the commit stays pending, untimed, for Commit now or Cancel.
    blocked: str = ""
    timer: asyncio.TimerHandle | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"files": list(self.files), "tasks": list(self.tasks),
                "due": self.due if self.timer is not None else None,
                "state": self.state, "blocked": self.blocked,
                "message": message(self.drafts)}


PENDING: dict[str, Pending] = {}
LAST: dict[str, dict[str, Any]] = {}


# ── what the project allows ───────────────────────────────────────────────

def _engine_repo(top: Path) -> bool:
    from .sandbox import is_engine_repo
    return is_engine_repo(top)


def guard_prefs(prefs: dict[str, Any], root: Path | None = None) -> dict[str, Any]:
    """Prefs as stored: auto push needs auto commit; the window is 0-30
    minutes (0 = as soon as the task ends). `root` is unused since A1 stopped
    being special (2026-10-08); callers still pass it."""
    out = dict(prefs)
    out["autoCommit"] = bool(out.get("autoCommit"))
    out["autoPush"] = bool(out.get("autoPush")) and out["autoCommit"]
    w = out.get("batchWindowMin")
    try:
        w = DEFAULT_WINDOW_MIN if w is None or w == "" or isinstance(w, bool) else int(w)
    except (TypeError, ValueError):
        w = DEFAULT_WINDOW_MIN
    out["batchWindowMin"] = max(0, min(30, w))
    return out


# Where a project's prefs are read from: routes.py points this at the
# database when it loads. Unset (a test, a script), every project reads as
# auto commit off -- the safe answer.
prefs_source: Callable[[str], Awaitable[dict[str, Any] | None]] | None = None


async def _prefs(project_id: str) -> dict[str, Any] | None:
    """The project's prefs NOW, not when the task started: a switch turned
    off while a task ran is off."""
    if prefs_source is None:
        return None
    try:
        return await prefs_source(project_id)
    except Exception:  # noqa: BLE001 -- unreadable prefs mean off, never on
        return None


# ── the message ───────────────────────────────────────────────────────────

def message(drafts: list[str]) -> str:
    """`magi: <what you asked>`, with what the agent said it did below.

    Several tasks folded into one commit: the first ask is the subject, and
    every ask is listed in the body -- one logical change, told whole."""
    ds = [d for d in drafts if (d or "").strip()]
    if not ds:
        return PREFIX + "Changes made in MAGI Code Mode"
    subj = [d.strip().splitlines()[0].strip() for d in ds]
    if len(ds) == 1:
        head, _, body = ds[0].strip().partition("\n")
        return PREFIX + head.strip() + (("\n" + body) if body.strip() else "")
    more = len(ds) - 1
    return (PREFIX + subj[0] + f" (+{more} more)\n\n"
            + "\n".join(f"- {s}" for s in subj))


# ── scheduling ────────────────────────────────────────────────────────────

def _running_write(project_id: str, mine: list[str] = ()) -> bool:
    """A write task on the project is still running -- not counting the
    ones this commit is for (`mine`): a 0-minute window fires while the task
    that applied is finishing, and waiting for ITSELF would add 30 s."""
    from . import tasks as T
    return any(t.project_id == project_id and t.mode == "write" and not t.done
               and t.id not in mine for t in T.TASKS.values())


async def on_applied(*, project_id: str, repo: str, files: list[str], draft: str,
                     task_id: str) -> dict[str, Any] | None:
    """A write task's files reached the folder. Schedule (or extend) the
    project's pending commit, if auto commit is on. Returns the pending
    commit, or None when auto commit is off here."""
    prefs = await _prefs(project_id)
    top = Path(repo)
    loop = asyncio.get_running_loop()
    prefs = guard_prefs(prefs or {}, None)
    if not prefs["autoCommit"]:
        return None
    # One already committing is left to finish: these files wait in the
    # NEXT pending commit rather than joining one that has started. Its
    # timer is armed when the current one is done (fire's finally).
    cur = PENDING.get(project_id)
    behind = cur is not None and cur.state != "waiting"
    key = f"{project_id}#next" if behind else project_id
    p = PENDING.get(key)
    if p is None:
        p = PENDING[key] = Pending(project_id=project_id, top=str(top))
    for f in files:
        if f not in p.files:
            p.files.append(f)
    p.drafts.append(draft)
    p.tasks.append(task_id)
    p.blocked = ""
    _arm(p, prefs["batchWindowMin"] * MINUTE, start=not behind)
    return p.to_dict()


def _arm(p: Pending, delay: float, *, start: bool = True) -> None:
    if p.timer is not None:
        p.timer.cancel()
        p.timer = None
    p.due = time.time() + delay
    if start:
        loop = asyncio.get_running_loop()
        p.timer = loop.call_later(delay, lambda: asyncio.ensure_future(fire(p.project_id)))


def cancel(project_id: str) -> bool:
    """Drop the pending commit. The files stay applied and uncommitted."""
    p = PENDING.get(project_id)
    if p is None or p.state != "waiting":
        return False
    if p.timer is not None:
        p.timer.cancel()
    PENDING.pop(project_id, None)
    _promote(project_id)
    _note(project_id, ok=False, code="cancelled",
          text=f"Auto commit cancelled; {_files(p.files)} left uncommitted.")
    return True


def _promote(project_id: str) -> None:
    """The pending commit that waited behind one in flight takes its place,
    and its timer starts for whatever is left of its window."""
    nxt = PENDING.pop(f"{project_id}#next", None)
    if nxt is not None:
        PENDING[project_id] = nxt
        _arm(nxt, max(1.0, nxt.due - time.time()))


def _files(fs: list[str]) -> str:
    return f"{len(fs)} file{'' if len(fs) == 1 else 's'}"


def _note(project_id: str, **kw: Any) -> dict[str, Any]:
    LAST[project_id] = {"at": time.time(), **kw}
    return LAST[project_id]


# ── firing ────────────────────────────────────────────────────────────────

async def fire(project_id: str, *, now: bool = False) -> dict[str, Any] | None:
    """The timer ran out (or you pressed Commit now): check, commit, maybe
    push. Every outcome, good or refused, lands in LAST for the line."""
    p = PENDING.get(project_id)
    if p is None or p.state != "waiting":
        return None
    if p.timer is not None:
        p.timer.cancel()
        p.timer = None
    if not now and _running_write(project_id, p.tasks):
        # A follow-up is being worked on; it will fold in when it applies.
        _arm(p, BUSY_RETRY)
        return None
    prefs = guard_prefs(await _prefs(project_id) or {}, None)
    if not prefs["autoCommit"]:
        PENDING.pop(project_id, None)
        _promote(project_id)
        return _note(project_id, ok=False, code="off",
                     text=f"Auto commit was switched off; {_files(p.files)} left uncommitted.")
    login = str(prefs.get("github") or "")
    loop = asyncio.get_running_loop()
    p.state = "committing"
    keep = False
    try:
        out = await loop.run_in_executor(None, _commit, p)
        keep = out.get("code") in FIXABLE
        if out.get("ok") and prefs["autoPush"]:
            p.state = "pushing"
            out = await loop.run_in_executor(None, _push, p, out, login)
    except Exception as exc:  # noqa: BLE001 -- the line must say something, not stall
        out = {"ok": False, "code": "error", "text": f"Auto commit failed: {type(exc).__name__}: {exc}"}
    finally:
        p.state = "waiting"
        if keep:
            p.blocked = out["text"]
            # Anything applied meanwhile joins it: still one logical change.
            nxt = PENDING.pop(f"{project_id}#next", None)
            if nxt is not None:
                p.files += [f for f in nxt.files if f not in p.files]
                p.drafts += nxt.drafts
                p.tasks += nxt.tasks
        else:
            PENDING.pop(project_id, None)
            _promote(project_id)
    out["files"] = list(p.files)
    out["tasks"] = list(p.tasks)
    return _note(project_id, **out)


# Refusals you can clear yourself; the commit waits for Commit now.
FIXABLE = {"in_progress", "detached", "conflicts", "staged"}


def check(top: Path, files: list[str]) -> tuple[str, str]:
    """("", "") when an auto commit of `files` may go ahead; otherwise
    (code, sentence). The refusals from the module docstring."""
    st = G.status(top)
    if st.state:
        return "in_progress", (f"Not auto-committed: the repository is in the middle of a "
                               f"{st.state}. Finish or abort it; the files stay applied.")
    if st.detached:
        return "detached", "Not auto-committed: HEAD is detached. Check out a branch first."
    mine = {f.replace("\\", "/") for f in files}
    clash = [c for c in st.conflicts if c in mine]
    if clash:
        return "conflicts", f"Not auto-committed: {', '.join(clash[:4])} has conflicts."
    other = sorted({e.path for e in st.entries if e.staged} - mine)
    if other:
        return "staged", (f"Not auto-committed: {_files(other)} you staged yourself "
                          f"({', '.join(other[:3])}{'…' if len(other) > 3 else ''}) "
                          "would sit beside it. Commit or unstage them, then Commit now.")
    return "", ""


def _commit(p: Pending) -> dict[str, Any]:
    top = Path(p.top)
    code, why = check(top, p.files)
    if code:
        return {"ok": False, "code": code, "text": why}
    try:
        c = G.commit(top, p.files, message(p.drafts))
    except G.GitError as e:
        if e.code == "nothing":
            return {"ok": False, "code": "nothing",
                    "text": "Nothing to auto-commit: these files already match the last commit."}
        return {"ok": False, "code": e.code, "text": f"Not auto-committed: {e.message}"}
    return {"ok": True, "code": "committed", "commit": c.to_dict(),
            "text": f"Auto-committed {c.sha[:7]} ({_files(c.files)})."}


def _push(p: Pending, done: dict[str, Any], login: str) -> dict[str, Any]:
    """Pull, and only on a clean pull, push. Never forced.

    As the project's GitHub account; with none chosen, as this PC's own git
    login, the way Claude Code's Stop hook pushes (auto push only -- the
    Push button still asks for an account). In A1 the pull happens only
    when the tree is clean: other sessions' uncommitted edits are never
    autostashed under them; a push refused as behind then waits for the
    next one."""
    from .tasks import git_auth
    top = Path(p.top)
    auth = git_auth(login)
    head = done["text"]
    if _engine_repo(top) and G.status(top).entries:
        pl = G.Pull(True, skipped=True, text="A1 has uncommitted work; not pulled.")
    else:
        try:
            pl = G.pull(top, auth)
        except G.GitError as e:
            pl = G.Pull(False, text=e.message)
    if not pl.ok:
        return {**done, "push": {"ok": False, "code": "pull_failed", "text": pl.text},
                "text": f"{head} Not pushed: {pl.text}"}
    try:
        res = G.push(top, auth, machine=True)
    except G.GitError as e:
        res = G.Push(False, e.code, e.message)
    d = res.to_dict()
    return {**done, "pull": pl.to_dict(), "push": d,
            "text": f"{head} {res.text}" if res.ok else f"{head} Not pushed: {res.text}"}


# ── what the console reads ────────────────────────────────────────────────

def view(project_id: str, prefs: dict[str, Any]) -> dict[str, Any]:
    """The `auto` block of /projects/{id}/git."""
    g = guard_prefs(prefs or {}, None)
    p = PENDING.get(project_id)
    last = LAST.get(project_id)
    if last and time.time() - last["at"] > LAST_SHOWN:
        last = None
    return {"commit": g["autoCommit"], "push": g["autoPush"], "window": g["batchWindowMin"],
            "pending": p.to_dict() if p else None, "last": last}


def forget_task(project_id: str, task_id: str, files: list[str]) -> None:
    """A task you committed by hand leaves the pending auto commit; one left
    with no task is dropped without a word (there is nothing left to say)."""
    for key in (project_id, f"{project_id}#next"):
        p = PENDING.get(key)
        if p is None or p.state != "waiting" or task_id not in p.tasks:
            continue
        i = p.tasks.index(task_id)
        p.tasks.pop(i)
        if i < len(p.drafts):
            p.drafts.pop(i)
        gone = set(files)
        p.files = [f for f in p.files if f not in gone]
        if not p.tasks or not p.files:
            if p.timer is not None:
                p.timer.cancel()
            PENDING.pop(key, None)
            if key == project_id:
                _promote(project_id)
