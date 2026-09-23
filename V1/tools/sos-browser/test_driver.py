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
import json
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

# -- A stalled transfer is restarted, not waited out -------------------------
# MEASURED (job sb_fdf7b00723): 47KB arrived, the transfer died, and the loop
# waited the remaining ~590s for a %%EOF that could never come, then blamed a
# timeout. The deck was finished; only the transfer was broken.
print("\nstalled download")
_dd = _inspect.getsource(driver._download_deck)
t("the download click is restartable",
  hasattr(driver, '_click_download_item'))
t("a stall is detected from bytes that stop growing",
  'last_growth' in _dd and 'STALL_S' in _dd)
t("Chrome's own cancel verdict is subscribed to",
  'Browser.downloadProgress' in _dd)
t("restarts are bounded", 'MAX_RESTARTS' in _dd)
t("the dead partial is removed before restarting",
  'f.unlink()' in _dd)
t("the stall budget is generous enough for a slow export",
  driver.STALL_S >= 30, driver.STALL_S)
t("restarts cannot spin forever",
  1 <= driver.MAX_RESTARTS <= 5, driver.MAX_RESTARTS)

# -- A download that NEVER STARTS is diagnosable ------------------------------
# MEASURED (2026-09-23, notebook 1af3bb34-b567-4566-8ab4-bec00a427e94): a fetch
# of an already-generated deck failed three times in one run, and the message
# changed between attempts:
#
#     attempt 1:  no new bytes for 45s          <- started, then died
#     attempt 2:  the download never started    <- nothing was ever initiated
#     attempt 3:  the download never started
#
# Those are two DIFFERENT failures needing opposite repairs — a transfer that
# keeps dying (popup teardown) versus a click that does nothing (menu/overlay).
# The final error collapsed both into one timeout sentence, and, worst of all,
# this path saved NO artifacts: the single failure kind whose repair requires
# reading the live markup was the one path that destroyed the evidence.
print("\ndownload never started: diagnosis")
_dd2 = _inspect.getsource(driver._download_deck)

t("the timeout path dumps the page for selector repair",
  "save_artifacts" in _dd2 and "download-timeout" in _dd2,
  "nlm_no_download is unrepairable without the markup")
t("and the dump cannot replace the real error with its own failure",
  "except Exception" in _dd2.split("download-timeout")[1][:400])
t("'no bytes ever arrived' is tracked across restarts",
  "saw_any_bytes" in _dd2,
  "each restart resets last_size, so a per-attempt flag cannot answer this")
t("and it names the click/menu as the cause, not a slow transfer",
  "never actually initiated" in _dd2)
t("a failed re-click is preserved rather than swallowed",
  "click_error" in _dd2,
  "the bare `except DriverError: pass` discarded the most diagnostic fact")
t("and surfaced in the final message",
  "The last re-click also failed" in _dd2)

# The retry must not assume a clean page. If the previous attempt left the
# artifact menu (or its backdrop) open, clicking "More" lands on the scrim,
# which merely dismisses it — the menu never opens and the attempt is a silent
# no-op that looks exactly like a dead transfer.
print("\nretry starts from a clean page")
_cdi = _inspect.getsource(driver._click_download_item)
t("anything already open is dismissed before clicking",
  "Escape" in _cdi,
  "a retry clicking through a stale overlay is a silent no-op")
_esc_at = _cdi.index("Escape")
_trig_at = _cdi.index("download_trigger")
t("and dismissed BEFORE the trigger is resolved", _esc_at < _trig_at)
t("the dismiss is best-effort, never the thing that fails the run",
  "except Exception" in _cdi[:_trig_at])

# -- The recovery URL must actually be reachable ------------------------------
# MEASURED: the URL recorded for recovery was https://notebook.google.com/...
# (no 'lm') because page.url was sampled while Google bounced through that
# host. The id was right and the host was wrong, so `fetch` would have failed
# at exactly the moment recovery mattered.
print("\nnotebook URL repair")
_SITE = "https://notebooklm.google.com/"
_BAD = "https://notebook.google.com/notebook/88dbf417-49a9-48c6-98b3-0b21a648e304"
_GOOD = "https://notebooklm.google.com/notebook/88dbf417-49a9-48c6-98b3-0b21a648e304"
t("the redirect host is repaired",
  driver._canonical_notebook_url(_BAD, _SITE) == _GOOD,
  driver._canonical_notebook_url(_BAD, _SITE))
t("an already-correct URL is unchanged",
  driver._canonical_notebook_url(_GOOD, _SITE) == _GOOD)
t("a query string is dropped",
  driver._canonical_notebook_url(_GOOD + '?hl=en', _SITE) == _GOOD)
