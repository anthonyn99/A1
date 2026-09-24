"""Phase 11: the read-only Repository surface.

The service modules (repos/pulls/issues/actions) against a scripted GitHub,
the signed-URL log fetch, the Actions watch's verdict, local branches, the
MCP bridge the Claude CLI reads through, and the routes' refusals. No
network, and the token is a sentinel that must never appear in any output.
"""

from __future__ import annotations

import asyncio
import io
import json
import subprocess
from pathlib import Path

import httpx
import pytest

from magi.github import actions as X
from magi.github import client as C
from magi.github import issues as I
from magi.github import mcp_server as M
from magi.github import pulls as P
from magi.github import repos as R

TOKEN = "github_pat_SENTINEL0123456789abcdefSENTINEL"
API = "https://api.github.com"


@pytest.fixture(autouse=True)
def _fresh():
    C._CACHE.clear()
    C.RATE.clear()
    yield
    C._CACHE.clear()
    C.RATE.clear()


class Server:
    def __init__(self):
        self.routes = {}
        self.seen: list[httpx.Request] = []

    def on(self, path, fn):
        self.routes[path] = fn
        return self

    def json(self, path, body, **kw):
        return self.on(path, lambda req: httpx.Response(200, json=body, **kw))

    def __call__(self, req):
        self.seen.append(req)
        fn = self.routes.get((req.url.host, req.url.path)) or self.routes.get(req.url.path)
        if fn is None:
            return httpx.Response(404, json={"message": "Not Found"})
        return fn(req)

    def gh(self):
        return C.GitHub(TOKEN, account="octo", transport=httpx.MockTransport(self))


# ── issues and pull requests ─────────────────────────────────────────────

def test_issues_list_leaves_pull_requests_out():
    s = Server().json("/repos/o/r/issues", [
        {"number": 1, "title": "real issue", "state": "open", "user": {"login": "a"},
         "labels": [{"name": "bug"}], "comments": 2},
        {"number": 2, "title": "a PR", "state": "open", "pull_request": {}}])
    rows = I.list_issues(s.gh(), "o", "r")
    assert [r["number"] for r in rows] == [1]
    assert rows[0]["labels"] == ["bug"]
    assert s.seen[0].url.params["state"] == "open"


def test_issues_state_is_whitelisted():
    s = Server().json("/repos/o/r/issues", [])
    I.list_issues(s.gh(), "o", "r", state="open&per_page=1000")
    assert s.seen[0].url.params["state"] == "open"


def test_one_issue_has_its_latest_comments_and_says_if_it_is_a_pr():
    s = (Server()
         .json("/repos/o/r/issues/7", {"number": 7, "title": "t", "body": "b" * 9000,
                                       "comments": 40, "pull_request": {}})
         .json("/repos/o/r/issues/7/comments",
               [{"user": {"login": f"u{i}"}, "body": f"c{i}"} for i in range(40)]))
    d = I.issue(s.gh(), "o", "r", 7)
    assert d["is_pull"] is True
    assert len(d["body"]) == I.BODY_MAX
    assert len(d["thread"]) == I.COMMENTS and d["thread"][-1]["body"] == "c39"


def test_an_issue_without_comments_asks_for_none():
    s = Server().json("/repos/o/r/issues/3", {"number": 3, "title": "t", "comments": 0})
    assert I.issue(s.gh(), "o", "r", 3)["thread"] == []
    assert [r.url.path for r in s.seen] == ["/repos/o/r/issues/3"]


def test_a_merged_pull_reads_as_merged_with_its_checks():
    s = (Server()
         .json("/repos/o/r/pulls/5", {"number": 5, "title": "p", "state": "closed",
                                      "merged_at": "2026-01-01T00:00:00Z",
                                      "head": {"ref": "f", "sha": "a" * 40}, "base": {"ref": "main"},
                                      "additions": 3, "deletions": 1, "changed_files": 2})
         .json(f"/repos/o/r/commits/{'a' * 40}/check-runs",
               {"check_runs": [{"name": "ci", "status": "completed", "conclusion": "success"}]})
         .json(f"/repos/o/r/commits/{'a' * 40}/status",
               {"statuses": [{"context": "deploy", "state": "error"}]}))
    d = P.pull(s.gh(), "o", "r", 5)
    assert d["state"] == "merged" and d["head"] == "f" and d["base"] == "main"
    assert d["checks"]["verdict"] == "failure"
    assert {c["name"] for c in d["checks"]["runs"]} == {"ci", "deploy"}


