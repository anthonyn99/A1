"""Code Mode's HTTP surface.

Phase 6 is the workspace registry and nothing else: projects, bindings, the
cached shape of a project, and a directory listing for the console's own
picker. **Nothing here writes into a project or runs a command.** The routes
that can do that arrive later, deliberately, so the part which can damage a
codebase is the last thing switched on.

Two conventions carried over from app.py rather than reinvented:

* a refusal returns a **reason code and a sentence**, never a bare 500. MAGI's
  whole error discipline is that a failure names its cause and its remedy
  (magi/errors.py), and "invalid path" sends you to check the spelling of a
  path that is spelled correctly.
* the engine's own identity decides which bindings are visible. A binding
  belonging to the laptop is not a path this machine can act on, and offering
  it would put a folder on screen that is not here.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body

from .. import ident
from ..settings import active_profile
from . import workspace as W

router = APIRouter(prefix="/api/code", tags=["code"])


def _engine_id() -> str:
    return ident.engine_identity().get("id", "")


def _fail(err: W.WorkspaceError) -> dict[str, Any]:
    return {"ok": False, "error": err.code, "message": err.message}


def _db():
    # Imported here rather than at module load: app.py owns the Database
    # instance and importing it at the top would make this module and app.py
    # import each other.
    from ..app import db
    return db


@router.get("/state")
async def code_state() -> dict[str, Any]:
    """Everything the console needs to paint Code Mode, in one request.

    One round trip rather than three, because this is fetched on every switch
    into the mode and the three pieces are useless apart.
    """
    eng = ident.engine_identity()
    projects = await _db().code_projects(eng.get("id", ""))
    # Whether Write mode can be offered for each project here, and if not, the
    # sentence that says why -- so the console greys the switch out with a
    # reason rather than letting a task start and be refused.
    loop = _asyncio.get_running_loop()
    for p in projects:
        here = next((b for b in p.get("bindings") or [] if b.get("here")), None)
        p["write"] = (await loop.run_in_executor(None, _write_status, here["root"])
                      if here else {"ok": False, "why": "No folder on this machine."})
    return {
        "ok": True,
        "profile": active_profile(),
        "engine": eng,
        "projects": projects,
        "defaults": W.DEFAULT_PREFS,
    }


def _write_status(root: str) -> dict[str, Any]:
    from pathlib import Path
    from . import sandbox as SB
    r = Path(root)
    if not r.is_dir():
        return {"ok": False, "why": "The folder is not there any more."}
    try:
        SB.repo_of(r)
    except SB.SandboxError:
        return {"ok": False, "why": "Edits need a git repository (run git init there), "
                "so every change is a diff you can read and undo."}
    if SB.is_engine_repo(r):
        return {"ok": False, "why": "MAGI's own repository stays read-only until the "
                "hardening phase."}
    return {"ok": True, "why": ""}


@router.get("/browse")
async def code_browse(path: str = "") -> dict[str, Any]:
    """Directory NAMES only, one level, never contents.

    This is how a folder gets chosen: a browser cannot enumerate a remote
    filesystem, MAGI does not use the native file picker, and this is the only
    shape that also works from a phone.
    """
    try:
        return {"ok": True, **W.browse(path or None)}
    except W.WorkspaceError as e:
        return _fail(e)


@router.post("/projects")
async def create_project(body: dict = Body(...)) -> dict[str, Any]:
    """Register a project, and bind it to a folder on this machine.

    The binding is optional: a project can exist before the machine that holds
    it does, which is what lets you set one up for a laptop you are not sitting
    at.
    """
    try:
        name = W.check_name(body.get("name", ""))
    except W.WorkspaceError as e:
        return _fail(e)

    root = None
    raw_root = (body.get("root") or "").strip()
    if raw_root:
        try:
            root = W.resolve_root(raw_root)
        except W.WorkspaceError as e:
            return _fail(e)

    pid = (body.get("id") or "").strip() or W.new_project_id()
    prefs = {**W.DEFAULT_PREFS, **(body.get("prefs") or {})}
    proj = W.Project(
        id=pid, name=name,
        aliases=[str(a)[:60] for a in (body.get("aliases") or [])][:8],
        prefs=prefs, notes=str(body.get("notes") or "")[:4000])
    await _db().save_code_project(proj.to_row())
    if root is not None:
        await _db().save_code_binding(
            pid, _engine_id(), str(root),
            allow_remote=bool(body.get("allowRemote", True)))
    return {"ok": True, "project": await _db().code_project(pid, _engine_id())}


@router.post("/projects/{project_id}/bind")
async def bind_project(project_id: str, body: dict = Body(...)) -> dict[str, Any]:
    """Point an existing project at a folder on THIS machine."""
    try:
        root = W.resolve_root(body.get("root", ""))
    except W.WorkspaceError as e:
        return _fail(e)
    if not await _db().code_project(project_id, _engine_id()):
        return {"ok": False, "error": "no_project", "message": "No such project."}
    await _db().save_code_binding(
        project_id, _engine_id(), str(root),
        allow_remote=bool(body.get("allowRemote", True)))
    return {"ok": True, "project": await _db().code_project(project_id, _engine_id())}


@router.delete("/projects/{project_id}/bind")
async def unbind_project(project_id: str) -> dict[str, Any]:
    """Forget where this project lives HERE. The project itself stays."""
    await _db().delete_code_binding(project_id, _engine_id())
    return {"ok": True, "project": await _db().code_project(project_id, _engine_id())}


@router.delete("/projects/{project_id}")
async def delete_project(project_id: str) -> dict[str, Any]:
    await _db().delete_code_project(project_id)
    return {"ok": True}


@router.post("/projects/{project_id}/prefs")
async def set_prefs(project_id: str, body: dict = Body(...)) -> dict[str, Any]:
    p = await _db().code_project(project_id, _engine_id())
    if not p:
        return {"ok": False, "error": "no_project", "message": "No such project."}
    prefs = {**W.DEFAULT_PREFS, **(p.get("prefs") or {}), **(body.get("prefs") or {})}
    row = W.Project(
        id=p["id"], name=body.get("name") or p["name"],
        aliases=p.get("aliases") or [], prefs=prefs,
        notes=body.get("notes", p.get("notes", ""))).to_row()
    await _db().save_code_project(row)
    return {"ok": True, "project": await _db().code_project(project_id, _engine_id())}


@router.get("/projects/{project_id}/skeleton")
async def project_skeleton(project_id: str, refresh: bool = False) -> dict[str, Any]:
    """The project's shape, cached against a fingerprint.

    The point of the cache is that nothing re-walks a tree to answer "what is
    in this project?" once per task. The fingerprint is two git calls, so
    checking whether the cache is still good costs far less than rebuilding it.
    """
    eng = _engine_id()
    p = await _db().code_project(project_id, eng)
    if not p:
        return {"ok": False, "error": "no_project", "message": "No such project."}
    here = next((b for b in p["bindings"] if b["here"]), None)
    if not here:
        return {"ok": False, "error": "not_bound",
                "message": f"{p['name']} has no folder on this machine yet."}

    from pathlib import Path
    root = Path(here["root"])
    if not root.is_dir():
        return {"ok": False, "error": "missing",
                "message": f"{root} is not there any more."}

    fp = W.fingerprint(root)
    if not refresh:
        cached = await _db().get_skeleton(project_id, eng, fp)
        if cached:
            return {"ok": True, "cached": True, "fingerprint": fp, "skeleton": cached}

    sk = W.skeleton(root)
    await _db().put_skeleton(project_id, eng, fp, sk)
    await _db().touch_code_binding(project_id, eng)
    return {"ok": True, "cached": False, "fingerprint": fp, "skeleton": sk}


@router.get("/projects/{project_id}/git")
async def project_git(project_id: str) -> dict[str, Any]:
    """Branch, ahead/behind, and how much is uncommitted -- local git only.

    No fetch and no pull: the console asks for this every time Code Mode
    opens and after every task, and a network round trip there would be a
    wait on every visit. Ahead/behind are as of the last fetch, which every
    task's pull refreshes; `fetched_at` says when that was.
    """
    p = await _db().code_project(project_id, _engine_id())
    if not p:
        return {"ok": False, "error": "no_project", "message": "No such project."}
    here = next((b for b in p["bindings"] if b["here"]), None)
    if not here:
        return {"ok": False, "error": "not_bound",
                "message": f"{p['name']} has no folder on this machine yet."}
    from pathlib import Path
    from . import git as G
    try:
        st = await _asyncio.get_running_loop().run_in_executor(None, G.state, Path(here["root"]))
    except G.GitError as e:
        return {"ok": False, "error": e.code, "message": e.message}
    return {"ok": True, "git": st}


@router.post("/resolve")
async def resolve(body: dict = Body(...)) -> dict[str, Any]:
    """"Work on A1." -> which project that is, if it is unambiguous."""
    projects = await _db().code_projects(_engine_id())
    hit = W.resolve_project(projects, body.get("phrase", ""))
    return {"ok": True, "project": hit}


# ── coding agents: accounts, limits, and running a task ───────────────────

import asyncio as _asyncio
import json as _json

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from .agents import chain as _chain
from .agents import limits as _limits
from .agents import login as _login
from .agents import slots as _slots
from .agents import usage_fetch as _usage_fetch
from . import tasks as _tasks


def _settings():
    from ..settings import load_settings
    return load_settings()


@router.get("/agents")
async def list_agents() -> dict[str, Any]:
    """Every way a unit can code here: CLI slots with who they are signed in
    as, the browser units behind them, and what each has left.

    Slot status runs each CLI's own zero-cost auth check -- no model call --
    in parallel, so a list of four slots costs one CLI start, not four.
    """
    loop = _asyncio.get_running_loop()
    s = _settings()
    # Ask each provider what is left BEFORE reading the stored figures, so the
    # card shows this morning's numbers, not those from the last task run.
    await loop.run_in_executor(None, _usage_fetch.refresh_all)
    snap = _limits.snapshot()

    async def one(agent: str, slot: str) -> dict[str, Any]:
        st = await loop.run_in_executor(None, _slots.status, agent, slot)
        key = _limits.key(agent, slot)
        d = st.to_dict()
        d["id"] = f"{agent}:{slot}"
        d["limited_until"] = (snap["limits"].get(key) or {}).get("until")
        from .agents import models as _m
        until, why = _m.cap_block(agent, slot)
        d["capped"] = {"until": until, "why": why} if until else None
        d["usage"] = snap["usage"].get(key) or {}
        if agent == "codex" and st.signed_in:
            # Codex does not report its windows while it runs, so they are
            # read from the account's own session log instead of being
            # discovered by walking into the limit.
            from .agents.codex_cli import session_usage
            d["usage"] = {**_limits.aged(await loop.run_in_executor(None, session_usage, slot)),
                          **d["usage"]}
        return d

    cli = []
    for agent in _slots.AGENTS:
        rows = await _asyncio.gather(*(one(agent, sl) for sl in _slots.list_slots(agent)))
        cli.append({"agent": agent, "label": "Claude" if agent == "claude" else "Codex",
                    "installed": bool(_slots.cli_path(agent)), "slots": list(rows)})

    enabled = set(s.enabled_site_ids())
    browser = [{"id": uid, "label": s.site(uid).display_name, "accent": s.site(uid).accent,
                "enabled": uid in enabled,
                "limited_until": (snap["limits"].get(_limits.key("browser", uid)) or {}).get("until")}
               for uid in s.sites]
    return {"ok": True, "cli": cli, "browser": browser, "order": _chain.DEFAULT_ORDER}


@router.post("/agents/{agent}/slots")
async def add_slot(agent: str, body: dict = Body(...)) -> dict[str, Any]:
    try:
        _slots.create(agent, body.get("slot", ""))
    except ValueError as e:
        return {"ok": False, "error": "bad_slot", "message": str(e)}
    return {"ok": True}


@router.delete("/agents/{agent}/slots/{slot}")
async def remove_slot(agent: str, slot: str) -> dict[str, Any]:
    """Forget MAGI's copy of a login. The account itself is untouched."""
    try:
        _slots.remove(agent, slot)
    except ValueError as e:
        return {"ok": False, "error": "bad_slot", "message": str(e)}
    _limits.clear(agent, slot)
    return {"ok": True}