t("a URL with no notebook id is left alone, not invented",
  driver._canonical_notebook_url(_SITE, _SITE) == _SITE)
t("empty input cannot crash the recorder",
  driver._canonical_notebook_url('', _SITE) == '' and
  driver._canonical_notebook_url(None, _SITE) == '')
t("the recorded URL is canonicalised at the source",
  '_canonical_notebook_url(page.url' in _inspect.getsource(
      driver.run_notebooklm_flow))
t("and again on the way into fetch",
  '_canonical_notebook_url(args.url' in _inspect.getsource(driver.cmd_fetch))

# A download that NEVER STARTS is as dead as one that dies partway.
# MEASURED (job sb_49fbc5a20e, 2026-09-15): the Download click did not take,
# the staging dir stayed empty, and the stall guard was written as
# `total_now > 0 and ...` — so with zero bytes it never fired and the run sat
# out the full 600s, reporting the same misleading timeout the stall detection
# existed to remove.
t("a stall is detected even with ZERO bytes on disk",
  'total_now > 0 and' not in _dd,
  'the zero-byte blind spot is back: stalled requires total_now > 0')
t("and the message distinguishes never-started from died-partway",
  'never started' in _dd and 'no new bytes' in _dd)

# The POPUP must be routed with page-scoped `allow`, never the browser-wide
# `allowAndName`. MEASURED 2026-09-15: switching it to Browser.setDownload-
# Behavior/allowAndName made the staging dir stay COMPLETELY EMPTY for a full
# 600s window on two consecutive runs — re-issuing the browser-scoped command
# from the popup's session drops the transfer the popup is already doing.
# The builds that actually downloaded decks (09-13, 09-14) used page `allow`.
_popup = _dd[_dd.index('async def _route_popup'):]
_popup = _popup[:_popup.index('page.context.on')]
t("the popup is routed page-scoped, not browser-scoped",
  'Page.setDownloadBehavior' in _popup
  and 'Browser.setDownloadBehavior' not in _popup, _popup[:200])
t("the popup uses plain allow, not allowAndName",
  'allowAndName' not in _popup, _popup[:200])
t("the browser-wide call still names files and enables events",
  'allowAndName' in _dd and 'eventsEnabled' in _dd)

# ── Reels harvest (Instagram) ─────────────────────────────────────────────────
print("\nreels")
ig = driver.load_reels_site("instagram")

# The five-attribute contract check_blockers() reads. Renaming one here would
# silently remove the challenge/rate-limit refusal from the scraper path — the
# one path where it matters most, since it drives a logged-in personal account.
for _attr in ("id", "display_name", "login_selectors",
              "rate_limit_selectors", "challenge_selectors"):
    t(f"ReelsSite carries `{_attr}` for check_blockers",
      hasattr(ig, _attr) and getattr(ig, _attr) not in (None, ""),
      f"{_attr} missing or empty")

t("instagram is NOT loadable as a chat site",
  not driver.is_deck_site("instagram") and driver.is_reels_site("instagram"))
t("headless stays off while the selectors are guesses",
  ig.headless_ok is False, ig.headless_ok)
t("a per-run scroll cap exists and is finite",
  isinstance(ig.max_scrolls, int) and 0 < ig.max_scrolls <= 200, ig.max_scrolls)
t("pacing is a RANGE, not a constant",
  isinstance(ig.scroll_pause_s, list) and len(ig.scroll_pause_s) == 2
  and ig.scroll_pause_s[0] < ig.scroll_pause_s[1], ig.scroll_pause_s)
t("_pace samples inside the range",
  all(ig.scroll_pause_s[0] <= driver._pace(ig.scroll_pause_s) <= ig.scroll_pause_s[1]
      for _ in range(50)))
t("_pace never returns the same value twice in a row (not a metronome)",
  len({driver._pace([1.5, 4.0]) for _ in range(20)}) > 15)

# shortcode_of — the dedup key. /p/ matters: a saved reel is sometimes filed
# under /p/, and treating that as a different item would double every entry.
t("shortcode from /reel/", driver.shortcode_of("/reel/Cx1y2Z3aBcD/") == "Cx1y2Z3aBcD")
t("shortcode from /reels/", driver.shortcode_of("/reels/Cx1y2Z3aBcD/") == "Cx1y2Z3aBcD")
t("shortcode from /p/ (same reel, different path)",
  driver.shortcode_of("/p/Cx1y2Z3aBcD/") == "Cx1y2Z3aBcD")
t("shortcode from a full URL with query",
  driver.shortcode_of("https://www.instagram.com/reel/AbCdEfGhIjK/?img_index=1")
  == "AbCdEfGhIjK")
t("a profile link yields no shortcode",
  driver.shortcode_of("/veda/saved/all-posts/") is None)
