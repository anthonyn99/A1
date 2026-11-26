import { nyClock } from '../core/clock.js';
import { isTradingDay } from '../core/holidays.js';
import { liveStrategies, noteSlot } from './lifecycle.js';

import { paperBroker } from './alpaca.js';
import { candidate, checkCandidate, exitReason, shardsFor, usesDaySetup } from './evaluate.js';
import { readMarketContext, earningsGuard } from './context.js';
import { loadBars, loadVolume, marketClock, objects } from './market.js';
import { reconcile, deployedOf } from './reconcile.js';
import { logEvent, readBotState, readSettings } from './state.js';

const MIN = 60000;
const REGULAR_OPEN = 570;
const REGULAR_CLOSE = 960;
/** What the bot evaluates (N5): the newest shadow, paper or active version of each strategy (lib/lifecycle.js). */
export const stagedStrategies = (db) => liveStrategies(db);

const due = (session, tf) => {
  if (tf === '1d') return session.minutes === session.openMin + 1;
  if (tf === '1h') return session.minutes % 60 === 1;
  const width = tf === '15m' ? 15 : 5;
  return session.minutes > session.openMin && (session.minutes - session.openMin) > width && (session.minutes - session.openMin) % width === 1;
};

/** Called as a named Worker entrypoint, with at most ten symbols and no broker writes. */
export async function inspectShard(env, symbols, rows, now, session, { cache = globalThis.caches?.default, broker = paperBroker(env), volumeOf, managed = [] } = {}) {
  if (!symbols.length || symbols.length > 10) throw new Error('A shard needs one to ten symbols');
  const work = rows.filter(({ spec }) => due(session, spec.timeframe) && spec.universe.symbols.some((s) => symbols.includes(s)));
  const exits = managed.filter((row) => symbols.includes(row.sym) && due(session, row.spec.timeframe));
  const all = [...work, ...exits];
  if (!all.length) return [];
  const tf = new Set(all.map(({ spec }) => spec.timeframe));
  if (all.some(({ spec }) => usesDaySetup(spec))) tf.add('1d');
  const groups = await Promise.all([...tf].map(async (frame) => {
    const bars = await loadBars(broker, [...symbols, 'SPY'], frame, now, session, cache);
    return [frame, Object.fromEntries(Object.entries(bars).map(([symbol, values]) => [symbol, objects(values)]))];
  }));
  const volumeSymbols = symbols.filter((symbol) => all.some(({ spec }) => spec.universe.symbols.includes(symbol) && usesDaySetup(spec)));
  const volume = volumeOf ? Object.assign({}, ...(await Promise.all(volumeSymbols.map((symbol) => volumeOf(symbol, session.date))))) : await loadVolume(broker, volumeSymbols, session.date, cache);
  const data = { bars: Object.fromEntries(groups), volume };
  const outcomes = [];
  for (const row of work) {
    for (const symbol of symbols) {
      if (!row.spec.universe.symbols.includes(symbol)) continue;
      const signal = candidate(row, symbol, data, { now, session });
      if (signal) outcomes.push({ symbol, strategy: row.id, version: row.version, ...signal });
    }
  }
  for (const row of exits) {
    const symbol = row.sym, frame = row.spec.timeframe;
    const why = exitReason(row, row.spec, data.bars[frame]?.[symbol], {
      now, session, daily: data.bars['1d']?.[symbol], bench: data.bars[frame]?.SPY, volume: volume[symbol],
    });
    if (why) outcomes.push({ exit: true, id: row.id, why });
  }
  return outcomes;
}

async function storeFailure(db, previous, at, reason) {
  const errors = Math.min(3, previous.errors + 1);
  if (previous.errors !== errors) {
    await db.prepare('UPDATE bot_state SET errors = ? WHERE id = 1').bind(errors).run();
    if (errors === 3) await logEvent(db, { key: 'broker-guard-' + nyClock(at).date + '-' + Math.floor(at / (15 * MIN)),
      ts: at, kind: 'guard', why: 'New entries paused after three data or broker errors. ' + reason });
  }
}

async function markCheckpoint(db, at, session, previous, book, count) {
  const slot = Math.floor((session.minutes - session.openMin) / 15);
  const snapshots = previous.date === session.date ? previous.shadowSlots || [] : [];
  const shadowSlots = [...new Set([...snapshots, ...(count > 0 && book.risk.state === 'ok' ? [slot] : [])])];
  const next = { ...(previous.killReport ? { killReport: previous.killReport } : {}), date: session.date, market: 'open', half: session.half, shadowSlots,
    startingEquity: book.startingEquity, book: book.book, equity: book.equity, peak: book.peak, dayPnl: book.dayPnl,
    ...deployedOf(book, previous, session.date), positions: book.positions,
    pending: book.pending, strategies: count, guard: book.risk, buyingPower: book.buyingPower };
  await db.prepare('UPDATE bot_state SET last_check = ?, snapshot = ?, errors = 0, halted = COALESCE(halted, ?) WHERE id = 1')
    .bind(at, JSON.stringify(next), book.risk.state === 'halt' ? book.risk.why : null).run();
}

