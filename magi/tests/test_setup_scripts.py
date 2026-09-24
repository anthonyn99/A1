"""The one-command install and the restart script keep their safety rules.

Both are PowerShell, proven by hand on a fresh clone (2026-09-24). What
went wrong in that first dry run is pinned here, so it cannot come back:
setup.ps1 onboarded the WRONG A1 (`python -m magi` imports from the current
directory), and restart.ps1 guessed port 8000 for a profile not set up
there, then killed whatever held it -- Tony's engine.
"""

from __future__ import annotations

from pathlib import Path

MAGI = Path(__file__).resolve().parents[1]
REPO = MAGI.parent
SETUP = (MAGI / "setup.ps1").read_text(encoding="utf-8")
RESTART = (MAGI / "restart.ps1").read_text(encoding="utf-8")


def test_setup_runs_from_its_own_a1():
    assert SETUP.index("Set-Location $root") < SETUP.index('"-m", "magi", "onboard"')


def test_setup_checks_the_engine_answers_as_the_profile():
    assert '$h.profile -ne $Who' in SETUP


def test_setup_looks_for_this_profiles_own_logon_task():
    assert '"MAGI Engine ($Who)"' in SETUP


def test_restart_never_guesses_a_port_for_someone_else():
    i = RESTART.index('} elseif ($Who -ne "tony") {')
    assert "exit 1" in RESTART[i:i + 400]


def test_restart_never_stops_another_profiles_engine():
    guard = RESTART.index('if ($h.profile -and $h.profile -ne $Who)')
    assert "exit 1" in RESTART[guard:guard + 300]
    assert guard < RESTART.index("Stop-Tree $c.OwningProcess"), "checked before anything is killed"


def test_restart_only_stops_engines_of_this_a1_and_profile():
    assert '$_.CommandLine -like "*$root\\magi\\.venv*"' in RESTART
    assert '--profile $Who\\b' in RESTART


def test_restart_starts_the_profile_on_its_port_with_its_token():
    assert '@("-m", "magi", "cloud", "--port", "$port") + $profileArgs' in RESTART
    assert '[Environment]::GetEnvironmentVariable($tokenName, "User")' in RESTART


def test_the_doc_claude_follows_runs_this_script():
    doc = (REPO / "docs" / "magi-setup.md").read_text(encoding="utf-8")
    assert r"magi\setup.ps1 -Profile veda" in doc
    assert "docs/magi-setup.md" in (REPO / "CLAUDE.md").read_text(encoding="utf-8")
