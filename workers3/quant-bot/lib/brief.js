// N8: the daily brief (A1-Priv docs/TradeHub/quant/n4-08.md). Numbers by code at the close + 20 (16:20, 13:20 on a
// half day); Claude's review merged from the post-close strategist run (lab_runs) as soon as it lands; a plain template
// at the close + 75 (17:15) if it never does. The week's last trading day also carries the week's roll-up.
// Cost: one D1 read a tick from the close + 20 until the brief is ready, two writes and one Alpaca read a day.
import { nyClock, nyMidnight } from '../core/clock.js';
import { isTradingDay, addDays } from '../core/holidays.js';
import { closeOf } from './lifecycle.js';
import { readSettings, readBotState } from './state.js';
import { paperBroker } from './alpaca.js';
import { json } from './lab.js';

export const NUMBERS_AFTER = 20, CLAUDE_DEADLINE = 75;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (x) => Math.round(x * 100) / 100;
const money = (x) => (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2);
const pct = (x) => (x > 0 ? '+' : '') + x.toFixed(2) + '%';

/** Closed paper trades whose last fill landed in [from, to): { id, symbol, strategy, version, side, pnl, r, at }. */
export async function dayTrades(db, from, to) {
  const { results } = await db.prepare(
    "SELECT o.client_id, o.symbol, o.strategy, o.version, o.side, o.entry_price, o.stop, f.side AS fside, f.qty, f.price, f.ts FROM bot_order_intents o JOIN bot_fills f ON f.client_id = o.client_id " +
    "WHERE o.status = 'closed' AND o.client_id IN (SELECT client_id FROM bot_fills WHERE ts >= ? AND ts < ?) ORDER BY f.ts").bind(from, to).all();
  const by = new Map();
  for (const r of results) {
    const t = by.get(r.client_id) || { id: r.client_id, symbol: r.symbol, strategy: r.strategy, version: r.version, side: r.side, entry: r.entry_price, stop: r.stop, opened: 0, cash: 0, at: 0 };
    if ((r.side === 'long') === (r.fside === 'buy')) t.opened += r.qty;
    t.cash += (r.fside === 'sell' ? 1 : -1) * r.qty * r.price;
    t.at = Math.max(t.at, r.ts);
    by.set(r.client_id, t);
  }
  return [...by.values()].filter((t) => t.opened > 0 && t.at >= from && t.at < to).map((t) => {
    const risk = Math.abs(t.entry - t.stop) * t.opened;
    return { id: t.id, symbol: t.symbol, strategy: t.strategy, version: t.version, side: t.side, pnl: r2(t.cash), r: risk > 0 ? r2(t.cash / risk) : null, at: t.at };
  });
}

/** Trades → { trades, wins, winRate, pf, grossWin, grossLoss, best, worst }. */
export function tally(trades) {
  let wins = 0, gw = 0, gl = 0, best = null, worst = null;
  for (const t of trades) {
    if (t.pnl > 0) { wins++; gw += t.pnl; } else gl += -t.pnl;
    if (!best || t.pnl > best.pnl) best = t;
    if (!worst || t.pnl < worst.pnl) worst = t;
  }
  const n = trades.length, pick = (t) => t && { symbol: t.symbol, strategy: t.strategy, side: t.side, pnl: t.pnl, r: t.r };
  return { trades: n, wins, winRate: n ? wins / n : null, pf: gl > 0 ? r2(gw / gl) : gw > 0 ? null : null, grossWin: r2(gw), grossLoss: r2(gl),
    best: n ? pick(best) : null, worst: n > 1 ? pick(worst) : null };
}

/** The day's stage moves (not conviction updates) and Gate edits, as { id, stage, why }. */
export async function dayChanges(db, day) {
  const { results } = await db.prepare("SELECT event_key, kind, strategy, why FROM bot_events WHERE day = ? AND kind IN ('stage', 'edit') AND event_key NOT LIKE 'conviction-%' ORDER BY ts, id").bind(day).all();
  return results.map((e) => {
    const m = /^stage-.+-\d+-([a-z]+)-\d+$/.exec(e.event_key);
    return { id: e.strategy, stage: e.kind === 'edit' ? 'edited' : m ? m[1] : 'changed', why: e.why };
  });
}

/** SPY's change on `day` from Alpaca's daily bars (null when the bar is not there). */
export async function spyChange(broker, day, at) {
  try {
    const bars = (await broker.bars(['SPY'], '1d', at - 10 * 86_400_000, at)).SPY || [];
    const i = bars.findIndex((b) => nyClock(b[0]).date === day);
    if (i < 1) return null;
    return r2((bars[i][4] / bars[i - 1][4] - 1) * 100);
  } catch (e) { return null; }
}

