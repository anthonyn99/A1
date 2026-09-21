"""The shape every coding agent shares.

The task runner, the approval gate, the audit log and the fallback chain all
talk to this interface and nothing below it, so none of them knows -- or needs
to know -- whether the agent on the other end is a CLI driving its own tools or
a chat session MAGI is driving on its behalf.
"""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any, Awaitable, Callable


class Outcome(StrEnum):
    """How a run ended, from the chain's point of view.

    The distinction that matters is between failures ANOTHER agent could fix
    and failures it could not. Running out of allowance is the first kind:
    Codex has its own. A task that failed on its merits is the second: if the
    tests failed under Claude, handing the same task to Codex just fails them
    again with a different author, and burns a second allowance doing it.
    """

    OK = "ok"                    # finished the task
    TASK_FAILED = "task_failed"  # did the work and it did not succeed -- stop here
    LIMITED = "limited"          # usage / rate limit -- hand off
    UNAUTHED = "unauthed"        # signed out or token rejected -- hand off
    UNAVAILABLE = "unavailable"  # CLI missing, crashed, or unit unreachable -- hand off
    CANCELLED = "cancelled"      # you pressed Halt -- stop everything

    @property
    def hands_off(self) -> bool:
        return self in (Outcome.LIMITED, Outcome.UNAUTHED, Outcome.UNAVAILABLE)


class Mode(StrEnum):
    # Phase 7. The agent can read and search the workspace and nothing else.
    READ = "read"
    # Phase 8. Edits, through the containment hook and the approval gate.
    WRITE = "write"


@dataclass
class Task:
    id: str
    prompt: str
    root: Path
    mode: Mode = Mode.READ
    # What earlier agents in the chain already did, when this is a hand-off.
    # Empty on the first attempt.
    handoff_note: str = ""
    # Write mode: a callable naming the files already changed in the sandbox,
    # so a hand-off says "carry on from these edits", not "start again".
    progress: Callable[[], list[str]] | None = None

    def full_prompt(self) -> str:
        """What a CLI agent is sent: framing, any hand-off, then the task."""
        parts = []
        if self.mode == Mode.WRITE:
            parts.append(WRITE_FRAME)
        if self.handoff_note:
            parts.append(self.handoff_note)
        parts.append(self.prompt)
        return "\n\n---\n\n".join(parts)


# Said to every agent in write mode. True, and useful to it: an agent that
# knows its edits are reviewed as a diff keeps them focused, and one that
# knows it cannot run anything does not spend turns trying.
WRITE_FRAME = (
    "You are working in a private copy of the project. Edit files directly to "
    "carry out the task. When you finish, your changes are shown to the user as "
    "a diff, and nothing reaches the real project unless they approve it. Keep "
    "the change focused on the task. Running the project's commands or tests is "
    "not part of this mode; do not claim to have run any. Finish with a short "
    "summary of what "
    "you changed and why.")


@dataclass
class Result:
    outcome: Outcome
    text: str = ""
    detail: str = ""
    # Seconds since the epoch when a limit lifts, if the agent said.
    resets_at: float | None = None
    session_id: str = ""
    turns: int = 0
    tools_used: list[str] = field(default_factory=list)


# Everything an agent reports while it works, normalised so the console draws
# one kind of stream whichever agent produced it.
#   {"k":"text","text":...}              words for the transcript
#   {"k":"tool","name":...,"target":...} a tool call, e.g. Read magi/app.py
#   {"k":"usage","window":...,"utilization":...,"resets_at":...}
#   {"k":"note","text":...}              MAGI's own narration
EventFn = Callable[[dict[str, Any]], Awaitable[None]]


class CodingAgent(ABC):
    #: Stable id used in the chain, the audit log and the UI.
    id: str
    #: What the console shows.
    label: str
    #: "cli" or "browser".
    kind: str

    @abstractmethod
    async def run(self, task: Task, *, emit: EventFn,
                  cancel: asyncio.Event) -> Result:
        """Work on the task. Never raises for an expected failure: every way a
        run can end is an Outcome, because the chain decides what to do next
        from the outcome and an exception carries no such decision."""

    async def available(self) -> tuple[bool, str]:
        """Cheap readiness check -- signed in, installed. No model call."""
        return True, ""
