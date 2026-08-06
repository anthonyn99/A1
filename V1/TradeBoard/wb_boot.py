#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════════
 wb_boot.py — headless auto-start entry for the Webull → TradeBoard sync
═══════════════════════════════════════════════════════════════════════════
 Same background sync as wb_server.py, but meant to be launched by Windows
 Task Scheduler at boot/logon and run silently (via pythonw.exe, no window,
 no browser pop-up). It does NOT open a browser and does NOT serve the local
 page — the hosted site (https://tradeboard-6b2ea.web.app) is what you open;
 this process just keeps the cloud fed with fresh Webull data.

 It reuses wb_server's sync loop so behavior (interval, backoff, auth-error
 handling, cloud push) stays identical to the double-click launcher.

 Logs to  wb_boot.log  next to this file so you can see it working even with
 no console. Stop it via Task Scheduler (End / Disable the task) or Task
 Manager (kill the pythonw.exe running this).

 READ-ONLY toward Webull.
═══════════════════════════════════════════════════════════════════════════
"""

import os
import sys
import threading
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Send stdout/stderr to a log file since there's no console under pythonw.
_LOG = os.path.join(HERE, "wb_boot.log")
try:
    _fh = open(_LOG, "a", encoding="utf-8", buffering=1)
    sys.stdout = _fh
    sys.stderr = _fh
except Exception:
    pass

print(f"\n[{datetime.now().isoformat(timespec='seconds')}] wb_boot starting…")

import wb_server  # reuses its sync_loop + status
import wb_sync


def main():
    cfg = wb_sync.load_config()
    trade = wb_sync.connect(cfg)

    # One immediate sync so data is fresh right after boot.
    try:
        n_t, n_p = wb_sync.sync(trade=trade, cfg=cfg)
        wb_server._set_status(
            last_sync=datetime.now(timezone.utc).isoformat(),
            trades=n_t, positions=n_p,
        )
        print(f"[{datetime.now().strftime('%H:%M:%S')}] first sync: {n_t} trades, {n_p} positions")
    except Exception as e:  # noqa: BLE001
        print(f"[{datetime.now().strftime('%H:%M:%S')}] first sync failed ({e}); loop will retry.")

    # Then the same forever-loop wb_server uses (every WEBULL_SYNC_INTERVAL secs).
    t = threading.Thread(target=wb_server.sync_loop, args=(trade, cfg), daemon=True)
    t.start()

    # Keep the process alive; the daemon thread does the work.
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"[{datetime.now().isoformat(timespec='seconds')}] wb_boot crashed: {e}")
        raise
