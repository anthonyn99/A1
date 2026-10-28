// ============================================================================
// personal-ai — Cloudflare Worker
//
// ONE worker + ONE Gemini key per person, powering all three personal AI
// features that used to live in three separate workers:
//
//   POST /list/parse      (was mylist-api /parse)     — voice/text → typed lists (shopping, packing, itinerary, to-do, reminders, other)
//   POST /taskhub/parse   (was taskhub-voice /parse)  — voice/text → TaskHub actions
//   POST /taskhub/prep    — one flagged task → AI prep kit (prompt, draft, sites, apps)
//   POST /journal/format  (was journal-ai /format)    — messy text → clean HTML
//   POST /prompt/refine   — MAGI's Refine: a prompt → a sharper prompt, nothing lost
//   GET  /quote/daily     — Everwell's quote of the day (ORCA → Gemini, cached per day); &kind=buddhist: a real Buddhist quote + its source
//   POST /fuel/plan       — Everwell's nutrition plan: a person's stats, training and photos → calories, macros, meals, water (ORCA → Gemini)
//   GET  /health          — status (which keys are configured)
//
// Each person (Tony / Veda) has a SINGLE key shared across all three features.
// Free-tier Gemini limits are per-project AND per-model, so the model fallback
// chain below multiplies the effective daily capacity of one key to several
// thousand requests/day — far more than these personal apps ever use.
//
// Bindings (Cloudflare → Settings → Variables & Secrets → add as SECRET):
//   TONY_GEMINI_KEY, VEDA_GEMINI_KEY
// ============================================================================

// Fallback chains: walked top→bottom. When a model is exhausted (429 / quota)
// or errors, we drop to the next one, so the apps stay usable even after the
// lead model hits its daily cap.
// All entries are on Google's FREE tier (Flash / Flash-Lite; Pro is paid-only).
// gemini-2.5-flash-lite and gemini-2.0-flash were retired by Google (404 on these
// keys, checked 2026-10-02) — their slots now hold 3.5-flash-lite / 3.8-flash.

// Notebook's AI tools (AI Format, AI Refine, every custom tool): long-document
// quality matters most → lead with 3.5-flash. Raced by runStaggered, not walked
// one by one. 2026-10-28: 2.5-flash answers 404 "no longer available" on both
// keys, so it is gone from this chain, and every Gemini Flash model spent hours
// shedding load (503), so Workers AI's models (see cfOnce) sit behind them:
// measured on a journal page they kept every fact and image token, in 6-7 s.
const MODELS = [
  'gemini-3.5-flash',       // newest flagship free Flash — most capable
  'gemini-3.1-flash-lite',  // newest Flash-Lite — high RPD
  'gemini-3.5-flash-lite',  // fast, high-RPD lite fallback
  '@cf/meta/llama-4-scout-17b-16e-instruct',      // Workers AI — not Google, so not down with it
  'gemini-3.8-flash',       // newest Flash — capacity fallback
  '@cf/mistralai/mistral-small-3.1-24b-instruct', // Workers AI — last resort
];

// MyList: interactive voice → latency matters most. 3.1-flash-lite is both the
// fastest and the most reliable at structured multi-op commands (3.5-flash can
// only throttle thinking to "low", never off, so it's seconds slower per call
// and was dropping changes on bulk edits).
// Re-measured 2026-10-02 (typed + spoken commands on every list type):
// 3.5-flash-lite answered in ~1 s on nearly every call while 3.1-flash-lite and
// 3.8-flash stalled past 20 s on a third of them. runStaggered() races the next
// model in whenever the leader is slow, so order = typical-case speed first.
// (2.5-flash-lite and 2.0-flash now return 404 — retired by Google.)
const LIST_MODELS = [
  'gemini-3.5-flash-lite',  // fastest + steadiest; accurate structured ops
  'gemini-3.1-flash-lite',  // first racer — strong on itineraries
  'gemini-3.5-flash',       // flagship — low daily quota, so not the lead
  'gemini-2.5-flash',
  'gemini-3.8-flash',
];
// MyList DICTATION — a long voice clip or a pasted/multi-line list ("here's
// everything I need to pack…"). Faithfulness beats latency there: every item
// and detail must survive. See isListDictation() for the cut-over.
// Live comparison (2026-10-02, 20-item spoken packing list): 3.5-flash kept
// every item, count and detail and sorted them into categories in ~3 s;
// flash-lite stays a close second and is the fastest racer behind it.
// Lists whose items hang on a TIME (itinerary, to-do, reminders): 3.1-flash-lite
// put times/dates in the right field on every live run; 3.5-flash-lite
// sometimes filed them under details. It leads here, and the fast 3.5-flash-lite
// races in after the stagger if it stalls.
const LIST_TIMED_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-3.8-flash',
];
// Input with LINKS: the pages are already read, so the model's job is naming +
// placing — short, structured, latency-bound. The fast lite models lead and race
// each other on a 2.5 s stagger; 3.5-flash is the faithful backstop for a long
// pasted shopping list; if all fail, handleList still adds the links.
const LIST_LINK_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-3.8-flash',
];
const LIST_DICTATION_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-3.8-flash',
];

// TaskHub's structured multi-action commands parse most RELIABLY on 2.5-flash
// (dynamic thinking) and 3.1-flash-lite — 3.5-flash at low thinking tends to drop
// fields on these, and high thinking is too slow for voice. So TaskHub leads with
// the reliable models, then falls through the rest of the chain for extra free-tier
// capacity. (List/Journal are simple and use the standard MODELS order.)
const TASKHUB_MODELS = [
  'gemini-3.1-flash-lite',  // BEST here: fast AND reliably captures all fields on multi-action commands
  'gemini-3.5-flash',       // newest flagship — capacity fallback
  'gemini-2.5-flash',       // proven Flash — capacity fallback
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
];

// TYPED bulk requests ("plan my entire next two weeks", a pasted list of 20
// assignments, "shift everything one day later") are a different problem from a
// one-line voice command: dozens of actions, a much larger state window, and no
// live user waiting on sub-second latency. Reasoning quality dominates, so this
// chain leads with the flagship and keeps the fast lite models as capacity
// fallbacks underneath. Short typed commands still use TASKHUB_MODELS above.
const TASKHUB_BULK_MODELS = [
  'gemini-3.5-flash',       // flagship — best at long, many-action plans
  'gemini-3.1-flash-lite',  // fast + reliable structured ops
  'gemini-2.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
];

// Recipes split by task, because the two jobs want opposite things:
//
//  • TYPED / SHORT edits ("rename this", "change cook time to 45", "delete step 6")
//    want minimum latency. 3.1-flash-lite is the fastest reliable structured-op
//    model and, with the compact prompt (only the OPEN recipe is sent in full),
//    these round-trips feel near-instant.
const RECIPE_EDIT_MODELS = [
  'gemini-3.1-flash-lite',  // fastest reliable structured editing
  'gemini-3.5-flash-lite',  // fast, high-RPD lite fallback
  'gemini-2.5-flash',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
];
//  • SPOKEN dictation of a recipe wants FAITHFULNESS over speed — capture every
//    ingredient, time, temperature and prep detail and never over-summarize. The
//    "lite" models distil/compress and were dropping content, so voice leads with
//    the full 2.5-flash (thinking OFF via thinkingBudget:0 keeps it fast enough),
//    then the 3.5-flash flagship for the hardest dictations.
const RECIPE_VOICE_MODELS = [
  'gemini-2.5-flash',       // capable + thinking-off → faithful AND reasonably fast
  'gemini-3.5-flash',       // flagship fallback for the hardest/longest dictations
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
];

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}
function keyFor(env, profile) {
  return profile === 'veda' ? env.VEDA_GEMINI_KEY : env.TONY_GEMINI_KEY;
}

// Per-model thinking config. Gemini 3.x uses thinkingLevel ("low"/"high"); it
// can't fully disable thinking, so we use "low" for speed. Gemini 2.5 uses a
// numeric thinkingBudget (0 = off, -1 = dynamic). Only TaskHub's 2.5-flash gets
// dynamic thinking (bulk/ambiguous commands need the reasoning); everything else
// stays fast. Older models take no thinking config.
function thinkingConfig(model) {
  // Keep latency low (esp. for voice). Gemini 3.x uses thinkingLevel — "low" is
  // fast and already capable ("high" is far too slow for interactive use). Gemini
  // 2.5 uses thinkingBudget:0 — dynamic thinking (-1) caused 90s+ hangs, not worth
  // it now that 3.1-flash-lite handles structured commands accurately and fast.
  if (model.startsWith('gemini-3')) return { thinkingLevel: 'low' };
  if (model.startsWith('gemini-2.5')) return { thinkingBudget: 0 };
  return undefined;
}

// Per-attempt hard timeout. A stalled/hung upstream connection (rather than a
// clean error) used to make the whole request wait indefinitely — the client
// has no way to recover from that short of a page refresh. Aborting after this
// many ms turns a hang into a normal retry/fallback, same as any other failure.
const GEMINI_TIMEOUT_MS = 15000;

// Single Gemini caller shared by all features. Returns the parsed JSON object,
// or null if the model produced nothing usable (caller then falls to next model).
async function callGemini(model, key, { prompt, schema, maxOutputTokens, feature, audio, mimeType }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const gc = {
    temperature: 0,
    maxOutputTokens,
    responseMimeType: 'application/json',
    responseSchema: schema,
  };
  const tc = thinkingConfig(model, feature);
  if (tc) gc.thinkingConfig = tc;

  const parts = [{ text: prompt }];
  if (audio) parts.push({ inlineData: { mimeType: mimeType || 'audio/wav', data: audio } });
  const body = JSON.stringify({ contents: [{ parts }], generationConfig: gc });

  let lastStatus = 0;
  // 2 attempts/model (was 3) so a bad model can't eat the whole client-side
  // budget before the fallback chain even gets to a working one.
  for (let attempt = 0; attempt < 2; attempt++) {
    let r;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), GEMINI_TIMEOUT_MS);
    try {
      r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ac.signal });
    } catch (e) {
      await new Promise(res => setTimeout(res, 500 * (attempt + 1)));
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (r.status === 429 || r.status >= 500) {
      // Quota/overload — retry briefly, then let the outer loop try the next model.
      lastStatus = r.status;
      await new Promise(res => setTimeout(res, 700 * (attempt + 1)));
      continue;
    }
    if (!r.ok) {
      const txt = (await r.text()).slice(0, 300);
      throw new Error(`gemini ${model} ${r.status}: ${txt}`);
    }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!text) continue;
    try { return JSON.parse(text); } catch (e) { continue; }
  }
  // Surface a persistent quota condition so the caller can report "exhausted".
  if (lastStatus === 429) throw new Error(`gemini ${model} 429 quota/exhausted`);
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// Hardened fallback chain (used by TaskHub; the other features keep the simple
// loop above, which is enough for their small, fast prompts).
//
// The plain "for (model of MODELS) { try 2x }" loop has three failure modes that
// bite exactly when a bulk request is in flight:
//   1. no overall budget — 5 models × 2 attempts × 15 s can burn 150 s before
//      the client ever hears back;
//   2. it retries a 429 model that is out of quota for the DAY, wasting the two
//      slowest seconds of the budget on a call that cannot succeed;
//   3. a long answer that hits maxOutputTokens comes back as unparseable JSON
//      and is thrown away whole, even though 30 valid actions were already in it.
//
// runModelChain fixes all three: one wall-clock deadline for the whole chain,
// per-outcome routing (quota/fatal → next model immediately, transient → one
// jittered retry), truncation salvage, and — only for slow bulk work — a hedge
// that starts the second model if the leader is still silent, taking whichever
// lands first.
// ════════════════════════════════════════════════════════════════════════════
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Rescue a truncated JSON response by keeping every COMPLETE object already
// present in the actions array. A bulk plan cut off at the token limit still
// carries most of its work; dropping it entirely is the worse answer.
function salvageJson(text) {
  const at = text.indexOf('"actions"');
  if (at < 0) return null;
  const open = text.indexOf('[', at);
  if (open < 0) return null;
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; continue; }
    if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { objs.push(JSON.parse(text.slice(start, i + 1))); } catch (e) { /* skip */ }
        start = -1;
      }
      continue;
    }
    if (c === ']' && depth === 0) break;
  }
  return objs.length ? { actions: objs, say: '', truncated: true } : null;
}

// One request, one attempt. Never throws for an expected condition — returns a
// classified outcome so the chain can decide retry vs. move on.
//   ok    → value is the parsed JSON object
//   retry → transient (network, timeout, 5xx, unusable body) — worth one retry
//   quota → 429; this model is capped, go to the next one right away
//   next  → the model answered but can't do this job (truncated/blocked)
//   fatal → 4xx; this model/key will never work for this request
// Older Flash tops out at 8 192 output tokens; asking for the bulk budget there
// is a hard 400, which would burn the model's slot in the chain for no reason.
const MODEL_MAX_OUT = { 'gemini-2.0-flash': 8192 };

async function geminiOnce(model, key, o, timeoutMs) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const cap = MODEL_MAX_OUT[model];
  const gc = {
    temperature: 0,
    maxOutputTokens: cap ? Math.min(o.maxOutputTokens, cap) : o.maxOutputTokens,
    responseMimeType: 'application/json',
    responseSchema: o.schema,
  };
  const tc = (o.thinkingLevel && model.startsWith('gemini-3')) ? { thinkingLevel: o.thinkingLevel } : thinkingConfig(model, o.feature);
  if (tc) gc.thinkingConfig = tc;
  const parts = [{ text: o.prompt }];
  if (o.audio) parts.push({ inlineData: { mimeType: o.mimeType || 'audio/wav', data: o.audio } });
  (o.images || []).forEach((im) => parts.push({ inlineData: { mimeType: im.mimeType, data: im.data } }));
  const body = JSON.stringify({ contents: [{ parts }], generationConfig: gc });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ac.signal });
  } catch (e) {
    // A timeout says this model is slow RIGHT NOW; repeating it just spends the
    // budget twice. Move to the next model, which is usually the faster one.
    if (e && e.name === 'AbortError') return { cls: 'next', err: `${model}: timeout ${timeoutMs}ms` };
    return { cls: 'retry', err: `${model}: ${(e && e.message) || 'network'}` };
  } finally {
    clearTimeout(timer);
  }

  if (r.status === 429) return { cls: 'quota', err: `${model}: 429 quota` };
  if (r.status >= 500) return { cls: 'retry', err: `${model}: ${r.status}` };
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    return { cls: 'fatal', err: `${model}: ${r.status} ${t.slice(0, 160)}` };
  }

  let data;
  try { data = await r.json(); } catch (e) { return { cls: 'retry', err: `${model}: bad envelope` }; }
  const cand = data && data.candidates && data.candidates[0];
  const finish = (cand && cand.finishReason) || '';
  const text = (cand && cand.content && Array.isArray(cand.content.parts))
    ? cand.content.parts.map(p => p.text || '').join('')
    : '';
  if (!text) {
    // SAFETY/RECITATION/MAX_TOKENS won't improve on a retry of the same model.
    return { cls: finish && finish !== 'STOP' ? 'next' : 'retry', err: `${model}: empty (${finish || '?'})` };
  }
  try { return { cls: 'ok', value: JSON.parse(text) }; } catch (e) { /* fall through */ }
  // Feature-specific truncation rescue (actions array by default; journal
  // formatting passes its own, since a cut-off document salvages differently).
  const salvaged = (o.salvage || salvageJson)(text);
  if (salvaged) return { cls: 'ok', value: salvaged };
  return { cls: 'retry', err: `${model}: unparseable output` };
}

// Workers AI: Cloudflare's own models, through the [ai] binding in
// wrangler.toml. No key, a separate free daily allowance, and a different
// company's servers -- so when Gemini sheds load (2026-10-28: 503 on nearly
// every Flash model for hours, 11-20 s on the calls that did answer) these
// still answer in 1-2 s. A model id starting "@cf/" in a chain runs here.
// Same outcome classes as geminiOnce, so runStaggered treats both alike.
// Gemini's schema dialect ("OBJECT"/"STRING") is lowercased for JSON Schema.
function jsonSchemaOf(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type' && typeof v === 'string') out.type = v.toLowerCase();
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([p, d]) => [p, jsonSchemaOf(d)]));
    else if (k === 'items') out.items = jsonSchemaOf(v);
    else out[k] = v;
  }
  return out;
}
async function cfOnce(model, o, timeoutMs) {
  const ai = o.env && o.env.AI;
  if (!ai) return { cls: 'fatal', err: `${model}: no AI binding` };
  const input = {
    messages: [{ role: 'user', content: o.prompt }],
    max_tokens: Math.min(o.maxOutputTokens || 2048, 16000),
    temperature: 0.2,
  };
  if (o.schema) input.response_format = { type: 'json_schema', json_schema: jsonSchemaOf(o.schema) };
  let timer;
  let r;
  try {
    r = await Promise.race([
      ai.run(model, input),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeoutMs); }),
    ]);
  } catch (e) {
    const m = String((e && e.message) || e || 'error');
    if (m === 'timeout') return { cls: 'next', err: `${model}: timeout ${timeoutMs}ms` };
    // The daily free allowance or a per-minute cap: this model is done for now.
    if (/\b429\b|capacity|neurons|limit|quota/i.test(m)) return { cls: 'quota', err: `${model}: ${m.slice(0, 120)}` };
    return { cls: 'next', err: `${model}: ${m.slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
  let resp = r && (r.response !== undefined ? r.response
    : r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content);
  if (resp && typeof resp === 'object') return { cls: 'ok', value: resp };
  const text = String(resp || '').trim();
  if (!text) return { cls: 'next', err: `${model}: empty` };
  try { return { cls: 'ok', value: JSON.parse(text) }; } catch (e) { /* fall through */ }
  const salvaged = o.salvage ? o.salvage(text) : null;
  if (salvaged) return { cls: 'ok', value: salvaged };
  return { cls: 'next', err: `${model}: unparseable output` };
}
const aiOnce = (model, key, o, timeoutMs) => (model.startsWith('@cf/')
  ? cfOnce(model, o, timeoutMs)
  : geminiOnce(model, key, o, timeoutMs));

// Resolve with the first promise that yields a truthy value; null if none do.
// Losers are abandoned in flight (a Worker just drops them).
function firstTruthy(promises) {
  return new Promise(resolve => {
    let pending = promises.length, done = false;
    const settle = v => {
      if (done) return;
      if (v) { done = true; resolve(v); }
      else if (--pending === 0) resolve(null);
    };
    promises.forEach(p => p.then(settle, () => settle(null)));
  });
}

async function runModelChain(models, key, o) {
  const deadline = Date.now() + (o.deadlineMs || 45000);
  const perCall = o.timeoutMs || GEMINI_TIMEOUT_MS;
  const left = () => deadline - Date.now();
  const errs = [];
  const used = [];
  // A well-formed answer that failed the quality bar. We move on to the next
  // model hoping for better, but keep it: a slightly lossy result still beats
  // telling the user the whole request failed.
  let soft = null;

  const tryModel = async model => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (left() < 1500) return null;                       // deadline is spent — don't start
      const budget = Math.min(perCall, left());
      used.push(model);
      const r = await geminiOnce(model, key, o, budget);
      if (r.cls === 'ok') {
        if (o.validate && !o.validate(r.value)) {
          if (!soft) soft = { value: r.value, model, soft: true };
          errs.push(`${model}: lossy extraction`);
          return null;                                      // escalate to the next model
        }
        return { value: r.value, model };
      }
      errs.push(r.err);
      if (r.cls !== 'retry') return null;                   // quota / fatal / next → next model
      if (attempt === 0) await sleep(220 + Math.floor(Math.random() * 380));
    }
    return null;
  };

  let i = 0;
  // Hedge only where the wait is long enough to justify a second call: if the
  // leader is still silent after hedgeAfterMs, run the runner-up alongside it.
  // Fast responses (the normal case) never trigger it, so quota use is unchanged.
  if (o.hedgeAfterMs && models.length > 1 && left() > o.hedgeAfterMs + 4000) {
    let leadDone = false;
    const lead = tryModel(models[0]).then(v => { leadDone = true; return v; });
    const hedged = sleep(o.hedgeAfterMs).then(() => (leadDone ? null : tryModel(models[1])));
    const win = await firstTruthy([lead, hedged]);
    if (win) return { ...win, tried: used.slice() };
    i = 2;
  }
  for (; i < models.length; i++) {
    if (left() < 1500) break;
    const win = await tryModel(models[i]);
    if (win) return { ...win, tried: used.slice() };
  }
  if (soft) return { ...soft, tried: used.slice() };
  const err = new Error(errs.slice(-3).join(' | ') || 'all models failed');
  err.tried = used.slice();
  throw err;
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 1 — MyList parser  (POST /list/parse)
//
// MyList holds more than shopping lists: packing lists, itineraries, to-dos,
// reminders and free-form lists. Every list has a TYPE (the client sends it as
// `listType`), and the prompt is built for that type — the same item fields
// mean different things per type (an itinerary's group is a DAY, a packing
// list's is a CATEGORY), and what "clean" looks like differs too.
//
// The model emits small targeted OPERATIONS (add / update / remove / move /
// bulk ops) referencing existing items by their number, and the worker applies
// them to the client's list deterministically. Compared to "echo the whole
// updated list back" this is ~10x fewer output tokens (fast) and makes it
// impossible for a bulk edit to drop or corrupt items the user never mentioned.
//
// Wire field names never change with the type: an item's group travels as
// `store` and the list's saved groups as `stores`, so lists written before list
// types existed (and older clients) keep working untouched.
// ════════════════════════════════════════════════════════════════════════════
const LIST_TYPES = ['shopping', 'packing', 'itinerary', 'todo', 'reminders', 'other'];
const TIMED_LIST_TYPES = ['itinerary', 'todo', 'reminders'];
function normListType(t) {
  const v = String(t || '').toLowerCase().trim();
  return LIST_TYPES.includes(v) ? v : 'shopping';
}

// Per-type guidance. `group` is what an item's "store" field means for the
// type; `rules` are the type's own cleanup/structure rules; `examples` are
// command → ops pairs (flash-lite follows examples far more reliably than
// prose rules — a rule with no example was routinely ignored).
const LIST_TYPE_GUIDE = {
  shopping: {
    what: 'a SHOPPING / grocery list',
    group: 'STORE — the retailer the item is bought at ("Costco", "Target", "Trader Joe\'s")',
    rules: [
      `- STORE NAMES: a store is a short proper retailer name in Title Case, max 3 words ("Costco", "Best Buy", "Trader Joe's"). When it's clearly one of the SAVED GROUPS, use that exact spelling. Vague places ("the store", "the mall", "online", "somewhere") are NOT stores — omit the field.`,
      `- NAMES: clean Title Case product name in its natural shopping form ("Eggs", "Bananas", "Paper Towels", "Furnace Air Filter"), KEEPING any brand ("Fairlife Whole Milk", "Oreo Cookies", "DeWalt 20V Drill"). Quantity goes in "qty" ("2", "1 gallon", "3 lbs", "a dozen") — never inside the name.`,
      `- SPLIT: every separate product is its own item ("eggs, bread and two avocados" = 3 adds).`,
      `- "when" is unused for shopping unless the user gives a deadline ("for Saturday's party" → desc, not when).`,
    ],
    examples: [
      `"move the milk to Costco and the eggs to Walmart instead" → [{"op":"update","index":1,"match":"Milk","set":{"store":"Costco"}},{"op":"update","index":4,"match":"Eggs","set":{"store":"Walmart"}}]`,
      `"we need 2 gallons of Fairlife milk and paper towels from Costco, and check off the bread" → [{"op":"add","name":"Fairlife Milk","qty":"2 gallons"},{"op":"add","name":"Paper Towels","store":"Costco"},{"op":"update","index":2,"match":"Bread","set":{"done":true}}]`,
      `"actually make it 3 avocados and get rid of the chips" → [{"op":"update","index":5,"match":"Avocados","set":{"qty":"3"}},{"op":"remove","index":7,"match":"Chips"}]`,
      `"move everything from Target to Walmart and clear out what I've already gotten" → [{"op":"move_all","from":"Target","to":"Walmart"},{"op":"remove_all","done":true}]`,
      `"add Walmart and Best Buy as stores" → [{"op":"add_store","name":"Walmart"},{"op":"add_store","name":"Best Buy"}]`,
      `"copy the milk over to Walmart too" → [{"op":"add","name":"Milk","store":"Walmart"}]`,
      `"take the milk out of Costco" / "put the milk on its own" → [{"op":"update","index":1,"match":"Milk","set":{"store":"__NONE__"}}]`,
      `"add 2 furnace air filters, 20 by 20 by 1" → [{"op":"add","name":"Furnace Air Filter","qty":"2","desc":"20×20×1"}]`,
      `"a can of white semi-gloss paint for the bathroom trim" → [{"op":"add","name":"White Semi-Gloss Paint","qty":"1 can","desc":"bathroom trim"}]`,
      `"grab the organic strawberries, the big container" → [{"op":"add","name":"Strawberries","desc":"organic, big container"}]`,
    ],
  },
  packing: {
    what: 'a PACKING list — things to bring on a trip',
    group: 'CATEGORY — Clothing, Toiletries, Electronics, Documents, Medications, Accessories, Snacks… (short Title Case, max 3 words)',
    rules: [
      `- NAMES: the object to pack, clean Title Case, singular unless it's naturally plural ("Phone Charger", "Sunglasses", "Toothbrush", "Passport"). Keep the useful qualifier in the name when it identifies the object ("Laptop Charger", "Sunglasses Case"); other details go in desc ("ID" + desc "passport card").`,
      `- SPLIT: every object is its own item — "phone, laptop and headphones" = 3 adds; "laptop and its charger" = "Laptop" + "Laptop Charger". Counts go in qty ("5 pairs of socks" → name "Socks", qty "5 pairs").`,
      `- CATEGORIES: if the list ALREADY uses categories (SAVED GROUPS is not empty) or is EMPTY, put every new item in the best-fitting category (reuse a saved one's exact spelling when it fits). If the list already has items but NO categories, leave "store" empty unless the user names one or asks you to organize/categorize — then set a category on EVERY item (update ops for the existing ones).`,
      `- "when" only for a timing the user states ("pack the night before" → when "night before").`,
    ],
    examples: [
      `"I need my laptop and charger, phone, headphones, 5 pairs of socks and my passport" → [{"op":"add","name":"Laptop"},{"op":"add","name":"Laptop Charger"},{"op":"add","name":"Phone"},{"op":"add","name":"Headphones"},{"op":"add","name":"Socks","qty":"5 pairs"},{"op":"add","name":"Passport"}]`,
      `"add sunscreen, the travel size one, under toiletries" → [{"op":"add","name":"Sunscreen","store":"Toiletries","desc":"travel size"}]`,
      `"organize this by category" (list: 1. Phone 2. Toothbrush 3. Passport) → [{"op":"update","index":1,"match":"Phone","set":{"store":"Electronics"}},{"op":"update","index":2,"match":"Toothbrush","set":{"store":"Toiletries"}},{"op":"update","index":3,"match":"Passport","set":{"store":"Documents"}}]`,
      `"I packed the phone and the toothbrush" → [{"op":"update","index":1,"match":"Phone","set":{"done":true}},{"op":"update","index":2,"match":"Toothbrush","set":{"done":true}}]`,
      `"unpack everything, I'm starting over" → [{"op":"uncheck_all"}]`,
    ],
  },
  itinerary: {
    what: 'a trip ITINERARY — places to go and things to do',
    group: 'DAY — the day the stop belongs to ("Day 1", "Friday", "Sat Oct 4"). Use the user\'s own wording, short Title Case; reuse the exact spelling of a SAVED GROUP for the same day',
    rules: [
      `- NAMES: the place or activity as a clean proper name with correct official spelling — fix speech-to-text slips and abbreviations ("red rocks" → "Red Rocks Park & Amphitheatre", "16th street mall" → "16th Street Mall", "dinner at Linger" → "Dinner at Linger"). Never leave stray filler words in a name.`,
      `- ALREADY ON THE LIST: a stop that is already listed — even worded or spelled differently ("Red Rocks" ≈ "Red Rocks Park & Amphitheater", "lunch at Union Station" ≈ "Union Station") — gets an UPDATE that sets its day/time/details. NEVER add a second copy of a listed stop.`,
      `- "when" = the time or time of day for that stop exactly as planned ("9:00 AM", "Sunset", "Morning", "After lunch", "7:30 PM"; "around 1" → "~1:00 PM"). Normalize clock times to "h:mm AM/PM". Times ALWAYS go in "when", never in desc.`,
      `- "desc" = everything else worth keeping: address/area, reservation or confirmation details, tickets, cost, who's going, tips, how to get there ("Uber from hotel"), duration ("~2 hrs").`,
      `- ORDER MATTERS: add stops in the order the user says them. "put X before Y" / "move X to the top/end" / "swap X and Y" → "move" ops.`,
      `- DAYS: only set "store" (the day) when the user says which day, or the list already groups by day and the day is obvious from context.`,
      `- "qty" only for a count of people/tickets the user states ("tickets for 2" → qty "2 tickets").`,
    ],
    examples: [
      `"saturday morning we're hiking red rocks then lunch at Union Station around 1, dinner reservation at Linger at 7:30 under Patel" (list: 1. Red Rocks Park & Amphitheater 2. Union Station) → [{"op":"update","index":1,"match":"Red Rocks Park & Amphitheater","set":{"store":"Saturday","when":"Morning","desc":"hike"}},{"op":"update","index":2,"match":"Union Station","set":{"store":"Saturday","when":"~1:00 PM","desc":"lunch"}},{"op":"add","name":"Dinner at Linger","store":"Saturday","when":"7:30 PM","desc":"reservation under Patel"}]`,
      `"sunday brunch at Snooze at 9:30 then the botanic gardens" (empty list) → [{"op":"add","name":"Brunch at Snooze","store":"Sunday","when":"9:30 AM"},{"op":"add","name":"Denver Botanic Gardens","store":"Sunday"}]`,
      `"move Union Station before Red Rocks" (list: 1. Red Rocks Park & Amphitheater 2. Union Station) → [{"op":"move","index":2,"match":"Union Station","before":1}]`,
      `"we did Larimer Square" → [{"op":"update","index":4,"match":"Larimer Sqr & Auraria","set":{"done":true}}]`,
      `"add the Denver Art Museum on Sunday at 10, it's free for the first Saturday though, budget two hours" → [{"op":"add","name":"Denver Art Museum","store":"Sunday","when":"10:00 AM","desc":"~2 hrs; free on first Saturdays"}]`,
    ],
  },
  todo: {
    what: 'a TO-DO / checklist of tasks',
    group: 'SECTION — a phase or area ("Before Leaving", "At the Airport", "House", "Work"); short Title Case',
    rules: [
      `- NAMES: a concise ACTION phrase in sentence case, starting with a verb where natural ("Check in for flights", "Charge phone, laptop & headphones", "Call the vet"). Reword rambling speech into a clean task WITHOUT losing meaning; keep every object the user listed.`,
      `- ONE TASK = ONE ITEM: a single action that covers several objects stays one item ("charge my phone, laptop and headphones" = 1 add). Separate actions are separate items.`,
      `- "when" = timing or deadline ("24 hours before flight", "Before the drive to the airport", "Fri", "By 5 PM"). Move timing OUT of the name into "when".`,
      `- "desc" = extra detail/steps/notes ("both ways", "fill before drive, empty before security, refill after").`,
      `- SECTIONS: set "store" only if the user names a section or the list already uses sections and one clearly fits.`,
      `- "qty" only when the user gives an explicit count of repetitions/people ("for both of us" → qty "2").`,
    ],
    examples: [
      `"remember to check in for our flights 24 hours before, both ways" → [{"op":"add","name":"Check in for flights","when":"24 hours before flight","desc":"both ways"}]`,
      `"fully charge my phone laptop and headphones before we drive to the airport" → [{"op":"add","name":"Charge phone, laptop & headphones","when":"Before the drive to the airport"}]`,
      `"done with the flight check in" → [{"op":"update","index":1,"match":"Check in for flights","set":{"done":true}}]`,
      `"call the vet tomorrow and book the car service for friday at 6 am" → [{"op":"add","name":"Call the vet","when":"Tomorrow"},{"op":"add","name":"Book the car service","desc":"pickup Fri 6:00 AM"}]`,
    ],
  },
  reminders: {
    what: 'a REMINDERS list — things to remember, often with a date/time',
    group: 'CATEGORY — e.g. "Bills", "Birthdays", "Health", "Home" (short Title Case); only when the user names one or the list already uses categories',
    rules: [
      `- NAMES: a short, clear reminder in sentence case, verb first where natural ("Pay the electric bill", "Renew passport", "Mom's birthday").`,
      `- "when" = the date and/or time, ALWAYS resolved against TODAY to a concrete, compact date (with TODAY Thu Oct 1: "tomorrow at 5" → "Fri Oct 2 · 5:00 PM"; "next Friday" → "Fri Oct 9"; "the 15th" → "Thu Oct 15"). Keep recurring phrasing ("Every Monday", "Monthly on the 1st"). No date said → leave "when" empty.`,
      `- "desc" = any extra context (amount, account, where, who).`,
    ],
    examples: [
      `(say TODAY is Thu, Oct 1, 2026) "remind me to pay the Xcel bill on the 15th, it's about 120 bucks" → [{"op":"add","name":"Pay the Xcel bill","when":"Thu Oct 15","desc":"~$120"}]`,
      `(say TODAY is Thu, Oct 1, 2026) "mom's birthday is next friday, get her a card" → [{"op":"add","name":"Mom's birthday","when":"Fri Oct 9","desc":"get her a card"}]`,
      `(say TODAY is Thu, Oct 1, 2026) "push the dentist to Monday at 3" → [{"op":"update","index":2,"match":"Dentist appointment","set":{"when":"Mon Oct 5 · 3:00 PM"}}]`,
      `"take out the trash every Tuesday night" → [{"op":"add","name":"Take out the trash","when":"Every Tue night"}]`,
    ],
  },
  other: {
    what: 'a general-purpose list (ideas, gifts, notes, anything)',
    group: 'GROUP — any short Title Case heading that fits the content (a person, a topic, a category)',
    rules: [
      `- Work out what the list is FOR from its name and existing items, and structure new items the same way.`,
      `- NAMES: concise and clean, Title Case for things, sentence case for actions. Details go in desc; dates/times go in when; counts go in qty.`,
      `- GROUPS: set "store" only if the user names a group or the list already uses groups and one clearly fits.`,
    ],
    examples: [
      `"gift ideas for Veda, a Kindle Paperwhite the 16 gig one, and those Lululemon leggings in black size small" → [{"op":"add","name":"Kindle Paperwhite","store":"Veda","desc":"16 GB"},{"op":"add","name":"Lululemon Leggings","store":"Veda","desc":"black, size S"}]`,
      `"movies to watch: Dune Part Two and Oppenheimer" → [{"op":"add","name":"Dune: Part Two"},{"op":"add","name":"Oppenheimer"}]`,
    ],
  },
};