@router.get("/usage")
async def agent_usage() -> dict[str, Any]:
    """What each account has left -- and NOTHING else.

    Separate from /agents deliberately. /agents asks each CLI who it is
    signed in as, which starts a process per slot; that is the right cost
    once, and the wrong cost every minute. This reads the remembered usage
    file, each provider's own usage endpoint (usage_fetch.py -- one small GET
    per account, throttled to once a minute) and, for Codex, the tail of its
    newest session log: no processes, no model calls, so the console can keep
    the percentages live while you work.
    """
    loop = _asyncio.get_running_loop()
    await loop.run_in_executor(None, _usage_fetch.refresh_all)
    snap = _limits.snapshot()
    usage = {k: dict(v) for k, v in snap["usage"].items()}
    from .agents.codex_cli import session_usage
    for slot in _slots.list_slots("codex"):
        key = _limits.key("codex", slot)
        fresh = _limits.aged(await loop.run_in_executor(None, session_usage, slot))
        have = usage.get(key) or {}
        # Per window, the newer reading wins -- so a remembered figure from a
        # run is not shadowed by an older log, nor the other way round.
        merged = dict(have)
        for win, v in fresh.items():
            if float(v.get("at") or 0) >= float((have.get(win) or {}).get("at") or 0):
                merged[win] = v
        if merged:
            usage[key] = merged
    from .agents import models as _m

    def extra():
        p = _m.prefs()
        capped, credits = {}, {}
        for agent in _slots.AGENTS:
            for slot in _slots.list_slots(agent):
                k = _limits.key(agent, slot)
                until, why = _m.cap_block(agent, slot, p)
                if until:
                    capped[k] = {"until": until, "why": why}
                cr = _m.credits(agent, slot)
                if cr:
                    credits[k] = cr
        return {"alerts": _m.alerts(p), "capped": capped, "credits": credits,
                "caps": p["caps"], "warn_at": p["warn_at"]}
    return {"ok": True, "usage": usage,
            "limits": {k: v.get("until") for k, v in snap["limits"].items()},
            **await loop.run_in_executor(None, extra)}


