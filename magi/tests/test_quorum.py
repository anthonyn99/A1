"""How many members have to answer before a run is worth continuing.

Tony asked one unit a question and got "NO QUORUM" plus an amber error --
"Only 1 of 1 members responded; synthesis needs at least 2" -- while ChatGPT's
answer sat on the screen above it, complete. Running a single unit is a
legitimate way to use MAGI; the flat minimum treated it as a failure.
"""

from magi.engine.orchestrator import required_members


def test_one_unit_asked_needs_one_answer():
    """The bug, pinned. Asking one and getting one is a success."""
    assert required_members(2, 1) == 1


def test_a_real_quorum_failure_is_still_a_failure():
    """Ask four, get one, and that IS worth refusing.

    min_members exists to stop a single voice being presented as a council
    verdict. Loosening it for the one-unit case must not loosen it here.
    """
    assert required_members(2, 4) == 2
    assert required_members(3, 4) == 3


def test_the_requirement_never_exceeds_what_was_asked():
    assert required_members(3, 2) == 2
    assert required_members(9, 3) == 3


def test_never_below_one():
    """Zero answers is nothing to report on, whatever the config says."""
    assert required_members(0, 3) == 1
    assert required_members(-5, 3) == 1
    assert required_members(2, 0) == 1
