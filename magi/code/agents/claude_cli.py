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

Write mode (Phase 8) swaps the last two for `--tools Read,Glob,Grep,Edit,Write`
and `--permission-mode acceptEdits`, and runs with cwd set to a throwaway
worktree (sandbox.py), never the real folder. Still no Bash. `--restricted`
confines the file tools to the working directory -- verified live: a Write to
C:\\Users\\<you>\\x.txt comes back as a `permission_denied` event -- and even an
edit that stayed inside only reaches your folder as a diff you approved.

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
from . import limits, models, slots
from ._proc import Stream

READ_TOOLS = "Read,Glob,Grep"
WRITE_TOOLS = "Read,Glob,Grep,Edit,Write"
MCP_SERVER = "magi_github"
MCP_ALLOW = f"mcp__{MCP_SERVER}"

_UNAUTH = re.compile(r"please run /login|not logged in|invalid api key|"
                     r"authentication_error|oauth token (has )?expired|401", re.I)
# The provider's refusal of a MODEL for credits, as opposed to the account
# being out of usage: "Fable 5.1 requires usage credits. Switch to another
# model, or manage usage credits at ..." (verified live, credits off).
_CREDITS = re.compile(r"requires usage credits|usage credits (are )?(required|off)", re.I)
# A model the ACCOUNT lists but this Claude Code build cannot run yet (found
# live, 2026-09-24: Opus 5.5 on 2.1.278 -> "API Error: 400 Claude Code
# 2.1.278 does not support this model; version 2.1.280 or newer is
# required"). Not the task's failure and not the account's: the model's.
_TOO_OLD = re.compile(r"does not support this model; version (\d+(?:\.\d+)+) or newer", re.I)
_LIMIT = re.compile(r"usage limit|limit reached|hit your limit|rate.?limit|"
                    r"limits? will reset|out of (extra )?usage|429", re.I)


def build_argv(exe: str, task: Task, model: str | None = None,
               effort: str | None = None) -> list[str]:
    write = task.mode == Mode.WRITE
    argv = [exe, "-p", "--output-format", "stream-json", "--verbose",
            "--restricted", "--strict-mcp-config",
            "--permission-mode", "acceptEdits" if write else "plan",
            "--tools", WRITE_TOOLS if write else READ_TOOLS]
    if task.mcp_config is not None:
        # Read-only GitHub tools for this project, from a config file MAGI
        # wrote (never JSON through a .cmd shim's argv). Allowed by server
        # name: every tool on it only reads, through the engine.
        argv += ["--mcp-config", str(task.mcp_config), "--allowedTools", MCP_ALLOW]
    if model:
        argv += ["--model", model]
    if effort:
        argv += ["--effort", effort]
    return argv


