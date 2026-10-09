"""The fallback chain: who works on a task, and who takes over when they can't.

Claude and Codex lead, because they are the strongest coders and the only two
that drive their own tools. Behind them, every council unit through its chat
session. The order is a preference; the membership is yours -- a unit you have
not ticked is never asked, the same promise the council makes.

The rule that makes this safe rather than wasteful:

    Hand off ONLY on a failure another agent could fix.

Running out of allowance, being signed out, a CLI that is not installed, a
unit that could not be reached -- those are the agent's problem, not the
task's, so the next agent gets it. A task that failed on its merits is not
handed on: if the tests failed under Claude, Codex would fail them too, and
spend a second allowance proving it.

And a hand-off is a continuation, not a restart. The next agent is told what
the previous one did, so a limit that trips halfway costs the rest of the task
rather than the part already done.

Two things send the SAME agent round again instead (Track F): a message you
typed while it worked that it could not take as it went (a Codex without
app-server steering is stopped and resumes its own session with it; a browser
unit gets it after its reply, or at once with Interrupt now -- the Claude CLI
and an app-server Codex take it at their next step and are never stopped),
and a follow-up's native resume that missed (retried once from the session's
transcript).
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from ..followup import Steer
from .base import CodingAgent, EventFn, Outcome, Result, Task
from .browser import BrowserUnitAgent
from .claude_cli import ClaudeCLIAgent
from .codex_cli import CodexCLIAgent
from . import slots

# The default order. "claude-cli" and "codex-cli" expand into every signed-in
# slot of that agent, in slot order, which is how the chain rotates ACCOUNTS
# before it moves on to a different model.
DEFAULT_ORDER = [
    "claude-cli", "codex-cli",
    "claude-pro", "chatgpt", "claude", "gemini", "deepseek", "grok", "perplexity",
]
CLI_AGENTS = {"claude-cli": "claude", "codex-cli": "codex"}


def expand(order: list[str], settings) -> list[CodingAgent]:
    """Turn ids into agents, dropping anything that does not exist here."""
    out: list[CodingAgent] = []
    enabled = set(settings.enabled_site_ids())
    for uid in order:
        if uid in CLI_AGENTS:
            agent = CLI_AGENTS[uid]
            for slot in slots.list_slots(agent):
                out.append(ClaudeCLIAgent(slot) if agent == "claude" else CodexCLIAgent(slot))
        elif uid in settings.sites and uid in enabled:
            out.append(BrowserUnitAgent(uid, settings.site(uid).display_name, settings))
    return out


@dataclass
class Attempt:
    agent: str
    label: str
    outcome: str
    detail: str = ""
    seconds: float = 0.0


@dataclass
class ChainResult:
    outcome: Outcome
    text: str = ""
    by: str = ""               # the agent that finished (or failed) the task
    by_label: str = ""
    attempts: list[Attempt] = field(default_factory=list)
    # The CLI session the last agent ran in (Track F): a follow-up by the
    # same agent resumes it. "" for a browser unit, or nothing started.
    session_id: str = ""
    by_kind: str = ""

    @property
    def native(self) -> dict[str, str]:
        if self.by_kind == "cli" and self.by and self.session_id:
            return {"agent": self.by, "sid": self.session_id}
        return {}

    def to_dict(self) -> dict[str, Any]:
        return {"outcome": str(self.outcome), "text": self.text, "by": self.by,
                "by_label": self.by_label, "native": self.native,
                "attempts": [a.__dict__ for a in self.attempts]}


def handoff_note(task: Task, attempts: list[Attempt], partial: list[str],
                 changed: list[str] | None = None) -> str:
    """What the next agent is told about the work so far.

    Deliberately factual and short: which agents tried, why each stopped, what
    they had said, and -- in write mode -- which files are already changed in
    the working copy. That last part is what turns this from "start again"
    into "carry on": the next agent works in the SAME sandbox, so the edits
    are already there for it to read.
    """
    lines = ["This task was started by another assistant that had to stop. "
             "Continue it rather than beginning again."]
    for a in attempts:
        if a.outcome in _NOT_STOPS:
            continue
        lines.append(f"- {a.label} stopped: {a.outcome}"
                     + (f" ({a.detail[:160]})" if a.detail else ""))
    if changed:
        lines.append("\nFiles it had already changed in this working copy (the "
                     "changes are on disk; read them, keep what is right, and "
                     "finish the task):\n" + "\n".join(f"  {c}" for c in changed))
    said = "\n\n".join(p for p in partial if p).strip()
    if said:
        lines.append("\nWhat had been worked out so far:\n" + said[-4000:])
    return "\n".join(lines)


# Attempts that were not an agent giving up: it went on, same agent.
_NOT_STOPS = (str(Outcome.INTERRUPTED), str(Outcome.RESUME_MISS))


def continuation_note(label: str, said: str, changed: list[str] | None, why: str) -> str:
    """For an agent continuing WITHOUT its own session to resume (a browser
    unit, or a CLI stopped before it had one): what it had already done. The
    person's message itself is in the prompt's ADDED BY THE PERSON block."""
    if why == "revise":
        lines = [f"You ({label}) already did this task once. The person looked at "
                 "the resulting diff and asked for a revision instead of approving "
                 "it; nothing was applied. Revise the work as they ask (see ADDED "
                 "BY THE PERSON) rather than starting again."]
    else:
        lines = [f"You ({label}) were working on this task and the person added a "
                 "message (see ADDED BY THE PERSON). Carry on from where you were, "
                 "taking it into account, rather than beginning again."]
    if changed:
        lines.append("\nFiles already changed in this working copy (the changes "
                     "are on disk):\n" + "\n".join(f"  {c}" for c in changed))
    if said.strip():
        lines.append("\nWhat you had said so far:\n" + said.strip()[-4000:])
    return "\n".join(lines)


def prepare_continuation(task: Task, agent: CodingAgent, *, said: str, sid: str,
                         msgs: list[str], why: str, changed: list[str] | None) -> None:
    """Set the task up for `agent` to carry on with `msgs`: a native resume of
    its own session when it has one, else a continuation note. The note is
    written either way, so a resume that misses still has it."""
    task.added += [m for m in msgs if m not in task.added]
    task.interrupt_msgs = list(msgs)
    task.handoff_note = continuation_note(agent.label, said, changed, why)
    task.resume = ({"agent": agent.id, "sid": sid, "why": why}
                   if agent.kind == "cli" and sid else {})


async def _link(stop: asyncio.Event, cancel: asyncio.Event,
                interrupt: asyncio.Event | None) -> None:
    """Set `stop` when Halt or (for a CLI agent) an interrupt arrives. The
    agent sees one event; the chain tells the two apart afterwards."""
    waits = [asyncio.ensure_future(cancel.wait())]
    if interrupt is not None:
        waits.append(asyncio.ensure_future(interrupt.wait()))
    try:
        await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
        stop.set()
    finally:
        for w in waits:
            w.cancel()


async def _changed(task: Task) -> list[str] | None:
    if task.progress is None:
        return None
    return await asyncio.get_running_loop().run_in_executor(None, task.progress)


async def run_chain(task: Task, agents: list[CodingAgent], *, emit: EventFn,
                    cancel: asyncio.Event, steer: Steer | None = None) -> ChainResult:
    """Walk the chain. `steer` carries the messages you type while it runs
    (followup.Steer); without one, nothing can arrive.

    Every way out closes the steer BEFORE its first await, so a message is
    either taken by this chain or answered "follow-up" -- never lost between.
    """
    steer = steer if steer is not None else Steer()
    # The agents see it too: a CLI that takes messages without stopping
    # delivers them itself, and a browser unit watches for Interrupt now.
    task.steer = steer
    attempts: list[Attempt] = []
    partial: list[str] = []

    if not agents:
        steer.close()
        await emit({"k": "error", "text": "No coding agent is available: nothing is ticked, "
                    "or nothing ticked is signed in."})
        return ChainResult(Outcome.UNAVAILABLE)

    for i, agent in enumerate(agents):
        if cancel.is_set():
            steer.close()
            return ChainResult(Outcome.CANCELLED, attempts=attempts)

        ok, why = await agent.available()
        if not ok:
            attempts.append(Attempt(agent.id, agent.label, "skipped", why))
            await emit({"k": "skip", "agent": agent.id, "label": agent.label, "why": why})
            continue

        await emit({"k": "agent", "agent": agent.id, "label": agent.label,
                    "kind": agent.kind, "position": i + 1, "of": len(agents)})
        if attempts:
            task.handoff_note = handoff_note(task, attempts, partial, await _changed(task))

        missed = False
        while True:
            # Typed before this agent started (or between agents): it goes
            # into the prompt, no interrupt needed.
            task.added += steer.take()
            stop = asyncio.Event()
            # Only a CLI that cannot take a message while it runs is ever
            # stopped for one (Steer.go_live turns that off for the rest).
            link = asyncio.ensure_future(
                _link(stop, cancel, steer.interrupt if agent.kind == "cli" else None))
            steer.running(agent.kind)
            t0 = time.time()
            try:
                res: Result = await agent.run(task, emit=emit, cancel=stop)
            except Exception as exc:  # noqa: BLE001 -- one agent crashing must not end the chain
                res = Result(Outcome.UNAVAILABLE, detail=f"{type(exc).__name__}: {exc}")
            finally:
                link.cancel()
                steer.running(None)
            dt = round(time.time() - t0, 1)

            if cancel.is_set():
                steer.close()
                attempts.append(Attempt(agent.id, agent.label, str(Outcome.CANCELLED), "", dt))
                return ChainResult(Outcome.CANCELLED, by=agent.id, by_label=agent.label,
                                   attempts=attempts, session_id=res.session_id,
                                   by_kind=agent.kind)
            outcome = Outcome.INTERRUPTED if stop.is_set() else res.outcome

            if outcome == Outcome.RESUME_MISS and not missed:
                # Its own session is gone (another PC's CLI, a cleaned-up
                # store): once more, same agent, memory from the transcript.
                missed = True
                attempts.append(Attempt(agent.id, agent.label, str(outcome), res.detail[:300], dt))
                task.resume = {}
                await emit({"k": "note", "text": f"{agent.label} could not resume its earlier "
                            "session; continuing from the session's history instead."})
                continue
            if outcome == Outcome.RESUME_MISS:
                outcome = Outcome.UNAVAILABLE

            if outcome == Outcome.INTERRUPTED or (outcome == Outcome.OK and steer.pending):
                msgs = steer.take()
                attempts.append(Attempt(agent.id, agent.label, str(Outcome.INTERRUPTED),
                                        "", dt))
                prepare_continuation(task, agent, said=res.text, sid=res.session_id,
                                     msgs=msgs, why="interrupt", changed=await _changed(task))
                resumed = bool(task.resume)
                await emit({"k": "interrupt", "agent": agent.id, "label": agent.label,
                            "finished": outcome == Outcome.OK, "resumed": resumed,
                            "messages": len(msgs)})
                await emit({"k": "note", "text": (
                    f"{agent.label} had finished; continuing with your message."
                    if outcome == Outcome.OK else
                    f"Interrupted — {agent.label} continues with your message.")})
                continue
            break

        attempts.append(Attempt(agent.id, agent.label, str(outcome), res.detail[:300], dt))

        if outcome == Outcome.OK:
            steer.close()
            await emit({"k": "done", "ok": True, "by": agent.id, "label": agent.label})
            return ChainResult(Outcome.OK, res.text, agent.id, agent.label, attempts,
                               res.session_id, agent.kind)

        if not outcome.hands_off:
            # Failed on the task itself. Stop: see the module docstring.
            steer.close()
            await emit({"k": "done", "ok": False, "by": agent.id, "label": agent.label,
                        "why": res.detail})
            return ChainResult(outcome, res.text, agent.id, agent.label, attempts,
                               res.session_id, agent.kind)

        if res.text:
            partial.append(f"[{agent.label}] {res.text}")
        nxt = next((a.label for a in agents[i + 1:]), None)
        await emit({"k": "handoff", "from": agent.id, "from_label": agent.label,
                    "reason": str(outcome), "detail": res.detail[:200],
                    "resets_at": res.resets_at, "to_label": nxt})

    steer.close()
    await emit({"k": "error", "text": "Every agent in the chain was unavailable, "
                "limited or signed out."})
    return ChainResult(Outcome.UNAVAILABLE, attempts=attempts)


