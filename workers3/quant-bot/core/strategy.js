// COPY of A1-Priv TradeHub/core/strategy.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// A strategy for the backtester (docs/TradeHub/quant/phase-06.md, "The strategy
// spec"). A strategy is DATA, never code: nothing the AI writes is ever run.
// Pure.
//
// { v: 1, name, horizon: 'day' | 'swing' | 'invest',
//   universe: { symbols?, sectors?: ['XLK', ...], lists?: ['watchlist','sp100','sectors','indexes'] },
//   timeframe: '1d' | '1h' | '15m' | '5m', from?: 'YYYY-MM-DD' | 'max', to?: 'YYYY-MM-DD',
//   entry: { all?: [Rule | { any: [Rule] }], any?: [Rule | { all: [Rule] }] },
//   exit:  { any: [Rule | Stop | Target | TimeExit] },
//   side: 'long' | 'short' | 'both', sizing: { kind: 'equal' | 'fixedRisk' | 'percent', value },
//   maxPositions?, rebalance?: 'none' | 'weekly' | 'monthly',
//   costs?: { slippageCents, fees: 'webull' | 'none' }, benchmark?: 'SPY' }
// Rule: core/strategy-rules.js. Stop = { stop: 'atr' | 'percent' | 'level', value };
// Target = { target: 'r' | 'percent' | 'level', value }; TimeExit = { bars }.
import { INDICATORS, OP_TEXT, checkRule, argsOf } from './strategy-rules.js';
import { SECTORS } from './universe.js';

export const STRATEGY_V = 1;
export const HORIZONS = ['day', 'swing', 'invest'], TIMEFRAMES = ['1d', '1h', '15m', '5m'], SIDES = ['long', 'short', 'both'];
export const SIZINGS = ['equal', 'fixedRisk', 'percent'], REBALANCES = ['none', 'weekly', 'monthly'], LISTS = ['watchlist', 'sp100', 'sectors', 'indexes'];
export const SECTOR_FUNDS = SECTORS.map((s) => s.sym);
export const MAX_YEARS_DAILY = 20, INTRADAY_START = '2016-01-04', CAPITAL = 100_000;
const SYM_RE = /^\^?[A-Z0-9][A-Z0-9.\-]{0,9}$/, DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TF_TEXT = { '1d': 'daily bars', '1h': 'hourly bars', '15m': '15-minute bars', '5m': '5-minute bars' };
const LIST_TEXT = { watchlist: 'the watchlist', sp100: 'the S&P 100', sectors: 'the sector funds', indexes: 'the index funds' };

/** What a spec gets for every field it leaves out ("do whatever is best"). */
export function defaultsFor(spec = {}) {
  const horizon = HORIZONS.includes(spec.horizon) ? spec.horizon : 'swing';
  // Fixed risk needs a stop: exits that were given without one get the account split equally
  // instead (Phase 9B: "sell after a 10% gain or two weeks" must run as said).
  const ownExits = spec.exit && Array.isArray(spec.exit.any) && spec.exit.any.length ? spec.exit.any : null;
  const noStop = !!ownExits && !ownExits.some((x) => x && x.stop != null);
  return {
    v: STRATEGY_V, name: 'Untitled strategy', horizon,
    // A day run reads 5-minute bars month by month: the watchlist only, by default (no usage spikes).
    universe: { lists: horizon === 'day' ? ['watchlist'] : ['watchlist', 'sp100'] },
    timeframe: horizon === 'day' ? '5m' : '1d',
    from: 'max', to: null,
    exit: { any: [{ stop: 'atr', value: 2 }, { target: 'r', value: 3 }, { bars: 20 }] },
    side: 'long', sizing: noStop ? { kind: 'equal', value: null } : { kind: 'fixedRisk', value: 1 }, maxPositions: 10, rebalance: 'none',
    costs: { slippageCents: 1, fees: 'webull' }, benchmark: 'SPY',
  };
}

