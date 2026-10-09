"""Codex through `codex app-server`: the same run as `codex exec`, steerable.

`codex exec` reads its prompt and nothing more, so a message typed while it
works could only reach it by stopping it and resuming the thread. The app
server (stdio JSON-RPC, the protocol the Codex IDE extension speaks) takes a
message INTO a running turn -- `turn/steer` -- which is what Claude Code in VS
Code does, and what this runner uses:

    initialize -> thread/start | thread/resume -> turn/start
    ... item/started  (a tool is about to run: deliver what you typed, as
                       turn/steer, so it is in the very next model call)
    ... turn/completed (anything still queued, or interrupted for: one more
                       turn/start on the same thread, same process)

"Interrupt now" is `turn/interrupt`; the message then starts the next turn.

The run is held to exactly what codex_cli.build_argv gives `exec`, checked
live on 0.162 (2026-10-09) before this shipped:

  * the same `--disable` features and `-c` sandbox config on the command
    line (the elevated Windows sandbox; workspace-write's temp and network
    exemptions off), and the thread's `sandbox` + every turn's
    `sandboxPolicy` (read-only, or workspace-write with the task's private
    copies as its only writable roots). A write in read-only mode came back
    "Access to the path ... is denied".
  * `approvalPolicy: "never"`, and any approval the server asks for anyway
    is DECLINED -- there is no person at this end to ask.
  * `--ignore-user-config` / `--ignore-rules` have no app-server spelling.
    Their job is done by `projects={}` (nothing is trusted, so no project's
    `.codex` config, hooks or exec policies load -- verified with a hostile
    `.codex/` in the folder) and by `usable()`, which falls back to `exec`
    if MAGI's own CODEX_HOME ever holds a config key beyond `projects` or a
    rules file.

Anything that goes wrong BEFORE the first turn starts (an older Codex, a
refused thread) returns None and the caller runs `exec` instead -- nothing
was sent to the model yet. A Codex whose `turn/steer` is refused keeps going
and gets your messages as the next turn instead.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from .base import Mode, Task

# How long the server may take to start the first turn before `exec` runs
# the task instead (it answers in about a second; a thread on a slow disk
# takes a few).
BOOT_S = 90.0

# Versions whose app server could not start a thread here: `exec` for the
# rest of this engine's life (it restarts when Codex updates).
_broken: set[str] = set()

# Approvals the server can ask for. MAGI answers every one of them no.
_DECLINE = {
    "item/commandExecution/requestApproval": {"decision": "decline"},
    "item/fileChange/requestApproval": {"decision": "decline"},
    "applyPatchApproval": {"decision": "denied"},
    "execCommandApproval": {"decision": "denied"},
}

# Items whose START means a tool is about to run: the next model call comes
# after it, so a message steered in now is in that call.
_TOOL_ITEMS = ("commandExecution", "fileChange", "mcpToolCall", "webSearch",
               "dynamicToolCall")


def usable(codex_home: Path | None, version: str) -> tuple[bool, str]:
    """May this run use the app server? (False, why) sends it to `exec`."""
    if os.environ.get("MAGI_CODEX_EXEC"):
        return False, "MAGI_CODEX_EXEC is set"
    if version in _broken:
        return False, f"Codex {version}'s app server did not start a thread here"
    if codex_home is None:
        return False, "no CODEX_HOME"
    rules = codex_home / "rules"
    if rules.is_dir() and any(rules.iterdir()):
        return False, "CODEX_HOME has rules files"
    cfg = codex_home / "config.toml"
    if cfg.is_file():
        try:
            import tomllib
            data = tomllib.loads(cfg.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False, "CODEX_HOME config.toml is unreadable"
        extra = sorted(set(data) - {"projects"})
        if extra:
            return False, "CODEX_HOME config.toml sets " + ", ".join(extra)
    return True, ""


def mark_broken(version: str) -> None:
    _broken.add(version)


def build_argv(exe: str, task: Task) -> list[str]:
    """The app server with exactly `exec`'s features and sandbox config."""
    from .codex_cli import DISABLED_FEATURES, SANDBOX_CONFIG, WRITE_CONFIG
    argv = [exe, "app-server"]
    for f in DISABLED_FEATURES:
        argv += ["--disable", f]
    for c in (WRITE_CONFIG if task.mode == Mode.WRITE else SANDBOX_CONFIG):
        if c.endswith("network_access=false") and (task.shell or {}).get("internet"):
            c = "sandbox_workspace_write.network_access=true"
        argv += ["-c", c]
    # Trust nothing: no project's .codex config, hooks or exec policies.
    argv += ["-c", "projects={}"]
    return argv


def sandbox_policy(task: Task) -> dict[str, Any]:
    """Every turn's sandbox, restated (a turn may override the thread's)."""
    if task.mode == Mode.READ:
        return {"type": "readOnly", "networkAccess": False}
    return {"type": "workspaceWrite",
            "writableRoots": [str(task.root)] + [str(c) for _, c in task.writes],
            "networkAccess": bool((task.shell or {}).get("internet")),
            "excludeTmpdirEnvVar": True, "excludeSlashTmp": True}


def thread_params(task: Task, model: str | None) -> dict[str, Any]:
    p: dict[str, Any] = {"cwd": str(task.root), "approvalPolicy": "never",
                         "sandbox": "read-only" if task.mode == Mode.READ else "workspace-write"}
    if model:
        p["model"] = model
    return p


