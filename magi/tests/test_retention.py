"""Unpinning restarts the 30-day clock; it does not expose a served sentence.

The bug this guards against is quiet and destructive. Retention used to be
measured from created_at, so pinning a six-month-old deliberation protected it
only for as long as the pin stayed on -- unpin it and it was already 150 days
past the window, so it vanished on the next render. Nobody taps "unpin"
meaning "delete this now".

The behaviour lives in magi.html's JavaScript, which no Python test can run, so
what is asserted here is the shape of it: that the stamp map exists, that both
expiry checks measure from it rather than from created_at, that pinning clears
the stamp and unpinning writes one, that the stamps travel to and from
Firestore so the clock is the same on every device, and that deleting an item
takes its stamp along. Each of those is a separate way for the guarantee to
quietly stop being true.
"""

from __future__ import annotations

from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PAGE = (REPO / "magi.html").read_text(encoding="utf-8")


def _fn(name: str) -> str:
    """One function's source, from its header to the next top-level one."""
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


# ── the stamps exist and are remembered ─────────────────────────────────────
def test_both_maps_exist_and_persist_locally():
    for const, key in (("UNPINNED_AT", "magi.unpinned"),
                       ("BS_UNPINNED_AT", "magi.bsunpinned")):
        assert f"const {const} = " in PAGE, f"{const} is gone"
        assert key in PAGE, f"{const} no longer survives a reload"


# ── the expiry checks measure from the stamp, not from created_at ───────────
def test_deliberation_expiry_measures_from_the_clock_start():
    body = _fn("expired")
    assert "clockStart(" in body, "expired() is back to measuring from created_at"
    assert "isPinned(r)" in body, "a pinned deliberation must never expire"


def test_session_expiry_measures_from_the_clock_start():
    body = _fn("bsExpired")
    assert "BS_UNPINNED_AT" in body, "bsExpired() ignores the unpin stamp again"
    assert "bsPinned(x)" in body, "a pinned session must never expire"


def test_clock_start_falls_back_to_created_at():
    """Never pinned means no stamp, and then nothing about ageing changes."""
    body = _fn("clockStart")
    assert "createdAt" in body, "clockStart() has no fallback for unpinned items"


# ── pinning clears the stamp, unpinning writes one ──────────────────────────
def test_toggling_a_deliberation_pin_moves_the_clock():
    body = _fn("togglePin")
    assert "delete UNPINNED_AT[id]" in body, "pinning no longer stops the clock"
    assert "UNPINNED_AT[id] = new Date().toISOString()" in body, (
        "unpinning no longer restarts the clock"
    )


def test_toggling_a_session_pin_moves_the_clock():
    body = _fn("bsTogglePin")
    assert "delete BS_UNPINNED_AT[id]" in body, "pinning no longer stops the clock"
    assert "BS_UNPINNED_AT[id] = new Date().toISOString()" in body, (
        "unpinning no longer restarts the clock"
    )


# ── and the clock is the same clock on every device ─────────────────────────
@pytest.mark.parametrize("field", ["unpinnedAt: UNPINNED_AT",
                                   "bsUnpinnedAt: BS_UNPINNED_AT"])
def test_stamps_are_written_to_firestore(field):
    assert field in PAGE, f"{field} is no longer saved, so the clock is per-device"


@pytest.mark.parametrize("read", ["d.unpinnedAt", "d.bsUnpinnedAt"])
def test_stamps_are_read_back_from_firestore(read):
    """Written-but-never-read is how the pins themselves used to be broken."""
    assert read in PAGE, f"{read} is never read, so another device's clock is lost"


# ── a deleted item leaves nothing behind ────────────────────────────────────
def test_deleting_an_item_deletes_its_stamp():
    assert "delete UNPINNED_AT[r.id]" in PAGE, "deleted runs leak their stamps"
    assert "delete BS_UNPINNED_AT[x.id]" in PAGE, "deleted sessions leak their stamps"


# ── and the panel says so ───────────────────────────────────────────────────
def test_how_it_works_explains_the_restart():
    start = PAGE.index("const HOW = [")
    panel = PAGE[start : PAGE.index("\n];", start)]
    assert "restart" in panel, (
        "the How it works panel no longer mentions that unpinning restarts the "
        "window -- silence there reads as 'unpinning deletes it'"
    )