/** `spec` with every missing field filled → `{ spec, assumed }`; `assumed`
 *  names the fields that took a default, so the results can say so. `today`
 *  = 'YYYY-MM-DD' fills `to`. */
export function withDefaults(spec = {}, { today = null } = {}) {
  const d = defaultsFor(spec), out = { ...spec }, assumed = [];
  for (const k of Object.keys(d)) {
    const missing = out[k] == null || (k === 'universe' && !hasUniverse(out.universe)) || (k === 'exit' && !(out.exit && Array.isArray(out.exit.any) && out.exit.any.length));
    if (missing) { out[k] = k === 'to' ? today : d[k]; if (k !== 'v' && k !== 'name') assumed.push(k); }
  }
  if (out.sizing && out.sizing.kind === 'equal') out.sizing = { kind: 'equal', value: null };
  return { spec: out, assumed };
}
const hasUniverse = (u) => !!(u && ((u.symbols && u.symbols.length) || (u.sectors && u.sectors.length) || (u.lists && u.lists.length)));

/** An exit of the spec's exit list: a stop, a target, a time exit (anything else is a rule). */
export const isStop = (x) => !!(x && x.stop != null), isTarget = (x) => !!(x && x.target != null), isTime = (x) => !!(x && x.bars != null && x.ind == null && x.setup == null);

/** Every reason `spec` cannot run, in words a person can read → `{ ok, errors }`.
 *  Check a spec after withDefaults (a missing field is a default, not an error). */
