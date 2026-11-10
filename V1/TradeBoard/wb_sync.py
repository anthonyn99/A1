#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════════
 wb_sync.py — Webull → Trade Journal sync  (official OpenAPI)
═══════════════════════════════════════════════════════════════════════════
 Pulls your FILLED stock & option orders plus LIVE positions from Webull's
 official OpenAPI and writes the two JSON files journal.html imports:

   broker_import.json    — trades in the journal's exact format: fills paired
                           FIFO per instrument into round-trips, then merged
                           so one real exit = one row (not one row per lot).
                           Tagged "webull" (+"option" for contracts).
   broker_positions.json — live positions + account equity for the
                           "Live positions" strip.

 READ-ONLY: this script never places, modifies, or cancels orders.

 ── SETUP ──────────────────────────────────────────────────────────────────
 1.  pip install webull-openapi-python-sdk        (already done if you ran
                                                   the launcher once)
 2.  Get API keys: Webull app/site → your profile → "API Management"
     (developer.webull.com) → create an app → copy App Key + App Secret.
 3.  Put them in  webull_config.json  next to this script:
         {
           "app_key":    "your-app-key",
           "app_secret": "your-app-secret",
           "region_id":  "us",
           "history_start": "2026-01-01"
         }
     (or set env vars WEBULL_APP_KEY / WEBULL_APP_SECRET instead — those
      win over the file. Optional: WEBULL_REGION_ID, WEBULL_ACCOUNT_ID.)
 4.  python wb_sync.py

 ── FIELD-NAME NOTE (read if numbers ever look wrong) ──────────────────────
 The request side of this script is built against the real SDK (v2.0.x
 signatures, verified by introspection). Webull's response field names are
 parsed DEFENSIVELY — each value is looked up under every name Webull is
 known to use (e.g. filled_qty / filled_quantity). On every sync the first
 raw order + position are dumped to  webull_raw_sample.json ; if a value
 imports wrong, open that file, find the real field name, and add it to the
 candidate lists in `_pick` calls below.
