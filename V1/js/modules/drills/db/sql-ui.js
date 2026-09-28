/* ============================================================================
 * StudyOS drills — SQL challenges & sandbox UI
 * ============================================================================
 * mode 'challenges': list → challenge (write, Run to see rows, Check to grade)
 * mode 'sandbox':    free-play SQLite on the Cape Codd tables
 *
 * Every Check runs on a FRESH database, so a stray DELETE in one attempt can
 * never corrupt the next. The sandbox keeps one database until "Reset", so
 * INSERT/UPDATE experiments persist while she plays.
 *
 * Scoring (ctx.record): the FIRST Check of a challenge in a sitting is the
 * attempt that counts — a miss there feeds weak spots. Solving it afterwards
 * earns the XP but the miss stands, because it was one.
 * ------------------------------------------------------------------------- */

import * as engine from './sqlengine.js';
import { compare } from './grade.js';
import { CHALLENGES } from './challenges.js';
import { DATASETS } from './datasets.js';

const SOLVED_KEY = 'studyos_sql_solved';
const solved = () => { try { return new Set(JSON.parse(localStorage.getItem(SOLVED_KEY) || '[]')); } catch (e) { return new Set(); } };
const markSolved = (id) => { const s = solved(); s.add(id); try { localStorage.setItem(SOLVED_KEY, JSON.stringify([...s])); } catch (e) {} };

function table(res, esc, max = 200) {
  if (!res || !res.columns || !res.columns.length) return '<div class="sp-muted" style="font-size:12px">No rows returned.</div>';
  const rows = res.rows.slice(0, max);
  return `<div class="sp-scroll"><table class="sp-table">
    <tr>${res.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>
    ${rows.map((r) => `<tr>${r.map((v) => `<td>${v === null ? '<span class="sp-muted">NULL</span>' : esc(v)}</td>`).join('')}</tr>`).join('')}
  </table></div>
  <div class="sp-muted" style="font-size:11px;font-family:var(--mono)">${res.rows.length} row${res.rows.length === 1 ? '' : 's'}${res.rows.length > max ? ` (first ${max} shown)` : ''}</div>`;
}

async function schemaHtml(esc, dataset = 'capecodd') {
  const db = await engine.openDataset(dataset);
  try {
    return DATASETS[dataset].tables.map((t) => {
      const cols = db.exec(`PRAGMA table_info(${t})`)[0].values;
      return `<div style="margin-bottom:6px"><button class="sp-chip" data-peek="${esc(t)}" style="min-height:26px;padding:2px 9px">${esc(t)}</button>
        <span class="sp-muted" style="font-family:var(--mono);font-size:11px">${cols.map((c) => (c[5] ? `<u>${esc(c[1])}</u>` : esc(c[1]))).join(', ')}</span></div>`;
    }).join('');
  } finally { db.close(); }
}

function wirePeek(root, esc, out) {
  root.querySelectorAll('[data-peek]').forEach((b) => {
    b.onclick = async () => {
      const db = await engine.openDataset('capecodd');
      try { out.innerHTML = `<div class="sp-muted" style="font-size:11px;font-family:var(--mono)">${esc(b.dataset.peek)}</div>` + table(engine.run(db, `SELECT * FROM ${b.dataset.peek}`), esc); }
      finally { db.close(); }
    };
  });
}

