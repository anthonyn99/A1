// POST /prompt/refine (MAGI's Refine) and the /journal/format chain (Notebook's
// AI tools): the real fetch handler of worker.js against a fake Gemini and a
// fake Workers AI binding. No network.
//
// Run: node workers/personal-ai/refine.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const SP = mkdtempSync(join(tmpdir(), 'refinetest-'));
writeFileSync(SP + '/_w.mjs', readFileSync(new URL('./worker.js', import.meta.url), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CALLS = [];
// Each test sets GEMINI(model, body) and CF(model, input) to an outcome:
// { ms, status, text } (text = the model's JSON string) or { ms, throws }.
let GEMINI = null, CF = null;
const resp = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => null },
  json: async () => body, text: async () => JSON.stringify(body),
});
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith('https://generativelanguage.googleapis.com/')) throw new Error('unexpected fetch ' + u);
  const model = u.split('/models/')[1].split(':')[0];
  const key = decodeURIComponent((u.match(/[?&]key=([^&]+)/) || [])[1] || '');
  const body = JSON.parse(opts.body);
  CALLS.push({ to: 'gemini', model, key, prompt: body.contents[0].parts[0].text });
  const o = GEMINI(model, body);
  if (o.ms) await sleep(o.ms);
  if (opts.signal && opts.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
  if (o.status && o.status !== 200) return resp(o.status, { error: { code: o.status } });
  return resp(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: o.text }] } }] });
};
const AI = { run: async (model, input) => {
  CALLS.push({ to: 'cf', model, prompt: input.messages[0].content, format: input.response_format });
  const o = CF(model, input);
  if (o.ms) await sleep(o.ms);
  if (o.throws) throw new Error(o.throws);
  return { response: o.text };
} };
const W = await import(pathToFileURL(SP + '/_w.mjs').href);
const worker = W.default;
const ENV = { TONY_GEMINI_KEY: 'tony-key', VEDA_GEMINI_KEY: 'veda-key', AI };
const post = async (path, body, env = ENV) => {
  const r = await worker.fetch(new Request('https://personal-ai.av1.workers.dev' + path, { method: 'POST', body: JSON.stringify(body) }), env);
  return { status: r.status, body: await r.json() };
};
const says = (refined, ms = 0) => () => ({ ms, text: JSON.stringify({ refined }) });
const down = (status = 503) => () => ({ status });
const reset = () => { CALLS.length = 0; GEMINI = CF = null; };

let pass = 0, fail = 0;
const t = async (name, fn) => {
  reset();
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n       ', e.message); }
};
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || ''} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

const Q = 'what should i get my mom for her 60th birthday, budget around $150, she likes gardening';
const GOOD = "I need gift ideas for my mom's 60th birthday, with a budget of around $150. She enjoys gardening.";

console.log('\nThe fact check');
await t('numbers, URLs, calls, files and quoted errors are facts', () => {
  const f = W.refineFacts('fix toggleSidebar() in magi.html, error "Cannot read x", see https://a.b/c?d=1 and pg-staging-02, budget $12,400 by 11/4');
  for (const want of ['toggleSidebar()', 'magi.html', 'Cannot read x', 'https://a.b/c?d=1', 'pg-staging-02', '12,400', '11/4']) ok(f.includes(want), 'missing fact ' + want + ' in ' + JSON.stringify(f));
});
await t('"Oct 12" → "October 12" keeps the 12; "5" → "five" loses the 5', () => {
  eq(W.refineMissing('broken since Oct 12', 'It has been broken since October 12.'), []);
  eq(W.refineMissing('summarize in 5 bullet points', 'Summarize in five bullet points.'), ['5']);
});
await t('a number only counts with no digit glued on ("2" is not kept by "20")', () => {
  eq(W.refineMissing('2 people', 'Plan for 20 people.'), ['2']);
});
await t('cleanRefined strips a preamble, fences and wrapping quotes; refuses an essay', () => {
  eq(W.cleanRefined('Here is the rewritten prompt: Do X.', 'x'), 'Do X.');
  eq(W.cleanRefined('```\nDo X.\n```', 'x'), 'Do X.');
  eq(W.cleanRefined('"Do X."', 'x'), 'Do X.');
  eq(W.cleanRefined('a'.repeat(4100), 'short'), null);
  ok(W.cleanRefined('a'.repeat(9000), 'b'.repeat(3000)), 'a long pasted request may come back long');
});