@router.post("/agents/{agent}/slots/{slot}/label")
async def set_slot_label(agent: str, slot: str, body: dict = Body(...)) -> dict[str, Any]:
    """What YOU call this account. The login is not touched."""
    try:
        label = _slots.set_label(agent, slot, str(body.get("label") or ""))
    except ValueError as e:
        return {"ok": False, "error": "bad_slot", "message": str(e)}
    return {"ok": True, "label": label}


@router.post("/agents/{agent}/slots/{slot}/login")
async def login_slot(agent: str, slot: str) -> dict[str, Any]:
    try:
        job = _login.start(agent, slot)
    except ValueError as e:
        return {"ok": False, "error": "cannot_login", "message": str(e)}
    # The device code appears a second or two in; wait briefly so the first
    # response usually carries it, rather than making the console poll once
    # just to learn what it could have been told now.
    for _ in range(20):
        if job.code or job.state != "starting":
            break
        await _asyncio.sleep(0.25)
    return {"ok": True, "job": job.to_dict()}


@router.get("/login/{job_id}")
async def login_status(job_id: str) -> dict[str, Any]:
    job = _login.JOBS.get(job_id)
    if not job:
        return {"ok": False, "error": "no_job", "message": "No such sign-in."}
    return {"ok": True, "job": job.to_dict()}


