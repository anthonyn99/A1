/* ============================================================================
 * StudyOS — Practice  (engagement upgrade Phases 2–5, the drills hub)
 * ============================================================================
 * The Practice view: every way to study actively, in one place.
 *
 *   per class   Quiz · Weak spots · Explain it back · Mock exam · Boss fights
 *   Databases   SQL challenges · SQL sandbox · Keys & closures ·
 *               Normalization · Relational algebra · ER → schema
 *   Data Str.   Visualizers (heap, AVL, hash, graph, sorting, stack/queue,
 *               linked list) · Big-O rapid fire · Trace the code · Python → Java
 *
 * ── THE DRILL CONTRACT ────────────────────────────────────────────────────
 * A drill module exports mount(host, ctx) and returns a cleanup function.
 * ctx gives it:
 *   classId / className   which of her classes the drill counts toward
 *   record({topic, correct, difficulty})   one answered item: logs a miss
 *                         against the topic (weak spots) and earns XP
 *   back()                return to the hub
 *   mode                  the registry entry's mode (one module, many drills)
 *
 * ── A SITTING IS ONE SESSION ──────────────────────────────────────────────
 * Individual drill items are seconds long, under the 60-second floor that
 * keeps abandoned timers out of the streak. So a whole sitting — from opening
 * a drill to leaving it — is logged as ONE session carrying its XP, items and
 * accuracy.
 *
 * ── WHICH CLASS ───────────────────────────────────────────────────────────
 * Course drills belong to a course, not a class id. The class is found by
 * name/code (/data struct/i, /database/i) and can be changed in the drill's
 * header; the choice is remembered per device.
 * ------------------------------------------------------------------------- */

import { store } from './store.js';
import * as progress from './progress.js';
import * as xp from './xp.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const COURSES = {
  db: { name: 'Databases', match: /data\s*base|\bdb\b|sql|3410/i },
  ds: { name: 'Data Structures', match: /data\s*struct|algorithm|\bds\b/i },
};

/* Every drill. `available` lets a later phase's module be listed only once it
 * exists, so the hub never offers a button that does nothing. */
export const DRILLS = [
  { id: 'sql', course: 'db', title: 'SQL challenges', blurb: 'Write queries, auto-graded on the Cape Codd database', load: () => import('./drills/db/sql-ui.js'), mode: 'challenges' },
  { id: 'sandbox', course: 'db', title: 'SQL sandbox', blurb: 'Free-play SQLite with the Cape Codd tables', load: () => import('./drills/db/sql-ui.js'), mode: 'sandbox' },
  { id: 'keys', course: 'db', title: 'Keys & closures', blurb: 'Attribute closures and candidate keys, endless questions', load: () => import('./drills/db/fd-ui.js'), mode: 'keys' },
  { id: 'normalize', course: 'db', title: 'Normalization trainer', blurb: 'Name the normal form, then decompose to BCNF', load: () => import('./drills/db/fd-ui.js'), mode: 'normalize' },
  { id: 'ra', course: 'db', title: 'Relational algebra', blurb: 'σ, π, ⋈ step by step on tables you can see', load: () => import('./drills/db/ra-ui.js'), mode: 'ra' },
  { id: 'er', course: 'db', title: 'ER → schema', blurb: 'Turn an ER description into tables with the right keys', load: () => import('./drills/db/er-ui.js'), mode: 'er' },

  { id: 'viz-heap', course: 'ds', title: 'Heap', blurb: 'Sift-up and sift-down, array and tree', load: () => import('./drills/ds/viz-ui.js'), mode: 'heap' },
  { id: 'viz-avl', course: 'ds', title: 'AVL tree', blurb: 'Inserts with LL / RR / LR / RL rotations', load: () => import('./drills/ds/viz-ui.js'), mode: 'avl' },
  { id: 'viz-hash', course: 'ds', title: 'Hash table', blurb: 'Chaining, linear and quadratic probing', load: () => import('./drills/ds/viz-ui.js'), mode: 'hash' },
  { id: 'viz-graph', course: 'ds', title: 'BFS / DFS', blurb: 'Traverse a graph you can edit', load: () => import('./drills/ds/viz-ui.js'), mode: 'graph' },
  { id: 'viz-sort', course: 'ds', title: 'Sorting', blurb: 'Bubble, insertion, selection, merge, quick', load: () => import('./drills/ds/viz-ui.js'), mode: 'sort' },
  { id: 'viz-stackqueue', course: 'ds', title: 'Stack & queue', blurb: 'push / pop / enqueue / dequeue', load: () => import('./drills/ds/viz-ui.js'), mode: 'stackqueue' },
  { id: 'viz-list', course: 'ds', title: 'Linked list', blurb: 'Insert and delete with pointers', load: () => import('./drills/ds/viz-ui.js'), mode: 'list' },
  { id: 'bigo', course: 'ds', title: 'Big-O rapid fire', blurb: 'Snippet → complexity, against the clock', load: () => import('./drills/ds/bigo-ui.js'), mode: 'bigo' },
  { id: 'trace', course: 'ds', title: 'Trace the code', blurb: '“What does this print?”', load: () => import('./drills/ds/trace-ui.js'), mode: 'trace' },
  { id: 'translate', course: 'ds', title: 'Python → Java', blurb: 'Rewrite it in Java; graded against a rubric', load: () => import('./drills/ds/translate-ui.js'), mode: 'translate' },
];

