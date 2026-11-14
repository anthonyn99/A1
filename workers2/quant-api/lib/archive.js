// Archives, backups and restore (A1-Priv docs/TradeHub/quant/phase-08.md). The
// heavy work (building the files, gzip, retention) is the runner's nightly
// `archive` job (A1-Priv tools/quant-archive.mjs), so the worker stays within
// its CPU limit; these are its primitives.
//
//   GET  /export/tables                  the tables a backup holds, with row counts
//   GET  /export?table=X&offset=N&limit=  a page of rows (≤ 2,000), in rowid order
//   GET  /history/old?days=30            unpinned conversations older than that, with their turns
//   POST /history/purge { ids }          remove them (after they reached Drive); one batch
//   POST /restore { confirm, table, rows, offset }
//        loads rows into a table that is EMPTY, or (to resume a chunked restore)
//        holds exactly `offset` rows; confirm must be "restore into an empty database".
import { fail, json } from './http.js';
import { bodyOf } from './charts.js';

export const EXPORT_MAX = 2000, RESTORE_MAX = 500, RESTORE_CONFIRM = 'restore into an empty database';
// Never exported or restored: Cloudflare's and SQLite's own, and the Drive token (sealed to this worker's key).
const SKIP = new Set(['_cf_KV', 'sqlite_sequence', 'd1_migrations']);
const META_SKIP = "k NOT LIKE 'drive:%'";
const TABLE_RE = /^[a-z_][a-z0-9_]{0,40}$/;
const batch = (env, stmts) => (env.DB.batch ? env.DB.batch(stmts) : (async () => { for (const s of stmts) await s.run(); })());

/** The tables of this database a backup holds. */
export async function tableNames(env) {
  const rows = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).results || [];
  return rows.map((r) => r.name).filter((n) => !SKIP.has(n) && TABLE_RE.test(n));
}
async function knownTable(env, t) {
  if (!TABLE_RE.test(String(t || '')) || !(await tableNames(env)).includes(t)) throw fail(400, 'no such table: ' + String(t).slice(0, 40));
  return t;
}
const where = (t) => (t === 'meta' ? ' WHERE ' + META_SKIP : '');

export async function exportTables(env) {
  const out = [];
  for (const t of await tableNames(env)) out.push({ table: t, rows: (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}${where(t)}`).first()).n });
  return json({ ok: true, tables: out });
}
export async function exportPage(env, url) {
  const t = await knownTable(env, url.searchParams.get('table'));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0), limit = Math.max(1, Math.min(EXPORT_MAX, Number(url.searchParams.get('limit')) || EXPORT_MAX));
  const rows = (await env.DB.prepare(`SELECT * FROM ${t}${where(t)} ORDER BY rowid LIMIT ? OFFSET ?`).bind(limit, offset).all()).results || [];
  return json({ ok: true, table: t, offset, rows, more: rows.length === limit });
}

export async function restore(env, req) {
  const b = await bodyOf(req, 6_000_000);
  if (!b || b.confirm !== RESTORE_CONFIRM) throw fail(400, `confirm must be "${RESTORE_CONFIRM}"`);
  const t = await knownTable(env, b.table), rows = Array.isArray(b.rows) ? b.rows : null, offset = Number(b.offset) || 0;
  if (!rows) throw fail(400, 'rows is needed');
  if (rows.length > RESTORE_MAX) throw fail(400, `at most ${RESTORE_MAX} rows a call`);
  const have = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n;
  // Only into an empty table, or one this restore is filling (exactly `offset` rows so far): never over live data.
  if (have !== offset) throw fail(409, `${t} holds ${have} rows; a restore goes only into an empty database (or resumes at offset ${have})`);
  if (!rows.length) return json({ ok: true, table: t, added: 0 });
  const cols = (await env.DB.prepare(`SELECT name FROM pragma_table_info('${t}')`).all()).results.map((r) => r.name);
  const stmts = rows.map((r) => {
    const keys = cols.filter((c) => Object.prototype.hasOwnProperty.call(r, c));
    if (!keys.length) throw fail(400, 'a row has none of the columns of ' + t);
    return env.DB.prepare(`INSERT INTO ${t} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).bind(...keys.map((k) => (r[k] === undefined ? null : r[k])));
  });
  await batch(env, stmts);
  return json({ ok: true, table: t, added: rows.length });
}

/* ── the 30-day rule for conversations ──────────────────────────────────── */
export async function historyOld(env, url) {
  const days = Math.max(1, Number(url.searchParams.get('days')) || 30), cut = Date.now() - days * 86_400_000;
  const convs = (await env.DB.prepare('SELECT h.*, COALESCE(MAX(t.at), h.created) AS updated FROM history h LEFT JOIN history_turns t ON t.conv = h.id '
    + 'WHERE h.pinned = 0 GROUP BY h.id HAVING COALESCE(MAX(t.at), h.created) < ? ORDER BY updated ASC LIMIT 500').bind(cut).all()).results || [];
  if (!convs.length) return json({ ok: true, conversations: [] });
  const turns = (await env.DB.prepare('SELECT * FROM history_turns WHERE conv IN (SELECT value FROM json_each(?)) ORDER BY at ASC').bind(JSON.stringify(convs.map((c) => c.id))).all()).results || [];
  const by = {};
  for (const t of turns) (by[t.conv] = by[t.conv] || []).push(t);
  return json({ ok: true, conversations: convs.map((c) => ({ ...c, turns: by[c.id] || [] })) });
}
export async function historyPurge(env, req) {
  const b = await bodyOf(req, 60000), ids = Array.isArray(b && b.ids) ? b.ids.map(String).slice(0, 500) : [];
  if (!ids.length) throw fail(400, 'ids is needed');
  const list = JSON.stringify(ids);
  // A pinned conversation is never purged, even when asked.
  await batch(env, [
    env.DB.prepare('DELETE FROM history_turns WHERE conv IN (SELECT id FROM history WHERE pinned = 0 AND id IN (SELECT value FROM json_each(?)))').bind(list),
    env.DB.prepare('DELETE FROM history WHERE pinned = 0 AND id IN (SELECT value FROM json_each(?))').bind(list),
  ]);
  return json({ ok: true, n: ids.length });
}
