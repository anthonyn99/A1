"""Code Mode tasks: run the chain in the background, stream it to any viewer.

Same shape as a council run in app.py -- POST starts it, GET streams it, POST
cancels it -- with one deliberate difference. A council run has one queue and
therefore one reader: a second console attaching would steal half the events
from the first. A Code Mode task keeps every event in a log and gives each
viewer its own queue, so the desk and the phone can watch the same task, a
reconnecting console gets the whole transcript replayed, and -- from Phase 8 --
an approval can be answered from whichever device you are holding.

In-memory, like council runs: a task does not survive an engine restart, and
the runner says so rather than leaving a task looking busy forever.

Every task starts with a pull (Phase 9, git.py): an answer about stale code
is a wrong answer, and an edit made on stale code is a conflict waiting to
happen. A pull that cannot finish cleanly is undone and stops the task.
MAGI's own repository is only fetched, never pulled: its working tree is the
one other sessions are editing.

Write mode (Phase 8) wraps the chain in a sandbox (sandbox.py):

    copy the workspace ─► chain edits the copy ─► diff ─► security.review
        ─► approval card (5 min; silence = deny; first device to answer wins)
        -- or, in Auto, no card: applied at once (below)
        ─► apply onto the real folder ─► remove the copy, always
        ─► (only if you press it) commit exactly the applied files

A refused diff never reaches the card, and nothing reaches the real folder
without an explicit Approve. Nothing is committed without a second, separate
press, and nothing is pushed without a third (Phase 10): Push, as the GitHub
account the project names, never forced.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import git as G
from . import autocommit, followup, sandbox, security
from .agents import chain, inventory
from .agents.base import Mode, Outcome, Task

MAX_EVENTS = 4000        # a long task's transcript, capped so memory is bounded
KEEP_FINISHED = 40       # finished tasks kept for reattaching, newest first
APPROVAL_TIMEOUT = 300   # seconds; no answer is a No


@dataclass
class TaskState:
    id: str
    project_id: str
    prompt: str
    mode: str
    started: float = field(default_factory=time.time)
    done: bool = False
    result: dict[str, Any] | None = None
    events: list[dict[str, Any]] = field(default_factory=list)
    root: str = ""
    sandbox_root: str = ""
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    viewers: set[asyncio.Queue] = field(default_factory=set)
    # Write mode: resolved True/False by POST /approve, from any device.
    approval: asyncio.Future | None = None
    approval_deadline: float = 0.0
    repo: str = ""            # the repository top the change was applied to
    committing: bool = False
    github: str = ""          # the GitHub login this project pushes/pulls as
    pushing: bool = False
    attachments: list[tuple[str, str]] = field(default_factory=list)
    images: list = field(default_factory=list)   # [agents.base.Image]
    # The project's check command (check.py), fixed when the task starts.
    check_cfg: dict[str, Any] = field(default_factory=dict)
    check_cwd: str = ""       # the copy's workspace folder, while the card is up
    check_job: asyncio.Task | None = None
    check_stop: asyncio.Event = field(default_factory=asyncio.Event)
    check_result: dict[str, Any] | None = None
    # "manual": the diff waits on the approval card. "auto": a diff that
    # passes security.review (and the project's automatic check, if it has
    # one) is applied without asking. Everything review REFUSES stays
    # refused in both -- Auto skips the question, never the rules.
    approve: str = "manual"
    # Track F (F3): the session this task is a turn of (its own id on turn
    # 1), and the messages typed while it runs (followup.Steer).
    session_id: str = ""
    turn: int = 1
    steer: followup.Steer = field(default_factory=followup.Steer)
    # A revision asked for at the card, until the chain runs again: more
    # messages in that gap join the same revision.
    revising: bool = False

    @property
    def checking(self) -> bool:
        return self.check_job is not None and not self.check_job.done()

    @property
    def awaiting_approval(self) -> bool:
        return self.approval is not None and not self.approval.done()

    def summary(self) -> dict[str, Any]:
        return {"id": self.id, "project_id": self.project_id,
                "prompt": self.prompt[:200], "mode": self.mode,
                "started": self.started, "done": self.done,
                "awaiting_approval": self.awaiting_approval,
                "checking": self.checking,
                "outcome": (self.result or {}).get("outcome"),
                "write": (self.result or {}).get("write"),
                "by": (self.result or {}).get("by_label"),
                "attachments": [n for n, _ in self.attachments] + [im.name for im in self.images],
                "approve": self.approve,
                "session_id": self.session_id or self.id, "turn": self.turn}


TASKS: dict[str, TaskState] = {}


def _rel(target: str, root: str) -> str:
    # Both sides to forward slashes first: agents report either separator
    # (Claude backslashes, Codex forward), and a root in one form never
    # prefix-matched a target in the other. The trailing "/" on the prefix is
    # what stops "A1" matching "A1-other".
    t = target.replace("\\", "/")
    r = root.replace("\\", "/").rstrip("/")
    if t.lower() == r.lower():
        return "."
    if t.lower().startswith(r.lower() + "/"):
        return t[len(r) + 1:]
    return target


def running() -> list[TaskState]:
    return [t for t in TASKS.values() if not t.done]


async def publish(t: TaskState, ev: dict[str, Any]) -> None:
    ev = {**ev, "t": round(time.time() - t.started, 2)}
    # "magi/cli/serve.py", not "C:\\Users\\...\\magi\\cli\\serve.py": the
    # workspace is already on screen, and the absolute path is a phone-width
    # of prefix in front of the one part you are reading for.
    # The sandbox first: in write mode the agent reports paths in the copy,
    # which you want to read as the same path in your project.
    for base in (t.sandbox_root, t.root):
        if base and isinstance(ev.get("target"), str):
            ev["target"] = _rel(ev["target"], base)
    if len(t.events) < MAX_EVENTS:
        t.events.append(ev)
    for q in list(t.viewers):
        q.put_nowait(ev)


def _prune() -> None:
    done = sorted((t for t in TASKS.values() if t.done), key=lambda t: t.started)
    for t in done[:-KEEP_FINISHED]:
        TASKS.pop(t.id, None)


async def start(*, project_id: str, root: Path, prompt: str, order: list[str],
                settings, mode: str = "read", github: str = "",
                attachments: list[tuple[str, str]] | None = None,
                images: list | None = None,
                check: dict[str, Any] | None = None,
                approve: str = "manual",
                session: followup.Session | None = None) -> TaskState:
    t = TaskState(id=uuid.uuid4().hex[:12], project_id=project_id,
                  prompt=prompt, mode=mode, root=str(root), github=github,
                  attachments=list(attachments or []), images=list(images or []),
                  check_cfg=dict(check or {}) if mode == "write" else {},
                  approve="auto" if approve == "auto" else "manual")
    t.session_id = session.id if session else t.id
    t.turn = session.turn if session else 1
    TASKS[t.id] = t
    _prune()

    agents = chain.expand(order, settings)
    loop = asyncio.get_running_loop()

    async def emit(ev):
        await publish(t, ev)

    async def work():
        sb: sandbox.Sandbox | None = None
        try:
            await publish(t, {"k": "start", "prompt": prompt, "mode": mode,
                              "approve": t.approve,
                              "session_id": t.session_id, "turn": t.turn,
                              "attachments": [n for n, _ in t.attachments] + [im.name for im in t.images],
                              "chain": [{"id": a.id, "label": a.label, "kind": a.kind}
                                        for a in agents]})
            pulled = await _pull_first(t, root)
            if not pulled.ok:
                t.result = {"outcome": "pull_failed", "text": "", "detail": pulled.text,
                            "conflicts": pulled.conflicts, "attempts": []}
                return
            if mode == "write":
                await emit({"k": "note", "text": "Making a private copy of the workspace…"})
                try:
                    sb = await loop.run_in_executor(
                        None, sandbox.create, root, t.id, _profile())
                except sandbox.SandboxError as e:
                    await emit({"k": "error", "text": e.message})
                    t.result = {"outcome": "unavailable", "text": "", "write": "refused",
                                "detail": e.message, "attempts": []}
                    return
                t.sandbox_root = str(sb.cwd)
                extra = f", plus {sb.copied} untracked file(s)" if sb.copied else ""
                await emit({"k": "note", "text": "Agents edit the copy; your folder is not "
                            f"touched unless you approve the diff (copy includes your "
                            f"uncommitted edits{extra})."})
            mcp = await loop.run_in_executor(None, write_mcp_config, t.id, project_id,
                                             root, github)
            # A question about sizes or rankings: measured here, handed over
            # (inventory.py). From the real folder, which the copy mirrors.
            inv = ""
            if inventory.wants(prompt):
                inv = await loop.run_in_executor(None, lambda: inventory.block(root, prompt=prompt))
                if inv:
                    n = inv.split("TOTAL: ", 1)[-1].split(" files", 1)[0]
                    await emit({"k": "tool", "name": "Inventory",
                                "target": f"{n} files measured by MAGI"})
            task = Task(id=t.id, prompt=prompt, root=sb.cwd if sb else root,
                        mode=Mode.WRITE if sb else Mode.READ,
                        progress=sb.changed_files if sb else None, mcp_config=mcp,
                        attachments=t.attachments, images=t.images, inventory=inv)
            if session is not None:
                task.session_turns = session.turns
                task.state_note = followup.state_note(session.turns)
                own = next((a for a in agents if a.id == session.native.get("agent")), None)
                if own is not None:
                    task.resume = {**session.native, "why": "followup"}
                    await emit({"k": "note", "text": f"{own.label} continues its own session "
                                "from the last turn."})
            res = await chain.run_chain(task, agents, emit=emit, cancel=t.cancel, steer=t.steer)
            t.result = res.to_dict()
            while sb is not None:
                if res.outcome == Outcome.OK and not t.cancel.is_set():
                    out = await _review_and_apply(t, sb)
                    if out.get("write") == "revised" and not t.cancel.is_set():
                        res = await _revise(t, task, agents, res, sb, emit)
                        t.result = res.to_dict()
                        continue
                    t.result.update(out)
                else:
                    t.result["write"] = "discarded"
                    if await loop.run_in_executor(None, sb.changed_files):
                        await emit({"k": "note", "text": "The task did not finish, so its "
                                    "partial edits were discarded. Your folder is unchanged."})
                break
        except Exception as exc:  # noqa: BLE001 -- the transcript must end, not hang
            t.result = {"outcome": "unavailable", "text": "",
                        "detail": f"{type(exc).__name__}: {exc}", "attempts": []}
        finally:
            # From here on a message is the next follow-up -- and one that
            # never reached an agent (typed during the pull, or just before a
            # Halt or a failure) goes back to the console to send as one.
            t.steer.close()
            t.revising = False
            left = t.steer.take()
            if left:
                t.result = {**(t.result or {}), "unsent_messages": left}
            if t.approval is not None and not t.approval.done():
                t.approval.cancel()
            # A check still running is running IN the copy about to be
            # removed: stop it, and let it take its dependency links down,
            # before anything deletes that folder.
            await _stop_check(t)
            if sb is not None:
                await loop.run_in_executor(None, sb.remove)
            _mcp_path(t.id).unlink(missing_ok=True)
            t.done = True
            await publish(t, {"k": "end", "result": t.result})
            for q in list(t.viewers):
                q.put_nowait(None)

    asyncio.create_task(work())
    return t


async def _pull_first(t: TaskState, root: Path) -> G.Pull:
    """The §7A rule: pull before anything reads the folder, and say so."""
    loop = asyncio.get_running_loop()
    pull = await loop.run_in_executor(None, sandbox.engine_repo_allows, root, "pull")
    auth = await loop.run_in_executor(None, git_auth, t.github)
    try:
        p = await loop.run_in_executor(None, G.pull if pull else G.fetch_only, root, auth)
    except G.GitError as e:
        p = G.Pull(False, text=f"Could not pull: {e.message}")
    await publish(t, {"k": "pull", **p.to_dict()})
    return p


def _mcp_path(task_id: str) -> Path:
    from ..settings import data_dir
    return data_dir() / "code" / "mcp" / f"{task_id}.json"


def write_mcp_config(task_id: str, project_id: str, root: Path, login: str) -> Path | None:
    """The --mcp-config that gives the Claude CLI read-only GitHub tools for
    this project -- only when the folder's remote is on GitHub and the
    project names an account to read it as. The file names a script, a port
    and a project id; nothing in it is a secret. Removed when the task ends.
    """
    if not login:
        return None
    try:
        top = G.toplevel(root)
        remote = G.github_of(top) if top else {}
    except G.GitError:
        return None
    if remote.get("host") != "github.com" or not remote.get("owner"):
        return None
    import json
    import sys
    from .. import ident
    from .agents.claude_cli import MCP_SERVER
    exe = Path(sys.executable)
    # pythonw where there is one: no console window flashes up when the CLI
    # starts the server, and stdio pipes work the same.
    quiet = exe.with_name("pythonw.exe")
    script = Path(__file__).resolve().parents[1] / "github" / "mcp_server.py"
    port = int(ident.engine_identity().get("port") or 8000)
    cfg = {"mcpServers": {MCP_SERVER: {
        "type": "stdio", "command": str(quiet if quiet.exists() else exe),
        "args": ["-I", str(script), "--port", str(port), "--project", project_id]}}}
    f = _mcp_path(task_id)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    return f


def _profile() -> str:
    from ..settings import active_profile
    return active_profile()


async def _review_and_apply(t: TaskState, sb: sandbox.Sandbox) -> dict[str, Any]:
    """Diff the copy, check it, ask, apply. Returns fields for the result."""
    loop = asyncio.get_running_loop()
    patch = await loop.run_in_executor(None, sb.diff)
    if not patch:
        await publish(t, {"k": "nochange", "text": "The agent made no changes."})
        return {"write": "none"}

    # Checked against the REAL repository: a link that is harmless in the
    # copy may point out of the folder the change is about to be applied to.
    rv = await loop.run_in_executor(
        None, lambda: security.review(patch.decode("utf-8", "replace"),
                                      root=sb.repo, prefix=sb.prefix,
                                      deny=sandbox.review_deny(sb.repo)))
    if not rv.ok:
        await publish(t, {"k": "refused", "text": rv.message,
                          "refused": [{"path": p, "why": w} for p, w in rv.refused]})
        return {"write": "refused", "detail": rv.message}

    # The check command (check.py). Automatic: it runs now, before the card,
    # so the card opens with the result on it and its clock starts after.
    # Otherwise the card offers Run check once you have seen the diff.
    t.check_cwd = str(sb.cwd)
    if t.check_cfg.get("command") and t.check_cfg.get("auto"):
        t.check_job = asyncio.ensure_future(_run_check(t))
        stopper = asyncio.ensure_future(t.cancel.wait())
        try:
            await asyncio.wait({t.check_job, stopper}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            stopper.cancel()
        if t.cancel.is_set():
            await _stop_check(t)
            await publish(t, {"k": "decision", "approved": False, "why": "halted"})
            return {"write": "halted"}

    # Auto: no card. But a check that ran and FAILED is exactly the "key
    # change" Manual exists for, so that one still asks.
    failed_check = t.check_result is not None and not t.check_result.get("ok")
    if t.approve == "auto" and not failed_check:
        await publish(t, {"k": "decision", "approved": True, "why": "auto",
                          "files": [f.to_dict() for f in rv.files],
                          "adds": sum(f.adds for f in rv.files),
                          "dels": sum(f.dels for f in rv.files)})
        return await _apply(t, sb, rv)
    if t.approve == "auto":
        await publish(t, {"k": "note", "text": "Auto mode, but the check failed — "
                          "asking before anything is applied."})

    t.approval = loop.create_future()
    t.approval_deadline = time.time() + APPROVAL_TIMEOUT
    # A change to the engine's own code does nothing until it restarts -- and
    # a bad one can stop it starting. Said on the card; never restarted here.
    # And in A1 everything approved SHIPS within minutes (its auto-commit
    # pushes), some of it as a deploy: the card says which.
    own = await loop.run_in_executor(None, sandbox.is_engine_repo, sb.repo)
    paths = [f.path.replace("\\", "/") for f in rv.files]
    a1 = {"ships": True,
          "engine_files": [p for p in paths if p.startswith("magi/")],
          "deploy_files": [p for p in paths if p.startswith(sandbox.ENGINE_REPO_DEPLOYS)]} \
        if own else {}
    await publish(t, {"k": "approval", "files": [f.to_dict() for f in rv.files], **a1,
                      "adds": sum(f.adds for f in rv.files),
                      "dels": sum(f.dels for f in rv.files),
                      "expires_at": t.approval_deadline,
                      "timeout": APPROVAL_TIMEOUT,
                      **({"check": {"command": t.check_cfg["command"],
                                    "auto": bool(t.check_cfg.get("auto")),
                                    "timeout_min": t.check_cfg.get("timeout_min")}}
                         if t.check_cfg.get("command") else {})})

    # The deadline can MOVE: a check started from the card holds the clock
    # while it runs and gives a full window back when it ends (_run_check).
    # So the wait is re-armed against whatever the deadline is now, rather
    # than one fixed timeout.
    halt = asyncio.ensure_future(t.cancel.wait())
    done: set = set()
    try:
        while True:
            left = t.approval_deadline - time.time()
            if left <= 0:
                break
            done, _ = await asyncio.wait({t.approval, halt}, timeout=min(left, 5.0),
                                         return_when=asyncio.FIRST_COMPLETED)
            if done:
                break
    finally:
        halt.cancel()
    if t.approval in done and not t.approval.cancelled() and t.approval.result() == REVISE:
        # A message typed at the card: nothing is applied, the same agent
        # revises in this same copy, and a new card follows (_revise).
        await publish(t, {"k": "decision", "approved": False, "why": "revised"})
        await _stop_check(t)
        t.approval = None
        t.check_result = None
        return {"write": "revised"}
    if t.approval in done and not t.approval.cancelled():
        approved, why = bool(t.approval.result()), ("approved" if t.approval.result() else "denied")
    else:
        why = "halted" if t.cancel.is_set() else "timeout"
        approved = False
        if not t.approval.done():
            t.approval.cancel()
    await publish(t, {"k": "decision", "approved": approved, "why": why})
    # Answered while a check was still going: the answer stands, the check
    # has nothing left to inform.
    await _stop_check(t)
    if not approved:
        return {"write": why}
    return await _apply(t, sb, rv)


async def _revise(t: TaskState, task: Task, agents: list, res: chain.ChainResult,
                  sb: sandbox.Sandbox, emit) -> chain.ChainResult:
    """Run the chain again for a revision asked for at the card: the agent
    that made the diff first -- its own session resumed when it has one --
    in the same copy, so its edits are still there to change."""
    msgs = t.steer.take()
    t.steer.reopen()
    t.revising = False
    by = next((a for a in agents if a.id == res.by), None)
    changed = await asyncio.get_running_loop().run_in_executor(None, sb.changed_files)
    if by is not None:
        chain.prepare_continuation(task, by, said=res.text, sid=res.session_id,
                                   msgs=msgs, why="revise", changed=changed)
    else:
        task.added += msgs
    await emit({"k": "note", "text": "Revising the diff with your message…"})
    order = ([by] if by else []) + [a for a in agents if a is not by]
    again = await chain.run_chain(task, order, emit=emit, cancel=t.cancel, steer=t.steer)
    again.attempts = res.attempts + again.attempts
    return again


# What POST /message resolves the approval future with (never a bool).
REVISE = "revise"


async def message(t: TaskState, text: str) -> dict[str, Any]:
    """A message typed while the task runs (POST /tasks/{id}/message).

    Where it goes depends on where the task is, decided with no await in
    between, so it lands in exactly one place:
      prompt       nothing running yet -- the next agent's prompt has it
      interrupt    a CLI agent is working -- stopped, then resumed with it
      after_reply  a browser unit is working -- sent after its reply
      revise       the approval card is up -- nothing applied, same agent
                   revises, a new card
      followup     applying, committing, ended -- the console sends it as
                   the next turn
    """
    try:
        if t.done or not (t.steer.open or t.awaiting_approval or t.revising):
            text = followup.Steer.check_text(text)
            how = "followup"
        elif t.awaiting_approval or t.revising:
            text = t.steer.hold(text)
            how = REVISE
            if t.awaiting_approval:
                t.revising = True
                t.approval.set_result(REVISE)
        else:
            how = t.steer.add(text)
            text = t.steer.pending[-1]
    except OverflowError as e:
        return {"ok": False, "error": "too_many", "message": str(e)}
    except ValueError as e:
        return {"ok": False, "error": "bad_message", "message": str(e)}
    await publish(t, {"k": "user", "text": text, "how": how})
    return {"ok": True, "accepted": how}


async def _apply(t: TaskState, sb: sandbox.Sandbox, rv) -> dict[str, Any]:
    """Apply an approved (or Auto) diff to the real folder."""
    loop = asyncio.get_running_loop()
    from ..settings import data_dir
    files = [f.to_dict() for f in rv.files]
    res = await loop.run_in_executor(
        None, sandbox.apply, sb, files, sandbox.patch_dir(data_dir()))
    if res.ok:
        t.repo = str(sb.repo)
        draft = G.draft_message(t.prompt, (t.result or {}).get("text", ""))
        # A1 (Phase 14b): applied, and left for its Stop hook to commit.
        hook = not await loop.run_in_executor(None, sandbox.engine_repo_allows, sb.repo, "commit")
        await publish(t, {"k": "applied", "files": res.files, "how": res.how,
                          "draft": draft, **({"by_hook": True} if hook else {})})
        out = {"write": "applied", "files": res.files, "draft": draft}
        # Phase 12: where auto commit is on, the commit is MAGI's to make
        # after the project's window -- the stream says when.
        pend = await autocommit.on_applied(project_id=t.project_id, repo=t.repo,
                                           files=res.files, draft=draft, task_id=t.id)
        if pend is not None:
            out["auto"] = pend
            await publish(t, {"k": "autocommit", **pend})
        return out
    if res.how == "refused":
        # Refused at approval time (sandbox.apply re-reviews): nothing written.
        await publish(t, {"k": "refused", "text": res.message,
                          "refused": [{"path": p, "why": ""} for p in res.conflicts]})
        return {"write": "refused", "detail": res.message}
    await publish(t, {"k": "conflict", "text": res.message, "files": res.conflicts,
                      "saved": res.saved_patch})
    return {"write": "conflict", "detail": res.message, "saved": res.saved_patch}


async def _run_check(t: TaskState) -> dict[str, Any]:
    """Run the project's check in the copy and put the result on the card.

    While it runs the approval clock is HELD (the deadline pushed past the
    check's own timeout), and when it ends you get a full window again: a
    ten-minute suite must not use up the five minutes you had to read it."""
    from . import check as C
    cfg = t.check_cfg
    cmd = cfg.get("command") or ""
    timeout_s = int(cfg.get("timeout_min") or C.DEFAULT_TIMEOUT_MIN) * 60
    loop = asyncio.get_running_loop()
    t.check_stop = asyncio.Event()
    if t.approval is not None:
        t.approval_deadline = time.time() + timeout_s + APPROVAL_TIMEOUT
        await publish(t, {"k": "deadline", "expires_at": t.approval_deadline, "held": True})
    await publish(t, {"k": "check", "state": "running", "command": cmd,
                      "auto": bool(cfg.get("auto")), "timeout_min": cfg.get("timeout_min")})
    links = await loop.run_in_executor(None, C.link_deps, Path(t.root), Path(t.check_cwd))
    try:
        res = await C.run(cmd, Path(t.check_cwd), timeout_s, stop=t.check_stop)
    finally:
        await loop.run_in_executor(None, C.unlink_deps, links)
    res = {**res, "command": cmd, "linked": [p.name for p in links]}
    t.check_result = res
    await publish(t, {"k": "check", "state": "done", **res})
    if t.approval is not None and not t.approval.done():
        t.approval_deadline = time.time() + APPROVAL_TIMEOUT
        await publish(t, {"k": "deadline", "expires_at": t.approval_deadline, "held": False})
    return res


async def _stop_check(t: TaskState) -> None:
    if t.check_job is None:
        return
    if not t.check_job.done():
        t.check_stop.set()
    try:
        await asyncio.wait_for(asyncio.shield(t.check_job), 30)
    except (asyncio.TimeoutError, asyncio.CancelledError, Exception):  # noqa: BLE001
        pass


def start_check(t: TaskState) -> tuple[bool, str]:
    """Run check, pressed on the card. Only while the card is waiting, and
    one at a time. Run again after a result is allowed."""
    if not t.check_cfg.get("command"):
        return False, "This project has no check command."
    if not t.awaiting_approval or not t.check_cwd:
        return False, "The check runs while the approval card is waiting."
    if t.checking:
        return False, "The check is already running."
    t.check_job = asyncio.ensure_future(_run_check(t))
    return True, ""


def decide(t: TaskState, approve: bool) -> tuple[bool, str]:
    """Answer an approval. The first answer wins; later ones are told so."""
    if t.approval is None:
        return False, "This task is not waiting for an approval."
    if t.approval.done():
        return False, "Already answered."
    t.approval.set_result(bool(approve))
    return True, ""


async def commit(t: TaskState, message: str) -> dict[str, Any]:
    """Commit exactly the files this task applied. Once; never pushed.

    Only the applied paths are staged (git.commit uses `--only`), so anything
    else you had staged or changed stays out of it. The repository's own hooks
    run -- this is your commit, made on your behalf.
    """
    r = t.result or {}
    if not t.done or r.get("write") != "applied" or not t.repo:
        return {"ok": False, "error": "not_applied",
                "message": "Only a change that was applied to your folder can be committed."}
    if not await asyncio.get_running_loop().run_in_executor(
            None, sandbox.engine_repo_allows, Path(t.repo), "commit"):
        return {"ok": False, "error": "read_only_project",
                "message": sandbox.ENGINE_REPO_WHY["commit"]}
    if r.get("commit"):
        return {"ok": False, "error": "already", "message": "Already committed.",
                "commit": r["commit"]}
    if t.committing:
        return {"ok": False, "error": "busy", "message": "Already committing."}
    t.committing = True
    try:
        c = await asyncio.get_running_loop().run_in_executor(
            None, G.commit, Path(t.repo), list(r.get("files") or []), message)
    except G.GitError as e:
        return {"ok": False, "error": e.code, "message": e.message}
    finally:
        t.committing = False
    r["commit"] = c.to_dict()
    # Committed by hand: this task is no longer the pending auto commit's.
    autocommit.forget_task(t.project_id, t.id, c.files)
    await publish(t, {"k": "committed", **c.to_dict()})
    return {"ok": True, "commit": c.to_dict()}


def git_auth(login: str) -> G.Auth | None:
    """The git credential wiring for a GitHub login MAGI holds a token for,
    or None. Names only -- the token is read by askpass when git asks."""
    if not login:
        return None
    from ..github import accounts as A
    try:
        login = A.check_login(login)
        if not A.get(login):
            return None
    except A.AccountError:
        return None
    return G.Auth(login=login, service=A.service(login))


async def push(t: TaskState, login: str = "") -> dict[str, Any]:
    """Push the branch this task committed to. A third, separate press.

    As `login` if given (the console sends the project's account), else the
    project's. Never forced: a remote that moved on is a refusal that says
    to pull first.
    """
    r = t.result or {}
    if not r.get("commit") or not t.repo:
        return {"ok": False, "error": "not_committed",
                "message": "Commit the change first; only a commit can be pushed."}
    if (r.get("push") or {}).get("ok"):
        return {"ok": False, "error": "already", "message": "Already pushed.", "push": r["push"]}
    if not await asyncio.get_running_loop().run_in_executor(
            None, sandbox.engine_repo_allows, Path(t.repo), "push"):
        return {"ok": False, "error": "read_only_project",
                "message": sandbox.ENGINE_REPO_WHY["push"]}
    if t.pushing:
        return {"ok": False, "error": "busy", "message": "Already pushing."}
    t.pushing = True
    loop = asyncio.get_running_loop()
    try:
        auth = await loop.run_in_executor(None, git_auth, login or t.github)
        res = await loop.run_in_executor(None, G.push, Path(t.repo), auth)
    except G.GitError as e:
        res = G.Push(False, e.code, e.message)
    finally:
        t.pushing = False
    d = res.to_dict()
    if res.ok:
        r["push"] = d
        await publish(t, {"k": "pushed", **d})
    return {"ok": res.ok, "push": d,
            **({} if res.ok else {"error": res.code, "message": res.text})}


async def stream(t: TaskState):
    """Everything so far, then everything new, then stop."""
    q: asyncio.Queue = asyncio.Queue()
    for ev in list(t.events):
        q.put_nowait(ev)
    if t.done:
        q.put_nowait(None)
    else:
        t.viewers.add(q)
    try:
        while True:
            ev = await q.get()
            if ev is None:
                return
            yield ev
    finally:
        t.viewers.discard(q)