/* Per-class tools. Resolved lazily from window.SOS so each lights up when its
 * phase has shipped. */
export const CLASS_TOOLS = [
  { id: 'quiz', title: 'Quiz', icon: '❓', ready: () => !!(window.SOS.quizUi), open: (classId) => window.SOS.quizUi.openQuizSetup(classId) },
  { id: 'weak', title: 'Weak spots', icon: '🎯', ready: () => !!(window.SOS.practice && window.SOS.practice.startWeakSpots), open: (classId) => startWeakSpots(classId) },
  { id: 'explain', title: 'Explain it back', icon: '🗣', ready: () => !!(window.SOS.explain), open: (classId) => window.SOS.explain.open(classId) },
  { id: 'mock', title: 'Mock exam', icon: '📝', ready: () => !!(window.SOS.mock), open: (classId) => window.SOS.mock.openSetup(classId) },
  { id: 'boss', title: 'Bosses & mastery', icon: '🐉', ready: () => !!(window.SOS.boss), open: (classId) => window.SOS.boss.openBossList(classId) },
];

// ── Course → class ──────────────────────────────────────────────────────────
const PREF = (course) => 'studyos_drill_class_' + course;

export function classForCourse(course) {
  const classes = store.getClasses().filter((c) => c && c.id);
  let saved = '';
  try { saved = localStorage.getItem(PREF(course)) || ''; } catch (e) {}
  const bySaved = classes.find((c) => c.id === saved);
  if (bySaved) return bySaved;
  const re = COURSES[course] && COURSES[course].match;
  return (re && classes.find((c) => re.test(`${c.name || ''} ${c.code || ''}`))) || null;
}

export function setClassForCourse(course, classId) {
  try { localStorage.setItem(PREF(course), classId); } catch (e) {}
}

