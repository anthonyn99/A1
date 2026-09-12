"""Prompt entry strategy and pacing.

Guards the two changes that took a 4-member run from 233s to ~50s:
  * long prompts are inserted in one operation, not typed key by key
  * members run concurrently instead of one after another
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from magi.browser import humanize  # noqa: E402
from magi.settings import Pacing, load_settings  # noqa: E402


class FakeKeyboard:
    def __init__(self):
        self.typed: list[str] = []
        self.pressed: list[str] = []

    async def type(self, text: str, delay: int = 0) -> None:
        self.typed.append(text)

    async def press(self, key: str) -> None:
        self.pressed.append(key)


class FakeCDP:
    def __init__(self, sink):
        self.sink = sink

    async def send(self, method: str, params: dict) -> None:
        self.sink.append((method, params.get("text", "")))

    async def detach(self) -> None:
        return None


class FakeContext:
    def __init__(self, sink):
        self.sink = sink

    async def new_cdp_session(self, page):
        return FakeCDP(self.sink)


class FakePage:
    def __init__(self):
        self.keyboard = FakeKeyboard()
        self.cdp_calls: list[tuple[str, str]] = []
        self.context = FakeContext(self.cdp_calls)


class FakeTarget:
    """A composer the typing helpers can enter.

    Stands in for a Playwright Locator, so it carries the three things
    browser/overlay.py asks of one: a click that takes a timeout, a focus, and
    an `evaluate` to read the focus back. `focused` starts False so the entry
    path is genuinely exercised rather than short-circuited.
    """

    def __init__(self, *, clickable: bool = True):
        self.clickable = clickable
        self.focused = False
        self.clicks = 0
        self.focus_calls = 0

    async def click(self, timeout: int = 0, force: bool = False) -> None:
        self.clicks += 1
        if not self.clickable and not force:
            raise TimeoutError("element is covered")
        self.focused = True

    async def focus(self, timeout: int = 0) -> None:
        self.focus_calls += 1
        self.focused = True

    async def evaluate(self, expr: str):
        return self.focused


FAST = Pacing(typing_delay_ms=(0, 0), paste_threshold=400)


@pytest.mark.asyncio
async def test_long_prompt_is_inserted_not_typed():
    """The synthesis prompt is thousands of chars; typing it cost 86s."""
    page = FakePage()
    long_text = "x" * 2000
    await humanize.insert_text(page, FakeTarget(), long_text, FAST)

    assert page.cdp_calls == [("Input.insertText", long_text)]
    assert page.keyboard.typed == []          # nothing typed char by char


@pytest.mark.asyncio
async def test_short_prompt_is_still_typed():
    """Short prompts keep human-paced typing; there is no speed win in pasting."""
    page = FakePage()
    await humanize.insert_text(page, FakeTarget(), "a short question", FAST)

    assert page.cdp_calls == []
    assert "".join(page.keyboard.typed) == "a short question"


@pytest.mark.asyncio
async def test_pasted_prompt_still_clears_the_draft_first():
    """Otherwise a leftover draft is prepended to the pasted prompt."""
    page = FakePage()
    await humanize.insert_text(page, FakeTarget(), "y" * 1000, FAST)
    assert page.keyboard.pressed[:2] == ["ControlOrMeta+a", "Delete"]


@pytest.mark.asyncio
async def test_paste_preserves_newlines_exactly():
    """Insertion bypasses the Enter-sends problem entirely -- no Shift+Enter
    dance, and no risk of submitting on the first line."""
    page = FakePage()
    text = "Line one\n\nLine two\nLine three" + "z" * 500
    await humanize.insert_text(page, FakeTarget(), text, FAST)
    assert page.cdp_calls[0][1] == text
    assert "Shift+Enter" not in page.keyboard.pressed


def test_defaults_are_parallel_and_fast():
    """A shipped config that still ran sequentially would undo the speedup."""
    s = load_settings()
    assert s.pacing.mode == "parallel"
    assert s.pacing.max_concurrency >= 4
    assert s.pacing.paste_threshold <= 500
    # Stagger must stay small; this was the 3-9s gap that dominated runs.
    assert s.pacing.inter_provider_delay_s[1] <= 2.0


def test_zero_stagger_fires_everyone_at_once():
    """[0, 0] must produce no artificial delay for any member."""
    p = Pacing(inter_provider_delay_s=(0, 0))
    delays, acc = [], 0.0
    for _ in range(4):
        delays.append(acc)
        acc += p.sample_inter_provider()
    assert delays == [0.0, 0.0, 0.0, 0.0]


def test_browser_windows_tile_into_distinct_quadrants():
    """Overlapping windows get occluded, and occluded windows get throttled."""
    from magi.browser.launcher import _window_position
    from magi.settings import BrowserConfig

    cfg = BrowserConfig(window_size=(940, 520))
    spots = [
        _window_position(s, cfg)
        for s in ("chatgpt", "claude", "gemini", "deepseek")
    ]
    assert len(set(spots)) == 4, f"windows would overlap: {spots}"
    # Two columns, two rows.
    assert spots[0] == (0, 0)
    assert spots[1][0] > 0 and spots[1][1] == 0
    assert spots[2][0] == 0 and spots[2][1] > 0


def test_offscreen_hides_windows_but_login_stays_visible():
    """Off-screen is how MAGI runs invisibly -- true headless is blocked by
    Cloudflare on ChatGPT and Claude. But anything the user must interact with
    has to be on screen, or they're typing into a window they cannot see."""
    from dataclasses import replace as dc_replace

    from magi.browser.launcher import _window_position
    from magi.settings import BrowserConfig

    hidden = BrowserConfig(offscreen=True)
    assert _window_position("chatgpt", hidden) == (-32000, -32000)

    # force_visible path (used by `magi login`) must land on the desktop.
    shown = dc_replace(hidden, offscreen=False)
    x, y = _window_position("chatgpt", shown)
    assert x >= 0 and y >= 0