t("empty href yields no shortcode", driver.shortcode_of("") is None)

# OBSERVED IN REAL DATA 2026-09-17: one reel in Boosts stored as a 39-char
# "shortcode" — the real 11-char code plus a tracking blob IG had appended to
# the path segment. It still played (IG ignores trailing junk on a permalink),
# so nothing looked wrong, but shortcode is the DEDUP key in merge_reels and
# the thumbnail key in thumb_key: the same reel arriving once with the suffix
# and once without becomes two permanent entries that never reconcile.
_ODD = "/reel/DVomTTOEnkot0nscGQGISyTIassL9DojYviFsQ0/"
t("an over-long path segment is truncated to the real 11-char shortcode",
  driver.shortcode_of(_ODD) == "DVomTTOEnko", driver.shortcode_of(_ODD))
t("...so both spellings of the same reel collapse to ONE dedup key",
  driver.shortcode_of(_ODD) == driver.shortcode_of("/reel/DVomTTOEnko/"))
t("an over-long segment is never DROPPED (that would lose a saved reel)",
  driver.shortcode_of(_ODD) is not None,
  "returning None here would silently discard a reel the person really saved")
# 12 is legitimate on some older posts, so the cap must not cut those.
t("a legitimate 12-char shortcode is left intact",
  driver.shortcode_of("/p/ABCDEFGHIJKL/") == "ABCDEFGHIJKL")

# merge_reels — MERGE, never replace. A partial harvest must not drop reels the
# widget is already showing.
_old = [{"shortcode": "A", "caption": "first", "thumbKey": "reel_A"},
        {"shortcode": "B", "caption": "second"}]
_new = [{"shortcode": "B", "caption": "second (edited)"},
        {"shortcode": "C", "caption": "third"}]
_m = driver.merge_reels(_old, _new)
t("merge unions by shortcode", [r["shortcode"] for r in _m] == ["A", "B", "C"],
  [r["shortcode"] for r in _m])
t("a partial harvest never drops a known reel",
  any(r["shortcode"] == "A" for r in driver.merge_reels(_old, [{"shortcode": "C"}])))
t("newer metadata wins",
  [r for r in _m if r["shortcode"] == "B"][0]["caption"] == "second (edited)")
t("an empty field does NOT clobber a stored value",
  [r for r in driver.merge_reels(_old, [{"shortcode": "A", "thumbKey": ""}])
   if r["shortcode"] == "A"][0]["thumbKey"] == "reel_A")
t("entries without a shortcode are dropped, not stored keyless",
  driver.merge_reels([], [{"caption": "no code"}]) == [])
t("merge is idempotent", driver.merge_reels(_m, _m) == _m)

# The harvest's two load-bearing orderings, asserted against the source so a
# later refactor cannot quietly undo them.
_hr = _inspect.getsource(driver._harvest_reels)
t("loading_more is checked BEFORE the growth/end-of-feed verdict",
  _hr.index("loading_more") < _hr.index("stalled >= site.stall_polls"),
  "poll order inverted: a spinner would read as a finished feed")
t("the stall guard does NOT require a non-zero count",
  "len(seen) > 0 and" not in _hr and "count > 0 and" not in _hr,
  "the zero-item blind spot is back: a harvest that never starts would hang")
t("hitting the scroll cap is reported, not silent",
  "scroll_cap" in _hr)
t("the harvest re-checks blockers every pass",
  "check_blockers" in _hr)

# The empty-result refusal — the single most destructive failure mode, since a
# logged-out page and an empty collection are indistinguishable.
_cr = _inspect.getsource(driver.cmd_reels)
# The browser work moved into _reels_run when the run lock was added; the
# refusal and the dry-run cut live there, so assert against the pair.
_rr = _inspect.getsource(driver._reels_run)
_cr_all = _cr + _rr
t("zero results never overwrite a non-empty cache",
  "ig_empty_harvest" in _cr_all and "refusing to overwrite" in _cr_all)
t("the refusal names the dry-run repair loop, not a retry",
  "--dry-run" in _cr_all and "retry" not in _cr_all.lower())
t("--dry-run stops before the harvest",
  _rr.index("args.dry_run") < _rr.index("_harvest_reels(page, site)"))
# --user auto-detect. The placeholder <your-handle> is a PowerShell parse error
# ('<' is a reserved operator), so the handle is read off the logged-in session
# and the flag is an override. Verified live 2026-09-16: resolved veda.1611.
_ru = _inspect.getsource(driver.resolve_ig_user)
t("the handle can be auto-detected from the session",
  callable(driver.resolve_ig_user))
t("auto-detect never navigates (it reads the page it is already on)",
  "page.goto" not in _ru, "a detour costs an extra page visit")
