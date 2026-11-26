// COPY of A1-Priv TradeHub/core/strategy-rules.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// The rule language a strategy is written in (docs/TradeHub/quant/phase-06.md,
// "The strategy spec"): the indicators a rule may read, the comparisons it may
// make, and how a rule becomes a yes/no for every bar. Pure; every series is
// causal (its value at bar i reads bars ≤ i only; tested per indicator).
//
// A strategy is DATA: nothing here runs text as code. This file is the ONE
// list of indicators: the builder's menus and Neo Quant's prompt (Phase 9B)
// both read INDICATORS from here.
//
// Rule  = { ind, args?: [numbers or choices, in the order listed], op, than }
//         than = a number, [lo, hi] for 'between', a label for 'is', a bar
//         count for 'rising' / 'falling' (default 1), or { ind, args } (another series)
//       | { setup: '<detector>' } (a Phase 5 setup firing on that bar)
import { sma, ema, rsi, atr, adx, bollinger, vwap, roc, macd, relVolume } from './indicators.js';
import { streak } from './streaks.js';
import { relStrength } from './strength.js';
import { nyClock } from './clock.js';
import { isTradingDay, addDays } from './holidays.js';
import { prepSwing, levelsAsOf, detectSwing, SWING_SETUPS } from './detect-swing.js';
import { detectDay, DAY_SETUPS } from './detect-day.js';
import { LABELS } from './regime.js';

const num = (name, def, min, max) => ({ name, type: 'number', def, min, max });
const choice = (name, def, values) => ({ name, type: 'choice', def, values });
const len = (def, min = 2, max = 400) => num('length', def, min, max);
const DAILY = new Set(['1d']);
// The earnings history lives in the Catalysts calendar (Firestore, recent dates
// only), so a backtest has no past earnings dates to read yet.
const NO_EARNINGS = 'earnings history is not available to the backtester yet';

/** Every indicator: `{ text, args, kind, fn(S, args) → series, needs? }`.
 *  kind: 'price' (in the stock's price units), 'number', 'fraction' (0.05 = 5%), 'label'.
 *  needs: 'intraday' | 'daily' when it only exists on one kind of bar. */
