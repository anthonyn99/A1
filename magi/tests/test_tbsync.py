"""TradeBoard's Webull sync follows pushed code with no restart by hand (magi/tbsync.py)."""
import os
import time

from magi import tbsync


def _folder(tmp_path, age_s):
    d = tmp_path / "TradeBoard"
    d.mkdir()
    for n in ("wb_sync.py", "wb_boot.py", "wb_server.py"):
        f = d / n
        f.write_text("# x")
        t = time.time() - age_s
        os.utime(f, (t, t))
    return d


def _run(procs, now=None):
    killed, started = [], []
    note = tbsync.tick(now=now or time.time(), procs=procs,
                       kill=killed.append, start=lambda folder, exe: started.append((folder, exe)))
    return note, killed, started


def test_a_sync_started_before_the_code_changed_is_restarted(tmp_path):
    d = _folder(tmp_path, age_s=300)
    p = {"pid": 42, "cmd": f'"C:\\Python\\pythonw.exe" "{d / "wb_boot.py"}"', "exe": "C:\\Python\\pythonw.exe", "start": time.time() - 3600}
    note, killed, started = _run([p])
    assert killed == [42] and started == [(d, "C:\\Python\\pythonw.exe")] and "restarted" in note


def test_the_old_launcher_is_replaced_by_the_headless_sync(tmp_path):
    d = _folder(tmp_path, age_s=300)
    p = {"pid": 7, "cmd": f'python {d / "wb_server.py"}', "exe": None, "start": time.time() - 3600}
    note, killed, started = _run([p])
    assert killed == [7] and started and started[0][0] == d


def test_a_sync_already_on_the_new_code_is_left_alone(tmp_path):
    d = _folder(tmp_path, age_s=3600)
    p = {"pid": 1, "cmd": f'pythonw {d / "wb_boot.py"}', "start": time.time() - 60}
    assert _run([p]) == ("", [], [])


def test_nothing_while_the_code_is_still_changing(tmp_path):
    d = _folder(tmp_path, age_s=10)          # pulled 10 s ago: wait for it to settle
    p = {"pid": 1, "cmd": f'pythonw {d / "wb_boot.py"}', "start": time.time() - 3600}
    assert _run([p]) == ("", [], [])


def test_nothing_on_a_pc_without_the_sync():
    assert _run([]) == ("", [], [])


def test_the_real_process_query_runs():
    # On a PC with no sync running it finds none; it must never raise.
    assert isinstance(tbsync._procs() if os.name == "nt" else [], list)
