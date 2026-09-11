"""FastAPI app: REST for commands, SSE for progress.

SSE rather than WebSocket because the traffic is strictly server->client
progress; SSE reconnects on its own and can be debugged with curl.

A council run takes minutes, far longer than a sane HTTP timeout, so POST /runs
starts a background task and returns immediately. Progress arrives on
GET /runs/{id}/stream, and everything lands in SQLite so a browser reload can
recover a run that is already in flight.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from . import accounts as accounts_mod
from .db import Database
from .engine import brainstorm as brainstorm_engine
from .engine import refine as refine_engine
from .engine import studio as studio_engine
from .engine.orchestrator import Orchestrator, required_members
from .errors import FailureKind, explain
from .providers import gemini_api
from .providers.base import ProviderEvent, RunContext
from .providers.registry import build_provider, build_providers
from .settings import ROOT, load_settings

settings = load_settings()
db = Database(settings.db_path)

# run_id -> live state for streaming clients
_runs: dict[str, dict] = {}

# job_id -> live state for a Studio artifact generation. Keyed separately from
# _runs (by job_id, not run_id) because one run can have several Studio
# artifacts generating at once.
_studio_jobs: dict[str, dict] = {}

# job_id -> live state for one brainstorm round or finalise. Keyed by job
# rather than session for the same reason as Studio: the stream belongs to the
# work, not to the thing the work is about.
_brainstorm_jobs: dict[str, dict] = {}

# Uploads are staged to disk per run and handed to each provider as a real
# file path -- Playwright's set_input_files needs one, and streaming an
# UploadFile straight into the browser call would mean re-reading it once per
# provider (the same file goes to every council member).
UPLOADS_DIR = ROOT / "data" / "uploads"

# Keeps the on-disk name predictable and shell/path safe without touching the
# user-visible name shown in the composer, which is stored separately.
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def _stage_upload_name(original: str) -> str:
    stem = _SAFE_NAME.sub("_", original)[:120] or "file"
    return f"{uuid.uuid4().hex[:8]}-{stem}"


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init()
    yield


app = FastAPI(title="MAGI", lifespan=lifespan)


# Where magi.html is served from. A1 is a GitHub Pages repo, so this is the
# one hosted origin that exists -- unlike the Firebase project this replaced,
# it never changes, which is why it can be a constant instead of a build-time
# variable. "null" is the origin of a file:// page, so magi.html opened straight
# off disk works too (the usual way a change gets checked before it is pushed).
PAGES_ORIGIN = "https://anthonyn99.github.io"


def _allowed_origins() -> list[str]:
    """Origins permitted to call this API.

    Deliberately NOT "*": these endpoints launch browsers holding live logins,
    and a wildcard with credentials is rejected by browsers anyway. Extra
    origins can be added through MAGI_ALLOWED_ORIGINS (comma separated) without
    editing code.
    """
    origins = [PAGES_ORIGIN, "null"]
    extra = os.environ.get("MAGI_ALLOWED_ORIGINS", "")
    origins += [o.strip().rstrip("/") for o in extra.split(",") if o.strip()]
    return origins


def _required_token() -> str:
    """Shared secret required on every API call, or "" to disable the gate.

    This exists because a quick tunnel (trycloudflare.com) CANNOT sit behind
    Cloudflare Access -- Access binds to a hostname on a zone you own, and a
    quick tunnel's hostname belongs to Cloudflare. Without this the tunnel URL
    is the only secret protecting endpoints that drive live logged-in accounts,
    and URLs leak: proxies, extensions, history, screenshots.

    Unset (the default) the gate is OFF, so local use over 127.0.0.1 is
    unchanged. Set MAGI_API_TOKEN on any machine exposing a tunnel.
    """
    return os.environ.get("MAGI_API_TOKEN", "").strip()


def _arrived_over_the_tunnel(request: Request) -> bool:
    """Did this request come in from the internet, or from this machine?

    The token exists to protect the TUNNEL. uvicorn binds 127.0.0.1, so a
    request that did not come through cloudflared came from a process already
    on this PC -- and demanding a shared secret to talk to a server running on
    your own machine, from a page that same server just handed you, is friction
    with nothing behind it. That is exactly what happened once MAGI_API_TOKEN
    was set: `GET /` returned the console and every `GET /api/*` it made came
    back 401.

    Client IP cannot answer this. cloudflared proxies to 127.0.0.1, so tunnel
    traffic arrives from the same address local traffic does.

    So two independent signals, and EITHER one means "treat it as remote":

      · Cloudflare's own proxy headers (CF-Ray, CF-Connecting-IP), which
        cloudflared attaches to everything it forwards;
      · a Host header that is not a loopback literal -- a browser sends the
        hostname it dialled, so a tunnel request carries
        <name>.trycloudflare.com.

    Failing CLOSED is the point of using both: the gate drops only when the
    request looks local by both measures at once, so one of them changing
    behaviour cannot silently open the API.
    """
    if request.headers.get("cf-ray") or request.headers.get("cf-connecting-ip"):
        return True
    raw = (request.headers.get("host") or "").strip().lower()
    # IPv6 literals are bracketed -- "[::1]:8000" -- so the port cannot just be
    # split off at the first colon. Chrome really does dial ::1 for localhost,
    # so getting this wrong locks the console out of its own backend on exactly
    # the machine it is running on.
    if raw.startswith("["):
        host = raw[1 : raw.index("]")] if "]" in raw else raw[1:]
    else:
        host = raw.split(":")[0]
    return host not in ("127.0.0.1", "localhost", "::1")


@app.middleware("http")
async def _require_token(request: Request, call_next):
    token = _required_token()
    if token and _arrived_over_the_tunnel(request):
        # CORS preflight carries no custom headers by design -- rejecting it
        # would break every cross-origin call before the real request is sent.
        if request.method != "OPTIONS" and request.url.path.startswith("/api/"):
            sent = request.headers.get("X-MAGI-Token") or request.query_params.get("token", "")
            # compare_digest avoids leaking the token's length/prefix through
            # response timing.
            if not secrets.compare_digest(sent, token):
                return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    # Cloudflare Access authenticates via a cookie, which the browser only
    # sends cross-origin when credentials are allowed on both ends.
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Private Network Access. magi.html on GitHub Pages is a PUBLIC origin
    # reaching a PRIVATE one (127.0.0.1), and Chrome sends a preflight carrying
    # Access-Control-Request-Private-Network for that. Starlette REJECTS such a
    # preflight with 400 unless this is on -- verified: the same preflight
    # returns 200 without that header and 400 with it -- so the hosted page
    # could never reach the engine even sitting at the PC.
    #
    # This is the real mechanism; the hand-rolled response header that used to
    # live in _require_token never ran, because CORSMiddleware is the outermost
    # layer and answers OPTIONS itself without calling anything inside it.
    allow_private_network=True,
)


@app.get("/api/health")
async def health():
    # Reports the live pacing settings so "is it actually running in parallel?"
    # can be answered without reading logs or guessing.
    return {
        "ok": True,
        "providers": settings.enabled_site_ids(),
        "pacing": {
            "mode": settings.pacing.mode,
            "max_concurrency": settings.pacing.max_concurrency,
            "paste_threshold": settings.pacing.paste_threshold,
        },
    }


@app.get("/api/token")
async def link_token(request: Request):
    """Hand the API token to a caller that is already on this machine.

    This closes the last manual step in MAGI. The token gates the tunnel, and
    magi-link keys its records by the token's HASH -- so a phone without the
    secret cannot even ask where the engine is. It showed "Engine offline -- no
    API token set" while everything else about it worked, and the cure was
    typing a long random string on a phone keyboard.

    The console at the desk can now learn the token from the engine itself and
    publish it to Firestore, where the phone reads it. Nobody types anything.

    THIS ADDS NO EXPOSURE, and that is the only reason it exists:

      · It refuses anything that arrived through cloudflared, by the same
        two-signal test that gates every other endpoint -- so the token is
        never served over the very tunnel it protects.
      · What remains is loopback, from a browser, on an origin in the CORS
        allowlist. Anything that can reach here can already POST /api/runs and
        drive four logged-in paid accounts, which is strictly worse than
        reading a string that authorises exactly that.

    Returns 404, not 403, over the tunnel: an endpoint that answers
    "unauthorised" advertises that it is worth attacking.
    """
    if _arrived_over_the_tunnel(request):
        raise HTTPException(404, "not found")
    return {"token": _required_token()}


@app.get("/api/providers")
async def list_providers():
    return [
        {
            "id": s.id,
            "display_name": s.display_name,
            "accent": s.accent,
            "enabled": settings.enabled.get(s.id, True),
            "url": s.url,
        }
        for s in settings.sites.values()
    ]


# Kept small: these are typed/pasted into a chat composer's own upload
# control, which is itself sized for a few reference files, not bulk transfer.
MAX_ATTACHMENTS = 8
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024


async def _stage_uploads(files, into: Path) -> list[Path]:
    """Write uploads to disk and hand back the paths, in order.

    Extracted so a brainstorm session stages files exactly as a council run
    does -- same size cap, same name sanitising. Two copies of this would be
    two places for the cap to drift out of agreement with the error message
    that quotes it.
    """
    out: list[Path] = []
    if not files:
        return out
    into.mkdir(parents=True, exist_ok=True)
    for f in files:
        data = await f.read()
        if len(data) > MAX_ATTACHMENT_BYTES:
            raise HTTPException(
                400,
                f"{f.filename} exceeds the {MAX_ATTACHMENT_BYTES // (1024*1024)}MB limit",
            )
        dest = into / _stage_upload_name(f.filename or "file")
        dest.write_bytes(data)
        out.append(dest)
    return out


@app.post("/api/runs")
async def create_run(
    question: str = Form(...),
    providers: str = Form(""),
    files: list[UploadFile] = File(default=[]),
):
    q = question.strip()
    if not q:
        raise HTTPException(400, "question is required")
    provider_ids = [p for p in providers.split(",") if p] or None

    if len(files) > MAX_ATTACHMENTS:
        raise HTTPException(400, f"at most {MAX_ATTACHMENTS} attachments per question")

    # Re-read config on every run. Without this, a server started before a
    # config edit keeps serving the old settings until it is restarted -- which
    # looks exactly like the change not working (e.g. "it's still sequential"
    # when parallel is already configured). Selector fixes benefit too: edit
    # selectors.yaml and the next run picks it up.
    global settings
    try:
        st = load_settings()
        _apply_chairman_override(st)
        settings = st
    except Exception:
        pass  # keep the last good config rather than failing the run

    run_id = uuid.uuid4().hex[:12]
    providers = build_providers(settings, provider_ids)

    # Stage attachments under this run's own directory so concurrent runs
    # never share a name, and so the whole set can be discarded together once
    # every provider has read them.
    staged_paths = await _stage_uploads(files, UPLOADS_DIR / run_id)

    state = {
        "queue": asyncio.Queue(),
        "cancel": asyncio.Event(),
        "done": False,
        "providers": {
            p.id: {
                "id": p.id,
                "display_name": p.display_name,
                "accent": p.accent,
                "state": "queued",
                "text": "",
                "chars": 0,
            }
            for p in providers
        },
        "result": None,
    }
    _runs[run_id] = state

    async def on_event(ev: ProviderEvent) -> None:
        prov = state["providers"].get(ev.provider_id)
        if prov is not None:
            prov["state"] = str(ev.state)
            if ev.partial_text:
                prov["text"] = ev.partial_text
                prov["chars"] = ev.chars
        await state["queue"].put(
            {
                "type": "state",
                "provider_id": ev.provider_id,
                "state": str(ev.state),
                "chars": ev.chars,
                "text": ev.partial_text,
                "message": ev.message,
            }
        )

    async def work() -> None:
        try:
            result = await Orchestrator(settings, db).run(
                q, providers, run_id=run_id,
                on_event=on_event, cancel=state["cancel"],
                attachments=staged_paths,
            )
            payload = {
                "type": "done",
                "run_id": run_id,
                "responded": result["responded"],
                "total": result["total"],
                "chairman": result["chairman"],
                "verdict": result["verdict"],
                "synthesis_ok": result["synthesis_ok"],
                "synthesis_error": result["synthesis_error"],
                "status": result["status"],
                "total_ms": result["total_ms"],
                "degraded": result["degraded"],
                "answers": [
                    {
                        "provider_id": a.provider_id,
                        "display_name": a.display_name,
                        "ok": a.ok,
                        "text": a.text,
                        "failure": str(a.failure) if a.failure else None,
                        "failure_cause": explain(a.failure)[0] if a.failure else None,
                        "failure_remedy": explain(a.failure)[1] if a.failure else None,
                        "error_detail": a.error_detail,
                        "degraded": a.degraded,
                        "degraded_reason": a.degraded_reason,
                        "low_confidence": a.low_confidence,
                        "latency_ms": a.latency_ms,
                        "chars": a.chars,
                        "completion_reason": a.completion_reason,
                    }
                    for a in result["answers"]
                ],
            }
            state["result"] = payload
            await state["queue"].put(payload)
        except Exception as e:  # noqa: BLE001
            await state["queue"].put(
                {"type": "error", "message": f"{type(e).__name__}: {e}"}
            )
        finally:
            state["done"] = True
            await state["queue"].put({"type": "__eof__"})
            # Every provider has either read these or failed trying; nothing
            # downstream needs the staged copies past this point.
            if staged_paths:
                shutil.rmtree(run_uploads_dir, ignore_errors=True)

    asyncio.create_task(work())
    return {"run_id": run_id}


@app.get("/api/runs/{run_id}/stream")
async def stream_run(run_id: str):
    state = _runs.get(run_id)
    if state is None:
        raise HTTPException(404, "unknown run")

    async def gen():
        # Replay current provider state so a late or reconnecting client is
        # not stuck with a blank grid.
        yield _sse({"type": "init", "providers": list(state["providers"].values())})
        if state["result"]:
            yield _sse(state["result"])
            return
        while True:
            item = await state["queue"].get()
            if item.get("type") == "__eof__":
                break
            yield _sse(item)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"


@app.post("/api/runs/{run_id}/cancel")
async def cancel_run(run_id: str):
    state = _runs.get(run_id)
    if state is None:
        raise HTTPException(404, "unknown run")
    state["cancel"].set()
    return {"ok": True}


@app.get("/api/runs/{run_id}")
async def get_run(run_id: str):
    row = await db.get_run(run_id)
    if row is None:
        raise HTTPException(404, "unknown run")
    return row


@app.get("/api/runs")
async def list_runs(limit: int = 50, offset: int = 0):
    return await db.list_runs(limit, offset)


def _studio_payload(row: dict) -> dict:
    """DB row -> API shape: parsed_json decoded, raw_text/status passed through."""
    out = dict(row)
    if out.get("parsed_json"):
        try:
            out["parsed_json"] = json.loads(out["parsed_json"])
        except (TypeError, ValueError):
            out["parsed_json"] = None
    return out


@app.delete("/api/runs/{run_id}")
async def delete_run(run_id: str):
    """Forget a deliberation on this machine.

    The engine's copy only. The console removes the cloud copy itself, from
    the browser that has the Firestore session -- the engine has no Firebase
    credentials and should not grow any, because that would mean the machine
    holding four logged-in accounts also holding the keys to the sync store.

    Refuses while the run is in flight: deleting the rows a live SSE stream is
    still writing to would leave half a run behind and a stream reporting
    progress on something that no longer exists.
    """
    state = _runs.get(run_id)
    if state and not state.get("done"):
        raise HTTPException(409, "That deliberation is still running.")
    removed = await db.delete_run(run_id)
    _runs.pop(run_id, None)
    # Attachments were staged per run, so they go with it.
    shutil.rmtree(UPLOADS_DIR / run_id, ignore_errors=True)
    return {"id": run_id, "removed": removed}


@app.post("/api/runs/{run_id}/studio/{kind}")
async def create_studio_artifact(run_id: str, kind: str, providers: str = Form("")):
    try:
        studio_kind = studio_engine.StudioKind(kind)
    except ValueError:
        raise HTTPException(
            400,
            f"Unknown studio kind {kind!r}. Known: "
            f"{[k.value for k in studio_engine.StudioKind]}.",
        )

    run = await db.get_run(run_id)
    if run is None:
        raise HTTPException(404, "unknown run")
    synthesis = run.get("synthesis")
    if not synthesis or not synthesis.get("ok"):
        raise HTTPException(
            400, "This run has no verdict yet -- Studio needs a completed run."
        )

    global settings
    try:
        settings = load_settings()
    except Exception:
        pass

    # The units the person has selected RIGHT NOW, not the ones that ran the
    # original council. Unticking a member has to stop it being driven at all.
    allowed = [p for p in providers.split(",") if p] or None
    provider_id = studio_engine.pick_generator_id(
        settings, run["run"].get("chairman_provider"), allowed
    )
    provider = build_provider(settings, provider_id)

    job_id = uuid.uuid4().hex[:12]
    await db.create_studio_artifact(job_id, run_id, studio_kind.value, provider_id)

    state = {
        "queue": asyncio.Queue(),
        "cancel": asyncio.Event(),
        "done": False,
        "result": None,
    }
    _studio_jobs[job_id] = state

    async def on_event(ev: ProviderEvent) -> None:
        await state["queue"].put(
            {"type": "state", "state": str(ev.state), "message": ev.message}
        )

    async def work() -> None:
        try:
            ctx = RunContext(run_id=run_id, question=run["run"]["question"])
            raw_text, parsed, ok, error_detail, latency_ms = await studio_engine.generate(
                provider,
                studio_kind,
                question=run["run"]["question"],
                answers=run["answers"],
                verdict=synthesis.get("verdict_text") or "",
                ctx=ctx,
                cancel=state["cancel"],
            )
            status = "complete" if ok else "failed"
            await db.finish_studio_artifact(
                job_id,
                status,
                raw_text=raw_text,
                parsed_json=json.dumps(parsed) if parsed is not None else None,
                error_detail=error_detail,
                latency_ms=latency_ms,
            )
            payload = {
                "type": "done",
                "job_id": job_id,
                "kind": studio_kind.value,
                "status": status,
                "provider_id": provider_id,
                "raw_text": raw_text,
                "parsed_json": parsed,
                "error_detail": error_detail,
                "latency_ms": latency_ms,
            }
            state["result"] = payload
            await state["queue"].put(payload)
        except Exception as e:  # noqa: BLE001
            await db.finish_studio_artifact(
                job_id, "failed", error_detail=f"{type(e).__name__}: {e}"
            )
            await state["queue"].put(
                {"type": "error", "message": f"{type(e).__name__}: {e}"}
            )
        finally:
            state["done"] = True
            await state["queue"].put({"type": "__eof__"})

    asyncio.create_task(work())
    return {"job_id": job_id}


@app.get("/api/runs/{run_id}/studio/{job_id}/stream")
async def stream_studio_artifact(run_id: str, job_id: str):
    state = _studio_jobs.get(job_id)
    if state is None:
        raise HTTPException(404, "unknown studio job")

    async def gen():
        if state["result"]:
            yield _sse(state["result"])
            return
        while True:
            item = await state["queue"].get()
            if item.get("type") == "__eof__":
                break
            yield _sse(item)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/runs/{run_id}/studio/{job_id}/cancel")
async def cancel_studio_artifact(run_id: str, job_id: str):
    """Stop a card that is still generating.

    A Studio card drives a real browser against a paid account for the better
    part of a minute, exactly like a council member -- so it needs the same way
    out that a run and a brainstorm round already have. The job's cancel Event
    was already created and already passed into studio_engine.generate; there
    was simply nothing that could set it, so "Generating…" was a state with no
    exit but waiting.
    """
    state = _studio_jobs.get(job_id)
    if state is None:
        raise HTTPException(404, "unknown studio job")
    state["cancel"].set()
    return {"ok": True}


@app.get("/api/runs/{run_id}/studio")
async def list_studio_artifacts(run_id: str):
    rows = await db.get_studio_artifacts(run_id)
    return [_studio_payload(r) for r in rows]


@app.get("/api/runs/{run_id}/studio/{job_id}")
async def get_studio_artifact(run_id: str, job_id: str):
    row = await db.get_studio_artifact(job_id)
    if row is None:
        raise HTTPException(404, "unknown studio job")
    return _studio_payload(row)


# ── brainstorm ──────────────────────────────────────────────────────────────


def _apply_chairman_override(st) -> None:
    """Let the console's choice of chairman win over the config file.

    Applied on every settings load rather than once at startup, so choosing a
    chairman takes effect on the next run without restarting the engine --
    which is the same reason settings are reloaded per request at all.
    """
    pick = accounts_mod.chairman_override()
    if pick and pick in st.sites:
        st.chairman.provider_id = pick
        # ...and it must not also sit in the fallback list, or a failure would
        # "fall back" to the member that just failed.
        st.chairman.fallback_order = [
            p for p in st.chairback_order_source() if p != pick
        ] if hasattr(st, "chairback_order_source") else [
            p for p in st.chairman.fallback_order if p != pick
        ]


# Applied to the settings loaded at import, now that the helper exists: the
# first run must chair with the console's choice, not the config's.
_apply_chairman_override(settings)


def _reload_settings() -> None:
    """Pick up config edits without a restart. Same rationale as create_run."""
    global settings
    try:
        st = load_settings()
        _apply_chairman_override(st)
        settings = st
    except Exception:
        pass  # keep the last good config rather than failing the request


def _next_round_no(turns: list[dict]) -> int:
    """The round this request belongs to.

    A round only counts as finished once the chairman merged it. If the last
    round failed before that -- quorum shortfall, a cancelled fan-out -- the
    retry belongs to the SAME round number as a second attempt, not to a new
    round. Advancing regardless is what made three tries at round one look
    like rounds one, two and three, none of which had answers to the ones
    before.
    """
    if not turns:
        return 1
    highest = max(t["round_no"] for t in turns)
    merged = any(
        t["round_no"] == highest
        and t.get("role") == "chairman"
        and (t.get("phase") or "round") == "round"
        for t in turns
    )
    return highest + 1 if merged else highest


def _last_questions(turns: list[dict]) -> list:
    """The questions the person is answering: those of the newest chairman turn."""
    for t in sorted(
        turns,
        key=lambda r: (r["round_no"], r.get("attempt") or 1, r["id"]),
        reverse=True,
    ):
        if t.get("role") == "chairman" and t.get("parsed_json"):
            try:
                parsed = json.loads(t["parsed_json"])
            except (TypeError, ValueError):
                return []
            # The finalise turn stores the plan, not a round merge; it has no
            # questions and must not be mistaken for the last round's.
            if parsed.get("kind") == "plan":
                continue
            return parsed.get("questions") or []
    return []


async def _save_council_answers(
    session_id: str, round_no: int, attempt: int, answers: list, phase: str
) -> None:
    """Record every member answer, including the ones that failed.

    A failed member is stored as a real row with its FailureKind rather than
    dropped, for the same reason the council runs keep theirs: history that
    quietly omits what went wrong cannot be trusted to say what went right.
    Degraded answers keep their text too -- it is what the reader needs to see
    to understand why it was excluded.
    """
    for a in answers:
        await db.add_turn(
            session_id, round_no, "council",
            attempt=attempt,
            provider_id=a.provider_id,
            content=a.text or "",
            ok=a.ok,
            failure_kind=str(a.failure) if a.failure else None,
            error_detail=a.error_detail,
            degraded=bool(a.degraded),
            degraded_reason=a.degraded_reason or None,
            latency_ms=a.latency_ms,
            char_count=a.chars,
            phase=phase,
        )


def _compose_reply(turns: list[dict], answers_json: str, notes: str) -> str:
    """Structured card answers + notes -> the prose stored as the user turn.

    A request with no `answers` field falls straight through to the notes,
    which is exactly the old free-text behaviour.
    """
    parsed: list = []
    if answers_json:
        try:
            loaded = json.loads(answers_json)
            if isinstance(loaded, list):
                parsed = loaded
        except (TypeError, ValueError):
            parsed = []
    if not parsed:
        return (notes or "").strip()
    return brainstorm_engine.format_reply(_last_questions(turns), parsed, notes)


def _session_payload(data: dict) -> dict:
    """DB session+turns -> API shape, with chairman parsed_json decoded."""
    turns = []
    for t in data["turns"]:
        row = dict(t)
        if row.get("parsed_json"):
            try:
                row["parsed_json"] = json.loads(row["parsed_json"])
            except (TypeError, ValueError):
                row["parsed_json"] = None
        turns.append(row)
    return {"session": data["session"], "turns": turns}


@app.post("/api/brainstorm")
async def create_brainstorm(
    topic: str = Form(...),
    providers: str = Form(""),
    files: list[UploadFile] = File(default=[]),
):
    t = topic.strip()
    if not t:
        raise HTTPException(400, "topic is required")

    _reload_settings()
    provider_ids = [p for p in providers.split(",") if p] or settings.enabled_site_ids()
    if not provider_ids:
        raise HTTPException(400, "no providers available")

    if len(files) > MAX_ATTACHMENTS:
        raise HTTPException(400, f"at most {MAX_ATTACHMENTS} attachments per session")

    session_id = uuid.uuid4().hex[:12]
    await db.create_session(session_id, t, provider_ids)

    # Staged under the SESSION's own directory and re-read from disk on every
    # round, rather than recorded in the database. A brainstorm is many rounds
    # over a long time, possibly across an engine restart, and a list of paths
    # in a row would then point at files a cleanup had every right to remove.
    # The directory is the record.
    await _stage_uploads(files, UPLOADS_DIR / session_id)
    return {"session_id": session_id, "attachments": len(files)}


def _session_attachments(session_id: str) -> list[Path]:
    """Whatever was attached when the session was created.

    Sorted, so every round hands the members the same files in the same order
    -- an unordered directory listing would silently reorder attachments
    between rounds.
    """
    d = UPLOADS_DIR / session_id
    if not d.is_dir():
        return []
    return sorted((f for f in d.iterdir() if f.is_file()), key=lambda f: f.name)


@app.get("/api/brainstorm")
async def list_brainstorms(limit: int = 30, offset: int = 0):
    return await db.list_sessions(limit, offset)


@app.get("/api/brainstorm/{session_id}")
async def get_brainstorm(session_id: str):
    data = await db.get_session(session_id)
    if data is None:
        raise HTTPException(404, "unknown session")
    return _session_payload(data)


@app.delete("/api/brainstorm/{session_id}")
async def delete_brainstorm(session_id: str):
    """Forget a planning session, its rounds and the files it carried.

    Refuses while a round is in flight, for the same reason a run does:
    deleting the rows a live stream is still writing to leaves half a session
    behind and a stream reporting progress on something that no longer exists.
    """
    job = _brainstorm_jobs.get(session_id)
    if job and not job.get("done"):
        raise HTTPException(409, "That session is in the middle of a round.")
    removed = await db.delete_session(session_id)
    _brainstorm_jobs.pop(session_id, None)
    # Attachments were staged under the session's own directory.
    shutil.rmtree(UPLOADS_DIR / session_id, ignore_errors=True)
    return {"id": session_id, "removed": removed}


@app.post("/api/brainstorm/{session_id}/round")
async def create_brainstorm_round(
    session_id: str,
    reply: str = Form(""),
    answers: str = Form(""),
):
    """One round: fan out to the council, then have the chairman merge.

    The fan-out goes through Orchestrator so a round inherits pacing, start
    stagger, per-member SSE progress and graceful degradation unchanged -- and
    so the frontend's existing council grid renders it with no new code. Only
    the synthesis step differs, which is why the chairman is driven here rather
    than left to Orchestrator's own verdict path.
    """
    data = await db.get_session(session_id)
    if data is None:
        raise HTTPException(404, "unknown session")
    session = data["session"]
    if session["status"] != "active":
        raise HTTPException(
            400, f"This session is {session['status']}, so it cannot take another round."
        )

    _reload_settings()
    topic = session["topic"]
    turns = data["turns"]
    round_no = _next_round_no(turns)

    provider_ids = session.get("provider_ids") or None
    try:
        members = build_providers(settings, provider_ids)
    except KeyError as e:
        raise HTTPException(400, str(e))

    # A retried round reuses its number, so both tries are kept side by side
    # rather than the second silently replacing the first.
    attempt = await db.next_attempt(session_id, round_no)

    user_reply = _compose_reply(turns, answers, reply)
    if user_reply:
        await db.add_turn(
            session_id, round_no, "user", attempt=attempt, content=user_reply
        )
        # Re-read so the transcript this round builds includes the reply just
        # saved, rather than the state from before it.
        data = await db.get_session(session_id)
        turns = data["turns"]

    job_id = uuid.uuid4().hex[:12]
    state = {
        "queue": asyncio.Queue(),
        "cancel": asyncio.Event(),
        "done": False,
        "result": None,
        "providers": {
            p.id: {
                "id": p.id,
                "display_name": p.display_name,
                "accent": p.accent,
                "state": "queued",
                "text": "",
                "chars": 0,
            }
            for p in members
        },
    }
    _brainstorm_jobs[job_id] = state

    async def on_event(ev: ProviderEvent) -> None:
        prov = state["providers"].get(ev.provider_id)
        if prov is not None:
            prov["state"] = str(ev.state)
            if ev.partial_text:
                prov["text"] = ev.partial_text
                prov["chars"] = ev.chars
        await state["queue"].put(
            {
                "type": "state",
                "provider_id": ev.provider_id,
                "state": str(ev.state),
                "chars": ev.chars,
                "text": ev.partial_text,
                "message": ev.message,
            }
        )

    async def work() -> None:
        try:
            orch = Orchestrator(settings, None)
            # Each member gets its own prompt: identical except for the
            # corrections block, which replays that member's OWN previously
            # refuted claims back to it. That is what stops a bad claim
            # recurring round after round.
            member_prompts = {
                m.id: brainstorm_engine.build_member_prompt(
                    topic, turns, round_no, provider_id=m.id
                )
                for m in members
            }
            ctx = RunContext(
                run_id=f"{session_id}-r{round_no}",
                question=next(iter(member_prompts.values()), topic),
                attachments=_session_attachments(session_id),
            )

            answers = await _fan_out_each(
                orch, members, member_prompts, ctx, on_event, state["cancel"]
            )
            await _save_council_answers(
                session_id, round_no, attempt, answers, "round"
            )

            responded = [a for a in answers if a.ok and a.text.strip()]
            # The merge itself still runs on the single-unit path, unlike the
            # council's verdict: it is not a summary of several voices, it is
            # what produces the plan and the questions, and one answer is
            # enough material for that.
            need = required_members(settings.chairman.min_members, len(answers))
            if len(responded) < need:
                raise RuntimeError(
                    f"Only {len(responded)} of {len(answers)} members responded; "
                    f"a round needs at least {need}."
                )
            if state["cancel"].is_set():
                raise RuntimeError("Round cancelled before the merge.")

            await state["queue"].put(
                {
                    "type": "phase",
                    "phase": "critique",
                    "message": "The members are reviewing each other's proposals",
                }
            )
            critiques = await _run_critique(
                orch, members, answers, topic, turns, ctx, on_event,
                state["cancel"], session_id, round_no, attempt, "round",
            )

            if state["cancel"].is_set():
                raise RuntimeError("Round cancelled before the merge.")

            chair = orch._pick_chairman(members, answers)
            if chair is None:
                raise RuntimeError("No member available to act as chairman.")

            # The chairman drives the same browser profile as the member of the
            # same name, and Chrome's profile lock outlives the Playwright
            # context. A session hits these profiles once per round, so this
            # race gets many more chances to bite than in a one-shot run.
            await orch._await_profile_release(chair)
            await state["queue"].put(
                {
                    "type": "state",
                    "provider_id": chair.id,
                    "state": "waiting",
                    "chars": 0,
                    "text": "",
                    "message": f"{chair.display_name} is merging the round",
                }
            )

            raw, parsed, ok, err, ms = await brainstorm_engine.merge_round(
                chair, topic, turns, answers, ctx,
                critiques=critiques, cancel=state["cancel"],
            )
            if not ok:
                raise RuntimeError(err or "The chairman failed to merge the round.")

            # Enforce the answered-facts ledger on the way out. The chairman is
            # told not to re-ask a settled question and was observed doing it
            # anyway, three rounds running, so the filter is applied to the
            # parsed result rather than trusted to the prompt.
            kept, dropped = brainstorm_engine.drop_answered_questions(
                parsed.get("questions") or [], turns
            )
            if dropped:
                parsed["questions"] = kept
                parsed["dropped_questions"] = dropped
                parsed["blocking"] = [
                    q for q in (parsed.get("blocking") or [])
                    if not any(q == d for d in dropped)
                ]

            await db.add_turn(
                session_id, round_no, "chairman",
                attempt=attempt,
                provider_id=chair.id,
                content=raw,
                parsed_json=json.dumps(parsed),
                ok=True,
                latency_ms=ms,
                char_count=len(raw or ""),
                phase="round",
            )

            payload = {
                "type": "done",
                "job_id": job_id,
                "session_id": session_id,
                "round_no": round_no,
                "chairman": chair.display_name,
                "raw_text": raw,
                "latency_ms": ms,
                "responded": len(responded),
                "total": len(answers),
                **parsed,
            }
            state["result"] = payload
            await state["queue"].put(payload)
        except Exception as e:  # noqa: BLE001
            await state["queue"].put(
                {"type": "error", "message": f"{type(e).__name__}: {e}"}
            )
        finally:
            state["done"] = True
            await state["queue"].put({"type": "__eof__"})

    asyncio.create_task(work())
    return {"job_id": job_id, "round_no": round_no}


async def _fan_out(orch, members, prompt, ctx, on_event, cancel) -> list:
    """Ask every member the same prompt, honouring the configured pacing.

    Mirrors Orchestrator.run's gather, but returns the raw answers instead of
    proceeding to a verdict -- a brainstorm round's synthesis step is a
    different prompt with a different output contract.
    """
    from .providers.base import Answer

    pacing = orch.settings.pacing
    answers: list = []

    if pacing.mode == "sequential" or pacing.max_concurrency <= 1:
        for i, p in enumerate(members):
            if cancel.is_set():
                break
            if i > 0:
                await asyncio.sleep(pacing.sample_inter_provider())
            answers.append(await p.ask(prompt, ctx=ctx, on_event=on_event, cancel=cancel))
        return answers

    sem = asyncio.Semaphore(pacing.max_concurrency)

    async def one(p, delay: float):
        await asyncio.sleep(delay)
        async with sem:
            return await p.ask(prompt, ctx=ctx, on_event=on_event, cancel=cancel)

    delays, acc = [], 0.0
    for _ in members:
        delays.append(acc)
        acc += pacing.sample_inter_provider()

    gathered = await asyncio.gather(
        *(one(p, d) for p, d in zip(members, delays)), return_exceptions=True
    )
    for p, g in zip(members, gathered):
        if isinstance(g, Exception):
            g = Answer.failed(p.id, p.display_name, FailureKind.UNKNOWN, str(g)[:300])
        answers.append(g)
    return answers


async def _fan_out_each(orch, members, prompts, ctx, on_event, cancel) -> list:
    """Like `_fan_out`, but each member gets its OWN prompt.

    The critique step needs this: every member is shown the same proposals but
    has to be told which one is its own, so the prompts differ per member.
    Pacing, stagger and failure handling are otherwise identical.
    """
    from .providers.base import Answer

    pacing = orch.settings.pacing
    answers: list = []

    if pacing.mode == "sequential" or pacing.max_concurrency <= 1:
        for i, p in enumerate(members):
            if cancel.is_set():
                break
            if i > 0:
                await asyncio.sleep(pacing.sample_inter_provider())
            answers.append(
                await p.ask(prompts[p.id], ctx=ctx, on_event=on_event, cancel=cancel)
            )
        return answers

    sem = asyncio.Semaphore(pacing.max_concurrency)

    async def one(p, delay: float):
        await asyncio.sleep(delay)
        async with sem:
            return await p.ask(prompts[p.id], ctx=ctx, on_event=on_event, cancel=cancel)

    delays, acc = [], 0.0
    for _ in members:
        delays.append(acc)
        acc += pacing.sample_inter_provider()

    gathered = await asyncio.gather(
        *(one(p, d) for p, d in zip(members, delays)), return_exceptions=True
    )
    for p, g in zip(members, gathered):
        if isinstance(g, Exception):
            g = Answer.failed(p.id, p.display_name, FailureKind.UNKNOWN, str(g)[:300])
        answers.append(g)
    return answers


async def _run_critique(
    orch, members, answers, topic, turns, ctx, on_event, cancel, session_id,
    round_no, attempt, phase,
):
    """The rebuttal step: every member reads the others and attacks them.

    This is where a council earns its cost over a single model. Without it the
    members never actually meet -- four parallel opinions and a summariser is a
    poll, not a debate, and a wrong claim from one member is never challenged
    by the three that could have caught it.

    Failure here is deliberately NOT fatal. The critiques improve the merge but
    the merge works without them, and a round that already spent four browser
    sessions on proposals must not be thrown away because a fifth call failed.
    """
    responded = [a for a in answers if a.ok and a.text.strip()]
    if len(responded) < 2:
        # Nothing to rebut: one proposal cannot be cross-examined.
        return []

    by_id = {a.provider_id: a for a in answers}
    critics = [m for m in members if m.id in {a.provider_id for a in responded}]
    prompts = {
        m.id: brainstorm_engine.build_critique_prompt(
            topic, turns, answers, by_id[m.id].display_name
        )
        for m in critics
    }

    try:
        results = await _fan_out_each(
            orch, critics, prompts, ctx, on_event, cancel
        )
    except Exception:
        return []

    critiques: list[dict] = []
    for a in results:
        if not (a.ok and a.text.strip()):
            continue
        critiques.append(
            {
                "provider_id": a.provider_id,
                "display_name": a.display_name,
                "raw": a.text,
                "parsed": brainstorm_engine.parse_critique(a.text),
            }
        )

    # Stored as real turns so the transcript can show who challenged what --
    # a correction that only ever existed inside a prompt is invisible to the
    # person afterwards, which is the gap this whole change set is closing.
    for a in results:
        await db.add_turn(
            session_id, round_no, "critique",
            attempt=attempt,
            provider_id=a.provider_id,
            content=a.text or "",
            ok=a.ok,
            failure_kind=str(a.failure) if a.failure else None,
            error_detail=a.error_detail,
            latency_ms=a.latency_ms,
            char_count=a.chars,
            phase=phase,
        )

    return critiques


@app.post("/api/brainstorm/{session_id}/finalize")
async def finalize_brainstorm(
    session_id: str,
    reply: str = Form(""),
    answers: str = Form(""),
):
    """Last council pass, then the chairman writes the plan file."""
    data = await db.get_session(session_id)
    if data is None:
        raise HTTPException(404, "unknown session")
    session = data["session"]
    if session["status"] != "active":
        raise HTTPException(
            400, f"This session is {session['status']}, so it cannot be finalised again."
        )
    if not any(t["role"] == "chairman" for t in data["turns"]):
        raise HTTPException(
            400, "Run at least one round before finalising -- there is no plan yet."
        )

    _reload_settings()
    topic = session["topic"]
    round_no = _next_round_no(data["turns"])

    provider_ids = session.get("provider_ids") or None
    try:
        members = build_providers(settings, provider_ids)
    except KeyError as e:
        raise HTTPException(400, str(e))

    attempt = await db.next_attempt(session_id, round_no)

    user_reply = _compose_reply(data["turns"], answers, reply)
    if user_reply:
        await db.add_turn(
            session_id, round_no, "user", attempt=attempt,
            content=user_reply, phase="finalize",
        )
        data = await db.get_session(session_id)
    turns = data["turns"]

    await db.set_session_status(session_id, "finalizing")

    job_id = uuid.uuid4().hex[:12]
    state = {
        "queue": asyncio.Queue(),
        "cancel": asyncio.Event(),
        "done": False,
        "result": None,
        "providers": {
            p.id: {
                "id": p.id,
                "display_name": p.display_name,
                "accent": p.accent,
                "state": "queued",
                "text": "",
                "chars": 0,
            }
            for p in members
        },
    }
    _brainstorm_jobs[job_id] = state

    async def on_event(ev: ProviderEvent) -> None:
        prov = state["providers"].get(ev.provider_id)
        if prov is not None:
            prov["state"] = str(ev.state)
            if ev.partial_text:
                prov["text"] = ev.partial_text
                prov["chars"] = ev.chars
        await state["queue"].put(
            {
                "type": "state",
                "provider_id": ev.provider_id,
                "state": str(ev.state),
                "chars": ev.chars,
                "text": ev.partial_text,
                "message": ev.message,
            }
        )

    async def work() -> None:
        try:
            orch = Orchestrator(settings, None)
            member_prompts = {
                m.id: brainstorm_engine.build_member_prompt(
                    topic, turns, round_no, provider_id=m.id
                )
                for m in members
            }
            ctx = RunContext(
                run_id=f"{session_id}-final",
                question=next(iter(member_prompts.values()), topic),
                attachments=_session_attachments(session_id),
            )
            answers = await _fan_out_each(
                orch, members, member_prompts, ctx, on_event, state["cancel"]
            )
            await _save_council_answers(
                session_id, round_no, attempt, answers, "finalize"
            )

            await state["queue"].put(
                {
                    "type": "phase",
                    "phase": "critique",
                    "message": "The members are reviewing each other's proposals",
                }
            )
            critiques = await _run_critique(
                orch, members, answers, topic, turns, ctx, on_event,
                state["cancel"], session_id, round_no, attempt, "finalize",
            )

            chair = orch._pick_chairman(members, answers)
            if chair is None:
                # The critique round is a bonus, not a requirement -- the plan
                # can still be written from the transcript alone, and losing a
                # finished session to a browser hiccup would be the worst
                # possible moment to fail.
                chair = build_provider(
                    settings,
                    # `provider_ids` is this session's selection, and the
                    # fallback has to stay inside it: an emergency is not a
                    # licence to drive a unit that was unticked.
                    studio_engine.pick_generator_id(settings, None, provider_ids),
                )
            else:
                await orch._await_profile_release(chair)

            await state["queue"].put(
                {
                    "type": "state",
                    "provider_id": chair.id,
                    "state": "waiting",
                    "chars": 0,
                    "text": "",
                    "message": f"{chair.display_name} is writing the plan",
                }
            )

            body, ok, err, ms = await brainstorm_engine.write_plan(
                chair, topic, turns, answers, ctx,
                critiques=critiques, cancel=state["cancel"],
            )
            if not ok:
                raise RuntimeError(err or "The chairman failed to write the plan.")

            # The review pass: contradictions, dropped material, unsupported
            # claims and readability, checked over the finished document. It
            # runs last because every one of those checks needs the whole thing
            # to exist first, and it can only ever improve or no-op -- a failed
            # review returns the document unchanged rather than losing it.
            await state["queue"].put(
                {
                    "type": "state",
                    "provider_id": chair.id,
                    "state": "waiting",
                    "chars": 0,
                    "text": "",
                    "message": f"{chair.display_name} is checking the document",
                }
            )
            body, reviewed, review_note, review_ms = await brainstorm_engine.review_plan(
                chair, body, turns, answers, ctx, cancel=state["cancel"]
            )
            ms += review_ms

            # No file is written here. The plan is kept in the database and
            # handed to the client, which offers Save As -- the person chooses
            # where it lands, rather than finding it somewhere they never
            # picked. `filename` is only a suggestion for that dialog.
            markdown = brainstorm_engine.build_plan_markdown(body, turns)
            filename = brainstorm_engine.plan_filename(topic)

            # The plan is also a turn -- the last thing the chairman said. It
            # lives on the session row too, but recording it here keeps the
            # turn log a complete account of the session rather than one that
            # stops just before its most important output.
            await db.add_turn(
                session_id, round_no, "chairman",
                attempt=attempt,
                provider_id=chair.id,
                content=markdown,
                parsed_json=json.dumps(
                    {"kind": "plan", "filename": filename, "body": body}
                ),
                ok=True,
                latency_ms=ms,
                char_count=len(markdown),
                phase="finalize",
            )
            await db.finish_session(
                session_id, "complete", plan_path=None, plan_md=markdown,
            )

            payload = {
                "type": "done",
                "job_id": job_id,
                "session_id": session_id,
                "status": "complete",
                "chairman": chair.display_name,
                "plan_filename": filename,
                "plan_md": markdown,
                "latency_ms": ms,
                "reviewed": reviewed,
                "review_note": review_note,
            }
            state["result"] = payload
            await state["queue"].put(payload)
        except Exception as e:  # noqa: BLE001
            # Back to active, not failed: the session's rounds are all still
            # there and finalising again is exactly the right thing to try.
            await db.set_session_status(session_id, "active")
            await state["queue"].put(
                {"type": "error", "message": f"{type(e).__name__}: {e}"}
            )
        finally:
            state["done"] = True
            await state["queue"].put({"type": "__eof__"})

    asyncio.create_task(work())
    return {"job_id": job_id}


@app.get("/api/brainstorm/{session_id}/job/{job_id}/stream")
async def stream_brainstorm_job(session_id: str, job_id: str):
    state = _brainstorm_jobs.get(job_id)
    if state is None:
        raise HTTPException(404, "unknown brainstorm job")

    async def gen():
        yield _sse({"type": "init", "providers": list(state["providers"].values())})
        if state["result"]:
            yield _sse(state["result"])
            return
        while True:
            item = await state["queue"].get()
            if item.get("type") == "__eof__":
                break
            yield _sse(item)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/brainstorm/{session_id}/job/{job_id}/cancel")
async def cancel_brainstorm_job(session_id: str, job_id: str):
    state = _brainstorm_jobs.get(job_id)
    if state is None:
        raise HTTPException(404, "unknown brainstorm job")
    state["cancel"].set()
    return {"ok": True}


# Refinement runs on the Gemini API rather than a browser member. A refine is
# one short turn on text the person has not sent anywhere yet, so the seconds
# spent launching Chrome and polling a page for a stable answer were the whole
# cost of the feature. The API path answers in about a second.
REFINER_PROVIDER_ID = "gemini-api"

# Which UNIT an API-backed provider is. The tick boxes are about models, not
# about transports: unticking GEMINI means "do not use Gemini", and reaching
# the same model through an API key instead of a logged-in tab is still using
# it -- same company, same account, same instruction being ignored.
API_PROVIDER_UNIT = {"gemini-api": "gemini"}


def _refiner_id(allowed: list[str] | None = None) -> str:
    """The provider the refiner should use, within the units selected.

    Refine is the quiet one. It is not a council run, it produces no History
    row, and it is easy to forget it drives a model at all -- which is exactly
    why it was the last place an unticked unit could still be used. It takes
    the selection like everything else now.

    Preference is still the Gemini API when its key is set AND Gemini is
    selected: it answers in a second where the browser path spends several
    launching Chrome to rewrite one sentence. Otherwise it falls back to a
    selected browser member -- slow, but yours.
    """
    if (
        gemini_api.load_api_key()
        and (allowed is None or API_PROVIDER_UNIT[REFINER_PROVIDER_ID] in allowed)
    ):
        return REFINER_PROVIDER_ID
    return studio_engine.pick_generator_id(settings, None, allowed)


def _resolve_refiner(requested: str, allowed: list[str] | None) -> str:
    """Which provider refines, honouring a request only if it is selected.

    An explicit provider_id is a convenience for scripts, not a way around the
    tick boxes -- so a request for a unit that is not selected is dropped and
    the normal choice is made instead.
    """
    requested = (requested or "").strip()
    if (
        requested
        and allowed
        and requested not in allowed
        and API_PROVIDER_UNIT.get(requested) not in allowed
    ):
        requested = ""
    return requested or _refiner_id(allowed)


# The council's browser profiles are single-occupancy, so a refine that ran
# while a run or a brainstorm round was in flight would fight the same profile
# lock. Cheap to check here, and a clear 409 beats an opaque Playwright error.
def _profiles_busy() -> bool:
    return any(
        not s.get("done") for s in (*_runs.values(), *_brainstorm_jobs.values())
    )


@app.post("/api/refine")
async def refine_prompt(
    question: str = Form(...),
    provider_id: str = Form(""),
    providers: str = Form(""),
):
    """Rewrite the composer's text into a sharper prompt, via one model.

    Synchronous rather than the POST-then-SSE shape the council uses: this is
    ONE provider doing ONE short turn, so it lands in the same order of time as
    a single chat message. A job id and a stream would be machinery around a
    request that finishes before the stream could be opened.

    Runs on the Gemini API by default (see REFINER_PROVIDER_ID) rather than a
    browser member, because the browser path spent seconds launching Chrome and
    polling for a stable answer to rewrite one sentence. `providers` is the
    units currently selected and constrains every choice here, the API refiner
    included -- see _refiner_id. Pass provider_id to force a specific member,
    which is honoured only if that member is selected too.
    """
    q = question.strip()
    if not q:
        raise HTTPException(400, "question is required")

    _reload_settings()

    allowed = [p for p in providers.split(",") if p] or None
    try:
        provider = build_provider(settings, _resolve_refiner(provider_id, allowed))
    except (KeyError, ValueError) as e:
        raise HTTPException(400, str(e))

    # Only browser members contend for a single-occupancy profile. An API
    # refiner holds no profile, so it can run while the council works -- which
    # is the point: you can sharpen your next question without waiting.
    if provider.kind != "api" and _profiles_busy():
        raise HTTPException(
            409,
            "The council is working right now -- wait for it to finish, then refine.",
        )

    ctx = RunContext(run_id=f"refine-{uuid.uuid4().hex[:8]}", question=q)
    text, ok, error, ms = await refine_engine.refine(provider, q, ctx)

    if not ok:
        raise HTTPException(502, error or "The refiner did not return a rewrite.")

    return {
        "refined": text,
        "original": q,
        "provider_id": provider.id,
        "display_name": provider.display_name,
        "latency_ms": ms,
    }


# ── accounts ────────────────────────────────────────────────────────────────
# Which account each unit is signed in as, and how to change it. See
# magi/accounts.py for why none of this scrapes an email address.
#
# Everything here drives a browser ON THE ENGINE DEVICE. A phone can start a
# sign-in, but the window opens where the profiles live, which is the only
# place it could possibly open -- so the console says so rather than leaving
# someone watching a phone for a window that is never coming.

_logins: dict[str, accounts_mod.LoginJob] = {}


@app.get("/api/chairman")
async def get_chairman():
    """Who chairs, and who could.

    `order` is the fallback chain as configured, so the console can say what
    happens if the chairman is not among the units you have selected.
    """
    _reload_settings()
    return {
        "chairman": settings.chairman.provider_id,
        "override": accounts_mod.chairman_override(),
        "fallback_order": settings.chairman.fallback_order,
        "min_members": settings.chairman.min_members,
    }


@app.post("/api/chairman")
async def put_chairman(provider_id: str = Form("")):
    """Choose the chairman, or send an empty id to go back to the config's."""
    _reload_settings()
    pick = provider_id.strip()
    if pick and pick not in settings.sites:
        raise HTTPException(404, f"Unknown unit {pick!r}")
    accounts_mod.set_chairman(pick)
    _reload_settings()
    return {"chairman": settings.chairman.provider_id,
            "override": accounts_mod.chairman_override()}


