import { nyClock, nyMidnight } from '../core/clock.js';
import { isTradingDay, nyseHalfDays } from '../core/holidays.js';

const MIN = 60000, DAY = 1440 * MIN;
export const KEEP = { '5m': 120, '15m': 120, '1h': 120, '1d': 300 };
export const BAR_MINUTES = { '5m': 5, '15m': 15, '1h': 60 };
const START = 9 * 60 + 30;
const CLOSE = 16 * 60, HALF = 13 * 60;
const halfByYear = new Map();

function closeOn(date) {
  const year = Number(date.slice(0, 4));
  if (!halfByYear.has(year)) halfByYear.set(year, nyseHalfDays(year));
  return halfByYear.get(year).has(date) ? HALF : CLOSE;
}

function cacheKey(path) {
  return new Request('https://quant-bot.anthony-account-3.workers.dev/.bot-cache/v1/' + path);
}

async function read(cache, key) {
  if (!cache) return null;
  try { return await (await cache.match(key))?.json() ?? null; } catch { return null; }
}

async function put(cache, key, value, seconds) {
  if (!cache) return;
  await cache.put(key, new Response(JSON.stringify(value), { headers: { 'Cache-Control': 'public, max-age=' + seconds } })).catch(() => {});
}

const mins = (time) => {
  const [hours, minutes] = String(time || '').split(':').map(Number);
  return hours * 60 + minutes;
};

export async function marketClock(broker, now, cache) {
  const date = nyClock(now).date;
  if (!isTradingDay(date)) return { date, open: false, closedForDay: true };
  const key = cacheKey('calendar/' + date);
  const [clock, saved] = await Promise.all([broker.clock(), read(cache, key)]);
  const session = saved || (await broker.calendar(date)).find((row) => row.date === date);
  if (!session) return { date, open: false, closedForDay: true };
  if (!saved) await put(cache, key, session, 24 * 3600);
  const openMin = mins(session.open), closeMin = mins(session.close);
  const check = Date.parse(clock.timestamp);
  if (!(closeMin > openMin) || !Number.isFinite(check) || Math.abs(check - now) > 2 * MIN) throw new Error('Broker clock or calendar is stale');
  const minutes = nyClock(check).minutes;
  return { date, minutes, open: clock.is_open === true && minutes >= openMin && minutes < closeMin,
    closedForDay: minutes >= closeMin, openMin, closeMin, half: closeMin < CLOSE };
}

function validBar(t, tf, now, session) {
  const c = nyClock(t);
  if (tf === '1d') return c.date < session.date && isTradingDay(c.date);
  const close = c.date === session.date ? session.closeMin : closeOn(c.date);
  const duration = Math.min(BAR_MINUTES[tf], close - c.minutes);
  return isTradingDay(c.date) && c.minutes >= START && duration > 0 && t + duration * MIN <= now - 10_000;
}

const firstAt = {
  '5m': 8 * DAY, '15m': 12 * DAY, '1h': 40 * DAY, '1d': 600 * DAY,
};

/** A cache entry is a compact range for one fixed symbol group and timeframe. */
export async function loadBars(broker, symbols, tf, now, session, cache) {
  const group = [...new Set(symbols)].sort();
  if (!group.length) return {};
  const key = cacheKey('bars/' + tf + '/' + encodeURIComponent(group.join(',')));
  const cached = await read(cache, key);
  // Read the newest completed bar once. The overlap includes an IEX bar that arrived late.
  const interval = (BAR_MINUTES[tf] || 1440) * MIN;
  const end = Math.floor((now - 10000) / interval) * interval;
  if (cached?.end === end) return cached.bars;
  const start = cached ? cached.end - interval : now - firstAt[tf];
  const fresh = await broker.bars(group, tf, start, Math.max(start + 1, now));
  const result = {};
  for (const symbol of group) {
    const byTime = new Map((cached?.bars?.[symbol] || []).map((b) => [b[0], b]));
    for (const bar of fresh[symbol]) if (validBar(bar[0], tf, now, session)) byTime.set(bar[0], bar);
    result[symbol] = [...byTime.values()].sort((a, b) => a[0] - b[0]).slice(-KEEP[tf]);
  }
  await put(cache, key, { end, bars: result }, 3 * 24 * 3600);
  return result;
}

export const objects = (bars) => (bars || []).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));

export function isFresh(bar, tf, now, session) {
  if (!bar) return false;
  const date = nyClock(bar.t).date;
  if (tf === '1d') {
    let yesterday = nyMidnight(session.date) - MIN;
    while (!isTradingDay(nyClock(yesterday).date)) yesterday -= DAY;
    return date === nyClock(yesterday).date;
  }
  return date === session.date && now - bar.t <= (BAR_MINUTES[tf] + 3) * MIN;
}
