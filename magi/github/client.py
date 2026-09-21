"""The GitHub REST client.

Small on purpose: GET-shaped reads with the four things that make polling
GitHub cheap and failures legible.

* **The API version is pinned.** `X-GitHub-Api-Version` on every request --
  leaving it off silently pins you to 2022-11-28, and a response shape
  changing under you is a bug nobody can reproduce.
* **Conditional requests.** Each response's ETag is remembered and sent back
  as `If-None-Match`; an unchanged answer comes back 304 with no body and,
  authenticated, does not count against the 5,000/hour limit. So asking
  "what repositories can I see?" every time Accounts opens is nearly free.
* **Rate limits are a kind of failure, not a surprise.** Every response's
  `x-ratelimit-*` headers are recorded per account, and running out raises a
  `GitHubError` that says when it resets.
* **The token never leaves this object.** Not in an error, a log line, a
  repr or a response. Errors are built from GitHub's own message and scrubbed
  of the token anyway, and transport exceptions are re-raised without their
  chain so nothing further down can print a request header.
"""

from __future__ import annotations

import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

import httpx

API = "https://api.github.com"
API_VERSION = "2026-03-10"
TIMEOUT = 15.0
MAX_PAGES = 10
_CACHE_MAX = 400


class Kind(StrEnum):
    BAD_TOKEN = "bad_token"          # 401: expired, revoked, mistyped
    FORBIDDEN = "forbidden"          # 403 that is not a rate limit: missing permission
    NOT_FOUND = "not_found"          # 404: absent, or invisible to this token
    RATE_LIMITED = "rate_limited"    # primary or secondary limit
    INVALID = "invalid"              # 422
    BAD_VERSION = "bad_version"      # the pinned API version was refused
    UNAVAILABLE = "unavailable"      # 5xx
    NETWORK = "network"              # never reached GitHub
    UNKNOWN = "unknown"


class GitHubError(Exception):
    def __init__(self, kind: Kind, message: str, *, status: int = 0,
                 reset_at: float | None = None):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.status = status
        self.reset_at = reset_at

    def to_dict(self) -> dict[str, Any]:
        return {"ok": False, "error": str(self.kind), "message": self.message,
                **({"reset_at": self.reset_at} if self.reset_at else {})}


@dataclass
class Response:
    data: Any
    status: int
    cached: bool = False             # True when GitHub said 304 and this is the remembered body
    etag: str = ""
    headers: dict[str, str] = field(default_factory=dict)


# ── shared state: ETags and rate limits, per account ─────────────────────

_LOCK = threading.Lock()
_CACHE: "OrderedDict[tuple[str, str], tuple[str, Any, str]]" = OrderedDict()
RATE: dict[str, dict[str, Any]] = {}


def _cache_get(key: tuple[str, str]):
    with _LOCK:
        hit = _CACHE.get(key)
        if hit is not None:
            _CACHE.move_to_end(key)
        return hit


def _cache_put(key: tuple[str, str], etag: str, data: Any, nxt: str) -> None:
    with _LOCK:
        _CACHE[key] = (etag, data, nxt)
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)


def forget(account: str) -> None:
    """Drop everything remembered for one account (it was removed)."""
    with _LOCK:
        for k in [k for k in _CACHE if k[0] == account]:
            del _CACHE[k]
        RATE.pop(account, None)


def _next_link(link: str) -> str:
    """The rel="next" URL from a Link header, or ""."""
    for part in (link or "").split(","):
        m = re.match(r'\s*<([^>]+)>\s*;\s*(.*)', part)
        if m and re.search(r'\brel="?next"?', m.group(2)):
            return m.group(1)
    return ""


def _int(v: str | None) -> int | None:
    try:
        return int(v) if v is not None else None
    except ValueError:
        return None


