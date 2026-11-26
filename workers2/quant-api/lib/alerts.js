// Alerts (A1-Priv docs/TradeHub/quant/phase-14.md): the rules, the minute
// check, dedupe, cooldown, hysteresis, quiet hours, and the push to Tony's
// devices through taskhub-reminders' POST /quant-push. All state in D1
// (`alerts`, `alert_fires`, meta rows `alert_cfg` and `alert_catalysts`); no KV.
//
// Routes (all need the Orca key)
//   GET    /alerts[?symbol=X]       { alerts, config }            rules in Tony's order
//   POST   /alerts { alert }        add or change one (same id); at most 200
//   DELETE /alerts?id=              remove one
//   POST   /alerts/order { ids }    Tony's order (Control ▸ Alerts, A1 drag)
//   GET    /alerts/fires?limit=50[&before=id][&kinds=a,b][&unread=1]   { fires, unseen, more }   newest first: the
//                                    notification center (C3: pages back with before=, every alert AND every test send)
//   POST   /alerts/seen { upTo? | ids? }   marked read: up to what the page showed, or just those (one, a group)
//   POST   /alerts/clear { ids | all }     cleared from the center (kept as a tombstone, so it can never fire again)
//   GET/PUT /alerts/config          kinds on/off, quiet hours, market hours only, per-ticker mute, TaskHub cards
//   PUT    /alerts/catalysts { items }   the next high-impact releases for held or watched tickers (from the page)
//   POST   /alerts/test             a test push → { sent, failed, devices }
//   POST   /alerts/check?force=1    run the check now (the cron's work; force = also outside a session)
//
// The check (cron, every minute): returns at once unless New York is in a
// session (04:00 to 20:00 on a trading day). Then ONE read of the enabled rules,
// ONE read of the config + catalysts + provider health + today's usage, at most
// ONE batched quote call (the Phase 1 chain) for the symbols of enabled price
// rules, and evaluation in memory. D1 writes happen only when an alert fires,
// or when a price rule's state moves (a cross waiting for its second check, a
// re-arm): never on a quiet minute. Signal, graded and regime alerts are raised
// when the runner or the page writes those records (raise()), not by polling.
import { fail, json } from './http.js';
import { symOf, bodyOf } from './charts.js';
import { nyClock } from './time.js';
import { isTradingDay } from './holidays.js';
import { Ledger, CAPS, day as utcDay } from './ledger.js';
import { getQuotes } from './data.js';

export const KINDS = ['price', 'signal', 'graded', 'regime', 'catalyst', 'data', 'order', 'cortex'];   // N8: cortex = Neo Cortex (quant-bot's outbox, lib/cortex-alerts.js). T7: order = a paper order filled, partly filled, cancelled or rejected (lib/order-watch.js)
export const DIRS = ['above', 'below', 'cross', 'enter'];
export const ALERTS_MAX = 200, COOLDOWN_MIN = 30, HYST_ATR = 0.3, ATR_GUESS = 0.01, FIRES_MAX = 200;
export const PUSH_URL = 'https://taskhub-reminders.av1.workers.dev';
export const PAGE_URL = 'https://a1-priv.av1.workers.dev/tradehub.html';
export const DEFAULT_CFG = Object.freeze({
  kinds: { price: true, signal: true, graded: true, regime: true, catalyst: true, data: true, order: true, cortex: true },
  quiet: { on: false, from: '22:00', to: '07:00', tz: 'America/Denver' },
  // "Market hours only": outside a New York session the alert is listed in the bell, not pushed.
  marketOnly: { price: true, signal: false, graded: false, regime: false, catalyst: false, data: true, order: false, cortex: false },
  mute: {},                              // { SYM: until ms (0 = until unmuted) }
  cards: { price: false, signal: false, graded: true, regime: false, catalyst: true, data: false, order: false, cortex: false },
  // T7: which order events and which brokers alert (Control ▸ Alerts ▸ Trading). His own cancels stay quiet by default.
  trading: { filled: true, partial: true, canceled: false, rejected: true, alpaca: true, webull: true },
  // N8: which Neo Cortex alerts are pushed (Control ▸ Alerts ▸ Neo Cortex); all on by default.
  cortex: { trades: true, changes: true, guards: true, research: true, brief: true },
  speak: true,                           // the page speaks a new alert when voice allows it
});
const ID_RE = /^[\w-]{1,64}$/, HHMM = /^([01]\d|2[0-3]):[0-5]\d$/, SETUP_RE = /^[a-z][a-z-]{1,23}$/;
const noTable = (e) => /no such (table|column)|has no column/i.test(String((e && e.message) || e));
const notYet = () => fail(503, 'the alerts tables are not there yet (D1 migration 0013_alerts.sql)');
const clip = (v, n) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, n));
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);
const parse = (s, d) => { if (!s) return d; try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
const fmtPx = (x) => (x == null ? '' : Number(x) >= 100 ? Number(x).toFixed(2) : String(Math.round(Number(x) * 10000) / 10000));

/* ── time ───────────────────────────────────────────────────────────────── */
/** True from 04:00 to 20:00 New York on a trading day (holidays known). */
export function inSession(ms) {
  const c = nyClock(ms);
  return c.minutes >= 240 && c.minutes < 1200 && isTradingDay(c.date);
}
const tzFmt = new Map();
function minutesIn(tz, ms) {
  let f = tzFmt.get(tz);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return minutesIn('America/New_York', ms); }
    tzFmt.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}
