"""When a member uses a tool instead of answering.

Observed live. Asked for a ten-section daily trading report, Claude replied
"I'll help you build a Daily Macro & Long-Only Trading Report template", read
its memories, and started building an interactive generator as a FILE. MAGI
waited for text that never settled, the run ended `stall_timeout`, and the
council lost a member on a question it could have answered.

Two defences, both pinned here:

  1. every member is told, on every turn, that the answer goes in the chat;
  2. whatever tool chrome leaks into the capture anyway is stripped, so the
     validator weighs the model's words and not the UI's account of them.
"""

from __future__ import annotations

import pytest

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from magi.browser.extract import clean, strip_tool_rows  # noqa: E402
from magi.providers.browser_base import DIRECT_ANSWER_PREAMBLE  # noqa: E402

# Exactly what came back, from magi/data's stored answer.
CAPTURED = (
    "I'll help you build a Daily Macro & Long-Only Trading Report template. "
    "Let me first check what information we need to gather.\n"
    "Read 4 memories\n"
    "Read 4 memories\n"
    "Perfect. You've given me the template structure.\n"
    "Creating a file56srunning\n"
    "Creating a file"
)


def test_the_preamble_says_where_the_answer_goes_and_nothing_else():
    """It must not be able to bend an answer -- only to place it.

    Any word about content, length, tone or format here would silently shape
    every council answer, every synthesis and every Studio card.
    """
    import re

    p = DIRECT_ANSWER_PREAMBLE.lower()
    assert "in this chat" in p
    for banned in ("concise", "brief", "detailed", "bullet", "format", "tone",
                   "short", "long", "markdown", "expert"):
        # Whole words. "information" contains "format", and failing on that
        # would be the test shaping the prompt rather than guarding it.
        assert not re.search(rf"\b{banned}\b", p), (
            f"the preamble is shaping answers: {banned!r}"
        )
    # Separated from the question, or it runs into the first line of it.
    assert DIRECT_ANSWER_PREAMBLE.endswith("\n\n")


def test_the_preamble_names_the_things_that_swallow_an_answer():
    p = DIRECT_ANSWER_PREAMBLE.lower()
    for surface in ("artifact", "canvas", "document", "file"):
        assert surface in p, surface


def test_tool_rows_are_stripped_from_the_middle_of_an_answer():
    out = clean(CAPTURED)
    assert "Read 4 memories" not in out
    assert "Creating a file" not in out
    # ...and the model's own sentences survive.
    assert "I'll help you build" in out
    assert "You've given me the template structure." in out


def test_the_glued_timer_does_not_save_a_tool_row():
    """"Creating a file56srunning" is three sibling nodes with no whitespace
    between them, so innerText concatenates them into one word."""
    assert strip_tool_rows("Creating a file56srunning\n").strip() == ""
    assert strip_tool_rows("Creating a file 12s running\n").strip() == ""
    assert strip_tool_rows("Read 4 memories\n").strip() == ""


def test_a_sentence_that_merely_mentions_a_tool_is_left_alone():
    """A false positive here deletes the model's actual words.

    The rows are matched as whole lines that contain nothing else, which is
    what makes stripping mid-answer safe at all.
    """
    prose = [
        "Creating a file is the first step, then you commit it.",
        "I read 4 memories of the last crash before answering.",
        "The script is creating a file in /tmp for each ticker.",
    ]
    for line in prose:
        assert strip_tool_rows(line + "\n").strip() == line


def test_an_answer_made_entirely_of_tool_rows_collapses_to_nothing_much():
    """Which is the point: the validator has to see how little was said.

    Leaving the rows in gives a non-answer more apparent content to weigh, so
    rubbish is likelier to be passed off as an answer.
    """
    only_tools = "Read 4 memories\nCreating a file56srunning\nCreating a file"
    assert clean(only_tools) == ""


def test_the_preamble_says_there_is_no_second_turn():
    """With the artifact fixed, Claude asked permission instead: "Should I
    search the web, or wait for you to provide the data?" -- reasonable to ask
    a person, worthless here. Nobody is watching that tab to say yes, and the
    other three units simply looked the data up."""
    p = DIRECT_ANSWER_PREAMBLE.lower()
    assert "single turn" in p
    assert "no follow-up" in p
    assert "look things up" in p


# ── declining at length ──────────────────────────────

