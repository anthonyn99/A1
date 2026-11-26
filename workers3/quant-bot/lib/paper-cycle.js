import { deployed, flattenDue } from '../core/risk-book.js';
import { reconcile } from './reconcile.js';
import { activeProtection, closeIntent, liveIntents, paperEntries, restoreProtection, syncIntents } from './orders.js';
import { logEvent, readBotState, readSettings } from './state.js';
import { readMarketContext } from './context.js';

const MIN = 60000;
const bySymbol = (positions) => new Map(positions.map((row) => [row.symbol, row]));
const isTimed = (row, session) => flattenDue(row, session.minutes, { half: session.half, flattenBy: JSON.parse(row.spec).flattenBy });

async function failure(db, status, now, reason) {
  const errors = Math.min(3, status.errors + 1);
  if (status.errors === errors) return;
  await db.prepare('UPDATE bot_state SET errors = ? WHERE id = 1').bind(errors).run();
  if (errors === 3) await logEvent(db, { key: 'paper-broker-guard-' + Math.floor(now / (15 * MIN)),
    ts: now, kind: 'guard', why: 'The paper broker failed three checks. New entries paused. ' + reason });
}

async function markRisk(db, session, status, book, at) {
  const frame = Math.floor(at / (15 * MIN));
  const fresh = frame !== Math.floor((status.lastCheck || 0) / (15 * MIN));
  const state = { date: session.date, market: session.open ? 'open' : 'closed', half: session.half,
    startingEquity: book.startingEquity, equity: book.equity, peak: book.peak, dayPnl: book.dayPnl,
    deployed: deployed({ positions: [...book.positions, ...book.pending] }), positions: book.positions,
    pending: book.pending, guard: book.risk, buyingPower: book.buyingPower };
  if (fresh || (book.risk.state === 'halt' && !status.halted) || status.errors || !status.peak || book.peak > status.peak) {
    await db.prepare('UPDATE bot_state SET last_check = ?, snapshot = ?, errors = 0, halted = COALESCE(halted, ?) WHERE id = 1')
      .bind(at, JSON.stringify(state), book.risk.state === 'halt' ? book.risk.why : null).run();
  }
  if (book.risk.state !== 'ok' && status.guard?.why !== book.risk.why) {
    await logEvent(db, { key: 'risk-guard-' + session.date + '-' + frame, ts: at, kind: 'guard', why: book.risk.why });
  }
  if (fresh) {
    const slot = frame * 15 * MIN;
    const market = new Map(book.positions.filter((p) => p.order).map((p) => [p.order, p.qty * p.price * (p.side === 'short' ? -1 : 1)]));
    const { results } = await db.prepare("SELECT o.strategy, o.version, f.client_id, SUM(CASE f.side WHEN 'sell' THEN f.qty*f.price ELSE -f.qty*f.price END) AS cash FROM bot_fills f JOIN bot_order_intents o ON f.client_id = o.client_id GROUP BY f.client_id, o.strategy, o.version").all();
    const sleeves = new Map();
    for (const row of results) {
      const key = row.strategy + ':' + row.version;
      const sleeve = sleeves.get(key) || { strategy: row.strategy, version: row.version, pnl: 0 };
      sleeve.pnl += row.cash + (market.get(row.client_id) || 0);
      sleeves.set(key, sleeve);
    }
    if (sleeves.size) await db.batch([...sleeves.values()].map((row) =>
      db.prepare('INSERT OR IGNORE INTO bot_equity (strategy,version,slot,equity) VALUES (?,?,?,?)').bind(row.strategy,row.version,slot,row.pnl)));
  }
}

export async function paperCycle(env, input, broker, clock = Date.now) {
  const { now: scheduledAt, session, outcomes, exits, rows, dataError } = input;
  const db = env.DB, config = await readSettings(db);
  const status = await readBotState(db);
  if (config.settings.mode !== 'paper' || status.killPending) return { skipped: 'mode-or-kill' };
  try {
    const [account, positions, orders, known, calendar] = await Promise.all([
      broker.account(), broker.positions(), broker.orders(), liveIntents(db), readMarketContext(db),
    ]);
    const refreshed = await syncIntents(db, broker, known, positions, orders, scheduledAt);
    const book = reconcile(account, positions, orders, refreshed, status, config.settings.limits);
    const raw = bySymbol(positions), exitReasons = new Map(exits.map((row) => [row.id, row.why]));
    const working = new Map(orders.map((order) => [order.client_order_id, order]));
    let protective = true;
    for (const row of refreshed) {
      const time = isTimed(row, session) || (session.closedForDay && row.style === 'day');
      const why = time ? 'The position reached its session flatten time' : exitReasons.get(row.client_id);
      const pending = working.get(row.client_id);
      if ((why || scheduledAt - row.bar_time > 30 * MIN) && pending && ['working','held'].includes(row.status) &&
          Number(pending.qty) > Number(pending.filled_qty || 0) && pending.id) {
        await broker.cancel(pending.id);
      }
      if (why && raw.has(row.symbol)) await closeIntent(db, broker, row, why, scheduledAt, orders);
      else if (raw.has(row.symbol) && !activeProtection(row, orders)) {
        protective = (await restoreProtection(db, broker, row, scheduledAt)) && protective;
      }
    }
    if (dataError) {
      await failure(db, status, scheduledAt, dataError);
      return { skipped: 'stale-data', reason: dataError };
    }
    await markRisk(db, session, status, book, scheduledAt);
    const marketCurrent = session.open && clock() - scheduledAt < MIN;
    const managed = new Set(refreshed.map((row) => row.symbol));
    if (marketCurrent && protective && !status.halted && !config.settings.paused && status.errors < 3 && book.risk.state === 'ok' &&
        positions.every((row) => managed.has(row.symbol))) {
      await paperEntries(db, broker, outcomes, rows, { ...book, positions: [...book.positions, ...book.pending] }, calendar, session, scheduledAt);
    }
    return { checked: true };
  } catch (error) {
    await failure(db, status, scheduledAt, error.message);
    return { skipped: 'broker', reason: error.message };
  }
}
