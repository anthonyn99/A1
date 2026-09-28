/* ============================================================================
 * StudyOS drills — SQL result grading
 * ============================================================================
 * A query is right when it returns the right DATA, not when it matches the
 * model answer's text. So grading runs both and compares result sets:
 *
 *   - rows as a MULTISET (duplicates matter: forgetting DISTINCT is wrong)
 *   - columns in ANY order, matched by content — "SKU, Department" and
 *     "Department, SKU" are the same answer — unless the challenge pins order
 *   - column NAMES ignored unless the challenge requires an alias
 *   - row order ignored unless the challenge asks for ORDER BY, and then only
 *     the requested sort key is checked (ties may come back in any order)
 *   - numbers compared with rounding (445 == 445.0), strings trimmed
 *
 * Feedback says WHY a result is wrong (row count, a missing row, an extra
 * row), because "incorrect" alone teaches nothing.
 * ------------------------------------------------------------------------- */

function norm(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  if (typeof v === 'bigint') return Number(v);
  const s = String(v).trim();
  if (s !== '' && /^-?\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1e6) / 1e6;
  return s;
}

const key = (v) => (v === null ? '\u0000NULL' : typeof v + ':' + String(v));
const rowKey = (row) => row.map(key).join('\u0001');

function column(rows, i) { return rows.map((r) => norm(r[i])); }

function sameMultiset(a, b) {
  if (a.length !== b.length) return false;
  const m = new Map();
  for (const x of a) m.set(x, (m.get(x) || 0) + 1);
  for (const x of b) {
    const n = m.get(x);
    if (!n) return false;
    m.set(x, n - 1);
  }
  return true;
}

/**
 * Map each expected column to a distinct actual column with the same values.
 * Returns an index array (expected i -> actual j) or null. Backtracking, but
 * challenge results have a handful of columns, so it is instant.
 */
function matchColumns(exp, act) {
  const n = exp.columns.length;
  if (act.columns.length !== n) return null;
  const expCols = [...Array(n)].map((_, i) => column(exp.rows, i).map(key));
  const actCols = [...Array(n)].map((_, j) => column(act.rows, j).map(key));
  const cand = expCols.map((ec) => actCols.map((ac, j) => (sameMultiset(ec, ac) ? j : -1)).filter((j) => j >= 0));
  const used = new Set();
  const out = [];
  const go = (i) => {
    if (i === n) return true;
    // Prefer the same position first, so identical layouts map straight through.
    const order = [...cand[i]].sort((a, b) => (a === i ? -1 : b === i ? 1 : 0));
    for (const j of order) {
      if (used.has(j)) continue;
      used.add(j); out[i] = j;
      if (go(i + 1)) return true;
      used.delete(j);
    }
    return false;
  };
  return go(0) ? out : null;
}

function fmtRow(row) {
  return '(' + row.map((v) => (v === null ? 'NULL' : typeof v === 'string' ? `'${v}'` : String(v))).join(', ') + ')';
}

/**
 * @param {{columns:string[], rows:any[][]}} exp   the model answer's result
 * @param {{columns:string[], rows:any[][]}} act   hers
 * @param {object} [opts]
 *   orderBy:   [{ col: 'ExtendedPrice', dir: 'asc'|'desc' }]  — expected column names
 *   columns:   ['OrderSum']  — aliases that must appear (case-insensitive)
 *   columnOrder: true        — columns must be in the model answer's order
 * @returns {{ ok: boolean, reason: string }}
 */
export function compare(exp, act, opts = {}) {
  if (!act || !Array.isArray(act.columns)) return { ok: false, reason: 'The query returned no result set.' };
  if (!act.columns.length) return { ok: false, reason: 'The query ran but returned no columns — is it a SELECT?' };

  if (opts.columns && opts.columns.length) {
    const have = act.columns.map((c) => String(c).toLowerCase());
    const miss = opts.columns.filter((c) => !have.includes(c.toLowerCase()));
    if (miss.length) return { ok: false, reason: `Name the result column${miss.length > 1 ? 's' : ''} ${miss.join(', ')} (use AS).` };
  }
  if (act.columns.length !== exp.columns.length) {
    return { ok: false, reason: `Expected ${exp.columns.length} column${exp.columns.length === 1 ? '' : 's'}, got ${act.columns.length}.` };
  }
  if (act.rows.length !== exp.rows.length) {
    const hint = act.rows.length > exp.rows.length && new Set(act.rows.map(rowKey)).size < act.rows.length
      ? ' (Duplicates? Consider DISTINCT.)' : '';
    return { ok: false, reason: `Expected ${exp.rows.length} row${exp.rows.length === 1 ? '' : 's'}, got ${act.rows.length}.${hint}` };
  }

  const map = opts.columnOrder ? exp.columns.map((_, i) => i) : matchColumns(exp, act);
  const reordered = map ? act.rows.map((r) => map.map((j) => norm(r[j]))) : null;
  const expN = exp.rows.map((r) => r.map(norm));

  if (!reordered || !sameMultiset(expN.map(rowKey), reordered.map(rowKey))) {
    // Name one concrete difference, in the model answer's column order.
    const base = reordered || act.rows.map((r) => r.map(norm));
    const have = new Map();
    for (const r of base) have.set(rowKey(r), (have.get(rowKey(r)) || 0) + 1);
    const missing = expN.find((r) => {
      const k = rowKey(r); const n = have.get(k);
      if (!n) return true;
      have.set(k, n - 1); return false;
    });
    return { ok: false, reason: missing ? `Missing a row like ${fmtRow(missing)}.` : 'The rows do not match the expected result.' };
  }

  // ORDER BY keys are checked LEXICOGRAPHICALLY: a secondary key only has to
  // be sorted within ties of the first, exactly like the SQL clause.
  const keys = (opts.orderBy || [])
    .map((o) => ({ i: exp.columns.findIndex((c) => String(c).toLowerCase() === String(o.col).toLowerCase()), dir: o.dir || 'asc', col: o.col }))
    .filter((k) => k.i >= 0);
  if (keys.length) {
    const cmp = (a, b) => (a === null || b === null ? 0
      : typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)));
    for (let r = 1; r < reordered.length; r++) {
      for (const k of keys) {
        const c = cmp(reordered[r - 1][k.i], reordered[r][k.i]) * (k.dir === 'desc' ? -1 : 1);
        if (c < 0) break;                 // correctly ordered on this key; later keys irrelevant
        if (c > 0) {
          const want = keys.map((x) => `${x.col} ${x.dir.toUpperCase()}`).join(', ');
          return { ok: false, reason: `Right rows, wrong order — sort by ${want}.` };
        }
      }
    }
  }
  return { ok: true, reason: 'Correct!' };
}

export default { compare };
