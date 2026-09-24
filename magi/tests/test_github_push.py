"""Pushing: git.push, and the credential path it uses.

Two kinds of remote, both built in tmp_path:

* a bare repository on disk -- real git behaviour (ahead, behind, refusals,
  never forcing) with no credential involved;
* the same bare repository served over smart HTTP by `git http-backend`
  behind a server that demands Basic auth. That is the path a GitHub push
  takes: git asks GIT_ASKPASS, askpass.py reads the token from the REAL
  credential store (a throwaway entry, removed afterwards), and the server
  records what it was sent. Then every file and every argv/env MAGI handed
  to git is searched for the token.
"""

from __future__ import annotations

import base64
import http.server
import os
import subprocess
import threading
import uuid
from pathlib import Path

import pytest

from magi import proc
from magi.code import git as G

TOKEN = "github_pat_PUSHTEST" + uuid.uuid4().hex


def _git(cwd: Path, *args: str) -> str:
    r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True,
                       encoding="utf-8")
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def _init(r: Path) -> Path:
    r.mkdir(parents=True, exist_ok=True)
    _git(r, "init", "-q", "-b", "main")
    for k, v in (("user.name", "t"), ("user.email", "t@t"), ("core.autocrlf", "false")):
        _git(r, "config", k, v)
    return r


def _commit(r: Path, name: str, text: str, msg: str = "c") -> None:
    (r / name).write_text(text)
    _git(r, "add", "--", name)
    _git(r, "commit", "-qm", msg)


@pytest.fixture
def remote(tmp_path, monkeypatch):
    monkeypatch.setattr("magi.settings.data_dir", lambda: tmp_path / "data")
    bare = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(bare)], check=True)
    seed = _init(tmp_path / "seed")
    _commit(seed, "app.py", "x = 1\n", "init")
    _git(seed, "remote", "add", "origin", str(bare))
    _git(seed, "push", "-q", "-u", "origin", "main")
    ours = tmp_path / "ours"
    subprocess.run(["git", "clone", "-q", str(bare), str(ours)], check=True)
    for k, v in (("user.name", "t"), ("user.email", "t@t"), ("core.autocrlf", "false")):
        _git(ours, "config", k, v)
    return {"bare": bare, "other": seed, "ours": ours, "tmp": tmp_path}


def _head(bare: Path, ref: str = "main") -> str:
    return _git(bare, "rev-parse", ref)


# ── remote URLs ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("url,host,owner,repo,pw,safe", [
    ("https://github.com/o/r.git", "github.com", "o", "r", False, "https://github.com/o/r.git"),
    ("https://x-access-token:ghp_x@github.com/o/r", "github.com", "o", "r", True,
     "https://github.com/o/r"),
    ("https://octo@GitHub.com/o/r/", "github.com", "o", "r", False, "https://GitHub.com/o/r/"),
    ("git@github.com:o/r.git", "github.com", "o", "r", False, "git@github.com:o/r.git"),
    ("ssh://git@github.com/o/r.git", "github.com", "o", "r", False, "ssh://github.com/o/r.git"),
    ("C:\\repos\\origin.git", "", "", "", False, "C:\\repos\\origin.git"),
    ("/tmp/origin.git", "", "", "", False, "/tmp/origin.git"),
])
def test_remote_info(url, host, owner, repo, pw, safe):
    i = G.remote_info(url)
    assert (i["host"], i["owner"], i["repo"], i["has_password"], i["safe"]) == (host, owner, repo, pw, safe)
    assert "ghp_x" not in i["safe"]


def test_state_names_the_repository_without_credentials(remote):
    o = remote["ours"]
    _git(o, "remote", "set-url", "origin", "https://u:ghp_secret@github.com/octo/thing.git")
    gh = G.state(o)["github"]
    assert (gh["owner"], gh["repo"], gh["host"], gh["remote"]) == ("octo", "thing", "github.com", "origin")
    assert "ghp_secret" not in str(G.state(o))


# ── pushing to a local remote (no credential) ─────────────────────────────

def test_push_sends_your_commits(remote):
    o = remote["ours"]
    _commit(o, "a.txt", "a\n")
    _commit(o, "b.txt", "b\n")
    p = G.push(o, None)
    assert p.ok and p.code == "pushed" and p.commits == 2
    assert _head(remote["bare"]) == _git(o, "rev-parse", "HEAD")
    assert p.new == _git(o, "rev-parse", "HEAD")[:7] and p.branch == "main"
    assert "Pushed 2 commits" in p.text
    assert G.state(o)["ahead"] == 0


