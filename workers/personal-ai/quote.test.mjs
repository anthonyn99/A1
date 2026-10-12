// GET /quote/daily (Everwell's quote of the day): the real fetch handler of
// worker.js against a fake KV and a fake upstream (ORCA + Gemini). No network.
//
// Run: node workers/personal-ai/quote.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const SP = mkdtempSync(join(tmpdir(), 'quotetest-'));
writeFileSync(SP + '/_w.mjs', readFileSync(new URL('./worker.js', import.meta.url), 'utf8'));

// Upstream script: each test sets ORCA(req) / GEMINI(req) to a response.
let ORCA = null, GEMINI = null;
const CALLS = [];
const resp = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[k] || headers[k.toLowerCase()] || null },
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
globalThis.fetch = async (url, opts) => {
  const u = String(url), body = opts && opts.body ? JSON.parse(opts.body) : {};
  if (u.startsWith('https://orca.vedapatel05.workers.dev/')) { CALLS.push({ to: 'orca', model: body.model || 'auto', auth: opts.headers.Authorization, prompt: body.messages[0].content }); return ORCA(body); }
  if (u.startsWith('https://generativelanguage.googleapis.com/')) { CALLS.push({ to: 'gemini', model: u.split('/models/')[1].split(':')[0] }); return GEMINI(body); }
  throw new Error('unexpected fetch ' + u);
};
const { default: worker } = await import(pathToFileURL(SP + '/_w.mjs').href);

const store = new Map(); let puts = 0;
const KV = { get: async (k, t) => { const v = store.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v); }, put: async (k, v) => { puts++; store.set(k, v); } };
const ENV = { TONY_ORCA_KEY: 'orca_sk_test', TONY_GEMINI_KEY: 'gk_test', TOKEN_CACHE: KV };
const today = new Date().toISOString().slice(0, 10);
const day = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const call = async (q, env = ENV) => { const r = await worker.fetch(new Request('https://personal-ai.av1.workers.dev/quote/daily?' + q), env); return { status: r.status, body: await r.json() }; };
const orcaSays = (text) => () => resp(200, { model: 'deepseek/free', choices: [{ message: { content: text } }] });
const geminiSays = (text) => () => resp(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ quote: text }) }] } }] });
const reset = () => { store.clear(); puts = 0; CALLS.length = 0; ORCA = GEMINI = null; };

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 400) : '')); } };

console.log('\nGuard rails');
reset();
ok('profile must be tony', (await call('profile=veda&date=' + today)).status === 400 && CALLS.length === 0);
ok('a malformed date is refused', (await call('profile=tony&date=2026-1-1')).status === 400);
ok('a date more than a day from today is refused (no cache bypass)', (await call('profile=tony&date=' + day(3))).status === 400 && (await call('profile=tony&date=' + day(-2))).status === 400 && CALLS.length === 0);

