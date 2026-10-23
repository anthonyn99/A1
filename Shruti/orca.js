// Shruti's only AI backend: Orca, with each person's own pasted key.
// OpenAI-shaped: GET /v1/models (with Orca's `routable`), POST /v1/chat/completions.
// A `model` is always sent explicitly, and the client runs its own fallback
// chain over the units the person ticked, in their order:
//   404 or another non-OK status  -> the next unit
//   401 / 403                     -> stop: the key is wrong
//   429 / 503                     -> wait out Retry-After once (max 20 s), then the next unit

export const ORCA = 'https://orca.vedapatel05.workers.dev/v1';

// MAGI's names for the units. Claude is selectable but off by default, so
// nothing lands on it unless ticked. Groq only shows when Orca routes it.
export const UNITS = [
  { id: 'deepseek/free', name: 'DeepSeek', on: true },
  { id: 'chatgpt/free', name: 'ChatGPT', on: true },
  { id: 'gemini_web/free', name: 'Gemini', on: true },
  { id: 'perplexity/free', name: 'Perplexity', on: true },
  { id: 'groq/gpt-oss-120b', name: 'Groq', on: true, optional: true },
  { id: 'claude/free', name: 'Claude', on: false },
];

export const looksLikeKey = (k) => /^orca_sk_[\w-]{8,}$/.test(String(k || '').trim());

/** Check a key live. Resolves {ok, models} or {ok:false, status, error}. */
export async function checkKey(key, { fetch: f = fetch, signal } = {}) {
  key = String(key || '').trim();
  if (!looksLikeKey(key)) return { ok: false, status: 0, error: 'That does not look like an Orca key (it starts with orca_sk_).' };
  let r;
  try { r = await f(ORCA + '/models', { headers: { authorization: 'Bearer ' + key }, signal }); }
  catch (e) { return { ok: false, status: 0, error: 'Orca could not be reached. Check the connection and try again.' }; }
  if (r.status === 401 || r.status === 403) return { ok: false, status: r.status, error: 'Orca rejected this key.' };
  if (!r.ok) return { ok: false, status: r.status, error: 'Orca answered ' + r.status + '. Try again in a moment.' };
  const j = await r.json().catch(() => ({}));
  const models = Array.isArray(j.data) ? j.data : [];
  return { ok: true, models };
}

/* ── what Orca says this key can use, once per key per page ─────────────── */
// Settings, Make with AI, Study and Import all read the same answer, so a unit
// shows the same state everywhere and a run never starts blind.
let asked = { key: null, models: null, at: 0, pending: null, rejected: false };
/** The last /models answer for this key (null when not asked yet). */
export const cachedModels = (key) => (asked.key === String(key || '').trim() ? asked.models : null);
/** Ask Orca, or reuse an answer under 5 minutes old. Resolves checkKey's result. */
export function models(key, { fresh = false, fetch: f } = {}) {
  key = String(key || '').trim();
  if (!fresh && asked.key === key && asked.models && Date.now() - asked.at < 5 * 60e3) return Promise.resolve({ ok: true, models: asked.models });
  if (!fresh && asked.key === key && asked.pending) return asked.pending;
  const p = checkKey(key, f ? { fetch: f } : {}).then((r) => {
    if (asked.key !== key) return r;
    if (r.ok) asked = { key, models: r.models, at: Date.now(), pending: null, rejected: false };
    else asked = { key, models: null, at: 0, pending: null, rejected: r.status === 401 || r.status === 403 };
    return r;
  });
  asked = { key, models: asked.key === key ? asked.models : null, at: asked.key === key ? asked.at : 0, pending: p, rejected: false };
  return p;
}
/** Forget the answer (the key was removed or replaced). */
export function forget() { asked = { key: null, models: null, at: 0, pending: null, rejected: false }; }

/** The picker's rows: the person's order and ticks over what Orca reports.
 *  prefs = {order:[ids], on:{id:bool}}; models = /models data (or null when unknown). */
