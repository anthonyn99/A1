// Rates, credit, the dollar and oil (A1-Priv docs/TradeHub/quant/phase-13.md,
// "Rates and credit"), from FRED's public CSV (fredgraph.csv: no key; the
// Treasury's own yields are FRED's DGS series), and Nasdaq's free earnings
// calendar by date (no key) for the earnings history.
import { call, noteBad, UA_BROWSER } from '../lib/net.js';

// The series of the `macro` pack. Missing days in FRED's CSV are '.'.
export const SERIES = {
  DGS3MO: '3-month Treasury', DGS2: '2-year Treasury', DGS10: '10-year Treasury',
  DFII10: '10-year real yield', BAMLH0A0HYM2: 'High-yield spread', DTWEXBGS: 'Dollar (broad)', DCOILWTICO: 'Oil (WTI)',
};
export const KEEP_DAYS = 400;
const DAY = 86_400_000;

/** FRED's CSV → [[day, value]…] oldest first, missing days left out. */
export function parseFredCsv(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/).slice(1)) {
    const [d, v] = line.split(',');
    const x = parseFloat(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d || '') && Number.isFinite(x)) out.push([d, x]);
  }
  return out;
}

/** One series, the last KEEP_DAYS days (one FRED call). */
export async function fredSeries(L, id, now = Date.now()) {
  const from = new Date(now - KEEP_DAYS * DAY).toISOString().slice(0, 10);
  const text = await call(L, 'fred', `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${from}`, { text: true, timeout: 10000 });
  const rows = parseFredCsv(text);
  if (!rows.length) throw noteBad(L, 'fred', 'no values for ' + id);
  return rows;
}

/** "$1.23" → 1.23, "($0.45)" → −0.45, "" / "N/A" → null. */
export function money(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t || /n\/a/i.test(t)) return null;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t);
  const x = parseFloat(t.replace(/[^0-9.]/g, ''));
  return Number.isFinite(x) ? (neg ? -x : x) : null;
}
/** "$259,072,131,000" → 259072131000. */
export const capOf = (s) => { const x = parseFloat(String(s || '').replace(/[^0-9.]/g, '')); return Number.isFinite(x) ? x : null; };
export const MIN_CAP = 5e9;   // only companies worth $5B or more are kept (D1's daily write allowance)

/** Nasdaq's earnings calendar for one day → [{ symbol, day, time, eps, est }] of
 *  companies worth MIN_CAP or more (one Nasdaq call). */
export async function earningsOn(L, day) {
  const j = await call(L, 'nasdaq', `https://api.nasdaq.com/api/calendar/earnings?date=${day}`, { timeout: 10000, headers: { 'user-agent': UA_BROWSER, accept: 'application/json' } });
  const rows = (j && j.data && j.data.rows) || [];
  if (!Array.isArray(rows)) throw noteBad(L, 'nasdaq', 'no rows in the earnings calendar');
  return parseEarnings(rows, day);
}
export function parseEarnings(rows, day) {
  const out = [];
  for (const r of rows || []) {
    const symbol = String((r && r.symbol) || '').toUpperCase();
    if (!/^[A-Z][A-Z.]{0,5}$/.test(symbol)) continue;
    const cap = capOf(r.marketCap);
    if (cap != null && cap < MIN_CAP) continue;
    if (cap == null) continue;
    const time = /pre-market/i.test(r.time || '') ? 'bmo' : /after-hours/i.test(r.time || '') ? 'amc' : null;
    out.push({ symbol, day, time, eps: money(r.eps), est: money(r.epsForecast) });
  }
  return out;
}
