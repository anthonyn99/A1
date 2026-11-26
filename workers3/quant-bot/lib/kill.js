import { paperBroker } from './alpaca.js';
import { nyClock } from '../core/clock.js';
import { json } from './lab.js';

const HALTED = 'Tony pressed the kill switch';

export async function killBot(env, body, { now = Date.now(), broker: client } = {}) {
  if (body?.confirm !== true) return json({ ok: false, error: 'Confirm the Neo Cortex kill switch first' }, 400);
  const db = env.DB;
  const stamp = crypto.randomUUID();
  await db.batch([
    db.prepare('UPDATE bot_state SET halted = ?, kill_pending = 1 WHERE id = 1').bind(HALTED),
    db.prepare('INSERT INTO bot_events (event_key, ts, day, kind, why) VALUES (?, ?, ?, ?, ?)')
      .bind('kill-' + stamp, now, nyClock(now).date, 'guard', HALTED),
  ]);

  if (!client && env.EXECUTION) return env.EXECUTION.getByName('account').liquidate();
  return flattenPaper(env, { broker: client });
}

export async function flattenPaper(env, { broker: client } = {}) {
  const db = env.DB;
  let canceled = null, closing = null, positions = null, orders = null;
  const problems = [];
  try {
    const broker = client || paperBroker(env);
    async function step(label, action) {
      try { return await action(); } catch (error) { problems.push(label + ': ' + error.message); return null; }
    }
    const cancel = await step('Cancel open orders', () => broker.cancelAll());
    const liquidation = await step('Close positions', () => broker.closeAll());
    canceled = Array.isArray(cancel) ? cancel.filter((row) => row.status < 300).length : null;
    closing = Array.isArray(liquidation) ? liquidation.filter((row) => row.status < 300).map((row) => row.symbol) : null;
    if (Array.isArray(cancel)) for (const row of cancel) if (row.status >= 300) problems.push('Order ' + row.id + ' returned ' + row.status);
    if (Array.isArray(liquidation)) for (const row of liquidation) if (row.status >= 300) problems.push('Closing ' + row.symbol + ' returned ' + row.status);
    const [leftPositions, leftOrders] = await Promise.all([
      step('Read remaining positions', () => broker.positions()), step('Read remaining orders', () => broker.orders()),
    ]);
    positions = Array.isArray(leftPositions) ? leftPositions.map((p) => ({ symbol: p.symbol, qty: p.qty, side: p.side })) : null;
    orders = Array.isArray(leftOrders) ? leftOrders.map((o) => ({ id: o.id, symbol: o.symbol, status: o.status })) : null;
  } catch (error) {
    problems.push(error.message);
  }
  const flat = positions?.length === 0 && orders?.length === 0;
  if (flat) await db.prepare('UPDATE bot_state SET kill_pending = 0 WHERE id = 1 AND halted = ?').bind(HALTED).run();
  return json({ ok: flat, halted: true, canceled, closing, positions, orders, problems }, flat ? 200 : 502);
}