// ── Styles (the view lives inside #study-root, so app tokens apply) ─────────
function styleOnce() {
  if (document.getElementById('sos-practice-css')) return;
  const el = document.createElement('style');
  el.id = 'sos-practice-css';
  el.textContent = `
.sp-wrap { max-width: 1100px; margin: 0 auto; }
.sp-h2 { font-family:'Lora',serif; font-size:18px; margin:22px 0 10px; display:flex; align-items:center; gap:8px; }
.sp-h2 small { font-family:var(--mono); font-size:11px; color:var(--text3); font-weight:400; }
.sp-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:10px; }
.sp-card { background:var(--bg3); border:1px solid var(--border); border-radius:6px; padding:12px 14px; cursor:pointer;
  text-align:left; color:var(--text); font-family:inherit; transition:border-color .15s, transform .15s; min-height:74px; }
.sp-card:hover { border-color:var(--accent); transform:translateY(-1px); }
.sp-card b { display:block; font-size:14px; margin-bottom:4px; }
.sp-card span { font-size:12px; color:var(--text3); line-height:1.4; }
.sp-card[disabled] { opacity:.45; cursor:default; transform:none; }
.sp-classrow { display:flex; flex-wrap:wrap; gap:8px; align-items:center; background:var(--bg3); border:1px solid var(--border);
  border-radius:6px; padding:10px 12px; margin-bottom:8px; }
.sp-classrow .sp-cname { font-weight:700; margin-right:auto; display:flex; align-items:center; gap:8px; min-width:160px; }
.sp-dot { width:9px; height:9px; border-radius:2px; display:inline-block; }
.sp-chip { background:var(--bg4); border:1px solid var(--border); color:var(--text2); border-radius:14px; padding:5px 11px;
  font-size:12px; cursor:pointer; font-family:inherit; min-height:32px; }
.sp-chip:hover { border-color:var(--accent); color:var(--text); }
.sp-chip[disabled] { opacity:.4; cursor:default; }
.sp-top { display:flex; align-items:center; gap:10px; margin-bottom:14px; flex-wrap:wrap; }
.sp-back { background:none; border:1px solid var(--border); color:var(--text2); border-radius:4px; padding:6px 12px;
  cursor:pointer; font-family:var(--mono); font-size:12px; min-height:34px; }
.sp-title { font-family:'Lora',serif; font-size:19px; font-weight:700; margin-right:auto; }
.sp-for { font-family:var(--mono); font-size:11px; color:var(--text3); display:flex; align-items:center; gap:6px; }
.sp-for select { background:var(--bg3); color:var(--text); border:1px solid var(--border); border-radius:4px; padding:3px 6px; font-size:11px; }
.sp-score { font-family:var(--mono); font-size:12px; color:var(--text2); }
.sp-panel { background:var(--bg3); border:1px solid var(--border); border-radius:6px; padding:14px; margin-bottom:12px; }
.sp-btn { background:var(--bg4); border:1px solid var(--border); color:var(--text); border-radius:4px; padding:7px 14px;
  cursor:pointer; font-family:inherit; font-size:13px; min-height:36px; }
.sp-btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:700; }
.sp-btn:disabled { opacity:.45; cursor:default; }
.sp-ok { color:#8fd6ad; } .sp-bad { color:#ef9f9f; } .sp-muted { color:var(--text3); }
.sp-code { font-family:var(--mono); font-size:13px; background:var(--bg2); border:1px solid var(--border); border-radius:4px;
  padding:10px 12px; white-space:pre; overflow-x:auto; line-height:1.5; color:var(--text); }
.sp-textarea { width:100%; box-sizing:border-box; font-family:var(--mono); font-size:13px; background:var(--bg2); color:var(--text);
  border:1px solid var(--border); border-radius:4px; padding:10px; resize:vertical; min-height:110px; line-height:1.5; }
.sp-input { background:var(--bg2); color:var(--text); border:1px solid var(--border); border-radius:4px; padding:7px 10px;
  font-family:var(--mono); font-size:13px; min-height:34px; box-sizing:border-box; }
.sp-table { border-collapse:collapse; font-family:var(--mono); font-size:12px; margin:6px 0; }
.sp-table th, .sp-table td { border:1px solid var(--border); padding:4px 8px; text-align:left; white-space:nowrap; }
.sp-table th { background:var(--bg4); color:var(--text2); font-weight:600; }
.sp-scroll { overflow-x:auto; max-width:100%; }
.sp-choices { display:grid; gap:8px; }
.sp-choice { text-align:left; background:var(--bg2); border:1px solid var(--border); color:var(--text); border-radius:5px;
  padding:10px 12px; cursor:pointer; font-family:inherit; font-size:14px; min-height:44px; }
.sp-choice:hover:not(:disabled) { border-color:var(--accent); }
.sp-choice.right { border-color:#8fd6ad; background:rgba(143,214,173,.12); }
.sp-choice.wrong { border-color:#ef9f9f; background:rgba(239,159,159,.12); }
.sp-row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.sp-svg { width:100%; height:auto; display:block; background:var(--bg2); border:1px solid var(--border); border-radius:5px; }
.sp-hint { font-size:12px; color:#f0bd86; font-family:var(--mono); margin-top:6px; }
.sp-list { display:grid; gap:6px; }
.sp-li { display:flex; gap:10px; align-items:center; padding:8px 10px; border:1px solid var(--border); border-radius:5px;
  background:var(--bg2); cursor:pointer; font-size:13px; }
.sp-li:hover { border-color:var(--accent); }
.sp-li .sp-tag { font-family:var(--mono); font-size:10px; color:var(--text3); margin-left:auto; }
@media (max-width:700px) { .sp-grid { grid-template-columns:1fr 1fr; } .sp-card { min-height:64px; padding:10px; } }
`;
  document.head.appendChild(el);
}

