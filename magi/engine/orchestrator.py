"""The council run: dispatch to members, then synthesise.

Two behaviours the original sketch lacked and this depends on:

  * Graceful degradation. One member failing does not fail the run. The council
    proceeds with whoever answered, and the shortfall is stated in the verdict
    rather than hidden.

  * Human pacing. Members are queried sequentially with randomised gaps by
    default. Four simultaneous requests from one machine is the pattern that
    gets accounts flagged.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from pathlib import Path

from ..db import Database
from ..providers.base import Answer, Provider, ProviderEvent, ProviderState, RunContext
from ..settings import Settings
from . import chairman as chairman_mod



def required_members(min_members: int, asked: int) -> int:
    """How many members must answer before a round is worth continuing.

    You can never need more members than you ASKED. `chairman.min_members`
    exists to stop a single voice being passed off as a council verdict when
    three of four members failed -- a real quorum failure, worth saying so.
    Deliberately running ONE unit is not the same thing: it is a legitimate way
    to use MAGI, and the flat minimum was the only reason a one-unit run came
    back "NO QUORUM" with an amber error instead of the answer sitting right
    there on screen.

    Never below 1: zero answers is nothing to report on, whatever the config.
    """
    return max(1, min(min_members, asked))

class Orchestrator:
    def __init__(self, settings: Settings, db: Database | None = None):
        self.settings = settings
        self.db = db

    def _pick_chairman(
        self, providers: list[Provider], answers: list[Answer]
    ) -> Provider | None:
        """Prefer the configured chairman, but only among members that answered.

        A member that just failed to respond cannot be trusted to write the
        synthesis, so the fallback order matters.
        """
        ok_ids = {a.provider_id for a in answers if a.ok}
        by_id = {p.id: p for p in providers}
        cfg = self.settings.chairman
        for cand in [cfg.provider_id, *cfg.fallback_order]:
            if cand in ok_ids and cand in by_id:
                return by_id[cand]
        for a in answers:
            if a.ok and a.provider_id in by_id:
                return by_id[a.provider_id]
        return None

    async def _await_profile_release(self, chair: Provider, timeout_s: float = 8.0) -> None:
        """Wait for the chairman's browser profile to be free before launching.

        The chairman reuses a member's profile directory, and Chrome holds the
        profile lock at the process level -- which can briefly outlive the
        Playwright context that was closed when that member finished. Launching
        into that window produces Playwright's opaque "Opening in existing
        browser session" error and loses the whole synthesis.

        Polls rather than sleeping a fixed amount: the wait is normally zero,
        and a fixed pause would cost every run for a race that rarely happens.
        Gives up quietly after `timeout_s` -- launcher has its own lock-clearing
        retry, so a stuck profile is better handled there with a real error
        message than turned into a different one here.
        """
        if getattr(chair, "kind", "browser") != "browser":
            return
        try:
            from ..browser.launcher import _profile_in_use
        except Exception:
            return

        profile_dir = self.settings.browser.profile_dir(chair.id)
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            # Blocking subprocess call (process listing); keep it off the event
            # loop so provider progress events are not stalled behind it.
            if not await asyncio.to_thread(_profile_in_use, profile_dir):
                return
            await asyncio.sleep(0.25)

    async def run(
        self,
        question: str,
        providers: list[Provider],
        *,
        run_id: str | None = None,
        on_event=None,
        cancel: asyncio.Event | None = None,
        attachments: list[Path] | None = None,
    ) -> dict:
        run_id = run_id or uuid.uuid4().hex[:12]
        ctx = RunContext(run_id=run_id, question=question, attachments=attachments or [])
        t0 = time.monotonic()

        if self.db:
            await self.db.create_run(run_id, question, self.settings.chairman.provider_id)

        async def emit(ev: ProviderEvent) -> None:
            if on_event:
                await on_event(ev)

        # -- gather ---------------------------------------------------------
        answers: list[Answer] = []
        pacing = self.settings.pacing

        if pacing.mode == "sequential" or pacing.max_concurrency <= 1:
            for i, p in enumerate(providers):
                if cancel and cancel.is_set():
                    break
                if i > 0:
                    await asyncio.sleep(pacing.sample_inter_provider())
                a = await p.ask(question, ctx=ctx, on_event=emit, cancel=cancel)
                answers.append(a)
                if self.db:
                    await self.db.save_answer(run_id, a)
        else:
            # Members run concurrently. Each drives its OWN browser profile and
            # its own site, so there is no shared rate limit to trip -- the
            # concern that motivated sequential-only was four requests to one
            # service, which is not what happens here.
            #
            # Starts are still staggered by a short random gap so four browser
            # launches don't land on the same instant (which is both a
            # recognisable pattern and a CPU spike that slows every member).
            sem = asyncio.Semaphore(pacing.max_concurrency)

            async def one(p: Provider, delay: float) -> Answer:
                await asyncio.sleep(delay)
                async with sem:
                    return await p.ask(question, ctx=ctx, on_event=emit, cancel=cancel)

            # Cumulative stagger, sampled per provider -- provider N waits for
            # the sum of N gaps, not N x one fixed gap.
            delays, acc = [], 0.0
            for _ in providers:
                delays.append(acc)
                acc += pacing.sample_inter_provider()

            gathered = await asyncio.gather(
                *(one(p, d) for p, d in zip(providers, delays)),
                return_exceptions=True,
            )
            for p, g in zip(providers, gathered):
                if isinstance(g, Exception):
                    from ..errors import FailureKind

                    g = Answer.failed(
                        p.id, p.display_name, FailureKind.UNKNOWN, str(g)[:300]
                    )
                answers.append(g)
                if self.db:
                    await self.db.save_answer(run_id, g)

        responded = [a for a in answers if a.ok and a.text.strip()]
        # Members that answered but whose text failed validation. Tracked
        # separately from outright failures because they mean something
        # different to the reader: the site worked and the model replied, but
        # what came back was not an answer. They are excluded from `responded`
        # (ok=False), so quorum and synthesis already ignore them.
        degraded = [a for a in answers if a.degraded]

        # -- synthesise -----------------------------------------------------
        verdict, syn_ok, syn_err, syn_ms = "", False, None, 0
        chair = None
        need = required_members(
            self.settings.chairman.min_members, len(answers)
        )
        if len(responded) < need:
            note = ""
            if degraded:
                note = (
                    " Excluded for unusable captures: "
                    + "; ".join(a.degraded_reason for a in degraded)
                )
            syn_err = (
                f"Only {len(responded)} of {len(answers)} members responded; "
                f"synthesis needs at least {need}. "
                f"The individual answers above are unaffected.{note}"
            )
        elif cancel and cancel.is_set():
            syn_err = "Run cancelled before synthesis."
        elif len(responded) == 1:
            # Nothing to synthesise. Handing a single answer to a chairman to
            # "compare" costs a second browser run against a paid account and
            # returns a worse-written version of what is already on screen --
            # so the sole member's answer IS the verdict, and the console says
            # so rather than dressing it up as a consensus.
            sole = responded[0]
            verdict, syn_ok = sole.text, True
            chair = next((p for p in providers if p.id == sole.provider_id), None)
        else:
            chair = self._pick_chairman(providers, answers)
            if chair is None:
                syn_err = "No member available to act as chairman."
            else:
                # The chairman drives the SAME browser profile as the member of
                # the same name, so the member's context must be fully released
                # before the chairman's launch claims it. The `async with` in
                # BrowserProvider.ask has returned by now, but Chrome's own
                # process can outlive it by a moment, and the profile lock is
                # held by the PROCESS, not the Playwright handle.
                #
                # This matters more than a lost synthesis: launcher's orphan
                # reclaim cannot tell a dead run's leftover window from a live
                # one, so a lingering process risks being killed while another
                # member is still using it. Waiting is cheap; a wrongly killed
                # member is a lost answer.
                await self._await_profile_release(chair)
                if on_event:
                    await on_event(
                        ProviderEvent(
                            provider_id=chair.id,
                            state=ProviderState.WAITING,
                            message=f"{chair.display_name} is synthesising the verdict",
                        )
                    )
                verdict, syn_ok, syn_err, syn_ms = await chairman_mod.synthesize(
                    chair, question, answers, ctx, cancel=cancel
                )

        total_ms = int((time.monotonic() - t0) * 1000)
        status = "complete" if responded else "failed"
        if cancel and cancel.is_set():
            status = "cancelled"

        if self.db:
            await self.db.save_synthesis(
                run_id, chair.id if chair else "", verdict,
                len(responded), len(answers), syn_ok, syn_err, syn_ms,
            )
            await self.db.finish_run(
                run_id, status, len(responded), len(answers), total_ms
            )

        return {
            "run_id": run_id,
            "question": question,
            "answers": answers,
            "verdict": verdict,
            "synthesis_ok": syn_ok,
            "synthesis_error": syn_err,
            "chairman": chair.display_name if chair else None,
            "responded": len(responded),
            "total": len(answers),
            "degraded": [
                {
                    "provider_id": a.provider_id,
                    "display_name": a.display_name,
                    "reason": a.degraded_reason,
                    "chars": a.chars,
                }
                for a in degraded
            ],
            "total_ms": total_ms,
            "status": status,
        }
