"""MAGI command line.

  python -m magi serve               run the backend + open the UI (local only)
  python -m magi cloud               same, plus a tunnel published to magi-link
  python -m magi autostart           run the engine at logon (no launcher needed)
  python -m magi doctor [site ...]   which selectors currently match
  python -m magi login <site>        open a window to sign in by hand
  python -m magi ask "question"      run the council from the terminal
  python -m magi capture <site>      find mid-generation selectors (costs 1 query)

Run from the A1 repo root, or just use magi.bat, which sets that up.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from .cli import doctor as doctor_cmd
from .cli import login as login_cmd
from .cli import serve as serve_cmd
from .settings import (
    KNOWN_PROFILES,
    load_settings,
    migrate_legacy_layout,
    resolve_profile,
    set_active_profile,
)


def _safe_stdio() -> None:
    """Never die on a character the console cannot show.

    With stdout piped or sent to NUL (a launcher, a test's `stdio: 'ignore'`)
    Python on Windows writes cp1252, and serve's "MAGI → http://…" line
    raised UnicodeEncodeError before the engine started (Phase 14 sweep).
    """
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass


def main(argv: list[str] | None = None) -> int:
    _safe_stdio()
    ap = argparse.ArgumentParser(prog="magi", description="MAGI multi-LLM council")

    # --profile on every subcommand rather than before it, so the natural
    # `magi serve --profile veda` works. An engine serves one person; this is
    # how you say which, and everything it reads or writes follows from it.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--profile",
        default=None,
        help=f"whose engine this is ({'/'.join(KNOWN_PROFILES)}); "
             "defaults to MAGI_PROFILE, then config/magi.yaml",
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    sv = sub.add_parser("serve", parents=[common], help="run the backend and open the UI")
    sv.add_argument("--port", type=int, default=0, help="default: this profile's port")
    sv.add_argument("--no-browser", action="store_true")

    cl = sub.add_parser("cloud", parents=[common], help="serve, tunnel, and publish where to reach it")
    cl.add_argument("--port", type=int, default=0, help="default: this profile's port")

    au = sub.add_parser(
        "autostart",
        parents=[common],
        help="start the engine automatically at logon, so magi.bat is optional",
    )
    au.add_argument("action", nargs="?", default="on", choices=["on", "off", "status"])
    au.add_argument("--port", type=int, default=0, help="default: this profile's port")

    d = sub.add_parser("doctor", parents=[common], help="check which selectors match each site")
    d.add_argument("sites", nargs="*", help="sites to check (default: all enabled)")

    lg = sub.add_parser("login", parents=[common], help="open a browser to sign in to a site")
    lg.add_argument("site", help="site id, e.g. chatgpt")

    cap = sub.add_parser(
        "capture",
        parents=[common],
        help="find selectors that only exist while a site is generating",
    )
    cap.add_argument("site", help="site id, e.g. deepseek")
    cap.add_argument("--question", help="what to ask (a short throwaway is best)")

    a = sub.add_parser("ask", parents=[common], help="ask the council a question")
    a.add_argument("question", nargs="+")
    a.add_argument("--providers", nargs="*", help="limit to these provider ids")

    ob = sub.add_parser(
        "onboard",
        parents=[common],
        help="set this machine up to run an engine for a profile",
    )
    ob.add_argument("--port", type=int, default=0, help="0 picks a free one")
    ob.add_argument("--label", default=None, help="what to call this engine")
    ob.add_argument("--no-autostart", action="store_true")

    args = ap.parse_args(argv)

    # Before ANY path is read. Every directory MAGI touches is derived from
    # the active profile, so choosing it late would mean half the process
    # looking at one person's data and half at another's.
    set_active_profile(resolve_profile(getattr(args, "profile", None)))
    # Tony's pre-profile directories move under his profile on first run.
    # Idempotent, and a no-op on a machine that never had the old layout.
    for moved in migrate_legacy_layout():
        print(f"[magi] moved {moved} into the {'tony'} profile")

    # serve/cloud load settings themselves, per request, so a config edit takes
    # effect without a restart. Loading here would pin the startup copy.
    # No --port: the port this profile was onboarded on (8000 unless it shares
    # a PC with another engine) -- never a guessed 8000 for someone else.
    if getattr(args, "port", None) == 0 and args.cmd in ("serve", "cloud", "autostart"):
        from .watchdog import _configured_port
        args.port = _configured_port()
    if args.cmd == "serve":
        return serve_cmd.run(args.port, not args.no_browser)
    if args.cmd == "cloud":
        return serve_cmd.cloud(args.port)
    if args.cmd == "autostart":
        return serve_cmd.autostart(args.action, args.port)
    if args.cmd == "onboard":
        from .cli import onboard as onboard_cmd

        return onboard_cmd.run(
            port=args.port, label=args.label, autostart=not args.no_autostart
        )

    settings = load_settings()
    if args.cmd == "doctor":
        return asyncio.run(doctor_cmd.run(settings, args.sites or None))
    if args.cmd == "login":
        return asyncio.run(login_cmd.run(settings, args.site))
    if args.cmd == "capture":
        from .cli import capture as capture_cmd

        return asyncio.run(capture_cmd.run(settings, args.site, args.question))
    if args.cmd == "ask":
        from .cli import ask as ask_cmd

        return asyncio.run(
            ask_cmd.run(settings, " ".join(args.question), args.providers)
        )
    ap.print_help()
    return 2


def _crash_log(exc: BaseException) -> None:
    """Leave a trace when the engine dies before it has a log.

    pythonw has no console, and data/autostart.log is only opened once cloud()
    is running -- so anything that fails EARLIER (a bad import after an edit, a
    missing dependency, a broken venv) disappeared without a word. That is what
    a failed logon start looks like from the outside: nothing happened, no
    reason anywhere. Verified 2026-09-19, when a NameError left the engine dead
    after a reboot and the log still showed the previous session.
    """
    import traceback
    from datetime import datetime

    try:
        from .settings import data_dir

        log = data_dir() / "boot.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a", encoding="utf-8", errors="replace") as f:
            f.write(f"\n=== {datetime.now().isoformat(timespec='seconds')} "
                    f"argv={sys.argv[1:]} ===\n")
            traceback.print_exception(type(exc), exc, exc.__traceback__, file=f)
    except Exception:  # noqa: BLE001 — a logger that raises helps nobody
        pass


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 — logged, then re-raised
        _crash_log(e)
        raise
