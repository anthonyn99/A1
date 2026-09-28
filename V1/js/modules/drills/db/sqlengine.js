/* ============================================================================
 * StudyOS drills — SQL engine  (sql.js / SQLite in WASM)
 * ============================================================================
 * Runs entirely in the browser: vendor/sqljs-<ver>/ is served beside the app
 * and cached by studyos-sw.js, so the sandbox works offline once loaded.
 *
 * ── DIALECT ───────────────────────────────────────────────────────────────
 * Her course (Kroenke, SQL Server flavour) writes `SELECT TOP 5 ...`. SQLite
 * has no TOP, so translate() rewrites the simple form to a trailing LIMIT.
 * `TOP n PERCENT` and `+` for string concatenation are NOT translated — both
 * would need a real parser to do safely — and the sandbox says so instead of
 * guessing.
 * ------------------------------------------------------------------------- */

import { DATASETS } from './datasets.js';

export const SQLJS_VERSION = '1.14.2';
const BASE = `vendor/sqljs-${SQLJS_VERSION}/`;

let _factory = null;     // test hook: a ready initSqlJs-style module
let _SQL = null;
let _loading = null;

/** Tests (Node) inject sql.js directly; the browser loads the vendored file. */
export function setSqlModule(SQL) { _SQL = SQL; }
export function setSqlFactory(fn) { _factory = fn; }

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('could not load ' + src));
    document.head.appendChild(s);
  });
}

export async function loadSql() {
  if (_SQL) return _SQL;
  if (_loading) return _loading;
  _loading = (async () => {
    if (_factory) { _SQL = await _factory(); return _SQL; }
    if (typeof window.initSqlJs !== 'function') await loadScript(BASE + 'sql-wasm.js');
    _SQL = await window.initSqlJs({ locateFile: (f) => BASE + f });
    return _SQL;
  })();
  try { return await _loading; }
  finally { _loading = null; }
}

/** A fresh in-memory database seeded with a dataset. Caller must close() it. */
export async function openDataset(name = 'capecodd') {
  const SQL = await loadSql();
  const db = new SQL.Database();
  const ds = DATASETS[name];
  if (!ds) throw new Error('unknown dataset ' + name);
  db.exec(ds.sql);
  return db;
}

/** Strip comments; they confuse the TOP rewrite and the statement split. */
function stripComments(sql) {
  return String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/**
 * Translate the SQL Server bits her course uses into SQLite.
 * Returns { sql, notes[] } — notes explain anything rewritten or refused.
 */
export function translate(sql) {
  let s = stripComments(sql).trim().replace(/;\s*$/, '');
  const notes = [];
  if (/\bTOP\s+\d+\s+PERCENT\b/i.test(s)) {
    return { sql: s, notes, error: 'TOP … PERCENT is SQL Server–only and not supported in this SQLite sandbox. Use ORDER BY with LIMIT n instead.' };
  }
  const m = /^\s*SELECT\s+(DISTINCT\s+)?TOP\s+(\d+)\s+/i.exec(s);
  if (m) {
    if (/\bLIMIT\s+\d+/i.test(s)) {
      return { sql: s, notes, error: 'Use either TOP or LIMIT, not both.' };
    }
    s = s.replace(m[0], 'SELECT ' + (m[1] || '')) + ' LIMIT ' + m[2];
    notes.push(`TOP ${m[2]} was run as LIMIT ${m[2]} (SQLite has no TOP).`);
  }
  // A `'text' + col` concatenation silently becomes arithmetic (0) in SQLite.
  if (/'[^']*'\s*\+|\+\s*'[^']*'/.test(s)) {
    notes.push("SQLite concatenates strings with || , not + — 'a' + 'b' is arithmetic here.");
  }
  return { sql: s, notes };
}

/**
 * Run SQL against a db. Returns { columns, rows, notes } for the LAST
 * statement that produced a result set, or throws with a readable message.
 */
export function run(db, sql) {
  const t = translate(sql);
  if (t.error) throw new Error(t.error);
  if (!t.sql) throw new Error('Type a query first.');
  let res;
  try {
    res = db.exec(t.sql);
  } catch (e) {
    throw new Error(String(e.message || e).replace(/^Error:\s*/, ''));
  }
  const last = res.length ? res[res.length - 1] : { columns: [], values: [] };
  return { columns: last.columns, rows: last.values, notes: t.notes };
}

export default { loadSql, openDataset, translate, run, setSqlModule, setSqlFactory, SQLJS_VERSION };
