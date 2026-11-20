// How far a bar's volume can be trusted (Refinements Batch 2, BV; A1-Priv docs/TradeHub/quant/r2-0v.md).
// Tony, 2026-11-20: "ensure no false data is given, ANY chart, ticker, anything". A bar may carry
//   vx: 'iex'   its volume is one exchange's (Alpaca's free edge, the newest 16 minutes): a few percent
//               of the market's; the page re-reads it once the whole market's (SIP) is out
//   vx: 'none'  its volume is not known: drawn as no bar, never as a number
//   vx: 'part'  a bar built from several (4 hours) where some parts' volume is not known: drawn faint
// and no `vx` when the volume is the whole market's.
//
// Yahoo, checked 2026-11-20 on MU's 5-minute bars: every pre- and after-hours bar reports 0 (it has
// no extended-hours volume), and one mid-day bar carried 25,118,076 shares, about 40 times its
// neighbours (a lump, not trades: its price range was 5.76 against ~4.7 around it; a real surge
// widens the range). markYahooVolume flags both; nothing is replaced by a guess.
import { nyClock } from './time.js';

export const OPEN = 570, CLOSE = 960;   // New York minutes, 09:30 and 16:00
export const SPIKE_X = 12, SPIKE_N = 12, SPIKE_RANGE_X = 2;
const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Yahoo's intraday bars with unknown volume flagged `vx: 'none'` (in place; returns them):
 *  a zero (Yahoo reports none in extended hours, and a zero in session is not a real 0), and a
 *  mid-session bar over SPIKE_X times the median volume of its SPIKE_N regular neighbours each side
 *  whose price range is under SPIKE_RANGE_X times theirs (a real surge, an FOMC minute or a halt
 *  ending, moves the price too). The open's first 15 minutes and the close's last 10 are real crowds. */
export function markYahooVolume(bars) {
  const reg = bars.map((b) => { const m = nyClock(b.t).minutes; return m >= OPEN && m < CLOSE; });
  const live = bars.map((b, i) => reg[i] && b.v > 0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!(b.v > 0)) { b.vx = 'none'; continue; }
    if (!reg[i]) continue;
    const m = nyClock(b.t).minutes;
    if (m < OPEN + 15 || m >= CLOSE - 10) continue;
    const near = [];
    for (let j = i - 1; j >= 0 && near.length < SPIKE_N; j--) if (live[j] && !bars[j].vx) near.push(bars[j]);
    for (let j = i + 1, k = 0; j < bars.length && k < SPIKE_N; j++) if (live[j]) { near.push(bars[j]); k++; }
    const med = median(near.map((x) => x.v)), rng = median(near.map((x) => x.h - x.l));
    if (near.length >= 6 && med > 0 && b.v > SPIKE_X * med && (b.h - b.l) < SPIKE_RANGE_X * rng) b.vx = 'none';
  }
  return bars;
}

/** The mark a bar built from `parts` keeps (aggregate): a lump (unknown, with volume) makes it unknown;
 *  else one exchange's makes it IEX; parts with no volume known beside known ones make it partial; all
 *  unknown, unknown; all whole, none. */
export function vxOf(parts) {
  let lump = false, iex = false, zero = 0, part = false;
  for (const p of parts) {
    if (p.vx === 'none') { if (p.v > 0) lump = true; else zero++; }
    else if (p.vx === 'iex') iex = true;
    else if (p.vx === 'part') part = true;
  }
  if (lump) return 'none';
  if (iex) return 'iex';
  if (zero === parts.length) return 'none';
  return zero || part ? 'part' : undefined;
}
