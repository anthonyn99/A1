// quant-hear: Neo Quant's hearing backup, on Cloudflare account 3 (Tony, 2026-11-15).
//
//   POST /whisper { audio: base64, initial_prompt?, language? }   header x-hear-key: HEAR_SECRET
//        → { ok, text, segments: [{ text, no_speech_prob }] }
//   GET  /health → { ok }
//
// Only quant-api (account 2, lib/hear.js) calls it, as the Workers AI rung of
// the hearing chain, after Groq Whisper failed. It is its own account so its
// Workers AI allowance (10,000 neurons a day; a 3 s clip is about 2) is never
// shared, and so quant-api needs no `AI` binding (that binding would also turn
// on Workers AI's chat model in Neo Quant's answer chain). It stores nothing.
//
// Secret (wrangler secret put HEAR_SECRET, account 3): the same value as quant-api's HEAR_SECRET.
export const MODEL = '@cf/openai/whisper-large-v3-turbo';
export const AUDIO_MAX = 1_500_000;   // base64 characters, as quant-api's lib/hear.js

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && (p === '/' || p === '/health')) return json({ ok: true, service: 'quant-hear' });
    if (p !== '/whisper' || req.method !== 'POST') return json({ ok: false, error: 'not found' }, 404);
    if (!env.HEAR_SECRET) return json({ ok: false, error: 'HEAR_SECRET is not set' }, 503);
    if (!same(req.headers.get('x-hear-key') || '', env.HEAR_SECRET)) return json({ ok: false, error: 'not allowed' }, 403);
    if (!env.AI) return json({ ok: false, error: 'Workers AI is not bound' }, 503);
    let b;
    try { const t = await req.text(); if (t.length > AUDIO_MAX + 4000) return json({ ok: false, error: 'too large' }, 413); b = JSON.parse(t); }
    catch (e) { return json({ ok: false, error: 'a JSON body is needed' }, 400); }
    const audio = b && typeof b.audio === 'string' ? b.audio : '';
    if (!audio || audio.length > AUDIO_MAX || !/^[A-Za-z0-9+/=]+$/.test(audio)) return json({ ok: false, error: 'audio (base64, at most 45 s) is needed' }, 400);
    try {
      const out = await env.AI.run(MODEL, { audio, language: typeof b.language === 'string' ? b.language.slice(0, 5) : 'en', ...(typeof b.initial_prompt === 'string' ? { initial_prompt: b.initial_prompt.slice(0, 700) } : {}), vad_filter: true });
      const segments = Array.isArray(out && out.segments) ? out.segments.map((s) => ({ text: String(s.text || ''), no_speech_prob: Number(s.no_speech_prob) || 0 })) : undefined;
      return json({ ok: true, text: String((out && out.text) || '').trim(), ...(segments ? { segments } : {}) });
    } catch (e) {
      // The free allowance spent, or the model down: quant-api moves to the next rung.
      return json({ ok: false, error: String((e && e.message) || e).slice(0, 200) }, 502);
    }
  },
};
