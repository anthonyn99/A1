// COPY of A1-Priv TradeHub/core/simulate.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// The strategy simulator (docs/TradeHub/quant/phase-06.md, "The simulator"):
// a checked strategy spec run over a universe's bars → trades, the equity
// curve, exposure and the benchmark. Pure.
//
// The same rules as the setups backtester: a signal is read at a bar's close
// and filled at the NEXT bar's open; a bar that spans both stop and target
// counts the stop (the order inside a bar is not known), and a gap through the
// stop fills at the open; one open trade per symbol. Portfolio level: cash
// (no leverage: a short's proceeds are not spendable and its value is held as collateral), at most maxPositions open
// (the strongest by the first entry rule's margin when more qualify), sizing,
// costs on every fill, and rebalancing (open positions resized to their
// target at the first bar of each week or month). A day strategy is flat at
// each session's close.
import { seriesContext, evalRule, mirrorRule, marginOf, series } from './strategy-rules.js';
import { atr } from './indicators.js';
import { feesOf } from './costs.js';
import { nyClock } from './clock.js';
import { mondayOf } from './weekly.js';
import { CAPITAL, isStop, isTarget, isTime } from './strategy.js';

export const STOP_PAD_ATR = 0.25, FALLBACK_STOP_ATR = 2;

/** Rules of an entry block → one yes/no series (all AND, any OR, groups one level deep).
 *  Exported for core/pilot.js: paper runs decide with this same code (live and backtest cannot drift). */
export function entrySeries(S, entry, dir, mirror) {
  const n = S.bars.length, one = (r) => evalRule(S, mirror ? mirrorRule(r) : r, dir);
  const group = (list, and) => {
    const out = new Uint8Array(n).fill(and ? 1 : 0);
    for (const r of list) {
      const s = r && (r.any || r.all) ? group(r.any || r.all, !!r.all) : one(r);
      for (let i = 0; i < n; i++) out[i] = and ? out[i] & s[i] : out[i] | s[i];
    }
    return out;
  };
  const parts = [];
  if (entry.all && entry.all.length) parts.push(group(entry.all, true));
  if (entry.any && entry.any.length) parts.push(group(entry.any, false));
  if (!parts.length) return new Uint8Array(n);
  const out = parts[0];
  for (let p = 1; p < parts.length; p++) for (let i = 0; i < n; i++) out[i] &= parts[p][i];
  return out;
}
const firstRule = (entry) => { const r = (entry.all && entry.all[0]) || (entry.any && entry.any[0]); return r && (r.any || r.all) ? (r.any || r.all)[0] : r; };

/** A daily series lined up on intraday bars as of the session BEFORE each bar
 *  (nothing of the day itself), or on daily bars as of the same bar. */
export function lineUp(bars, daily, values, intraday) {
  const out = new Array(bars.length).fill(null);
  if (!daily || !values) return null;
  if (!intraday) {
    const at = new Map(daily.map((b, i) => [b.t, i]));
    for (let i = 0; i < bars.length; i++) { const j = at.get(bars[i].t); if (j != null) out[i] = values[j]; }
    return out;
  }
  const dates = daily.map((b) => nyClock(b.t + 12 * 3_600_000).date);
  let j = -1, day = '';
  for (let i = 0; i < bars.length; i++) {
    const d = nyClock(bars[i].t).date;
    if (d !== day) { day = d; while (j + 1 < dates.length && dates[j + 1] < d) j++; }
    out[i] = j >= 0 ? values[j] : null;
  }
  return out;
}

/** Closes of `ref` lined up on `bars` by time (null where it has no bar then). */
function closesOn(bars, ref) {
  if (!ref) return null;
  const at = new Map(ref.map((b) => [b.t, b.c]));
  return bars.map((b) => (at.has(b.t) ? at.get(b.t) : null));
}

/**
 * Series contexts for every symbol → { SYM: S } (core/strategy-rules.js seriesContext).
 *   bars       { SYM: Bar[] } on the spec's timeframe
 *   daily      { SYM: Bar[] } daily bars (intraday runs: levels, setups, regime line-up)
 *   bench      the benchmark's bars on the same timeframe (relative strength)
 *   sectorBars { ETF: Bar[] } on the same timeframe; sectorOf { SYM: ETF }
 *   regime     { t, score, label } on daily bars (core/regime.js regimeSeries + times)
 *   breadth    { t, above50 } on daily bars
 *   earnings   { SYM: ['YYYY-MM-DD'] }; rank3m (SYM) → (i) → rank (rs-leader)
 */
