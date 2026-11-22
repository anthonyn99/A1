// quant-api's book per paper broker (Batch 4 T5, A1-Priv docs/TradeHub/quant/t4-05.md; lib/books.js):
// the shown numbers (capital + the broker's P&L, buying power scaled and capped), the routes (only Tony
// writes; a reset needs confirm, flattens that broker only and takes a new baseline), the order checks
// on both brokers (sized by the book, capped by its buying power), Alpaca's and Webull's flatten, and
// failing closed before migration 0015. On a REAL SQLite D1 with every migration.
//
// Run: node tests/quant-books-api.test.js
'use strict';
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const WDIR = path.join(__dirname, '..', 'workers2', 'quant-api');
const MIG = path.join(WDIR, 'migrations');
function realD1(skip = []) {
  const sql = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIG).filter((x) => x.endsWith('.sql') && !skip.includes(x)).sort()) sql.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  const norm = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a.map(norm)),
    async first() { const r = sql.prepare(q).get(...args); return r ? { ...r } : null; },
    async all() { return { results: sql.prepare(q).all(...args).map((r) => ({ ...r })) }; },
    async run() { const r = sql.prepare(q).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { sql, prepare: (q) => stmt(q), async batch(list) { for (const s of list) await s.run(); return []; } };
}
const body = async (res) => JSON.parse(await res.text());
const req = (b, method = 'POST') => new Request('https://quant-api.test/x', { method, body: JSON.stringify(b) });
const throwsOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

