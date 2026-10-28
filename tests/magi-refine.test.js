#!/usr/bin/env node
/**
 * MAGI Refine routing (magi.html refineText).
 *
 * Every Refine button rewrites through refineText. With Gemini ticked it must
 * go to the personal-ai worker with THIS profile's id -- so Tony's refines on
 * Tony's Notebook Gemini key and Veda's on hers -- and reach the engine only
 * as the fallback, with skip_api so the engine's own .env key is not used.
 * Gemini unticked: the worker (a Gemini key) is never called.
 *
 * Runs the real function, cut out of magi.html, against a fake fetch.
 * Run: node tests/magi-refine.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push(name + '\n      ' + e.message); console.log('  ✗ ' + name); }
}
function ok(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const page = fs.readFileSync(path.join(__dirname, '..', 'magi.html'), 'utf8');
const start = page.indexOf('const REFINE_API = ');
const end = page.indexOf('/** Rewrite the composer', start);
ok(start > 0 && end > start, 'refineText block not found in magi.html');
const code = page.slice(start, end);

function load({ profile = 'tony', up = true, worker, engine }) {
  const calls = [];
  const sb = {
    PROFILE: { id: profile },
    online: () => up,
    link: { api: 'https://engine.test' },
    authed: (init) => init,
    AbortController, setTimeout, clearTimeout, JSON,
    FormData: class { constructor() { this.m = {}; } append(k, v) { this.m[k] = v; } },
    fetch: async (url, init) => {
      calls.push({ url, init });
      const r = url.startsWith('https://personal-ai.') ? worker(JSON.parse(init.body)) : engine(init.body.m);
      if (r instanceof Error) throw r;
      return { ok: r.status === 200, status: r.status, json: async () => r.body };
    },
  };
  vm.createContext(sb);
  vm.runInContext(code + '\nthis.refineText = refineText; this.refineCanRun = refineCanRun; this.refineLossNote = refineLossNote;', sb);
  return { sb, calls };
}
const W200 = (refined, missing = []) => () => ({ status: 200, body: { ok: true, refined, missing } });
const E200 = (refined) => () => ({ status: 200, body: { refined } });

(async () => {
  console.log('\nMAGI Refine routing');
  await t("Tony, Gemini ticked: the worker, with profile 'tony' — no engine call", async () => {
    const { sb, calls } = load({ worker: W200('Better.'), engine: () => { throw new Error('engine called'); } });
    const r = await sb.refineText('q', ['gemini', 'chatgpt']);
    ok(r.refined === 'Better.');
    ok(calls.length === 1 && JSON.parse(calls[0].init.body).profile === 'tony');
  });
  await t("Veda: the worker gets profile 'veda' (her own key)", async () => {
    const { sb, calls } = load({ profile: 'veda', worker: W200('Better.') });
    await sb.refineText('q', ['gemini']);
    ok(JSON.parse(calls[0].init.body).profile === 'veda');
  });
  await t('works with the engine offline', async () => {
    const { sb } = load({ up: false, worker: W200('Better.') });
    ok(sb.refineCanRun(['gemini']));
    ok((await sb.refineText('q', ['gemini'])).refined === 'Better.');
  });
  await t('Code Mode sends kind "code"', async () => {
    const { sb, calls } = load({ worker: W200('Fix it.') });
    await sb.refineText('fix', ['gemini'], 'code');
    ok(JSON.parse(calls[0].init.body).kind === 'code');
  });
  await t('worker fails: the engine refines, with skip_api=1', async () => {
    const { sb, calls } = load({ worker: () => ({ status: 502, body: { ok: false, error: 'all models failed' } }), engine: E200('From a unit.') });
    const r = await sb.refineText('q', ['gemini', 'chatgpt']);
    ok(r.refined === 'From a unit.');
    ok(calls[1].init.body.m.skip_api === '1' && calls[1].init.body.m.providers === 'gemini,chatgpt');
  });
  await t('worker unreachable and engine offline: a clear error', async () => {
    const { sb } = load({ up: false, worker: () => new Error('net') });
    let err = null;
    try { await sb.refineText('q', ['gemini']); } catch (e) { err = e; }
    ok(err && /reach the refiner/.test(err.message), err && err.message);
  });
  await t('Gemini unticked: the worker (a Gemini key) is never called', async () => {
    const { sb, calls } = load({ worker: () => { throw new Error('worker called'); }, engine: E200('From a unit.') });
    await sb.refineText('q', ['chatgpt']);
    ok(calls.length === 1 && calls[0].url.startsWith('https://engine.test'));
  });
  await t('Gemini unticked and engine offline: Refine is not offered', async () => {
    const { sb } = load({ up: false, worker: W200('x') });
    ok(!sb.refineCanRun(['chatgpt']));
  });
  await t('a lossy rewrite is named under the box', async () => {
    const { sb } = load({ worker: W200('Better.', ['150']) });
    const r = await sb.refineText('q', ['gemini']);
    ok(/dropped: 150/.test(sb.refineLossNote(r.missing)));
    ok(sb.refineLossNote([]) === null);
  });
  await t('all three Refine buttons go through refineText', async () => {
    ok((page.match(/await refineText\(/g) || []).length === 3, 'expected 3 callers');
    ok((page.match(/\/api\/refine`/g) || []).length === 1, 'a caller still posts to the engine directly');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\n' + failures.join('\n')); process.exit(1); }
})();
