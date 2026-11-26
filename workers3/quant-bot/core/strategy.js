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
//
// v2 (Neo Cortex, docs/TradeHub/quant/n4-01.md) adds, all optional for v1:
//   id, version (immutable once published), thesis, invalidation, edge (words only),
//   window: { start, end } 'HH:MM' New York (when entries may open), flattenBy 'HH:MM' (only earlier than
//   the defaults), earningsBlackout (default true), sizing { kind: 'conviction', min, max } (% of the book).
// checkStrategy(spec, { bot: true }) also refuses what the bot must not or cannot run.
import { INDICATORS, OP_TEXT, checkRule, argsOf } from './strategy-rules.js';
import { SECTORS } from './universe.js';

export const STRATEGY_V = 1, STRATEGY_V2 = 2;
export const HORIZONS = ['day', 'swing', 'invest'], TIMEFRAMES = ['1d', '1h', '15m', '5m'], SIDES = ['long', 'short', 'both'];
export const SIZINGS = ['equal', 'fixedRisk', 'percent', 'conviction'], REBALANCES = ['none', 'weekly', 'monthly'], LISTS = ['watchlist', 'sp100', 'sectors', 'indexes'];
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
  if (out.v === STRATEGY_V2) {
    // v2: the earnings blackout is on unless switched off; a day strategy opens entries 09:35-15:30 unless told.
    if (out.earningsBlackout == null) { out.earningsBlackout = true; assumed.push('earningsBlackout'); }
    if (out.window == null && out.horizon === 'day' && out.timeframe !== '1d') { out.window = { ...DAY_WINDOW }; assumed.push('window'); }
  }
  return { spec: out, assumed };
}
const hasUniverse = (u) => !!(u && ((u.symbols && u.symbols.length) || (u.sectors && u.sectors.length) || (u.lists && u.lists.length)));

/** An exit of the spec's exit list: a stop, a target, a time exit (anything else is a rule). */
export const isStop = (x) => !!(x && x.stop != null), isTarget = (x) => !!(x && x.target != null), isTime = (x) => !!(x && x.bars != null && x.ind == null && x.setup == null);

/** Every reason `spec` cannot run, in words a person can read → `{ ok, errors }`.
 *  Check a spec after withDefaults (a missing field is a default, not an error). */
export function checkStrategy(spec, { bot = false } = {}) {
  const e = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, errors: ['a strategy must be an object'] };
  if (spec.v !== STRATEGY_V && spec.v !== STRATEGY_V2) e.push(`version must be ${STRATEGY_V} or ${STRATEGY_V2}`);
  if (spec.v === STRATEGY_V2) checkV2(spec, e);
  else if (spec.sizing && spec.sizing.kind === 'conviction') e.push('conviction sizing needs a v2 strategy');
  if (bot) checkBot(spec, e);
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
  else if (s.kind === 'conviction' && !(s.min > 0 && s.max <= 5 && s.min <= s.max)) e.push('conviction sizing is { min, max }: percents of the book, above 0, up to 5, min no more than max');
  if (s && (s.kind === 'fixedRisk' || s.kind === 'conviction') && Array.isArray(ex) && !ex.some(isStop)) e.push(`${s.kind === 'conviction' ? 'conviction' : 'fixed-risk'} sizing needs a stop`);
  if (!(Number.isInteger(spec.maxPositions) && spec.maxPositions >= 1 && spec.maxPositions <= 100)) e.push('max positions is a whole number from 1 to 100');
  if (!REBALANCES.includes(spec.rebalance)) e.push(`rebalance is ${REBALANCES.join(', ')}`);
  const c = spec.costs;
  if (!c || !(c.slippageCents >= 0 && c.slippageCents <= 50) || !['webull', 'none'].includes(c.fees)) e.push('costs are { slippageCents: 0 to 50, fees: webull or none }');
  if (!SYM_RE.test(String(spec.benchmark || ''))) e.push('the benchmark is a ticker such as SPY');
  return { ok: !e.length, errors: [...new Set(e)] };
}

