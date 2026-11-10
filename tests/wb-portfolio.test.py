"""TradeBoard's PC sync sends what the Portfolio shows (V1/TradeBoard/wb_sync.py, 2026-11-06).

Offline: a fake Webull client stands in for the SDK, so nothing reaches Webull.
Pins the account figures from the balance, open orders, 30 days of history,
cash activity (split by year, paged, trades dropped, cached 10 minutes) and
that a failed read is left out instead of breaking the sync.

Run: py -3 tests/wb-portfolio.test.py
"""
import importlib.util, json, os, sys, tempfile, time, types
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "V1", "TradeBoard", "wb_sync.py")
# The SDK is only on Veda's PC: stand-ins let the module load here.
for name in ("webull", "webull.core", "webull.core.client", "webull.trade", "webull.trade.trade_client"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["webull.core.client"].ApiClient = object
sys.modules["webull.trade.trade_client"].TradeClient = object
spec = importlib.util.spec_from_file_location("wb_sync_under_test", SRC)
wb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wb)

ok = fail = 0
def t(name, cond, detail=""):
    global ok, fail
    if cond: ok += 1; print("  ok  ", name)
    else: fail += 1; print("  FAIL", name, detail)

class R:  # an SDK response
    def __init__(self, body): self.body = body
    def json(self): return self.body
    status_code = 200

now = datetime.now(timezone.utc)
iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S.000Z")
calls = {"act": 0}
class Activity:
    def list_activities(self, account_id, activity_types=None, start_time=None, end_time=None, pagination_key=None):
        calls["act"] += 1
        if not pagination_key:
            return R({"data": [
                {"id": "d1", "activity_type": "DIVIDENDS", "activity_sub_type": "CASH_DIVIDEND", "symbol": "AAPL", "net_amount": "20.40", "trade_date": now.strftime("%Y-%m-%d"), "biz_time": iso(now)},
                {"id": "x1", "activity_type": "TRADE", "net_amount": "-500"},
            ], "pagination_key": "p2"})
        return R({"data": [{"id": "f1", "activity_type": "FEES", "activity_sub_type": "ADR_FEE", "symbol": "TSM", "net_amount": "-1.2", "trade_date": now.strftime("%Y-%m-%d")}]})
class OrderV3:
    def list_order_open(self, account_id, pagination_key=None):
        return R({"data": [{"orders": [{"symbol": "AMD", "side": "BUY", "total_quantity": "10", "limit_price": "150", "order_type": "LIMIT", "time_in_force": "DAY", "status": "SUBMITTED", "place_time_at": iso(now)}]}]})
trade = types.SimpleNamespace(activity=Activity(), order_v3=OrderV3())

wb._payload = lambda r: r.json() if hasattr(r, "json") else r
wb._api_call = lambda fn, *a, **k: fn(*a, **k)
wb.time.sleep = lambda s: None

print("account figures")
bal = {"total_net_liquidation_value": "52000", "total_cash_balance": "9000", "total_market_value": "43000", "total_day_profit_loss": "312.5",
       "account_currency_assets": [{"settled_cash": "8800", "unsettled_cash": "200", "buying_power": "18000", "day_trading_buying_power": "72000"}]}
a = wb.account_figures(bal)
t("net, cash, buying power, market value, day P&L", a.get("net_liquidation") == 52000 and a.get("cash") == 9000 and a.get("buying_power") == 18000 and a.get("market_value") == 43000 and a.get("day_pnl") == 312.5, a)
t("day % from the day P&L", a.get("day_pnl_pct") == round(312.5 / (52000 - 312.5) * 100, 2), a.get("day_pnl_pct"))
t("margin figures as Webull sends them", a.get("intraday_bp") == 72000 and a.get("settled_cash") == 8800 and a.get("unsettled_cash") == 200, a)
t("a buying power above net liquidation falls back to settled cash", wb.account_figures({"total_net_liquidation_value": "1000", "account_currency_assets": [{"buying_power": "99999", "settled_cash": "400"}]})["buying_power"] == 400)
t("a figure Webull leaves out is left out (never a fake 0)", "excess_liquidity" not in a)