// The pasted links, one line each, and how to turn them into items.
// 1-based number of the unused link whose page title (or URL slug) best
// matches an item name, or 0.
export function linkForName(name, links, used) {
  const n = normName(name);
  if (!n) return 0;
  let best = 0, score = 0;
  (links || []).forEach((m, i) => {
    if (used && used.has(i + 1)) return;
    const t = normName((m && m.title) || '') + ' ' + normName(slugTitle((m && m.url) || ''));
    const sc = tokenOverlap(t, n);
    if (sc > score) { score = sc; best = i + 1; }
  });
  return score >= 0.6 ? best : 0;
}

function linkPromptLines(links, type) {
  if (!links || !links.length) return [];
  return [
    `LINKS: each [LINK n] in the input is a web page the worker already read:`,
    ...links.map((m, i) => `[LINK ${i + 1}] page title: "${m.title || '(unreadable)'}" | store/site: ${m.site || '?'}${m.price ? ' | price: ' + m.price : ''}`),
    `LINK RULES: every [LINK n] is an item — an "add" with "link": n (or, when the user says the link is FOR an item already on the list, an "update" of that item with "link": n). Never put a link, URL or "[LINK n]" in any text field.`,
    `- "name": a clean, short product name from the page title (or the user's own wording next to the link, which wins): drop the store/site, "priced per pound", SEO filler and pack sizes; keep the brand only when it identifies the product ("Premier Protein Powder, Vanilla" keeps Premier; "Member's Mark Italian Herb Grilled Chicken Breasts" → "Italian Herb Grilled Chicken Breasts").`,
    `- "desc": ONLY the size/weight/count/flavor/color ("3 lbs", "24 ct", "Vanilla") or the user's own note — never marketing or feature text from the title. A count of how many to BUY is "qty".`,
    type === 'shopping'
      ? `- "store": the heading the user put the link under when they gave headings; otherwise the link's store/site name (e.g. "Sam's Club").`
      : `- "store": the heading the user put the link under, if any.`,
    `Example: input "Proteins: Grilled chicken [LINK 1], [LINK 2]" with [LINK 2] = "Premier Protein Powder, Vanilla, 3 lbs" → [{"op":"add","link":1,"name":"Grilled Chicken","store":"Proteins"},{"op":"add","link":2,"name":"Premier Protein Powder","store":"Proteins","desc":"Vanilla, 3 lbs"}]`,
    ``,
  ];
}

function buildListPrompt(transcript, items, stores, hasAudio, listType, listName, today, links) {
  const type = normListType(listType);
  const g = LIST_TYPE_GUIDE[type];
  const source = hasAudio
    ? `FIRST, listen carefully to the attached audio of the user speaking (US English) and work out exactly what they said — use the list's context to correct mishearings (place names, brands, products). Then act on it.`
    : `Act on the user's input below.`;

  const listLines = (items && items.length)
    ? items.map((it, i) => {
        let line = `${i + 1}. ${it.name}`;
        if (it.qty) line += ` | qty: ${it.qty}`;
        if (it.when) line += ` | when: ${it.when}`;
        line += ` | group: ${it.store || '(none)'}`;
        if (it.desc) line += ` | note: ${it.desc}`;
        if (it.done) line += ` | DONE`;
        if (it.link && it.link.site) line += ` | link: ${it.link.site}`;
        return line;
      }).join('\n')
    : `(the list is empty)`;

  return [
    `You are a meticulous list assistant. The user manages ${g.what} by voice or text. Convert their input into a precise sequence of OPERATIONS ("ops") on the list. Capture EVERY item and EVERY detail they give, clean up the wording, and NEVER touch anything they did not mention.`,
    source,
    hasAudio ? `` : `USER INPUT (may be messy, run-on, or a pasted list): """${transcript}"""`,
    ``,
    ...linkPromptLines(links, type),
    `TODAY: ${today || '(unknown)'}`,
    `LIST NAME: ${listName || '(untitled)'}    LIST TYPE: ${type}`,
    ``,
    `CURRENT LIST (numbered — use an item's number as "index" when targeting it):`,
    listLines,
    ``,
    `SAVED GROUPS: ${stores && stores.length ? stores.join(', ') : '(none yet)'}`,
    ``,
    `ITEM FIELDS: "name" (required), "qty" (count/amount), "when" (date, time or timing), "desc" (every other detail), "store" = the item's GROUP. For this list the group is a ${g.group}.`,
    ``,
    `OPS (emit one per distinct change, in the order the user said them):`,
    `- {op:"add", name, qty?, when?, store?, desc?} — a NEW item. "desc" is MANDATORY whenever the user gives ANY detail beyond name/qty/when/group.`,
    `- {op:"update", index, match, set:{name?, qty?, when?, store?, desc?, done?}} — change ONE existing item: rename, new qty, new time, move to another group (set.store), add detail (set.desc — write the FULL new note, keeping the old note's content unless the user replaces it), check off / un-check (set.done). "index" = the item's number above; "match" = that item's name. Include BOTH.`,
    `- {op:"remove", index, match} — delete ONE existing item.`,
    `- {op:"move", index, match, before?} / {op:"move", index, match, pos:"top"|"bottom"} — REORDER: put the item right before item number "before", or at the top/bottom. "after item N" = before item N+1 (or pos "bottom" if N is last).`,
    `- {op:"move_all", from, to} — move EVERY item in group "from" to group "to". Both required.`,
    `- {op:"check_all", store?} / {op:"uncheck_all", store?} — check off (or un-check) every item, optionally only one group's.`,
    `- {op:"remove_all", store?, done?} — bulk delete. "clear the list" → {}. "remove everything that's done" → {done:true}. "delete all the Costco stuff" → {store:"Costco"}.`,
    `- {op:"add_store", name} / {op:"remove_store", name} / {op:"rename_store", name, newName} — manage the saved GROUPS themselves (removing a group keeps its items, ungrouped).`,
    `- {op:"rename_list", name} — rename the CURRENT LIST itself ("rename/call this list X"). Never use a group op for this.`,
    `- {op:"set_type", listType} — change what KIND of list this is, only when asked ("make this a packing list"). listType ∈ ${LIST_TYPES.join(' | ')}.`,
    `- {op:"new_list", name?, listType?} — the user wants a brand-NEW separate list ("start/make a new list (called X)"). Emit it FIRST; every op AFTER it applies to the new empty list. Set "listType" to the kind of list it is (${LIST_TYPES.join(' | ')}) from what they say ("packing list for Denver" → packing; "itinerary" → itinerary; "to-do" → todo; "groceries" → shopping; "reminders" → reminders; else other).`,
    ``,
    `UNIVERSAL RULES:`,
    `- COMPLETENESS FIRST: a single input often holds MANY items or changes (a dictated or pasted list can hold 20+). Emit one op per item/change — never drop, merge, or summarize away anything. Before answering, re-read the input and confirm every item, number, time, place and detail is captured somewhere (name, qty, when, store or desc).`,
    `- CLEAN WRITING: fix capitalization (keep acronyms upper-case: ID, TV, USB, ATM), spelling and obvious speech-to-text errors; turn spoken numbers into digits ("two" → "2") and dimensions into compact form ("20 by 20 by 1" → "20×20×1"); money as "$80"; remove filler ("um", "like", "I think we should", "and then"). Reword awkward phrasing into a crisp item, but keep the user's meaning and every specific.`,
    `- SELF-CORRECTIONS: honor the user's final intent ("add milk, no wait, oat milk" → only Oat Milk; "at 7, actually 8" → 8).`,
    `- "when" ONLY holds a time, date or timing the user actually stated for THAT item. Never fill it with TODAY's date or a guess; leave it out otherwise. Likewise only include fields that carry real content — omit empty ones.`,
    `- AUTO-DETAILS: the user never has to say "description" — sizes, specs, colors, flavors, purposes, preferences, addresses, reservations, notes all go in "desc" automatically. Keep desc short and telegraphic; never repeat the name, qty or when in it.`,
    `- ADD vs UPDATE: if the user adds something that is already on the list (same thing, not done), update that item (new TOTAL qty, extra detail) instead of duplicating it. Anything not on the list is an add.`,
    `- DUPLICATE vs MOVE: "copy X to GROUP", "add X at GROUP too" → a NEW add with that group (the original stays). Use update set:{store} only when they say to MOVE/switch/change its group.`,
    `- UNGROUPING: "take X out of GROUP", "X on its own", "remove X's group", "move X to Other" → update set:{store:"__NONE__"} (not a delete). "move everything out of GROUP" → {"op":"move_all","from":"GROUP","to":"__NONE__"}.`,
    `- CHECK-OFF: "got / bought / packed / did / done / finished / visited / check off X" → update set:{done:true}. "uncheck X / didn't do X / put X back" → set:{done:false}.`,
    `- Group names are short headings, never sentences. Never invent items, groups or details the user didn't give.`,
    `- If the input maps to no change, return ops: [].`,
    `- "note": ≤12-word confirmation of what you did ("Added 6 items; checked off bread.").`,
    ``,
    `RULES FOR THIS LIST TYPE (${type}):`,
    ...g.rules,
    ``,
    `EXAMPLES (input → ops):`,
    ...g.examples,
    `"change the name of the list to Weekend Plans" → [{"op":"rename_list","name":"Weekend Plans"}]`,
    `"start a new packing list called Denver Trip with my laptop and sunglasses" → [{"op":"new_list","name":"Denver Trip","listType":"packing"},{"op":"add","name":"Laptop"},{"op":"add","name":"Sunglasses"}]`,
  ].join('\n');
}

const LIST_OPS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    ops: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          op:      { type: 'STRING', enum: ['add', 'update', 'remove', 'move', 'move_all', 'check_all', 'uncheck_all', 'remove_all', 'add_store', 'remove_store', 'rename_store', 'rename_list', 'set_type', 'new_list'] },
          name:    { type: 'STRING' },
          qty:     { type: 'STRING' },
          when:    { type: 'STRING' },
          store:   { type: 'STRING' },
          desc:    { type: 'STRING' },
          done:    { type: 'BOOLEAN' },
          index:   { type: 'INTEGER' },
          match:   { type: 'STRING' },
          before:  { type: 'INTEGER' },
          link:    { type: 'INTEGER' },
          pos:     { type: 'STRING' },
          listType: { type: 'STRING' },
          newName: { type: 'STRING' },
          from:    { type: 'STRING' },
          to:      { type: 'STRING' },
          set: {
            type: 'OBJECT',
            properties: {
              name:  { type: 'STRING' },
              qty:   { type: 'STRING' },
              when:  { type: 'STRING' },
              store: { type: 'STRING' },
              desc:  { type: 'STRING' },
              done:  { type: 'BOOLEAN' },
            },
            propertyOrdering: ['name', 'qty', 'when', 'store', 'desc', 'done'],
          },
        },
        required: ['op'],
        // Gemini writes properties ALPHABETICALLY unless told otherwise, which put
        // "desc" before "name": the model had to commit to an item's details
        // before naming it, and routinely skipped them. Natural order instead —
        // the op, its target, the item, then its details.
        propertyOrdering: ['op', 'index', 'match', 'link', 'name', 'qty', 'when', 'store', 'desc', 'done', 'set', 'before', 'pos', 'from', 'to', 'newName', 'listType'],
      },
    },
    note: { type: 'STRING' },
  },
  required: ['ops'],
  propertyOrdering: ['ops', 'note'],
};

