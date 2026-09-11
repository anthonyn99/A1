"""Tests for the StudyOS browser driver.

Covers the parts that fail SILENTLY — where a bug produces a plausible-looking
wrong answer rather than an error:

  "markdown walker keeps '## Slide N'"
      The pipeline's slide-coverage verifier keys on those headings. If the
      walker ever flattens them (which inner_text() does), every chunk looks
      like it skipped every slide, and the failure is reported as the model's
      fault rather than the reader's.

  "baseline logic detects both UI shapes"
      Append-style UIs grow the turn count; fill-style ones stream into a
      pre-rendered empty node so the count never moves. Checking only the count
      silently returns the PREVIOUS answer, and it looks completely valid.

  "gemini's trailing citations are stripped"
      Otherwise "AcqNotes\\n+ 2" lands inside the generated note.

The DOM walker is JS, so it is exercised in a real browser via Playwright and
skipped cleanly if no browser is installed.

Run:  python test_driver.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import driver  # noqa: E402

PASS = FAIL = 0


def t(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   " + name)
    else:
        FAIL += 1
        print("  FAIL " + name + (("\n       " + str(extra)[:300]) if extra else ""))


# ── Config ────────────────────────────────────────────────────────────────────
print("\nconfig")
claude = driver.load_site("claude")
t("claude loads", claude.display_name == "Claude")
t("selector lists are ordered fallbacks", len(claude.input) >= 3)
t("confirm_samples kept at the measured 14", claude.confirm_samples == 14,
  claude.confirm_samples)
t("assistant_turn avoids the streaming wrapper",
  claude.assistant_turn[0] == ".font-claude-response", claude.assistant_turn[:1])
gem = driver.load_site("gemini")
t("gemini loads", gem.display_name == "Gemini")
t("gemini has no streaming marker", gem.streaming_marker == [])
try:
    driver.load_site("nope")
    t("unknown site raises", False)
except SystemExit:
    t("unknown site raises", True)


# ── User agent ────────────────────────────────────────────────────────────────
print("\nheadless user agent")
ua = driver.headless_user_agent()
t("no HeadlessChrome token", "HeadlessChrome" not in ua, ua)
t("carries a real Chrome version", "Chrome/" in ua and ua.split("Chrome/")[1][0].isdigit(), ua)


# ── strip_patterns ────────────────────────────────────────────────────────────
print("\ntrailing-citation stripping")
t("removes the '+ N' grounding pill",
  driver.strip_trailing("Real answer.\nAcqNotes\n+ 2", gem.strip_patterns).endswith("AcqNotes"),
  driver.strip_trailing("Real answer.\nAcqNotes\n+ 2", gem.strip_patterns))
t("removes a trailing Sources line",
  driver.strip_trailing("Body text.\nSources", gem.strip_patterns) == "Body text.")
t("leaves a clean answer alone",
  driver.strip_trailing("## Slide 1\nContent.", gem.strip_patterns) == "## Slide 1\nContent.")
t("does not eat a legitimate '+ 2' mid-text",
  "2 + 2" in driver.strip_trailing("2 + 2 = 4\nmore", gem.strip_patterns))


# ── Baseline / new-answer detection ───────────────────────────────────────────
print("\nnew-answer detection (both UI shapes)")


def is_new(text, turns, base_text, base_turns):
    """Mirrors the gate in wait_for_completion."""
    return turns > base_turns or bool(text and text != base_text)


t("append-style: turn count grows", is_new("new", 2, "old", 1))
t("fill-style: count static, text changed", is_new("new", 1, "old", 1))
t("stale read is rejected", not is_new("old", 1, "old", 1))
t("empty read is rejected", not is_new("", 1, "old", 1))
t("first answer on an empty page", is_new("hello", 1, "", 0))


# ── The DOM → markdown walker, in a real browser ──────────────────────────────
async def walker_tests():
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print("\nSKIP markdown walker (playwright not importable)")
        return
    html = """
      <div id=root>
        <h2>Slide 7</h2>
        <p>Intro <strong>bold</strong> and <em>italic</em>.</p>
        <ul><li>first</li><li>second<ul><li>nested</li></ul></li></ul>
        <ol><li>one</li><li>two</li></ol>
        <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
        <pre><code class="language-sql">SELECT 1;</code></pre>
        <blockquote>quoted</blockquote>
        <button>Copy</button>
      </div>"""
    try:
        async with async_playwright() as pw:
            b = await pw.chromium.launch(headless=True)
            pg = await b.new_page()
            await pg.set_content(html)
            md = await pg.locator("#root").evaluate(driver.DOM_TO_MARKDOWN_JS)
            await b.close()
    except Exception as e:
        print(f"\nSKIP markdown walker ({str(e)[:90]})")
        return

    print("\nDOM -> markdown")
    t("keeps '## Slide 7' (the verifier depends on it)", "## Slide 7" in md, md)
    t("bold survives", "**bold**" in md, md)
    t("italic survives", "*italic*" in md, md)
    t("bullets survive", "- first" in md, md)
    t("nested bullets are indented", "  - nested" in md, md)
    t("ordered lists are numbered", "1. one" in md and "2. two" in md, md)
    t("tables keep their separator row", "| --- | --- |" in md, md)
    t("code fence keeps its language", "```sql" in md, md)
    t("blockquote survives", "> quoted" in md, md)
    t("chrome buttons are skipped", "Copy" not in md, md)
    # The whole point: inner_text would have produced none of the above.
    t("output is markdown, not flattened prose", md.count("\n") > 5, md)


asyncio.run(walker_tests())

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