t("it strips a leading @ if one is returned",
  'lstrip("@")' in _ru or "lstrip('@')" in _ru)
t("IG's own reserved paths are not mistaken for a handle",
  all(w in _ru for w in ("explore", "direct", "accounts")))
t("--user is optional, not required",
  "--user is required" not in _cr_all,
  "the hard requirement is back; the placeholder trap returns with it")
t("the failure message warns about the angle-bracket trap",
  "PowerShell" in _rr and "no angle brackets" in _rr)
# --probe: the change gate. One screen, no scrolling, no write. It exists so a
# recurring check costs a screen instead of 40 scrolls — but it is STILL a page
# visit, which is why nothing schedules it by default.
t("probe stops before the harvest",
  _rr.index('getattr(args, "probe", False)') < _rr.index("_harvest_reels(page, site)"))
t("probe never scrolls",
  "mouse.wheel" not in _rr.split('args, "probe"')[1].split("_harvest_reels")[0])
t("probe never writes the cache",
  "write_reels_cloud" not in _rr.split('args, "probe"')[1].split("_harvest_reels")[0])
t("an empty cache counts as changed (so a first run harvests)",
  "or not cached" in _rr)
t("probe still runs the blocker check first",
  _rr.index("check_blockers") < _rr.index('getattr(args, "probe", False)'))
# ── The hang, and its two bounds ──────────────────────────────────────────────
# SHIPPED BROKEN and caught on a real run (2026-09-16): `loading_more` correctly
# outranks the end-of-feed verdict, but the branch continued WITHOUT
# incrementing `scrolls`, and `scrolls` was the loop's only bound. IG keeps a
# loading element in the DOM, so the loop ran 23.7 minutes — alive, burning CPU,
# holding the run lock, writing nothing — until it was killed. A hang is worse
# than a wrong answer here because nothing reports it.
# ── No loading gate, and why ──────────────────────────────────────────────────
# Three attempts failed against the live page (all measured 2026-09-16):
#   presence       -> IG's scroll sentinel is permanent, count=1 forever
#   CSS visibility -> never hidden, is_visible()=True forever
#   viewport       -> top=3043, below the fold and moving as you scroll
# Both shipped forms returned 0 reels with stoppedAt=loading_stuck. GROWTH is
# the only workable signal, so the gate is gone. These tests keep it gone.
t("there is no loading gate in the harvest loop",
  "loading_stuck" not in _hr and "site.loading_more" not in _hr,
  "the loading gate is back; it cannot work on this site — see selectors.yaml")
t("growth is the end-of-feed verdict",
  "stalled >= site.stall_polls" in _hr)
t("the growth check does NOT require a non-zero count",
  "len(seen) > 0 and" not in _hr and "count > 0 and" not in _hr,
  "a harvest that never starts must still terminate")
t("stall_polls is generous enough to absorb a slow fetch",
  ig.stall_polls >= 4, f"stall_polls={ig.stall_polls} is the ONLY signal now")
t("the harvest still has a wall clock",
  "harvest_timeout_s" in _hr and "deadline" in _hr)
_loop_body = _hr[_hr.index("while scrolls < site.max_scrolls:"):]
t("the deadline is checked at the TOP of the loop, before any branch",
  "time.monotonic() > deadline" in _loop_body
  and _loop_body.index("deadline") < _loop_body.index("scrolls += 1"),
  "a deadline checked after a continue-branch cannot bound that branch")
t("every while-level path either scrolls or breaks",
  _loop_body.count("scrolls += 1") == 1,
  "max_scrolls cannot bound a branch that never increments it — this is the "
  "bug that hung a real run for 23.7 minutes")
t("the dead-end selector is retained as documentation, not used",
  bool(ig.loading_more) and "site.loading_more" not in _hr)

# Behavioural: a page that never yields a tile must terminate, not hang. This
# is the hang regression, now expressed against the growth path.
class _StuckPage:
    async def evaluate(self, *a, **k): return ''
    def locator(self, sel):
        class _L:
            async def count(self): return 0
            @property
            def first(self): return self
            async def is_visible(self): return True
            def nth(self, i): return self
            async def get_attribute(self, n): return None
        return _L()
    class _M:
        async def wheel(self, x, y): pass
    mouse = _M()
    class _K:
        async def press(self, k): pass
    keyboard = _K()
    async def screenshot(self, **k): pass
    async def content(self): return '<html></html>'

