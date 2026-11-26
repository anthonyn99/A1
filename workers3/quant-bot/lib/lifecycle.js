// Neo Cortex N5 (A1-Priv docs/TradeHub/quant/n4-05.md): each strategy's life and the learning loop.
//   gated → shadow (one session, never ordered) → paper (trial) → active, or killed / retired; paused holds a slot.
//
//   admit(env, at)                     cron 09:00-09:30 New York: gated → shadow while slots are free; a newer
//                                      version replaces the older one
//   liveStrategies(db)                 what the bot evaluates: shadow, paper, active (with each one's conviction)
//   review(env, at)                    cron once after the close: paper record → keep / retire / kill, conviction
//   POST /lifecycle/replay             the PC's decision check (tools/strat/replay.mjs) → shadow → paper, drift kill
//   GET  /lifecycle/fires?day          the bars where the live bot fired, for that check
//   GET  /lifecycle                    every strategy's row, the per-setup conviction table, the last review
//   POST /strategies/stage             pause, resume, retire, kill (Tony any; Claude retire; Neo pause)
import { nyClock, nyMidnight } from '../core/clock.js';
import { isTradingDay, nyseHalfDays } from '../core/holidays.js';
import { BOT_MAX_SYMBOLS, checkStrategy, rulesOf } from '../core/strategy.js';
import { json } from './lab.js';
import { logEvent, readSettings } from './state.js';
import { lifeSettings } from './life-rules.js';
export { LIFE_DEFAULTS, LIFE_RANGES, lifeSettings, patchLife } from './life-rules.js';

export const LIVE = ['shadow', 'paper', 'active'];
const HOLDS_SLOT = ['shadow', 'paper', 'active', 'paused'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9][a-z0-9-]{2,39}$/;
const PRIOR_N = 20, E_FULL = 0.4, RAMP = 15;
const bad = (message, status = 400) => json({ ok: false, error: message }, status);
const r2 = (x) => Math.round(x * 100) / 100;
const pct = (x) => Math.round(x * 1000) / 10 + '%';