// Keeps the client's "id" so untouched/edited items keep their identity in the app.
function sanitizeItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(it => {
      const o = {
        name:  String(it.name || '').trim(),
        qty:   String(it.qty || '').trim(),
        when:  String(it.when || '').trim(),
        store: String(it.store || '').trim(),
        desc:  String(it.desc || '').trim(),
        done:  !!it.done,
      };
      if (it.id) o.id = String(it.id);
      const lk = linkField(it.link);
      if (lk) o.link = lk;
      return o;
    })
    .filter(it => it.name);
}

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokenOverlap(a, b) {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of tb) if (ta.has(t)) hit++;
  return hit / Math.min(ta.size, tb.size);
}
// Resolve an op's target: trust the 1-based index when its item also roughly
// matches the given name (guards against off-by-one), else fuzzy-match by name.
function findItem(items, index, match) {
  const m = normName(match);
  if (Number.isInteger(index) && index >= 1 && index <= items.length) {
    const it = items[index - 1];
    if (!m) return it;
    const n = normName(it.name);
    if (n === m || n.includes(m) || m.includes(n) || tokenOverlap(n, m) >= 0.5) return it;
  }
  if (!m) return null;
  let best = null, bestScore = 0;
  for (const it of items) {
    const n = normName(it.name);
    if (n === m) return it;
    const score = (n.includes(m) || m.includes(n)) ? 0.8 : tokenOverlap(n, m);
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore >= 0.5 ? best : null;
}

// A details string that is NOTHING but a time ("Morning", "~1:00 PM", "at 10",
// "7:30pm") belongs in "when". The lite models occasionally file it under desc.
const WHEN_ONLY = /^(?:(?:at|around|about|by|~)\s*)?(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon|midnight|morning|afternoon|evening|night|tonight|sunrise|sunset|early morning|late night)$/i;
const LEADING_CLOCK = /^((?:~|around |about |at )?\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\s*[;,·—–-]\s*(.+)$/i;
function looksLikeWhen(v) { const t = String(v || '').trim(); return !!t && t.length <= 24 && WHEN_ONLY.test(t) && /[a-z]|:/i.test(t); }

function applyListOps(items, stores, ops, type, links) {
  const timed = TIMED_LIST_TYPES.includes(type);
  // [LINK n] → the page the worker read. Each link attaches to at most one item.
  const linkList = Array.isArray(links) ? links : [];
  const usedLinks = new Set();
  // The op's "link" number, or — the lite models often leave it out — the
  // unused link whose page title best matches the item's name.
  const takeLink = (op, name) => {
    let n = parseInt(op && (op.link ?? (op.set && op.set.link)), 10);
    if (!(n >= 1 && n <= linkList.length) || usedLinks.has(n)) n = linkForName(name, linkList, usedLinks);
    if (!n) return null;
    usedLinks.add(n);
    return linkField(linkList[n - 1]);
  };
  // Move a time-only desc into when (only when no when was given).
  const fixWhen = (f) => {
    if (!timed || !f || typeof f !== 'object') return;
    if (String(f.when || '').trim()) return;
    if (looksLikeWhen(f.desc)) { f.when = String(f.desc).trim(); f.desc = ''; return; }
    // "7:30 PM; reservation under Patel" → when "7:30 PM", desc "reservation under Patel"
    const m = LEADING_CLOCK.exec(String(f.desc || '').trim());
    if (m) { f.when = m[1].trim(); f.desc = m[2].trim(); }
  };
  // Ops apply to a "target" list — normally the current list, but a new_list op
  // switches the target to a fresh empty list so the rest of the command builds it.
  const mkTarget = (list, storeNames) => {
    const t = { list, storeMap: new Map(), name: '', type: '' }; // storeMap: lowercase → clean display name
    storeNames.forEach(s => addStore(t, s));
    return t;
  };
  function addStore(t, s) { const v = String(s || '').trim(); if (v && v.length <= 40) t.storeMap.set(v.toLowerCase(), v); }
  // Prefer a saved group's exact spelling when the model names the same group.
  const canonStore = (t, s) => { const v = String(s || '').trim(); return v ? (t.storeMap.get(v.toLowerCase()) || v) : ''; };
  // Explicit "unassign this item's group" sentinel(s) — "move it out on its own".
  // Distinct from an empty string (which means "no change"), so a deliberate
  // unassign works WITHOUT letting stray blanks wipe groups. "other" maps here so
  // "move it to Other" drops the item into the implicit ungrouped section rather
  // than creating a literal group named Other.
  const noStore = (s) => /^(__none__|\(none\)|\(no ?(store|group)\)|no ?(store|group)|none|unassigned|ungrouped|uncategor(?:ized|ised)|other)$/i.test(String(s || '').trim());
  const whereMatch = (it, where) => {
    if (!where || typeof where !== 'object') return true;
    if (typeof where.store === 'string' && where.store.trim() &&
        normName(it.store) !== normName(where.store)) return false;
    if (typeof where.done === 'boolean' && it.done !== where.done) return false;
    return true;
  };
  // Apply only non-empty set fields — an empty string from the model must never
  // wipe a field the user didn't ask to clear.
  const applySet = (t, it, set, allowRename) => {
    if (!set || typeof set !== 'object') return;
    if (allowRename && typeof set.name === 'string' && set.name.trim()) it.name = set.name.trim();
    if (typeof set.qty === 'string' && set.qty.trim()) it.qty = set.qty.trim();
    if (typeof set.when === 'string' && set.when.trim()) it.when = set.when.trim();
    if (typeof set.store === 'string' && set.store.trim()) { it.store = noStore(set.store) ? '' : canonStore(t, set.store); if (it.store) addStore(t, it.store); }
    if (typeof set.desc === 'string' && set.desc.trim()) it.desc = set.desc.trim();
    if (typeof set.done === 'boolean') it.done = set.done;
  };
  // The model sometimes puts new values at the op's top level instead of inside
  // "set" (or the where filter in top-level "store"). Accept both shapes so a
  // slightly-off op still applies instead of silently doing nothing.
  const effSet = (op, keys) => {
    const merged = {};
    for (const k of keys) if (op[k] !== undefined) merged[k] = op[k];
    if (op.set && typeof op.set === 'object') Object.assign(merged, op.set);
    return merged;
  };
  const effWhere = (op) => {
    const w = (op.where && typeof op.where === 'object') ? { ...op.where } : {};
    if ((typeof w.store !== 'string' || !w.store.trim()) && typeof op.store === 'string' && op.store.trim()) w.store = op.store;
    if (typeof w.done !== 'boolean' && typeof op.done === 'boolean') w.done = op.done;
    return w;
  };
  const listType = (v) => { const s = String(v || '').toLowerCase().trim(); return LIST_TYPES.includes(s) ? s : ''; };

  const cur = mkTarget(items.map(it => ({ ...it })), stores);
  // "index" numbers in the model's ops refer to the list AS THE MODEL SAW IT.
  // Earlier ops (a remove, a reorder) shift positions, so resolve indexes
  // against this frozen snapshot first and only fall back to the live list.
  const original = cur.list.slice();
  const resolve = (t, index, match) => {
    if (t === cur) {
      const hit = findItem(original, index, match);
      if (hit && t.list.includes(hit)) return hit;
    }
    return findItem(t.list, index, match);
  };
  let nl = null;   // new list target, once a new_list op appears
  let t = cur;     // active target

  for (const op of (Array.isArray(ops) ? ops : [])) {
    if (!op || typeof op !== 'object') continue;
    // A field named "type" reads as "product type/variant" to the lite models,
    // which parked item details there ("16 GB", "black, size S"). The schema now
    // calls it listType, but an item op that still carries a stray non-list-type
    // "type" gets it back as the detail it was.
    if ((op.op === 'add' || op.op === 'update') && typeof op.type === 'string' && op.type.trim() && !listType(op.type)) {
      const tgt = (op.op === 'update' && op.set && typeof op.set === 'object') ? op.set : op;
      if (!String(tgt.desc || '').trim()) tgt.desc = op.type.trim();
    }
    if (op.op === 'add') fixWhen(op);
    if (op.op === 'update') fixWhen(op.set && typeof op.set === 'object' ? op.set : op);
    switch (String(op.op || '')) {
      case 'rename_list': {
        const name = String(op.name || op.newName || '').trim();
        if (name) t.name = name;
        break;
      }
      case 'set_type': {
        const ty = listType(op.listType || op.type || op.name);
        if (ty) t.type = ty;
        break;
      }
      case 'new_list': {
        nl = mkTarget([], []);
        nl.name = String(op.name || '').trim();
        nl.type = listType(op.listType || op.type);
        t = nl;
        break;
      }
      case 'add': {
        // effSet: the model sometimes nests fields under "set" even on adds.
        const f = effSet(op, ['name', 'qty', 'when', 'store', 'desc']);
        const name = String(f.name || '').trim();
        if (!name) break;
        const store = noStore(f.store) ? '' : canonStore(t, f.store);
        if (store) addStore(t, store);
        // Same item, same group (or no group involved) → merge instead of duplicating.
        // A DIFFERENT group means the user wants a copy there — keep both.
        const dup = t.list.find(it => !it.done && normName(it.name) === normName(name) &&
          (!store || !it.store || normName(it.store) === normName(store)));
        const lk = takeLink(op, name);
        if (dup && lk && dup.link && dup.link.url !== lk.url) {
          // Same name, different product page — keep both.
          t.list.push({ name, qty: String(f.qty || '').trim(), when: String(f.when || '').trim(), store, desc: String(f.desc || '').trim(), done: false, link: lk });
        } else if (dup) {
          if (lk) dup.link = lk;
          if (String(f.qty || '').trim()) dup.qty = String(f.qty).trim();
          if (String(f.when || '').trim()) dup.when = String(f.when).trim();
          if (store) dup.store = store;
          if (String(f.desc || '').trim()) dup.desc = String(f.desc).trim();
        } else {
          const row = { name, qty: String(f.qty || '').trim(), when: String(f.when || '').trim(), store, desc: String(f.desc || '').trim(), done: false };
          if (lk) row.link = lk;
          t.list.push(row);
        }
        break;
      }
      case 'update': {
        const set = effSet(op, ['name', 'qty', 'when', 'store', 'desc', 'done']);
        const it = resolve(t, op.index, op.match || op.name);
        const lk = takeLink(op, String(set.name || (it && it.name) || op.match || ''));
        if (it) { applySet(t, it, set, true); if (lk) it.link = lk; break; }
        // Target not found (e.g. user thinks it's on the list) — add it so the command still lands.
        const name = String(set.name || op.match || '').trim();
        if (name) {
          const fresh = { name, qty: '', when: '', store: '', desc: '', done: false };
          applySet(t, fresh, set, true);
          if (lk) fresh.link = lk;
          t.list.push(fresh);
        }
        break;
      }
      case 'remove': {
        const it = resolve(t, op.index, op.match);
        if (it) t.list = t.list.filter(x => x !== it);
        break;
      }
      case 'move': {
        const it = resolve(t, op.index, op.match || op.name);
        if (!it) break;
        const pos = String(op.pos || '').toLowerCase();
        const anchor = Number.isInteger(op.before) ? resolve(t, op.before, '') : null;
        if (anchor === it) break;
        const rest = t.list.filter(x => x !== it);
        let at;
        if (anchor) at = rest.indexOf(anchor);
        else if (pos === 'top' || pos === 'first' || pos === 'start') at = 0;
        else if (pos === 'bottom' || pos === 'last' || pos === 'end') at = rest.length;
        else break;                                         // no destination → leave it
        if (at < 0) at = rest.length;
        rest.splice(at, 0, it);
        // Moving before an item in another group joins that group — otherwise
        // the item would render back under its old heading and the move would
        // look like it did nothing.
        if (anchor && normName(anchor.store) !== normName(it.store)) it.store = anchor.store;
        t.list = rest;
        break;
      }
      case 'move_all': {
        const from = normName(op.from);
        const none = noStore(op.to);
        const to = none ? '' : canonStore(t, op.to);
        if (!to && !none) break;   // no destination given → ignore (but "__NONE__" = unassign all)
        if (to) addStore(t, to);
        for (const it of t.list) if (normName(it.store) === from) it.store = to;
        break;
      }
      case 'check_all':
      case 'uncheck_all': {
        const done = op.op === 'check_all';
        const f = normName(op.store);
        for (const it of t.list) if (!f || normName(it.store) === f) it.done = done;
        break;
      }
      case 'update_all': { // legacy shape — kept in case a model emits it anyway
        const where = effWhere(op);
        const set = (op.set && typeof op.set === 'object') ? { ...op.set } : {};
        if (set.store === undefined && typeof op.to === 'string' && op.to.trim()) set.store = op.to;
        for (const it of t.list) if (whereMatch(it, where)) applySet(t, it, set, false);
        break;
      }
      case 'remove_all': {
        const where = effWhere(op);
        t.list = t.list.filter(it => !whereMatch(it, where));
        break;
      }
      case 'add_store': {
        addStore(t, op.name);
        break;
      }
      case 'remove_store': {
        const k = String(op.name || '').trim().toLowerCase();
        if (!k) break;
        t.storeMap.delete(k);
        t.list.forEach(it => { if (it.store.toLowerCase() === k) it.store = ''; });
        break;
      }
      case 'rename_store': {
        const from = String(op.name || '').trim(), to = String(op.newName || '').trim();
        if (!from || !to) break;
        t.storeMap.delete(from.toLowerCase());
        addStore(t, to);
        t.list.forEach(it => { if (it.store.toLowerCase() === from.toLowerCase()) it.store = canonStore(t, to); });
        break;
      }
    }
  }

  // A link the model skipped still lands: named from its page, under its store
  // on a shopping list. Nothing the user pasted is ever dropped.
  linkList.forEach((m, i) => {
    if (usedLinks.has(i + 1) || !m || !m.url) return;
    if ((nl || cur).list.some(it => it.link && it.link.url === m.url)) return;
    const store = type === 'shopping' || (nl && nl.type === 'shopping') ? canonStore(nl || cur, m.site) : '';
    (nl || cur).list.push({ name: linkItemName(m), qty: '', when: '', store, desc: '', done: false, link: linkField(m) });
  });
  cur.list.forEach(it => addStore(cur, it.store));
  const out = { items: cur.list, stores: [...cur.storeMap.values()], listName: cur.name, listType: cur.type };
  if (nl) {
    nl.list.forEach(it => addStore(nl, it.store));
    out.newList = { name: nl.name, type: nl.type, items: nl.list, stores: [...nl.storeMap.values()] };
  }
  return out;
}

// How many separate entries a typed input obviously holds: one per non-empty
// line once there are 3+ lines (a pasted or bulleted list). Used only to catch
// a model that silently summarized a long list into a few items.
function listInputEntries(transcript) {
  const lines = String(transcript || '').split(/\r?\n/)
    .map(s => s.replace(/^\s*(?:[-*•·]|\d+[.)]|\[[ xX]?\])\s*/, '').trim())
    .filter(s => s.length > 1);
  return lines.length >= 3 ? lines.length : 0;
}

// Numbers are the details models drop most (times, counts, sizes, prices,
// dates), and the easiest to check: every number the user TYPED must show up
// somewhere in the ops that add or change items. Returns the missing ones.
function numbersIn(text) {
  return (String(text || '').match(/\d+/g) || []).map((n) => String(parseInt(n, 10)));
}
function missingNumbers(transcript, ops) {
  const said = [...new Set(numbersIn(transcript))];
  if (!said.length || !Array.isArray(ops)) return [];
  const changes = ops.filter((o) => o && (o.op === 'add' || o.op === 'update' || o.op === 'new_list' || o.op === 'move'));
  if (!changes.length) return [];                       // pure removals/bulk ops: nothing to check
  const got = new Set();
  for (const o of ops) {
    if (!o || typeof o !== 'object') continue;
    for (const v of [o.name, o.qty, o.when, o.store, o.desc, o.match, o.from, o.to, o.newName,
                     o.set && o.set.name, o.set && o.set.qty, o.set && o.set.when, o.set && o.set.store, o.set && o.set.desc]) {
      numbersIn(v).forEach((n) => got.add(n));
    }
    for (const v of [o.index, o.before]) if (Number.isInteger(v)) got.add(String(v));
  }
  return said.filter((n) => !got.has(n));
}

// A request is "dictation" when it is long enough that faithfulness beats
// latency: any voice clip over a few seconds, or typed input that is clearly a
// list rather than a one-line command.
function isListDictation(transcript, audio) {
  if (audio) return audio.length > 200000;                 // ≈ >4.5 s of 16 kHz mono WAV, base64
  const words = String(transcript || '').trim().split(/\s+/).filter(Boolean).length;
  return words > 45 || listInputEntries(transcript) >= 4;
}

// Staggered race for MyList. Measured live (2026-10-02): Gemini latency for the
// SAME request swings from ~1 s to >14 s, and the slow spells hit every model
// at once. A sequential chain then stacks timeouts (14 s + 14 s + …) before
// anyone answers. Instead the lead model starts alone; if it hasn't answered
// within `staggerMs`, the next model starts ALONGSIDE it (never cancelling the
// leader, which may be seconds from done), and so on, up to `maxLive` calls in
// flight. A quota/error outcome starts the next model at once. First answer
// that passes `validate` wins; a well-formed but lossy one is kept as a
// fallback. Fast requests (the normal case) never start a second call, so
// quota use is unchanged.
//
// Self-correction: when an answer is lossy and `o.repairPrompt(value)` gives a
// follow-up prompt, the SAME model gets one chance to fix its own answer (told
// exactly what it missed) while the next model starts as usual — whichever
// passes first wins. Lite models are inconsistent run to run, not incapable,
// so a pointed second look usually lands in ~1-2 s.
function runStaggered(models, key, o) {
  const t0 = Date.now();
  const deadline = t0 + (o.deadlineMs || 45000);
  const left = () => deadline - Date.now();
  const tried = [], errs = [];
  let soft = null, live = 0, next = 0, done = false, timer = null;
  return new Promise((resolve, reject) => {
    const finish = (val) => {
      if (done) return; done = true; clearTimeout(timer);
      if (val) return resolve({ ...val, tried: tried.slice() });
      if (soft) return resolve({ ...soft, tried: tried.slice() });
      const err = new Error(errs.slice(-3).join(' | ') || 'all models failed');
      err.tried = tried.slice();
      reject(err);
    };
    const settleIfIdle = () => { if (!done && live === 0 && (next >= models.length || left() < 1500)) finish(null); };
    const run = (model, opts, label, onDone) => {
      live++; tried.push(label);
      const attempt = async (n) => {
        const r = await aiOnce(model, key, opts, Math.min(o.timeoutMs || 20000, Math.max(1000, left())));
        // o.retry === false: a second try of the same model is slower than the
        // next one in the chain (Refine, where every second shows).
        if (r.cls === 'retry' && n === 0 && o.retry !== false && !done && left() > 3000) { await sleep(250); return attempt(1); }
        return r;
      };
      attempt(0).then((r) => { live--; if (!done) onDone(r); },
        (e) => { live--; if (!done) onDone({ cls: 'fatal', err: label + ': ' + ((e && e.message) || 'error') }); });
    };
    const launch = () => {
      if (done || next >= models.length || left() < 1500) { settleIfIdle(); return; }
      const model = models[next++];
      clearTimeout(timer);
      if (live + 1 < (o.maxLive || 3)) timer = setTimeout(launch, o.staggerMs || 4000);
      run(model, o, model, (r) => {
        if (r.cls === 'ok') {
          if (!o.validate || o.validate(r.value)) return finish({ value: r.value, model });
          if (!soft) soft = { value: r.value, model, soft: true };
          errs.push(model + ': lossy extraction');
          const fix = o.repairPrompt && left() > 3000 ? o.repairPrompt(r.value) : null;
          if (fix) {
            run(model, { ...o, prompt: fix }, model + ':repair', (r2) => {
              if (r2.cls === 'ok' && (!o.validate || o.validate(r2.value))) return finish({ value: r2.value, model: model + ':repair' });
              errs.push(model + ':repair ' + (r2.cls === 'ok' ? 'still lossy' : r2.err));
              settleIfIdle();
            });
          }
        } else errs.push(r.err);
        launch();                // this one failed — the next model starts now
        settleIfIdle();
      });
    };
    launch();
  });
}

// ── Links in lists ──────────────────────────────────────────────────────────
// A pasted product link becomes a clean item: the worker reads the page (the
// schema.org Product block, then Open Graph, then <title>, then the URL slug)
// for its name, photo, price and store, hands the model one short line per link,
// and the model only has to name the item and place it. Each item keeps
// `link: {url, title, image, price, site}`.
const LINK_RE = /https?:\/\/[^\s<>"'`\])}]+/gi;
// The URLs in a text, in order, without trailing punctuation, deduped, capped.
export function listUrls(text) {
  const out = [];
  for (const m of String(text || '').match(LINK_RE) || []) {
    const u = m.replace(/[.,;:!?*]+$/, '');
    if (u.length > 12 && !out.includes(u)) out.push(u);
    if (out.length >= 30) break;
  }
  return out;
}
const SITE_NAMES = {
  'samsclub.com': "Sam's Club", 'amazon.com': 'Amazon', 'amzn.to': 'Amazon', 'a.co': 'Amazon', 'walmart.com': 'Walmart',
  'target.com': 'Target', 'costco.com': 'Costco', 'kingsoopers.com': 'King Soopers', 'kroger.com': 'Kroger',
  'wholefoodsmarket.com': 'Whole Foods', 'traderjoes.com': "Trader Joe's", 'bestbuy.com': 'Best Buy',
  'homedepot.com': 'Home Depot', 'lowes.com': "Lowe's", 'ikea.com': 'IKEA', 'etsy.com': 'Etsy', 'ebay.com': 'eBay',
  'instacart.com': 'Instacart', 'heb.com': 'H-E-B', 'safeway.com': 'Safeway', 'aldi.us': 'Aldi', 'sprouts.com': 'Sprouts',
  'cvs.com': 'CVS', 'walgreens.com': 'Walgreens', 'apple.com': 'Apple', 'nike.com': 'Nike', 'wayfair.com': 'Wayfair',
  'chewy.com': 'Chewy', 'rei.com': 'REI', 'macys.com': "Macy's", 'nordstrom.com': 'Nordstrom', 'kohls.com': "Kohl's",
  'ulta.com': 'Ulta', 'sephora.com': 'Sephora', 'bjs.com': "BJ's", 'publix.com': 'Publix', 'meijer.com': 'Meijer',
  'iherb.com': 'iHerb', 'gnc.com': 'GNC', 'dickssportinggoods.com': "Dick's", 'bedbathandbeyond.com': 'Bed Bath & Beyond',
};
function hostOf(url) { try { return new URL(url).hostname.toLowerCase().replace(/^(www\d?|smile|m)\./, ''); } catch (e) { return ''; } }
export function siteName(url, ogSite) {
  const h = hostOf(url);
  for (const d in SITE_NAMES) if (h === d || h.endsWith('.' + d)) return SITE_NAMES[d];
  const og = String(ogSite || '').trim().replace(/\.(com|net|org|us|co)$/i, '');
  if (og && og.length <= 30) return og;
  const base = h.split('.').slice(-2, -1)[0] || h;
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : '';
}
export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
// A readable name from the URL path when the page itself can't be read
// (".../members-mark-italian-herb-grilled-chicken-breast-5-count/13590050893").
export function slugTitle(url) {
  let segs = [];
  try { segs = new URL(url).pathname.split('/').map(decodeURIComponent); } catch (e) { return ''; }
  const best = segs.filter(s => /[a-z]/i.test(s) && /[-_+]/.test(s) && !/^[A-Z0-9]{10}$/.test(s))
    .sort((a, b) => b.length - a.length)[0];
  if (!best) return '';
  return best.replace(/\.(html?|aspx?|php)$/i, '').replace(/[-_+]+/g, ' ').trim()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase()).slice(0, 120);
}
// Store branding stuck on a page title: "… - Samsclub.com", "Amazon.com: … :
// Grocery & Gourmet Food", "… : Target", "… | Walmart.com".
export function cleanTitle(t, site) {
  let s = decodeEntities(t).replace(/\s+/g, ' ').trim();
  s = s.replace(/^amazon\.com\s*:\s*/i, '').replace(/\s*:\s*(amazon\.com|[A-Z][\w&,' ]{2,40})$/, (m, g) =>
    /amazon|target|grocery|home|kitchen|health|beauty|electronics|sports|toys|clothing|office|pet|baby|tools|automotive|garden/i.test(g) ? '' : m);
  const siteKey = String(site || '').toLowerCase().replace(/[^a-z]/g, '');
  for (let i = 0; i < 2; i++) {
    const m = /^(.*\S)\s+[-|–—:]\s+([^-|–—:]{2,40})$/.exec(s);
    if (!m) break;
    const tail = m[2].toLowerCase().replace(/[^a-z]/g, '');
    if (/\.(com|net|org|us)$/i.test(m[2].trim()) || (siteKey && (tail.includes(siteKey) || siteKey.includes(tail))) ||
        /^(shop|buy|official site|online|free shipping)/i.test(m[2])) s = m[1];
    else break;
  }
  return s.slice(0, 160);
}
function metaTags(html) {
  const out = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const a = {};
    tag.replace(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, k, v1, v2) => { a[k.toLowerCase()] = v1 != null ? v1 : v2; });
    const k = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (k && a.content && !(k in out)) out[k] = a.content;
  }
  return out;
}
function firstImage(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return firstImage(v[0]);
  return typeof v === 'object' ? String(v.url || v.contentUrl || '') : '';
}
function ldProduct(html) {
  const blocks = html.match(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
  const isProduct = (o) => o && typeof o === 'object' && [].concat(o['@type'] || []).some(t => /^(Product|ProductGroup|IndividualProduct)$/.test(t));
  const find = (o, d) => {
    if (!o || typeof o !== 'object' || d > 5) return null;
    if (isProduct(o)) return o;
    for (const v of Array.isArray(o) ? o : [o['@graph'], o.mainEntity, o.itemListElement].filter(Boolean)) {
      const hit = find(v, d + 1); if (hit) return hit;
    }
    return null;
  };
  for (const b of blocks) {
    try {
      const p = find(JSON.parse(b.replace(/^<script[^>]*>|<\/script>$/gi, '').trim()), 0);
      if (!p) continue;
      let offer = [].concat(p.offers || [])[0] || {};
      if (offer.offers) offer = [].concat(offer.offers)[0] || offer;
      const price = offer.price ?? offer.lowPrice ?? (offer.priceSpecification && offer.priceSpecification.price);
      return { name: p.name, image: firstImage(p.image), price, currency: offer.priceCurrency };
    } catch (e) { /* a broken block — try the next */ }
  }
  return null;
}
function fmtPrice(v, cur) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
  if (!isFinite(n) || n <= 0) return '';
  const c = String(cur || 'USD').toUpperCase();
  return (c === 'USD' ? '$' : c + ' ') + n.toFixed(2);
}
function absUrl(u, base) {
  try { const x = new URL(decodeEntities(u), base); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch (e) { return ''; }
}
// Everything a list item can show from one page's HTML (pure; tested).
export function extractLinkMeta(html, url) {
  const h = String(html || '');
  const meta = metaTags(h);
  const ld = ldProduct(h) || {};
  const titleTag = (/<title[^>]*>([^<]{2,300})/i.exec(h) || [])[1] || '';
  const site = siteName(url, decodeEntities(meta['og:site_name'] || ''));
  const raw = ld.name || meta['og:title'] || meta['twitter:title'] || titleTag;
  const blocked = /robot|captcha|access denied|are you a human|page not found|just a moment|sign in/i.test(titleTag) && !ld.name && !meta['og:title'];
  const title = blocked ? '' : cleanTitle(raw, site);
  // Amazon keeps its photo and price in the body, not the head.
  const bodyImg = (/data-old-hires="(https:[^"]+)"/.exec(h) || /id="landingImage"[^>]*?src="(https:[^"]+)"/.exec(h) || [])[1] || '';
  const bodyPrice = (/"priceAmount":\s*([0-9.]+)/.exec(h) || [])[1];
  const image = blocked ? '' : absUrl(ld.image || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'] || bodyImg, url);
  const price = fmtPrice(ld.price ?? meta['product:price:amount'] ?? meta['og:price:amount'] ?? bodyPrice, ld.currency || meta['product:price:currency'] || meta['og:price:currency']);
  return { url, title: title || slugTitle(url), image, price, site, read: !!title };
}
const LINK_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',   // many stores serve link-preview bots their OG tags
];
const linkCache = new Map();   // per isolate — repeated pastes of one link are free
// Measured 2026-10-15: from Cloudflare's IPs Sam's Club, Walmart, Target and
// Amazon all answer with a bot wall, so the worker ALSO asks Jina's free reader
// (r.jina.ai, ~20 req/min keyless), which returned every one of them in 1–4 s.
// The direct fetch still wins for the many sites that don't block.
const isAmazon = (url) => /(^|\.)amazon\.|(^|\.)amzn\.to$|(^|\.)a\.co$/.test(hostOf(url));
// Twelve links pasted at once all hit the reader together and most came back
// 429 (2026-10-15) — so one request's reader calls queue, three at a time.
// The queue is PER REQUEST: a module-level one woke waiters from another
// request's context, which Workers never resolves (the request hung → 1101).
export function makeLimiter(n) {
  let live = 0;
  const wait = [];
  const next = () => { if (live < n && wait.length) { live++; wait.shift()(); } };
  return (fn) => new Promise((resolve) => {
    wait.push(() => Promise.resolve().then(fn).then(resolve, () => resolve(null)).finally(() => { live--; next(); }));
    next();
  });
}
function fetchPage(url, ms, via, dbg, lim) {
  return (via === 'jina' && lim) ? lim(() => fetchPageNow(url, ms, via, dbg)) : fetchPageNow(url, ms, via, dbg);
}
async function fetchPageNow(url, ms, via, dbg) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const target = via === 'jina' ? 'https://r.jina.ai/' + url : url;
    const headers = via === 'jina'
      ? Object.assign({ 'X-Return-Format': 'html' }, isAmazon(url) ? {} : { 'X-Target-Selector': 'head' })
      : { 'User-Agent': via, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' };
    let r = await fetch(target, { signal: ac.signal, redirect: 'follow', headers });
    // The keyless reader rate-limits PER IP, and Cloudflare's egress IPs are
    // shared — a 429 asks for ~2 s, and the retry usually leaves from another IP.
    for (let i = 0; via === 'jina' && r.status === 429 && i < 3; i++) {
      await sleep(600 + i * 700);
      r = await fetch(target, { signal: ac.signal, redirect: 'follow', headers });
    }
    if (dbg && !r.ok) return { status: r.status, body: (await r.text()).slice(0, 300) };
    if (!r.ok || !/html|text\/plain/i.test(r.headers.get('content-type') || 'html')) return null;
    const html = (await r.text()).slice(0, 3500000);
    const m = extractLinkMeta(html, url);
    if (via !== 'jina' && r.url && r.url !== url) { const finalSite = siteName(r.url); if (finalSite) m.site = finalSite; }
    if (dbg) return { status: r.status, read: m.read, title: m.title, image: !!m.image };
    return m.read ? m : null;
  } catch (e) { return dbg ? { error: String(e && e.message) } : null; } finally { clearTimeout(timer); }
}
function okLinkUrl(url) {
  let u; try { u = new URL(url); } catch (e) { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  return !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/i.test(u.hostname) && u.hostname.includes('.');
}
// Read one link: the direct fetches and the reader race, the first page that
// names a product wins (one with a photo beats one without, briefly), and a
// page that can't be read still yields a slug name + store.
export async function linkMeta(url, ms = 7000, lim) {
  const fallback = { url, title: slugTitle(url), image: '', price: '', site: siteName(url), read: false };
  if (!okLinkUrl(url)) return fallback;
  const hit = linkCache.get(url);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.v;
  const v = await new Promise((resolve) => {
    const ways = [...LINK_UAS, 'jina'];
    let left = ways.length, noPhoto = null, grace = null;
    const done = (m) => { clearTimeout(grace); resolve(m); };
    ways.forEach((via) => fetchPage(url, ms, via, false, lim).then((m) => {
      if (m && m.image) return done(m);
      if (m && !noPhoto) { noPhoto = m; grace = setTimeout(() => done(noPhoto), 1500); }
      if (--left === 0) done(noPhoto || fallback);
    }));
  });
  if (v.read) { linkCache.set(url, { at: Date.now(), v }); if (linkCache.size > 300) linkCache.delete(linkCache.keys().next().value); }
  return v;
}
export function linkField(m) {
  if (!m || !m.url) return null;
  const o = { url: String(m.url).slice(0, 2000) };
  for (const k of ['title', 'image', 'price', 'site']) if (m[k]) o[k] = String(m[k]).slice(0, k === 'image' ? 2000 : 200);
  return o;
}
// GET /link/preview?url=… — the manual add/edit form's reader.
async function handleLinkPreview(url) {
  const target = String(url.searchParams.get('url') || '').trim();
  if (!okLinkUrl(target)) return json({ ok: false, error: 'not a web link' }, 400);
  if (url.searchParams.get('debug')) {
    // Which way in works for this site (direct with each user agent, the reader).
    const ways = [...LINK_UAS, 'jina'];
    const out = await Promise.all(ways.map(async (via) => { const t0 = Date.now(); const m = await fetchPage(target, 9000, via, true); return { via: via.slice(0, 30), ms: Date.now() - t0, ...m }; }));
    return json({ ok: true, ways: out });
  }
  const m = await linkMeta(target);
  return json({ ok: true, link: linkField(m), read: m.read, name: m.read ? linkItemName(m) : '', detail: m.read ? linkDetail(m) : '' });
}
// The short name a link gets when no model named it (every model failed, or
// the model skipped it): the page title up to its first comma/size clause.
// POST /link/parse {url, html} — the app read the page itself (through the
// reader, on the viewer's own IP and quota, when the worker's shared Cloudflare
// IPs are rate-limited) and only needs it understood. Nothing is fetched here.
async function handleLinkParse(body) {
  const target = String(body.url || '').trim();
  if (!okLinkUrl(target)) return json({ ok: false, error: 'not a web link' }, 400);
  const m = extractLinkMeta(String(body.html || '').slice(0, 2500000), target);
  if (m.read) { linkCache.set(target, { at: Date.now(), v: m }); if (linkCache.size > 300) linkCache.delete(linkCache.keys().next().value); }
  return json({ ok: true, link: linkField(m), read: m.read, name: m.read ? linkItemName(m) : '', detail: m.read ? linkDetail(m) : '' });
}
// The size/flavor part of a page title once the short name is taken off
// ("…Fillets, Frozen, 3 lbs." → "Frozen, 3 lbs").
export function linkDetail(m) {
  const t = String((m && m.title) || '').trim(), raw = linkItemName(m, true);
  if (!t.startsWith(raw)) return '';
  return t.slice(raw.length).replace(/^[\s,|(–-]+/, '').replace(/\)\s*$/, '')
    .replace(/,?\s*priced per pound/i, '').replace(/[.\s]+$/, '').trim().slice(0, 80);
}
// Store brands say nothing on a list that already shows the store.
const STORE_BRANDS = /^(member'?s mark|great value|kirkland signature|good & gather|market pantry|365 by whole foods market|equate|up & up)\s+/i;
export function linkItemName(m, keepBrand) {
  let t = String((m && m.title) || '').split(/\s*,\s*(?:priced|per|pack|\d)|\s+[|(]|\s+[-–]\s+\d/i)[0].trim();
  if (!keepBrand && STORE_BRANDS.test(t) && t.replace(STORE_BRANDS, '').length > 3) t = t.replace(STORE_BRANDS, '');
  return (t || (m && m.site) || 'Link').slice(0, 90);
}

async function handleList(body, env) {
  const profile = body.profile === 'veda' ? 'veda' : 'tony';
  const transcript = String(body.transcript || '').trim();
  const audio = typeof body.audio === 'string' ? body.audio : '';
  const mimeType = String(body.mimeType || 'audio/webm');
  const items = sanitizeItems(body.items);
  const stores = Array.isArray(body.stores) ? body.stores.filter(Boolean).map(String) : [];
  const listType = normListType(body.listType);
  const listName = String(body.listName || '').trim().slice(0, 80);
  const today = String(body.today || '').trim().slice(0, 60) || new Date().toDateString();

  if (!transcript && !audio) return json({ ok: false, error: 'no transcript or audio' }, 400);
  const key = keyFor(env, profile);
  if (!key) return json({ ok: false, error: `no Gemini key configured for ${profile}` }, 500);

  // Links: every page is read in parallel (≤6 s for all of them) BEFORE the
  // model runs, and the model sees "[LINK n]" + one line per page instead of
  // the raw URLs — far fewer tokens, and the numbers inside a URL never trip
  // the dropped-number check.
  const urls = listUrls(transcript);
  const lim = makeLimiter(3);
  const links = urls.length ? await Promise.all(urls.map(u => Promise.race([
    linkMeta(u, 9000, lim),
    sleep(10000).then(() => ({ url: u, title: slugTitle(u), image: '', price: '', site: siteName(u), read: false })),
  ]))) : [];
  let modelText = transcript, checkText = transcript;
  urls.map((u, i) => [u, i]).sort((a, b) => b[0].length - a[0].length).forEach(([u, i]) => {
    modelText = modelText.split(u).join('[LINK ' + (i + 1) + ']');
    checkText = checkText.split(u).join(' ');
  });

  const prompt = buildListPrompt(modelText, items, stores, !!audio, listType, listName, today, links);
  const dictation = isListDictation(checkText, audio);
  let models = links.length ? LIST_LINK_MODELS
    : dictation ? LIST_DICTATION_MODELS : (TIMED_LIST_TYPES.includes(listType) ? LIST_TIMED_MODELS : LIST_MODELS);
  // Debug-only: pin one model so the chain can be compared model-by-model.
  if (body.debug && typeof body.model === 'string' && /^gemini-[\w.-]+$/.test(body.model)) models = [body.model];

  const entries = listInputEntries(transcript);
  const words = links.length + checkText.split(/\s+/).filter(Boolean).length;
  // Quality bar. A lossy answer escalates to the next model (the chain keeps it
  // as a fallback, so the user still gets it if nothing better comes back):
  //  - a pasted/bulleted list that came back with far fewer ops than lines;
  //  - an empty answer to a real typed request (silence/noise audio is allowed
  //    to be empty — there may genuinely be nothing to do);
  //  - a typed request whose numbers (times, counts, sizes, prices) didn't all
  //    make it into the result.
  const validate = (v) => {
    if (!v || !Array.isArray(v.ops)) return false;
    if (entries >= 3 && v.ops.length < Math.ceil(entries * 0.7)) return false;
    if (!audio && words >= 3 && v.ops.length === 0) return false;
    if (!audio && missingNumbers(checkText, v.ops).length) return false;
    // Every link must be used — a skipped one escalates (and still lands via
    // applyListOps' fallback if no model does better).
    if (links.length && v.ops.filter(o => o && (o.op === 'add' || o.op === 'update')).length < links.length) return false;
    return true;
  };

  // Self-correction prompt for a lossy typed answer: hand the model its own ops
  // and name exactly what it dropped.
  const repairPrompt = audio ? null : (v) => {
    const miss = missingNumbers(checkText, v && v.ops);
    if (!miss.length) return null;
    return prompt + '\n\nYOUR FIRST ANSWER (ops) WAS:\n' + JSON.stringify(v.ops) +
      '\n\nIt LOST details: the user said ' + miss.map((n) => '"' + n + '"').join(', ') +
      ' but those numbers appear nowhere in your ops. Re-read the user input and return the COMPLETE corrected ops — every time in "when", every count in "qty", every size/price/other detail in "desc". Keep everything that was already right.';
  };

  try {
    const r = await runStaggered(models, key, {
      repairPrompt,
      prompt, schema: LIST_OPS_SCHEMA, maxOutputTokens: 8192, feature: 'list', audio, mimeType,
      validate,
      salvage: salvageListOps,
      thinkingLevel: (body.debug && /^(minimal|low|medium|high)$/.test(String(body.thinking || ''))) ? body.thinking : undefined,
      staggerMs: links.length ? 2500 : dictation ? 6000 : 3500,
      timeoutMs: dictation ? 30000 : 22000,
      deadlineMs: dictation ? 50000 : 40000,
    });
    const out = r.value || {};
    const ops = Array.isArray(out.ops) ? out.ops : [];
    const res = applyListOps(items, stores, ops, listType, links);
    const resp = { ok: true, items: res.items, stores: res.stores, note: String(out.note || '').trim(), ops: ops.length, model: r.model };
    if (res.listName) resp.listName = res.listName;
    if (res.listType) resp.listType = res.listType;
    if (res.newList) resp.newList = res.newList;
    if (r.soft) resp.lossy = true;
    if (out.truncated) resp.truncated = true;
    if (body.debug) { resp.opsDetail = ops; resp.tried = r.tried; resp.dictation = dictation; }
    return json(resp);
  } catch (e) {
    // Every model failed, but the links were read: add them anyway (named from
    // their pages) so a pasted link never bounces.
    if (links.length) {
      const res = applyListOps(items, stores, [], listType, links);
      return json({ ok: true, items: res.items, stores: res.stores, note: 'Added ' + links.length + ' link' + (links.length > 1 ? 's' : '') + ' (AI busy — names from the pages)', ops: 0, model: 'none', tried: e && e.tried });
    }
    return json({ ok: false, error: (e && e.message) || 'all models failed', tried: e && e.tried }, 502);
  }
}

// Truncation rescue for list ops: keep every complete op already emitted.
function salvageListOps(text) {
  const at = text.indexOf('"ops"');
  if (at < 0) return null;
  const s = salvageJson('{"actions"' + text.slice(at + 5));
  return s ? { ops: s.actions, note: '', truncated: true } : null;
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 2 — TaskHub voice command parser  (POST /taskhub/parse)
// ════════════════════════════════════════════════════════════════════════════
const CATEGORIES = ['work', 'personal', 'health', 'urgent', 'study', 'finance', 'other'];

// ── State projection ────────────────────────────────────────────────────────
// The client sends its WHOLE TaskHub (every day it has ever held). That used to
// be JSON.stringify(...).slice(0, 14000), which handed the model TRUNCATED,
// INVALID JSON — the single worst thing you can do to accuracy, and the reason
// bulk requests over more than a couple of weeks were unreliable.
//
// Instead we project: drop the fields the model can't act on, keep the calendar
// days nearest to TODAY first, and stop cleanly at a character budget. What the
// model sees is always valid JSON, and the days it is most likely to be asked
// about are the ones that survive.
const TASK_ITEM_FIELDS = ['title', 'type', 'done', 'time', 'category', 'repeat', 'repeatDays', 'notifyAt', 'altSeqTitles'];

function slimTaskItem(it) {
  if (!it || typeof it !== 'object') return null;
  const o = {};
  for (const k of TASK_ITEM_FIELDS) {
    const v = it[k];
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (Array.isArray(v) && !v.length) continue;
    o[k] = v;
  }
  return o.title ? o : null;
}
function slimSimple(arr) {
  return (Array.isArray(arr) ? arr : []).map(it => {
    if (!it || !it.title) return null;
    return it.done ? { title: it.title, done: true } : { title: it.title };
  }).filter(Boolean);
}
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
function dayShift(key, days) {
  const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!p) return null;
  const d = new Date(Date.UTC(+p[1], +p[2] - 1, +p[3]));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysApart(a, b) {
  const pa = Date.parse(a + 'T00:00:00Z'), pb = Date.parse(b + 'T00:00:00Z');
  return (isNaN(pa) || isNaN(pb)) ? 9e9 : Math.round((pa - pb) / 86400000);
}

function compactTaskState(state, today, { back, fwd, budget }) {
  const src = (state && typeof state === 'object') ? state : {};
  const out = {
    today: src.today || today,
    selectedDate: src.selectedDate,
    week: src.week,
    edit: src.edit,
    dailyHabits: slimSimple(src.habits),
    shortTermGoals: slimSimple(src.shortGoals),
    longTermGoals: slimSimple(src.longGoals),
    habitChecks: src.hc && Object.keys(src.hc).length ? src.hc : undefined,
    calendar: {},
  };
  const lo = dayShift(today, -back), hi = dayShift(today, fwd);
  const keys = Object.keys(src.data || {})
    .filter(k => DAY_KEY.test(k) && (src.data[k] || []).length && (!lo || k >= lo) && (!hi || k <= hi))
    .sort((a, b) => Math.abs(daysApart(a, today)) - Math.abs(daysApart(b, today)));

  let usedChars = JSON.stringify(out).length;
  const kept = {};
  let dropped = 0;
  for (const k of keys) {
    const arr = (src.data[k] || []).map(slimTaskItem).filter(Boolean);
    if (!arr.length) continue;
    const cost = JSON.stringify(arr).length + 16;
    if (usedChars + cost > budget) { dropped++; continue; }
    kept[k] = arr;
    usedChars += cost;
  }
  Object.keys(kept).sort().forEach(k => { out.calendar[k] = kept[k]; });
  out.calendarWindow = { from: lo, to: hi };
  if (dropped) out.calendarNote = `${dropped} further day(s) in this window were omitted for size`;
  return out;
}

// A typed request is "bulk" when it plainly spans many items or many days. Bulk
// gets a wider state window, a bigger output budget, and the flagship-led chain.
function isBulkRequest(text) {
  const t = String(text || '');
  if (!t) return false;
  if (t.length > 200) return true;
  if ((t.match(/\n/g) || []).length >= 2) return true;
  return /\b(all|every|everything|entire|each|whole|both|multiple|bulk|batch|plan|reorganiz\w*|reorganise|rearrange|reschedul\w*|shift|spread|distribute|fill in|next (two|three|few) weeks?|this (week|month)|next (week|month)|weeks?|month)\b/i.test(t);
}

function buildTaskPrompt(profile, transcript, state, today, weekday, hasAudio, opts) {
  const o = opts || {};
  const typed = !hasAudio;
  const src = hasAudio
    ? `FIRST, transcribe the attached audio of the user speaking (US English), correcting obvious mishearings. Then act on that transcription.`
    : `Act on the user's request below. It was TYPED, so take it literally — spelling, names, numbers and dates are exactly as the user intends. It may be long, multi-line, or a pasted list; handle ALL of it.`;

  const isTony = profile !== 'veda';

  return [
    `You are the precise command engine for "${isTony ? 'Tony' : 'Veda'}'s TaskHub" — a weekly planner with a dated calendar, daily habits, short-term goals, long-term goals, a focus timer, themes, and an edit mode. Your job: convert ONE user request into an exact, ordered list of ACTIONS. Be thorough and literal — capture EVERY change and EVERY detail the user mentions.`,
    `${src}`,
    hasAudio ? `` : `USER REQUEST: """${transcript}"""`,
    ``,
    `TODAY is ${today} (${weekday}). Resolve relative dates ("today", "tomorrow", "tonight", "next Monday", "the 5th", "this Friday", "in 3 days", "end of month") to absolute YYYY-MM-DD using TODAY. Past, present and future dates are all allowed. If no date is given for a calendar task, use TODAY.`,
    ``,
    `CURRENT STATE (JSON — read-only reference, used ONLY to locate items the user explicitly wants to edit/remove/move/reorder/swap). Never change anything here that the user did not name):`,
    JSON.stringify(state || {}, null, 0),
    ``,
    `STATE SHAPE: "calendar" maps YYYY-MM-DD → that day's items; "dailyHabits", "shortTermGoals", "longTermGoals" are lists; "habitChecks" records which habits are ticked on which day; "calendarWindow" is the date range you were shown (days outside it exist but were not sent — never assume they are empty).`,
    `BOXES: "calendar" (dated day tasks/events; needs "date"), "dailyHabits" (a recurring checklist you can tick off for each day of the week), "shortTermGoals", "longTermGoals".`,
    `state.week lists the dates of the currently-shown week as [{date,weekday}] — use it to map weekday names ("check off Exercise on Wednesday") to the exact date.`,
    ``,
    `ACTIONS:`,
    `- {type:"add_task", box, date?, title, kind?, category, time?, notify?, repeat?, repeatDays?, repeatEndDate?, altSeqTitles?, done?}`,
    `- {type:"edit_task", match, set:{ any of: title, kind, category, time, date, notify, repeat, repeatDays, done }}`,
    `- {type:"remove_task", match}`,
    `- {type:"toggle_task", match, date?, done?}   (tick off / mark done. Works on calendar tasks, goals, AND daily habits. For a daily habit, set match.box:"dailyHabits", match.title (the habit name), and "date" = the day to check it off (YYYY-MM-DD, default today). done:false unchecks.)`,
    `- {type:"move_task", match, toBox, toDate?}   (move BETWEEN boxes; toDate required if toBox="calendar")`,
    `- {type:"swap", first, second}   (swap the positions of two existing tasks)`,
    `- {type:"reorder", match, position?, relativeTo?, before?}   (position: "top"|"bottom"|"up"|"down"; OR relativeTo:{title} with before:true/false to place it before/after another task)`,
    `- {type:"clear", box, date?}`,
    `- {type:"shift_range", from, to, days}   (BULK: move EVERY calendar item dated between "from" and "to" (inclusive) by "days" — positive = later, negative = earlier. Reminders move with them. Use this for "shift everything one day later", "push next week back two days".)`,
    `- {type:"clear_completed", box?, from?, to?}   (BULK: delete every COMPLETED item. box: "calendar" | "shortTermGoals" | "longTermGoals" | "all" (default). from/to bound the calendar dates, e.g. the first and last day of the month.)`,
    `- {type:"go_to_date", date}`,
    `- {type:"set_theme", dark:true|false} | {type:"toggle_theme"} | {type:"set_edit_mode", on:true|false} | {type:"refresh_quote"}`,
    `- {type:"timer_set", minutes} | {type:"timer_start"} | {type:"timer_stop"} | {type:"timer_reset"} | {type:"timer_open"}`,
    `- {type:"undo"} | {type:"redo"}`,
    ``,
    `FIELD RULES:`,
    `- title: clean and concise. NEVER include the time, date, category, or the word "task" in the title.`,
    `- category (REQUIRED on every calendar add_task): exactly one of ${CATEGORIES.join(', ')}. Infer the best fit from the task ("gym"/"run"/"dentist"→health, "meeting"/"email"/"report"→work, "groceries"/"call mom"→personal, "exam"/"homework"/"study"→study, "pay rent"/"budget"→finance, anything time-critical the user stresses→urgent). If nothing fits well, use "other". NEVER leave it blank, even if the user doesn't say a category.`,
    `- kind: set "event" whenever the user says the word "event", OR the task happens AT a clock time ("meeting at 3", "gym at 5pm", "call at noon", "dinner tonight at 7"). Otherwise "task".`,
    `- time: the EVENT's clock time, 24h "HH:MM" (5pm→"17:00", noon→"12:00", "7:30 in the morning"→"07:30").`,
    `- notify: a REMINDER/notification, as {date:"YYYY-MM-DD", time:"HH:MM"}. Set it whenever the user says remind / reminder / notify / notification / alert / alarm / "ping me" / "let me know". An item can have BOTH a "time" (when it happens) AND a "notify" (when to be reminded). "remind me 15 minutes before" → notify 15 min before the event time. If the user calls it an event and gives ONE time (e.g. "an event with a notification at 3pm"), use that time for BOTH "time" and "notify".`,
    `- repeat: "none"|"daily"|"weekly"|"weekdays"|"custom"; repeatDays: weekday indexes 0=Mon..6=Sun for weekly/custom.`,
    `- altSeqTitles: 2+ titles for an alternating-sequence task ("alternate push and pull days") — use instead of title.`,
    ``,
    `MATCHING: "match"/"first"/"second"/"relativeTo" = {box?, date?, title}. "title" is the user's words for an EXISTING item (matched loosely). Include box and (for calendar) date when known. Resolve "it/that/this/the task" to the most recently referenced or just-added item.`,
    ``,
    `CRITICAL RULES — follow exactly:`,
    `- DO ONLY WHAT IS ASKED. Never modify, recategorize, reorder, rename, complete, move, or delete any item the user did not explicitly name. Every action you output must correspond to an explicit instruction. When in doubt, do LESS.`,
    `- ADD vs EDIT (most important): "create / add / new / schedule / make / set up / put down / note / jot" = ALWAYS a brand-new add_task. NEVER edit or overwrite an existing item for these — even if a similar-sounding item already exists (duplicates are fine). Use edit_task / remove_task / move_task / swap / reorder ONLY when the user clearly points at an existing item with a change intent ("change…", "rename…", "reschedule…", "move…", "delete…", "mark … done", "swap…").`,
    `- SUMMARIZE: if the user describes a task in a long or rambling sentence, distil it into a short, clear title that captures the essence — drop filler ("I need to", "remember to", "I really should", "can you"). E.g. "I really have to remember to call the dentist tomorrow to reschedule my cleaning" → title "Call dentist to reschedule".`,
    `- CONSOLIDATE: put ALL attributes the user mentions about a single new task into that ONE add_task — even when said mid-sentence or out of order ("add a dentist appointment, put it in health, tomorrow at 2, and remind me" = ONE add_task with category:"health", date, time:"14:00", notify). Do NOT emit a separate edit for attributes of a task you just added.`,
    `- BULK: a request may contain many changes. Emit one action per DISTINCT change, in the order stated. Don't merge unrelated changes; don't drop any; don't add extras.`,
    `- BULK SHORTCUTS: when a change applies to a whole date range rather than to named items, prefer ONE shift_range or clear_completed over dozens of edit_task/remove_task actions — it is exact, and it also covers days outside calendarWindow. Only fall back to individual actions when the rule really is item-by-item (e.g. "move every workout to Mondays and Thursdays" → one edit_task per workout, each with its new date).`,
    `- LISTS: if the request is a list (lines, bullets, numbers, semicolons, "and then"), treat EVERY line as its own item and emit an action for each one. Never collapse several lines into one task and never stop early — a 25-line list means 25 actions.`,
    `- PLANNING: for open-ended planning ("plan my next two weeks", "build my schedule from this list"), spread the work sensibly across the requested days — realistic times, a few items per day, nothing double-booked at the same clock time, and nothing on a day the user excluded. Respect what is ALREADY on those days; add around it, don't duplicate it.`,
    `- RANGES: "this week" = the dates in state.week. "next week" = the seven days after that. "this month" = the 1st through the last day of TODAY's month. Always convert a range to explicit YYYY-MM-DD dates.`,
    `- SWAP vs reorder: "swap A and B" / "switch their positions" → ONE swap. "move X to the top" / "put X above Y" / "move it up" → reorder.`,
    `- Never echo existing state back as new adds. Never invent tasks. If you cannot map the command to any action, return an empty "actions" array.`,
    `- "say": ≤12-word confirmation of what you did (e.g. "Added dentist 2pm tomorrow with a reminder.").`,
    ``,
    `EXAMPLES (command → actions):`,
    `"add gym at 6am, put it in health, and remind me at 5:45" → [{"type":"add_task","box":"calendar","date":"${today}","title":"Gym","kind":"event","category":"health","time":"06:00","notify":{"date":"${today}","time":"05:45"}}]`,
    `"schedule a team meeting tomorrow at 3pm as an event with a notification" → [{"type":"add_task","box":"calendar","date":"<tomorrow>","title":"Team Meeting","kind":"event","category":"work","time":"15:00","notify":{"date":"<tomorrow>","time":"15:00"}}]`,
    `"swap morning run and meal prep" → [{"type":"swap","first":{"box":"calendar","title":"morning run"},"second":{"box":"calendar","title":"meal prep"}}]`,
    `"move groceries to the top" → [{"type":"reorder","match":{"box":"calendar","title":"groceries"},"position":"top"}]`,
    `"add read 20 pages to daily habits and finish taxes to long term goals" → [{"type":"add_task","box":"dailyHabits","title":"Read 20 pages"},{"type":"add_task","box":"longTermGoals","title":"Finish taxes"}]`,
    `"check off exercise for wednesday" → [{"type":"toggle_task","match":{"box":"dailyHabits","title":"Exercise"},"date":"<this week's Wednesday>","done":true}]`,
    `"mark meditate done today and uncheck drink water" → [{"type":"toggle_task","match":{"box":"dailyHabits","title":"Meditate"},"date":"${today}","done":true},{"type":"toggle_task","match":{"box":"dailyHabits","title":"Drink water"},"date":"${today}","done":false}]`,
    `"shift everything next week one day later" → [{"type":"shift_range","from":"<next Monday>","to":"<next Sunday>","days":1}]`,
    `"delete all completed tasks from this month" → [{"type":"clear_completed","box":"calendar","from":"<1st of this month>","to":"<last day of this month>"}]`,
    ``,
    `Return ONLY the actions object. "actions" may be long — never truncate it, never stop halfway, never summarise instead of acting.`,
  ].join('\n');
}

const ACTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcript: { type: 'STRING' },
    say: { type: 'STRING' },
    actions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: { type: 'STRING' },
          box: { type: 'STRING' },
          date: { type: 'STRING' },
          title: { type: 'STRING' },
          kind: { type: 'STRING' },
          category: { type: 'STRING' },
          time: { type: 'STRING' },
          notify: {
            type: 'OBJECT',
            properties: { date: { type: 'STRING' }, time: { type: 'STRING' } },
          },
          repeat: { type: 'STRING' },
          repeatDays: { type: 'ARRAY', items: { type: 'INTEGER' } },
          repeatEndDate: {
            type: 'OBJECT',
            properties: { year: { type: 'INTEGER' }, month: { type: 'INTEGER' }, day: { type: 'INTEGER' } },
          },
          altSeqTitles: { type: 'ARRAY', items: { type: 'STRING' } },
          done: { type: 'BOOLEAN' },
          set: {
            type: 'OBJECT',
            properties: {
              title: { type: 'STRING' }, kind: { type: 'STRING' }, category: { type: 'STRING' },
              time: { type: 'STRING' }, date: { type: 'STRING' },
              notify: { type: 'OBJECT', properties: { date: { type: 'STRING' }, time: { type: 'STRING' } } },
              repeat: { type: 'STRING' }, repeatDays: { type: 'ARRAY', items: { type: 'INTEGER' } },
              done: { type: 'BOOLEAN' },
            },
          },
          match: {
            type: 'OBJECT',
            properties: { box: { type: 'STRING' }, date: { type: 'STRING' }, title: { type: 'STRING' }, id: { type: 'STRING' } },
          },
          first: {
            type: 'OBJECT',
            properties: { box: { type: 'STRING' }, date: { type: 'STRING' }, title: { type: 'STRING' } },
          },
          second: {
            type: 'OBJECT',
            properties: { box: { type: 'STRING' }, date: { type: 'STRING' }, title: { type: 'STRING' } },
          },
          relativeTo: {
            type: 'OBJECT',
            properties: { box: { type: 'STRING' }, date: { type: 'STRING' }, title: { type: 'STRING' } },
          },
          position: { type: 'STRING' },
          before: { type: 'BOOLEAN' },
          toBox: { type: 'STRING' },
          toDate: { type: 'STRING' },
          from: { type: 'STRING' },
          to: { type: 'STRING' },
          days: { type: 'INTEGER' },
          dark: { type: 'BOOLEAN' },
          on: { type: 'BOOLEAN' },
          minutes: { type: 'INTEGER' },
        },
        required: ['type'],
      },
    },
  },
  required: ['actions'],
};