═══════════════════════════════════════════════════════════════════════════
"""

import json
import os
import re
import sys
import time
from collections import defaultdict, deque
from datetime import date, datetime, timedelta, timezone

# Windows consoles default to cp1252, which can't print ✓ / → / ═.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "webull_config.json")
TRADES_OUT = os.path.join(HERE, "broker_import.json")
POSITIONS_OUT = os.path.join(HERE, "broker_positions.json")
RAW_SAMPLE_OUT = os.path.join(HERE, "webull_raw_sample.json")
ACTIVITY_CACHE = os.path.join(HERE, "broker_activity.json")   # cash activity, re-read every 10 min

BROKER_TAG = "webull"


def die(msg, code=1):
    print(f"\n✗ {msg}", file=sys.stderr)
    sys.exit(code)


try:
    from webull.core.client import ApiClient
    from webull.trade.trade_client import TradeClient
except ImportError:
    die(
        "The official Webull SDK isn't installed.\n"
        "  Run:  pip install webull-openapi-python-sdk\n"
        "Then run this script again."
    )


# ── config ───────────────────────────────────────────────────────────────────
def load_config():
    """Env vars win; webull_config.json fills the rest."""
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                cfg = json.load(fh)
        except Exception as e:  # noqa: BLE001
            die(f"webull_config.json is not valid JSON: {e}")

    app_key = os.environ.get("WEBULL_APP_KEY") or cfg.get("app_key")
    app_secret = os.environ.get("WEBULL_APP_SECRET") or cfg.get("app_secret")
    region = os.environ.get("WEBULL_REGION_ID") or cfg.get("region_id") or "us"
    account_id = os.environ.get("WEBULL_ACCOUNT_ID") or cfg.get("account_id")
    endpoint = os.environ.get("WEBULL_ENDPOINT") or cfg.get("endpoint")  # optional override
    history_start = cfg.get("history_start") or "2026-01-01"

    if not app_key or not app_secret or "your-app-key" in str(app_key):
        die(
            "No Webull API keys configured.\n"
            "  1. Webull → API Management (developer.webull.com) → create an app\n"
            "  2. Put app_key + app_secret in webull_config.json next to this script\n"
            f"     ({CONFIG_PATH})"
        )
    return {
        "app_key": app_key,
        "app_secret": app_secret,
        "region": region,
        "account_id": account_id,
        "endpoint": endpoint,
        "history_start": history_start,
    }


def connect(cfg):
    """Create the TradeClient. The SDK validates credentials on init."""
    print(f"Connecting to Webull ({cfg['region']})…")
    api_client = ApiClient(cfg["app_key"], cfg["app_secret"], cfg["region"])
    if cfg["endpoint"]:
        api_client.add_endpoint(cfg["region"], cfg["endpoint"])
    try:
        trade = TradeClient(api_client)
    except Exception as e:  # noqa: BLE001
        die(
            f"Webull rejected the connection: {e}\n"
            "  Check your app_key/app_secret in webull_config.json and that the\n"
            "  app is approved for the Trade API in Webull's API Management."
        )
    print("✓ Connected.\n")
    return trade


# ── response helpers ─────────────────────────────────────────────────────────
def _payload(response):
    """The SDK returns an HTTP response; unwrap to plain JSON."""
    if response is None:
        return None
    if hasattr(response, "json"):
        try:
            return response.json()
        except Exception:  # noqa: BLE001
            pass
    return response  # already a dict/list


def _rows(payload):
    """Webull list payloads are either a bare list or wrapped in a dict."""
    if payload is None:
        return []
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("items", "data", "orders", "positions", "list", "result"):
            v = payload.get(key)
            if isinstance(v, list):
                return v
        # single-object payload
        return [payload]
    return []


def _pick(d, names, default=None):
    """Return the first present, non-None value among candidate field names."""
    for n in names:
        if isinstance(d, dict) and d.get(n) is not None:
            return d[n]
    return default


def _f(x, default=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


# ── Webull rate-limiting ──────────────────────────────────────────────────────
# Webull throttles the OpenAPI aggressively (HTTP 429 TOO_MANY_REQUESTS). We
# space calls out and back off + retry on a 429 so a multi-window history walk
# doesn't trip the limiter. Tunable via env for slow/fast plans.
API_MIN_INTERVAL = float(os.environ.get("WEBULL_API_INTERVAL", "2.5"))  # seconds between calls
API_MAX_RETRIES = int(os.environ.get("WEBULL_API_RETRIES", "6"))
_last_call_at = [0.0]


def _is_rate_limit(err):
    s = str(err).lower()
    return "429" in s or "too_many_requests" in s or "too many requests" in s


def _api_call(fn, *args, **kwargs):
    """
    Call a Webull SDK method with a minimum inter-call gap and exponential
    backoff on rate-limit (429) responses. Non-429 errors propagate immediately.
    """
    gap = time.monotonic() - _last_call_at[0]
    if gap < API_MIN_INTERVAL:
        time.sleep(API_MIN_INTERVAL - gap)
    delay = 5.0
    for attempt in range(API_MAX_RETRIES + 1):
        try:
            resp = fn(*args, **kwargs)
            _last_call_at[0] = time.monotonic()
            return resp
        except Exception as e:  # noqa: BLE001
            if _is_rate_limit(e) and attempt < API_MAX_RETRIES:
                print(f"  (rate-limited by Webull; backing off {delay:.0f}s, "
                      f"retry {attempt + 1}/{API_MAX_RETRIES})")
                time.sleep(delay)
                delay = min(delay * 2, 30)
                continue
            _last_call_at[0] = time.monotonic()
            raise


def _iso_date(ts):
    """'2026-07-06T14:33:02Z' / epoch-millis / '2026-07-06 14:33:02' → '2026-07-06'."""
    if ts is None:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if isinstance(ts, (int, float)):  # epoch (s or ms)
        secs = ts / 1000 if ts > 1e11 else ts
        return datetime.fromtimestamp(secs, tz=timezone.utc).strftime("%Y-%m-%d")
    return str(ts)[:10]


def _iso_ts(ts):
    """A fill time as ISO UTC ('2026-11-05T14:33:02Z'), for the Journal's time and
    minute-level hold (TradeHub parity, 2026-11-09). Epoch s/ms and ISO strings
    with a zone are converted; a zone-less string is passed through as Webull
    sent it (the page reads it as given); nothing usable → None."""
    if ts is None or ts == "":
        return None
    try:
        s = str(ts).strip()
        if isinstance(ts, (int, float)) or s.replace(".", "", 1).isdigit():
            v = float(s)
            secs = v / 1000 if v > 1e11 else v
            return datetime.fromtimestamp(secs, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if len(s) >= 16 and s[4] == "-" and s[7] == "-":
            s2 = s.replace(" ", "T", 1)
            tail = s2[19:]
            if s2.endswith("Z") or "+" in tail or "-" in tail:
                z = s2[:-1] + "+00:00" if s2.endswith("Z") else s2
                if len(z) >= 5 and z[-5] in "+-" and z[-3] != ":":
                    z = z[:-2] + ":" + z[-2:]          # +0000 → +00:00
                dt = datetime.fromisoformat(z)
                return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            return s2[:19]
    except Exception:
        return None
    return None


# ── accounts ─────────────────────────────────────────────────────────────────
def resolve_account_id(trade, cfg):
    if cfg["account_id"]:
        return str(cfg["account_id"])
    payload = _payload(_api_call(trade.account_v2.get_account_list))
    accounts = _rows(payload)
    if not accounts:
        die("Webull returned no accounts for these API keys.")
    ids = [_pick(a, ["account_id", "accountId", "id"]) for a in accounts]
    ids = [str(i) for i in ids if i]
    if len(ids) > 1:
        print(f"  note: {len(ids)} accounts found; using the first ({ids[0]}).")
        print(f"        Set \"account_id\" in webull_config.json to pick another: {ids}")
    return ids[0]


# ── orders → fills ───────────────────────────────────────────────────────────
def fetch_filled_fills(trade, account_id, history_start):
    """
    Page through order history from history_start to today and normalize every
    FILLED order into fills:
      { date, ts, symbol, side('buy'|'sell'), qty, price, fees, mult, asset }
    Options get mult=100, a contract label like 'AAPL 2026-08-15 C 200' as the
    symbol (so pairing is per-contract), and asset='option'.
    """
    print(f"Fetching order history since {history_start}…")
    start = datetime.strptime(history_start, "%Y-%m-%d").date()
    today = date.today()

    raw_orders = []
    # The API caps ranges (defaults to 7 days when empty), so walk it in
    # 30-day windows and paginate inside each window.
    win_start = start
    throttled = False
    while win_start <= today:
        win_end = min(win_start + timedelta(days=29), today)
        last_id = None
        while True:
            try:
                resp = _api_call(
                    trade.order_v3.get_order_history,
                    account_id,
                    page_size=100,
                    start_date=win_start.strftime("%Y-%m-%d"),
                    end_date=win_end.strftime("%Y-%m-%d"),
                    last_client_order_id=last_id,
                )
            except Exception as e:  # noqa: BLE001
                # A rate-limit that survived every retry shouldn't nuke the whole
                # sync (positions especially). Keep the orders gathered so far,
                # flag it, and move on — the next sync pass fills the rest in.
                if _is_rate_limit(e):
                    print(f"  ⚠ rate-limited on order history ({win_start}→{win_end}) "
                          f"after retries; skipping this window, will catch up next sync.")
                    throttled = True
                    break
                die(f"Couldn't fetch order history ({win_start}→{win_end}): {e}")
            rows = _rows(_payload(resp))
            if not rows:
                break
            raw_orders.extend(rows)
            if len(rows) < 100:
                break
            last_id = _pick(rows[-1], ["client_order_id", "clientOrderId", "order_id", "orderId"])
            if not last_id:
                break
        win_start = win_end + timedelta(days=1)

    if throttled:
        print("  (order history is PARTIAL this pass due to Webull rate-limiting.)")
    print(f"✓ {len(raw_orders)} orders returned.")
    fills = []
    for o in raw_orders:
        f = normalize_order(o)
        if f:
            fills.append(f)
    fills.sort(key=lambda f: f["ts"])
    n_sym = len({f["symbol"] for f in fills})
    print(f"✓ {len(fills)} filled orders across {n_sym} instruments.\n")
    return fills, raw_orders


def normalize_order(o):
    """One raw Webull order → one fill dict, or None if not a filled trade."""
    status = str(_pick(o, ["order_status", "status", "orderStatus", "state"], "")).upper()
    if status not in ("FILLED", "PARTIAL_FILLED", "PARTIALLY_FILLED"):
        return None

    # Webull marks a short sale side "SHORT" (some feeds "SELL_SHORT"), and its
    # cover is a plain "BUY". Until 2026-11-05 only BUY*/SELL* got through, so
    # every short sale was dropped and its cover opened a phantom long (same
    # bug as Tony's TradeHub on the 11/5 SNDK/WDC shorts). A short sale is a
    # sell: pair_fifo opens a short on a sell with nothing held, and the
    # covering buy closes it.
    side = str(_pick(o, ["side", "action", "order_side"], "")).upper()
    if side.startswith("BUY"):
        side = "buy"
    elif side.startswith("SELL") or "SHORT" in side:
        side = "sell"
    else:
        return None

    qty = _f(_pick(o, ["filled_qty", "filled_quantity", "filledQuantity",
                       "filled_amount", "cumulative_quantity", "quantity", "qty"]))
    price = _f(_pick(o, ["avg_filled_price", "filled_avg_price", "avgFilledPrice",
                         "average_price", "avg_price", "filled_price", "price"]))
    if qty <= 0 or price <= 0:
        return None

    ts = _pick(o, ["filled_time", "filledTime", "update_time", "updated_time",
                   "place_time", "placeTime", "create_time", "created_time"])
    fees = _f(_pick(o, ["fees", "fee", "total_fee", "commission"], 0))

    inst_type = str(_pick(o, ["instrument_type", "instrumentType", "security_type",
                              "asset_type", "combo_type"], "EQUITY")).upper()
    symbol = str(_pick(o, ["symbol", "ticker", "instrument_symbol", "disSymbol"], "")).upper()
    if not symbol:
        return None

    is_option = "OPTION" in inst_type
    if is_option:
        strike = _f(_pick(o, ["strike_price", "strikePrice", "option_strike"], 0))
        expiry = str(_pick(o, ["option_expire_date", "expire_date", "expiration_date",
                               "expireDate"], ""))[:10]
        opt_type = str(_pick(o, ["option_type", "optionType", "call_or_put"], ""))[:1].upper()
        strike_txt = ("%g" % strike) if strike else "?"
        label = f"{symbol} {expiry} {opt_type} {strike_txt}".strip()
        return {
            "date": _iso_date(ts), "ts": str(ts or ""), "symbol": label,
            "side": side, "qty": qty, "price": price, "fees": fees,
            "mult": 100, "asset": "option",
        }
    return {
        "date": _iso_date(ts), "ts": str(ts or ""), "symbol": symbol,
        "side": side, "qty": qty, "price": price, "fees": fees,
        "mult": 1, "asset": "stock",
    }


# ── FIFO pairing → journal trades ────────────────────────────────────────────
# Battle-tested rules carried over from the previous broker integration:
#   DUST            — sub-0.0001 quantities are treated as zero.
#   REVERSAL_FLOOR  — a sub-0.1 sliver left over from CLOSING opposing
#                     inventory never opens a reversed lot (kills the phantom
#                     shorts caused by fractional/whole-share mismatches).
#   FRESH_SHORT_FLOOR — a stock sell that opens fresh (no inventory) below
#                     0.1 sh is the sale of shares acquired outside the order
#                     feed (transfer/reward/DRIP), not a real short — skipped.
#                     Webull DOES allow real margin shorts, so larger fresh
#                     sells open genuine short positions normally.
DUST = 1e-4
REVERSAL_FLOOR = 0.1
FRESH_SHORT_FLOOR = 0.1


def pair_fifo(fills):
    trades = []
    open_lots = defaultdict(deque)

    for f in fills:
        sym = f["symbol"]
        lots = open_lots[sym]
        remaining = f["qty"]
        closed_any = False

        def opposite(lot):
            return lot["side"] != f["side"]

        while remaining > DUST and lots and opposite(lots[0]):
            closed_any = True
            lot = lots[0]
            matched = min(remaining, lot["qty"])

            side = "long" if lot["side"] == "buy" else "short"
            entry_price, exit_price = lot["price"], f["price"]
            entry_date = lot["date"]

            leg_fees = (
                lot["fees"] * (matched / lot["qty"] if lot["qty"] else 0)
                + f["fees"] * (matched / f["qty"] if f["qty"] else 0)
            )

            mult = f.get("mult", 1)
            asset = f.get("asset", "stock")
            tags = [BROKER_TAG, asset] if asset == "option" else [BROKER_TAG]
            note_kind = "contract(s)" if asset == "option" else "shares"

            if matched > DUST:
                trades.append({
                    "date": f["date"],
                    "symbol": sym,
                    "side": side,
                    # qty carries the multiplier so the journal's (exit-entry)*qty
                    # lands in real dollars (×100 per option contract).
                    "qty": round(matched * mult, 6),
                    "entry": round(entry_price, 4),
                    "exit": round(exit_price, 4),
                    "fees": round(leg_fees, 2),
                    "tags": tags,
                    "notes": f"Auto-imported {round(matched, 4)} {note_kind}. "
                             f"Entry {entry_date}, exit {f['date']}.",
                    "_entry_date": entry_date,
                    "_asset": asset,
                    # Fill times: the Journal's time column and minute-level hold.
                    "entryTime": _iso_ts(lot.get("ts")),
                    "exitTime": _iso_ts(f.get("ts")),
                })

            lot["fees"] -= lot["fees"] * (matched / lot["qty"]) if lot["qty"] else 0
            lot["qty"] -= matched
            remaining -= matched
            if lot["qty"] <= DUST:
                lots.popleft()

        # Open the remainder as a new lot — with the two artifact guards.
        sliver_reversal = closed_any and remaining < REVERSAL_FLOOR
        fresh_tiny_stock_short = (
            not closed_any
            and f["side"] == "sell"
            and f.get("asset", "stock") == "stock"
            and remaining < FRESH_SHORT_FLOOR
        )
        if fresh_tiny_stock_short:
            print(f"  note: {sym} sell of {round(remaining, 6)} sh on {f['date']} has no "
                  f"matching buy (likely transfer/reward/DRIP shares) — skipped.")
        if remaining > DUST and not sliver_reversal and not fresh_tiny_stock_short:
            lots.append({
                "side": f["side"],
                "qty": remaining,
                "price": f["price"],
                "fees": f["fees"] * (remaining / f["qty"] if f["qty"] else 0),
                "date": f["date"],
                "ts": f.get("ts"),
                "mult": f.get("mult", 1),
                "asset": f.get("asset", "stock"),
            })

    # leftovers → open trades
    for sym, lots in open_lots.items():
        for lot in lots:
            if lot["qty"] <= DUST:
                continue
            mult = lot.get("mult", 1)
            asset = lot.get("asset", "stock")
            tags = [BROKER_TAG, "open"] + (["option"] if asset == "option" else [])
            trades.append({
                "date": lot["date"],
                "symbol": sym,
                "side": "long" if lot["side"] == "buy" else "short",
                "qty": round(lot["qty"] * mult, 6),
                "entry": round(lot["price"], 4),
                "exit": None,
                "fees": round(lot["fees"], 2),
                "tags": tags,
                "notes": f"Open position opened {lot['date']}.",
                "entryTime": _iso_ts(lot.get("ts")),
            })

    trades = _merge_roundtrips(trades)
    trades.sort(key=lambda t: (t["date"], t["symbol"]))
    return trades


def _merge_roundtrips(trades):
    """
    One real exit = one journal row. FIFO emits one row per opening lot, so a
    position built in pieces and sold at once fragments into many rows sharing
    symbol+side+exit-date. Merge each such group: qty summed, entry/exit
    share-weighted, fees summed. P&L is preserved exactly.
    """
    groups = defaultdict(list)
    passthrough = []
    for t in trades:
        if t.get("exit") is None:
            passthrough.append(t)
            continue
        groups[(t["symbol"], t["side"], t["date"])].append(t)

    merged = []
    for (symbol, side, exit_date), rows in groups.items():
        if len(rows) == 1:
            merged.append(rows[0])
            continue
        qty = sum(r["qty"] for r in rows)
        if qty <= 0:
            merged.append(rows[0])
            continue
        wavg_entry = sum(r["entry"] * r["qty"] for r in rows) / qty
        wavg_exit = sum(r["exit"] * r["qty"] for r in rows) / qty
        fees = sum(r.get("fees", 0) for r in rows)
        eds = sorted(r.get("_entry_date", exit_date) for r in rows)
        span = eds[0] if eds[0] == eds[-1] else f"{eds[0]}–{eds[-1]}"
        asset = rows[0].get("_asset", "stock")
        note_kind = "contract(s)" if asset == "option" else "shares"
        merged.append({
            "date": exit_date, "symbol": symbol, "side": side,
            "qty": round(qty, 6),
            "entry": round(wavg_entry, 4),
            "exit": round(wavg_exit, 4),
            "fees": round(fees, 2),
            "tags": rows[0]["tags"],
            "notes": f"Auto-imported {round(qty, 4)} {note_kind} "
                     f"({len(rows)} fills). Entry {span}, exit {exit_date}.",
            "entryDate": eds[0],
            # The first fill in, the last fill out.
            "entryTime": min((r["entryTime"] for r in rows if r.get("entryTime")), default=None),
            "exitTime": max((r["exitTime"] for r in rows if r.get("exitTime")), default=None),
        })

    out = passthrough + merged
    for t in out:
        # The entry date goes to TradeBoard as `entryDate` (its Journal's Hold
        # column, TradeHub's, 2026-11-09); it used to be dropped here. A merged
        # row carries its earliest entry.
        ed = t.pop("_entry_date", None)
        if ed and "entryDate" not in t:
            t["entryDate"] = ed
        t.pop("_asset", None)
        for k in ("entryTime", "exitTime"):
            if not t.get(k):
                t.pop(k, None)
    return out


# ── positions + equity ───────────────────────────────────────────────────────
def fetch_positions(trade, account_id):
    print("Fetching positions + balance…")
    out = []
    raw_sample = None
    try:
        payload = _payload(_api_call(trade.account_v2.get_account_position, account_id))
        rows = _rows(payload)
    except Exception as e:  # noqa: BLE001
        print(f"  (couldn't fetch positions: {e})")
        rows = []

    for p in rows:
        if raw_sample is None:
            raw_sample = p
        symbol = str(_pick(p, ["symbol", "ticker", "instrument_symbol"], "")).upper()
        qty = _f(_pick(p, ["quantity", "qty", "position", "total_quantity"]))
        if not symbol or qty == 0:
            continue
        avg = _f(_pick(p, ["avg_cost", "average_cost", "cost_price", "avg_price",
                           "average_buy_price", "unit_cost"]))
        last = _f(_pick(p, ["last_price", "lastPrice", "market_price", "current_price",
                            "mark_price"]))
        inst_type = str(_pick(p, ["instrument_type", "instrumentType", "security_type"],
                              "EQUITY")).upper()
        is_opt = "OPTION" in inst_type
        mult = 100 if is_opt else 1
        mkt_val = last * qty * mult
        cost = avg * qty * mult
        out.append({
            "symbol": symbol,
            "asset": "option" if is_opt else "stock",
            "qty": round(qty, 6),
            "avg": round(avg, 4),
            "last": round(last, 4),
            "market_value": round(mkt_val, 2),
            "unrealized": round(mkt_val - cost, 2),
            "unrealized_pct": round(((last - avg) / avg * 100) if avg else 0, 2),
        })
        dp = _num(_pick(p, ["day_change_ratio", "change_ratio", "day_profit_loss_rate"]))
        if dp is not None:
            out[-1]["day_pct"] = round(dp * 100 if abs(dp) < 1.5 else dp, 2)

    equity = None
    account = {}
    try:
        bal = _payload(_api_call(trade.account_v2.get_account_balance, account_id))
        b = bal[0] if isinstance(bal, list) and bal else bal
        # Real field verified against live Webull response (2026-07-18):
        # get_account_balance returns total_net_liquidation_value (a string).
        equity = _f(_pick(b, ["total_net_liquidation_value", "net_liquidation_value",
                              "netLiquidationValue", "total_asset", "total_assets",
                              "account_value", "net_liquidation", "equity"]), None)
        account = account_figures(b if isinstance(b, dict) else {})
    except Exception as e:  # noqa: BLE001
        print(f"  (couldn't fetch balance: {e})")

    print(f"✓ {len(out)} positions.\n")
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "broker": "Webull",
        "equity": round(equity, 2) if equity else None,
        "account": account,
        "positions": out,
    }, raw_sample


# ── Portfolio extras (2026-11-06): what TradeHub's Portfolio shows ───────────
# The page's Portfolio (TradeHub's layout) also shows the account figures, open
# orders, the last 30 days of orders and the account's cash activity. Each read
# fails soft: a missing piece shows "appears after the sync" on the page, never
# breaks the sync. Field names follow workers/tradeboard-api (Tony's, which
# reads the same Webull OpenAPI).
def _num(v):
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def account_figures(b):
    """Webull's balance payload → the page's account fields (None = not sent)."""
    d = b or {}
    assets = d.get("account_currency_assets") or []
    acct = assets[0] if isinstance(assets, list) and assets and isinstance(assets[0], dict) else {}

    def pick(*names):
        for src in (acct, d):
            for n in names:
                v = _num(src.get(n)) if isinstance(src, dict) else None
                if v is not None:
                    return v
        return None

    def pick_re(rx, avoid=None):
        for src in (acct, d):
            for k, v in (src or {}).items():
                norm = k.replace("_", "").replace("-", "").lower()
                if re.search(rx, norm) and not (avoid and re.search(avoid, norm)) and _num(v):
                    return _num(v)
        return None

    net = pick("total_net_liquidation_value", "net_liquidation_value")
    cash = pick("total_cash_balance", "cash_balance")
    settled = pick("settled_cash")
    bp = pick("available_buying_power", "buying_power", "settled_cash", "cash_buying_power")
    if (bp is None or bp <= 0) and (settled or cash):
        bp = settled or cash
    if net and bp and bp > net + 0.01:
        bp = settled or cash
    out = {
        "net_liquidation": net, "cash": cash, "buying_power": bp,
        "market_value": pick("total_market_value"),
        "day_pnl": pick("total_day_profit_loss"),
        "settled_cash": settled, "unsettled_cash": pick("unsettled_cash"),
        "intraday_bp": pick("day_trading_buying_power", "intraday_buying_power", "day_buying_power") or pick_re(r"(day|intraday)(trading)?buyingpower", r"(overnight|night)"),
        "overnight_bp": pick("overnight_buying_power", "night_trading_buying_power") or pick_re(r"(overnight|nighttrading)buyingpower"),
        "options_bp": pick("option_buying_power", "options_buying_power") or pick_re(r"options?(trading)?buyingpower"),
        "initial_margin": pick("initial_margin"), "maintenance_margin": pick("maintenance_margin"),
        "excess_liquidity": pick("excess_liquidity"),
        "account_type": d.get("account_type") or acct.get("account_type") or None,
        "currency": d.get("total_asset_currency") or "USD",
    }
    if out["day_pnl"] and net:
        out["day_pnl_pct"] = round(out["day_pnl"] / (net - out["day_pnl"]) * 100, 2) if net != out["day_pnl"] else None
    return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in out.items() if v is not None}


def _order_row(o):
    sym = str(_pick(o, ["symbol", "ticker"], "") or (o.get("instrument") or {}).get("symbol", "")).upper()
    return {
        "symbol": sym,
        "side": str(_pick(o, ["side", "action", "order_side"], "")).upper(),
        "qty": _f(_pick(o, ["total_quantity", "quantity", "qty"])),
        "filled": _f(_pick(o, ["filled_quantity", "filled_qty"])),
        "limit_price": _f(_pick(o, ["limit_price"])) or None,
        "stop_price": _f(_pick(o, ["stop_price", "aux_price"])) or None,
        "avg_price": _f(_pick(o, ["filled_price", "avg_filled_price"])) or None,
        "order_type": str(_pick(o, ["order_type", "type"], "")).upper(),
        "tif": _pick(o, ["time_in_force", "tif"], "DAY"),
        "status": str(_pick(o, ["status", "order_status"], "")).upper(),
        "placed_at": _pick(o, ["place_time_at", "create_time", "place_time"]),
        "filled_at": _pick(o, ["filled_time_at", "filled_time"]),
        "fee": _f(_pick(o, ["total_commission", "commission", "fee"])) if _pick(o, ["total_commission", "commission", "fee"]) is not None else None,
    }


def _flatten(rows):
    out = []
    for r in rows or []:
        if isinstance(r, dict) and isinstance(r.get("orders"), list) and r["orders"]:
            out.extend(x for x in r["orders"] if isinstance(x, dict))
        elif isinstance(r, dict):
            out.append(r)
    return out


def fetch_open_orders(trade, account_id):
    try:
        op = getattr(trade.order_v3, "list_order_open", None)
        resp = _api_call(op, account_id) if op else _api_call(trade.order_v3.get_order_open, account_id, page_size=100)
        rows = _flatten(_rows(_payload(resp)))
        out = [_order_row(o) for o in rows]
        return [o for o in out if o["symbol"]]
    except Exception as e:  # noqa: BLE001
        print(f"  (couldn't fetch open orders: {e})")
        return None


def recent_history(raw_orders, days=30):
    """The last `days` of orders (any status), newest first, from the history read above."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    rows = [_order_row(o) for o in _flatten(raw_orders)]
    rows = [r for r in rows if r["symbol"] and str(r.get("filled_at") or r.get("placed_at") or "") >= cutoff[:10]]
    rows.sort(key=lambda r: str(r.get("filled_at") or r.get("placed_at") or ""), reverse=True)
    return rows[:200]


