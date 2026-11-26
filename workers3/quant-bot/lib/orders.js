import { nyClock } from '../core/clock.js';
import { checkCandidate } from './evaluate.js';
import { logEvent, readBotState, readSettings } from './state.js';
import { earningsGuard } from './context.js';

const OPEN = "'reserved','working','held','closing'";
const ENDED = new Set(['canceled', 'expired', 'rejected', 'suspended', 'done_for_day']);
const WORKING = new Set(['accepted', 'new', 'partially_filled', 'pending_new', 'held', 'pending_cancel', 'pending_replace']);
const OPEN_ACTION = { long: 'buy', short: 'sell' };
const CLOSE_ACTION = { long: 'sell', short: 'buy' };
const MIN = 60000;

export const clientId = (p) => ['nc', p.strategy, p.version, p.symbol, p.barTime].join('-');

function limitOrder(p, qty, id) {
  if (!(p.price >= 1) || !Number.isInteger(qty) || qty < 1 || !(p.stop > 0) ||
      (p.side === 'long' ? p.stop > p.price - 0.0099 || (p.target != null && p.target < p.price + 0.0099)
        : p.stop < p.price + 0.0099 || (p.target != null && p.target > p.price - 0.0099))) {
    throw new Error('The limit entry and protective orders need valid prices at least one cent apart');
  }
  return { symbol: p.symbol, qty: String(qty), side: OPEN_ACTION[p.side], position_intent: OPEN_ACTION[p.side] + '_to_open',
    type: 'limit', time_in_force: 'gtc', client_order_id: id, limit_price: p.price.toFixed(2),
    order_class: p.target == null ? 'oto' : 'bracket', stop_loss: { stop_price: p.stop.toFixed(2) },
    ...(p.target == null ? {} : { take_profit: { limit_price: p.target.toFixed(2) } }) };
}

export async function liveIntents(db) {
  return (await db.prepare('SELECT * FROM bot_order_intents WHERE status IN (' + OPEN + ')').all()).results;
}

async function updateOrder(db, row, order) {
  const held = Number(order.filled_qty) > 0;
  const status = row.close_id ? 'closing' : held ? 'held' : ENDED.has(order.status) ? 'failed' : 'working';
  const preceding = row.order_body ? JSON.parse(row.order_body).legs || [] : [];
  const legs = [...new Map([...preceding, ...(order.legs || [])].map((leg) => [leg.id, leg])).values()];
  await db.prepare("UPDATE bot_order_intents SET broker_id = ?, opened = COALESCE(opened, ?), order_body = ?, status = ? WHERE client_id = ?")
    .bind(order.id, held ? Date.parse(order.filled_at || order.updated_at) || row.requested : null, JSON.stringify({ ...order, legs }), status, row.client_id).run();
}

export async function submitEntry(db, broker, p, row, qty, now) {
  const id = clientId(p), order = limitOrder(p, qty, id);
  const add = await db.prepare(
    "INSERT OR IGNORE INTO bot_order_intents (client_id,symbol,strategy,version,side,style,qty,entry_price,stop,target,bar_time,requested,status,why,thesis,spec) " +
    "SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?,? WHERE EXISTS (SELECT 1 FROM bot_state WHERE id = 1 AND halted IS NULL AND kill_pending = 0) AND EXISTS (SELECT 1 FROM (SELECT body FROM bot_settings ORDER BY version DESC LIMIT 1) WHERE json_extract(body, '$.mode') = 'paper' AND json_extract(body, '$.paused') = 0)"
  ).bind(id, p.symbol, p.strategy, p.version, p.side, p.style, qty, p.price, p.stop, p.target, p.barTime, now, p.why, p.thesis ?? null, JSON.stringify(row.spec)).run();
  if (!add.meta.changes) return { ok: false, why: 'The signal already has an order, the symbol is reserved, or the bot is halted' };
  const saved = { client_id: id, requested: now };
  let accepted;
  try {
    accepted = await broker.submit(order);
  } catch (error) {
    try { accepted = await broker.orderByClient(id); } catch { /* reconcile a transport-uncertain order later */ }
    if (!accepted) {
      if ([400, 401, 403, 404, 422].includes(error.status)) {
        await db.prepare("UPDATE bot_order_intents SET status = 'failed' WHERE client_id = ?").bind(id).run();
        return { ok: false, why: error.message };
      }
      return { ok: false, why: 'The broker did not confirm the order. It will be reconciled before any new entry in this symbol.', uncertain: true };
    }
  }
  if (!accepted.id) return { ok: false, why: 'The broker did not return an order ID', uncertain: true };
  await updateOrder(db, saved, accepted);
  return { ok: !ENDED.has(accepted.status), why: ENDED.has(accepted.status) ? 'Alpaca ' + accepted.status : null, id };
}