@router.post("/login/{job_id}/cancel")
async def login_cancel(job_id: str) -> dict[str, Any]:
    job = _login.cancel(job_id)
    return {"ok": bool(job), "job": job.to_dict() if job else None}


@router.post("/agents/{agent}/slots/{slot}/clear-limit")
async def clear_limit(agent: str, slot: str) -> dict[str, Any]:
    """For when you know better than the remembered reset time."""
    _limits.clear(agent, slot)
    return {"ok": True}


@router.post("/tasks")
async def start_task(body: dict = Body(...)) -> dict[str, Any]:
    """Run a task through the chain.

    `agents` is the chain order the console sends -- the ticked units, in the
    order they appear. Anything not listed is never asked.

    `mode` is "read" (the default) or "write". Write mode never edits the
    folder itself: agents work in a sandbox copy and the diff waits for an
    approval (tasks.py). The repository MAGI lives in (A1) is refused here,
    whatever the console sends -- the console greys the toggle out, but the
    rule has to live where the write happens.
    """
    eng = _engine_id()
    p = await _db().code_project(body.get("project_id", ""), eng)
    if not p:
        return {"ok": False, "error": "no_project", "message": "Pick a project first."}
    here = next((b for b in p["bindings"] if b["here"]), None)
    if not here:
        return {"ok": False, "error": "not_bound",
                "message": f"{p['name']} has no folder on this machine."}
    from pathlib import Path
    root = Path(here["root"])
    if not root.is_dir():
        return {"ok": False, "error": "missing", "message": f"{root} is not there any more."}
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        return {"ok": False, "error": "empty", "message": "Say what to look at."}
    mode = "write" if body.get("mode") == "write" else "read"
    if mode == "write":
        from .sandbox import is_engine_repo
        if await _asyncio.get_running_loop().run_in_executor(None, is_engine_repo, root):
            return {"ok": False, "error": "read_only_project", "message": (
                f"{p['name']} is MAGI's own repository, and stays read-only until "
                "the hardening phase. Ask in Read mode, or use another project.")}
    order = [str(x) for x in (body.get("agents") or _chain.DEFAULT_ORDER)]
    t = await _tasks.start(project_id=p["id"], root=root, prompt=prompt[:20000],
                           order=order, settings=_settings(), mode=mode,
                           github=str((p.get("prefs") or {}).get("github") or ""))
    await _db().touch_code_binding(p["id"], eng)
    return {"ok": True, "task": t.summary()}


@router.get("/tasks")
async def list_tasks() -> dict[str, Any]:
    return {"ok": True, "tasks": [t.summary() for t in
                                  sorted(_tasks.TASKS.values(), key=lambda t: -t.started)]}


@router.get("/tasks/{task_id}/stream")
async def stream_task(task_id: str):
    t = _tasks.TASKS.get(task_id)
    if t is None:
        raise HTTPException(404, "unknown task")

    async def gen():
        async for ev in _tasks.stream(t):
            yield f"data: {_json.dumps(ev)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/tasks/{task_id}/approve")
async def approve_task(task_id: str, body: dict = Body(...)) -> dict[str, Any]:
    """Approve or deny a write task's diff. `{"approve": true|false}`.

    Only an explicit true approves: a missing or malformed body is a No.
    """
    t = _tasks.TASKS.get(task_id)
    if t is None:
        return {"ok": False, "error": "no_task", "message": "No such task."}
    ok, why = _tasks.decide(t, body.get("approve") is True)
    return {"ok": ok, **({} if ok else {"error": "not_waiting", "message": why})}


@router.post("/tasks/{task_id}/commit")
async def commit_task(task_id: str, body: dict = Body(...)) -> dict[str, Any]:
    """Commit the files a write task applied. `{"message": "..."}`.

    Exactly those files, the repository's own hooks run, and nothing is
    pushed. The engine's own repository never gets here: it cannot be
    written to, so it never has an applied change.
    """
    t = _tasks.TASKS.get(task_id)
    if t is None:
        return {"ok": False, "error": "no_task", "message": "No such task."}
    return await _tasks.commit(t, str(body.get("message") or ""))


