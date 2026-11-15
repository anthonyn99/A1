// quant-api, Phase 10 (A1-Priv docs/TradeHub/quant/phase-10.md): Neo Quant's
// hearing, POST /ai/hear. The chain Groq Whisper → Workers AI Whisper → Gemini
// audio, each rung failing in turn; all failing says what was tried; the hint
// carries the watchlist; Whisper's silence segments dropped; the ledger counts
// each rung; bad bodies refused; the Orca key required. A REAL SQLite D1 with
// every migration, fake providers.
//
// Run: node tests/quant-hear-api.test.js
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const QA = path.join(__dirname, '..', 'workers2', 'quant-api');
const MIG = path.join(QA, 'migrations');

function realD1() {
  const sql = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIG).filter((x) => x.endsWith('.sql')).sort()) sql.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  const norm = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a.map(norm)),
    async first() { const r = sql.prepare(q).get(...args); return r ? { ...r } : null; },
    async all() { return { results: sql.prepare(q).all(...args).map((r) => ({ ...r })) }; },
    async run() { const r = sql.prepare(q).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { sql, prepare: (q) => stmt(q), async batch(list) { sql.exec('BEGIN'); try { for (const s of list) await s.run(); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; } return []; } };
}

// Fake providers: P.plan[key] = answers used in order (the last repeats). key = host, or the Gemini model id.
const P = { calls: [], forms: [], bodies: [], plan: {}, reset() { this.calls.length = 0; this.forms.length = 0; this.bodies.length = 0; this.plan = {}; } };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), host = new URL(u).host, m = /models\/([\w.-]+):/.exec(u), key = m ? m[1] : host;
  P.calls.push(key);
  if (init.body instanceof FormData) P.forms.push(Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : { name: v.name, type: v.type, size: v.size }])));
  else if (init.body) P.bodies.push({ key, body: String(init.body) });
  const list = P.plan[key];
  if (!list || !list.length) return new Response('{"error":{"message":"unplanned ' + key + '"}}', { status: 500 });
  const a = list.length > 1 ? list.shift() : list[0];
  return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body || {}), { status: a.status || 200, headers: { 'content-type': 'application/json' } });
};
const GROQ = 'api.groq.com', FLASH = 'gemini-3.8-flash', LITE = 'gemini-3.5-flash-lite';