/** The code-written headline. */
export function headline(b) {
  if (b.mode === 'shadow') return `Shadow day: ${b.shadow.decisions} decision${b.shadow.decisions === 1 ? '' : 's'} logged, no orders sent.`;
  if (b.mode === 'off') return 'Neo Cortex was off today.';
  const parts = [];
  if (b.pnl != null) parts.push(`${b.pnl >= 0 ? 'Up' : 'Down'} ${money(Math.abs(b.pnl)).replace('-', '')} (${pct(b.pnlPct)})` + (b.spyPct != null ? ` vs SPY ${pct(b.spyPct)}` : ''));
  parts.push(b.trades ? `${b.trades} trade${b.trades === 1 ? '' : 's'}, ${b.wins} won` : 'no trades closed');
  return parts.join(' · ') + '.';
}

/** The brief's numbers for `day` (code only). */
export async function buildNumbers(env, day, at, { broker = paperBroker(env) } = {}) {
  const db = env.DB, from = nyMidnight(day), to = from + 86_400_000;
  const [{ settings }, state, trades, changes, shadowRow, review, eq] = await Promise.all([
    readSettings(db), readBotState(db), dayTrades(db, from, to), dayChanges(db, day),
    db.prepare("SELECT COUNT(*) AS n FROM bot_events WHERE day = ? AND kind = 'shadow'").bind(day).first(),
    db.prepare('SELECT body FROM bot_reviews WHERE day = ?').bind(day).first(),
    db.prepare('SELECT slot, SUM(equity) AS pnl FROM bot_equity WHERE slot >= ? AND slot < ? GROUP BY slot ORDER BY slot').bind(from, to).all(),
  ]);
  const L = settings.limits, t = tally(trades), mode = settings.mode;
  const pnl = mode === 'paper' && state.date === day && Number.isFinite(state.dayPnl) ? r2(state.dayPnl) : mode === 'paper' ? r2(trades.reduce((s, x) => s + x.pnl, 0)) : null;
  const spyPct = mode === 'paper' ? await spyChange(broker, day, at) : null;
  const pnlPct = pnl != null ? r2(pnl / L.book * 100) : null;
  const reviewed = review ? JSON.parse(review.body).strategies || [] : [];
  const per = new Map();
  for (const x of trades) {
    const k = x.strategy, s = per.get(k) || { id: k, trades: 0, wins: 0, pnl: 0 };
    s.trades++; if (x.pnl > 0) s.wins++; s.pnl = r2(s.pnl + x.pnl); per.set(k, s);
  }
  for (const s of reviewed) {
    const cur = per.get(s.id) || { id: s.id, trades: 0, wins: 0, pnl: 0 };
    per.set(s.id, { ...cur, stage: s.stage, total: { trades: s.trades, winRate: s.winRate, pf: s.pf, pnl: s.pnl }, conviction: s.conviction });
  }
  const deployedPeak = state.date === day ? Number(state.deployedPeak ?? state.deployed) || 0 : 0;
  const body = {
    day, at, mode, book: L.book, maxDeployed: L.maxDeployed, equity: state.date === day && Number.isFinite(state.equity) ? r2(state.equity) : null,
    pnl, pnlPct, spyPct, vsSpy: pnlPct != null && spyPct != null ? r2(pnlPct - spyPct) : null,
    ...t, perStrategy: [...per.values()], changes, shadow: { decisions: shadowRow?.n || 0 },
    deployedPeak: r2(deployedPeak), riskUsedPct: L.maxDeployed ? r2(deployedPeak / L.maxDeployed * 100) : null,
    equityLine: (eq.results || []).map((r) => [r.slot, r2(L.book + r.pnl)]),
    commentary: null, lineup: [], retired: [], claude: null, ready: false, readyAt: null,
  };
  body.headline = headline(body);
  return body;
}

/** Claude's post-close run → { commentary, lineup, retired, claude }, or the template's when it failed or never came. */
export function mergeRun(body, run) {
  if (run && run.outcome !== 'failed' && run.summary) {
    const res = (() => { try { return JSON.parse(run.results || '[]'); } catch (e) { return []; } })();
    return { ...body, commentary: run.summary, claude: true, model: run.model || null,
      lineup: res.filter((x) => x.pass).map((x) => ({ id: x.id, name: x.name || x.id })).slice(0, 12),
      retired: res.filter((x) => x.retire).map((x) => ({ id: x.retire, why: x.why })).slice(0, 6) };
  }
  const why = run && run.outcome === 'failed' ? String(run.summary || 'Strategist did not run.').replace(/^Strategist did not run:?\s*/i, '') : 'no post-close run reached the bot by 5:15 PM (the PC was off or Claude\'s limit was reached)';
  return { ...body, claude: false, commentary: `Strategist did not run (${why}). ${body.headline} Approved strategies keep their current settings tomorrow.` };
}

