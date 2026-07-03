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

// Fallback chain: most powerful → most efficient, walked top→bottom. When a
// model is exhausted (429 / quota) or errors, we drop to the next one, so the
// apps stay usable even after the newest model hits its daily cap.
// All entries are on Google's FREE tier (Flash / Flash-Lite; Pro is paid-only).
const MODELS = [
  'gemini-3.5-flash',       // newest flagship free Flash — most capable
  'gemini-3.1-flash-lite',  // newest Flash-Lite — matches 2.5-flash quality, high RPD
  'gemini-2.5-flash',       // proven fast Flash
  'gemini-2.5-flash-lite',  // high-RPD lite fallback
  'gemini-2.0-flash',       // older Flash fallback
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
function thinkingConfig(model, feature) {
  // Keep latency low (esp. for voice). Gemini 3.x uses thinkingLevel — "low" is
  // fast and already capable; "high" is far too slow for interactive use. Gemini
  // 2.5-flash keeps the dynamic budget for TaskHub's more complex commands.
  if (model.startsWith('gemini-3')) return { thinkingLevel: 'low' };
  if (model === 'gemini-2.5-flash') return { thinkingBudget: feature === 'taskhub' ? -1 : 0 };
  if (model.startsWith('gemini-2.5')) return { thinkingBudget: 0 };
  return undefined;
}

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

  for (let attempt = 0; attempt < 3; attempt++) {
    let r;
    try {
      r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    } catch (e) {
      await new Promise(res => setTimeout(res, 500 * (attempt + 1)));
      continue;
    }
    if (r.status === 429 || r.status >= 500) {
      // Quota/overload — retry briefly, then let the outer loop try the next model.
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
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 1 — MyList shopping-list parser  (POST /list/parse)
// ════════════════════════════════════════════════════════════════════════════
function buildListPrompt(mode, transcript, items, stores, hasAudio) {
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

const LIST_SCHEMA = {
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

async function handleList(body, env) {
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

  const prompt = buildListPrompt(mode, transcript, items, stores, !!audio);
  let lastErr = null;
  for (const model of MODELS) {
    try {
      const out = await callGemini(model, key, { prompt, schema: LIST_SCHEMA, maxOutputTokens: 4096, feature: 'list', audio, mimeType });
      if (out && Array.isArray(out.items)) {
        const cleanItems = sanitizeItems(out.items);
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
  for (const model of MODELS) {
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
function buildFormatPrompt(text) {
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

async function handleFormat(body, env) {
  const profile = body.profile === 'veda' ? 'veda' : 'tony';
  const text = String(body.text || '').trim();
  if (!text) return json({ ok: false, error: 'no text' }, 400);
  const clipped = text.length > 100000 ? text.slice(0, 100000) : text;

  const key = keyFor(env, profile);
  if (!key) return json({ ok: false, error: `no Gemini key configured for ${profile}` }, 500);

  const prompt = buildFormatPrompt(clipped);
  let lastErr = null;
  for (const model of MODELS) {
    try {
      const out = await callGemini(model, key, { prompt, schema: FORMAT_SCHEMA, maxOutputTokens: 65536, feature: 'journal' });
      if (out && typeof out.html === 'string' && out.html.trim()) return json({ ok: true, html: out.html, model });
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return json({ ok: false, error: lastErr || 'all models failed' }, 502);
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
        features: ['list', 'taskhub', 'journal'],
        models: MODELS,
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