export function checkStrategy(spec) {
  const e = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, errors: ['a strategy must be an object'] };
  if (spec.v !== STRATEGY_V) e.push(`version must be ${STRATEGY_V}`);
  if (typeof spec.name !== 'string' || !spec.name.trim() || spec.name.length > 80) e.push('the name must be 1 to 80 characters');
  if (!HORIZONS.includes(spec.horizon)) e.push(`horizon must be ${HORIZONS.join(', ')}`);
  if (!TIMEFRAMES.includes(spec.timeframe)) e.push(`timeframe must be ${TIMEFRAMES.join(', ')}`);
  else if (spec.horizon === 'day' && spec.timeframe === '1d') e.push('a day strategy needs intraday bars (5m, 15m or 1h)');
  else if (spec.horizon === 'invest' && spec.timeframe !== '1d') e.push('an invest strategy runs on daily bars');
  const u = spec.universe;
  if (!hasUniverse(u)) e.push('the universe needs symbols, sectors or lists');
  else {
    if (u.symbols && (!Array.isArray(u.symbols) || u.symbols.length > 300 || u.symbols.some((s) => !SYM_RE.test(String(s))))) e.push('symbols must be up to 300 tickers such as NVDA or BRK.B');
    if (u.sectors && (!Array.isArray(u.sectors) || u.sectors.some((s) => !SECTOR_FUNDS.includes(s)))) e.push(`sectors are the sector funds: ${SECTOR_FUNDS.join(', ')}`);
    if (u.lists && (!Array.isArray(u.lists) || u.lists.some((s) => !LISTS.includes(s)))) e.push(`lists are ${LISTS.join(', ')}`);
  }
  if (spec.from !== 'max' && !(typeof spec.from === 'string' && DATE_RE.test(spec.from))) e.push('from must be a date (YYYY-MM-DD) or "max"');
  if (spec.to != null && !(typeof spec.to === 'string' && DATE_RE.test(spec.to))) e.push('to must be a date (YYYY-MM-DD)');
  if (DATE_RE.test(spec.from || '') && DATE_RE.test(spec.to || '') && spec.from >= spec.to) e.push('from must be before to');
  if (spec.timeframe !== '1d' && DATE_RE.test(spec.from || '') && spec.from < INTRADAY_START) e.push(`intraday history starts ${INTRADAY_START}`);

  const tf = spec.timeframe, en = spec.entry;
  const rulesIn = (list, inner) => {
    if (!Array.isArray(list)) { e.push('entry rules must be a list'); return 0; }
    let n = 0;
    for (const r of list) {
      if (r && (Array.isArray(r.any) || Array.isArray(r.all))) {
        if (!inner) { e.push('entry groups nest one level only'); continue; }
        const sub = r.any || r.all;
        if (!sub.length) e.push('an entry group is empty');
        for (const x of sub) { if (x && (x.any || x.all)) e.push('entry groups nest one level only'); else for (const why of checkRule(x, tf)) e.push('entry: ' + why); }
        n += sub.length;
      } else { for (const why of checkRule(r, tf)) e.push('entry: ' + why); n++; }
    }
    return n;
  };
  if (!en || typeof en !== 'object') e.push('an entry rule is needed');
  else if ((en.all ? rulesIn(en.all, true) : 0) + (en.any ? rulesIn(en.any, true) : 0) === 0) e.push('an entry rule is needed');

  const ex = spec.exit && spec.exit.any;
  if (!Array.isArray(ex) || !ex.length) e.push('an exit is needed (a stop, a target, a number of bars or a rule)');
  else {
    if (ex.filter(isStop).length > 1 || ex.filter(isTarget).length > 1 || ex.filter(isTime).length > 1) e.push('at most one stop, one target and one time exit');
    for (const x of ex) {
      if (isStop(x)) {
        if (!['atr', 'percent', 'level'].includes(x.stop)) e.push('a stop is atr, percent or level');
        else if (x.stop !== 'level' && !(x.value > 0 && x.value <= (x.stop === 'atr' ? 20 : 90))) e.push(`a ${x.stop} stop needs a value above 0 and up to ${x.stop === 'atr' ? 20 : 90}`);
      } else if (isTarget(x)) {
        if (!['r', 'percent', 'level'].includes(x.target)) e.push('a target is r, percent or level');
        else if (x.target !== 'level' && !(x.value > 0 && x.value <= (x.target === 'r' ? 50 : 1000))) e.push(`a ${x.target} target needs a value above 0`);
        if (x.target === 'r' && !ex.some(isStop)) e.push('an R target needs a stop (R is the distance to the stop)');
      } else if (isTime(x)) {
        if (!(Number.isInteger(x.bars) && x.bars >= 1 && x.bars <= 5000)) e.push('a time exit is a whole number of bars from 1 to 5000');
      } else for (const why of checkRule(x, tf)) e.push('exit: ' + why);
    }
  }
  if (!SIDES.includes(spec.side)) e.push(`side must be ${SIDES.join(', ')}`);
  const s = spec.sizing;
  if (!s || !SIZINGS.includes(s.kind)) e.push(`sizing is ${SIZINGS.join(', ')}`);
  else if (s.kind === 'fixedRisk' && !(s.value > 0 && s.value <= 5)) e.push('fixed risk is a percent of the account from above 0 to 5');
  else if (s.kind === 'percent' && !(s.value > 0 && s.value <= 100)) e.push('percent sizing is from above 0 to 100% of the account');
  if (s && s.kind === 'fixedRisk' && Array.isArray(ex) && !ex.some(isStop)) e.push('fixed-risk sizing needs a stop');
  if (!(Number.isInteger(spec.maxPositions) && spec.maxPositions >= 1 && spec.maxPositions <= 100)) e.push('max positions is a whole number from 1 to 100');
  if (!REBALANCES.includes(spec.rebalance)) e.push(`rebalance is ${REBALANCES.join(', ')}`);
  const c = spec.costs;
  if (!c || !(c.slippageCents >= 0 && c.slippageCents <= 50) || !['webull', 'none'].includes(c.fees)) e.push('costs are { slippageCents: 0 to 50, fees: webull or none }');
  if (!SYM_RE.test(String(spec.benchmark || ''))) e.push('the benchmark is a ticker such as SPY');
  return { ok: !e.length, errors: [...new Set(e)] };
}