def test_nothing_to_push_says_so(remote):
    p = G.push(remote["ours"], None)
    assert p.ok and p.code == "up_to_date" and p.commits == 0


def test_behind_is_refused_and_nothing_moves(remote):
    o = remote["ours"]
    _commit(remote["other"], "theirs.txt", "t\n")
    _git(remote["other"], "push", "-q")
    theirs = _head(remote["bare"])
    _commit(o, "mine.txt", "m\n")
    p = G.push(o, None)
    assert not p.ok and p.code == "behind" and "Pull first" in p.text
    assert _head(remote["bare"]) == theirs


def test_a_forcing_push_refspec_in_config_cannot_force(remote):
    """Even with `+refs/heads/*` configured, a diverged branch is refused,
    because push() names its own refspec -- and the fetch check stops it
    first. Belt: the refspec it passes has no '+'."""
    o = remote["ours"]
    _git(o, "config", "remote.origin.push", "+refs/heads/*:refs/heads/*")
    _commit(remote["other"], "theirs.txt", "t\n")
    _git(remote["other"], "push", "-q")
    theirs = _head(remote["bare"])
    _commit(o, "mine.txt", "m\n")
    seen = []
    real = G._run

    def spy(cwd, *args, **kw):
        seen.append(args)
        return real(cwd, *args, **kw)
    G._run, orig = spy, G._run
    try:
        G.push(o, None)
    finally:
        G._run = orig
    assert _head(remote["bare"]) == theirs
    for a in seen:
        assert "--force" not in a and "-f" not in a and not any(x.startswith("+") for x in a)


def test_the_push_itself_is_refused_if_the_remote_moves_after_the_check(remote, monkeypatch):
    """The race: the remote gains a commit between our fetch and our push.
    git's own non-fast-forward check refuses it, and the message says pull."""
    o = remote["ours"]
    _commit(o, "mine.txt", "m\n")
    real = G._run

    def racing(cwd, *args, **kw):
        if args and args[0] == "push":
            _commit(remote["other"], "late.txt", "l\n")
            _git(remote["other"], "push", "-q")
        return real(cwd, *args, **kw)
    monkeypatch.setattr(G, "_run", racing)
    p = G.push(o, None)
    assert not p.ok and p.code == "behind"


def test_a_new_branch_is_pushed_and_tracked(remote):
    o = remote["ours"]
    _git(o, "checkout", "-q", "-b", "feature/x")
    _commit(o, "f.txt", "f\n")
    p = G.push(o, None)
    assert p.ok and p.branch == "feature/x" and p.commits == 1
    assert _head(remote["bare"], "feature/x") == _git(o, "rev-parse", "HEAD")
    assert G.state(o)["upstream"] == "origin/feature/x"


def test_detached_and_mid_merge_are_refused(remote):
    o = remote["ours"]
    _git(o, "checkout", "-q", "--detach")
    assert G.push(o, None).code == "detached"
    _git(o, "checkout", "-q", "main")
    _git(o, "checkout", "-q", "-b", "side")
    _commit(o, "app.py", "x = 2\n")
    _git(o, "checkout", "-q", "main")
    _commit(o, "app.py", "x = 3\n")
    subprocess.run(["git", "-C", str(o), "merge", "side"], capture_output=True)
    assert G.push(o, None).code == "in_progress"


def test_a_repo_with_no_remote_is_refused(tmp_path):
    r = _init(tmp_path / "solo")
    _commit(r, "a", "a")
    assert G.push(r, None).code == "no_remote"


# ── HTTPS rules: an account, the right host, no password in the URL ──────

AUTH = G.Auth(login="octo", service="magi-github:test:octo")


@pytest.fixture
def no_network(monkeypatch):
    """Fails the test if anything reaches the network."""
    real = G._run

    def guard(cwd, *args, **kw):
        assert args[0] not in ("push", "fetch", "pull", "ls-remote"), args
        return real(cwd, *args, **kw)
    monkeypatch.setattr(G, "_run", guard)


def test_https_without_an_account_pushes_nothing(remote, no_network):
    o = remote["ours"]
    _git(o, "remote", "set-url", "origin", "https://github.com/octo/r.git")
    _commit(o, "a", "a")
    p = G.push(o, None)
    assert p.code == "no_account" and "octo/r" in p.text


def test_the_token_is_only_for_its_own_host(remote, no_network):
    o = remote["ours"]
    _git(o, "remote", "set-url", "origin", "https://gitlab.com/octo/r.git")
    _commit(o, "a", "a")
    assert G.push(o, AUTH).code == "wrong_host"