// Deterministic loss check for TYPED requests. ACTION_SCHEMA is necessarily wide
// (one object shape covering every action type), and a wide schema is exactly
// where these models quietly drop optional fields — "dentist next Tuesday at 2pm
// in health" coming back with the date right but no time and no category. We
// can't detect a wrong answer, but we CAN detect an answer that threw away
// something the user unmistakably wrote. When that happens runModelChain
// escalates to the next model and keeps this result only as a fallback.
//
// Deliberately conservative: it asks whether ANY action carried the detail, not
// every action, so a mixed request ("gym at 6 and call mom") still passes.
function taskExtractionOk(text, out) {
  if (!out || !Array.isArray(out.actions)) return false;
  if (!out.actions.length) return true;                 // "nothing to do" is a valid answer
  const carriers = out.actions.filter(a => a && (a.type === 'add_task' || a.type === 'edit_task'));
  if (!carriers.length) return true;                    // no action type that could hold these fields

  const hasTime = a => !!(a.time || a.notify || (a.set && (a.set.time || a.set.notify)));
  if (/\b(\d{1,2}\s*:\s*\d{2}|\d{1,2}\s*(am|pm)|noon|midnight)\b/i.test(text) && !carriers.some(hasTime)) return false;

  const named = CATEGORIES.find(c => c !== 'other' && new RegExp(`\\b${c}\\b`, 'i').test(text));
  if (named && !carriers.some(a => a.category === named || (a.set && a.set.category === named))) return false;

  return true;
}

function cleanAction(a) {
  if (!a || typeof a !== 'object' || !a.type) return null;
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out.type ? out : null;
}