console.log('\nMAGI Refine — keys');
await t("Tony's refine uses TONY_GEMINI_KEY (the same key as his Notebook)", async () => {
  GEMINI = says(GOOD);
  const r = await post('/prompt/refine', { profile: 'tony', question: Q });
  eq(r.status, 200); eq(r.body.refined, GOOD);
  eq(CALLS[0].key, 'tony-key');
});
await t("Veda's refine uses VEDA_GEMINI_KEY, never Tony's", async () => {
  GEMINI = says(GOOD);
  const r = await post('/prompt/refine', { profile: 'veda', question: Q });
  eq(r.status, 200);
  ok(CALLS.filter((c) => c.to === 'gemini').every((c) => c.key === 'veda-key'), JSON.stringify(CALLS.map((c) => c.key)));
});
await t('a person without a key still refines on Workers AI, never on the other key', async () => {
  GEMINI = says(GOOD); CF = says(GOOD);
  const r = await post('/prompt/refine', { profile: 'veda', question: Q }, { TONY_GEMINI_KEY: 'tony-key', AI });
  eq(r.status, 200);
  eq(CALLS.filter((c) => c.to === 'gemini').length, 0);
});
await t('the request is sent whole, between the fences, with the no-loss rule', async () => {
  GEMINI = says(GOOD);
  await post('/prompt/refine', { profile: 'tony', question: Q + ' $& $1' });
  ok(CALLS[0].prompt.includes('<<<\n' + Q + ' $& $1\n>>>'), 'question not carried verbatim');
  ok(CALLS[0].prompt.includes('Nothing may be lost.'));
});
await t('Code Mode adds the coding-agent note', async () => {
  GEMINI = says('Fix toggleSidebar() in magi.html.');
  await post('/prompt/refine', { profile: 'tony', question: 'fix toggleSidebar() in magi.html', kind: 'code' });
  ok(CALLS[0].prompt.includes('AI coding agent'));
});

console.log('\nMAGI Refine — speed and fallback');
await t('healthy Gemini: one call, Gemini lite answers, nothing else starts', async () => {
  GEMINI = says(GOOD, 50); CF = says(GOOD);
  const r = await post('/prompt/refine', { profile: 'tony', question: Q });
  eq(r.body.model, 'gemini-3.5-flash-lite');
  eq(CALLS.length, 1);
});
await t('Gemini 503: Workers AI answers at once, no waiting out a stagger', async () => {
  GEMINI = down(503); CF = says(GOOD, 30);
  const t0 = Date.now();
  const r = await post('/prompt/refine', { profile: 'tony', question: Q });
  eq(r.status, 200); eq(r.body.model, '@cf/meta/llama-4-scout-17b-16e-instruct');
  ok(Date.now() - t0 < 1000, 'took ' + (Date.now() - t0) + 'ms');
});
await t('slow Gemini (a 10 s answer): Scout is raced in at 1.5 s and wins', async () => {
  GEMINI = says(GOOD, 10000); CF = says(GOOD, 100);
  const t0 = Date.now();
  const r = await post('/prompt/refine', { profile: 'tony', question: Q });
  eq(r.body.model, '@cf/meta/llama-4-scout-17b-16e-instruct');
  const ms = Date.now() - t0;
  ok(ms >= 1400 && ms < 3000, 'took ' + ms + 'ms');
});
await t('a rewrite that drops a number is set aside for one that keeps everything', async () => {
  GEMINI = says("I need gift ideas for my mom's birthday. She enjoys gardening."); CF = says(GOOD);
  const r = await post('/prompt/refine', { profile: 'tony', question: Q });
  eq(r.body.refined, GOOD); eq(r.body.missing, []);
});
await t('if EVERY rewrite is lossy, the first comes back with what it lost named', async () => {
  const lossy = "I need gift ideas for my mom's 60th birthday. She enjoys gardening.";
  GEMINI = says(lossy); CF = says(lossy);
  const r = await post('/prompt/refine', { profile: 'tony', question: Q });
  eq(r.status, 200); eq(r.body.missing, ['150']);
});
await t('everything down: a clear 5xx, not a hang', async () => {
  GEMINI = down(503); CF = () => ({ throws: 'internal error' });
  const r = await post('/prompt/refine', { profile: 'tony', question: Q });
  ok(r.status >= 500, 'status ' + r.status); eq(r.body.ok, false);
});
await t('Workers AI gets a lowercase JSON schema', async () => {
  GEMINI = down(503); CF = says(GOOD);
  await post('/prompt/refine', { profile: 'tony', question: Q });
  eq(CALLS.find((c) => c.to === 'cf').format.json_schema.type, 'object');
});

