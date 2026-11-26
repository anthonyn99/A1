// COPY of A1-Priv TradeHub/core/warnings.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// Facts → flags (docs/TradeHub/quant/phase-07.md). Pure.
//
// warnings(dossier, bars, calendar, { now }) → [{ code, level, text }]
//   dossier   the merged dossier (data/dossier.js): `facts.name.v`
//   bars      the stock's daily bars, oldest first
//   calendar  Catalysts' events for it (`[{ ticker, t, name }]`), or null
// Each code and the line it shows:
//   rich               P/E in the top decile of its own 5-year range
//   earnings-soon      earnings within 5 sessions
//   estimates-falling  more estimates lowered than raised (four weeks), or the year's consensus down
//   insider-selling    open-market sells > 3× buys by value over 90 days
//   short-rising       short-volume ratio, 20-day average, up > 25% on the 20 days before
//   thin               average dollar volume (20 days) under $20M
//   debt               net debt over 4× EBITDA
//   dividend-uncovered dividends paid above free cash flow
//   extended           close more than 3 ATR above the 20-day average
import { sma, atr } from './indicators.js';
import { isTradingDay } from './holidays.js';
import { nyClock, nyMidnight } from './clock.js';

export const RICH_PCT = 0.9, EARNINGS_SESSIONS = 5, INSIDER_RATIO = 3, SHORT_RISE = 0.25, THIN_DOLLARS = 20e6, DEBT_MAX = 4, EXTENDED_ATR = 3;
export const WARNING_CODES = ['rich', 'earnings-soon', 'estimates-falling', 'insider-selling', 'short-rising', 'thin', 'debt', 'dividend-uncovered', 'extended'];

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const val = (d, k) => (d && d.facts && d.facts[k] ? d.facts[k].v : null);
const money = (x) => (Math.abs(x) >= 1e9 ? '$' + (x / 1e9).toFixed(1) + 'B' : Math.abs(x) >= 1e6 ? '$' + (x / 1e6).toFixed(1) + 'M' : '$' + Math.round(x).toLocaleString('en-US'));

/** Trading sessions from New York day `from` (exclusive) to `to` (inclusive), both YYYY-MM-DD. */
export function sessionsBetween(from, to) {
  if (!from || !to || to < from) return to === from ? 0 : null;
  let n = 0;
  for (let t = nyMidnight(from) + 86_400_000; ; t += 86_400_000) {
    const d = nyClock(t + 12 * 3600_000).date;
    if (d > to) break;
    if (isTradingDay(d)) n++;
    if (n > 400) break;
  }
  return n;
}

/** The flags a dossier, its bars and the calendar raise → [{ code, level, text }] (see the top of this file). */
export function warnings(dossier, bars = [], calendar = null, { now = Date.now() } = {}) {
  const out = [];
  const add = (code, level, text) => out.push({ code, level, text });
  // rich
  const pe = val(dossier, 'pe'), hist = (val(dossier, 'peHist') || []).map((x) => (x && typeof x === 'object' ? x.v : x)).filter((x) => fin(x) && x > 0);
  if (fin(pe) && pe > 0 && hist.length >= 4) {
    const p = hist.filter((x) => x < pe).length / hist.length;
    if (p >= RICH_PCT) add('rich', 'warn', `P/E ${pe.toFixed(1)} is in the top tenth of its own 5-year range`);
  }
  // earnings-soon: the dossier's date, else the calendar's
  const today = nyClock(now).date;
  let next = val(dossier, 'nextEarnings');
  if (!next && Array.isArray(calendar)) {
    const sym = dossier && dossier.symbol;
    const e = calendar.filter((x) => x && (!sym || x.ticker === sym) && /earn/i.test(x.name || x.kind || '') && x.t >= now - 86_400_000).sort((a, b) => a.t - b.t)[0];
    if (e) next = nyClock(e.t).date;
  }
  if (next && next >= today) {
    const n = sessionsBetween(today, next);
    if (n != null && n <= EARNINGS_SESSIONS) add('earnings-soon', 'warn', n === 0 ? 'Earnings today' : `Earnings in ${n} session${n === 1 ? '' : 's'} (${next})`);
  }
  // estimates-falling
  const rev = val(dossier, 'revisions');
  if (rev && ((rev.down || 0) > (rev.up || 0) || (fin(rev.change) && rev.change < -0.005)))
    add('estimates-falling', 'warn', (rev.down || 0) > (rev.up || 0) ? `Estimates falling: ${rev.down} lowered, ${rev.up || 0} raised in four weeks` : `Estimates falling: the year's consensus is ${(rev.change * 100).toFixed(1)}% lower than a month ago`);
  // insider-selling
  const ins = val(dossier, 'insiders');
  if (ins && fin(ins.sellValue) && ins.sellValue > 0 && ins.sellValue > INSIDER_RATIO * (ins.buyValue || 0))
    add('insider-selling', 'warn', `Insiders sold ${money(ins.sellValue)} and bought ${money(ins.buyValue || 0)} in 90 days`);
  // short-rising
  const sv = (val(dossier, 'shortVolume') || []).filter((x) => x && fin(x.ratio));   // newest first
  if (sv.length >= 40) {
    const a = sv.slice(0, 20).reduce((s, x) => s + x.ratio, 0) / 20, b = sv.slice(20, 40).reduce((s, x) => s + x.ratio, 0) / 20;
    if (b > 0 && a / b - 1 > SHORT_RISE) add('short-rising', 'warn', `Short volume rising: ${(a * 100).toFixed(0)}% of volume over 20 days, from ${(b * 100).toFixed(0)}%`);
  }
  // thin, extended: from the bars
  if (bars && bars.length >= 20) {
    const last = bars.slice(-20), dv = last.reduce((s, b) => s + b.c * b.v, 0) / 20;
    if (dv < THIN_DOLLARS) add('thin', 'warn', `Thinly traded: ${money(dv)} a day on average`);
    const c = bars.map((b) => b.c), m = sma(c, 20), A = atr(bars, 14), i = bars.length - 1;
    if (fin(m[i]) && fin(A[i]) && A[i] > 0 && (c[i] - m[i]) / A[i] > EXTENDED_ATR) add('extended', 'info', `Extended: ${((c[i] - m[i]) / A[i]).toFixed(1)} ATR above its 20-day average`);
  }
  // debt
  const nde = val(dossier, 'netDebtEbitda');
  if (fin(nde) && nde > DEBT_MAX) add('debt', 'bad', `Net debt ${nde.toFixed(1)}× EBITDA`);
  // dividend-uncovered
  const div = val(dossier, 'dividendsPaid'), fcf = val(dossier, 'freeCashFlow');
  if (fin(div) && div > 0 && fin(fcf) && div > fcf) add('dividend-uncovered', 'bad', `Dividends (${money(div)}) above free cash flow (${money(fcf)})`);
  return out;
}
