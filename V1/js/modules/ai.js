/* ============================================================================
 * StudyOS — AI providers  (topic breakdown engine)
 * ============================================================================
 * ONE call for the rest of the app: generateJSON({ system, prompt, pdf,
 * schema, validate }). Whichever provider Veda picked in AI settings answers
 * it; parsing, validation and the single repair ask are the SAME code for all
 * of them, so a lesson can never be accepted from one provider and rejected
 * from another.
 *
 *   bridge     Claude Pro through the local browser bridge (tools/sos-browser,
 *              mode 'ask'). No API key; spends the subscription.
 *   anthropic  The Claude API with her own key, via the official SDK
 *              (vendored — StudyOS has no bundler).
 *   openai     Any OpenAI-compatible endpoint: OpenAI, OpenRouter, Groq, …
 *              — the base URL is editable.
 *   gemini     Google's Gemini API.
 *
 * ── WHERE KEYS LIVE ───────────────────────────────────────────────────────
 * localStorage on THIS device only (studyos_ai_v1). Never in the synced
 * StudyOS document, never in Firestore, never sent to the bridge. A key in
 * the synced doc would reach every device and every backup of it.
 * ------------------------------------------------------------------------- */

import * as pipeline from './pipeline.js';

const KEY = 'studyos_ai_v1';

export const PROVIDERS = {
  bridge:    { label: 'Claude Pro (local bridge)', needsKey: false },
  anthropic: { label: 'Anthropic API', needsKey: true, defaultModel: 'claude-opus-5-5' },
  openai:    { label: 'OpenAI-compatible', needsKey: true, defaultModel: '',
               defaultBase: 'https://api.openai.com/v1' },
  gemini:    { label: 'Google Gemini', needsKey: true, defaultModel: '' },
  // Her own router (Downloads/ORCA). OpenAI-shaped, but its models take text
  // only, so the PDF goes as extracted text.
  orca:      { label: 'ORCA', needsKey: true, defaultModel: '',
               defaultBase: 'https://orca.vedapatel05.workers.dev/v1' },
};

// Base64 inflates by a third, and the Claude API caps a request at 32 MB.
const MAX_PDF_BYTES = 24 * 1024 * 1024;

export class AIError extends Error {
  constructor(message, { kind = 'ai', retryable = false } = {}) {
    super(message);
    this.kind = kind;
    this.retryable = retryable;
  }
}

// ── Settings ─────────────────────────────────────────────────────────────
function defaults() {
  return {
    provider: pipeline.enabled() && pipeline.isLocalBridge() ? 'bridge' : 'anthropic',
    keys: { anthropic: '', openai: '', gemini: '', orca: '' },
    models: { anthropic: PROVIDERS.anthropic.defaultModel, openai: '', gemini: '', orca: '' },
    baseUrl: { openai: PROVIDERS.openai.defaultBase, orca: PROVIDERS.orca.defaultBase },
  };
}

export function settings() {
  const d = defaults();
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!s || typeof s !== 'object') return d;
    return {
      provider: PROVIDERS[s.provider] ? s.provider : d.provider,
      keys: { ...d.keys, ...(s.keys || {}) },
      models: { ...d.models, ...(s.models || {}) },
      baseUrl: { ...d.baseUrl, ...(s.baseUrl || {}) },
    };
  } catch (e) { return d; }
}

/**
 * Save, then READ BACK. The A1 origin's localStorage has been measured full
 * on Veda's Brave, where setItem throws or silently keeps the old value — a
 * key that "saved" and then vanished would surface later as a baffling 401.
 * Returns { ok, error }.
 */
export function saveSettings(next) {
  const clean = { ...settings(), ...next };
  const raw = JSON.stringify(clean);
  try {
    localStorage.setItem(KEY, raw);
    if (localStorage.getItem(KEY) !== raw) return { ok: false, error: 'the browser did not keep it' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: /quota/i.test(String(e && e.name) + String(e && e.message))
      ? 'this browser’s storage for the site is full' : String((e && e.message) || e) };
  }
}

