"""Tests for the StudyOS bridge's job routing.

Covers the decisions that are invisible at runtime until they cost something:

  "the ethical line is in the retry table"
      needs_login / bot_challenge / rate_limited must never be retryable.
      Retrying one of those IS the bypass this tool refuses to perform, and the
      refusal lives in one set literal that a well-meaning edit could widen.

  "selector misses are not retryable"
      Every NotebookLM selector is an unverified guess, so misses are the
      expected failure. MAX_ATTEMPTS=2 on a miss means two browser launches to
      learn what the first one already said.

  "mode is part of the idempotency key"
      Without it the same file+prompt run through both pipelines collides and
      the cache returns the OTHER pipeline's job — a plausible wrong answer
      rather than an error.

  "build_job_pdf never lays out a downloaded deck"
      The /pdf route calls it with force=True whenever the file is missing. On
      a notebooklm job that would rasterise the SOURCE deck and pair it against
      the marker string, producing a confident, entirely wrong PDF.

Run:  python test_server.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pdfrender  # noqa: E402
import shutil as _shutil  # noqa: E402
import tempfile as _tempfile  # noqa: E402
import server  # noqa: E402

# THE TEST MUST NEVER WRITE THE REAL JOB JOURNAL.
#
# MEASURED (2026-09-23): running this file DESTROYED jobs.json — the live
# history of every deck run, including the notebookUrl that makes a failed
# download recoverable without spending quota again.
#
# The mechanism is quiet and entirely plausible. `import server` does NOT call
# `_load()` (only main() does), so `server._jobs` is `{}` in a test process.
# Several functions under test — build_job_pdf among them — journal their work
# by calling `_save()`, which faithfully writes that empty dict over the real
# file. Every test passed while doing it.
#
# Redirecting the module's JOBS_FILE at a temp path fixes it for the whole
# file, including tests that do not stub `_save` themselves, and it cannot be
# forgotten by the next test added below.
_tmp_jobs = Path(_tempfile.mkdtemp(prefix="sos-test-jobs-"))
server.JOBS_FILE = _tmp_jobs / "jobs.json"
import atexit  # noqa: E402
atexit.register(lambda: _shutil.rmtree(_tmp_jobs, ignore_errors=True))

_HERE = Path(__file__).resolve().parent

PASS = FAIL = 0


def t(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   " + name)
    else:
        FAIL += 1
        print("  FAIL " + name + (("\n       " + str(extra)[:300]) if extra else ""))


# ── Modes ─────────────────────────────────────────────────────────────────────
print("\nmodes")
t("both pipelines are declared", set(server.MODES) == {"rewrite", "notebooklm"},
  server.MODES)
t("rewrite is first, so it reads as the default", server.MODES[0] == "rewrite")


# ── The ethical line ──────────────────────────────────────────────────────────
print("\nretry table — the ethical line")
for kind in ("needs_login", "bot_challenge", "rate_limited"):
    t(f"{kind} is NOT retryable", kind not in server.RETRYABLE_KINDS)


# ── Selector misses ───────────────────────────────────────────────────────────
print("\nretry table — selector misses cost a browser launch to learn nothing")
_NO_NOTEBOOK = {"id": "j"}          # a job that would have to REGENERATE
for kind in ("nlm_no_create", "nlm_no_file_input", "nlm_no_studio",
             "nlm_no_slide_deck", "nlm_no_customize", "nlm_no_prompt_input",
             "nlm_no_generate", "nlm_no_download"):
    t(f"{kind} is NOT retryable", not server.is_retryable(kind, _NO_NOTEBOOK))
# Every pre-Generate selector miss stays unconditionally non-retryable: those
# fail before a notebook exists, so there is nothing to fetch and a retry can
# only repeat the same miss.
t("no pre-Generate nlm_no_* kind slipped into the table",
  not [k for k in server.RETRYABLE_KINDS
       if k.startswith("nlm_no_") and k not in server._DOWNLOAD_STAGE_KINDS],
  [k for k in server.RETRYABLE_KINDS
   if k.startswith("nlm_no_") and k not in server._DOWNLOAD_STAGE_KINDS])

# ── Download-stage failures: cheap to retry, but ONLY with a notebook ─────────
# Generation already succeeded, so the deck is finished in its notebook. With
# the URL recorded the retry is a fetch (spends nothing); without it the retry
# regenerates and spends the quota a second time.
print("\nretry table — download-stage failures depend on the notebook")
_WITH = {"id": "j", "notebookUrl": "https://notebooklm/x"}
for kind in sorted(server._DOWNLOAD_STAGE_KINDS):
    t(f"{kind} IS retryable once the notebook is known",
      server.is_retryable(kind, _WITH))
    t(f"{kind} is NOT retryable without one (it would regenerate)",
      not server.is_retryable(kind, _NO_NOTEBOOK))
t("a notebookUrl never makes the ethical stops retryable",
  not any(server.is_retryable(k, _WITH)
          for k in ("needs_login", "bot_challenge", "rate_limited")))
t("a notebookUrl never makes a pre-Generate miss retryable",
  not server.is_retryable("nlm_no_slide_deck", _WITH))
t("nlm_queued stays a quota wait, notebook or not",
  not server.is_retryable("nlm_queued", _WITH))
t("nlm_not_pdf is NOT retryable (a retry risks filing garbage)",
  "nlm_not_pdf" not in server.RETRYABLE_KINDS)
# A quota reset is hours away; retrying in 90s would just queue a second
# deferred deck. Same family as rate_limited, treated the same way.
t("nlm_queued is NOT retryable (it is a quota wait, not a fault)",
  "nlm_queued" not in server.RETRYABLE_KINDS)


# ── Genuinely transient ───────────────────────────────────────────────────────
print("\nretry table — transient failures DO retry")
for kind in ("nlm_generation_failed", "nlm_timeout", "nlm_empty_download"):
    t(f"{kind} is retryable", kind in server.RETRYABLE_KINDS)
print("  (and the rewrite path is unchanged)")
for kind in ("slide_gap", "empty_answer", "unexpected"):
    t(f"{kind} is still retryable", kind in server.RETRYABLE_KINDS)


# ── Idempotency ───────────────────────────────────────────────────────────────
print("\nfingerprint")


def fp(file_id, prompt_id, version, mode):
    """Mirrors the expression in Handler._create."""
    return f"{file_id}|{prompt_id}|{version}|{mode}"


t("the two pipelines do not collide on one file+prompt",
  fp("f1", "p1", 1, "rewrite") != fp("f1", "p1", 1, "notebooklm"))
t("the same job in one pipeline still caches",
  fp("f1", "p1", 1, "notebooklm") == fp("f1", "p1", 1, "notebooklm"))
t("a prompt edit still busts the cache",
  fp("f1", "p1", 1, "rewrite") != fp("f1", "p1", 2, "rewrite"))


# ── build_job_pdf must not lay out a downloaded deck ───────────────────────────
print("\nbuild_job_pdf on a downloaded deck")

_called = {"n": 0}
_real = pdfrender.build_deck_pdf


def _spy(*a, **k):
    _called["n"] += 1
    raise AssertionError("pdfrender was invoked for a notebooklm job")


pdfrender.build_deck_pdf = _spy
try:
    gone = {"id": "t_gone", "mode": "notebooklm", "result": "marker",
            "filePath": str(Path(__file__)), "pdfPath": "/definitely/not/here.pdf"}
    t("returns False when the download is gone", server.build_job_pdf(gone, force=True) is False)
    t("says how to recover, rather than inventing a deck",
      "re-run" in (gone.get("pdfError") or ""), gone.get("pdfError"))
    t("marks hasPdf false", gone.get("hasPdf") is False)

    here = {"id": "t_here", "mode": "notebooklm", "result": "marker",
            "filePath": str(Path(__file__)), "pdfPath": str(Path(__file__))}
    t("returns True when the download is still on disk",
      server.build_job_pdf(here, force=True) is True)

    t("pdfrender was never called for either", _called["n"] == 0, _called["n"])
finally:
    pdfrender.build_deck_pdf = _real

# The rewrite path must still reach the layout stage — the guard is meant to be
# narrow, and a guard that swallowed both paths would be silent and total.
t("a rewrite job with no result still declines cleanly",
  server.build_job_pdf({"id": "t_rw", "result": ""}) is False)


# ── Slide coverage is untouched ───────────────────────────────────────────────
print("\nrewrite path regression")
t("missing_slides still finds a gap",
  server.missing_slides("## Slide 1\ntext\n## Slide 3\nmore", 1, 3) == [2])
t("trim_to_first_slide still drops preamble",
  server.trim_to_first_slide("Read a file.\n## Slide 1\nbody").startswith("## Slide 1"))

# -- The served filename names the pipeline that made it ----------------------
# A NotebookLM deck and a Claude rewrite of the SAME source are both allowed to
# exist (the dedup key is (sourceFileId, mode)), so the filename is the only
# thing separating them once saved. This was hardcoded to "Rewritten".
print("\ndownload filename")
t("a notebooklm deck is served as Slides",
  server.download_name({'sourceName': 'Lecture 4.pdf', 'mode': 'notebooklm'})
  == 'Lecture 4 - Slides.pdf',
  server.download_name({'sourceName': 'Lecture 4.pdf', 'mode': 'notebooklm'}))
t("a rewrite keeps its old name",
  server.download_name({'sourceName': 'Lecture 4.pdf', 'mode': 'rewrite'})
  == 'Lecture 4 - Rewritten.pdf',
  server.download_name({'sourceName': 'Lecture 4.pdf', 'mode': 'rewrite'}))
t("a job from before `mode` existed is still a rewrite",
  server.download_name({'sourceName': 'Lecture 4.pdf'})
  == 'Lecture 4 - Rewritten.pdf')
t("the two pipelines never collide on one source",
  server.download_name({'sourceName': 'L.pdf', 'mode': 'notebooklm'})
  != server.download_name({'sourceName': 'L.pdf', 'mode': 'rewrite'}))
t("a nameless job still produces a usable filename",
  server.download_name({'mode': 'notebooklm'}) == 'deck - Slides.pdf',
  server.download_name({'mode': 'notebooklm'}))
t("path separators cannot escape the filename",
  '/' not in server.download_name({'sourceName': 'a/b/c.pdf'})
  and chr(92) not in server.download_name({'sourceName': 'a' + chr(92) + 'b.pdf'}))

# -- Recovery: never pay for the same deck twice ------------------------------
# A run killed mid-download leaves the deck FINISHED in its notebook. Because
# `deck` always creates a NEW notebook, a naive retry regenerates and spends the
# quota again. _run_notebooklm_job branches to cmd_fetch when notebookUrl is
# known; these pin that branch without driving a browser.
print("\nrecovery via fetch")
t("the driver exposes a fetch command", hasattr(server.driver, 'cmd_fetch'))
t("fetch is registered in the CLI dispatch",
  'fetch' in Path(server.driver.__file__).read_text(encoding='utf-8'))

_calls = {}


def _fake_fetch(args):
    _calls['fetch'] = dict(url=getattr(args, 'url', None),
                           out=getattr(args, 'out', None))
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_bytes(b'%PDF-1.4 recovered %%EOF')
    return {'pdfPath': args.out, 'bytes': 23, 'fetched': True}


def _fake_deck(args):
    _calls['deck'] = True
    raise AssertionError('cmd_deck must NOT run when the notebook is known')


_real_fetch = getattr(server.driver, 'cmd_fetch', None)
_real_deck = server.driver.cmd_deck
_real_run = server.asyncio.run
# Redirect OUTPUTS at a throwaway directory for the duration.
#
# _run_notebooklm_job writes the recovered deck to OUTPUTS/<job id>.pdf, and
# without this the test drops a 24-byte "sb_recover.pdf" into the REAL outputs
# folder beside genuine decks — test pollution sitting in a production
# directory, which then has to be told apart from a real (if tiny) result.
_real_outputs = server.OUTPUTS
_tmp_outputs = _tempfile.mkdtemp(prefix="sos-test-outputs-")
server.OUTPUTS = Path(_tmp_outputs)
server.driver.cmd_fetch = _fake_fetch
server.driver.cmd_deck = _fake_deck
server.asyncio.run = lambda c: c   # our fakes are plain functions
try:
    _job = {'id': 'sb_recover', 'mode': 'notebooklm', 'prompt': 'p',
            'filePath': __file__, 'notebookUrl': 'https://notebooklm/x',
            'sourceName': 'L.pdf'}
    server._run_notebooklm_job(_job)
    t('a known notebook is fetched, not regenerated',
      'fetch' in _calls and 'deck' not in _calls, _calls)
    t('fetch is pointed at the stored notebook',
      _calls.get('fetch', {}).get('url') == 'https://notebooklm/x')
    t('the recovered job is marked done', _job.get('status') == 'done')
    t('and carries a non-empty result (three consumers gate on it)',
      bool(_job.get('result')), _job.get('result'))
    t('and reports a pdf', _job.get('hasPdf') is True)
finally:
    server.driver.cmd_deck = _real_deck
    if _real_fetch is not None:
        server.driver.cmd_fetch = _real_fetch
    server.asyncio.run = _real_run
    server.OUTPUTS = _real_outputs
    _shutil.rmtree(_tmp_outputs, ignore_errors=True)
t("the test wrote nothing into the real outputs folder",
  not (_real_outputs / "sb_recover.pdf").exists(),
  "sb_recover.pdf leaked into outputs/")



# ── A cache hit must honour the destination chosen THIS time ──────────────────
# The bug this pins: the deck generated perfectly in NotebookLM and landed in
# the wrong module (or appeared nowhere at all). The fingerprint keys on
# fileId|promptId|version|mode and deliberately does NOT include the
# destination — adding it would treat "same deck, different module" as a miss
# and REGENERATE, burning ~11 min of a hard daily quota to rebuild a file that
# already exists. But the cached record carries the FIRST run's classId and
# outputModuleId, and the client files the deck using the job it gets back. So
# re-running one lecture into a different module silently re-filed it into the
# old one. Nothing errored; the deck simply went somewhere else.
print("\ncache hit honours the current destination")


class _FakeCreate(server.Handler):
    """Drives the real Handler._create without a socket.

    Subclassed rather than reimplemented, so the test exercises the SHIPPING
    branch: a local copy of the cache logic would keep passing after the real
    one regressed, which is exactly how this bug survived in the first place.
    """

    def __init__(self):
        self.sent = None

    def _send(self, obj, status=200):
        self.sent = (obj, status)
        return obj


def _create(body):
    h = _FakeCreate()
    h._create(body)
    return h.sent[0]


_real_jobs = server._jobs
_real_save = server._save
_real_queue = server._queue
_real_worker = server._ensure_worker
server._save = lambda: None
server._ensure_worker = lambda: None
try:
    cached_job = {
        "id": "sb_cached", "fileId": "f1", "promptId": "p1", "promptVersion": 1,
        "mode": "notebooklm", "status": "done", "result": "deck bytes",
        "fingerprint": "f1|p1|1|notebooklm",
        "classId": "CLASS_A", "outputModuleId": "MOD_OLD", "filed": True,
    }
    server._jobs = {"sb_cached": cached_job}
    server._queue = []

    out = _create({"prompt": "x", "fileId": "f1", "promptId": "p1",
                   "promptVersion": 1, "mode": "notebooklm",
                   "classId": "CLASS_A", "outputModuleId": "MOD_NEW"})

    t("the cache still hits, so no quota is spent", out.get("cached") is True)
    t("and it is the SAME job, not a regeneration", out["job"]["id"] == "sb_cached")
    t("the returned job points at the module chosen THIS time",
      out["job"]["outputModuleId"] == "MOD_NEW", out["job"]["outputModuleId"])
    t("the stored record agrees, so resumeWatches files it to the same place",
      server._jobs["sb_cached"]["outputModuleId"] == "MOD_NEW")
    t("`filed` is cleared, or the re-file would be skipped entirely",
      "filed" not in server._jobs["sb_cached"])
    t("the result bytes are reused, not discarded",
      out["job"].get("result") == "deck bytes")

    # Re-running into the SAME module must not churn the record — in particular
    # it must not clear `filed` and re-toast "Deck ready" on every boot.
    server._jobs["sb_cached"]["filed"] = True
    out2 = _create({"prompt": "x", "fileId": "f1", "promptId": "p1",
                    "promptVersion": 1, "mode": "notebooklm",
                    "classId": "CLASS_A", "outputModuleId": "MOD_NEW"})
    t("an unchanged destination leaves `filed` alone",
      server._jobs["sb_cached"].get("filed") is True and out2.get("cached") is True)

    # A different CLASS is the multi-class half of the bug: one lecture PDF
    # filed into two classes must follow the class asked for, not the first.
    out3 = _create({"prompt": "x", "fileId": "f1", "promptId": "p1",
                    "promptVersion": 1, "mode": "notebooklm",
                    "classId": "CLASS_B", "outputModuleId": "MOD_B"})
    t("a different class is honoured too, not just a different module",
      out3["job"]["classId"] == "CLASS_B" and out3["job"]["outputModuleId"] == "MOD_B",
      (out3["job"]["classId"], out3["job"]["outputModuleId"]))

    # A caller that sends no classId (an older client) must not blank a good one.
    server._jobs["sb_cached"]["classId"] = "CLASS_B"
    out4 = _create({"prompt": "x", "fileId": "f1", "promptId": "p1",
                    "promptVersion": 1, "mode": "notebooklm"})
    t("an omitted classId does not wipe the stored destination",
      out4["job"]["classId"] == "CLASS_B", out4["job"]["classId"])

    # A job that is NOT done must never satisfy the cache, or a deck still
    # generating would be handed back as a finished one.
    server._jobs = {"sb_run": dict(cached_job, id="sb_run", status="running")}
    server._queue = []
    out5 = _create({"prompt": "x", "fileId": "f1", "promptId": "p1",
                    "promptVersion": 1, "mode": "notebooklm",
                    "classId": "CLASS_A", "outputModuleId": "MOD_NEW"})
    t("an unfinished job is not served from the cache",
      not out5.get("cached") and out5["job"]["id"] != "sb_run")
    t("a fresh job carries the requested destination",
      out5["job"]["outputModuleId"] == "MOD_NEW"
      and out5["job"]["classId"] == "CLASS_A")
finally:
    server._jobs = _real_jobs
    server._queue = _real_queue
    server._save = _real_save
    server._ensure_worker = _real_worker

# ── The test must not destroy the real job journal ────────────────────────────
# MEASURED (2026-09-23): running this file wiped jobs.json — the live history of
# every deck run, including the notebookUrl that makes a failed download
# recoverable for free. `import server` never calls _load(), so server._jobs is
# {} here, and any function that journals its work (build_job_pdf does) writes
# that empty dict straight over the real file. Every test passed while doing it.
print("\ntest isolation")
t("the journal path is redirected away from the real file",
  server.JOBS_FILE != _HERE / "jobs.json", server.JOBS_FILE)
t("and points somewhere temporary", "sos-test-jobs-" in str(server.JOBS_FILE))
# The real proof: journal now, with the empty _jobs that caused the loss, and
# confirm the real file is untouched.
_real_journal = _HERE / "jobs.json"
_before = _real_journal.read_bytes() if _real_journal.exists() else None
server._save()
t("calling _save() leaves the real journal byte-identical",
  (_real_journal.read_bytes() if _real_journal.exists() else None) == _before,
  "the test just overwrote the live job history")


print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