def turn_params(thread: str, task: Task, text: str, images: list[Path] | None = None,
                effort: str | None = None) -> dict[str, Any]:
    inp: list[dict[str, Any]] = [{"type": "text", "text": text}]
    inp += [{"type": "localImage", "path": str(p)} for p in images or []]
    p: dict[str, Any] = {"threadId": thread, "input": inp, "approvalPolicy": "never",
                         "sandboxPolicy": sandbox_policy(task), "cwd": str(task.root)}
    if effort:
        p["effort"] = effort
    return p


def request(rid: int, method: str, params: dict[str, Any] | None = None) -> str:
    msg: dict[str, Any] = {"jsonrpc": "2.0", "id": rid, "method": method}
    if params is not None:
        msg["params"] = params
    return json.dumps(msg)


def notify(method: str) -> str:
    return json.dumps({"jsonrpc": "2.0", "method": method})


def answer_server(d: dict[str, Any]) -> str:
    """The reply to a request FROM the server: an approval is declined, and
    anything else (asking the person a question, a tool MAGI does not
    provide, a token refresh) is refused."""
    rid, method = d.get("id"), d.get("method", "")
    if method in _DECLINE:
        return json.dumps({"jsonrpc": "2.0", "id": rid, "result": _DECLINE[method]})
    return json.dumps({"jsonrpc": "2.0", "id": rid,
                       "error": {"code": -32601, "message": f"MAGI does not answer {method}"}})


def parse(line: str) -> dict[str, Any] | None:
    """One line from the server -> a normalised event, or None. Pure.

      {"k":"resp","id":n,"result":{...}|None,"error":"..."}
      {"k":"server","raw":{...}}            a request to answer (answer_server)
      {"k":"init","session_id":...}         thread started
      {"k":"turn","id":...}                 turn started
      {"k":"step"}                          a tool is about to run
      {"k":"tool","name":...,"target":...}  as codex_cli.parse_line
      {"k":"text","text":...}
      {"k":"error","text":...,"retry":bool,"info":...}
      {"k":"done","status":...,"text":...}  turn completed
      {"k":"limits","windows":{name:{utilization,resets_at}}}
    """
    line = line.strip()
    if not line.startswith("{"):
        return None
    try:
        d = json.loads(line)
    except ValueError:
        return None
    method = d.get("method")
    if "id" in d and not method:
        err = d.get("error")
        return {"k": "resp", "id": d.get("id"), "result": d.get("result"),
                "error": (err.get("message") or "error") if isinstance(err, dict) else ""}
    if "id" in d and method:
        return {"k": "server", "raw": d}
    p = d.get("params") or {}
    if method == "thread/started":
        return {"k": "init", "session_id": (p.get("thread") or {}).get("id", "")}
    if method == "turn/started":
        return {"k": "turn", "id": (p.get("turn") or {}).get("id", "")}
    if method == "turn/completed":
        turn = p.get("turn") or {}
        return {"k": "done", "status": turn.get("status", ""),
                "text": ((turn.get("error") or {}).get("message") or "")}
    if method == "error":
        e = p.get("error") or {}
        return {"k": "error", "text": e.get("message", ""), "retry": bool(p.get("willRetry")),
                "info": e.get("codexErrorInfo")}
    if method == "account/rateLimits/updated":
        rl = p.get("rateLimits") or {}
        from .codex_cli import _window_name
        out = {}
        for which in ("primary", "secondary"):
            w = rl.get(which)
            if isinstance(w, dict) and w.get("usedPercent") is not None:
                out[_window_name(w.get("windowDurationMins") or 0)] = {
                    "utilization": float(w["usedPercent"]) / 100.0,
                    "resets_at": w.get("resetsAt")}
        return {"k": "limits", "windows": out} if out else None
    if method in ("item/started", "item/completed"):
        item = p.get("item") or {}
        it = item.get("type")
        started = method == "item/started"
        if started and it == "commandExecution":
            return {"k": "tool", "name": "Bash", "target": item.get("command", ""), "step": True}
        if started and it == "webSearch":
            return {"k": "tool", "name": "WebSearch", "target": item.get("query", ""), "step": True}
        if started and it == "mcpToolCall":
            return {"k": "tool", "name": f"{item.get('server')}.{item.get('tool')}",
                    "target": "", "step": True}
        if started and it in _TOOL_ITEMS:
            return {"k": "step"}
        if not started and it == "fileChange":
            paths = ", ".join(c.get("path", "") for c in item.get("changes") or [])
            return {"k": "tool", "name": "Edit", "target": paths}
        if not started and it == "agentMessage" and item.get("text"):
            return {"k": "text", "text": item["text"]}
    return None


def steer_text(msgs: list[str], interrupted: bool = False) -> str:
    """Messages typed mid-run, as Codex is given them."""
    head = ("The person stopped your last step to send this; carry on with the task "
            "taking it into account:" if interrupted else
            "The person sent this while you were working; take it into account:")
    return head + "\n" + "\n\n".join(msgs)


class Session:
    """Request ids and what each one was for -- the state machine's memory."""

    def __init__(self) -> None:
        self.next_id = 0
        self.pending: dict[int, str] = {}
        self.thread = ""
        self.turn = ""
        self.started = time.time()

    def req(self, method: str, params: dict[str, Any] | None = None) -> str:
        self.next_id += 1
        self.pending[self.next_id] = method
        return request(self.next_id, method, params)

    def what(self, rid: Any) -> str:
        return self.pending.pop(rid, "") if isinstance(rid, int) else ""
