"""`magi ask "question"` -- run the council from the terminal."""

from __future__ import annotations

from ..db import Database
from ..engine.orchestrator import Orchestrator
from ..errors import FailureKind, explain
from ..providers.registry import build_providers
from ..settings import Settings

GREEN, RED, YELLOW, DIM, BOLD, OFF = (
    "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[1m", "\033[0m"
)


async def run(settings: Settings, question: str, provider_ids: list[str] | None) -> int:
    providers = build_providers(settings, provider_ids or None)
    db = Database(settings.db_path)
    await db.init()

    print(f"\n{BOLD}MAGI COUNCIL{OFF}")
    print(f"question: {question}")
    print(f"members : {', '.join(p.display_name for p in providers)}")
    print(f"{DIM}(browser windows will open; members are queried one at a time){OFF}\n")

    last_state: dict[str, str] = {}

    async def on_event(ev) -> None:
        # Only print on state change, so the log stays readable.
        if last_state.get(ev.provider_id) == ev.state and not ev.message:
            return
        last_state[ev.provider_id] = str(ev.state)
        suffix = f"  {ev.message}" if ev.message else ""
        if ev.chars:
            suffix += f"  ({ev.chars} chars)"
        print(f"  {DIM}[{ev.provider_id}] {ev.state}{suffix}{OFF}")

    result = await Orchestrator(settings, db).run(question, providers, on_event=on_event)

    for a in result["answers"]:
        print(f"\n{'=' * 70}")
        if a.ok:
            flag = f" {YELLOW}(low confidence){OFF}" if a.low_confidence else ""
            print(f"{GREEN}{a.display_name}{OFF}{flag}"
                  f"  {DIM}{a.latency_ms/1000:.1f}s, {a.chars} chars, "
                  f"via {a.completion_reason}{OFF}")
            print("=" * 70)
            print(a.text)
        else:
            cause, remedy = explain(a.failure or FailureKind.UNKNOWN)
            print(f"{RED}{a.display_name} -- did not respond{OFF}  {DIM}[{a.failure}]{OFF}")
            print("=" * 70)
            print(f"  {cause}")
            if remedy:
                print(f"  -> {remedy}")
            if a.error_detail:
                print(f"  {DIM}{a.error_detail}{OFF}")

    print(f"\n{'=' * 70}")
    print(f"{BOLD}VERDICT{OFF}  "
          f"{DIM}({result['responded']} of {result['total']} members responded"
          + (f", synthesised by {result['chairman']}" if result["chairman"] else "")
          + f"){OFF}")
    print("=" * 70)
    if result["synthesis_ok"]:
        print(result["verdict"])
    else:
        print(f"{YELLOW}No synthesis.{OFF} {result['synthesis_error']}")

    print(f"\n{DIM}run {result['run_id']} -- {result['total_ms']/1000:.1f}s total{OFF}")
    return 0 if result["responded"] else 1
