"""Track V4: branches, the agent's proposed commit subject and branch, commit
on a branch, and opening a pull request.

Real git repositories; GitHub is an httpx MockTransport, so no token and no
request leaves the machine.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path

import httpx
import pytest

from magi.code import git as G
from magi.code import sandbox as SB
from magi.code import tasks as T
from magi.code.agents import chain, edits
from magi.code.agents import base as B
from magi.code.agents import claude_cli as CC
from magi.code.agents.base import Mode, Task
from magi.github import accounts as A
from magi.github import pulls as P
from magi.github.client import GitHub
from tests.test_code_write import Editor


def _git(cwd, *a):
    r = subprocess.run(["git", "-C", str(cwd), *a], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


@pytest.fixture
def repo(tmp_path, monkeypatch):
    monkeypatch.setattr(SB, "BASE", tmp_path / "sandboxes")
    monkeypatch.setattr(SB, "patch_dir", lambda d: tmp_path / "patches")
    monkeypatch.setattr(T, "_profile", lambda: "test")
    r = tmp_path / "proj"
    r.mkdir()
    _git(r, "init", "-q", "-b", "main")
    _git(r, "config", "user.name", "t")
    _git(r, "config", "user.email", "t@t")
    _git(r, "config", "core.autocrlf", "false")
    (r / "app.py").write_text("x = 1\n")
    _git(r, "add", "-A")
    _git(r, "commit", "-qm", "init")
    return r


# ── names and suggestions ─────────────────────────────────────────────────

def test_branch_names_are_asked_of_git():
    assert G.check_branch("feat/api-v2") == "feat/api-v2"
    for bad in ("", "-x", "a..b", "a b", "HEAD", "x@{1}", "a" * 101, "x.lock", "/x"):
        with pytest.raises(G.GitError):
            G.check_branch(bad)


def test_an_agents_suggestion_is_made_safe():
    assert G.suggest_branch("Bump API Version!!") == "bump-api-version"
    assert G.suggest_branch("feature/a/b c") == "feature/a-b-c"
    assert G.suggest_branch("  ../--  ") == ""
    assert len(G.suggest_branch("x" * 200)) == 60


def test_commit_and_branch_lines_are_read_and_taken_out():
    text = ("Changed config.\n\nIt said COMMIT: not this one, inline.\n\n"
            "**COMMIT:** Bump API version to 2.\n`BRANCH: bump-api-v2`\n")
    subject, branch, rest = G.suggestions(text)
    assert subject == "Bump API version to 2" and branch == "bump-api-v2"
    assert "COMMIT:" not in rest.split("inline.")[1] and "BRANCH" not in rest
    assert rest.startswith("Changed config.") and "inline." in rest
    assert G.suggestions("no lines here") == ("", "", "no lines here")


def test_the_draft_uses_the_agents_subject():
    assert G.draft_message("make it 2", "Did it.", "Bump API version to 2").startswith(
        "Bump API version to 2\n\nDid it.")
    assert G.draft_message("make it 2", "Did it.").startswith("Make it 2")


def test_every_write_frame_asks_for_the_two_lines():
    assert "COMMIT:" in B.WRITE_FRAME and "BRANCH:" in B.WRITE_FRAME
    assert "COMMIT:" in edits.FORMAT_HELP and "BRANCH:" in edits.FORMAT_HELP
    t = Task("t", "q", Path("."), Mode.WRITE, mcp_servers=(CC.WS_SERVER,))
    assert "COMMIT:" in CC.write_frame(t)


# ── switching ─────────────────────────────────────────────────────────────

def test_switch_makes_and_switches_branches_and_never_loses_work(repo):
    (repo / "app.py").write_text("x = 5\n")              # uncommitted
    out = G.switch(repo, "feat", create=True)
    assert out == {"ok": True, "branch": "feat", "created": True, "from": "main"}
    assert _git(repo, "branch", "--show-current") == "feat"
    assert (repo / "app.py").read_text() == "x = 5\n", "uncommitted work came along"
    with pytest.raises(G.GitError) as e:
        G.switch(repo, "feat", create=True)
    assert e.value.code == "exists"
    with pytest.raises(G.GitError) as e:
        G.switch(repo, "nope")
    assert e.value.code == "no_branch"
    # A change that switching would overwrite: refused, nothing touched.
    _git(repo, "commit", "-qam", "five")
    G.switch(repo, "main")
    (repo / "app.py").write_text("x = 9\n")
    with pytest.raises(G.GitError) as e:
        G.switch(repo, "feat")
    assert e.value.code == "dirty" and (repo / "app.py").read_text() == "x = 9\n"
    assert _git(repo, "branch", "--show-current") == "main"


def test_a1_never_switches_branch(repo, monkeypatch):
    monkeypatch.setattr(SB, "is_engine_repo", lambda root: True)
    got = asyncio.run(T._to_branch(repo, "feat"))
    assert got["error"] == "read_only_project" and "A1 stays on its branch" in got["message"]
    assert _git(repo, "branch", "--show-current") == "main"


# ── commit on a branch, from a task ───────────────────────────────────────

async def _task(repo, agent):
    keep = chain.expand
    chain.expand = lambda order, settings: [agent]
    try:
        t = await T.start(project_id="p", root=repo, prompt="make x 2", order=[],
                          settings=None, mode="write")
        async for ev in T.stream(t):
            if ev["k"] == "approval":
                T.decide(t, True)
        return t
    finally:
        chain.expand = keep


class Suggester(Editor):
    async def run(self, task, *, emit, cancel):
        r = await super().run(task, emit=emit, cancel=cancel)
        r.text = "Set x to 2.\n\nCOMMIT: Set x to 2\nBRANCH: set-x-two"
        return r


def test_the_task_offers_the_agents_subject_and_branch(repo):
    t = asyncio.run(_task(repo, Suggester({"app.py": "x = 2\n"})))
    r = t.result
    assert r["write"] == "applied" and r["branch"] == "set-x-two"
    assert r["draft"].startswith("Set x to 2\n\nSet x to 2.")
    assert "COMMIT:" not in r["text"] and "BRANCH:" not in r["text"]


def test_commit_on_a_new_branch_leaves_main_alone(repo):
    t = asyncio.run(_task(repo, Suggester({"app.py": "x = 2\n"})))
    out = asyncio.run(T.commit(t, "Set x to 2", branch="set-x-two"))
    assert out["ok"] and out["commit"]["branch"] == "set-x-two"
    assert _git(repo, "branch", "--show-current") == "set-x-two"
    assert _git(repo, "log", "-1", "--format=%s") == "Set x to 2"
    assert _git(repo, "log", "-1", "--format=%s", "main") == "init", "main is untouched"


def test_a_bad_branch_name_commits_nothing(repo):
    t = asyncio.run(_task(repo, Suggester({"app.py": "x = 2\n"})))
    out = asyncio.run(T.commit(t, "Set x to 2", branch="bad name"))
    assert out["ok"] is False and out["error"] == "bad_branch"
    assert _git(repo, "log", "-1", "--format=%s") == "init"
    assert not t.result.get("commit")


# ── pull requests ─────────────────────────────────────────────────────────

def _fake_github(handler):
    return GitHub("TOKEN-SECRET", account="tony", transport=httpx.MockTransport(handler))


def _gh_repo(repo, monkeypatch, handler):
    _git(repo, "remote", "add", "origin", "https://github.com/tony/proj.git")
    monkeypatch.setattr(A, "client", lambda login: _fake_github(handler))


def _pr_json(n=7, head="feat", base="main"):
    return {"number": n, "title": "Set x", "state": "open", "html_url": f"https://github.com/tony/proj/pull/{n}",
            "head": {"ref": head, "sha": "abc"}, "base": {"ref": base}, "user": {"login": "tony"}}


def test_open_pull_posts_head_into_the_default_branch(repo, monkeypatch):
    seen = []

    def handler(req: httpx.Request):
        seen.append(req)
        if req.method == "GET" and req.url.path == "/repos/tony/proj":
            return httpx.Response(200, json={"default_branch": "main", "full_name": "tony/proj"})
        if req.method == "POST" and req.url.path == "/repos/tony/proj/pulls":
            return httpx.Response(201, json=_pr_json())
        return httpx.Response(404, json={})
    _gh_repo(repo, monkeypatch, handler)
    G.switch(repo, "feat", create=True)
    got = T.open_pull(repo, "tony", "Set x", "Body text")
    assert got["ok"] and got["pr"]["number"] == 7 and got["pr"]["url"].endswith("/pull/7")
    post = next(r for r in seen if r.method == "POST")
    assert json.loads(post.content) == {"title": "Set x", "head": "feat", "base": "main",
                                        "body": "Body text", "maintainer_can_modify": True}
    assert post.headers["authorization"] == "Bearer TOKEN-SECRET"


def test_open_pull_refuses_the_default_branch_and_explains_a_403(repo, monkeypatch):
    def handler(req):
        if req.method == "GET" and req.url.path == "/repos/tony/proj":
            return httpx.Response(200, json={"default_branch": "main"})
        return httpx.Response(403, json={"message": "Resource not accessible by personal access token"})
    _gh_repo(repo, monkeypatch, handler)
    got = T.open_pull(repo, "tony", "x", "")
    assert got["error"] == "default_branch"
    G.switch(repo, "feat", create=True)
    got = T.open_pull(repo, "tony", "x", "")
    assert got["error"] == "forbidden" and "Pull requests: Read and write" in got["message"]
    assert "TOKEN-SECRET" not in json.dumps(got)
    assert T.open_pull(repo, "", "x", "")["error"] == "no_account"


def test_pressing_twice_returns_the_open_pull_request(repo, monkeypatch):
    def handler(req):
        if req.method == "GET" and req.url.path == "/repos/tony/proj":
            return httpx.Response(200, json={"default_branch": "main"})
        if req.method == "POST":
            return httpx.Response(422, json={"message": "Validation Failed",
                                             "errors": [{"message": "A pull request already exists for tony:feat."}]})
        if req.method == "GET" and req.url.path == "/repos/tony/proj/pulls":
            assert req.url.params["head"] == "tony:feat"
            return httpx.Response(200, json=[_pr_json(9)])
        return httpx.Response(404, json={})
    _gh_repo(repo, monkeypatch, handler)
    G.switch(repo, "feat", create=True)
    got = T.open_pull(repo, "tony", "x", "")
    assert got["ok"] and got["pr"]["number"] == 9 and got["pr"]["existing"] is True


def test_open_pr_needs_a_push_first(repo):
    t = asyncio.run(_task(repo, Suggester({"app.py": "x = 2\n"})))
    got = asyncio.run(T.open_pr(t))
    assert got["error"] == "not_pushed"