// ── Challenges ──────────────────────────────────────────────────────────────
function mountChallenges(host, ctx) {
  const { esc } = ctx;
  let alive = true;

  const list = () => {
    const done = solved();
    const byTopic = new Map();
    for (const c of CHALLENGES) { if (!byTopic.has(c.topic)) byTopic.set(c.topic, []); byTopic.get(c.topic).push(c); }
    host.innerHTML = `
      <div class="sp-panel" style="font-size:13px">
        ${done.size} of ${CHALLENGES.length} solved. Each is graded by running your query and comparing the rows —
        any correct query passes. SQL Server's <code>TOP n</code> works; use <code>||</code> to join strings.
      </div>
      <div class="sp-list">
        ${[...byTopic].map(([topic, cs]) => cs.map((c) => `
          <div class="sp-li" data-ch="${esc(c.id)}">
            <span>${done.has(c.id) ? '<span class="sp-ok">✓</span>' : '<span class="sp-muted">○</span>'}</span>
            <span>${esc(c.prompt)}</span><span class="sp-tag">${esc(topic)}</span>
          </div>`).join('')).join('')}
      </div>`;
    host.querySelectorAll('[data-ch]').forEach((el) => { el.onclick = () => open(el.dataset.ch); });
  };

  const attempts = new Map();          // id -> { checks, recordedMiss }
  const open = async (id) => {
    const idx = CHALLENGES.findIndex((c) => c.id === id);
    const ch = CHALLENGES[idx];
    if (!ch) return list();
    const st = attempts.get(id) || { checks: 0, recordedMiss: false, hints: 0 };
    attempts.set(id, st);
    host.innerHTML = `
      <div class="sp-row" style="margin-bottom:8px">
        <button class="sp-btn" data-list>All challenges</button>
        <span class="sp-muted" style="font-size:12px;font-family:var(--mono)">${idx + 1} / ${CHALLENGES.length} · ${esc(ch.topic)}</span>
        <span style="margin-left:auto" class="sp-row">
          <button class="sp-btn" data-prev ${idx === 0 ? 'disabled' : ''}>‹</button>
          <button class="sp-btn" data-next ${idx === CHALLENGES.length - 1 ? 'disabled' : ''}>›</button>
        </span>
      </div>
      <div class="sp-panel"><div style="font-size:15px;line-height:1.5">${esc(ch.prompt)}</div>
        <details style="margin-top:10px"><summary class="sp-muted" style="cursor:pointer;font-size:12px">Tables (tap one to see its rows)</summary>
          <div data-schema style="margin-top:8px">Loading…</div><div data-peekout></div></details>
      </div>
      <textarea class="sp-textarea" data-sql placeholder="SELECT …   (Ctrl+Enter to run)" spellcheck="false"></textarea>
      <div class="sp-row" style="margin:8px 0">
        <button class="sp-btn" data-run>Run</button>
        <button class="sp-btn primary" data-check>Check</button>
        <button class="sp-btn" data-hint>Hint</button>
        <button class="sp-btn" data-show style="display:none">Show answer</button>
      </div>
      <div data-hints></div>
      <div data-feedback style="font-size:14px;margin:6px 0"></div>
      <div data-out></div>`;

    const q = (sel) => host.querySelector(sel);
    const ta = q('[data-sql]');
    const out = q('[data-out]');
    const fb = q('[data-feedback]');
    q('[data-list]').onclick = list;
    q('[data-prev]').onclick = () => open(CHALLENGES[idx - 1].id);
    q('[data-next]').onclick = () => open(CHALLENGES[idx + 1].id);
    schemaHtml(esc).then((h) => { if (!alive) return; q('[data-schema]').innerHTML = h; wirePeek(host, esc, q('[data-peekout]')); }).catch(() => {});

    const paintHints = () => {
      q('[data-hints]').innerHTML = ch.hints.slice(0, st.hints).map((h, i) => `<div class="sp-hint">Hint ${i + 1}: ${esc(h)}</div>`).join('');
      q('[data-hint]').textContent = st.hints >= ch.hints.length ? 'No more hints' : `Hint (${ch.hints.length - st.hints} left)`;
      q('[data-hint]').disabled = st.hints >= ch.hints.length;
      q('[data-show]').style.display = st.checks >= 3 || st.hints >= ch.hints.length ? '' : 'none';
    };
    paintHints();

    const runMine = async () => {
      const db = await engine.openDataset(ch.dataset);
      try { return engine.run(db, ta.value); } finally { db.close(); }
    };
    q('[data-run]').onclick = async () => {
      fb.textContent = '';
      try { const r = await runMine(); out.innerHTML = (r.notes.length ? `<div class="sp-hint">${r.notes.map(esc).join(' ')}</div>` : '') + table(r, esc); }
      catch (e) { out.innerHTML = `<div class="sp-bad" style="font-family:var(--mono);font-size:12px">${esc(e.message)}</div>`; }
    };
    q('[data-check]').onclick = async () => {
      let mine;
      try { mine = await runMine(); }
      catch (e) { fb.innerHTML = `<span class="sp-bad">${esc(e.message)}</span>`; return; }
      const db = await engine.openDataset(ch.dataset);
      let expected;
      try { expected = engine.run(db, ch.solution); } finally { db.close(); }
      const g = compare(expected, mine, ch);
      st.checks++;
      out.innerHTML = table(mine, esc);
      const difficulty = idx < 12 ? 1 : idx < 20 ? 2 : 3;
      if (g.ok) {
        fb.innerHTML = `<span class="sp-ok">✓ ${esc(g.reason)}</span>`;
        // Once per challenge per sitting: the first Check, or the solve that
        // follows a recorded miss (XP for getting there; the miss stands).
        if (!st.solved) { st.solved = true; ctx.record({ topic: 'SQL: ' + ch.topic, correct: true, difficulty }); }
        markSolved(ch.id);
      } else {
        fb.innerHTML = `<span class="sp-bad">✗ ${esc(g.reason)}</span>`;
        if (!st.recordedMiss) { st.recordedMiss = true; ctx.record({ topic: 'SQL: ' + ch.topic, correct: false, difficulty }); }
        if (st.hints < ch.hints.length) st.hints++;
      }
      paintHints();
    };
    q('[data-hint]').onclick = () => { if (st.hints < ch.hints.length) st.hints++; paintHints(); };
    q('[data-show]').onclick = () => {
      out.innerHTML = `<div class="sp-muted" style="font-size:12px;margin-bottom:4px">One correct answer:</div><div class="sp-code">${esc(ch.solution)}</div>`;
    };
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); q('[data-run]').click(); }
    });
    ta.focus();
  };

  list();
  // Warm the engine while she reads the list.
  engine.loadSql().catch((e) => {
    if (alive) host.insertAdjacentHTML('afterbegin', `<div class="sp-panel sp-bad">Could not load the SQL engine: ${esc(e.message)}</div>`);
  });
  return () => { alive = false; };
}

