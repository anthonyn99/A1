/* ============================================================================
 * StudyOS drills — relational algebra step-through
 * ============================================================================
 * Small tables she can see in full; an expression evaluated one operator at a
 * time, innermost first. Before each step she PREDICTS how many rows it will
 * produce (scored), then sees the actual intermediate table. At the end: pick
 * the SQL that computes the same thing.
 *
 * The evaluator is real (evaluate() below, pinned by test-ra.mjs), so every
 * intermediate table and row count is computed, not typed in.
 * ------------------------------------------------------------------------- */

export const TABLES = {
  SKU: {
    columns: ['SKU', 'Dept', 'Buyer'],
    rows: [[100100, 'Water', 'Pete'], [101100, 'Water', 'Nancy'], [201000, 'Camping', 'Cindy'],
           [202000, 'Camping', 'Cindy'], [301000, 'Climbing', 'Jerry']],
  },
  BUYER: {
    columns: ['Buyer', 'Position'],
    rows: [['Pete', 'Buyer 3'], ['Nancy', 'Buyer 1'], ['Cindy', 'Buyer 2'], ['Jerry', 'Buyer 1'], ['Mary', 'Manager']],
  },
  LINE: {
    columns: ['OrderNo', 'SKU', 'Qty'],
    rows: [[1000, 201000, 1], [1000, 202000, 1], [2000, 101100, 4], [3000, 100100, 1], [3000, 101100, 2]],
  },
};

const CMP = { '=': (a, b) => a === b, '<>': (a, b) => a !== b, '>': (a, b) => a > b, '<': (a, b) => a < b, '>=': (a, b) => a >= b };

export function label(e) {
  switch (e.op) {
    case 'rel': return e.name;
    case 'select': return `σ[${e.col} ${e.cmp} ${typeof e.val === 'string' ? `'${e.val}'` : e.val}](${label(e.child)})`;
    case 'project': return `π[${e.cols.join(', ')}](${label(e.child)})`;
    case 'join': return `(${label(e.left)} ⋈ ${label(e.right)})`;
    case 'union': return `(${label(e.left)} ∪ ${label(e.right)})`;
    case 'diff': return `(${label(e.left)} − ${label(e.right)})`;
    default: return '?';
  }
}

const dedupe = (rows) => {
  const seen = new Set();
  return rows.filter((r) => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; });
};

/** Evaluate an expression; returns { columns, rows } with SET semantics. */
export function evaluate(e, tables = TABLES) {
  switch (e.op) {
    case 'rel': return { columns: tables[e.name].columns.slice(), rows: tables[e.name].rows.map((r) => r.slice()) };
    case 'select': {
      const t = evaluate(e.child, tables);
      const i = t.columns.indexOf(e.col);
      return { columns: t.columns, rows: t.rows.filter((r) => CMP[e.cmp](r[i], e.val)) };
    }
    case 'project': {
      const t = evaluate(e.child, tables);
      const idx = e.cols.map((c) => t.columns.indexOf(c));
      return { columns: e.cols.slice(), rows: dedupe(t.rows.map((r) => idx.map((i) => r[i]))) };
    }
    case 'join': {
      const l = evaluate(e.left, tables), r = evaluate(e.right, tables);
      const common = l.columns.filter((c) => r.columns.includes(c));
      const rOnly = r.columns.filter((c) => !common.includes(c));
      const rows = [];
      for (const a of l.rows) {
        for (const b of r.rows) {
          if (common.every((c) => a[l.columns.indexOf(c)] === b[r.columns.indexOf(c)])) {
            rows.push([...a, ...rOnly.map((c) => b[r.columns.indexOf(c)])]);
          }
        }
      }
      return { columns: [...l.columns, ...rOnly], rows };
    }
    case 'union': case 'diff': {
      const l = evaluate(e.left, tables), r = evaluate(e.right, tables);
      const rk = new Set(r.rows.map((x) => JSON.stringify(x)));
      return e.op === 'union'
        ? { columns: l.columns, rows: dedupe([...l.rows, ...r.rows]) }
        : { columns: l.columns, rows: l.rows.filter((x) => !rk.has(JSON.stringify(x))) };
    }
    default: throw new Error('unknown op ' + e.op);
  }
}