export const INDICATORS = {
  close: { text: 'the close', args: [], kind: 'price', fn: (S) => S.c },
  open: { text: 'the open', args: [], kind: 'price', fn: (S) => S.o },
  high: { text: 'the high', args: [], kind: 'price', fn: (S) => S.h },
  low: { text: 'the low', args: [], kind: 'price', fn: (S) => S.l },
  volume: { text: 'volume', args: [], kind: 'number', fn: (S) => S.v },
  sma: { text: 'simple moving average', args: [len(50)], kind: 'price', fn: (S, [n]) => sma(S.c, n) },
  ema: { text: 'exponential moving average', args: [len(20)], kind: 'price', fn: (S, [n]) => ema(S.c, n) },
  rsi: { text: 'RSI', args: [len(14, 2, 100)], kind: 'number', fn: (S, [n]) => rsi(S.c, n) },
  atr: { text: 'ATR', args: [len(14, 2, 100)], kind: 'price', fn: (S, [n]) => atr(S.bars, n) },
  adx: { text: 'ADX', args: [len(14, 2, 100)], kind: 'number', fn: (S, [n]) => adx(S.bars, n).adx },
  'bollinger.upper': { text: 'upper Bollinger band', args: [len(20), num('width', 2, 0.5, 4)], kind: 'price', fn: (S, [n, k]) => bollinger(S.c, n, k).upper },
  'bollinger.lower': { text: 'lower Bollinger band', args: [len(20), num('width', 2, 0.5, 4)], kind: 'price', fn: (S, [n, k]) => bollinger(S.c, n, k).lower },
  'bollinger.mid': { text: 'middle Bollinger band', args: [len(20)], kind: 'price', fn: (S, [n]) => bollinger(S.c, n, 2).mid },
  vwap: { text: 'VWAP', args: [], kind: 'price', needs: 'intraday', fn: (S) => vwap(S.bars) },
  roc: { text: 'rate of change', args: [len(10, 1, 400)], kind: 'fraction', fn: (S, [n]) => roc(S.c, n) },
  macd: { text: 'MACD', args: [num('fast', 12, 2, 100), num('slow', 26, 3, 200), num('signal', 9, 2, 50)], kind: 'number', fn: (S, a) => macd(S.c, ...a).macd },
  'macd.signal': { text: 'MACD signal line', args: [num('fast', 12, 2, 100), num('slow', 26, 3, 200), num('signal', 9, 2, 50)], kind: 'number', fn: (S, a) => macd(S.c, ...a).signal },
  'macd.hist': { text: 'MACD histogram', args: [num('fast', 12, 2, 100), num('slow', 26, 3, 200), num('signal', 9, 2, 50)], kind: 'number', fn: (S, a) => macd(S.c, ...a).hist },
  relVolume: { text: 'relative volume', args: [len(20)], kind: 'number', fn: (S, [n]) => relVolume(S.bars, n, { floor: true }) },   // BV: a floor on partial bars
  streak: { text: 'the up/down streak', args: [], kind: 'number', fn: (S) => streak(S.c) },
  relStrength: { text: 'relative strength', args: [len(20, 1, 400), choice('vs', 'SPY', ['SPY', 'sector'])], kind: 'fraction',
    fn: (S, [n, vs]) => { const b = vs === 'sector' ? S.sector : S.bench; return b ? relStrength(S.c, b, n) : S.c.map(() => null); } },
  'regime.score': { text: 'the regime score', args: [], kind: 'number', fn: (S) => (S.regime ? S.regime.score : S.c.map(() => null)) },
  'regime.label': { text: 'the regime', args: [], kind: 'label', values: LABELS.map((x) => x[1]), fn: (S) => (S.regime ? S.regime.label : S.c.map(() => null)) },
  'breadth.above50': { text: 'the share of the S&P 100 above its 50-day average', args: [], kind: 'fraction', fn: (S) => S.breadth || S.c.map(() => null) },
  'level.nearestSupport': { text: 'the nearest support', args: [], kind: 'price', fn: (S) => nearestLevels(S).support },
  'level.nearestResistance': { text: 'the nearest resistance', args: [], kind: 'price', fn: (S) => nearestLevels(S).resistance },
  gapPct: { text: 'the opening gap', args: [], kind: 'fraction', fn: (S) => gapSeries(S) },
  dayOfWeek: { text: 'the day of the week (1 Monday to 5 Friday)', args: [], kind: 'number', fn: (S) => S.t.map((t) => nyClock(S.daily === S.bars ? t + 12 * 3_600_000 : t).dow) },
  daysToEarnings: { text: 'trading days to the next earnings report', args: [], kind: 'number', fn: (S) => daysToEarnings(S), unavailable: NO_EARNINGS },
};
export const UNAVAILABLE_SETUPS = { 'earnings-drift': NO_EARNINGS };
export const OPS = ['>', '<', 'crossesAbove', 'crossesBelow', 'between', 'rising', 'falling', 'is'];
export const OP_TEXT = { '>': 'is above', '<': 'is below', crossesAbove: 'crosses above', crossesBelow: 'crosses below', between: 'is between', rising: 'is rising', falling: 'is falling', is: 'is' };
export const SETUPS = [...DAY_SETUPS, ...SWING_SETUPS];
export const LEVEL_STEP = 5;   // daily levels for level.* are worked out again every 5 bars (always as of a past bar)

/**
 * The series context for one symbol's bars →
 *   { bars, t, o, h, l, c, v, tf, symbol, bench, sector, regime, breadth,
 *     earnings, daily, cache }
 * bench / sector = closes lined up on `bars` (null where unknown); regime =
 * { score[], label[] } and breadth = above50[] lined up the same way;
 * earnings = a Set of 'YYYY-MM-DD'; daily = the symbol's daily bars (for an
 * intraday run's levels and setups; the bars themselves on a daily run).
 */
export function seriesContext(bars, { tf = '1d', symbol = '', bench = null, sector = null, regime = null, breadth = null, earnings = null, daily = null, lastSetupOnly = false } = {}) {
  return {
    bars, tf, symbol, t: bars.map((b) => b.t), o: bars.map((b) => b.o), h: bars.map((b) => b.h), l: bars.map((b) => b.l), c: bars.map((b) => b.c), v: bars.map((b) => b.v),
    bench, sector, regime, breadth, earnings: earnings ? new Set(earnings) : null,
    daily: DAILY.has(tf) ? bars : daily, lastSetupOnly, cache: new Map(),
  };
}