/* ── v2 (Neo Cortex) ─────────────────────────────────────────────────────── */
export const ID_RE = /^[a-z0-9][a-z0-9-]{2,39}$/, HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Day trades flatten by these (New York); a half day closes at 13:00, so 12:55 / 12:50. */
export const FLATTEN = { long: '15:55', short: '15:50' }, FLATTEN_HALF = { long: '12:55', short: '12:50' };
export const DAY_WINDOW = { start: '09:35', end: '15:30' };
export const BOT_MAX_SYMBOLS = 40, BOT_MAX_POSITIONS = 6, BOT_RISK_BAND = { min: 0.25, max: 1.25 };
/** Indicators and setups the bot cannot compute every minute (n4-01.md). */
export const BOT_UNSUPPORTED = { 'level.nearestSupport': 'levels', 'level.nearestResistance': 'levels', daysToEarnings: 'earnings (the earnings blackout covers it)', 'breadth.above50': 'breadth',
  'regime.score': 'the regime per bar (choose strategies by the dossier's regime instead)', 'regime.label': 'the regime per bar (choose strategies by the dossier's regime instead)' };
export const BOT_UNSUPPORTED_SETUPS = ['earnings-drift'];
/** The % risked per trade for a fixed-risk or conviction sizing (the band's floor when no conviction is measured;
 *  N5 sets sizing.conviction 0..1), else the plain value. */
export function riskValueOf(sizing = {}) {
  if (sizing.kind !== 'conviction') return sizing.value;
  const c = Number.isFinite(sizing.conviction) ? Math.min(1, Math.max(0, sizing.conviction)) : 0;
  return sizing.min + (sizing.max - sizing.min) * c;
}

/** 'HH:MM' → minutes after midnight, or null when it is not HH:MM. */
export const hhmm = (s) => (HHMM_RE.test(String(s || '')) ? +s.slice(0, 2) * 60 + +s.slice(3) : null);

function checkV2(spec, e) {
  if (spec.id != null && !ID_RE.test(String(spec.id))) e.push('the id is 3 to 40 lowercase letters, digits or dashes');
  if (spec.version != null && !(Number.isInteger(spec.version) && spec.version >= 1)) e.push('the version is a whole number from 1');
  for (const [k, n] of [['thesis', 600], ['invalidation', 300], ['edge', 200]]) if (spec[k] != null && (typeof spec[k] !== 'string' || spec[k].length > n)) e.push(`${k} is text of up to ${n} characters`);
  if (spec.earningsBlackout != null && typeof spec.earningsBlackout !== 'boolean') e.push('earningsBlackout is true or false');
  const w = spec.window;
  if (w != null) {
    const a = hhmm(w.start), b = hhmm(w.end);
    if (spec.timeframe === '1d') e.push('an entry window is for intraday strategies');
    else if (a == null || b == null) e.push('the entry window is { start, end } as HH:MM New York time');
    else if (a >= b || a < 9 * 60 + 30 || b > 16 * 60) e.push('the entry window must run forwards inside 09:30-16:00');
  }
  if (spec.flattenBy != null) {
    const f = hhmm(spec.flattenBy), lim = hhmm(spec.side === 'short' ? FLATTEN.short : FLATTEN.long);
    if (f == null) e.push('flattenBy is HH:MM New York time');
    else if (f > lim) e.push(`flattenBy can only be earlier than ${spec.side === 'short' ? FLATTEN.short : FLATTEN.long}`);
    else if (spec.horizon !== 'day') e.push('flattenBy is for day trades');
  }
}

/** Every rule of the spec (entry, nested groups, exit rules), and the references inside them. */
export function rulesOf(spec) {
  const list = (x) => (Array.isArray(x) ? x : []);
  const out = [], add = (r) => { if (!r || typeof r !== 'object') return; if (r.any || r.all) list(r.any || r.all).forEach(add); else { out.push(r); if (r.than && typeof r.than === 'object' && !Array.isArray(r.than)) out.push(r.than); } };
  const en = spec.entry && typeof spec.entry === 'object' ? spec.entry : {};
  list(en.all).forEach(add); list(en.any).forEach(add);
  list(spec.exit && spec.exit.any).filter((x) => !isStop(x) && !isTarget(x) && !isTime(x)).forEach(add);
  return out;
}

