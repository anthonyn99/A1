"""Sign in with GitHub: the OAuth device flow.

Instead of minting a token by hand -- and minting another every time a new
repository should be reachable -- the console shows a short code, you enter
it at github.com/login/device on any device and approve, and the engine
receives an OAuth token for your account. That token carries the `repo`
scope, so it reaches every repository the account can reach, including
ones created later: adding a repository to MAGI needs no new token.

The token then goes through exactly the path a pasted one does
(accounts.add): verified with GET /user, kept in the credential store under
the login GitHub names, never in a response. The device code itself also
never leaves the engine -- the console sees only the short user code.

GitHub issues device-flow tokens to a registered OAuth App. The app's client
ID is public (it is not a secret; the device flow uses no client secret),
and is read from, in order: the machine-wide file data/github_oauth.json
(written from the console's setup screen, for an override), then
DEFAULT_CLIENT_ID -- MAGI's own app, built in. One app
serves every profile: Tony and Veda each approve it for their own account.
"""

from __future__ import annotations

import json
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from . import accounts as A

# The MAGI OAuth App (registered by anthonyn99, Device Flow on, tokens do not
# expire). Public by design: the device flow has no client secret. Built in
# so every engine -- either profile, any PC -- signs in with no setup step.
DEFAULT_CLIENT_ID = "Ov23liVKFZMeim6yDJm5"

SCOPES = "repo workflow"
DEVICE_URL = "https://github.com/login/device/code"
TOKEN_URL = "https://github.com/login/oauth/access_token"
GRANT = "urn:ietf:params:oauth:grant-type:device_code"
_CLIENT_ID = re.compile(r"^[A-Za-z0-9.]{16,40}$")
MIN_INTERVAL = 5                  # GitHub's floor; tests lower it

# Tests swap this for an httpx.MockTransport.
_transport: httpx.BaseTransport | None = None


def _file() -> Path:
    from ..settings import ROOT
    d = ROOT / "data"
    d.mkdir(parents=True, exist_ok=True)
    return d / "github_oauth.json"


def client_id() -> str:
    try:
        v = str(json.loads(_file().read_text("utf-8")).get("client_id") or "")
        if _CLIENT_ID.match(v):
            return v
    except (OSError, ValueError, AttributeError):
        pass
    return DEFAULT_CLIENT_ID


def set_client_id(raw: str) -> str:
    v = (raw or "").strip()
    if not _CLIENT_ID.match(v):
        raise A.AccountError("bad_client_id", "That is not an OAuth App client ID "
                             "(it looks like Ov23li… or 20 hex characters).")
    f = _file()
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps({"client_id": v}), "utf-8")
    tmp.replace(f)
    return v


def _post(url: str, data: dict[str, str]) -> dict[str, Any]:
    try:
        with httpx.Client(transport=_transport, timeout=20) as c:
            r = c.post(url, data=data, headers={"Accept": "application/json"})
    except httpx.HTTPError as e:
        raise A.AccountError("network", f"Could not reach GitHub ({type(e).__name__}).") from None
    try:
        d = r.json()
    except ValueError:
        d = {}
    if not isinstance(d, dict):
        d = {}
    if r.status_code >= 400 and "error" not in d:
        d["error"] = f"http_{r.status_code}"
    return d


_WHY = {
    "device_flow_disabled": "Device Flow is off for the MAGI app on GitHub: open the app's "
                            "settings, tick “Enable Device Flow”, and save.",
    "incorrect_client_credentials": "GitHub does not know that client ID. Check it in the "
                                    "OAuth App's settings.",
    "unauthorized_client": "That app cannot use the device flow.",
}


@dataclass
class Flow:
    id: str
    user_code: str
    uri: str
    expires_at: float
    interval: int
    state: str = "pending"            # pending | done | expired | denied | error | cancelled
    account: str = ""
    message: str = ""
    _device: str = field(default="", repr=False)
    _stop: threading.Event = field(default_factory=threading.Event, repr=False)

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "user_code": self.user_code, "verification_uri": self.uri,
                "expires_at": self.expires_at, "state": self.state,
                "account": self.account, "message": self.message}


_LOCK = threading.Lock()
_FLOWS: dict[str, Flow] = {}


def start() -> dict[str, Any]:
    """Ask GitHub for a code and begin waiting for approval in the background.
    One flow at a time per engine: a new one cancels the last."""
    cid = client_id()
    if not cid:
        raise A.AccountError("no_client_id", "MAGI is not registered with GitHub on this PC yet.")
    d = _post(DEVICE_URL, {"client_id": cid, "scope": SCOPES})
    if d.get("error") or not d.get("device_code"):
        err = str(d.get("error") or "no_code")
        raise A.AccountError(err, _WHY.get(err) or str(d.get("error_description")
                             or "GitHub did not hand out a code."))
    f = Flow(id=secrets.token_hex(8), user_code=str(d.get("user_code") or ""),
             uri=str(d.get("verification_uri") or "https://github.com/login/device"),
             expires_at=time.time() + int(d.get("expires_in") or 900),
             interval=max(MIN_INTERVAL, int(d.get("interval", 5))), _device=str(d["device_code"]))
    with _LOCK:
        for old in _FLOWS.values():
            if old.state == "pending":
                old.state = "cancelled"
                old._stop.set()
        _FLOWS.clear()
        _FLOWS[f.id] = f
    threading.Thread(target=_wait, args=(f, cid), name="gh-device", daemon=True).start()
    return f.public()


def _wait(f: Flow, cid: str) -> None:
    try:
        while not f._stop.is_set():
            if time.time() > f.expires_at:
                f.state, f.message = "expired", "The code expired. Start again."
                return
            if f._stop.wait(f.interval):
                return
            try:
                d = _post(TOKEN_URL, {"client_id": cid, "device_code": f._device, "grant_type": GRANT})
            except A.AccountError:
                continue                   # a network blip: keep waiting until expiry
            err = d.get("error")
            if err == "authorization_pending":
                continue
            if err == "slow_down":
                f.interval = int(d.get("interval") or f.interval + 5)
                continue
            if err == "expired_token":
                f.state, f.message = "expired", "The code expired. Start again."
                return
            if err == "access_denied":
                f.state, f.message = "denied", "Cancelled on GitHub."
                return
            if err or not d.get("access_token"):
                f.state = "error"
                f.message = _WHY.get(str(err)) or str(d.get("error_description") or err or "No token.")
                return
            tok = str(d["access_token"])
            try:
                acct = A.add(tok)
            except A.AccountError as e:
                f.state, f.message = "error", e.message
                return
            finally:
                tok = ""
                d.clear()
            f.account = str(acct.get("login") or "")
            f.state = "done"
            return
    finally:
        f._device = ""


def status(fid: str) -> dict[str, Any] | None:
    with _LOCK:
        f = _FLOWS.get(fid)
    return f.public() if f else None


def cancel(fid: str) -> bool:
    with _LOCK:
        f = _FLOWS.get(fid)
    if not f or f.state != "pending":
        return False
    f.state = "cancelled"
    f._stop.set()
    return True