/** Is `ms` inside the quiet hours (which may run past midnight)? */
export function isQuiet(cfg, ms) {
  const q = cfg && cfg.quiet;
  if (!q || !q.on || !HHMM.test(q.from || '') || !HHMM.test(q.to || '')) return false;
  const m = minutesIn(q.tz || 'America/New_York', ms);
  const a = Number(q.from.slice(0, 2)) * 60 + Number(q.from.slice(3)), b = Number(q.to.slice(0, 2)) * 60 + Number(q.to.slice(3));
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/* ── config ─────────────────────────────────────────────────────────────── */
/** The stored config over the defaults, every field checked. */
export function configOf(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const bools = (src, def) => Object.fromEntries(Object.keys(def).map((k) => [k, src && typeof src[k] === 'boolean' ? src[k] : def[k]]));
  const q = c.quiet || {};
  let tz = typeof q.tz === 'string' ? q.tz.slice(0, 60) : DEFAULT_CFG.quiet.tz;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch (e) { tz = DEFAULT_CFG.quiet.tz; }
  const mute = {};
  for (const [k, v] of Object.entries((c.mute && typeof c.mute === 'object') ? c.mute : {}).slice(0, 100)) {
    const s = String(k).toUpperCase();
    if (/^\^?[A-Z0-9][A-Z0-9.\-=]{0,14}$/.test(s) && Number.isFinite(Number(v)) && Number(v) >= 0) mute[s] = Number(v);
  }
  return {
    kinds: bools(c.kinds, DEFAULT_CFG.kinds),
    quiet: { on: q.on === true, from: HHMM.test(q.from || '') ? q.from : DEFAULT_CFG.quiet.from, to: HHMM.test(q.to || '') ? q.to : DEFAULT_CFG.quiet.to, tz },
    marketOnly: bools(c.marketOnly, DEFAULT_CFG.marketOnly),
    mute,
    cards: bools(c.cards, DEFAULT_CFG.cards),
    trading: bools(c.trading, DEFAULT_CFG.trading),
    cortex: bools(c.cortex, DEFAULT_CFG.cortex),
    speak: typeof c.speak === 'boolean' ? c.speak : DEFAULT_CFG.speak,
  };
}
export const isMuted = (cfg, sym, now) => {
  if (!sym || !cfg.mute) return false;
  const u = cfg.mute[sym];
  return u != null && (u === 0 || u > now);
};

/* ── rules ──────────────────────────────────────────────────────────────── */
/** A stored row → the rule the page and the check use. Phase 4's rows (kind
 *  'price' a line, 'level' a ranked level or zone, no params) read as price
 *  rules: a line fires on a cross either way, a zone when price enters it. */
export function ruleOf(r) {
  const p = parse(r.params, {}) || {};
  const legacy = r.kind === 'level' || r.kind === 'price';
  const kind = legacy ? 'price' : r.kind;
  const params = kind === 'price'
    ? { ...p, price: r.price, lo: r.lo, hi: r.hi, dir: DIRS.includes(p.dir) ? p.dir : (r.price == null && r.lo != null && r.hi != null ? 'enter' : 'cross'), holds: p.holds === true }
    : p;
  return {
    id: r.id, kind, symbol: r.symbol && r.symbol !== '*' ? r.symbol : null, params,
    price: r.price, lo: r.lo, hi: r.hi, level: r.level, note: r.note,
    enabled: r.active !== 0, cooldownMin: r.cooldown_min == null ? COOLDOWN_MIN : r.cooldown_min, quiet: !!r.quiet,
    ord: r.ord == null ? null : r.ord, created: r.created, at: r.at, firedAt: r.fired_at || null,
    state: parse(r.state, {}) || {},
  };
}
const isZone = (p) => p.price == null && p.lo != null && p.hi != null;
/** Which side of the rule's price or zone `px` is on: 'above' | 'below' | 'in' (zone) | null (exactly on a line). */
export function sideOf(p, px) {
  if (isZone(p)) return px < p.lo ? 'below' : px > p.hi ? 'above' : 'in';
  return px > p.price ? 'above' : px < p.price ? 'below' : null;
}
function wanted(p, from, to) {
  if (p.dir === 'enter') return to === 'in';
  if (p.dir === 'above') return to === 'above';
  if (p.dir === 'below') return to === 'below';
  return from != null && to !== from;          // cross: any change of side
}
/** Has price moved back far enough (HYST_ATR × ATR past the level or zone edge, away from where it fired) to re-arm? */
function rearms(p, fired, px) {
  const ref = isZone(p) ? null : p.price, atr = Number(p.atr) > 0 ? Number(p.atr) : Math.abs(ref != null ? ref : (p.lo + p.hi) / 2) * ATR_GUESS;
  const band = HYST_ATR * atr;
  if (!isZone(p)) return fired === 'above' ? px < ref - band : px > ref + band;
  if (fired === 'in') return px < p.lo - band || px > p.hi + band;
  if (fired === 'above') return px < p.hi - band;
  return px > p.lo + band;
}
/**
 * One price check, pure. → { fire, key, side, state, changed }.
 * The first check only learns the side. A cross the rule wants fires at once,
 * or with `holds` on the SECOND check in a row past it. After a fire the rule
 * is disarmed until price moves HYST_ATR × ATR back; each re-arm is a new
 * generation, so its trigger key is new (alert_fires keeps one row per key).
 */
export function evalPrice(rule, px) {
  // The key carries the rule's edit time (`at`): an edit resets the state to generation 0, and
  // without it the new px:0 keys would collide with fires stored before the edit (review, 2026-11-16).
  const ver = rule.at ? Number(rule.at).toString(36) + ':' : '';
  const p = rule.params, s0 = rule.state || {};
  const s = { side: s0.side || null, pend: s0.pend || null, armed: s0.armed !== false, gen: s0.gen || 0, fired: s0.fired || null };
  if (s0.retry) s.retry = s0.retry;
  const norm = (st) => JSON.stringify([st.side || null, st.pend || null, st.armed !== false, st.gen || 0, st.fired || null]);
  const out = (fire, st, key) => ({ fire, key: key || null, state: st, changed: norm(st) !== norm(s0) });
  if (!Number.isFinite(px)) return out(false, s0);
  const to = sideOf(p, px);
  if (!s.armed) {
    if (rearms(p, s.fired, px)) return out(false, { ...s, armed: true, gen: s.gen + 1, side: to, pend: null, fired: null });
    return out(false, s0);
  }
  if (!to) return out(false, s0);
  if (s.side == null) return out(false, { ...s, side: to, pend: null });
  if (to === s.side) return s.pend ? out(false, { ...s, pend: null }) : out(false, s0);
  if (!wanted(p, s.side, to)) return out(false, { ...s, side: to, pend: null });
  if (p.holds && s.pend !== to) return out(false, { ...s, pend: to });
  return out(true, { ...s, side: to, pend: null, armed: false, fired: to }, 'px:' + ver + s.gen + ':' + to);
}

/** A rule from the page, checked → the row's values, or a thrown 400. */
export function checkRule(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw fail(400, 'alert is needed');
  // 'level' stays as Phase 4 stored it (a ranked level's bell); it reads as a price rule.
  const kind = a.kind == null ? 'price' : String(a.kind);
  if (kind !== 'level' && !KINDS.includes(kind)) throw fail(400, 'kind must be one of ' + KINDS.join(' '));
  if (kind === 'cortex') throw fail(400, 'Neo Cortex alerts have no rules: they are switched in Control ▸ Alerts ▸ Neo Cortex');
  const p0 = a.params && typeof a.params === 'object' && !Array.isArray(a.params) ? a.params : {};
  const params = {};
  let symbol = '*', price = null, lo = null, hi = null;
  if (kind === 'price' || kind === 'level') {
    symbol = symOf(a.symbol);
    price = num(a.price ?? p0.price); lo = num(a.lo ?? p0.lo); hi = num(a.hi ?? p0.hi);
    if ([price, lo, hi].some(Number.isNaN)) throw fail(400, 'price, lo and hi must be numbers');
    if (price == null && (lo == null || hi == null)) throw fail(400, 'a price, or lo and hi, is needed');
    if (price != null && !(price > 0)) throw fail(400, 'price must be above 0');
    if (price == null && !(lo > 0 && hi >= lo)) throw fail(400, 'lo and hi must be prices, lo first');
    const dir = p0.dir == null ? (a.dir == null ? null : String(a.dir)) : String(p0.dir);
    if (dir != null) { if (!DIRS.includes(dir)) throw fail(400, 'dir must be one of ' + DIRS.join(' ')); params.dir = dir; }
    if (params.dir === 'enter' && price != null) throw fail(400, '"enter" needs a zone (lo and hi)');
    if (p0.holds === true || a.holds === true) params.holds = true;
    const atr = num(p0.atr ?? a.atr);
    if (atr != null && !Number.isNaN(atr) && atr > 0) params.atr = atr;
  } else if (kind === 'signal' || kind === 'graded') {
    if (a.symbol != null && a.symbol !== '' && a.symbol !== '*') symbol = symOf(a.symbol);
    if (kind === 'signal') {
      if (p0.setup != null && p0.setup !== '') { if (!SETUP_RE.test(String(p0.setup))) throw fail(400, 'setup is not valid'); params.setup = String(p0.setup); }
      if (p0.horizon != null && p0.horizon !== '') { if (!['day', 'swing', 'invest'].includes(p0.horizon)) throw fail(400, 'horizon must be day, swing or invest'); params.horizon = p0.horizon; }
    }
  } else if (kind === 'catalyst') {
    if (a.symbol != null && a.symbol !== '' && a.symbol !== '*') symbol = symOf(a.symbol);
    const m = num(p0.minutes);
    params.minutes = m == null || Number.isNaN(m) ? 15 : Math.max(1, Math.min(240, Math.round(m)));
  } else if (kind === 'data') {
    const d = num(p0.downMin), b = num(p0.budgetPct);
    params.downMin = d == null || Number.isNaN(d) ? 10 : Math.max(5, Math.min(120, Math.round(d)));
    params.budgetPct = b == null || Number.isNaN(b) ? 70 : Math.max(10, Math.min(100, Math.round(b)));
  }
  const cd = num(a.cooldownMin);
  const id = a.id == null ? crypto.randomUUID() : String(a.id);
  if (!ID_RE.test(id)) throw fail(400, 'a bad id');
  return {
    id, symbol, kind, price, lo, hi, level: clip(a.level, 40), note: clip(a.note, 200),
    active: a.active === false || a.enabled === false ? 0 : 1,
    params: Object.keys(params).length ? JSON.stringify(params) : null,
    cooldown_min: cd == null || Number.isNaN(cd) ? null : Math.max(0, Math.min(1440, Math.round(cd))),
    quiet: a.quiet === true ? 1 : 0,
  };
}

/* ── routes ─────────────────────────────────────────────────────────────── */
export async function readCfg(env) {
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'alert_cfg'").first();
  return configOf(row ? parse(row.v, {}) : {});
}
const putMeta = (env, k, v, at) => env.DB.prepare('INSERT INTO meta (k, v, at) VALUES (?, ?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v, at = excluded.at').bind(k, v, at);
const ORDER = ' ORDER BY (ord IS NULL), ord, created DESC';
/** GET /alerts[?symbol=X]: the rules, in Tony's order (newest first where he set none), and the config. */
export async function getAlerts(env, url) {
  const s = url.searchParams.get('symbol');
  const rows = s ? (await env.DB.prepare('SELECT * FROM alerts WHERE symbol = ?' + ORDER).bind(symOf(s)).all()).results
    : (await env.DB.prepare('SELECT * FROM alerts' + ORDER + ' LIMIT ?').bind(ALERTS_MAX).all()).results;
  let config = configOf({}), missing = false;
  try { config = await readCfg(env); } catch (e) { if (!noTable(e)) throw e; }
  const alerts = (rows || []).map((r) => {
    try { const x = ruleOf(r); delete x.state; return x; } catch (e) { return null; }
  }).filter(Boolean);
  if (rows && rows.length && !('params' in rows[0])) missing = true;
  return json({ ok: true, alerts, config, ...(missing ? { missing: true } : {}) });
}
/** POST /alerts { alert }: add one, or change it (same id; created, order and state stay). */
export async function putAlert(env, req) {
  const body = await bodyOf(req, 4000);
  const x = checkRule(body && body.alert);
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM alerts WHERE id != ?').bind(x.id).first();
  if (n && n.n >= ALERTS_MAX) throw fail(400, 'at most ' + ALERTS_MAX + ' alerts');
  const now = Date.now();
  try {
    await env.DB.prepare('INSERT INTO alerts (id, symbol, kind, price, lo, hi, level, note, active, created, at, params, cooldown_min, quiet) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT (id) DO UPDATE SET symbol = excluded.symbol, kind = excluded.kind, price = excluded.price, lo = excluded.lo, hi = excluded.hi, '
      + 'level = excluded.level, note = excluded.note, active = excluded.active, at = excluded.at, params = excluded.params, cooldown_min = excluded.cooldown_min, quiet = excluded.quiet, '
      // A rule whose price, zone or direction changed starts over (its old side means nothing now).
      + 'state = CASE WHEN alerts.price IS excluded.price AND alerts.lo IS excluded.lo AND alerts.hi IS excluded.hi AND alerts.params IS excluded.params THEN alerts.state ELSE NULL END')
      .bind(x.id, x.symbol, x.kind, x.price, x.lo, x.hi, x.level, x.note, x.active, now, now, x.params, x.cooldown_min, x.quiet).run();
  } catch (e) { if (noTable(e)) throw notYet(); throw e; }
  return json({ ok: true, id: x.id });
}
/** DELETE /alerts?id=: remove one (its fires stay in the list). */
export async function deleteAlert(env, url) {
  const id = String(url.searchParams.get('id') || '');
  if (!ID_RE.test(id)) throw fail(400, 'id= is needed');
  await env.DB.prepare('DELETE FROM alerts WHERE id = ?').bind(id).run();
  return json({ ok: true, id });
}
/** POST /alerts/order { ids }: Tony's order; one batch of updates. */
export async function orderAlerts(env, req) {
  const b = await bodyOf(req, 20_000);
  const ids = Array.isArray(b && b.ids) ? b.ids.map(String) : null;
  if (!ids || !ids.length || ids.length > ALERTS_MAX || !ids.every((i) => ID_RE.test(i))) throw fail(400, 'ids is needed');
  const stmts = ids.map((id, i) => env.DB.prepare('UPDATE alerts SET ord = ? WHERE id = ?').bind(i, id));
  try { if (env.DB.batch) await env.DB.batch(stmts); else for (const s of stmts) await s.run(); } catch (e) { if (noTable(e)) throw notYet(); throw e; }
  return json({ ok: true, n: ids.length });
}
// C3 (Tony 2026-11-21, the notification center): `seen` 0 unread, 1 read, CLEARED a fire Tony cleared. A cleared row
// stays (hidden) until the trim, because (rule_id, trigger_key) is what stops a trigger firing twice: deleting it
// would let the same signal or catalyst push again. Test sends are kept too, under rule TEST_RULE.
export const CLEARED = 2, TEST_RULE = 'test', KEEP_DAYS = 45, KEEP_MIN = 500, KEEP_MAX = 5000;
const FIRE_KINDS = [...KINDS, 'test'];
const fireOut = (r) => ({ ...r, devices: parse(r.devices, []), seen: !!r.seen, test: r.rule_id === TEST_RULE });
/** GET /alerts/fires?limit=50[&before=<id>][&kinds=price,signal][&unread=1]: newest first, the unread count, and
 *  `more` when an older page is there (the center asks for it with before = the last id it has). */
export async function getFires(env, url) {
  const q = url.searchParams;
  const n = Math.max(1, Math.min(FIRES_MAX, Number(q.get('limit')) || 50));
  const before = Number(q.get('before'));
  const kinds = String(q.get('kinds') || '').split(',').map((k) => k.trim()).filter((k) => FIRE_KINDS.includes(k));
  const where = ['seen < ' + CLEARED], args = [];
  if (Number.isFinite(before) && before > 0) { where.push('id < ?'); args.push(before); }
  if (kinds.length) { where.push('kind IN (' + kinds.map(() => '?').join(',') + ')'); args.push(...kinds); }
  if (q.get('unread') === '1') where.push('seen = 0');
  try {
    // id order is arrival order (AUTOINCREMENT), so before= pages cleanly even when two fires share a millisecond.
    const rows = (await env.DB.prepare('SELECT * FROM alert_fires WHERE ' + where.join(' AND ') + ' ORDER BY id DESC LIMIT ?').bind(...args, n + 1).all()).results || [];
    const u = await env.DB.prepare('SELECT COUNT(*) AS n FROM alert_fires WHERE seen = 0').first();
    return json({ ok: true, fires: rows.slice(0, n).map(fireOut), unseen: (u && u.n) || 0, more: rows.length > n });
  } catch (e) { if (noTable(e)) return json({ ok: true, fires: [], unseen: 0, more: false, missing: true }); throw e; }
}
const idsOf = (b) => (Array.isArray(b && b.ids) ? b.ids.map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 500) : null);
/** The trim (runs with seen/clear): rows older than KEEP_DAYS go once more than KEEP_MIN are kept; never more than KEEP_MAX. */
const trimStmts = (env, now) => [
  env.DB.prepare('DELETE FROM alert_fires WHERE at < ? AND id NOT IN (SELECT id FROM alert_fires ORDER BY id DESC LIMIT ?)').bind(now - KEEP_DAYS * 86400_000, KEEP_MIN),
  env.DB.prepare('DELETE FROM alert_fires WHERE id NOT IN (SELECT id FROM alert_fires ORDER BY id DESC LIMIT ?)').bind(KEEP_MAX),
];
/** POST /alerts/clear { ids } | { all: true }: cleared from the center (Tony confirms on the page first). */
export async function clearFires(env, req, now = Date.now()) {
  const b = await bodyOf(req, 20_000);
  const ids = idsOf(b);
  if (!(b && b.all === true) && !(ids && ids.length)) throw fail(400, 'ids or all is needed');
  const stmts = [b.all === true ? env.DB.prepare('UPDATE alert_fires SET seen = ? WHERE seen < ?').bind(CLEARED, CLEARED)
    : env.DB.prepare('UPDATE alert_fires SET seen = ? WHERE id IN (' + ids.map(() => '?').join(',') + ')').bind(CLEARED, ...ids), ...trimStmts(env, now)];
  try { if (env.DB.batch) await env.DB.batch(stmts); else for (const x of stmts) await x.run(); } catch (e) { if (noTable(e)) throw notYet(); throw e; }
  const u = await env.DB.prepare('SELECT COUNT(*) AS n FROM alert_fires WHERE seen = 0').first();
  return json({ ok: true, cleared: b.all === true ? 'all' : ids.length, unseen: (u && u.n) || 0 });
}
/** POST /alerts/seen: marked read (one write; also the trim, C3: at least KEEP_DAYS days of history). */
export async function seenFires(env, req, now = Date.now()) {
  // upTo: the newest fire the page showed; a fire that arrived after that stays unseen. ids: just those (C3).
  let upTo = null, ids = null;
  try { const b = req ? await req.json() : null; if (b && Number.isFinite(Number(b.upTo))) upTo = Number(b.upTo); ids = idsOf(b); } catch (e) {}
  if (ids && !ids.length) return json({ ok: true });   // { ids: [] } marks nothing (never "everything")
  try {
    const mark = ids && ids.length ? env.DB.prepare('UPDATE alert_fires SET seen = 1 WHERE seen = 0 AND id IN (' + ids.map(() => '?').join(',') + ')').bind(...ids)
      : upTo == null ? env.DB.prepare('UPDATE alert_fires SET seen = 1 WHERE seen = 0') : env.DB.prepare('UPDATE alert_fires SET seen = 1 WHERE seen = 0 AND id <= ?').bind(upTo);
    const stmts = [mark, ...trimStmts(env, now)];
    if (env.DB.batch) await env.DB.batch(stmts); else for (const s of stmts) await s.run();
  } catch (e) { if (noTable(e)) throw notYet(); throw e; }
  return json({ ok: true });
}
export async function getConfig(env) {
  try { return json({ ok: true, config: await readCfg(env) }); } catch (e) { if (noTable(e)) return json({ ok: true, config: configOf({}) }); throw e; }
}
/** PUT /alerts/config { config }: stored checked, over the defaults. One write. */
export async function putConfig(env, req) {
  const b = await bodyOf(req, 12_000);
  if (!b || typeof b.config !== 'object' || !b.config || Array.isArray(b.config)) throw fail(400, 'config is needed');
  const c = configOf(b.config);
  await putMeta(env, 'alert_cfg', JSON.stringify(c), Date.now()).run();
  return json({ ok: true, config: c });
}
/** PUT /alerts/catalysts { items: [{ id, t, title, symbols, impact }] }: the next
 *  high-impact releases for held or watched tickers (the page filters them; it
 *  sends only when the list changed). Past ones and more than 14 days out are dropped. */