/** The upper end of the win rate's Wilson interval (90%: z = 1.645), in 0..1. */
export function wilsonUpper(wins, n, z = 1.645) {
  if (!n) return 1;
  const p = wins / n, z2 = z * z, d = 1 + z2 / n;
  return Math.min(1, (p + z2 / (2 * n) + z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / d);
}

/** Conviction 0..1 from the paper record shrunk toward half the backtest (n4-05.md "Learning loop"). */
export function convictionOf({ rTrades = 0, sumR = 0 } = {}, backtestR = null) {
  const n = rTrades, ePaper = n ? sumR / n : 0, prior = Number.isFinite(backtestR) ? backtestR / 2 : 0;
  const e = (n * ePaper + PRIOR_N * prior) / (n + PRIOR_N);
  const c = Math.min(1, Math.max(0, e / E_FULL)) * Math.min(1, n / RAMP);
  return { conviction: Math.round(c * 1000) / 1000, e: Math.round(e * 1000) / 1000, ePaper: n ? Math.round(ePaper * 1000) / 1000 : null };
}

/** A strategy's sleeve: max deployed x its style's share. */
export const sleeveOf = (spec, limits) => limits.maxDeployed * (limits.styleShare?.[spec.horizon] ?? 1);

/** Closed paper trades of one strategy version, from its order intents and fills, oldest first. */
export async function tradesOf(db, id, version) {
  const { results } = await db.prepare(
    "SELECT o.client_id, o.side, o.entry_price, o.stop, f.side AS fside, f.qty, f.price, f.ts FROM bot_order_intents o JOIN bot_fills f ON f.client_id = o.client_id " +
    "WHERE o.strategy = ? AND o.version = ? AND o.status = 'closed' ORDER BY f.ts").bind(id, version).all();
  const by = new Map();
  for (const r of results) {
    const t = by.get(r.client_id) || { id: r.client_id, side: r.side, entry: r.entry_price, stop: r.stop, opened: 0, cash: 0, at: 0 };
    const opens = (r.side === 'long') === (r.fside === 'buy');
    if (opens) t.opened += r.qty;
    t.cash += (r.fside === 'sell' ? 1 : -1) * r.qty * r.price;
    t.at = Math.max(t.at, r.ts);
    by.set(r.client_id, t);
  }
  return [...by.values()].filter((t) => t.opened > 0).sort((a, b) => a.at - b.at).map((t) => {
    const risk = Math.abs(t.entry - t.stop) * t.opened;
    return { id: t.id, at: t.at, pnl: r2(t.cash), r: risk > 0 ? t.cash / risk : null };
  });
}

/** Trades → the numbers the rules read. */
export function statsOf(trades) {
  let pnl = 0, peak = 0, dd = 0, wins = 0, gw = 0, gl = 0, sumR = 0, rTrades = 0;
  for (const t of trades) {
    pnl += t.pnl; peak = Math.max(peak, pnl); dd = Math.max(dd, peak - pnl);
    if (t.pnl > 0) { wins++; gw += t.pnl; } else gl += -t.pnl;
    if (Number.isFinite(t.r)) { sumR += t.r; rTrades++; }
  }
  const n = trades.length;
  return { trades: n, wins, winRate: n ? wins / n : null, pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : null, grossWin: r2(gw), grossLoss: r2(gl),
    pnl: r2(pnl), peak: r2(peak), drawdown: r2(dd), sumR, rTrades };
}

/** Every strategy row that holds or wants a slot, all versions, with its life row. */
async function rowsOf(db) {
  const { results } = await db.prepare(
    "SELECT s.id, s.version, s.stage, s.spec, s.report, s.updated, l.since, l.prior_stage, l.shadow_day, l.shadow_fails, l.paper_days, l.last_day, " +
    "l.signals, l.matched, l.conviction, l.trades AS life_trades FROM strategies s LEFT JOIN strategy_life l ON l.id = s.id AND l.version = s.version " +
    "WHERE s.stage IN ('gated','shadow','paper','active','paused') ORDER BY s.updated DESC, s.id").all();
  return results.map((r) => ({ ...r, spec: JSON.parse(r.spec), report: r.report ? JSON.parse(r.report) : null }));
}

/** One stage move: the strategy, its life row and a `stage` event, together. */
function moveStatements(db, row, stage, why, at, life = {}) {
  const day = nyClock(at).date;
  const fields = { prior_stage: null, shadow_day: null, shadow_fails: 0, paper_days: 0, last_day: null, ...lifeOf(row), ...life };
  return [
    db.prepare('UPDATE strategies SET stage = ?, updated = ? WHERE id = ? AND version = ? AND stage = ?').bind(stage, at, row.id, row.version, row.stage),
    db.prepare('INSERT INTO strategy_life (id, version, stage, since, prior_stage, shadow_day, shadow_fails, paper_days, last_day, conviction, why, updated) ' +
      'SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE changes() = 1 ON CONFLICT(id, version) DO UPDATE SET stage = excluded.stage, since = excluded.since, prior_stage = excluded.prior_stage, ' +
      'shadow_day = excluded.shadow_day, shadow_fails = excluded.shadow_fails, paper_days = excluded.paper_days, last_day = excluded.last_day, why = excluded.why, updated = excluded.updated')
      .bind(row.id, row.version, stage, at, fields.prior_stage, fields.shadow_day, fields.shadow_fails, fields.paper_days, fields.last_day, fields.conviction ?? 0, why, at),
    db.prepare("INSERT OR IGNORE INTO bot_events (event_key, ts, day, kind, strategy, version, why) SELECT ?, ?, ?, 'stage', ?, ?, ? WHERE changes() = 1")
      .bind(['stage', row.id, row.version, stage, at].join('-'), at, day, row.id, row.version, why),
  ];
}
const lifeOf = (row) => Object.fromEntries(['prior_stage', 'shadow_day', 'shadow_fails', 'paper_days', 'last_day', 'conviction'].filter((k) => row[k] != null).map((k) => [k, row[k]]));

async function move(db, row, stage, why, at, life) {
  const res = await db.batch(moveStatements(db, row, stage, why, at, life));
  return res[0].meta.changes === 1;
}

/** Admission (n4-05.md): gated → shadow while slots are free, newest first. Idempotent; one read when idle. */
export async function admit(env, at) {
  const db = env.DB, day = nyClock(at).date;
  const { settings } = await readSettings(db);
  if (!['shadow', 'paper'].includes(settings.mode)) return [];   // nothing runs today: no shadow session to admit to
  const life = lifeSettings(settings.lifecycle);
  const rows = await rowsOf(db);
  const latest = new Map();
  for (const r of rows) if (!latest.has(r.id) || latest.get(r.id).version < r.version) latest.set(r.id, r);
  const moved = [];
  // Older versions: a gated one under a newer version is superseded; a live one stays until its successor is admitted.
  for (const r of rows) {
    if (latest.get(r.id) === r || r.stage !== 'gated') continue;
    if (await move(db, r, 'retired', `Superseded by version ${latest.get(r.id).version} before it ran`, at)) moved.push([r.id, r.version, 'retired']);
  }
  const holding = new Set(rows.filter((r) => HOLDS_SLOT.includes(r.stage)).map((r) => r.id));
  const symbolsBy = new Map(rows.filter((r) => HOLDS_SLOT.includes(r.stage)).map((r) => [r.id, r.spec.universe?.symbols || []]));
  const waiting = [...latest.values()].filter((r) => r.stage === 'gated' && checkStrategy(r.spec, { bot: true }).ok);
  for (const r of waiting) {
    const older = rows.filter((o) => o.id === r.id && o.version < r.version && HOLDS_SLOT.includes(o.stage));
    if (!older.length && holding.size >= life.maxLive) break;
    // The bot evaluates at most 40 symbols a tick (4 shards of 10): a strategy that would push the union past it waits.
    const union = new Set([...symbolsBy].filter(([id]) => id !== r.id).flatMap(([, list]) => list).concat(r.spec.universe?.symbols || []));
    if (union.size > BOT_MAX_SYMBOLS) continue;
    for (const o of older) {
      if (await move(db, o, 'retired', `Replaced by version ${r.version}; its open positions keep their own stop and exits`, at)) moved.push([o.id, o.version, 'retired']);
    }
    if (await move(db, r, 'shadow', `Admitted to shadow for the ${day} session: it is evaluated and logged, never ordered`, at, { shadow_day: day, conviction: 0 })) {
      holding.add(r.id); symbolsBy.set(r.id, r.spec.universe?.symbols || []); moved.push([r.id, r.version, 'shadow']);
    }
  }
  // Another shadow session: one more was needed after a verdict (shadow_day cleared), or the day had no usable check
  // (the PC was off, or the bot did not evaluate the whole session).
  for (const r of rows) {
    if (r.stage !== 'shadow' || (r.shadow_day && r.shadow_day >= day)) continue;
    await db.prepare('UPDATE strategy_life SET shadow_day = ?, updated = ? WHERE id = ? AND version = ?').bind(day, at, r.id, r.version).run();
    await logEvent(db, { key: ['stage', r.id, r.version, 'reshadow', day].join('-'), ts: at, kind: 'stage', strategy: r.id, version: r.version,
      why: r.shadow_day ? `No usable decision check for ${r.shadow_day} (the PC was off or the session was not fully evaluated), so it shadows the ${day} session too`
        : `It shadows the ${day} session: another shadow session is needed before its paper trial` });
    moved.push([r.id, r.version, 'shadow again']);
  }
  return moved;
}

/** What the bot evaluates: per strategy, the newest version that is shadow, paper or active (a newer gated version does
 *  not stop it: it keeps running until its successor is admitted), with its conviction. */
export async function liveStrategies(db, limit = 6) {
  const { results } = await db.prepare(
    "SELECT s.id, s.version, s.stage, s.spec, l.conviction FROM strategies s JOIN (SELECT id, MAX(version) AS version FROM strategies WHERE stage IN ('shadow','paper','active') GROUP BY id) latest " +
    "ON latest.id = s.id AND latest.version = s.version LEFT JOIN strategy_life l ON l.id = s.id AND l.version = s.version " +
    "ORDER BY s.updated DESC, s.id LIMIT 50").all();
  const out = [];
  for (const row of results) {
    const spec = JSON.parse(row.spec);
    if (!checkStrategy(spec, { bot: true }).ok) continue;
    out.push({ id: row.id, version: row.version, stage: row.stage, spec, conviction: row.stage === 'shadow' ? 0 : Number(row.conviction) || 0 });
    if (out.length >= limit) break;
  }
  return out;
}

export const closeOf = (day) => (nyseHalfDays(Number(day.slice(0, 4))).has(day) ? 13 * 60 : 16 * 60);

/** The kill rules on a paper record → the reason, or null. */
export function killReason(st, row, life, limits) {
  const k = life.kill;
  if (st.trades >= k.minTrades) {
    const up = wilsonUpper(st.wins, st.trades);
    if (up * 100 < k.wilsonUpper) return `Killed: win rate ${pct(st.winRate)} over ${st.trades} trades; even its 90% upper bound ${pct(up)} is under ${k.wilsonUpper}%`;
  }
  const sleeve = sleeveOf(row.spec, limits);
  if (sleeve > 0 && st.drawdown > sleeve * k.sleeveDD / 100) {
    return `Killed: the sleeve fell $${st.drawdown.toFixed(2)} from its peak, over ${k.sleeveDD}% of its $${sleeve.toFixed(0)} sleeve`;
  }
  const signals = Number(row.signals) || 0, matched = Number(row.matched) || 0;
  if (signals >= k.driftMinSignals && (signals - matched) / signals * 100 > k.driftBand) {
    return `Killed: live decisions disagreed with the backtest on ${signals - matched} of ${signals} signals (over ${k.driftBand}%)`;
  }
  return null;
}

/** The keep rule at the end of a trial → { stage, why } or null (still on trial). */
export function trialVerdict(st, paperDays, life) {
  const k = life.keep;
  const judged = st.trades >= k.minTrades || (paperDays >= k.minSessions && st.trades >= 5);
  const nums = `win rate ${st.winRate == null ? 'n/a' : pct(st.winRate)}, PF ${st.pf == null ? 'n/a' : st.pf === Infinity ? 'no losses' : st.pf.toFixed(2)}, ${st.trades} trades in ${paperDays} sessions`;
  if (judged) {
    return st.winRate * 100 >= k.minWinRate && st.pf >= k.minPF
      ? { stage: 'active', why: `Kept after its trial: ${nums} (needs ${k.minWinRate}% and ${k.minPF})` }
      : { stage: 'retired', why: `Retired: the trial did not earn its place: ${nums} (needs ${k.minWinRate}% and ${k.minPF})` };
  }
  if (paperDays >= life.trialMaxSessions && st.trades < 5) return { stage: 'retired', why: `Retired: too rare to judge: ${st.trades} trades in ${paperDays} sessions` };
  return null;
}

/** The daily review, once per session from the close + 5 minutes (n4-05.md). → the summary, or null when not due. */
export async function review(env, at, { force = false } = {}) {
  const db = env.DB, { date: day, minutes } = nyClock(at);
  if (!force && (!isTradingDay(day) || minutes < closeOf(day) + 5)) return null;
  if (await db.prepare('SELECT 1 AS x FROM bot_reviews WHERE day = ?').bind(day).first()) return null;
  const { settings } = await readSettings(db);
  const life = lifeSettings(settings.lifecycle), limits = settings.limits;
  const rows = (await rowsOf(db)).filter((r) => ['paper', 'active', 'paused'].includes(r.stage) && (r.stage !== 'paused' || ['paper', 'active'].includes(r.prior_stage)));
  const out = [];
  for (const row of rows) {
    const st = statsOf(await tradesOf(db, row.id, row.version));
    const tradedToday = row.stage !== 'paused' && (row.since == null || row.since < nyMidnight(day) + closeOf(day) * 60000) && row.last_day !== day;
    const paperDays = (Number(row.paper_days) || 0) + (tradedToday ? 1 : 0);
    const conv = convictionOf(st, row.report?.expectancyR);
    const before = Number(row.conviction) || 0;
    await db.prepare('INSERT INTO strategy_life (id, version, stage, since, updated) VALUES (?,?,?,?,?) ON CONFLICT(id, version) DO NOTHING').bind(row.id, row.version, row.stage, row.updated, at).run();
    await db.prepare('UPDATE strategy_life SET trades = ?, wins = ?, gross_win = ?, gross_loss = ?, sum_r = ?, r_trades = ?, pnl = ?, peak = ?, paper_days = ?, last_day = ?, conviction = ?, updated = ? WHERE id = ? AND version = ?')
      .bind(st.trades, st.wins, st.grossWin, st.grossLoss, st.sumR, st.rTrades, st.pnl, st.peak, paperDays, tradedToday ? day : row.last_day, conv.conviction, at, row.id, row.version).run();
    if (Math.abs(conv.conviction - before) >= 0.05) {
      await logEvent(db, { key: ['conviction', row.id, row.version, day].join('-'), ts: at, kind: 'stage', strategy: row.id, version: row.version,
        why: `Conviction ${before.toFixed(2)} → ${conv.conviction.toFixed(2)}: ${st.rTrades} paper trades at ${conv.ePaper == null ? 'n/a' : conv.ePaper.toFixed(2)} R, backtest ${Number.isFinite(row.report?.expectancyR) ? row.report.expectancyR.toFixed(2) : 'n/a'} R, shrunk to ${conv.e.toFixed(2)} R` });
    }
    const cur = { ...row, paper_days: paperDays, last_day: tradedToday ? day : row.last_day, conviction: conv.conviction };
    const killed = row.stage === 'paused' ? null : killReason(st, row, life, limits);
    let verdict = killed ? { stage: 'killed', why: killed } : null;
    if (!verdict && row.stage === 'paper') verdict = trialVerdict(st, paperDays, life);
    if (verdict) await move(db, cur, verdict.stage, verdict.why, at);
    out.push({ id: row.id, version: row.version, stage: verdict ? verdict.stage : row.stage, ...st, pf: st.pf === Infinity ? null : st.pf, paperDays, conviction: conv.conviction, why: verdict?.why || null });
  }
  const body = { day, strategies: out };
  await db.prepare('INSERT OR IGNORE INTO bot_reviews (day, at, body) VALUES (?, ?, ?)').bind(day, at, JSON.stringify(body)).run();
  return body;
}

/** Bars where the live bot fired on `day`: shadow and post-fire skip events, and paper order intents. */
export async function getFires({ DB }, url) {
  const day = url.searchParams.get('day');
  if (!DAY.test(day || '')) return bad('day is YYYY-MM-DD');
  const from = nyMidnight(day), to = from + 86_400_000;
  const { results } = await DB.prepare(
    'SELECT strategy, version, symbol, bar_time FROM bot_events WHERE day = ? AND fired = 1 AND bar_time IS NOT NULL AND strategy IS NOT NULL ' +
    'UNION SELECT strategy, version, symbol, bar_time FROM bot_order_intents WHERE bar_time >= ? AND bar_time < ?').bind(day, from, to).all();
  return json({ ok: true, day, fires: results });
}

/** Did the bot evaluate (almost) the whole session of `day`? Checkpoints are noted every 15 minutes while strategies
 *  were actually evaluated (lib/shadow.js, lib/paper-cycle.js); one miss is tolerated. → { ok, slots, need } */
export async function sessionCovered(db, day) {
  const need = Math.max(1, Math.ceil((closeOf(day) - 570) / 15) - 1);
  const row = await db.prepare('SELECT COUNT(*) AS n FROM bot_session_slots WHERE day = ?').bind(day).first();
  return { ok: Number(row?.n) >= need, slots: Number(row?.n) || 0, need };
}

/** Note one evaluated 15-minute checkpoint (idempotent: one row per slot). */
export function noteSlot(db, day, slot) {
  return db.prepare('INSERT OR IGNORE INTO bot_session_slots (day, slot) VALUES (?, ?)').bind(day, slot).run();
}

/** The PC's decision check for one day (tools/strat/replay.mjs). Applied once per strategy version and day; a day the
 *  bot did not fully evaluate (off, paused, halted, a guard) is recorded but judges nothing. */
export async function postReplay(env, body, at = Date.now()) {
  const db = env.DB;
  if (!body || !DAY.test(String(body.day || '')) || !Array.isArray(body.results) || body.results.length > 12) return bad('a replay needs a day and up to 12 results');
  const whole = (x) => Number.isInteger(x) && x >= 0 && x <= 100000;
  for (const r of body.results) {
    if (!r || !ID.test(String(r.id || '')) || !Number.isInteger(r.version) || ![r.signals, r.matched, r.missedLive, r.extraLive].every(whole) || r.matched > r.signals) {
      return bad('each result needs id, version, signals, matched, missedLive, extraLive (whole numbers, matched ≤ signals)');
    }
  }
  const { settings } = await readSettings(db);
  const life = lifeSettings(settings.lifecycle);
  const errored = await db.prepare("SELECT 1 AS x FROM bot_events WHERE day = ? AND kind = 'guard' AND (event_key LIKE 'broker-guard-%' OR event_key LIKE 'paper-broker-guard-%') LIMIT 1").bind(body.day).first();
  const covered = await sessionCovered(db, body.day);
  const rows = await rowsOf(db);
  const out = [];
  for (const r of body.results) {
    const add = await db.prepare('INSERT OR IGNORE INTO bot_replays (day, id, version, at, signals, matched, missed_live, extra_live, notes) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(body.day, r.id, r.version, at, r.signals, r.matched, r.missedLive, r.extraLive, String(r.notes || '').slice(0, 500)).run();
    if (add.meta.changes !== 1) { out.push({ id: r.id, version: r.version, already: true }); continue; }
    const row = rows.find((x) => x.id === r.id && x.version === r.version);
    if (!row) { out.push({ id: r.id, version: r.version, stage: null }); continue; }
    if (!covered.ok) { out.push({ id: r.id, version: r.version, stage: row.stage, unjudged: `the bot evaluated ${covered.slots} of ${covered.need} checkpoints` }); continue; }
    const agree = r.signals === 0 || r.matched / r.signals * 100 >= life.matchMin;
    const nums = r.signals ? `${r.matched} of ${r.signals} signals matched (${Math.round(r.matched / r.signals * 100)}%; ${r.missedLive} missed live, ${r.extraLive} extra)` : 'neither side fired';
    if (row.stage === 'shadow' && row.shadow_day === body.day) {
      if (agree && !errored) {
        await db.prepare('UPDATE strategy_life SET shadow_passes = shadow_passes + 1, updated = ? WHERE id = ? AND version = ?').bind(at, r.id, r.version).run();
        const done = await db.prepare('SELECT shadow_passes AS n FROM strategy_life WHERE id = ? AND version = ?').bind(r.id, r.version).first();
        if (Number(done?.n) >= life.shadowSessions) {
          await move(db, row, 'paper', `Shadow session ${body.day} passed: ${nums}. Paper trial starts`, at, { shadow_day: null });
          out.push({ id: r.id, version: r.version, stage: 'paper' });
        } else {
          await db.prepare('UPDATE strategy_life SET shadow_day = NULL, updated = ? WHERE id = ? AND version = ?').bind(at, r.id, r.version).run();
          await logEvent(db, { key: ['stage', r.id, r.version, 'shadowpass', body.day].join('-'), ts: at, kind: 'stage', strategy: r.id, version: r.version,
            why: `Shadow ${body.day} passed (${nums}): ${done?.n} of ${life.shadowSessions} sessions` });
          out.push({ id: r.id, version: r.version, stage: 'shadow', passed: Number(done?.n) });
        }
      } else {
        const fails = (Number(row.shadow_fails) || 0) + 1, why = errored ? `the ${body.day} session had a data or broker error` : `decisions disagreed: ${nums}`;
        if (fails >= 2) { await move(db, row, 'retired', `Retired after two failed shadow sessions: ${why}`, at); out.push({ id: r.id, version: r.version, stage: 'retired' }); }
        else {
          await db.prepare('UPDATE strategy_life SET shadow_fails = ?, shadow_passes = 0, shadow_day = NULL, updated = ? WHERE id = ? AND version = ?').bind(fails, at, r.id, r.version).run();
          await logEvent(db, { key: ['stage', r.id, r.version, 'shadowfail', body.day].join('-'), ts: at, kind: 'stage', strategy: r.id, version: r.version, why: `Shadow ${body.day} did not pass (${why}); it shadows one more session` });
          out.push({ id: r.id, version: r.version, stage: 'shadow', failed: fails });
        }
      }
      continue;
    }
    if (['paper', 'active'].includes(row.stage)) {
      await db.prepare('UPDATE strategy_life SET matched = matched + ?, signals = signals + ?, updated = ? WHERE id = ? AND version = ?').bind(r.matched, r.signals, at, r.id, r.version).run();
      const cur = { ...row, signals: (Number(row.signals) || 0) + r.signals, matched: (Number(row.matched) || 0) + r.matched };
      const k = life.kill, sig = cur.signals;
      if (sig >= k.driftMinSignals && (sig - cur.matched) / sig * 100 > k.driftBand) {
        await move(db, cur, 'killed', `Killed: live decisions disagreed with the backtest on ${sig - cur.matched} of ${sig} signals (over ${k.driftBand}%)`, at);
        out.push({ id: r.id, version: r.version, stage: 'killed' });
      } else out.push({ id: r.id, version: r.version, stage: row.stage });
      continue;
    }
    out.push({ id: r.id, version: r.version, stage: row.stage });
  }
  return json({ ok: true, day: body.day, results: out });
}

const WHO = { tony: ['paused', 'resume', 'retired', 'killed'], claude: ['retired'], neo: ['paused'] };
/** Tony, Claude or Neo moves one strategy by hand (n4-05.md "Rules"). */
export async function postStage(env, body, at = Date.now()) {
  const db = env.DB;
  const allowed = WHO[body?.author];
  if (!allowed || !ID.test(String(body.id || '')) || typeof body.why !== 'string' || !body.why.trim()) return bad('id, stage, why and author (tony, claude or neo) are needed');
  if (!allowed.includes(body.stage)) return bad(`${body.author} may only ${allowed.join(' or ')} a strategy`, 403);
  const version = body.version == null ? null : Number(body.version);
  if (version != null && !Number.isInteger(version)) return bad('version must be a whole number');
  // Without a version: the running (or paused) version first, a waiting gated one only when nothing runs.
  const rank = (r) => (HOLDS_SLOT.includes(r.stage) ? 1e6 : 0) + r.version;
  const rows = (await rowsOf(db)).filter((r) => r.id === body.id && (version == null || r.version === version) && HOLDS_SLOT.concat('gated').includes(r.stage));
  const row = rows.sort((a, b) => rank(b) - rank(a))[0];
  if (!row) return bad('no running or waiting strategy ' + body.id, 404);
  const who = { tony: 'Tony', claude: 'Claude', neo: 'Neo Quant' }[body.author], why = `${who}: ${body.why.trim().slice(0, 300)}`;
  let ok;
  if (body.stage === 'resume') {
    if (row.stage !== 'paused') return bad('only a paused strategy resumes', 409);
    ok = await move(db, row, row.prior_stage || 'paper', `Resumed (${why})`, at, { prior_stage: null });
  } else if (body.stage === 'paused') {
    if (!LIVE.includes(row.stage)) return bad('only a shadow, paper or active strategy pauses', 409);
    ok = await move(db, row, 'paused', `Paused: no new entries; stops and exits keep working (${why})`, at, { prior_stage: row.stage });
  } else {
    ok = await move(db, row, body.stage, `${body.stage === 'killed' ? 'Killed' : 'Retired'} (${why}); open positions keep their own stop and exits`, at);
  }
  return ok ? json({ ok: true, id: row.id, version: row.version, stage: body.stage === 'resume' ? row.prior_stage || 'paper' : body.stage }) : bad('the strategy changed, reload and retry', 409);
}

/** Every strategy's life, the per-setup conviction table and the last review. */
export async function getLifecycle({ DB }) {
  const { results } = await DB.prepare(
    "SELECT s.id, s.version, s.name, s.stage, s.spec, s.report, s.updated, l.since, l.shadow_day, l.shadow_fails, l.paper_days, l.trades, l.wins, l.gross_win, l.gross_loss, " +
    "l.sum_r, l.r_trades, l.pnl, l.peak, l.signals, l.matched, l.conviction, l.why FROM strategies s " +
    "LEFT JOIN strategy_life l ON l.id = s.id AND l.version = s.version ORDER BY s.updated DESC LIMIT 300").all();
  // One row per strategy: its running (or paused) version, else its newest; a waiting newer version is named in `next`.
  const pick = new Map(), newest = new Map();
  const rank = (r) => (HOLDS_SLOT.includes(r.stage) ? 1e6 : 0) + r.version;
  for (const r of results) {
    if (!pick.has(r.id) || rank(r) > rank(pick.get(r.id))) pick.set(r.id, r);
    if (!newest.has(r.id) || r.version > newest.get(r.id).version) newest.set(r.id, r);
  }
  const strategies = [...pick.values()].slice(0, 100).map((r) => {
    const nx = newest.get(r.id);
    const spec = JSON.parse(r.spec), report = r.report ? JSON.parse(r.report) : null, n = r.trades || 0;
    return { id: r.id, version: r.version, name: r.name, stage: r.stage, style: spec.horizon, side: spec.side, timeframe: spec.timeframe, symbols: spec.universe?.symbols || [],
      since: r.since ?? r.updated, shadowDay: r.shadow_day, paperDays: r.paper_days || 0, trades: n, winRate: n ? r.wins / n : null,
      pf: r.gross_loss > 0 ? r.gross_win / r.gross_loss : null, pnl: r.pnl || 0, expectancyR: r.r_trades ? r.sum_r / r.r_trades : null,
      backtest: report && { trades: report.trades, winRate: report.winRate, pf: report.profitFactor, expectancyR: report.expectancyR },
      replay: { signals: r.signals || 0, matched: r.matched || 0 }, conviction: r.conviction || 0, why: r.why || null,
      setups: [...new Set(rulesOf(spec).map((x) => x.setup).filter(Boolean))],
      next: nx.version > r.version ? { version: nx.version, stage: nx.stage } : null };
  });
  const by = new Map();
  for (const s of strategies) for (const k of s.setups.length ? s.setups : ['rules']) {
    const a = by.get(k) || { setup: k, strategies: 0, trades: 0, weighted: 0, weight: 0 }, w = Math.max(1, s.trades);
    a.strategies++; a.trades += s.trades; a.weighted += s.conviction * w; a.weight += w; by.set(k, a);
  }
  const setups = [...by.values()].map((a) => ({ setup: a.setup, strategies: a.strategies, trades: a.trades, conviction: Math.round(a.weighted / a.weight * 1000) / 1000 }));
  const last = await DB.prepare('SELECT day, at, body FROM bot_reviews ORDER BY day DESC LIMIT 1').first();
  return json({ ok: true, strategies, setups, review: last ? { day: last.day, at: last.at, ...JSON.parse(last.body) } : null });
}

/** Closed paper trades of every strategy (N7 Scorecard): symbol, side, open and close time, P&L and R. */
export async function getTrades({ DB }, url) {
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365), since = Date.now() - days * 86_400_000;
  const { results } = await DB.prepare(
    "SELECT o.client_id, o.strategy, o.version, o.symbol, o.side, o.entry_price, o.stop, o.opened, f.side AS fside, f.qty, f.price, f.ts FROM bot_order_intents o JOIN bot_fills f ON f.client_id = o.client_id " +
    "WHERE o.status = 'closed' AND o.client_id IN (SELECT client_id FROM bot_fills GROUP BY client_id HAVING MAX(ts) >= ? ORDER BY MAX(ts) DESC LIMIT 1000) ORDER BY f.ts").bind(since).all();
  const by = new Map();
  for (const r of results) {
    const t = by.get(r.client_id) || { id: r.client_id, strategy: r.strategy, version: r.version, symbol: r.symbol, side: r.side, entry: r.entry_price, stop: r.stop, opened: r.opened, qty: 0, cash: 0, closed: 0 };
    if ((r.side === 'long') === (r.fside === 'buy')) t.qty += r.qty;
    t.cash += (r.fside === 'sell' ? 1 : -1) * r.qty * r.price;
    t.closed = Math.max(t.closed, r.ts);
    by.set(r.client_id, t);
  }
  const trades = [...by.values()].filter((t) => t.qty > 0).map((t) => {
    const risk = Math.abs(t.entry - t.stop) * t.qty;
    return { id: t.id, strategy: t.strategy, version: t.version, symbol: t.symbol, side: t.side, opened: t.opened, closed: t.closed, pnl: Math.round(t.cash * 100) / 100, r: risk > 0 ? t.cash / risk : null };
  });
  return json({ ok: true, days, trades });
}
