"""Which GitHub accounts MAGI holds a token for, per profile.

The token goes into the operating system's credential store through
`keyring` (Windows Credential Manager on the engine PC), under

    service  magi-github:<profile>:<login>
    user     <login>

and nowhere else: not in SQLite, not in a settings file, not in Firestore,
not in any response. What IS kept in the profile's data folder is the public
half -- login, name, token kind, scopes, when it expires -- so the list can
be drawn without touching a secret.

Adding an account verifies the token first (`GET /user`) and stores it under
the login GitHub says it belongs to, so a mistyped token is refused before
it is saved, and two tokens for the same login are one account (the newer
replaces the older).
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from . import client as C

_TOKEN = re.compile(r"^[A-Za-z0-9_]{20,255}$")
_LOGIN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")


class AccountError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _keyring():
    # Imported late: a machine without a credential store still runs every
    # other part of MAGI, and says so here rather than failing at startup.
    try:
        import keyring
        return keyring
    except ImportError:
        raise AccountError("no_keyring", "The credential store module (keyring) is not "
                           "installed on the engine machine: pip install keyring.") from None


def _profile() -> str:
    from ..settings import active_profile
    return active_profile()


def service(login: str, profile: str | None = None) -> str:
    return f"magi-github:{profile or _profile()}:{login.lower()}"


def _meta_file() -> Path:
    from ..settings import data_dir
    d = data_dir() / "github"
    d.mkdir(parents=True, exist_ok=True)
    return d / "accounts.json"


def _load() -> dict[str, dict[str, Any]]:
    try:
        d = json.loads(_meta_file().read_text("utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(meta: dict[str, dict[str, Any]]) -> None:
    f = _meta_file()
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(meta, indent=1, sort_keys=True), "utf-8")
    tmp.replace(f)


def check_login(login: str) -> str:
    s = (login or "").strip()
    if not _LOGIN.match(s):
        raise AccountError("bad_login", "That is not a GitHub login.")
    return s.lower()


def list_accounts() -> list[dict[str, Any]]:
    """The public half of every account, oldest first. No tokens -- and each
    says whether its token is still in the credential store, because someone
    can delete it there by hand."""
    kr = None
    try:
        kr = _keyring()
    except AccountError:
        pass
    out = []
    for login, m in sorted(_load().items(), key=lambda kv: kv[1].get("added", 0)):
        row = {k: m.get(k) for k in ("login", "name", "avatar", "kind", "scopes",
                                     "expires", "added", "verified")}
        row["stored"] = bool(kr and kr.get_password(service(login), login))
        rate = C.RATE.get(login)
        if rate:
            row["rate"] = rate
        out.append(row)
    return out


def get(login: str) -> dict[str, Any] | None:
    return next((a for a in list_accounts() if a["login"] == login.lower()), None)


def token(login: str) -> str | None:
    """For this package and git.push only. Never put this in a response."""
    login = check_login(login)
    return _keyring().get_password(service(login), login)


def client(login: str, *, transport=None) -> C.GitHub:
    t = token(login)
    if not t:
        raise AccountError("no_token", f"MAGI has no token for {login} any more. Add it again "
                           "in Accounts.")
    return C.GitHub(t, account=login.lower(), transport=transport)


def add(raw_token: str, *, transport=None) -> dict[str, Any]:
    """Verify a token with GitHub, then store it under the login it belongs to."""
    tok = (raw_token or "").strip()
    if not _TOKEN.match(tok):
        raise AccountError("bad_token", "That does not look like a GitHub token. Paste the "
                           "whole token (it starts with github_pat_ or ghp_).")
    gh = C.GitHub(tok, account="verifying", transport=transport)
    try:
        r = gh.get("/user")
    except C.GitHubError as e:
        raise AccountError(str(e.kind), e.message) from None
    finally:
        C.forget("verifying")
    u = r.data if isinstance(r.data, dict) else {}
    login = check_login(str(u.get("login") or ""))
    kr = _keyring()
    try:
        kr.set_password(service(login), login, tok)
    except Exception as e:  # noqa: BLE001 -- keyring backends raise their own types
        raise AccountError("store_failed", "The credential store refused the token "
                           f"({type(e).__name__}).") from None
    meta = _load()
    now = time.time()
    meta[login] = {
        "login": login,
        "name": str(u.get("name") or "")[:100],
        "avatar": str(u.get("avatar_url") or "")[:300],
        "kind": C.token_kind(tok),
        "scopes": C.scopes(r.headers.get("x-oauth-scopes", "")),
        "expires": r.headers.get("token-expires", "")[:40],
        "added": (meta.get(login) or {}).get("added", now),
        "verified": now,
    }
    _save(meta)
    return get(login) or {}


def remove(login: str) -> bool:
    """Delete the stored token and the account's public record."""
    login = check_login(login)
    meta = _load()
    had = login in meta
    meta.pop(login, None)
    _save(meta)
    try:
        _keyring().delete_password(service(login), login)
        had = True
    except AccountError:
        raise
    except Exception:  # noqa: BLE001 -- PasswordDeleteError: nothing was stored
        pass
    C.forget(login)
    return had


def repos(login: str, *, transport=None) -> dict[str, Any]:
    """Every repository this account's token can see, newest push first.

    Conditional: with nothing changed on GitHub, every page is a 304 and the
    whole list costs none of the hourly limit.
    """
    gh = client(login, transport=transport)
    try:
        items, cached = gh.paginate("/user/repos", {"sort": "pushed", "affiliation":
                                                    "owner,collaborator,organization_member"})
    except C.GitHubError as e:
        raise AccountError(str(e.kind), e.message) from None
    rows = [{
        "full_name": r.get("full_name", ""),
        "private": bool(r.get("private")),
        "default_branch": r.get("default_branch", ""),
        "push": bool((r.get("permissions") or {}).get("push")),
        "pushed_at": r.get("pushed_at") or "",
        "url": r.get("html_url", ""),
    } for r in items if isinstance(r, dict)]
    return {"repos": rows, "cached": cached, "rate": gh.rate()}


def repo(login: str, owner: str, name: str, *, transport=None) -> dict[str, Any]:
    """One repository, and what this token may do to it."""
    gh = client(login, transport=transport)
    try:
        r = gh.get(f"/repos/{owner}/{name}")
    except C.GitHubError as e:
        raise AccountError(str(e.kind), e.message) from None
    d = r.data if isinstance(r.data, dict) else {}
    return {"full_name": d.get("full_name", f"{owner}/{name}"),
            "private": bool(d.get("private")),
            "default_branch": d.get("default_branch", ""),
            "push": bool((d.get("permissions") or {}).get("push")),
            "url": d.get("html_url", "")}