async function handleTaskhub(body, env) {
  const profile = body.profile === 'veda' ? 'veda' : 'tony';
  const transcript = String(body.transcript || '').trim();
  const audio = typeof body.audio === 'string' ? body.audio : '';
  const mimeType = String(body.mimeType || 'audio/wav');
  const state = (body.state && typeof body.state === 'object') ? body.state : {};
  const today = String(body.today || new Date().toISOString().slice(0, 10));
  const weekday = String(body.weekday || '');

  if (!transcript && !audio) return json({ ok: false, error: 'no transcript or audio' }, 400);
  const key = keyFor(env, profile);
  if (!key) return json({ ok: false, error: `no Gemini key configured for ${profile}` }, 500);

  // Voice is one short spoken command: keep the window tight and the chain fast.
  // Typed bulk is the opposite — it needs to SEE more of the calendar, write far
  // more actions, and is allowed to take longer.
  const bulk = !audio && isBulkRequest(transcript);
  const shaped = compactTaskState(
    state, today,
    bulk ? { back: 45, fwd: 120, budget: 46000 } : { back: 14, fwd: 45, budget: 14000 },
  );
  const prompt = buildTaskPrompt(profile, transcript, shaped, today, weekday, !!audio, { bulk });

  try {
    const { value, model, tried } = await runModelChain(bulk ? TASKHUB_BULK_MODELS : TASKHUB_MODELS, key, {
      prompt,
      schema: ACTION_SCHEMA,
      maxOutputTokens: bulk ? 32768 : 8192,
      feature: 'taskhub',
      audio,
      mimeType,
      timeoutMs: bulk ? 40000 : 15000,
      deadlineMs: bulk ? 70000 : 45000,
      hedgeAfterMs: bulk ? 12000 : 0,
      // Audio has no transcript to compare against, so the check is a no-op there.
      validate: v => (v && Array.isArray(v.actions)) && (!!audio || taskExtractionOk(transcript, v)),
    });
    const actions = value.actions.map(cleanAction).filter(Boolean);
    return json({
      ok: true,
      actions,
      transcript: String(value.transcript || transcript || '').trim(),
      say: String(value.say || '').trim(),
      truncated: !!value.truncated,
      bulk,
      model,
      tried,
    });
  } catch (e) {
    return json({ ok: false, error: (e && e.message) || 'all models failed', tried: (e && e.tried) || [] }, 502);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 2b — TaskHub AI task prep  (POST /taskhub/prep)
// ════════════════════════════════════════════════════════════════════════════
// Tony or Veda flags a task ("AI prep") and their TaskHub asks this route, ahead
// of time, for a KIT: a ready-to-paste prompt for the chosen assistant, a first draft (the
// email itself, a message, notes), the websites worth opening and the PC apps
// worth opening. Clicking the task's ✨ button then opens the assistant with
// the prompt typed in, and Shield opens the sites and apps.
//
// PREPARE, NEVER ACT: nothing here sends, books or submits anything. The Gmail
// link is a compose window she still has to press Send in.
//
// Two things are enforced here rather than trusted to the model:
//   · apps — only ids from the list the client sent (Shield's installed-app
//     list). A made-up id would resolve to nothing on the PC at best.
//   · sites — http(s) only. Shield opens these with the OS, so a file: or
//     javascript: URL must never get through.
// The Gmail compose link is BUILT here from the draft fields, never written by
// the model — models mis-encode query strings, and a half-encoded body loses
// everything after its first '&'.
const PREP_SITES = { perplexity: 'Perplexity', chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' };
const PREP_DRAFT_KINDS = ['email', 'message', 'document', 'none'];

const PREP_SCHEMA = {
  type: 'OBJECT',
  properties: {
    helpful: { type: 'BOOLEAN' },
    summary: { type: 'STRING' },
    prompt: { type: 'STRING' },
    draft: {
      type: 'OBJECT',
      properties: {
        kind: { type: 'STRING', enum: PREP_DRAFT_KINDS },
        to: { type: 'STRING' },
        subject: { type: 'STRING' },
        body: { type: 'STRING' },
      },
      // All four, not just kind: with the rest optional Gemini returned
      // {kind:'email'} and no body while the summary claimed a drafted email.
      required: ['kind', 'to', 'subject', 'body'],
    },
    sites: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { label: { type: 'STRING' }, url: { type: 'STRING' } },
        required: ['label', 'url'],
      },
    },
    apps: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['helpful', 'summary', 'prompt', 'draft', 'sites', 'apps'],
};

const PREP_MAX_APPS_IN = 400;   // names sent to the model
const PREP_MAX_SITES = 4;
const PREP_MAX_APPS = 3;
const PREP_PROMPT_MAX = 6000;   // the prompt rides in a URL query string

function prepCleanApps(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const id = String(a.id || '').trim();
    const name = String(a.name || '').trim().slice(0, 80);
    if (!id || !name || id.length > 64 || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
    if (out.length >= PREP_MAX_APPS_IN) break;
  }
  return out;
}

function prepIsWebUrl(u) {
  try {
    const p = new URL(String(u));
    return (p.protocol === 'https:' || p.protocol === 'http:') && !!p.hostname;
  } catch (e) { return false; }
}

// Straight to Gmail's own compose URL (/mail/u/0/?fs=1&tf=cm). The older
// /mail/?view=cm form is redirected by Gmail when signed in, and that redirect
// drops every line break from the body: Tony's draft arrived as one run-on
// paragraph, "Hi Anthony,I hope…" (2026-10-15). The page builds the same link
// (_vdPrepGmailUrl), so kits saved before this get the fix too.
function prepGmailUrl(d) {
  const q = ['fs=1', 'tf=cm'];
  if (d.to) q.push('to=' + encodeURIComponent(d.to));
  if (d.subject) q.push('su=' + encodeURIComponent(d.subject));
  if (d.body) q.push('body=' + encodeURIComponent(String(d.body).replace(/\r\n?/g, '\n')));
  return 'https://mail.google.com/mail/u/0/?' + q.join('&');
}

// Whose planner it is. Veda's wording is the original; Tony's says only what
// is known (nothing about school).
const PREP_PEOPLE = {
  veda: { name: 'Veda', intro: 'Veda is a university student. She', they: 'she', their: 'her', THEIR: 'HER', them: 'her', starts: 'starts', does: 'does', has: 'has' },
  tony: { name: 'Tony', intro: 'Tony', they: 'they', their: 'their', THEIR: 'THEIR', them: 'them', starts: 'start', does: 'do', has: 'have' },
};

function buildPrepPrompt({ profile, task, note, site, today, weekday, apps }) {
  const P = PREP_PEOPLE[profile === 'tony' ? 'tony' : 'veda'];
  const siteName = PREP_SITES[site] || 'Perplexity';
  const siteWeb = site === 'perplexity' || site === 'gemini'
    ? `${siteName} searches the web, so ask it to cite sources and current info where that helps.` : '';
  const appLines = apps.length
    ? apps.map(a => `${a.id}: ${a.name}`).join('\n')
    : '(none reported — return an empty apps list)';
  return [
    `You are ${P.name}'s task-prep assistant. ${P.intro} flagged one task on ${P.their} planner`,
    `and wants everything ready before ${P.they} ${P.starts} it, so ${P.they} ${P.does} as little manual work as possible.`,
    `You PREPARE only. Never claim anything was sent, booked or submitted.`,
    ``,
    `TODAY: ${today}${weekday ? ' (' + weekday + ')' : ''}`,
    `Anything dated before TODAY is in the past: never suggest deadlines, seasons or programs that have already passed.`,
    `TASK: ${task.title}`,
    task.date ? `TASK DATE: ${task.date}${task.time ? ' at ' + task.time : ''}` : '',
    task.type === 'event' ? `This is an EVENT (something happening at a time), not a to-do.` : '',
    task.category ? `CATEGORY: ${task.category}` : '',
    note ? `${P.THEIR} NOTES FOR YOU (trust these; they hold names, addresses, details): ${note}` : `${P.THEIR} NOTES: none.`,
    ``,
    `Return JSON with:`,
    `- helpful: false ONLY if there is nothing to prepare (e.g. "gym", "laundry", "sleep early"). Then keep the rest minimal.`,
    `- summary: 1-2 short sentences telling ${P.name} what you prepared and what is left for ${P.them} to do. Mention only`,
    `  what this JSON actually contains (never say you drafted an email unless draft.body holds it).`,
    `- prompt: a complete, self-contained message ${P.name} will paste into ${siteName}. Write it in ${P.their} voice ("I need to…"),`,
    `  include every detail from the task and notes, and ask for the concrete finished output (the full email, a`,
    `  comparison with links, a step-by-step plan, etc.). ${siteWeb}`,
    `  The assistant knows nothing else about ${P.them}, so the prompt must stand alone. Max ~1200 words.`,
    `  ${siteName} has NO access to ${P.their} email, calendar, files, accounts or PC, so never ask it to send,`,
    `  open, check, read or schedule anything there (it answers "I don't have access to Gmail"). Ask it only for`,
    `  text and information. ${P.name}'s planner already opens the Gmail draft, the sites and the apps for ${P.them}.`,
    `- draft: your own best first draft of the deliverable, so ${P.they} ${P.has} something even before opening ${siteName}.`,
    `  The COMPLETE text goes in draft.body; a draft with an empty body is discarded. Always fill every draft field`,
    `  (use "" for ones that do not apply).`,
    `  kind "email" when the task is to email/write to someone: fill to (only an address that appears in ${P.their} notes,`,
    `  else empty), subject, and body (complete, polite, signed "${P.name}", placeholders like [date] only where a fact`,
    `  is genuinely unknown).`,
    `  Write the body with real line breaks: the greeting on its own line, a blank line, short paragraphs`,
    `  separated by blank lines, then the sign-off and the name on their own lines.`,
    `  kind "message" for a text/DM, "document" for notes/outlines/lists, "none" if no draft fits.`,
    `- sites: up to ${PREP_MAX_SITES} websites ${P.they} will actually need for THIS task (the real https URL of the`,
    `  specific service: a booking page, a portal, a form, docs). Do NOT include Gmail (it is added automatically`,
    `  for email drafts), the AI assistant itself, or generic search pages. Empty when none clearly fit.`,
    `- apps: up to ${PREP_MAX_APPS} ids from the list below of apps installed on ${P.their} PC, only ones ${P.they} would`,
    `  open for this task (Word for an essay, Excel for a budget, Zoom for a call, Spotify for nothing). Use the ids`,
    `  exactly. Empty when none clearly fit.`,
    ``,
    `APPS ON ${P.THEIR} PC (id: name):`,
    appLines,
  ].filter(l => l !== '').join('\n');
}

// Shape whatever the model returned into a kit the client can trust.
function cleanPrepKit(v, apps) {
  v = (v && typeof v === 'object') ? v : {};
  const known = new Set(apps.map(a => a.id));
  const d = (v.draft && typeof v.draft === 'object') ? v.draft : {};
  const kind = PREP_DRAFT_KINDS.includes(d.kind) ? d.kind : 'none';
  const draft = {
    kind,
    to: kind === 'email' ? String(d.to || '').trim().slice(0, 200) : '',
    subject: kind === 'email' ? String(d.subject || '').trim().slice(0, 200) : '',
    body: kind === 'none' ? '' : String(d.body || '').trim().slice(0, 8000),
  };
  if (draft.kind !== 'none' && !draft.body) draft.kind = 'none';
  if (draft.to && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(draft.to)) draft.to = '';

  const sites = [];
  const seenUrl = new Set();
  if (draft.kind === 'email') {
    const g = prepGmailUrl(draft);
    sites.push({ label: 'Gmail draft', url: g });
    seenUrl.add(g);
  }
  (Array.isArray(v.sites) ? v.sites : []).forEach(s => {
    if (!s || sites.length >= PREP_MAX_SITES + (draft.kind === 'email' ? 1 : 0)) return;
    const url = String(s.url || '').trim();
    if (!prepIsWebUrl(url) || seenUrl.has(url)) return;
    if (/^https?:\/\/mail\.google\.com\//i.test(url)) return;   // ours is the only Gmail link
    seenUrl.add(url);
    sites.push({ label: String(s.label || '').trim().slice(0, 60) || new URL(url).hostname, url });
  });

  const outApps = [];
  (Array.isArray(v.apps) ? v.apps : []).forEach(id => {
    id = String(id || '').trim();
    if (known.has(id) && !outApps.includes(id) && outApps.length < PREP_MAX_APPS) outApps.push(id);
  });

  return {
    helpful: v.helpful !== false,
    summary: String(v.summary || '').trim().slice(0, 600),
    prompt: String(v.prompt || '').trim().slice(0, PREP_PROMPT_MAX),
    draft,
    sites,
    apps: outApps,
  };
}

async function handleTaskPrep(body, env) {
  const profile = body.profile === 'veda' ? 'veda' : 'tony';
  const t = (body.task && typeof body.task === 'object') ? body.task : {};
  const task = {
    title: String(t.title || '').trim().slice(0, 300),
    date: String(t.date || '').slice(0, 10),
    time: String(t.time || '').slice(0, 10),
    type: t.type === 'event' ? 'event' : 'task',
    category: String(t.category || '').slice(0, 30),
  };
  if (!task.title) return json({ ok: false, error: 'no task title' }, 400);
  const note = String(body.note || '').trim().slice(0, 2000);
  const site = PREP_SITES[body.site] ? body.site : 'perplexity';
  const apps = prepCleanApps(body.apps);
  const today = String(body.today || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const weekday = String(body.weekday || '').slice(0, 12);

  const key = keyFor(env, profile);
  if (!key) return json({ ok: false, error: `no Gemini key configured for ${profile}` }, 500);

  const prompt = buildPrepPrompt({ profile, task, note, site, today, weekday, apps });
  try {
    // Nobody is waiting on this (it runs ahead of time), so quality leads.
    const { value, model, tried } = await runModelChain(TASKHUB_BULK_MODELS, key, {
      prompt,
      schema: PREP_SCHEMA,
      maxOutputTokens: 8192,
      feature: 'taskprep',
      timeoutMs: 30000,
      deadlineMs: 60000,
      hedgeAfterMs: 15000,
      validate: v => !!(v && typeof v.prompt === 'string' && v.prompt.trim()),
    });
    return json({ ok: true, kit: cleanPrepKit(value, apps), site, model, tried });
  } catch (e) {
    return json({ ok: false, error: (e && e.message) || 'all models failed', tried: (e && e.tried) || [] }, 502);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 3 — Journal "AI Format"  (POST /journal/format)
// ════════════════════════════════════════════════════════════════════════════
// The editable default prompt (the front-end shows/stores its own copy per journal;
// this is only the fallback when the client doesn't send one).
const DEFAULT_FORMAT_PROMPT = [
  `You are an expert document formatter.`,
  ``,
  `Your task is to intelligently reformat the provided document without changing its meaning, tone, facts, wording, or intent in ANY way.`,
  ``,
  `Rules:`,
  `- Preserve ALL content. Never summarize, remove, invent, or rewrite information except for minor grammar, punctuation, spacing, capitalization, and formatting improvements.`,
  `- Choose the best presentation automatically:`,
  `  - Plain clean paragraphs if the document is primarily narrative.`,
  `  - Markdown headings, lists, tables, quotes, code blocks, callouts, etc. only when they genuinely improve readability.`,
  `  - Mix paragraphs and Markdown naturally when appropriate.`,
  `- Create a logical document structure with clear sections where beneficial.`,
  `- Merge broken lines into proper paragraphs.`,
  `- Fix spacing, indentation, numbering, bullet consistency, and overall layout.`,
  `- Preserve code, URLs, equations, and special formatting.`,
  `- Format ALL mathematics as Markdown math: inline math wrapped in single dollar signs like $E = mc^2$, and block/display equations wrapped in double dollar signs on their own lines like $$ ... $$. Convert any plain-text math (e.g. "E = mc^2", "integral from 0 to infinity", "x^2 + y^2 = z^2") into proper LaTeX inside those delimiters. Never leave math unformatted.`,
  `- If tables communicate information better, convert suitable content into Markdown tables.`,
  `- Do not over-format. Simplicity is preferred.`,
  `- Never wrap the entire document in a code block.`,
  ``,
  `Images:`,
  `- Preserve every image.`,
  `- Move images only if doing so improves document flow.`,
  `- Place each image near the most relevant content.`,
  `- Output reasonable display sizes based on importance (large for primary images, medium for supporting images, small for icons or references).`,
  `- Do not remove, duplicate, or describe images.`,
  ``,
  `Output only the fully formatted document.`,
].join('\n');

// Fixed output contract appended AFTER the (user-editable) prompt so the result is
// always parseable by the editor and images survive as tokens.
const FORMAT_OUTPUT_CONTRACT = [
  ``,
  `──────────  OUTPUT CONTRACT (obey exactly, overrides any conflicting instruction above)  ──────────`,
  `Return ONLY an HTML fragment representing the formatted document. No markdown code fences, no <html>/<head>/<body> wrappers, no commentary before or after.`,
  `Allowed tags ONLY: h1 h2 h3 h4 p ul ol li blockquote pre code strong em u s a table thead tbody tr th td hr br. "Markdown headings/lists/tables/etc" from the rules above means: express them with these HTML tags.`,
  `For checklists use exactly: <ul class="docx-checklist"><li class="docx-cl-item"><input type="checkbox" class="docx-cl-box"><span class="docx-cl-text">TASK</span></li></ul> (add the "checked" attribute and class "done" on <li> for completed items).`,
  `MATH: write math as plain LaTeX between dollar-sign delimiters directly in the text — inline as $ ... $ and display equations as $$ ... $$ (these dollar delimiters are REQUIRED and will be rendered; do NOT wrap math in any HTML tag).`,
  `Never wrap the whole document in <pre>/<code>. Do not add inline style attributes. Do not output <img> tags or scripts.`,
  `EMBEDDED TOKENS: the document may contain opaque tokens written EXACTLY like [[IMG1]], [[IMG2]], … Each stands in for something already fully-formed that you cannot see or edit — an image, a file attachment, or an existing hyperlink. Keep EVERY token exactly once, verbatim: never rename, merge, split, or invent one, never delete one, never describe or guess what it represents, never turn it into visible text. You MAY move a token to a better position in the flow for readability. Put each token on its own line UNLESS it is clearly an inline element (e.g. a link token inside a sentence), in which case keep it inline. Only for a token you know is an actual image may you optionally append a display-size hint before the closing brackets — |large, |medium, or |small (e.g. [[IMG1|large]]); never add a size hint to a token that isn't an image.`,
  ``,
  `DOCUMENT TO FORMAT (between the fences):`,
  `<<<`,
];

function buildFormatPrompt(text, customPrompt) {
  const base = (customPrompt && String(customPrompt).trim()) ? String(customPrompt).trim() : DEFAULT_FORMAT_PROMPT;
  return [base, ...FORMAT_OUTPUT_CONTRACT, text, `>>>`].join('\n');
}

const FORMAT_SCHEMA = {
  type: 'OBJECT',
  properties: { html: { type: 'STRING' } },
  required: ['html'],
};

// Rescue a document response that hit the token ceiling mid-string. The JSON is
// unparseable, but everything before the cut is real formatted HTML — returning
// it (the editor only replaces the blocks it sent) beats failing the whole run.
// Only accepted when a worthwhile amount came back and no tag is left dangling.
function salvageHtml(text) {
  const at = text.indexOf('"html"');
  if (at < 0) return null;
  const open = text.indexOf('"', text.indexOf(':', at) + 1);
  if (open < 0) return null;
  let out = '', esc = false;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (esc) {
      out += c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c === 'u' ? '' : c;
      if (c === 'u') { out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16) || 0); i += 4; }
      esc = false; continue;
    }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { out = ''; break; }   // string closed cleanly → it wasn't truncated; let JSON.parse own it
    out += c;
  }
  const cut = out.lastIndexOf('>');       // drop a half-written trailing tag
  if (cut > 0) out = out.slice(0, cut + 1);
  return out.trim().length > 200 ? { html: out } : null;
}

// Document formatting is the slowest job this worker runs: a full page of prose
// can take 20-40s on the flagship, far past the 15s default per-attempt timeout
// that the interactive voice features want. Scale the per-attempt budget with the
// document, and keep the whole chain inside one wall-clock deadline that lands
// comfortably before the client's 90s abort — so a slow model falls through to
// the next one instead of the user watching the spinner until it gives up.
function formatBudgets(len) {
  if (len > 40000) return { timeoutMs: 58000, deadlineMs: 78000 };
  if (len > 12000) return { timeoutMs: 42000, deadlineMs: 76000 };
  if (len > 3000)  return { timeoutMs: 30000, deadlineMs: 72000 };
  return { timeoutMs: 22000, deadlineMs: 66000 };
}

// Did a tool's answer keep everything it had to? Every [[IMGn]] token (an
// image, file or link the model cannot see) and every [[SECnS]]/[[SECnE]]
// section marker must survive, or the editor loses that image or cannot put
// the sections back. AI Format only restructures, so its text cannot shrink
// much either; Refine and custom tools may legitimately shorten, so only the
// tokens bind them. A failing answer is kept as the fallback while the next
// model gets a chance (runStaggered's `soft`).
export function formatKeepsContent(text, html, tool) {
  if (typeof html !== 'string' || !html.trim()) return false;
  const tokens = String(text).match(/\[\[(?:IMG\d+|SEC\d+[SE])\]\]/g) || [];
  for (const t of tokens) {
    const re = t.startsWith('[[IMG')
      ? new RegExp('\\[\\[' + t.slice(2, -2) + '(?:\\|(?:large|medium|small))?\\]\\]')
      : new RegExp(t.replace(/[[\]]/g, '\\$&'));
    if (!re.test(html)) return false;
  }
  if (tool === 'format') {
    const plain = (s) => s.replace(/\[\[[^\]]+\]\]/g, '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, '').length;
    const before = plain(String(text));
    if (before > 80 && plain(html) < before * 0.6) return false;
  }
  return true;
}

async function handleFormat(body, env) {
  const profile = body.profile === 'veda' ? 'veda' : 'tony';
  const text = String(body.text || '').trim();
  if (!text) return json({ ok: false, error: 'no text' }, 400);
  const clipped = text.length > 120000 ? text.slice(0, 120000) : text;

  const key = keyFor(env, profile);
  if (!key) return json({ ok: false, error: `no Gemini key configured for ${profile}` }, 500);

  // One pipeline for AI Format, AI Refine and every user-created tool — they
  // differ only by the prompt the client sends. `tool` is carried for logging.
  const tool = String(body.tool || 'format').slice(0, 60);
  const prompt = buildFormatPrompt(clipped, body.prompt);
  const { timeoutMs, deadlineMs } = formatBudgets(clipped.length);

  try {
    // Staggered, not sequential: the leader runs alone for half its timeout,
    // then the next model races it -- a Gemini slow spell (20 s+ on one page)
    // no longer stacks timeout on timeout. A 503/429 starts the next at once.
    const { value, model, tried, soft } = await runStaggered(MODELS, key, {
      prompt,
      env,
      schema: FORMAT_SCHEMA,
      maxOutputTokens: 65536,
      feature: 'journal',
      timeoutMs,
      deadlineMs,
      // A healthy Flash formats a short page in ~5 s; past 6 s it is having a
      // slow spell (live 2026-10-28: 28 s with only two racing), so the next
      // model joins then. Long documents get longer before anyone joins.
      staggerMs: clipped.length <= 3000 ? 6000 : clipped.length <= 12000 ? 10000 : Math.round(timeoutMs / 2),
      maxLive: 3,
      salvage: salvageHtml,
      validate: v => formatKeepsContent(clipped, v && v.html, tool),
    });
    return json({ ok: true, html: value.html, model, tool, tried, salvaged: !!soft });
  } catch (e) {
    const err = (e && e.message) || 'all models failed';
    const quota = /\b429\b|quota|resource_exhausted|exhaust/i.test(err);
    return json({ ok: false, error: err, tool, tried: (e && e.tried) || [], exhausted: quota }, quota ? 429 : 502);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 3b — MAGI's Refine  (POST /prompt/refine)
//
// MAGI's composer, Brainstorm topic and queued prompts rewrite through here,
// on the SAME per-person Gemini key as Notebook's AI tools (keyFor). It used to
// run on the PC engine with a key from magi/.env -- Veda's engine had none, so
// her Refine drove a browser unit and took 2+ minutes for one sentence.
//
// Speed: a staggered race (runStaggered). The fastest Gemini lite model leads;
// if it has not answered in 1 s, Workers AI's Llama 4 Scout (1-2 s, not
// Google's servers) races it, and so on down the chain. Measured 2026-10-28:
// Gemini answered 503 on nearly every model and took 11-20 s when it did, so
// on a day like that Scout answers first; on a good day Gemini does in ~1 s.
//
// Fidelity: REFINE_PROMPT forbids dropping anything, and refineMissing checks
// it -- every number, URL, path, identifier and quoted string in the request
// must still be in the rewrite, or that answer is set aside for the next model.
// MAGI's engine keeps the same prompt (magi/engine/refine.py, drift-tested) for
// its browser-unit fallback.
// ════════════════════════════════════════════════════════════════════════════
const REFINE_MODELS = [
  'gemini-3.5-flash-lite',                        // ~1 s when Google is healthy
  '@cf/meta/llama-4-scout-17b-16e-instruct',      // 1-2 s, 10/10 lossless on the bench
  'gemini-3.1-flash-lite',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
];

export const REFINE_PROMPT = `You are a prompt engineer. Rewrite the request below so that it gets a better answer from a large language model.

THE REQUEST
<<<
{question}
>>>

Rewrite it. Do not answer it, do not carry out any part of it, and do not add your own opinion -- your entire output is the rewritten request, which will be sent on to the models verbatim.

Nothing may be lost. Every detail the person gave must still be in the rewrite: every question and every separate part of the request, every name, number, amount, date, time, place, quantity, URL, file name, path, identifier, code, error message and quoted text, every preference and constraint, and any pasted notes or data. Keep those specifics exactly as written -- do not round, convert, translate, abbreviate, or swap a figure for a word. If the person pasted material (notes, a list, text, code), keep all of it in full inside the rewrite, with its line breaks and list structure, rather than summarising it or folding it into a sentence.

What a good rewrite does:
- Keeps the person's actual intent, subject and scope exactly. You are sharpening what they asked, not replacing it with a better question.
- Makes vague terms specific where the intent is obvious, and leaves them alone where it is not. Never invent facts, constraints, numbers, names or context the person did not give you -- an invented detail is worse than a vague one, because it will be answered as though it were true.
- States what form the answer should take, if the request implies one (steps, a comparison, a short factual answer, code).
- Removes filler and pleasantries, never content.

Keep it proportionate. A short, clear request needs a light touch -- do not inflate one plain sentence into a multi-paragraph specification; most short requests become one to four sentences. A long request stays as long as it needs to be to carry everything in it.

If the request is already clear and specific, return it essentially unchanged rather than padding it out to look like work was done.

Write the rewrite in the person's own voice, as the request itself ("Plan a...", "I am..."), not as instructions about them. No preamble, no "Here is the rewritten prompt", no quotation marks around it, no explanation of what you changed, no headings, no code fences.`;

// Code Mode: the rewrite is a task for a coding agent, which acts on names literally.
export const REFINE_CODE_NOTE = `

This request is a task for an AI coding agent working inside a software repository, not a question for a chat model. Keep every file name, path, identifier, command, error message and code snippet exactly as written. Say plainly what should change or be investigated, and how to tell it worked if the person implied that. Do not invent files, functions or requirements.`;

const REFINE_SCHEMA = { type: 'OBJECT', properties: { refined: { type: 'STRING' } }, required: ['refined'] };

// The specifics a rewrite must carry verbatim: URLs, emails, `code`, quoted
// text, calls, file names and paths, snake_case / camelCase / name-02 ids, and
// every number. Names and plain words are left to the prompt -- a rewrite may
// fairly capitalise "roth" or say "October 12" for "Oct 12".
export function refineFacts(q) {
  q = String(q || '');
  const out = new Set();
  const add = (s) => { s = String(s).trim(); if (s) out.add(s); };
  (q.match(/\bhttps?:\/\/[^\s<>"')\]]+/gi) || []).forEach((u) => add(u.replace(/[.,;:!?]+$/, '')));
  (q.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).forEach(add);
  (q.match(/`[^`\n]+`/g) || []).forEach((s) => add(s.slice(1, -1)));
  (q.match(/"[^"\n]{2,200}"|“[^”\n]{2,200}”/g) || []).forEach((s) => add(s.slice(1, -1)));
  (q.match(/\b[A-Za-z_$][\w$]*\(\)/g) || []).forEach(add);
  (q.match(/(?:[\w~-]+[\\/])*[\w-]+\.(?:[a-z][a-z0-9]{0,5})\b/gi) || []).forEach((s) => {
    if (!/^(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|jr)\.\w*$/i.test(s) && !/^www\./i.test(s)) add(s);
  });
  (q.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g) || []).forEach(add);
  (q.match(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g) || []).forEach(add);
  (q.match(/\b[a-z]+(?:-[a-z]+)*-\d+\b/gi) || []).forEach(add);
  (q.match(/\d+(?:[.,:/]\d+)*/g) || []).forEach(add);
  return [...out];
}
const refineNorm = (s) => String(s).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ');
// The facts of `q` that `refined` lost. A number counts as kept when its digits
// are there with no other digit glued on ("12" survives "October 12").
export function refineMissing(q, refined) {
  const r = refineNorm(refined);
  return refineFacts(q).filter((f) => {
    const n = refineNorm(f);
    if (/^\d+(?:[.,:/]\d+)*$/.test(n)) {
      return !new RegExp('(^|[^\\d])' + n.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '($|[^\\d])').test(r);
    }
    return !r.includes(n);
  });
}

// A model's rewrite, cleaned -- or null if it is not usable as the prompt
// (same rules as magi/engine/refine.py's parse: no fences, no "Here is the
// rewritten prompt:", no wrapping quotes, and not an ANSWER, which shows as
// far more text than the request could need).
export function cleanRefined(raw, question) {
  let text = String(raw || '').trim();
  if (!text) return null;
  const fence = text.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n\s*```$/);
  if (fence) text = fence[1].trim();
  text = text.replace(/^\s*(?:here(?:'s| is)\b[^\n:]*:|(?:the\s+)?(?:rewritten|refined|improved|revised)\s+(?:prompt|request|question)\s*:)/i, '').trim();
  if (text.length >= 2 && `"'“`.includes(text[0]) && `"'”`.includes(text[text.length - 1])) text = text.slice(1, -1).trim();
  if (!text) return null;
  if (text.length > Math.max(4000, String(question || '').length * 3 + 500)) return null;
  return text;
}

async function handleRefine(body, env) {
  const profile = body.profile === 'veda' ? 'veda' : 'tony';
  const q = String(body.question || '').trim();
  if (!q) return json({ ok: false, error: 'no question' }, 400);
  if (q.length > 60000) return json({ ok: false, error: 'too long to refine' }, 400);
  const key = keyFor(env, profile);
  // No key for this person: Workers AI alone still refines. Never the other
  // person's key -- that is their quota.
  const models = REFINE_MODELS.filter((m) => m.startsWith('@cf/') ? !!env.AI : !!key);
  if (!models.length) return json({ ok: false, error: `no Gemini key configured for ${profile}` }, 500);

  const prompt = REFINE_PROMPT.replace('{question}', () => q) + (body.kind === 'code' ? REFINE_CODE_NOTE : '');
  // A long pasted request takes longer to write back out in full.
  const long = q.length > 2000;
  const t0 = Date.now();
  try {
    const { value, model, tried, soft } = await runStaggered(models, key, {
      prompt,
      env,
      schema: REFINE_SCHEMA,
      maxOutputTokens: Math.min(16000, Math.max(1024, Math.ceil(q.length / 2))),
      feature: 'refine',
      timeoutMs: long ? 30000 : 12000,
      deadlineMs: long ? 50000 : 25000,
      staggerMs: long ? 6000 : 1000,
      maxLive: 3,
      retry: false,
      validate: (v) => {
        const text = cleanRefined(v && v.refined, q);
        return !!text && !refineMissing(q, text).length;
      },
    });
    const refined = cleanRefined(value && value.refined, q);
    if (!refined) throw Object.assign(new Error('no usable rewrite'), { tried });
    const missing = soft ? refineMissing(q, refined) : [];
    return json({ ok: true, refined, model, tried, ms: Date.now() - t0, missing });
  } catch (e) {
    const err = (e && e.message) || 'all models failed';
    const quota = /\b429\b|quota|resource_exhausted|exhaust/i.test(err);
    return json({ ok: false, error: err, tried: (e && e.tried) || [], exhausted: quota, ms: Date.now() - t0 }, quota ? 429 : 502);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 4 — MyList Recipes parser  (POST /recipe/parse)
//
// Same "type-to-action" system as the shopping list, but for the Recipes tab.
// The model emits a small set of OPS ("upsert" a whole recipe / "delete" a
// recipe) and the worker applies them to the client's recipe book. For edits the
// model returns the COMPLETE updated recipe (all fields, ingredients, tools, and
// numbered instructions) with just the requested change applied — this makes
// natural-language edits ("remove garlic", "replace step 3", "change the cook
// time") and the marquee feature (turn rambled spoken steps into clean numbered
// instructions) uniform and reliable. Response: {ok, recipes, note, ops}.
// ════════════════════════════════════════════════════════════════════════════
const REC_CATS = ['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Dessert', 'Other'];

function normCat(c) {
  c = String(c || '').trim();
  return REC_CATS.find(x => x.toLowerCase() === c.toLowerCase()) || 'Other';
}
// Split an instructions blob into an array of step texts (strip any existing
// numbering / bullets), tolerant of both newline- and number-delimited input.
function stepsOf(text) {
  text = String(text || '').trim();
  if (!text) return [];
  let parts = text.split(/\r?\n+/);
  if (parts.length <= 1) {
    // one line but possibly "1. a 2. b 3. c" — split on inline step numbers
    const m = text.split(/\s*(?=\d+[.)]\s)/);
    if (m.length > 1) parts = m;
  }
  return parts.map(l => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim()).filter(Boolean);
}
// Re-number steps as "1. …\n2. …" — the shape the app renders (pre-wrap text).
function numberSteps(text) {
  const s = stepsOf(text);
  return s.length ? s.map((l, i) => `${i + 1}. ${l}`).join('\n') : '';
}
function normRecipe(r, keepId) {
  r = r || {};
  const o = {
    name: String(r.name || '').trim(),
    category: normCat(r.category),
    prepTime: String(r.prepTime || '').trim(),
    servings: String(r.servings || '').trim(),
    ingredients: Array.isArray(r.ingredients)
      ? r.ingredients.map(i => ({ name: String((i && i.name) || '').trim(), qty: String((i && i.qty) || '').trim() })).filter(i => i.name)
      : [],
    tools: Array.isArray(r.tools) ? r.tools.map(t => String(t || '').trim()).filter(Boolean) : [],
    instructions: String(r.instructions || '').trim(),
  };
  if (keepId && r.id) o.id = String(r.id);
  return o;
}

// SPEED: only the FOCUS recipe (the one open / being edited) is rendered in full.
// Every other recipe is a compact one-liner (name + fields + ingredient names +
// step count) — enough to rename / delete / move / match by name, but a fraction
// of the tokens. This keeps single edits fast even with a large recipe book.
function recForPrompt(recipes, focusIndex) {
  if (!recipes.length) return '(no recipes yet)';
  return recipes.map((r, i) => {
    const n = i + 1;
    let head = `#${n} "${r.name || '(untitled)'}"  [category: ${normCat(r.category)}]`;
    if (r.prepTime) head += `  [cook time: ${r.prepTime}]`;
    if (r.servings) head += `  [servings: ${r.servings}]`;
    const steps = stepsOf(r.instructions);
    if (focusIndex && n === focusIndex) {
      const ings = (r.ingredients || []).length
        ? (r.ingredients || []).map((x, j) => `    ${j + 1}) ${x.name}${x.qty ? ` — ${x.qty}` : ''}`).join('\n')
        : '    (none)';
      const tools = (r.tools || []).length ? `  tools: ${r.tools.join(', ')}` : '  tools: (none)';
      const stepStr = steps.length ? steps.map((t, j) => `    ${j + 1}. ${t}`).join('\n') : '    (none)';
      return `${head}\n  ingredients:\n${ings}\n${tools}\n  instructions:\n${stepStr}`;
    }
    const inames = (r.ingredients || []).map(x => x.name).filter(Boolean);
    const ingLine = inames.length ? `  ingredients: ${inames.join(', ')}` : '  ingredients: (none)';
    return `${head}\n${ingLine}\n  (${steps.length} step${steps.length !== 1 ? 's' : ''})`;
  }).join('\n\n');
}

function buildRecipePrompt(transcript, recipes, openIndex, hasAudio) {
  const source = hasAudio
    ? `FIRST, listen carefully to the attached audio of the user speaking (US English) and work out what they said, using cooking context to correct obvious mishearings. Then act on it.`
    : `Act on the user's input below.`;
  const openLine = (Number.isInteger(openIndex) && openIndex >= 1 && openIndex <= recipes.length)
    ? `THE CURRENTLY OPEN RECIPE is #${openIndex}. When the user edits WITHOUT naming a recipe ("this recipe", "it", "here", or just gives ingredients/steps/a field), they mean recipe #${openIndex}. You may leave targetIndex OFF for edit ops and it will default to #${openIndex}; set targetIndex only when the user points at a DIFFERENT recipe.`
    : `The user is on the recipe list (no single recipe is open). For any EDIT op you MUST identify which recipe it targets by name via targetMatch (or targetIndex if the user gives a number).`;

  return [
    `You are a world-class cooking-recipe assistant. The user manages their personal recipe book by voice or text. Convert their ONE command into a precise sequence of small, TARGETED OPERATIONS ("ops"). Be fast, literal, and complete: capture EVERY change they ask for, and NEVER touch a recipe, field, ingredient, or step they did not mention.`,
    source,
    hasAudio ? `` : `USER INPUT (may be messy or run-on): """${transcript}"""`,
    ``,
    `CURRENT RECIPES (numbered — "#N" is a recipe's index; ingredients and instruction steps are numbered within each recipe — use those numbers as "index"):`,
    recForPrompt(recipes, openIndex),
    ``,
    openLine,
    ``,
    `TARGETING: every EDIT op (anything except add_recipe) targets one recipe. Identify it with "targetIndex" (its #N) and/or "targetMatch" (its name). If the user doesn't name a recipe and one is open, omit both and it defaults to the open recipe.`,
    ``,
    `OPS (emit one per distinct change, in the order the user said them):`,
    `- {op:"add_recipe", name, category?, prepTime?, servings?, ingredients?:[{name,qty}], tools?:[…], instructions?} — CREATE a brand-new recipe. Only for "create/add/make a NEW recipe". Fill every field you can infer.`,
    `- {op:"remove_recipe", targetIndex?, targetMatch?} — delete an ENTIRE recipe ("delete this recipe", "remove the Pancakes recipe").`,
    `- {op:"set_field", targetIndex?, targetMatch?, field:"name"|"category"|"prepTime"|"servings", value} — change ONE top-level field. "rename this to Chicken Alfredo" → field:"name". "change the cook time to 45 minutes" → field:"prepTime", value:"45 min". "make it serve 6" → field:"servings", value:"6 servings". "move this to Dinner" → field:"category", value:"Dinner".`,
    `- {op:"set_instructions", targetIndex?, targetMatch?, instructions} — REPLACE the whole instructions with the user's spoken/typed steps, cleaned and numbered (see INSTRUCTIONS rule). Use this when the user narrates how to make the dish or says "set/replace the instructions to …".`,
    `- {op:"add_ingredient", targetIndex?, targetMatch?, name, qty?} — "add one teaspoon of paprika" → name:"Paprika", qty:"1 tsp".`,
    `- {op:"update_ingredient", targetIndex?, targetMatch?, index?, match?, set:{name?,qty?}} — change one existing ingredient. index = its number; match = its name. "change the flour to 3 cups" → set:{qty:"3 cups"}.`,
    `- {op:"remove_ingredient", targetIndex?, targetMatch?, index?, match?} — "remove garlic" → match:"garlic". "delete ingredient number 4" → index:4.`,
    `- {op:"add_tool", targetIndex?, targetMatch?, name} — "add a whisk" → name:"Whisk".`,
    `- {op:"remove_tool", targetIndex?, targetMatch?, index?, match?}`,
    `- {op:"add_step", targetIndex?, targetMatch?, text} — append one instruction step.`,
    `- {op:"insert_step", targetIndex?, targetMatch?, after, text} — insert a step AFTER step number "after" (after:0 = new first step). "insert a step after step 2 …".`,
    `- {op:"update_step", targetIndex?, targetMatch?, index, text} — "replace step 3 with …" → index:3, text:"…".`,
    `- {op:"remove_step", targetIndex?, targetMatch?, index} — "delete step 6" → index:6.`,
    ``,
    `FIELD RULES:`,
    `- name: clean Title Case dish name. category: EXACTLY one of ${REC_CATS.join(', ')}. prepTime: time in the user's words ("30 min"). servings: amount it makes ("4 servings", "makes 12").`,
    `- ingredient name = clean singular name; qty = the amount ("2 cups", "1 tsp", "3 large", "1 pinch").`,
    `- INSTRUCTIONS (the marquee feature): for set_instructions / add_step / insert_step / update_step, take whatever the user says — even messy, run-on, spoken narrative — and organize it into clean, correctly-ordered, numbered step text. For set_instructions put ONE step per line (do NOT add "N." numbers yourself — the app numbers them). For a single step op, "text" is just that one cleaned step. Use °F, standard units, imperative voice.`,
    ``,
    `COMPLETENESS — TOP PRIORITY for anything the user dictates (accuracy over brevity; when in doubt, KEEP more, not less):`,
    `- Preserve EVERY ingredient the user mentions. If they name ingredients while narrating the steps and those ingredients are not already listed, ALSO capture them (in add_recipe's "ingredients", or via add_ingredient ops) — never let an ingredient go missing.`,
    `- Preserve ALL cooking times, temperatures, measurements, quantities, and settings EXACTLY as said ("350°F", "for 30 minutes", "2 cups", "medium-high heat", "until golden brown"). Never round, drop, or merge them.`,
    `- Preserve every preparation detail: preheating, mixing/whisking/folding, resting, marinating, chilling, greasing, seasoning, garnishing, cooling times, "set aside", etc.`,
    `- Split the narration into logical numbered steps WITHOUT losing information — one action (or a few tightly-related actions) per step. Do NOT compress multiple distinct actions into one terse step, and do NOT skip steps.`,
    `- Only fix grammar, spelling, punctuation, capitalization, and remove pure filler ("um", "uh", "like", "you know"). Do NOT paraphrase into something shorter or "cleaner" that loses specifics — stay close to the user's actual words and details.`,
    `- If a step is ambiguous, make the SMALLEST reasonable correction; never invent steps/ingredients/amounts and never delete content to make it tidier.`,
    ``,
    `CRITICAL RULES:`,
    `- DO ONLY WHAT IS ASKED. Each op changes exactly one thing. NEVER emit a field or op for something the user didn't mention. When the user gives only instructions, emit ONLY set_instructions (plus add_ingredient ops for any newly-named ingredients) — do NOT clear or re-send name, category, or existing content.`,
    `- ADD vs EDIT: only "create/add/make a NEW recipe (called X)" is add_recipe. Everything else that references a recipe is an edit op (set_field / set_instructions / *_ingredient / *_tool / *_step / remove_recipe).`,
    `- A command may contain several changes to the same recipe ("add salt and rename it to X") → one op each, all targeting that recipe.`,
    `- If nothing maps to a change, return ops: [].`,
    `- "note": ≤10-word confirmation ("Updated the instructions.", "Removed garlic.", "Renamed to Chicken Alfredo.").`,
    ``,
    `EXAMPLES (command → ops):`,
    `"add a new breakfast recipe called avocado toast, serves 2, ten minutes. two slices of sourdough, one avocado, a pinch of red pepper flakes. toaster and a fork. first toast the bread, then mash the avocado and spread it on, then sprinkle the pepper on top" → [{"op":"add_recipe","name":"Avocado Toast","category":"Breakfast","prepTime":"10 min","servings":"2 servings","ingredients":[{"name":"Sourdough Bread","qty":"2 slices"},{"name":"Avocado","qty":"1"},{"name":"Red Pepper Flakes","qty":"1 pinch"}],"tools":["Toaster","Fork"],"instructions":"Toast the sourdough slices.\\nMash the avocado and spread it onto the toast.\\nSprinkle red pepper flakes on top."}]`,
    `(open recipe) "first preheat the oven to 350, mix the flour eggs sugar and butter, pour into a pan, bake 30 minutes, let it cool 10 minutes before serving" → [{"op":"set_instructions","instructions":"Preheat the oven to 350°F.\\nMix the flour, eggs, sugar, and butter until well combined.\\nPour the mixture into a baking pan.\\nBake for 30 minutes.\\nLet cool for 10 minutes before serving."}]`,
    `(open recipe) "rename this to Chicken Alfredo" → [{"op":"set_field","field":"name","value":"Chicken Alfredo"}]`,
    `(open recipe) "change the cook time to 45 minutes and make it serve 6" → [{"op":"set_field","field":"prepTime","value":"45 min"},{"op":"set_field","field":"servings","value":"6 servings"}]`,
    `(open recipe) "add one teaspoon of paprika and remove the garlic" → [{"op":"add_ingredient","name":"Paprika","qty":"1 tsp"},{"op":"remove_ingredient","match":"garlic"}]`,
    `(open recipe) "replace step 3 with pour the batter into a greased pan" → [{"op":"update_step","index":3,"text":"Pour the batter into a greased pan."}]`,
    `(open recipe) "delete step 6" → [{"op":"remove_step","index":6}]`,
    `(open recipe) "move this recipe to Dinner" → [{"op":"set_field","field":"category","value":"Dinner"}]`,
    `"delete the pancake recipe" → [{"op":"remove_recipe","targetMatch":"Pancakes"}]`,
  ].join('\n');
}

const RECIPE_OPS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    ops: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          op: {
            type: 'STRING',
            enum: ['add_recipe', 'remove_recipe', 'set_field', 'set_instructions',
                   'add_ingredient', 'update_ingredient', 'remove_ingredient',
                   'add_tool', 'remove_tool', 'add_step', 'insert_step', 'update_step', 'remove_step'],
          },
          targetIndex:  { type: 'INTEGER' },
          targetMatch:  { type: 'STRING' },
          field:        { type: 'STRING' },
          value:        { type: 'STRING' },
          name:         { type: 'STRING' },
          qty:          { type: 'STRING' },
          index:        { type: 'INTEGER' },
          match:        { type: 'STRING' },
          after:        { type: 'INTEGER' },
          text:         { type: 'STRING' },
          instructions: { type: 'STRING' },
          set:          { type: 'OBJECT', properties: { name: { type: 'STRING' }, qty: { type: 'STRING' } } },
          category:     { type: 'STRING' },
          prepTime:     { type: 'STRING' },
          servings:     { type: 'STRING' },
          ingredients:  { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, qty: { type: 'STRING' } }, required: ['name'] } },
          tools:        { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['op'],
      },
    },
    note: { type: 'STRING' },
  },
  required: ['ops'],
};

// Fuzzy-locate an ingredient by 1-based index (preferred) or by name.
function findIngIndex(ings, index, match) {
  if (Number.isInteger(index) && index >= 1 && index <= ings.length) return index - 1;
  const m = normName(match);
  if (!m) return -1;
  let best = -1, score = 0;
  ings.forEach((it, i) => {
    const n = normName(it.name);
    const s = n === m ? 1 : ((n.includes(m) || m.includes(n)) ? 0.85 : tokenOverlap(n, m));
    if (s > score) { score = s; best = i; }
  });
  return score >= 0.5 ? best : -1;
}
function renumberSteps(steps) {
  const s = steps.map(x => String(x || '').trim()).filter(Boolean);
  return s.length ? s.map((l, i) => `${i + 1}. ${l}`).join('\n') : '';
}

function applyRecipeOps(recipes, ops, openIndex) {
  const list = (Array.isArray(recipes) ? recipes : []).map(r => normRecipe(r, true));
  // Resolve an edit op's target recipe. Priority: explicit index → name match →
  // the open recipe (only when the user named nothing). Never guesses otherwise.
  const resolve = (op) => {
    if (Number.isInteger(op.targetIndex) && op.targetIndex >= 1 && op.targetIndex <= list.length) return op.targetIndex - 1;
    const hasMatch = op.targetMatch && String(op.targetMatch).trim();
    if (hasMatch) {
      const m = normName(op.targetMatch);
      let best = -1, score = 0;
      list.forEach((r, i) => {
        const n = normName(r.name);
        const s = n === m ? 1 : ((n.includes(m) || m.includes(n)) ? 0.85 : tokenOverlap(n, m));
        if (s > score) { score = s; best = i; }
      });
      if (score >= 0.5) return best;
    }
    if (Number.isInteger(openIndex) && openIndex >= 1 && openIndex <= list.length) return openIndex - 1;
    return -1;
  };
  const target = (op) => { const ti = resolve(op); return ti >= 0 ? list[ti] : null; };

  let changed = 0;
  for (const op of (Array.isArray(ops) ? ops : [])) {
    if (!op || typeof op !== 'object') continue;
    switch (String(op.op || '')) {
      case 'add_recipe': {
        const inc = normRecipe(op.recipe || op, false);
        inc.instructions = numberSteps(inc.instructions);
        if (inc.name) { list.push(inc); changed++; }
        break;
      }
      case 'remove_recipe': {
        const ti = resolve(op);
        if (ti >= 0) { list.splice(ti, 1); changed++; }
        break;
      }
      case 'set_field': {
        const t = target(op); if (!t) break;
        const f = String(op.field || '').trim().toLowerCase();
        const v = String(op.value != null ? op.value : '').trim();
        if (f === 'name') { if (v) { t.name = v; changed++; } }
        else if (f === 'category') { if (v) { t.category = normCat(v); changed++; } }
        else if (f === 'preptime' || f === 'time' || f === 'cooktime' || f === 'cook time') { if (v) { t.prepTime = v; changed++; } }
        else if (f === 'servings' || f === 'serving' || f === 'yield') { if (v) { t.servings = v; changed++; } }
        break;
      }
      case 'set_instructions': {
        const t = target(op); if (!t) break;
        const ins = numberSteps(op.instructions);
        if (ins) { t.instructions = ins; changed++; }   // never wipe on an empty/misheard result
        break;
      }
      case 'add_ingredient': {
        const t = target(op); if (!t) break;
        const name = String((op.name != null ? op.name : (op.set && op.set.name) || '')).trim();
        if (!name) break;
        const qty = String((op.qty != null ? op.qty : (op.set && op.set.qty) || '')).trim();
        t.ingredients.push({ name, qty });
        changed++;
        break;
      }
      case 'update_ingredient': {
        const t = target(op); if (!t) break;
        const i = findIngIndex(t.ingredients, op.index, op.match || op.name);
        if (i < 0) break;
        const set = (op.set && typeof op.set === 'object') ? op.set : op;
        if (set.name != null && String(set.name).trim()) t.ingredients[i].name = String(set.name).trim();
        if (set.qty != null && String(set.qty).trim()) t.ingredients[i].qty = String(set.qty).trim();
        changed++;
        break;
      }
      case 'remove_ingredient': {
        const t = target(op); if (!t) break;
        const i = findIngIndex(t.ingredients, op.index, op.match || op.name);
        if (i >= 0) { t.ingredients.splice(i, 1); changed++; }
        break;
      }
      case 'add_tool': {
        const t = target(op); if (!t) break;
        const name = String(op.name || op.value || '').trim();
        if (name && !t.tools.some(x => x.toLowerCase() === name.toLowerCase())) { t.tools.push(name); changed++; }
        break;
      }
      case 'remove_tool': {
        const t = target(op); if (!t) break;
        let i = -1;
        if (Number.isInteger(op.index) && op.index >= 1 && op.index <= t.tools.length) i = op.index - 1;
        else {
          const m = normName(op.match || op.name);
          if (m) i = t.tools.findIndex(x => { const n = normName(x); return n === m || n.includes(m) || m.includes(n); });
        }
        if (i >= 0) { t.tools.splice(i, 1); changed++; }
        break;
      }
      case 'add_step': {
        const t = target(op); if (!t) break;
        const txt = String(op.text || '').trim(); if (!txt) break;
        const steps = stepsOf(t.instructions); steps.push(txt);
        t.instructions = renumberSteps(steps); changed++;
        break;
      }
      case 'insert_step': {
        const t = target(op); if (!t) break;
        const txt = String(op.text || '').trim(); if (!txt) break;
        const steps = stepsOf(t.instructions);
        let after = Number.isInteger(op.after) ? op.after : steps.length;
        if (after < 0) after = 0; if (after > steps.length) after = steps.length;
        steps.splice(after, 0, txt);
        t.instructions = renumberSteps(steps); changed++;
        break;
      }
      case 'update_step': {
        const t = target(op); if (!t) break;
        const txt = String(op.text || '').trim();
        const steps = stepsOf(t.instructions);
        const i = Number.isInteger(op.index) ? op.index - 1 : -1;
        if (i >= 0 && i < steps.length && txt) { steps[i] = txt; t.instructions = renumberSteps(steps); changed++; }
        break;
      }
      case 'remove_step': {
        const t = target(op); if (!t) break;
        const steps = stepsOf(t.instructions);
        const i = Number.isInteger(op.index) ? op.index - 1 : -1;
        if (i >= 0 && i < steps.length) { steps.splice(i, 1); t.instructions = renumberSteps(steps); changed++; }
        break;
      }
    }
  }
  return { recipes: list, changed };
}

async function handleRecipe(body, env) {
  const profile = body.profile === 'veda' ? 'veda' : 'tony';
  const transcript = String(body.transcript || '').trim();
  const audio = typeof body.audio === 'string' ? body.audio : '';
  const mimeType = String(body.mimeType || 'audio/wav');
  const recipes = Array.isArray(body.recipes) ? body.recipes : [];
  const openIndex = Number.isInteger(body.openIndex) ? body.openIndex : 0;

  if (!transcript && !audio) return json({ ok: false, error: 'no transcript or audio' }, 400);
  const key = keyFor(env, profile);
  if (!key) return json({ ok: false, error: `no Gemini key configured for ${profile}` }, 500);

  const prompt = buildRecipePrompt(transcript, recipes, openIndex, !!audio);
  // Voice → faithful chain (complete dictation); typed → fastest chain (instant edits).
  const models = audio ? RECIPE_VOICE_MODELS : RECIPE_EDIT_MODELS;
  let lastErr = null;
  for (const model of models) {
    try {
      const out = await callGemini(model, key, { prompt, schema: RECIPE_OPS_SCHEMA, maxOutputTokens: 8192, feature: 'recipe', audio, mimeType });
      if (out && Array.isArray(out.ops)) {
        const res = applyRecipeOps(recipes, out.ops, openIndex);
        return json({ ok: true, recipes: res.recipes, note: String(out.note || '').trim(), ops: res.changed, model });
      }
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return json({ ok: false, error: lastErr || 'all models failed' }, 502);
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 5 — MyList "Price Watch"   (POST /watch/check, /watch/resolve + daily cron)
//
// Tracks the price of items at six stores and pushes a notification when one
// drops. Two integration classes:
//   • Kroger / King Soopers → official Products API (source:"verified").
//   • Walmart / Amazon / CVS / Walgreens → Gemini-grounded Google Search, and a
//     price is ONLY stored if a supporting citation URL came back
//     (source:"ai-estimated"); otherwise source:"unavailable", never a guess.
//
// The server-side Firestore + FCM stack below is the SAME pattern the TaskHub
// reminders worker uses — service-account JWT → Google OAuth2 token, Firestore
// REST, and a data-only FCM send scoped by device mainDash. It is reused here so
// there is ONE notification/credential pipeline, not a second, different one.
//
// SECRETS required on THIS worker (wrangler secret put <NAME>):
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY   (same
//     service account as taskhub-reminders — re-put them here)
//   KROGER_CLIENT_ID, KROGER_CLIENT_SECRET   (register a free app at
//     developer.kroger.com — MANUAL step; module returns "unavailable" until set)
// VARS required (wrangler.toml [vars]) for the Kroger chains:
//   KROGER_LOCATION_ID, KINGSOOPERS_LOCATION_ID   (real store location IDs from
//     Tony — never hardcoded/guessed; module reports which is missing until set)
// KV binding required: TOKEN_CACHE   (shared namespace with taskhub-reminders)
// ════════════════════════════════════════════════════════════════════════════

const STORE_LABELS = {
  kroger: 'Kroger', kingsoopers: 'King Soopers', walmart: 'Walmart',
  amazon: 'Amazon', cvs: 'CVS', walgreens: 'Walgreens',
};
const KROGER_STORE_KEYS = new Set(['kroger', 'kingsoopers']);
const AI_STORES = new Set(['walmart', 'amazon', 'cvs', 'walgreens']);

// AI-search price lookups use ONLY gemini-2.5-flash: it gets free Google Search
// grounding (shared 500 req/day pool, NO billing account). Do NOT add a 3.x model
// here — grounding is not free for the 3.x family without billing enabled.
// NOTE: gemini-2.5-flash-lite was in the plan, but this project's API key returns
// 404 "no longer available to new users" for it (both grounded AND the reshape
// call), so it is dropped entirely — flash is the only usable free-grounding model
// here. Reshape (WATCH_RESHAPE_MODEL) therefore also uses flash; that's a plain
// no-tools call, so it does NOT consume the grounding quota.
// Grounded models tried in order (one attempt each) — both get FREE Google Search
// grounding with NO billing, and sit in SEPARATE daily quota buckets, so a
// 2.5-flash 429 falls through to 2.0-flash instead of killing the AI stores.
// (2.5-flash-lite is excluded — 404 "no longer available" on this key.)
const WATCH_AI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];
// The reshape is a PLAIN (no-tools) call, so it does NOT consume grounding quota
// and need not be a 2.5 model — using the high-RPD 3.1-flash-lite keeps the
// scarce 2.5-flash budget for the grounded call itself.
const WATCH_RESHAPE_MODEL = 'gemini-3.1-flash-lite';
// Grounded multi-search calls are slow; with only one usable model we allow a
// second attempt on it (see aiAllStores) instead of a cross-model fallback.
const WATCH_GEMINI_TIMEOUT_MS = 28000;

// ── Firestore-REST value <-> plain JS converters (the price-watch doc has nested
//    arrays/maps, so we need a general encoder, unlike the reminders worker which
//    only PATCHes scalar fields). ──────────────────────────────────────────────
function fsEncode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsEncode) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) fields[k] = fsEncode(v[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}
function fsDecode(val) {
  if (!val || typeof val !== 'object') return null;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return val.booleanValue;
  if ('integerValue' in val) return parseInt(val.integerValue, 10);
  if ('doubleValue' in val) return val.doubleValue;
  if ('stringValue' in val) return val.stringValue;
  if ('timestampValue' in val) return val.timestampValue;
  if ('arrayValue' in val) return (val.arrayValue.values || []).map(fsDecode);
  if ('mapValue' in val) {
    const o = {}, f = val.mapValue.fields || {};
    for (const k of Object.keys(f)) o[k] = fsDecode(f[k]);
    return o;
  }
  return null;
}

// Read a whole Firestore doc → plain JS object (null if it doesn't exist).
async function fsReadDoc(env, token, path) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`firestore read ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const doc = await r.json();
  const f = doc.fields || {}, o = {};
  for (const k of Object.keys(f)) o[k] = fsDecode(f[k]);
  return o;
}

// Full-document overwrite from a plain JS object. The cron writes the whole
// Price Watch doc back after EACH item (crash-safe — already-checked items
// persist). Last-write-wins vs. a concurrent UI edit; collisions effectively nil
// given the daily ~4am fire time.
async function fsWriteDoc(env, token, path, obj) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const fields = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) fields[k] = fsEncode(obj[k]);
  const r = await fetch(url, { method: 'PATCH', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`firestore write ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function fsFetchTokens(env, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/fcm_tokens`;
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!r.ok) return [];
  const data = await r.json();
  const seen = new Set();
  return (data.documents || []).filter(d => {
    const t = d.fields?.token?.stringValue;
    if (!t || seen.has(t)) return false;
    seen.add(t); return true;
  });
}

// Data-only FCM send — identical structure to the TaskHub reminders worker so
// firebase-messaging-sw.js draws it exactly the same way (title/body/id/dash;
// unique Topic so same-instant pushes can't coalesce). No new notification type.
// ttlSec: how long FCM holds the message for an OFFLINE device. Reminders are
// time-sensitive (short TTL), but a price drop delivered when a desktop next comes
// online is still useful — so drops use a long TTL (default here) so a 4am push
// isn't lost just because the desktop was asleep/closed (the phone's OS-level FCM
// gets it regardless; the desktop browser only receives while running).
async function sendFCM(projectId, token, title, body, id, accessToken, dash, ttlSec) {
  const ttl = String(ttlSec || 86400);   // 24h default
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        data: { id: String(id || ''), title: String(title || 'Price Watch'), body: String(body || title || ''), dash: String(dash || 'all') },
        android: { priority: 'high', ttl: `${ttl}s` },
        webpush: { headers: { Urgency: 'high', TTL: ttl, Topic: crypto.randomUUID().replace(/-/g, '') } },
      },
    }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message || res.status);
}

// ── Service-account access token (ported from taskhub-reminders). Cached in
//    memory + KV under a price-watch-specific key so it can't clobber the
//    reminders worker's 'gat' entry even though both share the KV namespace. ──
let _pwGoogleToken = null;
async function getGoogleAccessToken(env) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (_pwGoogleToken && _pwGoogleToken.expiresAt > nowSec + 300) return _pwGoogleToken.token;
  if (env.TOKEN_CACHE) {
    try {
      const kv = await env.TOKEN_CACHE.get('pw_gat', 'json');
      if (kv && kv.expiresAt > nowSec + 300) { _pwGoogleToken = kv; return kv.token; }
    } catch (e) { console.warn('KV read error:', e.message); }
  }
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL, sub: env.FIREBASE_CLIENT_EMAIL,
    aud: 'https://oauth2.googleapis.com/token', iat: nowSec, exp: nowSec + 3600,
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/datastore',
  }));
  const payload = `${header}.${claim}`;
  let raw = (env.FIREBASE_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/^['"]|['"]$/g, '');
  const pemBody = raw
    .replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').trim();
  if (!pemBody || pemBody.length < 100) throw new Error('FIREBASE_PRIVATE_KEY empty/too short after parsing — re-upload the secret');
  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', keyBytes.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(payload));
  const jwt = `${payload}.${b64url(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  const j = await res.json();
  const entry = { token: j.access_token, expiresAt: nowSec + 3600 };
  _pwGoogleToken = entry;
  if (env.TOKEN_CACHE) {
    try { await env.TOKEN_CACHE.put('pw_gat', JSON.stringify(entry), { expirationTtl: 3300 }); } catch (e) { console.warn('KV write error:', e.message); }
  }
  return entry.token;
}
function b64url(data) {
  const b = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = ''; b.forEach(x => s += String.fromCharCode(x));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ────────────────────────────────────────────────────────────────────────────
// STORE MODULE 3a — Kroger / King Soopers  (official Products API, no AI)
//
// Same API for both chains; the chain is chosen by filter.locationId. The OAuth2
// client-credentials token is short-lived, so it is cached (memory + KV) and
// reused across a whole cron run. See docs/PriceWatch/STORE_NOTES.md → "Kroger / King Soopers".
// ────────────────────────────────────────────────────────────────────────────
let _krogerTok = null;
async function krogerToken(env) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (_krogerTok && _krogerTok.expiresAt > nowSec + 60) return _krogerTok.token;
  if (env.TOKEN_CACHE) {
    try { const kv = await env.TOKEN_CACHE.get('kroger_tok', 'json'); if (kv && kv.expiresAt > nowSec + 60) { _krogerTok = kv; return kv.token; } } catch (e) {}
  }
  const basic = btoa(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`);
  const r = await fetch('https://api.kroger.com/v1/connect/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=product.compact',
  });
  if (!r.ok) throw new Error(`kroger token ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const j = await r.json();
  const entry = { token: j.access_token, expiresAt: nowSec + (j.expires_in || 1800) };
  _krogerTok = entry;
  if (env.TOKEN_CACHE) { try { await env.TOKEN_CACHE.put('kroger_tok', JSON.stringify(entry), { expirationTtl: Math.max(60, (j.expires_in || 1800) - 60) }); } catch (e) {} }
  return entry.token;
}

// Returns { ok, items:[{krogerProductId,name,brand,size,price}] } or, when config
// is absent, { ok:false, configMissing:[...] } so callers report exactly what
// still needs to be set (never a fabricated location ID or price).
//
// Location IDs are PER-PROFILE (Tony and Veda shop different regions — Tony=CO
// King Soopers, Veda=GA Kroger), so the var is <BANNER>_LOCATION_ID_<PROFILE>.
// A profile+banner with no nearby store (e.g. Tony+Kroger, Veda+KingSoopers)
// simply has no var set → that combo reports "unavailable", which is correct.
async function krogerSearch(env, storeKey, profile, { term, productId }) {
  const banner = storeKey === 'kingsoopers' ? 'KINGSOOPERS' : 'KROGER';
  const prof = profile === 'veda' ? 'VEDA' : 'TONY';
  const locVar = `${banner}_LOCATION_ID_${prof}`;
  const locId = env[locVar];
  const missing = [];
  if (!env.KROGER_CLIENT_ID || !env.KROGER_CLIENT_SECRET) missing.push('KROGER_CLIENT_ID/KROGER_CLIENT_SECRET (secrets)');
  if (!locId) missing.push(`${locVar} (var)`);
  if (missing.length) return { ok: false, configMissing: missing };

  const tok = await krogerToken(env);
  const qs = new URLSearchParams();
  qs.set('filter.locationId', locId);
  // A resolved productId pins us to the EXACT product (no fuzzy drift); otherwise
  // a fuzzy term search returns the top few candidates for confirm-on-add.
  if (productId) qs.set('filter.productId', productId);
  else { qs.set('filter.term', term); qs.set('filter.limit', '8'); }
  const r = await fetch(`https://api.kroger.com/v1/products?${qs.toString()}`, { headers: { 'Authorization': `Bearer ${tok}`, 'Accept': 'application/json' } });
  if (!r.ok) return { ok: false, error: `kroger products ${r.status}` };
  const j = await r.json();
  const items = (j.data || []).map(p => {
    const it = (p.items && p.items[0]) || {};
    const price = it.price || {};
    const val = (typeof price.promo === 'number' && price.promo > 0) ? price.promo : price.regular;
    return {
      krogerProductId: p.productId || '',
      name: p.description || '',
      brand: p.brand || '',
      size: it.size || '',
      price: typeof val === 'number' ? val : null,
    };
  });
  return { ok: true, items };
}

// Returns { source, variants:[{store,source,title,size,brand,price,krogerProductId}] }.
// Fuzzy term search returns SEVERAL real products (variants) with prices — all of
// them are surfaced so the confirm UI can show multiple to track.
async function krogerVariants(env, storeKey, profile, item) {
  const term = item.brandLock ? `${item.brandLock} ${item.itemName}` : item.itemName;
  let res;
  try { res = await krogerSearch(env, storeKey, profile, { term }); }
  catch (e) { return { source: 'unavailable', variants: [], note: e.message || 'kroger error' }; }
  if (!res.ok) {
    if (res.configMissing) return { source: 'unavailable', variants: [], configMissing: res.configMissing, note: `not configured — missing ${res.configMissing.join(', ')}` };
    return { source: 'unavailable', variants: [], note: res.error || 'kroger lookup failed' };
  }
  const variants = res.items
    .filter(x => typeof x.price === 'number' && x.price > 0)
    .map(x => ({ store: storeKey, source: 'verified', title: x.name, size: x.size, brand: x.brand, price: x.price, krogerProductId: x.krogerProductId }))
    .sort((a, b) => a.price - b.price)
    .slice(0, 6);
  if (!variants.length) return { source: 'unavailable', variants: [], note: 'no priced products found' };
  return { source: 'verified', variants };
}

// ────────────────────────────────────────────────────────────────────────────
// STORE MODULE 3b — Walmart / Amazon / CVS / Walgreens  (Gemini-grounded, cited)
//
// Returns MULTIPLE product variants per store (not one price). Two calls:
//   1) grounded (google_search + url_context) — asked for a LIST of real products.
//   2) a plain no-tools reshape into a strict variants array.
// A variant is kept ONLY if it has a numeric price AND a product-page URL ON THE
// STORE'S OWN DOMAIN (that URL is the citation — much higher recall than requiring
// groundingMetadata chunks, which were often empty even for real products).
// See docs/PriceWatch/STORE_NOTES.md for per-store notes.
// ────────────────────────────────────────────────────────────────────────────
// Default retailer set. Users can add/remove AI-type retailers at runtime (the
// list syncs via the pricewatch doc's `stores` field); the search auto-adapts to
// any of them BY DOMAIN with no per-store code. Kroger-type stores use the
// official API and are limited to the two configured banners.
const DEFAULT_STORES = [
  { key: 'kroger', name: 'Kroger', type: 'kroger' },
  { key: 'kingsoopers', name: 'King Soopers', type: 'kroger' },
  { key: 'walmart', name: 'Walmart', domain: 'walmart.com', type: 'ai' },
  { key: 'amazon', name: 'Amazon', domain: 'amazon.com', type: 'ai' },
  { key: 'cvs', name: 'CVS', domain: 'cvs.com', type: 'ai' },
  { key: 'walgreens', name: 'Walgreens', domain: 'walgreens.com', type: 'ai' },
];
const KROGER_BANNERS = new Set(['kroger', 'kingsoopers']);   // only these have API location vars
function cleanDomain(d) { return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''); }
function normStores(input) {
  if (!Array.isArray(input) || !input.length) return DEFAULT_STORES.slice();
  const out = [], seen = new Set();
  for (const s of input) {
    if (!s || !s.key) continue;
    const key = String(s.key).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);
    if (!key || seen.has(key)) continue; seen.add(key);
    const type = (s.type === 'kroger' || KROGER_BANNERS.has(key)) ? 'kroger' : 'ai';
    out.push({ key, name: String(s.name || key).slice(0, 40), domain: cleanDomain(s.domain), type });
  }
  return out.length ? out : DEFAULT_STORES.slice();
}
// Relevance of a product to the query (0..~1.3): token overlap of query(+brandLock)
// vs the product's brand+title, plus a full-phrase bonus — so "face wash" ranks
// face washes above other same-brand items, and partial tokens still count.
function relevanceScore(query, brandLock, text) {
  const q = normName((brandLock ? brandLock + ' ' : '') + (query || ''));
  const t = normName(text || '');
  if (!q || !t) return 0;
  const qt = q.split(' ').filter(Boolean);
  const tset = new Set(t.split(' ').filter(Boolean));
  const ta = [...tset];
  let hit = 0;
  qt.forEach(w => {
    if (tset.has(w)) hit += 1;
    else if (w.length >= 3 && ta.some(x => x.indexOf(w) >= 0 || w.indexOf(x) >= 0)) hit += 0.5;
  });
  let score = qt.length ? hit / qt.length : 0;
  if (t.indexOf(normName(query)) >= 0) score += 0.3;   // exact phrase present
  return score;
}

// ONE grounded call covers ALL FOUR AI stores. Firing four separate grounded
// calls (×2 attempts) per item blew the free-tier per-minute grounding limit
// (429) and burned 4× the shared 500/day pool; one combined call fixes both and
// lets the model compare across retailers in a single search.
function buildAiPrompt(item, aiStores) {
  const list = aiStores.map(s => `${s.name} (${s.domain})`).join(', ');
  const q = item.itemName;
  const lines = [
    `You are an expert shopping researcher. Using Google Search AND url_context, find products CURRENTLY SOLD at these US retailers: ${list}.`,
    `Shopper's query: "${q}".`,
  ];
  if (item.brandLock) lines.push(`Focus on this brand/product: "${item.brandLock} ${q}".`);
  if (item.productRef && item.productRef.url) lines.push(`One relevant product page (fetch with url_context): ${item.productRef.url}`);
  lines.push(
    ``,
    `Interpret the query INTELLIGENTLY — use fuzzy and partial matching, do NOT require an exact title match:`,
    `- If the query names a SPECIFIC product or type (e.g. "La Roche-Posay Face Wash"), put the closest EXACT matches first, then also include closely related products (same brand/line, or a similar type) so there are always useful results.`,
    `- If the query is BROAD (e.g. just a brand like "La Roche-Posay"), return a representative range of that brand's popular products at each retailer.`,
    ``,
    `For EACH retailer above, list UP TO 5 real products actually sold there, MOST RELEVANT FIRST. For every product give: which retailer, the exact product title, size/count, the brand, the CURRENT US price, and the product-page URL on THAT retailer's own domain.`,
    `Read each price from that retailer's own product page. Every product MUST have a real URL on that retailer's domain — never invent products, prices, or URLs, and never attribute one retailer's product to another. These retailers carry very broad catalogs, so search each thoroughly (e.g. "site:<domain> ${q}") before concluding an item isn't sold there.`,
  );
  return lines.join('\n');
}

function buildAiReshape(groundedText, aiStores) {
  const domains = aiStores.map(s => s.domain).filter(Boolean).join(', ');
  return [
    `From the shopping-research answer below, extract EVERY distinct product it lists, as JSON.`,
    `For each product: store (the retailer name it belongs to), title, size, brand, price (a USD number), url (its product-page URL — must be on one of these domains: ${domains}).`,
    `Include a product ONLY if it has BOTH a numeric price AND a URL on one of those domains. Drop anything missing either. Never invent values.`,
    ``,
    `ANSWER:`,
    `"""`,
    String(groundedText || '').slice(0, 12000),
    `"""`,
  ].join('\n');
}

const AI_VARIANTS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    products: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          store: { type: 'STRING' },
          title: { type: 'STRING' },
          size: { type: 'STRING' },
          brand: { type: 'STRING' },
          price: { type: 'NUMBER' },
          url: { type: 'STRING' },
        },
      },
    },
  },
  required: ['products'],
};

// Low-level grounded call (callGemini can't do this — it forces JSON-only, no
// tools). Returns { text, citationUrls } gathered from every citation channel.
async function geminiGrounded(model, key, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }, { url_context: {} }],
    generationConfig: { temperature: 0 },
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WATCH_GEMINI_TIMEOUT_MS);
  let r;
  try { r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ac.signal }); }
  finally { clearTimeout(timer); }
  if (!r.ok) throw new Error(`grounded ${model} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const cand = data?.candidates?.[0] || {};
  const text = cand?.content?.parts?.map(p => p.text || '').join('') || '';
  const urls = [];
  const gm = cand.groundingMetadata || {};
  (gm.groundingChunks || []).forEach(c => { const u = c?.web?.uri; if (u) urls.push(u); });
  const cm = cand.citationMetadata || {};
  (cm.citationSources || []).forEach(c => { if (c?.uri) urls.push(c.uri); });
  const um = cand.urlContextMetadata || {};
  (um.urlMetadata || []).forEach(u => { const v = u?.retrievedUrl || u?.retrieved_url; if (v) urls.push(v); });
  return { text, citationUrls: urls };
}

// ONE grounded call for ALL AI stores in the list → { <key>:{source,variants}, ... }.
// Each returned product is assigned to a store by matching its URL host to that
// store's domain (robust — doesn't trust the model's store label), which is also
// the citation gate: price>0 AND URL on one of the configured domains.
async function aiAllStores(env, item, profile, aiStores) {
  const out = {};
  aiStores.forEach(s => { out[s.key] = { source: 'unavailable', variants: [], note: '' }; });
  if (!aiStores.length) return out;
  const key = keyFor(env, profile);
  if (!key) { aiStores.forEach(s => out[s.key].note = `no Gemini key for ${profile}`); return out; }
  const prompt = buildAiPrompt(item, aiStores);

  let grounded = null, lastErr = null;
  for (const model of WATCH_AI_MODELS) {   // 2.5-flash → 2.0-flash on failure/429
    try { const g = await geminiGrounded(model, key, prompt); if (g && g.text) { grounded = g; break; } }
    catch (e) { lastErr = e.message || String(e); }
  }
  if (!grounded || !grounded.text) { aiStores.forEach(s => out[s.key].note = lastErr || 'grounded lookup failed'); return out; }

  let shaped = null;
  try { shaped = await callGemini(WATCH_RESHAPE_MODEL, key, { prompt: buildAiReshape(grounded.text, aiStores), schema: AI_VARIANTS_SCHEMA, maxOutputTokens: 4096, feature: 'watch' }); }
  catch (e) { lastErr = e.message || String(e); aiStores.forEach(s => out[s.key].note = lastErr); }

  const raw = (shaped && Array.isArray(shaped.products)) ? shaped.products : [];
  const byDomain = {};
  aiStores.forEach(s => { if (s.domain) byDomain[s.domain] = s.key; });
  const seen = {};
  for (const v of raw) {
    const price = typeof v.price === 'number' ? v.price : parseFloat(v.price);
    const url = String(v.url || '').trim();
    if (!(price > 0) || !url) continue;
    const lu = url.toLowerCase();
    let sk = null;
    for (const dom in byDomain) { if (lu.indexOf(dom) >= 0) { sk = byDomain[dom]; break; } }   // derive store from URL domain
    if (!sk || !out[sk]) continue;
    const dedupe = sk + '|' + String(v.title || '').toLowerCase().slice(0, 40) + '|' + price.toFixed(2);
    if (seen[dedupe]) continue;
    seen[dedupe] = 1;
    if (out[sk].variants.length >= 6) continue;
    out[sk].variants.push({ store: sk, source: 'ai-estimated', title: String(v.title || '').slice(0, 140), size: String(v.size || '').slice(0, 40), brand: String(v.brand || '').slice(0, 60), price: Math.round(price * 100) / 100, url });
  }
  aiStores.forEach(s => { if (out[s.key].variants.length) out[s.key].source = 'ai-estimated'; else if (!out[s.key].note) out[s.key].note = 'no cited product/price found'; });
  return out;
}

// ── ALL-STORE CHECK ──────────────────────────────────────────────────────────
// Prices an item at EVERY store in the (dynamic) `stores` list and returns a
// per-store breakdown of variants + the computed best (cheapest) across stores.
// Kroger-type banners hit the API in parallel with ONE combined AI grounded call
// for ALL ai-type stores (so cost is ~1 grounded request regardless of how many
// AI retailers are enabled — the pipeline stays performant as stores are added).
// Variants are ranked by relevance to the query, then price. Per-store pins
// (Kroger productId / AI url+title) carry forward from the item's prior breakdown.
async function checkAllStores(env, profile, item, storesInput) {
  const stores = normStores(storesInput);
  const itemName = item.name || item.itemName || '';
  const brandLock = item.brandLock || '';
  const prev = {};
  (Array.isArray(item.perStoreBreakdown) ? item.perStoreBreakdown : []).forEach(e => { if (e && e.store) prev[e.store] = e; });
  const hintUrl = (item.productRef && item.productRef.url) || '';

  const krogerStores = stores.filter(s => s.type === 'kroger');
  const aiStores = stores.filter(s => s.type === 'ai' && s.domain);
  const aiItem = { itemName, brandLock, productRef: { url: hintUrl, foundTitle: (aiStores[0] && prev[aiStores[0].key] && prev[aiStores[0].key].foundTitle) || '' } };

  const [krogerResults, aiRes] = await Promise.all([
    Promise.all(krogerStores.map(s =>
      krogerVariants(env, s.key, profile, { itemName, brandLock, productRef: { krogerProductId: (prev[s.key] && prev[s.key].krogerProductId) || '' } })
        .catch(e => ({ source: 'unavailable', variants: [], note: e.message || 'error' })))),
    aiAllStores(env, aiItem, profile, aiStores).catch(() => ({})),
  ]);
  const perStore = {};
  krogerStores.forEach((s, i) => { perStore[s.key] = krogerResults[i]; });
  aiStores.forEach(s => { perStore[s.key] = (aiRes && aiRes[s.key]) || { source: 'unavailable', variants: [] }; });

  const breakdown = stores.map((s) => {
    const res = perStore[s.key] || { source: 'unavailable', variants: [] };
    const variants = Array.isArray(res.variants) ? res.variants : [];
    variants.forEach(v => { v.score = relevanceScore(itemName, brandLock, (v.brand || '') + ' ' + (v.title || '')); });
    variants.sort((a, b) => (b.score - a.score) || (a.price - b.price));   // relevance, then price
    let cheapest = null;
    variants.forEach(v => { if (typeof v.price === 'number' && (cheapest === null || v.price < cheapest.price)) cheapest = v; });
    const entry = { store: s.key, storeName: s.name, source: cheapest ? res.source : 'unavailable', variants };
    if (cheapest) {
      entry.price = cheapest.price;
      if (cheapest.url) entry.url = cheapest.url;
      if (cheapest.krogerProductId) entry.krogerProductId = cheapest.krogerProductId;
      if (cheapest.brand) entry.brand = cheapest.brand;
      if (cheapest.title) entry.foundTitle = cheapest.title;
    } else if (res.note) {
      entry.note = res.note;
    }
    return entry;
  });

  guardOutliers(breakdown);   // drop a wildly-out-of-line price (e.g. a mis-parsed $4.98 → $498)

  let best = null;
  breakdown.forEach(e => { if (typeof e.price === 'number' && (best === null || e.price < best.price)) best = e; });
  return {
    ok: true, breakdown,
    bestPrice: best ? best.price : null,
    bestStore: best ? best.store : null,
    bestStoreName: best ? (best.storeName || best.store) : null,
    bestBrand: best ? (best.brand || '') : '',
    foundCount: breakdown.filter(e => typeof e.price === 'number').length,
    storeCount: stores.length,
    stores: stores.map(s => ({ key: s.key, name: s.name, type: s.type, domain: s.domain || '' })),
  };
}

// Defense-in-depth against a mis-scraped/mis-parsed price (e.g. a split-span
// "$4.98" read as "$498"): if a store's price is more than 10× the MEDIAN of the
// other found prices for this SAME item, treat it as a parse error — drop the
// price so it can't be shown, become "best", or poison price history. Requires at
// least 3 found prices so a genuinely pricier single store isn't nuked.
function guardOutliers(breakdown) {
  const priced = (breakdown || []).filter(e => typeof e.price === 'number' && e.price > 0);
  if (priced.length < 3) return;
  const sorted = priced.map(e => e.price).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!(median > 0)) return;
  (breakdown || []).forEach(e => {
    if (typeof e.price === 'number' && e.price > median * 10) {
      console.log(`[pricewatch] dropped outlier ${e.store} $${e.price} (median $${median})`);
      e.note = `dropped $${e.price} — looked mis-read (≫ other stores)`;
      delete e.price; delete e.url; delete e.krogerProductId; delete e.foundTitle; delete e.brand;
      e.source = 'unavailable';
      if (Array.isArray(e.variants)) e.variants = e.variants.filter(v => !(typeof v.price === 'number' && v.price > median * 10));
    }
  });
}

// Strip the per-store `variants` list (+ transient score) before persisting to
// Firestore — variants are for the live confirm UI only; storing them per item/day
// would bloat the doc. Keeps the pins + storeName so later checks/labels work.
function slimBreakdown(breakdown) {
  return (breakdown || []).map(e => {
    const o = { store: e.store, source: e.source };
    if (e.storeName) o.storeName = e.storeName;
    if (typeof e.price === 'number') o.price = e.price;
    if (e.url) o.url = e.url;
    if (e.krogerProductId) o.krogerProductId = e.krogerProductId;
    if (e.brand) o.brand = e.brand;
    if (e.foundTitle) o.foundTitle = e.foundTitle;
    if (e.note) o.note = e.note;
    return o;
  });
}

// /watch/check and /watch/resolve are the SAME all-store lookup — resolve is just
// the on-add call (client shows one consolidated "found at N of 6" confirm), and
// check is the on-demand / cron call. Body item may use `name` or `itemName`.
async function handleWatchCheck(body, env) {
  const profile = body.profile === 'veda' ? 'veda' : 'tony';
  const item = body.item;
  if (!item || !(item.name || item.itemName)) return json({ ok: false, error: 'missing item name' }, 400);
  try { return json(await checkAllStores(env, profile, item, body.stores)); }
  catch (e) { return json({ ok: false, error: e.message || String(e) }, 502); }
}
const handleWatchResolve = handleWatchCheck;

// ── Daily cron ───────────────────────────────────────────────────────────────
// Reads the two standalone Price Watch docs (one per profile), prices EACH item
// at ALL SIX stores, records the per-store breakdown + daily best into the item,
// writes the doc back AFTER EACH item (crash-safe), and pushes a notification
// when today's best beats the previous best by more than a flat $1.00.
//
// SUBREQUEST CAP (all-6-stores): each item costs ~9–13 subrequests (1 real Kroger
// banner + 1 skipped-before-fetch out-of-region; 4 AI stores × 2–3 Gemini calls) —
// so PW_MAX_ITEMS_PER_RUN is 3 (3 × ~13 + overhead + writes ≈ 45 < 50). A KV
// round-robin cursor rotates a larger combined watchlist across successive daily
// runs (coverage latency ≈ ceil(totalItems / 3) days) — the accepted tradeoff for
// the free plan and the cap that broke newshub-api.
const PW_DOCS = [
  { profile: 'tony', path: 'dashboards/pricewatch' },
  { profile: 'veda', path: 'dashboards/pricewatch-veda' },
];
const PW_MAX_ITEMS_PER_RUN = 3;
const PW_MAX_HISTORY = 180;   // ~6 months of daily bests; keeps the doc bounded

// ── Shared write path ────────────────────────────────────────────────────────
// The daily cron and /watch/ingest (the PriceWatch extension's background
// auto-checks) BOTH funnel through these two, so history shape, the badge
// `source` and the >$1 drop push behave identically no matter which one did
// the checking. Don't inline either of these back into a caller.

// Mutates `it` in place; returns the PREVIOUS best price (null if never priced)
// so the caller can decide whether a drop is worth notifying about.
function pwApplyToItem(it, res, today) {
  const prevBest = typeof it.bestPrice === 'number' ? it.bestPrice : null;
  const slim = slimBreakdown(res.breakdown);
  it.perStoreBreakdown = slim;
  it.bestPrice = (typeof res.bestPrice === 'number') ? res.bestPrice : null;   // may be null (all stores unavailable)
  it.bestStore = res.bestStore || null;
  it.lastChecked = new Date().toISOString();
  if (!Array.isArray(it.priceHistory)) it.priceHistory = [];
  // One entry PER DAY. The cron checks daily so this is a no-op for it, but the
  // extension can check every few hours — without this, `priceHistory` would
  // grow ~6×/day and MyList's pwDelta() (last two entries = day over day) would
  // start comparing two checks from the same afternoon.
  const last = it.priceHistory[it.priceHistory.length - 1];
  const rec = { date: today, bestPrice: it.bestPrice, bestStore: it.bestStore, breakdown: slim };
  if (last && last.date === today) it.priceHistory[it.priceHistory.length - 1] = rec;
  else it.priceHistory.push(rec);
  if (it.priceHistory.length > PW_MAX_HISTORY) it.priceHistory = it.priceHistory.slice(-PW_MAX_HISTORY);
  return prevBest;
}

// Push only on a REAL drop of more than a flat $1.00, and never when today's
// best is unavailable. Returns the number of devices notified.
async function pwNotifyDrop(env, token, profile, it, prevBest, res, tokenDocs) {
  if (prevBest == null || typeof res.bestPrice !== 'number') return 0;
  if ((prevBest - res.bestPrice) <= 1.00) return 0;
  const targets = tokenDocs.filter(d => (d.fields?.mainDash?.stringValue || 'all') === profile);
  const bestEntry = (res.breakdown || []).find(e => e.store === res.bestStore) || {};
  // 'live-scrape' is a real observed price, so it gets no hedge — only the AI
  // guess does.
  const estNote = bestEntry.source === 'ai-estimated' ? ' — worth double-checking' : '';
  const storeLabel = res.bestStoreName || bestEntry.storeName || STORE_LABELS[res.bestStore] || res.bestStore;
  const nm = it.itemName || it.name || 'Item';
  const bodyTxt = `${nm}: $${prevBest.toFixed(2)} → $${res.bestPrice.toFixed(2)} at ${storeLabel}${estNote}`;
  const occId = `pw_${profile}_${it.id || ''}_${Date.now()}`;
  await Promise.allSettled(targets.map(d =>
    sendFCM(env.FIREBASE_PROJECT_ID, d.fields.token.stringValue, 'Price drop', bodyTxt, occId, token, profile)
      .catch(e => { console.warn('[pricewatch] fcm', e.message); pruneDeadToken(env, token, d, e); })
  ));
  console.log(`[pricewatch] drop ${bodyTxt} → ${targets.length} device(s)`);
  return targets.length;
}

// A token FCM reports UNREGISTERED/NotRegistered is permanently dead (the browser
// rotated or revoked it). Delete its fcm_tokens doc so it can't keep silently
// swallowing this device's drops and so a stale entry can't mask the live one.
function pruneDeadToken(env, token, d, err) {
  const m = String((err && err.message) || err || '');
  if (!/unregistered|not.?registered|not a valid fcm registration|invalid.?registration|requested entity was not found/i.test(m)) return;
  if (!d || !d.name) return;
  console.log(`[pricewatch] pruning dead token ${d.name.split('/').pop()}`);
  fetch(`https://firestore.googleapis.com/v1/${d.name}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});
}

// Append a drop to the doc's `drops` list — the in-app "prices dropped while you
// were away" banner reads this and shows it until the user dismisses it. Capped so
// the doc can't grow unbounded. Kept alongside the FCM push so a missed push (e.g.
// a browser with background notifications disabled) is still visible in-app.
function pwRecordDrop(doc, it, prevBest, res, today) {
  if (!Array.isArray(doc.drops)) doc.drops = [];
  const bestEntry = (res.breakdown || []).find(e => e.store === res.bestStore) || {};
  doc.drops.push({
    id: it.id || '', itemName: it.itemName || it.name || 'Item',
    prevPrice: prevBest, newPrice: res.bestPrice,
    store: res.bestStore || '', storeName: res.bestStoreName || bestEntry.storeName || res.bestStore || '',
    source: bestEntry.source || '', date: today, ts: Date.now(),
  });
  if (doc.drops.length > 20) doc.drops = doc.drops.slice(-20);
}

async function runPriceWatchCron(env) {
  let token;
  try { token = await getGoogleAccessToken(env); }
  catch (e) { console.error('[pricewatch] auth failed:', e.message); return; }

  // Read both docs; build a flat list of {profile, path, doc, item} across them.
  const docs = {};
  const flat = [];
  for (const d of PW_DOCS) {
    let data;
    try { data = await fsReadDoc(env, token, d.path); }
    catch (e) { console.warn('[pricewatch] read', d.path, e.message); continue; }
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    docs[d.path] = data || { items: [] };
    if (!docs[d.path].items) docs[d.path].items = items;
    const stores = (data && Array.isArray(data.stores)) ? data.stores : null;   // per-profile store list
    items.forEach(item => { if (item) flat.push({ profile: d.profile, path: d.path, item, stores }); });
  }
  if (!flat.length) { console.log('[pricewatch] no watched items'); return; }

  let cursor = 0;
  try { const c = await env.TOKEN_CACHE.get('pw_cron_cursor'); cursor = c ? (parseInt(c, 10) || 0) : 0; } catch (e) {}
  if (cursor >= flat.length) cursor = 0;
  const slice = flat.slice(cursor, cursor + PW_MAX_ITEMS_PER_RUN);
  const nextCursor = (cursor + PW_MAX_ITEMS_PER_RUN >= flat.length) ? 0 : cursor + PW_MAX_ITEMS_PER_RUN;
  try { await env.TOKEN_CACHE.put('pw_cron_cursor', String(nextCursor)); } catch (e) {}
  console.log(`[pricewatch] checking ${slice.length}/${flat.length} item(s) (cursor ${cursor}→${nextCursor})`);

  let tokenDocsCache = null;
  const today = new Date().toISOString().slice(0, 10);

  for (const entry of slice) {
    const it = entry.item;
    let res;
    try { res = await checkAllStores(env, entry.profile, it, entry.stores); }
    catch (e) { res = { ok: false, breakdown: [], bestPrice: null, bestStore: null }; }

    const prevBest = pwApplyToItem(it, res, today);
    const isDrop = (prevBest != null && typeof res.bestPrice === 'number' && (prevBest - res.bestPrice) > 1.00);

    // Write the whole doc back NOW (crash-safe). `it` is a live reference inside
    // docs[path].items, so its mutation is already in the object we serialize.
    const d = docs[entry.path];
    if (isDrop) pwRecordDrop(d, it, prevBest, res, today);   // persist for the in-app banner (before the write)
    // Preserve the doc's `stores` + `drops` on write (never wipe user config/banner).
    try { await fsWriteDoc(env, token, entry.path, { items: d.items, stores: d.stores, drops: d.drops, savedAt: Date.now() }); }
    catch (e) { console.warn('[pricewatch] write', entry.path, e.message); }

    if (isDrop) {
      if (!tokenDocsCache) tokenDocsCache = await fsFetchTokens(env, token);
      await pwNotifyDrop(env, token, entry.profile, it, prevBest, res, tokenDocsCache);
    }
  }
}

// ── PriceWatch extension endpoints ───────────────────────────────────────────
// The browser extension scrapes in the USER'S OWN Chrome session, but it can't
// write Firestore itself: the page has App Check (reCAPTCHA v3) enabled and an
// extension service worker can't produce that attestation. So it reads state
// and posts results through here, where the service-account JWT already exists
// and the drop-notification pipeline is already wired.

// Current watchlist + the live store list for a profile. The extension calls
// this on every alarm run rather than caching a store list — same dynamic-store
// rule as the message path.
async function handleWatchState(body, env) {
  const profile = body.profile === 'veda' ? 'veda' : 'tony';
  const path = profile === 'veda' ? 'dashboards/pricewatch-veda' : 'dashboards/pricewatch';
  try {
    const token = await getGoogleAccessToken(env);
    const data = await fsReadDoc(env, token, path);
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    return json({
      ok: true,
      stores: (data && Array.isArray(data.stores)) ? data.stores : DEFAULT_STORES,
      // Only what a check needs — the extension never sees priceHistory.
      items: items.map(i => ({
        id: i.id, itemName: i.itemName || i.name || '', qty: i.qty || '',
        brandLock: i.brandLock || '', productRef: i.productRef || { url: '' },
        perStoreBreakdown: i.perStoreBreakdown || [],
      })),
    });
  } catch (e) { return json({ ok: false, error: e.message || String(e) }, 502); }
}

// Results scraped by the extension → the same doc, same schema persistWatch()
// writes, same >$1 push. Unknown item ids are skipped (the watch was deleted
// mid-run), never treated as an error.
async function handleWatchIngest(body, env) {
  const profile = body.profile === 'veda' ? 'veda' : 'tony';
  const path = profile === 'veda' ? 'dashboards/pricewatch-veda' : 'dashboards/pricewatch';
  const results = Array.isArray(body.results) ? body.results : [];
  if (!results.length) return json({ ok: false, error: 'no results' }, 400);

  try {
    const token = await getGoogleAccessToken(env);
    const data = (await fsReadDoc(env, token, path)) || { items: [] };
    const items = Array.isArray(data.items) ? data.items : [];
    const today = new Date().toISOString().slice(0, 10);
    let tokenDocsCache = null, applied = 0, skipped = 0;

    for (const r of results) {
      const it = items.find(x => x && x.id === r.id);
      if (!it) { skipped++; continue; }
      const res = {
        breakdown: Array.isArray(r.breakdown) ? r.breakdown : [],
        bestPrice: typeof r.bestPrice === 'number' ? r.bestPrice : null,
        bestStore: r.bestStore || null,
        bestStoreName: r.bestStoreName || null,
      };
      // Scrub a mis-parsed outlier price, then recompute best from the clean data
      // so a bad scrape (e.g. $4.98→$498) never enters history or fires a "drop".
      guardOutliers(res.breakdown);
      let rb = null;
      res.breakdown.forEach(e => { if (typeof e.price === 'number' && (rb === null || e.price < rb.price)) rb = e; });
      res.bestPrice = rb ? rb.price : null;
      res.bestStore = rb ? rb.store : null;
      res.bestStoreName = rb ? (rb.storeName || rb.store) : null;
      const prevBest = pwApplyToItem(it, res, today);
      applied++;
      if (prevBest != null && typeof res.bestPrice === 'number' && (prevBest - res.bestPrice) > 1.00) {
        pwRecordDrop(data, it, prevBest, res, today);   // in-app banner
        if (!tokenDocsCache) tokenDocsCache = await fsFetchTokens(env, token);
        await pwNotifyDrop(env, token, profile, it, prevBest, res, tokenDocsCache);
      }
    }

    if (applied) await fsWriteDoc(env, token, path, { items, stores: data.stores, drops: data.drops, savedAt: Date.now() });
    return json({ ok: true, applied, skipped });
  } catch (e) { return json({ ok: false, error: e.message || String(e) }, 502); }
}

// Diagnostic: send a test push to every token this profile's drop notifications
// target, and report per-token success/failure — so a device that silently isn't
// receiving MyList pushes (but gets TaskHub) can be pinpointed. Same send path,
// same token filter, as a real price drop.
async function handlePwNotifDebug(body, env) {
  const profile = body.profile === 'veda' ? 'veda' : 'tony';
  try {
    const token = await getGoogleAccessToken(env);
    const tokenDocs = await fsFetchTokens(env, token);
    const targets = tokenDocs.filter(d => (d.fields?.mainDash?.stringValue || 'all') === profile);
    const results = [];
    for (const d of targets) {
      const tok = d.fields.token.stringValue;
      const ua = (d.fields?.ua?.stringValue || '').slice(0, 60);
      try {
        await sendFCM(env.FIREBASE_PROJECT_ID, tok, 'Price Watch test', 'PriceWatch test — ' + new Date().toLocaleTimeString(), 'pwtest_' + Date.now(), token, profile);
        results.push({ ua, tokenTail: tok.slice(-10), result: 'sent' });
      } catch (e) {
        results.push({ ua, tokenTail: tok.slice(-10), result: 'FAIL: ' + (e.message || e) });
        pruneDeadToken(env, token, d, e);
      }
    }
    return json({ ok: true, profile, targets: targets.length, results });
  } catch (e) { return json({ ok: false, error: e.message || String(e) }, 502); }
}

// ════════════════════════════════════════════════════════════════════════════
// Router
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// FEATURE — Everwell's quote of the day  (GET /quote/daily?profile=tony&date=YYYY-MM-DD)
//
// One original, unattributed line per day for Everwell's Dashboard and Mindset
// (A1-Priv/docs/Everwell/plan.md, Phase 4). Generated at most ONCE per day and
// cached in KV, so a page opening a hundred times costs one AI call.
//
//   1. ORCA (Tony's own router, key TONY_ORCA_KEY): DeepSeek first, then the
//      other FREE accounts in turn (Tony, 2026-10-11: never Claude Pro or
//      Claude free, so never "ORCA's own pick" either, which could land on
//      them). Every routable ORCA model on Tony's profile is a signed-in BROWSER
//      account, which only answers while his PC bridge is up; ORCA then says
//      503 + Retry-After and we stop asking it at once rather than burn the
//      budget.
//   2. Gemini (TONY_GEMINI_KEY) through runModelChain, quality-first models.
//   3. Nothing: { ok:false, error:'unavailable' } and the page keeps its own
//      local line (EWCore.localQuote). Provider messages never leave the worker.
//
// Guard rails: profile 'tony' only; the date must be within a day of today
// (UTC), so the cache cannot be bypassed by asking for arbitrary dates; an
// older day than the cached one is never generated. KV: ONE write per day on
// TOKEN_CACHE (account 1's write budget, memory kv-write-budget).
// ════════════════════════════════════════════════════════════════════════════
const QUOTE_ORCA_URL = 'https://orca.vedapatel05.workers.dev/v1/chat/completions';
const QUOTE_ORCA_MODELS = ['deepseek/free', 'chatgpt/free', 'gemini_web/free', 'grok/free', 'copilot/free', 'perplexity/free'];
const QUOTE_ORCA_BUDGET_MS = 60000;                    // browser units are slow; one shared budget for every try
const QUOTE_ORCA_TRY_MS = 20000;                       // one hung unit must not eat the whole budget
const QUOTE_GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite'];
const QUOTE_KV_PREFIX = 'ew_quote:';
const QUOTE_RECENT = 30;
// Mindset, success and overcoming adversity only (Tony, 2026-10-16), in the
// voice of the quotes he keeps in his TaskHub (QUOTE_STYLE): short, punchy,
// about deciding who you become and pushing through hard things.
const QUOTE_THEMES = ['overcoming adversity', 'resilience after a setback', 'a growth mindset', 'confidence and self-belief',
  'discipline when motivation fades', 'success as a daily decision', 'outworking your talent', 'owning your choices',
  'the courage to start', 'mental toughness', 'turning failure into fuel', 'doubt versus action', 'evolving instead of repeating',
  'consistency over intensity', 'becoming who you decide to be', 'calm under pressure', 'small daily wins', 'keeping promises to yourself'];
// Tony's own TaskHub quotes: the TONE to aim for, never lines to reuse.
const QUOTE_STYLE = ['The mind is everything. What you think you become.',
  'I am not a product of my circumstances. I am a product of my decisions.',
  'Doubt kills more dreams than failure ever will.',
  'In life, you are offered two choices: evolve, or repeat.',
  'What you lack in talent, you make up for with desire, hustle, and giving 110% all the time.',
  "The future is built through today's mindset.",
  "Life isn't about finding yourself. Life is about creating yourself."];

function quoteDateOk(date, nowMs) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  const t = Date.parse(date + 'T00:00:00Z');
  if (isNaN(t)) return false;
  const today = Date.parse(new Date(nowMs).toISOString().slice(0, 10) + 'T00:00:00Z');
  return Math.abs(t - today) <= 86400000;   // device time zones put "today" within ±1 day of UTC
}
function quotePrompt(date, recent) {
  const day = Math.round(Date.parse(date + 'T00:00:00Z') / 86400000);
  const theme = QUOTE_THEMES[((day % QUOTE_THEMES.length) + QUOTE_THEMES.length) % QUOTE_THEMES.length];
  return [
    'Write ONE original quote of the day for Everwell, a personal app for growing in mind, health and faith.',
    'It is about MINDSET, SUCCESS and OVERCOMING ADVERSITY: how you think, the decisions that shape who you become, and pushing through hard things.',
    'Match the tone of these quotes the reader already loves (style only: do not copy, paraphrase or echo them):\n' + QUOTE_STYLE.map(r => '  * ' + r).join('\n'),
    `Today's theme: ${theme}.`,
    'Rules:',
    '- 6 to 22 words, one or two short, punchy sentences. A sharp contrast or turn of phrase is welcome.',
    '- Original wording. Never a famous or existing quote, never a paraphrase of one.',
    '- No author, no attribution, no quotation marks, no hashtags, no emoji.',
    '- Strong, direct and grounded, not sentimental or cheesy. No religion, diet or wellness talk.',
    recent.length ? '- Do not repeat or closely echo any of these recent lines:\n' + recent.slice(-QUOTE_RECENT).map(r => '  * ' + r).join('\n') : '',
    'Reply with JSON only: {"quote": "..."}',
  ].filter(Boolean).join('\n');
}
// The model's reply → one clean line, or null when it breaks a rule (the chain
// then tries the next source). Accepts bare JSON, JSON inside prose or a code
// fence, or a bare sentence.
function cleanQuote(raw, recent) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  let parsed = null;
  try { parsed = JSON.parse(s); } catch (e) {
    const m = s.match(/"quote"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) { try { parsed = { quote: JSON.parse('"' + m[1] + '"') }; } catch (e2) {} }
  }
  if (parsed && typeof parsed === 'object') s = typeof parsed.quote === 'string' ? parsed.quote : '';
  s = s.replace(/^```[a-z]*|```$/g, '').replace(/^[\s"“”'‘’]+|[\s"“”'‘’]+$/g, '').replace(/\s+/g, ' ').trim();
  if (s.length < 25 || s.length > 180) return null;
  if (/[\r\n]/.test(s)) return null;
  if (/[—–-]\s*[A-Z][\w.']*(?:\s+[A-Z][\w.']*)*\s*$/.test(s)) return null;      // "… — Some Name"
  if (/\b(once said|as .{1,30} said|according to)\b/i.test(s)) return null;
  if (/#|[\u{1F300}-\u{1FAFF}]/u.test(s)) return null;
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  if ((recent || []).concat(QUOTE_STYLE).some(r => norm(r) === norm(s))) return null;
  return s;
}
async function orcaQuote(env, prompt, recent) {
  if (!env.TONY_ORCA_KEY) return { ok: false, why: 'orca:no-key' };
  const deadline = Date.now() + QUOTE_ORCA_BUDGET_MS;
  let why = 'orca:no-usable-answer';
  for (const model of QUOTE_ORCA_MODELS) {
    const left = deadline - Date.now();
    if (left < 3000) { why = 'orca:budget-spent'; break; }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(left, QUOTE_ORCA_TRY_MS));
    let r;
    try {
      const body = { model, messages: [{ role: 'user', content: prompt }], max_tokens: 160, temperature: 0.9 };
      r = await fetch(QUOTE_ORCA_URL, { method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.TONY_ORCA_KEY }, body: JSON.stringify(body) });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') { why = 'orca:timeout-' + model; continue; }               // this unit hung; the next may answer
      return { ok: false, why: 'orca:network' };
    } finally { clearTimeout(timer); }
    if (r.status === 401 || r.status === 403) return { ok: false, why: 'orca:auth' };           // bad/rotated key: no point trying again
    // 503 (+Retry-After): nothing can serve right now (the PC bridge is away) —
    // true for every browser model, so stop. 404: THIS model cannot (disabled,
    // signed out) — the next free model may still answer.
    if (r.status === 503) return { ok: false, why: 'orca:unavailable', retryAfter: r.headers.get('Retry-After') };
    if (r.status === 404) { why = 'orca:no-backend-for-' + model; continue; }
    if (r.status === 429) return { ok: false, why: 'orca:rate-limited', retryAfter: r.headers.get('Retry-After') };
    if (!r.ok) { why = 'orca:' + r.status; continue; }                                             // e.g. 502 session expired → the next model
    let d = null;
    try { d = await r.json(); } catch (e) { why = 'orca:bad-envelope'; continue; }
    const text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    const q = cleanQuote(text, recent);
    if (q) return { ok: true, text: q, via: 'orca', model: (d && d.model) || model };
    why = 'orca:invalid-output';
  }
  return { ok: false, why };
}
async function geminiQuote(env, prompt, recent) {
  const key = env.TONY_GEMINI_KEY;
  if (!key) return { ok: false, why: 'gemini:no-key' };
  try {
    const r = await runModelChain(QUOTE_GEMINI_MODELS, key, {
      prompt, feature: 'quote', maxOutputTokens: 200, deadlineMs: 25000, timeoutMs: 12000,
      schema: { type: 'OBJECT', properties: { quote: { type: 'STRING' } }, required: ['quote'] },
      validate: (v) => !!cleanQuote(v && v.quote, recent),
    });
    const q = !r.soft && cleanQuote(r.value && r.value.quote, recent);
    return q ? { ok: true, text: q, via: 'gemini', model: r.model } : { ok: false, why: 'gemini:invalid-output' };
  } catch (e) { return { ok: false, why: 'gemini:failed' }; }
}
// ── kind=buddhist: Everwell's Prayer tab, a REAL Buddhist quote of the day ──
// Unlike the daily line, this one is a genuine teaching with its source
// ("Dhammapada, verse 5", "Thich Nhat Hanh"). Same chain (ORCA's free models,
// never Claude; then Gemini), its own KV key and recent list, one write a day.
// The prompt steers away from the many fake "Buddha quotes" that circulate.
const BQUOTE_KV_PREFIX = 'ew_bquote:';
function buddhistPrompt(date, recent) {
  return [
    'Give ONE genuine Buddhist quote for today (' + date + ') for a personal reflection app.',
    'Rules:',
    '- It must be REAL and verifiable: a verse from the Dhammapada or another sutta (in a standard English translation), or the published words of a well-known Buddhist teacher (e.g. Thich Nhat Hanh, Ajahn Chah, Shunryu Suzuki, Pema Chödrön, the Dalai Lama, Ajahn Brahm).',
    '- Never one of the popular misattributed "Buddha quotes". If unsure a line is authentic, pick a Dhammapada verse instead.',
    '- 10 to 60 words. Plain text, no hashtags, no emoji, no quotation marks around it.',
    '- "source" names where it comes from: "Dhammapada, verse 5", "Sutta Nipata 1.8", or the teacher\'s name.',
    recent.length ? '- Not any of these recent ones:\n' + recent.slice(-QUOTE_RECENT).map(r => '  * ' + r).join('\n') : '',
    'Reply with JSON only: {"quote": "...", "source": "..."}',
  ].filter(Boolean).join('\n');
}
function cleanBuddhist(raw, recent) {
  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim().replace(/^```[a-z]*\s*|\s*```$/g, '');
    try { v = JSON.parse(s); } catch (e) {
      const m = s.match(/\{[\s\S]*\}/);
      try { v = m ? JSON.parse(m[0]) : null; } catch (e2) { v = null; }
    }
  }
  if (!v || typeof v !== 'object') return null;
  const tidy = (x) => String(x == null ? '' : x).replace(/^[\s"“”'‘’]+|[\s"“”'‘’]+$/g, '').replace(/\s+/g, ' ').trim();
  const quote = tidy(v.quote), source = tidy(v.source).replace(/^[—–-]\s*/, '');
  if (quote.length < 20 || quote.length > 400) return null;
  if (source.length < 2 || source.length > 80) return null;
  if (/#|[\u{1F300}-\u{1FAFF}]/u.test(quote + source)) return null;
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  if ((recent || []).some(r => norm(r) === norm(quote))) return null;
  return { quote, source };
}
async function buddhistChain(env, prompt, recent) {
  const why = [];
  if (env.TONY_ORCA_KEY) {
    const deadline = Date.now() + QUOTE_ORCA_BUDGET_MS;
    for (const model of QUOTE_ORCA_MODELS) {
      const left = deadline - Date.now();
      if (left < 3000) { why.push('orca:budget-spent'); break; }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), Math.min(left, QUOTE_ORCA_TRY_MS));
      let r;
      try {
        r = await fetch(QUOTE_ORCA_URL, { method: 'POST', signal: ac.signal,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.TONY_ORCA_KEY },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 300, temperature: 0.8 }) });
      } catch (e) {
        clearTimeout(timer);
        if (e && e.name === 'AbortError') { why.push('orca:timeout-' + model); continue; }
        why.push('orca:network'); break;
      } finally { clearTimeout(timer); }
      if (r.status === 401 || r.status === 403 || r.status === 503 || r.status === 429) { why.push('orca:' + r.status); break; }
      if (!r.ok) { why.push('orca:' + r.status + '-' + model); continue; }
      let d = null; try { d = await r.json(); } catch (e) { why.push('orca:bad-envelope'); continue; }
      const q = cleanBuddhist(d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content, recent);
      if (q) return { ok: true, ...q, via: 'orca', model: (d && d.model) || model, why };
      why.push('orca:invalid-output');
    }
  } else why.push('orca:no-key');
  if (env.TONY_GEMINI_KEY) {
    try {
      const r = await runModelChain(QUOTE_GEMINI_MODELS, env.TONY_GEMINI_KEY, {
        prompt, feature: 'quote', maxOutputTokens: 400, deadlineMs: 25000, timeoutMs: 12000,
        schema: { type: 'OBJECT', properties: { quote: { type: 'STRING' }, source: { type: 'STRING' } }, required: ['quote', 'source'] },
        validate: (v) => !!cleanBuddhist(v, recent),
      });
      const q = !r.soft && cleanBuddhist(r.value, recent);
      if (q) return { ok: true, ...q, via: 'gemini', model: r.model, why };
      why.push('gemini:invalid-output');
    } catch (e) { why.push('gemini:failed'); }
  } else why.push('gemini:no-key');
  return { ok: false, why };
}
async function handleBuddhistQuote(profile, date, env) {
  const kvKey = BQUOTE_KV_PREFIX + profile;
  let st = null;
  try { st = env.TOKEN_CACHE ? await env.TOKEN_CACHE.get(kvKey, 'json') : null; } catch (e) {}
  if (st && st.date === date && st.text) return json({ ok: true, kind: 'buddhist', date, quote: st.text, cite: st.cite, source: st.via, cached: true });
  if (st && st.date > date) return json({ ok: false, error: 'unavailable' });
  const recent = (st && Array.isArray(st.recent)) ? st.recent : [];
  const res = await buddhistChain(env, buddhistPrompt(date, recent), recent);
  if (!res.ok) { console.warn('[bquote] no source answered: ' + res.why.join(' | ')); return json({ ok: false, error: 'unavailable' }); }
  const next = { date, text: res.quote, cite: res.source, via: res.via, model: res.model, at: Date.now(), recent: recent.concat([res.quote]).slice(-QUOTE_RECENT) };
  try { if (env.TOKEN_CACHE) await env.TOKEN_CACHE.put(kvKey, JSON.stringify(next)); } catch (e) { console.warn('[bquote] KV write failed'); }
  return json({ ok: true, kind: 'buddhist', date, quote: res.quote, cite: res.source, source: res.via });
}
async function handleQuote(url, env) {
  const profile = url.searchParams.get('profile');
  const date = url.searchParams.get('date') || '';
  if (profile !== 'tony') return json({ ok: false, error: 'unsupported profile' }, 400);
  if (!quoteDateOk(date, Date.now())) return json({ ok: false, error: 'bad date' }, 400);
  const kind = url.searchParams.get('kind') || 'daily';
  if (kind === 'buddhist') return handleBuddhistQuote(profile, date, env);
  if (kind !== 'daily') return json({ ok: false, error: 'unknown kind' }, 400);
  const kvKey = QUOTE_KV_PREFIX + profile;
  let st = null;
  try { st = env.TOKEN_CACHE ? await env.TOKEN_CACHE.get(kvKey, 'json') : null; } catch (e) {}
  if (st && st.date === date && st.text) return json({ ok: true, date, quote: st.text, source: st.via, cached: true });
  if (st && st.date > date) return json({ ok: false, error: 'unavailable' });       // a past day: never generated afresh
  const recent = (st && Array.isArray(st.recent)) ? st.recent : [];
  const prompt = quotePrompt(date, recent);
  const why = [];
  let res = await orcaQuote(env, prompt, recent);
  if (!res.ok) { why.push(res.why); const g = await geminiQuote(env, prompt, recent); if (g.ok) res = g; else why.push(g.why); }
  if (!res.ok) { console.warn('[quote] no source answered: ' + why.join(' | ')); return json({ ok: false, error: 'unavailable' }); }
  if (why.length) console.log('[quote] ' + res.via + ' after: ' + why.join(' | '));
  const next = { date, text: res.text, via: res.via, model: res.model, at: Date.now(), recent: recent.concat([res.text]).slice(-QUOTE_RECENT) };
  try { if (env.TOKEN_CACHE) await env.TOKEN_CACHE.put(kvKey, JSON.stringify(next)); } catch (e) { console.warn('[quote] KV write failed'); }
  return json({ ok: true, date, quote: res.text, source: res.via });
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURE — Everwell's nutrition plan  (POST /fuel/plan)
//
// One person's stats, their training (Everwell's rotation, routines, circuits
// and how often a workout was actually ticked) and up to three photos → daily
// calories, macros, meals and water (A1-Priv/docs/Everwell/plan.md, refinement
// round 5). Asked only when the person presses Re-run, or the first time a
// profile has the stats it needs: nothing is cached and nothing goes to KV.
//
//   1. ORCA (TONY_ORCA_KEY), FREE models only, never Claude and never ORCA's
//      own pick. With photos, the units that can SEE them go first (ChatGPT,
//      then Gemini's web app; DeepSeek cannot read images), then the text
//      chain DeepSeek-first without the photos.
//   2. Gemini (TONY_GEMINI_KEY), the photos sent inline.
//   3. Nothing: { ok:false, error:'unavailable' }; the page keeps its last plan.
//
// Every answer is checked before it is returned: numbers in range, the macros
// adding up to the calories (±12%), and the calories within ±40% of a
// Mifflin–St Jeor estimate made here. A plan that fails goes to the next model.
// Profile 'tony' only (his keys pay for it).
// ════════════════════════════════════════════════════════════════════════════
const FUEL_ORCA_TEXT = QUOTE_ORCA_MODELS;
const FUEL_ORCA_VISION = ['chatgpt/free', 'gemini_web/free'];
const FUEL_ORCA_BUDGET_MS = 100000;                     // long prompts and photos: browser units are slower here
const FUEL_ORCA_TRY_MS = 45000;
const FUEL_GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite'];
const FUEL_GOALS = ['lose', 'maintain', 'gain', 'recomp'];
const FUEL_DAY = { desk: 1.2, feet: 1.35, active: 1.5 };
const FUEL_LEVELS = ['sedentary', 'light', 'moderate', 'active', 'very active'];
const FUEL_MAX_PHOTOS = 3;
const FUEL_MAX_PHOTO_CHARS = 1600000;                   // a 1024px JPEG is ~150-300 KB of base64

const fuelNum = (v, lo, hi) => { const n = Number(v); return isFinite(n) && n >= lo && n <= hi ? n : null; };
const fuelStr = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// The request, cleaned: only known fields, every number in range, text capped.
export function fuelInput(body) {
  const p = (body && body.person) || {}, s = p.stats || p, t = (body && body.training) || {};
  const stats = {
    sex: s.sex === 'female' ? 'female' : s.sex === 'male' ? 'male' : null,
    age: fuelNum(s.age, 13, 100),
    heightIn: fuelNum(s.heightIn, 48, 96),
    weightLb: fuelNum(s.weightLb, 70, 700),
    bodyFat: fuelNum(s.bodyFat, 3, 60),
    goal: FUEL_GOALS.includes(s.goal) ? s.goal : 'maintain',
    targetLb: fuelNum(s.targetLb, 70, 700),
    dayActivity: FUEL_DAY[s.dayActivity] ? s.dayActivity : 'desk',
    diet: fuelStr(s.diet, 300),
  };
  if (!stats.sex || stats.age == null || stats.heightIn == null || stats.weightLb == null) return null;
  const list = (a, n) => (Array.isArray(a) ? a : []).slice(0, n);
  const training = {
    perWeek: fuelNum(t.perWeek, 0, 14) || 0,
    minutes: fuelNum(t.minutes, 0, 300) || 0,
    kind: fuelStr(t.kind, 80),
    splits: list(t.splits, 10).map((x) => fuelStr(x, 40)).filter(Boolean),
    routines: list(t.routines, 8).map((r) => ({ name: fuelStr(r && r.name, 40), lines: list(r && r.lines, 8).map((x) => fuelStr(x, 80)).filter(Boolean) })).filter((r) => r.name),
    circuits: list(t.circuits, 8).map((c) => ({ name: fuelStr(c && c.name, 40), minutes: fuelNum(c && c.minutes, 0, 300) || 0 })).filter((c) => c.name),
    done: t.done21 ? { done: fuelNum(t.done21.done, 0, 21) || 0, planned: fuelNum(t.done21.planned, 0, 21) || 0 } : null,
  };
  const photos = list(body && body.photos, 12).map((u) => {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(u || ''));
    return m && u.length <= FUEL_MAX_PHOTO_CHARS ? { url: u, mimeType: m[1], data: m[2] } : null;
  }).filter(Boolean).slice(0, FUEL_MAX_PHOTOS);
  return { name: fuelStr(p.name, 40), notes: fuelStr(p.notes, 1000), stats, training, photos };
}

