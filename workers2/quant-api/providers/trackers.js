// Free feeds for the non-equity instruments in Webull's Trackers list.
import { call, BARS_TIMEOUT } from '../lib/net.js';
import { nyDate, nyMidnight } from '../lib/time.js';

export const YAHOO_TRACKERS = Object.freeze({
  VIX: '^VIX', DXY: 'DX-Y.NYB', CLMAIN: 'CL=F', BZMAIN: 'BZ=F', NQMAIN: 'NQ=F', HGMAIN: 'HG=F',
});
const DELAY_MINUTES = { VIX: 15, DXY: 30, CLMAIN: 30, BZMAIN: 30, NQMAIN: 10, HGMAIN: 30 };
const SERIES = { US2Y: 'DGS2', US10Y: 'DGS10' };
export const yahooDelay = (s) => (DELAY_MINUTES[s] || 0) * 60_000;
export const isYield = (s) => Object.hasOwn(SERIES, s);
export const isTracker = (s) => isYield(s) || Object.hasOwn(YAHOO_TRACKERS, s);

export function readYieldCsv(csv, symbol) {
  const [head, ...rows] = csv.trim().split(/\r?\n/);
  const col = head.split(',').indexOf(SERIES[symbol]);
  if (col < 1) return [];
  return rows.flatMap((row) => {
    const fields = row.split(','), date = fields[0], c = Number(fields[col]);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(c) && c > 0
      ? [{ t: nyMidnight(date), o: c, h: c, l: c, c, v: 0, vx: 'none' }] : [];
  });
}

async function rates(L, syms, from, to) {
  const p = new URLSearchParams({ id: syms.map((s) => SERIES[s]).join(','), cosd: nyDate(from), coed: nyDate(to) });
  return call(L, 'fred', 'https://fred.stlouisfed.org/graph/fredgraph.csv?' + p, { text: true, timeout: BARS_TIMEOUT });
}

export async function yieldQuotes(L, syms, now) {
  const csv = await rates(L, syms, now - 12 * 86_400_000, now);
  const quotes = {};
  for (const symbol of syms) {
    const bars = readYieldCsv(csv, symbol), last = bars.at(-1);
    if (last) quotes[symbol] = { symbol, price: last.c, prevClose: bars.at(-2)?.c ?? null,
      t: last.t, heard: now, provider: 'fred', realtime: false, delayMs: 0, daily: true };
  }
  return quotes;
}

export async function yieldBars(L, env, sym, tf, from, to) {
  if (tf !== '1d') return null;
  return readYieldCsv(await rates(L, [sym], from, to), sym);
}
