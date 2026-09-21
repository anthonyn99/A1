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
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .agents import chain
from .agents.base import Mode, Task

MAX_EVENTS = 4000        # a long task's transcript, capped so memory is bounded
KEEP_FINISHED = 40       # finished tasks kept for reattaching, newest first


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
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    viewers: set[asyncio.Queue] = field(default_factory=set)

    def summary(self) -> dict[str, Any]:
        return {"id": self.id, "project_id": self.project_id,
                "prompt": self.prompt[:200], "mode": self.mode,
                "started": self.started, "done": self.done,
                "outcome": (self.result or {}).get("outcome"),
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
    if t.root and isinstance(ev.get("target"), str):
        ev["target"] = _rel(ev["target"], t.root)
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

    async def emit(ev):
        await publish(t, ev)

    async def work():
        try:
            await publish(t, {"k": "start", "prompt": prompt, "mode": mode,
                              "chain": [{"id": a.id, "label": a.label, "kind": a.kind}
                                        for a in agents]})
            task = Task(id=t.id, prompt=prompt, root=root,
                        mode=Mode(mode) if mode in ("read", "write") else Mode.READ)
            res = await chain.run_chain(task, agents, emit=emit, cancel=t.cancel)
            t.result = res.to_dict()
        except Exception as exc:  # noqa: BLE001 -- the transcript must end, not hang
            t.result = {"outcome": "unavailable", "text": "",
                        "detail": f"{type(exc).__name__}: {exc}", "attempts": []}
        finally:
            t.done = True
            await publish(t, {"k": "end", "result": t.result})
            for q in list(t.viewers):
                q.put_nowait(None)

    asyncio.create_task(work())
    return t


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
