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
    if (typeof set.store === 'string' && set.store.trim()) { it.store = canonStore(t, set.store); addStore(t, it.store); }
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
        const store = canonStore(t, f.store);
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
        const to = canonStore(t, op.to);
        if (!to) break;
        addStore(t, to);
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
        version: 7, // bump when verifying a deploy went live
        features: ['list', 'taskhub', 'journal'],
        models: MODELS,
        listModels: LIST_MODELS,
        taskhubModels: TASKHUB_MODELS,
        tonyKey: !!env.TONY_GEMINI_KEY,
        vedaKey: !!env.VEDA_GEMINI_KEY,
        time: new Date().toISOString(),
      });
    }

    if (req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'bad json' }, 400); }

      if (path === '/list/parse')     return handleList(body, env);
      if (path === '/taskhub/parse')  return handleTaskhub(body, env);
      if (path === '/journal/format') return handleFormat(body, env);
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};