/** The active provider, model and key — or why it cannot run. */
export function active() {
  const s = settings();
  const id = s.provider;
  const model = id === 'bridge' ? 'claude.ai' : (s.models[id] || PROVIDERS[id].defaultModel || '');
  let problem = '';
  if (id === 'bridge') {
    if (!pipeline.enabled() || !pipeline.isLocalBridge()) problem = 'The Claude Pro provider needs the local bridge switched on in config.';
  } else if (!s.keys[id]) problem = `Add your ${PROVIDERS[id].label} key in AI settings.`;
  else if (!model && id !== 'orca') problem = `Name a model for ${PROVIDERS[id].label} in AI settings.`;
  return { id, label: PROVIDERS[id].label, model, key: s.keys[id] || '',
           baseUrl: (s.baseUrl[id] || PROVIDERS[id].defaultBase || '').replace(/\/+$/, ''),
           problem };
}

// ── JSON out of an answer ─────────────────────────────────────────────────
/**
 * Pull ONE JSON object out of a model answer (port of the bridge's
 * kit.extract_json). Tries the LAST ```json fence first — a model that
 * "corrects itself" puts the good copy last — then any fence, then the first
 * balanced object in the raw text.
 */
export function extractJSON(text) {
  if (!text || !String(text).trim()) throw new AIError('empty answer', { kind: 'bad_json' });
  const src = String(text);
  const fences = [...src.matchAll(/```([\w-]*)[^\n]*\n([\s\S]*?)```/g)];
  const cands = [
    ...fences.filter(f => f[1].toLowerCase() === 'json').reverse().map(f => f[2]),
    ...fences.filter(f => f[1].toLowerCase() !== 'json').reverse().map(f => f[2]),
  ];
  const bal = balancedObject(src);
  if (bal) cands.push(bal);
  cands.push(src);

  let lastErr = 'no JSON object found';
  for (let c of cands) {
    c = c.trim().replace(/^\s*json\s*\n/i, '');
    const inner = balancedObject(c) || c;
    for (const attempt of [inner, inner.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        const v = JSON.parse(attempt);
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
        lastErr = 'JSON is not an object';
      } catch (e) { lastErr = 'invalid JSON: ' + e.message; }
    }
  }
  throw new AIError(lastErr, { kind: 'bad_json' });
}