def test_a_password_in_the_remote_url_is_refused(remote, no_network):
    o = remote["ours"]
    _git(o, "remote", "set-url", "origin", "https://x:ghp_theirs@github.com/octo/r.git")
    _commit(o, "a", "a")
    p = G.push(o, AUTH)
    assert p.code == "password_in_url" and "ghp_theirs" not in p.text


def test_auth_clears_every_credential_helper_first():
    cfg = AUTH.config()
    assert cfg[:2] == ["-c", "credential.helper="]
    assert TOKEN not in " ".join(cfg)
    # A repository's own http.sslVerify=false must not let a proxy read it.
    assert "http.sslVerify=true" in cfg


def test_pull_uses_the_account_only_for_its_host(remote):
    o = remote["ours"]
    assert G._for_remote(o, AUTH) is None                  # a local path: no token
    _git(o, "remote", "set-url", "origin", "https://github.com/o/r.git")
    assert G._for_remote(o, AUTH) is AUTH
    _git(o, "remote", "set-url", "origin", "https://example.com/o/r.git")
    assert G._for_remote(o, AUTH) is None


@pytest.mark.parametrize("stderr,code", [
    ("To https://github.com/o/r.git\n ! [rejected]        main -> main (fetch first)", "behind"),
    ("remote: Permission to o/r.git denied to octo.\nfatal: unable to access", "auth_refused"),
    ("remote: Write access to repository not granted.\nfatal: unable to access", "auth_refused"),
    ("fatal: Authentication failed for 'https://github.com/o/r.git/'", "auth_refused"),
    ("remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found",
     "not_found"),
    ("remote: error: GH006: Protected branch update failed for refs/heads/main.", "protected"),
    ("error: failed to push some refs\nhook declined", "hook"),
    ("fatal: unable to access: Could not resolve host: github.com", "push"),
])
def test_push_failures_are_named(stderr, code):
    r = G._push_failed(G.Push(False, repo="o/r", branch="main"), stderr, AUTH, "push")
    assert r.code == code, r.text


# ── the real credential path, over HTTP, with the real credential store ──

def _backend() -> str:
    ex = subprocess.run(["git", "--exec-path"], capture_output=True, text=True).stdout.strip()
    for name in ("git-http-backend.exe", "git-http-backend"):
        if (Path(ex) / name).exists():
            return str(Path(ex) / name)
    pytest.skip("git-http-backend not available")


class _AuthGit(http.server.BaseHTTPRequestHandler):
    """Smart HTTP for one directory of bare repos, behind Basic auth."""
    root: Path
    backend: str
    user: str
    password: str
    seen: list

    def log_message(self, *a):
        pass

    def _serve(self):
        a = self.headers.get("Authorization") or ""
        self.seen.append(a)
        want = "Basic " + base64.b64encode(f"{self.user}:{self.password}".encode()).decode()
        if a != want:
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="magi-test"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        path, _, qs = self.path.partition("?")
        env = {"GIT_PROJECT_ROOT": str(self.root), "GIT_HTTP_EXPORT_ALL": "1",
               "PATH_INFO": path, "QUERY_STRING": qs, "REQUEST_METHOD": self.command,
               "CONTENT_TYPE": self.headers.get("Content-Type", ""),
               "CONTENT_LENGTH": str(len(body)), "REMOTE_USER": self.user,
               "REMOTE_ADDR": "127.0.0.1", "SystemRoot": os.environ.get("SystemRoot", ""),
               "HTTP_CONTENT_ENCODING": self.headers.get("Content-Encoding", ""),
               "GIT_PROTOCOL": self.headers.get("Git-Protocol", "")}
        r = subprocess.run([self.backend], input=body, env=env, capture_output=True,
                           creationflags=proc.NO_WINDOW)
        head, _, rest = r.stdout.partition(b"\r\n\r\n")
        status, headers = 200, []
        for line in head.decode("latin-1").split("\r\n"):
            k, _, v = line.partition(":")
            if k.lower() == "status":
                status = int(v.strip().split()[0])
            elif k:
                headers.append((k, v.strip()))
        self.send_response(status)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(rest)))
        self.end_headers()
        self.wfile.write(rest)

    do_GET = do_POST = _serve


