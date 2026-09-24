"""GitHub Actions, read-only: runs, their jobs, and why a job failed.

The post-push watch is built from `runs_for(sha)` + `summary()`: the console
asks again every so often while a run is in progress, and because every read
is conditional, an unchanged answer is a 304 that costs nothing. When a run
fails, `failure()` names the failing job and step and returns the END of its
log -- the lines that say why -- which is what "Ask the chain to diagnose"
hands to an agent.
"""

from __future__ import annotations

import re
from typing import Any

from .client import GitHub, GitHubError, Kind
from .pulls import BAD

TAIL_LINES = 80
_TS = re.compile(r"^\ufeff?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?")
# ANSI colour codes: runners print them, a transcript cannot show them.
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def run_row(r: dict[str, Any]) -> dict[str, Any]:
    return {"id": r.get("id"), "name": str(r.get("name") or r.get("display_title") or "")[:120],
            "title": str(r.get("display_title") or "")[:200],
            "status": r.get("status", ""), "conclusion": r.get("conclusion") or "",
            "sha": r.get("head_sha", ""), "branch": r.get("head_branch", ""),
            "event": r.get("event", ""), "number": r.get("run_number"),
            "attempt": r.get("run_attempt"),
            "created": r.get("created_at") or "", "updated": r.get("updated_at") or "",
            "url": r.get("html_url", "")}


def runs(gh: GitHub, owner: str, name: str, *, sha: str = "", branch: str = "",
         n: int = 20) -> dict[str, Any]:
    params: dict[str, Any] = {"per_page": max(1, min(n, 100))}
    if sha:
        params["head_sha"] = sha
    if branch:
        params["branch"] = branch
        # Found live on A1 (4,000+ runs): `branch=` alone answered with runs
        # from four weeks earlier -- a different slice on every page size --
        # while the same query plus exclude_pull_requests came back newest
        # first. A branch's own runs are pushes to it, so nothing is lost.
        params["exclude_pull_requests"] = "true"
    r = gh.get(f"/repos/{owner}/{name}/actions/runs", params)
    d = r.data or {}
    rows = [run_row(x) for x in d.get("workflow_runs") or [] if isinstance(x, dict)]
    return {"runs": rows, "total": int(d.get("total_count") or len(rows)), "cached": r.cached}


def summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """The watch's verdict over every run for one commit.

    "pending" while any is queued or running; then "failure" if any
    concluded badly, else "success". "none" when no workflow ran (yet)."""
    if not rows:
        return {"state": "none", "done": 0, "total": 0, "failed": []}
    done = [r for r in rows if r["status"] == "completed"]
    failed = [r for r in done if r["conclusion"] in BAD]
    state = ("pending" if len(done) < len(rows)
             else "failure" if failed else "success")
    return {"state": state, "done": len(done), "total": len(rows),
            "failed": [{"id": r["id"], "name": r["name"], "url": r["url"]} for r in failed]}


def jobs(gh: GitHub, owner: str, name: str, run_id: int) -> list[dict[str, Any]]:
    d = gh.get(f"/repos/{owner}/{name}/actions/runs/{int(run_id)}/jobs",
               {"per_page": 100, "filter": "latest"}).data or {}
    out = []
    for j in d.get("jobs") or []:
        if not isinstance(j, dict):
            continue
        out.append({"id": j.get("id"), "name": str(j.get("name") or "")[:120],
                    "status": j.get("status", ""), "conclusion": j.get("conclusion") or "",
                    "url": j.get("html_url", ""),
                    "steps": [{"number": s.get("number"), "name": str(s.get("name") or "")[:120],
                               "status": s.get("status", ""),
                               "conclusion": s.get("conclusion") or ""}
                              for s in j.get("steps") or [] if isinstance(s, dict)]})
    return out


def clean_log(text: str) -> list[str]:
    """Timestamps and colour codes off; `##[group]` markers made readable."""
    out = []
    for line in (text or "").splitlines():
        line = _ANSI.sub("", _TS.sub("", line)).rstrip()
        if line.startswith("##[group]"):
            line = "▸ " + line[len("##[group]"):]
        elif line.startswith("##[endgroup]"):
            continue
        out.append(line)
    return out


def tail(lines: list[str], n: int = TAIL_LINES) -> str:
    """The last `n` lines -- plus any `##[error]` line from before them, since
    a runner often prints the real error and then a screenful of cleanup."""
    body = lines[-n:]
    early = [ln for ln in lines[:-n] if ln.startswith("##[error]")][-5:]
    if early:
        body = early + ["…"] + body
    return "\n".join(body)


def job_log_tail(gh: GitHub, owner: str, name: str, job_id: int, n: int = TAIL_LINES) -> str:
    raw = gh.get_raw(f"/repos/{owner}/{name}/actions/jobs/{int(job_id)}/logs")
    return tail(clean_log(raw), n)


def failure(gh: GitHub, owner: str, name: str, run_id: int) -> dict[str, Any]:
    """A run's jobs, and for the first failed one: the step and its log tail."""
    js = jobs(gh, owner, name, run_id)
    bad = next((j for j in js if j["conclusion"] in BAD), None)
    out: dict[str, Any] = {"jobs": js, "failed_job": None}
    if bad is None:
        return out
    step = next((s for s in bad["steps"] if s["conclusion"] in BAD), None)
    fj = {"id": bad["id"], "name": bad["name"], "url": bad["url"],
          "step": step["name"] if step else "", "log": "", "log_error": ""}
    try:
        fj["log"] = job_log_tail(gh, owner, name, bad["id"])
    except GitHubError as e:
        fj["log_error"] = (e.message if e.kind != Kind.FORBIDDEN else
                           "This token cannot read Actions logs (a fine-grained token "
                           "needs Actions: Read-only).")
    out["failed_job"] = fj
    return out