const legs = (order) => [order, ...(order?.legs || [])].filter(Boolean);
const isClose = (o, row) => o.symbol === row.symbol && o.side === CLOSE_ACTION[row.side];
const idsFor = (row) => new Set([row.broker_id, row.close_id, ...legs(row.order_body ? JSON.parse(row.order_body) : null).map((o) => o.id)].filter(Boolean));

export async function syncIntents(db, broker, rows, held, open, now) {
  const openByClient = new Map(open.map((o) => [o.client_order_id, o]));
  const heldBySymbol = new Set(held.map((p) => p.symbol));
  const cursor = (await db.prepare('SELECT MAX(ts) AS at FROM bot_fills').first()).at;
  const fills = rows.length ? await broker.fills(Math.max(cursor ? cursor - MIN : 0, now - 86400000)) : [];
  for (const row of rows) {
    const current = openByClient.get(row.client_id);
    if (row.status === 'reserved' || (row.status === 'working' && !current)) {
      const found = current || await broker.orderByClient(row.client_id);
      if (found) await updateOrder(db, row, found);
      else if (now - row.requested >= MIN) await db.prepare("UPDATE bot_order_intents SET status = 'failed' WHERE client_id = ?").bind(row.client_id).run();
    }
    if (row.status === 'held' && current && current.legs?.length !== (row.order_body ? JSON.parse(row.order_body).legs?.length : null)) await updateOrder(db, row, current);
    if ((row.status === 'held' || row.status === 'closing') && !heldBySymbol.has(row.symbol) && !current) {
      await db.prepare("UPDATE bot_order_intents SET status = 'closed' WHERE client_id = ?").bind(row.client_id).run();
    }
  }
  const active = await liveIntents(db);
  const updated = [...rows, ...active];
  const unique = [...new Map(updated.map((row) => [row.client_id, row])).values()];
  for (const row of unique) {
    const exact = idsFor(row);
    for (const fill of fills) {
      if (fill.symbol !== row.symbol || !exact.has(fill.order_id) || !fill.id) continue;
      const ts = Date.parse(fill.transaction_time);
      const qty = Number(fill.qty), price = Number(fill.price);
      if (!(ts >= row.requested) || !(qty > 0) || !(price > 0) || !['buy', 'sell'].includes(fill.side)) continue;
      const openSide = fill.side === OPEN_ACTION[row.side];
      const why = openSide ? row.why : 'Alpaca confirmed the protective or rule exit.';
      await db.batch([
        db.prepare('INSERT OR IGNORE INTO bot_fills (id,client_id,ts,qty,price,side) VALUES (?,?,?,?,?,?)').bind(fill.id, row.client_id, ts, qty, price, fill.side),
        db.prepare("INSERT OR IGNORE INTO bot_events (event_key,ts,day,kind,symbol,side,qty,price,strategy,version,why,thesis) " +
          "SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE changes() = 1")
          .bind('fill-' + fill.id, ts, nyClock(ts).date, openSide ? 'entry' : 'exit', row.symbol, row.side, qty, price, row.strategy, row.version, why, row.thesis),
      ]);
    }
  }
  return active;
}

export function activeProtection(row, orders) {
  return orders.flatMap(legs).some((o) => isClose(o, row) && WORKING.has(o.status) && !['held','pending_cancel'].includes(o.status) && (o.type === 'stop' || o.type === 'stop_limit' || o.type === 'market'));
}

export async function restoreProtection(db, broker, row, at) {
  const [position, orders] = await Promise.all([broker.position(row.symbol), broker.orders()]);
  if (!position || activeProtection(row, orders)) return true;
  const parent = orders.find((order) => order.client_order_id === row.client_id && Number(order.qty) > Number(order.filled_qty || 0));
  if (parent) {
    if (parent.status !== 'pending_cancel') await broker.cancel(parent.id);
    return false;
  }
  if (orders.flatMap(legs).some((o) => isClose(o, row) && ['held','pending_cancel'].includes(o.status))) return false;
  const qty = Math.abs(Number(position.qty));
  if (!(qty > 0)) return true;
  const side = CLOSE_ACTION[row.side];
  const cid = 'stop-' + row.client_id + '-' + Math.floor(at / MIN);
  const placed = await broker.submit({ symbol: row.symbol, qty: String(qty), side, position_intent: side + '_to_close',
    type: 'stop', time_in_force: 'gtc', stop_price: Number(row.stop).toFixed(2), client_order_id: cid });
  if (!placed.id) throw new Error('Alpaca did not confirm the replacement stop');
  const history = row.order_body ? JSON.parse(row.order_body) : {};
  history.legs = [...(history.legs || []), placed];
  await db.prepare('UPDATE bot_order_intents SET order_body = ? WHERE client_id = ?').bind(JSON.stringify(history), row.client_id).run();
  await logEvent(db, { key: 'protect-' + placed.id, ts: at, kind: 'stop-move', symbol: row.symbol,
    side: row.side, qty, price: row.stop, strategy: row.strategy, version: row.version, why: 'Replaced a missing broker stop at the original risk price.' });
  return true;
}

