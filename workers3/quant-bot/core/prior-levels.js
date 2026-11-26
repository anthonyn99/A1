// COPY of A1-Priv TradeHub/core/prior-levels.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// The levels a trader marks before the open: the previous day, week and
// month, the pre-market range, the opening range, and gaps. Pure.
import { nyClock, nyDays, PRE_OPEN, OPEN } from './clock.js';

const range = (bars) => {
  if (!bars.length) return null;
  let high = -Infinity, low = Infinity;
  for (const b of bars) { if (b.h > high) high = b.h; if (b.l < low) low = b.l; }
  return { high, low, close: bars[bars.length - 1].c };
};
// Monday-based week number of a 'YYYY-MM-DD' date (1970-01-01 was a Thursday).
const weekOf = (date) => { const [y, m, d] = date.split('-').map(Number); return Math.floor((Date.UTC(y, m - 1, d) / 86_400_000 + 3) / 7); };

/** Gaps in daily bars → `[{ i, t, dir: 'up'|'down', lo, hi, filled }]`: bar
 *  `i` opened and stayed beyond the previous bar's range (`low_i > high_{i−1}`
 *  or `high_i < low_{i−1}`); `lo..hi` is the empty stretch; `filled` once a
 *  later bar has traded all the way back across it. Looks at the last `lookback` bars. */
export function gaps(daily, lookback = 120) {
  const out = [];
  for (let i = Math.max(1, daily.length - lookback); i < daily.length; i++) {
    const p = daily[i - 1], b = daily[i];
    let g = null;
    if (b.l > p.h) g = { i, t: b.t, dir: 'up', lo: p.h, hi: b.l, filled: false };
    else if (b.h < p.l) g = { i, t: b.t, dir: 'down', lo: b.h, hi: p.l, filled: false };
    if (!g) continue;
    for (let j = i + 1; j < daily.length && !g.filled; j++) g.filled = g.dir === 'up' ? daily[j].l <= g.lo : daily[j].h >= g.hi;
    out.push(g);
  }
  return out;
}

/** Prior levels → `{ today, prevDay, prevWeek, prevMonth, premarket,
 *  openingRange: { m5, m15 }, gaps }`. Each of the first three is
 *  `{ high, low, close }` of the last finished New York day, week (Monday to
 *  Friday) and month before `today`; `premarket` = `{ high, low }` of today's
 *  04:00 to 09:30 bars; `m5` / `m15` = `{ high, low, done }` of the first 5
 *  and 15 minutes from 09:30, `done` once a later bar shows that stretch is
 *  over. Only bars lying wholly inside a stretch count, so 15-minute bars give
 *  no 5-minute range. `today` is the New York date of `now` (ms; the caller's
 *  clock), else of the last intraday bar, else of the last daily bar.
 *  Anything without bars is null. */
export function priorLevels(dailyBars, intradayBars, { now } = {}) {
  const daily = dailyBars || [], intra = intradayBars || [];
  const out = { today: null, prevDay: null, prevWeek: null, prevMonth: null, premarket: null, openingRange: { m5: null, m15: null }, gaps: gaps(daily) };
  const last = intra.length ? intra[intra.length - 1] : daily[daily.length - 1];
  if (now == null && !last) return out;
  const today = out.today = nyClock(now == null ? last.t : now).date, week = weekOf(today), month = today.slice(0, 7);

  // Walk back from the newest daily bar; three months is always enough.
  const day = [], wk = [], mo = [];
  let prevWeek = null, prevMonth = null;
  for (let i = daily.length - 1; i >= 0 && i >= daily.length - 70; i--) {
    const date = nyClock(daily[i].t).date;
    if (date >= today) continue;
    if (!day.length) day.push(daily[i]);
    const w = weekOf(date), m = date.slice(0, 7);
    if (w < week) { if (prevWeek == null) prevWeek = w; if (w === prevWeek) wk.unshift(daily[i]); }
    if (m < month) { if (prevMonth == null) prevMonth = m; if (m === prevMonth) mo.unshift(daily[i]); }
    if (prevWeek != null && w < prevWeek && prevMonth != null && m < prevMonth) break;
  }
  out.prevDay = range(day); out.prevWeek = range(wk); out.prevMonth = range(mo);

  if (intra.length) {
    const { day: d, minute, dates } = nyDays(intra.map((b) => b.t));
    // How long one bar lasts: the smallest step between the newest bars.
    let width = Infinity;
    for (let i = intra.length - 1; i > 0 && i >= intra.length - 50; i--) width = Math.min(width, (intra[i].t - intra[i - 1].t) / 60_000);
    if (!(width > 0 && width < Infinity)) width = 1;
    const pre = [], m5 = [], m15 = [];
    let newest = -1;
    for (let i = intra.length - 1; i >= 0 && dates[d[i]] >= today; i--) {
      if (dates[d[i]] !== today) continue;
      const m = minute[i], end = m + width;
      if (m > newest) newest = m;
      if (m >= PRE_OPEN && end <= OPEN) pre.unshift(intra[i]);
      if (m >= OPEN && end <= OPEN + 5) m5.unshift(intra[i]);
      if (m >= OPEN && end <= OPEN + 15) m15.unshift(intra[i]);
    }
    const hl = (r, until) => (r ? (until ? { high: r.high, low: r.low, done: newest >= until } : { high: r.high, low: r.low }) : null);
    out.premarket = hl(range(pre));
    out.openingRange = { m5: hl(range(m5), OPEN + 5), m15: hl(range(m15), OPEN + 15) };
  }
  return out;
}