@router.post("/tasks/{task_id}/cancel")
async def cancel_task(task_id: str) -> dict[str, Any]:
    t = _tasks.TASKS.get(task_id)
    if t is None:
        return {"ok": False, "error": "no_task"}
    t.cancel.set()
    return {"ok": True}


@router.post("/tasks/{task_id}/push")
async def push_task(task_id: str, body: dict = Body(default={})) -> dict[str, Any]:
    """Push what a task committed. `{"account": "<login>"}` optional; the
    project's account otherwise. Never forced, never without a commit."""
    t = _tasks.TASKS.get(task_id)
    if t is None:
        return {"ok": False, "error": "no_task", "message": "No such task."}
    return await _tasks.push(t, str((body or {}).get("account") or ""))


# ── GitHub: accounts, repositories, and which account a project uses ─────
#
# The token goes in once (POST /github/accounts) and never comes out: every
# response here is built from the account's public record. See
# magi/github/accounts.py for where it is kept.

from ..github import accounts as _gh
from ..github import client as _ghc


def _gh_fail(e: "_gh.AccountError") -> dict[str, Any]:
    return {"ok": False, "error": e.code, "message": e.message}


@router.get("/github/accounts")
async def gh_accounts() -> dict[str, Any]:
    try:
        rows = await _asyncio.get_running_loop().run_in_executor(None, _gh.list_accounts)
    except _gh.AccountError as e:
        return _gh_fail(e)
    return {"ok": True, "accounts": rows, "api_version": _ghc.API_VERSION}


@router.post("/github/accounts")
async def gh_add_account(body: dict = Body(...)) -> dict[str, Any]:
    """`{"token": "github_pat_..."}` -> verified with GitHub, stored in the
    credential store, and the account's public record returned."""
    tok = str((body or {}).get("token") or "")
    try:
        acct = await _asyncio.get_running_loop().run_in_executor(None, _gh.add, tok)
    except _gh.AccountError as e:
        return _gh_fail(e)
    finally:
        tok = ""
    return {"ok": True, "account": acct}


@router.delete("/github/accounts/{login}")
async def gh_remove_account(login: str) -> dict[str, Any]:
    try:
        had = await _asyncio.get_running_loop().run_in_executor(None, _gh.remove, login)
    except _gh.AccountError as e:
        return _gh_fail(e)
    return {"ok": True, "removed": had}


@router.get("/github/accounts/{login}/repos")
async def gh_repos(login: str) -> dict[str, Any]:
    try:
        d = await _asyncio.get_running_loop().run_in_executor(None, _gh.repos, login)
    except _gh.AccountError as e:
        return _gh_fail(e)
    return {"ok": True, **d}


async def _project_here(project_id: str):
    p = await _db().code_project(project_id, _engine_id())
    if not p:
        return None, None, {"ok": False, "error": "no_project", "message": "No such project."}
    here = next((b for b in p["bindings"] if b["here"]), None)
    if not here:
        return p, None, {"ok": False, "error": "not_bound",
                         "message": f"{p['name']} has no folder on this machine yet."}
    from pathlib import Path
    return p, Path(here["root"]), None


@router.get("/projects/{project_id}/github")
async def project_github(project_id: str) -> dict[str, Any]:
    """Which repository this project's folder answers to, which account it
    uses, and whether that account can see and push it (one REST call,
    conditional, so asking again is nearly free)."""
    p, root, err = await _project_here(project_id)
    if err:
        return err
    from . import git as G
    loop = _asyncio.get_running_loop()
    top = await loop.run_in_executor(None, G.toplevel, root)
    if top is None:
        return {"ok": False, "error": "not_git", "message": "This folder is not a git repository."}
    remote = await loop.run_in_executor(None, G.github_of, top)
    login = str((p.get("prefs") or {}).get("github") or "")
    out: dict[str, Any] = {"ok": True, "remote": remote, "account": login, "access": None}
    if login and remote.get("host") == "github.com" and remote.get("owner"):
        try:
            out["access"] = await loop.run_in_executor(
                None, lambda: _gh.repo(login, remote["owner"], remote["repo"]))
        except _gh.AccountError as e:
            out["access"] = {"error": e.code, "message": e.message}
        else:
            # Push permission from git itself (a dry run), not REST: see
            # git.can_push for why REST's answer is wrong here.
            probe = await loop.run_in_executor(
                None, G.can_push, top, _tasks.git_auth(login))
            out["access"].update(probe)
    return out


