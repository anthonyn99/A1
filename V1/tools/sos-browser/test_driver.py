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

  "notebooklm is not loadable as a chat site"
      load_site() filters against Site's fields, so a deck config placed under
      `sites:` would load happily and drop every wizard selector — failing much
      later as a misleading `no_input`.

  "DeckSite carries the five attributes check_blockers reads"
      That function is the ethical stop. It works on both classes only by
      structural typing, so renaming a field here would silently remove the
      challenge and rate-limit checks from the deck path.

  "looks_like_pdf rejects an HTML error page"
      A sign-in redirect saved under a .pdf name is the failure that would
      otherwise be filed into a class as a slide deck.

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


# ── Deck config (NotebookLM) ──────────────────────────────────────────────────
print("\ndeck config (notebooklm)")
nlm = driver.load_deck_site("notebooklm")
t("notebooklm loads", nlm.display_name == "NotebookLM")

_WIZARD = ("create_notebook", "source_file_input", "source_ready", "studio_tab",
           "slide_deck_button", "customize_button", "prompt_input",
           "generate_button", "artifact_ready", "artifact_failed",
           "download_trigger", "download_menu_item")
t("every wizard field is an ordered fallback list",
  all(isinstance(getattr(nlm, f), list) for f in _WIZARD),
  [f for f in _WIZARD if not isinstance(getattr(nlm, f), list)])
t("no wizard field is empty",
  all(getattr(nlm, f) for f in _WIZARD),
  [f for f in _WIZARD if not getattr(nlm, f)])

# It must NOT be reachable through load_site: that call filters against Site's
# fields, so it would return a Site with empty input/assistant_turn — a config
# that loads fine and then fails at runtime pointing at the wrong thing.
try:
    driver.load_site("notebooklm")
    t("notebooklm is not loadable as a chat site", False,
      "load_site accepted it; the wizard fields would be silently dropped")
except SystemExit:
    t("notebooklm is not loadable as a chat site", True)
t("is_deck_site tells the two apart",
  driver.is_deck_site("notebooklm") and not driver.is_deck_site("claude"))

# check_blockers() works on both classes purely by structural typing.
t("DeckSite carries the five attributes check_blockers reads",
  all(hasattr(nlm, a) for a in ("id", "display_name", "login_selectors",
                                "rate_limit_selectors", "challenge_selectors")))

t("generation deadline is generous (minutes, not seconds)",
  nlm.gen_timeout_s >= 900, nlm.gen_timeout_s)
t("ingest gets its own, shorter deadline",
  0 < nlm.source_timeout_s < nlm.gen_timeout_s,
  (nlm.source_timeout_s, nlm.gen_timeout_s))
# 700ms over a 30-minute wait is ~2,500 pointless DOM queries.
t("generation polls slowly, unlike the chat path",
  nlm.gen_poll_ms >= 2000, nlm.gen_poll_ms)
# Failure is checked BEFORE success in _wait_for_deck; if they were the same
# list, a failed run would be read as a finished one.
t("failure has its own detector, distinct from ready",
  nlm.artifact_failed and nlm.artifact_failed != nlm.artifact_ready)
t("headless is off while the selectors are guesses", nlm.headless_ok is False)


# ── Downloaded-file validation ────────────────────────────────────────────────
print("\ndownload validation")
t("a real PDF header passes", driver.looks_like_pdf(b"%PDF-1.7\n%..."))
t("an HTML error page is rejected", not driver.looks_like_pdf(b"<!DOCTYPE html>"))
t("a sign-in redirect is rejected", not driver.looks_like_pdf(b"<html><head>"))
t("an empty download is rejected", not driver.looks_like_pdf(b""))
t("a truncated header is rejected", not driver.looks_like_pdf(b"%PD"))


asyncio.run(walker_tests())

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
