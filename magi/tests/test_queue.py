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

import re

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
    assert "mergeFields: [L.field]" in body, (
        "merge:true cannot delete a removed item, and a full setDoc would "
        "clobber the pins, names and runs that share this document"
    )


def test_queue_writes_are_debounced():
    body = _fn("cloudSaveQueue")
    assert "clearTimeout(L.saveT)" in body and "setTimeout(" in body, (
        "every keystroke or model click is its own write again"
    )


def test_an_edit_in_flight_is_not_overwritten():
    body = _fn("cloudSaveQueue")
    assert "L.dirty = true" in body and "L.dirty = false" in body
    sync = _fn("queuesFromCloud")
    assert "!C.dirty" in sync and "!K.dirty" in sync, (
        "the listener applies an older copy mid-edit"
    )


def test_attachment_bytes_never_reach_firestore():
    """Names, sizes and types travel; the files stay on the device."""
    # One normaliser serves both directions (queueNorm), so it is the body
    # that decides what reaches Firestore -- and queueForCloud must use it.
    assert "const queueForCloud = (L) => queueSorted(L).map(queueNorm);" in PAGE
    body = _fn("queueNorm")
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
    # A drag (2026-10-01) moves a row to any place; still one number.
    body = _fn("queueMoveTo")
    assert "it.order = dropOrder(" in body
    assert body.count(".order =") == 1, "a move rewrites more than one row"
    assert 'it.status !== "queued"' in body, "only a waiting row moves"


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
    drain = _fn("queueDrain")
    assert drain.count("gen !== L.gen") >= 2, (
        "the loop must recheck after every await, not only at the top"
    )
    assert "L.gen++" in _fn("queueStop")