export function buildContexts(spec, { bars = {}, daily = {}, bench = null, sectorBars = {}, sectorOf = {}, regime = null, breadth = null, earnings = {}, rank3m = null } = {}) {
  const tf = spec.timeframe, intraday = tf !== '1d', out = {};
  const regDaily = regime ? regime.t.map((t) => ({ t })) : null;
  for (const sym of Object.keys(bars)) {
    const b = bars[sym];
    if (!b || !b.length) continue;
    const S = seriesContext(b, {
      tf, symbol: sym, bench: closesOn(b, bench), sector: sectorOf[sym] && sectorBars[sectorOf[sym]] ? closesOn(b, sectorBars[sectorOf[sym]]) : null,
      regime: regime ? { score: lineUp(b, regDaily, regime.score, intraday), label: lineUp(b, regDaily, regime.label, intraday) } : null,
      breadth: breadth ? lineUp(b, breadth.t.map((t) => ({ t })), breadth.above50, intraday) : null,
      earnings: earnings[sym] || null, daily: intraday ? daily[sym] || null : b,
    });
    if (rank3m) S.rank3m = rank3m(sym);
    out[sym] = S;
  }
  return out;
}

/** Which period a bar starts, for rebalancing: its New York week or month. */
const periodOf = (t, kind, intraday) => (kind === 'weekly' ? mondayOf(t) : nyClock(t + (intraday ? 0 : 12 * 3_600_000)).date.slice(0, 7));

/**
 * Run `spec` (already through withDefaults and checkStrategy) →
 *   { trades, equity: [[t, value]], exposure: [[t, open positions]], capital, start, end, symbols }
 *   contexts   buildContexts' result
 *   from, to   ms: bars outside are not traded (the indicators still see the history before `from`)
 *   sectorOf   { SYM: ETF } (each trade's sector)
 *   onProgress ({ share }) about every 5% of the timeline
 * Trade = { symbol, sector, side, entryT, entry, exitT, exit, shares, pnl, ret, r, bars, reason, regime, stop, target }
 *   reason: stop | target | time | rule | session | end;  r = pnl over the risk taken (null with no stop)
 */
