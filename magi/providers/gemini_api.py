"""API-backed Gemini provider.

Exists for one reason: latency. Every other council member answers through a
real browser session, which is the only way to use a paid chat subscription --
but it costs a Chrome launch, a page load and a scrape-until-stable poll loop
before a single character comes back. That price is worth paying for the
council, where four models deliberate. It is not worth paying for the refiner,
which is one short turn whose whole job is to hand the composer a better
sentence before anyone has committed to anything.

This talks to generativelanguage.googleapis.com directly over HTTP, so a
refine costs one request instead of a browser. It implements the same Provider
interface as BrowserProvider, which is what lets engine/refine.py stay
completely unchanged -- it already speaks only `provider.ask()`.

Deliberately NOT wired into the council: those members are browser-driven on
purpose (paid subscriptions, no per-token cost), and mixing an API member into
quorum counting and window tiling would be a change to the council's meaning,
not just its speed.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from ..errors import FailureKind
from ..settings import ROOT
from .base import (
    Answer,
    HealthReport,
    Provider,
    ProviderEvent,
    ProviderState,
    ProgressFn,
    RunContext,
)

API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"

# Flash rather than Pro: the refiner rewrites one sentence, and the difference
# between the two on that task is not measurable, while the latency difference
# is the entire point of this module.
#
# Pinned to an exact version rather than the `gemini-flash-latest` alias, which
# is tempting but wrong here. Measured 2026-08-22 on the real refine prompt:
#
#     gemini-3.5-flash      2.7-3.4s   never failed
#     gemini-3.6-flash      5.1-14.0s  intermittent 503
#     gemini-3.7-flash      3.0-12.5s  intermittent 503
#     gemini-flash-latest  14.1-30.2s  503 under load
#
# The newest model is not the fastest -- the just-released ones are under heavy
# demand and shed load, and the floating alias currently resolves to one of
# them. An alias that silently repoints at a 30s model would quietly undo the
# entire reason this module exists, so the version is pinned and re-measured
# deliberately. If this one is ever retired the API says so in a 404 naming its
# replacement, which is a loud, actionable failure rather than a slow one.
DEFAULT_MODEL = "gemini-3.5-flash"

ENV_KEYS = ("GEMINI_API_KEY", "GOOGLE_API_KEY")


def load_api_key() -> str:
    """Find the key in the environment, falling back to a .env at the repo root.

    A real environment variable wins, so a shell export or a CI secret can
    override the file without editing it. The .env fallback exists because the
    alternative is asking someone to set a permanent Windows environment
    variable before they can use a button in a local app.

    The key is read fresh on every call rather than cached at import: adding it
    to .env should not require restarting the server to take effect.
    """
    for name in ENV_KEYS:
        val = os.environ.get(name, "").strip()
        if val:
            return val

    env_file = ROOT / ".env"
    try:
        raw = env_file.read_text(encoding="utf-8")
    except OSError:
        return ""

    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, val = line.partition("=")
        if name.strip() in ENV_KEYS:
            # Tolerate quoted values -- pasting a key between quotes is the
            # single most likely way to hand-edit this file wrongly, and a key
            # that silently carries a trailing quote fails with an opaque 400.
            return val.strip().strip('"').strip("'").strip()
    return ""


class MissingKey(RuntimeError):
    """Raised at construction so the API layer can answer 400 rather than 502."""


class GeminiAPIProvider(Provider):
    kind = "api"

    def __init__(
        self,
        *,
        api_key: str = "",
        model: str = DEFAULT_MODEL,
        provider_id: str = "gemini-api",
        display_name: str = "Gemini",
        accent: str = "#4A7DBE",
        timeout_s: int = 60,
    ):
        key = (api_key or load_api_key()).strip()
        if not key:
            raise MissingKey(
                "No Gemini API key. Put GEMINI_API_KEY=<your key> in a .env "
                "file at the MAGI project root, or set it as an environment "
                "variable. Get a key at https://aistudio.google.com/apikey"
            )
        self._key = key
        self.model = model
        self.id = provider_id
        self.display_name = display_name
        self.accent = accent
        self.timeout_s = timeout_s

    # ------------------------------------------------------------------ HTTP

    def _post_sync(self, prompt: str) -> tuple[str, str | None]:
        """Blocking POST. Returns (text, error). Never raises for an expected
        failure -- the Provider contract is that `ask` reports failure as data.

        urllib rather than httpx/aiohttp so this adds no dependency: it is one
        JSON POST, and the async-ness that matters is handled by running this
        in a thread.
        """
        url = f"{API_ROOT}/{self.model}:generateContent"
        body = json.dumps(
            {
                "contents": [{"parts": [{"text": prompt}]}],
                # The refiner's output is a rewritten prompt, and creative
                # variation in it is not a feature -- it makes the same
                # question rewrite differently each press for no benefit.
                "generationConfig": {"temperature": 0.3},
            }
        ).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": self._key,
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:400]
            # The key is the one thing a user can actually fix, so 401/403 gets
            # a specific message instead of a raw API error blob.
            if e.code in (401, 403):
                return "", (
                    "Gemini rejected the API key (HTTP "
                    f"{e.code}). Check GEMINI_API_KEY in your .env."
                )
            if e.code == 429:
                return "", "Gemini API rate limit or quota exceeded (HTTP 429)."
            # A retired model answers 404 with a message naming its replacement.
            # Worth pulling out of the JSON blob: it is the failure most likely
            # to appear months from now, and it is fixed by editing one
            # constant -- but only if the message actually reaches the user.
            if e.code == 404:
                msg = self._error_message(detail)
                return "", (
                    f"Gemini model {self.model!r} is unavailable. {msg} "
                    "Update DEFAULT_MODEL in providers/gemini_api.py."
                )
            # 503 means the model is shedding load, not that anything is
            # misconfigured -- say so, so it is not mistaken for a broken key.
            if e.code == 503:
                return "", (
                    f"Gemini model {self.model!r} is temporarily overloaded "
                    "(HTTP 503). Try again in a moment."
                )
            return "", f"Gemini API error (HTTP {e.code}): {detail}"
        except urllib.error.URLError as e:
            return "", f"Could not reach the Gemini API: {e.reason}"
        except (TimeoutError, OSError) as e:
            return "", f"Gemini API request failed: {e}"
        except json.JSONDecodeError:
            return "", "Gemini API returned a response that was not JSON."

        return self._extract(payload)

    @staticmethod
    def _error_message(body: str) -> str:
        """Pull `error.message` out of an API error body, or return it as-is.

        Falls back to the raw body rather than swallowing it: an unparseable
        error is still better shown than replaced with "unknown error".
        """
        try:
            return (json.loads(body).get("error") or {}).get("message", body).strip()
        except (json.JSONDecodeError, AttributeError):
            return body.strip()

    @staticmethod
    def _extract(payload: dict) -> tuple[str, str | None]:
        """Pull the text out of a generateContent response.

        A blocked or truncated response comes back as a well-formed 200 with no
        text in it, which must be reported as a failure -- returning "" as
        though it were an answer is exactly the bug errors.py exists to prevent.
        """
        if "error" in payload:
            msg = (payload.get("error") or {}).get("message", "unknown error")
            return "", f"Gemini API error: {msg}"

        candidates = payload.get("candidates") or []
        if not candidates:
            fb = (payload.get("promptFeedback") or {}).get("blockReason")
            if fb:
                return "", f"Gemini refused the prompt (blocked: {fb})."
            return "", "Gemini returned no candidates."

        cand = candidates[0]
        parts = ((cand.get("content") or {}).get("parts")) or []
        text = "".join(p.get("text", "") for p in parts).strip()

        if not text:
            reason = cand.get("finishReason", "")
            if reason and reason != "STOP":
                return "", f"Gemini stopped without answering (finishReason: {reason})."
            return "", "Gemini returned an empty response."

        return text, None

    # ------------------------------------------------------------------- ask

    async def ask(
        self,
        question: str,
        *,
        ctx: RunContext,
        on_event: ProgressFn | None = None,
        cancel: asyncio.Event | None = None,
    ) -> Answer:
        started = datetime.now(timezone.utc)
        t0 = time.monotonic()

        if on_event:
            await on_event(
                ProviderEvent(provider_id=self.id, state=ProviderState.WAITING)
            )

        # to_thread keeps the event loop free: this is a blocking socket call,
        # and the API layer serves other requests while it is in flight.
        task = asyncio.create_task(asyncio.to_thread(self._post_sync, question))

        if cancel is not None:
            cancel_wait = asyncio.create_task(cancel.wait())
            done, _ = await asyncio.wait(
                {task, cancel_wait}, return_when=asyncio.FIRST_COMPLETED
            )
            if task not in done:
                task.cancel()
                cancel_wait.cancel()
                return Answer.failed(
                    self.id,
                    self.display_name,
                    FailureKind.CANCELLED,
                    "Cancelled before Gemini responded.",
                    started_at=started,
                    latency_ms=int((time.monotonic() - t0) * 1000),
                    provider_kind=self.kind,
                )
            cancel_wait.cancel()

        text, error = await task
        ms = int((time.monotonic() - t0) * 1000)

        if error:
            kind = FailureKind.UNKNOWN
            low = error.lower()
            if "rate limit" in low or "quota" in low or "overloaded" in low:
                kind = FailureKind.RATE_LIMITED
            elif "could not reach" in low:
                kind = FailureKind.NAVIGATION
            elif "api key" in low:
                kind = FailureKind.NOT_LOGGED_IN
            elif "empty response" in low or "no candidates" in low:
                kind = FailureKind.EMPTY_RESPONSE
            elif "timed out" in low or "timeout" in low:
                kind = FailureKind.TIMEOUT

            if on_event:
                await on_event(
                    ProviderEvent(
                        provider_id=self.id,
                        state=ProviderState.FAILED,
                        message=error,
                    )
                )
            return Answer.failed(
                self.id,
                self.display_name,
                kind,
                error,
                started_at=started,
                latency_ms=ms,
                provider_kind=self.kind,
            )

        if on_event:
            await on_event(
                ProviderEvent(
                    provider_id=self.id,
                    state=ProviderState.DONE,
                    partial_text=text,
                    chars=len(text),
                    elapsed_ms=ms,
                )
            )

        return Answer(
            provider_id=self.id,
            display_name=self.display_name,
            text=text,
            ok=True,
            state=ProviderState.DONE,
            started_at=started,
            ended_at=datetime.now(timezone.utc),
            latency_ms=ms,
            chars=len(text),
            provider_kind=self.kind,
        )

    # ---------------------------------------------------------------- health

    async def health_check(self, *, deep: bool = False) -> HealthReport:
        """No selectors and no login -- reachability is the only real question.

        `logged_in` maps to "the key was accepted", which is the API-side
        equivalent and keeps doctor's output meaningful for this provider.
        """
        if not deep:
            return HealthReport(
                provider_id=self.id,
                display_name=self.display_name,
                reachable=True,
                logged_in=bool(self._key),
                notes=[f"API provider ({self.model}); no browser profile."],
            )

        text, error = await asyncio.to_thread(self._post_sync, "Reply with: ok")
        return HealthReport(
            provider_id=self.id,
            display_name=self.display_name,
            reachable=error is None or "could not reach" not in error.lower(),
            logged_in=error is None,
            notes=[f"API provider ({self.model})."]
            + ([f"Replied: {text[:40]}"] if text else []),
            error=error,
        )
