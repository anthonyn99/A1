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

import os
import secrets
import socket
import sys
from pathlib import Path

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


def _pick_port(requested: int) -> int:
    """The asked-for port, else this profile's usual one, else the next free."""
    if requested:
        return requested
    preferred = PROFILE_PORTS.get(active_profile(), 0)
    if preferred and (_port_free(preferred) or _owned_port() == preferred):
        return preferred
    for p in range(BASE_PORT, BASE_PORT + 40):
        if _port_free(p):
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
            (d / "engine.json").write_text(
                __import__("json").dumps(rec, indent=1), encoding="utf-8"
            )
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
    _say("Done. Two things only you can do:")
    _say()
    flag = "" if profile == "tony" else f" --profile {profile}"
    if sites:
        _say(f"  1. Sessions already saved here: {', '.join(sites)}")
        _say(f"     Add or refresh one:  magi login <site>{flag}")
    else:
        _say("  1. Sign in to each site you want on the council:")
        _say(f"       magi login chatgpt{flag}")
        _say(f"       magi login claude{flag}")
        _say(f"       magi login gemini{flag}")
        _say(f"       magi login deepseek{flag}")
        _say("     A real window opens; you log in by hand. MAGI never sees")
        _say("     your credentials, and your own Chrome is never touched.")
    _say()
    _say(f"  2. Open http://127.0.0.1:{chosen} and enter the token once,")
    _say(f"     as the {profile} profile. Every other device picks it up.")
    _say()
    return 0
