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
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

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

    def to_dict(self) -> dict[str, Any]:
        return {"outcome": str(self.outcome), "text": self.text, "by": self.by,
                "by_label": self.by_label,
                "attempts": [a.__dict__ for a in self.attempts]}


def handoff_note(task: Task, attempts: list[Attempt], partial: list[str]) -> str:
    """What the next agent is told about the work so far.

    Deliberately factual and short: which agents tried, why each stopped, and
    what they had said. Phase 8 adds the files already changed and the current
    diff, which is the part that turns this from "start again" into
    "carry on".
    """
    lines = ["This task was started by another assistant that had to stop. "
             "Continue it rather than beginning again."]
    for a in attempts:
        lines.append(f"- {a.label} stopped: {a.outcome}"
                     + (f" ({a.detail[:160]})" if a.detail else ""))
    said = "\n\n".join(p for p in partial if p).strip()
    if said:
        lines.append("\nWhat had been worked out so far:\n" + said[-4000:])
    return "\n".join(lines)


async def run_chain(task: Task, agents: list[CodingAgent], *, emit: EventFn,
                    cancel: asyncio.Event) -> ChainResult:
    attempts: list[Attempt] = []
    partial: list[str] = []

    if not agents:
        await emit({"k": "error", "text": "No coding agent is available: nothing is ticked, "
                    "or nothing ticked is signed in."})
        return ChainResult(Outcome.UNAVAILABLE)

    for i, agent in enumerate(agents):
        if cancel.is_set():
            return ChainResult(Outcome.CANCELLED, attempts=attempts)

        ok, why = await agent.available()
        if not ok:
            attempts.append(Attempt(agent.id, agent.label, "skipped", why))
            await emit({"k": "skip", "agent": agent.id, "label": agent.label, "why": why})
            continue

        await emit({"k": "agent", "agent": agent.id, "label": agent.label,
                    "kind": agent.kind, "position": i + 1, "of": len(agents)})
        if attempts:
            task.handoff_note = handoff_note(task, attempts, partial)

        t0 = time.time()
        try:
            res: Result = await agent.run(task, emit=emit, cancel=cancel)
        except Exception as exc:  # noqa: BLE001 -- one agent crashing must not end the chain
            res = Result(Outcome.UNAVAILABLE, detail=f"{type(exc).__name__}: {exc}")
        dt = time.time() - t0
        attempts.append(Attempt(agent.id, agent.label, str(res.outcome),
                                res.detail[:300], round(dt, 1)))

        if res.outcome == Outcome.OK:
            await emit({"k": "done", "ok": True, "by": agent.id, "label": agent.label})
            return ChainResult(Outcome.OK, res.text, agent.id, agent.label, attempts)

        if res.outcome == Outcome.CANCELLED:
            return ChainResult(Outcome.CANCELLED, by=agent.id, by_label=agent.label,
                               attempts=attempts)

        if not res.outcome.hands_off:
            # Failed on the task itself. Stop: see the module docstring.
            await emit({"k": "done", "ok": False, "by": agent.id, "label": agent.label,
                        "why": res.detail})
            return ChainResult(res.outcome, res.text, agent.id, agent.label, attempts)

        if res.text:
            partial.append(f"[{agent.label}] {res.text}")
        nxt = next((a.label for a in agents[i + 1:]), None)
        await emit({"k": "handoff", "from": agent.id, "from_label": agent.label,
                    "reason": str(res.outcome), "detail": res.detail[:200],
                    "resets_at": res.resets_at, "to_label": nxt})

    await emit({"k": "error", "text": "Every agent in the chain was unavailable, "
                "limited or signed out."})
    return ChainResult(Outcome.UNAVAILABLE, attempts=attempts)
