import { addDays, isTradingDay } from '../core/holidays.js';
import { json } from './lab.js';

const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FRESH_MS = 36 * 3600000;

export async function putMarketContext({ DB }, value, now = Date.now()) {
  const earnings = value?.earnings;
  if (!earnings || typeof earnings !== 'object' || Array.isArray(earnings) || Object.keys(earnings).length > 200) {
    return json({ ok: false, error: 'earnings must map ticker symbols to dates' }, 400);
  }
  for (const [symbol, row] of Object.entries(earnings)) {
    if (!SYMBOL.test(symbol) || !Number.isFinite(row?.asOf) || row.asOf > now + 5 * 60000 ||
        (row.next !== null && !DAY.test(row.next))) return json({ ok: false, error: 'invalid earnings row' }, 400);
  }
  await DB.prepare('INSERT INTO bot_market_context (id, at, body) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, body = excluded.body WHERE excluded.at >= bot_market_context.at')
    .bind(now, JSON.stringify(earnings)).run();
  return json({ ok: true });
}

export async function readMarketContext(db) {
  const row = await db.prepare('SELECT body FROM bot_market_context WHERE id = 1').first();
  return row ? JSON.parse(row.body) : {};
}

export function earningsGuard(context, symbol, date, now) {
  const row = context[symbol];
  if (!row || now - row.asOf > FRESH_MS || (row.next && row.next < date)) return { known: false, soon: false };
  let next = addDays(date, 1);
  while (!isTradingDay(next)) next = addDays(next, 1);
  return { known: true, soon: row.next === date || row.next === next };
}
