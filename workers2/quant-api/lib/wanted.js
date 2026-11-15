// Neo Quant's "wanted" list (A1-Priv docs/TradeHub/quant/phase-11.md): what
// Tony asked for that it cannot do yet. D1 table `wanted` (migrations/0011_wanted.sql).
//
//   GET    /wanted                      { wanted: [{ what, words, kind, at, count }], missing? }  newest first
//   POST   /wanted { what, words, kind } one row per `what`; asking again counts it and keeps the newest words
//   DELETE /wanted?what=…                one row;  DELETE /wanted?confirm=clear  every row
// Until the migration is applied, GET answers an empty list with missing: true and
// a write answers 503 (the page keeps its own copy meanwhile).
import { fail, json } from './http.js';
import { bodyOf } from './charts.js';

export const WANTED_MAX = 100, WHAT_MAX = 120, WORDS_MAX = 300, KINDS = ['control', 'lab'];
const noTable = (e) => /no such table/i.test(String((e && e.message) || e));
const notYet = () => fail(503, 'the wanted table is not there yet (D1 migration 0011_wanted.sql)');
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

export async function getWanted(env) {
  try {
    const rows = (await env.DB.prepare('SELECT what, words, kind, at, count FROM wanted ORDER BY at DESC LIMIT ?').bind(WANTED_MAX).all()).results || [];
    return json({ ok: true, wanted: rows });
  } catch (e) { if (noTable(e)) return json({ ok: true, wanted: [], missing: true }); throw e; }
}

export async function postWanted(env, req) {
  const b = await bodyOf(req);
  const what = clip(b.what, WHAT_MAX), words = clip(b.words, WORDS_MAX), kind = KINDS.includes(b.kind) ? b.kind : 'control';
  if (!what) throw fail(400, 'what is missing');
  const at = Date.now();
  try {
    await env.DB.prepare('INSERT INTO wanted (what, words, kind, at, count) VALUES (?, ?, ?, ?, 1) ON CONFLICT(what) DO UPDATE SET words = excluded.words, kind = excluded.kind, at = excluded.at, count = wanted.count + 1')
      .bind(what, words || what, kind, at).run();
    // Kept small: the oldest beyond the cap go.
    await env.DB.prepare('DELETE FROM wanted WHERE what NOT IN (SELECT what FROM wanted ORDER BY at DESC LIMIT ?)').bind(WANTED_MAX).run();
  } catch (e) { if (noTable(e)) throw notYet(); throw e; }
  return json({ ok: true, what, at });
}

export async function deleteWanted(env, url) {
  const what = clip(url.searchParams.get('what'), WHAT_MAX), all = url.searchParams.get('confirm') === 'clear';
  if (!what && !all) throw fail(400, 'say which (?what=) or confirm=clear');
  try {
    const r = all ? await env.DB.prepare('DELETE FROM wanted').run() : await env.DB.prepare('DELETE FROM wanted WHERE what = ?').bind(what).run();
    return json({ ok: true, deleted: (r && r.meta && r.meta.changes) || 0 });
  } catch (e) { if (noTable(e)) throw notYet(); throw e; }
}
