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


# ── pausing, and picking it back up ─────────────────────────────────────────
def test_the_prompt_in_flight_is_recorded_even_when_you_pause():
    """The pause bug: the loop returned on the generation check BEFORE writing
    the outcome, so the row stayed "running" for ever. It then counted as
    neither waiting nor finished, Run queue had nothing to start, and the
    button sat greyed out over a prompt that had actually finished."""
    body = _fn("queueDrain")
    after_run = body[body.index("await runOne"):]
    record = after_run.index("it.status = outcome.ok")
    pause = after_run.index("gen !== _queueGen")
    assert record < pause, (
        "the generation is rechecked before the outcome is written, which "
        "leaves the paused row stuck on running"
    )


def test_a_row_left_running_by_a_closed_tab_can_be_started_again():
    assert "const queueStuck" in PAGE
    start = _fn("queueStart")
    assert "queueStuck()" in start, "the start guard ignores an orphaned row"
    assert 'it.status = "queued"' in start, "an orphan is never reset"
    # ...and the button has to be clickable for that to be reachable at all.
    render = _fn("renderQueue")
    assert "queueStuck()" in render, "Run queue stays greyed over a stuck row"


def test_an_orphan_is_only_reclaimed_once_the_lease_is_held():
    """Another device may legitimately be running that row."""
    start = _fn("queueStart")
    assert start.index("leaseClaim()") < start.index('it.status = "queued"'), (
        "rows are reset before the lease is claimed, so a row another device "
        "is running would be restarted here as well"
    )


# ── watching a prompt that is already running ───────────────────────────────
def test_a_row_records_its_run_id_as_the_run_starts():
    """Not when it ends. A refresh mid-prompt has to have something to point
    at, or the row says "running" about a run nothing can find."""
    body = _fn("queueDrain")
    assert "onRunStart" in body, "the id is only recorded once the run finishes"
    assert body.index("onRunStart") < body.index("await runOne"), (
        "the callback is armed after the run has already started"
    )
    assert "onRunStart = null" in body, "the callback outlives the run"


def test_a_running_row_can_be_watched():
    body = _fn("renderQueue")
    assert "queueWatch" in body, "a running row offers no way to see it happen"
    assert "Watch this deliberation" in body


def test_watching_attaches_rather_than_starting_another_run():
    """The expensive mistake: re-running a prompt the engine is still running
    would ask the whole council the same question twice."""
    watch = _fn("watchRun")
    assert "attachTo: runId" in watch
    one = _fn("runOne")
    assert "if (!runId) {" in one, "runOne always POSTs, so attaching restarts"
    assert 'form.append("question"' in one


def test_the_engines_replay_rebuilds_the_grid_only_when_attaching():
    body = _fn("runOne")
    assert 'msg.type === "init"' in body, "the replay frame is ignored"
    assert "if (!attachTo || !msg.providers) return;" in body, (
        "a run started here would have its panels rebuilt from the replay, "
        "throwing away text already on screen"
    )


def test_a_reload_reconnects_instead_of_requeuing_a_run_that_has_an_id():
    load = _fn("loadQueueLocal")
    assert "resumable" in load, (
        "a row mid-run is requeued outright, so the next Run asks the council "
        "a question it is already answering"
    )
    resume = _fn("queueResume")
    assert "queueWatch" in resume
    # ...and nothing else starts by itself on load.
    assert "queueStart" not in resume, (
        "a page that starts deliberations on load spends your accounts while "
        "you are reading something else"
    )


def test_the_close_control_sits_with_copy():
    body = _fn("renderVerdict")
    assert "verdict-acts" in body, "Close and Copy are no longer one group"
    assert 'acts.append(shut)' in body
    assert '(n.querySelector(".verdict-acts") || hd)' in body, (
        "the copy button went back to the header, so the header's spare width "
        "sits between the two controls again"
    )


def test_editing_a_row_does_not_ask_to_delete_it():
    """The pencil reused the confirming remove, so it popped "Remove this
    prompt?" at someone who had asked to edit. It no longer removes anything
    at all -- see the editor tests below."""
    body = _fn("queueEdit")
    assert "Remove this prompt" not in body