// Mifflin–St Jeor, an activity factor from the day job plus training hours,
// and the goal's adjustment: the yardstick an AI answer has to land near.
export function fuelEstimate(stats, training) {
  const kg = stats.weightLb * 0.45359237, cm = stats.heightIn * 2.54;
  const bmr = 10 * kg + 6.25 * cm - 5 * stats.age + (stats.sex === 'male' ? 5 : -161);
  const hours = (training.perWeek || 0) * (training.minutes || 0) / 60;
  const factor = FUEL_DAY[stats.dayActivity] + Math.min(0.4, hours * 0.035);
  const tdee = bmr * factor;
  const adj = { lose: 0.82, maintain: 1, gain: 1.1, recomp: 0.95 }[stats.goal];
  return { bmr: Math.round(bmr), tdee: Math.round(tdee), target: Math.round(tdee * adj), factor: Math.round(factor * 100) / 100 };
}

export function fuelPrompt(inp, est) {
  const s = inp.stats, t = inp.training;
  const ft = Math.floor(s.heightIn / 12), inch = Math.round(s.heightIn - ft * 12);
  const lines = [
    'You are a sports nutritionist. Recommend ONE person\'s daily nutrition from the facts below.',
    '',
    'Person:',
    `- ${s.sex}, ${s.age} years, ${ft} ft ${inch} in, ${s.weightLb} lb` + (s.bodyFat != null ? `, about ${s.bodyFat}% body fat` : ''),
    `- Goal: ${{ lose: 'lose fat', maintain: 'maintain weight', gain: 'gain muscle', recomp: 'lose fat and build muscle (recomposition)' }[s.goal]}` + (s.targetLb ? `, target ${s.targetLb} lb` : ''),
    `- Day job / daily movement: ${{ desk: 'mostly sitting', feet: 'on their feet much of the day', active: 'physically active work' }[s.dayActivity]}`,
    s.diet ? `- Diet notes: ${s.diet}` : '',
    '',
    'Training:',
    `- About ${t.perWeek} workouts a week` + (t.minutes ? `, ${t.minutes} minutes each` : '') + (t.kind ? ` (${t.kind})` : ''),
    t.splits.length ? `- Rotation: ${t.splits.join(', ')}` : '',
    ...t.routines.map((r) => `- Routine "${r.name}": ${r.lines.join('; ')}`),
    ...t.circuits.map((c) => `- Circuit "${c.name}": ${c.minutes} min`),
    t.done ? `- Last 3 weeks: ${t.done.done} of ${t.done.planned} planned workouts done` : '',
    '',
    inp.notes ? 'In their own words (weigh this: it may say how long they have trained, injuries, schedule or what has worked):' : '',
    inp.notes ? '"' + inp.notes.replace(/"/g, "'") + '"' : '',
    '',
    `For reference, a Mifflin-St Jeor estimate puts maintenance near ${est.tdee} kcal/day. Use your judgement; stay realistic.`,
    inp.photos.length ? `${inp.photos.length} photo(s) of this person are attached. Use them ONLY to judge build and body composition. Never describe or comment on their appearance.` : '',
    '',
    'Rules:',
    '- protein*4 + carbs*4 + fat*9 must equal the calories (within 5%).',
    '- water in US fluid ounces for the whole day, training included.',
    '- meals: how many meals a day suit this person (2 to 6), with a short name for each in order (e.g. Breakfast, Lunch, Dinner, Snack).',
    '- notes: at most 3 short, specific tips (under 15 words each), no fluff.',
    `- activity: one of ${FUEL_LEVELS.join(', ')}.`,
    '',
    'Reply with JSON only, no prose:',
    '{"calories": 0, "protein": 0, "carbs": 0, "fat": 0, "fiber": 0, "waterOz": 0, "meals": 3, "mealNames": ["Breakfast", "Lunch", "Dinner"], "activity": "moderate", "notes": ["..."]}',
  ];
  return lines.filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i > 0)).join('\n');
}

