"""A repository's shape on GitHub: branches, commits, divergence, releases.

Every function takes a `GitHub` (one account's client) and returns plain
dicts, or raises `GitHubError`. Nothing here holds or sees the token, and
nothing writes: Phase 11 is a read-only surface.

Each read is a conditional request (client.py), so opening the Repository
panel twice costs the hourly limit once.
"""

from __future__ import annotations

from typing import Any

from .client import GitHub

TITLE_MAX = 200


def _first_line(msg: str) -> str:
    return (msg or "").strip().split("\n", 1)[0][:TITLE_MAX]


def repo_info(gh: GitHub, owner: str, name: str) -> dict[str, Any]:
    d = gh.get(f"/repos/{owner}/{name}").data or {}
    return {"full_name": d.get("full_name", f"{owner}/{name}"),
            "private": bool(d.get("private")),
            "default_branch": d.get("default_branch", ""),
            "description": str(d.get("description") or "")[:300],
            "open_issues": int(d.get("open_issues_count") or 0),
            "pushed_at": d.get("pushed_at") or "",
            "url": d.get("html_url", "")}


def branches(gh: GitHub, owner: str, name: str) -> list[dict[str, Any]]:
    items, _ = gh.paginate(f"/repos/{owner}/{name}/branches", max_pages=3)
    return [{"name": b.get("name", ""),
             "sha": ((b.get("commit") or {}).get("sha") or "")[:40],
             "protected": bool(b.get("protected"))}
            for b in items if isinstance(b, dict)]


def commit_row(c: dict[str, Any]) -> dict[str, Any]:
    info = c.get("commit") or {}
    who = (info.get("author") or {})
    return {"sha": c.get("sha", ""), "short": (c.get("sha") or "")[:7],
            "title": _first_line(info.get("message", "")),
            "author": (c.get("author") or {}).get("login") or who.get("name", ""),
            "date": who.get("date", ""), "url": c.get("html_url", "")}


def commits(gh: GitHub, owner: str, name: str, ref: str = "", n: int = 30) -> list[dict[str, Any]]:
    params: dict[str, Any] = {"per_page": max(1, min(n, 100))}
    if ref:
        params["sha"] = ref
    data = gh.get(f"/repos/{owner}/{name}/commits", params).data
    return [commit_row(c) for c in (data if isinstance(data, list) else []) if isinstance(c, dict)]


def compare(gh: GitHub, owner: str, name: str, base: str, head: str) -> dict[str, Any]:
    """How `head` stands against `base` on GitHub: ahead/behind and status
    ("ahead", "behind", "diverged", "identical")."""
    d = gh.get(f"/repos/{owner}/{name}/compare/{base}...{head}", {"per_page": 1}).data or {}
    return {"base": base, "head": head, "status": d.get("status", ""),
            "ahead_by": int(d.get("ahead_by") or 0), "behind_by": int(d.get("behind_by") or 0)}


def releases(gh: GitHub, owner: str, name: str, n: int = 10) -> list[dict[str, Any]]:
    data = gh.get(f"/repos/{owner}/{name}/releases", {"per_page": max(1, min(n, 50))}).data
    return [{"tag": r.get("tag_name", ""), "name": str(r.get("name") or "")[:TITLE_MAX],
             "draft": bool(r.get("draft")), "prerelease": bool(r.get("prerelease")),
             "date": r.get("published_at") or r.get("created_at") or "",
             "url": r.get("html_url", "")}
            for r in (data if isinstance(data, list) else []) if isinstance(r, dict)]
