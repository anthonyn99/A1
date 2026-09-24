"""The GitHub REST client, the account store, and the askpass helper.

No network: every GitHub answer comes from an httpx.MockTransport, and the
credential store is an in-memory stand-in for keyring. The token used
throughout is a sentinel, and the last tests grep every output MAGI produces
-- responses, errors, reprs, logs, files -- for it.
"""

from __future__ import annotations

import json
import logging
import traceback

import httpx
import pytest

from magi.github import accounts as A
from magi.github import askpass
from magi.github import client as C

TOKEN = "github_pat_SENTINEL0123456789abcdefSENTINEL"


@pytest.fixture(autouse=True)
def _fresh_state():
    C._CACHE.clear()
    C.RATE.clear()
    yield
    C._CACHE.clear()
    C.RATE.clear()


class Server:
    """A scripted GitHub: routes -> handler(request) -> httpx.Response,
    with every request it saw kept for the assertions."""

    def __init__(self):
        self.routes = {}
        self.seen: list[httpx.Request] = []

    def on(self, path, fn):
        self.routes[path] = fn
        return self

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.seen.append(req)
        fn = self.routes.get(req.url.path)
        if fn is None:
            return httpx.Response(404, json={"message": "Not Found"})
        return fn(req)

    @property
    def transport(self):
        return httpx.MockTransport(self)


def _rate(remaining=4999, reset=1_900_000_000):
    return {"x-ratelimit-limit": "5000", "x-ratelimit-remaining": str(remaining),
            "x-ratelimit-used": str(5000 - remaining), "x-ratelimit-reset": str(reset),
            "x-ratelimit-resource": "core"}


def _gh(srv, token=TOKEN, account="octo"):
    return C.GitHub(token, account=account, transport=srv.transport)


# ── requests ──────────────────────────────────────────────────────────────

def test_every_request_pins_the_api_version_and_sends_the_token_as_a_header():
    srv = Server().on("/user", lambda r: httpx.Response(200, json={"login": "octo"}))
    _gh(srv).get("/user")
    h = srv.seen[0].headers
    assert h["X-GitHub-Api-Version"] == C.API_VERSION == "2026-03-10"
    assert h["Authorization"] == f"Bearer {TOKEN}"
    assert h["Accept"] == "application/vnd.github+json"
    assert TOKEN not in str(srv.seen[0].url)


def test_etag_is_sent_back_and_a_304_returns_the_remembered_body():
    def user(r):
        if r.headers.get("If-None-Match") == 'W/"abc"':
            return httpx.Response(304, headers=_rate(4999))
        return httpx.Response(200, json={"login": "octo"}, headers={"etag": 'W/"abc"', **_rate(4998)})
    srv = Server().on("/user", user)
    gh = _gh(srv)
    a = gh.get("/user")
    b = gh.get("/user")
    assert (a.cached, b.cached) == (False, True)
    assert b.data == {"login": "octo"} and b.status == 304
    assert "If-None-Match" not in srv.seen[0].headers
    assert srv.seen[1].headers["If-None-Match"] == 'W/"abc"'


def test_etag_cache_is_per_account():
    srv = Server().on("/user", lambda r: httpx.Response(200, json={}, headers={"etag": '"e"'}))
    _gh(srv, account="one").get("/user")
    _gh(srv, account="two").get("/user")
    assert "If-None-Match" not in srv.seen[1].headers


def test_pagination_follows_link_next_and_a_second_pass_is_all_304():
    base = "https://api.github.com/user/repos"

    def repos(r):
        page = int(r.url.params.get("page", "1"))
        etag = f'"p{page}"'
        if r.headers.get("If-None-Match") == etag:
            return httpx.Response(304)
        link = f'<{base}?per_page=100&page={page + 1}>; rel="next", <{base}?page=3>; rel="last"' \
            if page < 3 else f'<{base}?page=1>; rel="first"'
        return httpx.Response(200, json=[{"id": page * 10 + i} for i in range(2)],
                              headers={"etag": etag, "link": link})
    srv = Server().on("/user/repos", repos)
    gh = _gh(srv)
    items, cached = gh.paginate("/user/repos")
    assert [i["id"] for i in items] == [10, 11, 20, 21, 30, 31]
    assert cached is False
    assert srv.seen[0].url.params["per_page"] == "100"
    items2, cached2 = gh.paginate("/user/repos")
    assert items2 == items and cached2 is True
    assert len(srv.seen) == 6


def test_pagination_stops_at_max_pages():
    def repos(r):
        n = int(r.url.params.get("page", "1"))
        return httpx.Response(200, json=[n], headers={
            "link": f'<https://api.github.com/user/repos?page={n + 1}>; rel="next"'})
    items, _ = _gh(Server().on("/user/repos", repos)).paginate("/user/repos", max_pages=4)
    assert items == [1, 2, 3, 4]


