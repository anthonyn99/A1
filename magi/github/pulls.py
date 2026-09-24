"""Pull requests, read-only, with the checks on their head commit."""

from __future__ import annotations

from typing import Any

from .client import GitHub, GitHubError, Kind

BODY_MAX = 8000


def row(p: dict[str, Any]) -> dict[str, Any]:
    return {"number": p.get("number"), "title": str(p.get("title") or "")[:200],
            "state": "merged" if p.get("merged_at") else p.get("state", ""),
            "draft": bool(p.get("draft")), "user": (p.get("user") or {}).get("login", ""),
            "head": (p.get("head") or {}).get("ref", ""),
            "base": (p.get("base") or {}).get("ref", ""),
            "sha": (p.get("head") or {}).get("sha", ""),
            "updated": p.get("updated_at") or "", "url": p.get("html_url", "")}


def list_pulls(gh: GitHub, owner: str, name: str, state: str = "open",
               n: int = 30) -> list[dict[str, Any]]:
    state = state if state in ("open", "closed", "all") else "open"
    data = gh.get(f"/repos/{owner}/{name}/pulls",
                  {"state": state, "per_page": max(1, min(n, 100)), "sort": "updated",
                   "direction": "desc"}).data
    return [row(p) for p in (data if isinstance(data, list) else []) if isinstance(p, dict)]


def checks(gh: GitHub, owner: str, name: str, sha: str) -> dict[str, Any]:
    """Check runs plus the older commit statuses, folded into one verdict:
    "failure" if anything failed, "pending" if anything is still going,
    "success" if everything passed, "none" if nothing reported."""
    runs: list[dict[str, Any]] = []
    try:
        d = gh.get(f"/repos/{owner}/{name}/commits/{sha}/check-runs", {"per_page": 100}).data or {}
        for c in d.get("check_runs") or []:
            runs.append({"name": c.get("name", ""), "status": c.get("status", ""),
                         "conclusion": c.get("conclusion") or "", "url": c.get("html_url", "")})
    except GitHubError as e:
        # A fine-grained token without Checks: read gets 403 here; the
        # commit statuses below may still answer, so this is not fatal.
        if e.kind not in (Kind.FORBIDDEN, Kind.NOT_FOUND):
            raise
    try:
        d = gh.get(f"/repos/{owner}/{name}/commits/{sha}/status").data or {}
        for s in d.get("statuses") or []:
            st = s.get("state", "")
            runs.append({"name": s.get("context", ""),
                         "status": "completed" if st != "pending" else "in_progress",
                         "conclusion": {"error": "failure"}.get(st, st) if st != "pending" else "",
                         "url": s.get("target_url") or ""})
    except GitHubError as e:
        if e.kind not in (Kind.FORBIDDEN, Kind.NOT_FOUND):
            raise
    return {"verdict": verdict(runs), "runs": runs}


BAD = {"failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"}


def verdict(runs: list[dict[str, Any]]) -> str:
    if not runs:
        return "none"
    if any(r.get("conclusion") in BAD for r in runs):
        return "failure"
    if any(r.get("status") != "completed" for r in runs):
        return "pending"
    return "success"


def pull(gh: GitHub, owner: str, name: str, number: int) -> dict[str, Any]:
    p = gh.get(f"/repos/{owner}/{name}/pulls/{int(number)}").data or {}
    out = {**row(p), "body": str(p.get("body") or "")[:BODY_MAX],
           "mergeable": p.get("mergeable"), "mergeable_state": p.get("mergeable_state", ""),
           "commits": int(p.get("commits") or 0), "additions": int(p.get("additions") or 0),
           "deletions": int(p.get("deletions") or 0), "changed_files": int(p.get("changed_files") or 0)}
    out["checks"] = checks(gh, owner, name, out["sha"]) if out["sha"] else {"verdict": "none", "runs": []}
    return out