export const CATALYSTS_MAX = 60;
export async function putCatalysts(env, req) {
  const b = await bodyOf(req, 40_000), now = Date.now();
  if (!Array.isArray(b && b.items)) throw fail(400, 'items is needed');
  const items = b.items.filter((x) => x && Number.isFinite(Number(x.t)) && Number(x.t) > now && Number(x.t) < now + 14 * 86400_000 && x.title)
    .slice(0, CATALYSTS_MAX)
    .map((x) => ({ id: clip(x.id, 80) || String(Math.round(Number(x.t))) + ':' + clip(x.title, 40), t: Math.round(Number(x.t)), title: clip(x.title, 120),
      symbols: Array.isArray(x.symbols) ? x.symbols.map((s) => String(s).toUpperCase()).filter((s) => /^\^?[A-Z0-9][A-Z0-9.\-=]{0,14}$/.test(s)).slice(0, 20) : [],
      impact: x.impact === 'high' ? 'high' : 'medium' }));
  await putMeta(env, 'alert_catalysts', JSON.stringify(items), now).run();
  return json({ ok: true, n: items.length });
}

/* ── the push ───────────────────────────────────────────────────────────── */
/** One message to Tony's devices through taskhub-reminders → { ok, sent, failed, devices } or { ok:false, error }. */
export async function push(env, msg) {
  if (!env.PUSH_SECRET) return { ok: false, error: 'PUSH_SECRET is not set on quant-api' };
  try {
    const r = await fetch((env.PUSH_URL || PUSH_URL).replace(/\/+$/, '') + '/quant-push', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-quant-secret': env.PUSH_SECRET },
      body: JSON.stringify({ title: msg.title, body: msg.body || '', url: msg.url || PAGE_URL, tag: msg.tag || 'tbq', ...(msg.card ? { card: true, kind: msg.kind || 'alert' } : {}) }),
    });
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok || j.ok === false) return { ok: false, error: j.error || 'HTTP ' + r.status };
    return { ok: (j.sent || 0) > 0, sent: j.sent || 0, failed: j.failed || 0, devices: Array.isArray(j.devices) ? j.devices : [], ...(j.ms ? { ms: j.ms } : {}), ...(j.sent ? {} : { error: 'no device received it' }) };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}