@app.get("/api/accounts")
async def list_accounts():
    _reload_settings()
    return accounts_mod.listing(settings)


@app.post("/api/accounts/{site_id}/label")
async def label_account(site_id: str, label: str = Form("")):
    if site_id not in settings.sites:
        raise HTTPException(404, f"Unknown unit {site_id!r}")
    return accounts_mod.set_label(site_id, label)


@app.post("/api/accounts/{site_id}/check")
async def check_account(site_id: str):
    """One browser, one unit, on request.

    Opening seven to render a settings tab would be absurd, so the listing
    reads the filesystem and this is the live answer for a single unit.
    """
    _reload_settings()
    if site_id not in settings.sites:
        raise HTTPException(404, f"Unknown unit {site_id!r}")
    if _profiles_busy():
        raise HTTPException(
            409, "The council is working right now — wait for it to finish."
        )
    return await accounts_mod.check(settings, site_id)


@app.post("/api/accounts/{site_id}/signout")
async def signout_account(site_id: str):
    if site_id not in settings.sites:
        raise HTTPException(404, f"Unknown unit {site_id!r}")
    if _profiles_busy():
        raise HTTPException(
            409, "The council is working right now — wait for it to finish."
        )
    return accounts_mod.sign_out(site_id)


@app.post("/api/accounts/{site_id}/login")
async def start_login(site_id: str):
    """Open a sign-in window on the engine device.

    One at a time per unit: two windows onto the same profile directory means
    Chrome refuses the second with a profile lock, and the first one's session
    is what you were half-way through typing into.
    """
    _reload_settings()
    if site_id not in settings.sites:
        raise HTTPException(404, f"Unknown unit {site_id!r}")
    if _profiles_busy():
        raise HTTPException(
            409, "The council is working right now — wait for it to finish, then sign in."
        )
    live = _logins.get(site_id)
    if live and live.state in ("opening", "waiting"):
        return live.snapshot()

    job = accounts_mod.LoginJob(site_id=site_id)
    _logins[site_id] = job
    asyncio.create_task(accounts_mod.run_login(settings, job))
    return job.snapshot()


