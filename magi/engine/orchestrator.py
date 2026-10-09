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
import contextlib
import time
import uuid
from dataclasses import replace as dc_replace
from pathlib import Path

from ..db import Database
from ..providers.base import Answer, Provider, ProviderEvent, ProviderState, RunContext
from ..settings import Settings
from . import chairman as chairman_mod
from . import session as session_mod
from .session import Steer



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

# A third simultaneous Chrome launch is where startup contention starts to
# cost more than the stagger does (measured: 4 at once 15.6s vs staggered 9.7s).
CONTENTION_FROM = 2
CONTENTION_GAP_S = 0.6

# See Orchestrator._gather_with_grace.
STRAGGLER_MAX = 1
STRAGGLER_GRACE_S = 180.0
# A one-line question does not need three minutes of grace: replaying every
# stored council run and brainstorm phase (2026-09-28), a 90s floor for
# prompts under 600 chars would have cut no real answer.
STRAGGLER_GRACE_SHORT_S = 90.0
SHORT_PROMPT_CHARS = 600
# A straggler whose text grew this recently is still writing: extend, don't cut.
STILL_WRITING_S = 20.0
# A straggler that has not produced ONE word of answer yet. Grok sat on
# "Working for 8m" with five answers in hand (2026-09-29) and the old grace --
# as long again as the run had taken -- let it: nothing showed it was going to
# answer. Silence after everyone else is done gets this long, flat, and is cut.
SILENT_GRACE_S = 30.0
SILENT_GRACE_LONG_S = 60.0


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
        chairs = self.chair_candidates(providers, answers)
        return chairs[0] if chairs else None

    def chair_candidates(
        self, providers: list[Provider], answers: list[Answer]
    ) -> list[Provider]:
        """Every member that may write the synthesis, in the order to try them.

        The configured chairman and its fallback order first, then any other
        member that answered. A list rather than one pick because the chair
        itself can fail AFTER being picked: on 2026-09-21 Gemini chaired a 5/5
        council and returned "I encountered an error doing what you asked", and
        with nobody to hand over to, that line was the verdict.
        """
        ok_ids = {a.provider_id for a in answers if a.ok}
        by_id = {p.id: p for p in providers}
        cfg = self.settings.chairman
        out: list[Provider] = []
        for cand in [cfg.provider_id, *cfg.fallback_order, *(a.provider_id for a in answers)]:
            if cand in ok_ids and cand in by_id and by_id[cand] not in out:
                out.append(by_id[cand])
        return out

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

    async def _gather_with_grace(
        self, tasks, providers, t0, emit, *, floor=None, grew=None
    ) -> None:
        """Wait for every member -- but not for ever for the last one.

        One stuck unit used to hold the whole council: on 2026-09-22 Gemini
        sat "thinking" for twelve minutes with three answers already in hand,
        and nothing could reach a verdict until it gave up. So once only
        STRAGGLER_MAX units are left, they get a grace period -- as long again
        as the run has taken so far, never less than `floor` (STRAGGLER_GRACE_S,
        or STRAGGLER_GRACE_SHORT_S for a short prompt) -- and are then cut off.
        A slow unit that is really working still fits: the slowest real answer
        (ChatGPT, 362s against the others' ~130s) is well inside twice the time
        the others took.

        And a unit is never cut mid-sentence: `grew` maps unit id -> when its
        text last grew, and while that is under STILL_WRITING_S ago the grace
        is extended, STILL_WRITING_S at a time. The site's own hard timeout
        (completion.py) stays the ceiling.

        Tightened 2026-09-29: the grace is now `floor` flat, no longer scaled
        by the run's length (a real writer is protected by the extensions
        above, not by the scaling), and a straggler that has shown NO answer
        text at all gets only SILENT_GRACE_S -- a spinner is not an answer.
        """
        if floor is None:
            floor = STRAGGLER_GRACE_S
        silent = SILENT_GRACE_LONG_S if floor >= STRAGGLER_GRACE_S else SILENT_GRACE_S
        grew = grew if grew is not None else {}
        by_task = dict(zip(tasks, providers))
        pending = set(tasks)
        while pending:
            done, pending = await asyncio.wait(
                pending, return_when=asyncio.FIRST_COMPLETED
            )
            if pending and len(pending) <= STRAGGLER_MAX and len(pending) < len(tasks):
                others_done = time.monotonic()

                def base_deadline():
                    # Re-read each time: a silent unit that starts writing
                    # during its short grace earns the full one.
                    wrote = any(by_task[t].id in grew for t in pending)
                    return others_done + (floor if wrote else min(silent, floor))

                deadline = base_deadline()
                while pending:
                    deadline = max(deadline, base_deadline())
                    left = deadline - time.monotonic()
                    if left > 0:
                        # Wake at least every few seconds so a unit that starts
                        # writing moves to the full grace promptly.
                        done, pending = await asyncio.wait(
                            pending, timeout=min(left, 5.0)
                        )
                        continue
                    now = time.monotonic()
                    writing = [
                        grew[by_task[t].id] for t in pending
                        if now - grew.get(by_task[t].id, float("-inf")) < STILL_WRITING_S
                    ]
                    if not writing:
                        break
                    deadline = max(writing) + STILL_WRITING_S
                if pending:
                    for t in pending:
                        t.cancel()
                    with contextlib.suppress(BaseException):
                        await asyncio.gather(*pending, return_exceptions=True)
                    if emit:
                        for t in pending:
                            p = by_task[t]
                            with contextlib.suppress(Exception):
                                await emit(ProviderEvent(
                                    provider_id=p.id, state=ProviderState.FAILED,
                                    message=f"Cut off: the other units finished "
                                            f"and {p.display_name} was still going.",
                                ))
                    return
                pending = set()

    @staticmethod
    async def _ask(p, question, ctx, emit, cancel):
        """Ask one member; a stock refusal gets exactly one retry.

        Observed 2026-09-21: Gemini Flash answered "What moved the market the
        most today?" with "I cannot fulfill this request. I do not have access
        to real-time financial market data or live web search" -- and the same
        question typed into gemini.google.com by hand searched and answered.
        Whether a chat model decides to search is a coin it flips per turn, so
        a refusal is worth one more throw in a fresh chat, told outright to
        search. Only refusals: a clarifying question or an echo would come back
        the same way, and each retry costs a full browser turn.
        """
        a = await Orchestrator._ask_once(p, question, ctx, emit, cancel)
        # Retry only a model that says it cannot look things up -- that is a
        # coin it flips per turn. A site's own error line ("I encountered an
        # error", "I'm having a hard time fulfilling your request") came back
        # the same way on every retry on 2026-09-22 and cost the whole council
        # a further wait each time.
        from .validate import _NO_LIVE_ACCESS

        if not (
            a.degraded and a.degraded_kind == "refusal"
            and _NO_LIVE_ACCESS.search(a.text.replace("’", "'"))
        ):
            return a
        if cancel is not None and cancel.is_set():
            return a
        from ..providers.browser_base import REFUSAL_RETRY_NUDGE

        if emit:
            await emit(
                ProviderEvent(
                    provider_id=p.id,
                    state=ProviderState.WAITING,
                    message=f"{p.display_name} refused; asking again with web search",
                )
            )
        again = await Orchestrator._ask_once(
            p, REFUSAL_RETRY_NUDGE + question, ctx, emit, cancel
        )
        # A second refusal is reported as the first one was; anything else --
        # an answer, or a different failure -- is what the retry found.
        return again

    @staticmethod
    async def _ask_once(p, question, ctx, emit, cancel):
        a = await Orchestrator._ask_raw(p, question, ctx, emit, cancel)
        # A provider announces DONE and DEGRADED itself, but a failure only
        # ever came back as a return value, so the console heard about it when
        # the WHOLE council finished: Grok sat on "awaiting response" for the
        # rest of a run after its rate limit had been read off the page. Say
        # so the moment it is known.
        # A member stopped by Interrupt now has not failed: it is about to be
        # asked again (gather `reask`), and a FAILED card would flash first.
        if emit and not a.ok and not a.degraded and not getattr(a, "interrupted", False):
            with contextlib.suppress(Exception):
                await emit(ProviderEvent(
                    provider_id=p.id, state=ProviderState.FAILED,
                    message=a.error_detail or str(a.failure or "failed"),
                ))
        return a

    @staticmethod
    async def _ask_raw(p, question, ctx, emit, cancel):
        """Ask one member, and let a halt actually interrupt it.

        A provider checks `cancel` where it can do so safely: before sending,
        and on every poll while it waits for the answer. That covers the long
        middle of a run and nothing else -- launching a browser, navigating,
        clearing a dialog and pasting the prompt are all uninterruptible, and
        together they are most of the first thirty seconds. Which is exactly
        when someone presses Halt.

        So the ask is raced against the event. When the event wins, the task is
        cancelled outright: that unwinds `async with launcher.launch(...)`,
        which closes the browser, whatever phase it had reached. Halting a
        four-member fan-out used to mean waiting for four browsers to finish
        what they were doing; now it means four `CancelledError`s and four
        closed browsers.

        The member still returns an Answer rather than vanishing, so a halted
        run reports what happened to each unit instead of showing gaps.
        """
        if cancel is None:
            return await p.ask(question, ctx=ctx, on_event=emit, cancel=cancel)

        task = asyncio.create_task(
            p.ask(question, ctx=ctx, on_event=emit, cancel=cancel)
        )
        halt = asyncio.create_task(cancel.wait())
        try:
            await asyncio.wait({task, halt}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            halt.cancel()
        if task.done():
            return task.result()

        task.cancel()
        # Let the cancellation propagate so the browser context closes before
        # this returns; the browser teardown is the whole point of cancelling.
        with contextlib.suppress(BaseException):
            await task
        from ..errors import FailureKind

        return Answer.failed(
            p.id, p.display_name, FailureKind.CANCELLED,
            "Halted before this unit finished.",
        )

    async def gather(
        self,
        providers: list[Provider],
        prompts: str | dict[str, str],
        ctx: RunContext | None,
        emit,
        cancel: asyncio.Event | None,
        on_answer=None,
        floor_chars: int | None = None,
        reask=None,
    ) -> list[Answer]:
        """Ask every member, honouring the pacing -- one fan-out for everyone.

        `prompts` is one question for all, or a dict keyed by unit id when each
        member gets its own (Brainstorm's rounds and critiques). The council
        and Brainstorm used to fan out separately, and Brainstorm's copy had
        none of this one's protections: no halt race, no instant FAILED card,
        no refusal retry, no contention stagger, and no straggler cut -- a
        stuck unit could hold a round until its 20-minute hard timeout.

        `on_answer` is awaited with each Answer, in member order (the council
        saves them to the run as they come).

        `floor_chars` is the length the straggler floor is judged on when the
        prompts are longer than what was asked: a follow-up's prompt carries
        the conversation so far, and a one-line follow-up must keep the short
        floor rather than inherit a long one from its padding.
        """
        def prompt_for(p: Provider) -> str:
            return prompts[p.id] if isinstance(prompts, dict) else prompts

        async def ask(p: Provider, ev) -> Answer:
            a = await self._ask(p, prompt_for(p), ctx, ev, cancel)
            # Interrupt now (RunContext.interrupt): asked once more, in a
            # fresh chat, with what it had written and the notes. `reask`
            # gives that prompt (None = keep the stopped answer). The second
            # ask cannot be interrupted again.
            stopped = getattr(a, "interrupted", False) and not (cancel and cancel.is_set())
            if stopped and reask is not None:
                again = reask(p, prompt_for(p), a)
                if again:
                    # Checked against the question AND the notes: "answer in
                    # French" makes a good answer share few words with the
                    # question alone (validate's off-topic test).
                    ref = "
".join([ctx.reference or ctx.question, again.rsplit(
                        "NOTES FROM THE PERSON:", 1)[-1]])
                    return await self._ask(p, again, dc_replace(ctx, interrupt=None,
                                                                reference=ref), ev, cancel)
            return a

        t0 = time.monotonic()
        answers: list[Answer] = []
        pacing = self.settings.pacing

        if pacing.mode == "sequential" or pacing.max_concurrency <= 1:
            for i, p in enumerate(providers):
                if cancel and cancel.is_set():
                    break
                if i > 0:
                    await asyncio.sleep(pacing.sample_inter_provider())
                a = await ask(p, emit)
                answers.append(a)
                if on_answer:
                    await on_answer(a)
            return answers

        # Members run concurrently. Each drives its OWN browser profile and
        # its own site, so there is no shared rate limit to trip -- the
        # concern that motivated sequential-only was four requests to one
        # service, which is not what happens here.
        #
        # Starts are still staggered by a short random gap so four browser
        # launches don't land on the same instant (which is both a
        # recognisable pattern and a CPU spike that slows every member).
        sem = asyncio.Semaphore(pacing.max_concurrency)

        # When each unit's text last grew, for the straggler rule. STREAMING
        # events fire only when the captured text grew (completion.py).
        grew: dict[str, float] = {}

        async def tracked(ev: ProviderEvent) -> None:
            if ev.state == ProviderState.STREAMING and ev.partial_text:
                grew[ev.provider_id] = time.monotonic()
            if emit:
                await emit(ev)

        longest = (
            floor_chars if floor_chars is not None
            else max((len(prompt_for(p)) for p in providers), default=0)
        )
        floor = (
            STRAGGLER_GRACE_SHORT_S if longest < SHORT_PROMPT_CHARS
            else STRAGGLER_GRACE_S
        )

        async def one(p: Provider, delay: float) -> Answer:
            await asyncio.sleep(delay)
            async with sem:
                return await ask(p, tracked)

        # Cumulative stagger, sampled per provider -- provider N waits for
        # the sum of N gaps, not N x one fixed gap.
        #
        # With the gap configured to zero (start everyone together) the
        # first two still start together, but a THIRD onwards is held back
        # a beat. Chrome startup is CPU-bound: measured here, four members
        # launched at the same instant took 15.6s to all be page-ready,
        # against 9.7s when spread out, because they slowed each other
        # down. Two browsers do not contend, so a two-unit council pays
        # nothing for this.
        delays, acc = [], 0.0
        for i, _ in enumerate(providers):
            delays.append(acc)
            gap = pacing.sample_inter_provider()
            if gap <= 0 and i + 1 >= CONTENTION_FROM:
                gap = CONTENTION_GAP_S
            acc += gap

        tasks = [
            asyncio.create_task(one(p, d)) for p, d in zip(providers, delays)
        ]
        await self._gather_with_grace(
            tasks, providers, t0, emit, floor=floor, grew=grew
        )
        from ..errors import FailureKind

        for p, t in zip(providers, tasks):
            if t.cancelled():
                a = Answer.failed(
                    p.id, p.display_name, FailureKind.TIMEOUT,
                    f"Cut off: every other unit had finished and "
                    f"{p.display_name} was still going "
                    f"{int(time.monotonic() - t0)}s into the run.",
                )
            elif t.exception() is not None:
                a = Answer.failed(
                    p.id, p.display_name, FailureKind.UNKNOWN,
                    str(t.exception())[:300],
                )
            else:
                a = t.result()
            answers.append(a)
            if on_answer:
                await on_answer(a)
        return answers

    async def run(
        self,
        question: str,
        providers: list[Provider],
        *,
        run_id: str | None = None,
        on_event=None,
        cancel: asyncio.Event | None = None,
        attachments: list[Path] | None = None,
        context: list[dict] | None = None,
        session_id: str | None = None,
        turn: int | None = None,
        steer: Steer | None = None,
    ) -> dict:
        """One council turn.

        Track F: `context` is the conversation so far (`[{q, answer}]`, from
        the console) -- each unit is asked with it replayed in front of the
        new message, and the chairman sees it too. `steer` holds notes typed
        while the run is going; those in before synthesis starts go to the
        chairman, later ones come back as `followup_notes`.
        """
        run_id = run_id or uuid.uuid4().hex[:12]
        context = context or []
        ctx = RunContext(
            run_id=run_id, question=question, attachments=attachments or [],
            reference=session_mod.reference(question, context) if context else "",
            interrupt=steer.interrupt if steer else None,
        )
        t0 = time.monotonic()

        if self.db:
            await self.db.create_run(
                run_id, question, self.settings.chairman.provider_id,
                session_id=session_id or run_id, turn=turn or 1,
            )

        async def emit(ev: ProviderEvent) -> None:
            if on_event:
                await on_event(ev)

        async def save(a: Answer) -> None:
            if self.db:
                await self.db.save_answer(run_id, a)

        # -- gather ---------------------------------------------------------
        prompts: str | dict[str, str] = question
        if context:
            prompts = {
                p.id: session_mod.prompt_with_context(
                    question, context, session_mod.budget_for(p.id, question)
                )
                for p in providers
            }
        def reask(p: Provider, prompt: str, a: Answer) -> str | None:
            notes = steer.notes if steer else []
            return session_mod.reask_prompt(prompt, a.text, notes) if notes else None

        answers = await self.gather(
            providers, prompts, ctx, emit, cancel, on_answer=save,
            floor_chars=len(question), reask=reask,
        )
        # No await between this snapshot and the decision below: a note is
        # in the verdict or held for the follow-up, never both or neither.
        additions = steer.close_gather() if steer else []

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
        # The model the chair that wrote the verdict was on (chairman.Synthesis).
        chair_model, chair_fallback = "", ""
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
        elif len(responded) == 1 and not additions:
            # Nothing to synthesise. Handing a single answer to a chairman to
            # "compare" costs a second browser run against a paid account and
            # returns a worse-written version of what is already on screen --
            # so the sole member's answer IS the verdict, and the console says
            # so rather than dressing it up as a consensus.
            #
            # Unless the person added notes while it was answering: the unit
            # never saw them, so it goes through synthesis to revise its own
            # answer with them.
            sole = responded[0]
            verdict, syn_ok = sole.text, True
            chair = next((p for p in providers if p.id == sole.provider_id), None)
        else:
            chairs = self.chair_candidates(providers, answers)
            if not chairs:
                syn_err = "No member available to act as chairman."
            failures: list[str] = []
            for chair in chairs:
                if cancel and cancel.is_set():
                    syn_err = "Run cancelled before synthesis."
                    break
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
                            message=(
                                f"{chair.display_name} is synthesising the verdict"
                                if not failures else
                                f"{chair.display_name} is taking over the verdict"
                            ),
                        )
                    )
                syn = await chairman_mod.synthesize(
                    chair, question, answers, ctx, cancel=cancel,
                    context=session_mod.build_context(
                        context, session_mod.budget_for(chair.id, question)
                    ),
                    additions=additions,
                )
                verdict, syn_ok, syn_err, ms = syn
                syn_ms += ms
                if syn_ok:
                    chair_model = getattr(syn, "model", "")
                    chair_fallback = getattr(syn, "model_fallback", "")
                    break
                # The chair's capture goes through the same validation as a
                # member's, so a refusal or a stock error line lands here as a
                # failure rather than as the verdict. Hand it to the next unit.
                failures.append(syn_err or f"Chairman ({chair.display_name}) failed.")
                verdict = ""
            if not syn_ok and len(failures) > 1 and not (cancel and cancel.is_set()):
                syn_err = " | ".join(failures)

        total_ms = int((time.monotonic() - t0) * 1000)
        status = "complete" if responded else "failed"
        if cancel and cancel.is_set():
            status = "cancelled"

        # Notes the verdict used, and ones it could not (no quorum, halted,
        # every chair failed) -- those go back to the person, not to waste.
        applied = additions if syn_ok else []
        unapplied = [] if syn_ok else additions
        if steer:
            steer.finish()
        followup = list(steer.followup) if steer else []

        if self.db:
            await self.db.save_synthesis(
                run_id, chair.id if chair else "", verdict,
                len(responded), len(answers), syn_ok, syn_err, syn_ms,
                model=chair_model, model_fallback=chair_fallback,
            )
            await self.db.finish_run(
                run_id, status, len(responded), len(answers), total_ms,
                notes=(
                    {"applied": applied, "followup": followup, "unapplied": unapplied}
                    if (applied or followup or unapplied) else None
                ),
            )

        return {
            "run_id": run_id,
            "question": question,
            "answers": answers,
            "verdict": verdict,
            "synthesis_ok": syn_ok,
            "synthesis_error": syn_err,
            "chairman": chair.display_name if chair else None,
            "chairman_model": chair_model,
            "chairman_model_fallback": chair_fallback,
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
            "session_id": session_id or run_id,
            "turn": turn or 1,
            "notes": applied,
            "followup_notes": followup,
            "unapplied_notes": unapplied,
        }