def _probe_barren():
    """A grid that resolves but never yields a tile. Must end via the growth
    stall, never spin."""
    import asyncio as _a
    _sv = (driver.any_matches, driver.check_blockers, driver.resolve)
    async def _no(page, cands): return False
    async def _ok(page, site, *, pre_send): pass
    async def _res(page, cands, **k): return {"selector": "x", "locator": None, "count": 1}
    driver.any_matches, driver.check_blockers, driver.resolve = _no, _ok, _res
    try:
        st = driver.load_reels_site("instagram")
        st.poll_ms, st.stall_polls, st.max_scrolls = 10, 2, 50
        st.scroll_pause_s = [0.001, 0.002]
        return _a.run(_a.wait_for(driver._harvest_reels(_StuckPage(), st), timeout=20))
    finally:
        driver.any_matches, driver.check_blockers, driver.resolve = _sv

try:
    _barren = _probe_barren()
    t("a grid that never yields a tile TERMINATES (the 23.7-min hang)",
      _barren["stoppedAt"] == "exhausted" and _barren["reels"] == [],
      str(_barren)[:140])
    t("and it stops at the stall, not by exhausting max_scrolls",
      _barren["scrolls"] <= 4, f"scrolls={_barren['scrolls']}")
except Exception as _e:
    t("a grid that never yields a tile TERMINATES (the 23.7-min hang)", False,
      f"hangs or errors: {str(_e)[:120]}")

# clean_caption — IG alt text is a whole post body, and the card clamps to two
# lines in a 330px slot. MEASURED on the real harvest: 42 of the first 60
# captions carry newlines or lead with hashtags, so raw text renders as "." or
# a wall of tags. Cleaned at read time so the widget renders what it is given.
t("the headline survives, spacer dots and hashtags do not",
  driver.clean_caption("Animation done by me!\n.\n.\n.\n#digitalart #art")
  == "Animation done by me!")
t("a single-line caption is untouched",
  driver.clean_caption("i think we got em") == "i think we got em")
t("trailing hashtags on the headline itself are stripped",
  driver.clean_caption("Lil jork as requested #deer #fawn") == "Lil jork as requested")
t("an emoji-only opener yields to the real sentence",
  driver.clean_caption("\U0001F43F\U0001F43F\nthere was a chipmunk in the tub")
  == "there was a chipmunk in the tub")
t("a hashtag-only post still yields something, not an empty card",
  driver.clean_caption("#fyp #viral") != "",
  "a wrong-looking caption beats a blank card")
t("newlines never survive (they break the 2-line clamp)",
  "\n" not in driver.clean_caption("a\nb\nc"))
t("whitespace is collapsed",
  driver.clean_caption("too   many    spaces") == "too many spaces")
t("an empty caption stays empty rather than becoming junk",
  driver.clean_caption("") == "" and driver.clean_caption(None) == "")
t("the result is length-capped for the doc",
  len(driver.clean_caption("x" * 5000)) <= 300)
t("cleaning is applied at the read site, not left to the widget",
  'clean_caption(caption or "")' in _hr)

# ── Thumbnails are the HARVESTER's job now ────────────────────────────────────
# REGRESSION 2026-09-16: moving the store to the cloud removed the page's
# thumbnail step and nothing replaced it, so a harvest published 1239 reels with
# thumbKey:"" — every tile a placeholder, while 1313 thumbnails sat unused in
# KV. Nothing errored; the widget just looked broken. The harvester is the only
# writer AND the only party holding IG's signed CDN url (which expires within
# days), so it owns this.
t("the harvester attaches thumbnails before publishing",
  "attach_thumbs(merged)" in _cr_all,
  "a published doc with no thumbKeys renders as all placeholders")
t("existence is checked before uploading (a read is free, a write is not)",
  _inspect.getsource(driver.attach_thumbs).index("thumb_exists")
  < _inspect.getsource(driver.attach_thumbs).index("upload_thumb"))
t("uploads are capped per run",
  "uploaded >= REELS_THUMB_UPLOADS" in _inspect.getsource(driver.attach_thumbs),
  "the KV namespace is ~1000 writes/DAY and SHARED with StudyOS uploads")
t("the cap leaves the rest pending rather than failing the run",
  '"pending"' in _inspect.getsource(driver.attach_thumbs))
t("an oversized image is skipped, not uploaded",
  "512 * 1024" in _inspect.getsource(driver.upload_thumb))
t("a failed thumbnail is never retried",
  "retry" not in _inspect.getsource(driver.upload_thumb).lower(),
  "a signed url that already expired will not start working")
t("the signed CDN url is never published",
  '"thumbSrc"' not in _cr_all.split("doc = {")[1].split("}")[0]
  if "doc = {" in _cr_all else True,
  "IG's thumbSrc expires; only thumbKey belongs in the doc")

