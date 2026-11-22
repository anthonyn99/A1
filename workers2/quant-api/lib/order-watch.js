// Trade alerts (Batch 4 T7, A1-Priv docs/TradeHub/quant/t4-07.md; ask P2-5): a paper order filled, partly filled,
// cancelled or rejected → an alert of kind `order` (lib/alerts.js fire(): the bell, and a push through /quant-push to
// the devices Beacon lets hear TradeHub). Run by the cron every minute of a New York session (04:00-20:00, trading days).
//
// Cheap by design (rule 11): ONE read per broker a minute (Alpaca: its latest 100 orders, legs nested; Webull: its order
// history), nothing at all when the `order` kind or every broker is off, and D1 written only when something new happened.
// Each broker keeps the keys it has already seen (`orderwatch:<broker>` in meta, the latest 400); the first run only
// learns what is there (no flood of old orders). A partial fill is new each time its filled quantity grows.
// Per event and per broker switches: Control ▸ Alerts ▸ Trading (config `trading`).
import { configOf, fire, standingRules, ruleOf, push, PAGE_URL } from './alerts.js';
import * as paper from './paper.js';
import * as webull from './brokers/webull.js';

export const BROKERS = { alpaca: { label: 'Alpaca', ready: (env) => !!(env.ALPACA_KEY && env.ALPACA_SECRET), read: paper.recentOrders },
  webull: { label: 'Webull', ready: (env) => !!(env.WEBULL_PAPER_KEY && env.WEBULL_PAPER_SECRET), read: webull.recentOrders } };
export const EVENTS = ['filled', 'partial', 'canceled', 'rejected'];
export const SEEN_MAX = 400;
const EVENT_OF = { filled: 'filled', partially_filled: 'partial', canceled: 'canceled', cancelled: 'canceled', rejected: 'rejected' };
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const px = (x) => (x == null ? '' : Number(x) >= 1 ? Number(x).toFixed(2) : String(Math.round(Number(x) * 10000) / 10000));
const TYPE = { market: 'market', limit: 'limit', stop: 'stop', stop_limit: 'stop limit', trailing_stop: 'trailing stop' };

/** An order (and its legs) → its events now: [{ key, event, o }]. */
export function eventsOf(orders) {
  const out = [];
  for (const o of orders || []) for (const x of [o, ...(Array.isArray(o.legs) ? o.legs : [])]) {
    const ev = EVENT_OF[String(x.status || '').toLowerCase()];
    if (!ev || !x.id) continue;
    out.push({ key: `${x.id}:${ev}${ev === 'partial' ? ':' + num(x.filled_qty) : ''}`, event: ev, o: x });
  }
  return out;
}
/** The alert's words: "Filled: Buy 10 NVDA at 164.20" / "Alpaca paper · limit order". */
export function wordsOf(broker, event, o) {
  const side = o.side === 'sell' ? 'Sell' : 'Buy', qty = num(o.qty), fq = num(o.filled_qty), avg = num(o.filled_avg_price);
  const at = o.type === 'limit' || o.type === 'stop_limit' ? num(o.limit_price) : o.type === 'stop' ? num(o.stop_price) : null;
  const title = event === 'filled' ? `Filled: ${side} ${fq || qty} ${o.symbol}${avg ? ' at ' + px(avg) : ''}`
    : event === 'partial' ? `Partly filled: ${side} ${fq} of ${qty} ${o.symbol}${avg ? ' at ' + px(avg) : ''}`
    : event === 'canceled' ? `Cancelled: ${side} ${qty} ${o.symbol}${at ? ' ' + (TYPE[o.type] || o.type) + ' ' + px(at) : ''}`
    : `Rejected: ${side} ${qty} ${o.symbol}${at ? ' ' + (TYPE[o.type] || o.type) + ' ' + px(at) : ''}`;
  const body = `${BROKERS[broker].label} paper · ${TYPE[o.type] || o.type || 'order'} order` + (o.reject_reason ? ' · ' + String(o.reject_reason).slice(0, 120) : '');
  return { title, body };
}

/** The cron's work → { skipped } or { brokers: { alpaca: { events, fired, learned } } }. */
export async function watch(env, now = Date.now(), { send = push, fetchFn = fetch } = {}) {
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'alert_cfg'").first().catch(() => null);
  let raw = {}; try { raw = row && row.v ? JSON.parse(row.v) : {}; } catch (e) {}
  const cfg = configOf(raw);
  if (cfg.kinds.order === false) return { skipped: 'order alerts are off' };
  const on = Object.keys(BROKERS).filter((b) => cfg.trading[b] !== false && BROKERS[b].ready(env));
  if (!on.length) return { skipped: 'no broker to watch' };
  const keys = on.map((b) => 'orderwatch:' + b);
  const seenRows = (await env.DB.prepare(`SELECT k, v FROM meta WHERE k IN (${keys.map(() => '?').join(',')})`).bind(...keys).all()).results || [];
  const seenOf = new Map(seenRows.map((r) => { let v = null; try { v = JSON.parse(r.v); } catch (e) {} return [r.k, Array.isArray(v) ? v : null]; }));
  let rules = null;
  const out = { brokers: {} };
  for (const b of on) {
    let orders;
    try { orders = await BROKERS[b].read(env, fetchFn); } catch (e) { out.brokers[b] = { error: e.message || String(e) }; continue; }
    const evs = eventsOf(orders), had = seenOf.get('orderwatch:' + b);
    const fresh = had ? evs.filter((e) => !had.includes(e.key)) : [];
    out.brokers[b] = { events: fresh.length, learned: !had };
    if (had && !fresh.length) continue;   // nothing new: no write
    const keep = [...new Set([...evs.map((e) => e.key), ...(had || [])])].slice(0, SEEN_MAX);
    await env.DB.prepare('INSERT INTO meta (k, v, at) VALUES (?, ?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v, at = excluded.at').bind('orderwatch:' + b, JSON.stringify(keep), now).run();
    const wanted = fresh.filter((e) => cfg.trading[e.event] !== false);
    if (!wanted.length) continue;
    if (!rules) {
      const rows = (await env.DB.prepare("SELECT * FROM alerts WHERE active = 1 AND kind = 'order'").all().catch(() => ({ results: [] }))).results || [];
      rules = rows.map(ruleOf); rules.push(...standingRules(cfg, rules, ['order']));
    }
    const items = [];
    for (const r of rules) for (const e of wanted) {
      if (r.symbol && r.symbol !== e.o.symbol) continue;
      const w = wordsOf(b, e.event, e.o);
      items.push({ rule: r, key: `${b}:${e.key}`, kind: 'order', symbol: e.o.symbol, title: w.title, body: w.body, url: PAGE_URL + '#alert=trading:' + b });
    }
    out.brokers[b].fired = await fire(env, items, cfg, now, { send });
  }
  return out;
}