def test_checks_survive_a_token_that_cannot_read_check_runs():
    s = (Server()
         .on(f"/repos/o/r/commits/{'b' * 40}/check-runs",
             lambda req: httpx.Response(403, json={"message": "Resource not accessible"}))
         .json(f"/repos/o/r/commits/{'b' * 40}/status",
               {"statuses": [{"context": "ci", "state": "pending"}]}))
    assert P.checks(s.gh(), "o", "r", "b" * 40)["verdict"] == "pending"


@pytest.mark.parametrize("runs,want", [
    ([], "none"),
    ([{"status": "completed", "conclusion": "success"}], "success"),
    ([{"status": "in_progress", "conclusion": ""}, {"status": "completed", "conclusion": "success"}], "pending"),
    ([{"status": "in_progress", "conclusion": ""}, {"status": "completed", "conclusion": "failure"}], "failure"),
    ([{"status": "completed", "conclusion": "skipped"}], "success"),
    ([{"status": "completed", "conclusion": "timed_out"}], "failure"),
])
def test_the_check_verdict(runs, want):
    assert P.verdict(runs) == want


# ── repository shape ─────────────────────────────────────────────────────

def test_branches_commits_compare_and_releases():
    s = (Server()
         .json("/repos/o/r/branches", [{"name": "main", "commit": {"sha": "c" * 40}, "protected": True}])
         .json("/repos/o/r/commits", [{"sha": "d" * 40, "html_url": "u",
                                       "commit": {"message": "Title line\n\nbody",
                                                  "author": {"name": "N", "date": "D"}},
                                       "author": {"login": "octo"}}])
         .json("/repos/o/r/compare/main...feat", {"status": "diverged", "ahead_by": 2, "behind_by": 3})
         .json("/repos/o/r/releases", [{"tag_name": "v1", "name": "One", "prerelease": True}]))
    gh = s.gh()
    assert R.branches(gh, "o", "r") == [{"name": "main", "sha": "c" * 40, "protected": True}]
    c = R.commits(gh, "o", "r", ref="feat", n=500)[0]
    assert (c["short"], c["title"], c["author"]) == ("ddddddd", "Title line", "octo")
    commits_req = next(r for r in s.seen if r.url.path.endswith("/commits"))
    assert commits_req.url.params["sha"] == "feat" and commits_req.url.params["per_page"] == "100"
    assert R.compare(gh, "o", "r", "main", "feat")["behind_by"] == 3
    assert R.releases(gh, "o", "r")[0] == {"tag": "v1", "name": "One", "draft": False,
                                           "prerelease": True, "date": "", "url": ""}


# ── Actions ──────────────────────────────────────────────────────────────

def _run(i, status="completed", conclusion="success", sha="e" * 40):
    return {"id": i, "name": f"wf{i}", "status": status, "conclusion": conclusion,
            "head_sha": sha, "head_branch": "main", "run_number": i}


def test_runs_for_a_commit_ask_by_head_sha_and_repeat_for_free():
    etag = 'W/"runs1"'

    def runs(req):
        if req.headers.get("if-none-match") == etag:
            return httpx.Response(304, headers={"etag": etag})
        return httpx.Response(200, json={"total_count": 1, "workflow_runs": [_run(1)]},
                              headers={"etag": etag})
    s = Server().on("/repos/o/r/actions/runs", runs)
    gh = s.gh()
    a = X.runs(gh, "o", "r", sha="e" * 40)
    b = X.runs(gh, "o", "r", sha="e" * 40)
    assert s.seen[0].url.params["head_sha"] == "e" * 40
    assert (a["cached"], b["cached"]) == (False, True)
    assert a["runs"] == b["runs"]


def test_runs_for_a_branch_exclude_pull_requests():
    # Without it GitHub returned a weeks-old slice for a busy branch (live, A1).
    s = Server().json("/repos/o/r/actions/runs", {"total_count": 0, "workflow_runs": []})
    X.runs(s.gh(), "o", "r", branch="main")
    X.runs(s.gh(), "o", "r", sha="e" * 40)
    assert s.seen[0].url.params["exclude_pull_requests"] == "true"
    assert "exclude_pull_requests" not in s.seen[1].url.params


@pytest.mark.parametrize("rows,state", [
    ([], "none"),
    ([_run(1, "queued", None)], "pending"),
    ([_run(1), _run(2, "in_progress", None)], "pending"),
    ([_run(1), _run(2)], "success"),
    ([_run(1), _run(2, conclusion="failure")], "failure"),
    ([_run(1, conclusion="cancelled")], "failure"),
])
def test_the_watch_verdict(rows, state):
    assert X.summary([X.run_row(r) for r in rows])["state"] == state


