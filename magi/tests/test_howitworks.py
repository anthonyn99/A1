"""The "How it works" panel has to stay true.

It is the only documentation most people will ever read, and a confidently
wrong explanation is worse than none: it teaches you to expect behaviour the
program does not have, and then the program looks broken.

Prose cannot be tested. What CAN be tested is that the specific, checkable
claims it makes still describe the code -- the status words the doctor
actually emits, the units that actually exist, the retention window, the
places it promises an unticked unit is never used. Each assertion below fails
loudly enough to say which sentence has gone stale.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import yaml  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
PAGE = (REPO / "magi.html").read_text(encoding="utf-8")


def _panel() -> str:
    """The HOW array only -- claims elsewhere in the file are not this test's."""
    start = PAGE.index("const HOW = [")
    end = PAGE.index("let _howOpen", start)
    return PAGE[start:end]


HOW = _panel()


def test_the_panel_exists_and_is_reachable_from_both_headers():
    """A help panel only in the sidebar is help you must already know to find.

    On a phone the sidebar is a shut drawer.
    """
    assert 'id="helpBtn"' in PAGE and 'id="helpBtnM"' in PAGE
    assert '"helpBtn", "helpBtnM"' in PAGE
    assert "b.onclick = openHow" in PAGE


def test_the_background_is_frozen_while_it_is_open():
    """Asked for explicitly: no scrolling and no interacting behind the panel.

    `overflow: hidden` on the root is not enough on iOS, which scrolls the
    nearest scrollable ancestor anyway -- and .page IS that ancestor here.
    """
    assert "modal-open" in PAGE
    assert "html.modal-open .page" in PAGE
    assert "backdrop-filter: blur" in PAGE


def test_the_retention_window_is_not_typed_out():
    """A number written twice is a number that will disagree with itself."""
    assert "__DAYS__" in HOW, "the history section should interpolate HISTORY_DAYS"
    assert re.search(r"const HISTORY_DAYS = \d+", PAGE)
    # ...and nowhere in the panel is a day count spelled out by hand.
    assert not re.search(r"\b\d+ days\b", HOW.replace("__DAYS__ days", "")), (
        "spell the retention window as __DAYS__, not as a literal"
    )


def test_the_doctor_status_words_are_the_ones_the_doctor_emits():
    """The panel teaches four labels. The table must still show those four."""
    for label in ("OK", "FALLBACK", "MISS", "n/a"):
        assert f">{label}<" in HOW or f"<b>{label}</b>" in HOW or f'"{label}"' in HOW, label
        assert f'"{label}"' in PAGE, f"renderDoctor no longer emits {label}"


def test_every_unit_the_panel_names_still_exists():
    """Naming a model MAGI cannot drive is the most embarrassing kind of stale."""
    sites = yaml.safe_load(
        (REPO / "magi" / "config" / "selectors.yaml").read_text(encoding="utf-8")
    )["sites"]
    names = {s.get("display_name", sid) for sid, s in sites.items()}
    # Substring, not equality: a display name may qualify the account it is
    # signed in to ("Claude (free)", "Claude (Pro)") and that is still Claude.
    # Exact matching read those as Claude being unconfigured, which is the
    # opposite of true and would have had someone deleting it from the panel.
    def configured(model: str) -> bool:
        return any(model in n for n in names)

    for claimed in ("ChatGPT", "Claude", "Gemini", "DeepSeek"):
        assert configured(claimed) == (claimed in HOW), (
            f"{claimed} is named in the panel but not configured, or vice versa"
        )


def test_the_selectors_file_it_points_you_at_is_where_it_says():
    assert "magi/config/selectors.yaml" in HOW
    assert (REPO / "magi" / "config" / "selectors.yaml").exists()


def test_it_does_not_promise_a_chairman_pass_for_a_single_unit():
    """The panel says SOLE UNIT and "no chairman pass". Both must hold."""
    assert "SOLE UNIT" in HOW
    assert "SOLE UNIT" in PAGE, "updateCore no longer renders SOLE UNIT"
    orch = (REPO / "magi" / "engine" / "orchestrator.py").read_text(encoding="utf-8")
    assert "elif len(responded) == 1:" in orch, (
        "the single-unit short circuit is gone; the panel still promises it"
    )


def test_it_promises_the_doctor_runs_in_parallel_and_scoped():
    assert "in parallel" in HOW
    app = (REPO / "magi" / "app.py").read_text(encoding="utf-8")
    doctor = app[app.index('@app.post("/api/doctor")'):]
    doctor = doctor[: doctor.index("# ── the UI")]
    assert "asyncio.gather" in doctor, "the doctor is sequential again"
    assert "providers.split" in doctor, "the doctor no longer takes a selection"


def test_it_promises_refine_respects_the_gemini_tick_box():
    """The specific claim: unticking Gemini stops the API refiner too."""
    assert "Gemini API key" in HOW
    app = (REPO / "magi" / "app.py").read_text(encoding="utf-8")
    assert "API_PROVIDER_UNIT" in app
    assert "def _refiner_id(allowed" in app


def test_it_promises_nothing_is_written_mid_run():
    """One finished deliberation is one write -- the whole sync budget rests
    on this, and the panel states it as a fact."""
    assert "while a run is in flight" in HOW
    # cloudPushRun is called from the SSE `done` handler and from backfill, and
    # from nowhere that runs per frame.
    assert PAGE.count("cloudPushRun(") <= 4, (
        "cloudPushRun has new callers; check none of them fire during a run"
    )


def test_the_code_mode_write_claims_still_hold():
    """Write mode's paragraph makes promises about safety. Each is checked
    against the code that keeps it, so the panel cannot drift into claiming a
    protection that no longer exists."""
    from magi.code import security, tasks
    assert "Read or Write, per task" in HOW
    assert "__APPROVE_MIN__" in HOW, "spell the approval window as __APPROVE_MIN__"
    m = re.search(r"const APPROVE_MIN = (\d+);", PAGE)
    assert m and int(m.group(1)) * 60 == tasks.APPROVAL_TIMEOUT
    # "refused before you are asked" -- the deny-list the sentence names.
    for d in (".git", ".ssh", ".claude", ".codex"):
        assert d in security._DENY_DIRS, d
    assert security.check_path(".env") and security.check_path("../x")
    # "A1 itself stays read-only" -- enforced by the engine, not only the switch.
    routes = (REPO / "magi" / "code" / "routes.py").read_text(encoding="utf-8")
    assert "read_only_project" in routes and "is_engine_repo" in routes
    # "Every task starts in Read".
    assert 'rw: "read",' in PAGE
    # "a window whose reset time has passed shows 0%".
    assert "function usageLive(u)" in PAGE