def test_pause_stops_after_the_prompt_in_flight():
    """Not mid-deliberation: the browsers are already running."""
    drain = _fn("queueDrain")
    i = drain.index("await runOne")
    assert "gen !== L.gen" in drain[i:], (
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
    assert "units: coding ? [] : [...S.selected]" in body
    assert "units: it.units" in _fn("queueDrain")
    # A Code row carries its own agents, workspace and Read/Write instead.
    assert 'agents: codeChain().map((m) => m.id), pid: proj.id' in body
    assert "agents: it.agents || []" in _fn("codeQueueRun")


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
    pause = after_run.index("gen !== L.gen")
    assert record < pause, (
        "the generation is rechecked before the outcome is written, which "
        "leaves the paused row stuck on running"
    )


def test_a_row_left_running_by_a_closed_tab_can_be_started_again():
    assert "const queueStuck" in PAGE
    start = _fn("queueStart")
    assert "queueStuck(L)" in start, "the start guard ignores an orphaned row"
    assert 'it.status = "queued"' in start, "an orphan is never reset"
    # ...and the button has to be clickable for that to be reachable at all.
    render = _fn("renderQueue")
    assert "queueStuck(L)" in render, "Run queue stays greyed over a stuck row"


def test_an_orphan_is_only_reclaimed_once_the_lease_is_held():
    """Another device may legitimately be running that row."""
    start = _fn("queueStart")
    assert start.index("leaseClaim(L)") < start.index('it.status = "queued"'), (
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
    init = body[body.index('msg.type === "init"'):body.index('msg.type === "state"')]
    # A run started here folds the replay into its panels (a reconnect after
    # a dropped stream) and returns before the rebuild below.
    assert "if (!attachTo) {" in init and "livePanels.length = 0" in init
    assert init.index("if (!attachTo) {") < init.index("livePanels.length = 0"), (
        "a run started here would have its panels rebuilt from the replay, "
        "throwing away text already on screen"
    )
    assert "if (q.text) p.text = q.text" in init, "an empty replay wipes text"


def test_a_dropped_stream_waits_for_the_reconnect():
    """2026-09-22: ending the run on the first stream error left the prompt
    behind an idle Convene while the council was still going -- two runs."""
    body = _fn("runOne")
    err = body[body.index("es.onerror"):]
    assert "EventSource.CLOSED" in err and "120000" in err
    assert err.index("return;") < err.index("endRun()")


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
    assert "queueChanged(" not in before, (
        "an edit reaches the other devices before it is saved"
    )
    assert "queueChanged(L)" in after
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
    # The PROPERTY, not the exact expression: what must never come back is
    # Queue depending on the engine being reachable. Pinning the literal
    # string instead broke the moment Code Mode added an unrelated term to
    # the same line, which reported "Queue needs the engine" about a change
    # that had nothing to do with the engine.
    qline = next(
        (ln for ln in body.splitlines() if '$("btnQueue").disabled' in ln), ""
    )
    assert qline, "Queue's disabled state is no longer set in updateEnabled"
    rhs = qline.split("=", 1)[1]
    # A word boundary, not a whitespace split: `!up` is one token to str.split() and slid
    # straight through, so the check passed on exactly the line it exists to
    # catch. Verified by mutation -- add `!up` here and this must go red.
    assert not re.search(r"\bup\b", rhs), (
        "Queue needs the engine, which is the opposite of the point"
    )
    assert "online()" not in rhs, (
        "Queue needs the engine, which is the opposite of the point"
    )
    # Why Queue is held is one expression (qWhy) shared by the title, so the
    # rule is read from there: a unit on the council, a workspace and an
    # agent in Code Mode -- and never the engine, in either.
    i = body.index("const qWhy =")
    qwhy = body[i: body.index(";", i)]
    assert not re.search(r"\bup\b", qwhy) and "online()" not in qwhy, (
        "Queue needs the engine, which is the opposite of the point"
    )
    assert "!q" in qline and "qWhy" in qline, (
        "Queue should still need a prompt and at least one unit"
    )
    assert "S.selected.size === 0" in qwhy, "a council prompt needs a unit"
    assert "!codeProject()" in qwhy and "!codeChain().length" in qwhy, (
        "a coding task needs a workspace and an agent"
    )
    # One run at a time: while one runs, the button either adds to it (on
    # screen) or is held (Track F, councilSend).
    assert '$("btnSend").disabled = !q || !!s.why;' in body
    assert 'why = "Another deliberation is running' in _fn("councilSend")


# ── knowing what is running, and what you are reading ───────────────────────
def test_the_running_prompt_is_named_above_the_units():
    """The composer used to be that label. It stopped being one the moment it
    became typable during a run."""
    assert 'id="runNow"' in PAGE
    assert PAGE.index('id="runNow"') < PAGE.index('<div class="magi" id="magi"'), (
        "the banner is below the units it is meant to caption"
    )
    body = _fn("renderRunNow")
    assert "S.live" in body and "S.running" in body
    assert "backToLive" in body, (
        "the banner is the one thing on screen saying a run is in flight, so "
        "it should also be the way back to it"
    )


def test_the_banner_follows_the_run_not_the_composer():
    for fn in ("runOne", "endRun", "setView", "backToLive"):
        assert "renderRunNow()" in _fn(fn), f"{fn} leaves the banner stale"


def test_a_verdict_says_which_question_it_answers():
    """Reading one prompt's verdict while another runs and a third is
    half-typed in the box: nothing on screen said what the verdict was for."""
    assert "viewQuestion" in PAGE
    body = _fn("renderVerdict")
    assert "S.viewQuestion" in body
    assert "S.fromHistory || S.running" in body, (
        "the caption shows even when the composer above it already says the "
        "same thing, or hides when it does not"
    )
    for fn in ("runOne", "showSession", "backToLive"):
        assert "S.viewQuestion" in _fn(fn), f"{fn} leaves the caption stale"


# ── failed prompts can be run again ─────────────────────────────────────────
def test_a_failed_row_offers_retry_and_many_offer_retry_all():
    page = (Path(__file__).resolve().parents[2] / "magi.html").read_text(encoding="utf-8")
    assert "function queueRetry(L, ids)" in page
    assert '`q-act${it.status === "failed" ? " retry" : ""}`' in page
    assert 'id="queueRetryBtn"' in page and "failed.length > 1" in page


def test_a_finished_row_can_run_again():
    """Claude Queue's Requeue: a done row goes back with its units and files."""
    body = _fn("queueRetry")
    assert 'it.status === "failed" || it.status === "done"' in body
    assert 'if (it.status === "failed" || it.status === "done")' in _fn("renderQueue")


# ── a usage limit holds the queue (from Claude Queue) ───────────────────────
def test_a_limit_requeues_the_row_and_holds_instead_of_failing():
    body = _fn("queueDrain")
    hit = body[body.index("if (queueHitLimit(outcome))"):]
    # Back to waiting, not failed -- and the loop sleeps then carries on.
    assert hit.index('it.status = "queued"') < hit.index("queueHoldFor(")
    assert "queueHoldWait(L, gen)" in hit and "continue;" in hit
    # Guessing forever is not allowed.
    assert "guessed > QUEUE_HOLD_GUESSES" in hit


def test_the_hold_is_bounded_and_pausable():
    assert "const QUEUE_HOLD_MIN_MS = 60 * 1000;" in PAGE
    assert "const QUEUE_HOLD_MAX_MS = 6 * 60 * 60 * 1000;" in PAGE
    hold = _fn("queueHoldFor")
    assert "Math.max(now + QUEUE_HOLD_MIN_MS, Math.min(want, now + QUEUE_HOLD_MAX_MS))" in hold
    wait = _fn("queueHoldWait")
    assert "gen !== L.gen" in wait, "Pause must end a hold"
    assert "L.hold = null" in _fn("queueStop"), "a paused queue must not promise to resume"


def test_try_now_and_cancel_wait_act_at_once():
    """Found live: a plain 15s nap meant either button sat for up to 15s."""
    assert "L.holdWake = () =>" in _fn("queueHoldWait")
    assert "queueHoldWake(L)" in _fn("queueStop")
    assert "queueHoldWake(L);" in _fn("renderQueueHold")


def test_the_hold_uses_the_reset_times_the_engine_already_has():
    # Code: the chain's handoff events. Council: the Units sheet's limits.
    assert 'e.k === "handoff" && e.reason === "limited" && e.resets_at' in _fn("codeQueueOutcome")
    assert "u.limit.resets_at" in _fn("queueCouncilReset")


# ── it rings when it needs you ──────────────────────────────────────────────
def test_an_approval_card_rings_and_is_silenced_by_its_decision():
    att = _fn("codeAttach")
    assert 'if (ev.k === "approval") codeApprovalAlarm(t, ev);' in att
    assert 'if (ev.k === "decision" || ev.k === "end") codeApprovalQuiet(t);' in att
    alarm = _fn("codeApprovalAlarm")
    # A replayed, already-answered card must stay silent.
    assert 't.events.some((e) => e.k === "decision")' in alarm
    assert "expires - 60000" in alarm, "one reminder with a minute left"


def test_a_queue_that_stops_by_itself_rings():
    assert "attnSet(L.attn" in _fn("queueDrain")
    assert '"queue:stopped", "Queue"' in PAGE and '"codequeue:stopped", "Code queue"' in PAGE
    assert "if (!S.muted) beepAttention();" in _fn("attnSet")


def test_unit_colours_do_not_wait_for_the_engine():
    page = (Path(__file__).resolve().parents[2] / "magi.html").read_text(encoding="utf-8")
    assert "const UNIT_FALLBACK" in page
    # A council row's dot comes from unitAccent (which has the fallback); a
    # Code row's from the agent it names.
    assert "dot.style.background = info ? info.accent : unitAccent(id);" in page


# ── two queues: Deliberation and Code Mode ──────────────────────────────────
def test_deliberation_and_code_mode_have_separate_queues():
    """They shared one list: a coding task waited behind every council prompt
    ahead of it, and a council rate limit held the coding tasks up too."""
    assert 'council: queueLane("council", "queue", QUEUE_KEY' in PAGE
    assert 'code: queueLane("code", "codeQueue", CODE_QUEUE_KEY' in PAGE
    assert 'const CODE_QUEUE_KEY = lsKey("codequeue")' in PAGE
    # Nothing still reaches for the old single list.
    for gone in ("S.queue", "S.queueRunning", "S.queueHold", "_queueGen",
                 "_queueDirty", "CLOUD.lease"):
        assert gone not in PAGE, f"{gone} is the shared queue coming back"


def test_each_queue_has_its_own_runner_lease_and_hold():
    lane = _fn("queueLane")
    for field in ("running", "hold", "gen", "leaseTimer", "lease", "dirty", "saveT",
                  "holdWake"):
        assert f"{field}:" in lane, f"{field} is shared between the queues"
    assert "leaseField: `${field}Lease`" in lane
    lease = _fn("leaseWrite")
    assert "[L.leaseField]" in lease, "both queues write one lease"
    assert "L.lease" in _fn("leaseClaim")


def test_a_queued_row_lands_in_its_own_modes_queue():
    add = _fn("queueAdd")
    assert "const L = coding ? QUEUES.code : QUEUES.council;" in add
    assert "L.items.push(" in add


def test_the_drawer_shows_the_queue_of_the_mode_on_screen():
    assert "const L = queueViewLane();" in _fn("renderQueue")
    assert "const L = queueViewLane();" in _fn("renderQueueHold")


def test_incoming_rows_only_enter_their_own_queue():
    body = _fn("queueFromCloud")
    assert '(it.kind === "code") === code' in body, (
        "a Code row arriving in `queue` would run as a deliberation"
    )


def test_a_code_row_left_in_the_old_shared_list_moves_rather_than_vanishes():
    sync = _fn("queuesFromCloud")
    assert 'legacy = d.queue.filter((it) => it && it.kind === "code")' in sync
    assert "queueChanged(K)" in sync and "queueChanged(C)" in sync
    local = _fn("loadQueueLocal")
    assert 'shared.filter((it) => it.kind === "code")' in local
    assert "CODE_QUEUE_KEY" in local


def test_a_queued_deliberation_waits_for_one_started_by_hand():
    """The Code queue already waited for a hand-started task; the council's
    ran straight over a hand-started deliberation's screen."""
    free = _fn("queueCouncilFree")
    assert "S.running" in free and "gen !== L.gen" in free
    drain = _fn("queueDrain")
    assert drain.index("queueCouncilFree(L, gen)") < drain.index("await runOne")
    assert "gen !== QUEUES.code.gen" in _fn("codeQueueRun")
