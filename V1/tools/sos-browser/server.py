"""StudyOS local pipeline bridge.

Serves the SAME /api/ai/* contract as workers/studyos-ai, but backed by the
browser driver instead of an API key. StudyOS's ⚡ Run button, Jobs panel and
auto-run all speak this shape already, so pointing config.cloudflare.ai.baseUrl
at http://127.0.0.1:8781 is the only client change needed.

  POST   /api/ai/jobs           create        -> { ok, job }
  GET    /api/ai/jobs           list recent
  GET    /api/ai/jobs/<id>      one job
  POST   /api/ai/jobs/<id>/retry
  DELETE /api/ai/jobs/<id>
  GET    /api/ai/budget         always $0 — a subscription, not per-token
  GET    /health

── WHY A SEPARATE PROCESS AND NOT THE WORKER ─────────────────────────────────
A Cloudflare Worker cannot drive a browser. The whole point of the browser route
is that it runs where the logged-in Chrome profile lives, which is this machine.
That is also this bridge's one real limitation: it is reachable from StudyOS in
a browser ON THIS PC, not from the phone.

── JOBS OUTLIVE THE PAGE, NOT THE PROCESS ────────────────────────────────────
Jobs run on a background thread and are journaled to jobs.json after every
state change, so closing the StudyOS tab does not touch them and a crash does
not lose history. They do NOT survive this process being killed mid-run: such a
job is marked 'interrupted' on the next start rather than left claiming to be
running, because a job stuck at "running" forever is worse than one that says
it died.

── CONCURRENCY ───────────────────────────────────────────────────────────────
One job at a time, by design. Each job drives a real browser profile, and two
jobs sharing one profile fight over the same Chrome instance — the exact
"Opening in existing browser session" failure seen during development.

Run:  python server.py            (or: python server.py --port 8781)
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import driver
import pdfrender

HERE = Path(__file__).resolve().parent
JOBS_FILE = HERE / "jobs.json"
UPLOADS = HERE / "uploads"
OUTPUTS = HERE / "outputs"

SLIDES_PER_CHUNK = 15
MAX_ATTEMPTS = 2          # a browser run is slow; don't grind on a broken one

# Two shapes of job, chosen per-job by the client.
#
#   rewrite     the original flow: Claude rewrites a deck slide by slide, and
#               pdfrender pairs each answer with the real slide image.
#   notebooklm  NotebookLM generates a NEW deck from the source and we catch
#               the download. No chunking, no coverage check, no layout stage.
#
# Absent `mode` means 'rewrite', so every job already in jobs.json keeps working
# with no migration.
MODES = ("rewrite", "notebooklm")

# Retryable = "the identical run again might just work".
#
# This table is the single most consequential judgment in the deck path. Every
# NotebookLM selector is an unverified guess, so selector misses will be common
# — and MAX_ATTEMPTS=2 on a non-retryable-in-practice failure means two browser
# launches and two artifact dumps to learn exactly what the first one said.
RETRYABLE_KINDS = {
    # rewrite path (unchanged behaviour)
    "slide_gap", "empty_answer", "unexpected",
    # deck path: transient, or the far side's own failure
    "nlm_generation_failed",    # NotebookLM's own failure badge; often transient
    "nlm_timeout",              # generation outran the deadline
    "nlm_source_timeout",       # ingest was slow; a second run often clears it
    "nlm_empty_download",       # zero bytes; a re-click usually works
}
# Deliberately NOT retryable, and each for its own reason:
#
#   needs_login / bot_challenge / rate_limited
#       THE ETHICAL STOP. Retrying one of these is precisely the bypass this
#       tool refuses to perform. Pinned by test_server.py.
#   nlm_no_* (every selector miss)
#       The markup will not have changed in the 90 seconds before attempt 2.
#       A retry burns a browser launch to fail identically; the fix is a human
#       editing selectors.yaml, guided by `deck --dry-run`.
#   nlm_not_pdf
#       The site handed back something that is not a deck. Cause unknown, and a
#       retry risks filing garbage into a class.
#   nlm_queued
#       Out of quota: NotebookLM deferred the deck to a later window instead of
#       generating it. Retrying in 90 seconds cannot change a quota reset that
#       is hours away — it would just queue a second deferred deck. Same family
#       as rate_limited, and treated the same way.
#   bad_input
#       The source file is gone. Running again will not bring it back.

_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_queue: list[str] = []
_worker_started = False


# ── Persistence ───────────────────────────────────────────────────────────────
def _save():
    """Journal after every state change. Called with _lock held."""
    try:
        JOBS_FILE.write_text(json.dumps(_jobs, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        print(f"[bridge] could not journal jobs: {e}")


def _load():
    global _jobs
    if not JOBS_FILE.exists():
        return
    try:
        _jobs = json.loads(JOBS_FILE.read_text(encoding="utf-8"))
    except Exception:
        _jobs = {}
        return
    # A job marked 'running' cannot still be running — this process just
    # started. Saying so beats leaving it claiming progress forever.
    for j in _jobs.values():
        if j.get("status") in ("running", "queued"):
            j["status"] = "interrupted"
            j["error"] = "the bridge restarted while this job was in flight"
    _save()


# ── Slide coverage ────────────────────────────────────────────────────────────
# Mirrors workers/studyos-ai/worker.js missingSlides(). Any heading level plus an
# optional separator: live Claude answers "### Slide 1" when asked for "##".
_SLIDE_RE = re.compile(r"^#{1,6}\s*Slide\s*[:#-]?\s*(\d+)", re.I | re.M)


def missing_slides(text: str, lo: int, hi: int) -> list[int]:
    seen = {int(m.group(1)) for m in _SLIDE_RE.finditer(text or "")}
    return [i for i in range(lo, hi + 1) if i not in seen]


def trim_to_first_slide(text: str) -> str:
    """Drop everything before the first slide heading.

    When a file is attached, Claude narrates its tool use above the answer
    ("Reading the file-reading router skill…", "Read 15 files, ran 2 commands",
    "I've now reviewed all 15 slides…"). Those lines render inside the same
    response node, so the DOM serializer picks them up and they land at the top
    of the generated note.

    Chasing each phrasing with a regex is whack-a-mole — the wording changes per
    run. This uses the one STRUCTURAL fact that holds: the prompt demands the
    answer begin at "## Slide N", so anything before the first such heading is
    preamble by definition.

    Deliberately a no-op when no heading is found, rather than returning "":
    a chunk with no headings is already a coverage failure, and the caller's
    error should name that rather than an empty answer.
    """
    if not text:
        return text
    m = _SLIDE_RE.search(text)
    if not m:
        return text
    # Keep from the START OF THE LINE the heading sits on.
    start = text.rfind("\n", 0, m.start()) + 1
    return text[start:].strip()


# ── The output stage ──────────────────────────────────────────────────────────
def build_job_pdf(job: dict, *, force: bool = False) -> bool:
    """Render a finished job's text into a PDF deck on disk.

    Split out of _run_job so the /pdf route can call it too. Jobs generated
    before this stage existed have their text but no deck, and without an
    on-demand build they were a dead end: the idempotency cache answers
    "already generated" and refuses to re-run, so there was no way left to ask
    for the output at all.

    Never raises — a layout failure records `pdfError` and returns False, so it
    can never cost a caller the (expensive) generated text.
    """
    # A NotebookLM deck was DOWNLOADED, not assembled here — there is no text to
    # lay out against slide images. Without this guard the /pdf route (which
    # calls this with force=True whenever the file is missing from disk) would
    # rasterise the SOURCE deck and pair it against the marker string from
    # _run_notebooklm_job, producing a plausible-looking, entirely wrong PDF.
    # That is the nastiest failure available in this file.
    #
    # Returning False makes /pdf answer 404, which is the truth: a deleted
    # NotebookLM output can only be recovered by running the job again.
    if job.get("mode") == "notebooklm":
        have = bool(job.get("pdfPath") and Path(job["pdfPath"]).exists())
        if not have:
            with _lock:
                job["hasPdf"] = False
                job["pdfError"] = "the downloaded deck is gone; re-run this job"
                _save()
        return have

    if not force and job.get("pdfPath") and Path(job["pdfPath"]).exists():
        return True
    if not job.get("result"):
        return False

    if not job.get("filePath") or not Path(job["filePath"]).exists():
        with _lock:
            job["hasPdf"] = False
            job["pdfError"] = "the source PDF is no longer on disk"
            _save()
        return False

    try:
        stem = Path(job.get("sourceName") or "deck.pdf").stem
        pdf_bytes = pdfrender.build_deck_pdf(
            job["filePath"], job["result"], stem + " \u2014 Rewritten")
        OUTPUTS.mkdir(parents=True, exist_ok=True)
        out_file = OUTPUTS / (job["id"] + ".pdf")
        out_file.write_bytes(pdf_bytes)
    except Exception as e:
        print("[pdf] job " + job["id"] + " assembly failed: " + str(e))
        with _lock:
            job["hasPdf"] = False
            job["pdfError"] = str(e)[:300]
            _save()
        return False

    with _lock:
        # The bytes stay on disk and are fetched from /pdf on demand. Inlining
        # 11MB of base64 here would ride along on every poll of this job.
        job["pdfPath"] = str(out_file)
        job["hasPdf"] = True
        job["pdfBytes"] = len(pdf_bytes)
        job.pop("pdfError", None)
        _save()
    return True


# ── The runner ────────────────────────────────────────────────────────────────
def _run_job(job_id: str):
    with _lock:
        job = _jobs.get(job_id)
        if not job or job["status"] in ("done", "canceled"):
            return
        job["status"] = "running"
        job["startedAt"] = job.get("startedAt") or int(time.time() * 1000)
        job["attempts"] = job.get("attempts", 0) + 1
        _save()

    try:
        if job.get("mode") == "notebooklm":
            _run_notebooklm_job(job)
        else:
            _run_rewrite_job(job)
    except driver.DriverError as e:
        _fail(job, e.message, retryable=e.kind in RETRYABLE_KINDS)
    except Exception as e:
        _fail(job, str(e)[:400], retryable=True)


def _run_notebooklm_job(job: dict):
    """One generation, one download. No chunking: NotebookLM produces the whole
    deck in a single pass, so slideCount is advisory at most."""
    if not job.get("filePath") or not Path(job["filePath"]).exists():
        raise driver.DriverError("bad_input",
                                 "the source PDF is no longer on disk")

    OUTPUTS.mkdir(parents=True, exist_ok=True)
    out_file = OUTPUTS / (job["id"] + ".pdf")

    with _lock:
        job["progress"] = 5
        _save()

    args = argparse.Namespace(
        site=job.get("site") or "notebooklm",
        prompt=job["prompt"], prompt_file=None,
        source=job["filePath"], out=str(out_file),
        headful=False, dry_run=False,
    )
    # Deliberately no per-step progress ladder. Reporting 20/40/60 would mean
    # threading a callback from here into the driver, puncturing the "all
    # Google UI churn in one function" boundary for a cosmetic gain. A job that
    # says "running" for twenty minutes is honest.
    out = asyncio.run(driver.cmd_deck(args))

    with _lock:
        job["status"] = "done"
        job["progress"] = 100
        job["finishedAt"] = int(time.time() * 1000)
        # NOT EMPTY, and not text either. Three places gate on the truthiness
        # of `result`: build_job_pdf above, fileResult in pipeline.js, and
        # resumeWatches in pipeline-ui.js (via hasResult). An empty result here
        # means the deck downloads perfectly and is then never filed into the
        # class — the exact silent dead end the resumeWatches comment describes.
        # A marker is one line; teaching three consumers about hasPdf instead is
        # three chances to miss one. Do not "clean this up" to "".
        job["result"] = f"NotebookLM slide deck ({out['bytes']} bytes)"
        job["pdfPath"] = str(out_file)
        job["hasPdf"] = True
        job["pdfBytes"] = out["bytes"]
        job["sections"] = []          # no chunks on this path
        job.pop("pdfError", None)
        _save()


def _run_rewrite_job(job: dict):
    """The original Claude path, moved here VERBATIM from _run_job.

    Unchanged on purpose: a regression in the working path should be impossible
    to introduce by inspection of this diff.
    """
    total = int(job.get("slideCount") or SLIDES_PER_CHUNK)
    sections = job.get("sections") or []
    outline = job.get("outline") or ""
    attach = [Path(job["filePath"])] if job.get("filePath") else []

    start = job.get("nextSlide") or 1
    for lo in range(start, total + 1, SLIDES_PER_CHUNK):
        hi = min(lo + SLIDES_PER_CHUNK - 1, total)

        guard = (
            f"\n\nYou are being given ONE SEGMENT of a longer deck: slides {lo}-{hi}.\n"
            f"Cover EVERY slide in {lo}-{hi} inclusive, in order, and stop at {hi}.\n"
            f'Begin each slide\'s section with a heading of exactly the form "## Slide N".\n'
        )
        if outline:
            guard += f"\nFor continuity, earlier segments covered:\n{outline}\n(Do not repeat them.)"

        args = argparse.Namespace(
            site=job.get("site") or "claude",
            prompt=job["prompt"] + guard,
            prompt_file=None,
            # Attach the deck on the FIRST chunk only: the conversation keeps
            # it, and re-uploading per chunk wastes minutes and can trip an
            # attachment limit.
            attach=[str(p) for p in attach] if lo == start else None,
            headful=False,
        )
        out = asyncio.run(driver.cmd_ask(args))
        text = trim_to_first_slide(out.get("text") or "")

        gaps = missing_slides(text, lo, hi)
        if gaps:
            raise driver.DriverError(
                "slide_gap",
                f"slides not covered: {', '.join(map(str, gaps))}")

        sections.append({"from": lo, "to": hi, "text": text,
                         "site": out.get("site"), "clean": out.get("clean")})
        outline = (outline + f"\nSlides {lo}-{hi} covered.")[-2000:]

        with _lock:
            job["sections"] = sections
            job["outline"] = outline
            job["nextSlide"] = hi + 1
            job["progress"] = round(hi / total * 100)
            # A chunk that finished on the weakest gate is worth surfacing:
            # the text is probably fine, but it was never confirmed.
            job["lowConfidence"] = any(not s.get("clean") for s in sections)
            _save()

    result_text = "\n\n".join(s["text"] for s in sections)

    with _lock:
        job["status"] = "done"
        job["progress"] = 100
        job["finishedAt"] = int(time.time() * 1000)
        job["result"] = result_text
        _save()

    # Lay the text out against the real slide images. Deliberately AFTER the
    # text is journaled above, and build_job_pdf swallows its own errors: a
    # layout failure must not throw away a generation that cost many minutes
    # of browser time. The job keeps its text; pdfError says what went wrong.
    build_job_pdf(job)


def _fail(job: dict, message: str, *, retryable: bool):
    with _lock:
        can_retry = retryable and job.get("attempts", 0) < MAX_ATTEMPTS
        job["status"] = "queued" if can_retry else "error"
        job["error"] = message
        _save()
        if can_retry:
            _queue.append(job["id"])


def _worker_loop():
    while True:
        job_id = None
        with _lock:
            if _queue:
                job_id = _queue.pop(0)
        if job_id:
            try:
                _run_job(job_id)
            except Exception as e:
                print(f"[bridge] job {job_id} crashed: {e}")
        else:
            time.sleep(1)


def _ensure_worker():
    global _worker_started
    if not _worker_started:
        threading.Thread(target=_worker_loop, daemon=True).start()
        _worker_started = True


# ── HTTP ──────────────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        pass                                    # keep the console readable

    def _send(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # StudyOS is served from a file:// page or a workers.dev origin, so the
        # bridge must allow cross-origin reads. It binds to 127.0.0.1 only, so
        # nothing off this machine can reach it regardless.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Firebase-AppCheck")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, data: bytes, ctype: str, filename: str = ""):
        """Raw-body twin of _send(), for the generated PDF."""
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if filename:
            self.send_header("Content-Disposition",
                             f'inline; filename="{filename}"')
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Firebase-AppCheck")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send({}, 204)

    def do_GET(self):
        p = urlparse(self.path).path
        if p == "/health":
            return self._send({"ok": True, "bridge": "sos-browser",
                               "driver": True, "jobs": len(_jobs),
                               "modes": list(MODES)})
        if p == "/api/ai/budget":
            # A subscription, not per-token billing. Reported as zero spend with
            # no cap so the UI's budget line stays truthful rather than fake.
            return self._send({"ok": True, "spend": 0, "cap": 0,
                               "provider": "browser", "note": "subscription, not metered"})
        if p == "/api/ai/jobs":
            with _lock:
                jobs = sorted(_jobs.values(), key=lambda j: j.get("createdAt", 0), reverse=True)[:50]
                slim = [{k: v for k, v in j.items()
                         if k not in ("result", "sections", "prompt", "filePath", "pdfPath")} for j in jobs]
                for s, j in zip(slim, jobs):
                    s["hasResult"] = bool(j.get("result"))
            return self._send({"ok": True, "jobs": slim})
        # The generated deck's bytes. Served from disk rather than inlined into
        # the job JSON, which is polled repeatedly while a job runs — an 11MB
        # base64 blob would ride along on every one of those polls.
        # Matched BEFORE the single-job route below, which would otherwise
        # swallow "<id>/pdf" as an id.
        m = re.match(r"^/api/ai/jobs/([\w.-]+)/pdf$", p)
        if m:
            with _lock:
                job = _jobs.get(m.group(1))
            if not job:
                return self._send({"ok": False, "error": "not found"}, 404)
            # Build it now if this job has never had one. Jobs finished before
            # the layout stage shipped have their text but no deck, and the
            # idempotency cache refuses to re-run them — so without this they
            # could never produce output again. Also covers a deck deleted off
            # disk, and a job whose first layout attempt failed.
            if not job.get("pdfPath") or not Path(job["pdfPath"]).exists():
                if not build_job_pdf(job, force=True):
                    return self._send(
                        {"ok": False,
                         "error": job.get("pdfError") or "no pdf for this job"}, 404)
            try:
                data = Path(job["pdfPath"]).read_bytes()
            except OSError as e:
                return self._send({"ok": False, "error": f"pdf unreadable: {e}"}, 410)
            name = re.sub(r"[^\w.\- ]", "_",
                          Path(job.get("sourceName") or "deck.pdf").stem)
            return self._send_bytes(data, "application/pdf",
                                    f"{name} - Rewritten.pdf")

        m = re.match(r"^/api/ai/jobs/([\w.-]+)$", p)
        if m:
            with _lock:
                job = _jobs.get(m.group(1))
            return self._send({"ok": True, "job": job} if job
                              else {"ok": False, "error": "not found"}, 200 if job else 404)
        return self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        p = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            return self._send({"ok": False, "error": "bad json"}, 400)

        if p == "/api/ai/jobs":
            return self._create(body)

        m = re.match(r"^/api/ai/jobs/([\w.-]+)/filed$", p)
        if m:
            # The app has written this result into a class. Recorded so a later
            # reload does not re-file it and re-toast "Note ready" forever.
            with _lock:
                job = _jobs.get(m.group(1))
                if not job:
                    return self._send({"ok": False, "error": "not found"}, 404)
                job["filed"] = True
                _save()
            return self._send({"ok": True, "job": {"id": job["id"], "filed": True}})

        m = re.match(r"^/api/ai/jobs/([\w.-]+)/retry$", p)
        if m:
            with _lock:
                job = _jobs.get(m.group(1))
                if not job:
                    return self._send({"ok": False, "error": "not found"}, 404)
                job.update(status="queued", error="", attempts=0)
                _queue.append(job["id"])
                _save()
            _ensure_worker()
            return self._send({"ok": True, "job": job})
        return self._send({"ok": False, "error": "not found"}, 404)

    def do_DELETE(self):
        m = re.match(r"^/api/ai/jobs/([\w.-]+)$", urlparse(self.path).path)
        if not m:
            return self._send({"ok": False, "error": "not found"}, 404)
        with _lock:
            _jobs.pop(m.group(1), None)
            _save()
        return self._send({"ok": True, "deleted": m.group(1)})

    def _create(self, body):
        prompt = (body.get("prompt") or "").strip()
        if not prompt:
            return self._send({"ok": False, "error": "prompt required"}, 400)

        # Validated here rather than branched on later: a client typo should
        # fail at create time, not fall through to an unknown runner branch.
        mode = body.get("mode") or "rewrite"
        if mode not in MODES:
            return self._send({"ok": False,
                               "error": f"unknown mode {mode!r}; "
                                        f"expected one of {', '.join(MODES)}"}, 400)

        # Idempotency, matching the Worker: same file + prompt + version returns
        # the existing result instead of re-running a slow browser job.
        #
        # MODE IS PART OF THE KEY. Without it, the same file+prompt run through
        # both paths collides and the cache hands back the other path's job —
        # a silent wrong answer rather than an error. This does invalidate every
        # fingerprint written before this change, so the first re-run of an old
        # job regenerates once. That one-off cost beats a conditional key that
        # breaks the day a third mode appears.
        fp = (f"{body.get('fileId')}|{body.get('promptId')}"
              f"|{body.get('promptVersion', 1)}|{mode}")
        with _lock:
            for j in _jobs.values():
                if j.get("fingerprint") == fp and j.get("status") == "done":
                    return self._send({"ok": True, "cached": True, "job": j})

        file_path = None
        if body.get("fileB64"):
            UPLOADS.mkdir(parents=True, exist_ok=True)
            name = re.sub(r"[^\w.\-]", "_", body.get("sourceName") or "deck.pdf")
            file_path = UPLOADS / f"{uuid.uuid4().hex[:8]}-{name}"
            try:
                file_path.write_bytes(base64.b64decode(body["fileB64"]))
            except Exception as e:
                return self._send({"ok": False, "error": f"bad attachment: {e}"}, 400)

        job = {
            "id": "sb_" + uuid.uuid4().hex[:10],
            "fileId": body.get("fileId") or "",
            "sourceName": body.get("sourceName") or "",
            "promptId": body.get("promptId") or "inline",
            "promptVersion": body.get("promptVersion") or 1,
            "prompt": prompt,
            "classId": body.get("classId") or "",
            "outputModuleId": body.get("outputModuleId") or "",
            "slideCount": max(1, min(600, int(body.get("slideCount") or SLIDES_PER_CHUNK))),
            "mode": mode,
            # Forced, not merely defaulted: this is the trust boundary. A job
            # with mode=notebooklm and site=claude would send cmd_deck to
            # load_deck_site('claude'), which exits. The client sets this too;
            # this is the half that has to be right.
            "site": ("notebooklm" if mode == "notebooklm"
                     else (body.get("site") or "claude")),
            "filePath": str(file_path) if file_path else "",
            "fingerprint": fp,
            "status": "queued", "progress": 0, "attempts": 0, "costUsd": 0,
            "createdAt": int(time.time() * 1000),
        }
        with _lock:
            _jobs[job["id"]] = job
            _queue.append(job["id"])
            _save()
        _ensure_worker()
        return self._send({"ok": True, "job": job})


# ── autostart ─────────────────────────────────────────────────────────────────
# The bridge is the one part of StudyOS that cannot be "just a page": the logged-in
# Chrome profile lives on this PC, so a browser tab can never start it. Having to
# run `python server.py` first makes the ⚡ button the only thing in StudyOS with a
# manual step, and a button that is dead until you remember something is a button
# you stop pressing.
#
# So the bridge becomes a logon item. After this, opening StudyOS is enough.
#
# A STARTUP SHORTCUT, NOT A SCHEDULED TASK — the same decision, for the same
# reason, as `magi autostart` (see magi/cli/serve.py): Register-ScheduledTask
# needs elevation, and an autostart that prompts for admin to install is not an
# autostart. The Startup folder is per-user, needs no rights, and is somewhere
# you can see and delete by hand.
#
# pythonw.exe, not python.exe: a console window on every logon is exactly the
# thing this exists to remove.
SHORTCUT_NAME = "StudyOS Bridge.lnk"


def _startup_dir() -> Path:
    return (Path(os.environ["APPDATA"]) / "Microsoft" / "Windows"
            / "Start Menu" / "Programs" / "Startup")


def _healthy(port: int, timeout: float = 2.0) -> bool:
    """True when something is already answering /health on this port."""
    import urllib.request
    try:
        with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/health", timeout=timeout) as r:
            return json.loads(r.read()).get("ok") is True
    except Exception:
        return False


def _pythonw() -> Path:
    """The windowless twin of the interpreter running this script."""
    exe = Path(sys.executable)
    cand = exe.with_name("pythonw.exe")
    return cand if cand.exists() else exe


def autostart(action: str, port: int) -> int:
    if os.name != "nt":
        print("  autostart is Windows-only (it writes a Startup-folder shortcut).")
        return 1

    lnk = _startup_dir() / SHORTCUT_NAME

    if action == "status":
        print()
        print(f"  startup shortcut: {'present' if lnk.exists() else 'not installed'}")
        print(f"  {lnk}")
        print(f"  bridge on 127.0.0.1:{port}: "
              f"{'up' if _healthy(port) else 'not responding'}")
        print()
        return 0

    if action == "off":
        try:
            lnk.unlink()
            print(f"\n  Removed {lnk.name} - the bridge no longer starts at logon.")
        except FileNotFoundError:
            print("\n  Nothing to remove; it was not installed.")
        print("  Any bridge already running is left alone.\n")
        return 0

    pyw = _pythonw()
    here = Path(__file__).resolve().parent
    lnk.parent.mkdir(parents=True, exist_ok=True)

    # Quoting: the repo path contains no quotes, but it may contain spaces, so
    # every path goes inside single quotes for PowerShell.
    script = (
        "$w = New-Object -ComObject WScript.Shell; "
        f"$s = $w.CreateShortcut('{lnk}'); "
        f"$s.TargetPath = '{pyw}'; "
        f"$s.Arguments = '\"{here / 'server.py'}\" --port {port}'; "
        f"$s.WorkingDirectory = '{here}'; "
        "$s.Description = 'StudyOS pipeline bridge'; "
        "$s.WindowStyle = 7; "
        "$s.Save(); "
        "if (Test-Path $s.FullName) { 'ok' } else { throw 'shortcut not written' }"
    )
    r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive",
                        "-Command", script], capture_output=True, text=True)
    out = (r.stdout or r.stderr).strip()
    # Checked, not assumed: a script that prints its own confirmation regardless
    # of what the cmdlet did reports success while silently failing.
    if r.returncode != 0 or "ok" not in out:
        print(f"\n  [X] could not write the shortcut:\n{out}\n")
        return 1

    print(f"\n  Installed {lnk.name} - the bridge now starts when you log in.")

    if _healthy(port):
        print(f"  Already running on 127.0.0.1:{port}.\n")
        return 0

    # Start it now rather than making you log out to see it work.
    print("  Starting it now...")
    subprocess.Popen([str(pyw), str(here / "server.py"), "--port", str(port)],
                     cwd=str(here))
    for _ in range(30):
        if _healthy(port, timeout=1):
            print(f"\n  The bridge is up on 127.0.0.1:{port}. Open StudyOS and")
            print("  press the lightning button - no terminal needed again.\n")
            return 0
        time.sleep(1)
    print("\n  [!] Installed, but it has not answered yet.")
    print(f"      Check `python server.py autostart status` in a moment.\n")
    return 0


def main():
    ap = argparse.ArgumentParser(description="StudyOS local pipeline bridge")
    ap.add_argument("--port", type=int, default=8781)
    sub = ap.add_subparsers(dest="cmd")
    a = sub.add_parser("autostart", help="run the bridge at logon")
    a.add_argument("action", nargs="?", default="on",
                   choices=["on", "off", "status"])
    args = ap.parse_args()

    if args.cmd == "autostart":
        raise SystemExit(autostart(args.action, args.port))

    # Refuse to start a second copy. Two bridges on one port means the newcomer
    # dies with a confusing bind error, and two driving one Chrome profile is the
    # "Opening in existing browser session" failure. Silent under pythonw, where
    # there is no console to read anyway.
    if _healthy(args.port, timeout=1):
        print(f"  A bridge is already running on 127.0.0.1:{args.port}. Nothing to do.")
        return

    _load()
    _ensure_worker()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"  StudyOS bridge on http://127.0.0.1:{args.port}")
    print(f"  Point config.cloudflare.ai.baseUrl at that, and set enabled: true.")
    print(f"  {len(_jobs)} job(s) in history. Ctrl+C to stop.\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped.")


if __name__ == "__main__":
    main()
