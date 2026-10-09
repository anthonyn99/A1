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

Every task starts with a pull (Phase 9, git.py): an answer about stale code
is a wrong answer, and an edit made on stale code is a conflict waiting to
happen. A pull that cannot finish cleanly is undone and stops the task.
MAGI's own repository is only fetched, never pulled: its working tree is the
one other sessions are editing.

Write mode (Phase 8) wraps the chain in a sandbox (sandbox.py):

    copy the workspace ─► chain edits the copy ─► diff ─► security.review
        ─► approval card (5 min; silence = deny; first device to answer wins)
        -- or, in Auto, no card: applied at once (below)
        ─► apply onto the real folder ─► remove the copy, always
        ─► (only if you press it) commit exactly the applied files

A refused diff never reaches the card, and nothing reaches the real folder
without an explicit Approve.

Track V3: a write task can also CHANGE other registered workspaces
(`writes`). Each gets its own private copy, its changes are diffed and
reviewed like the main one's, and they share ONE card -- a section per
workspace -- and one decision: applied together or not at all
(sandbox.apply_all). Nothing is committed without a second, separate
press, and nothing is pushed without a third (Phase 10): Push, as the GitHub
account the project names, never forced.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import git as G
from . import autocommit, followup, sandbox, security
from .agents import chain, inventory
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
    repo: str = ""            # the repository top the change was applied to
    committing: bool = False
    github: str = ""          # the GitHub login this project pushes/pulls as
    pushing: bool = False
    attachments: list[tuple[str, str]] = field(default_factory=list)
    images: list = field(default_factory=list)   # [agents.base.Image]
    # The project's check command (check.py), fixed when the task starts.
    check_cfg: dict[str, Any] = field(default_factory=dict)
    check_cwd: str = ""       # the copy's workspace folder, while the card is up
    check_job: asyncio.Task | None = None
    check_stop: asyncio.Event = field(default_factory=asyncio.Event)
    check_result: dict[str, Any] | None = None
    # "manual": the diff waits on the approval card. "auto": a diff that
    # passes security.review (and the project's automatic check, if it has
    # one) is applied without asking. Everything review REFUSES stays
    # refused in both -- Auto skips the question, never the rules.
    approve: str = "manual"
    # Track F (F3): the session this task is a turn of (its own id on turn
    # 1), and the messages typed while it runs (followup.Steer).
    session_id: str = ""
    turn: int = 1
    steer: followup.Steer = field(default_factory=followup.Steer)
    # A revision asked for at the card, until the chain runs again: more
    # messages in that gap join the same revision.
    revising: bool = False
    # Track V: other workspaces this task may read, as (name, folder).
    refs: list[tuple[str, str]] = field(default_factory=list)
    # Track V3: other workspaces this task may CHANGE (write mode), each in
    # its own private copy -- as Part, below. The main workspace is not here.
    writes: list["Part"] = field(default_factory=list)
    # Track V4: what the agent proposed (its COMMIT: and BRANCH: lines).
    suggest_subject: str = ""
    suggest_branch: str = ""
    # Track W2: the shell's scratch folder (scripts, TMP), removed at the end.
    shell_scratch: str = ""
    # Track W3: the project's checkers (problems.detect), when this task can run them.
    problem_checkers: list = field(default_factory=list)
    problems_after: dict | None = None
    # Track W4: the file open in the console's viewer ({path, start, end}).
    open: dict | None = None
    opening_pr: bool = False

    @property
    def checking(self) -> bool:
        return self.check_job is not None and not self.check_job.done()

    @property
    def awaiting_approval(self) -> bool:
        return self.approval is not None and not self.approval.done()

    def summary(self) -> dict[str, Any]:
        return {"id": self.id, "project_id": self.project_id,
                "prompt": self.prompt[:200], "mode": self.mode,
                "started": self.started, "done": self.done,
                "awaiting_approval": self.awaiting_approval,
                "checking": self.checking,
                "outcome": (self.result or {}).get("outcome"),
                "write": (self.result or {}).get("write"),
                "by": (self.result or {}).get("by_label"),
                "attachments": [n for n, _ in self.attachments] + [im.name for im in self.images],
                "approve": self.approve,
                "session_id": self.session_id or self.id, "turn": self.turn}


TASKS: dict[str, TaskState] = {}


@dataclass
class Part:
    """One workspace a write task changes besides the main one (Track V3)."""
    name: str                 # @name, as the agents and the card call it
    project_id: str
    root: str                 # the real folder
    github: str = ""
    sb: sandbox.Sandbox | None = None
    copy: str = ""            # the private copy's workspace folder, once made

    def label(self, path: str) -> str:
        return f"@{self.name}/{path}"


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
    tgt = ev.get("target")
    if isinstance(tgt, str) and not any(
            b and _rel(tgt, b) != tgt for w in t.writes for b in (w.copy, w.root)):
        for base in (t.sandbox_root, t.root):
            if base and isinstance(ev.get("target"), str):
                ev["target"] = _rel(ev["target"], base)
    # A reference folder's file -- or one in another workspace this task
    # changes (its copy first, then its real folder) -- reads as @name/path,
    # the way the agent was told to name it.
    for name, base in [(w.name, b) for w in t.writes for b in (w.copy, w.root) if b] + t.refs:
        tgt = ev.get("target")
        if isinstance(tgt, str):
            rel = _rel(tgt, base)
            if rel != tgt:
                ev["target"] = f"@{name}" + ("" if rel == "." else "/" + rel)
    if len(t.events) < MAX_EVENTS:
        t.events.append(ev)
    for q in list(t.viewers):
        q.put_nowait(ev)


def _prune() -> None:
    done = sorted((t for t in TASKS.values() if t.done), key=lambda t: t.started)
    for t in done[:-KEEP_FINISHED]:
        TASKS.pop(t.id, None)