def test_a_failure_names_the_job_the_step_and_the_end_of_its_log():
    log = "\n".join(
        ["2026-09-24T02:00:00.0000000Z ##[group]Run setup", "2026-09-24T02:00:00.1Z setting up",
         "2026-09-24T02:00:00.2Z ##[endgroup]", "2026-09-24T02:00:01.0Z ##[error]the real error"]
        + [f"2026-09-24T02:00:02.0Z \x1b[31mnoise {i}\x1b[0m" for i in range(200)])

    s = (Server()
         .json("/repos/o/r/actions/runs/9/jobs", {"jobs": [
             {"id": 1, "name": "build", "status": "completed", "conclusion": "success", "steps": []},
             {"id": 2, "name": "deploy", "status": "completed", "conclusion": "failure",
              "steps": [{"number": 1, "name": "checkout", "conclusion": "success"},
                        {"number": 2, "name": "Deploy", "conclusion": "failure"}]}]})
         .on("/repos/o/r/actions/jobs/2/logs",
             lambda req: httpx.Response(302, headers={"location": "https://logs.blob.example/x?sig=1"}))
         .on(("logs.blob.example", "/x"), lambda req: httpx.Response(200, text=log)))
    d = X.failure(s.gh(), "o", "r", 9)
    fj = d["failed_job"]
    assert (fj["name"], fj["step"]) == ("deploy", "Deploy")
    lines = fj["log"].splitlines()
    assert lines[0] == "##[error]the real error"          # the early error is kept
    assert lines[-1] == "noise 199" and "\x1b" not in fj["log"]
    assert not any(ln.startswith("2026-") for ln in lines)
    # The signed URL is its own credential: the token never goes there.
    blob = [r for r in s.seen if r.url.host == "logs.blob.example"][0]
    assert "authorization" not in {k.lower() for k in blob.headers}
    api = [r for r in s.seen if r.url.path.endswith("/logs")][0]
    assert api.headers["authorization"] == f"Bearer {TOKEN}"


@pytest.mark.parametrize("loc", ["http://logs.example/x", f"{API}/repos/o/r/other", "ftp://x/y", ""])
def test_the_log_redirect_is_only_followed_to_https_elsewhere(loc):
    s = Server().on("/repos/o/r/actions/jobs/2/logs",
                    lambda req: httpx.Response(302, headers={"location": loc}))
    with pytest.raises(C.GitHubError):
        s.gh().get_raw("/repos/o/r/actions/jobs/2/logs")
    assert len(s.seen) == 1


def test_a_token_without_actions_access_gets_a_sentence_not_a_crash():
    s = (Server()
         .json("/repos/o/r/actions/runs/9/jobs", {"jobs": [
             {"id": 2, "name": "deploy", "conclusion": "failure", "steps": []}]})
         .on("/repos/o/r/actions/jobs/2/logs",
             lambda req: httpx.Response(403, json={"message": "Must have admin rights"})))
    fj = X.failure(s.gh(), "o", "r", 9)["failed_job"]
    assert fj["log"] == "" and "Actions: Read-only" in fj["log_error"]


def test_a_passing_run_has_no_failed_job():
    s = Server().json("/repos/o/r/actions/runs/9/jobs", {"jobs": [
        {"id": 1, "name": "build", "status": "completed", "conclusion": "success", "steps": []}]})
    assert X.failure(s.gh(), "o", "r", 9)["failed_job"] is None
    assert len(s.seen) == 1                           # no log fetched


def test_the_log_is_the_end_only_and_scrubbed():
    body = ("x" * (C.MAX_RAW + 10)) + TOKEN
    s = Server().on("/repos/o/r/actions/jobs/2/logs", lambda req: httpx.Response(200, text=body))
    out = s.gh().get_raw("/repos/o/r/actions/jobs/2/logs")
    assert TOKEN not in out and out.endswith("***")
    assert len(out) <= C.MAX_RAW


# ── local branches ───────────────────────────────────────────────────────

def _git(cwd, *a):
    subprocess.run(["git", "-C", str(cwd), *a], check=True, capture_output=True)