/* ── plain words ─────────────────────────────────────────────────────────── */
const fmtNum = (x) => (Number.isInteger(x) ? String(x) : String(Math.round(x * 1000) / 1000));
/** An indicator in words: "RSI (14)", "relative strength (20, vs SPY)". */
export function refText(x) {
  const spec = INDICATORS[x.ind];
  if (!spec) return String(x.ind);
  const a = argsOf(x.ind, x.args);
  return spec.text + (a.length ? ` (${a.map((v) => (typeof v === 'number' ? fmtNum(v) : 'vs ' + v)).join(', ')})` : '');
}
const valText = (ind, v) => (INDICATORS[ind] && INDICATORS[ind].kind === 'fraction' ? fmtNum(v * 100) + '%' : fmtNum(v));
/** One rule in words. */
export function ruleText(r) {
  if (r.setup != null) return `the ${r.setup} setup fires`;
  const t = r.than, op = OP_TEXT[r.op] || r.op;
  if (r.op === 'between') return `${refText(r)} ${op} ${valText(r.ind, t[0])} and ${valText(r.ind, t[1])}`;
  if (r.op === 'rising' || r.op === 'falling') return `${refText(r)} ${op}` + (t && t > 1 ? ` over ${t} bars` : '');
  if (r.op === 'is') return `${refText(r)} is ${t}`;
  return `${refText(r)} ${op} ` + (t && typeof t === 'object' ? refText(t) : valText(r.ind, t));
}
const joinWords = (list, word) => (list.length <= 1 ? list.join('') : list.slice(0, -1).join(', ') + ` ${word} ` + list[list.length - 1]);
const groupText = (list, word) => joinWords(list.map((r) => (r.any ? '(' + joinWords(r.any.map(ruleText), 'or') + ')' : r.all ? '(' + joinWords(r.all.map(ruleText), 'and') + ')' : ruleText(r))), word);
function exitText(x) {
  if (isStop(x)) return x.stop === 'atr' ? `a ${fmtNum(x.value)} ATR stop` : x.stop === 'percent' ? `a ${fmtNum(x.value)}% stop` : 'a stop under the nearest support';
  if (isTarget(x)) return x.target === 'r' ? `a ${fmtNum(x.value)} R target` : x.target === 'percent' ? `a ${fmtNum(x.value)}% target` : 'a target at the nearest resistance';
  if (isTime(x)) return `after ${x.bars} bar${x.bars === 1 ? '' : 's'}`;
  return 'when ' + ruleText(x);
}
/** The whole spec as one paragraph a person can check. */
export const describe = (spec) => describeParts(spec).join(' ');
/** The fields each sentence of describeParts() speaks for (Neo Quant marks a sentence "(default)" by them). */
export const PART_FIELDS = ['horizon side timeframe', 'exit', 'sizing maxPositions rebalance', 'universe from to', 'costs benchmark'].map((s) => s.split(' '));
/** describe()'s five sentences: what and when, exits, sizing, universe and span, costs. */
export function describeParts(spec) {
  const side = spec.side === 'long' ? 'long only' : spec.side === 'short' ? 'short only' : 'long and short';
  const hz = spec.horizon === 'day' ? 'Day trades' : spec.horizon === 'invest' ? 'Investing' : 'Swing trades';
  const en = spec.entry || {}, parts = [];
  if (en.all && en.all.length) parts.push(groupText(en.all, 'and'));
  if (en.any && en.any.length) parts.push((en.all && en.all.length ? 'and any of: ' : '') + groupText(en.any, 'or'));
  const verb = spec.side === 'short' ? 'sell short' : 'buy';
  const ex = ((spec.exit && spec.exit.any) || []).map(exitText);
  const s = spec.sizing || {};
  const size = s.kind === 'fixedRisk' ? `Risk ${fmtNum(s.value)}% of the account a trade` : s.kind === 'percent' ? `Put ${fmtNum(s.value)}% of the account in each trade` : 'Split the account equally';
  const u = spec.universe || {}, names = [...(u.lists || []).map((l) => LIST_TEXT[l]), ...(u.sectors || []).map((x) => (SECTORS.find((y) => y.sym === x) || {}).name + ' stocks'), ...(u.symbols && u.symbols.length ? [u.symbols.slice(0, 8).join(', ') + (u.symbols.length > 8 ? ` and ${u.symbols.length - 8} more` : '')] : [])];
  const span = (spec.from === 'max' ? 'from the earliest bar' : `from ${spec.from}`) + (spec.to ? ` to ${spec.to}` : ' to today');
  const c = spec.costs || {};
  return [
    `${hz}, ${side}, on ${TF_TEXT[spec.timeframe] || spec.timeframe}: ${verb} when ${parts.join(' ') || 'nothing'}` + (spec.side === 'both' ? ' (and sell short when the opposite holds)' : '') + '.',
    `Exit at ${joinWords(ex, 'or')}${ex.length > 1 ? ', whichever comes first' : ''}.`,
    `${size}, at most ${spec.maxPositions} position${spec.maxPositions === 1 ? '' : 's'} at once` + (spec.rebalance && spec.rebalance !== 'none' ? `, resized ${spec.rebalance}` : '') + '.',
    `Universe: ${joinWords(names, 'and')}, ${span}.`,
    `Costs: ${fmtNum(c.slippageCents)} cent${c.slippageCents === 1 ? '' : 's'} a share each way${c.fees === 'webull' ? ' plus Webull\'s fees' : ''}. Compared with ${spec.benchmark}.`,
  ];
}