function balancedObject(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

const INLINE_RULE =
  'Reply with ONE fenced code block tagged json and nothing else. Write it ' +
  'inline in the chat — do NOT create an artifact, a file, or a document, and ' +
  'do not add commentary before or after the block.';

export function repairPrompt(error, answer, schemaHint) {
  return 'The text below was meant to be a single valid JSON object but it could not be ' +
    `used (${error}). Fix it and return ONLY the corrected JSON. Keep every item; ` +
    'do not summarise, shorten or drop content.' +
    (schemaHint ? `\n\nThe required shape:\n${schemaHint}` : '') +
    `\n\n${INLINE_RULE}\n\n<broken>\n${String(answer).slice(0, 120000)}\n</broken>`;
}

// ── The one entry point ───────────────────────────────────────────────────
/**
 * @param {object} o
 * @param {string} o.system     instructions (who the model is, the rules)
 * @param {string} o.prompt     the request
 * @param {{b64:string, name:string, size?:number}} [o.pdf]  the source
 * @param {object} o.schema     JSON Schema of the answer
 * @param {(v:object)=>{value?:object, error?:string}} [o.validate]
 * @param {number} [o.maxTokens]
 * @param {string} [o.key]      stable id of this step (bridge cache + resume)
 * @param {string} [o.fileId]
 * @param {string} [o.resumeJobId]  a bridge job already running this step
 * @param {(id:string)=>void} [o.onJob]  told the bridge job id once queued
 * @returns {Promise<{ data:object, provider:string, model:string }>}
 */
export async function generateJSON(o) {
  const a = active();
  if (a.problem) throw new AIError(a.problem, { kind: 'setup' });
  if (o.pdf && o.pdf.size > MAX_PDF_BYTES) {
    throw new AIError('This PDF is over 24 MB — too large to send to a model in one piece.', { kind: 'too_large' });
  }

  const call = (spec) => ADAPTERS[a.id](a, spec);
  const schemaHint = JSON.stringify(o.schema);
  const text = await call({ ...o, attachPdf: true });

  let firstErr;
  try { return { data: checked(extractJSON(text), o.validate), provider: a.id, model: a.model }; }
  catch (e) { firstErr = e; }

  // ONE repair ask, WITHOUT the source: the content is already there and only
  // its shape is wrong. Cheaper and far more reliable than regenerating.
  const fixed = await call({
    system: 'You repair malformed JSON. You never drop or shorten content.',
    prompt: repairPrompt(firstErr.message, text, schemaHint),
    schema: o.schema, maxTokens: o.maxTokens,
    key: o.key ? o.key + ':repair' : '', fileId: o.fileId, attachPdf: false,
    onJob: o.onJob,
  });
  try { return { data: checked(extractJSON(fixed), o.validate), provider: a.id, model: a.model }; }
  catch (e) {
    throw new AIError(`The answer was unusable even after a repair ask (${e.message}).`, { kind: 'bad_json', retryable: true });
  }
}

function checked(obj, validate) {
  if (!validate) return obj;
  const r = validate(obj) || {};
  if (r.error) throw new AIError(r.error, { kind: 'invalid' });
  return r.value || obj;
}

/** One tiny request, to prove the key and model work. */
export async function testConnection() {
  const a = active();
  if (a.problem) throw new AIError(a.problem, { kind: 'setup' });
  if (a.id === 'bridge') {
    const h = await pipeline.health();
    if (!h || !h.ok) throw new AIError('The bridge did not answer.');
    if (!(h.modes || []).includes('ask')) throw new AIError('The bridge is out of date — restart it to load the "ask" mode.');
    return 'Bridge is running.';
  }
  const text = await ADAPTERS[a.id](a, {
    system: '', prompt: 'Reply with the single word OK.', maxTokens: 256, attachPdf: false, test: true,
  });
  return `Connected — ${a.model || a.label} replied “${String(text).trim().slice(0, 40)}”.`;
}

// ── Adapters: (active, spec) → answer text ────────────────────────────────
const ADAPTERS = { bridge: viaBridge, anthropic: viaAnthropic, openai: viaOpenAI, gemini: viaGemini, orca: viaOpenAI };

async function viaBridge(a, spec) {
  const prompt = (spec.system ? spec.system + '\n\n' : '') + spec.prompt + '\n\n' + INLINE_RULE;
  let job = null;

  // Re-attach to a job this step already started (the tab was closed mid-run).
  // Submitting again while it is still queued or running would start a SECOND
  // paid ask: the bridge's cache only answers for jobs that are done.
  if (spec.resumeJobId && spec.attachPdf) {
    try { job = await pipeline.getJob(spec.resumeJobId); } catch (e) { job = null; }
    if (job && job.status === 'error') job = null;
  }
  if (!job) {
    const r = await pipeline.ask({
      fileId: spec.fileId, sourceName: spec.pdf && spec.pdf.name,
      promptId: spec.key || 'ask', promptVersion: hash(prompt),
      prompt, fileB64: spec.attachPdf && spec.pdf ? spec.pdf.b64 : null,
    });
    job = r.job;
    if (spec.onJob && job && job.id) spec.onJob(job.id, !!spec.attachPdf);
  }
  job = await untilSettled(job);
  if (job.status !== 'done') throw new AIError(job.error || 'The bridge job failed.', { kind: 'bridge', retryable: true });
  return job.result || '';
}

function untilSettled(job) {
  if (job && (job.status === 'done' || job.status === 'error') && ('result' in job || job.status === 'error')) {
    return Promise.resolve(job);
  }
  return new Promise((resolve) => {
    const stop = pipeline.watchJob(job.id, (j) => {
      if (j.status === 'done' || j.status === 'error' || j.status === 'canceled') { stop && stop(); resolve(j); }
    });
  });
}

let _sdk = null;
async function anthropicSdk() {
  if (!_sdk) _sdk = import('../../vendor/anthropic-sdk-0.129.0/anthropic-sdk.mjs').then(m => m.default);
  return _sdk;
}

// Models that take adaptive thinking + effort, and the server-side refusal
// fallback. Anything else she types (an older or smaller model) gets a plain
// request rather than a 400.
const MODERN_CLAUDE = /^claude-(opus-(4-[678]|5)|sonnet-(4-6|5)|fable-5|mythos-5)/;
const FALLBACK_OK = /^claude-(opus-5|sonnet-5-5|fable-5-1)/;

async function viaAnthropic(a, spec) {
  const Anthropic = await anthropicSdk();
  const client = new Anthropic({ apiKey: a.key, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const content = [];
  if (spec.attachPdf && spec.pdf) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: spec.pdf.b64 } });
  }
  content.push({ type: 'text', text: spec.prompt });

  const modern = MODERN_CLAUDE.test(a.model);
  const params = {
    model: a.model,
    max_tokens: spec.maxTokens || 64000,
    messages: [{ role: 'user', content }],
    ...(spec.system ? { system: spec.system } : {}),
    ...(modern ? { thinking: { type: 'adaptive' } } : {}),
    output_config: {
      ...(modern ? { effort: spec.test ? 'low' : 'high' } : {}),
      ...(spec.schema ? { format: { type: 'json_schema', schema: spec.schema } } : {}),
    },
  };
  if (!Object.keys(params.output_config).length) delete params.output_config;
  if (FALLBACK_OK.test(a.model)) {
    // A declined request is re-run on a fallback model inside the same call.
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  let msg;
  try {
    msg = await client.beta.messages.stream(params).finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AIError('The Anthropic key was rejected.', { kind: 'auth' });
    if (e instanceof Anthropic.PermissionDeniedError) throw new AIError('This key may not use that model.', { kind: 'auth' });
    if (e instanceof Anthropic.NotFoundError) throw new AIError(`No such model: ${a.model}.`, { kind: 'setup' });
    if (e instanceof Anthropic.RateLimitError) throw new AIError('Rate limited by Anthropic — try again shortly.', { kind: 'rate', retryable: true });
    if (e instanceof Anthropic.BadRequestError) throw new AIError('Anthropic refused the request: ' + (e.message || ''), { kind: 'request' });
    if (e instanceof Anthropic.APIError) throw new AIError(`Anthropic error ${e.status || ''}: ${e.message}`, { kind: 'api', retryable: true });
    throw new AIError('Could not reach Anthropic: ' + ((e && e.message) || e), { kind: 'network', retryable: true });
  }
  if (msg.stop_reason === 'refusal') throw new AIError('The model declined this document.', { kind: 'refusal' });
  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (msg.stop_reason === 'max_tokens' && !spec.test) {
    throw new AIError('The answer hit the length limit before it finished.', { kind: 'too_long', retryable: true });
  }
  return text;
}

