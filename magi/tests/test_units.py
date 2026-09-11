"""Every configured unit is fully wired into the console.

Adding a unit means touching three files, and the two that are easy to forget
are both in magi.html: a unit with no codename renders a blank second line on
its chip, and one with no PHASE gets no stagger in the grid animation. Neither
throws, so neither is noticed.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import yaml  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
PAGE = (REPO / "magi.html").read_text(encoding="utf-8")
SITES = yaml.safe_load(
    (REPO / "magi" / "config" / "selectors.yaml").read_text(encoding="utf-8")
)["sites"]


def _map(name: str) -> dict:
    block = PAGE[PAGE.index(f"const {name} = {{"):]
    block = block[: block.index("};") + 2]
    return dict(re.findall(r"(\w+):\s*\"([^\"]+)\"", block))


def test_every_unit_has_a_codename_and_a_phase():
    units, phases = _map("UNIT"), _map("PHASE")
    for sid in SITES:
        assert sid in units, f"{sid} has no codename in UNIT"
        assert sid in phases, f"{sid} has no stagger in PHASE"


def test_no_two_units_share_a_codename_or_an_accent():
    """Two units the same colour is two units you cannot tell apart in the
    grid, which is the one thing the grid exists to do."""
    units = _map("UNIT")
    names = [units[s] for s in SITES]
    assert len(set(names)) == len(names), f"duplicate codename: {names}"

    accents = [SITES[s].get("accent") for s in SITES]
    assert all(accents), "a unit has no accent colour"
    assert len(set(accents)) == len(accents), f"duplicate accent: {accents}"


def test_every_unit_declares_the_fields_a_run_needs():
    """A missing composer or answer selector is a unit that cannot answer."""
    for sid, cfg in SITES.items():
        assert cfg.get("input"), f"{sid} has no input selector"
        assert cfg.get("assistant_turn"), f"{sid} has no assistant_turn selector"
        assert cfg.get("url", "").startswith("https://"), sid
        assert cfg.get("display_name"), sid
        # submit MAY be empty (DeepSeek sends with Enter), but then the key
        # has to be set or nothing ever gets sent.
        assert cfg.get("submit") or cfg.get("send_key"), f"{sid} can never send"