/** Is `day` the last trading day of its week? */
export function lastOfWeek(day) {
  const [y, m, d] = day.split('-').map(Number), wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  for (let k = 1; wd + k <= 5; k++) if (isTradingDay(addDays(day, k))) return false;
  return true;
}

/** The week's roll-up from that week's earlier briefs and today's. */
export function rollup(bodies) {
  const w = { days: bodies.length, pnl: null, trades: 0, wins: 0, grossWin: 0, grossLoss: 0, best: null, worst: null, perStrategy: [] };
  const per = new Map();
  for (const b of bodies) {
    if (b.pnl != null) w.pnl = r2((w.pnl || 0) + b.pnl);
    w.trades += b.trades || 0; w.wins += b.wins || 0; w.grossWin = r2(w.grossWin + (b.grossWin || 0)); w.grossLoss = r2(w.grossLoss + (b.grossLoss || 0));
    for (const t of [b.best, b.worst]) {
      if (!t) continue;
      if (!w.best || t.pnl > w.best.pnl) w.best = { ...t, day: b.day };
      if (!w.worst || t.pnl < w.worst.pnl) w.worst = { ...t, day: b.day };
    }
    for (const s of b.perStrategy || []) {
      const c = per.get(s.id) || { id: s.id, trades: 0, wins: 0, pnl: 0 };
      c.trades += s.trades || 0; c.wins += s.wins || 0; c.pnl = r2(c.pnl + (s.pnl || 0)); per.set(s.id, c);
    }
  }
  if (w.best && w.worst && w.best === w.worst) w.worst = null;
  w.winRate = w.trades ? w.wins / w.trades : null;
  w.pf = w.grossLoss > 0 ? r2(w.grossWin / w.grossLoss) : null;
  w.perStrategy = [...per.values()].filter((s) => s.trades);
  return w;
}

/** The cron's brief step. → 'numbers' | 'ready' | null (nothing to do). Never throws into the trading tick. */
export async function briefTick(env, at, opts = {}) {
  const db = env.DB, { date: day, minutes } = nyClock(at);
  if (!isTradingDay(day)) return null;
  const close = closeOf(day);
  if (minutes < close + NUMBERS_AFTER) return null;
  const row = await db.prepare('SELECT body FROM bot_briefs WHERE day = ?').bind(day).first();
  let body = row ? JSON.parse(row.body) : null, made = false;
  if (body && body.ready) return null;
  if (!body) { body = await buildNumbers(env, day, at, opts); made = true; }
  const run = await db.prepare("SELECT model, outcome, summary, results, ended FROM lab_runs WHERE day = ? AND session = 'postclose' AND ended IS NOT NULL AND outcome != 'running' ORDER BY ended DESC LIMIT 1").bind(day).first();
  let done = null;
  if (run && run.outcome !== 'failed') done = mergeRun(body, run);
  else if (minutes >= close + CLAUDE_DEADLINE) done = mergeRun(body, run);
  if (done) {
    body = { ...done, ready: true, readyAt: at };
    if (lastOfWeek(day)) {
      const monday = addDays(day, -((new Date(day + 'T12:00:00Z').getUTCDay() + 6) % 7));
      const { results } = await db.prepare('SELECT body FROM bot_briefs WHERE day >= ? AND day < ? ORDER BY day').bind(monday, day).all();
      body.week = { from: monday, to: day, ...rollup([...results.map((r) => JSON.parse(r.body)), body]) };
    }
  } else if (!made) return null;
  await db.prepare('INSERT INTO bot_briefs (day, at, body) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET at = excluded.at, body = excluded.body').bind(day, at, JSON.stringify(body)).run();
  return body.ready ? 'ready' : 'numbers';
}

/** GET /briefs?limit=: the history list for the card's date picker (newest first). */
export async function getBriefs({ DB }, url) {
  const limit = Math.min(60, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const { results } = await DB.prepare('SELECT day, at, body FROM bot_briefs ORDER BY day DESC LIMIT ?').bind(limit).all();
  return json({ ok: true, briefs: results.map((r) => { const b = JSON.parse(r.body); return { day: r.day, at: r.at, headline: b.headline, pnl: b.pnl, mode: b.mode, ready: !!b.ready, week: !!b.week }; }) });
}
export { DAY as BRIEF_DAY };
