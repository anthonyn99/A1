"""Phase 13: Code Mode state between the engine and Firestore.

The engine half only: GET/PUT /api/code/sync against a real SQLite database
in tmp_path. The console half (the one listener, the debounced write, the
write counts) is tests/magi-code-sync.test.js and tests/live/magi-sync.live.js.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from magi.code import autocommit as AC
from magi.code import routes as RT
from magi.code import sync as S
from magi.db import Database

A1 = Path(__file__).resolve().parents[2]
ENG = {"id": "eng_desk", "label": "Tony PC", "profile": "tony", "port": 8000}


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def db(tmp_path, monkeypatch):
    d = Database(tmp_path / "magi.db")
    run(d.init())
    monkeypatch.setattr(RT, "_db", lambda: d)
    monkeypatch.setattr(RT.ident, "engine_identity", lambda: dict(ENG))
    AC.PENDING.clear()
    return d


def mk(db, name="Proj", prefs=None, pid=None, root=None):
    body = {"name": name, "prefs": prefs or {}}
    if pid:
        body["id"] = pid
    if root:
        body["root"] = str(root)
    d = run(RT.create_project(body))
    assert d["ok"], d
    return d["project"]


# ── what leaves the engine ────────────────────────────────────────────────

def test_the_view_never_carries_a_path(db, tmp_path):
    folder = tmp_path / "work"
    folder.mkdir()
    mk(db, "Work", root=folder, pid="proj_w")
    v = run(RT.sync_state())
    assert v["ok"]
    blob = repr(v)
    assert str(tmp_path) not in blob and str(tmp_path).replace("\\", "\\\\") not in blob
    assert "root" not in blob
    p = v["projects"]["proj_w"]
    assert p["bindings"] == {"eng_desk": {"label": "Tony PC"}}
    assert set(p) == {"name", "aliases", "prefs", "notes", "updatedAt", "bindings"}


def test_an_unbound_project_claims_no_engine(db):
    mk(db, "Floating", pid="proj_f")
    assert run(RT.sync_state())["projects"]["proj_f"]["bindings"] == {}


def test_rev_moves_on_every_change_that_syncs(db, tmp_path):
    r0 = run(RT.sync_state())["rev"]
    mk(db, "One", pid="proj_1")
    r1 = run(RT.sync_state())["rev"]
    assert r1 > r0
    run(RT.set_prefs("proj_1", {"prefs": {"commitStyle": "short"}}))
    r2 = run(RT.sync_state())["rev"]
    assert r2 > r1
    f = tmp_path / "b"
    f.mkdir()
    run(RT.bind_project("proj_1", {"root": str(f)}))
    r3 = run(RT.sync_state())["rev"]
    assert r3 > r2
    run(RT.delete_project("proj_1"))
    assert run(RT.sync_state())["rev"] > r3


def test_opening_a_project_does_not_move_rev(db, tmp_path):
    f = tmp_path / "b"
    f.mkdir()
    mk(db, "One", pid="proj_1", root=f)
    r = run(RT.sync_state())["rev"]
    run(db.touch_code_binding("proj_1", "eng_desk"))
    assert run(RT.sync_state())["rev"] == r


def test_state_carries_rev_too(db):
    mk(db, "One", pid="proj_1")
    assert run(RT.code_state())["rev"] == run(RT.sync_state())["rev"]


# ── what comes in ─────────────────────────────────────────────────────────

LATER = "2099-01-01T00:00:00+00:00"
EARLIER = "2000-01-01T00:00:00+00:00"


def test_a_newer_cloud_copy_wins_and_keeps_its_time(db):
    mk(db, "Old name", pid="proj_1")
    d = run(RT.sync_apply({"projects": {"proj_1": {
        "name": "New name", "aliases": ["nn"], "prefs": {"commitStyle": "short"},
        "notes": "hi", "updatedAt": LATER}}}))
    p = d["projects"]["proj_1"]
    assert p["name"] == "New name" and p["aliases"] == ["nn"] and p["notes"] == "hi"
    assert p["prefs"]["commitStyle"] == "short"
    # Stored WITH the cloud's time: the next exchange compares equal.
    assert S.ts(p["updatedAt"]) == S.ts(LATER)


def test_an_older_cloud_copy_changes_nothing(db):
    mk(db, "Mine", pid="proj_1")
    before = run(RT.sync_state())
    d = run(RT.sync_apply({"projects": {"proj_1": {"name": "Stale", "updatedAt": EARLIER}}}))
    assert d["projects"]["proj_1"]["name"] == "Mine"
    assert d["rev"] == before["rev"]
    assert d["applied"] == {"save": 0, "delete": 0, "tomb": 0}


def test_a_tie_is_a_no_op(db):
    mk(db, "Mine", pid="proj_1")
    at = run(RT.sync_state())["projects"]["proj_1"]["updatedAt"]
    d = run(RT.sync_apply({"projects": {"proj_1": {"name": "Other", "updatedAt": at}}}))
    assert d["projects"]["proj_1"]["name"] == "Mine"


def test_a_project_only_the_cloud_knows_arrives_unbound(db):
    d = run(RT.sync_apply({"projects": {"proj_new": {
        "name": "From the laptop", "prefs": {}, "updatedAt": LATER,
        "bindings": {"eng_laptop": {"label": "Laptop"}}}}}))
    p = d["projects"]["proj_new"]
    assert p["name"] == "From the laptop"
    # The laptop's binding is not this engine's to claim.
    assert p["bindings"] == {}
    st = run(RT.code_state())
    assert [b for b in st["projects"][0]["bindings"]] == []


def test_a_synced_doc_cannot_turn_on_auto_commit_for_a1(db):
    run(db.save_code_project({"id": "proj_a1", "name": "A1", "aliases": "[]",
                              "prefs": "{}", "notes": ""}, updated_at=EARLIER))
    run(db.save_code_binding("proj_a1", "eng_desk", str(A1)))
    d = run(RT.sync_apply({"projects": {"proj_a1": {
        "name": "A1", "prefs": {"autoCommit": True, "autoPush": True},
        "updatedAt": LATER}}}))
    prefs = d["projects"]["proj_a1"]["prefs"]
    assert prefs["autoCommit"] is False and prefs["autoPush"] is False


def test_binding_later_regards_prefs_that_arrived_unbound(db, monkeypatch, tmp_path):
    run(RT.sync_apply({"projects": {"proj_x": {
        "name": "X", "prefs": {"autoCommit": True, "autoPush": True}, "updatedAt": LATER}}}))
    assert run(RT.sync_state())["projects"]["proj_x"]["prefs"]["autoCommit"] is True
    folder = tmp_path / "x"
    folder.mkdir()
    # Pretend this folder is MAGI's own repository.
    monkeypatch.setattr(AC, "_engine_repo", lambda root: True)
    d = run(RT.bind_project("proj_x", {"root": str(folder)}))
    assert d["project"]["prefs"]["autoCommit"] is False
    assert d["project"]["prefs"]["autoPush"] is False


def test_stray_and_mistyped_prefs_are_dropped(db):
    d = run(RT.sync_apply({"projects": {"proj_1": {
        "name": "P", "updatedAt": LATER,
        "prefs": {"evil": "rm -rf", "batchWindowMin": "5", "autoCommit": "yes",
                  "github": "octo", "permissionMode": 7}}}}))
    prefs = d["projects"]["proj_1"]["prefs"]
    assert "evil" not in prefs
    assert prefs["batchWindowMin"] == 3          # the string was ignored
    assert prefs["autoCommit"] is False          # "yes" is not a bool
    assert prefs["github"] == "octo"
    assert prefs["permissionMode"] == "plan"


def test_a_bad_name_or_time_is_skipped_not_fatal(db):
    d = run(RT.sync_apply({"projects": {
        "proj_a": {"name": "", "updatedAt": LATER},
        "proj_b": {"name": "B", "updatedAt": "not a time"},
        "proj_c": "garbage",
        "proj_d": {"name": "D", "updatedAt": LATER}}}))
    assert set(d["projects"]) == {"proj_d"}


# ── deletions ─────────────────────────────────────────────────────────────

def test_a_newer_deletion_removes_it_here(db):
    mk(db, "Doomed", pid="proj_1")
    d = run(RT.sync_apply({"deleted": {"proj_1": LATER}}))
    assert "proj_1" not in d["projects"]
    assert "proj_1" in d["deleted"]


def test_a_deletion_older_than_a_change_here_is_ignored(db):
    mk(db, "Renamed since", pid="proj_1")
    d = run(RT.sync_apply({"deleted": {"proj_1": EARLIER}}))
    assert "proj_1" in d["projects"]


def test_a_deleted_project_does_not_come_back_from_an_old_copy(db):
    mk(db, "Gone", pid="proj_1")
    run(RT.delete_project("proj_1"))
    v = run(RT.sync_state())
    assert "proj_1" in v["deleted"]
    d = run(RT.sync_apply({"projects": {"proj_1": {"name": "Gone", "updatedAt": EARLIER}}}))
    assert "proj_1" not in d["projects"]


def test_a_tombstone_for_a_project_never_held_here_is_kept(db):
    d = run(RT.sync_apply({"deleted": {"proj_z": LATER}}))
    assert d["deleted"]["proj_z"] == LATER
    # ...so a stale copy that arrives afterwards cannot create it.
    d = run(RT.sync_apply({"projects": {"proj_z": {"name": "Z", "updatedAt": EARLIER}}}))
    assert "proj_z" not in d["projects"]


def test_recreating_a_project_clears_its_tombstone(db):
    mk(db, "Again", pid="proj_1")
    run(RT.delete_project("proj_1"))
    mk(db, "Again", pid="proj_1")
    assert "proj_1" not in run(RT.sync_state())["deleted"]


def test_a_deleted_project_cancels_its_pending_auto_commit(db, monkeypatch):
    mk(db, "P", pid="proj_1")
    seen = []
    monkeypatch.setattr(AC, "cancel", lambda pid: seen.append(pid))
    run(RT.sync_apply({"deleted": {"proj_1": LATER}}))
    assert "proj_1" in seen


# ── the round trip ───────────────────────────────────────────────────────

def test_applying_the_engines_own_view_changes_nothing(db, tmp_path):
    f = tmp_path / "w"
    f.mkdir()
    mk(db, "W", pid="proj_w", root=f, prefs={"commitStyle": "short"})
    v = run(RT.sync_state())
    d = run(RT.sync_apply({"projects": v["projects"], "deleted": v["deleted"]}))
    assert d["applied"] == {"save": 0, "delete": 0, "tomb": 0}
    assert d["rev"] == v["rev"]