/** A test send kept in the center (C3: Brave on the PC keeps nothing, so TradeHub is the record). Never fails the send. */
export async function keepTest(env, t, now, key) {
  try {
    await env.DB.prepare('INSERT INTO alert_fires (rule_id, trigger_key, at, kind, symbol, title, body, url, pushed, why, devices) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (rule_id, trigger_key) DO NOTHING')
      .bind(TEST_RULE, key, now, t.kind, t.symbol || null, clip(t.title, 140), clip(t.body, 400), t.url || PAGE_URL, t.res.ok ? 1 : 0, t.res.ok ? null : clip(t.res.error, 200), JSON.stringify(t.res.devices || [])).run();
  } catch (e) { /* the table not there yet: the send still counts */ }
}
const symOfTitle = (t) => { const m = /^(?:\[Test\] )?(?:New GO: )?([A-Z]{1,6})\b/.exec(t || ''); return m && !['CPI', 'Regime'].includes(m[1]) ? m[1] : null; };
/** POST /alerts/test: "Send test" in Control ▸ Alerts. */
export async function testPush(env, now = Date.now()) {
  const r = await push(env, { title: 'TradeHub test alert', body: 'If you can read this, alerts reach this device.', url: PAGE_URL + '#alert=alerts', tag: 'tbq-test-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) });
  await keepTest(env, { kind: 'test', title: 'TradeHub test alert', body: 'If you can read this, alerts reach this device.', url: PAGE_URL + '#alert=alerts', res: r }, now, 'one-' + now.toString(36) + Math.random().toString(36).slice(2, 6));
  // Each test its own tag: one tag for every test made the second REPLACE the first, silently (Tony, 2026-11-16).
  return json({ ok: r.ok, sent: r.sent || 0, failed: r.failed || 0, devices: r.devices || [], ...(r.ms ? { ms: r.ms } : {}), ...(r.error ? { error: r.error } : {}) });
}
export const pageUrl = (route) => PAGE_URL + '#alert=' + route;

/** B10: one example of every kind, in the words the real alert uses, marked "[Test]". */
export const TEST_KINDS = [
  { kind: 'price', what: 'price crossed above', title: 'NVDA crossed above R1 172.30', body: 'NVDA 172.41', url: 'chart:NVDA' },
  { kind: 'price', what: 'price crossed below', title: 'NVDA crossed below S1 166.40', body: 'NVDA 166.31', url: 'chart:NVDA' },
  { kind: 'price', what: 'zone entered', title: 'AMD entered the zone 160.10–161.00', body: 'AMD 160.55', url: 'chart:AMD' },
  { kind: 'price', what: 'holds (two checks)', title: 'MU crossed above 650.00', body: 'MU 651.20, held for two checks', url: 'chart:MU' },
  { kind: 'signal', what: 'new GO', title: 'New GO: AMD breakout', body: 'long swing, entry 162.50, stop 157.80', url: 'scanner' },
  { kind: 'graded', what: 'a taken signal hit target 1', title: 'AMD hit target 1', body: 'The breakout signal you took: +1.7R', url: 'scanner' },
  { kind: 'graded', what: 'a taken signal hit its stop', title: 'TSLA hit its stop', body: 'The vwap-reclaim signal you took: -1R', url: 'scanner' },
  { kind: 'regime', what: 'regime change', title: 'Regime: Constructive → Risk-off', body: 'At the midday snapshot', url: 'market' },
  { kind: 'catalyst', what: 'catalyst coming up', title: 'CPI in 15 min', body: 'For NVDA, AMD, MU', url: 'catalysts' },
  { kind: 'data', what: 'a data provider down', title: 'alpaca is down for 12 min', body: 'TradeHub Quant falls through to the next source.', url: 'status' },
  { kind: 'data', what: 'a budget past 70%', title: 'groq at 72% of today\'s budget', body: '72 of 100 calls', url: 'status' },
  { kind: 'order', what: 'a paper order filled (T7)', title: 'Filled: Buy 10 NVDA at 164.20', body: 'Alpaca paper · limit order', url: 'trading:alpaca' },
];
/** POST /alerts/test-all: B10's "Send every kind once" in Control ▸ Alerts. Each goes through the real push route to
 *  Tony's devices only (taskhub-reminders /quant-push), one notification each, with what quiet hours, "market hours
 *  only" and the kind switch WOULD do right now reported beside it (a test is always sent, so he sees every text). */
// Spaced out (Tony 2026-11-21: the phone showed 8 of 11): Android drops a burst of notifications from one app (its
// enqueue limit is about 5 a second), so the 12 go 700 ms apart, about 8 s in all.
export const TEST_GAP_MS = 700;
// `only`: positions in TEST_KINDS (0-11) to send just those again (B10's tap check, 2026-11-21); absent = all 12.
export async function testAll(env, now = Date.now(), { send = push, gap = env.TEST_GAP_MS != null ? Number(env.TEST_GAP_MS) : TEST_GAP_MS, only = null } = {}) {
  const cfg = await readCfg(env), run = now.toString(36), out = [];
  const pick = Array.isArray(only) && only.length ? new Set(only.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < TEST_KINDS.length)) : null;
  for (const [i, t] of TEST_KINDS.entries()) {
    if (pick && !pick.has(i)) continue;
    if (out.length && gap) await new Promise((r) => setTimeout(r, gap));
    const would = cfg.kinds[t.kind] === false ? 'kind is off' : isQuiet(cfg, now) ? 'quiet hours' : cfg.marketOnly[t.kind] && !inSession(now) ? 'outside market hours' : null;
    const r = await send(env, { title: '[Test] ' + t.title, body: t.body, url: pageUrl(t.url), tag: 'tbq-tall-' + run + '-' + i, card: false, kind: t.kind });
    await keepTest(env, { kind: t.kind, symbol: symOfTitle(t.title), title: '[Test] ' + t.title, body: t.body, url: pageUrl(t.url), res: r }, Date.now(), 'all-' + run + '-' + i);
    out.push({ kind: t.kind, what: t.what, title: '[Test] ' + t.title, body: t.body, ok: !!r.ok, devices: r.devices || [], error: r.ok ? null : r.error || null, normally: would || 'pushed' });
  }
  return json({ ok: out.every((x) => x.ok), sent: out.filter((x) => x.ok).length, of: out.length, results: out, notPushed: ['strategy pauses'] });
}
/** A short, stable notification tag for a rule's trigger. */
export function tagOf(str) { let a = 5381, b = 52711; for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); a = (a * 33) ^ c; b = (b * 33) ^ c; } return (a >>> 0).toString(36) + (b >>> 0).toString(36); }

