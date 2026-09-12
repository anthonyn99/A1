"""Browser-backed Provider: one implementation, driven entirely by config.

This is the spike logic from scripts/spike_chatgpt.py generalised. There is no
per-site Python -- every site difference lives in config/selectors.yaml. Adding
a council member means adding a YAML block, not a class.

Verified working against chatgpt.com on 2026-08-12 (M1 gate, 3/3).
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from pathlib import Path

from ..browser import completion, extract, humanize, launcher, overlay, resolve
from ..engine import validate
from ..errors import FailureKind, ProviderError
from ..settings import Settings, SiteSelectors
from .base import (
    Answer,
    HealthReport,
    Provider,
    ProviderEvent,
    ProviderState,
    ProgressFn,
    RunContext,
    SelectorProbe,
)


# Answer HERE, in the chat.
#
# These are real chat UIs with real tool belts, and a long structured prompt is
# exactly the shape that makes them reach for one. Observed live: asked for a
# ten-section trading report, Claude replied "I'll help you build a template",
# read its memories, and started BUILDING AN INTERACTIVE GENERATOR as a file.
# MAGI waited, the visible text never settled into an answer, and the run ended
# with stall_timeout -- a member lost for the whole run, and a real question
# unanswered.
#
# MAGI cannot read an artifact, a canvas, a file or a tool result: it scrapes
# the conversation. An answer that is not in the conversation does not exist as
# far as the council is concerned. So every member is told, once, where the
# answer has to go.
#
# The second paragraph exists for the same failure one step later. With the
# artifact fixed, Claude came back with "Should I: 1. Search the web for
# today's data? 2. Wait for you to provide it?" -- a perfectly reasonable
# thing to ask a person, and worthless here. A council turn is ONE turn: there
# is no conversation, nobody is watching that tab, and a member that spends
# its turn asking has contributed nothing. The other three units simply looked
# the data up, which is why they answered and Claude did not.
#
# Deliberately short and behavioural. It says nothing about content, tone,
# length or format, so it cannot bend an answer -- only where that answer is
# put and whether there will be one. It is prepended to EVERY browser turn,
# which includes the chairman's synthesis and Studio's generation, and those
# are the turns most likely to be mistaken for "build me a document".
DIRECT_ANSWER_PREAMBLE = (
    "Reply with your full answer in this chat message. Do not create an "
    "artifact, canvas, document, file, app or tool to hold it, and do not "
    "offer to build one.\n"
    "This is a single turn and there is no follow-up: nobody will read a "
    "clarifying question or reply to an offer. Answer with what you have, "
    "state any assumption you had to make, and look things up if you need "
    "current information.\n\n"
)


class BrowserProvider(Provider):
    kind = "browser"

    def __init__(self, site: SiteSelectors, settings: Settings):
        self.site = site
        self.settings = settings
        self.id = site.id
        self.display_name = site.display_name
        self.accent = site.accent

    # ------------------------------------------------------------------ utils

    async def _emit(
        self,
        on_event: ProgressFn | None,
        state: ProviderState,
        *,
        text: str = "",
        started: float | None = None,
        message: str = "",
    ) -> None:
        if on_event is None:
            return
        await on_event(
            ProviderEvent(
                provider_id=self.id,
                state=state,
                partial_text=text,
                chars=len(text),
                elapsed_ms=int((time.monotonic() - started) * 1000) if started else 0,
                message=message,
            )
        )

    async def _save_artifacts(self, page, tag: str) -> list[str]:
        """Screenshot + DOM on failure, so a broken selector is diagnosable later."""
        if not self.settings.artifacts_on_failure:
            return []
        out: list[str] = []
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        base = Path(self.settings.artifacts_dir)
        base.mkdir(parents=True, exist_ok=True)
        try:
            png = base / f"{self.id}-{tag}-{stamp}.png"
            await page.screenshot(path=str(png), full_page=False)
            out.append(str(png))
        except Exception:
            pass
        try:
            html = base / f"{self.id}-{tag}-{stamp}.html"
            html.write_text(await page.content(), encoding="utf-8")
            out.append(str(html))
        except Exception:
            pass
        self._prune_artifacts(base)
        return out

    def _prune_artifacts(self, base: Path) -> None:
        """Keep only the newest `keep_last` files.

        Done here, after each write, because this is the only thing that ever
        creates them -- a sweep anywhere else would be a second place to
        remember. Failures are swallowed for the same reason the writes above
        are: an artifact is a diagnostic nicety, and nothing about saving one
        may take down the run it is diagnosing.
        """
        keep = getattr(self.settings, "artifacts_keep_last", 200)
        if keep <= 0:
            return
        try:
            files = sorted(
                (f for f in base.iterdir() if f.is_file()),
                key=lambda f: f.stat().st_mtime,
                reverse=True,
            )
            for old in files[keep:]:
                old.unlink(missing_ok=True)
        except Exception:
            pass

    # -------------------------------------------------------------------- ask

    async def ask(
        self,
        question: str,
        *,
        ctx: RunContext,
        on_event: ProgressFn | None = None,
        cancel: asyncio.Event | None = None,
    ) -> Answer:
        site = self.site
        started_at = datetime.now(timezone.utc)
        t0 = time.monotonic()
        artifacts: list[str] = []

        def fail(kind: FailureKind, detail: str) -> Answer:
            return Answer.failed(
                self.id,
                self.display_name,
                kind,
                detail,
                started_at=started_at,
                latency_ms=int((time.monotonic() - t0) * 1000),
                artifacts=artifacts,
            )

        try:
            await self._emit(on_event, ProviderState.LAUNCHING, started=t0)
            # Sites that tolerate it run fully headless -- no window and no
            # taskbar entry. The Cloudflare-fronted ones fall back to an
            # off-screen window, which still shows a taskbar icon but is the
            # only way they work at all.
            async with launcher.launch(
                self.id,
                self.settings.browser,
                headless=True if site.headless_ok else None,
            ) as browser_ctx:
                page = browser_ctx.pages[0] if browser_ctx.pages else await browser_ctx.new_page()

                # -- navigate ------------------------------------------------
                await self._emit(on_event, ProviderState.NAVIGATING, started=t0)
                try:
                    await page.goto(site.url, timeout=site.nav_timeout_s * 1000)
                except Exception as e:
                    return fail(FailureKind.NAVIGATION, str(e)[:400])
                await asyncio.sleep(self.settings.pacing.sample_post_nav())

                if cancel is not None and cancel.is_set():
                    return fail(FailureKind.CANCELLED, "Cancelled before sending.")

                # -- bot challenge -------------------------------------------
                if await resolve.is_challenge_page(page, site.challenge_selectors):
                    artifacts = await self._save_artifacts(page, "challenge")
                    return fail(
                        FailureKind.BOT_CHALLENGE,
                        f"{self.display_name} showed a human-verification page. "
                        f"Run `python -m magi login {self.id}` and clear it by hand.",
                    )

                # -- composer -------------------------------------------------
                box = await resolve.resolve(
                    page, site.input, timeout_ms=site.ready_timeout_s * 1000
                )
                if box is None:
                    artifacts = await self._save_artifacts(page, "no-input")
                    if await resolve.signed_out(page, site.login_selectors):
                        return fail(
                            FailureKind.NOT_LOGGED_IN,
                            f"No composer found on {self.display_name} and a login "
                            f"control is showing. Run `python -m magi login {self.id}`.",
                        )
                    return fail(
                        FailureKind.SELECTOR_MISS,
                        f"No 'input' selector matched on {self.display_name}. "
                        f"Tried {len(site.input)}. Run `python -m magi doctor`.",
                    )

                # A quota notice sits on top of a perfectly working page, so
                # this must be checked BEFORE typing: otherwise the prompt goes
                # in, the send appears to land, and nothing ever streams -- the
                # exact shape that got reported as a timeout with "the send may
                # not have registered, or the assistant_turn selector is wrong".
                limit = await resolve.rate_limited(page, site.rate_limit_selectors)
                if limit:
                    artifacts = await self._save_artifacts(page, "rate-limited")
                    return fail(
                        FailureKind.RATE_LIMITED,
                        f"{self.display_name} says: {limit}",
                    )

                # A composer is NOT proof of a session. Gemini and ChatGPT both
                # render one for anonymous visitors, so this check used to be
                # reachable only when the composer was MISSING -- which meant a
                # logged-out member answered normally, on the free tier, and the
                # verdict counted it as a full vote with nothing anywhere saying
                # which tier had spoken. Failing loudly is the whole point of
                # FailureKind: a wrong answer presented as a good one is the one
                # outcome this system must not produce.
                if await resolve.signed_out(page, site.login_selectors):
                    artifacts = await self._save_artifacts(page, "signed-out")
                    return fail(
                        FailureKind.NOT_LOGGED_IN,
                        f"{self.display_name} is signed OUT -- it shows a composer to "
                        f"anonymous visitors, so this would have answered on the free "
                        f"tier. Run `python -m magi login {self.id}`.",
                    )

                # -- attachments, before typing (matches how a person uses the
                # composer: attach first, then write the message about them) --
                if ctx.attachments:
                    file_box = await resolve.resolve(
                        page, site.file_input, timeout_ms=3000, require_visible=False
                    )
                    if file_box is None:
                        artifacts = await self._save_artifacts(page, "no-file-input")
                        return fail(
                            FailureKind.SELECTOR_MISS,
                            f"No 'file_input' selector matched on {self.display_name}, "
                            f"so the {len(ctx.attachments)} attachment(s) could not be "
                            f"sent. Run `python -m magi doctor`.",
                        )
                    try:
                        await file_box.locator.first.set_input_files(
                            [str(p) for p in ctx.attachments]
                        )
                        # Sites render the upload preview and finish reading the
                        # file asynchronously after set_input_files resolves, so
                        # a short pause here gives that a chance to settle before
                        # the message is typed and sent.
                        await asyncio.sleep(self.settings.pacing.sample_post_nav())
                    except Exception as e:
                        artifacts = await self._save_artifacts(page, "attach-failed")
                        return fail(
                            FailureKind.SELECTOR_MISS,
                            f"Could not attach files: {str(e)[:300]}",
                        )

                # -- clear whatever the site painted over its own composer ----
                # Before the baseline, so a dialog closing cannot be mistaken
                # for the page changing, and before typing, so the click below
                # is not fighting it. Costs a few milliseconds when there is
                # nothing to close, which is the usual case; when there is, it
                # is the difference between a run and a dead unit. A cookie
                # card over Perplexity's composer is what put this here.
                await overlay.dismiss(page, site.dismiss_selectors)

                # -- baseline BEFORE sending ----------------------------------
                baseline = await completion.capture_baseline(page, site)

                # -- type + send ----------------------------------------------
                await self._emit(on_event, ProviderState.TYPING, started=t0)
                # Get the caret in FIRST, and separately from typing, so the two
                # failures stay distinguishable: something covering the composer
                # is not a broken selector and must not be reported as one.
                try:
                    await overlay.focus_composer(
                        page, box.locator.first,
                        dismiss_selectors=site.dismiss_selectors,
                    )
                except Exception as e:
                    blocked = await overlay.blocker(box.locator.first)
                    artifacts = await self._save_artifacts(page, "composer-blocked")
                    if blocked:
                        return fail(
                            FailureKind.OVERLAY_BLOCKED,
                            f"{self.display_name}'s composer is covered by "
                            f"'{blocked}', which none of this site's "
                            f"dismiss_selectors closed.",
                        )
                    return fail(
                        FailureKind.OVERLAY_BLOCKED,
                        f"Could not put the caret in {self.display_name}'s "
                        f"composer: {str(e)[:200]}",
                    )
                try:
                    # insert_text types short prompts and pastes long ones --
                    # the synthesis prompt is far too long to type at human
                    # speed without dominating the run time.
                    await humanize.insert_text(
                        page, box.locator.first,
                        DIRECT_ANSWER_PREAMBLE + question,
                        self.settings.pacing,
                    )
                except Exception as e:
                    artifacts = await self._save_artifacts(page, "type-failed")
                    return fail(FailureKind.SELECTOR_MISS, f"Could not type: {str(e)[:300]}")

                submit = await resolve.resolve(page, site.submit, timeout_ms=3000)
                await humanize.send(
                    page,
                    submit.locator.first if submit else None,
                    site.send_key,
                    self.settings.pacing,
                    # Passed so the click can be CONFIRMED: a present-but-inert
                    # send button reports a successful click while leaving the
                    # prompt in the box, and the fallback Enter never ran.
                    composer=box.locator.first,
                )
                await self._emit(on_event, ProviderState.WAITING, started=t0)

                # -- wait ------------------------------------------------------
                async def on_progress(text: str) -> None:
                    await self._emit(
                        on_event, ProviderState.STREAMING, text=text, started=t0
                    )

                # Artifacts are captured HERE, inside the browser context, not
                # in the `except ProviderError` at the bottom of this method --
                # that handler runs after `async with launcher.launch(...)` has
                # already torn the browser down, so there is no page left to
                # photograph. Every timeout therefore recorded artifacts: [],
                # which is precisely the failure where a screenshot is the only
                # way to tell "the send never registered" from "the site
                # redesigned its answer container".
                try:
                    result = await completion.wait_for_completion(
                        page, site, baseline=baseline,
                        on_progress=on_progress, cancel=cancel,
                    )
                except ProviderError as e:
                    # A quota notice can appear DURING a run -- the limit is
                    # per rolling window, so a member that started fine can be
                    # cut off mid-answer. Re-checking here turns "timeout, go
                    # edit your selectors" into "you are out of quota until
                    # 5pm", which is the difference between a wasted afternoon
                    # and waiting.
                    limit = await resolve.rate_limited(page, site.rate_limit_selectors)
                    if limit:
                        artifacts = await self._save_artifacts(page, "rate-limited")
                        return fail(
                            FailureKind.RATE_LIMITED,
                            f"{self.display_name} says: {limit}",
                        )
                    artifacts = await self._save_artifacts(page, str(e.kind))
                    raise

                # Strip UI chrome (citation pills, injected ads) before this text
                # can reach the synthesis prompt.
                cleaned = extract.clean(result.text, site.strip_patterns)

                if not cleaned.strip():
                    artifacts = await self._save_artifacts(page, "empty")
                    return fail(
                        FailureKind.EMPTY_RESPONSE,
                        f"{self.display_name} produced no text.",
                    )

                # A mechanically successful scrape is not necessarily an answer.
                # Verified live: Claude returned a 23-char clarifying question
                # that was counted as a full vote and reported as consensus.
                # Checked here rather than in the orchestrator so the artifacts
                # are still available for diagnosis.
                verdict = validate.validate_answer(
                    cleaned, question, display_name=self.display_name
                )
                if not verdict.ok:
                    artifacts = await self._save_artifacts(page, "degraded")
                    await self._emit(
                        on_event,
                        ProviderState.DEGRADED,
                        text=cleaned,
                        started=t0,
                        message=verdict.summary,
                    )
                    a = Answer.degraded_capture(
                        self.id,
                        self.display_name,
                        cleaned,
                        verdict.summary,
                        started_at=started_at,
                        latency_ms=int((time.monotonic() - t0) * 1000),
                        completion_reason=str(result.reason),
                    )
                    a.artifacts = artifacts
                    return a

                await self._emit(on_event, ProviderState.DONE, text=cleaned, started=t0)
                return Answer(
                    provider_id=self.id,
                    display_name=self.display_name,
                    text=cleaned,
                    ok=True,
                    state=ProviderState.DONE,
                    completion_reason=str(result.reason),
                    low_confidence=result.low_confidence,
                    started_at=started_at,
                    ended_at=datetime.now(timezone.utc),
                    latency_ms=int((time.monotonic() - t0) * 1000),
                    chars=len(cleaned),
                    provider_kind=self.kind,
                )

        except ProviderError as e:
            return fail(e.kind, e.detail)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            return fail(FailureKind.UNKNOWN, f"{type(e).__name__}: {str(e)[:400]}")

    # ----------------------------------------------------------------- health

    async def health_check(self, *, deep: bool = False) -> HealthReport:
        site = self.site
        report = HealthReport(
            provider_id=self.id, display_name=self.display_name,
            reachable=False, logged_in=False,
        )
        try:
            async with launcher.launch(self.id, self.settings.browser) as ctx:
                page = ctx.pages[0] if ctx.pages else await ctx.new_page()
                try:
                    await page.goto(site.url, timeout=site.nav_timeout_s * 1000)
                except Exception as e:
                    report.error = f"Navigation failed: {str(e)[:200]}"
                    return report
                await asyncio.sleep(self.settings.pacing.sample_post_nav())
                await asyncio.sleep(3)  # let hydration settle before probing

                report.reachable = True
                report.challenged = await resolve.is_challenge_page(
                    page, site.challenge_selectors
                )
                if report.challenged:
                    report.notes.append(
                        "A bot-verification page is showing. Selector results below "
                        "are meaningless until it is cleared."
                    )

                # What a run would hit before it could type. Checked BEFORE
                # the dialogs are cleared, because "a cookie banner is over
                # your composer every time" is a finding, not a detail -- and
                # then cleared, so the probes below see the page a run sees.
                blocked = ""
                # The site's OWN ready timeout, not a flat sleep. Measured on
                # perplexity.ai: with two dialogs to render, the composer was
                # not there three seconds after navigation, and the doctor
                # reported `input` and `ready_selector` as MISS -- a false
                # alarm whose printed remedy is "update them in
                # selectors.yaml", against selectors that were perfectly fine.
                # A run has always waited this long for the composer; the
                # health check that is supposed to be the more careful of the
                # two was the one giving up early.
                box = await resolve.resolve(
                    page, site.input, timeout_ms=site.ready_timeout_s * 1000
                )
                if box is not None:
                    blocked = await overlay.blocker(box.locator.first)
                closed = await overlay.dismiss(page, site.dismiss_selectors)
                if blocked:
                    still = ""
                    if box is not None:
                        still = await overlay.blocker(box.locator.first)
                    if still:
                        report.notes.append(
                            f"Something is covering the composer ({still!r}) and "
                            f"none of this site's dismiss_selectors closed it. A run "
                            f"will still get the prompt in -- it focuses the composer "
                            f"rather than clicking it -- but add the button that "
                            f"closes this to dismiss_selectors in selectors.yaml."
                        )
                    else:
                        report.notes.append(
                            f"A dialog was covering the composer ({blocked!r}); "
                            f"clicking {', '.join(closed) or 'it'} closed it. Runs do "
                            f"the same thing automatically, so this is handled."
                        )

                fields = {
                    "input": site.input,
                    "submit": site.submit,
                    "assistant_turn": site.assistant_turn,
                    "stop_button": site.stop_button,
                    "streaming_marker": site.streaming_marker,
                    "ready_selector": site.ready_selector,
                    "login_selectors": site.login_selectors,
                    "challenge_selectors": site.challenge_selectors,
                }
                # Prime the composer so the send button -- which does not exist
                # on an empty composer on claude.ai and gemini.google.com -- is
                # actually present to be probed. Without this, a correct
                # `submit` selector is reported as MISS on every idle page.
                for p in await resolve.probe_all(page, fields, prime=True):
                    report.selectors.append(
                        SelectorProbe(
                            field=p.field, matched=p.matched, count=p.count,
                            tried=p.tried, status=str(p.status), note=p.note,
                        )
                    )

                has_input = any(p.field == "input" and p.ok for p in report.selectors)
                has_login = any(
                    p.field == "login_selectors" and p.ok for p in report.selectors
                )
                # A composer is what matters. Some sites (ChatGPT) show a login
                # button permanently even when usable, so its presence alone
                # does not mean logged out.
                report.logged_in = has_input and not (has_login and site.login_is_proof)
                if has_input and has_login and not site.login_is_proof:
                    report.notes.append(
                        "A login control is visible but the composer works "
                        "(this site allows logged-out use)."
                    )
                elif has_input and has_login:
                    report.notes.append(
                        "Signed OUT: this site shows a sign-in wall, so a "
                        "composer on the page is not proof of a session."
                    )
                elif not has_input and has_login:
                    report.notes.append(
                        f"Logged out. Run `python -m magi login {self.id}`."
                    )

                for p in report.selectors:
                    if p.ok and p.tried and p.matched != p.tried[0]:
                        report.notes.append(
                            f"'{p.field}' fell back to a later candidate "
                            f"({p.matched!r}); the preferred selector is stale."
                        )

                # Only genuine faults are called out. Fields that simply cannot
                # match on an idle page are not mentioned at all -- listing them
                # as problems is what made a healthy install look broken.
                faults = [p.field for p in report.selectors if p.is_fault]
                if faults:
                    report.notes.append(
                        f"Selectors that should have matched but did not: "
                        f"{', '.join(faults)}. Update them in config/selectors.yaml."
                    )

                report.screenshot_path = (
                    (await self._save_artifacts(page, "health")) or [None]
                )[0]
        except ProviderError as e:
            report.error = f"{e.kind}: {e.detail}"
        except Exception as e:
            report.error = f"{type(e).__name__}: {str(e)[:200]}"
        return report
