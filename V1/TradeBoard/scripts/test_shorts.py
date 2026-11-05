"""Short trades through Veda's Webull sync (wb_sync.normalize_order + pair_fifo).

Webull marks a short sale side SHORT and its cover a plain BUY. Before
2026-11-05 normalize_order dropped every SHORT order, so the cover opened a
phantom long. Run: python TradeBoard/scripts/test_shorts.py (from V1).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import wb_sync  # noqa: E402

# Tony's real 11/5/26 orders, in Webull's OpenAPI shape.
RAW = [
    ("WDC", "2026-11-05T15:49:21Z", "SHORT", 271.32, 0.01),
    ("SNDK", "2026-11-05T15:52:57Z", "SHORT", 812.17, 0.02),
    ("SNDK", "2026-11-05T15:54:41Z", "BUY", 825.00, 0),
    ("WDC", "2026-11-05T15:55:27Z", "BUY", 268.48, 0),
    ("SNDK", "2026-11-05T16:01:46Z", "SHORT", 822.36, 0.02),
    ("SNDK", "2026-11-05T16:02:55Z", "BUY", 826.18, 0),
    ("PLTR", "2026-11-05T16:10:00Z", "SELL_SHORT", 160.00, 0),
    ("PLTR", "2026-11-05T16:20:00Z", "BUY_TO_COVER", 158.00, 0),
]
orders = [{"status": "FILLED", "symbol": s, "side": side, "filled_qty": 1,
           "avg_filled_price": px, "filled_time": ts, "fees": fee}
          for s, ts, side, px, fee in RAW]

fails = 0


def ok(name, cond, detail=""):
    global fails
    print(("  ✓ " if cond else "  ✗ FAIL: ") + name + ("" if cond else f"\n      {detail}"))
    fails += 0 if cond else 1


fills = sorted((f for f in map(wb_sync.normalize_order, orders) if f), key=lambda f: f["ts"])
ok("every SHORT order becomes a fill", len(fills) == len(RAW), [f["side"] for f in fills])
trades = wb_sync.pair_fifo(fills)
by = {}
for t in trades:
    by.setdefault(t["symbol"], []).append(t)

ok("no open positions left", all(t["exit"] is not None for t in trades), trades)
ok("every trade is a short", all(t["side"] == "short" for t in trades), [t["side"] for t in trades])
w = by.get("WDC", [{}])[0]
ok("WDC: short 271.32, covered 268.48", w.get("entry") == 271.32 and w.get("exit") == 268.48, w)
s = by.get("SNDK", [])
# Same-day round trips on one symbol merge into one row (_merge_roundtrips).
ok("SNDK: both shorts land (2 shares)", sum(t["qty"] for t in s) == 2, s)
ok("PLTR: SELL_SHORT / BUY_TO_COVER pair as a short", len(by.get("PLTR", [])) == 1, by.get("PLTR"))

print("\n" + ("all passed" if not fails else f"{fails} failed"))
sys.exit(1 if fails else 0)