/* ── firing ─────────────────────────────────────────────────────────────── */
/**
 * Fire what the check or a write found. Each item: { rule, key, kind, symbol,
 * title, body, url, state? }. Per rule: the kind switched off → nothing; inside
 * its cooldown → nothing (a price rule then tries again next minute). A rule
 * never fires twice for one key (alert_fires unique). Muted ticker, a quiet
 * rule, quiet hours or "market hours only" outside a session → listed, not
 * pushed. A failed send is kept on the rule and retried once on the next run.
 */
export async function fire(env, items, cfg, now, { send = push } = {}) {
  const out = [];
  const seenRule = new Set();
  for (const it of items) {
    const r = it.rule;
    if (cfg.kinds[it.kind] === false) continue;
    // One fire a run and the cooldown are about repeats around a price level. Signal, graded,
    // regime, catalyst and data alerts are distinct events, each deduped by its own key, so
    // three new GOs at once are three alerts (review, 2026-11-16).
    const priced = it.kind === 'price';
    if (priced && seenRule.has(r.id)) continue;
    if (priced && r.firedAt && r.cooldownMin > 0 && now - r.firedAt < r.cooldownMin * 60_000) continue;
    let why = null;
    if (isMuted(cfg, it.symbol, now)) why = 'muted';
    else if (r.quiet) why = 'quiet rule';
    else if (isQuiet(cfg, now)) why = 'quiet hours';
    else if (cfg.marketOnly[it.kind] && !inSession(now)) why = 'outside market hours';
    const ins = await env.DB.prepare('INSERT INTO alert_fires (rule_id, trigger_key, at, kind, symbol, title, body, url, pushed, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT (rule_id, trigger_key) DO NOTHING')
      .bind(r.id, it.key, now, it.kind, it.symbol || null, clip(it.title, 140), clip(it.body, 400), it.url || PAGE_URL, why).run();
    if (!ins || !ins.meta || ins.meta.changes !== 1) {          // fired for this trigger before
      // A price rule still moves on (disarmed), so it does not retry the same key every minute.
      if (priced && it.state) await env.DB.prepare('UPDATE alerts SET state = ? WHERE id = ?').bind(JSON.stringify(it.state), r.id).run();
      continue;
    }
    seenRule.add(r.id);
    const st = { ...(it.state || r.state || {}) };
    delete st.retry;
    let res = null;
    if (!why) {
      // A tag per rule AND trigger: each new alert is its own notification (one tag a rule made a new one replace the last).
      const msg = { title: it.title, body: it.body, url: it.url, tag: 'tbq-' + tagOf(r.id + '|' + it.key), card: !!cfg.cards[it.kind], kind: it.kind };
      res = await send(env, msg);
      if (!res.ok) st.retry = { key: it.key, ...msg };
      await env.DB.prepare('UPDATE alert_fires SET pushed = ?, why = ?, devices = ? WHERE rule_id = ? AND trigger_key = ?')
        .bind(res.ok ? 1 : 0, res.ok ? null : clip(res.error, 200), JSON.stringify(res.devices || []), r.id, it.key).run();
    }
    await env.DB.prepare('UPDATE alerts SET fired_at = ?, state = ? WHERE id = ?').bind(now, JSON.stringify(st), r.id).run();
    out.push({ rule: r.id, key: it.key, kind: it.kind, title: it.title, pushed: why ? null : !!(res && res.ok), why: why || (res && !res.ok ? res.error : null) });
  }
  return out;
}
/** The rules' retries from the last run: sent once more, then dropped either way. */
async function retry(env, rules, now, send) {
  const out = [];
  for (const r of rules) {
    const m = r.state && r.state.retry;
    if (!m) continue;
    const res = await send(env, m);
    const st = { ...r.state }; delete st.retry;
    r.state = st;
    await env.DB.prepare('UPDATE alerts SET state = ? WHERE id = ?').bind(JSON.stringify(st), r.id).run();
    await env.DB.prepare('UPDATE alert_fires SET pushed = ?, why = ?, devices = ? WHERE rule_id = ? AND trigger_key = ?')
      .bind(res.ok ? 1 : 0, res.ok ? null : clip('retried: ' + (res.error || ''), 200), JSON.stringify(res.devices || []), r.id, m.key).run();
    out.push({ rule: r.id, retried: true, pushed: !!res.ok });
  }
  return out;
}

