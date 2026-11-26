import { guard } from '../core/risk-book.js';

const n = (value) => value === null || value === '' || value === undefined ? null : Number(value);
const number = (value) => Number.isFinite(n(value)) ? n(value) : null;
const positionsBySymbol = (rows) => new Map(rows.map((row) => [row.symbol, row]));
const side = (row) => row.side === 'short' || row.side === 'sell' ? 'short' : 'long';

export function reconcile(account, held, open, managed, previous, limits) {
  const equity = number(account.equity), lastEquity = number(account.last_equity), buyingPower = number(account.buying_power);
  if (equity == null || lastEquity == null || buyingPower == null || !Array.isArray(held) || !Array.isArray(open)) {
    throw new Error('Alpaca reconciliation returned incomplete balances or orders');
  }
  const own = positionsBySymbol(managed), brokerPositions = positionsBySymbol(held), positions = [];
  for (const row of held) {
    const strategy = own.get(row.symbol);
    const qty = Math.abs(number(row.qty)), price = number(row.current_price) ?? number(row.avg_entry_price);
    if (!(qty > 0) || !(price > 0)) throw new Error('Alpaca position has no quantity or price for ' + row.symbol);
    positions.push({ sym: row.symbol, qty, price, side: side(row), stop: strategy?.stop ?? null, style: strategy?.style ?? null,
      strategy: strategy?.strategy ?? null, version: strategy?.version ?? null, opened: strategy?.opened ?? null,
      pnl: number(row.unrealized_pl), order: strategy?.client_id ?? null });
  }
  const pending = [];
  for (const row of open) {
    if (!['entry', null, undefined].includes(row.group_role)) continue;
    const strategy = own.get(row.symbol);
    const opens = row.position_intent === 'buy_to_open' || row.position_intent === 'sell_to_open' ||
      (strategy && strategy.client_id === row.client_order_id) || !brokerPositions.has(row.symbol);
    if (!opens) continue;
    const qty = number(row.qty) - (number(row.filled_qty) || 0);
    const price = number(row.limit_price) ?? strategy?.entry_price;
    if (!(qty > 0)) continue;
    if (!(price > 0)) throw new Error('An open order has no reserve price for ' + row.symbol);
    pending.push({ sym: row.symbol, qty, price, side: side(row), style: strategy?.style ?? null,
      stop: strategy?.stop ?? null, strategy: strategy?.strategy ?? null, id: row.id, order: row.client_order_id });
  }
  const reserved = new Set(pending.map((row) => row.order));
  for (const row of managed) {
    if (row.status !== 'reserved' || reserved.has(row.client_id) || brokerPositions.has(row.symbol)) continue;
    pending.push({ sym: row.symbol, price: row.entry_price, qty: row.qty, side: row.side,
      style: row.style, stop: row.stop, strategy: row.strategy, order: row.client_id, id: null });
  }
  const startingEquity = previous.startingEquity ?? equity;
  const bookEquity = limits.book + equity - startingEquity;
  const peak = Math.max(previous.peak ?? limits.book, bookEquity);
  const dayPnl = equity - lastEquity;
  const state = { equity: bookEquity, peak, dayPnl, halted: previous.halted, paused: account.trading_blocked === true || previous.dayPaused === true,
    positions: [...positions, ...pending], buyingPower, startingEquity };
  return { ...state, positions, pending, risk: guard(state, limits) };
}