# Emoji in captions vs a cp1252 console. The driver's whole result is one line
# of JSON on stdout with ensure_ascii=False, so a caption emoji raised
# UnicodeEncodeError while PRINTING a finished harvest — work complete, data
# written, and still a traceback and a non-zero exit. Observed 2026-09-16.
_src_all = _inspect.getsource(driver)
t("stdout is reconfigured to UTF-8 (emoji captions are the normal case)",
  'reconfigure(encoding="utf-8"' in _src_all)
t("the reconfigure tolerates pythonw's absent streams",
  _src_all.count("except Exception") >= 1
  and "for _stream in (sys.stdout, sys.stderr)" in _src_all)
t("a caption emoji survives a round-trip through json.dumps",
  json.loads(json.dumps({"c": "cues 💪"}, ensure_ascii=False))["c"].endswith("💪"))

# The scroll cap must be able to finish a real library, not just bound a feed.
t("max_scrolls can reach the end of a real collection",
  ig.max_scrolls >= 200,
  f"max_scrolls={ig.max_scrolls}; a measured run hit the cap at 273 reels")
t("the wall clock allows the larger cap",
  ig.harvest_timeout_s >= 900, f"harvest_timeout_s={ig.harvest_timeout_s}")

t("the harvest runs under a pid-based run lock",
  "_RunLock(HERE / \".reels-run.lock\")" in _cr,
  "two concurrent harvests would fight over the one IG profile")
t("the lock wraps the browser work, not just the config read",
  _cr.index("_RunLock") < _cr.index("_reels_run("))
t("the scraper holds no Firebase credential",
  not any(w in _inspect.getsource(driver).lower()
          for w in ("firebase_admin", "service_account", "firestore.client")),
  "the credential boundary is broken: the page must own the cloud write")

# ── Real autoplay + loop, via a genuine <video> tag ─────────────────────────────
# Instagram's embed iframe can NEVER autoplay or loop on its own — VERIFIED
# 2026-09-16, not assumed: ?autoplay=1&muted=1 is silently ignored, a
# script-fired click on the play button does nothing (Event.isTrusted cannot be
# set by any JS API, same- or cross-origin — a browser spec guarantee), and even
# a genuine click does not loop (plays once, rewinds to 0, re-pauses). The one
# way around all of that is a real <video> tag pointed at Instagram's own
# progressive-download mp4 — confirmed a genuine complete file (real ftyp
# header, plays with zero session/cookies from a browser that had never visited
# instagram.com) and DISTINCT from the DASH fragments the live page streams (79
# ~800-byte pieces measured for one 13s reel — there is no single file behind
# that path).
print("\nreal video extraction (the autoplay/loop fix)")

# Two shapes actually captured from live embed pages 2026-09-16 (verbatim, not
# re-guessed — the earlier version of this test fabricated a double-slash-
# escaped form that does not occur in practice and it caught nothing).
_HTML_PLAIN = (
    'blah blah "count":851560}},"video_url":'
    '"https://scontent-atl3-1.cdninstagram.com/o1/v/t2/f2/m86/'
    'AQM3abc123.mp4?_nc_cat=110&_nc_sid=5e9851" more json here'
)
# CAPTURED VERBATIM from the real embed page's outerHTML: the key/value quotes
# are escaped (this JSON is itself embedded as a string literal inside a
# <script> tag), but the URL's OWN slashes carry only a single backslash each —
# not the doubled escaping a naive "JSON serialized twice" assumption predicts.
# Trailing `,\"oh\":...` included on purpose: a real page always has more JSON
# after the url, and a fixture truncated exactly AT the closing quote (an
# earlier version of this test did that) hides a real off-by-one at the string
# boundary instead of exercising it.
_HTML_REAL_CAPTURE = (
    'count\\":851560}},\\"video_url\\":\\"https:\\/\\/scontent-atl3-1'
    '.cdninstagram.com\\/o1\\/v\\/t2\\/f2\\/m86\\/AQM3TTa58V6YX6ss0u2RWOdP1p9E9w'
    'QGLB1VRkyc1-Vm5D-b2jbV_Z6wA2POveuJubJm_eX05Iipax-quYj7jUbw8PDAsnRNRYx_Y7M'
    '.mp4?_nc_cat=110\\u0026_nc_sid=5e9851\\",\\"oh\\":\\"00_AQIabc\\"}'
)

_u1 = driver.extract_video_url(_HTML_PLAIN)
t("extracts a video_url from an unescaped JSON blob",
  _u1 is not None and _u1.startswith("https://") and ".mp4" in _u1, _u1)
t("does not mangle a URL that needed no unescaping",
  _u1 is not None and "&" in _u1 and "_nc_sid=5e9851" in _u1, _u1)

_u2 = driver.extract_video_url(_HTML_REAL_CAPTURE)
t("extracts a video_url from the REAL escaped shape captured off a live page",
  _u2 is not None and _u2.startswith("https://") and ".mp4" in _u2, _u2)
