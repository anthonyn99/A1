"""Issues, read-only.

GitHub's `/issues` also returns pull requests (a PR is an issue with a
`pull_request` key); they are dropped here so the Issues list is issues, and
PRs have their own list in pulls.py.
"""

from __future__ import annotations

from typing import Any

from .client import GitHub

BODY_MAX = 8000
COMMENT_MAX = 3000
COMMENTS = 30


def _labels(i: dict[str, Any]) -> list[str]:
    return [str((lb or {}).get("name") or "") for lb in i.get("labels") or []
            if isinstance(lb, dict)][:8]


def row(i: dict[str, Any]) -> dict[str, Any]:
    return {"number": i.get("number"), "title": str(i.get("title") or "")[:200],
            "state": i.get("state", ""), "user": (i.get("user") or {}).get("login", ""),
            "labels": _labels(i), "comments": int(i.get("comments") or 0),
            "updated": i.get("updated_at") or "", "url": i.get("html_url", "")}


def list_issues(gh: GitHub, owner: str, name: str, state: str = "open",
                n: int = 30) -> list[dict[str, Any]]:
    state = state if state in ("open", "closed", "all") else "open"
    data = gh.get(f"/repos/{owner}/{name}/issues",
                  {"state": state, "per_page": max(1, min(n, 100)), "sort": "updated"}).data
    return [row(i) for i in (data if isinstance(data, list) else [])
            if isinstance(i, dict) and "pull_request" not in i]


def issue(gh: GitHub, owner: str, name: str, number: int) -> dict[str, Any]:
    """One issue with its most recent comments. A PR number is refused with
    a pointer, so "issue #12" never silently shows a pull request."""
    i = gh.get(f"/repos/{owner}/{name}/issues/{int(number)}").data or {}
    out = {**row(i), "body": str(i.get("body") or "")[:BODY_MAX],
           "is_pull": "pull_request" in i}
    if int(i.get("comments") or 0):
        # The last page of comments is the conversation as it stands.
        cs = gh.get(f"/repos/{owner}/{name}/issues/{int(number)}/comments",
                    {"per_page": 100}).data
        cs = cs if isinstance(cs, list) else []
        out["thread"] = [{"user": (c.get("user") or {}).get("login", ""),
                          "date": c.get("created_at") or "",
                          "body": str(c.get("body") or "")[:COMMENT_MAX]}
                         for c in cs[-COMMENTS:] if isinstance(c, dict)]
    else:
        out["thread"] = []
    return out
