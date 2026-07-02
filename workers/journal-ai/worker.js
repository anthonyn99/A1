// ============================================================================
// journal-ai — Cloudflare Worker
//
// AI "AI Format" for the Index journals (MyJournal / Brainstorm Journal).
// Takes the raw, possibly-messy text of a document and returns clean, well
// structured HTML — WITHOUT changing the wording/content, only the formatting.
//
// Each journal has its own Gemini key so usage is separated:
//   MyJournal (Tony) → profile "tony" → TONY_GEMINI_KEY
//   Brainstorm Journal (Veda) → profile "veda" → VEDA_GEMINI_KEY
//
// Routes:
//   GET  /health  → status (reports which keys are configured)
//   POST /format  → { profile, text } → { ok, html }
//
// Bindings (Cloudflare → Settings → Variables & Secrets → add as SECRET):
//   TONY_GEMINI_KEY, VEDA_GEMINI_KEY
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

function buildPrompt(text) {
  return [
    `You are a meticulous document formatter for a rich-text journal editor.`,
    `You are given the RAW TEXT of a document that the user pasted or typed. It may be messy: inconsistent spacing, no headings, run-on lines, ad-hoc lists, pasted markdown, etc.`,
    ``,
    `Your job: return the SAME content re-expressed as clean, beautiful, well-structured HTML.`,
    ``,
    `ABSOLUTE RULES:`,
    `- DO NOT change the wording. Preserve every sentence, word, number, name, URL and piece of data EXACTLY. Do not add new information, do not remove content, do not summarize, do not rewrite, do not correct spelling or grammar, do not translate.`,
    `- You may ONLY change formatting/structure: split into paragraphs, add headings for sections that clearly are headings, turn obvious lists into <ul>/<ol>, turn checkbox-like lines ("[ ]", "[x]", "- todo") into checklists, format tables written with pipes into <table>, wrap quotes in <blockquote>, wrap code/command lines in <pre><code>, add <strong>/<em> only where the raw text used markdown markers (**bold**, *italic*, __bold__, _italic_) or ALL-CAPS emphasis that is clearly a label.`,
    `- Reasonable inference of structure is encouraged (e.g. a short line followed by related lines can become a heading + paragraph), but NEVER invent or drop words.`,
    `- If a line is just a label like "Prompt 1:" keep it, optionally as a heading.`,
    ``,
    `OUTPUT FORMAT:`,
    `- Output ONLY an HTML fragment (no markdown fences, no <html>, <head> or <body> tags).`,
    `- Allowed tags: h1 h2 h3 h4 p ul ol li blockquote pre code strong em u s a table thead tbody tr th td hr br. For checklists use: <ul class="docx-checklist"><li class="docx-cl-item"><input type="checkbox" class="docx-cl-box"><span class="docx-cl-text">TASK</span></li></ul> (add the "checked" attribute and class "done" for completed items).`,
    `- Do not use inline style attributes. Do not use images or scripts.`,
    ``,
    `RAW TEXT (between the fences):`,
    `<<<`,
    text,
    `>>>`,
  ].join('\n');
}

const FORMAT_SCHEMA = {
  type: 'OBJECT',
  properties: { html: { type: 'STRING' } },
  required: ['html'],
};

async function callGemini(model, key, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const gc = {
    temperature: 0,
    maxOutputTokens: 65536,
    responseMimeType: 'application/json',
    responseSchema: FORMAT_SCHEMA,
  };
  if (model === 'gemini-2.5-flash') gc.thinkingConfig = { thinkingBudget: 0 };
  else if (model.startsWith('gemini-2.5')) gc.thinkingConfig = { thinkingBudget: 0 };
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: gc });

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
    const raw = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!raw) continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { continue; }
    if (parsed && typeof parsed.html === 'string' && parsed.html.trim()) return parsed.html;
  }
  return null;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' || path === '/health') {
      return json({
        ok: true,
        service: 'journal-ai',
        tonyKey: !!env.TONY_GEMINI_KEY,
        vedaKey: !!env.VEDA_GEMINI_KEY,
        time: new Date().toISOString(),
      });
    }

    if (path === '/format' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'bad json' }, 400); }
      const profile = body.profile === 'veda' ? 'veda' : 'tony';
      const text = String(body.text || '').trim();
      if (!text) return json({ ok: false, error: 'no text' }, 400);
      // Keep payloads sane (Gemini context + worker limits)
      const clipped = text.length > 100000 ? text.slice(0, 100000) : text;

      const key = keyFor(env, profile);
      if (!key) return json({ ok: false, error: `no Gemini key configured for ${profile}` }, 500);

      const prompt = buildPrompt(clipped);
      let lastErr = null;
      for (const model of MODELS) {
        try {
          const html = await callGemini(model, key, prompt);
          if (html) return json({ ok: true, html, model });
        } catch (e) {
          lastErr = e.message || String(e);
        }
      }
      return json({ ok: false, error: lastErr || 'all models failed' }, 502);
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};
