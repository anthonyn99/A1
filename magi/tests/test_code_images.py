"""Code Mode tasks with attached images (screenshots, diagrams).

An image reaches each agent the way that agent takes one -- an image block on
the Claude CLI's stdin, a file Codex is pointed at with --image, an upload in
a browser unit's chat -- and is never written into the workspace. The engine
reads the type from the bytes and refuses anything the agents do not all
take, before a task starts rather than halfway through it.
"""

from __future__ import annotations

import asyncio
import base64
import json
import subprocess
from pathlib import Path

from magi.code.agents import claude_cli, codex_cli
from magi.code.agents.base import Image, Mode, Outcome, Task, sniff_image, stage_images
from magi.code.routes import (
    MAX_IMAGE_BYTES,
    MAX_TASK_ATTACHMENTS,
    _task_images,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def _task(**kw) -> Task:
    return Task(id="t1", prompt="why is the toggle misaligned?", root=Path("."), **kw)


# ── what the engine accepts ─────────────────────────────────────────────────
def test_the_type_comes_from_the_bytes():
    assert sniff_image(PNG) == "image/png"
    assert sniff_image(JPEG) == "image/jpeg"
    assert sniff_image(b"GIF89a" + b"\x00" * 8) == "image/gif"
    assert sniff_image(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "image/webp"
    assert sniff_image(b"BM" + b"\x00" * 30) == ""         # a BMP: redrawn by the console
    assert sniff_image(b"plain text") == ""


def test_an_image_is_accepted_and_typed_by_its_bytes():
    # Named .png, holds a JPEG: it is sent as what it is.
    imgs, why = _task_images([{"name": "shot.png", "data": _b64(JPEG)}])
    assert why == "" and imgs == [Image("shot.png", "image/jpeg", JPEG)]


def test_no_images_is_not_an_error():
    assert _task_images(None) == ([], "")
    assert _task_images([]) == ([], "")


def test_what_is_not_an_image_is_refused():
    assert "not a PNG" in _task_images([{"name": "x.png", "data": _b64(b"hello")}])[1]
    assert "intact" in _task_images([{"name": "x.png", "data": "not base64!"}])[1]
    assert _task_images("nope")[1] and _task_images(["nope"])[1]


def test_an_image_too_large_for_the_api_is_refused():
    big = PNG + b"\x00" * MAX_IMAGE_BYTES
    assert "too large" in _task_images([{"name": "huge.png", "data": _b64(big)}])[1]


def test_images_share_the_file_count_with_text():
    two = [{"name": f"{i}.png", "data": _b64(PNG)} for i in range(2)]
    assert _task_images(two, room=2)[1] == ""
    assert str(MAX_TASK_ATTACHMENTS) in _task_images(two, room=1)[1]


# ── what every agent is told ────────────────────────────────────────────────
def test_the_prompt_names_the_images_in_order():
    t = _task(images=[Image("before.png", "image/png", PNG),
                      Image("after.jpg", "image/jpeg", JPEG)])
    for p in (t.full_prompt(), t.resumed_prompt()):
        assert p.index("toggle") < p.index("ATTACHED IMAGES")
        assert "1. before.png\n2. after.jpg" in p
        assert "not instructions" in p
    assert "ATTACHED IMAGES" not in _task().full_prompt()


def test_an_interruption_does_not_resend_them():
    t = _task(images=[Image("a.png", "image/png", PNG)])
    assert t.images_for("claude:system") == t.images
    t.resume = {"agent": "claude:system", "sid": "s1", "why": "interrupt"}
    assert t.images_for("claude:system") == []          # its session has them
    assert t.images_for("codex:main") == t.images       # a hand-off starts fresh
    t.resume["why"] = "followup"
    assert t.images_for("claude:system") == t.images    # a new turn's own images


def test_staged_names_are_safe_and_unique(tmp_path):
    imgs = [Image("my shot?.png", "image/png", PNG), Image("my shot?.png", "image/jpeg", JPEG)]
    paths = stage_images(imgs, tmp_path / "s")
    assert [p.name for p in paths] == ["1-my_shot_.png", "2-my_shot_.jpg"]
    assert paths[1].read_bytes() == JPEG


# ── Claude Code: an image block on stdin ────────────────────────────────────
def test_claude_takes_images_as_stream_json():
    t = _task(images=[Image("a.png", "image/png", PNG)])
    argv = claude_cli.build_argv("claude", t)
    # Always stream-json now: stdin stays open for messages typed mid-run.
    assert argv[argv.index("--input-format") + 1] == "stream-json"

    line = claude_cli.stdin_for("PROMPT", t.images)
    assert line.endswith("\n") and line.count("\n") == 1, "one JSON message per line"
    msg = json.loads(line)
    assert msg["type"] == "user" and msg["message"]["role"] == "user"
    text, img = msg["message"]["content"]
    assert text == {"type": "text", "text": "PROMPT"}
    assert img["source"] == {"type": "base64", "media_type": "image/png", "data": _b64(PNG)}
    plain = json.loads(claude_cli.stdin_for("PROMPT", []))
    assert plain["message"]["content"] == [{"type": "text", "text": "PROMPT"}], "no images: text only"


# ── Codex: --image ──────────────────────────────────────────────────────────
def test_codex_takes_images_before_its_other_flags():
    t = _task()
    argv = codex_cli.build_argv("codex", t, images=[Path("C:/s/1-a.png"), Path("C:/s/2-b.png")])
    # exec's --image takes several values: anything positional after it would
    # be swallowed, so the images lead.
    assert argv[:6] == ["codex", "exec", "--image", str(Path("C:/s/1-a.png")),
                        "--image", str(Path("C:/s/2-b.png"))]
    assert argv[-1] == "-"


def test_codex_resume_gives_images_to_the_resume_subcommand():
    t = _task()
    argv = codex_cli.build_argv("codex", t, resume="th1", images=[Path("a.png")])
    i = argv.index("resume")
    assert argv[i:] == ["resume", "th1", "--image", "a.png", "-"]
    assert argv.count("--image") == 1


def test_codex_stages_then_removes_the_files(tmp_path, monkeypatch):
    """The images exist while Codex runs and are gone after -- outside the
    workspace the whole time."""
    from magi import settings
    seen = {}

    class FakeStream:
        def __init__(self, argv, **kw):
            imgs = [argv[i + 1] for i, a in enumerate(argv) if a == "--image"]
            seen["imgs"] = imgs
            seen["existed"] = [Path(p).read_bytes() for p in imgs]
            self.stderr_tail, self.stalled = [], ""

        async def lines(self, cancel, wake=None):
            for ev in ({"type": "thread.started", "thread_id": "th"},
                       {"type": "item.completed", "item": {"type": "agent_message",
                                                           "text": "Red and blue."}},
                       {"type": "turn.completed", "usage": {}}):
                yield json.dumps(ev)

        async def wait(self):
            return 0

        def kill(self):
            pass

    async def no_watch(*a, **k):
        await asyncio.sleep(3600)

    monkeypatch.setattr(settings, "data_dir", lambda: tmp_path / "data")
    monkeypatch.setattr(codex_cli, "Stream", FakeStream)
    monkeypatch.setattr(codex_cli.AS, "usable", lambda home, ver: (False, "test"))
    monkeypatch.setattr(codex_cli.slots, "cli_path", lambda a: "codex")
    monkeypatch.setattr(codex_cli.slots, "env_for", lambda a, s: {})
    monkeypatch.setattr(codex_cli.models, "cap_watch", no_watch)
    monkeypatch.setattr(codex_cli.CodexCLIAgent, "_pick", lambda self, t: {})
    monkeypatch.setattr(codex_cli, "gave_up", lambda text, tools: False)

    async def emit(e):
        pass

    t = Task("t1", "what colours?", tmp_path / "proj", Mode.READ,
             images=[Image("a.png", "image/png", PNG)])
    res = asyncio.run(codex_cli.CodexCLIAgent("main").run(t, emit=emit, cancel=asyncio.Event()))
    assert res.outcome == Outcome.OK, res
    assert seen["existed"] == [PNG]
    assert Path(seen["imgs"][0]).is_relative_to(tmp_path / "data" / "code_uploads")
    assert not Path(seen["imgs"][0]).exists(), "staged images are removed after the run"


# ── a browser unit: uploaded with every message ─────────────────────────────
class _Ans:
    def __init__(self, text, ok=True, failure=None, detail=None):
        self.text, self.ok, self.failure, self.error_detail = text, ok, failure, detail


class _Unit:
    def __init__(self, replies):
        self.replies, self.asks = list(replies), []

    async def ask(self, prompt, *, ctx, cancel=None):
        self.asks.append({"prompt": prompt,
                          "files": {p.name: p.read_bytes() for p in ctx.attachments}})
        return self.replies.pop(0)


def _run_unit(monkeypatch, tmp_path, replies):
    from magi.code.agents import browser
    from magi.providers import registry
    root = tmp_path / "proj"
    root.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    (root / "app.py").write_text("toggle = 1\n", encoding="utf-8")
    unit = _Unit(replies)
    monkeypatch.setattr(registry, "build_provider", lambda s, u: unit)
    monkeypatch.setattr(browser, "_staging_root", lambda: tmp_path / "stage")
    events = []

    async def emit(e):
        events.append(e)

    t = Task("t1", "why is the toggle off?", root, Mode.READ,
             images=[Image("shot.png", "image/png", PNG)])
    res = asyncio.run(browser.BrowserUnitAgent("claude", "Claude", settings=None)
                      .run(t, emit=emit, cancel=asyncio.Event()))
    return res, unit, events


def test_a_browser_unit_gets_the_image_every_round(tmp_path, monkeypatch):
    res, unit, _ = _run_unit(monkeypatch, tmp_path, [
        _Ans("NEED: app.py", ok=False),
        _Ans("The toggle sits 4px low."),
    ])
    assert res.outcome == Outcome.OK
    for ask in unit.asks:                       # each ask is a fresh chat
        assert ask["files"]["1-shot.png"] == PNG
        assert "1. shot.png" in ask["prompt"]
    assert not any((tmp_path / "stage").iterdir())


def test_a_site_that_takes_no_files_hands_an_image_task_on(tmp_path, monkeypatch):
    from magi.errors import FailureKind
    res, unit, events = _run_unit(monkeypatch, tmp_path, [
        _Ans("", ok=False, failure=FailureKind.SELECTOR_MISS, detail="no attach button"),
    ])
    assert res.outcome == Outcome.UNAVAILABLE and "image" in res.detail
    assert len(unit.asks) == 1, "not asked again without the picture"
