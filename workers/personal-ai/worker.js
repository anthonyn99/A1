// ============================================================================
// personal-ai — Cloudflare Worker
//
// ONE worker + ONE Gemini key per person, powering all three personal AI
// features that used to live in three separate workers:
//
//   POST /list/parse      (was mylist-api /parse)     — voice/text → shopping list
//   POST /taskhub/parse   (was taskhub-voice /parse)  — voice/text → TaskHub actions
//   POST /journal/format  (was journal-ai /format)    — messy text → clean HTML
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

// Journal formatting: long-document quality matters most → lead with 3.5-flash.
const MODELS = [
  'gemini-3.5-flash',       // newest flagship free Flash — most capable
  'gemini-3.1-flash-lite',  // newest Flash-Lite — matches 2.5-flash quality, high RPD
  'gemini-2.5-flash',       // proven fast Flash
  'gemini-2.5-flash-lite',  // high-RPD lite fallback
  'gemini-2.0-flash',       // older Flash fallback
];

// MyList: interactive voice → latency matters most. 3.1-flash-lite is both the
// fastest and the most reliable at structured multi-op commands (3.5-flash can
// only throttle thinking to "low", never off, so it's seconds slower per call
// and was dropping changes on bulk edits).
const LIST_MODELS = [
  'gemini-3.1-flash-lite',  // fast, accurate structured ops — best for voice
  'gemini-3.5-flash',       // flagship — capacity fallback
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
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
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
];