def test_a_next_link_to_another_host_is_refused():
    srv = Server().on("/user/repos", lambda r: httpx.Response(200, json=[1], headers={
        "link": '<https://evil.example/steal?page=2>; rel="next"'}))
    with pytest.raises(C.GitHubError):
        _gh(srv).paginate("/user/repos")
    assert all(r.url.host == "api.github.com" for r in srv.seen)


def test_rate_limit_headers_are_recorded_per_account():
    srv = Server().on("/user", lambda r: httpx.Response(200, json={}, headers=_rate(4321, 1_900_000_123)))
    gh = _gh(srv, account="octo")
    gh.get("/user")
    assert gh.rate()["remaining"] == 4321
    assert gh.rate()["reset"] == 1_900_000_123
    assert C.RATE["octo"]["limit"] == 5000


@pytest.mark.parametrize("status,headers,body", [
    (403, _rate(0, 1_900_000_000), {"message": "API rate limit exceeded for user"}),
    (429, {"retry-after": "60"}, {"message": "Too many"}),
    (403, {"retry-after": "30"}, {"message": "You have exceeded a secondary rate limit"}),
])
def test_rate_limits_are_a_typed_error_with_a_reset_time(status, headers, body):
    srv = Server().on("/user", lambda r: httpx.Response(status, json=body, headers=headers))
    with pytest.raises(C.GitHubError) as e:
        _gh(srv).get("/user")
    assert e.value.kind == C.Kind.RATE_LIMITED
    assert e.value.reset_at and e.value.reset_at > 1_000_000_000
    assert "resets at" in e.value.message


@pytest.mark.parametrize("status,body,kind", [
    (401, {"message": "Bad credentials"}, C.Kind.BAD_TOKEN),
    (403, {"message": "Resource not accessible by personal access token"}, C.Kind.FORBIDDEN),
    (404, {"message": "Not Found"}, C.Kind.NOT_FOUND),
    (422, {"message": "Validation Failed"}, C.Kind.INVALID),
    (400, {"message": "Unsupported 'X-GitHub-Api-Version' header"}, C.Kind.BAD_VERSION),
    (502, {"message": "Bad gateway"}, C.Kind.UNAVAILABLE),
    (418, {"message": "teapot"}, C.Kind.UNKNOWN),
])
def test_status_codes_map_to_kinds(status, body, kind):
    srv = Server().on("/user", lambda r: httpx.Response(status, json=body))
    with pytest.raises(C.GitHubError) as e:
        _gh(srv).get("/user")
    assert e.value.kind == kind
    assert e.value.status == status
    assert e.value.to_dict()["error"] == str(kind)


def test_a_network_failure_is_a_typed_error():
    def boom(r):
        raise httpx.ConnectError("no route", request=r)
    with pytest.raises(C.GitHubError) as e:
        C.GitHub(TOKEN, transport=httpx.MockTransport(boom)).get("/user")
    assert e.value.kind == C.Kind.NETWORK
    assert e.value.__cause__ is None and e.value.__suppress_context__


def test_scopes_and_token_kinds():
    assert C.scopes("repo, read:org ,") == ["read:org", "repo"]
    assert C.scopes("") == []
    assert C.token_kind("github_pat_x") == "fine-grained"
    assert C.token_kind("ghp_x") == "classic"
    assert C.token_kind("xyz") == "token"


# ── the token never comes out ─────────────────────────────────────────────

def test_the_token_is_in_no_error_repr_log_or_traceback(caplog):
    """GitHub never echoes a token -- but if anything ever did, it must be
    scrubbed on the way out. So this server does, on every error path."""
    caplog.set_level(logging.DEBUG)
    evil = {"message": f"leaked {TOKEN} here"}
    outs = []
    for status in (401, 403, 404, 422, 500, 400):
        srv = Server().on("/user", lambda r, s=status: httpx.Response(s, json=evil))
        try:
            _gh(srv).get("/user")
        except C.GitHubError as e:
            outs += [str(e), e.message, json.dumps(e.to_dict()),
                     "".join(traceback.format_exception(e))]

    def boom(r):
        raise httpx.ConnectError(f"cannot connect {TOKEN}", request=r)
    try:
        C.GitHub(TOKEN, transport=httpx.MockTransport(boom)).get("/user")
    except C.GitHubError as e:
        outs += [str(e), "".join(traceback.format_exception(e))]
    gh = _gh(Server())
    outs += [repr(gh), str(gh.rate()), json.dumps(C.RATE), str(list(C._CACHE.items())),
             caplog.text]
    blob = "\n".join(outs)
    assert len(outs) >= 20
    assert TOKEN not in blob
    assert TOKEN[11:30] not in blob         # no fragment either


# ── the account store ─────────────────────────────────────────────────────

