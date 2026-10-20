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
    const status = !models ? 'unknown' : !m ? 'missing' : m.routable ? 'ready' : 'offline';
    return { id, name: u.name, on, status, optional: !!u.optional };
  // An optional unit (Groq) only shows once Orca says it routes it, or after the person ticked it.
  }).filter((r) => !(r.optional && (r.status === 'missing' || r.status === 'unknown') && !(prefs.on && prefs.on[r.id])));
}

/** The models to try, in order: ticked, and routable when that is known. */
export function chain(prefs, models) {
  const rows = unitRows(prefs, models).filter((r) => r.on);
  const ready = rows.filter((r) => r.status === 'ready' || r.status === 'unknown');
  return (ready.length ? ready : rows).map((r) => r.id);
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
      const text = await readStream(r, onDelta);
      return { text, model };
    }
  }
  throw Object.assign(new Error('No unit could answer (' + tried.join(', ') + ').'), { code: 'none', tried });
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
        const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (t) { out += t; if (onDelta) onDelta(t); }
      } catch (e) {}
    }
  }
  return out;
}
