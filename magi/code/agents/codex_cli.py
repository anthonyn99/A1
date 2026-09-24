"""Codex, through the Codex CLI, signed in with a ChatGPT account.

    codex exec --json --sandbox read-only --skip-git-repo-check
               --ignore-user-config --ignore-rules --ephemeral -C <root> -

Runs on whatever ChatGPT account its slot is signed into -- including a Free
one, which covers local coding tasks on a rolling five-hour window plus weekly
limits. No API key, and it is deliberately NOT the account the council's
ChatGPT browser unit uses: its login lives in its own CODEX_HOME (slots.py).

  --sandbox read-only    Codex's own OS-level sandbox, and the default anyway;
                         stated so a config change can never widen it in read
                         mode.
  --ignore-user-config   no $CODEX_HOME/config.toml -- the run is defined by
  --ignore-rules         this command line, not by files a repo could carry.
  --ephemeral            no session files left behind for a read-only look.
  -                      the prompt arrives on stdin (see claude_cli.py for why
                         prose never goes through a .cmd shim's argv).

The event schema is Codex's own (sdk/typescript/src/events.ts, generated from
codex-rs/exec/src/exec_events.rs): thread.started, turn.started,
item.started/updated/completed carrying a typed item, turn.completed with
usage, turn.failed, and error.
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

_UNAUTH = re.compile(r"401 unauthorized|missing bearer|not logged in|"
                     r"please (log|sign) in|unauthori[sz]ed|token (is )?expired", re.I)
_LIMIT = re.compile(r"usage limit|hit your (usage )?limit|rate.?limit|429|"
                    r"quota|too many requests|try again (in|at)", re.I)
# "try again in 2 hours 13 minutes" / "resets in 45m" -> seconds from now.
_IN = re.compile(r"(?:try again|resets?)\s+in\s+((?:\d+\s*\w+\s*)+)", re.I)


# Features that reach off this machine or start other agents. Off in every
# mode: a prompt-injected run with a browser or an app connector could carry
# project content anywhere. (All present in 0.155; an unknown name would be
# an error, so this list only ever names features the CLI reports.)
DISABLED_FEATURES = ("browser_use", "browser_use_external", "computer_use",
                     "in_app_browser", "apps", "plugins", "image_generation",
                     "multi_agent", "hooks")

# Write mode on Windows. Without `windows.sandbox`, workspace-write silently
# degrades to read-only ("writing is blocked by read-only sandbox"). And by
# default workspace-write also lets commands write to %TEMP% -- verified live:
# a probe file landed there -- so the temp exemptions are switched off, which
# leaves the worktree as the only writable place (a write to the home folder
# came back UnauthorizedAccessException). Values are unquoted on purpose: `-c`
# parses TOML and falls back to a plain string, and quotes would have to
# survive codex.cmd's cmd.exe parsing.
WRITE_CONFIG = ("windows.sandbox=unelevated",
                "sandbox_workspace_write.exclude_tmpdir_env_var=true",
                "sandbox_workspace_write.exclude_slash_tmp=true",
                "sandbox_workspace_write.network_access=false",
                "web_search=disabled")


def build_argv(exe: str, task: Task, model: str | None = None,
               effort: str | None = None) -> list[str]:
    sandbox = "read-only" if task.mode == Mode.READ else "workspace-write"
    argv = [exe, "exec", "--json", "--sandbox", sandbox, "--skip-git-repo-check",
            "--ignore-user-config", "--ignore-rules", "--ephemeral",
            "-C", str(task.root)]
    for f in DISABLED_FEATURES:
        argv += ["--disable", f]
    if task.mode == Mode.WRITE:
        for c in WRITE_CONFIG:
            argv += ["-c", c]
    if model:
        argv += ["-m", model]
    if effort:
        # Unquoted, like WRITE_CONFIG: TOML falls back to a plain string.
        argv += ["-c", f"model_reasoning_effort={effort}"]
    argv.append("-")
    return argv


def parse_line(line: str) -> dict[str, Any] | None:
    """One JSONL line -> a normalised event, or None. Pure, for tests."""
    line = line.strip()
    if not line.startswith("{"):
        return None
    try:
        d = json.loads(line)
    except ValueError:
        return None
    t = d.get("type")
    if t == "thread.started":
        return {"k": "init", "session_id": d.get("thread_id", "")}
    if t == "error":
        return {"k": "error", "text": d.get("message", "")}
    if t == "turn.failed":
        return {"k": "failed", "text": ((d.get("error") or {}).get("message") or "")}
    if t == "turn.completed":
        return {"k": "done", "usage": d.get("usage") or {}}
    if t in ("item.completed", "item.started"):
        item = d.get("item") or {}
        it = item.get("type")
        # Only COMPLETED items become transcript: a started agent_message has
        # no text yet, and a started command has no output.
        done = t == "item.completed"
        if it == "agent_message" and done:
            return {"k": "text", "text": item.get("text", "")}
        if it == "command_execution" and not done:
            return {"k": "tool", "name": "Bash", "target": item.get("command", "")}
        if it == "file_change" and done:
            paths = ", ".join(c.get("path", "") for c in item.get("changes") or [])
            return {"k": "tool", "name": "Edit", "target": paths}
        if it == "web_search" and not done:
            return {"k": "tool", "name": "WebSearch", "target": item.get("query", "")}
        if it == "mcp_tool_call" and not done:
            return {"k": "tool", "name": f"{item.get('server')}.{item.get('tool')}", "target": ""}
        if it == "error" and done:
            return {"k": "error", "text": item.get("message", "")}
    return None


def classify_failure(text: str) -> Outcome:
    if _UNAUTH.search(text or ""):
        return Outcome.UNAUTHED
    if _LIMIT.search(text or ""):
        return Outcome.LIMITED
    return Outcome.TASK_FAILED


def parse_reset(text: str) -> float | None:
    """ "try again in 2 hours 13 minutes" -> an absolute timestamp. """
    m = _IN.search(text or "")
    if not m:
        return None
    secs = 0
    for n, unit in re.findall(r"(\d+)\s*([a-z]+)", m.group(1).lower()):
        n = int(n)
        if unit.startswith("d"):
            secs += n * 86400
        elif unit.startswith("h"):
            secs += n * 3600
        elif unit.startswith("m"):
            secs += n * 60
        elif unit.startswith("s"):
            secs += n
    return time.time() + secs if secs else None


def _window_name(minutes: float) -> str:
    """Codex names its windows in minutes; the UI wants "5h" or "30d"."""
    mins = int(minutes or 0)
    if mins <= 0:
        return "window"
    if mins < 60:
        return f"{mins}m"
    if mins < 1440:
        return f"{mins // 60}h"
    return f"{mins // 1440}d"


def session_usage(slot: str) -> dict[str, dict]:
    """How much of its allowance this Codex account has used.

    `codex exec --json` never says -- it reports tokens, not windows. The
    numbers do exist, in the rollout file Codex writes for the session:
    `rate_limits.primary/secondary`, each with `used_percent`,
    `window_minutes` and `resets_at`. So MAGI reads the newest rollout rather
    than spending a run to be told, and the percentage shown is as fresh as
    the last time this account was used.
    """
    d = slots.slot_dir("codex", slot)
    root = (d / "sessions") if d else None
    if not root or not root.is_dir():
        return {}
    files = sorted((p for p in root.rglob("rollout-*.jsonl") if p.is_file()),
                   key=lambda p: p.stat().st_mtime, reverse=True)
    for p in files[:3]:
        try:
            # The last mention wins: a long session updates it as it goes.
            # Only the tail is read -- a busy session's rollout is megabytes,
            # and this runs every time Accounts is opened.
            with p.open("rb") as fh:
                fh.seek(max(0, p.stat().st_size - 512 * 1024))
                raw = fh.read().decode("utf-8", "replace")
        except OSError:
            continue
        i = raw.rfind('"rate_limits"')
        if i < 0:
            continue
        chunk = raw[max(0, raw.rfind("\n", 0, i)):]
        line = chunk.split("\n", 2)[1] if chunk.startswith("\n") else chunk.split("\n", 1)[0]
        try:
            rl = _find_rate_limits(json.loads(line))
        except ValueError:
            continue
        if not rl:
            continue
        out: dict[str, dict] = {}
        for which in ("primary", "secondary"):
            w = rl.get(which)
            if not isinstance(w, dict) or w.get("used_percent") is None:
                continue
            out[_window_name(w.get("window_minutes", 0))] = {
                "utilization": float(w["used_percent"]) / 100.0,
                "resets_at": w.get("resets_at"),
                "at": p.stat().st_mtime,
            }
        if out:
            return out
    return {}


def _find_rate_limits(node) -> dict | None:
    """`rate_limits` sits at a different depth in different Codex versions."""
    if isinstance(node, dict):
        if isinstance(node.get("rate_limits"), dict):
            return node["rate_limits"]
        for v in node.values():
            hit = _find_rate_limits(v)
            if hit:
                return hit
    elif isinstance(node, list):
        for v in node:
            hit = _find_rate_limits(v)
            if hit:
                return hit
    return None


class CodexCLIAgent(CodingAgent):
    kind = "cli"

    def __init__(self, slot: str, model: str | None = None):
        self.slot = slot
        self.model = model
        self.id = f"codex:{slot}"
        self.label = f"Codex ({slots.label_of('codex', slot) or slot})"

    async def available(self) -> tuple[bool, str]:
        if not slots.cli_path("codex"):
            return False, "Codex CLI is not installed."
        until, why = models.cap_block("codex", self.slot)
        if until:
            return False, f"{why} — until {_when(until)}"
        until = limits.blocked_until("codex", self.slot)
        if until:
            return False, "Limited until " + time.strftime("%H:%M", time.localtime(until))
        used_up = models.plan_used_up("codex", self.slot)
        cr = models.credits("codex", self.slot)
        if used_up and not (cr.get("enabled") and not cr.get("exhausted")):
            return False, f"Plan limit reached until {_when(used_up)}; no ChatGPT credits to carry on"
        st = await asyncio.get_running_loop().run_in_executor(
            None, slots.status, "codex", self.slot)
        return (st.signed_in, st.detail or ("" if st.signed_in else "Not signed in."))

    def _pick(self, task: Task) -> dict:
        if self.model:
            return {"model": self.model, "effort": None, "auto": False, "label": self.model,
                    "why": "fixed", "note": ""}
        return models.choose("codex", self.slot, task.prompt, str(task.mode))

    async def run(self, task: Task, *, emit: EventFn, cancel: asyncio.Event) -> Result:
        exe = slots.cli_path("codex")
        if not exe:
            return Result(Outcome.UNAVAILABLE, detail="Codex CLI is not installed.")

        pick = self._pick(task)
        if pick.get("note"):
            await emit({"k": "note", "text": pick["note"]})
        await emit({"k": "model", "agent": "codex", "slot": self.slot,
                    **{k: pick.get(k) for k in ("model", "label", "effort", "auto", "why")}})
        prompt = task.full_prompt()
        try:
            s = Stream(build_argv(exe, task, pick.get("model"), pick.get("effort")), cwd=task.root,
                       env=slots.env_for("codex", self.slot), stdin_text=prompt)
        except OSError as exc:
            return Result(Outcome.UNAVAILABLE, detail=f"Could not start Codex: {exc}")

        texts: list[str] = []
        errors: list[str] = []
        tools: list[str] = []
        session = ""
        failed = ""
        finished = False
        capped: list[str] = []

        def trip(why: str) -> None:
            if not capped:
                capped.append(why)
                s.kill()
        watch = asyncio.ensure_future(models.cap_watch("codex", self.slot, trip))
        await emit({"k": "note", "text": f"Codex ({self.slot}) is " + (
            "editing a sandbox copy of the workspace." if task.mode == Mode.WRITE
            else "reading the workspace.")})

        try:
            async for raw in s.lines(cancel):
                ev = parse_line(raw)
                if not ev:
                    continue
                k = ev["k"]
                if k == "init":
                    session = ev["session_id"]
                elif k == "text":
                    texts.append(ev["text"])
                    await emit(ev)
                elif k == "tool":
                    tools.append(ev["name"])
                    await emit(ev)
                elif k == "error":
                    errors.append(ev["text"])
                    # A 401 is not going to fix itself on reconnect 3 of 5. Stop
                    # now rather than spend the retries finding that out.
                    if _UNAUTH.search(ev["text"]):
                        s.kill()
                        break
                elif k == "failed":
                    failed = ev["text"]
                elif k == "done":
                    finished = True
        finally:
            watch.cancel()

        if cancel.is_set():
            return Result(Outcome.CANCELLED, session_id=session, tools_used=tools)
        await s.wait()

        text = "\n\n".join(t for t in texts if t).strip()
        if capped:
            return Result(Outcome.LIMITED, text=text, detail=capped[0], session_id=session,
                          tools_used=tools)
        if finished and not failed:
            limits.clear("codex", self.slot)
            return Result(Outcome.OK, text=text, session_id=session, tools_used=tools)

        why = failed or "\n".join(errors[-3:]) or "\n".join(s.stderr_tail)
        outcome = classify_failure(why)
        if outcome == Outcome.TASK_FAILED and not texts and not tools:
            # Nothing happened at all -- the run never got as far as the task.
            outcome = Outcome.UNAVAILABLE
        resets = None
        if outcome == Outcome.LIMITED:
            resets = limits.mark("codex", self.slot, parse_reset(why), "codex")
        return Result(outcome, text=text, detail=why[-600:], resets_at=resets,
                      session_id=session, tools_used=tools)


def _when(ts: float) -> str:
    if ts - time.time() > 20 * 3600:
        return time.strftime("%b %d", time.localtime(ts)).replace(" 0", " ")
    return time.strftime("%H:%M", time.localtime(ts))