class GitHub:
    """One account's view of GitHub. `account` names it in the caches; the
    token is held privately and is never part of any output."""

    __slots__ = ("_token", "account", "base", "_transport", "timeout")

    def __init__(self, token: str, *, account: str = "", base: str = API,
                 transport: httpx.BaseTransport | None = None, timeout: float = TIMEOUT):
        self._token = token
        self.account = account or "anonymous"
        self.base = base.rstrip("/")
        self._transport = transport
        self.timeout = timeout

    def __repr__(self) -> str:
        return f"GitHub(account={self.account!r}, token=***)"

    # ── plumbing ──────────────────────────────────────────────────────────

    def _scrub(self, text: str) -> str:
        return text.replace(self._token, "***") if self._token else text

    def _headers(self, etag: str = "") -> dict[str, str]:
        h = {"Accept": "application/vnd.github+json",
             "X-GitHub-Api-Version": API_VERSION,
             "User-Agent": "MAGI-Code-Mode",
             "Authorization": f"Bearer {self._token}"}
        if etag:
            h["If-None-Match"] = etag
        return h

    def _record_rate(self, r: httpx.Response) -> None:
        lim = _int(r.headers.get("x-ratelimit-limit"))
        if lim is None:
            return
        RATE[self.account] = {
            "limit": lim,
            "remaining": _int(r.headers.get("x-ratelimit-remaining")),
            "used": _int(r.headers.get("x-ratelimit-used")),
            "reset": _int(r.headers.get("x-ratelimit-reset")),
            "resource": r.headers.get("x-ratelimit-resource", "core"),
            "at": time.time(),
        }

    def _fail(self, r: httpx.Response) -> GitHubError:
        try:
            body = r.json()
        except ValueError:
            body = {}
        msg = self._scrub(str((body or {}).get("message") or r.reason_phrase or "")).strip()
        st = r.status_code
        remaining = r.headers.get("x-ratelimit-remaining")
        retry = _int(r.headers.get("retry-after"))
        if st in (403, 429) and (remaining == "0" or retry is not None
                                 or "rate limit" in msg.lower()):
            reset = (time.time() + retry) if retry is not None else _int(r.headers.get("x-ratelimit-reset"))
            when = time.strftime("%H:%M", time.localtime(reset)) if reset else "later"
            return GitHubError(Kind.RATE_LIMITED,
                               f"GitHub's rate limit for this account is used up; it resets at {when}.",
                               status=st, reset_at=float(reset) if reset else None)
        if st == 401:
            return GitHubError(Kind.BAD_TOKEN, "GitHub did not accept this token. It may have "
                               "expired or been revoked; add a new one.", status=st)
        if st == 403:
            return GitHubError(Kind.FORBIDDEN, "This token is not allowed to do that"
                               + (f" ({msg})" if msg else "") + ". Check its permissions on GitHub.",
                               status=st)
        if st == 404:
            return GitHubError(Kind.NOT_FOUND, "Not found on GitHub — or this token cannot see it "
                               "(a fine-grained token only sees the repositories you picked for it).",
                               status=st)
        if st == 400 and "version" in msg.lower():
            return GitHubError(Kind.BAD_VERSION, f"GitHub refused API version {API_VERSION}: {msg}",
                               status=st)
        if st == 422:
            return GitHubError(Kind.INVALID, f"GitHub refused the request: {msg or 'invalid'}.",
                               status=st)
        if st >= 500:
            return GitHubError(Kind.UNAVAILABLE, f"GitHub is having trouble ({st}); try again shortly.",
                               status=st)
        return GitHubError(Kind.UNKNOWN, f"GitHub answered {st}" + (f": {msg}" if msg else "."),
                           status=st)

    # ── requests ──────────────────────────────────────────────────────────

    def _url(self, path: str) -> str:
        if path.startswith(("http://", "https://")):
            # Only ever the pagination links GitHub itself returned, which
            # point back at the same host. Anything else would be a request
            # carrying the token somewhere it was not issued for.
            if not path.startswith(self.base + "/"):
                raise GitHubError(Kind.UNKNOWN, "Refusing to send the token to another host.")
            return path
        return self.base + "/" + path.lstrip("/")

    def get(self, path: str, params: dict[str, Any] | None = None) -> Response:
        url = self._url(path)
        if params:
            url = str(httpx.URL(url, params=params))
        key = (self.account, url)
        hit = _cache_get(key)
        try:
            with httpx.Client(transport=self._transport, timeout=self.timeout,
                              follow_redirects=False) as c:
                r = c.get(url, headers=self._headers(hit[0] if hit else ""))
        except httpx.HTTPError as e:
            # `from None`: the chained exception holds the request, and the
            # request holds the Authorization header.
            raise GitHubError(Kind.NETWORK, "Could not reach GitHub: "
                              + self._scrub(type(e).__name__)) from None
        self._record_rate(r)
        if r.status_code == 304 and hit:
            return Response(hit[1], 304, cached=True, etag=hit[0],
                            headers={"link-next": hit[2]})
        if r.status_code >= 300:
            raise self._fail(r)
        try:
            data = r.json()
        except ValueError:
            raise GitHubError(Kind.UNKNOWN, "GitHub sent something that is not JSON.",
                              status=r.status_code) from None
        etag = r.headers.get("etag", "")
        nxt = _next_link(r.headers.get("link", ""))
        if etag:
            _cache_put(key, etag, data, nxt)
        return Response(data, r.status_code, etag=etag,
                        headers={"link-next": nxt,
                                 "x-oauth-scopes": r.headers.get("x-oauth-scopes", ""),
                                 "token-expires": r.headers.get(
                                     "github-authentication-token-expiration", "")})

    def paginate(self, path: str, params: dict[str, Any] | None = None,
                 max_pages: int = MAX_PAGES) -> tuple[list[Any], bool]:
        """Every item across `Link: rel="next"` pages. Returns (items, all_cached)
        -- the second is True when every page came back 304."""
        items: list[Any] = []
        cached = True
        url: str = path
        p = {"per_page": 100, **(params or {})}
        for _ in range(max_pages):
            r = self.get(url, p)
            cached = cached and r.cached
            items.extend(r.data if isinstance(r.data, list) else [])
            url = r.headers.get("link-next", "")
            p = None            # the next link already carries the query
            if not url:
                break
        return items, cached

    def rate(self) -> dict[str, Any]:
        return dict(RATE.get(self.account) or {})


def scopes(header: str) -> list[str]:
    """`X-OAuth-Scopes: repo, read:org` -> ["read:org", "repo"]. Classic
    tokens send it; fine-grained ones do not (their permissions are per
    repository and only GitHub's settings page lists them)."""
    return sorted({s.strip() for s in (header or "").split(",") if s.strip()})


def token_kind(token: str) -> str:
    for prefix, kind in (("github_pat_", "fine-grained"), ("ghp_", "classic"),
                         ("gho_", "oauth"), ("ghu_", "app-user")):
        if token.startswith(prefix):
            return kind
    return "token"