/** Post-order list of the non-leaf steps. */
export function steps(e) {
  const out = [];
  const walk = (n) => {
    if (n.child) walk(n.child);
    if (n.left) walk(n.left);
    if (n.right) walk(n.right);
    if (n.op !== 'rel') out.push(n);
  };
  walk(e);
  return out;
}

const rel = (name) => ({ op: 'rel', name });
const sel = (col, cmp, val, child) => ({ op: 'select', col, cmp, val, child });
const proj = (cols, child) => ({ op: 'project', cols, child });
const join = (left, right) => ({ op: 'join', left, right });

export const EXERCISES = [
  { title: 'Selection', topic: 'σ select', expr: sel('Dept', '=', 'Camping', rel('SKU')),
    sql: ["SELECT * FROM SKU WHERE Dept = 'Camping';", "SELECT Dept FROM SKU WHERE Dept = 'Camping';", "SELECT * FROM SKU GROUP BY Dept;"] },
  { title: 'Projection removes duplicates', topic: 'π project', expr: proj(['Dept'], rel('SKU')),
    sql: ['SELECT DISTINCT Dept FROM SKU;', 'SELECT Dept FROM SKU;', 'SELECT COUNT(Dept) FROM SKU;'] },
  { title: 'Select, then project', topic: 'π project', expr: proj(['Buyer'], sel('Dept', '=', 'Water', rel('SKU'))),
    sql: ["SELECT DISTINCT Buyer FROM SKU WHERE Dept = 'Water';", "SELECT Buyer, Dept FROM SKU WHERE Dept = 'Water';", "SELECT DISTINCT Buyer FROM SKU;"] },
  { title: 'Natural join', topic: '⋈ join', expr: join(rel('SKU'), rel('BUYER')),
    sql: ['SELECT * FROM SKU JOIN BUYER ON SKU.Buyer = BUYER.Buyer;', 'SELECT * FROM SKU, BUYER;', 'SELECT * FROM SKU LEFT JOIN BUYER ON SKU.Buyer = BUYER.Buyer;'] },
  { title: 'Join, then select', topic: '⋈ join', expr: sel('Position', '=', 'Buyer 1', join(rel('SKU'), rel('BUYER'))),
    sql: ["SELECT * FROM SKU JOIN BUYER ON SKU.Buyer = BUYER.Buyer WHERE Position = 'Buyer 1';", "SELECT * FROM BUYER WHERE Position = 'Buyer 1';", "SELECT * FROM SKU WHERE Buyer = 'Buyer 1';"] },
  { title: 'Which buyers sold nothing?', topic: '− difference', expr: { op: 'diff', left: proj(['Buyer'], rel('BUYER')), right: proj(['Buyer'], join(rel('SKU'), rel('LINE'))) },
    sql: ['SELECT Buyer FROM BUYER WHERE Buyer NOT IN (SELECT Buyer FROM SKU JOIN LINE ON SKU.SKU = LINE.SKU);',
          'SELECT Buyer FROM BUYER WHERE Buyer IN (SELECT Buyer FROM SKU);', 'SELECT Buyer FROM SKU JOIN LINE ON SKU.SKU = LINE.SKU;'] },
  { title: 'Three-way join, then project', topic: '⋈ join', expr: proj(['OrderNo', 'Position'], join(join(rel('LINE'), rel('SKU')), rel('BUYER'))),
    sql: ['SELECT DISTINCT OrderNo, Position FROM LINE JOIN SKU ON LINE.SKU = SKU.SKU JOIN BUYER ON SKU.Buyer = BUYER.Buyer;',
          'SELECT OrderNo, Position FROM LINE, BUYER;', 'SELECT DISTINCT OrderNo FROM LINE JOIN SKU ON LINE.SKU = SKU.SKU;'] },
  { title: 'Union', topic: '∪ union', expr: { op: 'union', left: proj(['Buyer'], sel('Dept', '=', 'Water', rel('SKU'))), right: proj(['Buyer'], sel('Position', '=', 'Buyer 1', rel('BUYER'))) },
    sql: ["SELECT Buyer FROM SKU WHERE Dept = 'Water' UNION SELECT Buyer FROM BUYER WHERE Position = 'Buyer 1';",
          "SELECT Buyer FROM SKU WHERE Dept = 'Water' AND Buyer IN (SELECT Buyer FROM BUYER WHERE Position = 'Buyer 1');", "SELECT Buyer FROM BUYER;"] },
];