/** The arguments of `ind` with defaults filled in → the list (in order). */
export function argsOf(ind, args = []) {
  const spec = INDICATORS[ind];
  return spec.args.map((a, k) => (args && args[k] != null ? args[k] : a.def));
}

/** Series of `ind` with `args` on S (cached). */
export function series(S, ind, args) {
  const a = argsOf(ind, args), key = ind + '(' + a.join(',') + ')';
  if (!S.cache.has(key)) S.cache.set(key, INDICATORS[ind].fn(S, a));
  return S.cache.get(key);
}

/** The Phase 5 setup `name` firing on each bar for `dir` (1 = it fired). */
export function setupSeries(S, name, dir = 'long') {
  const key = 'setup:' + name + ':' + dir;
  if (S.cache.has(key)) return S.cache.get(key);
  const out = new Uint8Array(S.bars.length);
  if (SWING_SETUPS.includes(name) && DAILY.has(S.tf)) {
    const earnings = S.earnings || null;
    for (let i = S.lastSetupOnly ? Math.max(1, S.bars.length - 1) : 1; i < S.bars.length; i++) for (const c of detectSwing({ symbol: S.symbol, bars: { '1d': S.bars }, i, earnings, rs: S.rank3m ? { rank3m: S.rank3m } : null })) if (c.setup === name && c.dir === dir) out[i] = 1;
  } else if (DAY_SETUPS.includes(name) && S.tf === '5m') {
    const lv = name === 'sweep' || name === 'level-reaction' ? dayLevels(S) : () => null;
    for (let i = S.lastSetupOnly ? S.bars.length - 1 : 0; i < S.bars.length; i++) for (const c of detectDay({ symbol: S.symbol, setup: name, bars: { '5m': S.bars }, i, levels: lv(i) })) if (c.setup === name && c.dir === dir) out[i] = 1;
  }
  S.cache.set(key, out);
  return out;
}

/** For intraday bars: (i) → the daily levels as of the session before bar i's. */
function dayLevels(S) {
  const daily = S.daily || [], p = daily.length ? prepSwing(daily) : null, byDay = new Map();
  return (i) => {
    if (!p) return null;
    const date = nyClock(S.t[i]).date;
    if (!byDay.has(date)) {
      let j = -1;
      for (let x = daily.length - 1; x >= 0; x--) if (nyClock(daily[x].t + 12 * 3_600_000).date < date) { j = x; break; }
      byDay.set(date, j >= 0 ? levelsAsOf(p, j) : null);
    }
    return byDay.get(date);
  };
}

/** Nearest support (highest level top under the close) and resistance (lowest
 *  level bottom over it) at each bar, from daily levels as of a past bar. */
function nearestLevels(S) {
  if (S.cache.has('levels')) return S.cache.get('levels');
  const n = S.bars.length, support = new Array(n).fill(null), resistance = new Array(n).fill(null);
  let lvAt;
  if (DAILY.has(S.tf)) { const p = prepSwing(S.bars); lvAt = (i) => levelsAsOf(p, i - (i % LEVEL_STEP)); }
  else lvAt = dayLevels(S);
  for (let i = 0; i < n; i++) {
    const lv = lvAt(i);
    if (!lv) continue;
    for (const l of [...lv.supports, ...lv.resistances]) {
      const lo = l.lo == null ? l.price : l.lo, hi = l.hi == null ? l.price : l.hi;
      if (hi < S.c[i] && (support[i] == null || hi > support[i])) support[i] = hi;
      if (lo > S.c[i] && (resistance[i] == null || lo < resistance[i])) resistance[i] = lo;
    }
  }
  const out = { support, resistance };
  S.cache.set('levels', out);
  return out;
}