/* ── standing rules (B10) ──────────────────────────────────────────────── */
// B0 found that every kind fired only through a rule in the table and nothing made one, so with every kind ticked
// "On" and no rules (Tony's screen) no signal, graded, regime, catalyst or data alert could ever reach him. Now a kind
// that is On and has no rule of Tony's gets a standing one, for every ticker, with the defaults. It lives only in the
// run (never written to the table); its fires are kept under its own id (`std:<kind>`), so each event still pushes once.
export const STANDING = { signal: null, graded: null, regime: null, catalyst: { minutes: 15 }, data: { downMin: 10, budgetPct: 70 }, order: null, cortex: null };
export function standingRules(cfg, rules, kinds = Object.keys(STANDING)) {
  const have = new Set(rules.map((r) => r.kind));
  return kinds.filter((k) => k in STANDING && cfg.kinds[k] !== false && !have.has(k))
    .map((k) => ruleOf({ id: 'std:' + k, kind: k, symbol: '*', params: STANDING[k] ? JSON.stringify(STANDING[k]) : null, active: 1, state: null, fired_at: null, cooldown_min: null, quiet: 0 }));
}

/* ── the check (cron) ───────────────────────────────────────────────────── */
const DIR_WORD = { above: 'crossed above', below: 'crossed below', in: 'entered', cross: 'crossed' };
function priceItem(r, q, ev) {
  const p = r.params, sym = r.symbol, where = isZone(p) ? `${fmtPx(p.lo)}–${fmtPx(p.hi)}` : fmtPx(p.price);
  const name = r.level ? r.level.split(' ')[0] + ' ' : '';
  const word = isZone(p) ? (ev.state.fired === 'in' ? 'entered the zone' : ev.state.fired === 'above' ? 'broke above the zone' : 'broke below the zone') : DIR_WORD[ev.state.fired];
  return { rule: r, key: ev.key, kind: 'price', symbol: sym, state: ev.state,
    title: `${sym} ${word} ${name}${where}`,
    body: `${sym} ${fmtPx(q.price)}${p.holds ? ', held for two checks' : ''}${r.note ? ' · ' + r.note : ''}`,
    url: pageUrl('chart:' + sym) };
}
/** The cron's work. → { skipped } or { rules, quotes, fired, writes }. */
export async function check(env, now = Date.now(), { force = false, send = push } = {}) {
  if (!force && !inSession(now)) return { skipped: 'closed' };
  // The first read: the rules the check evaluates, and any rule (signal, graded and regime
  // too) holding a failed send to retry. Before 0013 there is no `state` column: nothing to do.
  let rows;
  try { rows = (await env.DB.prepare("SELECT * FROM alerts WHERE active = 1 AND (kind IN ('price', 'level', 'catalyst', 'data') OR state LIKE '%\"retry\"%')").all()).results || []; }
  catch (e) { if (noTable(e)) return { skipped: 'no alerts table' }; throw e; }
  const rules = rows.map(ruleOf);
  // The second read: config, catalysts, provider health and today's usage, in one query (B10: read even with no rule
  // of Tony's, since a kind that is On now fires through its standing rule).
  const d = utcDay(now);
  const ctx = (await env.DB.prepare(
    "SELECT 'meta' AS t, k AS a, v AS b, at AS c, NULL AS d, NULL AS e, NULL AS f FROM meta WHERE k IN ('alert_cfg', 'alert_catalysts') "
    + "UNION ALL SELECT 'health', provider, ok, at, ok_at, skip_until, fails FROM provider_health "
    + "UNION ALL SELECT 'usage', service, n, NULL, NULL, NULL, NULL FROM usage WHERE day = ?").bind(d).all()).results || [];
  const meta = {}, health = {}, used = {};
  for (const x of ctx) {
    if (x.t === 'meta') meta[x.a] = x.b;
    else if (x.t === 'health') health[x.a] = { provider: x.a, ok: x.b, at: x.c, ok_at: x.d, skip_until: x.e, fails: x.f };
    else used[x.a] = x.b;
  }
  const cfg = configOf(parse(meta.alert_cfg, {}));
  rules.push(...standingRules(cfg, rules, ['catalyst', 'data']));
  if (!rules.length) return { rules: 0, fired: [] };
  const items = [], writes = [];
  const out = { rules: rules.length, quotes: 0, fired: [], retried: [] };
  out.retried = await retry(env, rules.filter((r) => r.state && r.state.retry), now, send);
  const live = rules.filter((r) => r.kind !== 'signal' && r.kind !== 'graded' && r.kind !== 'regime');
  // Price rules: one batched quote call for their symbols (the Phase 1 chain). The
  // ledger is read with the context above and not written back: these calls are
  // at most 960 a day and are not counted in /usage.
  const pr = cfg.kinds.price === false ? [] : live.filter((r) => r.kind === 'price' && r.symbol);
  if (pr.length) {
    const syms = [...new Set(pr.map((r) => r.symbol))].slice(0, 60);
    const L = new Ledger(env, now); L.used = used; L.health = health;
    let q = { quotes: {} };
    try { q = await getQuotes(L, env, syms, now); } catch (e) { console.warn('alerts quotes:', e.message || e); }
    out.quotes = 1;
    for (const r of pr) {
      const qt = q.quotes[r.symbol];
      if (!qt) continue;
      const ev = evalPrice(r, Number(qt.price));
      if (ev.fire) items.push(priceItem(r, qt, ev));
      else if (ev.changed) writes.push(env.DB.prepare('UPDATE alerts SET state = ? WHERE id = ?').bind(JSON.stringify(ev.state), r.id));
    }
  }
  // Catalysts: N minutes before a high-impact release for a held or watched ticker.
  const cats = parse(meta.alert_catalysts, []) || [];
  for (const r of live.filter((x) => x.kind === 'catalyst')) {
    const win = (r.params.minutes || 15) * 60_000;
    for (const c of cats) {
      if (!(c.t > now && c.t - now <= win) || c.impact !== 'high') continue;
      if (r.symbol && !(c.symbols || []).includes(r.symbol)) continue;
      const mins = Math.max(1, Math.round((c.t - now) / 60_000));
      items.push({ rule: r, key: 'cat:' + c.id, kind: 'catalyst', symbol: (c.symbols || [])[0] || null,
        title: `${c.title} in ${mins} min`, body: (c.symbols || []).length ? 'For ' + c.symbols.join(', ') : 'High impact', url: pageUrl('catalysts') });
    }
  }
  // Data: a provider down for N minutes in session; a service past N% of today's budget.
  for (const r of live.filter((x) => x.kind === 'data')) {
    const downMs = (r.params.downMin || 10) * 60_000;
    for (const h of Object.values(health)) {
      if (h.ok !== 0 || !h.at || now - h.at > 15 * 60_000) continue;     // its last answer failed, recently
      const since = h.ok_at || 0;
      if (since && now - since < downMs) continue;
      const mins = since ? Math.round((now - since) / 60_000) : null;
      items.push({ rule: r, key: 'down:' + h.provider + ':' + since, kind: 'data', symbol: null,
        title: `${h.provider} is down${mins ? ' for ' + mins + ' min' : ''}`, body: 'TradeHub Quant falls through to the next source.', url: pageUrl('status') });
    }
    for (const [svc, n] of Object.entries(used)) {
      const cap = CAPS[svc.split(':')[0]];
      if (!cap || n / cap * 100 < (r.params.budgetPct || 70)) continue;
      items.push({ rule: r, key: 'budget:' + svc + ':' + d, kind: 'data', symbol: null,
        title: `${svc} at ${Math.round(n / cap * 100)}% of today's budget`, body: `${n} of ${cap} calls`, url: pageUrl('status') });
    }
  }
  if (writes.length) { if (env.DB.batch) await env.DB.batch(writes); else for (const w of writes) await w.run(); }
  out.fired = await fire(env, items, cfg, now, { send });
  out.writes = writes.length;
  return out;
}

