"""Phase 13: Code Mode state, carried between devices through Firestore.

The engine never talks to Firestore. The console does -- it already holds the
one listener on the profile's document -- and this module is the engine's half
of the conversation: what it offers to sync (`view`) and how it takes in a
copy that came back from the cloud (`incoming`).

What syncs is the LOGICAL project: name, aliases, prefs (auto commit, auto
push, the GitHub login...), notes, and *which engines* hold a folder for it.
What never syncs: the folder's path, tokens, CLI logins, a pending auto
commit, a running task. `view` is the only way out, so that list is enforced
here and nowhere else.

Conflicts are per project, newest `updatedAt` wins. Every timestamp comes
from an engine's clock (the console only ever copies them), and the winning
copy is stored WITH its time, so after one exchange both sides compare equal
and nothing ping-pongs. A tie is a no-op both ways.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from . import workspace as W

# Prefs a synced copy may set, with the type each must have. Anything else in
# a cloud document is ignored: the document is written by browsers, and a
# stray key must not become an engine setting.
_PREF_TYPES: dict[str, type] = {
    "permissionMode": str, "autoCommit": bool, "autoPush": bool,
    "commitStyle": str, "batchWindowMin": int, "github": str,
}


def ts(s: Any) -> float:
    """An ISO time as epoch seconds; 0 for anything unreadable, so a garbled
    time always loses rather than winning forever."""
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0.0


def view(projects: list[dict[str, Any]], meta: dict[str, Any],
         engine: dict[str, Any]) -> dict[str, Any]:
    """What this engine offers the cloud. No path, ever."""
    eid = engine.get("id", "")
    out: dict[str, Any] = {}
    for p in projects:
        here = any(b.get("here") for b in p.get("bindings") or [])
        out[p["id"]] = {
            "name": p["name"],
            "aliases": list(p.get("aliases") or []),
            "prefs": clean_prefs(p.get("prefs") or {}),
            "notes": p.get("notes") or "",
            "updatedAt": p.get("updated_at") or "",
            # Presence only: "this engine has a folder for it".
            "bindings": {eid: {"label": engine.get("label", "")}} if here and eid else {},
        }
    return {"rev": int(meta.get("rev") or 0), "engine": {"id": eid, "label": engine.get("label", "")},
            "projects": out, "deleted": dict(meta.get("deleted") or {})}


def clean_prefs(prefs: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, t in _PREF_TYPES.items():
        if k not in prefs:
            continue
        v = prefs[k]
        if t is int:
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                continue
            v = int(v)
        elif not isinstance(v, t):
            continue
        out[k] = v[:80] if isinstance(v, str) else v
    return out


def incoming(local: list[dict[str, Any]], meta: dict[str, Any],
             body: dict[str, Any]) -> dict[str, list]:
    """Decide what a cloud copy changes here. Pure: returns a plan, touches
    nothing, so every rule below is testable without a database.

    {"save": [(row_fields, updated_at)], "delete": [(id, at)], "tomb": [(id, at)]}
    """
    by_id = {p["id"]: p for p in local}
    dead_here = dict(meta.get("deleted") or {})
    plan: dict[str, list] = {"save": [], "delete": [], "tomb": []}

    deleted = body.get("deleted") if isinstance(body.get("deleted"), dict) else {}
    for pid, at in deleted.items():
        if not isinstance(pid, str) or not ts(at):
            continue
        p = by_id.get(pid)
        if p is not None:
            # Only a deletion NEWER than the last change here removes it:
            # renamed on the desk after the phone deleted it is a keep.
            if ts(at) >= ts(p.get("updated_at")):
                plan["delete"].append((pid, str(at)))
        elif ts(dead_here.get(pid)) < ts(at):
            plan["tomb"].append((pid, str(at)))

    projects = body.get("projects") if isinstance(body.get("projects"), dict) else {}
    gone = {pid for pid, _ in plan["delete"]}
    for pid, c in projects.items():
        if not isinstance(pid, str) or not isinstance(c, dict) or pid in gone:
            continue
        at = c.get("updatedAt")
        if not ts(at):
            continue
        # Deleted here after this copy was made: the deletion stands.
        if ts(dead_here.get(pid)) >= ts(at) or ts(deleted.get(pid)) >= ts(at):
            continue
        p = by_id.get(pid)
        if p is not None and ts(at) <= ts(p.get("updated_at")):
            continue
        try:
            name = W.check_name(str(c.get("name") or ""))
        except W.WorkspaceError:
            continue
        aliases = c.get("aliases") if isinstance(c.get("aliases"), list) else []
        base = (p or {}).get("prefs") or {}
        plan["save"].append(({
            "id": pid, "name": name,
            "aliases": [str(a)[:60] for a in aliases][:8],
            "prefs": {**W.DEFAULT_PREFS, **base, **clean_prefs(c.get("prefs") or {})},
            "notes": str(c.get("notes") or "")[:4000],
        }, str(at)))
    return plan
