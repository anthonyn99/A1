#!/usr/bin/env bash
# Poll the DEFERRED deck for free until it generates, then verify the download
# path against it. Spends no quota: the already-queued deck is what finishes,
# so no new Generate is ever pressed.
cd "C:/Users/vedap/Desktop/A1/V1/tools/sos-browser"
NB="https://notebooklm.google.com/notebook/b031a334-129f-40c1-988d-7b1a242c5268"
for i in $(seq 1 14); do          # ~7h at 30min
  out=$(python check_queued.py "$NB" 2>/dev/null | tail -1)
  echo "[$(date +%H:%M)] $out"
  if echo "$out" | grep -q '"ready": true'; then
    echo "=== DECK READY — verifying download selectors ==="
    python verify_download.py "$NB" 2>&1 | tail -3
    exit 0
  fi
  if echo "$out" | grep -q '"failed": true'; then
    echo "=== generation failed on their side ==="; exit 1
  fi
  sleep 1800
done
echo "=== still queued after ~7h; stopping rather than spending ==="