class FakeKeyring:
    def __init__(self):
        self.store = {}

    def set_password(self, service, user, pw):
        self.store[(service, user)] = pw

    def get_password(self, service, user):
        return self.store.get((service, user))

    def delete_password(self, service, user):
        if (service, user) not in self.store:
            raise KeyError("PasswordDeleteError")
        del self.store[(service, user)]


@pytest.fixture
def store(tmp_path, monkeypatch):
    kr = FakeKeyring()
    monkeypatch.setattr(A, "_keyring", lambda: kr)
    monkeypatch.setattr(A, "_profile", lambda: "tony")
    monkeypatch.setattr(A, "_meta_file", lambda: tmp_path / "accounts.json")
    return kr


def _user_srv(login="Octo-Cat", status=200, scopes="repo"):
    return Server().on("/user", lambda r: httpx.Response(
        status, json={"login": login, "name": "Octo", "avatar_url": "https://a/x"}
        if status == 200 else {"message": "Bad credentials"},
        headers={"x-oauth-scopes": scopes,
                 "github-authentication-token-expiration": "2026-12-01 00:00:00 UTC", **_rate()}))


def test_add_verifies_then_stores_under_the_login_github_names(store):
    srv = _user_srv()
    acct = A.add(f"  {TOKEN}\n", transport=srv.transport)
    assert srv.seen[0].headers["Authorization"] == f"Bearer {TOKEN}"
    assert acct["login"] == "octo-cat"
    assert acct["kind"] == "fine-grained" and acct["scopes"] == ["repo"]
    assert acct["expires"].startswith("2026-12-01") and acct["stored"] is True
    assert store.store == {("magi-github:tony:octo-cat", "octo-cat"): TOKEN}
    assert A.token("octo-cat") == TOKEN


def test_adding_shows_the_hourly_limit_straight_away(store):
    A.add(TOKEN, transport=_user_srv().transport)
    assert A.list_accounts()[0]["rate"]["remaining"] == 4999
    assert "verifying" not in C.RATE


def test_a_rejected_token_is_never_stored(store):
    with pytest.raises(A.AccountError) as e:
        A.add(TOKEN, transport=_user_srv(status=401).transport)
    assert e.value.code == "bad_token"
    assert store.store == {} and A.list_accounts() == []


@pytest.mark.parametrize("bad", ["", "short", "has space in it 0123456789", "x" * 300, "ghp_ü" * 5])
def test_malformed_tokens_are_refused_before_any_request(store, bad):
    srv = _user_srv()
    with pytest.raises(A.AccountError):
        A.add(bad, transport=srv.transport)
    assert srv.seen == []


def test_list_and_files_never_contain_the_token(store, tmp_path):
    A.add(TOKEN, transport=_user_srv().transport)
    rows = A.list_accounts()
    assert [r["login"] for r in rows] == ["octo-cat"]
    assert TOKEN not in json.dumps(rows)
    assert TOKEN not in (tmp_path / "accounts.json").read_text()
    assert "token" not in rows[0]


def test_adding_the_same_login_again_replaces_the_token(store):
    A.add(TOKEN, transport=_user_srv().transport)
    added = A.list_accounts()[0]["added"]
    other = "github_pat_OTHER0123456789abcdefOTHER"
    A.add(other, transport=_user_srv().transport)
    assert len(A.list_accounts()) == 1
    assert A.token("octo-cat") == other
    assert A.list_accounts()[0]["added"] == added


def test_remove_deletes_the_credential_and_the_record(store):
    A.add(TOKEN, transport=_user_srv().transport)
    assert A.remove("Octo-Cat") is True
    assert store.store == {} and A.list_accounts() == []
    with pytest.raises(A.AccountError):
        A.client("octo-cat")
    assert A.remove("octo-cat") is False


def test_a_token_deleted_outside_magi_shows_as_not_stored(store):
    A.add(TOKEN, transport=_user_srv().transport)
    store.store.clear()
    assert A.list_accounts()[0]["stored"] is False


def test_profiles_have_separate_credentials(store, monkeypatch):
    A.add(TOKEN, transport=_user_srv().transport)
    monkeypatch.setattr(A, "_profile", lambda: "veda")
    assert A.service("octo-cat") == "magi-github:veda:octo-cat"
    assert A.token("octo-cat") is None


