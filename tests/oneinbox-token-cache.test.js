/* OneInbox Gmail access-token cache: one KV record for every mailbox.

   WHY THIS FILE EXISTS
   Gmail access tokens live an hour, so five connected mailboxes need ~120
   refreshes a day. Cached one-key-per-address, that was 120 KV WRITES/day --
   23% of the whole Cloudflare account's 1,000/day free-tier write budget, spent
   on a cache -- and it was a real contributor to the day that budget ran out.

   A cron tick polls every mailbox in ONE invocation, so those refreshes land
   together. Holding them in a single record and committing it once per run
   makes it ~24 writes/day instead of ~120.

   The saving only exists if the commit is genuinely batched, and that is
   invisible from the outside: a per-mailbox write and a per-run write behave
   identically -- same mail, same latency, no error -- and differ only in a
   number on a quota page nobody reads until it is exceeded. Hence a test that
   counts the writes.

   The correctness risk is the mirror image. This is a cache of SHORT-LIVED
   access tokens; the refresh tokens live in oi:acct:<email> and are untouched.
   So the failure to guard against is not data loss, it is a merge that
   clobbers another isolate's fresh token and reintroduces the writes.

   Run: node tests/oneinbox-token-cache.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'workers', 'oneinbox-api', 'worker.js'), 'utf8');

let pass = 0; const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}
function section(s) { console.log('\n' + s); }

/* A KV stub that COUNTS operations -- the whole point of the exercise. */
function makeKV(seed) {
  const store = new Map(Object.entries(seed || {}));
  return {
    reads: 0, writes: 0, deletes: 0,
    async get(k, type) {
      this.reads++;
      const v = store.has(k) ? store.get(k) : null;
      if (v == null) return null;
      return (type === 'json' || (type && type.type === 'json')) ? JSON.parse(v) : v;
    },
    async put(k, v) { this.writes++; store.set(k, v); },
    async delete(k) { this.deletes++; store.delete(k); },
    _raw: store,
  };
}

/* Load module scope without running the fetch/scheduled handlers, and let the
   test drive the token layer directly. Each load is a FRESH isolate, which is
   what makes the cross-isolate merge testable at all. */