async def start(*, project_id: str, root: Path, prompt: str, order: list[str],
                settings, mode: str = "read", github: str = "",
                attachments: list[tuple[str, str]] | None = None,
                images: list | None = None,
                check: dict[str, Any] | None = None,
                approve: str = "manual",
                session: followup.Session | None = None,
                refs: list[tuple[str, Path]] | None = None,
                writes: list[Part] | None = None,
                open_: dict[str, Any] | None = None) -> TaskState:
    t = TaskState(id=uuid.uuid4().hex[:12], project_id=project_id,
                  prompt=prompt, mode=mode, root=str(root), github=github,
                  attachments=list(attachments or []), images=list(images or []),
                  check_cfg=dict(check or {}) if mode == "write" else {},
                  approve="auto" if approve == "auto" else "manual")
    t.refs = [(n, str(p)) for n, p in refs or []]
    t.open = open_
    # Read mode changes nothing anywhere: a workspace ticked to change is
    # only read there (routes passes it as a ref instead).
    t.writes = list(writes or []) if mode == "write" else []
    t.session_id = session.id if session else t.id
    t.turn = session.turn if session else 1
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
                              "approve": t.approve,
                              "session_id": t.session_id, "turn": t.turn,
                              "attachments": [n for n, _ in t.attachments] + [im.name for im in t.images],
                              "refs": [n for n, _ in t.refs],
                              "writes": [w.name for w in t.writes],
                              **({"open": t.open} if t.open else {}),
                              "chain": [{"id": a.id, "label": a.label, "kind": a.kind}
                                        for a in agents]})
            pulled = await _pull_first(t, root)
            for w in t.writes:
                if not pulled.ok:
                    break
                pulled = await _pull_first(t, Path(w.root), w.github, name=w.name)
            if not pulled.ok:
                t.result = {"outcome": "pull_failed", "text": "", "detail": pulled.text,
                            "conflicts": pulled.conflicts, "attempts": []}
                return
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
                # Track V3: a private copy of each other workspace it changes.
                for i, w in enumerate(t.writes, 2):
                    try:
                        w.sb = await loop.run_in_executor(
                            None, sandbox.create, Path(w.root), f"{t.id}-{i}", _profile())
                    except sandbox.SandboxError as e:
                        await emit({"k": "error", "text": f"@{w.name}: {e.message}"})
                        t.result = {"outcome": "unavailable", "text": "", "write": "refused",
                                    "detail": f"@{w.name}: {e.message}", "attempts": []}
                        return
                    w.copy = str(w.sb.cwd)
                if t.writes:
                    await emit({"k": "note", "text": "Also changing, each in its own private "
                                "copy: " + ", ".join("@" + w.name for w in t.writes)
                                + ". One card covers every workspace, applied together or "
                                "not at all."})
            # Track V: in write mode Claude also gets the workspace tools
            # (ws_mcp.py) -- move, copy, delete, make folder -- and the
            # project's check, if you let agents run it.
            ws = None
            # Track V6: the named commands agents may run, set on this PC.
            from . import commands as _cmds
            cmds = _cmds.get(project_id) if sb is not None else []
            # Track W2: the agents' sandboxed shell, if this PC can give one
            # and the project has it on. Write: in the copy; Read: your real
            # folder, read-only.
            from . import shell as _shell
            shcfg = _shell.get(project_id)
            sh = None
            sh_why = ""
            if shcfg["enabled"]:
                ok, why = await loop.run_in_executor(None, lambda: _shell.availability(wait=True))
                if ok:
                    scratch = _shell.scratch_for(t.id)
                    t.shell_scratch = str(scratch)
                    sh = await loop.run_in_executor(None, lambda: _shell.spec(
                        cwd=sb.cwd if sb is not None else root, scratch=scratch,
                        write=sb is not None, internet=shcfg["internet"],
                        extra_writable=[Path(w.copy) for w in t.writes if w.copy]))
                else:
                    sh_why = why
                    await emit({"k": "note", "text": f"No shell for the agents in this task: {why}"})
            else:
                sh_why = "switched off for this project (Check sheet)"
            if sb is not None:
                ck = t.check_cfg if t.check_cfg.get("agents") else {}
                ws = {"root": str(sb.cwd), "real": str(root),
                      "check": ({"command": ck["command"], "timeout_min": ck.get("timeout_min")}
                                if ck.get("command") else None),
                      "refs": [{"name": n, "root": p} for n, p in t.refs],
                      "writes": [{"name": w.name, "root": w.copy} for w in t.writes],
                      "commands": cmds, "shell": sh}
            elif sh is not None:
                # Read mode: a server with the shell only (and the reference
                # tools) -- nothing on it changes a file.
                ws = {"root": str(root), "readonly": True, "shell": sh,
                      "refs": [{"name": n, "root": p} for n, p in t.refs]}
            # Track W1: the project's own instructions, for every agent.
            from . import instructions as _instr
            top = await loop.run_in_executor(None, G.toplevel, root)
            instr, instr_files = await loop.run_in_executor(
                None, lambda: _instr.load(root, top))
            if instr_files:
                await emit({"k": "tool", "name": "Instructions",
                            "target": ", ".join(instr_files)})
            # Track W3: the project's Problems, as last checked on this engine.
            from . import problems as _prob
            prob_block = _prob.block(_prob.CACHE.get(project_id))
            t.problem_checkers = (await loop.run_in_executor(None, _prob.detect, root)
                                  if sh is not None and sb is not None else [])
            if t.problem_checkers and ws is not None:
                ws["problems"] = t.problem_checkers
            # Track W4: the file open in the viewer, and its selected lines,
            # from your real folder as it is now.
            from . import editor as _editor
            ed_block, ed = await loop.run_in_executor(None, _editor.block, root, t.open)
            if ed:
                await emit({"k": "tool", "name": "Open in editor", "target": ed["path"] + (
                    "" if not ed["start"] else f":{ed['start']}" if ed["start"] == ed["end"]
                    else f":{ed['start']}-{ed['end']}")})
            elif t.open:
                await emit({"k": "note", "text": f"{t.open['path']} (open in the viewer) could "
                            "not be read, so the agents are not told about it."})
            if t.refs:
                await emit({"k": "note", "text": "Also reading, never changing: "
                            + ", ".join("@" + n for n, _ in t.refs) + "."})
            mcp = await loop.run_in_executor(
                None, lambda: write_mcp_config(t.id, project_id, root, github, workspace=ws))
            # A question about sizes or rankings: measured here, handed over
            # (inventory.py). From the real folder, which the copy mirrors.
            inv = ""
            if inventory.wants(prompt):
                inv = await loop.run_in_executor(None, lambda: inventory.block(root, prompt=prompt))
                if inv:
                    n = inv.split("TOTAL: ", 1)[-1].split(" files", 1)[0]
                    await emit({"k": "tool", "name": "Inventory",
                                "target": f"{n} files measured by MAGI"})
            task = Task(id=t.id, prompt=prompt, root=sb.cwd if sb else root,
                        mode=Mode.WRITE if sb else Mode.READ,
                        progress=(lambda: _changed(sb, t.writes)) if sb else None,
                        mcp_config=mcp,
                        mcp_servers=mcp_servers_in(mcp),
                        agent_check=((ws or {}).get("check") or {}).get("command", ""),
                        agent_check_min=int(((ws or {}).get("check") or {}).get("timeout_min") or 0),
                        real_root=root, agent_commands=cmds, instructions=instr,
                        shell=sh, shell_why=sh_why, problems=prob_block,
                        editor=ed_block, editor_path=(ed or {}).get("path", ""),
                        attachments=t.attachments, images=t.images, inventory=inv,
                        refs=[(n, Path(p)) for n, p in t.refs],
                        writes=[(w.name, Path(w.copy)) for w in t.writes])
            if session is not None:
                task.session_turns = session.turns
                task.state_note = followup.state_note(session.turns)
                own = next((a for a in agents if a.id == session.native.get("agent")), None)
                if own is not None:
                    task.resume = {**session.native, "why": "followup"}
                    await emit({"k": "note", "text": f"{own.label} continues its own session "
                                "from the last turn."})
            res = await chain.run_chain(task, agents, emit=emit, cancel=t.cancel, steer=t.steer)
            t.result = res.to_dict()
            _take_suggestions(t)
            while sb is not None:
                if res.outcome == Outcome.OK and not t.cancel.is_set():
                    out = await _review_and_apply(t, sb)
                    if out.get("write") == "revised" and not t.cancel.is_set():
                        res = await _revise(t, task, agents, res, sb, emit)
                        t.result = res.to_dict()
                        _take_suggestions(t)
                        continue
                    t.result.update(out)
                else:
                    t.result["write"] = "discarded"
                    if await loop.run_in_executor(None, _changed, sb, t.writes):
                        await emit({"k": "note", "text": "The task did not finish, so its "
                                    "partial edits were discarded. Your folder is unchanged."})
                break
        except Exception as exc:  # noqa: BLE001 -- the transcript must end, not hang
            t.result = {"outcome": "unavailable", "text": "",
                        "detail": f"{type(exc).__name__}: {exc}", "attempts": []}
        finally:
            # From here on a message is the next follow-up -- and one that
            # never reached an agent (typed during the pull, or just before a
            # Halt or a failure) goes back to the console to send as one.
            t.steer.close()
            t.revising = False
            left = t.steer.take()
            if left:
                t.result = {**(t.result or {}), "unsent_messages": left}
            if t.approval is not None and not t.approval.done():
                t.approval.cancel()
            # A check still running is running IN the copy about to be
            # removed: stop it, and let it take its dependency links down,
            # before anything deletes that folder.
            await _stop_check(t)
            if sb is not None:
                await loop.run_in_executor(None, sb.remove)
            for w in t.writes:
                if w.sb is not None:
                    await loop.run_in_executor(None, w.sb.remove)
            _mcp_path(t.id).unlink(missing_ok=True)
            _ws_path(t.id).unlink(missing_ok=True)
            if t.shell_scratch:
                # Scripts and temp files; the package cache is kept (shell.cache_dir).
                import shutil as _sh
                await loop.run_in_executor(None, lambda: _sh.rmtree(t.shell_scratch, ignore_errors=True))
            t.done = True
            await publish(t, {"k": "end", "result": t.result})
            for q in list(t.viewers):
                q.put_nowait(None)

    asyncio.create_task(work())
    return t