// Recipes split by task, because the two jobs want opposite things:
//
//  • TYPED / SHORT edits ("rename this", "change cook time to 45", "delete step 6")
//    want minimum latency. 3.1-flash-lite is the fastest reliable structured-op
//    model and, with the compact prompt (only the OPEN recipe is sent in full),
//    these round-trips feel near-instant.
const RECIPE_EDIT_MODELS = [
  'gemini-3.1-flash-lite',  // fastest reliable structured editing
  'gemini-2.5-flash-lite',  // high-RPD lite fallback
  'gemini-2.5-flash',
  'gemini-3.5-flash',
  'gemini-2.0-flash',
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
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
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
// FEATURE 1 — MyList shopping-list parser  (POST /list/parse)
//
// The model emits small targeted OPERATIONS (add / update / remove / bulk ops)
// referencing existing items by their number, and the worker applies them to
// the client's list deterministically. Compared to the old "echo the whole
// updated list back" design this is ~10x fewer output tokens (fast) and makes
// it impossible for a bulk edit to drop or corrupt items the user never
// mentioned. The response shape ({items, stores, note}) is unchanged, so the
// front-end keeps working as-is.
// ════════════════════════════════════════════════════════════════════════════
function buildListPrompt(transcript, items, stores, hasAudio) {
  const source = hasAudio
    ? `FIRST, listen carefully to the attached audio of the user speaking (US English) and work out what they said, using shopping context to correct obvious mishearings. Then act on it.`
    : `Act on the user's input below.`;

  const listLines = (items && items.length)
    ? items.map((it, i) => {
        let line = `${i + 1}. ${it.name}`;
        if (it.qty) line += ` | qty: ${it.qty}`;
        line += ` | store: ${it.store || '(none)'}`;
        if (it.desc) line += ` | note: ${it.desc}`;
        if (it.done) line += ` | DONE`;
        return line;
      }).join('\n')
    : `(the list is empty)`;

  return [
    `You are a world-class shopping-list assistant. The user manages a grocery/shopping list by voice or text. Convert their ONE command into a precise sequence of OPERATIONS ("ops") on the list. Be fast, literal, and complete: capture EVERY change they ask for, and NEVER touch anything they did not mention.`,
    source,
    hasAudio ? `` : `USER INPUT (may be messy or run-on): """${transcript}"""`,
    ``,
    `CURRENT LIST (numbered — use an item's number as "index" when targeting it):`,
    listLines,
    ``,
    `SAVED STORES: ${stores && stores.length ? stores.join(', ') : '(none yet)'}`,
    ``,
    `OPS (emit one per distinct change, in the order the user said them):`,
    `- {op:"add", name, qty?, store?, desc?} — a NEW item ("add / get / need / buy / pick up / grab / we're out of X"). "desc" is MANDATORY whenever the user says ANY detail beyond name/qty/store — dimensions, size, specs, model number, color, flavor, purpose. Example: "add 2 furnace air filters, 20 by 20 by 1" → {"op":"add","name":"Furnace Air Filter","qty":"2","desc":"20×20×1"} (the "20 by 20 by 1" MUST NOT be dropped).`,
    `- {op:"update", index, match, set:{name?, qty?, store?, desc?, done?}} — change ONE existing item: rename (set.name), new quantity (set.qty), move it to a different store (set.store), add detail (set.desc), check it off or un-check it (set.done). "index" = the item's number in the list above; "match" = that item's name. Include BOTH.`,
    `- {op:"remove", index, match} — delete ONE existing item.`,
    `- {op:"move_all", from, to} — move EVERY item at store "from" to store "to" ("move everything from Walmart to Target" → from:"Walmart", to:"Target"). Both fields are store names and BOTH are required.`,
    `- {op:"check_all", store?} / {op:"uncheck_all", store?} — check off (or un-check) every item; add "store" to limit it to one store's items.`,
    `- {op:"remove_all", store?, done?} — bulk delete. "clear the list" → {}. "remove everything I already got" → {done:true}. "delete all the Costco stuff" → {store:"Costco"}.`,
    `- {op:"add_store", name} / {op:"remove_store", name} / {op:"rename_store", name, newName} — manage the saved-stores list itself. "remove/delete X as a store / get rid of the X store" → remove_store (its items stay, just unassigned).`,
    `- {op:"rename_list", name} — rename the CURRENT LIST itself: "rename the list to X", "change the list('s) name to X", "call this/the list X". The LIST is the whole document, not a store — NEVER use add_store or rename_store for a list-name change.`,
    `- {op:"new_list", name?} — the user wants a brand-NEW separate list: "create/start/make a/another new list (called X)". Emit this FIRST; every op AFTER it applies to the new empty list (so follow it with add / add_store ops for everything they want on it). Include "name" only if the user said one. Do NOT use for adding items to the current list.`,
    ``,
    `RULES:`,
    `- BULK COMMANDS: one command often contains MANY changes ("move the milk to Costco, the eggs to Walmart, check off bread, and add paper towels" = 4 ops). Emit one op per change, never drop or merge any, never add extras.`,
    `- MOVING AN ITEM BETWEEN STORES: "move / switch / swap / put X (over) to/at STORE" → update with set:{store:"STORE"}. Only that item's store changes. "swap X and Y's stores" → two updates exchanging their stores.`,
    `- REMOVING AN ITEM FROM ITS STORE (no new store named): "take X out of STORE", "move X out of the store", "put X on its own / by itself", "X isn't at any store", "remove X's store", "un-assign / uncategorize X", "move X to Other" → update with set:{store:"__NONE__"}. This UNASSIGNS the store (the item stays on the list, shown under "Other") — it is NOT a delete, and it does NOT change quantity/name. Use "__NONE__" ONLY when no real store is named; to move to an actual store use that store's name. Likewise "move everything out of STORE" / "empty STORE" → {"op":"move_all","from":"STORE","to":"__NONE__"}.`,
    `- STORE NAMES: a store is a short proper retailer name in Title Case, max 3 words ("Costco", "Best Buy", "Trader Joe's"). When it's clearly one of the SAVED STORES, use that exact spelling. Vague places ("the store", "the mall", "online", "somewhere") are NOT stores — omit the field. Never write a sentence or explanation in a store field.`,
    `- NEW ITEMS: "name" = clean Title Case product name (singular), KEEPING any brand ("Fairlife Whole Milk", "Oreo Cookies", "DeWalt 20V Drill"). Quantity goes in "qty" ("2", "1 gallon", "3 lbs", "a dozen") — never inside the name.`,
    `- AUTO-DESCRIPTIONS (never drop details!): the user never has to say the word "description" — EVERY extra detail spoken with an item goes in that item's "desc", automatically: sizes/dimensions ("20 by 20 by 1" → "20×20×1"), model/part numbers, color, flavor, variety, material, "organic", "the big pack", purposes ("for the party", "for the bathroom trim"), preferences ("the cheap one"). Before finishing, re-check the command: if the user said something about an item that is not captured in name/qty/store, it MUST be in desc. Keep desc short and telegraphic; never repeat the name or qty in it.`,
    `- ADD vs UPDATE: if the user "adds" more of something already on the list, update that item with the new TOTAL qty (list has "Milk qty:1", user says "grab another milk" → set:{qty:"2"}). Anything not on the list is an add.`,
    `- DUPLICATE vs MOVE: "copy/duplicate X to STORE", "add X at STORE too/also/as well", "I also need X from STORE" → a NEW add op with that store (the original item stays untouched). Use update set:{store} ONLY when they say to MOVE/switch/change the item's store.`,
    `- CHECK-OFF: "got / bought / grabbed / picked up / already have / check off / done with X" → update set:{done:true}. "put X back / didn't get X / uncheck X" → set:{done:false}.`,
    `- Split run-on speech into separate ops. Ignore filler ("um", "uh", "like", "let me think", "and then").`,
    `- Do ONLY what was asked. If the command maps to no change, return ops: [].`,
    `- "note": ≤10-word confirmation of what you did ("Moved milk to Costco, eggs to Walmart.").`,
    ``,
    `EXAMPLES (command → ops):`,
    `"move the milk to Costco and the eggs to Walmart instead" → [{"op":"update","index":1,"match":"Milk","set":{"store":"Costco"}},{"op":"update","index":4,"match":"Eggs","set":{"store":"Walmart"}}]`,
    `"we need 2 gallons of Fairlife milk and paper towels from Costco, and check off the bread" → [{"op":"add","name":"Fairlife Milk","qty":"2 gallons"},{"op":"add","name":"Paper Towels","store":"Costco"},{"op":"update","index":2,"match":"Bread","set":{"done":true}}]`,
    `"actually make it 3 avocados and get rid of the chips" → [{"op":"update","index":5,"match":"Avocados","set":{"qty":"3"}},{"op":"remove","index":7,"match":"Chips"}]`,
    `"move everything from Target to Walmart and clear out what I've already gotten" → [{"op":"move_all","from":"Target","to":"Walmart"},{"op":"remove_all","done":true}]`,
    `"add Walmart and Best Buy as stores" → [{"op":"add_store","name":"Walmart"},{"op":"add_store","name":"Best Buy"}]`,
    `"change the name of the list to My Shopping List" → [{"op":"rename_list","name":"My Shopping List"}]`,
    `"remove Home Depot as a store" → [{"op":"remove_store","name":"Home Depot"}]`,
    `"copy the milk over to Walmart too" → [{"op":"add","name":"Milk","store":"Walmart"}]`,
    `"take the milk out of Costco" / "put the milk on its own" → [{"op":"update","index":1,"match":"Milk","set":{"store":"__NONE__"}}]`,
    `"move everything out of Target" → [{"op":"move_all","from":"Target","to":"__NONE__"}]`,
    `"start a new list called Weekend BBQ with burgers and hot dog buns from Costco" → [{"op":"new_list","name":"Weekend BBQ"},{"op":"add","name":"Burgers","store":"Costco"},{"op":"add","name":"Hot Dog Buns","store":"Costco"}]`,
    `"add 2 furnace air filters, 20 by 20 by 1" → [{"op":"add","name":"Furnace Air Filter","qty":"2","desc":"20×20×1"}]`,
    `"a can of white semi-gloss paint for the bathroom trim" → [{"op":"add","name":"White Semi-Gloss Paint","qty":"1 can","desc":"bathroom trim"}]`,
    `"grab the organic strawberries, the big container" → [{"op":"add","name":"Strawberries","desc":"organic, big container"}]`,
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
          op:      { type: 'STRING', enum: ['add', 'update', 'remove', 'move_all', 'check_all', 'uncheck_all', 'remove_all', 'add_store', 'remove_store', 'rename_store', 'rename_list', 'new_list'] },
          name:    { type: 'STRING' },
          qty:     { type: 'STRING' },
          store:   { type: 'STRING' },
          desc:    { type: 'STRING' },
          done:    { type: 'BOOLEAN' },
          index:   { type: 'INTEGER' },
          match:   { type: 'STRING' },
          newName: { type: 'STRING' },
          from:    { type: 'STRING' },
          to:      { type: 'STRING' },
          set: {
            type: 'OBJECT',
            properties: {
              name:  { type: 'STRING' },
              qty:   { type: 'STRING' },
              store: { type: 'STRING' },
              desc:  { type: 'STRING' },
              done:  { type: 'BOOLEAN' },
            },
          },
        },
        required: ['op'],
      },
    },
    note: { type: 'STRING' },
  },
  required: ['ops'],
};