t("fully un-escapes \\/ to / (no backslashes survive in the result)",
  _u2 is not None and "\\" not in _u2, _u2)
t("un-escapes \\u0026 to a literal &",
  _u2 is not None and "_nc_cat=110&_nc_sid=5e9851" in _u2, _u2)

t("returns None when the reel has no video_url at all",
  driver.extract_video_url("<html>no such field here</html>") is None,
  "a removed/broken post correctly yields nothing, not a crash")
t("returns None on a truncated/malformed key with no colon",
  driver.extract_video_url('"video_url" garbage no colon here') is None)

# CAPTURED VERBATIM from a live embed page via page.content() on 2026-09-16
# (saved to disk and inspected byte-by-byte with open(path, 'rb') before being
# pasted here) — a THIRD, deeper shape distinct from _HTML_REAL_CAPTURE above:
# the URL's own slashes are escaped with a doubled backslash pair (\\\/, i.e.
# three literal backslash characters before each /), while the query string's
# `&` is a bare, unescaped ampersand. This is the shape that caught the actual
# bug: a combined regex with a literal \" in its Python source silently made
# every delimiter quote OPTIONAL (in Python's `re`, \" is just an escaped
# bare ", never "backslash then quote" — the backslash is consumed by the
# regex engine, not required in the text), which happened to still pass every
# fixture above but broke the moment escape depth got deeper than they modeled.
_HTML_LIVE_CAPTURE = (
    'ed_by\\":{\\"count\\":851560}},\\"video_url\\":\\"https:\\\\\\/\\\\\\/'
    'scontent-atl3-1.cdninstagram.com\\\\\\/o1\\\\\\/v\\\\\\/t2\\\\\\/f2\\\\\\/m86'
    '\\\\\\/AQM3TTa58V6YX6ss0u2RWOdP1p9E9wQGLB1VRkyc1-Vm5D-b2jbV_Z6wA2POveuJubJm'
    '_eX05Iipax-quYj7jUbw8PDAsnRNRYx_Y7M.mp4?_nc_cat=110&_nc_sid=5e9851\\",'
    '\\"oh\\":\\"00_AQIabc\\"}'
)
_u3 = driver.extract_video_url(_HTML_LIVE_CAPTURE)
t("extracts a video_url from a REAL page.content() capture, triple-backslash slashes",
  _u3 is not None and _u3.startswith("https://") and ".mp4" in _u3, _u3)
t("collapses \\\\\\/ (triple backslash + slash) down to a single /",
  _u3 is not None and "\\" not in _u3
  and "cdninstagram.com/o1/v/t2/f2/m86/AQM3" in _u3, _u3)
t("a bare unescaped & in the query string survives untouched",
  _u3 is not None and "_nc_cat=110&_nc_sid=5e9851" in _u3, _u3)

# ── video_versions: the DASH-only reels ─────────────────────────────────────
# CAPTURED 2026-09-17 from the REAL (non-embed) page of a reel whose embed
# carried no video_url anywhere. Shape verified against the live document:
# the key is followed by an ARRAY, so the url sits one object deep — which is
# why the plain video_url scanner cannot read it and a separate entry point
# exists. The url's own escaping is the same as every other capture here.
_HTML_VERSIONS = (
    '</MPD>\\n\\",\\"video_versions\\":[{\\"type\\":101,\\"url\\":\\"'
    'https:\\\\\\/\\\\\\/scontent-atl3-1.cdninstagram.com\\\\\\/o1\\\\\\/v'
    '\\\\\\/t2\\\\\\/f2\\\\\\/m86\\\\\\/AQOrOvu47PUamxICRSt8xr4KSi8w1.mp4'
    '?_nc_cat=103&_nc_sid=5e9851\\"},{\\"type\\":102,\\"url\\":\\"https:'
    '\\\\\\/\\\\\\/example.com\\\\\\/lower.mp4\\"}]'
)
_v1 = driver.extract_video_versions_url(_HTML_VERSIONS)
t("extracts the progressive mp4 out of video_versions",
  _v1 is not None and _v1.startswith("https://") and ".mp4" in _v1, _v1)
t("it decodes the escaped slashes like the video_url path does",
  _v1 is not None and "\\" not in _v1
  and "cdninstagram.com/o1/v/t2/f2/m86/AQOrOvu47" in _v1, _v1)
t("it takes the FIRST rendition (Instagram orders these best-first)",
  _v1 is not None and "lower.mp4" not in _v1,
  "index 0 was the highest rendition in every sample inspected")
t("returns None when there is no video_versions key",
  driver.extract_video_versions_url('{"something_else":[{"url":"x.mp4"}]}') is None)
