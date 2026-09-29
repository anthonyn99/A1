"""MAGI's disk sweep follows cleanup-rules.json, and fails closed.

The rules file is shared with the browser sweeper, so these run the real
sweep.run() against a fake magi/ folder with a rules file written per test.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from magi import settings as S  # noqa: E402
from magi import sweep  # noqa: E402

NOW = time.time()


def _item(**kw):
    base = {"id": "shots", "store": "disk", "program": "magi", "category": "failed",
            "capDays": 7, "glob": "artifacts/{profile}/*.png", "owner": "t", "reason": "t",
            "delete": True}
    base.update(kw)
    return base


@pytest.fixture
def fake(tmp_path, monkeypatch):
    root = tmp_path / "magi"
    (root / "artifacts" / "tony").mkdir(parents=True)
    (root / "data" / "tony").mkdir(parents=True)
    monkeypatch.setattr(S, "ROOT", root)
    monkeypatch.setattr(S, "_active_profile", "tony")

    def rules(*items):
        (tmp_path / "cleanup-rules.json").write_text(
            json.dumps({"version": 1, "items": list(items)}), encoding="utf-8")
    return root, rules


def _file(p: Path, days_old: float, body: str = "x") -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body, encoding="utf-8")
    t = NOW - days_old * 86400
    os.utime(p, (t, t))
    return p


def test_only_files_past_their_age_go(fake):
    root, rules = fake
    rules(_item())
    old = _file(root / "artifacts/tony/a-old.png", 8)
    new = _file(root / "artifacts/tony/a-new.png", 2)
    rep = sweep.run(now=NOW)
    assert not old.exists() and new.exists()
    assert len(rep["deleted"]) == 1


def test_delete_false_is_a_dry_run(fake):
    root, rules = fake
    rules(_item(delete=False))
    old = _file(root / "artifacts/tony/a-old.png", 30)
    rep = sweep.run(now=NOW)
    assert old.exists()
    assert rep["would_delete"] and not rep["deleted"]


def test_once_a_day_unless_forced(fake):
    root, rules = fake
    rules(_item())
    sweep.run(now=NOW)
    old = _file(root / "artifacts/tony/late.png", 9)
    assert sweep.run(now=NOW) == {"skipped": "already swept today"}
    assert old.exists()
    sweep.run(force=True, now=NOW)
    assert not old.exists()


@pytest.mark.parametrize("bad", [
    _item(glob="profiles/tony/*"),              # outside artifacts/ and data/
    _item(glob="data/../../x"),
    _item(test="rm-rf"),                        # a test this code does not know
    _item(capDays=0),
    _item(store="kv"),
])
def test_unexpected_rules_delete_nothing(fake, bad):
    root, rules = fake
    ok = _file(root / "artifacts/tony/keep.png", 30)
    rules(_item(), bad)
    rep = sweep.run(now=NOW)
    assert ok.exists(), "a bad rule must stop the whole run, the good rules too"
    assert rep["error"]


def test_missing_rules_file_deletes_nothing(fake):
    root, _ = fake
    ok = _file(root / "artifacts/tony/keep.png", 30)
    rep = sweep.run(now=NOW)
    assert ok.exists() and rep["error"]


def test_never_the_database_or_uploads(fake):
    root, rules = fake
    rules(_item(glob="data/**/*", capDays=1))
    db = _file(root / "data/tony/magi.db", 90)
    up = _file(root / "data/tony/uploads/r1/a.jpg", 90)
    sweep.run(now=NOW)
    assert db.exists() and up.exists()


def test_tts_orphans_and_empty_files(fake):
    root, rules = fake
    rules(_item(id="orph", glob="data/{profile}/tts/*.mp3", capDays=1, test="no-sibling:.words.json"),
          _item(id="empty", glob="artifacts/{profile}/*", capDays=1, test="zero-bytes"))
    orphan = _file(root / "data/tony/tts/aaa.mp3", 3)
    paired = _file(root / "data/tony/tts/bbb.mp3", 3)
    _file(root / "data/tony/tts/bbb.words.json", 3)
    empty = _file(root / "artifacts/tony/e.png", 3, body="")
    full = _file(root / "artifacts/tony/f.png", 3)
    sweep.run(now=NOW)
    assert not orphan.exists() and paired.exists()
    assert not empty.exists() and full.exists()


def test_the_real_rules_file_loads():
    items = sweep.load_rules(REPO / "cleanup-rules.json")
    assert {i["id"] for i in items} >= {"magi-screenshots", "magi-dom-dumps"}
    shots = next(i for i in items if i["id"] == "magi-screenshots")
    assert shots["capDays"] == 7
