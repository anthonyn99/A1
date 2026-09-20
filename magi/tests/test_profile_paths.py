"""Profiles: the directory split, and the one-time migration into it.

An engine serves one person. Tony's drives Tony's logged-in Chrome sessions
and writes Tony's history; Veda's drives hers. Everything that separation is
made of is a path, so this file is about paths.

The migration is the dangerous part. It moves over a gigabyte of live Chrome
session data -- the saved logins for every unit -- and if it moved the wrong
thing, or moved it twice, or overwrote a real profile with an empty one, the
symptom is every account signed out at once with no way back short of logging
in to all of them by hand. So it is exercised here against a synthetic tree
before it is ever pointed at the real one.
"""

from __future__ import annotations

import json

import pytest

from magi import settings as S


@pytest.fixture(autouse=True)
def _restore_profile():
    before = S.active_profile()
    yield
    S.set_active_profile(before)


@pytest.fixture
def fake_root(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "ROOT", tmp_path)
    return tmp_path


# ── naming ────────────────────────────────────────────────────────────────

def test_a_profile_name_cannot_escape_the_magi_directory():
    # These become directory names. "../.." would write outside MAGI entirely.
    for bad in ("../..", "a/b", "a\\b", "", " ", "x" * 33, "Tony Smith", "t;rm"):
        if bad.strip() == "":
            # Empty is "leave it alone", not an error -- it is what an unset
            # flag looks like by the time it reaches here.
            assert S.set_active_profile(bad) == S.active_profile()
            continue
        with pytest.raises(ValueError):
            S.set_active_profile(bad)


def test_a_profile_name_is_case_insensitive():
    S.set_active_profile("VEDA")
    assert S.active_profile() == "veda"


# ── precedence ────────────────────────────────────────────────────────────

def test_the_flag_beats_the_environment_beats_the_file(monkeypatch, tmp_path):
    cfg = tmp_path / "config"
    cfg.mkdir()
    (cfg / "magi.yaml").write_text("profile: veda\n", encoding="utf-8")

    # The file, on its own.
    monkeypatch.delenv("MAGI_PROFILE", raising=False)
    assert S.resolve_profile(None, config_dir=cfg) == "veda"

    # The environment beats the file.
    monkeypatch.setenv("MAGI_PROFILE", "tony")
    assert S.resolve_profile(None, config_dir=cfg) == "tony"

    # The flag beats both. It has to: two engines on one PC share one checkout
    # and therefore one magi.yaml, so if the file had the last word they could
    # never differ.
    assert S.resolve_profile("veda", config_dir=cfg) == "veda"


def test_no_config_at_all_still_resolves(tmp_path, monkeypatch):
    monkeypatch.delenv("MAGI_PROFILE", raising=False)
    assert S.resolve_profile(None, config_dir=tmp_path / "nope") == S.DEFAULT_PROFILE


# ── derived paths ─────────────────────────────────────────────────────────

def test_every_directory_moves_with_the_profile(fake_root):
    S.set_active_profile("tony")
    t_data, t_prof, t_art = S.data_dir(), S.profiles_dir(), S.artifacts_dir()
    S.set_active_profile("veda")
    v_data, v_prof, v_art = S.data_dir(), S.profiles_dir(), S.artifacts_dir()

    assert t_data != v_data and t_prof != v_prof and t_art != v_art
    assert t_data.name == "tony" and v_data.name == "veda"
    # And they are really created, not just named.
    for d in (t_data, t_prof, t_art, v_data, v_prof, v_art):
        assert d.is_dir()


def test_two_profiles_never_share_a_database(fake_root):
    S.set_active_profile("tony")
    tony_db = S._profile_path("data/magi.db")
    S.set_active_profile("veda")
    veda_db = S._profile_path("data/magi.db")
    assert tony_db != veda_db
    assert tony_db.parent.name == "tony" and veda_db.parent.name == "veda"


def test_a_sites_chrome_profile_is_per_person(fake_root):
    b = S.BrowserConfig()
    S.set_active_profile("tony")
    tony_claude = b.profile_dir("claude")
    S.set_active_profile("veda")
    veda_claude = b.profile_dir("claude")
    # The whole point: the same unit, signed in as two different people.
    assert tony_claude != veda_claude
    assert tony_claude.name == veda_claude.name == "claude"
    assert tony_claude.parent.name == "tony"
    assert veda_claude.parent.name == "veda"


# ── the migration ─────────────────────────────────────────────────────────

def _legacy_tree(root):
    """The layout as it was before profiles existed."""
    for site in ("chatgpt", "claude", "gemini", "deepseek"):
        d = root / "profiles" / site / "Default"
        d.mkdir(parents=True)
        (d / "Cookies").write_text(f"{site}-session", encoding="utf-8")
    (root / "data").mkdir()
    (root / "data" / "magi.db").write_text("RUNS", encoding="utf-8")
    (root / "data" / "magi.db-wal").write_text("WAL", encoding="utf-8")
    (root / "data" / "accounts.json").write_text("{}", encoding="utf-8")
    (root / "data" / "uploads").mkdir()
    (root / "artifacts").mkdir()
    (root / "artifacts" / "claude-health.png").write_text("PNG", encoding="utf-8")