@router.post("/projects/{project_id}/github")
async def set_project_github(project_id: str, body: dict = Body(...)) -> dict[str, Any]:
    """`{"account": "<login>"}` to connect, `{"account": ""}` to disconnect.
    Stores the login in the project's prefs; the token never moves."""
    p, _root, err = await _project_here(project_id)
    if p is None:
        return err
    login = str((body or {}).get("account") or "").strip()
    if login:
        try:
            login = _gh.check_login(login)
        except _gh.AccountError as e:
            return _gh_fail(e)
        if not await _asyncio.get_running_loop().run_in_executor(None, _gh.get, login):
            return {"ok": False, "error": "no_account",
                    "message": f"MAGI holds no token for {login}. Add it in Accounts first."}
    prefs = {**W.DEFAULT_PREFS, **(p.get("prefs") or {}), "github": login}
    row = W.Project(id=p["id"], name=p["name"], aliases=p.get("aliases") or [],
                    prefs=prefs, notes=p.get("notes", "")).to_row()
    await _db().save_code_project(row)
    return {"ok": True, "project": await _db().code_project(project_id, _engine_id())}


@router.post("/projects/{project_id}/push")
async def push_project(project_id: str, body: dict = Body(default={})) -> dict[str, Any]:
    """Push the project's current branch -- the repository line's ↑n.

    As the project's GitHub account (or `{"account"}`), never forced, and
    never for MAGI's own repository: A1 stays read-only until the hardening
    phase, pushes included.
    """
    p, root, err = await _project_here(project_id)
    if err:
        return err
    from . import git as G
    from .sandbox import is_engine_repo
    loop = _asyncio.get_running_loop()
    if await loop.run_in_executor(None, is_engine_repo, root):
        return {"ok": False, "error": "read_only_project", "message": (
            f"{p['name']} is MAGI's own repository; it is not pushed from Code Mode until "
            "the hardening phase.")}
    login = str((body or {}).get("account") or (p.get("prefs") or {}).get("github") or "")
    auth = await loop.run_in_executor(None, _tasks.git_auth, login)
    try:
        res = await loop.run_in_executor(None, G.push, root, auth)
    except G.GitError as e:
        return {"ok": False, "error": e.code, "message": e.message}
    d = res.to_dict()
    return {"ok": res.ok, "push": d, **({} if res.ok else {"error": res.code, "message": res.text})}


# ── the Repository panel (Phase 11): read-only GitHub, per project ───────
#
# Each route is a thin pass-through to magi/github/{repos,pulls,issues,
# actions}.py, for the repository the project's folder points at, as the
# account the project names. Nothing here writes -- to GitHub or to the
# folder -- and nothing returns a token. Every GitHub read is conditional,
# so the console asking again (the post-push watch does, every 20s while a
# run is going) costs nothing until something changes.

from ..github import actions as _gha
from ..github import issues as _ghi
from ..github import pulls as _ghp
from ..github import repos as _ghr


async def _repo_ctx(project_id: str):
    """(ctx, None) or (None, refusal). ctx = gh, owner, repo, top, login."""
    p, root, err = await _project_here(project_id)
    if err:
        return None, err
    from . import git as G
    loop = _asyncio.get_running_loop()
    top = await loop.run_in_executor(None, G.toplevel, root)
    if top is None:
        return None, {"ok": False, "error": "not_git",
                      "message": "This folder is not a git repository."}
    remote = await loop.run_in_executor(None, G.github_of, top)
    if remote.get("host") != "github.com" or not remote.get("owner"):
        return None, {"ok": False, "error": "not_github",
                      "message": "This folder's remote is not a GitHub repository."}
    login = str((p.get("prefs") or {}).get("github") or "")
    if not login:
        return None, {"ok": False, "error": "no_account", "remote": remote,
                      "message": f"Choose which GitHub account reads {remote['owner']}/"
                                 f"{remote['repo']} (the Repository pill), then this fills in."}
    try:
        gh = await loop.run_in_executor(None, _gh.client, login)
    except _gh.AccountError as e:
        return None, _gh_fail(e)
    return {"gh": gh, "owner": remote["owner"], "repo": remote["repo"], "top": top,
            "login": login, "remote": remote}, None


async def _repo_call(project_id: str, fn) -> dict[str, Any]:
    """Run `fn(ctx)` off the event loop; GitHub's refusals come back in words."""
    ctx, err = await _repo_ctx(project_id)
    if err:
        return err
    try:
        out = await _asyncio.get_running_loop().run_in_executor(None, fn, ctx)
    except _ghc.GitHubError as e:
        return e.to_dict()
    except _gh.AccountError as e:
        return _gh_fail(e)
    return {"ok": True, "repo": f"{ctx['owner']}/{ctx['repo']}", "account": ctx["login"],
            "rate": ctx["gh"].rate(), **out}


@router.get("/projects/{project_id}/repo")
async def repo_overview(project_id: str) -> dict[str, Any]:
    """What the panel opens on: the repository, and how the current
    branch's latest workflow runs went."""
    from . import git as G

    def go(c):
        info = _ghr.repo_info(c["gh"], c["owner"], c["repo"])
        br = G.github_of(c["top"])
        st = G.state(c["top"])
        branch = st.get("branch") or info["default_branch"]
        r = _gha.runs(c["gh"], c["owner"], c["repo"], branch=branch, n=5)
        tip = _ghr.commits(c["gh"], c["owner"], c["repo"], ref=branch, n=1)
        return {"info": info, "branch": branch, "tip": tip[0] if tip else None, "local": {k: st.get(k) for k in (
                    "branch", "head", "subject", "upstream", "ahead", "behind", "dirty",
                    "fetched_at")},
                "remote_name": br.get("remote", ""), "runs": r["runs"]}
    return await _repo_call(project_id, go)