export function unitRows(prefs, models) {
  prefs = prefs || {};
  const known = new Map((models || []).map((m) => [m.id, m]));
  const order = (prefs.order || []).filter((id) => UNITS.some((u) => u.id === id));
  UNITS.forEach((u) => { if (!order.includes(u.id)) order.push(u.id); });
  return order.map((id) => {
    const u = UNITS.find((x) => x.id === id);
    const m = known.get(id);
    const on = prefs.on && id in prefs.on ? !!prefs.on[id] : u.on;
    // in_key_scope:false = Orca has the unit but this key may not use it (the
    // key is limited on Orca's Keys page), which is not the same as offline.
    const status = !models ? 'unknown' : !m ? 'missing' : m.in_key_scope === false ? 'scope' : m.routable ? 'ready' : 'offline';
    return { id, name: u.name, on, status, optional: !!u.optional };
  // An optional unit (Groq) only shows once Orca says it routes it, or after the person ticked it.
  }).filter((r) => !(r.optional && (r.status === 'missing' || r.status === 'unknown') && !(prefs.on && prefs.on[r.id])));
}
/** A row's status in words, the same in Settings and every maker. */
export const STATUS = { ready: 'ready', offline: 'offline', missing: 'not on Orca', scope: 'not allowed on this key', unknown: '' };
const usable = (r) => r.status === 'ready' || r.status === 'unknown';

/** The models to try, in order: ticked, and routable when that is known.
 *  When none is ready, the ticked offline ones are still tried (one may be
 *  back by now); a unit the key may not use never is. */
export function chain(prefs, models) {
  const rows = unitRows(prefs, models).filter((r) => r.on);
  const ready = rows.filter(usable);
  return (ready.length ? ready : rows.filter((r) => r.status === 'offline')).map((r) => r.id);
}

const NAME = Object.fromEntries(UNITS.map((u) => [u.id, u.name]));
const names = (rows) => rows.map((r) => r.name).join(', ').replace(/, ([^,]*)$/, ' and $1');

/** Why the AI cannot run, said before anything is sent. null when it can,
 *  else {code, title, text, action: 'settings'}. mdl = cachedModels(key). */
export function preflight(key, prefs, mdl) {
  key = String(key || '').trim();
  if (!key) return { code: 'nokey', title: 'Your Orca key is needed', text: 'Every AI feature runs through Orca with your own key. Paste it once in Settings and it works on all your devices.', action: 'settings' };
  if (asked.rejected && asked.key === key) return explain({ code: 'key' });
  const on = unitRows(prefs, mdl).filter((r) => r.on);
  if (!on.length) return { code: 'none', title: 'No AI units are ticked', text: 'Tick at least one unit in Settings: DeepSeek, ChatGPT, Gemini or Perplexity.', action: 'settings' };
  if (mdl && !on.some((r) => r.status === 'ready' || r.status === 'offline')) {
    const scope = on.filter((r) => r.status === 'scope');
    return { code: 'scope', title: 'Your key may not use these units',
      text: (scope.length ? names(scope) + (scope.length > 1 ? ' are' : ' is') + ' not allowed on this key. ' : 'None of the ticked units is on Orca. ') +
        'Tick another unit in Settings, or allow more models for the key on Orca\'s Keys page.', action: 'settings' };
  }
  return null;
}

/** An error from chat(), speak() or preflight() as {code, title, text, action}:
 *  action 'settings' (the fix is there) or 'retry'. */
