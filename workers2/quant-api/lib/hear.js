// Neo Quant's hearing (A1-Priv docs/TradeHub/quant/phase-10.md).
//
//   POST /ai/hear { audio: base64, mime: 'audio/webm;codecs=opus', watchlist?: ['NVDA', …] }
//        → { ok, text, provider, model, ms, tried }   (text '' = nobody spoke)
//
// Brave has no speech recognition of its own, so the page records Tony and
// sends the clip here. The chain, each rung through the ledger (spend()):
//   1. Groq Whisper (whisper-large-v3-turbo; GROQ_KEY; its own allowance, apart from Groq's chat)
//   2. Workers AI Whisper on Cloudflare account 3 (A1 workers3/quant-hear; HEAR_URL + HEAR_SECRET)
//   3. Gemini audio (lib/gemini.js, job `hear`: Phase 9's ladder)
// A prompt hint lists the watchlist's tickers and the trading terms, so
// "NVDA" and "VWAP" come back spelled right more often (the page's fixTerms
// snaps the rest). Every rung failing is said so, with what was tried.
import { fail, json } from './http.js';
import { bodyOf } from './charts.js';
import { Ledger } from './ledger.js';
import { askWhole } from './gemini.js';

export const AUDIO_MAX = 1_500_000;   // base64 characters: 45 s of opus at 32 kbps is about 240 KB
export const GROQ_STT = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const GROQ_MODEL = 'whisper-large-v3-turbo', WAI_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const TIMEOUT_MS = 15_000;
// A Whisper segment this sure that nobody spoke is dropped (Whisper writes "Thank you." over silence).
export const NO_SPEECH = 0.8;
export const TERMS = ['VWAP', 'ATR', 'RSI', 'MACD', 'EMA', 'SMA', 'GO', 'NO-GO', 'WATCH', 'R1', 'S1', 'stop', 'target', 'breakout', 'pullback', 'premarket', 'Neo Quant'];
const TYPES = { webm: 'webm', ogg: 'ogg', mp4: 'm4a', m4a: 'm4a', mpeg: 'mp3', mp3: 'mp3', wav: 'wav', 'x-wav': 'wav', flac: 'flac' };
const SYM = /^[A-Z][A-Z.]{0,5}$/;