def test_local_branches_know_their_upstream_distance(tmp_path):
    from magi.code import git as G
    origin, work = tmp_path / "origin.git", tmp_path / "work"
    _git(tmp_path, "init", "--bare", "-b", "main", str(origin))
    _git(tmp_path, "clone", str(origin), str(work))
    for k, v in (("user.email", "t@t"), ("user.name", "t"), ("commit.gpgsign", "false")):
        _git(work, "config", k, v)
    (work / "a").write_text("1")
    _git(work, "add", "a")
    _git(work, "commit", "-m", "one")
    _git(work, "push", "-u", "origin", "main")
    (work / "a").write_text("2")
    _git(work, "commit", "-am", "two")
    _git(work, "branch", "loose")
    rows = {b["name"]: b for b in G.branches(work)}
    assert rows["main"]["current"] and rows["main"]["upstream"] == "origin/main"
    assert (rows["main"]["ahead"], rows["main"]["behind"]) == (1, 0)
    assert rows["loose"]["upstream"] == "" and not rows["loose"]["current"]
    assert rows["main"]["subject"] == "two"


# ── the MCP bridge ───────────────────────────────────────────────────────

class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _server(answer):
    seen = []

    def opener(req, timeout=0):
        seen.append(req.full_url)
        return _Resp(json.dumps(answer).encode())
    return M.Server(8123, "proj_x", opener=opener), seen


def test_mcp_lists_only_read_tools_pinned_to_one_project():
    srv, seen = _server({"ok": True})
    init = srv.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                       "params": {"protocolVersion": "2025-03-26"}})
    assert init["result"]["protocolVersion"] == "2025-03-26"
    assert srv.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    tools = srv.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]
    names = {t["name"] for t in tools}
    assert names == {"github_overview", "github_branches", "github_commits", "github_issues",
                     "github_issue", "github_pulls", "github_pull", "github_actions_runs",
                     "github_run_failure"}
    assert all(t["annotations"]["readOnlyHint"] for t in tools)
    # No argument anywhere names a repository or a project.
    for t in tools:
        assert not ({"owner", "repo", "project", "url"} & set(t["inputSchema"].get("properties", {})))


def test_mcp_calls_go_to_the_engine_on_loopback_for_that_project_only():
    srv, seen = _server({"ok": True, "issue": {"number": 12}, "rate": {"remaining": 1}})
    r = srv.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                    "params": {"name": "github_issue", "arguments": {"number": 12}}})
    assert seen == ["http://127.0.0.1:8123/api/code/projects/proj_x/repo/issues/12"]
    body = json.loads(r["result"]["content"][0]["text"])
    assert body["issue"]["number"] == 12 and "rate" not in body
    assert r["result"]["isError"] is False


@pytest.mark.parametrize("args", [{"number": "12/../../x"}, {"number": -1}, {"number": True}, {}])
def test_mcp_refuses_a_number_that_is_not_one(args):
    srv, seen = _server({"ok": True})
    r = srv.handle({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                    "params": {"name": "github_issue", "arguments": args}})
    assert r["result"]["isError"] is True and seen == []


def test_mcp_passes_the_engines_refusal_through_in_words():
    srv, _ = _server({"ok": False, "error": "no_account", "message": "Choose which GitHub account"})
    r = srv.handle({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                    "params": {"name": "github_overview", "arguments": {}}})
    assert r["result"]["isError"] and "Choose which" in r["result"]["content"][0]["text"]


def test_mcp_state_and_unknown_tool():
    srv, seen = _server({"ok": True})
    srv.handle({"jsonrpc": "2.0", "id": 6, "method": "tools/call",
                "params": {"name": "github_pulls", "arguments": {"state": "everything"}}})
    assert seen[-1].endswith("/repo/pulls?state=open")
    r = srv.handle({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                    "params": {"name": "github_merge", "arguments": {}}})
    assert r["result"]["isError"]
    assert srv.handle({"jsonrpc": "2.0", "id": 8, "method": "resources/list"})["error"]["code"] == -32601


