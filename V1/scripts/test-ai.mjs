// Tests for js/modules/ai.js — the provider layer behind the topic breakdown.
//
// The cases this file exists for:
//
//   "a key that did not save says so"
//       The A1 origin's localStorage has been measured FULL on Veda's Brave.
//       A key that "saved" and then vanished would surface later as a 401 with
//       no explanation. saveSettings reads back what it wrote.
//
//   "a repair ask never re-sends the document"
//       The repair carries the broken text; re-attaching a 20 MB PDF to fix a
//       missing comma would cost a full generation's worth of input.
//
//   "resuming a bridge step never pays twice"
//       A bridge job still running from before a reload must be RE-ATTACHED,
//       not submitted again: the bridge's cache only answers finished jobs.
//
// Every provider is stubbed at fetch — nothing here reaches a real API.
// Run with:  node scripts/test-ai.mjs
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 400))); }
};

// ── Stubs ─────────────────────────────────────────────────────────────────
const mem = new Map();
let quotaFull = false;
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { if (quotaFull) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } mem.set(k, String(v)); },
  removeItem: (k) => mem.delete(k),
};
globalThis.window = {
  STUDYOS_CONFIG: { cloudflare: { ai: { enabled: true, baseUrl: 'http://127.0.0.1:8781', site: 'claude' } } },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  _sosBridge: { getClasses: () => [], getEvents: () => [], getTasks: () => [], getNotes: () => [],
    getKsu: () => ({ modules: [] }), getModules: () => [], getSnapshot: () => null, subscribe: () => () => {} },
};
globalThis.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = (i || {}).detail; } };