def test_the_old_layout_becomes_tonys(fake_root):
    _legacy_tree(fake_root)
    moved = S.migrate_legacy_layout()

    # The sessions are the thing that must not be lost.
    ck = fake_root / "profiles" / "tony" / "claude" / "Default" / "Cookies"
    assert ck.read_text(encoding="utf-8") == "claude-session"
    # History, and the write-ahead log beside it -- moving the database without
    # its -wal is how you silently lose the most recent runs.
    assert (fake_root / "data" / "tony" / "magi.db").read_text(encoding="utf-8") == "RUNS"
    assert (fake_root / "data" / "tony" / "magi.db-wal").exists()
    assert (fake_root / "data" / "tony" / "accounts.json").exists()
    assert (fake_root / "data" / "tony" / "uploads").is_dir()
    assert (fake_root / "artifacts" / "tony" / "claude-health.png").exists()
    # Nothing left behind at the old level.
    assert not (fake_root / "profiles" / "claude").exists()
    assert not (fake_root / "data" / "magi.db").exists()
    assert moved


def test_running_it_twice_changes_nothing(fake_root):
    _legacy_tree(fake_root)
    S.migrate_legacy_layout()
    before = sorted(str(p.relative_to(fake_root)) for p in fake_root.rglob("*"))
    assert S.migrate_legacy_layout() == []
    after = sorted(str(p.relative_to(fake_root)) for p in fake_root.rglob("*"))
    assert before == after


def test_it_never_overwrites_a_profile_that_already_has_data(fake_root):
    """The case that would sign Tony out of everything.

    A half-migrated tree -- one site moved, the rest not -- must not have the
    moved one clobbered by the stale copy still sitting at the old level.
    """
    _legacy_tree(fake_root)
    good = fake_root / "profiles" / "tony" / "claude" / "Default"
    good.mkdir(parents=True)
    (good / "Cookies").write_text("THE-REAL-ONE", encoding="utf-8")

    S.migrate_legacy_layout()

    assert (good / "Cookies").read_text(encoding="utf-8") == "THE-REAL-ONE"
    # The loser is left where it was rather than deleted, so nothing is lost.
    assert (fake_root / "profiles" / "claude" / "Default" / "Cookies").exists()


def test_it_does_not_swallow_the_other_profile(fake_root):
    """profiles/veda is a PROFILE, not a site left over from the old layout."""
    _legacy_tree(fake_root)
    v = fake_root / "profiles" / "veda" / "claude"
    v.mkdir(parents=True)
    (v / "Cookies").write_text("vedas", encoding="utf-8")

    S.migrate_legacy_layout()

    assert (v / "Cookies").read_text(encoding="utf-8") == "vedas"
    assert not (fake_root / "profiles" / "tony" / "veda").exists()


def test_it_ignores_directories_that_are_not_sites(fake_root):
    """A stray folder under profiles/ is not a Chrome session; leave it."""
    _legacy_tree(fake_root)
    (fake_root / "profiles" / "notes").mkdir()
    S.migrate_legacy_layout()
    assert (fake_root / "profiles" / "notes").is_dir()


def test_a_fresh_machine_migrates_nothing(fake_root):
    assert S.migrate_legacy_layout() == []


def test_it_survives_a_locked_file(fake_root, monkeypatch):
    """A migration that raises must not stop the engine booting."""
    _legacy_tree(fake_root)

    def boom(self, target):
        raise PermissionError("file in use")

    monkeypatch.setattr("pathlib.Path.rename", boom)
    assert S.migrate_legacy_layout() == []      # reported, not raised


# ── engine identity ───────────────────────────────────────────────────────

def test_each_profile_gets_its_own_engine_identity(fake_root):
    from magi import ident

    S.set_active_profile("tony")
    a = ident.engine_identity()
    S.set_active_profile("veda")
    b = ident.engine_identity()

    assert a["id"] != b["id"]
    assert a["profile"] == "tony" and b["profile"] == "veda"


def test_an_engine_identity_survives_a_restart(fake_root):
    from magi import ident

    S.set_active_profile("tony")
    first = ident.engine_identity()["id"]
    # A second process reads the same file rather than minting a new id --
    # otherwise a console listing engines would grow a new entry every reboot.
    assert ident.engine_identity()["id"] == first
    assert json.loads((S.data_dir() / "engine.json").read_text())["id"] == first


def test_a_label_can_be_changed_without_losing_the_id(fake_root):
    from magi import ident

    S.set_active_profile("veda")
    before = ident.engine_identity()["id"]
    rec = ident.set_engine_label("Veda PC")
    assert rec["label"] == "Veda PC"
    assert rec["id"] == before


# ── scheduled tasks ───────────────────────────────────────────────────────

def test_tonys_scheduled_task_keeps_the_name_it_already_has():
    """He has these registered. Renaming would orphan the old pair."""
    from magi import watchdog
    from magi.cli import serve

    S.set_active_profile("tony")
    assert watchdog.task_engine() == "MAGI Engine"
    assert watchdog.task_watchdog() == "MAGI Watchdog"
    assert serve._task_args() == ""


def test_another_profile_gets_its_own_tasks_and_carries_the_flag():
    from magi import watchdog
    from magi.cli import serve

    S.set_active_profile("veda")
    assert watchdog.task_engine() == "MAGI Engine (veda)"
    assert watchdog.task_watchdog() == "MAGI Watchdog (veda)"
    # Without this the task would start the DEFAULT engine twice.
    assert serve._task_args() == " --profile veda"


def test_the_two_profiles_do_not_share_an_api_token():
    """magi-link keys records by the token's hash; one token, one record."""
    from magi.cli import onboard

    S.set_active_profile("tony")
    a = onboard._token_env_name()
    S.set_active_profile("veda")
    b = onboard._token_env_name()
    assert a != b
    assert a == "MAGI_API_TOKEN"          # unchanged for Tony


def test_the_two_profiles_do_not_share_a_port():
    from magi.cli import onboard

    assert onboard.PROFILE_PORTS["tony"] != onboard.PROFILE_PORTS["veda"]