let _pdfjs = null;
async function pdfjs() {
  if (!_pdfjs) {
    _pdfjs = import('../../vendor/pdfjs-6.3.289/pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs-6.3.289/pdf.worker.min.mjs', import.meta.url).href;
      return m;
    });
  }
  return _pdfjs;
}

// A run of only bullet glyphs: •, ◼, □, ➢, … and the private-use code points
// Wingdings bullets extract as (or an empty string, which some fonts give).
const BULLET_ONLY = /^[\s•‣⁃■-◿☐-☒✓➢●-–·*-]*$/;

/**
 * pdf.js text items → the page's visual lines, in the order the page draws
 * them: [{ text, h, bullet }]. `h` is the font height (a slide's title is the
 * tallest line); `bullet` means the line opened with a bullet glyph.
 *
 * Superscripts are marked with ^: pdf.js hands "10" and "3" over as separate
 * items, the second smaller and raised, and joining them naively turns
 * "10³ and 2¹⁰" into "103 and 210" — a different number a model will then
 * teach as fact.
 */
export function linesFromItems(items) {
  const lines = [];
  let line = null, brk = true;
  for (const it of items || []) {
    const str = it && typeof it.str === 'string' ? it.str : '';
    const h = Math.abs((it && it.height) || 0);
    const y = it && it.transform ? it.transform[5] : 0;
    if (!h) {                                  // spaces and end-of-line markers
      if (line && str) { line.text += str; if (/\s/.test(str)) line.sup = false; }
      if (it && it.hasEOL) brk = true;
      continue;
    }
    if (line && !brk && Math.abs(y - line.y) <= line.h * 0.6) {
      if (!line.text.trim() && BULLET_ONLY.test(line.text)) { line.text = ''; line.h = h; line.y = y; }
      if (line.text && h < line.h * 0.8 && y - line.y > line.h * 0.15) {
        // "10" "-" "3": one exponent in two items is still ONE ^ (10^-3).
        line.text = line.sup ? line.text + str.trim() : line.text.replace(/\s+$/, '') + '^' + str.trim();
        line.sup = true;
      } else { line.text += str; line.sup = false; }
    } else {
      line = { text: BULLET_ONLY.test(str) ? '' : str, h, y, bullet: BULLET_ONLY.test(str) };
      lines.push(line);
    }
    brk = !!(it && it.hasEOL);
  }
  return lines
    .map((l) => ({ text: l.text.replace(/\s+/g, ' ').trim(), h: Math.round(l.h * 10) / 10, bullet: l.bullet }))
    .filter((l) => l.text);
}

