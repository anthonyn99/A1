"""`magi doctor` -- the selector maintenance loop.

When a site ships a redesign, this is the first thing to run. It reports which
configured selector currently matches each field, so the fix is "add the working
selector to the top of that list in selectors.yaml" rather than a debugging
session.
"""

from __future__ import annotations

from ..providers.base import HealthReport
from ..providers.registry import build_providers
from ..settings import Settings

# Which non-matches are faults is decided once, in browser/resolve.py, and read
# here from the probe's status. Keeping a second list in the CLI is how the two
# drifted apart: this one lacked `submit`, so a send button that legitimately
# does not exist until you type was printed as a hard MISS.

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
DIM = "\033[2m"
OFF = "\033[0m"


def _print_report(r: HealthReport) -> None:
    print(f"\n{'=' * 70}")
    print(f"{r.display_name}  ({r.provider_id})")
    print("=" * 70)

    if r.error:
        print(f"{RED}ERROR{OFF}  {r.error}")
        return

    status = f"{GREEN}usable{OFF}" if r.usable else f"{RED}NOT usable{OFF}"
    print(f"reachable={r.reachable}  composer={r.logged_in}  "
          f"challenged={r.challenged}  -> {status}")

    if r.selectors:
        print(f"\n  {'FIELD':<20} {'STATUS':<6} {'N':>3}  MATCHED")
        print(f"  {'-' * 64}")
        for p in r.selectors:
            if not p.tried:
                print(f"  {p.field:<20} {DIM}--{OFF}     {'':>3}  {DIM}(none configured){OFF}")
                continue
            if p.ok:
                stale = p.matched != p.tried[0]
                colour = YELLOW if stale else GREEN
                label = "FALLBK" if stale else "OK"
                print(f"  {p.field:<20} {colour}{label:<6}{OFF} {p.count:>3}  {p.matched}")
            elif not p.is_fault:
                # Not a fault: nothing to match while idle, gated behind
                # typing, or absent because absence is the healthy case.
                why = p.note or "not applicable in this page state"
                print(f"  {p.field:<20} {DIM}{'n/a':<6}{OFF} {0:>3}  {DIM}({why}){OFF}")
            else:
                print(f"  {p.field:<20} {RED}{'MISS':<6}{OFF} {0:>3}  "
                      f"{DIM}(all {len(p.tried)} failed){OFF}")

    for n in r.notes:
        print(f"\n  note: {n}")
    if r.screenshot_path:
        print(f"\n  screenshot: {r.screenshot_path}")


async def run(settings: Settings, site_ids: list[str] | None = None) -> int:
    providers = build_providers(settings, site_ids)
    print(f"Checking {len(providers)} provider(s). A browser window opens for each.")

    reports: list[HealthReport] = []
    for p in providers:
        print(f"\n[{p.id}] checking...", flush=True)
        reports.append(await p.health_check())

    for r in reports:
        _print_report(r)

    usable = [r for r in reports if r.usable]
    print(f"\n{'=' * 70}")
    print(f"SUMMARY: {len(usable)}/{len(reports)} usable")
    for r in reports:
        mark = f"{GREEN}OK{OFF}" if r.usable else f"{RED}--{OFF}"
        why = ""
        if not r.usable:
            if r.error:
                why = "  (error)"
            elif r.challenged:
                why = "  (bot challenge)"
            elif not r.logged_in:
                why = f"  (logged out -> `python -m magi login {r.provider_id}`)"
            else:
                why = "  (no message box found -- 'input' selector is stale)"
        print(f"  {mark}  {r.display_name}{why}")

    if len(usable) < len(reports):
        print("\nTo fix a stale selector: open the site, inspect the element, and add "
              "the working selector to the TOP of that field's list in "
              "config/selectors.yaml.")
    return 0 if usable else 1