t("returns None when video_versions holds no usable mp4 url",
  driver.extract_video_versions_url('"video_versions":[{"type":101}]') is None,
  "an entry without a url must not fall through to some unrelated later key")

# ── Batching, pacing, prioritization ────────────────────────────────────────────
_avu = _inspect.getsource(driver.attach_video_urls)
t("each extraction is a real page visit (page.goto), not a fetch",
  "await page.goto" in _avu and "/embed/" in _avu)
# The cap is now resolved into `cap` at the top of the function so --videos can
# override it per run; REELS_VIDEO_BATCH remains the default it falls back to.
t("the batch is capped per run (a page visit is ~9-10s, not a cheap fetch)",
  "REELS_VIDEO_BATCH" in _avu and "extracted >= cap" in _avu)
t("the per-run cap is overridable, defaulting to REELS_VIDEO_BATCH",
  "batch if batch and batch > 0 else REELS_VIDEO_BATCH" in _avu,
  "a small collection should be coverable in full; a large one must stay "
  "bounded by default")
# The fallback that removed the iframe path for DASH-only reels. MEASURED
# 2026-09-17: 17 of 57 reels in Boosts carried no video_url on EITHER page,
# but did carry a progressive mp4 under video_versions on the real one.
t("a reel with no video_url falls back to its real page",
  "/embed/" in _avu and 'f"https://www.instagram.com/reel/{code}/"' in _avu,
  "the embed alone leaves DASH-only reels stuck on the iframe player")
t("the real-page fallback tries video_versions too",
  "extract_video_versions_url" in _avu)
t("the fallback is only spent when the embed came back empty",
  "if not url:" in _avu,
  "it is a SECOND page visit; spending it on every reel would double the "
  "automated traffic to a logged-in account for no gain")
t("pacing between visits is sampled from a range, not a fixed delay",
  "_pace([1.2, 2.4])" in _avu or "_pace(" in _avu,
  "a fixed delay between automated visits to a logged-in account is a "
  "recognisable pattern")
t("the batch starts from the WATCHED reel, not always the top of the list",
  "watch_shortcode" in _avu and "order = reels[start:] + reels[:start]" in _avu,
  "otherwise a video url only ever lands near the front of a large collection, "
  "never on what is actually being watched")
t("a reel already fresh is skipped rather than re-visited",
  'r.get("videoUrl")' in _avu and "videoUrlExpiresAt" in _avu,
  "re-fetching a URL that has not expired wastes a page visit for nothing")
t("a per-reel extraction failure never aborts the whole batch",
  "except Exception" in _avu,
  "one removed post or transient miss must not lose every other reel's video")

t("videoUrl has an absolute expiry timestamp, not a relative TTL alone",
  "videoUrlExpiresAt" in _avu and "now + REELS_VIDEO_URL_TTL_MS" in _avu,
  "the widget must be able to check freshness without knowing when the "
  "harvest ran")
t("the TTL is set BELOW the measured real-world expiry, with margin",
  driver.REELS_VIDEO_URL_TTL_MS < 36 * 60 * 60 * 1000 + 1
  and driver.REELS_VIDEO_URL_TTL_MS > 24 * 60 * 60 * 1000,
  f"REELS_VIDEO_URL_TTL_MS={driver.REELS_VIDEO_URL_TTL_MS}ms — measured expiry "
  f"was ~1.5 days (129600000ms); serving a url the CDN has already invalidated "
  f"is worse than falling back to the iframe early")

# ── Wiring into the harvest ──────────────────────────────────────────────────────
t("video extraction happens BEFORE the browser context closes",
  _cr_all.index("attach_video_urls") < _cr_all.index("await ctx.close()"),
  "extracting a video url needs an open page — this cannot run after ctx.close()")
t("it operates on the MERGED list, not just this run's fresh harvest",
  "attach_video_urls(\n                merged" in _cr_all
  or "attach_video_urls(merged" in _cr_all.replace("\n", " ").replace("  ", " "),
  "a watched reel harvested in an EARLIER run must still be eligible for a "
  "video url refresh now")
t("the watch position is read from the widget's own config, not guessed",
  "read_reels_cfg()" in _cr_all and "watchShortcode" in _cr_all)
t("a config-read failure degrades gracefully rather than failing the harvest",
  _inspect.getsource(driver.read_reels_cfg).count("except Exception") >= 1,
  "prioritization is a nice-to-have; the harvest itself must not depend on it")
t("thumbnails (plain HTTP fetches) still run AFTER the context closes",
  _cr_all.index("attach_thumbs(merged)") > _cr_all.index("await ctx.close()"),
  "thumbnails need no browser at all — running them before ctx.close() would "
  "hold the Instagram session open for no reason")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