@router.get("/projects/{project_id}/repo/branches")
async def repo_branches(project_id: str) -> dict[str, Any]:
    from . import git as G

    def go(c):
        local = G.branches(c["top"])
        remote = _ghr.branches(c["gh"], c["owner"], c["repo"])
        on_remote = {b["name"] for b in remote}
        for b in local:
            b["on_remote"] = b["name"] in on_remote
        mine = {b["name"] for b in local}
        return {"local": local, "remote": remote,
                "remote_only": [b for b in remote if b["name"] not in mine]}
    return await _repo_call(project_id, go)


@router.get("/projects/{project_id}/repo/commits")
async def repo_commits(project_id: str, ref: str = "") -> dict[str, Any]:
    return await _repo_call(project_id, lambda c: {
        "ref": ref, "commits": _ghr.commits(c["gh"], c["owner"], c["repo"], ref=ref[:200])})


@router.get("/projects/{project_id}/repo/pulls")
async def repo_pulls(project_id: str, state: str = "open") -> dict[str, Any]:
    return await _repo_call(project_id, lambda c: {
        "state": state, "pulls": _ghp.list_pulls(c["gh"], c["owner"], c["repo"], state)})


@router.get("/projects/{project_id}/repo/pulls/{number}")
async def repo_pull(project_id: str, number: int) -> dict[str, Any]:
    return await _repo_call(project_id, lambda c: {
        "pull": _ghp.pull(c["gh"], c["owner"], c["repo"], number)})


@router.get("/projects/{project_id}/repo/issues")
async def repo_issues(project_id: str, state: str = "open") -> dict[str, Any]:
    return await _repo_call(project_id, lambda c: {
        "state": state, "issues": _ghi.list_issues(c["gh"], c["owner"], c["repo"], state)})


@router.get("/projects/{project_id}/repo/issues/{number}")
async def repo_issue(project_id: str, number: int) -> dict[str, Any]:
    return await _repo_call(project_id, lambda c: {
        "issue": _ghi.issue(c["gh"], c["owner"], c["repo"], number)})


@router.get("/projects/{project_id}/repo/actions")
async def repo_actions(project_id: str, sha: str = "", branch: str = "") -> dict[str, Any]:
    """Workflow runs -- for one commit (the post-push watch) or a branch.
    With `sha`, the answer carries `summary`: the watch's verdict."""
    def go(c):
        r = _gha.runs(c["gh"], c["owner"], c["repo"], sha=sha[:40], branch=branch[:200])
        return {**r, "summary": _gha.summary(r["runs"]) if sha else None}
    return await _repo_call(project_id, go)


@router.get("/projects/{project_id}/repo/actions/{run_id}")
async def repo_run(project_id: str, run_id: int) -> dict[str, Any]:
    """One run's jobs, and the failing job's step and log tail."""
    return await _repo_call(project_id, lambda c: _gha.failure(
        c["gh"], c["owner"], c["repo"], run_id))


@router.get("/projects/{project_id}/repo/releases")
async def repo_releases(project_id: str) -> dict[str, Any]:
    return await _repo_call(project_id, lambda c: {
        "releases": _ghr.releases(c["gh"], c["owner"], c["repo"])})


# ── models, credits, caps (Phase 11B) ────────────────────────────────────
#
# Which models each coding account can run (asked of the provider, cached for
# hours), which one each agent uses -- a model you pick, or Auto -- and your
# caps on how much of an allowance MAGI may spend. Everything lives on the
# engine, per profile, beside the logins it is about; nothing is synced.

from .agents import models as _models
from .agents import updates as _updates


def _model_slots(agent: str) -> list[dict[str, Any]]:
    rows = []
    for slot in _slots.list_slots(agent):
        cat = _models.catalog(agent, slot)
        until, why = _models.cap_block(agent, slot)
        rows.append({"slot": slot, "label": _slots.label_of(agent, slot) or slot,
                     "plan": _models.plan_of(agent, slot),
                     "credits": _models.credits(agent, slot),
                     "models": _models.models_for(agent, slot),
                     "fetched_at": cat.get("fetched_at"),
                     "plan_used_up": _models.plan_used_up(agent, slot),
                     "capped": {"until": until, "why": why} if until else None,
                     "usage": _limits.aged(_limits.usage(agent, slot))})
    return rows


