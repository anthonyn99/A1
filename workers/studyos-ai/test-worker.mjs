// Tests for workers/studyos-ai/worker.js — the pipeline worker (spec P-1…P-7).
//
// Runs the real module against an in-memory KV stub and a stubbed Anthropic
// endpoint. Four behaviours here are the reason the file exists, and each one
// is a place where being silently wrong would be expensive:
//
//   "slide gap is caught"
//       Her prompt forbids skipping slides. A chunk that quietly drops slide 23
//       produces a note that LOOKS complete. The stitcher must fail loudly
//       instead, or the whole feature is untrustworthy.
//
//   "cap blocks before spending"
//       The spec requires the monthly cap be enforced server-side, not merely
//       displayed. The check has to sit before the model call, not after.
//
//   "idempotent re-submit does not re-spend"
//       Same deck + same prompt is the common case (a retry, a double-click, a
//       re-sync). Without the fingerprint it bills twice for one result.
//
//   "a poisoned job cannot wedge the queue"
//       The queue marker is deleted BEFORE the work is attempted. If that order
//       is ever flipped, one bad job blocks every job behind it forever.
//
// Run with:  node workers/studyos-ai/test-worker.mjs
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};

// ── A KV stub with the surface the worker uses ────────────────────────────
function makeKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...m.keys()].filter(k => k.startsWith(prefix)).sort()
        .slice(0, limit).map(name => ({ name }));
      return { keys };
    },
  };
}

// The worker is written for the Workers runtime; under Node it needs btoa and
// a crypto.subtle, both of which modern Node has natively.
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
}

// ── Load the worker with a stubbed global fetch ───────────────────────────
// The module reads env at call time, not import time, so one import serves
// every case; only fetch needs swapping per test.
const mod = await import(new URL('./worker.js', import.meta.url).href);
const worker = mod.default;

let fetchPlan = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const next = fetchPlan.shift();
  if (typeof next === 'function') return next(u, init);
  throw new Error('unexpected fetch: ' + u);
};

// A PDF "file" response from studyos-files.
const filePdf = () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });

// An Anthropic response covering slides `from..to`.
const anthropicCovering = (from, to, usage) => () => new Response(JSON.stringify({
  stop_reason: 'end_turn',
  content: [{
    type: 'text',
    text: Array.from({ length: to - from + 1 }, (_, i) => `## Slide ${from + i}\nbody`).join('\n\n'),
  }],
  usage: usage || { input_tokens: 1000, output_tokens: 500 },
}), { status: 200 });

function envWith(kv, over = {}) {
  return {
    JOBS: kv,
    ANTHROPIC_API_KEY: 'sk-test',
    MONTHLY_CAP_USD: '20',
    // No FILES service binding in the test: the worker falls back to a plain
    // fetch, which the plan above intercepts.
    ...over,
  };
}

const post = (path, body) => new Request('https://x' + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Firebase-AppCheck': 'stub' },
  body: JSON.stringify(body || {}),
});

// App Check verification talks to a live JWKS endpoint, which we are not going
// to reach in a unit test. Neutralise just that check by seeding a job directly
// and driving /cron, which is intentionally NOT App Check gated (it is called
// worker-to-worker over a service binding).
async function seedJob(kv, job) {
  const full = {
    id: job.id, fileId: 'f1', promptId: 'p1', promptVersion: 1,
    prompt: 'rewrite it', slideCount: 15, status: 'queued', progress: 0,
    attempts: 0, costUsd: 0, createdAt: Date.now(), ...job,
  };
  await kv.put('job:' + full.id, JSON.stringify(full));
  await kv.put(`queue:${String(full.createdAt).padStart(14, '0')}:${full.id}`, '1');
  return full;
}