print("open orders")
o = wb.fetch_open_orders(trade, "acc")
t("grouped orders are flattened and mapped", o and o[0]["symbol"] == "AMD" and o[0]["limit_price"] == 150 and o[0]["qty"] == 10 and o[0]["status"] == "SUBMITTED", o)
t("a failed read is None (left out), not an error", wb.fetch_open_orders(types.SimpleNamespace(order_v3=types.SimpleNamespace(list_order_open=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x")))), "acc") is None)

print("history")
old = iso(now - timedelta(days=60)); recent = iso(now - timedelta(days=2))
h = wb.recent_history([{"symbol": "TSLA", "side": "SELL", "total_quantity": "5", "filled_price": "320", "status": "FILLED", "filled_time_at": recent, "total_commission": "0.05"},
                       {"symbol": "OLD", "side": "BUY", "total_quantity": "1", "status": "FILLED", "filled_time_at": old}])
t("only the last 30 days, with price and fee", len(h) == 1 and h[0]["symbol"] == "TSLA" and h[0]["avg_price"] == 320 and h[0]["fee"] == 0.05, h)

print("cash activity")
items = wb.fetch_cash_activity(trade, "acc", days=30)
t("pages on, drops trades", [x["id"] for x in items] == ["d1", "f1"] or sorted(x["id"] for x in items) == ["d1", "f1"], items)
t("amounts are numbers, types upper-case", items and isinstance(items[0]["amount"], float) and items[0]["type"] in ("DIVIDENDS", "FEES"))
cross = wb.fetch_cash_activity(trade, "acc", days=400)
t("a range across a year end is read year by year", calls["act"] >= 4, calls["act"])
tmp = tempfile.mkdtemp(); wb.ACTIVITY_CACHE = os.path.join(tmp, "broker_activity.json")
n0 = calls["act"]; first = wb.cached_cash_activity(trade, "acc"); n1 = calls["act"]; second = wb.cached_cash_activity(trade, "acc")
t("cached: a second sync within 10 minutes reads nothing", n1 > n0 and calls["act"] == n1 and first == second)
json.dump({"at": time.time() - 3600, "items": [{"id": "stale"}]}, open(wb.ACTIVITY_CACHE, "w"))
bad = types.SimpleNamespace(activity=types.SimpleNamespace(list_activities=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down"))))
t("Webull down: the last good read is kept", wb.cached_cash_activity(bad, "acc") == [{"id": "stale"}])

# The Journal's Hold column (TradeHub parity, 2026-11-09): the entry date goes
# out as entryDate (it used to be dropped); a merged row carries its earliest.
print("journal entry dates")
rt = lambda ed, qty, ex="2026-11-05": {"date": ex, "symbol": "NVDA", "side": "long", "qty": qty, "entry": 100.0, "exit": 110.0,
                                       "fees": 0, "tags": ["webull"], "notes": "", "_entry_date": ed, "_asset": "stock"}
one = wb._merge_roundtrips([rt("2026-11-01", 5)])
t("a single round trip sends entryDate, not _entry_date", one and one[0].get("entryDate") == "2026-11-01" and "_entry_date" not in one[0] and "_asset" not in one[0], one)
many = wb._merge_roundtrips([rt("2026-11-03", 2), rt("2026-10-28", 3)])
t("fills merged into one exit keep the earliest entry", len(many) == 1 and many[0].get("entryDate") == "2026-10-28" and many[0]["qty"] == 5, many)
op = wb._merge_roundtrips([{"date": "2026-11-04", "symbol": "AMD", "side": "long", "qty": 1, "entry": 1, "exit": None, "fees": 0, "tags": ["webull"], "notes": ""}])
t("an open position is untouched (its date is the entry)", op and "entryDate" not in op[0], op)

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
