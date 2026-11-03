"""Take this machine from a fresh clone to a working engine, in one command.

    magi onboard --profile veda

Everything that can be done without a human is done here: directories, a
strong API token, a free port, a stable engine identity, and the scheduled
tasks that start it at logon. What is left is the part only a person can do --
signing in to each site, and typing the token into the console once.

**It is built and proven on Tony's PC against the `veda` profile**, months
before Veda's machine exists. A second engine that only exists in theory until
someone carries a laptop into the room is a second engine that does not work:
every path this takes is exercised here first, so the real thing is an install
rather than a debugging session.

Idempotent. Re-running repairs whatever is missing and leaves the rest alone --
in particular it never regenerates a token that already works, because that
would silently orphan every device already paired with it.
"""

from __future__ import annotations

import json
import os
import secrets
import socket

from .. import ident, proc
from ..settings import ROOT, active_profile, data_dir, profiles_dir

# Tony's engine is on 8000 and always has been. A second profile needs its own,
# because two engines cannot share a port and the whole point is running both.
BASE_PORT = 8000
PROFILE_PORTS = {"tony": 8000, "veda": 8001}


def _say(msg: str = "") -> None:
    print(f"  {msg}" if msg else "")


def _port_free(port: int) -> bool:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _ours(port: int) -> bool:
    """Is the thing already on this port THIS profile's engine?

    A busy port is only a conflict if somebody else is on it. Onboarding Tony
    while Tony's engine is running -- which is the common case, since this is
    also the repair command -- must not shunt him onto a new port and strand
    every device paired with the old one. So ask: /api/health names the profile.
    """
    import json as _json
    import urllib.request

    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/health", timeout=1.5
        ) as r:
            return _json.loads(r.read()).get("profile") == active_profile()
    except Exception:
        return False


def _pick_port(requested: int) -> int:
    """The asked-for port, else this profile's usual one, else the next free."""
    if requested:
        return requested
    usable = lambda p: _port_free(p) or _ours(p)  # noqa: E731
    # The port this profile already owns (re-running onboard must not move a
    # paired engine), then 8000 -- the port every console, script and doc
    # assumes, so the engine on a PC of its own (Veda's) is set up exactly
    # like Tony's -- and only on a PC already running another engine, the
    # profile's own spare (veda: 8001).
    owned = _owned_port()
    if owned and usable(owned):
        return owned
    if usable(BASE_PORT):
        return BASE_PORT
    preferred = PROFILE_PORTS.get(active_profile(), 0)
    if preferred and (usable(preferred) or owned == preferred):
        return preferred
    for p in range(BASE_PORT, BASE_PORT + 40):
        if _port_free(p) or _ours(p):
            return p
    return BASE_PORT


def _owned_port() -> int:
    """The port this profile was onboarded on, if it ever was."""
    rec = ident.engine_identity()
    try:
        return int(rec.get("port") or 0)
    except Exception:
        return 0


def _token_env_name() -> str:
    """Tony's token stays in MAGI_API_TOKEN; another profile gets its own.

    They MUST differ. magi-link keys its records by the hash of the token, so
    two engines sharing one would fight over a single record -- and, worse, a
    shared token would let either person's console reach the other's engine and
    its signed-in accounts.
    """
    p = active_profile()
    return "MAGI_API_TOKEN" if p == "tony" else f"MAGI_API_TOKEN_{p.upper()}"


def _existing_token() -> str:
    return os.environ.get(_token_env_name(), "").strip()


def _set_token(value: str) -> bool:
    """setx, so it survives a reboot. Takes effect in NEW terminals only."""
    try:
        r = proc.run(["setx", _token_env_name(), value], capture_output=True)
        return r.returncode == 0
    except Exception:
        return False


def run(port: int = 0, label: str | None = None, autostart: bool = True) -> int:
    profile = active_profile()
    _say()
    _say(f"Setting up the {profile} engine on this machine.")
    _say()

    if os.name != "nt":
        _say("MAGI's engine is Windows-only (off-screen windows use Win32).")
        return 1

    # ── 1. directories ────────────────────────────────────────────────────
    # Touching them is enough: each helper creates what it names.
    d, p = data_dir(), profiles_dir()
    _say(f"data      {d}")
    _say(f"profiles  {p}")

    # ── 2. identity ───────────────────────────────────────────────────────
    rec = ident.engine_identity()
    if label:
        rec = ident.set_engine_label(label)
    chosen = _pick_port(port)
    if rec.get("port") != chosen:
        rec["port"] = chosen
        try:
            (d / "engine.json").write_text(json.dumps(rec, indent=1), encoding="utf-8")
        except Exception as exc:
            _say(f"could not record the engine identity: {exc}")
            return 1
    _say(f"engine    {rec['id']}  \"{rec['label']}\"  port {chosen}")

    # ── 3. the API token ──────────────────────────────────────────────────
    tok = _existing_token()
    if tok:
        _say(f"token     already set in {_token_env_name()} ({len(tok)} chars)")
    else:
        tok = secrets.token_urlsafe(32)
        if _set_token(tok):
            _say(f"token     generated and stored in {_token_env_name()}")
            _say("          (open a NEW terminal before starting the engine)")
        else:
            _say(f"token     could not run setx; set {_token_env_name()} by hand:")
            _say(f"          setx {_token_env_name()} \"{tok}\"")

    # ── 4. Playwright's Chromium ──────────────────────────────────────────
    # Installed even though config runs `channel: chrome`, because some
    # Playwright internals expect the bundled browser to be present regardless.
    py = ROOT / ".venv" / "Scripts" / "python.exe"
    if py.exists():
        _say("chromium  checking Playwright's browser...")
        r = proc.run([str(py), "-m", "playwright", "install", "chromium"],
                     capture_output=True)
        _say("chromium  ready" if r.returncode == 0 else
             "chromium  install reported a problem; `playwright install chromium` by hand")
    else:
        _say(f"chromium  skipped: no venv at {py}")

    # ── 5. autostart ──────────────────────────────────────────────────────
    if autostart:
        from . import serve as serve_cmd

        _say("autostart registering scheduled tasks...")
        serve_cmd.autostart("on", chosen)
    else:
        _say("autostart skipped (--no-autostart)")

    # ── 6. what a human still has to do ───────────────────────────────────
    sites = sorted(x.name for x in p.iterdir() if x.is_dir()) if p.is_dir() else []
    _say()
    # What is left is signing in, and all of it happens in the console
    # (Accounts starts every sign-in on this PC). The token needs no typing:
    # the console at this PC reads it from /api/token and shares it with the
    # profile's other devices.
    _say("Done. What only a person can do, in the console:")
    _say()
    _say(f"  Open https://anthonyn99.github.io/A1/magi.html here, pick {profile}, unlock,")
    _say("  then Accounts: sign in to each council unit, Coding agents (Codex shows")
    _say("  a device code), and GitHub (add a token).")
    if sites:
        _say(f"  Sessions already saved here: {', '.join(sites)}")
    _say()
    return 0
