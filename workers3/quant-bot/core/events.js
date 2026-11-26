// COPY of A1-Priv TradeHub/core/events.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// Macro and earnings events (docs/TradeHub/quant/phase-13.md): event studies,
// the event-risk window on signals, the 30-minute rule for day signals, catalyst
// impact per ticker, and how news is weighed. Pure.
//
// The schedule is the one TradeHub already builds (Catalysts,
// dashboards/market_calendar); this file only reads what it is handed.
import { nyClock, nyMidnight } from './clock.js';
import { sessionsBetween } from './warnings.js';

export const FEW = 8;                     // under 8 events a study says "too few to trust"
export const DAY_GUARD_MS = 30 * 60_000;  // day signals inside 30 minutes before a release: WATCH at best
export const PROX_SESSIONS = 5;           // proximity decays to nothing over 5 sessions
export const SENS_FULL = 3;               // an event day moving 3× a normal day = full sensitivity
const HOUR = 3_600_000;
const fin = Number.isFinite;

// The high-impact releases, each with its tier (magnitude: 1 the biggest).
export const KINDS = [
  ['fomc', /\bfomc\b|fed(eral)? (funds|rate|reserve).*(decision|meeting|announcement)|interest rate decision|powell.*press/i, 1],
  ['cpi', /\bcpi\b|consumer price/i, 1],
  ['jobs', /non-?farm|payrolls|employment situation|\bjobs report\b|unemployment rate/i, 1],
  ['pce', /\bpce\b|personal (income|consumption)/i, 0.66],
  ['ppi', /\bppi\b|producer price/i, 0.66],
  ['gdp', /\bgdp\b|gross domestic/i, 0.66],
  ['retail', /retail sales/i, 0.66],
  ['ism', /\bism\b|purchasing managers/i, 0.33],
];
export const KIND_NAMES = { fomc: 'FOMC', cpi: 'CPI', jobs: 'Jobs report', pce: 'PCE', ppi: 'PPI', gdp: 'GDP', retail: 'Retail sales', ism: 'ISM', earnings: 'Earnings' };

/** A release's kind from its name ('cpi', 'fomc'…), or null when it is not one of the eight. */
export function kindOf(name) {
  const s = String(name || '');
  if (/\bADP\b/i.test(s)) return null;   // ADP's private payrolls are not the jobs report
  for (const [k, re] of KINDS) if (re.test(s)) return k;
  return null;
}
/** The tier (magnitude, 0 to 1) of a kind; earnings of the ticker itself = 1. */
export function tierOf(kind) {
  if (kind === 'earnings') return 1;
  const k = KINDS.find((x) => x[0] === kind);
  return k ? k[2] : 0.33;
}

/** The index of the bar of New York day `day` in daily bars (oldest first), or -1. */
function barOfDay(bars, day) {
  for (let i = bars.length - 1; i >= 0; i--) { const d = nyClock(bars[i].t + 12 * HOUR).date; if (d === day) return i; if (d < day) return -1; }
  return -1;
}
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/**
 * An event study of one release kind on one symbol (or sector fund):
 * `dates` = [{ day: 'YYYY-MM-DD', outcome?: 'hot' | 'inline' | 'cool' }], `bars`
 * daily oldest first → `{ kind, n, avgAbsMove, normalAbsMove, upShare,
 * avgMoveByOutcome: { hot, inline, cool }, driftNext5, few, note }`.
 * The move of a day = close / previous close − 1; `normalAbsMove` = the average
 * absolute move of every other day in the same span; driftNext5 = the close 5
 * bars later / that day's close − 1.
 */