let calls = [];
let responder = () => new Response('{}', { status: 200 });
globalThis.fetch = async (url, init = {}) => {
  const body = init.body && typeof init.body === 'string' ? (() => { try { return JSON.parse(init.body); } catch (e) { return init.body; } })() : init.body;
  const headers = {};
  const h = init.headers;
  if (h && typeof h.forEach === 'function') h.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  else Object.entries(h || {}).forEach(([k, v]) => { headers[k.toLowerCase()] = v; });
  const call = { url: String(url), method: init.method || 'GET', body, headers };
  calls.push(call);
  return responder(call);
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

const ai = await import(new URL('../js/modules/ai.js', import.meta.url).href);
const PDF = { b64: 'JVBERi0xLjQ=', name: 'Lecture.pdf', size: 8 };
const SCHEMA = { type: 'object', additionalProperties: false, required: ['x'], properties: { x: { type: 'number' } } };

// ── extractJSON ───────────────────────────────────────────────────────────
console.log('\nextractJSON');
t('a fenced block', ai.extractJSON('Here:\n```json\n{"a":1}\n```').a === 1);
t('the LAST json fence wins (a model that corrects itself)',
  ai.extractJSON('```json\n{"a":1,}\n```\nOops:\n```json\n{"a":2}\n```').a === 2);
t('trailing commas are forgiven', ai.extractJSON('{"a":[1,2,],}').a.length === 2);
t('a bare object in prose', ai.extractJSON('Sure! {"a":{"b":"}"}} Hope that helps').a.b === '}');
t('a stray "json" label line', ai.extractJSON('json\n{"a":3}').a === 3);
let threw = null;
try { ai.extractJSON('no json here'); } catch (e) { threw = e; }
t('no object is an AIError of kind bad_json', threw && threw.kind === 'bad_json', threw && threw.message);
try { ai.extractJSON('[1,2]'); threw = null; } catch (e) { threw = e; }
t('an array is refused (the caller wants an object)', !!threw);

// ── Settings ──────────────────────────────────────────────────────────────
console.log('\nsettings');
t('defaults to the bridge when it is configured', ai.settings().provider === 'bridge');
t('Anthropic is prefilled with the current Opus', ai.settings().models.anthropic === 'claude-opus-5-5');
let r = ai.saveSettings({ provider: 'anthropic', keys: { anthropic: 'sk-ant-x' } });
t('saves', r.ok === true, r);
t('reads back', ai.settings().keys.anthropic === 'sk-ant-x' && ai.active().id === 'anthropic');
quotaFull = true;
r = ai.saveSettings({ provider: 'gemini' });
t('a full storage quota is reported, not swallowed', r.ok === false && /full/.test(r.error), r);
quotaFull = false;
ai.saveSettings({ provider: 'openai', keys: { anthropic: 'sk-ant-x', openai: '' } });
t('a missing key is a setup problem', /key/i.test(ai.active().problem), ai.active());
ai.saveSettings({ provider: 'openai', keys: { anthropic: 'sk-ant-x', openai: 'sk-o' }, models: { anthropic: 'claude-opus-5-5', openai: '', gemini: '' } });
t('a missing model is a setup problem', /model/i.test(ai.active().problem), ai.active());
t('keys never leave localStorage (settings key only)', [...mem.keys()].every((k) => k === 'studyos_ai_v1'), [...mem.keys()]);

// ── OpenAI-compatible ─────────────────────────────────────────────────────
console.log('\nopenai-compatible adapter');
ai.saveSettings({ provider: 'openai', keys: { openai: 'sk-o' }, models: { openai: 'gpt-x' }, baseUrl: { openai: 'https://openrouter.ai/api/v1/' } });
calls = [];
responder = () => json({ choices: [{ message: { content: '{"x": 7}' }, finish_reason: 'stop' }] });
let out = await ai.generateJSON({ system: 'sys', prompt: 'go', pdf: PDF, schema: SCHEMA });
t('returns the parsed answer', out.data.x === 7, out);
t('posts to <base>/chat/completions (trailing slash trimmed)', calls[0].url === 'https://openrouter.ai/api/v1/chat/completions', calls[0].url);
t('bearer key', calls[0].headers.authorization === 'Bearer sk-o');
const oaUser = calls[0].body.messages.find((m) => m.role === 'user');
t('the PDF rides as a file part', oaUser.content[0].type === 'file' && oaUser.content[0].file.file_data.startsWith('data:application/pdf;base64,'), oaUser.content[0]);
t('asks for the JSON schema', calls[0].body.response_format.type === 'json_schema' && calls[0].body.response_format.json_schema.strict === true);

calls = [];
responder = (c) => (c.body.response_format.type === 'json_schema'
  ? json({ error: { message: 'response_format json_schema unsupported' } }, 400)
  : json({ choices: [{ message: { content: '{"x": 8}' }, finish_reason: 'stop' }] }));
out = await ai.generateJSON({ system: 'sys', prompt: 'go', pdf: PDF, schema: SCHEMA });
t('falls back to json_object on a 400', out.data.x === 8 && calls.length === 2 && calls[1].body.response_format.type === 'json_object', calls.map(c => c.body.response_format));

console.log('\nthe repair ask');
calls = [];
let n = 0;
responder = () => json({ choices: [{ message: { content: n++ === 0 ? '{"x": 1,, oops' : '{"x": 9}' }, finish_reason: 'stop' }] });
out = await ai.generateJSON({ system: 'sys', prompt: 'go', pdf: PDF, schema: SCHEMA });
t('a broken answer is repaired once', out.data.x === 9 && calls.length === 2, calls.length);
const rep = calls[1].body.messages.find((m) => m.role === 'user');
t('the repair does NOT re-send the document', rep.content.every((p) => p.type !== 'file'), rep.content.map(p => p.type));
t('the repair carries the broken text', rep.content.some((p) => (p.text || '').includes('{"x": 1,, oops')));

calls = [];
responder = () => json({ choices: [{ message: { content: '{"x": "nope"}' }, finish_reason: 'stop' }] });
threw = null;
try {
  await ai.generateJSON({ system: 's', prompt: 'p', pdf: PDF, schema: SCHEMA,
    validate: (v) => (typeof v.x === 'number' ? { value: v } : { error: 'x must be a number' }) });
} catch (e) { threw = e; }
t('validation failure after repair is an error', threw && /unusable/.test(threw.message), threw && threw.message);
t('...after exactly one repair', calls.length === 2, calls.length);

calls = [];
responder = () => json({ error: { message: 'bad key' } }, 401);
threw = null;
try { await ai.generateJSON({ system: 's', prompt: 'p', pdf: PDF, schema: SCHEMA }); } catch (e) { threw = e; }
t('a 401 is an auth error, not a repair', threw && threw.kind === 'auth' && calls.length === 1, threw && threw.kind);

calls = [];
responder = () => json({ choices: [{ message: { content: '{"x": 1' }, finish_reason: 'length' }] });
threw = null;
try { await ai.generateJSON({ system: 's', prompt: 'p', pdf: PDF, schema: SCHEMA }); } catch (e) { threw = e; }
t('a truncated answer says so', threw && threw.kind === 'too_long', threw && threw.message);

threw = null;
try { await ai.generateJSON({ system: 's', prompt: 'p', pdf: { ...PDF, size: 30 * 1024 * 1024 }, schema: SCHEMA }); } catch (e) { threw = e; }
t('an oversized PDF is refused before any request', threw && threw.kind === 'too_large');

// ── Gemini ────────────────────────────────────────────────────────────────
console.log('\ngemini adapter');
ai.saveSettings({ provider: 'gemini', keys: { gemini: 'AIza1' }, models: { gemini: 'gemini-x' } });
calls = [];
responder = () => json({ candidates: [{ content: { parts: [{ text: '{"x": 4}' }] }, finishReason: 'STOP' }] });
out = await ai.generateJSON({ system: 'sys', prompt: 'go', pdf: PDF, schema: SCHEMA });
t('returns the parsed answer', out.data.x === 4);
t('calls generateContent for the model', /models\/gemini-x:generateContent$/.test(calls[0].url), calls[0].url);
t('key in a header, not the URL', calls[0].headers['x-goog-api-key'] === 'AIza1' && !calls[0].url.includes('AIza1'));
t('the PDF rides as inline_data', calls[0].body.contents[0].parts[0].inline_data.mime_type === 'application/pdf');
t('asks for JSON', calls[0].body.generationConfig.responseMimeType === 'application/json');

// ── Anthropic (official SDK, vendored) ────────────────────────────────────
console.log('\nanthropic adapter');
ai.saveSettings({ provider: 'anthropic', keys: { anthropic: 'sk-ant-k' }, models: { anthropic: 'claude-opus-5-5' } });
calls = [];
responder = () => json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
threw = null;
try { await ai.generateJSON({ system: 'sys', prompt: 'go', pdf: PDF, schema: SCHEMA }); } catch (e) { threw = e; }
t('a rejected key is a typed auth error', threw && threw.kind === 'auth', threw && threw.message);
const req = calls[0] || {};
t('calls the Messages API', /api\.anthropic\.com\/v1\/messages/.test(req.url || ''), req.url);
t('sends the key', req.headers['x-api-key'] === 'sk-ant-k');
t('the PDF is a base64 document block before the text',
  req.body && req.body.messages[0].content[0].type === 'document'
  && req.body.messages[0].content[0].source.media_type === 'application/pdf'
  && req.body.messages[0].content[1].type === 'text', req.body && req.body.messages[0].content.map(c => c.type));
t('adaptive thinking', req.body && req.body.thinking && req.body.thinking.type === 'adaptive');
t('structured output via output_config.format', req.body && req.body.output_config.format.type === 'json_schema');
t('effort set explicitly (Opus 5.5 defaults to medium)', req.body && req.body.output_config.effort === 'high');
t('streams (long lessons)', req.body && req.body.stream === true);
t('refusal fallback on', req.body && req.body.fallbacks === 'default'
  && /server-side-fallback-2026-07-01/.test(req.headers['anthropic-beta'] || ''), req.headers['anthropic-beta']);
t('browser access header set by the SDK', 'anthropic-dangerous-direct-browser-access' in req.headers);

ai.saveSettings({ provider: 'anthropic', keys: { anthropic: 'sk-ant-k' }, models: { anthropic: 'claude-haiku-4-5' } });
calls = [];
try { await ai.generateJSON({ system: 'sys', prompt: 'go', pdf: PDF, schema: SCHEMA }); } catch (e) {}
const hreq = calls[0] || {};
t('an older model gets no thinking/effort/fallbacks (no 400)',
  hreq.body && !hreq.body.thinking && !hreq.body.fallbacks && !(hreq.body.output_config || {}).effort, hreq.body && Object.keys(hreq.body));

// ── Bridge ────────────────────────────────────────────────────────────────
console.log('\nbridge adapter');
ai.saveSettings({ provider: 'bridge' });
calls = [];
responder = (c) => {
  if (c.method === 'POST' && c.url.endsWith('/api/ai/jobs')) return json({ ok: true, job: { id: 'j1', status: 'queued' } });
  if (c.url.endsWith('/api/ai/jobs/j1')) return json({ ok: true, job: { id: 'j1', status: 'done', result: '```json\n{"x": 5}\n```' } });
  return json({ ok: true });
};
let seen = [];
out = await ai.generateJSON({ system: 'sys', prompt: 'go', pdf: PDF, schema: SCHEMA, key: 'bd:f1:topics', fileId: 'f1',
  onJob: (id, main) => seen.push([id, main]) });
t('returns the parsed answer', out.data.x === 5, out);
const post = calls.find((c) => c.method === 'POST');
t('posts mode=ask', post.body.mode === 'ask' && post.body.site === 'claude');
t('attaches the source', post.body.fileB64 === PDF.b64);
t('the step key is the promptId', post.body.promptId === 'bd:f1:topics');
t('the prompt text is the version', /^h[0-9a-z]+$/.test(post.body.promptVersion));
t('asks for an inline JSON block, not an artifact', /do NOT create an artifact/.test(post.body.prompt));
t('reports the job id to the caller', seen.length === 1 && seen[0][0] === 'j1' && seen[0][1] === true, seen);

calls = [];
let polls = 0;
responder = (c) => {
  if (c.url.endsWith('/api/ai/jobs/j9')) return json({ ok: true, job: { id: 'j9', status: polls++ ? 'done' : 'running', result: '{"x": 6}' } });
  return json({ ok: true, job: { id: 'jNEW', status: 'queued' } });
};
out = await ai.generateJSON({ system: 's', prompt: 'p', pdf: PDF, schema: SCHEMA, resumeJobId: 'j9' });
t('resumes a running job instead of paying again', out.data.x === 6 && !calls.some((c) => c.method === 'POST'), calls.map(c => c.method + ' ' + c.url));

// ── ORCA: one string, the document inside it ──────────────────────────────
/* ORCA's browser backends used to type "the last message whose content is a
 * string": a content-parts user message was skipped and the SYSTEM prompt went
 * out as the question. The model never saw the document and invented a whole
 * course. A single string reaches every backend. */
console.log('\norca adapter');
ai.saveSettings({ provider: 'orca', keys: { orca: 'orca_sk_x' }, models: { orca: '' }, baseUrl: { orca: 'https://orca.test/v1' } });
calls = [];
responder = () => json({ choices: [{ message: { content: '{"x": 5}' }, finish_reason: 'stop' }] });
out = await ai.generateJSON({ system: 'sys', prompt: 'List the topics.', pdf: PDF, schema: SCHEMA, docText: '--- page 1 ---\nvon Neumann' });
const orcaUser = calls[0].body.messages.find((m) => m.role === 'user');
t('the user message is ONE string', typeof orcaUser.content === 'string', orcaUser.content);
t('the document text comes first, then the request', orcaUser.content.indexOf('von Neumann') >= 0
  && orcaUser.content.indexOf('von Neumann') < orcaUser.content.indexOf('List the topics.'), orcaUser.content);
t('the system prompt stays a system message', calls[0].body.messages[0].role === 'system' && calls[0].body.messages[0].content === 'sys');
t('no model named: ORCA routes', !('model' in calls[0].body));
calls = [];
await ai.generateJSON({ system: 's', prompt: 'Only this.', pdf: PDF, schema: SCHEMA, docText: '' });
t('docText "" sends the prompt alone (it already holds the pages)', calls[0].body.messages[1].content === 'Only this.', calls[0].body.messages[1].content);

calls = [];
await ai.generateJSON({ system: 's', prompt: 'Teach the figure.', pdf: PDF, schema: SCHEMA, docText: '',
  images: ['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,BBBB'] });
const figUser = calls[0].body.messages[1].content;
t('figures go as standard image_url parts after the text', Array.isArray(figUser) && figUser[0].type === 'text'
  && figUser[0].text === 'Teach the figure.' && figUser.slice(1).map((p) => p.image_url.url).join() === 'data:image/jpeg;base64,AAAA,data:image/jpeg;base64,BBBB', figUser);
n = 0;
calls = [];
responder = () => json({ choices: [{ message: { content: n++ === 0 ? '{"x": 1,, oops' : '{"x": 2}' }, finish_reason: 'stop' }] });
await ai.generateJSON({ system: 's', prompt: 'p', pdf: PDF, schema: SCHEMA, docText: '', images: ['data:image/jpeg;base64,AAAA'] });
t('a repair ask never re-sends the images', typeof calls[1].body.messages[1].content === 'string', calls[1].body.messages[1].content);

// ── Text out of a PDF page ────────────────────────────────────────────────
/* Items as pdf.js gives them for slide 7 of Chapter1-Introduction.pdf: the
 * exponents are separate, smaller, raised items. Joined naively they read
 * "10 3 and 2 10" — or "103 and 210" — and a model teaches the wrong number. */
console.log('\nlinesFromItems');
{
  const it = (str, h, x, y, hasEOL = false) => ({ str, height: h, transform: [h, 0, 0, h, x, y], hasEOL });
  const items = [
    it('7', 12, 657, 32.6),
    it('', 0, 92, 376.5, true), it('•', 22, 92, 376.5), it(' ', 0, 104, 376.5), it('Kilo', 22, 126, 376.5), it('-', 22, 167, 376.5),
    it(' ', 0, 177, 376.5), it('(K) = 1 thousand = 10', 22, 185, 376.5), it('3', 14.6, 439, 383.1), it(' ', 0, 448, 383.1),
    it('and 2', 22, 456, 376.5), it('10', 14.6, 519, 383.1),
    it('', 0, 92, 344.8, true), it('•', 22, 92, 344.8), it(' ', 0, 104, 344.8), it('Mega', 22, 126, 344.8), it('-', 22, 185, 344.8),
    it(' ', 0, 195, 344.8), it('(M) = 1 million = 10', 22, 203, 344.8), it('6', 14.6, 430, 351.4), it(' ', 0, 440, 351.4),
    it('and 2', 22, 448, 344.8), it('20', 14.6, 510, 351.4),
    it('', 0, 55, 343.6, true), it('', 28, 55, 241.1), it(' ', 0, 80, 241.1), it('So,', 28, 92, 241.1),
    it('', 0, 55, 479.1, true), it('The Measures of', 36, 55, 479.1), it(' ', 0, 352, 479.1), it('Speed and', 36, 364, 479.1),
  ];
  const lines = ai.linesFromItems(items);
  t('exponents are marked with ^', lines[1].text === 'Kilo- (K) = 1 thousand = 10^3 and 2^10', lines[1]);
  t('each bullet is its own line', lines[2].text === 'Mega- (M) = 1 million = 10^6 and 2^20', lines.map((l) => l.text));
  t('a bullet glyph is flagged, not kept as text', lines[1].bullet === true && !lines[1].text.includes('•'));
  t('a Wingdings bullet (an empty string) is a bullet too', lines[3].text === 'So,' && lines[3].bullet === true, lines[3]);
  t('the title keeps its height (the tallest line)', lines[4].text === 'The Measures of Speed and' && lines[4].h === 36, lines[4]);
  // Slide 11: "10" then "-" and "3" as two raised items — one exponent.
  const neg = ai.linesFromItems([
    it('', 0, 92, 300, true), it('Milli- (m) = 1 thousandth = 10 ', 22, 126, 300), it('-', 14.6, 400, 306.6), it('3', 14.6, 405, 306.6),
    it(' ', 0, 412, 306.6), it('and more', 22, 420, 300),
  ]);
  t('a negative exponent split over two items is one ^', neg[0].text === 'Milli- (m) = 1 thousandth = 10^-3 and more', neg[0].text);
  t('the page number is dropped from the prompt text', !ai.pageText({ n: 7, lines }).split('\n').includes('7'), ai.pageText({ n: 7, lines }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
