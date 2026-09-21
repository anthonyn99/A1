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

Write mode (Phase 8) wraps the chain in a sandbox (sandbox.py):

    copy the workspace ─► chain edits the copy ─► diff ─► security.review
        ─► approval card (5 min; silence = deny; first device to answer wins)
        ─► apply onto the real folder ─► remove the copy, always

A refused diff never reaches the card, and nothing reaches the real folder
without an explicit Approve.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import sandbox, security
from .agents import chain
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

    @property
    def awaiting_approval(self) -> bool:
        return self.approval is not None and not self.approval.done()

    def summary(self) -> dict[str, Any]:
        return {"id": self.id, "project_id": self.project_id,
                "prompt": self.prompt[:200], "mode": self.mode,
                "started": self.started, "done": self.done,
                "awaiting_approval": self.awaiting_approval,
                "outcome": (self.result or {}).get("outcome"),
                "write": (self.result or {}).get("write"),
                "by": (self.result or {}).get("by_label")}


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
                settings, mode: str = "read") -> TaskState:
    t = TaskState(id=uuid.uuid4().hex[:12], project_id=project_id,
                  prompt=prompt, mode=mode, root=str(root))
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
                              "chain": [{"id": a.id, "label": a.label, "kind": a.kind}
                                        for a in agents]})
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
            task = Task(id=t.id, prompt=prompt, root=sb.cwd if sb else root,
                        mode=Mode.WRITE if sb else Mode.READ,
                        progress=sb.changed_files if sb else None)
            res = await chain.run_chain(task, agents, emit=emit, cancel=t.cancel)
            t.result = res.to_dict()
            if sb is not None:
                if res.outcome == Outcome.OK and not t.cancel.is_set():
                    t.result.update(await _review_and_apply(t, sb))
                else:
                    t.result["write"] = "discarded"
                    if await loop.run_in_executor(None, sb.changed_files):
                        await emit({"k": "note", "text": "The task did not finish, so its "
                                    "partial edits were discarded. Your folder is unchanged."})
        except Exception as exc:  # noqa: BLE001 -- the transcript must end, not hang
            t.result = {"outcome": "unavailable", "text": "",
                        "detail": f"{type(exc).__name__}: {exc}", "attempts": []}
        finally:
            if t.approval is not None and not t.approval.done():
                t.approval.cancel()
            if sb is not None:
                await loop.run_in_executor(None, sb.remove)
            t.done = True
            await publish(t, {"k": "end", "result": t.result})
            for q in list(t.viewers):
                q.put_nowait(None)

    asyncio.create_task(work())
    return t


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
                                      root=sb.repo, prefix=sb.prefix))
    if not rv.ok:
        await publish(t, {"k": "refused", "text": rv.message,
                          "refused": [{"path": p, "why": w} for p, w in rv.refused]})
        return {"write": "refused", "detail": rv.message}

    t.approval = loop.create_future()
    t.approval_deadline = time.time() + APPROVAL_TIMEOUT
    await publish(t, {"k": "approval", "files": [f.to_dict() for f in rv.files],
                      "adds": sum(f.adds for f in rv.files),
                      "dels": sum(f.dels for f in rv.files),
                      "expires_at": t.approval_deadline,
                      "timeout": APPROVAL_TIMEOUT})

    halt = asyncio.ensure_future(t.cancel.wait())
    try:
        done, _ = await asyncio.wait({t.approval, halt}, timeout=APPROVAL_TIMEOUT,
                                     return_when=asyncio.FIRST_COMPLETED)
    finally:
        halt.cancel()
    if t.approval in done and not t.approval.cancelled():
        approved, why = bool(t.approval.result()), ("approved" if t.approval.result() else "denied")
    else:
        why = "halted" if t.cancel.is_set() else "timeout"
        approved = False
        if not t.approval.done():
            t.approval.cancel()
    await publish(t, {"k": "decision", "approved": approved, "why": why})
    if not approved:
        return {"write": why}

    from ..settings import data_dir
    files = [f.to_dict() for f in rv.files]
    res = await loop.run_in_executor(
        None, sandbox.apply, sb, files, sandbox.patch_dir(data_dir()))
    if res.ok:
        await publish(t, {"k": "applied", "files": res.files, "how": res.how})
        return {"write": "applied", "files": res.files}
    await publish(t, {"k": "conflict", "text": res.message, "files": res.conflicts,
                      "saved": res.saved_patch})
    return {"write": "conflict", "detail": res.message, "saved": res.saved_patch}


def decide(t: TaskState, approve: bool) -> tuple[bool, str]:
    """Answer an approval. The first answer wins; later ones are told so."""
    if t.approval is None:
        return False, "This task is not waiting for an approval."
    if t.approval.done():
        return False, "Already answered."
    t.approval.set_result(bool(approve))
    return True, ""


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