function checkBot(spec, e) {
  if (spec.v !== STRATEGY_V2) e.push('the bot runs v2 strategies only');
  if (!ID_RE.test(String(spec.id || '')) || !(Number.isInteger(spec.version) && spec.version >= 1)) e.push('the bot needs an id and a version');
  if (spec.side === 'both') e.push('the bot books one side per strategy: write a long and a short strategy');
  if (spec.side === 'short' && spec.horizon !== 'day') e.push('a short is a day trade only (Tony\'s rule): set horizon day');
  const ex = spec.exit && Array.isArray(spec.exit.any) ? spec.exit.any : [];
  if (!ex.some(isStop)) e.push('every bot position needs a stop resting at the broker');
  if (spec.horizon === 'swing' && !ex.some(isTime)) e.push('a swing strategy needs a time exit (its longest hold)');
  const u = spec.universe && typeof spec.universe === 'object' ? spec.universe : {};
  if ((u.lists && u.lists.length) || (u.sectors && u.sectors.length)) e.push('the bot trades named symbols only (publishing resolves the watchlist)');
  if (!(Array.isArray(u.symbols) && u.symbols.length)) e.push('the bot needs symbols');
  else if (u.symbols.length > BOT_MAX_SYMBOLS) e.push(`the bot trades at most ${BOT_MAX_SYMBOLS} symbols per strategy`);
  if (Number.isInteger(spec.maxPositions) && spec.maxPositions > BOT_MAX_POSITIONS) e.push(`at most ${BOT_MAX_POSITIONS} positions (the risk book's cap)`);
  const s = spec.sizing || {};
  if (s.kind === 'conviction') { if (!(s.min >= BOT_RISK_BAND.min && s.max <= BOT_RISK_BAND.max)) e.push(`conviction sizing stays inside ${BOT_RISK_BAND.min}-${BOT_RISK_BAND.max}% of the book`); }
  else if (s.kind === 'fixedRisk') { if (!(s.value >= BOT_RISK_BAND.min && s.value <= BOT_RISK_BAND.max)) e.push(`fixed risk stays inside ${BOT_RISK_BAND.min}-${BOT_RISK_BAND.max}% of the book`); }
  else e.push('the bot sizes by conviction (or a fixed risk inside the band)');
  if (spec.rebalance && spec.rebalance !== 'none') e.push('the bot does not rebalance');
  for (const r of rulesOf(spec)) {
    if (r.setup != null && BOT_UNSUPPORTED_SETUPS.includes(r.setup)) e.push(`the bot cannot run the ${r.setup} setup`);
    if (r.ind && BOT_UNSUPPORTED[r.ind]) e.push(`the bot cannot compute ${BOT_UNSUPPORTED[r.ind]} every minute (${r.ind})`);
    if (r.ind === 'relStrength' && argsOf('relStrength', r.args)[1] === 'sector') e.push('the bot compares relative strength with SPY only');
  }
}

/** A stable hash of the fields that change what a strategy trades (not its words): two versions with one id must
 *  differ here, or the "edit" changed nothing. FNV-1a over canonical JSON, hex. */
export function specHash(spec) {
  const skip = new Set('name thesis invalidation edge version from to'.split(' '));   // words, and the backtest span
  const canon = (x) => (Array.isArray(x) ? '[' + x.map(canon).join(',') + ']' : x && typeof x === 'object'
    ? '{' + Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}' : JSON.stringify(x));
  const s = canon(Object.fromEntries(Object.entries(spec || {}).filter(([k]) => !skip.has(k))));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
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
  const size = s.kind === 'conviction' ? `Risk ${fmtNum(s.min)}% to ${fmtNum(s.max)}% of the book a trade, more as measured conviction rises`
    : s.kind === 'fixedRisk' ? `Risk ${fmtNum(s.value)}% of the account a trade` : s.kind === 'percent' ? `Put ${fmtNum(s.value)}% of the account in each trade` : 'Split the account equally';
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