export function study(kind, bars, dates) {
  const b = bars || [], moves = [], next5 = [], by = { hot: [], inline: [], cool: [] }, used = new Set();
  for (const d of dates || []) {
    const i = barOfDay(b, d && d.day);
    if (i < 1 || used.has(i)) continue;
    used.add(i);
    const m = b[i].c / b[i - 1].c - 1;
    moves.push(m);
    if (d.outcome && by[d.outcome]) by[d.outcome].push(m);
    if (i + 5 < b.length) next5.push(b[i + 5].c / b[i].c - 1);
  }
  const first = used.size ? Math.min(...used) : 1, normal = [];
  for (let i = Math.max(1, first - 250); i < b.length; i++) if (!used.has(i)) normal.push(Math.abs(b[i].c / b[i - 1].c - 1));
  const n = moves.length, few = n < FEW;
  return {
    kind, n,
    avgAbsMove: avg(moves.map(Math.abs)), normalAbsMove: avg(normal),
    upShare: n ? moves.filter((m) => m > 0).length / n : null,
    avgMoveByOutcome: { hot: avg(by.hot), inline: avg(by.inline), cool: avg(by.cool) },
    driftNext5: avg(next5), few,
    note: few ? `too few to trust (${n} event${n === 1 ? '' : 's'}, needs ${FEW})` : null,
  };
}

/**
 * The symbol's own past earnings: `reports` = [{ day, time: 'bmo' | 'amc' | … }]
 * → `{ n, avgGap, avgAbsGap, gapUpShare, drift1, drift5, drift20, few, note }`.
 * The reaction day is the report day before the open, the next session after
 * the close (unknown time = after). gap = its open / the close before − 1;
 * driftN = the close N bars after the reaction day's close / that close − 1.
 */
export function earningsStudy(bars, reports) {
  const b = bars || [], gaps = [], d1 = [], d5 = [], d20 = [], used = new Set();
  for (const r of reports || []) {
    let i = barOfDay(b, r && r.day);
    if (i < 0) continue;
    if (r.time !== 'bmo') i += 1;
    if (i < 1 || i >= b.length || used.has(i)) continue;
    used.add(i);
    gaps.push(b[i].o / b[i - 1].c - 1);
    if (i + 1 < b.length) d1.push(b[i + 1].c / b[i].c - 1);
    if (i + 5 < b.length) d5.push(b[i + 5].c / b[i].c - 1);
    if (i + 20 < b.length) d20.push(b[i + 20].c / b[i].c - 1);
  }
  const n = gaps.length, few = n < FEW;
  return {
    kind: 'earnings', n, avgGap: avg(gaps), avgAbsGap: avg(gaps.map(Math.abs)),
    gapUpShare: n ? gaps.filter((g) => g > 0).length / n : null,
    drift1: avg(d1), drift5: avg(d5), drift20: avg(d20), few,
    note: few ? `too few to trust (${n} report${n === 1 ? '' : 's'}, needs ${FEW})` : null,
  };
}

/**
 * The event risk of a signal: the first high-impact event (macro, or the
 * ticker's own earnings) after the signal's bar CLOSES and before it expires
 * (the window score.js's event factor reads) → `{ name, kind, at, hoursAway }`
 * or null. `events` = scanContext's list `[{ t, ticker, high, name }]`; `now` =
 * when it is asked (hoursAway from then); `barMs` = a day bar's length.
 */
export function eventRiskOf(sig, events, now = sig && sig.at, barMs = 5 * 60_000) {
  if (!sig || !Array.isArray(events)) return null;
  const from = sig.at + (sig.horizon === 'day' ? barMs : 86_400_000), to = sig.expires;
  let hit = null;
  for (const e of events) {
    if (!e || !e.high || !fin(e.t)) continue;
    if (e.ticker && e.ticker !== sig.symbol) continue;
    if (e.t < from || (fin(to) && e.t > to)) continue;
    if (!hit || e.t < hit.t) hit = e;
  }
  if (!hit) return null;
  return { name: hit.name || 'a high-impact release', kind: hit.ticker ? 'earnings' : kindOf(hit.name), at: hit.t, hoursAway: Math.round((hit.t - now) / HOUR * 10) / 10 };
}

/** The 30-minute rule: a day signal whose bar closes inside 30 minutes before a
 *  high-impact macro release → that release (the verdict is WATCH at best), else null. */
export function releaseGuard(sig, events, barMs = 5 * 60_000) {
  if (!sig || sig.horizon !== 'day' || !Array.isArray(events)) return null;
  const at = sig.at + barMs;
  for (const e of events) {
    if (!e || !e.high || e.ticker || !fin(e.t)) continue;
    if (e.t >= at && e.t - at <= DAY_GUARD_MS) return e;
  }
  return null;
}

