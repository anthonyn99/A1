// workers3/quant-hear (Cloudflare account 3): Neo Quant's hearing backup.
// The shared key is required (compared whole), bad bodies are refused before
// Workers AI is asked, a good clip goes to Whisper with the hint, Workers AI
// failing (the free allowance spent) is a 502 with its reason, nothing else
// is served; the account-3 lane is wired (package.json, workflow, layout).
//
// Run: node tests/quant-hear-worker.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'workers3', 'quant-hear');

(async () => {
  const W = (await import(pathToFileURL(path.join(DIR, 'worker.js')).href)).default;
  const runs = [];
  const AI = { run: async (model, input) => { runs.push({ model, input }); if (AI.fail) throw new Error('4006: you have used up your daily free allocation of 10,000 neurons'); return { text: ' Is NVDA a buy here? ', segments: [{ text: ' Is NVDA a buy here?', no_speech_prob: 0.02, words: [] }] }; } };
  const env = { HEAR_SECRET: 'hs_live_abc123', AI };
  const call = async (p, { method = 'POST', key = 'hs_live_abc123', body, e = env } = {}) => {
    const r = await W.fetch(new Request('https://quant-hear.test' + p, { method, headers: { ...(key ? { 'x-hear-key': key } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), e);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const CLIP = { audio: Buffer.from('opus bytes').toString('base64'), initial_prompt: 'Tickers: NVDA.' };

  console.log('\nWho may ask');
  ok('GET /health answers with no key', (await call('/health', { method: 'GET', key: null })).status === 200);
  ok('no key → 403, Workers AI not asked', (await call('/whisper', { key: null, body: CLIP })).status === 403 && runs.length === 0);
  ok('a wrong key (same length too) → 403', (await call('/whisper', { key: 'hs_live_abc124', body: CLIP })).status === 403 && (await call('/whisper', { key: 'x', body: CLIP })).status === 403 && runs.length === 0);
  ok('HEAR_SECRET not set → 503 (never open)', (await call('/whisper', { body: CLIP, e: { AI } })).status === 503);

  console.log('\nThe clip');
  ok('not JSON → 400; no audio → 400; not base64 → 400; too long → 400 or 413', (await call('/whisper', { body: 'nope' })).status === 400 && (await call('/whisper', { body: {} })).status === 400
    && (await call('/whisper', { body: { audio: 'not base64!' } })).status === 400 && [400, 413].includes((await call('/whisper', { body: { audio: 'A'.repeat(1_500_100) } })).status) && runs.length === 0);
  let r = await call('/whisper', { body: CLIP });
  ok('a clip: Whisper large v3 turbo hears it, English, with the hint and voice detection', r.status === 200 && r.body.ok && r.body.text === 'Is NVDA a buy here?' && runs[0].model === '@cf/openai/whisper-large-v3-turbo' && runs[0].input.audio === CLIP.audio && runs[0].input.language === 'en' && runs[0].input.initial_prompt === 'Tickers: NVDA.' && runs[0].input.vad_filter === true, JSON.stringify(r.body));
  ok('...segments come back with their no-speech chance only (quant-api drops sure silence)', JSON.stringify(r.body.segments) === JSON.stringify([{ text: ' Is NVDA a buy here?', no_speech_prob: 0.02 }]));
  AI.fail = true;
  r = await call('/whisper', { body: CLIP });
  ok('Workers AI failing (the day\'s allowance spent): 502 with its reason, so quant-api moves on', r.status === 502 && r.body.ok === false && /neurons/.test(r.body.error));
  ok('anything else → 404', (await call('/other', { body: CLIP })).status === 404 && (await call('/whisper', { method: 'GET' })).status === 404);

  console.log('\nThe account-3 lane');
  const toml = fs.readFileSync(path.join(DIR, 'wrangler.toml'), 'utf8'), pkg = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));
  ok('wrangler.toml: named, an entry point, the AI binding, no account_id (the workflow supplies it)', /^name = "quant-hear"/m.test(toml) && /^main = /m.test(toml) && /\[ai\]\s*\nbinding = "AI"/.test(toml) && !/^\s*account_id/m.test(toml));
  ok('package.json pins wrangler v4 (the workflow hard-errors without it)', /^\^?4/.test(pkg.devDependencies.wrangler));
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-workers3.yml'), 'utf8');
  ok('deploy-workers3.yml deploys workers3/ with account 3\'s token, and skips cleanly without it', /- 'workers3\/\*\*'/.test(wf) && /CF_API_TOKEN_3/.test(wf) && /CF_ACCOUNT_ID_3/.test(wf) && /ready=false/.test(wf));
  const layout = JSON.parse(fs.readFileSync(path.join(ROOT, 'Rules', 'layout.json'), 'utf8'));
  ok('Rules/layout.json lists workers3', JSON.stringify(layout).includes('"workers3"'));
  ok('quant-api reaches it by HEAR_URL (a var) and HEAR_SECRET (a secret), with no AI binding of its own', /HEAR_URL\s*=\s*"https:\/\/quant-hear\./.test(fs.readFileSync(path.join(ROOT, 'workers2', 'quant-api', 'wrangler.toml'), 'utf8')) && !/^\[ai\]/m.test(fs.readFileSync(path.join(ROOT, 'workers2', 'quant-api', 'wrangler.toml'), 'utf8')));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
