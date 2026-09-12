"""The artifacts directory has a limit, and the limit is enforced.

`config/magi.yaml` has carried `artifacts: keep_last: 200` since the
beginning and nothing ever read it. Every failed attempt and every doctor
probe leaves a screenshot and a full DOM dump -- a Grok page is a megabyte of
HTML on its own -- so the directory reached 93MB in three days of ordinary
use, on the machine that also holds seven Chrome profiles.
"""

from __future__ import annotations

import sys
import time
import types
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from magi.providers.browser_base import BrowserProvider  # noqa: E402
from magi.settings import load_settings  # noqa: E402


def test_the_configured_limit_is_actually_read():
    s = load_settings()
    assert s.artifacts_keep_last == 200, (
        "keep_last is back to being decoration in the config file"
    )


def _write(d: Path, n: int) -> list[Path]:
    made = []
    for i in range(n):
        f = d / f"probe-{i:03d}.html"
        f.write_text("x", encoding="utf-8")
        # Distinct mtimes, oldest first, so "newest kept" is checkable.
        import os
        os.utime(f, (time.time() - (n - i), time.time() - (n - i)))
        made.append(f)
    return made


def test_only_the_newest_are_kept(tmp_path):
    made = _write(tmp_path, 12)
    fake = types.SimpleNamespace(
        settings=types.SimpleNamespace(artifacts_keep_last=5))
    BrowserProvider._prune_artifacts(fake, tmp_path)
    left = {f.name for f in tmp_path.iterdir()}
    assert left == {f.name for f in made[-5:]}, "the wrong five survived"


def test_zero_means_keep_everything(tmp_path):
    """A limit of 0 is "unlimited", not "delete the lot" -- the reading that
    silently destroys every artifact must not be the one it takes."""
    _write(tmp_path, 4)
    fake = types.SimpleNamespace(
        settings=types.SimpleNamespace(artifacts_keep_last=0))
    BrowserProvider._prune_artifacts(fake, tmp_path)
    assert len(list(tmp_path.iterdir())) == 4


def test_pruning_never_breaks_the_run(tmp_path):
    """It runs inside a failure path; it cannot become a second failure."""
    fake = types.SimpleNamespace(settings=types.SimpleNamespace())  # no field
    BrowserProvider._prune_artifacts(fake, tmp_path / "does-not-exist")