def test_mcp_serves_newline_delimited_stdio():
    srv, _ = _server({"ok": True})
    fin = io.StringIO('{"jsonrpc":"2.0","id":1,"method":"ping"}\nnot json\n\n'
                      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    fout = io.StringIO()
    srv.serve(fin, fout)
    assert [json.loads(x) for x in fout.getvalue().splitlines()] == [
        {"jsonrpc": "2.0", "id": 1, "result": {}}]


# ── the per-task MCP config, and the Claude CLI's argv ───────────────────

@pytest.fixture
def gh_repo(tmp_path, monkeypatch):
    monkeypatch.setattr("magi.settings.data_dir", lambda: tmp_path / "data")
    work = tmp_path / "w"
    work.mkdir()
    _git(work, "init", "-b", "main")
    _git(work, "remote", "add", "origin", "https://github.com/octo/thing.git")
    return work


def test_the_mcp_config_names_a_script_a_port_and_the_project_nothing_secret(gh_repo):
    from magi.code import tasks as T
    f = T.write_mcp_config("t1", "proj_abc", gh_repo, "octo")
    cfg = json.loads(f.read_text("utf-8"))
    srv = cfg["mcpServers"]["magi_github"]
    assert srv["args"][0] == "-I" and srv["args"][1].endswith("mcp_server.py")
    assert srv["args"][-2:] == ["--project", "proj_abc"]
    assert TOKEN not in f.read_text("utf-8")


def test_no_mcp_config_without_an_account_or_off_github(gh_repo, tmp_path):
    from magi.code import tasks as T
    assert T.write_mcp_config("t1", "p", gh_repo, "") is None
    _git(gh_repo, "remote", "set-url", "origin", "https://gitlab.com/octo/thing.git")
    assert T.write_mcp_config("t1", "p", gh_repo, "octo") is None
    assert T.write_mcp_config("t1", "p", tmp_path, "octo") is None      # not a repo


def test_claude_gets_the_tools_only_when_there_is_a_config(tmp_path):
    from magi.code.agents import claude_cli as CC
    from magi.code.agents.base import Mode, Task
    plain = CC.build_argv("claude", Task(id="t", prompt="p", root=tmp_path))
    assert "--mcp-config" not in plain and "--allowedTools" not in plain
    cfg = tmp_path / "m.json"
    argv = CC.build_argv("claude", Task(id="t", prompt="p", root=tmp_path, mcp_config=cfg,
                                        mode=Mode.READ))
    i = argv.index("--mcp-config")
    assert argv[i + 1] == str(cfg) and argv[argv.index("--allowedTools") + 1] == "mcp__magi_github"
    # The built-in tool list is untouched: still exactly the read tools.
    assert argv[argv.index("--tools") + 1] == CC.READ_TOOLS
    assert "--strict-mcp-config" in argv


# ── the routes ───────────────────────────────────────────────────────────

def _here(prefs, root):
    async def here(pid):
        return {"name": "X", "prefs": prefs}, root, None
    return here


def test_the_panel_without_an_account_says_how_to_choose_one(gh_repo, monkeypatch):
    from magi.code import routes as RT
    monkeypatch.setattr(RT, "_project_here", _here({}, gh_repo))
    d = asyncio.run(RT.repo_issues("p"))
    assert d["error"] == "no_account" and "octo/thing" in d["message"]


def test_the_panel_off_github_says_so(gh_repo, monkeypatch):
    from magi.code import routes as RT
    _git(gh_repo, "remote", "set-url", "origin", "https://gitlab.com/octo/thing.git")
    monkeypatch.setattr(RT, "_project_here", _here({"github": "octo"}, gh_repo))
    assert asyncio.run(RT.repo_pulls("p"))["error"] == "not_github"


def test_githubs_refusal_comes_back_in_words_and_without_the_token(gh_repo, monkeypatch):
    from magi.code import routes as RT
    from magi.github import accounts as A
    s = Server().on("/repos/octo/thing/issues",
                    lambda req: httpx.Response(401, json={"message": f"Bad credentials {TOKEN}"}))
    monkeypatch.setattr(RT, "_project_here", _here({"github": "octo"}, gh_repo))
    monkeypatch.setattr(A, "client", lambda login: s.gh())
    d = asyncio.run(RT.repo_issues("p"))
    assert d["ok"] is False and d["error"] == "bad_token"
    assert TOKEN not in json.dumps(d)


def test_a_successful_read_names_the_repo_and_account(gh_repo, monkeypatch):
    from magi.code import routes as RT
    from magi.github import accounts as A
    s = Server().json("/repos/octo/thing/actions/runs",
                      {"total_count": 2, "workflow_runs": [_run(1), _run(2, "in_progress", None)]})
    monkeypatch.setattr(RT, "_project_here", _here({"github": "octo"}, gh_repo))
    monkeypatch.setattr(A, "client", lambda login: s.gh())
    d = asyncio.run(RT.repo_actions("p", sha="e" * 40))
    assert d["ok"] and d["repo"] == "octo/thing" and d["account"] == "octo"
    assert d["summary"]["state"] == "pending" and d["summary"]["total"] == 2
    assert TOKEN not in json.dumps(d)
