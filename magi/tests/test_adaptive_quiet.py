"""A finished answer should not be waited on for longer than it took to stream.

DeepSeek exposes no streaming marker and no stop button, so the only evidence
its answer is finished is the text sitting still. That window was a fixed 20
samples (14s), paid on every answer -- measured medians put DeepSeek at 28s for
answers that were complete ~14s earlier.

completion.py now scales the window to how THIS answer streamed (four times its
longest pause, floor 2.5s, and never more than the configured window), so:
  * a smoothly streaming answer settles in about 2.5s;
  * an answer that paused a long time to think still gets the full window,
    because its own pause is what sets the bar.
"""

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from magi.browser import completion  # noqa: E402
from magi.settings import SiteSelectors  # noqa: E402


def _site(**kw):
    return SiteSelectors(
        id="deepseek", display_name="DeepSeek", url="https://x/",
        poll_ms=100, stability_samples=140,     # 14s window, at a fast poll
        confirm_samples=5, stall_timeout_s=120, hard_timeout_s=1200,
        **kw,
    )


def _drive(chunks, gap_s):
    """A page whose answer grows by one chunk every `gap_s`, then stops."""
    started = time.monotonic()
    def read(_page, _site):
        elapsed = time.monotonic() - started
        shown = min(len(chunks), int(elapsed / gap_s) + 1)
        return "".join(chunks[:shown]), 1
    return read


def _run(site, read):
    """Drive the real wait loop against a fake page, then put every patched
    function back -- these are module globals, and leaving them replaced broke
    every other completion test in the same session."""
    async def main():
        return await completion.wait_for_completion(object(), site, turns_before=0)
    async def noop(*a, **k):
        return None
    async def absent(*a, **k):
        return False
    saved = (completion._check_sentinels, completion._read_latest, completion.resolve.present)
    completion._check_sentinels = noop
    completion.resolve.present = absent
    completion._read_latest = lambda page, s: asyncio.sleep(0, result=read(page, s))
    t0 = time.monotonic()
    try:
        result = asyncio.new_event_loop().run_until_complete(main())
    finally:
        completion._check_sentinels, completion._read_latest, completion.resolve.present = saved
    return result, time.monotonic() - t0


def test_a_smooth_answer_is_not_held_for_the_full_window():
    site = _site()
    # Streaming, as it really arrives: many small growths in a steady rhythm.
    text = [f"chunk {i}. " for i in range(20)]
    result, took = _run(site, _drive(text, 0.2))
    assert result.text == "".join(text)
    # Streamed with 0.2s gaps: 4x that is under the 2.5s floor, so ~2.5s of
    # quiet -- not the configured 14s.
    assert took < 4 + 20 * 0.2, f"took {took:.1f}s; the fixed window is back"
    assert took > 2.5, f"took {took:.1f}s; the quiet floor was skipped"


def test_an_answer_that_paused_to_think_keeps_a_long_window():
    site = _site()
    text = ["Thinking... ", "and here is the real answer."]
    # Two growths with a 3s pause between them: too little evidence of a
    # rhythm to shorten anything, so the full configured window applies.
    result, took = _run(site, _drive(text, 3.0))
    assert result.text == "".join(text)
    assert took > 9, f"took {took:.1f}s; a pausing answer could be cut off"


# Sites that DO signal the end of generation keep their fixed confirm window:
# see the comment on the streaming-marker gate in completion.py for the
# measured reason (a preamble streams at a steady rhythm too, so the rhythm
# cannot be trusted to tell a finished answer from a pause before one).
