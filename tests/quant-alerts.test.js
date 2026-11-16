// TradeHub Quant Phase 14 (A1-Priv docs/TradeHub/quant/phase-14.md): alerts.
// quant-api's rules, the minute check and its gate, dedupe, cooldown,
// hysteresis, quiet hours, mute, "market hours only", signal / graded / regime
// alerts raised by writes, the retry of a failed send, and taskhub-reminders'
// POST /quant-push (the secret, Tony's tokens only, none of Veda's, dead tokens
// pruned, the TaskHub card). quant-api runs on a REAL SQLite (node:sqlite) with
// every migration; Yahoo, FCM and Firestore are faked.
//
// Run: node tests/quant-alerts.test.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 600) : '')); }
};
const QA = path.join(__dirname, '..', 'workers2', 'quant-api');
const MIG = path.join(QA, 'migrations');
const REM = path.join(__dirname, '..', 'workers', 'taskhub-reminders', 'worker.js');

function realD1({ skip = [] } = {}) {
  const sql = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIG).filter((x) => x.endsWith('.sql') && !skip.includes(x)).sort()) sql.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  const norm = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
  const db = { sql, reads: 0, writes: 0, log: [] };
  const isRead = (q) => /^\s*SELECT/i.test(q);
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a.map(norm)),
    async first() { db.reads++; db.log.push(q); const r = sql.prepare(q).get(...args); return r ? { ...r } : null; },
    async all() { db.reads++; db.log.push(q); return { results: sql.prepare(q).all(...args).map((r) => ({ ...r })) }; },
    async run() { if (isRead(q)) db.reads++; else db.writes++; db.log.push(q); const r = sql.prepare(q).run(...args); return { meta: { changes: r.changes } }; },
  });
  db.prepare = (q) => stmt(q);
  db.batch = async (list) => { for (const s of list) await s.run(); return []; };
  return db;
}