export async function closeIntent(db, broker, row, reason, at, orders) {
  const live = orders.flatMap(legs);
  const workingClose = live.find((o) => isClose(o, row) && (o.id === row.close_id || o.type === 'market'));
  if (workingClose) return;
  try {
    let result;
    try { result = await broker.close(row.symbol); }
    catch (error) {
      if (error.status !== 403 || !/available|held|qty|quantity/i.test(error.message)) throw error;
      const protection = live.filter((order) => isClose(order, row) && idsFor(row).has(order.id) && WORKING.has(order.status));
      if (!protection.length) throw error;
      await broker.cancel(protection[0].id);
      try { result = await broker.close(row.symbol); }
      catch (retry) {
        try { await restoreProtection(db, broker, row, at); }
        catch (protect) { throw new Error(retry.message + '. Could not restore the stop: ' + protect.message); }
        throw retry;
      }
    }
    if (!result.id) throw new Error('Alpaca did not return the exit order ID');
    await db.prepare("UPDATE bot_order_intents SET status = 'closing', close_id = ? WHERE client_id = ?").bind(result.id, row.client_id).run();
    await logEvent(db, { key: 'close-' + result.id, ts: at, kind: 'exit', strategy: row.strategy, version: row.version,
      symbol: row.symbol, side: row.side, why: reason + '. Alpaca accepted the exit.' });
  } catch (e) {
    await logEvent(db, { key: 'close-error-' + row.client_id + '-' + Math.floor(at / (15 * MIN)), ts: at, kind: 'guard',
      symbol: row.symbol, side: row.side, strategy: row.strategy, version: row.version,
      why: reason + '. Alpaca could not accept the exit: ' + e.message });
  }
}

export async function paperEntries(db, broker, outcomes, rows, exposure, calendar, session, now) {
  const byId = new Map(rows.filter((row) => ['shadow', 'paper', 'active'].includes(row.stage)).map((row) => [row.id, row]));
  for (const p of outcomes) {
    const row = byId.get(p.strategy);
    if (!row || p.version !== row.version) continue;
    if (p.skip) {
      const bar = p.barTime || Math.floor(now / (15 * MIN));
      await logEvent(db, { key: 'skip-' + clientId({ ...p, barTime: bar }), ts: now, kind: 'skip', symbol: p.symbol,
        strategy: p.strategy, version: p.version, why: p.skip, barTime: p.barTime, fired: false });
      continue;
    }
    if (row.stage === 'shadow') {
      // N5: a strategy's shadow session in paper mode: the same checks, logged, never ordered.
      const earnings = earningsGuard(calendar, p.symbol, session.date, now);
      const verdict = checkCandidate(p, exposure, (await readSettings(db)).settings.limits, { session, earningsSoon: earnings.soon });
      const skip = !earnings.known ? 'Earnings coverage is unavailable' : verdict.ok ? null : verdict.why;
      await logEvent(db, { key: 'shadow-' + clientId(p), ts: now, kind: skip ? 'skip' : 'shadow', symbol: p.symbol, side: p.side,
        qty: skip ? null : verdict.qty, price: p.price, strategy: p.strategy, version: p.version, thesis: p.thesis, why: skip || p.why, barTime: p.barTime, fired: true });
      continue;
    }
    const [settings, status] = await Promise.all([readSettings(db), readBotState(db)]);
    const controls = settings.settings;
    if (controls.mode !== 'paper' || controls.paused || status.halted || status.killPending || status.errors >= 3) return;
    const earnings = earningsGuard(calendar, p.symbol, session.date, now);
    const verdict = checkCandidate(p, exposure, controls.limits, { session, earningsSoon: earnings.soon });
    let skip = !earnings.known ? 'Earnings coverage is unavailable' : verdict.ok ? null : verdict.why;
    if (!skip && p.side === 'short') {
      const asset = await broker.asset(p.symbol);
      if (asset.shortable !== true || asset.easy_to_borrow !== true || asset.tradable !== true) skip = 'Alpaca borrow eligibility is unavailable';
    }
    const needed = p.price * verdict.qty * (p.side === 'short' ? 1.03 : 1);
    if (!skip && needed > exposure.buyingPower) skip = 'Insufficient Alpaca buying power';
    if (!skip) {
      const placed = await submitEntry(db, broker, p, row, verdict.qty, now);
      if (placed.ok || placed.uncertain) {
        exposure.buyingPower -= needed;
        exposure.positions.push({ sym: p.symbol, side: p.side, style: p.style, strategy: p.strategy, price: p.price, stop: p.stop, qty: verdict.qty });
      }
      if (!placed.ok) skip = placed.why;
    }
    if (skip) await logEvent(db, { key: 'skip-' + clientId(p), ts: now, kind: 'skip', symbol: p.symbol, side: p.side,
      strategy: p.strategy, version: p.version, why: skip, barTime: p.barTime, fired: true });
  }
}