def test_repos_lists_what_the_token_can_see_without_the_token(store):
    A.add(TOKEN, transport=_user_srv().transport)
    srv = Server().on("/user/repos", lambda r: httpx.Response(200, json=[
        {"full_name": "octo/a", "private": True, "default_branch": "main",
         "permissions": {"push": True}, "pushed_at": "2026-09-01", "html_url": "https://github.com/octo/a"},
        {"full_name": "org/b", "private": False, "default_branch": "dev",
         "permissions": {"push": False}},
    ], headers={"etag": '"r"', **_rate(4990)}))
    d = A.repos("octo-cat", transport=srv.transport)
    assert [(r["full_name"], r["role_push"]) for r in d["repos"]] == [("octo/a", True), ("org/b", False)]
    assert all("push" not in r for r in d["repos"]), "the owner's role must not read as the token's permission"
    assert d["rate"]["remaining"] == 4990
    assert srv.seen[0].url.params["sort"] == "pushed"
    assert TOKEN not in json.dumps(d)


def test_repo_errors_come_back_as_account_errors(store):
    A.add(TOKEN, transport=_user_srv().transport)
    with pytest.raises(A.AccountError) as e:
        A.repo("octo-cat", "o", "private", transport=Server().transport)
    assert e.value.code == "not_found"


# ── askpass ───────────────────────────────────────────────────────────────

ENV = {"MAGI_GH_SERVICE": "magi-github:tony:octo", "MAGI_GH_LOGIN": "octo",
       "MAGI_GH_HOST": "github.com"}


@pytest.fixture
def kr(monkeypatch):
    import keyring
    asked = []

    def get(service, user):
        asked.append((service, user))
        return TOKEN if (service, user) == ("magi-github:tony:octo", "octo") else None
    monkeypatch.setattr(keyring, "get_password", get)
    return asked


def test_askpass_answers_username_and_password_for_its_host(kr):
    assert askpass.answer("Username for 'https://github.com': ", ENV) == "octo"
    assert askpass.answer("Password for 'https://octo@github.com': ", ENV) == TOKEN
    assert kr == [("magi-github:tony:octo", "octo")]


@pytest.mark.parametrize("prompt", [
    "Password for 'https://octo@evil.example': ",
    "Password for 'https://octo@github.com.evil.example': ",
    "Password for 'http://octo@github.com': ",            # plain http to a real host
    "Password for 'https://github.com@evil.example': ",   # the host hidden as a user
    "Password for 'https://github.com:8443': ",           # another port is another server
    "Password for 'https://evil.example/github.com': ",
    "Password for 'https://localhost': ",                 # loopback is not the account's host
    "Enter passphrase for key '/c/Users/x/.ssh/id_ed25519': ",
    "",
])
def test_askpass_says_nothing_to_anything_else(kr, prompt):
    assert askpass.answer(prompt, ENV) is None
    assert kr == []


def test_askpass_without_its_environment_says_nothing(kr):
    assert askpass.answer("Password for 'https://octo@github.com': ", {}) is None
    assert kr == []


# ── the HTTP surface (handlers called directly, as in test_gate) ─────────

def test_routes_take_the_token_in_and_never_give_it_back(store, monkeypatch):
    import asyncio
    from magi.code import routes as R
    real_add = A.add
    monkeypatch.setattr(A, "add", lambda tok: real_add(tok, transport=_user_srv().transport))
    outs = [asyncio.run(R.gh_add_account({"token": TOKEN})),
            asyncio.run(R.gh_accounts())]
    assert outs[0]["ok"] and outs[0]["account"]["login"] == "octo-cat"
    assert [a["login"] for a in outs[1]["accounts"]] == ["octo-cat"]
    assert outs[1]["api_version"] == C.API_VERSION
    monkeypatch.setattr(A, "repos", lambda login: {"repos": [], "cached": True, "rate": {}})
    outs.append(asyncio.run(R.gh_repos("octo-cat")))
    outs.append(asyncio.run(R.gh_remove_account("octo-cat")))
    assert outs[-1] == {"ok": True, "removed": True}
    assert TOKEN not in json.dumps(outs)
    assert store.store == {}


def test_a_bad_token_through_the_route_is_a_sentence(store, monkeypatch):
    import asyncio
    from magi.code import routes as R
    real_add = A.add
    monkeypatch.setattr(A, "add", lambda tok: real_add(tok, transport=_user_srv(status=401).transport))
    d = asyncio.run(R.gh_add_account({"token": TOKEN}))
    assert d == {"ok": False, "error": "bad_token", "message": d["message"]}
    assert "expired" in d["message"] and TOKEN not in json.dumps(d)


def test_magis_own_repository_is_never_pushed(monkeypatch, tmp_path):
    import asyncio
    from magi.code import routes as R
    from magi.code import sandbox as SB

    async def here(pid):
        return {"name": "A1", "prefs": {"github": "octo"}}, tmp_path, None
    monkeypatch.setattr(R, "_project_here", here)
    monkeypatch.setattr(SB, "is_engine_repo", lambda root: True)
    called = []
    monkeypatch.setattr("magi.code.git.push", lambda *a: called.append(a))
    d = asyncio.run(R.push_project("p", {}))
    assert d["error"] == "read_only_project" and called == []
