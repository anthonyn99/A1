// ============================================================================
// mylist-api — Cloudflare Worker
//
// Voice / text → structured shopping-list parser for the MyList app.
// Each profile (Tony / Veda) has its own Gemini key so usage is separated.
//
// Routes:
//   GET  /health                 → status check
//   POST /parse                  → turn a spoken/typed transcript into list items
//
// /parse body (JSON):
//   {
//     profile:   "tony" | "veda",          // selects which Gemini key to use
//     mode:      "create" | "edit",        // create a fresh list vs. edit existing
//     transcript:"two gallons of milk ...", // typed text OR speech-to-text (optional)
//     audio:     "<base64>",                // optional: raw recorded audio (mobile/iOS)
//     mimeType:  "audio/webm",              // mime of the audio blob
//     items:     [{name,qty,store,done}],  // current list items (for edit mode)
//     stores:    ["Costco","Publix"]        // known stores to attribute items to
//   }
// Provide EITHER transcript or audio. Audio is transcribed by Gemini directly so
// the feature works on iOS Safari (which lacks the Web Speech API).
//
// /parse response:
//   { ok:true, items:[{name,qty,store,done}], note:"..." }
//
// Bindings (Cloudflare → Settings → Variables):
//   TONY_GEMINI_KEY, VEDA_GEMINI_KEY   (the two AI Studio keys, one per profile)
// ============================================================================

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-1.5-flash'];

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

// ── Prompt builders ─────────────────────────────────────────────────────────
// hasAudio toggles wording so the model knows to transcribe the attached audio
// instead of reading a text transcript.
function buildPrompt(mode, transcript, items, stores, hasAudio) {
  const storeLine = (stores && stores.length)
    ? `The user already has these stores: ${stores.join(', ')}. Match item stores to one of these EXACT names when they fit.`
    : `The user has no saved stores yet.`;
  const source = hasAudio
    ? `Listen carefully to the attached audio recording of the user speaking.`
    : `Read the user's input below.`;

  const SHARED_RULES = [
    `STORE DETECTION: If the user names a real shop/retailer for an item — "from Best Buy", "at Costco", "Walmart run", "get X from Target" — set that item's "store" to that shop's clean Title Case name (even if not in the saved list). A store named once applies to all items grouped with it in that phrase. STRICT: "store" must be a short proper store name, max 3 words. If the location is vague or generic ("the mall", "the store", "somewhere", "online"), leave "store" as "". Never write a sentence, explanation, or placeholder text in "store" — only a real name or "".`,
    `BRANDS: If the user names a brand or specific product, KEEP it in the "name" (e.g. "Fairlife Whole Milk", "Oreo Cookies", "DeWalt 20V Drill", "Apple MacBook Pro"). Do not strip brands.`,
    `DESCRIPTIONS: Put any extra detail the user gives (size, color, flavor, variety, purpose, preference, "the big one", "organic", "for the party") into "desc" as a SHORT concise note. Do NOT repeat the name or quantity in desc. If no detail, "desc" is "".`,
    `ITEMS: Split run-on speech into SEPARATE items. Recognize counts/quantities accurately. Ignore filler words ("um", "uh", "like", "let me think", "and then").`,
    `STORE-ONLY COMMANDS: The user can manage stores by voice/text with no items, e.g. "add Walmart, Target and Best Buy" or "add Costco as a store". When they do, put those store names in the top-level "stores" array and leave the existing items unchanged. ALWAYS also list in top-level "stores" every store name you assigned to any item, plus the user's existing saved stores. So "stores" = the full set of stores that should exist after this command.`,
    `OUTPUT: Every field is short data only — never explanations, reasoning, or placeholder notes. Keep each field tight.`,
    `Per-item fields:`,
    `- "name": clean Title Case product name WITH brand if stated. No quantity inside the name.`,
    `- "qty": short human quantity ("2", "1 gallon", "3 lbs", "a dozen", "5 bags") or "" if none.`,
    `- "store": detected/saved store name, or "".`,
    `- "desc": concise extra detail, or "".`,
  ];

  if (mode === 'edit') {
    return [
      `You are an expert shopping-list assistant. The user has an EXISTING list and just gave a command to change it. ${source}`,
      storeLine,
      ``,
      `CURRENT LIST (JSON):`,
      JSON.stringify(items || [], null, 0),
      ``,
      hasAudio ? `` : `USER COMMAND (may be messy): """${transcript}"""`,
      ``,
      `Apply the command. The user may ADD items, REMOVE items, change QUANTITIES, mark items done/gotten, rename items, add/clarify descriptions, or assign a store. Keep every existing item the command does not touch, preserving its "done" and "desc". Merge duplicates intelligently (same item → combine quantities). Return the COMPLETE updated list.`,
      ``,
      ...SHARED_RULES,
      `- "done": boolean — true only if the user said it's already bought/gotten/done.`,
    ].join('\n');
  }

  return [
    `You are an expert shopping-list assistant. Convert what the user wants into a clean, de-duplicated shopping list. ${source}`,
    storeLine,
    ``,
    hasAudio ? `` : `USER INPUT (may be messy or run-on): """${transcript}"""`,
    ``,
    `Extract every distinct item the user wants to buy.`,
    ``,
    ...SHARED_RULES,
    `- "done": always false for a new list.`,
  ].join('\n');
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name:  { type: 'STRING' },
          qty:   { type: 'STRING' },
          store: { type: 'STRING' },
          desc:  { type: 'STRING' },
          done:  { type: 'BOOLEAN' },
        },
        required: ['name'],
      },
    },
    stores: { type: 'ARRAY', items: { type: 'STRING' } },
    note: { type: 'STRING' },
  },
  required: ['items'],
};

