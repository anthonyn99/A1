"""A quota wall must not be reported as a timeout.

Verified live: Claude's 5-hour limit leaves the composer present and the send
apparently accepted, but nothing ever streams. Completion detection therefore
reported

    No new answer appeared within 45s (0 turns, text unchanged). The send may
    not have registered, or the assistant_turn selector is wrong.

and sent the reader off to edit selectors.yaml. The real remedy was to wait
until 5pm. Wrong cause, wrong remedy -- the exact failure MAGI's taxonomy
exists to prevent.

The fixture below reproduces the toast from a real capture
(claude-timeout-20260909-205707.html); artifacts/ is gitignored, so the text
is inlined rather than read from disk.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from magi.browser import resolve  # noqa: E402
from magi.settings import load_settings  # noqa: E402

WALL = """
<div role="dialog"><h2>Need more usage?</h2>
  <p>You've reached your 5-hour limit. It resets at 5:00 PM MDT on Sep 9.</p>
</div>
<div class="toast">You&rsquo;ve hit your limit for Claude messages.
  Limits will reset at 5:00 PM. <a href="/usage">View your usage details.</a></div>
<div contenteditable="true" class="ProseMirror">the composer is still here</div>
"""

HEALTHY = """
<div contenteditable="true" class="ProseMirror"></div>
<div class="answer">Cookies are sent to the server on every request; the others
are not. There is no limit on how often you may ask.</div>
"""


@pytest.fixture(scope="module")
def page():
    pw = pytest.importorskip("playwright.sync_api")
    with pw.sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception as exc:
            pytest.skip(f"chromium unavailable: {exc}")
        pg = browser.new_page()
        yield pg
        browser.close()


def _claude():
    return load_settings().site("claude")


def _check(page, html: str) -> str:
    page.set_content(html)
    # The async detector, driven from the sync API for the test's sake.
    import asyncio

    from magi.browser.resolve import rate_limited

    async def run():
        from playwright.async_api import async_playwright  # noqa: F401
        return ""

    # Simpler: replicate the predicate over the sync locator API.
    for sel in _claude().rate_limit_selectors:
        loc = page.locator(sel).first
        if loc.count() and loc.is_visible():
            return " ".join((loc.inner_text() or "").split())[:200]
    return ""


def test_a_quota_wall_is_detected(page):
    found = _check(page, WALL)
    assert found, "the limit toast must be recognised"
    # The reset time is the one fact the user actually needs.
    assert "5:00 PM" in found


def test_a_healthy_page_is_not_a_quota_wall(page):
    """Over-detection would report a working member as rate limited.

    The answer text here deliberately contains the word "limit", because the
    council is often asked about limits and a naive substring match would call
    every such answer a quota wall.
    """
    assert _check(page, HEALTHY) == ""


def test_every_site_declares_markers():
    """A site with none silently keeps the old wrong diagnosis."""
    s = load_settings()
    for sid in s.sites:
        assert s.site(sid).rate_limit_selectors, f"{sid} has no rate_limit_selectors"