@app.get("/api/accounts/{site_id}/login")
async def login_status(site_id: str):
    job = _logins.get(site_id)
    if not job:
        raise HTTPException(404, "No sign-in is running for that unit.")
    return job.snapshot()


@app.post("/api/accounts/{site_id}/login/cancel")
async def cancel_login(site_id: str):
    job = _logins.get(site_id)
    if not job:
        raise HTTPException(404, "No sign-in is running for that unit.")
    job.cancel.set()
    return job.snapshot()


@app.post("/api/doctor")
async def doctor(
    request: Request,
    provider_ids: list[str] | None = None,
    providers: str = Form(""),
):
    """Check the selectors still match, for the units that are SELECTED.

    A doctor pass opens a real Chrome against each site it checks, signed in as
    you. Running it across every configured site meant unticking a unit did not
    stop MAGI driving it -- the one place in the console that still did. A unit
    you are not using is also a unit whose selectors you do not need to know
    about, so scoping this loses nothing and honours the tick box.

    `providers` (form) is what the console sends; `provider_ids` (json) is kept
    so scripts and the older shape keep working.
    """
    picked = provider_ids or [p for p in providers.split(",") if p] or None
    providers = build_providers(settings, picked)

    # Checked in PARALLEL, for the same reason the council fans out in
    # parallel: each unit drives its own browser profile against a DIFFERENT
    # service, so nothing is being hammered. Sequentially this was one real
    # Chrome launch after another -- roughly half a minute each, so four units
    # meant two minutes of staring at a spinner. That is long enough that the
    # doctor stopped being something you just run.
    async def _one(p):
        t0 = time.monotonic()
        r = await p.health_check()
        return r, int((time.monotonic() - t0) * 1000)

    checks = [asyncio.create_task(_one(p)) for p in providers]
    gathered = asyncio.gather(*checks, return_exceptions=True)

    async def _cancel_when_client_leaves() -> None:
        """Kill every in-flight check the moment the browser aborts the fetch.

        Checking is_disconnected only BETWEEN providers -- which is what this
        did before -- meant Stop waited for the current unit to finish, and a
        single health check runs for tens of seconds. Pressing Stop and
        watching nothing happen is indistinguishable from a Stop button that
        does not work, which is exactly how it was reported.

        Cancelling unwinds launcher.launch's context manager, so the browsers
        it opened are closed rather than left orphaned holding profile locks.
        """
        while not gathered.done():
            if await request.is_disconnected():
                for c in checks:
                    c.cancel()
                return
            await asyncio.sleep(0.35)

    watcher = asyncio.create_task(_cancel_when_client_leaves())
    try:
        results = await gathered
    except asyncio.CancelledError:
        return []
    finally:
        watcher.cancel()

    out = []
    for p, res in zip(providers, results):
        if isinstance(res, asyncio.CancelledError):
            continue
        if isinstance(res, BaseException):
            out.append({
                "provider_id": p.id, "display_name": p.display_name,
                "reachable": False, "logged_in": False, "challenged": False,
                "usable": False, "error": str(res)[:300], "notes": [],
                "selectors": [], "duration_ms": 0,
            })
            continue
        r, ms = res
        out.append(
            {
                "provider_id": r.provider_id,
                "display_name": r.display_name,
                "reachable": r.reachable,
                "logged_in": r.logged_in,
                "challenged": r.challenged,
                "usable": r.usable,
                "error": r.error,
                "notes": r.notes,
                # How long this unit took to open and probe. A unit that is
                # "fine" but took 50 seconds is on its way to timing out mid
                # run, and nothing else in the console would tell you.
                "duration_ms": ms,
                "selectors": [
                    {
                        "field": s.field,
                        "matched": s.matched,
                        "count": s.count,
                        "ok": s.ok,
                        # `status` is what the UI should colour on: a bare
                        # ok=False conflates a broken selector with one that
                        # simply cannot match on an idle page.
                        "status": s.status,
                        "note": s.note,
                        "stale": bool(s.ok and s.tried and s.matched != s.tried[0]),
                        "tried": len(s.tried),
                        # The preferred candidate, so the UI can say exactly
                        # what to put where: a stale field's fix is "move the
                        # matched selector above this one in selectors.yaml".
                        "preferred": s.tried[0] if s.tried else "",
                    }
                    for s in r.selectors
                ],
            }
        )
    return out


# ── the UI ───────────────────────────────────────────────────────────────────
# magi.html is a single self-contained file at the A1 repo root, exactly like
# every other program in the suite -- there is no build step and no bundle, so
# there is nothing to mount under /assets and nothing to rebuild when the UI
# changes. Serving it here gives the local case a SAME-ORIGIN page, which skips
# CORS and Private Network Access entirely: open http://127.0.0.1:8000 and it
# just works. The same file served from GitHub Pages is the remote case.
_UI = ROOT.parent / "magi.html"


@app.get("/")
async def index():
    if not _UI.is_file():
        return JSONResponse(
            {"detail": f"magi.html not found at {_UI}"}, status_code=404
        )
    # Never cache. The file is edited in place and keeps one URL forever, so a
    # cached copy pins the browser to an old UI against a new backend with no
    # error anywhere to explain it -- editing then appears to do nothing.
    return FileResponse(
        _UI,
        media_type="text/html",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )
