"""The Provider interface -- the load-bearing abstraction in MAGI.

The engine, the API layer, the database and the UI all speak only this
interface. Browser automation is one implementation; an API-backed provider can
be added later without any of them changing. That seam is deliberate: browser
scraping is fragile and against these sites' terms, so the cost of switching
must stay near zero.

Design rule enforced throughout: `ask()` NEVER raises for an expected failure
and NEVER invents text. It returns an Answer with ok=False and a specific
FailureKind. A failure and an opinion must never be the same value.
"""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import StrEnum
from pathlib import Path
from typing import Awaitable, Callable, Literal

from ..errors import FailureKind


class ProviderState(StrEnum):
    IDLE = "idle"
    QUEUED = "queued"
    LAUNCHING = "launching"
    NAVIGATING = "navigating"
    AUTH_REQUIRED = "auth_required"
    TYPING = "typing"
    WAITING = "waiting"
    STREAMING = "streaming"
    DONE = "done"
    # Text came back, but it is not an answer -- a clarifying question, a
    # captured preamble, or a stale turn. Distinct from both DONE and FAILED on
    # purpose: the member DID respond (so calling it offline is a lie) but its
    # text must not reach the synthesis (so calling it done is a worse one).
    DEGRADED = "degraded"
    FAILED = "failed"
    SKIPPED = "skipped"


TERMINAL_STATES = {
    ProviderState.DONE,
    ProviderState.DEGRADED,
    ProviderState.FAILED,
    ProviderState.SKIPPED,
}


@dataclass
class ProviderEvent:
    """Progress emitted while a provider works; forwarded to the UI over SSE."""

    provider_id: str
    state: ProviderState
    partial_text: str = ""
    chars: int = 0
    elapsed_ms: int = 0
    message: str = ""


@dataclass
class Answer:
    """The result of asking one council member one question."""

    provider_id: str
    display_name: str
    text: str
    ok: bool
    state: ProviderState
    failure: FailureKind | None = None
    error_detail: str | None = None
    completion_reason: str = ""
    low_confidence: bool = False
    # Set when the capture failed post-capture validation (engine/validate.py).
    # `ok` stays False for these, so every existing quorum count and synthesis
    # filter excludes them automatically rather than needing to learn a new
    # rule -- but the text is KEPT, so the UI can show the user what actually
    # came back and why it was rejected.
    degraded: bool = False
    degraded_reason: str = ""
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    ended_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    latency_ms: int = 0
    chars: int = 0
    artifacts: list[str] = field(default_factory=list)
    provider_kind: str = "browser"

    @classmethod
    def failed(
        cls,
        provider_id: str,
        display_name: str,
        kind: FailureKind,
        detail: str,
        *,
        started_at: datetime | None = None,
        latency_ms: int = 0,
        artifacts: list[str] | None = None,
        provider_kind: str = "browser",
    ) -> "Answer":
        now = datetime.now(timezone.utc)
        return cls(
            provider_id=provider_id,
            display_name=display_name,
            text="",                       # never a placeholder or error string
            ok=False,
            state=ProviderState.FAILED,
            failure=kind,
            error_detail=detail,
            started_at=started_at or now,
            ended_at=now,
            latency_ms=latency_ms,
            chars=0,
            artifacts=artifacts or [],
            provider_kind=provider_kind,
        )

    @classmethod
    def degraded_capture(
        cls,
        provider_id: str,
        display_name: str,
        text: str,
        reason: str,
        *,
        started_at: datetime | None = None,
        latency_ms: int = 0,
        completion_reason: str = "",
    ) -> "Answer":
        """A member responded, but the text is not a usable answer.

        Unlike `failed`, the text is retained -- the user needs to see what came
        back to understand why it was rejected (a clarifying question means
        their prompt was ambiguous, which is useful, not noise). `ok` is False
        so it cannot leak into the synthesis or the responded count.
        """
        now = datetime.now(timezone.utc)
        return cls(
            provider_id=provider_id,
            display_name=display_name,
            text=text,
            ok=False,
            state=ProviderState.DEGRADED,
            failure=None,
            error_detail=reason,
            completion_reason=completion_reason,
            degraded=True,
            degraded_reason=reason,
            started_at=started_at or now,
            ended_at=now,
            latency_ms=latency_ms,
            chars=len(text),
        )


@dataclass
class SelectorProbe:
    field: str
    matched: str | None
    count: int
    tried: list[str]
    # How to READ a non-match: a real fault, or a field that could not have
    # matched in this page state. See browser/resolve.ProbeStatus.
    status: str = "miss"
    note: str = ""

    @property
    def ok(self) -> bool:
        return self.matched is not None

    @property
    def is_fault(self) -> bool:
        """Whether this result is evidence of something actually broken."""
        return self.status == "miss"


@dataclass
class HealthReport:
    """Result of `magi doctor` for one provider."""

    provider_id: str
    display_name: str
    reachable: bool
    logged_in: bool
    challenged: bool = False
    selectors: list[SelectorProbe] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    screenshot_path: str | None = None
    error: str | None = None

    @property
    def usable(self) -> bool:
        """Whether a run against this provider is worth attempting.

        Only `input` is genuinely required. Deliberately NOT requiring:

        * `assistant_turn` -- on an empty chat there is no answer on the page
          yet, so it cannot match. Reporting a working site as broken because
          of that made doctor useless (it flagged 3 of 4 healthy providers).
          Its correctness is proven by actually asking a question.
        * `submit` -- some sites (DeepSeek) have no stable send-button
          selector and are driven by the Enter key instead, which is a
          supported configuration, not a fault.
        """
        if not self.reachable or self.challenged:
            return False
        return any(p.field == "input" and p.ok for p in self.selectors)


@dataclass
class RunContext:
    """Per-run context handed to every provider."""

    run_id: str
    question: str
    # Files staged to disk for this run, shared read-only across every member
    # -- each provider attaches the same set to its own composer.
    attachments: list[Path] = field(default_factory=list)


ProgressFn = Callable[[ProviderEvent], Awaitable[None]]


class Provider(ABC):
    """One council member."""

    id: str
    display_name: str
    kind: Literal["browser", "api"] = "browser"
    accent: str = "#8D769A"

    @abstractmethod
    async def ask(
        self,
        question: str,
        *,
        ctx: RunContext,
        on_event: ProgressFn | None = None,
        cancel: asyncio.Event | None = None,
    ) -> Answer:
        """Ask one question. Returns an Answer; does not raise for expected failures."""

    @abstractmethod
    async def health_check(self, *, deep: bool = False) -> HealthReport:
        """Report whether this provider is currently usable, and why not if not."""

    async def startup(self) -> None:
        return None

    async def shutdown(self) -> None:
        return None