export function explain(e) {
  const code = e && e.code;
  if (code === 'abort') return { code, title: 'Cancelled', text: 'Cancelled.', action: null };
  if (code === 'key') return { code, title: 'Orca rejected your key', text: 'It may have been deleted or changed on Orca\'s Keys page. Paste a working key in Settings.', action: 'settings' };
  if (e && e.title && e.text) return e;
  if (code === 'none' && Array.isArray(e.tried) && e.tried.length) {
    if (e.tried.every((t) => /: unreachable$/.test(t))) return { code: 'net', title: 'Orca could not be reached', text: 'Check the connection and try again.', action: 'retry' };
    const why = (w) => (/^(429|503)$/.test(w) ? 'busy' : /^(500|502|504)$/.test(w) ? 'offline' : w === '404' ? 'not on Orca' : w);
    const each = e.tried.map((t) => { const i = t.indexOf(': '); const id = t.slice(0, i); return (NAME[id] || id) + ' ' + why(t.slice(i + 2)); });
    return { code: 'down', title: 'No unit could answer just now', text: 'Tried ' + each.join(', ') + '. Try again in a minute, or tick another unit in Settings.', action: 'retry' };
  }
  if (code === 'none') return { code, title: 'No AI units are ticked', text: 'Tick at least one unit in Settings.', action: 'settings' };
  return { code: code || 'error', title: 'It stopped', text: (e && e.message) || String(e), action: 'retry' };
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

/** Chat through the chain. onDelta(text) streams; resolves {text, model}.
 *  messages: OpenAI-shaped. Throws {code:'key'|'none'|'abort', message}. */
export async function chat({ key, messages, models, onDelta, onModel, signal, fetch: f = fetch, temperature }) {
  if (!models || !models.length) throw Object.assign(new Error('No AI units are ticked in Settings.'), { code: 'none' });
  const tried = [];
  for (const model of models) {
    let waited = false;
    for (;;) {
      let r;
      try {
        r = await f(ORCA + '/chat/completions', {
          method: 'POST', signal,
          headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages, stream: true, ...(temperature != null ? { temperature } : {}) }),
        });
      } catch (e) {
        if (e && e.name === 'AbortError') throw Object.assign(new Error('Cancelled'), { code: 'abort' });
        tried.push(model + ': unreachable'); break;
      }
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Orca rejected the key. Check it in Settings.'), { code: 'key' });
      if ((r.status === 429 || r.status === 503) && !waited) {
        waited = true;
        const s = Math.min(20, Math.max(1, Number(r.headers.get('retry-after')) || 5));
        await sleep(s * 1000, signal);
        continue;
      }
      if (!r.ok) { tried.push(model + ': ' + r.status); break; }
      if (onModel) onModel(model);
      // A unit that fails mid-stream (Orca sends an error frame, or the
      // stream just ends empty) is a failed unit: the chain moves on.
      let text;
      try { text = await readStream(r, onDelta); }
      catch (e) {
        if (e && e.name === 'AbortError') throw Object.assign(new Error('Cancelled'), { code: 'abort' });
        tried.push(model + ': ' + (e && e.message || 'failed')); break;
      }
      if (!String(text || '').trim()) { tried.push(model + ': empty reply'); break; }
      return { text, model };
    }
  }
  throw Object.assign(new Error('No unit could answer (' + tried.join(', ') + ').'), { code: 'none', tried });
}

/* ── speech: POST /v1/audio/speech with timestamps (Edge neural voices) ───── */
// Read-aloud's default (Tony, 2026-10-22: Libby, "another elegant female" than
// Sonia, who hosts the podcasts and narrates the videos).
export const DEFAULT_VOICE = 'en-GB-LibbyNeural';
/** Used when /audio/voices cannot be asked (no key yet): the same vetted set. */
export const VOICES = [
  ['en-US-AvaMultilingualNeural', 'Ava', 'en-US', 'female'], ['en-US-AndrewMultilingualNeural', 'Andrew', 'en-US', 'male'],
  ['en-US-EmmaMultilingualNeural', 'Emma', 'en-US', 'female'], ['en-US-BrianMultilingualNeural', 'Brian', 'en-US', 'male'],
  ['en-US-JennyNeural', 'Jenny', 'en-US', 'female'], ['en-US-GuyNeural', 'Guy', 'en-US', 'male'],
  ['en-US-AriaNeural', 'Aria', 'en-US', 'female'], ['en-US-ChristopherNeural', 'Christopher', 'en-US', 'male'],
  ['en-US-MichelleNeural', 'Michelle', 'en-US', 'female'], ['en-US-SteffanNeural', 'Steffan', 'en-US', 'male'],
  ['en-GB-SoniaNeural', 'Sonia', 'en-GB', 'female'], ['en-GB-RyanNeural', 'Ryan', 'en-GB', 'male'],
  ['en-GB-LibbyNeural', 'Libby', 'en-GB', 'female'], ['en-GB-ThomasNeural', 'Thomas', 'en-GB', 'male'],
  ['en-AU-NatashaNeural', 'Natasha', 'en-AU', 'female'], ['en-AU-WilliamMultilingualNeural', 'William', 'en-AU', 'male'],
  ['en-IN-NeerjaNeural', 'Neerja', 'en-IN', 'female'], ['en-IN-PrabhatNeural', 'Prabhat', 'en-IN', 'male'],
  ['en-IE-EmilyNeural', 'Emily', 'en-IE', 'female'], ['en-IE-ConnorNeural', 'Connor', 'en-IE', 'male'],
].map(([id, name, locale, gender]) => ({ id, name, locale, gender, engine: 'edge' }));

