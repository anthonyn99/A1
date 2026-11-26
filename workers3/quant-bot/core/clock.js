// COPY of A1-Priv TradeHub/core/clock.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// Market time. The exchange keeps New York time whatever zone the screen
// shows, so sessions are worked out there and only display converts.
// Pure: every function takes the moment as an argument.
import { nyseHolidays, nyseHalfDays } from './holidays.js';

const NY = 'America/New_York';
const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY, hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

// New York's offset from UTC is always a whole number of hours, so the date,
// weekday and hour are the same for a whole UTC hour: worked out once per hour
// (the formatter is slow, and backtests ask for millions of bars).
const HOUR = 3_600_000, byHour = new Map();
/** New York's wall clock at `ms`: { date:'YYYY-MM-DD', dow:0-6 (Sun=0), minutes } */
export function nyClock(ms) {
  const hr = Math.floor(ms / HOUR);
  let c = byHour.get(hr);
  if (!c) {
    const p = Object.fromEntries(partsFmt.formatToParts(new Date(hr * HOUR)).map((x) => [x.type, x.value]));
    c = { date: `${p.year}-${p.month}-${p.day}`, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), minutes: Number(p.hour) * 60 + Number(p.minute) };
    if (byHour.size > 400_000) byHour.clear();
    byHour.set(hr, c);
  }
  return { date: c.date, dow: c.dow, minutes: c.minutes + Math.floor((ms - hr * HOUR) / 60_000) };
}

export const PRE_OPEN = 4 * 60, OPEN = 9 * 60 + 30, CLOSE = 16 * 60, POST_CLOSE = 20 * 60;
export const HALF_CLOSE = 13 * 60, HALF_POST_CLOSE = 17 * 60;

/** 'pre' | 'regular' | 'post' | 'closed' for US stocks at `ms`.
 *  `holidays`: a Set of 'YYYY-MM-DD' full closures; `halfDays`: a Set of dates
 *  that close at 13:00, with after hours ending at 17:00 (both come from the
 *  Catalysts calendar). */
export function session(ms, { holidays, halfDays } = {}) {
  const c = nyClock(ms);
  if (c.dow === 0 || c.dow === 6) return 'closed';
  if (holidays && holidays.has(c.date)) return 'closed';
  const half = !!(halfDays && halfDays.has(c.date)), close = half ? HALF_CLOSE : CLOSE;
  if (c.minutes < PRE_OPEN || c.minutes >= (half ? HALF_POST_CLOSE : POST_CLOSE)) return 'closed';
  if (c.minutes < OPEN) return 'pre';
  if (c.minutes < close) return 'regular';
  return 'post';
}

/** 00:00 in New York on `date` ('YYYY-MM-DD'), as ms. At 05:00 UTC New York
 *  reads 00:00 (standard time) or 01:00 (daylight time), including on the two
 *  days the clocks change, which both switch later than that. */
export function nyMidnight(date) {
  const [y, m, d] = date.split('-').map(Number);
  const at5 = Date.UTC(y, m - 1, d, 5);
  return at5 - (nyClock(at5).minutes >= 60 ? 3_600_000 : 0);
}
/** New York days for a run of bar times (oldest first): `day[i]` numbers the
 *  date bar `i` falls on (0, 1, 2, ... into `dates`), `minute[i]` is its
 *  minute of that day. One calendar lookup per day, not per bar. */
export function nyDays(times) {
  const day = new Int32Array(times.length), minute = new Int16Array(times.length), dates = [];
  let start = -Infinity, cur = '', shift = 0;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    // A New York day is at least 23 hours long, so inside that the date cannot have changed.
    if (!(t >= start && t < start + 23 * 3_600_000)) {
      const c = nyClock(t);
      if (c.date !== cur) {
        cur = c.date; dates.push(cur); start = nyMidnight(cur);
        // The two days the clocks change: after 02:00 the wall clock is an hour off the hours gone by.
        shift = nyClock(start + 12 * 3_600_000).minutes - 720;
      }
    }
    day[i] = dates.length - 1;
    const gone = Math.round((t - start) / 60_000);
    minute[i] = shift && gone >= (shift > 0 ? 120 : 180) ? gone + shift : gone;
  }
  return { day, minute, dates };
}
/** The New York month holding `ms`: 'YYYY-MM'. */
export const nyMonth = (ms) => nyClock(ms).date.slice(0, 7);
/** Where New York month 'YYYY-MM' begins and the next one begins: [start, end). */
export function nyMonthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [nyMidnight(month + '-01'), nyMidnight(next + '-01')];
}

/** A price poll's pace outside the session (2026-11-19: polling every 5 s all
 *  night from a TradeHub left on screen used up account 2's 100,000 free
 *  Worker requests a day, and every worker there, the Daily Reminder's too,
 *  answered 1027 until midnight UTC). */
export const QUIET_POLL_MS = 300_000;
/** How long a price poll waits at `ms`: `active` while US stocks trade
 *  (04:00 to 20:00 New York on a trading day, 17:00 on a half day), else `quiet`. */
export function pollMs(ms, active, quiet = QUIET_POLL_MS) {
  const y = Number(nyClock(ms).date.slice(0, 4));
  return session(ms, { holidays: nyseHolidays(y), halfDays: nyseHalfDays(y) }) === 'closed' ? quiet : active;
}