(async () => {
  const BK = await import(pathToFileURL(path.join(WDIR, 'lib', 'books.js')).href);
  const PA = await import(pathToFileURL(path.join(WDIR, 'lib', 'paper.js')).href);
  const WB = await import(pathToFileURL(path.join(WDIR, 'lib', 'brokers', 'webull.js')).href);

  console.log('\nThe shown numbers');
  {
    const a = { equity: 101000, cash: 60000, buying_power: 202000, long_value: 41000, short_value: 0, last_equity: 100500 };
    ok('no book: the broker\'s own numbers', BK.applyBook(null, a).equity === 101000 && BK.applyBook(null, a).booked === false);
    const b = { capital: 25000, baseline: 100000, bp_cap: null };
    const s = BK.applyBook(b, a);
    ok('equity = capital + the broker\'s P&L since the baseline ($25,000 + $1,000)', s.equity === 26000 && s.booked && s.broker_equity === 101000, JSON.stringify(s));
    ok('cash and yesterday\'s equity move by the same offset (today\'s P&L unchanged)', s.cash === -15000 && s.last_equity === 25500 && s.equity - s.last_equity === a.equity - a.last_equity);
    ok('buying power scales with the shown equity (202,000 × 26,000 / 101,000)', s.buying_power === 52000, s.buying_power);
    const c = BK.applyBook({ ...b, bp_cap: 50000 }, a);
    ok('a buying-power cap is a ceiling on what is held: 50,000 − 41,000 held = 9,000', c.buying_power === 9000, c.buying_power);
    ok('...never below zero', BK.applyBook({ ...b, bp_cap: 10000 }, a).buying_power === 0);
    ok('a book equal to the broker changes nothing', BK.applyBook({ capital: 100000, baseline: 100000, bp_cap: null }, a).equity === 101000 && BK.applyBook({ capital: 100000, baseline: 100000, bp_cap: null }, a).buying_power === 202000);
    ok('an order\'s value: notional, else qty × limit / stop / price', BK.orderValue({ notional: 500 }) === 500 && BK.orderValue({ qty: 10, limit_price: 20 }) === 200 && BK.orderValue({ qty: 3 }, 10) === 30 && BK.orderValue({ qty: 3 }) === null);
    ok('over the book\'s buying power is refused, in words; a closing order never is', /more than the book's buying power \(\$52000\.00\)/.test(BK.overBook(s, { qty: 1000, limit_price: 60 }, null)) && BK.overBook(s, { qty: 1000, limit_price: 60 }, null, true) === '' && BK.overBook(s, { qty: 10, limit_price: 60 }) === '' && BK.overBook(BK.applyBook(null, a), { qty: 1e6, limit_price: 60 }) === '');
  }

  console.log('\nThe routes');
  {
    BK.clearBooks();
    const env = { DB: realD1() };
    let raw = { equity: 100000, cash: 100000, buying_power: 200000, long_value: 0, short_value: 0 }, flat = 0;
    const deps = () => ({ rawAccount: async () => raw, flatten: async () => { flat++; return { canceled: 2, closing: ['NVDA'], failed: [] }; } });
    const call = (b, rest = '/book', m = 'PUT', now = 1000) => BK.bookRoute(env, b ? req(b, m) : new Request('https://q.test/x'), 'alpaca', rest, m, { ...deps(), now });
    let j = await body(await call(null, '/book', 'GET'));
    ok('GET: no book yet; the default capital is said', j.book === null && j.defaults.capital === 100000);
    let e = await throwsOf(() => call({ capital: 25000, who: 'neo' }));
    ok('Neo Quant cannot set the book (403)', e && e.status === 403, e && e.message);
    e = await throwsOf(() => call({ capital: 50, who: 'tony' }));
    ok('capital under $1,000 is refused', e && e.status === 400 && /between/.test(e.message));
    j = await body(await call({ capital: 25000, who: 'tony' }));
    ok('PUT capital: the book starts at the broker\'s equity now (baseline 100,000)', j.book.capital === 25000 && j.book.baseline === 100000 && j.book.bp_cap === null);
    raw = { ...raw, equity: 100800 };
    j = await body(await call({ bpCap: 30000, who: 'tony' }));
    ok('PUT again keeps the baseline (P&L stays), sets the cap', j.book.baseline === 100000 && j.book.capital === 25000 && j.book.bp_cap === 30000);
    j = await body(await call({ bpCap: null, who: 'tony' }));
    ok('...a cap of none clears it', j.book.bp_cap === null);
    e = await throwsOf(() => call({ who: 'tony' }, '/book/reset', 'POST'));
    ok('a reset without confirm: true is refused and touches nothing', e && e.status === 400 && flat === 0);
    raw = { ...raw, equity: 100750 };
    j = await body(await call({ who: 'tony', confirm: true }, '/book/reset', 'POST', 2000));
    ok('reset: flattened once, a new baseline (the broker\'s equity after), the capital kept', flat === 1 && j.book.baseline === 100750 && j.book.capital === 25000 && j.canceled === 2 && j.closing[0] === 'NVDA');
    ok('...its history: when, the capital, what the book showed before (25,000 + 750)', j.book.resets.length === 1 && j.book.resets[0].at === 2000 && j.book.resets[0].from === 25750 && j.book.resets[0].capital === 25000);
    j = await body(await call({ who: 'tony', confirm: true, capital: 50000 }, '/book/reset', 'POST', 3000));
    ok('reset with a new capital', j.book.capital === 50000 && j.book.resets.length === 2 && j.book.resets[0].at === 3000);
    for (let i = 0; i < 25; i++) await call({ who: 'tony', confirm: true }, '/book/reset', 'POST', 4000 + i);
    j = await body(await call(null, '/book', 'GET', 9e9));
    ok('the history keeps the last 20 resets', j.book.resets.length === 20 && j.book.resets[0].at === 4024);
    const env2 = { DB: realD1() };
    j = await body(await BK.bookRoute(env2, req({ who: 'tony', confirm: true }), 'webull', '/book/reset', 'POST', { rawAccount: async () => ({ equity: 999000 }), flatten: async () => ({ canceled: 0, closing: ['MSFT'], failed: [] }), now: 5 }));
    ok('a first reset with no capital starts at the broker\'s default ($1,000,000 Webull)', j.book.capital === 1000000 && j.book.baseline === 999000);
    e = await throwsOf(() => BK.bookRoute(env2, req({ who: 'tony', confirm: true, capital: 5000 }), 'webull', '/book/reset', 'POST', { rawAccount: async () => ({ equity: 980000 }), flatten: async () => ({ canceled: 3, closing: [], failed: ['AAPL'] }), now: 6 }));
    const after = await BK.readBook(env2, 'webull');
    ok('a position the broker would not close refuses the reset (409, in words: the cancels stand) and the book does not move', e && e.status === 409 && /3 open order\(s\) were cancelled, but AAPL could not be closed/.test(e.message) && after.capital === 1000000 && after.baseline === 999000 && after.resets.length === 1, e && e.message);
    const env3 = { DB: realD1(['0015_books.sql']) };
    ok('before migration 0015: no book (reads), and a write says which migration', (await BK.readBook(env3, 'alpaca')) === null
      && /0015_books/.test(((await throwsOf(() => BK.bookRoute(env3, req({ capital: 5000, who: 'tony' }, 'PUT'), 'alpaca', '/book', 'PUT', deps()))) || {}).message || ''));
    env.DB.sql.exec("UPDATE trade_books SET capital = 1 WHERE broker = 'alpaca'");
    ok('never cached: a change reaches the very next read (every worker copy sees a reset at once)', (await BK.readBook(env, 'alpaca')).capital === 1);
    const NOW = Date.parse('2026-11-23T17:00:00Z');
    const sameDay = BK.applyBook({ capital: 50000, baseline: 103000, bp_cap: null, resets: [{ at: Date.parse('2026-11-23T16:00:00Z') }] }, { equity: 103400, last_equity: 100000, cash: 0, buying_power: 1, day_pnl: 3400 }, NOW);
    ok('a reset today: Today counts from the reset ($50,000 → $50,400 = +$400), not from yesterday\'s close', sameDay.last_equity === 50000 && sameDay.equity === 50400 && sameDay.day_pnl === 400, JSON.stringify(sameDay));
    const dayAfter = BK.applyBook({ capital: 50000, baseline: 103000, bp_cap: null, resets: [{ at: Date.parse('2026-11-22T16:00:00Z') }] }, { equity: 103400, last_equity: 103100 }, NOW);
    ok('...a reset on an earlier day: yesterday\'s close + the offset, as before', dayAfter.last_equity === 50100);
    ok('a changed order counts only its increase against the buying power', BK.overBook({ booked: true, buying_power: 500 }, { qty: 20, limit_price: 50 }, null, false, 600) === '' && /more than the book's buying power/.test(BK.overBook({ booked: true, buying_power: 300 }, { qty: 20, limit_price: 50 }, null, false, 600)));
  }

  console.log('\nAlpaca: the account and the order checks follow the book');
  {
    BK.clearBooks();
    const env = { DB: realD1(), ALPACA_KEY: 'k', ALPACA_SECRET: 's' };
    const calls = [];
    const fake = async (u, init = {}) => {
      const url = new URL(u); calls.push([init.method || 'GET', url.pathname + url.search]);
      const R = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
      if (url.host !== 'paper-api.alpaca.markets') return R({ message: 'wrong host' }, 500);
      if (url.pathname === '/v2/account') return R({ equity: '100000', last_equity: '100000', cash: '100000', buying_power: '200000', long_market_value: '0', short_market_value: '0' });
      if (url.pathname === '/v2/clock') return R({ is_open: true });
      if (url.pathname === '/v2/orders' && init.method === 'POST') return R({ id: 'A1', status: 'accepted' });
      if (url.pathname === '/v2/orders' && init.method === 'DELETE') return R([{ id: 'o1' }, { id: 'o2' }], 207);
      if (url.pathname === '/v2/positions' && init.method === 'DELETE') return R([{ symbol: 'NVDA', status: 200 }, { symbol: 'AMD', status: 403 }], 207);
      return R({ message: 'no route' }, 404);
    };
    const book = { capital: 10000, baseline: 100000, bp_cap: null };
    const a = await body(await PA.account(env, fake, book));
    ok('/account with a book: $10,000 shown, the broker\'s $100,000 beside it, the book rides along', a.account.equity === 10000 && a.account.broker_equity === 100000 && a.account.buying_power === 20000 && a.book.capital === 10000);
    const place = (order, b = book) => PA.place(env, req({ order, who: 'tony' }), { fetchFn: fake, priceOf: async () => 100, book: b });
    let e = await throwsOf(() => place({ symbol: 'AAPL', side: 'buy', type: 'limit', limit_price: 100, qty: 30, time_in_force: 'day' }));
    ok('25% of the BOOK\'s equity sizes an order ($3,000 on $10,000 is refused)', e && e.status === 422 && /25%|equity/.test(e.message), e && e.message);
    e = await throwsOf(() => place({ symbol: 'AAPL', side: 'buy', type: 'limit', limit_price: 100, qty: 30, time_in_force: 'day' }, null));
    ok('...the same order without a book goes ($3,000 of $100,000)', !e, e && e.message);
    e = await throwsOf(() => place({ symbol: 'AAPL', side: 'buy', type: 'limit', limit_price: 100, qty: 20, time_in_force: 'day' }, { ...book, bp_cap: 2500 }));
    ok('the book\'s buying-power cap refuses an order over it ($2,000 over a $2,500 cap is fine; …)', !e, e && e.message);
    e = await throwsOf(() => place({ symbol: 'AAPL', side: 'buy', type: 'limit', limit_price: 100, qty: 24, time_in_force: 'day' }, { ...book, bp_cap: 2000 }));
    ok('...$2,400 over a $2,000 cap is refused, in words', e && e.status === 422 && /book's buying power/.test(e.message), e && e.message);
    const f = await PA.flatten(env, fake);
    ok('flatten: cancel all, then close all with their orders; a close Alpaca refused is named', f.canceled === 2 && f.closing.join() === 'NVDA' && f.failed.join() === 'AMD' && calls.some(([m, p]) => m === 'DELETE' && p === '/v2/positions?cancel_orders=true'));
    const r = await PA.rawAccount(env, fake);
    ok('rawAccount: the broker\'s own numbers', r.equity === 100000 && r.booked === undefined);
  }

  console.log('\nWebull: the same, and its flatten (one cancel per order, a logged market close per position)');
  {
    BK.clearBooks(); WB.clearCache();
    const env = { DB: realD1(), WEBULL_PAPER_KEY: 'K', WEBULL_PAPER_SECRET: 'S' };
    const ACCTS = [{ account_id: 'MRG1', account_label: 'Individual Margin', account_class: 'INDIVIDUAL_MARGIN' }];
    const BAL = { total_net_liquidation_value: '1000000.00', total_market_value: '5000.00', total_cash_balance: '995000.00', total_day_profit_loss: '0', account_currency_assets: [{ buying_power: '2000000', day_buying_power: '4000000' }] };
    const calls = []; let placeOk = true;
    const OPEN = [{ client_order_id: 'o1', combo_type: 'NORMAL', orders: [{ symbol: 'AAPL', side: 'BUY', status: 'SUBMITTED', client_order_id: 'o1', order_type: 'LIMIT', total_quantity: '1', filled_quantity: '0', time_in_force: 'GTC', limit_price: '50' }] }];
    const fake = async (u, init = {}) => {
      const url = new URL(u); calls.push([init.method, url.pathname, init.body ? JSON.parse(init.body) : null]);
      const R = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
      if (url.host !== 'api.sandbox.webull.com') return R({ message: 'wrong host' }, 500);
      if (url.pathname === '/openapi/account/list') return R(ACCTS);
      if (url.pathname === '/openapi/assets/balance') return R(BAL);
      if (url.pathname === '/openapi/assets/positions') return R([{ symbol: 'MSFT', quantity: '10', last_price: '500', cost_price: '480' }, { symbol: 'TSLA', quantity: '-2', last_price: '300' }]);
      if (url.pathname === '/trading/orders/open-orders/list') return R({ data: OPEN });
      if (url.pathname === '/trading/orders/cancel') return R({ client_order_id: 'o1' });
      if (url.pathname === '/trading/orders/place') return placeOk ? R({ order_id: 'P' }) : R({ message: 'market closed' }, 417);
      return R({ message: 'no route' }, 404);
    };
    const U = new URL('https://quant-api.test/trade/webull/x');
    const a = await body(await WB.account(env, U, fake, { capital: 50000, baseline: 1000000, bp_cap: null }));
    ok('/account with a book: $50,000 shown, buying power scaled (2,000,000 × 0.05)', a.account.equity === 50000 && a.account.buying_power === 100000 && a.book.capital === 50000);
    const e = await throwsOf(() => WB.place(env, req({ order: { symbol: 'AAPL', side: 'buy', type: 'limit', limit_price: 100, qty: 200, time_in_force: 'gtc' }, who: 'tony' }), U, { fetchFn: fake, priceOf: async () => 100, book: { capital: 50000, baseline: 1000000, bp_cap: 15000 } }));
    ok('a Webull order over the book is refused before anything is sent', e && e.status === 422 && !calls.some(([, p]) => p === '/trading/orders/place'), e && e.message);
    WB.clearCache(); calls.length = 0;
    const f = await WB.flatten(env, U, { fetchFn: fake, now: 7 });
    const placed = calls.filter(([, p]) => p === '/trading/orders/place').map(([, , b]) => b);
    ok('flatten: the open order cancelled; MSFT sold 10 and TSLA bought back 2 at market', f.canceled === 1 && f.closing.join() === 'MSFT,TSLA' && placed.length === 2 && JSON.stringify(placed).includes('SELL') && JSON.stringify(placed).includes('BUY'), JSON.stringify(placed).slice(0, 300));
    const logged = env.DB.sql.prepare("SELECT reason, who, broker FROM paper_orders WHERE reason = 'book reset'").all();
    ok('...each close logged before it went, as yours, under Webull', logged.length === 2 && logged.every((r) => r.who === 'tony' && r.broker === 'webull'));
    WB.clearCache(); placeOk = false;
    const f2 = await WB.flatten(env, U, { fetchFn: fake, now: 8 });
    ok('...a close the sandbox refuses (market closed) is reported, not hidden', f2.failed.join() === 'MSFT,TSLA' && f2.closing.length === 0);
    const r = await WB.rawAccount(env, U, fake);
    ok('rawAccount: the broker\'s own $1,000,000', r.equity === 1000000);
  }

  console.log('\nThe worker wires it');
  {
    const src = fs.readFileSync(path.join(WDIR, 'worker.js'), 'utf8');
    ok('/trade/:broker/book and /book/reset route to lib/books.js, each broker with its own flatten', /bookRoute\(env, req, mm\[1\]/.test(src) && /paper\.flatten\(env\)/.test(src) && /webull\.flatten\(env, url\)/.test(src));
    ok('every account read, order and change passes the broker\'s book', (src.match(/readBook\(env, 'alpaca'\)/g) || []).length === 3 && (src.match(/readBook\(env, 'webull'\)/g) || []).length === 3);
    ok('the book route is before the alias to /paper (so /trade/alpaca/book is not a /paper 404)', src.indexOf('bookRoute(env, req, mm[1]') < src.indexOf("if (mm[1] === 'alpaca') return paperRoute"));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