def test_an_offer_to_do_the_work_is_not_an_answer():
    """Captured live at 543 characters, and counted as a full council vote.

    The short-clarifying-question rule stops at MIN_ANSWER_CHARS, because a
    long answer ending in a question mark is a normal rhetorical device. But a
    member can decline at length, and in a one-shot council asking permission
    is the same as declining.
    """
    from magi.engine.validate import Rejection, validate_answer

    captured = (
        "I'm ready to deliver your Daily Macro Snapshot. However, I need "
        "current market data to provide an accurate analysis.\n\nTo give you a "
        "proper read, I need:\n\n- Today's key economic data\n- Current levels: "
        "S&P 500, 10Y yield, crude oil\n\n**Should I:**\n\n1. Search the web for "
        "today's macro data and market levels?\n2. Wait for you to provide "
        "specific data points?\n\nLet me know and I'll deliver the snapshot."
    )
    v = validate_answer(captured, "Daily Macro Snapshot", display_name="Claude")
    assert not v.ok
    assert v.reason is Rejection.CLARIFYING_QUESTION


def test_a_real_answer_that_closes_with_an_offer_survives():
    """"Let me know if you want me to go deeper?" after a full answer is
    manners, not a refusal, and throwing it away would lose a good answer."""
    from magi.engine.validate import validate_answer

    body = (
        "Use Postgres for this database workload. "
        + "It handles your volume comfortably and the operational story is "
          "simpler than the alternatives for this database. " * 20
        + "Let me know if you want me to go deeper on the sharding options?"
    )
    assert validate_answer(body, "which database should I use", display_name="X").ok


def test_web_search_rows_go_in_both_tenses():
    """The row reads "Searching the web" while it runs and "Searched the web"
    once it is done, and a capture can land on either -- both were observed in
    the same verification run."""
    for row in ("Searched the web", "Searching the web", "Looked up the web"):
        assert strip_tool_rows(row + chr(10)).strip() == "", row
    # ...but the same words inside a sentence are the model's, not the UI's.
    prose = "I searched the web for the latest CPI print and found 3.4%."
    assert strip_tool_rows(prose + chr(10)).strip() == prose


def test_a_capture_of_the_sent_prompt_is_not_a_vote():
    """Grok 2026-09-16: the user's own bubble was scraped and counted."""
    from magi.engine import validate
    assert " ".join(DIRECT_ANSWER_PREAMBLE.lower().split()).startswith(validate.ECHO_PREFIX)
    v = validate.validate_answer(DIRECT_ANSWER_PREAMBLE + "Describe this environment",
                                 "Describe this environment", display_name="Grok")
    assert not v.ok and v.reason == validate.Rejection.ECHO


@pytest.mark.parametrize("attach", [True, False])
def test_a_correct_description_of_a_photo_is_not_off_topic(attach):
    """Gemini and Claude, 2026-09-16: rejected for describing the photo."""
    from magi.engine import validate
    text = ("The image depicts a tranquil night landscape dominated by Mount Fuji, "
            "set against a clear starry sky with mist hanging over a dark lake. ") * 3
    v = validate.validate_answer(text, "Describe this environment",
                                 display_name="Gemini", has_attachments=attach)
    assert v.ok, v.detail


def test_a_limit_reset_time_is_read_from_the_sites_wording():
    from datetime import datetime, timedelta, timezone
    from magi.engine import usage
    seen = datetime(2026, 9, 16, 16, 42, tzinfo=timezone.utc)
    assert usage.parse_reset("6 hours 50 minutes before limit is gone", seen) == seen + timedelta(hours=6, minutes=50)
    assert usage.parse_reset("Try again in 45 minutes", seen) == seen + timedelta(minutes=45)
    assert usage.parse_reset("You've reached your upload limit.", seen) is None


def test_an_old_timeout_whose_snapshot_shows_a_limit_is_reported_as_one(tmp_path):
    import json, sqlite3
    from datetime import datetime, timezone
    from magi.engine import usage
    snap = tmp_path / "grok.html"
    snap.write_text("<div><p>Describe this environment</p></div>"
                    "<div class='x'>6 hours 50 minutes before limit is gone</div>", encoding="utf-8")
    db = tmp_path / "m.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE answers(provider_id, ok, failure_kind, error_detail, degraded_reason, ended_at, artifacts)")
    now = datetime.now(timezone.utc).isoformat()
    con.execute("INSERT INTO answers VALUES('grok',0,'empty_response','stayed empty',NULL,?,?)",
                (now, json.dumps([str(snap)])))
    con.commit(); con.close()
    r = usage._recent_sync(str(db), "grok", ["text=/before limit is gone/i"])
    (i,) = r["issues"]
    assert i["limit"] and i["resets_at"] and not i["cleared"]
    assert i["detail"] == "The site said: 6 hours 50 minutes before limit is gone"
