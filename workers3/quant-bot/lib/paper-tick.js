import { nyClock } from '../core/clock.js';
import { isTradingDay } from '../core/holidays.js';
import { paperBroker } from './alpaca.js';
import { shardsFor } from './evaluate.js';
import { marketClock } from './market.js';
import { liveIntents } from './orders.js';
import { stagedStrategies } from './shadow.js';

export async function runPaper(env, now, inspect, execute, { broker = paperBroker(env), cache = globalThis.caches?.default } = {}) {
  const clock = nyClock(now);
  if (!isTradingDay(clock.date) || clock.minutes < 570 || clock.minutes > 970) return { skipped: 'outside-session' };
  const [session, rows, intents] = await Promise.all([marketClock(broker, now, cache), stagedStrategies(env.DB), liveIntents(env.DB)]);
  if (session.openMin == null || (!session.open && !session.closedForDay)) return { skipped: 'market-unavailable' };
  const held = intents.filter((row) => ['held', 'closing'].includes(row.status)).map((row) => ({
    id: row.client_id, sym: row.symbol, side: row.side, style: row.style, opened: row.opened || row.requested, spec: JSON.parse(row.spec),
  }));
  const active = rows.filter((row) => ['paper', 'active'].includes(row.stage));
  const groups = shardsFor(active, held).slice(0, 4);
  const outcomes = session.open ? (await Promise.all(groups.map((group) => inspect(group, active, now, session, held)))).flat() : [];
  return execute({ now, session, rows: active, outcomes: outcomes.filter((result) => !result.exit), exits: outcomes.filter((result) => result.exit) });
}