console.log('\nNotebook AI tools (/journal/format)');
const DOC = 'woke up at 6:15, ran 3.2 miles\n[[IMG1]]\nbuy eggs and spinach\n[[IMG2]]';
const HTML = '<p>Woke up at 6:15, ran 3.2 miles.</p>[[IMG1|large]]<ul><li>Buy eggs and spinach</li></ul>[[IMG2]]';
const html = (h, ms = 0) => () => ({ ms, text: JSON.stringify({ html: h }) });
await t('formatKeepsContent: every image token and section marker must survive', () => {
  ok(W.formatKeepsContent(DOC, HTML, 'format'));
  ok(!W.formatKeepsContent(DOC, '<p>Woke up at 6:15, ran 3.2 miles.</p>[[IMG1]]<p>Buy eggs and spinach</p>', 'refine'), 'a dropped image passed');
  ok(!W.formatKeepsContent('[[SEC0S]]\na\n[[SEC0E]]', '<p>a</p>', 'format'), 'a dropped marker passed');
});
await t('formatKeepsContent: AI Format may not shrink the text; Refine may', () => {
  const long = 'This is a long paragraph about my day and what I did in it. '.repeat(5);
  ok(!W.formatKeepsContent(long, '<p>A day.</p>', 'format'));
  ok(W.formatKeepsContent(long, '<p>A day.</p>', 'refine'));
});
await t("Tony's tools use his key; Veda's use hers", async () => {
  GEMINI = html(HTML);
  await post('/journal/format', { profile: 'tony', text: DOC, tool: 'format' });
  await post('/journal/format', { profile: 'veda', text: DOC, tool: 'format' });
  eq(CALLS.map((c) => c.key), ['tony-key', 'veda-key']);
});
await t('the retired 2.5-flash is not in the chain', async () => {
  GEMINI = (m) => (m === 'gemini-2.5-flash' ? { status: 404 } : { status: 503 }); CF = html(HTML);
  await post('/journal/format', { profile: 'tony', text: DOC, tool: 'format' });
  ok(!CALLS.some((c) => c.model === 'gemini-2.5-flash'), JSON.stringify(CALLS.map((c) => c.model)));
});
await t('Gemini down: Workers AI formats it', async () => {
  GEMINI = down(503); CF = html(HTML);
  const r = await post('/journal/format', { profile: 'tony', text: DOC, tool: 'format' });
  eq(r.status, 200); eq(r.body.model, '@cf/meta/llama-4-scout-17b-16e-instruct'); eq(r.body.html, HTML);
});
await t('an answer that lost an image is replaced by one that kept it', async () => {
  GEMINI = (m) => (m === 'gemini-3.5-flash' ? html('<p>Woke up at 6:15, ran 3.2 miles.</p>[[IMG1]]<p>Buy eggs and spinach</p>')() : html(HTML)());
  const r = await post('/journal/format', { profile: 'tony', text: DOC, tool: 'format' });
  eq(r.body.html, HTML); eq(r.body.salvaged, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