# ── editing a queued prompt ─────────────────────────────────────────────────
def test_editing_opens_its_own_panel_rather_than_borrowing_the_composer():
    """With a prompt running, the composer is busy: the pencil used to move
    your queued text behind a DELIBERATING button you could not press, and
    drop the row on the way."""
    body = _fn("queueEdit")
    assert "uiConfirmMagi" not in body, "the pencil confirms a deletion again"
    assert "queueRemove" not in body, "editing still deletes the row"
    assert 'el("div", "sheet")' in body, "no panel of its own"
    assert "setQuestion(" not in body, "it writes into the composer again"


def test_the_editor_can_do_what_the_composer_can():
    body = _fn("queueEdit")
    assert "/api/refine" in body, "no Refine"
    assert "MAX_ATTACHMENTS" in body and "fileIn.click()" in body, "cannot add files"
    assert "units.delete(p.id)" in body, "cannot change who is asked"


def test_nothing_is_written_back_until_save():
    """Cancel has to mean cancel, and a half-finished edit must not sync."""
    body = _fn("queueEdit")
    i = body.index("save.onclick")
    before, after = body[:i], body[i:]
    assert "queueChanged()" not in before, (
        "an edit reaches the other devices before it is saved"
    )
    assert "queueChanged()" in after
    assert "let text = it.q" in before, "the row is edited in place, not copied"


def test_an_attachment_from_another_device_is_shown_but_not_faked():
    body = _fn("queueEdit")
    assert "elsewhere" in body, (
        "a file whose bytes live on another device is offered as though this "
        "one could send it"
    )


def test_a_failed_verdict_does_not_read_as_a_failed_deliberation():
    body = _fn("renderVerdict")
    assert "verdict-failed" in body
    assert "cleanSynthError" in body, "the raw FailureKind reaches the screen"
    clean = _fn("cleanSynthError")
    assert "None" in clean, "the None case is no longer stripped"


# ── popups ──────────────────────────────────────────────────────────────────
def test_no_sheet_keeps_its_own_dismissal_rule():
    """`click` fires on the nearest ancestor SHARED by where a press started
    and where it ended -- so dragging to select text in a box and releasing
    past its edge fired a click on the backdrop, and every sheet took that as
    "close". Selecting the text of a prompt closed the editor."""
    assert "sheet.onclick = (e) =>" not in PAGE, (
        "a sheet dismisses itself again, which means it closes on a text drag"
    )
    assert PAGE.count("dismissOnBackdrop(") >= 8, "not every sheet uses the helper"


def test_the_backdrop_needs_both_ends_of_the_gesture():
    body = _fn("dismissOnBackdrop")
    assert "pointerdown" in body and "pointerup" in body
    assert "down && up" in body, "one end of the gesture is enough again"


def test_escape_closes_only_the_topmost_sheet():
    body = _fn("dismissOnBackdrop")
    assert 'querySelectorAll(".sheet")' in body, (
        "Escape closes every open sheet at once"
    )
    assert "removeEventListener" in body, "the key handler outlives its sheet"


def test_the_editors_styles_are_declared_after_the_sheet_styles():
    """They lost every tie when they came first: .sheet-lbl{display:block}
    beat .qedit-lbl{display:flex} on source order alone, and the units count
    rendered as "UNITS3 of 6"."""
    assert PAGE.index("\n.sheet {") < PAGE.index(".qedit-lbl {"), (
        "the editor's rules are back above the sheet rules they extend, so "
        "they are silently overridden"
    )
    assert PAGE.index("\n.sheet-lbl {") < PAGE.index(".qedit-lbl {")


# ── the composer during a run ───────────────────────────────────────────────
def test_typing_is_never_blocked_by_a_run():
    """The queue exists so the next prompts can be written WHILE the council
    works; disabling the box made the one screen where you would queue
    something the one screen where you could not."""
    body = _fn("updateEnabled")
    assert '$("composer").disabled = S.refining;' in body, (
        "the composer is disabled by a run in flight again"
    )
    assert '$("btnQueue").disabled = !q || S.selected.size === 0;' in body, (
        "Queue needs the engine, which is the opposite of the point"
    )
    # Convene still waits its turn: one run at a time.
    assert '$("btnSend").disabled = busy' in body
