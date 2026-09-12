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
import re
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

    except driver.DriverError as e:
        _fail(job, e.message, retryable=e.kind in ("slide_gap", "empty_answer", "unexpected"))
    except Exception as e:
        _fail(job, str(e)[:400], retryable=True)


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
                               "driver": True, "jobs": len(_jobs)})
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

        # Idempotency, matching the Worker: same file + prompt + version returns
        # the existing result instead of re-running a slow browser job.
        fp = f"{body.get('fileId')}|{body.get('promptId')}|{body.get('promptVersion', 1)}"
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
            "site": body.get("site") or "claude",
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


def main():
    ap = argparse.ArgumentParser(description="StudyOS local pipeline bridge")
    ap.add_argument("--port", type=int, default=8781)
    args = ap.parse_args()

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