/** The words the transcriber is told to expect (Whisper reads at most ~224 tokens of it). */
export function hint(watchlist = []) {
  const syms = [...new Set((Array.isArray(watchlist) ? watchlist : []).map((s) => String(s).toUpperCase()).filter((s) => SYM.test(s)))].slice(0, 40);
  return ('A trader talking to Neo Quant about stocks. Terms: ' + TERMS.join(', ') + '.' + (syms.length ? ' Tickers: ' + syms.join(', ') + '.' : '')).slice(0, 700);
}
/** The clip's type → the file extension Groq reads the format from, or null when it is not audio we take. */
export function extOf(mime) {
  const m = /^audio\/([\w.+-]+)(?:;.*)?$/i.exec(String(mime || '').trim());
  return m ? TYPES[m[1].toLowerCase()] || null : null;
}
/** Whisper's verbose answer → the words said, the segments it is sure were silence left out. */
export function whisperText(j) {
  if (!j || typeof j !== 'object') return '';
  if (Array.isArray(j.segments) && j.segments.length) return j.segments.filter((s) => !(Number(s.no_speech_prob) > NO_SPEECH)).map((s) => String(s.text || '').trim()).filter(Boolean).join(' ').trim();
  return String(j.text || '').trim();
}
const b64bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/* ── the rungs ───────────────────────────────────────────────────────────── */
async function groq(env, L, clip) {
  const svc = 'whisper-groq';
  if (!env.GROQ_KEY) return { skip: true, why: 'no GROQ_KEY' };
  const blocked = L.blocked(svc);
  if (blocked) return { why: blocked };
  if (!L.spend(svc)) return { why: 'at its daily cap' };
  const t0 = Date.now();
  let status = null;
  try {
    const fd = new FormData();
    fd.append('file', new Blob([clip.bytes], { type: clip.mime }), 'speech.' + clip.ext);
    fd.append('model', GROQ_MODEL);
    fd.append('language', 'en');
    fd.append('temperature', '0');
    fd.append('response_format', 'verbose_json');
    fd.append('prompt', clip.hint);
    const r = await fetch(GROQ_STT, { method: 'POST', headers: { authorization: 'Bearer ' + env.GROQ_KEY }, body: fd, signal: AbortSignal.timeout(TIMEOUT_MS) });
    status = r.status;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = whisperText(await r.json());
    L.note(svc, true, status, Date.now() - t0);
    return { ok: true, text, provider: 'groq', model: GROQ_MODEL };
  } catch (e) {
    const why = e && e.name === 'TimeoutError' ? 'timed out after ' + TIMEOUT_MS / 1000 + ' s' : (e && e.message) || String(e);
    L.note(svc, false, status, null, why);
    return { why };
  }
}
// Workers AI Whisper. Normally through A1 workers3/quant-hear on Cloudflare account 3 (HEAR_URL +
// HEAR_SECRET; its own allowance), so quant-api needs no `AI` binding: that binding would also turn on
// Workers AI's chat model in Neo Quant's answer chain (lib/ai.js PROVIDERS) and meter account 2.
async function workersAi(env, L, clip) {
  const svc = 'whisper-workersai';
  const remote = !!(env.HEAR_URL && env.HEAR_SECRET);
  if (!remote && !env.AI) return { skip: true, why: 'Workers AI hearing is not set up (HEAR_URL / HEAR_SECRET)' };
  const blocked = L.blocked(svc);
  if (blocked) return { why: blocked };
  if (!L.spend(svc)) return { why: 'at its daily cap' };
  const t0 = Date.now();
  let status = null;
  try {
    let out;
    if (remote) {
      const r = await fetch(String(env.HEAR_URL).replace(/\/+$/, '') + '/whisper', { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'content-type': 'application/json', 'x-hear-key': env.HEAR_SECRET }, body: JSON.stringify({ audio: clip.b64, language: 'en', initial_prompt: clip.hint }) });
      status = r.status;
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) throw new Error((j && j.error ? String(j.error).slice(0, 120) + ' ' : '') + '(HTTP ' + r.status + ')');
      out = j;
    } else {
      out = await Promise.race([
        env.AI.run(WAI_MODEL, { audio: clip.b64, language: 'en', initial_prompt: clip.hint, vad_filter: true }),
        new Promise((_, no) => setTimeout(() => no(new Error('timed out after ' + TIMEOUT_MS / 1000 + ' s')), TIMEOUT_MS)),
      ]);
    }
    const text = whisperText(out);
    L.note(svc, true, status || 200, Date.now() - t0);
    return { ok: true, text, provider: 'workersai', model: WAI_MODEL };
  } catch (e) {
    const why = e && e.name === 'TimeoutError' ? 'timed out after ' + TIMEOUT_MS / 1000 + ' s' : (e && e.message) || String(e);
    L.note(svc, false, status, null, why);
    return { why };
  }
}
async function gemini(env, L, clip) {
  if (!env.GEMINI_KEY) return { skip: true, why: 'no GEMINI_KEY' };
  let r;
  // Google's model list or the models table failing must not lose what the other rungs tried.
  try { r = await askWhole(env, L, {
    system: 'Transcribe the speech in this audio exactly, in English. Write only the words said: no notes, no quotes, no timestamps. If nobody speaks, write nothing. ' + clip.hint,
    messages: [{ role: 'user', content: 'Transcribe this clip.' }],
    images: [{ mime: clip.mime, data: clip.b64 }],
    max_tokens: 400, temperature: 0,
  }, 'hear'); } catch (e) { return { why: (e && e.message) || String(e) }; }
  if (r.ok) return { ok: true, text: String(r.text || '').trim(), provider: 'gemini', model: r.model, tried: r.tried };
  return { why: (r.tried && r.tried.length ? r.tried.map((t) => (t.model || 'gemini') + ': ' + t.why).join('; ') : 'no model could take it').slice(0, 300), tried: r.tried };
}
export const RUNGS = [['groq', groq], ['workersai', workersAi], ['gemini', gemini]];

/* ── the route ───────────────────────────────────────────────────────────── */
export async function hear(env, req) {
  const b = await bodyOf(req, AUDIO_MAX + 4000);
  const audio = b && typeof b.audio === 'string' ? b.audio : '';
  if (!audio || !/^[A-Za-z0-9+/=]+$/.test(audio)) throw fail(400, 'audio (base64) is needed');
  if (audio.length > AUDIO_MAX) throw fail(413, 'a clip is at most ' + AUDIO_MAX + ' base64 characters (about 45 s)');
  const ext = extOf(b.mime);
  if (!ext) throw fail(400, 'mime must be an audio type (webm, ogg, mp4, mpeg, wav, flac)');
  const mime = String(b.mime).split(';')[0].trim().toLowerCase();
  const clip = { b64: audio, bytes: b64bytes(audio), mime, ext, hint: hint(b.watchlist) };
  const L = await Ledger.load(env), t0 = Date.now(), tried = [];
  try {
    for (const [id, rung] of RUNGS) {
      const r = await rung(env, L, clip);
      if (r.ok) return json({ ok: true, text: r.text, provider: r.provider, model: r.model, ms: Date.now() - t0, tried: tried.concat(r.tried || []) });
      tried.push({ provider: id, why: r.why });
    }
  } finally { await L.flush(); }
  throw fail(503, 'nothing could transcribe that', { tried });
}
