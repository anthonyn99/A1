"""Background browsers stay out of the taskbar for the whole run (winhide)."""

from __future__ import annotations

import sys
import time

import pytest

from magi.browser import launcher, winhide


def test_exact_profile_match_never_takes_a_longer_name():
    t = r"c:\magi\profiles\tony\claude"
    assert launcher._names_profile(rf'chrome.exe --user-data-dir="{t}" --x', t)
    assert launcher._names_profile(rf"chrome.exe --user-data-dir={t} --x", t)
    assert launcher._names_profile(rf"chrome.exe --user-data-dir={t}", t)
    assert launcher._names_profile(rf"chrome.exe --user-data-dir={t}\ --x", t)
    assert not launcher._names_profile(rf"chrome.exe --user-data-dir={t}_pro --x", t)
    assert not launcher._names_profile(rf"chrome.exe --user-data-dir={t}2", t)


@pytest.mark.skipif(sys.platform != "win32", reason="the watcher only runs on Windows")
def test_keeper_keeps_hiding_windows_that_open_later(monkeypatch):
    """A frame that opens after launch (busy PC, new page, crash-restore) is
    still hidden: the watcher keeps looking until it is stopped."""
    reads, looks = [], []
    monkeypatch.setattr(winhide.KeepHidden, "TICK_S", 0.01)
    monkeypatch.setattr(winhide.KeepHidden, "EMPTY_REREAD_S", 0.01)

    def pids():
        reads.append(1)
        return [] if len(reads) < 3 else [7]  # Chrome starts on the third read

    monkeypatch.setattr(winhide, "hide_windows", lambda p: looks.append(p) or 1)
    keeper = winhide.KeepHidden(pids).start()
    time.sleep(0.3)
    keeper.stop()
    assert len(reads) == 3  # the slow list stops being read once known
    assert len(looks) > 5 and all(p == {7} for p in looks)  # and hiding never stops
    n = len(looks)
    time.sleep(0.05)
    assert len(looks) == n  # stopped means stopped
