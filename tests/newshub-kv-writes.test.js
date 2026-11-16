// newshub-api's staged News build and account 1's KV write budget (1,000 a day,
// shared by every worker on the account). 2026-11-16: the intraday rebuilds
// (every 45 min of the session, one per watchlist) pushed NEWSHUB_CACHE to
// ~250-660 writes a day. Pinned here: starting a build writes only its meta (no
// empty articles seed), AI prep writes only the events (no empty enriched seed),
// and the stage:winstatus breadcrumb is written on the last window or a window
// that enriched nothing, never on every window. Also: the live-test harness
// always catches newshub-api, so a test watchlist can never start a real build.
//
// Run: node tests/newshub-kv-writes.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400) : '')); }
};
const SRC = path.join(__dirname, '..', 'workers', 'newshub-api', 'worker.js');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhkv-'));
  let src = fs.readFileSync(SRC, 'utf8');
  src += '\nexport { startStagedBuild, handleStage, stageKeys };\n';
  fs.writeFileSync(path.join(dir, 'w.mjs'), src);
  // The AI window is faked: nothing leaves this process.
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  const W = await import(pathToFileURL(path.join(dir, 'w.mjs')).href);

  const kv = new Map(), puts = [];
  const NEWSHUB_CACHE = {
    get: async (k) => (kv.has(k) ? kv.get(k) : null),
    put: async (k, v) => { puts.push(k); kv.set(k, v); },
    delete: async (k) => { kv.delete(k); },
  };
  const kicks = [];
  const env = { NEWSHUB_CACHE, SELF: { fetch: async (u) => { kicks.push(u); return new Response('{}'); } } };
  const ctx = { waitUntil() {} };
  const req = new Request('https://newshub-api.test/news');

  await W.startStagedBuild(env, ctx, req, false, ['NVDA', 'AMD'], [], 'events:v1:test', 'build:lock:test');
  const metaKey = puts.find((k) => /:meta$/.test(k));
  ok('starting a build writes ONE key (its meta), no empty articles seed', puts.length === 1 && !!metaKey, puts);
  const buildId = metaKey.replace(/^stage:/, '').replace(/:meta$/, '');
  const k = W.stageKeys(buildId);
  ok('… and kicks the first fetch stage', kicks.length === 1 && /stage=fetch/.test(kicks[0]));

  // The AI prep stage, from a fetched articles list.
  kv.set(k.articles, '[]');
  puts.length = 0;
  await W.handleStage(env, ctx, req, buildId, 'ai', null);
  ok('AI prep writes only the events (no empty enriched seed)', puts.length === 1 && puts[0] === k.events, puts);

  // Windows: 3 windows' worth of events, every model unavailable (nothing enriched) → the breadcrumb
  // on each (that is what it explains); with enrichment it would be the last only (checked in the source).
  const s = fs.readFileSync(SRC, 'utf8');
  ok('the breadcrumb is gated: the last window, or a window that enriched nothing', /if \(next >= totalWindows \|\| \(windowEvents\.length && !winEnriched\)\)\{\s*await env\.NEWSHUB_CACHE\.put\('stage:winstatus'/.test(s));
  ok('no other place seeds an empty articles or enriched key', !/put\(k\.(articles|enriched), '\[\]'/.test(s));

  const cdp = fs.readFileSync(path.join(__dirname, 'live', 'cdp.js'), 'utf8');
  ok('the live-test harness always catches newshub-api (unless CDP_REAL_NEWSHUB=1)', /CDP_REAL_NEWSHUB \? \[\] : \['https:\/\/newshub-api\.av1\.workers\.dev\/\*'\]/.test(cdp));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