// An answer → a clean plan, or null (the next model is asked).
export function fuelPlan(raw, inp, est) {
  let v = raw;
  if (typeof v === 'string') {
    const s = v.replace(/```(?:json)?/gi, '');
    try { v = JSON.parse(s); } catch (e) {
      const a = s.indexOf('{'), b = s.lastIndexOf('}');
      if (a < 0 || b <= a) return null;
      try { v = JSON.parse(s.slice(a, b + 1)); } catch (e2) { return null; }
    }
  }
  if (!v || typeof v !== 'object') return null;
  const cal = fuelNum(v.calories, 1000, 7000), p = fuelNum(v.protein, 30, 500), c = fuelNum(v.carbs, 20, 900), f = fuelNum(v.fat, 15, 350);
  if (cal == null || p == null || c == null || f == null) return null;
  if (Math.abs(p * 4 + c * 4 + f * 9 - cal) > cal * 0.12) return null;                 // the macros must add up
  if (Math.abs(cal - est.target) > est.target * 0.4) return null;                      // far from any sane estimate
  const water = fuelNum(v.waterOz, 40, 260);
  if (water == null) return null;
  const meals = Math.round(fuelNum(v.meals, 2, 6) || 3);
  const DEF = { 2: ['Lunch', 'Dinner'], 3: ['Breakfast', 'Lunch', 'Dinner'], 4: ['Breakfast', 'Lunch', 'Snack', 'Dinner'], 5: ['Breakfast', 'Snack', 'Lunch', 'Snack', 'Dinner'], 6: ['Breakfast', 'Snack', 'Lunch', 'Snack', 'Dinner', 'Snack'] };
  let names = (Array.isArray(v.mealNames) ? v.mealNames : []).map((x) => fuelStr(x, 24).replace(/[*_#`]/g, '')).filter(Boolean);
  if (names.length !== meals) names = DEF[meals];
  const notes = (Array.isArray(v.notes) ? v.notes : []).map((x) => fuelStr(x, 140).replace(/^[-*\d.)\s]+/, '').replace(/[*_#`]/g, '')).filter(Boolean).slice(0, 3);
  const act = FUEL_LEVELS.includes(String(v.activity || '').toLowerCase()) ? String(v.activity).toLowerCase() : null;
  return {
    calories: Math.round(cal / 10) * 10, protein: Math.round(p), carbs: Math.round(c), fat: Math.round(f),
    fiber: Math.round(fuelNum(v.fiber, 10, 90) || Math.max(25, Math.round(cal / 1000 * 14))),
    waterOz: Math.round(water), meals, mealNames: names, activity: act || 'moderate', notes,
  };
}

async function orcaFuel(env, models, prompt, photos, inp, est, deadline) {
  let why = 'orca:no-usable-answer';
  for (const model of models) {
    const left = deadline - Date.now();
    if (left < 5000) return { ok: false, why: 'orca:budget-spent' };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(left, FUEL_ORCA_TRY_MS));
    const content = photos.length ? [{ type: 'text', text: prompt }].concat(photos.map((ph) => ({ type: 'image_url', image_url: { url: ph.url } }))) : prompt;
    let r;
    try {
      r = await fetch(QUOTE_ORCA_URL, { method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.TONY_ORCA_KEY },
        body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: 700, temperature: 0.3 }) });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') { why = 'orca:timeout-' + model; continue; }
      return { ok: false, why: 'orca:network', stop: true };
    } finally { clearTimeout(timer); }
    if (r.status === 401 || r.status === 403) return { ok: false, why: 'orca:auth', stop: true };
    if (r.status === 503) return { ok: false, why: 'orca:unavailable', stop: true };   // the PC bridge is away: every browser unit is
    if (r.status === 429) return { ok: false, why: 'orca:rate-limited', stop: true };
    if (r.status === 404) { why = 'orca:no-backend-for-' + model; continue; }
    if (!r.ok) { why = 'orca:' + r.status; continue; }
    let d = null;
    try { d = await r.json(); } catch (e) { why = 'orca:bad-envelope'; continue; }
    const text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    const plan = fuelPlan(text, inp, est);
    if (plan) return { ok: true, plan, via: 'orca', model: (d && d.model) || model, sawPhotos: photos.length > 0 };
    why = 'orca:invalid-output-' + model;
  }
  return { ok: false, why };
}

