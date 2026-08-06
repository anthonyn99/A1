# TRADEBOARD — Trade Journal

**Auto-sync from Webull → your cloud TradeBoard, hands-off.** While your PC runs
the sync, your Webull trades + positions push straight into your Firebase cloud
(`tradeboard/veda`), so **every device updates live** — the hosted site
(https://tradeboard-6b2ea.web.app) and your phone included. No clicking, no
importing, no local server needed on the viewing device.

```
  Webull (official API keys)          [ your PC, every 2 min ]
      │
      ▼
  wb_server.py ──► wb_sync.py ──► wb_cloud.py ──► Firestore (tradeboard/veda)
  (or wb_sync.py                                        │
   one-shot)                                            ▼
                                     hosted site + phone + any device
                                     (tradeboard.html — auto-updates live)
```

- Your PC must be **on and running the sync** for updates to flow; when it's off,
  the last-synced data stays visible everywhere (nothing is lost).
- **Manual journal entries are never touched** — the cloud push replaces only the
  broker-tagged rows (mirror semantics), same as the in-app broker import.
- The local `broker_import.json` / `broker_positions.json` files are still written
  too, so the older local-served journal keeps working.

## Set it up (one time)

1. Get free **App Key + App Secret** at
   [developer.webull.com](https://developer.webull.com) → **API Management** →
   create an app.
2. Put them in `webull_config.json` (see Part 2 below).
3. Double-click **`Start Trade Journal.bat`** and leave it running. Done — open
   https://tradeboard-6b2ea.web.app on any device and watch it update.

---

## Part 1 — Just the journal (zero install)

1. Keep this folder somewhere permanent.
2. **Double-click `journal.html`.** That's the whole install — works offline.
3. First launch seeds 4 demo trades. Remove them: **⇄ Sync from broker → 4**.
4. Log trades with **＋ Log trade** (symbol, qty, entry required; blank exit =
   open trade). Close later via ✎. Stats + equity curve update instantly.
5. **Back up with Export JSON** — trades live in the browser's localStorage,
   not in the HTML file. Export regularly; Import JSON restores anywhere.

## Part 2 — Hook it to Webull (one-time setup)

1. **Get API keys** (free, official): log in at
   [developer.webull.com](https://developer.webull.com) → **API Management** →
   create an app → copy the **App Key** and **App Secret**.
   (Approval of API access can take a little time on Webull's side.)
2. **Double-click `Start Trade Journal.bat`.** On first run it:
   - installs the official SDK (`webull-openapi-python-sdk`) if needed,
   - creates `webull_config.json` and opens it in Notepad.
3. **Paste your App Key + App Secret** into `webull_config.json`, save:
   ```json
   {
     "app_key":    "xxxxxxxx",
     "app_secret": "xxxxxxxx",
     "region_id":  "us",
     "history_start": "2026-01-01"
   }
   ```
   `history_start` = how far back to import trades.
   Optional: `"account_id"` if you have several accounts (the sync prints the
   list on first run), `"endpoint"` to use Webull's sandbox.
4. **Double-click `Start Trade Journal.bat` again.** It connects, syncs, and
   opens the journal at `http://localhost:8787` with a green **● live** pill.
   Leave the window open; close it to stop.

That's it — trades and live positions refresh every 2 minutes with no clicking.
Because Webull uses real API keys there is **no daily re-login** (unlike
session-based brokers).

## Daily use with sync running

- New fills appear automatically (tagged `webull`; options also get `option`).
- The **Live positions** strip shows holdings, unrealized P&L, and equity.
- Broker rows **mirror** the sync file — corrected data replaces stale rows
  automatically, and nothing ever duplicates. Your hand-entered trades are
  never touched by the sync.
- Manual sync without the server: `python wb_sync.py`, then
  **⇄ Sync from broker → 1** in the journal.

## The ⇄ Sync from broker menu

| Option | What it does |
|---|---|
| 1 | Import trades from `broker_import.json` (replaces broker rows, keeps manual) |
| 2 | Load live positions from `broker_positions.json` |
| 3 | Remove all broker-imported trades (keeps manual) |
| 4 | Remove all manual trades (keeps broker) |

## Files

| File | Purpose |
|---|---|
| `journal.html` | The journal app (open directly, or via the server) |
| `hub.html` | Program hub — add the journal via ＋ Add program (icon 📓) |
| `wb_sync.py` | One-shot Webull → JSON sync (read-only) + pushes to cloud |
| `wb_cloud.py` | Pushes each sync into Firestore so every device updates live |
| `wb_server.py` | Auto-sync server: syncs every 2 min + serves the journal |
| `Start Trade Journal.bat` | One-click launcher (also on your Desktop as "Trade Journal") |
| `webull_config.json` | Your API keys — **keep private, don't share/commit** |
| `broker_import.json` | Latest synced trades (regenerated every sync) |
| `broker_positions.json` | Latest synced positions + equity |
| `webull_raw_sample.json` | Debug: first raw order/position from the last sync |

## How trades are built (what the sync does)

- Every **filled** order becomes a fill; fills pair **FIFO per instrument**
  into round-trips (buy→sell = long, sell→buy = short — Webull margin shorts
  are supported).
- Round-trips sharing the same symbol+side+exit-date **merge into one row**
  (weighted-average entry, summed qty/fees) so one real exit = one row.
- **Options** pair per exact contract (`AAPL 2026-08-15 C 200`) with the ×100
  multiplier baked into quantity, so P&L is in real dollars.
- Guard rails: fractional dust never fabricates trades, and a tiny sell with
  no matching buy (transferred/reward shares) is skipped, not turned into a
  phantom short.

## Troubleshooting

- **Pill says `auth` / console says UNAUTHORIZED** — your keys are wrong,
  revoked, or the app isn't approved for the Trade API yet. Fix them in
  `webull_config.json`, restart the launcher.
- **A number looks wrong after the first real sync** — open
  `webull_raw_sample.json`, find the real field name Webull used, and adjust
  the candidate lists in `wb_sync.py` (`_pick(...)` calls). The parsers accept
  multiple known field spellings, but Webull's docs don't publish all of them.
- **Port 8787 busy** — another copy of the server is already running; close it.
- **Journal empty in a different browser** — data is per-browser localStorage.
  Export JSON in one, Import in the other.

## Security notes

- The sync is **read-only**: it can query orders/positions/balance and never
  places, modifies, or cancels anything.
- `webull_config.json` holds your API keys in plain text on your own machine.
  Anyone with the file can read your account data (not trade with these
  scripts, but treat it like a password). You can revoke/rotate keys any time
  in Webull's API Management.