// ── The hub ─────────────────────────────────────────────────────────────────
let _root = null;
let _cleanup = null;
let _sitting = null;

function host() {
  return document.getElementById('sos-practice-root');
}

export function render() {
  styleOnce();
  _root = host();
  if (!_root) return;
  endSitting();
  const classes = store.getClasses().filter((c) => c && c.id);
  const tools = CLASS_TOOLS.map((t) => ({ ...t, ok: (() => { try { return t.ready(); } catch (e) { return false; } })() }));
  const lv = xp.levelInfo();

  const courseBlock = (course) => {
    const cls = classForCourse(course);
    const list = DRILLS.filter((d) => d.course === course);
    return `
      <div class="sp-h2">${esc(COURSES[course].name)} drills
        <small>${cls ? 'counts toward ' + esc(cls.name) : 'pick the class in any drill'}</small></div>
      <div class="sp-grid">
        ${list.map((d) => `<button class="sp-card" data-drill="${esc(d.id)}"><b>${esc(d.title)}</b><span>${esc(d.blurb)}</span></button>`).join('')}
      </div>`;
  };

  _root.innerHTML = `
    <div class="sp-wrap">
      <div class="sp-top">
        <div class="sp-title">Practice</div>
        <div class="sp-score" title="${lv.xp} XP total">Level ${lv.level} · ${lv.into}/${lv.span} XP to ${lv.level + 1}</div>
      </div>
      <div class="sp-h2">Your classes <small>quiz, weak spots, explain, mock exams</small></div>
      ${classes.length ? classes.map((c) => `
        <div class="sp-classrow">
          <div class="sp-cname"><span class="sp-dot" style="background:${esc(c.color || '#8D769A')}"></span>${esc(c.name)}</div>
          ${tools.map((t) => `<button class="sp-chip" data-tool="${esc(t.id)}" data-class="${esc(c.id)}"${t.ok ? '' : ' disabled title="Coming soon"'}>${t.icon} ${esc(t.title)}</button>`).join('')}
        </div>`).join('') : '<div class="sp-muted" style="font-size:13px">Add a class to get started.</div>'}
      ${courseBlock('db')}
      ${courseBlock('ds')}
    </div>`;

  _root.querySelectorAll('[data-drill]').forEach((b) => { b.onclick = () => openDrill(b.dataset.drill); });
  _root.querySelectorAll('[data-tool]').forEach((b) => {
    b.onclick = () => {
      const t = CLASS_TOOLS.find((x) => x.id === b.dataset.tool);
      try { if (t && t.ready()) t.open(b.dataset.class); } catch (e) { console.warn('[practice] tool failed:', e); }
    };
  });
}

// ── Sittings ────────────────────────────────────────────────────────────────
function startSitting(drill, classId) {
  endSitting();
  _sitting = { drill: drill.id, title: drill.title, classId, startedAt: Date.now(), items: 0, correct: 0, xp: 0 };
}

export function endSitting() {
  const s = _sitting;
  _sitting = null;
  if (!s || !s.items) return null;
  try {
    return window.SOS.sessions && window.SOS.sessions.log('drill', {
      classId: s.classId || '', startedAt: s.startedAt, durationMs: Date.now() - s.startedAt,
      completed: true, xp: s.xp, items: s.items, correct: s.correct,
      accuracy: Math.round((s.correct / s.items) * 100), topic: s.title,
    });
  } catch (e) { console.warn('[practice] could not log the sitting:', e); return null; }
}

