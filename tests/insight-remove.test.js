// Insight's POST /items/remove (workers/insight-api/worker.js), driven through
// the real route with Plaid, Firestore and KV faked in memory.
//
// The case it exists for (2026-10-28): Discover moved to Capital One, so a
// second Capital One link carried the same cards (Savor, Quicksilver) as the
// July one but only a few weeks of history. Removing the old link must hand
// each shared card's OLDER transactions to the new link instead of deleting
// them, and still delete everything else that link wrote.
//
// Run: node tests/insight-remove.test.js
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 400) : '')); }
};

const ROOT = 'projects/p/databases/(default)/documents';
const DOCS = new Map();          // full doc name → plain fields
const put = (coll, id, f) => DOCS.set(`${ROOT}/dashboards/insight/${coll}/${id}`, f);
const sv = (v) => ({ stringValue: v });

// Old link OLD: Savor ••1508 + a card only it has. New link NEW: Savor ••1508, from Sep 7.
put('accounts', 'oSav', { item_id: 'OLD', account_id: 'oSav', name: 'Savor', mask: '1508' });
put('accounts', 'oSolo', { item_id: 'OLD', account_id: 'oSolo', name: 'Platinum', mask: '9999' });
put('accounts', 'nSav', { item_id: 'NEW', account_id: 'nSav', name: 'Savor', mask: '1508' });
put('accounts', 'other', { item_id: 'ALLY', account_id: 'other', name: 'Spending', mask: '9095' });
put('plaid_transactions', 't1', { item_id: 'OLD', account_id: 'oSav', date: '2026-04-28' });
put('plaid_transactions', 't2', { item_id: 'OLD', account_id: 'oSav', date: '2026-09-06' });
put('plaid_transactions', 't3', { item_id: 'OLD', account_id: 'oSav', date: '2026-09-07' });   // overlap: drop
put('plaid_transactions', 't4', { item_id: 'OLD', account_id: 'oSav', date: '2026-09-29' });   // overlap: drop
put('plaid_transactions', 't5', { item_id: 'OLD', account_id: 'oSolo', date: '2026-05-01' }); // no twin: drop
put('plaid_transactions', 'n1', { item_id: 'NEW', account_id: 'nSav', date: '2026-09-07' });
put('plaid_transactions', 'n2', { item_id: 'NEW', account_id: 'nSav', date: '2026-09-29' });
put('plaid_transactions', 'a1', { item_id: 'ALLY', account_id: 'other', date: '2026-01-01' });

const kv = (init) => {
  const m = new Map(Object.entries(init));
  return {
    m,
    async get(k, t) { const v = m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list() { return { keys: [...m.keys()].map(name => ({ name })), list_complete: true }; },
  };
};
const LOCK = { salt: 's', hash: 'h'.repeat(40) };
const INSIGHT_KV = kv({
  'plaid:item:OLD': JSON.stringify({ item_id: 'OLD', access_token: 'tok-old', institution_name: 'Capital One' }),
  'plaid:cursor:OLD': 'c',
  'plaid:item:NEW': JSON.stringify({ item_id: 'NEW', access_token: 'tok-new', institution_name: 'Capital One' }),
  'locktok:T': JSON.stringify({ v: LOCK.salt + ':' + LOCK.hash.slice(0, 24) }),
  'gat': JSON.stringify({ token: 'g', expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
});
const env = {
  INSIGHT_KV, AUTH_KV: kv({}), PLAID_ENV: 'production', PLAID_CLIENT_ID: 'c', PLAID_SECRET_PRODUCTION: 's',
  FIREBASE_PROJECT_ID: 'p', FIREBASE_CLIENT_EMAIL: 'e', FIREBASE_PRIVATE_KEY: 'k',
};
env.AUTH_KV.get = async () => LOCK;

const plaidCalls = [];
global.fetch = async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : {};
  const reply = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (/plaid\.com\/item\/remove$/.test(url)) { plaidCalls.push(body.access_token); return reply({}); }
  if (url.endsWith(':runQuery')) {
    const q = body.structuredQuery;
    const coll = q.from[0].collectionId;
    const f = q.where && q.where.fieldFilter;
    const rows = [...DOCS].filter(([n, d]) => n.includes(`/${coll}/`) && (!f || d[f.field.fieldPath] === f.value.stringValue));
    return reply(rows.map(([name, d]) => ({ document: { name, fields: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, sv(v)])) } })));
  }
  if (url.endsWith(':batchWrite')) {
    for (const w of body.writes) {
      if (w.delete) DOCS.delete(w.delete);
      else {
        const cur = DOCS.get(w.update.name) || {};
        for (const k of w.updateMask ? w.updateMask.fieldPaths : Object.keys(w.update.fields)) cur[k] = w.update.fields[k].stringValue;
        DOCS.set(w.update.name, cur);
      }
    }
    return reply({ writeResults: body.writes.map(() => ({})), status: body.writes.map(() => ({})) });
  }
  throw new Error('unexpected fetch ' + url);
};

(async () => {
  const worker = (await import(pathToFileURL(path.join(__dirname, '..', 'workers', 'insight-api', 'worker.js')).href)).default;
  const call = (b) => worker.fetch(new Request('https://x/items/remove', {
    method: 'POST', headers: { Origin: 'https://a1-priv.av1.workers.dev' }, body: JSON.stringify(b),
  }), env, {}).then(r => r.json());

  const denied = await call({ item_id: 'OLD' });
  ok('no lock token → refused, nothing touched', denied.lockRequired && INSIGHT_KV.m.has('plaid:item:OLD'), denied);

  const r = await call({ token: 'T', item_id: 'OLD' });
  ok('remove succeeds', r.ok, r);
  ok('Plaid unlinks the old item only', plaidCalls.length === 1 && plaidCalls[0] === 'tok-old', plaidCalls);
  ok('KV token and cursor gone, other item kept',
    !INSIGHT_KV.m.has('plaid:item:OLD') && !INSIGHT_KV.m.has('plaid:cursor:OLD') && INSIGHT_KV.m.has('plaid:item:NEW'));

  const tx = (id) => DOCS.get(`${ROOT}/dashboards/insight/plaid_transactions/${id}`);
  const acct = (id) => DOCS.get(`${ROOT}/dashboards/insight/accounts/${id}`);
  ok('old link’s accounts deleted, others kept', !acct('oSav') && !acct('oSolo') && acct('nSav') && acct('other'));
  ok('shared card: transactions before the new link’s history move to it',
    tx('t1')?.item_id === 'NEW' && tx('t1')?.account_id === 'nSav' && tx('t2')?.account_id === 'nSav', [tx('t1'), tx('t2')]);
  ok('shared card: transactions the new link already covers are deleted (no duplicates)', !tx('t3') && !tx('t4'));
  ok('card no other link has: transactions deleted', !tx('t5'));
  ok('other links’ transactions untouched', tx('n1') && tx('n2') && tx('a1')?.item_id === 'ALLY');
  ok('counts reported', r.handedOver === 2 && r.plaid_transactions === 3 && r.accounts === 2, r);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
