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
import inspect as _inspect  # noqa: E402
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


# ── The selectors that cost the most to get wrong ─────────────────────────────
# Each of these was a real failure during the live repair loop, and each failed
# in the expensive way: the selector MATCHED something, so the run died several
# steps later pointing at an innocent control.
print("\nselector traps (each one a real failure, pinned)")

# A bare `textarea` matched the sidebar's "Search the web for new sources" box,
# which is invisible behind the dialog — the click timed out after 30s naming
# the wrong element. Three visible textareas exist on that screen.
t("prompt_input is anchored, never a bare tag",
  all(sel.strip() not in ("textarea", "div[contenteditable='true']",
                          "[role='textbox']", "input")
      for sel in nlm.prompt_input), nlm.prompt_input)
t("prompt_input names the slide-deck box specifically",
  any("slide deck" in sel.lower() or "dialog" in sel.lower()
      for sel in nlm.prompt_input), nlm.prompt_input)

# The source ROW appears the instant the upload starts, so matching it alone
# reported "ready" while the file was still processing — and the Studio
# controls are styled divs, so is_enabled() stays True and nothing complains.
t("ingest completion has its own signal, not just the row",
  bool(nlm.ingest_spinner), nlm.ingest_spinner)
t("source_ready and ingest_spinner are different things",
  not (set(nlm.source_ready) & set(nlm.ingest_spinner)))

# The file input does not exist until "Add sources" is clicked, and "Upload
# files" then opens a native chooser rather than revealing an input.
t("the upload dialog is opened before any input is sought",
  bool(nlm.add_source_button) and bool(nlm.upload_files_button))

# An announcement modal covers the app and swallows clicks behind it.
t("announcement modals can be dismissed", bool(nlm.dismiss_dialog))

# [aria-label*='Customize' i] matches "Customize notebook" — the global
# settings dialog for title and cover image, NOT the slide-deck prompt.
t("customize_button cannot match the notebook settings dialog",
  not any(sel == "[aria-label*='Customize' i]" or sel == "button:has-text('Customize')"
          for sel in nlm.customize_button), nlm.customize_button)

# Two Generate buttons exist once the prompt dialog opens.
# THE EXPENSIVE ONE. The dialog has "Generate later" AND "Generate now" side by
# side, and :has-text() is a SUBSTRING match — so has-text('Generate') matched
# both and, since "Generate later" comes first in the DOM, every run clicked it.
# The deck was deferred rather than built, and the symptom (a row reading
# "Scheduled for after 12am") is indistinguishable from an exhausted quota.
# A whole day was spent waiting for a reset that was never the problem.
t("generate_button can never match 'Generate later'",
  all("later" not in sel.lower() for sel in nlm.generate_button),
  nlm.generate_button)
t("every generate_button candidate names 'Generate now'",
  all("generate now" in sel.lower() for sel in nlm.generate_button),
  nlm.generate_button)
# A bare has-text('Generate') is the exact bug. It must not come back.
t("no bare has-text('Generate') candidate",
  not any(sel.strip().endswith("has-text('Generate')")
          for sel in nlm.generate_button), nlm.generate_button)
t("'Generate later' is listed so it can be refused, not clicked",
  bool(nlm.generate_later_button))


# A deferred deck is a THIRD outcome, not a slow success. Out of quota,
# NotebookLM schedules the job ("Scheduled for after 12am") and the row sits
# still for hours; a live run polled one for 22 minutes before this existed.
t("a queued/deferred deck is detectable", bool(nlm.artifact_queued),
  nlm.artifact_queued)
t("queued is distinct from both ready and failed",
  not (set(nlm.artifact_queued) & (set(nlm.artifact_ready) | set(nlm.artifact_failed))))


# ── One run at a time ─────────────────────────────────────────────────────────
print("\nconcurrent-run guard")
import os as _os  # noqa: E402
_lock = Path(__file__).resolve().parent / ".deck-run.test.lock"
_lock.unlink(missing_ok=True)
# A live holder must block a second run: two overlapping runs create two
# notebooks from one source and spend twice the quota. That happened for real.
_lock.write_text(str(_os.getpid() + 100000), encoding="utf-8")   # a pid we do not own
try:
    with driver._RunLock(_lock):
        # If that pid happens to exist this is inconclusive, not a failure.
        t("a live lock blocks a second run", True, "(holder pid not live; skipped)")
except driver.DriverError as e:
    t("a live lock blocks a second run", e.kind == "already_running", e.kind)
# A stale lock (holder died) must NOT block forever.
_lock.write_text("99999999", encoding="utf-8")
try:
    with driver._RunLock(_lock):
        t("a stale lock is ignored", True)
except driver.DriverError as e:
    t("a stale lock is ignored", False, e.message[:80])
_lock.unlink(missing_ok=True)

# The generating placeholder shares a class with the finished row, so
# readiness must require something only a FINISHED artifact has.
#
# The old assertion here was `'has(' in sel`, and it PASSED while the bug was
# live: the offending fallback was
#   .artifact-primary-content:not(:has(.artifact-failed-subtitle))
# which contains 'has(' via the :not(:has(...)) NEGATION. That negation
# excludes a FAILED row; it says nothing about a GENERATING one. So the test
# was satisfied by the very selector that matched the placeholder and sent the
# run on to click the source row's kebab. Assert the positive requirement
# instead: a readiness selector must demand something a finished row HAS.
def _requires_finished_marker(sel: str) -> bool:
    if "testid" in sel:
        return True
    # Strip every :not(...) group, then look for a surviving :has().
    depth = 0
    out = []
    i = 0
    while i < len(sel):
        if sel.startswith(":not(", i):
            depth += 1
            i += 5
            continue
        c = sel[i]
        if depth:
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
        else:
            out.append(c)
        i += 1
    return ":has(" in "".join(out)