/** A page as prompt text. The page-number line on a slide is dropped. */
export function pageText(page) {
  return (page.lines || [])
    .filter((l) => !/^\d{1,4}$/.test(l.text))
    .map((l) => (l.bullet ? '- ' : '') + l.text).join('\n');
}

function pdfBytes(b64) {
  const bin = atob(b64), data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  return data;
}

// A page is a FIGURE page when it paints a raster image of at least this many
// pixels. Measured on Chapter1-Introduction.pdf: its diagrams and photos are
// 400x200 to 1242x992; vector shapes are no signal (every slide draws a title
// bar, and bullets are paths too).
const FIGURE_MIN_PIXELS = 40000;

function hasFigure(lib, ops) {
  const O = lib.OPS;
  const paint = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject, O.paintImageXObjectRepeat]);
  return ops.fnArray.some((f, i) => {
    if (!paint.has(f)) return false;
    const a = ops.argsArray[i] || [];
    const w = Number(a[1] || (a[0] && a[0].width) || 0), h = Number(a[2] || (a[0] && a[0].height) || 0);
    return w * h >= FIGURE_MIN_PIXELS;
  });
}

/** The pages of a base64 PDF: [{ n, lines, figure }]. `figure`: the page
 *  carries a picture (a diagram, photo, chart) that its text does not. */
export async function pdfPages(b64) {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: pdfBytes(b64) });
  try {
    const doc = await task.promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      let figure = false;
      try { figure = hasFigure(lib, await page.getOperatorList()); } catch (e) { figure = false; }
      pages.push({ n, lines: linesFromItems(tc.items), figure });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/**
 * Some pages of a base64 PDF as JPEG data URLs, for a model that reads text
 * only from the PDF but can look at pictures: [{ n, url }]. Rendered wide
 * enough to read a diagram's labels (1280 px), small enough to upload fast.
 */
export async function pdfPageImages(b64, pageNums, { width = 1280, quality = 0.8 } = {}) {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: pdfBytes(b64) });
  try {
    const doc = await task.promise;
    const out = [];
    for (const n of pageNums) {
      if (n < 1 || n > doc.numPages) continue;
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, width / base.width) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';                 // JPEG has no alpha: paint slides onto white
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      out.push({ n, url: canvas.toDataURL('image/jpeg', quality) });
    }
    return out;
  } finally {
    await task.destroy();
  }
}

/** The text of a base64 PDF, page by page, for models that cannot read the file. */
export async function pdfText(b64) {
  return (await pdfPages(b64)).map((p) => `--- page ${p.n} ---\n${pageText(p)}`).join('\n\n');
}