export async function voices(key, { fetch: f = fetch } = {}) {
  try {
    const r = await f(ORCA + '/audio/voices', { headers: { authorization: 'Bearer ' + key } });
    if (!r.ok) return VOICES;
    const j = await r.json();
    return Array.isArray(j.voices) && j.voices.length ? j.voices : VOICES;
  } catch (e) { return VOICES; }
}

const b64ToBytes = (b64) => { const s = atob(b64); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };

/* ── how words are said (Shruti/lexicon.json, shared with tools/speech.py) ── */
// A word an English voice gets wrong (Sanjaya, Kurukshetra, sattva…) is sent
// respelled; the word timings come back with the true spelling, one word for
// one word, so captions and highlighting still line up with the text.
let lexP = null;
export function lexicon(f = fetch) {
  if (!lexP) lexP = Promise.resolve().then(() => f(new URL('lexicon.json', import.meta.url).href)).then((r) => (r && r.ok ? r.json() : {})).catch(() => ({}))
    .then((j) => { const o = Object.assign({}, j); delete o._; return o; });
  return lexP;
}
const WORD = /[A-Za-z]+/g;
const lexKey = (w, lex) => (w in lex ? w : ((w[0] === w[0].toUpperCase() ? w[0].toLowerCase() : w[0].toUpperCase()) + w.slice(1)) in lex ? (w[0] === w[0].toUpperCase() ? w[0].toLowerCase() : w[0].toUpperCase()) + w.slice(1) : null);
/** {said, back}: the text as the voice says it, and spoken -> written words. */
export function respell(text, lex) {
  const back = {};
  const said = String(text).replace(WORD, (w) => {
    const k = lexKey(w, lex);
    if (!k) return w;
    let s = lex[k];
    if ((w[0] === w[0].toUpperCase()) !== (s[0] === s[0].toUpperCase())) s = (w[0] === w[0].toUpperCase() ? s[0].toUpperCase() : s[0].toLowerCase()) + s.slice(1);
    back[s.toLowerCase()] = w;
    return s;
  });
  return { said, back };
}
export function unspell(words, back) {
  if (!words || !Object.keys(back).length) return words;
  return words.map(([t, d, w]) => [t, d, String(w).replace(/[A-Za-z]+/, (m) => back[m.toLowerCase()] || m)]);
}

/** Speak text: resolves {audio: Blob (mp3), words: [[t, d, w]] | null, engine, voice}.
 *  Throws {code:'key'} for a refused key, {code:'abort'}, else {code:'tts'}. */