/** The opening gap: a day's open over the close before it, minus 1, on every bar of that day. */
function gapSeries(S) {
  const out = new Array(S.bars.length).fill(null);
  if (DAILY.has(S.tf)) { for (let i = 1; i < S.bars.length; i++) out[i] = S.o[i] / S.c[i - 1] - 1; return out; }
  let day = '', gap = null, prevClose = null;
  for (let i = 0; i < S.bars.length; i++) {
    const d = nyClock(S.t[i]).date;
    if (d !== day) { gap = prevClose ? S.o[i] / prevClose - 1 : null; day = d; }
    out[i] = gap;
    prevClose = S.c[i];
  }
  return out;
}

/** Trading days from each bar's day to the next earnings report (0 on the day; null when none is known). */
function daysToEarnings(S) {
  const out = new Array(S.bars.length).fill(null);
  if (!S.earnings || !S.earnings.size) return out;
  const dates = [...S.earnings].sort(), memo = new Map();
  for (let i = 0; i < S.bars.length; i++) {
    const d = nyClock(S.t[i] + (DAILY.has(S.tf) ? 12 * 3_600_000 : 0)).date;
    if (!memo.has(d)) {
      const next = dates.find((x) => x >= d);
      let n = null;
      if (next) { n = 0; for (let x = addDays(d, 1); x <= next && n < 400; x = addDays(x, 1)) if (isTradingDay(x)) n++; }
      memo.set(d, n);
    }
    out[i] = memo.get(d);
  }
  return out;
}

/** Is `x` a usable indicator reference → a reason it is not, or ''. */
export function checkRef(x, tf) {
  if (!x || typeof x !== 'object') return 'a series must be { ind, args }';
  const spec = INDICATORS[x.ind];
  if (!spec) return `"${x.ind}" is not an indicator TradeHub knows (${Object.keys(INDICATORS).join(', ')})`;
  if (spec.needs === 'intraday' && DAILY.has(tf)) return `\`${x.ind}\` needs an intraday timeframe`;
  if (spec.unavailable) return `\`${x.ind}\` cannot be backtested: ${spec.unavailable}`;
  const want = spec.args, got = x.args == null ? [] : x.args;
  if (!Array.isArray(got)) return `\`${x.ind}\` takes its arguments as a list`;
  const words = ['no', 'one', 'two', 'three'];
  const sayArgs = () => (want.length ? `\`${x.ind}\` takes ${words[want.length] || want.length} ${want.length === 1 ? 'value' : 'values'}: ${want.map((a) => a.type === 'choice' ? `${a.name} (${a.values.join(' or ')})` : `its ${a.name}`).join(', ')}` : `\`${x.ind}\` takes no values`);
  if (got.length > want.length) return sayArgs();
  for (let k = 0; k < got.length; k++) {
    const a = want[k], v = got[k];
    if (v == null) continue;
    if (a.type === 'number' && !(typeof v === 'number' && Number.isFinite(v))) return sayArgs();
    if (a.type === 'number' && (v < a.min || v > a.max)) return `\`${x.ind}\`'s ${a.name} must be from ${a.min} to ${a.max}`;
    if (a.type === 'choice' && !a.values.includes(v)) return `\`${x.ind}\`'s ${a.name} must be ${a.values.join(' or ')}`;
  }
  if (x.ind.startsWith('macd')) { const [f, s] = argsOf(x.ind, got); if (f >= s) return 'MACD\'s fast length must be shorter than its slow length'; }
  return '';
}