console.log('\nORCA first');
reset(); ORCA = orcaSays('{"quote": "Keep the promise you made to yourself this morning, even when nobody is watching."}');
let r = await call('profile=tony&date=' + today);
ok('ORCA answers: one call, to DeepSeek, with the ORCA key', r.body.ok && r.body.source === 'orca' && CALLS.length === 1 && CALLS[0].model === 'deepseek/free' && CALLS[0].auth === 'Bearer orca_sk_test', { r, CALLS });
ok('the quote is clean', r.body.quote === 'Keep the promise you made to yourself this morning, even when nobody is watching.');
ok('…and cached: one KV write', puts === 1 && JSON.parse(store.get('ew_quote:tony')).date === today);
r = await call('profile=tony&date=' + today);
ok('the same day again costs NO AI call and the same text comes back', r.body.ok && r.body.cached && CALLS.length === 1 && r.body.quote.startsWith('Keep the promise') && puts === 1);
ok('a day older than the cached one is never generated', (await call('profile=tony&date=' + day(-1))).body.ok === false && CALLS.length === 1);
ok('the prompt carries today\'s theme and the JSON instruction', /Today's theme: /.test(CALLS[0].prompt) && /Reply with JSON only/.test(CALLS[0].prompt));

console.log('\nFallbacks');
reset(); ORCA = () => resp(503, { error: { kind: 'no_eligible_backend' } }, { 'Retry-After': '120' }); GEMINI = geminiSays('Strength grows in the quiet reps you choose when skipping would be easier.');
r = await call('profile=tony&date=' + today);
ok('ORCA 503 (PC away): ONE ORCA call, then Gemini answers', r.body.ok && r.body.source === 'gemini' && CALLS.filter((c) => c.to === 'orca').length === 1 && CALLS.some((c) => c.to === 'gemini' && c.model === 'gemini-3.5-flash'), CALLS);
reset(); ORCA = (b) => (b.model !== 'gemini_web/free' ? resp(b.model === 'deepseek/free' ? 404 : 502, { error: {} }) : orcaSays('Faith grows when you keep showing up on the days that feel ordinary.')());
r = await call('profile=tony&date=' + today);
ok('DeepSeek 404, ChatGPT 502: the next free model is tried, in order', r.body.ok && r.body.source === 'orca' && CALLS.map((c) => c.model).join() === 'deepseek/free,chatgpt/free,gemini_web/free', CALLS);
reset(); ORCA = () => resp(404, { error: {} }); GEMINI = geminiSays('Small honest efforts, repeated daily, quietly outgrow every dramatic resolution.');
r = await call('profile=tony&date=' + today);
const tried = CALLS.filter((c) => c.to === 'orca').map((c) => c.model);
ok('every ORCA try names a FREE model, never Claude and never ORCA\'s own pick', tried.length === 6 && tried.every((m) => /\/free$/.test(m) && !/claude/.test(m) && m !== 'auto') && r.body.source === 'gemini', tried);
reset(); ORCA = () => resp(401, {}); GEMINI = geminiSays('Your habits are votes for the person you are becoming, so vote well today.');
r = await call('profile=tony&date=' + today);
ok('ORCA 401 (bad key): straight to Gemini, no second ORCA call', r.body.ok && r.body.source === 'gemini' && CALLS.filter((c) => c.to === 'orca').length === 1);
reset(); ORCA = () => resp(429, {}, { 'Retry-After': '60' }); GEMINI = geminiSays('Patience is effort that has decided to stay for the whole season.');
ok('ORCA 429: Gemini, no ORCA retry', (await call('profile=tony&date=' + today)).body.source === 'gemini' && CALLS.filter((c) => c.to === 'orca').length === 1);
reset(); ORCA = () => { throw new TypeError('network down'); }; GEMINI = geminiSays('A calm mind is built one honest choice at a time, not in a single day.');
ok('ORCA network error: Gemini', (await call('profile=tony&date=' + today)).body.source === 'gemini');
reset(); ORCA = orcaSays('The only way to do great work is to love what you do. — Steve Jobs'); GEMINI = geminiSays('Do the small thing well today and tomorrow will ask less of your courage.');
r = await call('profile=tony&date=' + today);
ok('a line with an attribution ("— Name") is rejected, next source used', r.body.ok && r.body.source === 'gemini' && !/Jobs/.test(r.body.quote), r.body);
reset(); ORCA = () => resp(503, {}); GEMINI = () => resp(429, { error: { message: 'Quota exceeded for project 12345 secret detail' } });
r = await call('profile=tony&date=' + today);
ok('everything fails: ok:false with a GENERIC error, nothing cached', r.status === 200 && r.body.ok === false && r.body.error === 'unavailable' && puts === 0, r);
ok('…and no provider text leaks into the reply', !/quota|12345|secret|gemini|orca/i.test(JSON.stringify(r.body)));
reset();
r = await call('profile=tony&date=' + today, { TOKEN_CACHE: KV });
ok('no keys at all: unavailable, no upstream call', r.body.ok === false && CALLS.length === 0);

console.log('\nNo repeats');
reset();
store.set('ew_quote:tony', JSON.stringify({ date: day(-1), text: 'Yesterday line that was quite long enough to count.', via: 'orca', recent: ['Yesterday line that was quite long enough to count.'] }));
ORCA = orcaSays('Yesterday line that was quite long enough to count.'); GEMINI = geminiSays('Tomorrow is built from the effort you are willing to spend this afternoon.');
r = await call('profile=tony&date=' + today);
ok('a repeat of a recent line is rejected; the recent list is in the prompt', r.body.ok && r.body.source === 'gemini' && /Yesterday line/.test(CALLS[0].prompt), r.body);
ok('…and the new line joins the recent list (capped at 30)', JSON.parse(store.get('ew_quote:tony')).recent.length === 2);

console.log('\nkind=buddhist (Prayer tab)');
const bq = (o) => JSON.stringify(o);
reset(); ORCA = orcaSays(bq({ quote: 'Hatred is never appeased by hatred in this world. By non-hatred alone is hatred appeased.', source: 'Dhammapada, verse 5' }));
r = await call('profile=tony&kind=buddhist&date=' + today);
ok('ORCA (DeepSeek first) answers with the quote AND its source', r.body.ok && r.body.kind === 'buddhist' && r.body.source === 'orca' && r.body.cite === 'Dhammapada, verse 5' && /^Hatred is never/.test(r.body.quote) && CALLS[0].model === 'deepseek/free', r.body);
ok('the prompt asks for a REAL quote and warns off fake ones', /genuine Buddhist quote/.test(CALLS[0].prompt) && /misattributed/.test(CALLS[0].prompt));
ok('…cached under its own key (the daily line is untouched)', puts === 1 && !!store.get('ew_bquote:tony') && !store.get('ew_quote:tony'));
r = await call('profile=tony&kind=buddhist&date=' + today);
ok('the same day again: no AI call, same quote and source', r.body.cached && CALLS.length === 1 && r.body.cite === 'Dhammapada, verse 5');
reset(); ORCA = orcaSays('Here you go: {"quote": "Peace comes from within. Do not seek it without."}'); GEMINI = () => resp(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: bq({ quote: 'You yourselves must strive; the Buddhas only point the way.', source: 'Dhammapada, verse 276' }) }] } }] });
r = await call('profile=tony&kind=buddhist&date=' + today);
ok('an answer with no source is refused; the next source is used', r.body.ok && r.body.source === 'gemini' && r.body.cite === 'Dhammapada, verse 276', r.body);
reset(); ORCA = () => resp(503, {}); GEMINI = () => resp(429, { error: { message: 'quota secret' } });
r = await call('profile=tony&kind=buddhist&date=' + today);
ok('all failing: a generic unavailable, nothing cached, no leak', r.body.ok === false && r.body.error === 'unavailable' && puts === 0 && !/quota|secret/.test(JSON.stringify(r.body)));
ok('an unknown kind is refused', (await call('profile=tony&kind=zen&date=' + today)).status === 400);
ok('kind=buddhist keeps the guard rails (profile, date)', (await call('profile=veda&kind=buddhist&date=' + today)).status === 400 && (await call('profile=tony&kind=buddhist&date=' + day(3))).status === 400);

console.log('\nThe health route advertises it');
const h = await (await worker.fetch(new Request('https://personal-ai.av1.workers.dev/health'), ENV)).json();
ok('/health: version 26, features "quote" + "quote-buddhist" + "yt-playlist" + "ig-media", orcaKey true, no key material', h.version === 26 && h.features.includes('quote') && h.features.includes('quote-buddhist') && h.features.includes('yt-playlist') && h.features.includes('ig-media') && h.orcaKey === true && !JSON.stringify(h).includes('orca_sk_test'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
