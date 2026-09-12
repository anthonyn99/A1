"""Every prompt box can be resized, and the screens read the same way.

The grip is easy to half-add: a button with no drag, a drag that autosize
undoes on the next keystroke, or one box out of three left without it. And
the two composer screens -- Deliberation and Brainstorm -- have drifted apart
before, which is why their heading and description are asserted together.
"""

from __future__ import annotations

from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PAGE = (REPO / "magi.html").read_text(encoding="utf-8")


# ── the grip is on all three boxes ──────────────────────────────────────────
def test_the_council_composer_has_a_grip():
    assert 'id="composerGrip"' in PAGE
    assert 'attachGrip($("composer"), $("composerGrip"), "composer", autosize);' in PAGE


@pytest.mark.parametrize("key", ["bstopic", "bsreply"])
def test_both_brainstorm_boxes_have_a_grip(key):
    assert f'attachGrip(ta, ' in PAGE and f'"{key}"' in PAGE, (
        f"the {key} box lost its resize grip"
    )


def test_the_grip_is_usable_with_a_finger():
    """Without touch-action:none the browser claims the drag as a scroll."""
    css = PAGE[PAGE.index(".qbar-grip {"):]
    css = css[: css.index("}")]
    assert "touch-action: none" in css
    # A 14px native corner is a stab target, not a grab target.
    assert "width: 34px" in css and "height: 30px" in css


# ── and a hand-set height sticks ────────────────────────────────────────────
@pytest.mark.parametrize("fn", ["function autosize()", "function bsAutosize(ta)"])
def test_autosize_leaves_a_hand_set_height_alone(fn):
    body = PAGE[PAGE.index(fn):]
    body = body[: body.index("\n}")]
    assert "dataset.userH" in body, (
        "autosize overrides a height set with the grip -- the box springs back "
        "on the next keystroke, which is what makes a handle feel broken"
    )


def test_a_hand_set_height_lifts_the_stylesheet_cap():
    body = PAGE[PAGE.index("function attachGrip("):]
    body = body[: body.index("\n}\n")]
    assert "ta.style.maxHeight" in body, (
        "the 45vh cap still applies, so a drag stops halfway down"
    )


def test_the_height_is_remembered():
    body = PAGE[PAGE.index("function attachGrip("):]
    assert '"magi.h." + key' in body[: body.index("\n}\n")]


# ── the two composer screens ────────────────────────────────────────────────
def test_the_deliberation_heading_is_one_word():
    assert '<span class="bs-title council-title">Deliberation</span>' in PAGE
    hd = PAGE[PAGE.index('id="councilHd"'):]
    hd = hd[: hd.index("</div>")]
    assert "bs-sub" not in hd, "the description is back above the composer"


def test_both_descriptions_sit_under_the_units():
    # Council: the note element is markup, and it follows the unit bar.
    assert PAGE.index('id="unitBar"') < PAGE.index('id="councilNote"'), (
        "the council's description is no longer below the units"
    )
    # Brainstorm: the note is appended right after the borrowed unit bar.
    bs = PAGE[PAGE.index('if ($("unitBar")) root.append($("unitBar"));'):]
    assert "view-note" in bs[:400], (
        "the brainstorm description is no longer below the units"
    )


def test_both_captions_clear_the_units_by_the_same_distance():
    """Same rule, two layouts: one collapses margins and one does not.

    In the council the note's margin-top collapses with the unit row's own
    16px bottom margin; inside the brainstorm panel nothing collapses and the
    panel's flex gap adds on top. One margin for both read as 26px on one
    screen and 54px on the other.
    """
    css = PAGE[PAGE.index(".view-note {"):]
    css = css[: css.index("}")]
    assert "margin: 54px auto 0" in css
    assert ".bs .view-note { margin-top: 26px; }" in PAGE, (
        "the brainstorm caption no longer takes back the panel's own spacing, "
        "so the two screens have drifted apart again"
    )


def test_the_descriptions_are_dimmed():
    css = PAGE[PAGE.index(".view-note {"):]
    css = css[: css.index("}")]
    assert "var(--txd)" in css, "the captions are no longer the dimmest text"


def test_the_council_description_appears_with_its_heading():
    body = PAGE[PAGE.index("function syncCouncilIdle()"):]
    body = body[: body.index("\n}")]
    assert "councilNote" in body, (
        "the description no longer follows the heading's visibility, so it "
        "will linger over a screen full of answers"
    )


# ── one grid, two screens ───────────────────────────────────────────────────
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


def test_the_grid_records_which_screen_filled_it():
    """A deliberation and a brainstorm round fill the SAME panels.

    Without an owner, opening a past deliberation and then starting a
    brainstorm session carried that deliberation's units and its CENTRAL
    DOGMA panel onto the brainstorm screen.
    """
    assert "gridOwner: null," in PAGE, "S.gridOwner is gone"
    assert 'S.gridOwner = "brainstorm";' in _fn("primeGridForRound")
    for fn in ("start", "openRun", "cloudOpenRun"):
        assert 'S.gridOwner = "council";' in _fn(fn), f"{fn} does not claim the grid"
    assert "S.gridOwner = null;" in _fn("newRun")
    assert "S.gridOwner = null;" in _fn("bsReset")


@pytest.mark.parametrize(
    "fn,needle",
    [("setView", "gridMine"),
     ("renderVerdict", 'S.gridOwner === "council"'),
     ("syncCouncilIdle", "ownGrid")],
)
def test_each_screen_only_shows_a_grid_it_owns(fn, needle):
    assert needle in _fn(fn), f"{fn} shows another screen's grid again"


def test_studio_follows_the_verdict_it_builds_from():
    line = [l for l in PAGE.splitlines() if "const studioEnabled" in l][0]
    tail = PAGE[PAGE.index(line):PAGE.index(line) + 260]
    assert 'S.gridOwner === "council"' in tail, (
        "Studio offers cards built from a verdict that is no longer on screen"
    )