function tableHtml(t, esc, title) {
  return `<div style="display:inline-block;vertical-align:top;margin:0 12px 10px 0">
    ${title ? `<div class="sp-muted" style="font-family:var(--mono);font-size:11px">${esc(title)}</div>` : ''}
    <table class="sp-table"><tr>${t.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>
    ${t.rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${t.columns.length}" class="sp-muted">(empty)</td></tr>`}
    </table></div>`;
}

const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

export function mount(host, ctx) {
  const { esc } = ctx;
  let ex = 0;
  const open = (i) => {
    ex = (i + EXERCISES.length) % EXERCISES.length;
    const e = EXERCISES[ex];
    const st = steps(e.expr);
    const used = [...new Set(JSON.stringify(e.expr).match(/"name":"(\w+)"/g).map((m) => m.slice(8, -1)))];
    let k = 0;
    host.innerHTML = `
      <div class="sp-row" style="margin-bottom:8px"><span class="sp-muted" style="font-family:var(--mono);font-size:12px">${ex + 1} / ${EXERCISES.length} · ${esc(e.title)}</span>
        <span style="margin-left:auto" class="sp-row"><button class="sp-btn" data-prev>‹</button><button class="sp-btn" data-next>›</button></span></div>
      <div class="sp-panel"><div class="sp-code" style="white-space:normal;font-size:14px">${esc(label(e.expr))}</div>
        <div class="sp-scroll" style="margin-top:10px">${used.map((n) => tableHtml(TABLES[n], esc, n)).join('')}</div></div>
      <div data-steps></div><div data-q></div>`;
    host.querySelector('[data-prev]').onclick = () => open(ex - 1);
    host.querySelector('[data-next]').onclick = () => open(ex + 1);
    const stepsEl = host.querySelector('[data-steps]');
    const qEl = host.querySelector('[data-q]');

    const ask = () => {
      if (k >= st.length) return finalQ();
      const node = st[k];
      const truth = evaluate(node).rows.length;
      const opts = shuffle([...new Set([truth, truth + 1, Math.max(0, truth - 1), truth + 2, truth * 2 || 3])].slice(0, 4));
      qEl.innerHTML = `<div class="sp-panel"><div style="margin-bottom:8px">Step ${k + 1}: <code>${esc(label(node))}</code><br>How many rows will it produce?</div>
        <div class="sp-row">${opts.map((o) => `<button class="sp-btn" data-n="${o}">${o}</button>`).join('')}</div></div>`;
      qEl.querySelectorAll('[data-n]').forEach((b) => {
        b.onclick = () => {
          const ok = Number(b.dataset.n) === truth;
          ctx.record({ topic: 'Relational algebra: ' + e.topic, correct: ok, difficulty: 1 });
          stepsEl.insertAdjacentHTML('beforeend', `<div class="sp-panel"><div class="${ok ? 'sp-ok' : 'sp-bad'}" style="font-size:13px;margin-bottom:6px">${ok ? '✓' : '✗'} ${truth} row${truth === 1 ? '' : 's'} — <code>${esc(label(node))}</code></div>
            <div class="sp-scroll">${tableHtml(evaluate(node), esc)}</div></div>`);
          k++;
          ask();
        };
      });
    };
    const finalQ = () => {
      const choices = shuffle(e.sql);
      qEl.innerHTML = `<div class="sp-panel"><div style="margin-bottom:8px">Which SQL computes the same result?</div>
        <div class="sp-choices">${choices.map((s) => `<button class="sp-choice" data-s="${esc(s)}"><code>${esc(s)}</code></button>`).join('')}</div>
        <div data-fb style="margin-top:8px"></div></div>`;
      qEl.querySelectorAll('[data-s]').forEach((b) => {
        b.onclick = () => {
          const ok = b.dataset.s === e.sql[0];
          ctx.record({ topic: 'Relational algebra → SQL', correct: ok, difficulty: 2 });
          qEl.querySelectorAll('[data-s]').forEach((x) => { x.disabled = true; if (x.dataset.s === e.sql[0]) x.classList.add('right'); else if (x === b) x.classList.add('wrong'); });
          qEl.querySelector('[data-fb]').innerHTML = `<button class="sp-btn primary" data-go>Next expression</button>`;
          qEl.querySelector('[data-go]').onclick = () => open(ex + 1);
        };
      });
    };
    ask();
  };
  open(0);
  return null;
}

export default { mount, evaluate, steps, label, EXERCISES, TABLES };