def test_deepseek_quiet_window_outlives_its_streaming_pause():
    """DeepSeek emits one word, pauses ~3s, then streams the rest.

    Too short a window truncated answers to that first word ("Print"). The
    quiet window must comfortably exceed the pause, and the stall timeout must
    in turn exceed the quiet window or it fires first.
    """
    s = load_settings()
    d = s.site("deepseek")
    quiet_s = d.stability_samples * d.poll_ms / 1000
    assert quiet_s >= 10, f"quiet window {quiet_s}s is too short for the pause"
    assert d.stall_timeout_s > quiet_s, "stall timeout would fire before stability"


def test_all_members_run_headless():
    """Every site was verified to answer correctly with no window at all."""
    s = load_settings()
    for sid in ("chatgpt", "claude", "gemini", "deepseek"):
        assert s.site(sid).headless_ok is True, f"{sid} would open a window"


def test_headless_user_agent_hides_the_headless_token():
    """The load-bearing detail behind headless working at all.

    Headless Chrome advertises "HeadlessChrome/151..." instead of
    "Chrome/151...". That token alone is what Cloudflare blocks -- with it
    present chatgpt.com and claude.ai serve an unclearable challenge page.
    If this regresses, half the council silently stops answering.
    """
    from magi.browser.launcher import _headless_user_agent
    from magi.settings import BrowserConfig

    ua = _headless_user_agent(BrowserConfig())
    assert "Headless" not in ua
    assert "Chrome/" in ua and "Mozilla/5.0" in ua

    # An explicit override wins, for pinning a specific string.
    custom = BrowserConfig(headless_user_agent="Custom/1.0")
    assert _headless_user_agent(custom) == "Custom/1.0"


def test_taskbar_hiding_is_a_noop_off_windows():
    """The Win32 hide must never raise on another platform."""
    from magi.browser import winhide

    assert winhide.hide_windows_for_profile(Path("does-not-exist")) >= 0


def test_stagger_is_cumulative_not_flat():
    """Provider N should start after the sum of N gaps, not one flat gap."""
    p = Pacing(inter_provider_delay_s=(1.0, 1.0))
    delays, acc = [], 0.0
    for _ in range(4):
        delays.append(acc)
        acc += p.sample_inter_provider()
    assert delays == [0.0, 1.0, 2.0, 3.0]
