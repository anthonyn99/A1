// COPY of A1-Priv TradeHub/core/scan.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// The scan: run the detectors over a symbol's closed bars and turn each
// candidate into a signal (score.js). One function for the page's Web Worker
// (job `scan`) and the scheduled runner, so a replayed day gives exactly the
// signals the live page gave. Pure.
import { detectDay, BAR_MS } from './detect-day.js';
import { detectSwing, prepSwing, levelsAsOf } from './detect-swing.js';
import { evaluate } from './score.js';
import { withEventRisk } from './events.js';
import { nyClock, nyMidnight, CLOSE } from './clock.js';

const DAY_MS = 86_400_000;
/** True once daily bar `b` is closed at `now`: its New York day is over (16:00). */
const dailyClosed = (b, now) => { const d = nyClock(b.t + 12 * 3_600_000).date; return now >= nyMidnight(d) + CLOSE * 60_000; };

/**
 * Signals for one symbol → Signal[] (oldest first).
 *   symbol, m5 (5-minute bars, extended hours allowed), daily (daily bars)
 *   since      day setups: bars that open at or after this (ms); null = none
 *   swingSince swing setups: daily bars from this (ms), 'last' = only the last
 *              closed one (the live case: an older bar would get today's regime); null = none
 *   now        only bars closed by then count; the signals' `created`
 *   regime     { score, label }, or (t, horizon) → it (a backtest: the regime as of
 *              the signal, never later)
 *   rs         { rank, vsSector, rank3m }, or (t, horizon) → it
 *   events, earnings (Set), eventEdge
 *   stats      { setup: stats } (score.js verdictOf), or
 *   calibration Phase 6's measured table (score.js calStats / calWeights)
 */
export function scanSymbol({ symbol, m5 = [], daily = [], since = null, swingSince = null, now = Date.now(), regime = null, rs = null, events = null, earnings = null, eventEdge, stats = null, calibration = null }) {
  const out = [], seen = new Set();
  const push = (s) => { if (s && !seen.has(s.id)) { seen.add(s.id); out.push(s); } };
  const ps = daily.length ? prepSwing(daily) : null;
  const ctx0 = { symbol, daily, events, eventEdge, now, calibration };
  const regAt = (c) => (typeof regime === 'function' ? regime(c.at, c.horizon) : regime);
  const rsAt = (c) => (typeof rs === 'function' ? rs(c.at, c.horizon) : rs);
  // Phase 13: each signal carries the first high-impact event inside its window
  // (`eventRisk`); a day signal inside 30 minutes before a release is WATCH at best.
  const sig = (c, extra) => withEventRisk(evaluate(c, { ...ctx0, ...extra, regime: regAt(c), rs: rsAt(c) }, stats && stats[c.setup]), events, BAR_MS);

  if (since != null && m5.length) {
    // Daily levels as of the session before each day: nothing of that day leaks in.
    const lvByDay = new Map();
    const levelsFor = (t) => {
      const day = nyClock(t).date;
      if (!lvByDay.has(day)) {
        let j = -1;
        const cut = nyMidnight(day);
        for (let x = daily.length - 1; x >= 0; x--) if (daily[x].t < cut) { j = x; break; }
        lvByDay.set(day, ps && j >= 0 ? levelsAsOf(ps, j) : null);
      }
      return lvByDay.get(day);
    };
    for (let i = 0; i < m5.length; i++) {
      const b = m5[i];
      if (b.t < since || b.t + BAR_MS > now) continue;
      const lv = levelsFor(b.t);
      for (const c of detectDay({ symbol, bars: { '5m': m5 }, i, levels: lv })) push(sig(c, { main: m5, i, levels: lv }));
    }
  }
  if (swingSince != null && ps) {
    const rsCtx = typeof rs === 'function' ? { rank3m: (i) => { const x = rs(daily[i].t, 'swing'); return x ? x.rank3m : null; } }
      : rs && rs.rank3m != null ? { rank3m: rs.rank3m } : null;
    let lastClosed = -1;
    for (let i = daily.length - 1; i >= 1 && lastClosed < 0; i--) if (dailyClosed(daily[i], now)) lastClosed = i;
    for (let i = 1; i < daily.length; i++) {
      if (swingSince === 'last' ? i !== lastClosed : daily[i].t < swingSince || !dailyClosed(daily[i], now)) continue;
      for (const c of detectSwing({ symbol, bars: { '1d': daily }, i, rs: rsCtx, earnings })) push(sig(c, { main: daily, i, levels: levelsAsOf(ps, i) }));
    }
  }
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** Many symbols at once: `items` = { SYM: { m5, daily, rs, earnings } }, the
 *  rest shared → Signal[]. */
export function scanMany({ items = {}, ...shared }) {
  const out = [];
  for (const [symbol, x] of Object.entries(items)) {
    try { out.push(...scanSymbol({ ...shared, ...x, symbol })); } catch (e) { /* one bad symbol never stops the rest */ }
  }
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** The start of the regular session that `now` falls in (or the last one
 *  before it), for `since`: today's day setups. */
export function sessionStartOf(now) { return nyMidnight(nyClock(now).date) + 9.5 * 3_600_000; }