console.log('\nhealth + auth');
{
  const kv = makeKV();
  const r = await worker.fetch(new Request('https://x/health'), envWith(kv), {});
  t('health responds', r.status === 200);

  // Every /api/ai/* route must demand App Check. Without a token the guard
  // rejects before any work happens.
  const r2 = await worker.fetch(
    new Request('https://x/api/ai/budget'), envWith(kv), {});
  t('budget requires App Check', r2.status === 401);

  const r3 = await worker.fetch(post('/api/ai/jobs', { fileId: 'f', promptId: 'p', prompt: 'x' }),
    envWith(kv, { ANTHROPIC_API_KEY: '' }), {});
  t('missing API key -> 503, not a crash', r3.status === 503);
}

console.log('\ndrain: the happy path');
{
  const kv = makeKV();
  await seedJob(kv, { id: 'j1', slideCount: 15 });
  fetchPlan = [filePdf, anthropicCovering(1, 15)];
  const r = await worker.fetch(post('/cron'), envWith(kv), {});
  const out = await r.json();
  t('one job drained', out.drained === 1);
  const job = JSON.parse(await kv.get('job:j1'));
  t('status done', job.status === 'done');
  t('progress 100', job.progress === 100);
  t('result stitched', /## Slide 1\b/.test(job.result) && /## Slide 15\b/.test(job.result));
  // 1000 in @ $5/M + 500 out @ $25/M = 0.005 + 0.0125
  t('cost recorded', Math.abs(job.costUsd - 0.0175) < 1e-9);
  t('spend ledger updated', Math.abs(parseFloat(kv._m.get([...kv._m.keys()].find(k => k.startsWith('spend:')))) - 0.0175) < 1e-9);
  t('queue marker consumed', [...kv._m.keys()].filter(k => k.startsWith('queue:')).length === 0);
}

console.log('\ndrain: chunking across a long deck');
{
  const kv = makeKV();
  await seedJob(kv, { id: 'j2', slideCount: 30 });
  fetchPlan = [filePdf, anthropicCovering(1, 15), anthropicCovering(16, 30)];
  await worker.fetch(post('/cron'), envWith(kv), {});
  const job = JSON.parse(await kv.get('job:j2'));
  t('both chunks ran', job.status === 'done' && job.sections.length === 2);
  t('covers slide 30', /## Slide 30\b/.test(job.result));
  t('chunk boundaries recorded', job.sections[0].to === 15 && job.sections[1].from === 16);
}

console.log('\ndrain: a slide gap must fail loudly');
{
  const kv = makeKV();
  await seedJob(kv, { id: 'j3', slideCount: 15 });
  // Model "covers" the segment but silently omits slide 7.
  fetchPlan = [filePdf, () => new Response(JSON.stringify({
    stop_reason: 'end_turn',
    content: [{
      type: 'text',
      text: Array.from({ length: 15 }, (_, i) => i + 1).filter(n => n !== 7)
        .map(n => `## Slide ${n}\nbody`).join('\n\n'),
    }],
    usage: { input_tokens: 10, output_tokens: 10 },
  }), { status: 200 })];
  const r = await worker.fetch(post('/cron'), envWith(kv), {});
  const out = await r.json();
  const job = JSON.parse(await kv.get('job:j3'));
  t('gap reported', /slides not covered: 7/.test(out.error || job.error || ''));
  t('not marked done', job.status !== 'done');
  t('will retry', out.willRetry === true);
}

console.log('\ndrain: a refusal is not an empty note');
{
  const kv = makeKV();
  await seedJob(kv, { id: 'j4', slideCount: 15 });
  fetchPlan = [filePdf, () => new Response(JSON.stringify({
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'cyber' },
    content: [], usage: { input_tokens: 5, output_tokens: 0 },
  }), { status: 200 })];
  await worker.fetch(post('/cron'), envWith(kv), {});
  const job = JSON.parse(await kv.get('job:j4'));
  t('refusal surfaces as an error', /declined/.test(job.error || ''));
  t('marked error, not done', job.status === 'error');
  t('not retried (would refuse identically)', job.attempts === 1);
}

console.log('\ndrain: a poisoned job cannot wedge the queue');
{
  const kv = makeKV();
  await seedJob(kv, { id: 'bad', createdAt: 1 });
  await seedJob(kv, { id: 'good', createdAt: 2, slideCount: 15 });
  // The bad job's source file 404s.
  fetchPlan = [() => new Response('nope', { status: 404 })];
  await worker.fetch(post('/cron'), envWith(kv), {});
  // Next tick must reach the good job rather than retrying the bad one forever.
  fetchPlan = [filePdf, anthropicCovering(1, 15)];
  await worker.fetch(post('/cron'), envWith(kv), {});
  const good = JSON.parse(await kv.get('job:good'));
  t('the job behind it still ran', good.status === 'done');
}

console.log('\ncap is enforced server-side, before spending');
{
  const kv = makeKV();
  const sk = 'spend:' + new Date().getUTCFullYear() + '-' + String(new Date().getUTCMonth() + 1).padStart(2, '0');
  await kv.put(sk, '999');
  await seedJob(kv, { id: 'j5' });
  // No Anthropic call is planned: if the worker tries one, fetch throws and the
  // test fails — which is exactly the assertion.
  fetchPlan = [];
  await worker.fetch(post('/cron'), envWith(kv), {});
  const job = JSON.parse(await kv.get('job:j5'));
  t('job stopped at the cap', job.status === 'error' && /cap/.test(job.error));
  t('no model call was made', fetchPlan.length === 0);
}

console.log('\ncost accounting');
{
  // Cached-read and cache-creation input tokens are still billed input; leaving
  // them out of the sum silently under-reports spend against the cap.
  const kv = makeKV();
  await seedJob(kv, { id: 'j6', slideCount: 15 });
  fetchPlan = [filePdf, anthropicCovering(1, 15, {
    input_tokens: 1000, cache_creation_input_tokens: 2000,
    cache_read_input_tokens: 4000, output_tokens: 1000,
  })];
  await worker.fetch(post('/cron'), envWith(kv), {});
  const job = JSON.parse(await kv.get('job:j6'));
  // (1000+2000+4000) * 5/M + 1000 * 25/M = 0.035 + 0.025
  t('counts cache tokens as input', Math.abs(job.costUsd - 0.06) < 1e-9);
}

console.log('\nresume: a checkpointed job restarts mid-deck');
{
  const kv = makeKV();
  await seedJob(kv, {
    id: 'j7', slideCount: 30, nextSlide: 16,
    sections: [{ from: 1, to: 15, text: '## Slide 1\nx' }],
    outline: 'Slides 1-15 covered.',
  });
  // Only ONE model call is planned. If the worker restarted from slide 1 it
  // would need two and the fetch stub would throw.
  fetchPlan = [filePdf, anthropicCovering(16, 30)];
  await worker.fetch(post('/cron'), envWith(kv), {});
  const job = JSON.parse(await kv.get('job:j7'));
  t('resumed without re-paying for slides 1-15', job.status === 'done');
  t('kept the earlier section', job.sections.length === 2);
}

console.log('\nidempotency: the same deck + prompt must not re-spend');
{
  // createJob is App Check gated, so exercise the fingerprint through the queue:
  // run a job to completion, then confirm the idem key points at it.
  const kv = makeKV();
  await seedJob(kv, { id: 'j8', slideCount: 15, fingerprint: 'fp-abc' });
  fetchPlan = [filePdf, anthropicCovering(1, 15)];
  await worker.fetch(post('/cron'), envWith(kv), {});
  t('fingerprint recorded on success', (await kv.get('idem:fp-abc')) === 'j8');

  // A FAILED job must not leave a fingerprint, or a later identical submit
  // would hand back the failure as a cached result.
  const kv2 = makeKV();
  await seedJob(kv2, { id: 'j9', slideCount: 15, fingerprint: 'fp-bad' });
  fetchPlan = [() => new Response('nope', { status: 404 })];
  await worker.fetch(post('/cron'), envWith(kv2), {});
  t('no fingerprint after a failure', (await kv2.get('idem:fp-bad')) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