export function simulate(spec, { contexts, from = -Infinity, to = Infinity, sectorOf = {}, capital = CAPITAL, onProgress = null } = {}) {
  const syms = Object.keys(contexts), intraday = spec.timeframe !== '1d', day = spec.horizon === 'day';
  const ex = (spec.exit && spec.exit.any) || [];
  const stopX = ex.find(isStop), targetX = ex.find(isTarget), timeX = ex.find(isTime), ruleX = ex.filter((x) => !isStop(x) && !isTarget(x) && !isTime(x));
  const slip = ((spec.costs && spec.costs.slippageCents) || 0) / 100, fees = !spec.costs || spec.costs.fees !== 'none';
  const sides = spec.side === 'both' ? ['long', 'short'] : [spec.side];
  const lead = firstRule(spec.entry || {});

  // Per symbol: entries per side, exit rules per side, ATR, the session's last bar.
  const P = {};
  for (const sym of syms) {
    const S = contexts[sym], n = S.bars.length;
    const entry = {}, exitR = {};
    for (const side of sides) {
      const mirror = spec.side === 'both' && side === 'short';
      entry[side] = entrySeries(S, spec.entry || {}, side, mirror);
      exitR[side] = ruleX.length ? entrySeries(S, { any: ruleX }, side, mirror) : null;
    }
    const lastOfSession = new Uint8Array(n);
    if (day) for (let i = 0; i < n; i++) lastOfSession[i] = i === n - 1 || nyClock(S.t[i + 1]).date !== nyClock(S.t[i]).date ? 1 : 0;
    P[sym] = { S, entry, exitR, atr: atr(S.bars, 14), lastOfSession, ptr: 0,
      sup: stopX && stopX.stop === 'level' ? series(S, 'level.nearestSupport') : null, res: (stopX && stopX.stop === 'level') || (targetX && targetX.target === 'level') ? series(S, 'level.nearestResistance') : null };
    if (targetX && targetX.target === 'level' && !P[sym].sup) P[sym].sup = series(S, 'level.nearestSupport');
  }

  const times = [...new Set(syms.flatMap((s) => contexts[s].t.filter((t) => t >= from && t < to)))].sort((a, b) => a - b);
  for (const sym of syms) { const t = contexts[sym].t; let p = 0; while (p < t.length && t[p] < from) p++; P[sym].ptr = p; }

  let cash = capital;
  const pos = new Map(), pendIn = new Map(), pendOut = new Set(), lastClose = new Map(), trades = [], equity = [], exposure = [];
  const buy = (px) => px + slip, sell = (px) => Math.max(0.0001, px - slip);

  function close(sym, px, t, reason) {
    const q = pos.get(sym), long = q.side === 'long';
    const fill = long ? sell(px) : buy(px);
    const fee = long ? (fees ? feesOf('sell', q.shares, fill) : 0) : 0;
    if (long) cash += q.shares * fill - fee; else cash -= q.shares * fill;
    const pnl = (long ? fill - q.entry : q.entry - fill) * q.shares - fee - q.entryFee + q.realized;
    trades.push({ symbol: sym, sector: sectorOf[sym] || null, side: q.side, entryT: q.entryT, entry: q.entry, exitT: t, exit: fill, shares: q.shares,
      pnl, ret: pnl / (q.entry * q.shares), r: q.riskPS > 0 ? pnl / (q.riskPS * q.shares) : null, bars: q.bars, reason, regime: q.regime, stop: q.stop, target: q.target });
    pos.delete(sym);
    pendOut.delete(sym);
  }
  function targetShares(px, riskPS, eq) {
    const k = spec.sizing.kind, v = spec.sizing.value;
    let sh = k === 'equal' ? eq / spec.maxPositions / px : k === 'percent' ? eq * v / 100 / px : riskPS > 0 ? eq * v / 100 / riskPS : 0;
    sh = Math.min(sh, eq / px);   // no leverage
    return Math.floor(sh);
  }
  function open(sym, side, b, iSig, eq) {
    const p = P[sym], a = p.atr[iSig], long = side === 'long', sgn = long ? 1 : -1;
    const px = long ? buy(b.o) : sell(b.o);
    let stop = null;
    if (stopX) {
      if (stopX.stop === 'atr' && a) stop = px - sgn * stopX.value * a;
      else if (stopX.stop === 'percent') stop = px * (1 - sgn * stopX.value / 100);
      else if (stopX.stop === 'level') { const lv = long ? p.sup && p.sup[iSig] : p.res && p.res[iSig]; stop = lv != null && a ? lv - sgn * STOP_PAD_ATR * a : a ? px - sgn * FALLBACK_STOP_ATR * a : null; }
      if (stop != null && (long ? stop >= px : stop <= px)) stop = null;
    }
    const riskPS = stop != null ? Math.abs(px - stop) : 0;
    let target = null;
    if (targetX) {
      if (targetX.target === 'r' && riskPS > 0) target = px + sgn * targetX.value * riskPS;
      else if (targetX.target === 'percent') target = px * (1 + sgn * targetX.value / 100);
      else if (targetX.target === 'level') { const lv = long ? p.res && p.res[iSig] : p.sup && p.sup[iSig]; if (lv != null && (long ? lv > px : lv < px)) target = lv; }
    }
    let shares = targetShares(px, riskPS, eq);
    shares = Math.min(shares, Math.floor(free() / px));
    if (shares < 1) return false;
    const entryFee = !long && fees ? feesOf('sell', shares, px) : 0;
    if (long) cash -= shares * px; else cash += shares * px - entryFee;
    const reg = p.S.regime && p.S.regime.label ? p.S.regime.label[iSig] : null;
    lastClose.set(sym, b.o);   // marked at its fill until this bar closes
    pos.set(sym, { side, shares, entry: px, entryT: b.t, stop, target, riskPS, bars: 0, entryFee: long ? 0 : entryFee, realized: 0, regime: reg });
    return true;
  }
  /** Stop and target inside bar b (the stop first; a gap through either fills at the open). */
  function intrabar(sym, b) {
    const q = pos.get(sym);
    if (!q) return;
    const long = q.side === 'long';
    if (q.stop != null && (long ? b.o <= q.stop : b.o >= q.stop)) return close(sym, b.o, b.t, 'stop');
    if (q.stop != null && (long ? b.l <= q.stop : b.h >= q.stop)) return close(sym, q.stop, b.t, 'stop');
    if (q.target != null && (long ? b.o >= q.target : b.o <= q.target)) return close(sym, b.o, b.t, 'target');
    if (q.target != null && (long ? b.h >= q.target : b.l <= q.target)) return close(sym, q.target, b.t, 'target');
  }
  // Cash that can open a position: a short's proceeds are not spendable, and its
  // value is held again as collateral (no leverage either way).
  const free = () => { let held = 0; for (const [sym, q] of pos) if (q.side === 'short') held += 2 * q.shares * (lastClose.get(sym) || q.entry); return cash - held; };
  const value = () => { let v = cash; for (const [sym, q] of pos) { const c = lastClose.get(sym); v += (q.side === 'long' ? 1 : -1) * q.shares * c; } return v; };

  let prevPeriod = null, eqPrev = capital, nextTick = 0;
  for (let d = 0; d < times.length; d++) {
    const T = times[d], here = [];
    for (const sym of syms) { const p = P[sym]; if (p.ptr < p.S.t.length && p.S.t[p.ptr] === T) here.push([sym, p.ptr]); }
    // Rebalance at the open of a new week or month.
    if (spec.rebalance && spec.rebalance !== 'none') {
      const per = periodOf(T, spec.rebalance, intraday);
      if (prevPeriod != null && per !== prevPeriod) for (const [sym, i] of here) {
        const q = pos.get(sym);
        if (!q) continue;
        const b = P[sym].S.bars[i], want = targetShares(b.o, q.riskPS, eqPrev), diff = want - q.shares;
        if (!diff || want < 1) continue;
        const long = q.side === 'long', grow = diff > 0, px = long === grow ? buy(b.o) : sell(b.o), k = Math.abs(diff);
        if (grow && k * px > free()) continue;
        const fee = (long && !grow) || (!long && grow) ? (fees ? feesOf('sell', k, px) : 0) : 0;
        if (long) cash += grow ? -k * px : k * px - fee; else cash += grow ? k * px - fee : -k * px;
        if (grow) { q.entry = (q.entry * q.shares + px * k) / (q.shares + k); q.entryFee += fee; }
        else q.realized += (long ? px - q.entry : q.entry - px) * k - fee;   // the trimmed shares' result stays on the trade
        q.shares = want;
      }
      prevPeriod = per;
    }
    // Exits at the open (a rule that fired at the last close), then stops and targets.
    for (const [sym, i] of here) {
      const b = P[sym].S.bars[i];
      if (pos.has(sym) && pendOut.has(sym)) close(sym, b.o, T, 'rule');
      else intrabar(sym, b);
    }
    // Entries signalled at the last close, the strongest first.
    const cands = here.filter(([sym]) => pendIn.has(sym) && !pos.has(sym)).map(([sym, i]) => ({ sym, i, ...pendIn.get(sym) })).sort((x, y) => y.rank - x.rank || x.sym.localeCompare(y.sym));
    // A signal is good for its symbol's NEXT bar only (other symbols' times in between do not count).
    for (const [sym] of here) pendIn.delete(sym);
    for (const c of cands) {
      if (pos.size >= spec.maxPositions) break;
      const b = P[c.sym].S.bars[c.i];
      if (open(c.sym, c.side, b, c.iSig, eqPrev)) intrabar(c.sym, b);
    }
    // The close: time and session exits, then tomorrow's signals.
    for (const [sym, i] of here) {
      const p = P[sym], b = p.S.bars[i];
      lastClose.set(sym, b.c);
      const q = pos.get(sym);
      if (q) {
        q.bars++;
        if (timeX && q.bars >= timeX.bars) close(sym, b.c, T, 'time');
        else if (day && p.lastOfSession[i]) close(sym, b.c, T, 'session');
        else if (p.exitR[q.side] && p.exitR[q.side][i]) pendOut.add(sym);
      } else if (!(day && p.lastOfSession[i])) {
        for (const side of sides) if (p.entry[side][i]) {
          const m = marginOf(p.S, side === 'short' && spec.side === 'both' ? mirrorRule(lead) : lead, i);
          pendIn.set(sym, { side, iSig: i, rank: m });
          break;
        }
      }
      p.ptr++;
    }
    eqPrev = value();
    equity.push([T, eqPrev]);
    exposure.push([T, pos.size]);
    if (onProgress && d >= nextTick) { onProgress({ share: d / times.length }); nextTick = d + Math.max(1, Math.floor(times.length / 20)); }
  }
  for (const sym of [...pos.keys()]) close(sym, lastClose.get(sym), times[times.length - 1], 'end');
  if (equity.length) { eqPrev = value(); equity[equity.length - 1] = [equity[equity.length - 1][0], eqPrev]; }
  return { trades, equity, exposure, capital, start: times[0] == null ? null : times[0], end: times.length ? times[times.length - 1] : null, symbols: syms.length };
}

/** A buy-and-hold curve on `times`: `capital` split equally over `barsList`
 *  (each bought at its first bar on or after the start, cash until then),
 *  marked at each time's last known close. */
export function holdCurve(times, barsList, capital = CAPITAL) {
  const list = barsList.filter((b) => b && b.length);
  if (!times.length || !list.length) return [];
  const share = capital / list.length, ptr = list.map(() => 0), held = list.map(() => null), last = list.map(() => null);
  return times.map((T) => {
    let v = 0;
    list.forEach((b, k) => {
      while (ptr[k] < b.length && b[ptr[k]].t <= T) { last[k] = b[ptr[k]].c; if (held[k] == null && b[ptr[k]].t >= times[0]) held[k] = share / b[ptr[k]].o; ptr[k]++; }
      v += held[k] == null ? share : held[k] * last[k];
    });
    return [T, v];
  });
}