/** Apply eventRisk and the 30-minute rule to a signal (in place) → it. */
export function withEventRisk(sig, events, barMs) {
  if (!sig) return sig;
  const risk = eventRiskOf(sig, events, sig.created != null ? sig.created : sig.at, barMs);
  if (risk) sig.eventRisk = risk;
  const g = releaseGuard(sig, events, barMs);
  if (g && sig.verdict === 'GO') {
    sig.verdict = 'WATCH';
    sig.notes = (sig.notes || []).concat(`WATCH at best: ${g.name || 'a high-impact release'} in under 30 minutes`);
  }
  return sig;
}

/**
 * A catalyst's impact on one ticker, 0 to 100:
 *   40 · sensitivity + 30 · proximity + 30 · magnitude
 * sensitivity = clamp((avgAbsMove on that kind of day / normal day − 1) / (3 − 1))
 * (the symbol's own study, else its sector's), proximity = 1 − sessions away / 5
 * (0 from 5 sessions on), magnitude = the kind's tier.
 * → `{ score, sensitivity, proximity, magnitude, ratio }`.
 */
export function impact(event, { studyOf = null, today, kind = null } = {}) {
  const k = kind || (event && event.kind) || kindOf(event && event.name);
  const s = studyOf || null;
  const ratio = s && fin(s.avgAbsMove) && fin(s.normalAbsMove) && s.normalAbsMove > 0 && !s.few ? s.avgAbsMove / s.normalAbsMove : null;
  const sensitivity = ratio == null ? 0.5 : Math.max(0, Math.min(1, (ratio - 1) / (SENS_FULL - 1)));
  // Trading sessions away (holidays count as none: warnings.js); a date that is not a day → far away.
  const away = /^\d{4}-\d{2}-\d{2}$/.test((event && event.date) || '') ? (sessionsBetween(today, event.date) ?? PROX_SESSIONS) : PROX_SESSIONS;
  const proximity = Math.max(0, 1 - away / PROX_SESSIONS);
  const magnitude = tierOf(k);
  return { score: Math.round(40 * sensitivity + 30 * proximity + 30 * magnitude), sensitivity, proximity, magnitude, ratio, kind: k };
}

// newshub keeps a confirmed / speculation distinction: a rumour is shown as
// "Unconfirmed" and never moves a verdict.
const RUMOUR = /\b(rumou?r|unconfirmed|speculat|report(?:edly|s say)|sources say|people familiar|could|may be considering|in talks)\b/i;
/** Is a news item unconfirmed? (newshub's own flag first, else its words.) */
export function unconfirmed(item) {
  if (!item) return false;
  if (item.confirmed === true || item.status === 'confirmed') return false;
  if (item.confirmed === false || item.speculation === true || item.status === 'speculation' || item.status === 'unconfirmed' || item.rumor === true) return true;
  return RUMOUR.test(String(item.title || item.headline || ''));
}
/** How a news item is shown and weighed → `{ label, movesVerdict }`. */
export function newsWeight(item) {
  return unconfirmed(item) ? { label: 'Unconfirmed', movesVerdict: false } : { label: 'Confirmed', movesVerdict: true };
}

/** The release's New York time on its day (ms), 08:30 when no time is given. */
export function releaseAt(e) {
  if (!e || e.dateOnly || !/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(e.time || ''), min = m ? Number(m[1]) * 60 + Number(m[2]) : 8.5 * 60;
  return nyMidnight(e.date) + min * 60_000;
}

/** The next high-impact releases from the Catalysts calendar after `now` →
 *  `[{ name, kind, date, time, at }]`, soonest first, at most `max`. */
export function nextReleases(calendar, now, max = 6) {
  const out = [];
  for (const e of calendar || []) {
    if (!e || e.ticker || e.kind === 'earnings' || e.kind === 'holiday') continue;
    const kind = kindOf(e.name);
    if (!kind && e.importance !== 'high') continue;
    const at = e.dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? nyMidnight(e.date) : releaseAt(e);
    if (at == null || (e.dateOnly ? e.date < nyClock(now).date : at < now)) continue;
    out.push({ name: e.name, kind, date: e.date, time: e.time || null, dateOnly: !!e.dateOnly, at, actual: e.actual ?? null, forecast: e.forecast ?? null, prior: e.prior ?? null });
  }
  return out.sort((a, b) => a.at - b.at).slice(0, max);
}