export async function speak({ key, text, voice, signal, fetch: f = fetch }) {
  if (!key) throw Object.assign(new Error('Read-aloud needs your Orca key (Settings).'), { code: 'key' });
  const { said, back } = respell(text, await lexicon());
  let waited = false;
  for (;;) {
    let r;
    try {
      r = await f(ORCA + '/audio/speech', {
        method: 'POST', signal,
        headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'edge-neural', input: said, voice: voice || DEFAULT_VOICE, timestamps: true }),
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw Object.assign(new Error('Cancelled'), { code: 'abort' });
      throw Object.assign(new Error('Orca could not be reached.'), { code: 'tts' });
    }
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Orca rejected the key. Check it in Settings.'), { code: 'key' });
    if ((r.status === 429 || r.status === 503 || r.status === 502) && !waited) {
      waited = true;
      await sleep(Math.min(10, Math.max(1, Number(r.headers.get('retry-after')) || 2)) * 1000, signal);
      continue;
    }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw Object.assign(new Error((j.error && j.error.message) || 'Orca answered ' + r.status), { code: 'tts', status: r.status });
    }
    const j = await r.json();
    return { audio: new Blob([b64ToBytes(j.audio)], { type: 'audio/mpeg' }), words: Array.isArray(j.words) ? unspell(j.words, back) : null, engine: j.engine, voice: j.voice };
  }
}

/* ── exact clips: what a podcast, video or saved narration is built from ── */
// A made episode or video is timed from byte counts (Edge's MP3 is 24 kHz mono
// 48 kbps, 144-byte frames: 6000 bytes a second) and its captions from Edge's
// word timings. A clip from the fallback voice (Aura: another bitrate, no
// timings) would throw every time after it off (Tony, 2026-10-22: a video's
// voice and captions did not match). So a build takes only clips that are
// whole Edge frames with timings, asks again when one is not, and says so
// plainly if the voice service keeps refusing; it never mixes them.
export const FRAME = 144, BYTES_PER_SECOND = 6000;
/** Whole frames of Edge's format: MPEG-2 layer III, 24 kHz, 48 kbps. */
export function edgeClip(bytes) {
  return !!bytes && bytes.length >= FRAME && bytes.length % FRAME === 0 && bytes[0] === 0xff && (bytes[1] & 0xfe) === 0xf2 && (bytes[2] >> 4) === 6;
}
/** Words that fit inside the clip (a timing past its end is not Edge's). */
const wordsFit = (words, dur) => Array.isArray(words) && words.length > 0 && words.every((w) => w[0] >= 0 && w[0] <= dur + 0.25);
/** Speak one clip for a build: {bytes, words, voice}. speak = O.speak or a test's. */
export async function speakExact(speakFn, args, { tries = 4, wait = 1500 } = {}) {
  let last = null;
  for (let k = 0; k < tries; k++) {
    if (k) await sleep(wait * 2 ** (k - 1), args.signal);
    const r = await speakFn(args);
    const bytes = new Uint8Array(await r.audio.arrayBuffer());
    if (r.engine === 'edge' && edgeClip(bytes) && wordsFit(r.words, bytes.length / BYTES_PER_SECOND)) return { bytes, words: r.words, voice: r.voice };
    last = r.engine !== 'edge' ? 'the fallback voice answered' : !edgeClip(bytes) ? 'the audio was not whole frames' : 'the word timings did not fit';
  }
  throw Object.assign(new Error('The voice service kept giving audio that cannot be timed exactly (' + last + '), so nothing was built. Try again in a minute.'), { code: 'tts' });
}

/** OpenAI SSE (data: {...choices[0].delta.content}) or a plain JSON reply. */
export async function readStream(r, onDelta) {
  const ct = r.headers.get('content-type') || '';
  if (!/event-stream/.test(ct) || !r.body) {
    const j = await r.json().catch(() => ({}));
    const t = (j.choices && j.choices[0] && (j.choices[0].message || {}).content) || '';
    if (onDelta && t) onDelta(t);
    return t;
  }
  const rd = r.body.getReader(), dec = new TextDecoder();
  let buf = '', out = '';
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') return out;
      try {
        const j = JSON.parse(d);
        if (j.error) throw Object.assign(new Error(String(j.error.message || j.error)), { orca: true });
        const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (t) { out += t; if (onDelta) onDelta(t); }
      } catch (e) { if (e && e.orca) throw e; }
    }
  }
  return out;
}