// ── Sandbox ─────────────────────────────────────────────────────────────────
function mountSandbox(host, ctx) {
  const { esc } = ctx;
  let db = null;
  let alive = true;
  host.innerHTML = `
    <div class="sp-panel" style="font-size:13px">
      SQLite in your browser with the Cape Codd tables. Anything goes — INSERT, UPDATE, CREATE TABLE — and
      <b>Reset</b> puts the data back. <details style="margin-top:8px"><summary class="sp-muted" style="cursor:pointer;font-size:12px">Tables</summary>
      <div data-schema style="margin-top:8px">Loading…</div><div data-peekout></div></details>
    </div>
    <textarea class="sp-textarea" data-sql spellcheck="false" placeholder="SELECT * FROM SKU_DATA;   (Ctrl+Enter to run)"></textarea>
    <div class="sp-row" style="margin:8px 0"><button class="sp-btn primary" data-run>Run</button><button class="sp-btn" data-reset>Reset data</button></div>
    <div data-out></div>`;
  const q = (s) => host.querySelector(s);
  const fresh = async () => { if (db) db.close(); db = await engine.openDataset('capecodd'); };
  fresh().then(() => schemaHtml(esc)).then((h) => { if (!alive) return; q('[data-schema]').innerHTML = h; wirePeek(host, esc, q('[data-peekout]')); })
    .catch((e) => { q('[data-out]').innerHTML = `<div class="sp-bad">${esc(e.message)}</div>`; });
  q('[data-run]').onclick = async () => {
    if (!db) await fresh();
    try {
      const r = engine.run(db, q('[data-sql]').value);
      q('[data-out]').innerHTML = (r.notes.length ? `<div class="sp-hint">${r.notes.map(esc).join(' ')}</div>` : '') + table(r, esc);
    } catch (e) { q('[data-out]').innerHTML = `<div class="sp-bad" style="font-family:var(--mono);font-size:12px">${esc(e.message)}</div>`; }
  };
  q('[data-reset]').onclick = async () => { await fresh(); q('[data-out]').innerHTML = '<div class="sp-muted" style="font-size:12px">Data reset.</div>'; };
  q('[data-sql]').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); q('[data-run]').click(); }
  });
  return () => { alive = false; if (db) { db.close(); db = null; } };
}

export function mount(host, ctx) {
  return ctx.mode === 'sandbox' ? mountSandbox(host, ctx) : mountChallenges(host, ctx);
}

export default { mount };