CASH_TYPES = "DEPOSIT,WITHDRAW,FEES,TRANSFER,DIVIDENDS,TAX,INTERESTS,CORPORATE_ACTION,OPTION_EA,JOURNAL"


def cash_activity_row(r):
    return {
        "id": r.get("id"),
        "type": str(r.get("activity_type") or "").upper(),
        "sub": str(r.get("activity_sub_type") or "").upper(),
        "symbol": r.get("symbol") or "",
        "date": r.get("trade_date") or (str(r.get("biz_time"))[:10] if r.get("biz_time") else ""),
        "at": r.get("biz_time"),
        "amount": round(_f(r.get("net_amount")), 2),
        "currency": r.get("currency") or "USD",
    }


def fetch_cash_activity(trade, account_id, days=400):
    """Webull cash activity (v3), split by calendar year (Webull refuses a range
    across a year end) and paged; trades are left out (they are in History)."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    out, with_types = [], True
    try:
        for y in range(start.year, end.year + 1):
            a = start if y == start.year else datetime(y, 1, 1, tzinfo=timezone.utc)
            b = end if y == end.year else datetime(y, 12, 31, 23, 59, 59, tzinfo=timezone.utc)
            key, page = None, 0
            while page < 8:
                try:
                    payload = _payload(_api_call(trade.activity.list_activities, account_id,
                                                 activity_types=CASH_TYPES if with_types else None,
                                                 start_time=iso(a), end_time=iso(b), pagination_key=key))
                except Exception as e:  # noqa: BLE001
                    if with_types and not _is_rate_limit(e):
                        with_types = False   # a type list it won't take: ask for all, drop trades here
                        continue
                    raise
                rows = payload if isinstance(payload, list) else (payload or {}).get("data") or []
                for r in rows:
                    m = cash_activity_row(r)
                    if m["type"] not in ("TRADE", "EC_SETTLEMENT"):
                        out.append(m)
                key = payload.get("pagination_key") if isinstance(payload, dict) else None
                page += 1
                if not key or not rows:
                    break
                time.sleep(0.6)
    except Exception as e:  # noqa: BLE001
        print(f"  (couldn't fetch cash activity: {e})")
        return None
    seen, uniq = set(), []
    for x in out:
        k = x["id"] or f'{x["type"]}{x["sub"]}{x["date"]}{x["amount"]}{x["symbol"]}'
        if k not in seen:
            seen.add(k)
            uniq.append(x)
    uniq.sort(key=lambda x: str(x.get("at") or x.get("date")), reverse=True)
    return uniq


def cached_cash_activity(trade, account_id, max_age_s=600):
    """Cash activity at most every 10 minutes (the sync runs every 2): the last
    read is kept in broker_activity.json and reused until it is stale."""
    c = None
    try:
        with open(ACTIVITY_CACHE, encoding="utf-8") as fh:
            c = json.load(fh)
        if time.time() - float(c.get("at", 0)) < max_age_s and isinstance(c.get("items"), list):
            return c["items"]
    except Exception:  # noqa: BLE001
        pass
    items = fetch_cash_activity(trade, account_id)
    if items is None:
        return c.get("items") if isinstance(c, dict) and isinstance(c.get("items"), list) else None
    try:
        with open(ACTIVITY_CACHE, "w", encoding="utf-8") as fh:
            json.dump({"at": time.time(), "items": items}, fh)
    except Exception:  # noqa: BLE001
        pass
    return items


# ── main ─────────────────────────────────────────────────────────────────────
def sync(trade=None, cfg=None):
    """Run one full sync. Returns (n_trades, n_positions)."""
    cfg = cfg or load_config()
    trade = trade or connect(cfg)
    account_id = resolve_account_id(trade, cfg)

    fills, raw_orders = fetch_filled_fills(trade, account_id, cfg["history_start"])
    trades = pair_fifo(fills)
    positions, raw_pos = fetch_positions(trade, account_id)
    # Portfolio extras (open orders, 30 days of orders, cash activity); a piece
    # that can't be read is left out and the page says when it will appear.
    orders = fetch_open_orders(trade, account_id)
    if orders is not None:
        positions["orders"] = orders
    positions["history"] = recent_history(raw_orders)
    activity = cached_cash_activity(trade, account_id)
    if activity is not None:
        positions["activity"] = activity

    with open(TRADES_OUT, "w", encoding="utf-8") as fh:
        json.dump(trades, fh, indent=2)
    with open(POSITIONS_OUT, "w", encoding="utf-8") as fh:
        json.dump(positions, fh, indent=2)

    # Push straight to the TradeBoard cloud so the hosted site + every device
    # (incl. your phone) update live — no local server, no clicking. Fails soft:
    # a cloud outage never breaks the local-file sync above.
    try:
        import wb_cloud
        wb_cloud.push(trades, positions)
    except Exception as e:  # noqa: BLE001
        print(f"  (cloud push unavailable: {e})")

    # first raw order + position, for one-minute field-name fixes if ever needed
    try:
        with open(RAW_SAMPLE_OUT, "w", encoding="utf-8") as fh:
            json.dump({"first_order": raw_orders[0] if raw_orders else None,
                       "first_position": raw_pos}, fh, indent=2, default=str)
    except Exception:  # noqa: BLE001
        pass

    closed = sum(1 for t in trades if t["exit"] is not None)
    print("─" * 60)
    print(f"✓ Wrote {len(trades)} trades ({closed} closed, {len(trades) - closed} open)")
    print(f"    → {TRADES_OUT}")
    print(f"✓ Wrote {len(positions['positions'])} live positions")
    print(f"    → {POSITIONS_OUT}")
    print("─" * 60)
    return len(trades), len(positions["positions"])


def main():
    print("═" * 60)
    print(" Webull → Trade Journal sync  (official OpenAPI, read-only)")
    print("═" * 60 + "\n")
    sync()
    print("\nNext: open journal.html → '⇄ Sync from broker' → 1 → broker_import.json")
    print("      (or run wb_server.py for fully automatic updating)")


if __name__ == "__main__":
    main()