async def _pull_first(t: TaskState, root: Path, github: str | None = None,
                      name: str = "") -> G.Pull:
    """The §7A rule: pull before anything reads the folder, and say so.
    `name`: another workspace this task changes (Track V3), pulled as its
    own project's account and named in the transcript."""
    loop = asyncio.get_running_loop()
    pull = await loop.run_in_executor(None, sandbox.engine_repo_allows, root, "pull")
    auth = await loop.run_in_executor(None, git_auth, t.github if github is None else github)
    try:
        p = await loop.run_in_executor(None, G.pull if pull else G.fetch_only, root, auth)
    except G.GitError as e:
        p = G.Pull(False, text=f"Could not pull: {e.message}")
    await publish(t, {"k": "pull", **p.to_dict(), **({"ws": name} if name else {})})
    return p


def _changed(sb: sandbox.Sandbox, writes: list[Part]) -> list[str]:
    """Files changed so far in every copy, the others' as @name/path."""
    out = sb.changed_files()
    for w in writes:
        if w.sb is not None:
            for ln in w.sb.changed_files():
                st, _, path = ln.partition(" ")
                out.append(f"{st} {w.label(path)}")
    return out[:60]


def _mcp_path(task_id: str) -> Path:
    from ..settings import data_dir
    return data_dir() / "code" / "mcp" / f"{task_id}.json"


def _ws_path(task_id: str) -> Path:
    return _mcp_path(task_id).with_name(f"{task_id}.ws.json")


def mcp_servers_in(cfg: Path | None) -> tuple[str, ...]:
    """The server names an --mcp-config file declares, in order."""
    if cfg is None:
        return ()
    import json
    try:
        return tuple((json.loads(cfg.read_text(encoding="utf-8")).get("mcpServers") or {}).keys())
    except (OSError, ValueError, AttributeError):
        return ()


def _github_server(project_id: str, root: Path, login: str) -> dict | None:
    """Read-only GitHub tools for this project -- only when the folder's
    remote is on GitHub and the project names an account to read it as."""
    if not login:
        return None
    try:
        top = G.toplevel(root)
        remote = G.github_of(top) if top else {}
    except G.GitError:
        return None
    if remote.get("host") != "github.com" or not remote.get("owner"):
        return None
    from .. import ident
    script = Path(__file__).resolve().parents[1] / "github" / "mcp_server.py"
    port = int(ident.engine_identity().get("port") or 8000)
    return {"type": "stdio", "command": _quiet_python(),
            "args": ["-I", str(script), "--port", str(port), "--project", project_id]}


def _quiet_python() -> str:
    import sys
    exe = Path(sys.executable)
    # pythonw where there is one: no console window flashes up when the CLI
    # starts the server, and stdio pipes work the same.
    quiet = exe.with_name("pythonw.exe")
    return str(quiet if quiet.exists() else exe)