(async () => {
  const W = (await import(pathToFileURL(path.join(QA, 'worker.js')).href)).default;
  const H = await import(pathToFileURL(path.join(QA, 'lib', 'hear.js')).href);
  const KEY = 'orca_sk_test_hear_0123456789ab';
  const hash = (k) => crypto.createHash('sha256').update(k).digest('hex');
  const NOW = Date.now();
  const mkEnv = async (keys = { GROQ_KEY: 'gk', GEMINI_KEY: 'gm' }) => {
    const env = { DB: realD1(), ALLOWED_KEYS: hash(KEY), ...keys };
    for (const [id, family, rank] of [[FLASH, 'flash', 0], [LITE, 'flash-lite', 0]]) {
      await env.DB.prepare('INSERT INTO models (provider, id, family, rank, caps, limits, spent, state, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind('gemini', id, family, rank, JSON.stringify({ audio: null }), JSON.stringify({ rpd: 100 }), JSON.stringify({}), 'ok', NOW).run();
    }
    return env;
  };
  const call = async (env, body, { key = KEY } = {}) => {
    const r = await W.fetch(new Request('https://quant-api.test/ai/hear', { method: 'POST', headers: { ...(key ? { authorization: 'Bearer ' + key } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, { waitUntil() {} });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (e) {}
    return { status: r.status, body: j };
  };
  const usage = async (env) => Object.fromEntries(((await env.DB.prepare('SELECT service, n FROM usage').all()).results || []).map((r) => [r.service, r.n]));
  const CLIP = { audio: Buffer.from('fake opus bytes, about a second of Tony').toString('base64'), mime: 'audio/webm;codecs=opus', watchlist: ['NVDA', 'AMD', 'pltr', 'bad sym!', 'SPY'] };
  const gemText = (t) => ({ candidates: [{ content: { parts: [{ text: t }], role: 'model' }, finishReason: 'STOP' }] });
  let env, r;

  console.log('\nThe pieces');
  ok('the hint lists the trading terms and the watchlist (cleaned, upper case)', /VWAP/.test(H.hint(CLIP.watchlist)) && /Tickers: NVDA, AMD, PLTR, SPY\./.test(H.hint(CLIP.watchlist)), H.hint(CLIP.watchlist));
  ok('the hint stays short (Whisper reads about 224 tokens of it)', H.hint(Array.from({ length: 200 }, (_, i) => 'T' + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26)))).length <= 700);
  ok('the clip type → the extension Groq reads the format from', H.extOf('audio/webm;codecs=opus') === 'webm' && H.extOf('audio/ogg') === 'ogg' && H.extOf('audio/mp4') === 'm4a' && H.extOf('audio/wav') === 'wav' && H.extOf('video/webm') === null && H.extOf('') === null);
  ok('Whisper: segments it is sure were silence are dropped ("Thank you." over silence)', H.whisperText({ text: 'Is NVDA a buy? Thank you.', segments: [{ text: ' Is NVDA a buy?', no_speech_prob: 0.02 }, { text: ' Thank you.', no_speech_prob: 0.93 }] }) === 'Is NVDA a buy?');
  ok('...a plain answer (no segments) is its text', H.whisperText({ text: '  Debrief me. ' }) === 'Debrief me.' && H.whisperText(null) === '');

  console.log('\nThe chain');
  env = await mkEnv(); P.reset();
  P.plan[GROQ] = [{ body: { text: 'Is NVDA a buy here?', segments: [{ text: 'Is NVDA a buy here?', no_speech_prob: 0.01 }] } }];
  r = await call(env, CLIP);
  ok('Groq Whisper answers first', r.status === 200 && r.body.text === 'Is NVDA a buy here?' && r.body.provider === 'groq' && r.body.model === H.GROQ_MODEL && r.body.tried.length === 0, JSON.stringify(r.body));
  const f = P.forms[0] || {};
  ok('...sent as a file named for its format, English, the hint as the prompt', f.file && f.file.name === 'speech.webm' && f.file.type === 'audio/webm' && f.file.size > 10 && f.model === 'whisper-large-v3-turbo' && f.language === 'en' && f.response_format === 'verbose_json' && /NVDA/.test(f.prompt), JSON.stringify(f));
  ok('...one call counted on its own ledger line (apart from Groq\'s chat)', (await usage(env))['whisper-groq'] === 1 && !(await usage(env)).groq);

  env = await mkEnv(); P.reset();
  P.plan[GROQ] = [{ status: 429, body: { error: { message: 'rate limit' } } }];
  P.plan[FLASH] = [{ body: gemText('What changed?') }];
  r = await call(env, CLIP);
  ok('Groq refusing, Workers AI not bound: Gemini audio hears it', r.status === 200 && r.body.text === 'What changed?' && r.body.provider === 'gemini' && r.body.model === FLASH, JSON.stringify(r.body));
  ok('...what was tried says why each rung was passed', r.body.tried.map((t) => t.provider + ':' + t.why).join('|') === 'groq:HTTP 429|workersai:Workers AI is not bound (needs Tony\'s yes)', JSON.stringify(r.body.tried));
  const gb = JSON.parse((P.bodies.find((b) => b.key === FLASH) || {}).body || '{}');
  const parts = (gb.contents || [])[0] ? gb.contents[0].parts : [];
  ok('...Gemini got the audio inline (type without its codec) and the transcribe instruction', parts.some((p) => p.inline_data && p.inline_data.mime_type === 'audio/webm' && p.inline_data.data === CLIP.audio) && /Transcribe/.test(JSON.stringify(gb.systemInstruction)), JSON.stringify(gb).slice(0, 300));
  const row = await env.DB.prepare("SELECT caps FROM models WHERE provider = 'gemini' AND id = ?").bind(FLASH).first();
  ok('...and Gemini learned it can do audio (Phase 9\'s ladder bookkeeping)', JSON.parse(row.caps).audio === true, row.caps);

  env = await mkEnv({ GROQ_KEY: 'gk', GEMINI_KEY: 'gm', AI: { run: async (model, input) => { P.calls.push('ai:' + model); P.wai = input; return { text: 'Debrief me.', segments: [{ text: 'Debrief me.', no_speech_prob: 0.1 }] }; } } }); P.reset();
  P.plan[GROQ] = [{ status: 500 }];
  r = await call(env, CLIP);
  ok('Groq down, Workers AI bound: Workers AI Whisper hears it', r.status === 200 && r.body.text === 'Debrief me.' && r.body.provider === 'workersai' && P.calls.includes('ai:@cf/openai/whisper-large-v3-turbo') && P.wai.audio === CLIP.audio && /NVDA/.test(P.wai.initial_prompt), JSON.stringify(r.body));
  ok('...each rung counted', (await usage(env))['whisper-groq'] === 1 && (await usage(env))['whisper-workersai'] === 1, JSON.stringify(await usage(env)));

  env = await mkEnv(); P.reset();
  P.plan[GROQ] = [{ status: 500 }]; P.plan[FLASH] = [{ status: 429, body: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' }]; P.plan[LITE] = [{ status: 503 }];
  r = await call(env, CLIP);
  ok('every rung failing: 503, what was tried for each, never a made-up transcript', r.status === 503 && r.body.ok === false && /nothing could transcribe/.test(r.body.error) && r.body.tried.map((t) => t.provider).join() === 'groq,workersai,gemini' && /gemini-3\.8-flash/.test(r.body.tried[2].why) && !('text' in r.body), JSON.stringify(r.body));

  env = await mkEnv({}); P.reset();
  r = await call(env, CLIP);
  ok('no key for any rung: 503 that says so', r.status === 503 && r.body.tried.map((t) => t.why).join('|') === 'no GROQ_KEY|Workers AI is not bound (needs Tony\'s yes)|no GEMINI_KEY' && P.calls.length === 0, JSON.stringify(r.body));

  env = await mkEnv(); P.reset();
  P.plan[GROQ] = [{ body: { text: 'Thank you.', segments: [{ text: 'Thank you.', no_speech_prob: 0.95 }] } }];
  r = await call(env, CLIP);
  ok('nobody spoke: an empty transcript from the first rung (no other rung is spent on silence)', r.status === 200 && r.body.text === '' && r.body.provider === 'groq' && P.calls.length === 1);

  console.log('\nRefused');
  env = await mkEnv(); P.reset();
  ok('no Orca key → 401', (await call(env, CLIP, { key: null })).status === 401);
  ok('no audio → 400', (await call(env, { mime: 'audio/webm' })).status === 400);
  ok('not base64 → 400', (await call(env, { audio: 'not base64!!', mime: 'audio/webm' })).status === 400);
  ok('not an audio type → 400', (await call(env, { audio: CLIP.audio, mime: 'video/mp4' })).status === 400);
  ok('a clip past the cap → 413', (await call(env, { audio: 'A'.repeat(H.AUDIO_MAX + 10), mime: 'audio/webm' })).status === 413);
  ok('...none of them reached a provider', P.calls.length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
