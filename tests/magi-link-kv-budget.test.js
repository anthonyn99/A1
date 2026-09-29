/* magi-link must not let one engine spend account 2's KV budget.

   WHY THIS FILE EXISTS
   On 2026-09-28 Veda's engine replaced its (healthy) tunnel every 5 minutes,
   around the clock: each cycle a DELETE (withdraw) and a PUT (publish), 275 of
   each that day -- half of account 2's 1,000/day KV write cap, which
   index-backups, weather, ProView and TradeHub share. The worker answered every
   one of them correctly, so nothing looked wrong until Cloudflare's 50% email.

   Two properties, both invisible when they regress:
     - PUTs past MAX_PUTS_PER_HOUR per token are refused BEFORE touching KV
       (counted in the Cache API, which costs no quota);
     - a DELETE with nothing to delete is a read, not a delete.

   Run: node tests/magi-link-kv-budget.test.js */
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0; const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}

function fakeKV() {
  const m = new Map(); const ops = { get: 0, put: 0, delete: 0 };
  return {
    ops,
    async get(k) { ops.get++; return m.has(k) ? m.get(k) : null; },
    async put(k, v) { ops.put++; m.set(k, v); },
    async delete(k) { ops.delete++; m.delete(k); },
  };
}

function fakeCache() {
  const m = new Map();
  return {
    async match(u) { return m.has(u) ? new Response(m.get(u)) : undefined; },
    async put(u, r) { m.set(u, await r.text()); },
  };
}

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'workers2', 'magi-link', 'worker.js')).href);
  const worker = mod.default;
  globalThis.caches = { default: fakeCache() };
  const env = { MAGI_LINK: fakeKV() };
  const req = (method, body) => new Request('https://magi-link.av1-2.workers.dev/link', {
    method, headers: { 'x-magi-token': 'tok', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  // withdraw with nothing published: no delete spent
  let r = await worker.fetch(req('DELETE'), env);
  t('DELETE of an absent record answers ok', r.status === 200);
  t('...and spends no KV delete', env.MAGI_LINK.ops.delete === 0, 'deletes=' + env.MAGI_LINK.ops.delete);

  // a churning engine: 30 publishes in one hour
  const statuses = [];
  for (let i = 0; i < 30; i++) {
    const res = await worker.fetch(req('PUT', { url: `https://t${i}.trycloudflare.com` }), env);
    statuses.push(res.status);
  }
  t('the first MAX_PUTS_PER_HOUR publishes succeed',
    statuses.slice(0, mod.MAX_PUTS_PER_HOUR).every(s => s === 200), statuses.join(','));
  t('the rest are refused with 429',
    statuses.slice(mod.MAX_PUTS_PER_HOUR).every(s => s === 429));
  t('KV writes are capped at MAX_PUTS_PER_HOUR', env.MAGI_LINK.ops.put === mod.MAX_PUTS_PER_HOUR,
    'puts=' + env.MAGI_LINK.ops.put);
  t('the cap is well under what churn cost (12/hour)', mod.MAX_PUTS_PER_HOUR < 12);

  // a record that exists is still withdrawn
  r = await worker.fetch(req('DELETE'), env);
  t('DELETE of a live record deletes it', env.MAGI_LINK.ops.delete === 1);

  // next hour: the budget resets
  const hour = 3600000 * 1000;
  t('a new hour has a fresh budget', (await mod.overBudget('k', hour, globalThis.caches.default)) === false);
  // a cache that throws never blocks a publish
  const broken = { match() { throw new Error('x'); }, put() { throw new Error('x'); } };
  t('a failing cache fails open', (await mod.overBudget('k', Date.now(), broken)) === false);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
})();