async function viaOpenAI(a, spec) {
  let content = [];
  if (a.id === 'orca') {
    // ONE string, never content parts. ORCA's browser backends once typed only
    // "the last message whose content is a string" — a parts message was
    // skipped, the system prompt was sent as the question, and the model
    // invented a course it had never seen. A string reaches every backend.
    let doc = '';
    if (spec.attachPdf && spec.pdf) {
      // docText: the caller already put the document (or the pages that
      // matter) into the prompt, or passes exactly the text to send.
      if (typeof spec.docText === 'string') doc = spec.docText.trim();
      else {
        try { doc = (await pdfText(spec.pdf.b64)).trim(); }
        catch (e) { throw new AIError('Could not read the text of this PDF: ' + ((e && e.message) || e), { kind: 'bad_input' }); }
        if (!doc) throw new AIError('This PDF has no selectable text (a scan?) — ORCA models cannot read it.', { kind: 'bad_input' });
      }
    }
    content = (doc ? `The source document (${spec.pdf.name || 'source.pdf'}), as extracted text:\n\n${doc}\n\n` : '') + spec.prompt;
    // Pictures of pages (figures the text cannot carry) as standard image
    // parts. ORCA routes such a request only to models that take images.
    const images = spec.attachPdf ? (spec.images || []) : [];
    if (images.length) {
      content = [{ type: 'text', text: content },
        ...images.map((url) => ({ type: 'image_url', image_url: { url } }))];
    }
  } else {
    if (spec.attachPdf && spec.pdf) {
      content.push({ type: 'file', file: { filename: spec.pdf.name || 'source.pdf',
        file_data: 'data:application/pdf;base64,' + spec.pdf.b64 } });
    }
    content.push({ type: 'text', text: spec.prompt });
  }
  const messages = [
    ...(spec.system ? [{ role: 'system', content: spec.system }] : []),
    { role: 'user', content },
  ];
  const post = (response_format) => fetch(a.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + a.key },
    body: JSON.stringify({ ...(a.model && !/^(any|auto)$/i.test(a.model) ? { model: a.model } : {}), messages, ...(response_format ? { response_format } : {}) }),
  });

  let res;
  try {
    res = await post(spec.schema && !spec.test
      ? { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: spec.schema } }
      : null);
    // Not every OpenAI-compatible host takes a JSON Schema; json_object is the
    // near-universal fallback, and validation catches the rest.
    if (res.status === 400 && spec.schema && !spec.test) res = await post({ type: 'json_object' });
  } catch (e) {
    throw new AIError(`Could not reach ${a.baseUrl}: ${(e && e.message) || e}`, { kind: 'network', retryable: true });
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw httpError('the provider', res.status, body, spec.attachPdf);
  const choice = body && body.choices && body.choices[0];
  if (choice && choice.finish_reason === 'length' && !spec.test) {
    throw new AIError('The answer hit the length limit before it finished.', { kind: 'too_long', retryable: true });
  }
  const c = choice && choice.message && choice.message.content;
  return Array.isArray(c) ? c.map(p => p.text || '').join('') : (c || '');
}

async function viaGemini(a, spec) {
  const parts = [];
  if (spec.attachPdf && spec.pdf) parts.push({ inline_data: { mime_type: 'application/pdf', data: spec.pdf.b64 } });
  parts.push({ text: spec.prompt });
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + encodeURIComponent(a.model) + ':generateContent';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': a.key },
      body: JSON.stringify({
        ...(spec.system ? { systemInstruction: { parts: [{ text: spec.system }] } } : {}),
        contents: [{ role: 'user', parts }],
        ...(spec.test ? {} : { generationConfig: { responseMimeType: 'application/json' } }),
      }),
    });
  } catch (e) {
    throw new AIError('Could not reach Gemini: ' + ((e && e.message) || e), { kind: 'network', retryable: true });
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw httpError('Gemini', res.status, body, spec.attachPdf);
  const cand = body && body.candidates && body.candidates[0];
  if (cand && cand.finishReason === 'MAX_TOKENS' && !spec.test) {
    throw new AIError('The answer hit the length limit before it finished.', { kind: 'too_long', retryable: true });
  }
  return ((cand && cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
}

function httpError(who, status, body, hadPdf) {
  const detail = (body && ((body.error && (body.error.message || body.error)) || body.message)) || '';
  if (status === 401 || status === 403) return new AIError(`${who} rejected the key (${status}).`, { kind: 'auth' });
  if (status === 404) return new AIError(`${who}: model not found (${detail || 404}).`, { kind: 'setup' });
  if (status === 429) return new AIError(`${who} rate-limited the request — try again shortly.`, { kind: 'rate', retryable: true });
  const pdfHint = hadPdf && /pdf|file|document|mime|unsupported/i.test(String(detail))
    ? ' This model may not read PDFs — pick one that does.' : '';
  return new AIError(`${who} error ${status}: ${String(detail).slice(0, 300)}${pdfHint}`,
    { kind: 'api', retryable: status >= 500 });
}

/** FNV-1a — the prompt text as a cache version (same as the deck sheet's). */
export function hash(text) {
  const str = String(text || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'h' + h.toString(36);
}

export default { pdfText, pdfPages, pdfPageImages, pageText, linesFromItems, PROVIDERS, settings, saveSettings, active, generateJSON, testConnection, extractJSON, repairPrompt, hash, AIError };
