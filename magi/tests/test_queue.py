"""The prompt queue's contract with Firestore and with itself.

The queue's expensive mistakes are all invisible ones: syncing attachment
bytes, spending a write per keystroke, two devices draining one list into one
engine, or a second drain loop started by a quick Pause/Run. None of those
show up as an error message -- they show up as a Firebase bill or as two
prompts interleaved in one browser.

The behaviour itself was verified by driving the console in a headless
browser: three prompts ran in order with their own units and models, a
failure did not stop the rest, a rate limit did, Pause stopped after the
prompt in flight, and a rapid Run/Pause/Run never ran a prompt twice.
"""

from __future__ import annotations

from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PAGE = (REPO / "magi.html").read_text(encoding="utf-8")


def _fn(name: str) -> str:
    i = PAGE.index(f"function {name}(")
    depth, j = 0, PAGE.index("{", PAGE.index(") {", i))
    for k in range(j, len(PAGE)):
        if PAGE[k] == "{":
            depth += 1
        elif PAGE[k] == "}":
            depth -= 1
            if depth == 0:
                return PAGE[i : k + 1]
    raise AssertionError(f"{name} never closes")


# ── what it costs to sync ───────────────────────────────────────────────────
def test_the_queue_rides_the_document_that_is_already_watched():
    """A separate collection would mean a second listener and a read per item
    per device. One field on the index doc costs nothing to receive."""
    body = _fn("cloudSaveQueue")
    assert "_indexDoc()" in body, "the queue moved off the index document"
    assert 'mergeFields: ["queue"]' in body, (
        "merge:true cannot delete a removed item, and a full setDoc would "
        "clobber the pins, names and runs that share this document"
    )


def test_queue_writes_are_debounced():
    body = _fn("cloudSaveQueue")
    assert "clearTimeout(_queueT)" in body and "setTimeout(" in body, (
        "every keystroke or model click is its own write again"
    )


def test_an_edit_in_flight_is_not_overwritten():
    body = _fn("cloudSaveQueue")
    assert "_queueDirty = true" in body and "_queueDirty = false" in body
    assert "!_queueDirty" in PAGE, "the listener applies an older copy mid-edit"


def test_attachment_bytes_never_reach_firestore():
    """Names, sizes and types travel; the files stay on the device."""
    # An arrow const returning an object literal, so it ends on "}));" --
    # stopping at the first "});" ran off the end into unrelated code and made
    # this test pass or fail on whatever happened to be below it.
    body = PAGE[PAGE.index("const queueForCloud ="):]
    body = body[: body.index("}));") + 4]
    assert "atts" in body and "a.n" in body and "a.s" in body
    for forbidden in ("file", "File", "blob", "base64", "dataURL"):
        assert forbidden not in body, f"{forbidden} is being serialised"
    assert "QUEUE_FILES" in PAGE, "nowhere holds the actual files"
    # The map that holds them is explicitly NOT part of the synced state.
    assert "const QUEUE_FILES = new Map()" in PAGE


def test_a_device_without_the_files_says_so():
    body = _fn("queueDrain")
    assert "missing" in body, (
        "a prompt whose attachments live on another device runs silently "
        "without them"
    )


# ── ordering ────────────────────────────────────────────────────────────────
def test_moving_a_row_changes_only_that_row():
    """Fractional keys, from Claude Queue: a move is one number, not a
    renumbering of every sibling -- which in a field that syncs as a whole
    keeps the diff small."""
    assert "QUEUE_STEP = 1000" in PAGE
    body = _fn("queueMove")
    assert "it.order =" in body
    assert body.count(".order =") == 1, "a move rewrites more than one row"


# ── one runner ──────────────────────────────────────────────────────────────
def test_only_one_device_drains_the_queue():
    assert "queueLease" in PAGE, "nothing stops two devices draining at once"
    body = _fn("leaseClaim")
    assert "LEASE_STALE_MS" in body, (
        "a lease nobody refreshes would freeze the queue for ever -- a closed "
        "laptop must not be able to hold it"
    )
    assert "DEVICE_ID" in body


def test_a_second_drain_loop_cannot_start():
    """Veda's bug: Pause then Run quickly started a second loop over one list."""
    assert "_queueGen" in PAGE
    drain = _fn("queueDrain")
    assert drain.count("gen !== _queueGen") >= 2, (
        "the loop must recheck after every await, not only at the top"
    )
    assert "_queueGen++" in _fn("queueStop")


def test_pause_stops_after_the_prompt_in_flight():
    """Not mid-deliberation: the browsers are already running."""
    drain = _fn("queueDrain")
    i = drain.index("await runOne")
    assert "gen !== _queueGen" in drain[i:], (
        "the generation is not rechecked after the run, so a pause would land "
        "mid-prompt or be ignored"
    )


def test_a_rate_limit_stops_the_queue_but_a_failure_does_not():
    drain = _fn("queueDrain")
    assert "queueHitLimit" in drain
    limit = _fn("queueHitLimit")
    assert "RATE_LIMITED" in limit
    assert "limited.length === answers.length" in limit, (
        "one rate-limited unit out of six would stop the whole queue"
    )


# ── per-item settings ───────────────────────────────────────────────────────
def test_each_item_carries_its_own_units():
    body = _fn("queueAdd")
    assert "units: [...S.selected]" in body
    assert "units: it.units" in _fn("queueDrain")


def test_queueing_does_not_rewrite_the_ticked_set():
    """S.selected is a per-device preference that syncs; a queue item is not
    allowed to be a side effect on it."""
    body = _fn("queueDrain")
    assert "S.selected =" not in body
    assert "S.selected =" not in _fn("queueAdd")
    # runOne builds its panels from the units it was HANDED.
    assert "ids.includes(p.id)" in _fn("runOne")