// ── Opening a drill ─────────────────────────────────────────────────────────
export async function openDrill(id) {
  const d = DRILLS.find((x) => x.id === id);
  _root = host();
  if (!d || !_root) return;
  if (_cleanup) { try { _cleanup(); } catch (e) {} _cleanup = null; }
  styleOnce();
  let cls = classForCourse(d.course);
  const classes = store.getClasses().filter((c) => c && c.id);

  _root.innerHTML = `
    <div class="sp-wrap">
      <div class="sp-top">
        <button class="sp-back">‹ Practice</button>
        <div class="sp-title">${esc(d.title)}</div>
        <label class="sp-for">for
          <select data-for>
            <option value="">(no class)</option>
            ${classes.map((c) => `<option value="${esc(c.id)}"${cls && cls.id === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select></label>
        <div class="sp-score" data-score></div>
      </div>
      <div data-drill-host></div>
    </div>`;
  const scoreEl = _root.querySelector('[data-score]');
  _root.querySelector('.sp-back').onclick = () => render();
  _root.querySelector('[data-for]').onchange = (e) => {
    setClassForCourse(d.course, e.target.value);
    cls = classes.find((c) => c.id === e.target.value) || null;
    if (_sitting) _sitting.classId = cls ? cls.id : '';
  };
  startSitting(d, cls && cls.id);

  const paintScore = () => {
    if (!_sitting) return;
    scoreEl.textContent = _sitting.items ? `${_sitting.correct}/${_sitting.items} · +${_sitting.xp} XP` : '';
  };
  const ctx = {
    mode: d.mode,
    get classId() { return cls ? cls.id : ''; },
    get className() { return cls ? cls.name : ''; },
    esc,
    record({ topic, correct, difficulty = 1, partial } = {}) {
      const miss = correct ? 0 : (partial != null ? 1 - partial : 1);
      if (topic) { try { progress.recordAttempt(cls ? cls.id : '', topic, miss); } catch (e) {} }
      if (_sitting) {
        _sitting.items++;
        if (correct) _sitting.correct++;
        _sitting.xp += xp.forDrillItem({ correct, difficulty });
      }
      paintScore();
    },
    back: () => render(),
    toast: (i, t, b) => { try { window.showNotif && window.showNotif(i, esc(t), esc(b || '')); } catch (e) {} },
  };
  const mod = await d.load();
  const h = _root.querySelector('[data-drill-host]');
  if (!h) return;
  _cleanup = mod.mount(h, ctx) || null;
}

// ── Weak spots (2.3) ────────────────────────────────────────────────────────
/**
 * A session built from her most-missed topics: due-or-not cards on those
 * topics first, then quiz questions on them. Falls back to telling her there
 * is nothing weak yet rather than opening an empty screen.
 */
export function startWeakSpots(classId, { topic } = {}) {
  const S = window.SOS || {};
  const weak = topic ? [{ topic }] : progress.weakTopics(classId, 3);
  const notify = (i, t, b) => { try { window.showNotif && window.showNotif(i, t, esc(b)); } catch (e) {} };
  if (!weak.length) {
    notify('🎯', 'No weak spots yet', 'Misses in reviews, quizzes and drills show up here. Keep practising!');
    return null;
  }
  const topics = weak.map((w) => w.topic);
  const qs = S.quiz ? S.quiz.buildQuiz({ classId, topics }, 6) : [];
  if (qs.length && S.quizUi) {
    return S.quizUi.startQuiz({ classId, topics }, { n: 8, title: 'Weak spots: ' + topics.join(', '), questions: qs, withCards: true });
  }
  const pool = S.deck ? S.deck.buildQueue({ classId, topics }, { maxNew: 10, limit: 20 }) : [];
  if (pool.length && S.review) {
    // Weak topics are worth reviewing even if the cards are not due yet.
    const cards = S.deck.poolFor({ classId, topics }).slice(0, 20);
    return S.review.startReview({ classId, topics }, { limit: 20, maxNew: 20, cards });
  }
  notify('🎯', 'Weak spots: ' + topics.join(', '), 'No cards or questions on these topics yet — generate a study kit for the lecture.');
  return null;
}

export default { render, openDrill, endSitting, startWeakSpots, classForCourse, setClassForCourse, DRILLS, CLASS_TOOLS, COURSES };