async function callGemini(model, key, prompt, audio, mimeType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const gc = {
    temperature: 0,
    maxOutputTokens: 4096,
    responseMimeType: 'application/json',
    responseSchema: RESPONSE_SCHEMA,
  };
  if (model.startsWith('gemini-2.5')) gc.thinkingConfig = { thinkingBudget: 0 };
  const parts = [{ text: prompt }];
  if (audio) parts.push({ inlineData: { mimeType: mimeType || 'audio/webm', data: audio } });
  const body = JSON.stringify({ contents: [{ parts }], generationConfig: gc });

  for (let attempt = 0; attempt < 3; attempt++) {
    let r;
    try {
      r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    } catch (e) {
      await new Promise(res => setTimeout(res, 500 * (attempt + 1)));
      continue;
    }
    if (r.status === 429 || r.status >= 500) {
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
    return JSON.parse(text);
  }
  return null;
}

function sanitizeItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(it => ({
      name:  String(it.name || '').trim(),
      qty:   String(it.qty || '').trim(),
      store: String(it.store || '').trim(),
      desc:  String(it.desc || '').trim(),
      done:  !!it.done,
    }))
    .filter(it => it.name);
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' || path === '/health') {
      return json({
        ok: true,
        service: 'mylist-api',
        tonyKey: !!env.TONY_GEMINI_KEY,
        vedaKey: !!env.VEDA_GEMINI_KEY,
        time: new Date().toISOString(),
      });
    }

    if (path === '/parse' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'bad json' }, 400); }
      const profile = body.profile === 'veda' ? 'veda' : 'tony';
      const mode = body.mode === 'edit' ? 'edit' : 'create';
      const transcript = String(body.transcript || '').trim();
      const audio = typeof body.audio === 'string' ? body.audio : '';
      const mimeType = String(body.mimeType || 'audio/webm');
      const items = Array.isArray(body.items) ? body.items : [];
      const stores = Array.isArray(body.stores) ? body.stores.filter(Boolean) : [];

      if (!transcript && !audio) return json({ ok: false, error: 'no transcript or audio' }, 400);
      const key = keyFor(env, profile);
      if (!key) return json({ ok: false, error: `no Gemini key configured for ${profile}` }, 500);

      const prompt = buildPrompt(mode, transcript, items, stores, !!audio);
      let lastErr = null;
      for (const model of MODELS) {
        try {
          const out = await callGemini(model, key, prompt, audio, mimeType);
          if (out && Array.isArray(out.items)) {
            const cleanItems = sanitizeItems(out.items);
            // stores = AI's returned stores ∪ any store assigned to an item ∪ caller's stores
            const storeSet = new Map();
            const addS = s => { const v = String(s || '').trim(); if (v && v.length <= 40) storeSet.set(v.toLowerCase(), v); };
            (Array.isArray(out.stores) ? out.stores : []).forEach(addS);
            cleanItems.forEach(it => addS(it.store));
            stores.forEach(addS);
            return json({ ok: true, items: cleanItems, stores: [...storeSet.values()], note: out.note || '', model });
          }
        } catch (e) {
          lastErr = e.message || String(e);
        }
      }
      return json({ ok: false, error: lastErr || 'all models failed' }, 502);
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};