async function finishSession(db, at, session, previous) {
  if (previous.date !== session.date || previous.market !== 'open') return;
  const remainingSlots = Math.ceil((session.closeMin - session.openMin) / 15);
  const next = { ...previous, market: 'closed' };
  for (const field of ['halted', 'lastCheck', 'errors', 'killPending']) delete next[field];
  const statements = [db.prepare('UPDATE bot_state SET last_check = ?, snapshot = ? WHERE id = 1').bind(at, JSON.stringify(next))];
  if (!previous.errors && !previous.halted && (previous.shadowSlots || []).length >= remainingSlots) {
    statements.push(db.prepare('INSERT OR IGNORE INTO bot_shadow_sessions (day, checked) VALUES (?, ?)').bind(session.date, at));
  }
  await db.batch(statements);
}

/** Serial portfolio checks for one scheduled shadow tick. Shards never touch broker orders. */
export async function runShadow(env, at, dispatch, { cache = globalThis.caches?.default, broker: client } = {}) {
  const now = at;
  const local = nyClock(at);
  if (!isTradingDay(local.date) || local.minutes < REGULAR_OPEN || local.minutes > REGULAR_CLOSE + 10) return { skipped: 'outside-session' };
  const db = env.DB;
  const [status, config] = await Promise.all([readBotState(db), readSettings(db)]);
  const settings = config.settings;
  if (settings.mode !== 'shadow') return { skipped: 'mode' };
  const broker = client || paperBroker(env);
  let session, book, rows, calendar, outcomes;
  try {
    session = await marketClock(broker, at, cache);
    if (!session.open) {
      if (session.closedForDay && session.openMin != null) await finishSession(db, at, session, status);
      return { skipped: 'market-closed' };
    }
    const checkpoint = (session.minutes - session.openMin) % 15 === 1;
    if (!checkpoint && !['5m', '15m', '1h', '1d'].some((frame) => due(session, frame))) return { skipped: 'no-new-bar' };
    const [account, positions, orders, picks, availability] = await Promise.all([
      broker.account(), broker.positions(), broker.orders(), stagedStrategies(db), readMarketContext(db),
    ]);
    book = reconcile(account, positions, orders, [], status, settings.limits);
    rows = picks;
    calendar = availability;
    if (settings.paused || status.halted || book.risk.state !== 'ok') {
      if (checkpoint) await markCheckpoint(db, at, session, status, book, 0);
      return { skipped: 'guard' };
    }
    const groups = shardsFor(rows).slice(0, 4);
    outcomes = (await Promise.all(groups.map((symbols) => dispatch(symbols, rows, now, session)))).flat();
    if (checkpoint) {
      await markCheckpoint(db, at, session, status, book, rows.length);
      if (rows.length) await noteSlot(db, session.date, Math.floor((session.minutes - session.openMin) / 15));
    }
    else if (status.errors) await db.prepare('UPDATE bot_state SET errors = 0 WHERE id = 1').run();
  } catch (error) {
    await storeFailure(db, status, at, error.message);
    return { skipped: 'unavailable', reason: error.message };
  }

  const exposure = { ...book, positions: [...book.positions, ...book.pending] };
  for (const outcome of outcomes) {
    const { symbol, strategy, version } = outcome;
    const key = [session.date, strategy, version, symbol, outcome.barTime || Math.floor(at / (15 * MIN))].join('-');
    const earnings = earningsGuard(calendar, symbol, session.date, at);
    let skip = outcome.skip || (!earnings.known && 'Earnings coverage is unavailable');
    const signal = !skip && checkCandidate(outcome, exposure, settings.limits, { session, earningsSoon: earnings.soon });
    if (!skip && !signal.ok) skip = signal.why;
    if (!skip && outcome.side === 'short') {
      try {
        const asset = await broker.asset(symbol);
        if (asset.shortable !== true || asset.easy_to_borrow !== true || asset.tradable !== true) skip = 'Alpaca does not mark the symbol as tradable and easy to borrow';
      } catch { skip = 'Alpaca could not verify borrow availability'; }
    }
    if (!skip && signal.qty * outcome.price > book.buyingPower) skip = 'The paper account has insufficient buying power';
    if (!skip) exposure.positions.push({ sym: symbol, qty: signal.qty, price: outcome.price, stop: outcome.stop, side: outcome.side,
      style: outcome.style, strategy });
    await logEvent(db, { key, ts: at, kind: skip ? 'skip' : 'shadow', symbol, side: outcome.side, qty: skip ? null : signal.qty,
      price: outcome.price, strategy, version, thesis: outcome.thesis, why: skip || outcome.why, barTime: outcome.barTime, fired: !outcome.skip });
  }
  return { evaluated: outcomes.length };
}
