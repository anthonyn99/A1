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
    return {
        "ok": True,
        "profile": active_profile(),
        "engine": eng,
        "projects": projects,
        "defaults": W.DEFAULT_PREFS,
    }


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


@router.post("/resolve")
async def resolve(body: dict = Body(...)) -> dict[str, Any]:
    """"Work on A1." -> which project that is, if it is unambiguous."""
    projects = await _db().code_projects(_engine_id())
    hit = W.resolve_project(projects, body.get("phrase", ""))
    return {"ok": True, "project": hit}