@pytest.fixture
def http_remote(remote):
    bare = remote["bare"]
    _git(bare, "config", "http.receivepack", "true")
    handler = type("H", (_AuthGit,), {"root": bare.parent, "backend": _backend(),
                                     "user": "octo", "password": TOKEN, "seen": []})
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    host = f"127.0.0.1:{srv.server_address[1]}"
    _git(remote["ours"], "remote", "set-url", "origin", f"http://{host}/{bare.name}")
    yield {**remote, "host": host, "seen": handler.seen}
    srv.shutdown()


@pytest.fixture
def stored_token():
    keyring = pytest.importorskip("keyring")
    service = f"magi-github:pytest-{uuid.uuid4().hex[:8]}:octo"
    try:
        keyring.set_password(service, "octo", TOKEN)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no usable credential store: {e}")
    yield service
    try:
        keyring.delete_password(service, "octo")
    except Exception:  # noqa: BLE001
        pass


def test_push_over_http_gets_the_token_from_the_credential_store(http_remote, stored_token,
                                                                 monkeypatch):
    o = http_remote["ours"]
    _commit(o, "a.txt", "a\n")
    calls = []
    real = proc.run

    def spy(cmd, **kw):
        calls.append((list(cmd), dict(kw.get("env") or {})))
        return real(cmd, **kw)
    monkeypatch.setattr(proc, "run", spy)
    auth = G.Auth(login="octo", service=stored_token, host=http_remote["host"])
    p = G.push(o, auth)
    assert p.ok, p.text
    assert p.by == "octo" and p.commits == 1
    assert _head(http_remote["bare"]) == _git(o, "rev-parse", "HEAD")
    want = "Basic " + base64.b64encode(f"octo:{TOKEN}".encode()).decode()
    assert want in http_remote["seen"]

    # The token went over the wire and nowhere else MAGI can see.
    net = [c for c in calls if any(a in c[0] for a in ("push", "fetch"))]
    assert net and all("credential.helper=" in c[0] for c in net)
    for argv, env in calls:
        assert TOKEN not in " ".join(argv)
        assert TOKEN not in " ".join(f"{k}={v}" for k, v in env.items())
    for f in (o / ".git").rglob("*"):
        if f.is_file() and f.stat().st_size < 2_000_000:
            assert TOKEN.encode() not in f.read_bytes(), f
    assert TOKEN not in str(p.to_dict())
    script = Path(auth.env()["GIT_ASKPASS"]).read_text()
    assert TOKEN not in script and "askpass.py" in script


def test_a_wrong_token_is_a_refusal_with_a_reason(http_remote, stored_token):
    import keyring
    keyring.set_password(stored_token, "octo", "github_pat_WRONG0123456789abcdef")
    o = http_remote["ours"]
    _commit(o, "a.txt", "a\n")
    before = _head(http_remote["bare"])
    p = G.push(o, G.Auth(login="octo", service=stored_token, host=http_remote["host"]))
    assert not p.ok and p.code == "auth_refused", p.text
    assert _head(http_remote["bare"]) == before


def test_no_stored_token_fails_fast_instead_of_prompting(http_remote):
    o = http_remote["ours"]
    _commit(o, "a.txt", "a\n")
    p = G.push(o, G.Auth(login="octo", service="magi-github:pytest-none:octo",
                         host=http_remote["host"]))
    assert not p.ok and p.code == "auth_refused"


def test_pull_uses_the_account_too(http_remote, stored_token):
    _commit(http_remote["other"], "theirs.txt", "t\n")
    _git(http_remote["other"], "push", "-q")
    o = http_remote["ours"]
    auth = G.Auth(login="octo", service=stored_token, host=http_remote["host"])
    assert G.pull(o, None).ok is False                     # no account: refused by the server
    p = G.pull(o, auth)
    assert p.ok and p.commits == 1, p.text


def test_can_push_asks_git_and_writes_nothing(http_remote, stored_token):
    """The dry run: allowed with the right token, refused with a wrong one,
    and in neither case does anything reach the remote."""
    import keyring
    o = http_remote["ours"]
    before = _git(http_remote["bare"], "for-each-ref")
    auth = G.Auth(login="octo", service=stored_token, host=http_remote["host"])
    assert G.can_push(o, auth)["push"] is True
    keyring.set_password(stored_token, "octo", "github_pat_WRONG0123456789abcdef")
    r = G.can_push(o, auth)
    assert r["push"] is False, r
    assert _git(http_remote["bare"], "for-each-ref") == before
    assert "magi-write-check" not in before


def test_can_push_without_an_account_or_on_another_host_does_not_ask(remote, no_network):
    assert G.can_push(remote["ours"], None)["push"] is None
    assert G.can_push(remote["ours"], AUTH)["push"] is None       # a local path remote