def env_for_task(slot: str, task: Task) -> dict[str, str]:
    """The slot's environment, adjusted for the mode.

    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB keeps credentials out of the agent's
    SHELL commands -- and, found live, it also stops acceptEdits from
    auto-approving any edit, even one inside the working directory ("Claude
    requested permissions to write to ..., but you haven't granted it yet").
    Write mode offers no shell tool at all, so the scrub has nothing to guard
    there; it stays on in read mode, and when a later phase gives write mode a
    shell, that phase has to solve this another way.
    """
    env = slots.env_for("claude", slot)
    if task.mode == Mode.WRITE:
        env.pop("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", None)
    return env


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
    if t == "system" and d.get("subtype") == "permission_denied":
        # The containment working: a tool call the CLI refused. Shown, so a
        # task that went quiet on a refused write does not look like a bug.
        return {"k": "denied", "name": d.get("tool_name", ""),
                "text": d.get("message") or d.get("decision_reason") or ""}
    if t == "rate_limit_event":
        info = d.get("rate_limit_info") or {}
        return {"k": "ratelimit", "status": info.get("status", ""),
                "resets_at": info.get("resetsAt"),
                "error_code": info.get("errorCode") or "",
                "overage": bool(info.get("isUsingOverage")),
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
        # A fixed model (tests, or a caller that knows): skips the choice.
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
        # Your cap first: it is the one reason that is yours, and the
        # sentence says which cap and until when.
        until, why = models.cap_block("claude", self.slot)
        if until:
            return False, f"{why} — until {models_when(until)}"
        until = limits.blocked_until("claude", self.slot)
        if until:
            return False, "Limited until " + time.strftime("%H:%M", time.localtime(until))
        used_up = models.plan_used_up("claude", self.slot)
        cr = models.credits("claude", self.slot)
        if used_up and not (cr.get("enabled") and not cr.get("exhausted")):
            return False, (f"Plan limit reached until {models_when(used_up)}; "
                           "usage credits are off")
        st = await asyncio.get_running_loop().run_in_executor(
            None, slots.status, "claude", self.slot)
        return (st.signed_in, st.detail or ("" if st.signed_in else "Not signed in."))

    def _pick(self, task: Task) -> dict:
        if self.model:
            return {"model": self.model, "effort": None, "auto": False, "label": self.model,
                    "why": "fixed", "note": ""}
        return models.choose("claude", self.slot, task.prompt, str(task.mode))

    async def run(self, task: Task, *, emit: EventFn, cancel: asyncio.Event) -> Result:
        exe = slots.cli_path("claude")
        if not exe:
            return Result(Outcome.UNAVAILABLE, detail="Claude Code CLI is not installed.")
        # At most two tries on this account. A model can turn out to be
        # unusable only when it is tried: it needs usage credits (a plan MAGI
        # has not seen before), or this Claude Code build is too old for it.
        # Either is remembered, and the task goes again once on the best model
        # the account CAN run -- not handed to the next agent, and not counted
        # as the account being out of usage.
        res = Result(Outcome.UNAVAILABLE)
        refused = ""
        for attempt in range(2):
            pick = self._pick(task)
            if pick.get("note"):
                await emit({"k": "note", "text": pick["note"]})
            await emit({"k": "model", "agent": "claude", "slot": self.slot,
                        **{k: pick.get(k) for k in ("model", "label", "effort", "auto", "why")}})
            res, refused = await self._run_once(exe, task, pick, emit=emit, cancel=cancel)
            if not refused:
                return res
            label = pick.get("label") or "That model"
            if refused == "credits":
                if pick.get("model"):
                    models.note_credit_refusal("claude", self.slot, pick["model"])
                why = (f"{label} runs on usage credits for this account, and they are off.")
            else:
                need = refused.split(":", 1)[1]
                if pick.get("model"):
                    models.note_cli_min(pick["model"], need)
                why = (f"{label} needs Claude Code {need} or newer; this PC has "
                       f"{models.claude_cli_version() or 'an older one'} (run `claude update` there).")
            if self.model or attempt:
                break
            await emit({"k": "note", "text": why + " Trying again with the best model it can run."})
        return Result(Outcome.UNAVAILABLE, text=res.text, detail=why,
                      session_id=res.session_id, tools_used=res.tools_used)

    async def _run_once(self, exe: str, task: Task, pick: dict, *, emit: EventFn,
                        cancel: asyncio.Event) -> tuple[Result, str]:
        """One CLI run. The second value is "" normally, "credits" when the
        model needs usage credits, "cli:<version>" when this Claude Code is
        too old for it -- the two refusals run() retries once."""
        prompt = task.full_prompt()
        try:
            s = Stream(build_argv(exe, task, pick.get("model"), pick.get("effort")), cwd=task.root,
                       env=env_for_task(self.slot, task), stdin_text=prompt)
        except OSError as exc:
            return Result(Outcome.UNAVAILABLE, detail=f"Could not start Claude Code: {exc}"), ""

        result: dict[str, Any] | None = None
        session = ""
        tools: list[str] = []
        texts: list[str] = []
        limited_at: float | None = None
        credits_required = False
        capped: list[str] = []          # the sentence, once a cap trips
        p = models.prefs()

        def trip(why: str) -> None:
            if not capped:
                capped.append(why)
                s.kill()
        watch = asyncio.ensure_future(models.cap_watch("claude", self.slot, trip))

        try:
            async for raw in s.lines(cancel):
                ev = parse_line(raw)
                if not ev:
                    continue
                k = ev["k"]
                if k == "init":
                    session = ev["session_id"]
                    await emit({"k": "note", "text": f"Claude ({ev['model']}) is "
                                + ("editing a sandbox copy of the workspace."
                                   if task.mode == Mode.WRITE else "reading the workspace.")})
                elif k == "denied":
                    await emit(ev)
                elif k == "ratelimit":
                    for win, w in (ev["windows"] or {}).items():
                        util = float(w.get("utilization") or 0)
                        limits.note_usage("claude", self.slot, win, util, w.get("resetsAt"))
                        await emit({"k": "usage", "agent": "claude", "slot": self.slot,
                                    "window": win, "utilization": w.get("utilization"),
                                    "resets_at": w.get("resetsAt")})
                        cap = models.cap_crossed("claude", win, util, p)
                        if cap:
                            trip(f"Stopped at your {cap}% cap on the "
                                 f"{models.window_label(win)} limit ({round(util * 100)}% used)")
                    if ev.get("error_code") == "credits_required":
                        # THIS model needs credits -- the account is fine.
                        credits_required = True
                    elif ev["status"] and not str(ev["status"]).startswith("allowed"):
                        # "allowed" and "allowed_warning" keep going; anything
                        # else is the wall, remembered with the CLI's reset time.
                        limited_at = ev["resets_at"]
                elif k == "batch":
                    for e in ev["events"]:
                        if e["k"] == "tool":
                            tools.append(e["name"])
                        elif e["k"] == "text":
                            texts.append(e["text"])
                        await emit(e)
                elif k == "result":
                    result = ev
        finally:
            watch.cancel()

        if cancel.is_set():
            return Result(Outcome.CANCELLED, session_id=session, tools_used=tools), ""

        code = await s.wait()
        tail = "\n".join(s.stderr_tail)

        if capped:
            # Handed on like a limit, but nothing is remembered as one: the
            # cap is yours, and changing it takes effect on the next task.
            return Result(Outcome.LIMITED, detail=capped[0], session_id=session,
                          tools_used=tools, text=(result or {}).get("text", "")), ""
        said = (result or {}).get("text", "") + "\n" + "\n".join(texts) + "\n" + tail
        old = _TOO_OLD.search(said)
        if old:
            return Result(Outcome.UNAVAILABLE, text=(result or {}).get("text", ""),
                          session_id=session, tools_used=tools), "cli:" + old.group(1)
        if credits_required or _CREDITS.search((result or {}).get("text", "")):
            return Result(Outcome.UNAVAILABLE, text=(result or {}).get("text", ""),
                          session_id=session, tools_used=tools), "credits"
        if limited_at is not None:
            until = limits.mark("claude", self.slot, limited_at, "rate_limit_event")
            return Result(Outcome.LIMITED, detail="Claude's usage limit was reached.",
                          resets_at=until, session_id=session, tools_used=tools), ""
        if result is None:
            outcome = classify_failure(tail, None)
            if outcome == Outcome.TASK_FAILED:
                outcome = Outcome.UNAVAILABLE   # died before producing anything
            if outcome == Outcome.LIMITED:
                limits.mark("claude", self.slot, None, "stderr")
            return Result(outcome, detail=(tail[-600:] or f"exited {code} with no result"),
                          session_id=session, tools_used=tools), ""
        if result["ok"]:
            limits.clear("claude", self.slot)
            cr = models.credits("claude", self.slot)
            if pick.get("model") and not cr.get("enabled"):
                # It ran with credits off, so it does not need them here.
                models.note_gated("claude", self.slot, pick["model"], False)
            return Result(Outcome.OK, text=result["text"], session_id=session,
                          turns=result["turns"], tools_used=tools), ""
        outcome = classify_failure(result["text"] + "\n" + tail, result.get("api_status"))
        if outcome == Outcome.LIMITED:
            limits.mark("claude", self.slot, None, "result")
        return Result(outcome, text=result["text"], detail=result["text"][:600],
                      session_id=session, turns=result["turns"], tools_used=tools), ""


def models_when(ts: float) -> str:
    """"15:40" today, "Oct 1" further out."""
    if ts - time.time() > 20 * 3600:
        return time.strftime("%b %d", time.localtime(ts)).replace(" 0", " ")
    return time.strftime("%H:%M", time.localtime(ts))
