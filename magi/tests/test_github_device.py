"""Sign in with GitHub (device flow) and clone-from-GitHub.

No network: GitHub's device and token endpoints are an httpx.MockTransport,
the credential store is the in-memory stand-in from test_github_client, and
the clone runs against a local bare repository standing in for github.com.
"""

from __future__ import annotations

import subprocess
import time

import httpx
import pytest

from magi.code import git as G
from magi.github import accounts as A
from magi.github import device as D
from magi.tests.test_github_client import FakeKeyring, _user_srv

OAUTH_TOKEN = "gho_SENTINELdevice0123456789abcdefSENT"


@pytest.fixture
def env(tmp_path, monkeypatch):
    kr = FakeKeyring()
    monkeypatch.setattr(A, "_keyring", lambda: kr)
    monkeypatch.setattr(A, "_profile", lambda: "veda")
    monkeypatch.setattr(A, "_meta_file", lambda: tmp_path / "accounts.json")
    monkeypatch.setattr(D, "_file", lambda: tmp_path / "github_oauth.json")
    monkeypatch.setattr(D, "DEFAULT_CLIENT_ID", "")
    # accounts.add verifies the token against GET /user.
    real_add = A.add
    monkeypatch.setattr(A, "add", lambda tok: real_add(tok, transport=_user_srv(login="Veda-N").transport))
    D._FLOWS.clear()
    return kr


def _github(answers):
    """Device endpoint hands out a code; token endpoint answers from `answers`
    in turn (the last repeats)."""
    seen = []

    def handle(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        if req.url.path == "/login/device/code":
            return httpx.Response(200, json={"device_code": "DEVICE-SECRET", "user_code": "ABCD-1234",
                                             "verification_uri": "https://github.com/login/device",
                                             "expires_in": 900, "interval": 0})
        a = answers[min(len(seen) - 2, len(answers) - 1)] if len(seen) >= 2 else answers[0]
        return httpx.Response(200, json=a)
    return httpx.MockTransport(handle), seen


def _fast(monkeypatch):
    # No 5-second waits in a test: the stop event's wait returns at once.
    monkeypatch.setattr(D, "MIN_INTERVAL", 0)


def _until(fid, states, s=5.0):
    t0 = time.time()
    while time.time() - t0 < s:
        st = D.status(fid)
        if st and st["state"] in states:
            return st
        time.sleep(0.02)
    return D.status(fid)


def test_without_a_client_id_it_says_setup_is_needed(env):
    with pytest.raises(A.AccountError) as e:
        D.start()
    assert e.value.code == "no_client_id"


def test_client_id_is_validated_and_kept(env):
    with pytest.raises(A.AccountError):
        D.set_client_id("not an id!")
    assert D.set_client_id(" Ov23liABCDEFGHIJ1234 ") == "Ov23liABCDEFGHIJ1234"
    assert D.client_id() == "Ov23liABCDEFGHIJ1234"


def test_approval_stores_the_token_under_the_login_and_never_shows_it(env, monkeypatch):
    D.set_client_id("Ov23liABCDEFGHIJ1234")
    tr, seen = _github([{"error": "authorization_pending"}, {"error": "authorization_pending"},
                        {"access_token": OAUTH_TOKEN, "token_type": "bearer", "scope": "repo,workflow"}])
    monkeypatch.setattr(D, "_transport", tr)
    _fast(monkeypatch)
    f = D.start()
    assert f["user_code"] == "ABCD-1234" and "device_code" not in f
    assert "DEVICE-SECRET" not in repr(f)
    st = _until(f["id"], {"done", "error"})
    assert st["state"] == "done", st
    assert st["account"] == "veda-n"
    assert env.store == {("magi-github:veda:veda-n", "veda-n"): OAUTH_TOKEN}
    assert A.get("veda-n")["kind"] == "oauth"
    assert OAUTH_TOKEN not in repr(st)
    # Asked for the repo scope, so future repositories need no new token.
    assert b"scope=repo+workflow" in seen[0].content


def test_denied_and_expired_and_disabled(env, monkeypatch):
    D.set_client_id("Ov23liABCDEFGHIJ1234")
    _fast(monkeypatch)
    for answer, state in (({"error": "access_denied"}, "denied"), ({"error": "expired_token"}, "expired")):
        tr, _ = _github([answer])
        monkeypatch.setattr(D, "_transport", tr)
        f = D.start()
        assert _until(f["id"], {state})["state"] == state
    assert env.store == {}

    def off(req):
        return httpx.Response(200, json={"error": "device_flow_disabled"})
    monkeypatch.setattr(D, "_transport", httpx.MockTransport(off))
    with pytest.raises(A.AccountError) as e:
        D.start()
    assert "Enable Device Flow" in e.value.message


def test_a_new_sign_in_cancels_the_last(env, monkeypatch):
    D.set_client_id("Ov23liABCDEFGHIJ1234")
    tr, _ = _github([{"error": "authorization_pending"}])
    monkeypatch.setattr(D, "_transport", tr)
    a = D.start()
    b = D.start()
    assert D.status(a["id"]) is None and D.status(b["id"])["state"] == "pending"
    assert D.cancel(b["id"]) and D.status(b["id"])["state"] == "cancelled"


def test_clone_refuses_bad_names_and_existing_folders(tmp_path):
    for owner, repo in (("..", "x"), ("a", ".."), ("a b", "x"), ("a", "x/y")):
        with pytest.raises(G.GitError):
            G.clone(tmp_path, owner, repo, None)
    (tmp_path / "taken").mkdir()
    with pytest.raises(G.GitError) as e:
        G.clone(tmp_path, "me", "taken", None)
    assert e.value.code == "exists"


def test_clone_uses_the_plain_https_url(tmp_path, monkeypatch):
    calls = []

    class R:
        returncode = 0
        stdout = stderr = b""
    monkeypatch.setattr(G, "_run", lambda cwd, *args, auth=None, **kw: calls.append((cwd, args, auth)) or R())
    auth = G.Auth(login="veda-n", service="magi-github:veda:veda-n")
    dest = G.clone(tmp_path, "Veda-N", "notes", auth)
    assert dest == tmp_path / "notes"
    cwd, args, a = calls[0]
    assert args == ("clone", "--", "https://github.com/Veda-N/notes.git", str(tmp_path / "notes"))
    assert a is auth


def test_clone_really_clones(tmp_path, monkeypatch):
    # A local bare repository standing in for github.com.
    src = tmp_path / "src.git"
    subprocess.run(["git", "init", "--bare", "-q", str(src)], check=True)
    real = G._run

    def local(cwd, *args, auth=None, **kw):
        args = tuple(str(src) if str(a).startswith("https://github.com/") else a for a in args)
        return real(cwd, *args, auth=None, **kw)
    monkeypatch.setattr(G, "_run", local)
    out = tmp_path / "work"
    out.mkdir()
    dest = G.clone(out, "me", "proj", None)
    assert (dest / ".git").is_dir()
