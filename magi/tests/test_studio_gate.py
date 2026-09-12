"""Studio is offered only where a card can actually be built.

Studio is fully implemented -- seven kinds, each with a prompt, a parser, an
endpoint, a database row and a viewer -- but it builds a card by driving a
real browser against the run's STORED answers, so it can only run where those
answers live. A deliberation made on another device opens here from the cloud
(answers, verdict and any cards already built all travel), and the engine has
never seen it: POST /api/runs/{id}/studio/{kind} answers 404 "unknown run".

The console used to offer all seven rows anyway, and the click went nowhere
visible -- the refusal was JSON with `detail` where `job_id` should have been,
so it opened a stream at /studio/undefined/stream and the card sat on
"Queued..." for ever.
"""

from __future__ import annotations

from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PAGE = (REPO / "magi.html").read_text(encoding="utf-8")
APP = (REPO / "magi" / "app.py").read_text(encoding="utf-8")


def _fn(name: str) -> str:
    i = PAGE.index(f"function {name}(")
    depth, j = 0, PAGE.index("{", i)
    for k in range(j, len(PAGE)):
        if PAGE[k] == "{":
            depth += 1
        elif PAGE[k] == "}":
            depth -= 1
            if depth == 0:
                return PAGE[i : k + 1]
    raise AssertionError(f"{name} never closes")


def test_the_engine_still_refuses_a_run_it_does_not_have():
    """The condition the gate exists for. If this stops being true the gate
    is merely unnecessary -- if it stays true the gate must stay too."""
    assert '404, "unknown run"' in APP


def test_studio_is_gated_on_the_run_being_here():
    line = [l for l in PAGE.splitlines() if "const studioEnabled" in l][0]
    tail = PAGE[PAGE.index(line) : PAGE.index(line) + 300]
    assert "S.runLocal" in tail, (
        "Studio is offered for a deliberation this engine has never seen"
    )


def test_the_flag_is_set_wherever_a_run_is_opened():
    assert "runLocal: false," in PAGE, "S.runLocal is gone"
    for fn in ("start", "openRun"):
        assert "S.runLocal = true;" in _fn(fn), f"{fn} does not mark the run local"
    assert "S.runLocal = false;" in _fn("cloudOpenRun"), (
        "a run opened from the cloud claims to be on this engine"
    )
    assert "S.runLocal = false;" in _fn("newRun")


def test_the_greyed_out_rows_say_which_reason():
    """Three reasons, and the wrong one reads as a bug in the program."""
    body = _fn("renderStudioNav")
    for reason in ("Needs the engine device to be awake.",
                   "synced from another device",
                   "Available once a verdict is reached."):
        assert reason in body, f"the note no longer explains: {reason}"


def test_a_refused_generation_is_reported_not_left_spinning():
    body = _fn("generateStudio")
    assert "!r.ok" in body, (
        "the response is assumed to be a job again -- a refusal opens a stream "
        "at /studio/undefined/stream and the card queues for ever"
    )
    assert "d.detail" in body, "the engine's reason is thrown away"
    assert "e.message" in body, "the failed card shows a generic message again"


# ── and the seven cards are all real, so none of them should be hidden ──────
@pytest.mark.parametrize("kind", ["table", "report", "flashcards", "quiz",
                                  "mindmap", "slides", "audio"])
def test_every_offered_card_exists_end_to_end(kind):
    engine = (REPO / "magi" / "engine" / "studio.py").read_text(encoding="utf-8")
    assert f'"{kind}"' in engine, f"{kind} has no StudioKind"
    assert f"{kind}:" in PAGE or f'"{kind}"' in PAGE, f"{kind} has no card"
    assert f'case "{kind}":' in PAGE, f"{kind} has no viewer, so it would open blank"