/* ── raised by writes (signal, graded, regime) ──────────────────────────── */
/**
 * The runner or the page just wrote records: raise the alerts they match.
 *   signal  events [{ id, symbol, setup, horizon, dir, verdict, entry, stop }]  new GO signals
 *   graded  events [{ id, symbol, setup, status, r }]   a signal he took hit a target or its stop
 *   regime  events [{ from, to, day, slot }]            the label changed
 * Reads: the enabled rules of that kind and the config (nothing more when there are none).
 */
export async function raise(env, kind, events, now = Date.now(), { send = push } = {}) {
  if (!events || !events.length) return [];
  let rows;
  try { rows = (await env.DB.prepare('SELECT * FROM alerts WHERE active = 1 AND kind = ?').bind(kind).all()).results || []; }
  catch (e) { if (noTable(e)) return []; throw e; }
  const cfg = await readCfg(env), rules = rows.map(ruleOf);
  rules.push(...standingRules(cfg, rules, [kind]));   // B10: On with no rule of Tony's = his standing rule
  if (!rules.length) return [];
  const items = [];
  for (const r of rules) for (const e of events) {
    if (kind === 'signal') {
      if (e.verdict !== 'GO') continue;
      if (r.symbol && r.symbol !== e.symbol) continue;
      if (r.params.setup && r.params.setup !== e.setup) continue;
      if (r.params.horizon && r.params.horizon !== e.horizon) continue;
      items.push({ rule: r, key: 'sig:' + e.id, kind, symbol: e.symbol, title: `New GO: ${e.symbol} ${e.setup}`,
        body: `${e.dir} ${e.horizon}${e.entry ? ', entry ' + fmtPx(e.entry) : ''}${e.stop ? ', stop ' + fmtPx(e.stop) : ''}`, url: pageUrl('signal:' + e.id) });
    } else if (kind === 'graded') {
      if (r.symbol && r.symbol !== e.symbol) continue;
      const hit = e.status === 'stopped' ? 'hit its stop' : e.status === 'target2' ? 'hit target 2' : 'hit target 1';
      items.push({ rule: r, key: 'gr:' + e.id + ':' + e.status, kind, symbol: e.symbol, title: `${e.symbol} ${hit}`,
        body: `The ${e.setup} signal you took${Number.isFinite(e.r) ? ': ' + (e.r > 0 ? '+' : '') + Math.round(e.r * 100) / 100 + 'R' : ''}`, url: pageUrl('signal:' + e.id) });
    } else if (kind === 'regime') {
      items.push({ rule: r, key: 'rg:' + e.day + ':' + e.slot + ':' + e.to, kind, symbol: null, title: `Regime: ${e.from} → ${e.to}`,
        body: `At the ${e.slot} snapshot`, url: pageUrl('market') });
    }
  }
  return fire(env, items, cfg, now, { send });
}
/** POST /alerts/check[?force=1]: the cron's work, on demand. */
export async function checkRoute(env, url) {
  return json({ ok: true, ...(await check(env, Date.now(), { force: url.searchParams.get('force') === '1' })) });
}