def write_mcp_config(task_id: str, project_id: str, root: Path, login: str,
                     workspace: dict | None = None) -> Path | None:
    """The --mcp-config for the Claude CLI: read-only GitHub tools for this
    project (when it is on GitHub with an account), and -- `workspace`, write
    mode only -- the workspace tools for the task's private copy
    (code/ws_mcp.py; `{"root", "real", "check"}`, written to a file of its
    own beside this one so the server reads it, not argv). Nothing in either
    file is a secret; both are outside the copy, so the agent cannot change
    them, and both are removed when the task ends. None = no servers.
    """
    import json
    from .agents.claude_cli import MCP_SERVER, WS_SERVER
    servers: dict[str, dict] = {}
    gh = _github_server(project_id, root, login)
    if gh:
        servers[MCP_SERVER] = gh
    f = _mcp_path(task_id)
    if workspace and workspace.get("root"):
        wf = _ws_path(task_id)
        wf.parent.mkdir(parents=True, exist_ok=True)
        wf.write_text(json.dumps(workspace, indent=1), encoding="utf-8")
        script = Path(__file__).resolve().parent / "ws_mcp.py"
        servers[WS_SERVER] = {"type": "stdio", "command": _quiet_python(),
                              "args": ["-I", str(script), "--config", str(wf)]}
    if not servers:
        return None
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({"mcpServers": servers}, indent=1), encoding="utf-8")
    return f


def _profile() -> str:
    from ..settings import active_profile
    return active_profile()