function loadIsolate() {
  const body = SRC.replace(/export default \{[\s\S]*$/, '');
  return new Function(`${body}
    return {
      loadToks, flushToks, TOKS_KEY,
      stage: (email, rec) => { _toks = _toks || {}; _toks[email] = rec; _toksDirty = true; },
      peek:  () => _toks,
      dirty: () => _toksDirty,
      reset: () => { _toks = null; _toksAt = 0; _toksDirty = false; },
      setStale: () => { _toksAt = 0; },
    };`)();
}

const NOW = Math.floor(Date.now() / 1000);
const tok = (name, ttl) => ({ token: 'tok-' + name, exp: NOW + (ttl === undefined ? 3600 : ttl) });
const FIVE = ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com'];

/* ── 1. The actual saving ────────────────────────────────────────────────── */
section('Five mailboxes refreshing costs ONE write, not five');
{
  const W = loadIsolate();
  const kv = makeKV();
  const env = { OI_KV: kv };

  (async () => {
    for (const e of FIVE) { await W.loadToks(env); W.stage(e, tok(e)); }
    await W.flushToks(env);

    t('one KV write for five refreshed mailboxes', kv.writes === 1, kv.writes + ' write(s)');
    const stored = JSON.parse(kv._raw.get('oi:toks'));
    t('all five tokens are in the single record', Object.keys(stored).length === 5,
      Object.keys(stored).join(', '));
    t('and they are the right tokens',
      FIVE.every((e) => stored[e] && stored[e].token === 'tok-' + e));
    t('the old per-mailbox key shape is gone from the source',
      !/['"]oi:tok:['"]|oi:tok:'\s*\+/.test(SRC),
      'A leftover oi:tok:<email> write would silently restore the 120/day cost.');
  })();
}

/* ── 2. A warm cache must not write at all ───────────────────────────────── */
section('A cached token is reused without touching KV');
{
  const W = loadIsolate();
  const kv = makeKV({ 'oi:toks': JSON.stringify({ 'a@x.com': tok('a@x.com') }) });
  const env = { OI_KV: kv };
  (async () => {
    const toks = await W.loadToks(env);
    t('the stored token is visible to the isolate', !!toks['a@x.com']);
    await W.flushToks(env);
    t('nothing dirty means nothing written', kv.writes === 0, kv.writes + ' write(s)');
  })();
}

/* ── 3. The cross-isolate merge ──────────────────────────────────────────── */
section('Flushing merges rather than overwrites');
{
  const W = loadIsolate();
  // Isolate A loaded when the record was empty and refreshed a@x.com.
  const kv = makeKV();
  const env = { OI_KV: kv };
  (async () => {
    await W.loadToks(env);
    W.stage('a@x.com', tok('a@x.com'));

    // Meanwhile isolate B refreshed b@x.com and committed first.
    kv._raw.set('oi:toks', JSON.stringify({ 'b@x.com': tok('b@x.com') }));

    await W.flushToks(env);
    const stored = JSON.parse(kv._raw.get('oi:toks'));
    t("another isolate's token survives", !!stored['b@x.com'],
      'Clobbering it forces a needless refresh -- the exact cost this removes.');
    t('this isolate\'s token is stored too', !!stored['a@x.com']);
  })();
}

section('The fresher token wins a conflict');
{
  const W = loadIsolate();
  const kv = makeKV();
  const env = { OI_KV: kv };
  (async () => {
    await W.loadToks(env);
    W.stage('a@x.com', { token: 'older', exp: NOW + 100 });
    kv._raw.set('oi:toks', JSON.stringify({ 'a@x.com': { token: 'newer', exp: NOW + 3000 } }));
    await W.flushToks(env);
    const stored = JSON.parse(kv._raw.get('oi:toks'));
    t('later expiry is kept', stored['a@x.com'].token === 'newer', stored['a@x.com'].token);
  })();
}

/* ── 4. The record cannot grow without bound ─────────────────────────────── */
section('Dead entries are pruned, so one record cannot become a landfill');
{
  const W = loadIsolate();
  const kv = makeKV();
  const env = { OI_KV: kv };
  (async () => {
    await W.loadToks(env);
    W.stage('live@x.com', tok('live@x.com'));
    W.stage('expired@x.com', { token: 'dead', exp: NOW - 10 });
    await W.flushToks(env);
    const stored = JSON.parse(kv._raw.get('oi:toks'));
    t('the expired entry is dropped', !stored['expired@x.com']);
    t('the live entry is kept', !!stored['live@x.com']);
  })();
}

/* ── 5. Failure must degrade to a refresh, never to an error ─────────────── */
section('KV trouble costs a round trip, never a failed sync');
{
  const W = loadIsolate();
  const env = { OI_KV: {
    async get() { throw new Error('KV unavailable'); },
    async put() { throw new Error('KV unavailable'); },
  } };
  (async () => {
    let threw = null;
    try {
      const toks = await W.loadToks(env);
      t('a failed read yields an empty view rather than throwing',
        toks && typeof toks === 'object');
      W.stage('a@x.com', tok('a@x.com'));
      await W.flushToks(env);
    } catch (e) { threw = e; }
    t('a failed write does not propagate', threw === null,
      threw ? String(threw.message) : '',
      );
  })();
}

/* ── 6. Wiring: the flush has to actually be called ──────────────────────── */
section('The commit is wired into every path that can refresh a token');
t('the cron run flushes once at the end',
  /await flushToks\(env\);\s*\/\/ likewise: one write, not one per mailbox/.test(SRC),
  'Without this the cron -- the path that refreshes all five -- never commits.');
t('the request handler flushes in a finally',
  /\}\s*finally\s*\{[\s\S]{0,600}?ctx\.waitUntil\(flushToks\(env\)\)/.test(SRC),
  'A per-route flush would be forgotten by the next route added.');
t('disconnecting an account evicts its token',
  /delete toks\[a\.email\];[\s\S]{0,80}?flushToks\(env\)/.test(SRC));
t('the record carries a TTL so an abandoned deployment cleans itself up',
  /TOKS_KEY, JSON\.stringify\(merged\), \{ expirationTtl:/.test(SRC));

setTimeout(() => {
  console.log('\n' + '─'.repeat(64));
  if (failures.length) {
    console.log(failures.length + ' FAILED:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  console.log('All ' + pass + ' token-cache checks passed.');
}, 50);