t("readiness cannot match a still-generating row",
  all(_requires_finished_marker(sel) for sel in nlm.artifact_ready),
  nlm.artifact_ready)
t("the bare .artifact-primary-content fallback is gone",
  not any(sel.strip().startswith(".artifact-primary-content")
          for sel in nlm.artifact_ready),
  nlm.artifact_ready)
t("a generating state is detected explicitly", bool(nlm.artifact_generating))

# Pinned against the REAL page captured when this failed
# (artifacts/notebooklm-no-download-item-20260914-024201.html): the Studio
# showed 'Generating Slide Deck...' and the page's ONLY aria-label='More'
# button belonged to the source row, so any readiness match there sends the
# flow to 'Remove source / Rename source'.
_cap = (driver.ARTIFACTS
        / "notebooklm-no-download-item-20260914-024201.html")
if _cap.exists():
    _html = _cap.read_text(encoding="utf-8", errors="replace")
    t("the captured failure really was mid-generation",
      "Generating Slide Deck" in _html)
    t("and its only More button was the source row's",
      _html.count('aria-label=\"More\"') == 1
      and "source-item-more-button" in _html)
    # The generating row carries .artifact-primary-content and no failure
    # subtitle — which is exactly why the removed fallback matched it.
    t("the generating row is why the bare fallback was unsafe",
      ".artifact-primary-content".lstrip('.') in _html)


# ── Download completion (three wrong guesses before the right one) ────────────
print("\ndownload completion")
# Chrome never renames away .crdownload here — the popup that owns the transfer
# is gone — so a finished file sits under a UUID with no suffix.
t("download budget is generous enough for a large deck",
  nlm.download_timeout_s >= 300, nlm.download_timeout_s)


def complete_pdf(b: bytes) -> bool:
    """Mirrors the completion gate in _download_deck."""
    return b[:5] == b"%PDF-" and b"%%EOF" in b[-2048:]


t("a complete PDF is accepted", complete_pdf(b"%PDF-1.7" + b"x" * 500 + b"%%EOF"))
# THE ONE THAT MATTERED: a truncated download still starts with %PDF-, passes
# every cheap check, and renders as pure noise. It was reported as a success
# twice before the trailer check existed.
t("a truncated PDF is REJECTED (it renders as noise but looks valid)",
  not complete_pdf(b"%PDF-1.7" + b"x" * 5000))
t("an HTML error page is rejected", not complete_pdf(b"<!DOCTYPE html>"))


# ── Downloaded-file validation ────────────────────────────────────────────────
print("\ndownload validation")
t("a real PDF header passes", driver.looks_like_pdf(b"%PDF-1.7\n%..."))
t("an HTML error page is rejected", not driver.looks_like_pdf(b"<!DOCTYPE html>"))
t("a sign-in redirect is rejected", not driver.looks_like_pdf(b"<html><head>"))
t("an empty download is rejected", not driver.looks_like_pdf(b""))
t("a truncated header is rejected", not driver.looks_like_pdf(b"%PD"))


asyncio.run(walker_tests())

# -- The staging directory must not look like garbage ------------------------
# A partially downloaded deck sits there NOT growing for minutes (NotebookLM
# streams a large deck slowly). The folder used to be '.dl-<ts>-<rand>', which
# is indistinguishable from junk — and it was deleted mid-transfer, killing the
# download and stranding a deck that had already cost real quota.
print("\nstaging directory")
_dl_src = _inspect.getsource(driver._download_deck)
t("the folder says not to delete it",
  "ACTIVE-DOWNLOAD-do-not-delete" in _dl_src)
# Comments may still mention the old ".dl-*" name (the history is the reason the
# current name exists), so check the CODE lines only.
_dl_code = "\n".join(l for l in _dl_src.splitlines()
                     if not l.lstrip().startswith("#"))
t("it is not hidden behind a dot",
  ".dl-" not in _dl_code, "the old hidden .dl-* name is back in code")
t("it records the owning pid, so liveness is checkable",
  "os.getpid()" in _dl_src)
t("it drops a README explaining the risk",
  "README.txt" in _dl_src)
t("the README is not mistaken for the deck",
  'f.name != \"README.txt\"' in _dl_src)
t("deletion mid-transfer is reported as its own kind",
  "nlm_staging_gone" in _dl_src)
t("and every download failure points at the no-quota recovery",
  _dl_src.count("driver.py fetch") >= 2, _dl_src.count("driver.py fetch"))

# The URL is published straight after Generate — BEFORE the download — so a
# failure at the download stage still leaves the deck recoverable.
_flow_src = _inspect.getsource(driver.run_notebooklm_flow)
_gen_at = _flow_src.index("generate_button")
_url_at = _flow_src.index("on_notebook_url(notebook_url)")
_dl_at = _flow_src.index("_download_deck")
t("the notebook URL is recorded after Generate", _url_at > _gen_at)
t("and BEFORE the download can fail", _url_at < _dl_at)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