/** Why a rule cannot be used on timeframe `tf` → reasons (empty = fine). */
export function checkRule(rule, tf = '1d') {
  if (!rule || typeof rule !== 'object') return ['a rule must be an object'];
  if (rule.setup != null) {
    if (!SETUPS.includes(rule.setup)) return [`"${rule.setup}" is not a setup (${SETUPS.join(', ')})`];
    if (UNAVAILABLE_SETUPS[rule.setup]) return [`the ${rule.setup} setup cannot be backtested: ${UNAVAILABLE_SETUPS[rule.setup]}`];
    if (SWING_SETUPS.includes(rule.setup) && !DAILY.has(tf)) return [`the ${rule.setup} setup runs on daily bars`];
    if (DAY_SETUPS.includes(rule.setup) && tf !== '5m') return [`the ${rule.setup} setup runs on 5-minute bars`];
    return [];
  }
  const bad = checkRef(rule, tf);
  if (bad) return [bad];
  if (!OPS.includes(rule.op)) return [`"${rule.op}" is not a comparison (${OPS.join(', ')})`];
  const kind = INDICATORS[rule.ind].kind, t = rule.than;
  if (rule.op === 'is') {
    if (kind !== 'label') return ['"is" compares a label, such as the regime'];
    if (!INDICATORS[rule.ind].values.includes(t)) return [`the regime is one of ${INDICATORS[rule.ind].values.join(', ')}`];
    return [];
  }
  if (kind === 'label') return [`\`${rule.ind}\` is a label: compare it with "is"`];
  if (rule.op === 'between') return Array.isArray(t) && t.length === 2 && t.every(Number.isFinite) && t[0] <= t[1] ? [] : ['"between" takes two numbers, the lower first'];
  if (rule.op === 'rising' || rule.op === 'falling') return t == null || (Number.isInteger(t) && t >= 1 && t <= 250) ? [] : [`"${rule.op}" takes a number of bars from 1 to 250`];
  if (typeof t === 'number') return Number.isFinite(t) ? [] : ['the value must be a number'];
  if (t && typeof t === 'object') { const b = checkRef(t, tf); return b ? [b] : []; }
  return ['compare with a number or another indicator'];
}

/** A rule as yes/no per bar (Uint8Array, 1 = true) on S, for `dir` (a setup rule's side). */
export function evalRule(S, rule, dir = 'long') {
  if (rule.setup != null) return setupSeries(S, rule.setup, dir);
  const n = S.bars.length, out = new Uint8Array(n), a = series(S, rule.ind, rule.args), t = rule.than;
  const b = t && typeof t === 'object' && !Array.isArray(t) ? series(S, t.ind, t.args) : null;
  const B = (i) => (b ? b[i] : t);
  const ok = (x) => x != null && Number.isFinite(x);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    switch (rule.op) {
      case '>': out[i] = ok(x) && ok(B(i)) && x > B(i) ? 1 : 0; break;
      case '<': out[i] = ok(x) && ok(B(i)) && x < B(i) ? 1 : 0; break;
      case 'crossesAbove': out[i] = i > 0 && ok(x) && ok(B(i)) && ok(a[i - 1]) && ok(B(i - 1)) && a[i - 1] <= B(i - 1) && x > B(i) ? 1 : 0; break;
      case 'crossesBelow': out[i] = i > 0 && ok(x) && ok(B(i)) && ok(a[i - 1]) && ok(B(i - 1)) && a[i - 1] >= B(i - 1) && x < B(i) ? 1 : 0; break;
      case 'between': out[i] = ok(x) && x >= t[0] && x <= t[1] ? 1 : 0; break;
      case 'rising': { const k = t || 1; out[i] = i >= k && ok(x) && ok(a[i - k]) && x > a[i - k] ? 1 : 0; break; }
      case 'falling': { const k = t || 1; out[i] = i >= k && ok(x) && ok(a[i - k]) && x < a[i - k] ? 1 : 0; break; }
      case 'is': out[i] = x === t ? 1 : 0; break;
      default: out[i] = 0;
    }
  }
  return out;
}

/** The same rule for the other side: > and <, the crosses, rising and falling swap. */
export function mirrorRule(rule) {
  const SWAP = { '>': '<', '<': '>', crossesAbove: 'crossesBelow', crossesBelow: 'crossesAbove', rising: 'falling', falling: 'rising' };
  return rule.setup != null || !SWAP[rule.op] ? rule : { ...rule, op: SWAP[rule.op] };
}

/** How strongly a comparison holds at bar i: (a − b)/|b| for > (and the
 *  mirror for <), else 0. A strategy ranks candidates by its first rule's margin. */
export function marginOf(S, rule, i) {
  if (!rule || rule.setup != null || !['>', '<', 'crossesAbove', 'crossesBelow'].includes(rule.op)) return 0;
  const a = series(S, rule.ind, rule.args)[i], t = rule.than, b = t && typeof t === 'object' ? series(S, t.ind, t.args)[i] : t;
  if (a == null || b == null || !b) return 0;
  const m = (a - b) / Math.abs(b);
  return rule.op === '<' || rule.op === 'crossesBelow' ? -m : m;
}
