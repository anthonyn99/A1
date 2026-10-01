"""The two engine bugs Track F's F4 fixed on the way (docs/magi-plan.md §8 F4
step 6), each on the string it was seen with.

* A sole Gemini verdict lost its heading line breaks in capture, so its NOTES
  and CONFIDENCE were glued to the answer and went into the next turn's memory.
* Codex sometimes answered a READ task "I can't read README.md ... I don't
  have a file-reading tool" without running a single command.
"""

from __future__ import annotations

import json
from pathlib import Path

from magi.code.agents import codex_cli as CX
from magi.code.agents.base import Mode, Outcome, Task
from magi.engine import session as S

from test_code_followup import _agent_run, fake_cli  # noqa: F401 -- the fixture

# ── Gemini's glued headings ──────────────────────────────────────────────

GLUED = ("ANSWER\nIt is named after Miranda, the heroine of Shakespeare's *The "
         "Tempest*, and the ship is the *Dream*.NOTES None.CONFIDENCE HIGH -- "
         "the play and the name are both well documented.")


def test_a_glued_notes_heading_is_cut_from_the_memory():
    out = S.answer_section(GLUED)
    assert out.endswith("the ship is the *Dream*.")
    assert "NOTES" not in out and "CONFIDENCE" not in out and "HIGH" not in out


def test_a_glued_confidence_alone_is_cut_too():
    out = S.answer_section("ANSWER\nBlue.CONFIDENCE HIGH -- sure.")
    assert out == "Blue."


def test_a_heading_with_its_text_on_the_same_line_is_cut():
    out = S.answer_section("ANSWER\nBlue.\n\nNOTES None.\n\nCONFIDENCE HIGH")
    assert out == "Blue."


def test_prose_that_mentions_notes_is_left_alone():
    txt = "Take notes. NOTES-style headers are fine. Confidence matters."
    assert S.answer_section(txt) == txt


def test_the_well_formed_verdict_is_unchanged():
    ok = "ANSWER\nBlue.\n\nNOTES\nNone.\n\nCONFIDENCE\nHIGH -- sure."
    assert S.answer_section(ok) == "Blue."


# ── Codex giving up without trying ──────────────────────────────────────

GAVE_UP = ("I can't read README.md because this workspace is mounted read-only and "
           "I don't have a file-reading tool available in this environment.")


def _J(**kw):
    return json.dumps(kw)


def _codex_ok(text, tools=()):
    lines = [_J(type="thread.started", thread_id="th-1")]
    for cmd in tools:
        lines.append(_J(type="item.started", item={"type": "command_execution", "command": cmd}))
    lines += [_J(type="item.completed", item={"type": "agent_message", "text": text}),
              _J(type="turn.completed", usage={})]
    return (lines, [])


GAVE_UP_2 = ("I can’t identify the file without inspecting the workspace, and this session "
             "only permits read access through tools that aren’t available here.")


def test_gave_up_matches_the_recorded_replies_only_without_tools():
    assert CX.gave_up(GAVE_UP, [])
    assert CX.gave_up(GAVE_UP_2, []), "the second wording, seen live in magi-codemode"
    assert not CX.gave_up(GAVE_UP_2, ["Bash"])
    # Real answers that happen to use the words are left alone when it read.
    assert not CX.gave_up("The engine's app is in magi/app.py; I can't see any other.", ["Bash"])
    assert not CX.gave_up(GAVE_UP, ["Bash"]), "it tried: its answer stands"
    assert not CX.gave_up("README.md says: install with pip.", [])
    assert CX.gave_up("I cannot access the files in this workspace.", [])
    assert CX.gave_up("I don’t have shell access here.", [])


def test_a_codex_read_task_that_gives_up_is_handed_on(fake_cli):
    fake_cli.scripts = [_codex_ok(GAVE_UP)]
    res, events = _agent_run(CX.CodexCLIAgent("c1", model="m"), Task("t", "what is in README?", Path(".")))
    assert res.outcome == Outcome.UNAVAILABLE
    assert "without reading" in res.detail
    assert any(e.get("k") == "note" and "handing on" in e.get("text", "") for e in events)


def test_a_codex_read_task_that_read_something_is_ok(fake_cli):
    fake_cli.scripts = [_codex_ok(GAVE_UP, tools=["Get-Content README.md"])]
    res, _ = _agent_run(CX.CodexCLIAgent("c1", model="m"), Task("t", "q", Path(".")))
    assert res.outcome == Outcome.OK


def test_a_codex_read_task_is_told_its_shell_can_read(fake_cli):
    fake_cli.scripts = [_codex_ok("fine", tools=["dir"])]
    _agent_run(CX.CodexCLIAgent("c1", model="m"), Task("t", "list the files", Path(".")))
    assert fake_cli.prompts[0].startswith(CX.READ_HINT)
    assert "list the files" in fake_cli.prompts[0]


def test_a_codex_write_task_gets_no_read_hint(fake_cli):
    fake_cli.scripts = [_codex_ok("done", tools=["Edit"])]
    _agent_run(CX.CodexCLIAgent("c1", model="m"), Task("t", "fix it", Path("."), mode=Mode.WRITE))
    assert CX.READ_HINT not in fake_cli.prompts[0]


def test_answer_on_the_same_line_as_its_text_is_cut():
    """A Gemini paragraph renders "ANSWER<newline>text" as "ANSWER text"."""
    assert S.answer_section("ANSWER Blue.\n\nNOTES None.\n\nCONFIDENCE HIGH - sure.") == "Blue."
    assert S.answer_section("ANSWER: Blue.") == "Blue."
    # Prose that starts with the word is not a heading.
    assert S.answer_section("ANSWERS vary by region.") == "ANSWERS vary by region."
