"""MAGI command line.

  python -m magi doctor [site ...]   which selectors currently match
  python -m magi login <site>        open a window to sign in by hand
  python -m magi ask "question"      run the council from the terminal
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from .cli import doctor as doctor_cmd
from .cli import login as login_cmd
from .settings import load_settings


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="magi", description="MAGI multi-LLM council")
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("doctor", help="check which selectors match each site")
    d.add_argument("sites", nargs="*", help="sites to check (default: all enabled)")

    lg = sub.add_parser("login", help="open a browser to sign in to a site")
    lg.add_argument("site", help="site id, e.g. chatgpt")

    a = sub.add_parser("ask", help="ask the council a question")
    a.add_argument("question", nargs="+")
    a.add_argument("--providers", nargs="*", help="limit to these provider ids")

    args = ap.parse_args(argv)
    settings = load_settings()

    if args.cmd == "doctor":
        return asyncio.run(doctor_cmd.run(settings, args.sites or None))
    if args.cmd == "login":
        return asyncio.run(login_cmd.run(settings, args.site))
    if args.cmd == "ask":
        from .cli import ask as ask_cmd

        return asyncio.run(
            ask_cmd.run(settings, " ".join(args.question), args.providers)
        )
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
