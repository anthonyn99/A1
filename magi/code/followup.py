"""Code Mode follow-ups: a task as one turn of a session (Track F, F3).

A Code Mode task used to be a one-shot. Now it can be turn n of a session:

  * **Memory.** The console is the source of truth for the thread and sends
    the earlier turns with each follow-up (`parse_session`). They become a
    "SESSION SO FAR" block -- F1's `engine/session.build_context`, the same
    trimming, a different header -- so any agent, on any engine, after any
    restart, knows what was said.
  * **Native resume.** When the SAME CLI agent and account continue, its own
    session is resumed instead (`claude --resume`, `codex exec … resume`),
    and the block is left out so nothing is said twice. A resume that misses
    falls back to the block (chain.py).
  * **Ground truth.** Native memory remembers every edit the agent MADE,
    including the ones you denied. `state_note` says what actually reached the
    folder, turn by turn, and is sent on every follow-up, resumed or not.
  * **Mid-run messages** (`Steer`): typed while a task runs, and queued --
    editable and removable -- until delivered. Before the agent starts they
    join its first prompt; a CLI agent takes them at its next step without
    stopping (Claude's stream-json stdin, Codex's app-server `turn/steer`;
    a Codex that cannot is stopped and resumed instead); a browser unit gets
    them right after its current reply. "Interrupt now" stops the current
    step or reply first. At the approval card they ask for a revision
    (tasks.py). After that they are the next follow-up.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Any, Callable

from ..engine.session import build_context, valid_session_id

HEADER = ("SESSION SO FAR (earlier turns of this coding session, oldest first; "
          "the new message follows)")
NEW_MESSAGE = "NEW MESSAGE:\n"
# A CLI agent's prompt goes in on stdin, so its budget is ours to set; a
# browser unit's is its chat box's (session.budget_for).
CLI_BUDGET = 24_000

MAX_INPUT_CHARS = 200_000     # the whole `session` field, before trimming
MAX_TURNS = 200
MAX_TURN = 1_000
MAX_MESSAGE_CHARS = 4_000
MAX_MESSAGES = 20             # per task, however they were delivered
BATCH_S = 1.5                 # messages this close together are one interrupt
STATE_TURNS = 12              # write turns the ground-truth note lists

_AGENT = re.compile(r"^(claude|codex):[A-Za-z0-9_.-]{1,64}$")
_SID = re.compile(r"^[A-Za-z0-9-]{8,80}$")

# How a write turn ended -> what that means for the folder. Every "not"
# is spelled out: this note exists because the agent's own memory of the
# turn says the edits were made.
_WRITE = {
    "applied": "your diff was APPLIED -- these edits are in the project: {files}",
    "denied": "your diff was DENIED by the person -- those edits are NOT in the project",
    "timeout": "your diff was not answered in time, so it was NOT applied -- "
               "those edits are NOT in the project",
    "halted": "the turn was halted before its diff was applied -- those edits "
              "are NOT in the project",
    "refused": "your diff was REFUSED by MAGI's safety review -- those edits "
               "are NOT in the project",
    "conflict": "your diff could not be applied (it conflicted with the "
                "folder) -- those edits are NOT in the project",
    "discarded": "the turn did not finish and its partial edits were "
                 "discarded -- they are NOT in the project",
    "none": "you made no changes",
}


@dataclass
class Session:
    id: str
    turn: int
    turns: list[dict] = field(default_factory=list)
    # {"agent": "claude:system", "sid": "..."} -- the CLI session the last
    # turn ran in, for a native resume. {} = none.
    native: dict = field(default_factory=dict)


def _s(v: Any, name: str) -> str:
    if v is None:
        return ""
    if not isinstance(v, str):
        raise ValueError(f"session {name} must be a string")
    return v


def _files(v: Any) -> list[str]:
    """[str] or [{path}] (the applied event's shape) -> [str]."""
    out = []
    for f in (v or [])[:200] if isinstance(v, list) else []:
        p = f.get("path") if isinstance(f, dict) else f
        if isinstance(p, str) and p.strip():
            out.append(p.strip()[:300])
    return out


def parse_session(raw: Any) -> Session | None:
    """The console's `session` field -> a Session, or None for a fresh task.

    Raises ValueError with a message fit for a refusal.
    """
    if raw in (None, "", {}):
        return None
    if not isinstance(raw, dict):
        raise ValueError("session must be an object")
    sid = _s(raw.get("id"), "id")
    if not valid_session_id(sid):
        raise ValueError("session id is not valid")
    turn = raw.get("turn", 1)
    if not isinstance(turn, int) or isinstance(turn, bool) or not 1 <= turn <= MAX_TURN:
        raise ValueError("session turn must be a whole number from 1")
    turns_in = raw.get("turns") or []
    if not isinstance(turns_in, list):
        raise ValueError("session turns must be a list")
    if len(turns_in) > MAX_TURNS:
        raise ValueError(f"a session has at most {MAX_TURNS} earlier turns")
    turns, total = [], 0
    for t in turns_in:
        if not isinstance(t, dict):
            raise ValueError("each session turn must be an object")
        d = {"prompt": _s(t.get("prompt"), "prompt").strip(),
             "text": _s(t.get("text"), "text").strip(),
             "outcome": _s(t.get("outcome"), "outcome")[:40],
             "write": _s(t.get("write"), "write")[:40],
             "mode": "write" if t.get("mode") == "write" or t.get("write") else "read",
             "files": _files(t.get("files")),
             "by": _s(t.get("by"), "by")[:80]}
        total += len(d["prompt"]) + len(d["text"])
        if total > MAX_INPUT_CHARS:
            raise ValueError(f"the session is over {MAX_INPUT_CHARS:,} characters")
        if d["prompt"]:
            turns.append(d)
    native = raw.get("native") or {}
    if not isinstance(native, dict):
        raise ValueError("session native must be an object")
    agent, nsid = _s(native.get("agent"), "agent"), _s(native.get("sid"), "sid")
    if agent or nsid:
        if not _AGENT.match(agent) or not _SID.match(nsid):
            raise ValueError("session native is not a CLI session")
        native = {"agent": agent, "sid": nsid}
    else:
        native = {}
    return Session(id=sid, turn=turn, turns=turns, native=native)


def _meta(t: dict) -> str:
    who = f" by {t['by']}" if t.get("by") else ""
    if t.get("mode") != "write":
        return f"[read-only turn{who}]"
    w = t.get("write") or ""
    if w == "applied" and t.get("files"):
        return f"[write turn{who}; applied: {', '.join(t['files'][:12])}]"
    return f"[write turn{who}; " + (f"diff {w}]" if w else "no diff]")


def history(turns: list[dict], budget: int) -> str:
    """The SESSION SO FAR block: each earlier prompt with what kind of turn it
    was, and the agent's answer. Trimmed like a Deliberation's."""
    return build_context(
        [{"q": f"{t['prompt']}\n{_meta(t)}", "answer": t.get("text", "")} for t in turns],
        budget, header=HEADER)


def state_note(turns: list[dict]) -> str:
    """What the earlier WRITE turns actually left in the folder. "" if none.

    The ground truth an agent needs most when it is resumed natively: its
    own memory has every edit it made, approved or not.
    """
    writes = [(i + 1, t) for i, t in enumerate(turns) if t.get("mode") == "write"]
    if not writes:
        return ""
    lines = ["WHAT IS ACTUALLY IN THE PROJECT NOW (from MAGI; trust this over "
             "your memory of earlier turns):"]
    for n, t in writes[-STATE_TURNS:]:
        w = t.get("write") or "discarded"
        text = _WRITE.get(w, f"its diff ended as '{w}' and was NOT applied")
        files = ", ".join(t.get("files") or []) or "(files not recorded)"
        lines.append(f"- Turn {n}: " + text.format(files=files) + ".")
    lines.append("This turn starts from the project folder as it is now; "
                 "anything not listed as applied is not in it.")
    return "\n".join(lines)


def added_block(messages: list[str]) -> str:
    if not messages:
        return ""
    return ("ADDED BY THE PERSON WHILE YOU WERE WORKING (apply these; they "
            "override the task where they conflict):\n"
            + "\n".join(f"- {m}" for m in messages))


class Steer:
    """Messages typed while a task runs, and where each one goes.

    Synchronous methods only, so under the one event loop a message is either
    pending before the chain `close()`s the steer or it is a follow-up --
    never both, never neither.

    Every message has an id and stays QUEUED -- editable, removable -- until
    something delivers it: the next prompt, a live agent at its next step
    (`deliver`), or a continuation (`take`). `on_deliver(ids, how)` hears
    about each delivery, so every viewer's bubble stops offering Edit.

    `kind` is what is running now: None (nothing yet, or between agents: the
    next prompt takes it), "cli", "browser" (after its reply). A CLI agent
    that can take messages without stopping (`go_live`: Claude's stream-json
    stdin, Codex's app-server) delivers them itself at its next step; one
    that cannot is stopped and resumed (`interrupt`, after BATCH_S).
    `now` is "Interrupt now": a live agent stops its current step, a browser
    unit stops its reply, and a non-live CLI is stopped at once.
    """

    def __init__(self) -> None:
        self.items: list[dict[str, str]] = []
        self.count = 0
        self.open = True
        self.kind: str | None = None
        self.live = False
        self.interrupt = asyncio.Event()
        self.now = asyncio.Event()
        # Set whenever a live agent should look again (a message, Interrupt
        # now); the agent clears it.
        self.wake = asyncio.Event()
        self.on_deliver: Callable[[list[str], str], None] | None = None
        self._timer: asyncio.TimerHandle | None = None
        self._seq = 0

    @property
    def pending(self) -> list[str]:
        """The queued texts, oldest first."""
        return [i["text"] for i in self.items]

    @staticmethod
    def check_text(text: Any) -> str:
        text = (text if isinstance(text, str) else "").strip()
        if not text:
            raise ValueError("The message is empty.")
        if len(text) > MAX_MESSAGE_CHARS:
            raise ValueError(f"A message is at most {MAX_MESSAGE_CHARS:,} characters.")
        return text

    def hold(self, text: Any) -> str:
        """Keep a message for the chain without interrupting anything (a
        revision asked for at the card). Counted against the cap."""
        text = self.check_text(text)
        if self.count >= MAX_MESSAGES:
            raise OverflowError(f"At most {MAX_MESSAGES} messages per task; "
                                "send it as a follow-up.")
        self.count += 1
        self._seq += 1
        self.items.append({"id": f"m{self._seq}", "text": text})
        return text

    @property
    def last_id(self) -> str:
        return self.items[-1]["id"] if self.items else ""

    def add(self, text: Any) -> str:
        """Queue a message for the running chain. Returns how it will land:
        "prompt" | "queued" | "interrupt" | "after_reply". Call only while
        `open`."""
        self.hold(text)
        if self.kind == "cli":
            if self.live:
                self.wake.set()
                return "queued"
            if self._timer is None:
                # Batched: a second message typed right after the first
                # rides the same interrupt instead of causing another.
                self._timer = asyncio.get_running_loop().call_later(BATCH_S, self._fire)
            return "interrupt"
        return "after_reply" if self.kind == "browser" else "prompt"

    def edit(self, mid: str, text: Any) -> bool:
        """Change a queued message. False once it has been delivered."""
        text = self.check_text(text)
        for i in self.items:
            if i["id"] == mid:
                i["text"] = text
                return True
        return False

    def remove(self, mid: str) -> bool:
        """Drop a queued message (it no longer counts against the cap).
        False once it has been delivered."""
        for n, i in enumerate(self.items):
            if i["id"] == mid:
                del self.items[n]
                self.count -= 1
                if not self.items and self._timer is not None:
                    self._timer.cancel()
                    self._timer = None
                return True
        return False

    def interrupt_now(self) -> str:
        """"Interrupt now": what it does depends on what is running.
        "live" | "browser" | "stopped" (a non-live CLI, stopped at once) |
        "" (nothing to interrupt -- the message joins the next prompt)."""
        if not self.items or self.kind is None:
            return ""
        if self.kind == "cli" and not self.live:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            self.interrupt.set()
            return "stopped"
        self.now.set()
        self.wake.set()
        return "live" if self.kind == "cli" else "browser"

    def go_live(self) -> None:
        """The running CLI agent takes messages without stopping: it calls
        `deliver` at its own steps, so no interrupt is timed for it."""
        self.live = True
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        if self.items:
            self.wake.set()

    def _fire(self) -> None:
        self._timer = None
        if self.items and self.kind == "cli" and not self.live:
            self.interrupt.set()

    def running(self, kind: str | None) -> None:
        self.kind = kind
        self.live = False
        if kind is None:
            self.now.clear()
            self.wake.clear()
        if kind == "cli" and self.items and self._timer is None:
            self._timer = asyncio.get_running_loop().call_later(BATCH_S, self._fire)

    def _taken(self, how: str) -> list[dict[str, str]]:
        out, self.items = self.items, []
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        if out and self.on_deliver is not None:
            self.on_deliver([i["id"] for i in out], how)
        return out

    def deliver(self) -> list[str]:
        """A live agent takes everything queued, at one of its steps."""
        return [i["text"] for i in self._taken("live")]

    def take(self, how: str = "taken") -> list[str]:
        """Everything pending, now delivered ("unsent": handed back to the
        console instead, the task having ended)."""
        out = self._taken(how)
        self.interrupt.clear()
        return [i["text"] for i in out]

    def close(self) -> None:
        """The chain is finishing: later messages are follow-ups."""
        self.open = False
        self.kind = None
        self.live = False
        self.now.clear()
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def reopen(self) -> None:
        """A revision from the approval card runs the chain again."""
        self.open = True