async def _review_and_apply(t: TaskState, sb: sandbox.Sandbox) -> dict[str, Any]:
    """Diff the copy (copies, Track V3), check, ask, apply. Returns fields
    for the result."""
    loop = asyncio.get_running_loop()
    reviews: list[tuple[Part | None, sandbox.Sandbox, Any]] = []
    for w, psb in [(None, sb)] + [(w, w.sb) for w in t.writes if w.sb is not None]:
        patch = await loop.run_in_executor(None, psb.diff)
        if not patch:
            continue
        # Checked against the REAL repository: a link that is harmless in the
        # copy may point out of the folder the change is about to be applied to.
        rv = await loop.run_in_executor(
            None, lambda p=patch, sb=psb: security.review(
                p.decode("utf-8", "replace"), root=sb.repo, prefix=sb.prefix,
                deny=sandbox.review_deny(sb.repo)))
        if not rv.ok:
            # One workspace's change refused is the whole change refused: the
            # card is one decision, never a part of one.
            text = (f"@{w.name}: " if w else "") + rv.message
            await publish(t, {"k": "refused", "text": text,
                              "refused": [{"path": w.label(p) if w else p, "why": why}
                                          for p, why in rv.refused]})
            return {"write": "refused", "detail": text}
        reviews.append((w, psb, rv))
    if not reviews:
        await publish(t, {"k": "nochange", "text": "The agent made no changes."})
        return {"write": "none"}

    # Track W3: how the change moves the project's Problems -- the checkers
    # run in the copy before the card opens (the copy borrows node_modules /
    # .venv from your folder for the run, as the check does).
    prob = await _problems_after(t, sb)

    # The check command (check.py). Automatic: it runs now, before the card,
    # so the card opens with the result on it and its clock starts after.
    # Otherwise the card offers Run check once you have seen the diff.
    t.check_cwd = str(sb.cwd)
    if t.check_cfg.get("command") and t.check_cfg.get("auto"):
        t.check_job = asyncio.ensure_future(_run_check(t))
        stopper = asyncio.ensure_future(t.cancel.wait())
        try:
            await asyncio.wait({t.check_job, stopper}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            stopper.cancel()
        if t.cancel.is_set():
            await _stop_check(t)
            await publish(t, {"k": "decision", "approved": False, "why": "halted"})
            return {"write": "halted"}

    # Auto: no card. But a check that ran and FAILED is exactly the "key
    # change" Manual exists for, so that one still asks.
    failed_check = t.check_result is not None and not t.check_result.get("ok")
    files = _card_files(reviews)
    if t.approve == "auto" and not failed_check:
        await publish(t, {"k": "decision", "approved": True, "why": "auto",
                          "files": files,
                          "adds": sum(f["adds"] for f in files),
                          "dels": sum(f["dels"] for f in files)})
        return await _apply(t, reviews)
    if t.approve == "auto":
        await publish(t, {"k": "note", "text": "Auto mode, but the check failed — "
                          "asking before anything is applied."})

    t.approval = loop.create_future()
    t.approval_deadline = time.time() + APPROVAL_TIMEOUT
    # A change to the engine's own code does nothing until it restarts -- and
    # a bad one can stop it starting. Said on the card; never restarted here.
    # And in A1 everything approved SHIPS right away (auto commit and
    # push), some of it as a deploy: the card says which.
    sections = []
    for w, psb, prv in reviews:
        own = await loop.run_in_executor(None, sandbox.is_engine_repo, psb.repo)
        paths = [f.path.replace("\\", "/") for f in prv.files]
        a1 = {"ships": True,
              "engine_files": [p for p in paths if p.startswith("magi/")],
              "deploy_files": [p for p in paths if p.startswith(sandbox.ENGINE_REPO_DEPLOYS)]} \
            if own else {}
        sections.append({"name": w.name if w else "", "main": w is None,
                         "project_id": w.project_id if w else t.project_id,
                         "paths": [w.label(p) if w else p for p in paths],
                         "adds": sum(f.adds for f in prv.files),
                         "dels": sum(f.dels for f in prv.files), **a1})
    # The card's top-level A1 flags: any section that ships (labelled paths),
    # so a console that predates sections still says so.
    a1 = {}
    for sec in sections:
        if sec.get("ships"):
            a1["ships"] = True
            for k in ("engine_files", "deploy_files"):
                a1.setdefault(k, []).extend(
                    sec[k] if sec["main"] else [f"@{sec['name']}/{p}" for p in sec[k]])
    await publish(t, {"k": "approval", "files": files, **a1,
                      **({"problems": prob} if prob else {}),
                      **({"sections": sections} if t.writes else {}),
                      "adds": sum(f["adds"] for f in files),
                      "dels": sum(f["dels"] for f in files),
                      "expires_at": t.approval_deadline,
                      "timeout": APPROVAL_TIMEOUT,
                      **({"check": {"command": t.check_cfg["command"],
                                    "auto": bool(t.check_cfg.get("auto")),
                                    "timeout_min": t.check_cfg.get("timeout_min")}}
                         if t.check_cfg.get("command") else {})})

    # The deadline can MOVE: a check started from the card holds the clock
    # while it runs and gives a full window back when it ends (_run_check).
    # So the wait is re-armed against whatever the deadline is now, rather
    # than one fixed timeout.
    halt = asyncio.ensure_future(t.cancel.wait())
    done: set = set()
    try:
        while True:
            left = t.approval_deadline - time.time()
            if left <= 0:
                break
            done, _ = await asyncio.wait({t.approval, halt}, timeout=min(left, 5.0),
                                         return_when=asyncio.FIRST_COMPLETED)
            if done:
                break
    finally:
        halt.cancel()
    if t.approval in done and not t.approval.cancelled() and t.approval.result() == REVISE:
        # A message typed at the card: nothing is applied, the same agent
        # revises in this same copy, and a new card follows (_revise).
        await publish(t, {"k": "decision", "approved": False, "why": "revised"})
        await _stop_check(t)
        t.approval = None
        t.check_result = None
        return {"write": "revised"}
    if t.approval in done and not t.approval.cancelled():
        approved, why = bool(t.approval.result()), ("approved" if t.approval.result() else "denied")
    else:
        why = "halted" if t.cancel.is_set() else "timeout"
        approved = False
        if not t.approval.done():
            t.approval.cancel()
    await publish(t, {"k": "decision", "approved": approved, "why": why})
    # Answered while a check was still going: the answer stands, the check
    # has nothing left to inform.
    await _stop_check(t)
    if not approved:
        return {"write": why}
    return await _apply(t, reviews)


async def _problems_after(t: TaskState, sb: sandbox.Sandbox) -> dict[str, Any] | None:
    """Run the project's checkers in the copy and compare with your folder's
    last result (run now if there is none). None when there are none."""
    if not t.problem_checkers:
        return None
    from . import check as C
    from . import problems as PR
    from . import shell as SH
    loop = asyncio.get_running_loop()
    await publish(t, {"k": "note", "text": "Checking Problems after the change ("
                      + ", ".join(c["name"] for c in t.problem_checkers) + ")…"})
    before = PR.CACHE.get(t.project_id)
    if before is None:
        got = await PR.for_folder(t.project_id, Path(t.root))
        before = got if got.get("ok") else None
    links = await loop.run_in_executor(None, C.link_deps, Path(t.root), sb.cwd)
    try:
        sp = await loop.run_in_executor(None, lambda: SH.spec(
            cwd=sb.cwd, scratch=SH.scratch_for(t.id) / "problems", write=True, internet=False))
        after = await PR.run(sp, Path(t.root), t.problem_checkers)
    finally:
        await loop.run_in_executor(None, C.unlink_deps, links)
    cmp = PR.compare(before, after)
    out = {**cmp, "errors": after["errors"], "warnings": after["warnings"],
           "tools": [r["name"] for r in after["ran"]]}
    t.problems_after = out
    await publish(t, {"k": "problems", **out})
    return out


def _card_files(reviews: list) -> list[dict[str, Any]]:
    """Every changed file for the card, in order: the main workspace's as
    they are, another workspace's as @name/path with `ws` naming it."""
    out = []
    for w, _, rv in reviews:
        for f in rv.files:
            d = f.to_dict()
            if w is not None:
                d["path"] = w.label(d["path"])
                d["ws"] = w.name
            out.append(d)
    return out


async def _revise(t: TaskState, task: Task, agents: list, res: chain.ChainResult,
                  sb: sandbox.Sandbox, emit) -> chain.ChainResult:
    """Run the chain again for a revision asked for at the card: the agent
    that made the diff first -- its own session resumed when it has one --
    in the same copy, so its edits are still there to change."""
    msgs = t.steer.take()
    t.steer.reopen()
    t.revising = False
    by = next((a for a in agents if a.id == res.by), None)
    changed = await asyncio.get_running_loop().run_in_executor(None, sb.changed_files)
    if by is not None:
        chain.prepare_continuation(task, by, said=res.text, sid=res.session_id,
                                   msgs=msgs, why="revise", changed=changed)
    else:
        task.added += msgs
    await emit({"k": "note", "text": "Revising the diff with your message…"})
    order = ([by] if by else []) + [a for a in agents if a is not by]
    again = await chain.run_chain(task, order, emit=emit, cancel=t.cancel, steer=t.steer)
    again.attempts = res.attempts + again.attempts
    return again


# What POST /message resolves the approval future with (never a bool).
REVISE = "revise"


async def message(t: TaskState, text: str) -> dict[str, Any]:
    """A message typed while the task runs (POST /tasks/{id}/message).

    Where it goes depends on where the task is, decided with no await in
    between, so it lands in exactly one place:
      prompt       nothing running yet -- the next agent's prompt has it
      interrupt    a CLI agent is working -- stopped, then resumed with it
      after_reply  a browser unit is working -- sent after its reply
      revise       the approval card is up -- nothing applied, same agent
                   revises, a new card
      followup     applying, committing, ended -- the console sends it as
                   the next turn
    """
    try:
        if t.done or not (t.steer.open or t.awaiting_approval or t.revising):
            text = followup.Steer.check_text(text)
            how = "followup"
        elif t.awaiting_approval or t.revising:
            text = t.steer.hold(text)
            how = REVISE
            if t.awaiting_approval:
                t.revising = True
                t.approval.set_result(REVISE)
        else:
            how = t.steer.add(text)
            text = t.steer.pending[-1]
    except OverflowError as e:
        return {"ok": False, "error": "too_many", "message": str(e)}
    except ValueError as e:
        return {"ok": False, "error": "bad_message", "message": str(e)}
    await publish(t, {"k": "user", "text": text, "how": how})
    return {"ok": True, "accepted": how}


async def _apply(t: TaskState, reviews: list) -> dict[str, Any]:
    """Apply an approved (or Auto) diff to the real folder -- or, across
    workspaces (Track V3), every part of it or none (sandbox.apply_all)."""
    if t.writes:
        return await _apply_parts(t, reviews)
    _, sb, rv = reviews[0]
    loop = asyncio.get_running_loop()
    from ..settings import data_dir
    files = [f.to_dict() for f in rv.files]
    res = await loop.run_in_executor(
        None, sandbox.apply, sb, files, sandbox.patch_dir(data_dir()))
    if res.ok:
        t.repo = str(sb.repo)
        draft = G.draft_message(t.prompt, (t.result or {}).get("text", ""), t.suggest_subject)
        await publish(t, {"k": "applied", "files": res.files, "how": res.how,
                          "draft": draft,
                          **({"branch": t.suggest_branch} if t.suggest_branch else {})})
        out = {"write": "applied", "files": res.files, "draft": draft,
               **({"branch": t.suggest_branch} if t.suggest_branch else {})}
        # Phase 12: where auto commit is on, the commit is MAGI's to make
        # after the project's window -- the stream says when.
        pend = await autocommit.on_applied(project_id=t.project_id, repo=t.repo,
                                           files=res.files, draft=draft, task_id=t.id)
        if pend is not None:
            out["auto"] = pend
            await publish(t, {"k": "autocommit", **pend})
        return out
    if res.how == "refused":
        # Refused at approval time (sandbox.apply re-reviews): nothing written.
        await publish(t, {"k": "refused", "text": res.message,
                          "refused": [{"path": p, "why": ""} for p in res.conflicts]})
        return {"write": "refused", "detail": res.message}
    await publish(t, {"k": "conflict", "text": res.message, "files": res.conflicts,
                      "saved": res.saved_patch})
    return {"write": "conflict", "detail": res.message, "saved": res.saved_patch}


async def _apply_parts(t: TaskState, reviews: list) -> dict[str, Any]:
    """Track V3's apply: several repositories, one decision."""
    loop = asyncio.get_running_loop()
    from ..settings import data_dir
    parts = [(psb, [f.to_dict() for f in rv.files]) for _, psb, rv in reviews]
    results = await loop.run_in_executor(
        None, sandbox.apply_all, parts, sandbox.patch_dir(data_dir()))
    bad = [(w, r) for (w, _, _), r in zip(reviews, results) if not r.ok and r.how != "held"]
    if bad:
        w, r = bad[0]
        where = f"@{w.name}: " if w else ""
        if r.how == "refused":
            await publish(t, {"k": "refused", "text": where + r.message,
                              "refused": [{"path": w.label(p) if w else p, "why": ""}
                                          for p in r.conflicts]})
            return {"write": "refused", "detail": where + r.message}
        await publish(t, {"k": "conflict", "text": where + r.message,
                          "files": [w.label(p) if w else p for p in r.conflicts],
                          "saved": r.saved_patch})
        return {"write": "conflict", "detail": where + r.message, "saved": r.saved_patch}
    draft = G.draft_message(t.prompt, (t.result or {}).get("text", ""), t.suggest_subject)
    repos, flat = [], []
    for (w, psb, _), r in zip(reviews, results):
        repos.append({"name": w.name if w else "", "main": w is None,
                      "project_id": w.project_id if w else t.project_id,
                      "repo": str(psb.repo), "files": r.files,
                      "github": w.github if w else t.github})
        flat += [w.label(p) if w else p for p in r.files]
    main = next((x for x in repos if x["main"]), repos[0])
    t.repo = main["repo"]
    how = "merged" if any(r.how == "merged" for r in results) else "clean"
    await publish(t, {"k": "applied", "files": flat, "how": how, "draft": draft,
                      **({"branch": t.suggest_branch} if t.suggest_branch else {}),
                      "repos": [{k: x[k] for k in ("name", "main", "files")}
                                for x in repos]})
    out = {"write": "applied", "files": flat, "draft": draft, "repos": repos,
           **({"branch": t.suggest_branch} if t.suggest_branch else {})}
    for x in repos:
        pend = await autocommit.on_applied(project_id=x["project_id"], repo=x["repo"],
                                           files=x["files"], draft=draft, task_id=t.id)
        if pend is not None:
            x["auto"] = pend
            await publish(t, {"k": "autocommit", **pend,
                              **({} if x["main"] else {"ws": x["name"]})})
            if x["main"]:
                out["auto"] = pend
    return out


async def _run_check(t: TaskState) -> dict[str, Any]:
    """Run the project's check in the copy and put the result on the card.

    While it runs the approval clock is HELD (the deadline pushed past the
    check's own timeout), and when it ends you get a full window again: a
    ten-minute suite must not use up the five minutes you had to read it."""
    from . import check as C
    cfg = t.check_cfg
    cmd = cfg.get("command") or ""
    timeout_s = int(cfg.get("timeout_min") or C.DEFAULT_TIMEOUT_MIN) * 60
    loop = asyncio.get_running_loop()
    t.check_stop = asyncio.Event()
    if t.approval is not None:
        t.approval_deadline = time.time() + timeout_s + APPROVAL_TIMEOUT
        await publish(t, {"k": "deadline", "expires_at": t.approval_deadline, "held": True})
    await publish(t, {"k": "check", "state": "running", "command": cmd,
                      "auto": bool(cfg.get("auto")), "timeout_min": cfg.get("timeout_min")})
    links = await loop.run_in_executor(None, C.link_deps, Path(t.root), Path(t.check_cwd))
    try:
        res = await C.run(cmd, Path(t.check_cwd), timeout_s, stop=t.check_stop)
    finally:
        await loop.run_in_executor(None, C.unlink_deps, links)
    res = {**res, "command": cmd, "linked": [p.name for p in links]}
    t.check_result = res
    await publish(t, {"k": "check", "state": "done", **res})
    if t.approval is not None and not t.approval.done():
        t.approval_deadline = time.time() + APPROVAL_TIMEOUT
        await publish(t, {"k": "deadline", "expires_at": t.approval_deadline, "held": False})
    return res


async def _stop_check(t: TaskState) -> None:
    if t.check_job is None:
        return
    if not t.check_job.done():
        t.check_stop.set()
    try:
        await asyncio.wait_for(asyncio.shield(t.check_job), 30)
    except (asyncio.TimeoutError, asyncio.CancelledError, Exception):  # noqa: BLE001
        pass


def start_check(t: TaskState) -> tuple[bool, str]:
    """Run check, pressed on the card. Only while the card is waiting, and
    one at a time. Run again after a result is allowed."""
    if not t.check_cfg.get("command"):
        return False, "This project has no check command."
    if not t.awaiting_approval or not t.check_cwd:
        return False, "The check runs while the approval card is waiting."
    if t.checking:
        return False, "The check is already running."
    t.check_job = asyncio.ensure_future(_run_check(t))
    return True, ""


def decide(t: TaskState, approve: bool) -> tuple[bool, str]:
    """Answer an approval. The first answer wins; later ones are told so."""
    if t.approval is None:
        return False, "This task is not waiting for an approval."
    if t.approval.done():
        return False, "Already answered."
    t.approval.set_result(bool(approve))
    return True, ""


def _take_suggestions(t: TaskState) -> None:
    """Track V4: the agent's COMMIT:/BRANCH: lines, kept on the task and taken
    out of the summary (a later revision without them keeps the earlier)."""
    if t.mode != "write" or not t.result:
        return
    subject, branch, rest = G.suggestions(t.result.get("text") or "")
    if subject:
        t.suggest_subject = subject
    if branch:
        t.suggest_branch = branch
    t.result["text"] = rest


async def _to_branch(top: Path, branch: str) -> dict[str, Any] | None:
    """Switch `top` to `branch` before committing -- made from where you are
    when it is new. None when there is nothing to do; a refusal dict if not."""
    if not branch:
        return None
    loop = asyncio.get_running_loop()
    if not await loop.run_in_executor(None, sandbox.engine_repo_allows, top, "branch"):
        return {"ok": False, "error": "read_only_project", "message": sandbox.ENGINE_REPO_WHY["branch"]}
    try:
        name = G.check_branch(branch)
        exists = await loop.run_in_executor(None, G.branch_exists, top, name)
        await loop.run_in_executor(None, G.switch, top, name, not exists)
    except G.GitError as e:
        return {"ok": False, "error": e.code, "message": e.message}
    return None


async def commit(t: TaskState, message: str, branch: str = "") -> dict[str, Any]:
    """Commit exactly the files this task applied. Once; never pushed.
    `branch` (Track V4): on that branch -- made from where you are if it is
    new, switched to if it exists; your other uncommitted changes come along
    as they do with any `git switch`.

    Only the applied paths are staged (git.commit uses `--only`), so anything
    else you had staged or changed stays out of it. The repository's own hooks
    run -- this is your commit, made on your behalf.
    """
    r = t.result or {}
    if not t.done or r.get("write") != "applied" or not t.repo:
        return {"ok": False, "error": "not_applied",
                "message": "Only a change that was applied to your folder can be committed."}
    if r.get("repos"):
        return await _commit_parts(t, r, message, branch)
    if not await asyncio.get_running_loop().run_in_executor(
            None, sandbox.engine_repo_allows, Path(t.repo), "commit"):
        return {"ok": False, "error": "read_only_project",
                "message": sandbox.ENGINE_REPO_WHY["commit"]}
    if r.get("commit"):
        return {"ok": False, "error": "already", "message": "Already committed.",
                "commit": r["commit"]}
    if t.committing:
        return {"ok": False, "error": "busy", "message": "Already committing."}
    t.committing = True
    try:
        moved = await _to_branch(Path(t.repo), branch)
        if moved:
            return moved
        c = await asyncio.get_running_loop().run_in_executor(
            None, G.commit, Path(t.repo), list(r.get("files") or []), message)
    except G.GitError as e:
        return {"ok": False, "error": e.code, "message": e.message}
    finally:
        t.committing = False
    r["commit"] = {**c.to_dict(), **({"branch": branch} if branch else {})}
    # Committed by hand: this task is no longer the pending auto commit's.
    autocommit.forget_task(t.project_id, t.id, c.files)
    await publish(t, {"k": "committed", **r["commit"]})
    return {"ok": True, "commit": r["commit"]}


async def _commit_parts(t: TaskState, r: dict[str, Any], message: str,
                        branch: str = "") -> dict[str, Any]:
    """Track V3: one Commit press commits each repository the change was
    applied to -- exactly its files, the same message, its own hooks. A1 is
    skipped (it commits itself) and says so. Nothing is pushed."""
    if r.get("commit"):
        return {"ok": False, "error": "already", "message": "Already committed.",
                "commit": r["commit"]}
    if t.committing:
        return {"ok": False, "error": "busy", "message": "Already committing."}
    loop = asyncio.get_running_loop()
    t.committing = True
    commits: list[dict[str, Any]] = []
    try:
        for x in r["repos"]:
            if x.get("commit") or not x.get("files"):
                continue
            moved = await _to_branch(Path(x["repo"]), branch)
            if moved:
                where = "" if x["main"] else f"@{x['name']}: "
                return {**moved, "message": where + moved["message"]}
            try:
                c = await loop.run_in_executor(
                    None, G.commit, Path(x["repo"]), list(x["files"]), message)
            except G.GitError as e:
                where = "" if x["main"] else f"@{x['name']}: "
                # What went in before stays in: say which, and what did not.
                done = ", ".join((y["name"] or "this workspace") + " " + y["commit"]["short"]
                                 for y in r["repos"] if y.get("commit"))
                return {"ok": False, "error": e.code, "message": where + e.message
                        + (f" (already committed: {done})" if done else "")}
            x["commit"] = {**c.to_dict(), **({"branch": branch} if branch else {})}
            commits.append({**x["commit"], "name": x["name"], "main": x["main"]})
            autocommit.forget_task(x["project_id"], t.id, c.files)
    finally:
        t.committing = False
    if not commits:
        return {"ok": False, "error": "read_only_project",
                "message": sandbox.ENGINE_REPO_WHY["commit"]}
    r["commit"] = commits[0]
    r["commits"] = commits
    await publish(t, {"k": "committed", **commits[0], "commits": commits})
    return {"ok": True, "commit": commits[0], "commits": commits}


def git_auth(login: str) -> G.Auth | None:
    """The git credential wiring for a GitHub login MAGI holds a token for,
    or None. Names only -- the token is read by askpass when git asks."""
    if not login:
        return None
    from ..github import accounts as A
    try:
        login = A.check_login(login)
        if not A.get(login):
            return None
    except A.AccountError:
        return None
    return G.Auth(login=login, service=A.service(login))


async def push(t: TaskState, login: str = "") -> dict[str, Any]:
    """Push the branch this task committed to. A third, separate press.

    As `login` if given (the console sends the project's account), else the
    project's. Never forced: a remote that moved on is a refusal that says
    to pull first.
    """
    r = t.result or {}
    if not r.get("commit") or not t.repo:
        return {"ok": False, "error": "not_committed",
                "message": "Commit the change first; only a commit can be pushed."}
    if r.get("repos"):
        return await _push_parts(t, r, login)
    if (r.get("push") or {}).get("ok"):
        return {"ok": False, "error": "already", "message": "Already pushed.", "push": r["push"]}
    if not await asyncio.get_running_loop().run_in_executor(
            None, sandbox.engine_repo_allows, Path(t.repo), "push"):
        return {"ok": False, "error": "read_only_project",
                "message": sandbox.ENGINE_REPO_WHY["push"]}
    if t.pushing:
        return {"ok": False, "error": "busy", "message": "Already pushing."}
    t.pushing = True
    loop = asyncio.get_running_loop()
    try:
        auth = await loop.run_in_executor(None, git_auth, login or t.github)
        res = await loop.run_in_executor(None, G.push, Path(t.repo), auth)
    except G.GitError as e:
        res = G.Push(False, e.code, e.message)
    finally:
        t.pushing = False
    d = res.to_dict()
    if res.ok:
        r["push"] = d
        await publish(t, {"k": "pushed", **d})
    return {"ok": res.ok, "push": d,
            **({} if res.ok else {"error": res.code, "message": res.text})}


async def _push_parts(t: TaskState, r: dict[str, Any], login: str) -> dict[str, Any]:
    """Track V3: push each repository this task committed to, each as its
    own project's GitHub account (`login` overrides only the main one's).
    Never forced; one that is refused is said, the others still go."""
    if t.pushing:
        return {"ok": False, "error": "busy", "message": "Already pushing."}
    loop = asyncio.get_running_loop()
    t.pushing = True
    pushes: list[dict[str, Any]] = []
    try:
        for x in r["repos"]:
            if not x.get("commit") or (x.get("push") or {}).get("ok"):
                continue
            if not await loop.run_in_executor(
                    None, sandbox.engine_repo_allows, Path(x["repo"]), "push"):
                continue
            try:
                auth = await loop.run_in_executor(
                    None, git_auth, (login if x["main"] and login else x.get("github") or ""))
                res = await loop.run_in_executor(None, G.push, Path(x["repo"]), auth)
            except G.GitError as e:
                res = G.Push(False, e.code, e.message)
            x["push"] = res.to_dict()
            pushes.append({**res.to_dict(), "name": x["name"], "main": x["main"]})
    finally:
        t.pushing = False
    if not pushes:
        return {"ok": False, "error": "already", "message": "Nothing left to push."}
    ok = all(p["ok"] for p in pushes)
    if ok:
        r["push"] = pushes[0]
    r["pushes"] = pushes
    await publish(t, {"k": "pushed", **pushes[0], "ok": ok, "pushes": pushes})
    bad = next((p for p in pushes if not p["ok"]), None)
    return {"ok": ok, "push": pushes[0], "pushes": pushes,
            **({} if ok else {"error": bad.get("code") or "push",
                              "message": (f"@{bad['name']}: " if not bad["main"] else "")
                              + (bad.get("text") or "Push failed.")})}


def open_pull(top: Path, login: str, title: str, body: str) -> dict[str, Any]:
    """Open a pull request on GitHub from the branch `top` is on into the
    repository's default branch, as `login`. Blocking (run it in an executor).
    -> {"ok", "pr": {...}} or a refusal in words."""
    from ..github import accounts as A
    from ..github import client as C
    from ..github import pulls as P
    from ..github import repos as RP
    head = G.out(top, "branch", "--show-current")
    if not head:
        return {"ok": False, "error": "detached", "message": "HEAD is detached; there is no branch to propose."}
    remote = G.github_of(top, head)
    if remote.get("host") != "github.com" or not remote.get("owner"):
        return {"ok": False, "error": "not_github", "message": "This repository's remote is not on GitHub."}
    if not login:
        return {"ok": False, "error": "no_account", "message": (
            f"Choose which GitHub account this project uses (the Repository pill) to open a "
            f"pull request on {remote['owner']}/{remote['repo']}.")}
    owner, name = remote["owner"], remote["repo"]
    try:
        gh = A.client(login)
        base = RP.repo_info(gh, owner, name).get("default_branch") or G.default_branch(top)
        if head == base:
            return {"ok": False, "error": "default_branch", "message": (
                f"{head} is the default branch, so there is nothing to propose. Commit on a new "
                "branch (the commit form offers one), push it, then open the pull request.")}
        pr = P.create(gh, owner, name, head=head, base=base, title=title, body=body)
    except A.AccountError as e:
        return {"ok": False, "error": e.code, "message": e.message}
    except C.GitHubError as e:
        if e.kind == C.Kind.FORBIDDEN:
            return {"ok": False, "error": "forbidden", "message": (
                f"{login}'s token may not open pull requests on {owner}/{name}. On GitHub, give "
                "the token \"Pull requests: Read and write\" for this repository (Settings → "
                "Developer settings → Fine-grained tokens), then press again.")}
        if e.kind == C.Kind.INVALID and "no commits between" in e.message.lower():
            return {"ok": False, "error": "nothing", "message": (
                f"{head} has nothing that {base} does not -- push it first, or there is "
                "nothing to propose.")}
        return e.to_dict()
    return {"ok": True, "pr": {**pr, "repo": f"{owner}/{name}", "base": base, "head": head,
                               "by": login}}


async def open_pr(t: TaskState, title: str = "", body: str = "") -> dict[str, Any]:
    """Track V4: Open a pull request for what this task pushed -- in each
    repository it pushed to (V3). A fourth, separate press; as each project's
    own account; never for the default branch."""
    r = t.result or {}
    loop = asyncio.get_running_loop()
    if t.opening_pr:
        return {"ok": False, "error": "busy", "message": "Already opening it."}
    commit_ = r.get("commit") or {}
    title = title or commit_.get("subject") or G.draft_message(t.prompt, "").splitlines()[0]
    body = body or (r.get("text") or "")
    targets = ([(x, Path(x["repo"]), x.get("github") or "") for x in r["repos"]
                if (x.get("push") or {}).get("ok")] if r.get("repos")
               else ([(None, Path(t.repo), t.github)] if (r.get("push") or {}).get("ok") else []))
    if not targets:
        return {"ok": False, "error": "not_pushed",
                "message": "Push the branch first; a pull request proposes what is on GitHub."}
    t.opening_pr = True
    prs: list[dict[str, Any]] = []
    try:
        for x, top, login in targets:
            if x is not None and x.get("pr"):
                prs.append({**x["pr"], "name": x["name"], "main": x["main"]})
                continue
            got = await loop.run_in_executor(None, open_pull, top, login, title, body)
            if not got.get("ok"):
                where = "" if x is None or x["main"] else f"@{x['name']}: "
                return {**got, "message": where + str(got.get("message") or ""), "prs": prs}
            if x is not None:
                x["pr"] = got["pr"]
            prs.append({**got["pr"], **({"name": x["name"], "main": x["main"]} if x else {})})
    finally:
        t.opening_pr = False
    r["pr"] = prs[0]
    r["prs"] = prs
    await publish(t, {"k": "pr", **prs[0], "prs": prs})
    return {"ok": True, "pr": prs[0], "prs": prs}


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
