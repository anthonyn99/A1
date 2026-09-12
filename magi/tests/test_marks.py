"""Pins and names have exactly one home, and an edit is never undone.

Every one of these guards a bug that shipped. Pinning, unpinning and renaming
a past deliberation all appeared to do nothing, and the cause was two copies
of the same fact fighting each other:

  * the mark was ALSO stored on the run's cloud index row, and isPinned/nickOf
    fell back to that copy -- so unpinning cleared the map, the row still said
    pinned:true, and the list came back pinned;
  * the marks were written with merge:true, which merges a map key by key, so
    a key deleted here was never deleted there -- "Remove name" wrote the map
    without the name and Firestore handed the name straight back;
  * the snapshot listener applied the incoming copy unconditionally, so any
    snapshot arriving between the tap and the flush restored the document as
    it was before the tap.

None of it can be tested from Python by running it -- it is browser code
driving Firestore -- so what is asserted is the shape that makes it correct.
The behaviour itself was verified in a headless browser against a Firestore
stand-in with these exact merge semantics.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PAGE = (REPO / "magi.html").read_text(encoding="utf-8")


def _fn(name: str) -> str:
    for opener in (f"function {name}(", f"const {name} = ("):
        i = PAGE.find(opener)
        if i != -1:
            break
    else:
        pytest.fail(f"{name} is gone from magi.html")
    depth, j = 0, PAGE.index("{", i)
    for k in range(j, len(PAGE)):
        if PAGE[k] == "{":
            depth += 1
        elif PAGE[k] == "}":
            depth -= 1
            if depth == 0:
                return PAGE[i : k + 1]
    pytest.fail(f"{name} never closes")


# ── one home ────────────────────────────────────────────────────────────────
def test_a_pin_is_read_from_one_place():
    assert "const isPinned = (r) => PINS.has(r.id);" in PAGE, (
        "isPinned reads something other than PINS again -- a second copy of a "
        "pin is what made unpinning impossible"
    )


def test_a_name_is_read_from_one_place():
    line = re.search(r"const nickOf = .*", PAGE).group(0)
    assert "r.nick" not in line, "nickOf falls back to the row copy again"


@pytest.mark.parametrize("fn", ["togglePin", "setNick"])
def test_editing_a_mark_does_not_also_write_the_index(fn):
    """Two writers on two debounces is how a pin arrived and was contradicted."""
    body = _fn(fn)
    assert "cloudUpsertIndex" not in body, f"{fn} writes the index row again"
    assert "cloudSaveMarks()" in body, f"{fn} no longer syncs the mark"
    assert "mergeHistory()" in body, f"{fn} no longer redraws the list"


def test_the_index_row_never_carries_a_mark():
    body = _fn("cloudUpsertIndex")
    assert "delete row.pinned" in body and "delete row.nick" in body, (
        "index rows can carry pins and names again"
    )


# ── a removal has to propagate ──────────────────────────────────────────────
@pytest.mark.parametrize(
    "fn,fields",
    [("cloudSaveMarks", ["pins", "nicks", "unpinnedAt"]),
     ("cloudSaveBsMarks", ["bsPins", "bsNicks", "bsUnpinnedAt"])],
)
def test_marks_are_written_with_mergefields(fn, fields):
    body = _fn(fn)
    assert "mergeFields" in body, (
        f"{fn} is back to merge:true, which cannot delete a map key -- "
        "removing a name will silently come back"
    )
    for f in fields:
        assert f'"{f}"' in body, f"{fn} no longer replaces {f} outright"
    assert "{ merge: true }" not in body, f"{fn} still merges a map key by key"


# ── an edit in flight is not overwritten ────────────────────────────────────
@pytest.mark.parametrize("flag,fn", [("_marksDirty", "cloudSaveMarks"),
                                     ("_bsMarksDirty", "cloudSaveBsMarks")])
def test_an_in_flight_edit_blocks_the_listener(flag, fn):
    body = _fn(fn)
    assert f"{flag} = true" in body, f"{fn} no longer announces an edit in flight"
    assert f"{flag} = false" in body, f"{flag} is never cleared"
    # Cleared only after the write, never in the catch: a failed write leaves
    # this browser holding the newer truth.
    after = body[body.index(f"{flag} = false"):]
    assert "catch" in after, f"{flag} is cleared before the write can fail"
    assert f"!{flag}" in PAGE, f"the listener does not consult {flag}"


def test_the_listener_compares_before_it_applies():
    """Applying an identical copy re-renders the list under the user's finger."""
    watch = _fn("cloudWatch")
    for field in ("d.pins", "d.nicks", "d.unpinnedAt",
                  "d.bsPins", "d.bsNicks", "d.bsUnpinnedAt"):
        assert field in watch, f"{field} is no longer read back"
    assert "bsChanged" in watch, "session marks apply unconditionally again"


# ── the one-time migration ──────────────────────────────────────────────────
def test_old_row_marks_are_folded_in_only_once():
    watch = _fn("cloudWatch")
    assert "CLOUD.folded" in watch, "the legacy fold is gone"
    assert "!Array.isArray(d.pins)" in watch, (
        "the fold adopts old row pins even when a modern pins field exists -- "
        "an empty pins array is a pin deliberately removed, and re-adopting "
        "it hands it straight back"
    )


def test_old_row_marks_are_stripped():
    body = _fn("cloudStripRowMarks")
    assert 'mergeFields: ["runs"]' in body, "the strip rewrites more than runs"
