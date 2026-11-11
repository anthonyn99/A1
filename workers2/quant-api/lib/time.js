// New York market time for the worker. The page has the full version in
// A1-Priv TradeHub/core/clock.js (holidays, half days); the worker only needs
// to know roughly whether the market is open (for cache times) and where New
// York days and months begin (to join and cache bars).

const NY = 'America/New_York';
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY, hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

/** New York's wall clock at `ms`: { date:'YYYY-MM-DD', dow, minutes } */
export function nyClock(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}
export const nyDate = (ms) => nyClock(ms).date;

/** 00:00 in New York on `date` ('YYYY-MM-DD'), as ms. At 05:00 UTC New York
 *  reads 00:00 (standard time) or 01:00 (daylight time), including on the two
 *  days the clocks change, which both switch later than that. */
export function nyMidnight(date) {
  const [y, m, d] = date.split('-').map(Number);
  const at5 = Date.UTC(y, m - 1, d, 5);
  return at5 - (nyClock(at5).minutes >= 60 ? 3600_000 : 0);
}
/** Where the New York month holding `ms` begins. */
export const nyMonthStart = (ms) => nyMidnight(nyDate(ms).slice(0, 8) + '01');

/** True from 04:00 to 20:00 New York on weekdays (holidays are not known here). */
export function marketHours(ms) {
  const c = nyClock(ms);
  return c.dow >= 1 && c.dow <= 5 && c.minutes >= 240 && c.minutes < 1200;
}
