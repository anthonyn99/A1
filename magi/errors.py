"""Failure taxonomy.

The whole point of this module is that MAGI never reports a failure as an
answer. The original proof-of-concept did `except Exception as e: answer =
f"[ERROR: {e}]"`, which meant a crash and a real response were the same type
flowing into the same field -- a synthesis step downstream would happily treat
"[ERROR: Timeout]" as one model's considered opinion.

Here, a failure is a distinct kind with a cause the UI can explain and, where
possible, a concrete action the user can take.
"""

from __future__ import annotations

from enum import StrEnum


class FailureKind(StrEnum):
    NOT_LOGGED_IN = "not_logged_in"
    SELECTOR_MISS = "selector_miss"
    # The composer was found and is correct -- something was sitting on top of
    # it. Split out from SELECTOR_MISS because that kind's remedy is "rewrite
    # selectors.yaml", which is exactly the wrong thing to go and do when the
    # selector matched perfectly. See browser/overlay.py.
    OVERLAY_BLOCKED = "overlay_blocked"
    TIMEOUT = "timeout"
    BOT_CHALLENGE = "bot_challenge"
    RATE_LIMITED = "rate_limited"
    NAVIGATION = "navigation"
    EMPTY_RESPONSE = "empty_response"
    BROWSER_CRASH = "browser_crash"
    PROFILE_LOCKED = "profile_locked"
    CANCELLED = "cancelled"
    UNKNOWN = "unknown"


# Plain-language cause + remedy, surfaced directly in the UI panel.
EXPLANATIONS: dict[FailureKind, tuple[str, str]] = {
    FailureKind.NOT_LOGGED_IN: (
        "This site's saved session is not logged in.",
        "Run `python -m magi login <site>` and sign in in the window that opens.",
    ),
    FailureKind.SELECTOR_MISS: (
        "The configured selectors no longer match this site's page.",
        "Run `python -m magi doctor` to see which selector failed, then add a "
        "working one to the top of that list in config/selectors.yaml.",
    ),
    FailureKind.OVERLAY_BLOCKED: (
        "Something on the page was covering the composer, so the prompt could "
        "not be entered. The selectors are fine.",
        "Usually a cookie or privacy dialog. Add the button that closes it to "
        "that site's `dismiss_selectors` in config/selectors.yaml -- the cause "
        "above names it.",
    ),
    FailureKind.TIMEOUT: (
        "The model did not finish answering within the time limit.",
        "Raise hard_timeout_s for this site in config/selectors.yaml, or retry.",
    ),
    FailureKind.BOT_CHALLENGE: (
        "The site presented a human-verification challenge.",
        "Run `python -m magi login <site>`, clear the challenge by hand, then "
        "retry. Slowing pacing in config/magi.yaml makes this less frequent.",
    ),
    FailureKind.RATE_LIMITED: (
        "The site says you have hit a usage limit.",
        "Wait for the quota to reset, or disable this provider in config/magi.yaml.",
    ),
    FailureKind.NAVIGATION: (
        "The page failed to load.",
        "Check your network connection and that the URL in selectors.yaml is right.",
    ),
    FailureKind.EMPTY_RESPONSE: (
        "A response element was found but contained no text.",
        "Usually a selector pointing at the wrong element. Run `python -m magi doctor`.",
    ),
    FailureKind.BROWSER_CRASH: (
        "The browser closed unexpectedly.",
        "Retry. If it repeats, delete this site's folder under profiles/ and log in again.",
    ),
    FailureKind.PROFILE_LOCKED: (
        "This site's browser profile is already open in another process.",
        "Close any MAGI browser windows and retry. MAGI never uses your personal "
        "Chrome profile, so your normal browser can stay open.",
    ),
    FailureKind.CANCELLED: (
        "The run was cancelled.",
        "",
    ),
    FailureKind.UNKNOWN: (
        "An unexpected error occurred.",
        "Check the error detail and the saved screenshot under artifacts/.",
    ),
}


def explain(kind: FailureKind) -> tuple[str, str]:
    return EXPLANATIONS.get(kind, EXPLANATIONS[FailureKind.UNKNOWN])


class ProviderError(Exception):
    """Raised inside a provider; converted to a failed Answer at the boundary."""

    def __init__(self, kind: FailureKind, detail: str = ""):
        self.kind = kind
        self.detail = detail
        super().__init__(f"{kind}: {detail}")
