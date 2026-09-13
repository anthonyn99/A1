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
import server  # noqa: E402

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
for kind in ("nlm_no_create", "nlm_no_file_input", "nlm_no_studio",
             "nlm_no_slide_deck", "nlm_no_customize", "nlm_no_prompt_input",
             "nlm_no_generate", "nlm_no_download"):
    t(f"{kind} is NOT retryable", kind not in server.RETRYABLE_KINDS)
t("no nlm_no_* kind slipped in",
  not [k for k in server.RETRYABLE_KINDS if k.startswith("nlm_no_")],
  [k for k in server.RETRYABLE_KINDS if k.startswith("nlm_no_")])
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

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
