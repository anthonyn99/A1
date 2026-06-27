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
    ? `The user shops at these stores: ${stores.join(', ')}. If an item is clearly tied to one of them, set its "store" to that exact name; otherwise leave store as "".`
    : `No specific stores were provided — leave every "store" as "".`;
  const source = hasAudio
    ? `Listen to the attached audio recording of the user speaking.`
    : `Read the user's input below.`;

  if (mode === 'edit') {
    return [
      `You are a precise shopping-list assistant. The user has an EXISTING list and just gave a command to change it. ${source}`,
      storeLine,
      ``,
      `CURRENT LIST (JSON):`,
      JSON.stringify(items || [], null, 0),
      ``,
      hasAudio ? `` : `USER COMMAND (may be messy): """${transcript}"""`,
      ``,
      `Apply the command to the list. The user may ADD items, REMOVE items, change QUANTITIES, mark items as done/gotten, rename items, or assign a store. Keep every existing item that the command does not touch, preserving its "done" state. Merge duplicates intelligently (same item → combine quantities). Return the COMPLETE updated list.`,
      ``,
      `Rules for each item:`,
      `- "name": singular, clean, Title Case grocery name (e.g. "Bananas", "Whole Milk"). No quantities inside the name.`,
      `- "qty": a short human quantity string ("2", "1 gallon", "3 lbs", "a dozen") or "" if none was stated.`,
      `- "store": one of the user's stores, or "".`,
      `- "done": boolean — true only if the user said it's already bought/gotten/done.`,
    ].join('\n');
  }

  return [
    `You are a precise shopping-list assistant. Convert what the user wants into a clean, de-duplicated shopping list. ${source}`,
    storeLine,
    ``,
    hasAudio ? `` : `USER INPUT (may be messy or run-on): """${transcript}"""`,
    ``,
    `Extract every distinct item the user wants to buy. Be accurate: split run-on speech into separate items, infer obvious quantities, and ignore filler words ("um", "and uh", "let me think").`,
    ``,
    `Rules for each item:`,
    `- "name": singular, clean, Title Case grocery name (e.g. "Bananas", "Whole Milk"). No quantities inside the name.`,
    `- "qty": a short human quantity string ("2", "1 gallon", "3 lbs", "a dozen") or "" if none was stated.`,
    `- "store": one of the user's stores, or "".`,
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
          done:  { type: 'BOOLEAN' },
        },
        required: ['name'],
      },
    },
    note: { type: 'STRING' },
  },
  required: ['items'],
};

async function callGemini(model, key, prompt, audio, mimeType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const gc = {
    temperature: 0.1,
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
            return json({ ok: true, items: sanitizeItems(out.items), note: out.note || '', model });
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