const FUEL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    calories: { type: 'NUMBER' }, protein: { type: 'NUMBER' }, carbs: { type: 'NUMBER' }, fat: { type: 'NUMBER' }, fiber: { type: 'NUMBER' },
    waterOz: { type: 'NUMBER' }, meals: { type: 'NUMBER' }, mealNames: { type: 'ARRAY', items: { type: 'STRING' } },
    activity: { type: 'STRING' }, notes: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['calories', 'protein', 'carbs', 'fat', 'waterOz', 'meals', 'mealNames', 'notes'],
};

async function handleFuel(body, env) {
  if (!body || body.profile !== 'tony') return json({ ok: false, error: 'unsupported profile' }, 400);
  const inp = fuelInput(body);
  if (!inp) return json({ ok: false, error: 'missing stats' }, 400);
  const est = fuelEstimate(inp.stats, inp.training);
  const prompt = fuelPrompt(inp, est);
  const why = [];
  let res = null;
  if (env.TONY_ORCA_KEY) {
    const deadline = Date.now() + FUEL_ORCA_BUDGET_MS;
    if (inp.photos.length) {
      const v = await orcaFuel(env, FUEL_ORCA_VISION, prompt, inp.photos, inp, est, deadline);
      if (v.ok) res = v; else { why.push(v.why); if (v.stop) res = false; }
    }
    if (res === null) {
      const textPrompt = inp.photos.length ? fuelPrompt(Object.assign({}, inp, { photos: [] }), est) : prompt;
      const t = await orcaFuel(env, FUEL_ORCA_TEXT.filter((m) => !(inp.photos.length && FUEL_ORCA_VISION.includes(m))), textPrompt, [], inp, est, deadline);
      if (t.ok) res = t; else why.push(t.why);
    }
  } else why.push('orca:no-key');
  if (!res && env.TONY_GEMINI_KEY) {
    try {
      const g = await runModelChain(FUEL_GEMINI_MODELS, env.TONY_GEMINI_KEY, {
        prompt, feature: 'fuel', maxOutputTokens: 900, deadlineMs: 40000, timeoutMs: 20000, schema: FUEL_SCHEMA,
        images: inp.photos.map((ph) => ({ mimeType: ph.mimeType, data: ph.data })),
        validate: (v) => !!fuelPlan(v, inp, est),
      });
      const plan = !g.soft && fuelPlan(g.value, inp, est);
      if (plan) res = { ok: true, plan, via: 'gemini', model: g.model, sawPhotos: inp.photos.length > 0 };
      else why.push('gemini:invalid-output');
    } catch (e) { why.push('gemini:failed'); }
  } else if (!res) why.push('gemini:no-key');
  if (!res) { console.warn('[fuel] no source answered: ' + why.join(' | ')); return json({ ok: false, error: 'unavailable' }, 503); }
  if (why.length) console.log('[fuel] ' + res.via + ' after: ' + why.join(' | '));
  return json({ ok: true, plan: res.plan, via: res.via, model: res.model, sawPhotos: res.sawPhotos, estimate: est });
}

// ── YouTube playlist contents (Everwell's "Expand", A1-Priv/everwell.html) ──
// GET /yt/playlist?list=<id> → { ok, list, title, videos: [{ id, title }], more }
// No API key: the public playlist page (ytInitialData) gives the first 100,
// then YouTube's own browse continuation gives 100 a page, up to YT_MAX.
// Videos are "lockupViewModel" entries since 2025 ("playlistVideoRenderer"
// before; both are read). Answers sit in the edge cache for 10 minutes (Everwell
// re-syncs expanded playlists, so a change on YouTube shows soon); nothing
// goes to KV (its writes are the daily limit). Mixes (RD…) and private lists
// have no playlist page: { ok: false, error: 'unavailable' }. &fresh=1 (the
// playlist's Refresh button) skips the cached answer and stores the new one.
const YT_MAX = 500;
const YT_CACHE_S = 600;
const YT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export function ytInitialData(h) {
  const tag = 'var ytInitialData = ', i = h.indexOf(tag); if (i < 0) return null;
  const s = i + tag.length, e = h.indexOf(';</script>', s); if (e < 0) return null;
  try { return JSON.parse(h.slice(s, e)); } catch (x) { return null; }
}
export function ytWalk(o, out) {
  if (!o || typeof o !== 'object') return out;
  if (Array.isArray(o)) { for (const x of o) ytWalk(x, out); return out; }
  const l = o.lockupViewModel;
  if (l && l.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && /^[A-Za-z0-9_-]{11}$/.test(l.contentId || '')) {
    const md = l.metadata && l.metadata.lockupMetadataViewModel;
    out.videos.push({ id: l.contentId, title: String((md && md.title && md.title.content) || '').slice(0, 120) });
    return out;
  }
  const p = o.playlistVideoRenderer;
  if (p && /^[A-Za-z0-9_-]{11}$/.test(p.videoId || '')) {
    const t = p.title ? (p.title.simpleText || (p.title.runs || []).map((r) => r.text).join('')) : '';
    out.videos.push({ id: p.videoId, title: String(t || '').slice(0, 120) });
    return out;
  }
  if (o.continuationCommand && o.continuationCommand.token) out.next = o.continuationCommand.token;
  for (const k in o) ytWalk(o[k], out);
  return out;
}
async function handleYtPlaylist(url, ctx) {
  const list = url.searchParams.get('list') || '';
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(list)) return json({ ok: false, error: 'bad list' }, 400);
  const cache = caches.default, ckey = new Request('https://personal-ai.cache/yt/playlist?list=' + list);
  const hit = url.searchParams.get('fresh') === '1' ? null : await cache.match(ckey);
  if (hit) return new Response(hit.body, { headers: { 'Content-Type': 'application/json', ...cors() } });
  let page;
  try {
    const r = await fetch('https://www.youtube.com/playlist?list=' + encodeURIComponent(list) + '&hl=en', { headers: { 'User-Agent': YT_UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'SOCS=CAI; CONSENT=YES+1' } });
    if (!r.ok) return json({ ok: false, error: 'unavailable' });
    page = await r.text();
  } catch (e) { return json({ ok: false, error: 'unreachable' }); }
  const d = ytInitialData(page);
  const out = ytWalk(d && d.contents, { videos: [], next: null });
  if (!d || !out.videos.length) return json({ ok: false, error: 'unavailable' });
  const md = d.metadata && d.metadata.playlistMetadataRenderer;
  const key = (page.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1], ver = (page.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1];
  while (out.next && out.videos.length < YT_MAX && ver) {
    const token = out.next; out.next = null;
    try {
      const r = await fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false' + (key ? '&key=' + key : ''), {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': YT_UA },
        body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: ver, hl: 'en' } }, continuation: token }) });
      if (!r.ok) break;
      const j = await r.json(); const before = out.videos.length;
      ytWalk(j.onResponseReceivedActions, out);
      if (out.videos.length === before) break;
    } catch (e) { break; }
  }
  const seen = new Set(), videos = out.videos.filter((v) => !seen.has(v.id) && seen.add(v.id)).slice(0, YT_MAX);
  const body = JSON.stringify({ ok: true, list, title: String((md && md.title) || '').slice(0, 120), videos, more: !!out.next || out.videos.length > YT_MAX });
  if (ctx) ctx.waitUntil(cache.put(ckey, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + YT_CACHE_S } })));
  return new Response(body, { headers: { 'Content-Type': 'application/json', ...cors() } });
}

// ── Instagram post/reel media (Everwell's reel player, A1-Priv/everwell.html) ──
// GET /ig/media?code=<shortcode> → { ok, code, user, caption, items: [{ type:
// 'video'|'image', src, poster?, w, h, dur? }] }
// No login: Instagram's public EMBED page (what an <iframe> of
// /p/<code>/embed/captioned/ gets) carries the post as contextJSON ->
// gql_data.shortcode_media for reels/videos/carousels, and as an
// <img class="EmbeddedMediaImage"> for a plain photo. It only does so for a
// request that looks like an iframe load (Sec-Fetch-Dest: iframe); a plain
// GET gets an empty shell. The CDN files themselves answer CORP cross-origin
// with ACAO *, so Everwell plays them in its own <video> (checked 2026-10-12).
// The CDN links are signed and expire (oe=), so they are never stored: the
// page asks again each time, and answers sit in the edge cache for IG_CACHE_S.
// A private, deleted or unreadable post → { ok: false, error }, and the page
// falls back to Instagram's own embed.
const IG_CACHE_S = 3600;
const IG_CDN = /^https:\/\/[a-z0-9.-]+\.(cdninstagram\.com|fbcdn\.net)\//;
export function igContext(h) {
  const m = String(h || '').match(/"contextJSON":("(?:[^"\\]|\\.)*")/); if (!m) return null;
  try { const s = JSON.parse(m[1]); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}
const igUnent = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#064;/g, '@').replace(/&quot;/g, '"').replace(/&#x2F;|&#47;/g, '/').replace(/&#039;|&#39;/g, "'");
export function igMedia(h, code) {
  const out = { code, user: '', caption: '', items: [] };
  const c = igContext(h), sm = c && c.gql_data && c.gql_data.shortcode_media;
  const cdn = (u) => (IG_CDN.test(u || '') ? u : '');
  const one = (n) => {
    if (!n) return null;
    const d = n.dimensions || {}, w = Number(d.width) || 0, ht = Number(d.height) || 0;
    if (n.is_video && cdn(n.video_url)) return { type: 'video', src: n.video_url, poster: cdn(n.display_url), w, h: ht, dur: Number(n.video_duration) || 0 };
    if (cdn(n.display_url)) return { type: 'image', src: n.display_url, w, h: ht };
    return null;
  };
  if (sm) {
    out.user = String((sm.owner && sm.owner.username) || '').slice(0, 60);
    const ce = sm.edge_media_to_caption && sm.edge_media_to_caption.edges, cn = ce && ce[0] && ce[0].node;
    out.caption = String((cn && cn.text) || '').slice(0, 800);
    const kids = sm.edge_sidecar_to_children && sm.edge_sidecar_to_children.edges;
    const nodes = kids && kids.length ? kids.map((e) => e && e.node) : [sm];
    out.items = nodes.map(one).filter(Boolean);
    // Since ~2026-10 the logged-out embed leaves video_url out (a reel is only
    // its cover): say so, so the page plays the sync's link or IG's player.
    if (nodes.some((n) => n && n.is_video && !cdn(n.video_url))) out.noVideo = true;
  }
  if (!out.items.length) {
    // A plain photo: the embed draws it as EmbeddedMediaImage (srcset → largest).
    const tag = (String(h || '').match(/<img[^>]*class="[^"]*EmbeddedMediaImage[^"]*"[^>]*>/) || [])[0] || '';
    const set = (tag.match(/srcset="([^"]+)"/) || [])[1];
    let best = '', bw = 0;
    if (set) igUnent(set).split(/,\s*(?=https:)/).forEach((p) => { const m = p.trim().match(/^(\S+)\s+(\d+)w$/); if (m && +m[2] > bw && cdn(m[1])) { best = m[1]; bw = +m[2]; } });
    const src = best || cdn(igUnent((tag.match(/src="([^"]+)"/) || [])[1]));
    if (src) out.items.push({ type: 'image', src, w: bw || 0, h: 0 });
    if (!out.user) out.user = ((igUnent(tag).match(/shared by @([A-Za-z0-9._]{1,30})/) || [])[1] || '');
  }
  return out;
}
async function handleIgMedia(url, ctx) {
  const code = url.searchParams.get('code') || '';
  if (!/^[A-Za-z0-9_-]{5,40}$/.test(code)) return json({ ok: false, error: 'bad code' }, 400);
  const cache = caches.default, ckey = new Request('https://personal-ai.cache/ig/media?code=' + code);
  const hit = url.searchParams.get('fresh') === '1' ? null : await cache.match(ckey);
  if (hit) return new Response(hit.body, { headers: { 'Content-Type': 'application/json', ...cors() } });
  let page;
  try {
    const r = await fetch('https://www.instagram.com/p/' + code + '/embed/captioned/', { headers: {
      'User-Agent': YT_UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'cross-site', Referer: 'https://a1-priv.av1.workers.dev/' } });
    if (!r.ok) return json({ ok: false, error: r.status === 404 ? 'gone' : 'unavailable' });
    page = await r.text();
  } catch (e) { return json({ ok: false, error: 'unreachable' }); }
  const m = igMedia(page, code);
  if (!m.items.length) return json({ ok: false, error: 'unavailable' });
  const body = JSON.stringify({ ok: true, ...m });
  if (ctx) ctx.waitUntil(cache.put(ckey, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + IG_CACHE_S } })));
  return new Response(body, { headers: { 'Content-Type': 'application/json', ...cors() } });
}

// GET /ig/thumb?code=<shortcode> → the post's cover, as image bytes.
// instagram.com/p/<code>/media/?size=m redirects (server side only) to a cover
// on the CDN, but THAT file answers `cross-origin-resource-policy: same-origin`,
// so no other site's <img> may show it (seen 2026-10-12: every cover blank).
// The worker fetches the bytes itself and passes them on with CORP
// cross-origin. Falls back to the embed's poster. Edge-cached IG_THUMB_S.
const IG_THUMB_S = 21600;
// Fetch an Instagram CDN file and hand it on so any page may use it: an <img>,
// or a <video> (Range passes through, so it can seek). Images are cached.
async function igRelay(target, req, ctx, ckey) {
  const range = req && req.headers.get('Range');
  const r = await fetch(target, { headers: { 'User-Agent': YT_UA, ...(range ? { Range: range } : {}) } });
  const h = new Headers({ ...cors(), 'Cross-Origin-Resource-Policy': 'cross-origin', 'Accept-Ranges': 'bytes' });
  ['Content-Type', 'Content-Length', 'Content-Range'].forEach((k) => { const v = r.headers.get(k); if (v) h.set(k, v); });
  const img = /^image\//.test(r.headers.get('Content-Type') || '');
  h.set('Cache-Control', r.ok && img ? 'max-age=' + IG_THUMB_S : 'no-store');
  const res = new Response(r.body, { status: r.status, headers: h });
  if (ctx && ckey && r.status === 200 && img) ctx.waitUntil(cache_put(ckey, res.clone()));
  return res;
}
const cache_put = (k, r) => caches.default.put(k, r).catch(() => {});
async function handleIgThumb(url, req, ctx) {
  const code = url.searchParams.get('code') || '', size = url.searchParams.get('size') === 'l' ? 'l' : 'm';
  if (!/^[A-Za-z0-9_-]{5,40}$/.test(code)) return json({ ok: false, error: 'bad code' }, 400);
  const ckey = new Request('https://personal-ai.cache/ig/thumb2?code=' + code + '&size=' + size);
  const hit = await caches.default.match(ckey); if (hit) return hit;
  let to = '';
  try {
    const r = await fetch('https://www.instagram.com/p/' + code + '/media/?size=' + size, { redirect: 'manual', headers: { 'User-Agent': YT_UA } });
    const loc = r.headers.get('Location') || '';
    if (r.status >= 300 && r.status < 400 && IG_CDN.test(loc)) to = loc;
  } catch (e) {}
  if (!to) {
    const m = await handleIgMedia(new URL('https://x/ig/media?code=' + code), ctx).then((r) => r.json()).catch(() => null);
    const it = m && m.ok && m.items[0];
    to = it ? (it.type === 'video' ? it.poster : it.src) || '' : '';
  }
  if (!to) return new Response('not found', { status: 404, headers: { ...cors(), 'Cache-Control': 'max-age=600' } });
  try { return await igRelay(to, null, ctx, ckey); } catch (e) { return new Response('unreachable', { status: 502, headers: cors() }); }
}
// GET /ig/px?u=<an Instagram CDN link> → that file, usable by any page.
// For posts whose owner turned embedding off: no logged-out route reads them,
// so the "Everwell sync" bookmarklet brings their CDN links back from Tony's
// signed-in tab, and they play through here. Only Instagram's CDN hosts.
async function handleIgPx(url, req, ctx) {
  const u = url.searchParams.get('u') || '';
  if (!IG_CDN.test(u) || u.length > 2000) return json({ ok: false, error: 'bad link' }, 400);
  const ckey = new Request('https://personal-ai.cache/ig/px?u=' + encodeURIComponent(u));
  if (!req.headers.get('Range')) { const hit = await caches.default.match(ckey); if (hit) return hit; }
  try { return await igRelay(u, req, ctx, ckey); } catch (e) { return new Response('unreachable', { status: 502, headers: cors() }); }
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' || path === '/health') {
      return json({
        ok: true,
        service: 'personal-ai',
        version: 46, // bump when verifying a deploy went live
        features: ['list', 'recipe', 'taskhub', 'taskprep', 'journal', 'refine', 'watch', 'watch-ingest', 'quote', 'quote-buddhist', 'fuel', 'yt-playlist', 'ig-media', 'ig-thumb', 'ig-px', 'link-preview', 'link-parse'],
        quoteModels: { orca: QUOTE_ORCA_MODELS, gemini: QUOTE_GEMINI_MODELS },
        fuelModels: { orcaVision: FUEL_ORCA_VISION, orca: FUEL_ORCA_TEXT, gemini: FUEL_GEMINI_MODELS },
        orcaKey: !!env.TONY_ORCA_KEY,
        models: MODELS,
        refineModels: REFINE_MODELS,
        workersAi: !!env.AI,
        listModels: LIST_MODELS,
        listDictationModels: LIST_DICTATION_MODELS,
        listLinkModels: LIST_LINK_MODELS,
        recipeEditModels: RECIPE_EDIT_MODELS,
        recipeVoiceModels: RECIPE_VOICE_MODELS,
        taskhubModels: TASKHUB_MODELS,
        watchAiModels: WATCH_AI_MODELS,
        tonyKey: !!env.TONY_GEMINI_KEY,
        vedaKey: !!env.VEDA_GEMINI_KEY,
        firestore: !!(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY),
        krogerConfigured: !!(env.KROGER_CLIENT_ID && env.KROGER_CLIENT_SECRET),
        krogerLocations: {
          tony:  { kingsoopers: !!env.KINGSOOPERS_LOCATION_ID_TONY, kroger: !!env.KROGER_LOCATION_ID_TONY },
          veda:  { kingsoopers: !!env.KINGSOOPERS_LOCATION_ID_VEDA, kroger: !!env.KROGER_LOCATION_ID_VEDA },
        },
        time: new Date().toISOString(),
      });
    }

    if (req.method === 'GET' && path === '/quote/daily') return handleQuote(url, env);
    if (req.method === 'GET' && path === '/yt/playlist') return handleYtPlaylist(url, ctx);
    if (req.method === 'GET' && path === '/ig/media') return handleIgMedia(url, ctx);
    if (req.method === 'GET' && path === '/ig/thumb') return handleIgThumb(url, req, ctx);
    if (req.method === 'GET' && path === '/ig/px') return handleIgPx(url, req, ctx);
    if (req.method === 'GET' && path === '/link/preview') return handleLinkPreview(url);

    if (req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'bad json' }, 400); }

      if (path === '/list/parse')     return handleList(body, env);
      if (path === '/link/parse')     return handleLinkParse(body);
      if (path === '/recipe/parse')   return handleRecipe(body, env);
      if (path === '/fuel/plan')      return handleFuel(body, env);
      if (path === '/taskhub/parse')  return handleTaskhub(body, env);
      if (path === '/taskhub/prep')   return handleTaskPrep(body, env);
      if (path === '/journal/format') return handleFormat(body, env);
      if (path === '/prompt/refine')  return handleRefine(body, env);
      if (path === '/watch/check')    return handleWatchCheck(body, env);
      if (path === '/watch/resolve')  return handleWatchResolve(body, env);
      if (path === '/watch/state')    return handleWatchState(body, env);
      if (path === '/watch/ingest')   return handleWatchIngest(body, env);
      if (path === '/watch/notifdebug') return handlePwNotifDebug(body, env);
    }

    return json({ ok: false, error: 'not found' }, 404);
  },

  // Daily price-watch cron (see wrangler.toml [triggers]).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPriceWatchCron(env));
  },
};
