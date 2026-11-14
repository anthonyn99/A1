// What Neo Quant wrote ahead of time (A1-Priv docs/TradeHub/quant/phase-09.md):
// the daily brief (the runner's premarket job) and "What changed?". D1 `briefs`.
//
//   GET  /brief?kind=daily[&day=YYYY-MM-DD]   the newest one up to that New York day → { brief } (null when none)
//   POST /brief { day, kind, body: { text, facts?, model?, provider?, struck? } }   one row per day and kind
import { fail, json } from './http.js';
import { bodyOf } from './charts.js';

export const BRIEF_KINDS = ['daily', 'changed'], BRIEF_MAX = 24_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const noTable = (e) => /no such table/i.test(String((e && e.message) || e));

export async function getBrief(env, url) {
  const kind = url.searchParams.get('kind') || 'daily', day = url.searchParams.get('day') || '';
  if (!BRIEF_KINDS.includes(kind)) throw fail(400, 'kind must be ' + BRIEF_KINDS.join(' or '));
  if (day && !DAY_RE.test(day)) throw fail(400, 'day must be YYYY-MM-DD');
  let row = null;
  try {
    row = day ? await env.DB.prepare('SELECT * FROM briefs WHERE kind = ? AND day <= ? ORDER BY day DESC LIMIT 1').bind(kind, day).first()
      : await env.DB.prepare('SELECT * FROM briefs WHERE kind = ? ORDER BY day DESC LIMIT 1').bind(kind).first();
  } catch (e) { if (!noTable(e)) throw e; }
  let body = null;
  if (row) { try { body = JSON.parse(row.body); } catch (e) {} }
  return json({ ok: true, brief: body ? { day: row.day, kind: row.kind, at: row.at, ...body } : null });
}
export async function postBrief(env, req) {
  const b = await bodyOf(req, BRIEF_MAX + 2000), body = b && b.body;
  if (!b || !DAY_RE.test(b.day || '') || !BRIEF_KINDS.includes(b.kind)) throw fail(400, 'day (YYYY-MM-DD) and kind are needed');
  if (!body || typeof body.text !== 'string' || !body.text.trim()) throw fail(400, 'body.text is needed');
  const out = JSON.stringify({ text: body.text, facts: Array.isArray(body.facts) ? body.facts.slice(0, 80) : [], model: body.model ? String(body.model).slice(0, 80) : null,
    provider: body.provider ? String(body.provider).slice(0, 40) : null, struck: Array.isArray(body.struck) ? body.struck.map(String).slice(0, 40) : [] });
  if (out.length > BRIEF_MAX) throw fail(413, 'a brief is at most ' + BRIEF_MAX + ' bytes');
  const now = Date.now();
  try {
    await env.DB.prepare('INSERT INTO briefs (day, kind, at, body) VALUES (?, ?, ?, ?) ON CONFLICT (day, kind) DO UPDATE SET at = excluded.at, body = excluded.body').bind(b.day, b.kind, now, out).run();
  } catch (e) { if (noTable(e)) throw fail(503, 'the AI tables are not there yet (D1 migration 0009_ai.sql)'); throw e; }
  return json({ ok: true, day: b.day, kind: b.kind, at: now });
}
