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
from .settings import load_settings


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="magi", description="MAGI multi-LLM council")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sv = sub.add_parser("serve", help="run the backend and open the UI")
    sv.add_argument("--port", type=int, default=8000)
    sv.add_argument("--no-browser", action="store_true")

    cl = sub.add_parser("cloud", help="serve, tunnel, and publish where to reach it")
    cl.add_argument("--port", type=int, default=8000)

    au = sub.add_parser(
        "autostart",
        help="start the engine automatically at logon, so magi.bat is optional",
    )
    au.add_argument("action", nargs="?", default="on", choices=["on", "off", "status"])
    au.add_argument("--port", type=int, default=8000)

    d = sub.add_parser("doctor", help="check which selectors match each site")
    d.add_argument("sites", nargs="*", help="sites to check (default: all enabled)")

    lg = sub.add_parser("login", help="open a browser to sign in to a site")
    lg.add_argument("site", help="site id, e.g. chatgpt")

    cap = sub.add_parser(
        "capture",
        help="find selectors that only exist while a site is generating",
    )
    cap.add_argument("site", help="site id, e.g. deepseek")
    cap.add_argument("--question", help="what to ask (a short throwaway is best)")

    a = sub.add_parser("ask", help="ask the council a question")
    a.add_argument("question", nargs="+")
    a.add_argument("--providers", nargs="*", help="limit to these provider ids")

    args = ap.parse_args(argv)

    # serve/cloud load settings themselves, per request, so a config edit takes
    # effect without a restart. Loading here would pin the startup copy.
    if args.cmd == "serve":
        return serve_cmd.run(args.port, not args.no_browser)
    if args.cmd == "cloud":
        return serve_cmd.cloud(args.port)
    if args.cmd == "autostart":
        return serve_cmd.autostart(args.action, args.port)

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


if __name__ == "__main__":
    sys.exit(main())
