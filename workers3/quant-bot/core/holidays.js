// COPY of A1-Priv TradeHub/core/holidays.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// The New York Stock Exchange's calendar, worked out from its rules, so the
// scheduled runner (which cannot read the Catalysts calendar) knows a closed
// day. Pure date arithmetic on 'YYYY-MM-DD' strings; no clock.

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();   // 0 = Sunday
/** The `n`th `weekday` (0 = Sunday) of a month; n = -1 is the last one. */
function nth(y, m, weekday, n) {
  if (n > 0) return 1 + ((7 + weekday - dow(y, m, 1)) % 7) + 7 * (n - 1);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return last - ((7 + dow(y, m, last) - weekday) % 7);
}
/** Easter Sunday → [month, day] (the anonymous Gregorian computus). */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}
/** A fixed-date holiday as the exchange keeps it: on a Sunday it moves to
 *  Monday, on a Saturday to the Friday before; null when that Friday is in
 *  the year before (New Year's Day on a Saturday is not made up). */
function observed(y, m, d) {
  const w = dow(y, m, d);
  if (w === 0) return iso(y, m, d + 1);
  if (w !== 6) return iso(y, m, d);
  return m === 1 && d === 1 ? null : iso(y, m, d - 1);
}

/** The days the NYSE is closed all day in `year` → a Set of 'YYYY-MM-DD':
 *  New Year's Day, Martin Luther King Jr. Day (3rd Monday of January),
 *  Washington's Birthday (3rd Monday of February), Good Friday, Memorial Day
 *  (last Monday of May), Juneteenth (from 2022), Independence Day, Labor Day
 *  (1st Monday of September), Thanksgiving (4th Thursday of November),
 *  Christmas; fixed dates as `observed`. */
export function nyseHolidays(year) {
  const [em, ed] = easter(year), gf = new Date(Date.UTC(year, em - 1, ed - 2));
  const days = [
    observed(year, 1, 1),
    iso(year, 1, nth(year, 1, 1, 3)),
    iso(year, 2, nth(year, 2, 1, 3)),
    iso(gf.getUTCFullYear(), gf.getUTCMonth() + 1, gf.getUTCDate()),
    iso(year, 5, nth(year, 5, 1, -1)),
    year >= 2022 ? observed(year, 6, 19) : null,
    observed(year, 7, 4),
    iso(year, 9, nth(year, 9, 1, 1)),
    iso(year, 11, nth(year, 11, 4, 4)),
    observed(year, 12, 25),
  ];
  return new Set(days.filter(Boolean));
}

/** The days the NYSE closes at 13:00 in `year` → a Set: the day after
 *  Thanksgiving, Christmas Eve and 3 July, each when it is a weekday that is
 *  not itself a holiday. */
export function nyseHalfDays(year) {
  const closed = nyseHolidays(year), out = new Set();
  for (const d of [iso(year, 11, nth(year, 11, 4, 4) + 1), iso(year, 12, 24), iso(year, 7, 3)]) {
    const [y, m, day] = d.split('-').map(Number), w = dow(y, m, day);
    if (w !== 0 && w !== 6 && !closed.has(d)) out.add(d);
  }
  return out;
}

/** True when US stocks trade on `date` ('YYYY-MM-DD'): a weekday that is not
 *  an NYSE holiday. */
export function isTradingDay(date) {
  const [y, m, d] = date.split('-').map(Number), w = dow(y, m, d);
  return w !== 0 && w !== 6 && !nyseHolidays(y).has(date);
}

/** The date `n` days after `date` (n may be negative), as 'YYYY-MM-DD'. */
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number), x = new Date(Date.UTC(y, m - 1, d + n));
  return iso(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
}