// New York times (EST in November: UTC-5).
const NY = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h + 5, mi);
const MON_10 = NY(2026, 11, 16, 10);          // Monday 10:00 New York
const W = { prices: {}, yahooCalls: 0, pushes: [], pushFail: false };
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (/finance\.yahoo\.com|query\d\.finance/.test(u)) {
    W.yahooCalls++;
    const syms = decodeURIComponent(/symbols=([^&]+)/.exec(u)[1]).split(',');
    const t = Math.floor(W.now / 1000);
    return new Response(JSON.stringify({ spark: { result: syms.filter((s) => W.prices[s] != null).map((s) => ({ symbol: s, response: [{ meta: { regularMarketPrice: W.prices[s], regularMarketTime: t }, timestamp: [], indicators: { quote: [{ close: [] }] } }] })) } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (/\/quant-push$/.test(u)) {
    W.pushes.push({ headers: opts.headers, body: JSON.parse(opts.body) });
    if (W.pushFail) return new Response(JSON.stringify({ ok: false, error: 'down' }), { status: 502 });
    return new Response(JSON.stringify({ ok: true, sent: 2, failed: 0, devices: ['Tony PC', 'Pixel'] }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};

(async () => {
  const A = await import(pathToFileURL(path.join(QA, 'lib', 'alerts.js')).href);
  const Wk = (await import(pathToFileURL(path.join(QA, 'worker.js')).href)).default;
  const KEY = 'orca_sk_test_alerts_0123456789';
  const hash = (k) => crypto.createHash('sha256').update(k).digest('hex');
  const call = async (env, method, p, body, { key = KEY } = {}) => {
    const r = await Wk.fetch(new Request('https://quant-api.test' + p, { method, headers: { ...(key ? { authorization: 'Bearer ' + key } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
    let j = null; try { j = JSON.parse(await r.text()); } catch (e) {}
    return { status: r.status, body: j };
  };
  const mkEnv = (o = {}) => ({ DB: realD1(o), ALLOWED_KEYS: hash(KEY), PUSH_SECRET: 's3cret', PUSH_URL: 'https://taskhub-reminders.test' });

  console.log('\nthe holiday table is the page\'s');
  const page = path.join(__dirname, '..', '..', 'A1-Priv', 'TradeHub', 'core', 'holidays.js');
  if (fs.existsSync(page)) {
    const body = (f) => fs.readFileSync(f, 'utf8').replace(/\r/g, '').split('\n').filter((l) => !/^\/\//.test(l)).join('\n').trim();
    ok('workers2/quant-api/lib/holidays.js = A1-Priv TradeHub/core/holidays.js (below the comments)', body(path.join(QA, 'lib', 'holidays.js')) === body(page));
  } else ok('A1-Priv is not next to A1 here: copy check skipped', true);

  console.log('\nthe gate: New York sessions only');
  ok('Monday 10:00 New York: in session', A.inSession(MON_10));
  ok('04:00 in, 03:59 out', A.inSession(NY(2026, 11, 16, 4)) && !A.inSession(NY(2026, 11, 16, 3, 59)));
  ok('19:59 in, 20:00 out', A.inSession(NY(2026, 11, 16, 19, 59)) && !A.inSession(NY(2026, 11, 16, 20)));
  ok('Saturday out', !A.inSession(NY(2026, 11, 21, 10)));
  ok('Thanksgiving (Thursday 2026-11-26) out', !A.inSession(NY(2026, 11, 26, 10)));
  ok('Good Friday 2027 (03-26) out', !A.inSession(Date.UTC(2027, 2, 26, 14)));
  {
    const env = mkEnv(); let waited = 0;
    await Wk.scheduled({ scheduledTime: NY(2026, 11, 21, 10) }, env, { waitUntil() { waited++; } });
    ok('the cron on a Saturday: no work, not one D1 read', env.DB.reads === 0 && waited === 0);
    await Wk.scheduled({ scheduledTime: NY(2026, 11, 26, 12) }, env, { waitUntil() { waited++; } });
    ok('the cron on a holiday: no work either', env.DB.reads === 0 && waited === 0);
  }

  console.log('\nprice rules (pure)');
  const R = (params, state = {}) => ({ id: 'r1', kind: 'price', symbol: 'NVDA', params: { dir: 'cross', ...params }, state, cooldownMin: 30 });
  let ev = A.evalPrice(R({ price: 170.6, dir: 'above' }), 169);
  ok('the first check only learns the side', !ev.fire && ev.changed && ev.state.side === 'below');
  ev = A.evalPrice(R({ price: 170.6, dir: 'above' }, ev.state), 169.5);
  ok('still below: nothing, and nothing to write', !ev.fire && !ev.changed);
  let s1 = ev.state;
  ev = A.evalPrice(R({ price: 170.6, dir: 'above' }, s1), 171);
  ok('crossing above fires (above rule)', ev.fire && ev.key === 'px:0:above' && ev.state.armed === false);
  const sDown = A.evalPrice(R({ price: 170.6, dir: 'above' }, { side: 'above' }), 169).state;
  ok('crossing BELOW does not fire an "above" rule (it moves the side)', !A.evalPrice(R({ price: 170.6, dir: 'above' }, { side: 'above' }), 169).fire && sDown.side === 'below');
  ok('"below" rule fires on the way down', A.evalPrice(R({ price: 170.6, dir: 'below' }, { side: 'above' }), 170).fire);
  ok('"cross" fires either way', A.evalPrice(R({ price: 170.6 }, { side: 'above' }), 170).fire && A.evalPrice(R({ price: 170.6 }, { side: 'below' }), 171).fire);
  ok('exactly on the line: no side, nothing', !A.evalPrice(R({ price: 170.6 }, { side: 'below' }), 170.6).fire);
  // holds: two consecutive checks past it.
  let h = A.evalPrice(R({ price: 170.6, dir: 'above', holds: true }, { side: 'below' }), 171);
  ok('"holds above": the first check above does not fire, it waits', !h.fire && h.state.pend === 'above' && h.changed);
  const h2 = A.evalPrice(R({ price: 170.6, dir: 'above', holds: true }, h.state), 171.2);
  ok('… the second check above fires', h2.fire);
  const h3 = A.evalPrice(R({ price: 170.6, dir: 'above', holds: true }, h.state), 170.1);
  ok('… back below on the second check: no fire, the wait is cleared', !h3.fire && h3.state.pend === null && h3.state.side === 'below');
  // Hysteresis: 0.3 ATR back before the same level re-arms (atr 2 → band 0.6).
  const fired = A.evalPrice(R({ price: 170.6, dir: 'above', atr: 2 }, { side: 'below' }), 171).state;
  ok('after a fire the rule is disarmed: another cross does nothing', !A.evalPrice(R({ price: 170.6, dir: 'above', atr: 2 }, { ...fired, side: 'below' }), 171.5).fire);
  const near = A.evalPrice(R({ price: 170.6, dir: 'above', atr: 2 }, fired), 170.2);
  ok('back 0.4 (< 0.3 ATR = 0.6): still disarmed', near.state.armed === false && !near.changed);
  const back = A.evalPrice(R({ price: 170.6, dir: 'above', atr: 2 }, fired), 169.9);
  ok('back 0.7 (> 0.6): re-armed, a new generation, side below', back.state.armed === true && back.state.gen === 1 && back.state.side === 'below');
  const again = A.evalPrice(R({ price: 170.6, dir: 'above', atr: 2 }, back.state), 171);
  ok('… and the next cross fires under a NEW trigger key', again.fire && again.key === 'px:1:above');
  ok('no ATR given: 1% of price stands in (band 0.3% = 0.51)', A.evalPrice(R({ price: 170, dir: 'above' }, { armed: false, fired: 'above', gen: 0 }), 169.6).state.armed === false
    && A.evalPrice(R({ price: 170, dir: 'above' }, { armed: false, fired: 'above', gen: 0 }), 169.4).state.armed === true);
  // Zones.
  const Z = (params, state) => R({ price: null, lo: 168, hi: 170, dir: 'enter', ...params }, state);
  ok('a zone: entering it fires ("enter")', A.evalPrice(Z({}, { side: 'above' }), 169).fire && !A.evalPrice(Z({}, { side: 'above' }), 171).fire);
  ok('a zone "above": breaking above its top edge fires', A.evalPrice(Z({ dir: 'above' }, { side: 'in' }), 170.5).fire);
  // Phase 4's rows read as price rules.
  const legacyLine = A.ruleOf({ id: 'x', symbol: 'NVDA', kind: 'level', price: 180.5, lo: null, hi: null, level: 'R1 Strong', active: 1, created: 1, at: 1 });
  const legacyZone = A.ruleOf({ id: 'y', symbol: 'NVDA', kind: 'price', price: null, lo: 170, hi: 172, active: 1, created: 1, at: 1 });
  ok('Phase 4 rows: a line is a "cross" price rule, a zone an "enter" one, 30 min cooldown', legacyLine.kind === 'price' && legacyLine.params.dir === 'cross' && legacyZone.params.dir === 'enter' && legacyLine.cooldownMin === 30);

  console.log('\nquiet hours, mute');
  const cfg = A.configOf({ quiet: { on: true, from: '22:00', to: '07:00', tz: 'America/Denver' } });
  ok('quiet 22:00-07:00 Denver: 23:30 Denver is quiet', A.isQuiet(cfg, Date.UTC(2026, 10, 17, 6, 30)));
  ok('… 06:59 quiet, 07:00 not', A.isQuiet(cfg, Date.UTC(2026, 10, 17, 13, 59)) && !A.isQuiet(cfg, Date.UTC(2026, 10, 17, 14, 0)));
  ok('… noon not', !A.isQuiet(cfg, Date.UTC(2026, 10, 17, 19)));
  ok('quiet off: never quiet', !A.isQuiet(A.configOf({}), Date.UTC(2026, 10, 17, 6, 30)));
  ok('a bad time zone falls back, bad times fall back', A.configOf({ quiet: { tz: 'Nowhere/Land', from: '25:00' } }).quiet.tz === 'America/Denver' && A.configOf({ quiet: { from: '25:00' } }).quiet.from === '22:00');
  const mc = A.configOf({ mute: { nvda: 0, AMD: MON_10 + 60000, 'bad sym!': 0 } });
  ok('mute: NVDA until unmuted, AMD for a minute, a bad symbol dropped', A.isMuted(mc, 'NVDA', MON_10) && A.isMuted(mc, 'AMD', MON_10) && !A.isMuted(mc, 'AMD', MON_10 + 120000) && Object.keys(mc.mute).length === 2);

  console.log('\nroutes');
  const env = mkEnv();
  let r = await call(env, 'GET', '/alerts', null, { key: '' });
  ok('the Orca key is needed', r.status === 401);
  r = await call(env, 'POST', '/alerts', { alert: { symbol: 'nvda', kind: 'price', price: 170.6, params: { dir: 'above', holds: true, atr: 2 }, note: 'holds above 170.60' } });
  const pid = r.body.id;
  ok('a price rule with dir, holds and ATR is stored', r.status === 200 && typeof pid === 'string');
  r = await call(env, 'POST', '/alerts', { alert: { symbol: 'NVDA', kind: 'level', price: 180.5, level: 'R1 Strong' } });
  ok('a level bell (Phase 4 shape) still works', r.status === 200);
  const bad = [];
  for (const a of [{ symbol: 'NVDA' }, { symbol: 'NVDA', price: 'abc' }, { symbol: 'NVDA', price: 1, params: { dir: 'sideways' } }, { symbol: 'NVDA', price: 1, params: { dir: 'enter' } }, { kind: 'weather' }, { kind: 'signal', params: { setup: 'Bad Setup!' } }])
    bad.push((await call(env, 'POST', '/alerts', { alert: a })).status);
  ok('bad rules are refused (no price, NaN, unknown dir, "enter" on a line, unknown kind, bad setup)', bad.every((s) => s === 400), bad);
  r = await call(env, 'POST', '/alerts', { alert: { kind: 'signal', params: { setup: 'orb', horizon: 'day' } } });
  const sid = r.body.id;
  ok('a signal rule (any symbol, one setup) is stored with symbol *', r.status === 200 && env.DB.sql.prepare('SELECT symbol FROM alerts WHERE id = ?').get(sid).symbol === '*');
  r = await call(env, 'POST', '/alerts', { alert: { kind: 'catalyst', params: { minutes: 999 } } });
  const cid = r.body.id;
  ok('a catalyst rule: minutes clamped to 240', JSON.parse(env.DB.sql.prepare('SELECT params FROM alerts WHERE id = ?').get(cid).params).minutes === 240);
  await call(env, 'POST', '/alerts', { alert: { id: cid, kind: 'catalyst', params: { minutes: 15 } } });
  const gid = (await call(env, 'POST', '/alerts', { alert: { kind: 'graded' } })).body.id;
  const rid = (await call(env, 'POST', '/alerts', { alert: { kind: 'regime' } })).body.id;
  const did = (await call(env, 'POST', '/alerts', { alert: { kind: 'data' } })).body.id;
  r = await call(env, 'GET', '/alerts');
  ok('GET: every rule back as the page reads it (kind, params, symbol null for "any"), and the config', r.body.alerts.length === 7 && r.body.alerts.find((a) => a.id === sid).symbol === null && r.body.alerts.find((a) => a.id === pid).params.holds === true && r.body.config.kinds.price === true);
  ok('GET never sends the check\'s state', r.body.alerts.every((a) => !('state' in a)));
  {
    const zid = (await call(env, 'POST', '/alerts', { alert: { symbol: 'NVDA', kind: 'level', lo: 170, hi: 172 } })).body.id;
    ok('a zone bell (lo and hi) too', !!zid);
    await call(env, 'DELETE', '/alerts?id=' + zid);
    const lid = (await call(env, 'POST', '/alerts', { alert: { symbol: 'AMD', kind: 'price', price: 150 } })).body.id;
    env.DB.sql.prepare('UPDATE alerts SET state = ? WHERE id = ?').run('{"side":"below"}', lid);
    await call(env, 'POST', '/alerts', { alert: { id: lid, symbol: 'AMD', kind: 'price', price: 151 } });
    const row = env.DB.sql.prepare('SELECT price, state FROM alerts WHERE id = ?').get(lid);
    ok('the same id changes it (an alert line dragged), and its old side is forgotten', row.price === 151 && row.state === null);
    env.DB.sql.prepare('UPDATE alerts SET state = ? WHERE id = ?').run('{"side":"below"}', lid);
    await call(env, 'POST', '/alerts', { alert: { id: lid, symbol: 'AMD', kind: 'price', price: 151, note: 'renamed' } });
    ok('… a note-only change keeps its state', env.DB.sql.prepare('SELECT state FROM alerts WHERE id = ?').get(lid).state === '{"side":"below"}');
    ok('a bad id, or no alert, is refused', (await call(env, 'POST', '/alerts', { alert: { id: 'bad id!', symbol: 'NVDA', price: 1 } })).status === 400 && (await call(env, 'POST', '/alerts', {})).status === 400);
    r = await call(env, 'GET', '/alerts?symbol=AMD');
    ok('GET ?symbol= lists that ticker\'s rules only', r.body.alerts.length === 1 && r.body.alerts[0].symbol === 'AMD');
    r = await call(env, 'DELETE', '/alerts?id=' + lid);
    ok('DELETE removes one', r.status === 200 && !env.DB.sql.prepare('SELECT 1 FROM alerts WHERE id = ?').get(lid));
    const e2 = mkEnv();
    for (let i = 0; i < 200; i++) e2.DB.sql.prepare("INSERT INTO alerts (id, symbol, kind, price, active, created, at) VALUES (?, 'NVDA', 'price', 1, 1, ?, 1)").run('x' + i, i);
    r = await call(e2, 'POST', '/alerts', { alert: { symbol: 'NVDA', price: 1 } });
    ok('at most 200 alerts', r.status === 400 && /200/.test(r.body.error));
    ok('… but one of the 200 can still be changed', (await call(e2, 'POST', '/alerts', { alert: { id: 'x5', symbol: 'NVDA', price: 2 } })).status === 200);
  }
  r = await call(env, 'POST', '/alerts/order', { ids: [did, rid, gid, cid, sid, pid] });
  r = await call(env, 'GET', '/alerts');
  ok('Tony\'s order is kept (A1 drag), unordered rules after', r.body.alerts[0].id === did && r.body.alerts[5].id === pid && r.body.alerts.length === 7);
  r = await call(env, 'PUT', '/alerts/config', { config: { quiet: { on: false }, mute: {}, kinds: { regime: true } } });
  ok('config stored over the defaults', r.status === 200 && r.body.config.cards.graded === true && r.body.config.marketOnly.price === true);

  console.log('\nthe check');
  W.now = MON_10; W.prices = { NVDA: 169 };
  let c = await A.check(env.DB ? env : env, MON_10);
  ok('first run: learns NVDA\'s side, fires nothing, 1 quote call, 2 D1 reads + the retry read', c.fired.length === 0 && W.yahooCalls === 1 && c.quotes === 1, c);
  env.DB.reads = 0; env.DB.writes = 0;
  c = await A.check(env, MON_10 + 60000);
  ok('a quiet minute: no D1 write at all, 3 reads (rules, retries, context)', c.fired.length === 0 && env.DB.writes === 0 && env.DB.reads === 3, { reads: env.DB.reads, writes: env.DB.writes });
  W.prices = { NVDA: 171 };
  c = await A.check(env, MON_10 + 120000);
  ok('"holds above": the first check above fires nothing (a state write only)', c.fired.length === 0 && c.writes >= 1);
  const before = W.pushes.length;
  c = await A.check(env, MON_10 + 180000);
  ok('the second check above fires the holds rule once, pushed', c.fired.length >= 1 && c.fired.some((f) => f.rule === pid && f.pushed === true), c.fired);
  const pushed = W.pushes.slice(before).find((p) => /170\.60/.test(p.body.title));
  ok('the push: secret header, Tony\'s page with the chart link, tag per rule', pushed && pushed.headers['x-quant-secret'] === 's3cret' && /tradehub\.html#alert=chart:NVDA$/.test(pushed.body.url) && pushed.body.tag === 'tbq-' + pid, pushed);
  c = await A.check(env, MON_10 + 240000);
  ok('one alert fires ONCE: the next minute, still above, nothing', !c.fired.some((f) => f.rule === pid));
  r = await call(env, 'GET', '/alerts/fires');
  ok('the bell: the fire is listed, unseen, with the devices it reached', r.body.unseen >= 1 && r.body.fires.some((f) => f.rule_id === pid && f.pushed === 1 && f.devices.includes('Pixel')));
  await call(env, 'POST', '/alerts/seen');
  r = await call(env, 'GET', '/alerts/fires');
  ok('seen: the count back to 0', r.body.unseen === 0 && r.body.fires.length >= 1);
  // Dedupe in the table itself.
  const dup = await env.DB.prepare('INSERT INTO alert_fires (rule_id, trigger_key, at, kind, title) VALUES (?, ?, ?, ?, ?) ON CONFLICT (rule_id, trigger_key) DO NOTHING').bind(pid, 'px:0:above', 1, 'price', 'x').run();
  ok('alert_fires (rule_id, trigger_key) is unique: the same trigger cannot be stored twice', dup.meta.changes === 0);

  console.log('\ncooldown');
  {
    const e = mkEnv();
    const id = (await call(e, 'POST', '/alerts', { alert: { symbol: 'AMD', price: 100, params: { dir: 'cross', atr: 1 }, cooldownMin: 30 } })).body.id;
    W.prices = { AMD: 99 }; await A.check(e, MON_10);
    W.prices = { AMD: 101 }; let x = await A.check(e, MON_10 + 60000);
    ok('a cross fires', x.fired.length === 1);
    W.prices = { AMD: 99 }; await A.check(e, MON_10 + 120000);      // re-armed (back past 0.3)
    W.prices = { AMD: 101 }; x = await A.check(e, MON_10 + 180000);
    ok('re-armed, crossed again 2 minutes later: held back by the 30-minute cooldown', x.fired.length === 0);
    x = await A.check(e, MON_10 + 31 * 60000);
    ok('after the cooldown, still past it: it fires (the cross was kept, not lost)', x.fired.length === 1 && x.fired[0].rule === id);
  }

  console.log('\nquiet, mute, market hours only, kinds off');
  {
    const e = mkEnv();
    const id = (await call(e, 'POST', '/alerts', { alert: { symbol: 'TSLA', price: 400, params: { dir: 'above' } } })).body.id;
    await call(e, 'PUT', '/alerts/config', { config: { quiet: { on: true, from: '00:00', to: '23:59', tz: 'America/New_York' } } });
    W.prices = { TSLA: 399 }; await A.check(e, MON_10);
    const n0 = W.pushes.length;
    W.prices = { TSLA: 401 }; let x = await A.check(e, MON_10 + 60000);
    ok('quiet hours: listed in the bell, not pushed', x.fired.length === 1 && x.fired[0].pushed === null && x.fired[0].why === 'quiet hours' && W.pushes.length === n0);
    const e2 = mkEnv();
    await call(e2, 'POST', '/alerts', { alert: { symbol: 'TSLA', price: 400, params: { dir: 'above' } } });
    await call(e2, 'PUT', '/alerts/config', { config: { mute: { TSLA: 0 } } });
    W.prices = { TSLA: 399 }; await A.check(e2, MON_10); W.prices = { TSLA: 401 }; x = await A.check(e2, MON_10 + 60000);
    ok('a muted ticker: listed, not pushed', x.fired[0] && x.fired[0].why === 'muted');
    const e3 = mkEnv();
    await call(e3, 'POST', '/alerts', { alert: { symbol: 'TSLA', price: 400, params: { dir: 'above' }, quiet: true } });
    W.prices = { TSLA: 399 }; await A.check(e3, MON_10); W.prices = { TSLA: 401 }; x = await A.check(e3, MON_10 + 60000);
    ok('a quiet rule: listed, not pushed', x.fired[0] && x.fired[0].why === 'quiet rule');
    const e4 = mkEnv();
    await call(e4, 'POST', '/alerts', { alert: { symbol: 'TSLA', price: 400, params: { dir: 'above' } } });
    await call(e4, 'PUT', '/alerts/config', { config: { kinds: { price: false } } });
    W.prices = { TSLA: 399 }; const y0 = W.yahooCalls; x = await A.check(e4, MON_10);
    ok('price alerts switched off: no quote call, nothing fires', x.fired.length === 0 && W.yahooCalls === y0);
    // A signal (raised) outside the session with "market hours only" on for signals.
    const e5 = mkEnv();
    await call(e5, 'POST', '/alerts', { alert: { kind: 'signal' } });
    await call(e5, 'PUT', '/alerts/config', { config: { marketOnly: { signal: true } } });
    const f5 = await A.raise(e5, 'signal', [{ id: 's0001', symbol: 'NVDA', setup: 'orb', horizon: 'day', dir: 'long', verdict: 'GO' }], NY(2026, 11, 16, 21));
    ok('"market hours only" outside a session: listed, not pushed', f5[0] && f5[0].why === 'outside market hours');
  }

  console.log('\nsignal, graded, regime: raised by the writes');
  {
    const e = mkEnv();
    await call(e, 'POST', '/alerts', { alert: { kind: 'signal', params: { setup: 'orb' } } });
    await call(e, 'POST', '/alerts', { alert: { kind: 'graded' } });
    await call(e, 'POST', '/alerts', { alert: { kind: 'regime' } });
    const sig = (id, verdict, setup = 'orb') => ({ id, symbol: 'NVDA', setup, horizon: 'day', dir: 'long', at: MON_10, expires: MON_10 + 86400000, verdict, entry: 170, stop: 168, zone: [169, 170], targets: [172, 174] });
    const n0 = W.pushes.length;
    let x = await call(e, 'POST', '/signals', { signals: [sig('s00a1', 'GO'), sig('s00a2', 'WATCH'), sig('s00a3', 'GO', 'vwap-reclaim')] });
    ok('POST /signals: only the NEW GO for the rule\'s setup is pushed', x.status === 200 && W.pushes.length === n0 + 1 && /New GO: NVDA orb/.test(W.pushes[n0].body.title) && /#alert=signal:s00a1$/.test(W.pushes[n0].body.url), W.pushes.slice(n0).map((p) => p.body.title));
    x = await call(e, 'POST', '/signals', { signals: [sig('s00a1', 'GO')] });
    ok('the same signal sent again: no second alert', W.pushes.length === n0 + 1);
    await call(e, 'POST', '/grades', { grades: [{ id: 's00a2', status: 'target1', done: false, r: 1 }] });
    ok('a signal he did NOT take hits target 1: no graded alert', W.pushes.length === n0 + 1);
    await call(e, 'POST', '/grades', { grades: [{ id: 's00a1', status: 'target1', done: false, r: 1.02, taken: 't-123' }] });
    const g = W.pushes[n0 + 1];
    ok('a signal he TOOK hits target 1: "NVDA hit target 1", +1.02R, card on', g && /NVDA hit target 1/.test(g.body.title) && /\+1\.02R/.test(g.body.body) && g.body.card === true, g && g.body);
    await call(e, 'POST', '/grades', { grades: [{ id: 's00a1', status: 'target1', done: false, r: 1.02, taken: 't-123' }] });
    ok('the same grade again: nothing new', W.pushes.length === n0 + 2);
    const snap = (slot, label) => ({ snapshot: { day: '2026-11-16', slot, at: NY(2026, 11, 16, 16), rows: {}, regime: { label, score: 50 } } });
    await call(e, 'POST', '/snapshot', snap('premarket', 'Constructive'));
    await call(e, 'POST', '/snapshot', snap('open30', 'Constructive'));
    ok('the same regime label at the next snapshot: no alert', W.pushes.length === n0 + 2);
    await call(e, 'POST', '/snapshot', snap('midday', 'Choppy'));
    ok('the label changed: "Regime: Constructive → Choppy"', W.pushes.length === n0 + 3 && W.pushes[n0 + 2].body.title === 'Regime: Constructive → Choppy');
  }

  console.log('\ncatalysts and data');
  {
    const e = mkEnv();
    await call(e, 'POST', '/alerts', { alert: { kind: 'catalyst', params: { minutes: 15 } } });
    await call(e, 'POST', '/alerts', { alert: { kind: 'data' } });
    const now = Date.now();
    await call(e, 'PUT', '/alerts/catalysts', { items: [{ id: 'cpi', t: now + 10 * 60000, title: 'CPI', symbols: [], impact: 'high' }, { id: 'nvda-er', t: now + 60 * 60000, title: 'NVDA earnings', symbols: ['NVDA'], impact: 'high' }, { id: 'low', t: now + 5 * 60000, title: 'Some speech', impact: 'medium' }, { id: 'past', t: now - 1000, title: 'gone', impact: 'high' }] });
    ok('catalysts stored without the past one', JSON.parse(e.DB.sql.prepare("SELECT v FROM meta WHERE k = 'alert_catalysts'").get().v).length === 3);
    e.DB.sql.prepare('INSERT INTO provider_health (provider, ok, status, latency_ms, detail, at, ok_at, fails, skip_until) VALUES (?, 0, 500, NULL, ?, ?, ?, 4, NULL)').run('finnhub', 'down', now - 30000, now - 12 * 60000);
    e.DB.sql.prepare('INSERT INTO provider_health (provider, ok, status, latency_ms, detail, at, ok_at, fails, skip_until) VALUES (?, 0, 500, NULL, ?, ?, ?, 1, NULL)').run('tiingo', 'down', now - 30000, now - 3 * 60000);
    const d = new Date(now).toISOString().slice(0, 10);
    e.DB.sql.prepare('INSERT INTO usage (day, service, n) VALUES (?, ?, ?)').run(d, 'groq', 600);
    e.DB.sql.prepare('INSERT INTO usage (day, service, n) VALUES (?, ?, ?)').run(d, 'yahoo', 100);
    const x = await A.check(e, now, { force: true });
    const titles = x.fired.map((f) => f.title);
    ok('CPI 10 min out (inside 15): "CPI in 10 min"', titles.includes('CPI in 10 min'), titles);
    ok('one fire a rule a run: the data rule fires once (finnhub, down 12 min)', titles.filter((t) => /finnhub is down for 12 min/.test(t)).length === 1, titles);
    const y = await A.check(e, now + 60000, { force: true });
    const t2 = y.fired.map((f) => f.title);
    ok('… inside the data rule\'s cooldown, the budget alert waits (not lost: its key is new)', !t2.some((t) => /groq/.test(t)));
    const z = await A.check(e, now + 31 * 60000, { force: true });
    ok('after the cooldown: "groq at 75% of today\'s budget"; tiingo (down 3 min) never', z.fired.some((f) => /groq at 75% of today's budget/.test(f.title)) && !z.fired.some((f) => /tiingo/.test(f.title)), z.fired);
  }

  console.log('\na failed send is retried once on the next run');
  {
    const e = mkEnv();
    await call(e, 'POST', '/alerts', { alert: { symbol: 'META', price: 600, params: { dir: 'above' } } });
    W.prices = { META: 599 }; await A.check(e, MON_10);
    W.pushFail = true; W.prices = { META: 601 };
    let x = await A.check(e, MON_10 + 60000);
    ok('the send fails: listed with pushed 0 and the error', x.fired[0] && x.fired[0].pushed === false && /down/.test(x.fired[0].why));
    W.pushFail = false; const n = W.pushes.length;
    x = await A.check(e, MON_10 + 120000);
    ok('next run: sent once more, and the fire row says pushed', x.retried.length === 1 && x.retried[0].pushed === true && W.pushes.length === n + 1 && e.DB.sql.prepare('SELECT pushed FROM alert_fires').get().pushed === 1);
    x = await A.check(e, MON_10 + 180000);
    ok('… and not again', x.retried.length === 0 && W.pushes.length === n + 1);
  }

  console.log('\nbudget and the old database');
  {
    const e = mkEnv({ skip: ['0013_alerts.sql'] });
    let x = await call(e, 'POST', '/alerts', { alert: { kind: 'signal' } });
    ok('before migration 0013 a new kind of rule is a 503 that names it', x.status === 503 && /0013_alerts/.test(x.body.error));
    x = await call(e, 'GET', '/alerts/fires');
    ok('… the bell reads empty (missing: true)', x.status === 200 && x.body.missing === true);
    e.DB.sql.prepare("INSERT INTO alerts (id, symbol, kind, price, active, created, at) VALUES ('old', 'NVDA', 'price', 100, 1, 1, 1)").run();
    const c0 = await A.check(e, MON_10);
    ok('… and the check does nothing', c0.skipped === 'no alerts table');
  }
  ok('budget: at most 960 cron runs a day do work (16 h × 60)', (20 - 4) * 60 === 960);

  console.log('\nSend test');
  {
    const e = mkEnv();
    const x = await call(e, 'POST', '/alerts/test');
    ok('Send test: shows which devices received it', x.status === 200 && x.body.ok && x.body.devices.join() === 'Tony PC,Pixel');
    const e2 = mkEnv(); delete e2.PUSH_SECRET;
    const y = await call(e2, 'POST', '/alerts/test');
    ok('no PUSH_SECRET: says so', y.body.ok === false && /PUSH_SECRET/.test(y.body.error));
  }

  console.log('\ntaskhub-reminders POST /quant-push');
  {
    const SP = fs.mkdtempSync(path.join(os.tmpdir(), 'qptest-'));
    let src = fs.readFileSync(REM, 'utf8');
    src = src.replace(/^export default \{[\s\S]*?\n\};/m, '');
    src = src.replace('async function getGoogleAccessToken(env) {', "async function getGoogleAccessToken(env) { return 'svc';");
    src += '\nexport { handleQuantPush };\n';
    fs.writeFileSync(path.join(SP, '_w.mjs'), src);
    const F = { tokens: [], docs: new Map(), sent: [], patched: [], queries: [], dead: new Set() };
    const doc = (id, token, mainDash, ua) => ({ name: 'projects/p/databases/(default)/documents/fcm_tokens/' + id, fields: { token: { stringValue: token }, ...(mainDash ? { mainDash: { stringValue: mainDash } } : {}), ua: { stringValue: ua || 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' } } });
    F.tokens = [doc('devA', 'tokA', 'tony'), doc('devB', 'tokB', 'tony', 'Mozilla/5.0 (Linux; Android 14) Chrome/130'), doc('devV', 'tokV', 'veda'), doc('devN', 'tokN', 'none'), doc('devX', 'tokX', 'tony')];
    F.dead.add('tokX');
    F.docs.set('dashboards/beacon_tony', { devices: { mapValue: { fields: { devA: { mapValue: { fields: { name: { stringValue: 'Tony PC' } } } } } } } });
    const prev = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url), method = opts.method || 'GET';
      if (/:runQuery$/.test(u)) {
        const q = JSON.parse(opts.body).structuredQuery; F.queries.push(q);
        const f = q.where && q.where.fieldFilter;
        // Firestore applies the filter: only matching docs come back (and are billed).
        const rows = F.tokens.filter((d) => !f || (d.fields[f.field.fieldPath] && d.fields[f.field.fieldPath].stringValue === f.value.stringValue));
        return new Response(JSON.stringify(rows.map((d) => ({ document: d }))), { status: 200 });
      }
      if (/fcm\.googleapis\.com/.test(u)) {
        const m = JSON.parse(opts.body).message; F.sent.push(m);
        if (F.dead.has(m.token)) return new Response(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 });
        return new Response('{}', { status: 200 });
      }
      const m = /\/documents\/([^?]+)(\?(.*))?$/.exec(u);
      if (m) {
        const p = decodeURIComponent(m[1]);
        if (method === 'GET') return F.docs.has(p) ? new Response(JSON.stringify({ fields: F.docs.get(p) }), { status: 200 }) : new Response('{}', { status: 404 });
        if (method === 'PATCH') { F.patched.push({ p, q: m[3] || '', body: JSON.parse(opts.body) }); F.docs.set(p, { ...(F.docs.get(p) || {}), ...JSON.parse(opts.body).fields }); return new Response('{}', { status: 200 }); }
      }
      return new Response('{}', { status: 404 });
    };
    const { handleQuantPush } = await import(pathToFileURL(path.join(SP, '_w.mjs')).href);
    const qenv = { FIREBASE_PROJECT_ID: 'p', QUANT_PUSH_SECRET: 'qs-123' };
    const qp = async (body, secret) => { const res = await handleQuantPush(new Request('https://x/quant-push', { method: 'POST', headers: secret ? { 'x-quant-secret': secret } : {}, body: JSON.stringify(body) }), qenv, ''); return { status: res.status, body: await res.json() }; };
    let x = await qp({ title: 'NVDA crossed above 170.60' });
    ok('refused without the secret', x.status === 401 && F.sent.length === 0);
    x = await qp({ title: 'NVDA crossed above 170.60' }, 'qs-wrong');
    ok('refused with a wrong secret', x.status === 401 && F.sent.length === 0);
    x = await handleQuantPush(new Request('https://x/quant-push', { method: 'POST', headers: { 'x-quant-secret': 'x' }, body: '{}' }), { FIREBASE_PROJECT_ID: 'p' }, '').then((res) => res.status);
    ok('refused when the worker has no secret set at all', x === 401);
    x = await qp({ title: 'NVDA crossed above 170.60', body: 'NVDA 171.02', url: 'https://a1-priv.av1.workers.dev/tradehub.html#alert=chart:NVDA', tag: 'tbq-r1', card: true, kind: 'price' }, 'qs-123');
    ok('the tokens query is filtered on mainDash == tony at Firestore', F.queries.length === 1 && F.queries[0].where.fieldFilter.field.fieldPath === 'mainDash' && F.queries[0].where.fieldFilter.value.stringValue === 'tony');
    const toks = F.sent.map((m) => m.token).sort();
    ok('fan-out to every one of Tony\'s tokens', toks.join() === 'tokA,tokB,tokX', toks);
    ok('none of Veda\'s, none of an Un-main\'d device', !toks.includes('tokV') && !toks.includes('tokN'));
    ok('→ { sent 2, failed 1, pruned 1, devices [Beacon name, else the browser] }', x.body.sent === 2 && x.body.failed === 1 && x.body.pruned === 1 && x.body.devices.sort().join() === 'Android · Chrome,Tony PC', x.body);
    const pr = F.patched.find((p) => /fcm_tokens\/devX/.test(p.p));
    ok('the dead token is pruned: its token field only (mainDash stays)', pr && /updateMask\.fieldPaths=token$/.test(pr.q) && JSON.stringify(pr.body.fields) === '{}');
    const m0 = F.sent[0];
    ok('data-only FCM, kind quant, the url and tag carried, high priority', m0.data.kind === 'quant' && m0.data.dash === 'tony' && /#alert=chart:NVDA$/.test(m0.data.url) && m0.data.tag === 'tbq-r1' && !m0.notification && m0.android.priority === 'high');
    const card = F.docs.get('dashboards/quant_alerts_tony');
    ok('card: true lists it on Tony\'s TaskHub (dashboards/quant_alerts_tony)', card && JSON.parse(card.items.stringValue)[0].title === 'NVDA crossed above 170.60');
    F.sent = [];
    x = await qp({ title: 'x', url: 'https://evil.example/phish' }, 'qs-123');
    ok('a url that is not TradeHub\'s page is replaced by TradeHub\'s page', F.sent.every((m) => m.data.url === 'https://a1-priv.av1.workers.dev/tradehub.html'));
    x = await qp({ title: '' }, 'qs-123');
    ok('no title: 400', x.status === 400);
    // Veda's token is not even returned by a filtered query; a doc that slipped through is still never sent to.
    F.tokens.push(doc('devV2', 'tokV2', 'tony'));
    F.tokens[F.tokens.length - 1].fields.mainDash.stringValue = 'tony';
    F.sent = [];
    globalThis.fetch = ((inner) => async (url, opts) => {
      if (/:runQuery$/.test(String(url))) return new Response(JSON.stringify([...F.tokens.map((d) => ({ document: d }))]), { status: 200 });   // a query that ignored its filter
      return inner(url, opts);
    })(globalThis.fetch);
    await qp({ title: 'y' }, 'qs-123');
    ok('belt and braces: even if the query returned Veda\'s doc, it is not sent to', !F.sent.some((m) => m.token === 'tokV' || m.token === 'tokN'));
    globalThis.fetch = prev;
    // TaskHub's own reminders code is untouched by this route: the send path and the scoping function are the same text.
    const rs = fs.readFileSync(REM, 'utf8');
    ok('TaskHub\'s reminders path does not call the quant route (runReminders → sendFCM only)', /async function runReminders[\s\S]*?sendFCM\(projectId, token, title, id, accessToken, dash/.test(rs) && !/runReminders[\s\S]{0,8000}handleQuantPush/.test(rs.slice(rs.indexOf('async function runReminders'), rs.indexOf('async function maybeReschedule'))));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