/* ── the sensitivity strip ───────────────────────────────────────────────── */
/** Every number in the rules and exits nudged ±20% → `[{ label, path, dir, spec }]`
 *  (lengths and bar counts stay whole and ≥ 1). At most `max` numbers. */
export function nudges(spec, { pct = 0.2, max = 8 } = {}) {
  const found = [];
  const visit = (rule, where) => {
    if (!rule || rule.setup != null) return;
    if (rule.stop != null || rule.target != null) { if (rule.value > 0) found.push({ label: exitText(rule), get: (s) => s, path: [...where, 'value'], int: false }); return; }
    if (rule.bars != null && rule.ind == null) { found.push({ label: exitText(rule), path: [...where, 'bars'], int: true }); return; }
    if (!INDICATORS[rule.ind]) return;
    const a = argsOf(rule.ind, rule.args);
    INDICATORS[rule.ind].args.forEach((d, k) => { if (d.type === 'number') found.push({ label: `${refText(rule)}: ${d.name}`, path: [...where, 'args', k], int: d.name === 'length' || d.name === 'fast' || d.name === 'slow' || d.name === 'signal', fill: a }); });
    if (typeof rule.than === 'number' && rule.than !== 0) found.push({ label: ruleText(rule), path: [...where, 'than'], int: rule.op === 'rising' || rule.op === 'falling' });
  };
  const en = spec.entry || {};
  for (const key of ['all', 'any']) (en[key] || []).forEach((r, i) => {
    if (r && (r.any || r.all)) (r.any || r.all).forEach((x, j) => visit(x, ['entry', key, i, r.any ? 'any' : 'all', j]));
    else visit(r, ['entry', key, i]);
  });
  ((spec.exit && spec.exit.any) || []).forEach((r, i) => visit(r, ['exit', 'any', i]));
  const out = [];
  for (const f of found.slice(0, max)) for (const dir of [-1, 1]) {
    const s = JSON.parse(JSON.stringify(spec));
    let node = s;
    for (const k of f.path.slice(0, -1)) {
      if (node[k] == null && k === 'args') node[k] = f.fill.slice();
      node = node[k];
    }
    const last = f.path[f.path.length - 1];
    if (f.fill && node === undefined) continue;
    const v = last === 'args' ? null : node[last] != null ? node[last] : (f.fill ? f.fill[last] : null);
    if (!Number.isFinite(v)) continue;
    let nv = v * (1 + dir * pct);
    nv = f.int ? Math.max(1, Math.round(nv)) : Math.round(nv * 1e4) / 1e4;
    if (nv === v) nv = f.int ? Math.max(1, v + dir) : v;
    node[last] = nv;
    out.push({ label: f.label, path: f.path, dir, value: nv, spec: s });
  }
  return out;
}