def _models_state() -> dict[str, Any]:
    p = _models.prefs()
    agents = {}
    for agent in _slots.AGENTS:
        rows = _model_slots(agent)
        # The windows each agent reports, for the caps: Claude always has a
        # session and a weekly one; Codex has whatever its plan has (a free
        # account: one 30-day window; Plus: 5-hour and weekly).
        wins = ["five_hour", "seven_day"] if agent == "claude" else []
        for r in rows:
            for w in r["usage"]:
                if w not in wins:
                    wins.append(w)
        wins += [w for w in p["caps"].get(agent, {}) if w not in wins]
        agents[agent] = {"slots": rows, "choice": p["choice"][agent], "caps": p["caps"][agent],
                         "windows": [{"id": w, "label": _models.window_label(w)} for w in wins],
                         "cli": _updates.status(agent)}
    return {"ok": True, "agents": agents, "warn_at": p["warn_at"], "efforts": list(_models.EFFORTS),
            "auto_update": p["auto_update"]}


@router.get("/models")
async def models_state(refresh: bool = False) -> dict[str, Any]:
    """Everything the model sheet shows. `refresh=1` re-reads every
    account's model list from the provider now instead of from the cache."""
    loop = _asyncio.get_running_loop()
    await loop.run_in_executor(None, _usage_fetch.refresh_all)
    if refresh:
        for agent in _slots.AGENTS:
            for slot in _slots.list_slots(agent):
                await loop.run_in_executor(None, lambda a=agent, s=slot: _models.catalog(a, s, force=True))
    return await loop.run_in_executor(None, _models_state)


@router.post("/models/choice")
async def models_choice(body: dict = Body(...)) -> dict[str, Any]:
    """`{"agent": "claude", "model": "auto"|"<id>", "effort": "auto"|"high"}`"""
    try:
        _models.set_choice(str(body.get("agent") or ""), str(body.get("model") or "auto"),
                           str(body.get("effort") or "auto"))
    except ValueError as e:
        return {"ok": False, "error": "bad_choice", "message": str(e)}
    return await _asyncio.get_running_loop().run_in_executor(None, _models_state)


@router.post("/models/cap")
async def models_cap(body: dict = Body(...)) -> dict[str, Any]:
    """`{"agent": "claude", "window": "seven_day", "percent": 80}`; percent
    null removes the cap."""
    pct = body.get("percent")
    try:
        _models.set_cap(str(body.get("agent") or ""), str(body.get("window") or ""),
                        None if pct is None else pct)
    except ValueError as e:
        return {"ok": False, "error": "bad_cap", "message": str(e)}
    return await _asyncio.get_running_loop().run_in_executor(None, _models_state)


@router.post("/models/warn")
async def models_warn(body: dict = Body(...)) -> dict[str, Any]:
    try:
        _models.set_warn(body.get("percent"))
    except ValueError as e:
        return {"ok": False, "error": "bad_warn", "message": str(e)}
    return await _asyncio.get_running_loop().run_in_executor(None, _models_state)


@router.post("/models/preview")
async def models_preview(body: dict = Body(...)) -> dict[str, Any]:
    """What each agent would run THIS prompt on, as the console types --
    local rules over the cached lists, no network, no model call."""
    prompt = str(body.get("prompt") or "")[:20000]
    mode = "write" if body.get("mode") == "write" else "read"

    def go():
        p = _models.prefs()
        out = {}
        for agent in _slots.AGENTS:
            slot = next((s for s in _slots.list_slots(agent)
                         if _models.catalog_cached(agent, s).get("models")), None)
            out[agent] = _models.choose(agent, slot, prompt, mode, p) if slot else None
        return {"ok": True, "tier": _models.classify(prompt, mode), "pick": out}
    return await _asyncio.get_running_loop().run_in_executor(None, go)

# ── keeping the CLIs current ─────────────────────────────────────────────
#
# Update now (per agent), and the automatic updater's switch. Refused while a
# task or a sign-in is running; see magi/code/agents/updates.py.

@router.get("/updates")
async def updates_state(check: bool = False) -> dict[str, Any]:
    """Each CLI's installed and latest version, what is waiting on it, and
    the last update job. `check=1` asks npm now instead of the 6 h cache."""
    loop = _asyncio.get_running_loop()
    rows = {a: await loop.run_in_executor(None, lambda a=a: _updates.status(a, check=check))
            for a in _slots.AGENTS}
    return {"ok": True, "cli": rows, "auto_update": _models.prefs()["auto_update"],
            "busy": _updates.busy()}


@router.post("/updates/auto")
async def updates_auto(body: dict = Body(...)) -> dict[str, Any]:
    """`{"on": true|false}` -- keep the CLIs updated by themselves."""
    try:
        _models.set_auto_update(body.get("on"))
    except ValueError as e:
        return {"ok": False, "error": "bad_value", "message": str(e)}
    return await updates_state()


@router.post("/updates/{agent}")
async def updates_start(agent: str) -> dict[str, Any]:
    """Update one CLI now. Answers at once; poll GET /updates for the end."""
    try:
        job = await _asyncio.get_running_loop().run_in_executor(None, _updates.start, agent)
    except ValueError as e:
        return {"ok": False, "error": "cannot_update", "message": str(e)}
    return {"ok": True, "job": job.to_dict()}
