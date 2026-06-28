// ============================================================================
// taskhub-voice — Cloudflare Worker
//
// Voice / text → structured TaskHub COMMANDS for the Index TaskHubs.
// Each profile (Tony / Veda) has its own Gemini key so usage is separated.
//
// Routes:
//   GET  /health   → status check (reports which keys are configured)
//   POST /parse    → turn a spoken/typed command into a list of TaskHub actions
//
// /parse body (JSON):
//   {
//     profile:   "tony" | "veda",   // selects which Gemini key to use
//     transcript:"add gym at 5pm",  // typed text OR speech-to-text (optional)
//     audio:     "<base64>",        // optional: raw recorded WAV (mobile/iOS)
//     mimeType:  "audio/wav",       // mime of the audio blob
//     today:     "2026-06-28",      // the user's local date (YYYY-MM-DD)
//     weekday:   "Sunday",          // user's local weekday name
//     tz:        "America/Denver",  // user's IANA tz (informational)
//     state:     { ...snapshot... } // current TaskHub state (see front-end)
//   }
// Provide EITHER transcript or audio. Audio is transcribed by Gemini directly so
// the feature works on iOS Safari (which lacks the Web Speech API).
//
// /parse response:
//   { ok:true, actions:[ {type,...}, ... ], transcript:"...", say:"..." }
//
// Bindings (Cloudflare → Settings → Variables & Secrets → add as SECRET):
//   TONY_GEMINI_KEY, VEDA_GEMINI_KEY   (the two AI keys, one per TaskHub)
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

// ── Categories the TaskHub supports (used so the AI maps "work meeting" → work) ──
const CATEGORIES = ['work', 'personal', 'health', 'urgent', 'study', 'finance', 'other'];

// ── Action vocabulary, described to the model. Keep in lock-step with the
//    front-end executor (window._thVoice / window._vdVoice .apply). ───────────
function buildPrompt(profile, transcript, state, today, weekday, hasAudio) {
  const src = hasAudio
    ? `FIRST, transcribe the attached audio of the user speaking (US English). Then treat that transcription as the command.`
    : `The user typed/spoke the command below.`;

  const isTony = profile !== 'veda';

  return [
    `You are the voice command engine for "${isTony ? 'Tony' : 'Veda'}'s TaskHub" — a weekly planner with a calendar, daily habits, short-term goals, long-term goals, a focus timer, light/dark themes, and an edit mode.`,
    `${src}`,
    ``,
    `TODAY is ${today} (${weekday}). Resolve relative dates ("today", "tomorrow", "next Monday", "the 5th", "this Friday", "in 3 days") to absolute YYYY-MM-DD using TODAY. Dates may be in the past, present, or future.`,
    ``,
    `CURRENT STATE (JSON — use it to find existing tasks to edit/remove/move, and to avoid duplicates):`,
    JSON.stringify(state || {}, null, 0).slice(0, 12000),
    ``,
    `Convert the command into an ordered list of ACTIONS. Output ONLY actions that the user actually asked for. The user may issue several at once ("clear Monday and add gym Tuesday at 6") — emit one action per discrete change. Support BULK changes across multiple days/boxes.`,
    ``,
    `BOXES (where a task lives):`,
    `- "calendar" = a task/event on a specific dated day (needs "date"). This is the weekly view.`,
    `- "dailyHabits" = recurring daily habit checklist (no date).`,
    `- "shortTermGoals" = short-term goals list (no date).`,
    `- "longTermGoals" = long-term goals list (no date).`,
    ``,
    `ACTION TYPES (each is an object with a "type"):`,
    `- {type:"add_task", box, date?, title, kind?, category?, time?, notify?, repeat?, repeatDays?, repeatEndDate?, altSeqTitles?, done?}`,
    `    kind: "task" or "event" (default "task"; use "event" if the user gives a clock time for it, e.g. "meeting at 3pm").`,
    `    box "calendar" REQUIRES "date" (YYYY-MM-DD). Other boxes ignore date.`,
    `    category (calendar tasks only): one of ${CATEGORIES.join(', ')} — pick the best fit, else omit.`,
    `    time: event clock time as 24h "HH:MM" (e.g. "17:00"). Only for events.`,
    `    notify: a reminder, as {date:"YYYY-MM-DD", time:"HH:MM"} (24h). Use when the user asks to be reminded/notified.`,
    `    repeat: "none"|"daily"|"weekly"|"weekdays"|"custom". repeatDays: array of weekday indexes (0=Mon..6=Sun) when repeat is "weekly"/"custom".`,
    `    repeatEndDate: {year, month(0-based), day} when the user bounds the repeat; else omit.`,
    `    altSeqTitles: array of 2+ titles for an ALTERNATING SEQUENCE task (e.g. "alternate push day and pull day") — emit instead of "title".`,
    `- {type:"edit_task", match, set:{...any add_task fields...}} — change an existing task. "set" only the changed fields.`,
    `- {type:"remove_task", match}`,
    `- {type:"toggle_task", match, done?} — check/uncheck or mark done/not done.`,
    `- {type:"move_task", match, toBox, toDate?} — move between boxes (toDate required if toBox is "calendar").`,
    `- {type:"clear", box, date?} — remove all tasks in a box (calendar needs date).`,
    `- {type:"go_to_date", date} — navigate the calendar to a day.`,
    `- {type:"set_theme", dark:true|false}  /  {type:"toggle_theme"}`,
    `- {type:"set_edit_mode", on:true|false}`,
    `- {type:"refresh_quote"}`,
    `- {type:"timer_set", minutes}  /  {type:"timer_start"}  /  {type:"timer_stop"}  /  {type:"timer_reset"}  /  {type:"timer_open"}`,
    `- {type:"undo"}  /  {type:"redo"}`,
    ``,
    `"match" identifies an existing task: {box, date?, title} where "title" is the user's words for it (fuzzy — front-end matches loosely). Include "date" when box is "calendar". If the user says "it"/"that", match the most relevant recent task in CURRENT STATE.`,
    ``,
    `RULES:`,
    `- Titles: clean, concise, Title-ish case. Do NOT put the time or date inside the title.`,
    `- If the user clearly wants something done but a detail is ambiguous, choose the most reasonable interpretation rather than refusing.`,
    `- If the command is small talk or you truly cannot map it to any action, return an empty "actions" array and put a one-line reply in "say".`,
    `- Never invent tasks the user didn't ask for. Never echo the whole state back as adds.`,
    `- "say": a SHORT (<=12 words) human confirmation of what you did, e.g. "Added Gym at 5pm Tuesday." Keep it tight.`,
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

async function callGemini(model, key, prompt, audio, mimeType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const gc = {
    temperature: 0,
    maxOutputTokens: 4096,
    responseMimeType: 'application/json',
    responseSchema: ACTION_SCHEMA,
  };
  if (model.startsWith('gemini-2.5')) gc.thinkingConfig = { thinkingBudget: 0 };
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

// Drop empty/undefined fields so the front-end gets clean actions.
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

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' || path === '/health') {
      return json({
        ok: true,
        service: 'taskhub-voice',
        tonyKey: !!env.TONY_GEMINI_KEY,
        vedaKey: !!env.VEDA_GEMINI_KEY,
        time: new Date().toISOString(),
      });
    }

    if (path === '/parse' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'bad json' }, 400); }
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

      const prompt = buildPrompt(profile, transcript, state, today, weekday, !!audio);
      let lastErr = null;
      for (const model of MODELS) {
        try {
          const out = await callGemini(model, key, prompt, audio, mimeType);
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

    return json({ ok: false, error: 'not found' }, 404);
  },
};
