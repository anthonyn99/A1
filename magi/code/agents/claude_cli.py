"""Claude, through the Claude Code CLI, on a signed-in account.

    claude -p --output-format stream-json --verbose --restricted
           --strict-mcp-config --tools <exact list> --permission-mode plan

Every flag is load-bearing:

  --restricted          ignores user, project and local settings files. In A1
                        that is what stops the agent loading .claude/ and
                        firing the repo's own Stop hook -- which runs
                        `git add -A && git commit && git push` -- at the end of
                        every Code Mode task.
  --tools <list>        the EXACT tool set, not "restricted minus some". A
                        restricted session still offered Artifact (publishes a
                        page to a URL), PushNotification and SendMessage, and a
                        prompt-injected agent with those could send project
                        content off this machine. Read, Glob, Grep; nothing else
                        in read mode.
  --strict-mcp-config   no MCP servers from anywhere but the command line.
  --permission-mode plan  belt to the tool list's braces: writes never
                        auto-approve even if a tool slipped through.

The prompt goes in on stdin, not argv: the CLI is a .cmd shim on Windows, and
passing arbitrary prose through cmd.exe's quoting is how a prompt containing
`&` or `%` turns into a different command.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

from .base import CodingAgent, EventFn, Mode, Outcome, Result, Task
from . import limits, slots
from ._proc import Stream

READ_TOOLS = "Read,Glob,Grep"

_UNAUTH = re.compile(r"please run /login|not logged in|invalid api key|"
                     r"authentication_error|oauth token (has )?expired|401", re.I)
_LIMIT = re.compile(r"usage limit|limit reached|hit your limit|rate.?limit|"
                    r"limits? will reset|out of (extra )?usage|429", re.I)


def build_argv(exe: str, task: Task, model: str | None = None) -> list[str]:
    argv = [exe, "-p", "--output-format", "stream-json", "--verbose",
            "--restricted", "--strict-mcp-config", "--permission-mode", "plan"]
    if task.mode == Mode.READ:
        argv += ["--tools", READ_TOOLS]
    if model:
        argv += ["--model", model]
    return argv


def _target(inp: dict[str, Any]) -> str:
    for k in ("file_path", "path", "pattern", "glob", "query"):
        v = inp.get(k)
        if v:
            return str(v)
    return ""


def parse_line(line: str) -> dict[str, Any] | None:
    """One stream-json line -> a normalised event, or None to ignore it.

    Pure, so it can be tested against a recorded run without a CLI.
    """
    line = line.strip()
    if not line.startswith("{"):
        return None
    try:
        d = json.loads(line)
    except ValueError:
        return None
    t = d.get("type")
    if t == "system" and d.get("subtype") == "init":
        return {"k": "init", "model": d.get("model", ""),
                "session_id": d.get("session_id", ""), "tools": d.get("tools") or []}
    if t == "rate_limit_event":
        info = d.get("rate_limit_info") or {}
        return {"k": "ratelimit", "status": info.get("status", ""),
                "resets_at": info.get("resetsAt"),
                "type": info.get("rateLimitType", ""),
                "windows": info.get("unifiedWindows") or {}}
    if t == "assistant":
        out = []
        for b in (d.get("message") or {}).get("content") or []:
            if b.get("type") == "text" and b.get("text"):
                out.append({"k": "text", "text": b["text"]})
            elif b.get("type") == "tool_use":
                out.append({"k": "tool", "name": b.get("name", ""),
                            "target": _target(b.get("input") or {})})
        return {"k": "batch", "events": out} if out else None
    if t == "result":
        return {"k": "result", "ok": not d.get("is_error"),
                "subtype": d.get("subtype", ""), "text": d.get("result") or "",
                "turns": d.get("num_turns") or 0,
                "api_status": d.get("api_error_status"),
                "session_id": d.get("session_id", "")}
    return None


def classify_failure(text: str, api_status: Any) -> Outcome:
    """A failed result -> whether another agent should take over."""
    if api_status in (429, "429"):
        return Outcome.LIMITED
    if api_status in (401, 403, "401", "403"):
        return Outcome.UNAUTHED
    if _UNAUTH.search(text or ""):
        return Outcome.UNAUTHED
    if _LIMIT.search(text or ""):
        return Outcome.LIMITED
    return Outcome.TASK_FAILED


class ClaudeCLIAgent(CodingAgent):
    kind = "cli"

    def __init__(self, slot: str = slots.SYSTEM_SLOT, model: str | None = None):
        self.slot = slot
        self.model = model
        self.id = f"claude:{slot}"
        # Your own name for the account if you gave it one -- the transcript
        # says who did the work, and "Claude (codex1-spare)" says less than
        # "Claude (work account)".
        named = slots.label_of("claude", slot)
        self.label = ("Claude" if slot == slots.SYSTEM_SLOT and not named
                      else f"Claude ({named or slot})")

    async def available(self) -> tuple[bool, str]:
        if not slots.cli_path("claude"):
            return False, "Claude Code CLI is not installed."
        until = limits.blocked_until("claude", self.slot)
        if until:
            return False, "Limited until " + time.strftime("%H:%M", time.localtime(until))
        st = await asyncio.get_running_loop().run_in_executor(
            None, slots.status, "claude", self.slot)
        return (st.signed_in, st.detail or ("" if st.signed_in else "Not signed in."))

    async def run(self, task: Task, *, emit: EventFn, cancel: asyncio.Event) -> Result:
        exe = slots.cli_path("claude")
        if not exe:
            return Result(Outcome.UNAVAILABLE, detail="Claude Code CLI is not installed.")

        prompt = task.prompt
        if task.handoff_note:
            prompt = task.handoff_note + "\n\n---\n\n" + prompt
        try:
            s = Stream(build_argv(exe, task, self.model), cwd=task.root,
                       env=slots.env_for("claude", self.slot), stdin_text=prompt)
        except OSError as exc:
            return Result(Outcome.UNAVAILABLE, detail=f"Could not start Claude Code: {exc}")

        result: dict[str, Any] | None = None
        session = ""
        tools: list[str] = []
        limited_at: float | None = None

        async for raw in s.lines(cancel):
            ev = parse_line(raw)
            if not ev:
                continue
            k = ev["k"]
            if k == "init":
                session = ev["session_id"]
                await emit({"k": "note", "text": f"Claude ({ev['model']}) is reading the workspace."})
            elif k == "ratelimit":
                for win, w in (ev["windows"] or {}).items():
                    limits.note_usage("claude", self.slot, win,
                                      float(w.get("utilization") or 0), w.get("resetsAt"))
                    await emit({"k": "usage", "agent": "claude", "slot": self.slot,
                                "window": win, "utilization": w.get("utilization"),
                                "resets_at": w.get("resetsAt")})
                # "allowed" and "allowed_warning" keep going; anything else is
                # the wall. Remembered with the reset time the CLI gave.
                if ev["status"] and not str(ev["status"]).startswith("allowed"):
                    limited_at = ev["resets_at"]
            elif k == "batch":
                for e in ev["events"]:
                    if e["k"] == "tool":
                        tools.append(e["name"])
                    await emit(e)
            elif k == "result":
                result = ev

        if cancel.is_set():
            return Result(Outcome.CANCELLED, session_id=session, tools_used=tools)

        code = await s.wait()
        tail = "\n".join(s.stderr_tail)

        if limited_at is not None:
            until = limits.mark("claude", self.slot, limited_at, "rate_limit_event")
            return Result(Outcome.LIMITED, detail="Claude's usage limit was reached.",
                          resets_at=until, session_id=session, tools_used=tools)
        if result is None:
            outcome = classify_failure(tail, None)
            if outcome == Outcome.TASK_FAILED:
                outcome = Outcome.UNAVAILABLE   # died before producing anything
            if outcome == Outcome.LIMITED:
                limits.mark("claude", self.slot, None, "stderr")
            return Result(outcome, detail=(tail[-600:] or f"exited {code} with no result"),
                          session_id=session, tools_used=tools)
        if result["ok"]:
            limits.clear("claude", self.slot)
            return Result(Outcome.OK, text=result["text"], session_id=session,
                          turns=result["turns"], tools_used=tools)
        outcome = classify_failure(result["text"] + "\n" + tail, result.get("api_status"))
        if outcome == Outcome.LIMITED:
            limits.mark("claude", self.slot, None, "result")
        return Result(outcome, text=result["text"], detail=result["text"][:600],
                      session_id=session, turns=result["turns"], tools_used=tools)