// Keeps the client's "id" so untouched/edited items keep their identity in the app.
function sanitizeItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(it => {
      const o = {
        name:  String(it.name || '').trim(),
        qty:   String(it.qty || '').trim(),
        store: String(it.store || '').trim(),
        desc:  String(it.desc || '').trim(),
        done:  !!it.done,
      };
      if (it.id) o.id = String(it.id);
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

function applyListOps(items, stores, ops) {
  // Ops apply to a "target" list — normally the current list, but a new_list op
  // switches the target to a fresh empty list so the rest of the command builds it.
  const mkTarget = (list, storeNames) => {
    const t = { list, storeMap: new Map(), name: '' }; // storeMap: lowercase → clean display name
    storeNames.forEach(s => addStore(t, s));
    return t;
  };
  function addStore(t, s) { const v = String(s || '').trim(); if (v && v.length <= 40) t.storeMap.set(v.toLowerCase(), v); }
  // Prefer a saved store's exact spelling when the model names the same store.
  const canonStore = (t, s) => { const v = String(s || '').trim(); return v ? (t.storeMap.get(v.toLowerCase()) || v) : ''; };
  // Explicit "unassign this item's store" sentinel(s) — "move it out on its own".
  // Distinct from an empty string (which means "no change"), so a deliberate
  // unassign works WITHOUT letting stray blanks wipe stores. "other" maps here so
  // "move it to Other" drops the item into the implicit uncategorized group rather
  // than creating a literal store named Other.
  const noStore = (s) => /^(__none__|\(none\)|\(no ?store\)|no ?store|none|unassigned|uncategor(?:ized|ised)|other)$/i.test(String(s || '').trim());
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

  const cur = mkTarget(items.map(it => ({ ...it })), stores);
  let nl = null;   // new list target, once a new_list op appears
  let t = cur;     // active target

  for (const op of (Array.isArray(ops) ? ops : [])) {
    if (!op || typeof op !== 'object') continue;
    switch (String(op.op || '')) {
      case 'rename_list': {
        const name = String(op.name || op.newName || '').trim();
        if (name) t.name = name;
        break;
      }
      case 'new_list': {
        nl = mkTarget([], []);
        nl.name = String(op.name || '').trim();
        t = nl;
        break;
      }
      case 'add': {
        // effSet: the model sometimes nests fields under "set" even on adds.
        const f = effSet(op, ['name', 'qty', 'store', 'desc']);
        const name = String(f.name || '').trim();
        if (!name) break;
        const store = noStore(f.store) ? '' : canonStore(t, f.store);
        if (store) addStore(t, store);
        // Same item, same store (or no store involved) → merge instead of duplicating.
        // A DIFFERENT store means the user wants a copy at that store — keep both.
        const dup = t.list.find(it => !it.done && normName(it.name) === normName(name) &&
          (!store || !it.store || normName(it.store) === normName(store)));
        if (dup) {
          if (String(f.qty || '').trim()) dup.qty = String(f.qty).trim();
          if (store) dup.store = store;
          if (String(f.desc || '').trim()) dup.desc = String(f.desc).trim();
        } else {
          t.list.push({ name, qty: String(f.qty || '').trim(), store, desc: String(f.desc || '').trim(), done: false });
        }
        break;
      }
      case 'update': {
        const set = effSet(op, ['name', 'qty', 'store', 'desc', 'done']);
        const it = findItem(t.list, op.index, op.match || op.name);
        if (it) { applySet(t, it, set, true); break; }
        // Target not found (e.g. user thinks it's on the list) — add it so the command still lands.
        const name = String(set.name || op.match || '').trim();
        if (name) {
          const fresh = { name, qty: '', store: '', desc: '', done: false };
          applySet(t, fresh, set, true);
          t.list.push(fresh);
        }
        break;
      }
      case 'remove': {
        const it = findItem(t.list, op.index, op.match);
        if (it) t.list = t.list.filter(x => x !== it);
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

  cur.list.forEach(it => addStore(cur, it.store));
  const out = { items: cur.list, stores: [...cur.storeMap.values()], listName: cur.name };
  if (nl) {
    nl.list.forEach(it => addStore(nl, it.store));
    out.newList = { name: nl.name, items: nl.list, stores: [...nl.storeMap.values()] };
  }
  return out;
}

async function handleList(body, env) {
  const profile = body.profile === 'veda' ? 'veda' : 'tony';
  const transcript = String(body.transcript || '').trim();
  const audio = typeof body.audio === 'string' ? body.audio : '';
  const mimeType = String(body.mimeType || 'audio/webm');
  const items = sanitizeItems(body.items);
  const stores = Array.isArray(body.stores) ? body.stores.filter(Boolean).map(String) : [];

  if (!transcript && !audio) return json({ ok: false, error: 'no transcript or audio' }, 400);
  const key = keyFor(env, profile);
  if (!key) return json({ ok: false, error: `no Gemini key configured for ${profile}` }, 500);

  const prompt = buildListPrompt(transcript, items, stores, !!audio);
  let lastErr = null;
  for (const model of LIST_MODELS) {
    try {
      const out = await callGemini(model, key, { prompt, schema: LIST_OPS_SCHEMA, maxOutputTokens: 8192, feature: 'list', audio, mimeType });
      if (out && Array.isArray(out.ops)) {
        const res = applyListOps(items, stores, out.ops);
        const resp = { ok: true, items: res.items, stores: res.stores, note: String(out.note || '').trim(), ops: out.ops.length, model };
        if (res.listName) resp.listName = res.listName;
        if (res.newList) resp.newList = res.newList;
        if (body.debug) resp.opsDetail = out.ops;
        return json(resp);
      }
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return json({ ok: false, error: lastErr || 'all models failed' }, 502);
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 2 — TaskHub voice command parser  (POST /taskhub/parse)
// ════════════════════════════════════════════════════════════════════════════
const CATEGORIES = ['work', 'personal', 'health', 'urgent', 'study', 'finance', 'other'];

function buildTaskPrompt(profile, transcript, state, today, weekday, hasAudio) {
  const src = hasAudio
    ? `FIRST, transcribe the attached audio of the user speaking (US English), correcting obvious mishearings. Then act on that transcription.`
    : `Act on the user's command below.`;

  const isTony = profile !== 'veda';

  return [
    `You are the precise voice command engine for "${isTony ? 'Tony' : 'Veda'}'s TaskHub" — a weekly planner with a dated calendar, daily habits, short-term goals, long-term goals, a focus timer, themes, and an edit mode. Your job: convert ONE spoken command into an exact, ordered list of ACTIONS. Be thorough and literal — capture EVERY change and EVERY detail the user mentions.`,
    `${src}`,
    hasAudio ? `` : `USER COMMAND: """${transcript}"""`,
    ``,
    `TODAY is ${today} (${weekday}). Resolve relative dates ("today", "tomorrow", "tonight", "next Monday", "the 5th", "this Friday", "in 3 days", "end of month") to absolute YYYY-MM-DD using TODAY. Past, present and future dates are all allowed. If no date is given for a calendar task, use TODAY.`,
    ``,
    `CURRENT STATE (JSON — read-only reference, used ONLY to locate items the user explicitly wants to edit/remove/move/reorder/swap). Never change anything here that the user did not name):`,
    JSON.stringify(state || {}, null, 0).slice(0, 14000),
    ``,
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
    `- BULK: a command may contain many changes. Emit one action per DISTINCT change, in the order stated. Don't merge unrelated changes; don't drop any; don't add extras.`,
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

  const prompt = buildTaskPrompt(profile, transcript, state, today, weekday, !!audio);
  let lastErr = null;
  for (const model of TASKHUB_MODELS) {
    try {
      const out = await callGemini(model, key, { prompt, schema: ACTION_SCHEMA, maxOutputTokens: 8192, feature: 'taskhub', audio, mimeType });
      if (out && Array.isArray(out.actions)) {
        const actions = out.actions.map(cleanAction).filter(Boolean);
        return json({
          ok: true,
          actions,
          transcript: String(out.transcript || transcript || '').trim(),
          say: String(out.say || '').trim(),
          model,
        });
      }
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return json({ ok: false, error: lastErr || 'all models failed' }, 502);
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

async function handleFormat(body, env) {
  const profile = body.profile === 'veda' ? 'veda' : 'tony';
  const text = String(body.text || '').trim();
  if (!text) return json({ ok: false, error: 'no text' }, 400);
  const clipped = text.length > 120000 ? text.slice(0, 120000) : text;

  const key = keyFor(env, profile);
  if (!key) return json({ ok: false, error: `no Gemini key configured for ${profile}` }, 500);

  const prompt = buildFormatPrompt(clipped, body.prompt);
  let lastErr = null, quota = false;
  for (const model of MODELS) {
    try {
      const out = await callGemini(model, key, { prompt, schema: FORMAT_SCHEMA, maxOutputTokens: 65536, feature: 'journal' });
      if (out && typeof out.html === 'string' && out.html.trim()) return json({ ok: true, html: out.html, model });
    } catch (e) {
      lastErr = e.message || String(e);
      if (/\b429\b|quota|resource_exhausted|exhaust/i.test(lastErr)) quota = true;
    }
  }
  return json({ ok: false, error: lastErr || 'all models failed', exhausted: quota }, quota ? 429 : 502);
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
async function sendFCM(projectId, token, title, body, id, accessToken, dash) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        data: { id: String(id || ''), title: String(title || 'Price Watch'), body: String(body || title || ''), dash: String(dash || 'all') },
        android: { priority: 'high' },
        webpush: { headers: { Urgency: 'high', TTL: '600', Topic: crypto.randomUUID().replace(/-/g, '') } },
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
// reused across a whole cron run. See STORE_NOTES.md → "Kroger / King Soopers".
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
// See STORE_NOTES.md for per-store notes.
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
      .catch(e => console.warn('[pricewatch] fcm', e.message))
  ));
  console.log(`[pricewatch] drop ${bodyTxt} → ${targets.length} device(s)`);
  return targets.length;
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

    // Write the whole doc back NOW (crash-safe). `it` is a live reference inside
    // docs[path].items, so its mutation is already in the object we serialize.
    const d = docs[entry.path];
    // Preserve the doc's `stores` list on write (never wipe the user's store config).
    try { await fsWriteDoc(env, token, entry.path, { items: d.items, stores: d.stores, savedAt: Date.now() }); }
    catch (e) { console.warn('[pricewatch] write', entry.path, e.message); }

    if (prevBest != null && typeof res.bestPrice === 'number' && (prevBest - res.bestPrice) > 1.00) {
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
      const prevBest = pwApplyToItem(it, res, today);
      applied++;
      if (prevBest != null && typeof res.bestPrice === 'number' && (prevBest - res.bestPrice) > 1.00) {
        if (!tokenDocsCache) tokenDocsCache = await fsFetchTokens(env, token);
        await pwNotifyDrop(env, token, profile, it, prevBest, res, tokenDocsCache);
      }
    }

    if (applied) await fsWriteDoc(env, token, path, { items, stores: data.stores, savedAt: Date.now() });
    return json({ ok: true, applied, skipped });
  } catch (e) { return json({ ok: false, error: e.message || String(e) }, 502); }
}

// ════════════════════════════════════════════════════════════════════════════
// Router
// ════════════════════════════════════════════════════════════════════════════
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' || path === '/health') {
      return json({
        ok: true,
        service: 'personal-ai',
        version: 13, // bump when verifying a deploy went live
        features: ['list', 'recipe', 'taskhub', 'journal', 'watch', 'watch-ingest'],
        models: MODELS,
        listModels: LIST_MODELS,
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

    if (req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'bad json' }, 400); }

      if (path === '/list/parse')     return handleList(body, env);
      if (path === '/recipe/parse')   return handleRecipe(body, env);
      if (path === '/taskhub/parse')  return handleTaskhub(body, env);
      if (path === '/journal/format') return handleFormat(body, env);
      if (path === '/watch/check')    return handleWatchCheck(body, env);
      if (path === '/watch/resolve')  return handleWatchResolve(body, env);
      if (path === '/watch/state')    return handleWatchState(body, env);
      if (path === '/watch/ingest')   return handleWatchIngest(body, env);
    }

    return json({ ok: false, error: 'not found' }, 404);
  },

  // Daily price-watch cron (see wrangler.toml [triggers]).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPriceWatchCron(env));
  },
};
