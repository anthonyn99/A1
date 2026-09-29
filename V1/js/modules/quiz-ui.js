/* ============================================================================
 * StudyOS — quiz mode, mock exams and boss fights  (engagement 2.4 / 4.2 / 5.2)
 * ============================================================================
 * ONE full-screen engine, three styles:
 *
 *   quiz   feedback + explanation after every answer
 *   mock   Respondus-style: timed, one question per screen, no going back,
 *          no feedback until the end, then a full review
 *   boss   quiz feedback, plus a boss HP bar (each right answer is damage)
 *          and three hearts (each miss costs one) — win or lose
 *
 * Question types: mcq (auto) · trace (auto, spacing-forgiving) · sql (auto
 * when its answer runs against the Cape Codd tables, else self-graded) ·
 * short (reveal, then "got it / missed it").
 *
 * Every answer updates the question's stats (quiz.js), the topic's weak-spot
 * record (progress.js), and the session's XP; the sitting is logged as ONE
 * session. The end screen is summary.js.
 * ------------------------------------------------------------------------- */

import * as quiz from './quiz.js';
import * as progress from './progress.js';
import * as xp from './xp.js';
import * as summary from './summary.js';
import { store } from './store.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let _open = null;

function styleOnce() {
  if (document.getElementById('sos-quiz-css')) return;
  const el = document.createElement('style');
  el.id = 'sos-quiz-css';
  el.textContent = `
.sos-quiz {
  --bg:#1B1C1E; --bg2:#1f2022; --bg3:#26272A; --bg4:#2e2f33;
  --border:rgba(255,255,255,0.09); --text:#ECECEE; --text2:#AFB0B5; --text3:#76777C;
  --accent:#8D769A; --mono:'IBM Plex Mono',monospace; --sans:'Nunito',sans-serif;
  position:fixed; inset:0; z-index:10300; background:var(--bg2); color:var(--text); font-family:var(--sans);
  display:flex; flex-direction:column; padding-top:env(safe-area-inset-top,0px);
}
.sos-quiz-top { display:flex; align-items:center; gap:10px; padding:10px 14px; border-bottom:1px solid var(--border);
  font-family:var(--mono); font-size:11px; flex-shrink:0; }
.sos-quiz-top .grow { flex:1; }
.sos-quiz-x { background:none; border:1px solid var(--border); color:var(--text3); border-radius:4px; cursor:pointer;
  min-width:34px; min-height:34px; font-size:14px; }
.sos-quiz-bar { flex:1; height:4px; background:var(--bg4); border-radius:2px; overflow:hidden; }
.sos-quiz-bar > i { display:block; height:100%; background:var(--accent); transition:width .25s; }
.sos-quiz-body { flex:1; overflow-y:auto; padding:20px 18px 30px; display:flex; flex-direction:column; align-items:center; }
.sos-quiz-card { width:100%; max-width:720px; display:flex; flex-direction:column; gap:12px; }
.sos-quiz-topic { font-family:var(--mono); font-size:10px; color:var(--text3); letter-spacing:.04em; text-transform:uppercase; }
.sos-quiz-q { font-size:18px; line-height:1.55; white-space:pre-wrap; }
.sos-quiz-q code, .sos-quiz-pre { font-family:var(--mono); font-size:13px; }
.sos-quiz-pre { background:var(--bg); border:1px solid var(--border); border-radius:4px; padding:10px 12px; white-space:pre; overflow-x:auto; }
.sos-quiz-choice { text-align:left; background:var(--bg3); border:1px solid var(--border); color:var(--text); border-radius:6px;
  padding:12px 14px; cursor:pointer; font-family:inherit; font-size:15px; min-height:48px; width:100%; }
.sos-quiz-choice:hover:not(:disabled) { border-color:var(--accent); }
.sos-quiz-choice.sel { border-color:var(--accent); background:rgba(141,118,154,.18); }
.sos-quiz-choice.right { border-color:#8fd6ad; background:rgba(143,214,173,.14); }
.sos-quiz-choice.wrong { border-color:#ef9f9f; background:rgba(239,159,159,.14); }
.sos-quiz-input { width:100%; box-sizing:border-box; background:var(--bg); color:var(--text); border:1px solid var(--border);
  border-radius:5px; padding:10px; font-family:var(--mono); font-size:14px; min-height:44px; }
textarea.sos-quiz-input { min-height:110px; resize:vertical; }
.sos-quiz-btn { background:var(--bg3); border:1px solid var(--border); color:var(--text); border-radius:5px; padding:10px 18px;
  cursor:pointer; font-family:inherit; font-size:14px; min-height:44px; }
.sos-quiz-btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:700; }
.sos-quiz-btn:disabled { opacity:.45; cursor:default; }
.sos-quiz-row { display:flex; gap:8px; flex-wrap:wrap; }
.sos-quiz-fb { font-size:14px; line-height:1.5; border-left:3px solid var(--border); padding:6px 12px; }
.sos-quiz-fb.ok { border-color:#8fd6ad; } .sos-quiz-fb.bad { border-color:#ef9f9f; }
.sos-quiz-boss { width:100%; max-width:720px; display:grid; grid-template-columns:auto 1fr auto; gap:10px; align-items:center;
  font-family:var(--mono); font-size:12px; margin-bottom:14px; }
.sos-quiz-hp { height:12px; background:var(--bg4); border-radius:6px; overflow:hidden; }
.sos-quiz-hp > i { display:block; height:100%; background:linear-gradient(90deg,#ef9f9f,#f0bd86); transition:width .4s; }
.sos-quiz-hearts { letter-spacing:2px; }
.sos-quiz-review { width:100%; max-width:720px; display:grid; gap:10px; margin-top:10px; text-align:left; }
.sos-quiz-review > div { background:var(--bg3); border:1px solid var(--border); border-radius:6px; padding:10px 12px; font-size:13px; }
${summary.CSS}`;
  document.head.appendChild(el);
}

let _sql = null;
async function sqlTools() {
  if (!_sql) {
    const [engine, grade] = await Promise.all([import('./drills/db/sqlengine.js'), import('./drills/db/grade.js')]);
    _sql = { engine, compare: grade.compare };
  }
  return _sql;
}

/**
 * Start a quiz. scope: { classId, moduleIds?, topics? }.
 * opts: { n, title, questions?, mode: 'quiz'|'mock'|'boss', minutes?, boss?: {name, onWin, onLose} }
 */
export function startQuiz(scope = {}, opts = {}) {
  if (_open) return _open;
  styleOnce();
  const mode = opts.mode || 'quiz';
  const qs = (opts.questions && opts.questions.length ? opts.questions : quiz.buildQuiz(scope, opts.n || 10)).slice(0, opts.n || 50);
  if (!qs.length) {
    try { window.showNotif && window.showNotif('ℹ️', 'No questions yet', 'Generate a study kit from a lecture — its quiz lands here.'); } catch (e) {}
    return null;
  }
  const cls = scope.classId ? store.getClass(scope.classId) : null;
  const started = Date.now();
  const answers = [];          // { q, correct, response }
  let i = 0;
  let deadline = opts.minutes ? started + opts.minutes * 60000 : null;
  let tick = null;
  const boss = mode === 'boss' ? { hp: 100, hearts: 3, dmg: 100 / qs.length } : null;
  let finished = false;

  const el = document.createElement('div');
  el.className = 'sos-quiz';
  el.innerHTML = `
    <div class="sos-quiz-top"><button class="sos-quiz-x" title="Close (Esc)">✕</button>
      <span>${esc(opts.title || (mode === 'mock' ? 'Mock exam' : mode === 'boss' ? 'Boss fight' : 'Quiz'))}${cls ? ' · ' + esc(cls.name) : ''}</span>
      <div class="sos-quiz-bar"><i style="width:0%"></i></div><span data-count></span><span data-timer></span></div>
    <div class="sos-quiz-body"><div data-boss></div><div class="sos-quiz-card" data-card></div></div>`;
  document.body.appendChild(el);
  const card = el.querySelector('[data-card]');
  const bar = el.querySelector('.sos-quiz-bar > i');

  const paintBoss = () => {
    if (!boss) return;
    el.querySelector('[data-boss]').innerHTML = `<div class="sos-quiz-boss"><span>🐉 ${esc((opts.boss && opts.boss.name) || 'Boss')}</span>
      <div class="sos-quiz-hp"><i style="width:${Math.max(0, boss.hp)}%"></i></div>
      <span class="sos-quiz-hearts">${'❤️'.repeat(boss.hearts)}${'🖤'.repeat(3 - boss.hearts)}</span></div>`;
  };

  const record = (q, correct, response) => {
    answers.push({ q, correct, response });
    try { if (q.classId) quiz.recordAnswer(q.classId, q.id, correct); } catch (e) {}
    try { progress.recordAttempt(q.classId || scope.classId, q.topic, correct ? 0 : 1); } catch (e) {}
    if (boss) { if (correct) boss.hp -= boss.dmg; else boss.hearts--; paintBoss(); }
  };

  const close = () => {
    if (tick) clearInterval(tick);
    document.removeEventListener('keydown', onKey, true);
    if (!finished && answers.length) logSession();
    el.remove();
    _open = null;
    try { window.updateStats && window.updateStats(); } catch (e) {}
  };

  const correctCount = () => answers.filter((a) => a.correct).length;
  let logged = false;
  function logSession() {
    if (logged) return;
    logged = true;
    const c = correctCount();
    const gained = xp.forQuiz({ items: answers.length, correct: c, mock: mode === 'mock' })
      + (boss && boss.hp <= 0.01 ? xp.WEIGHTS.bossWin : 0);
    try {
      window.SOS.sessions && window.SOS.sessions.log(mode === 'quiz' ? 'quiz' : mode, {
        classId: scope.classId || '', startedAt: started, durationMs: Date.now() - started, completed: finished,
        items: answers.length, correct: c, accuracy: answers.length ? Math.round((c / answers.length) * 100) : null, xp: gained,
      });
    } catch (e) {}
    return gained;
  }

  const finish = () => {
    if (finished) return;
    finished = true;
    if (tick) clearInterval(tick);
    const gained = logSession() || 0;
    const c = correctCount();
    const missed = [...new Set(answers.filter((a) => !a.correct).map((a) => a.q.topic).filter(Boolean))];
    const won = boss ? boss.hp <= 0.01 : null;
    if (boss && opts.boss) { try { (won ? opts.boss.onWin : opts.boss.onLose || (() => {}))({ correct: c, total: answers.length }); } catch (e) {} }
    const unanswered = qs.length - answers.length;
    const review = mode === 'mock' ? `<div class="sos-quiz-review">${answers.map((a, k) => `
      <div><b class="${a.correct ? '' : ''}" style="color:${a.correct ? '#8fd6ad' : '#ef9f9f'}">${a.correct ? '✓' : '✗'} ${k + 1}.</b> ${esc(a.q.prompt).slice(0, 400)}
        <div style="color:var(--text3);margin-top:4px">Your answer: ${esc(a.response == null ? '—' : a.response)} · Correct: ${esc(a.q.answer)}</div>
        ${a.q.explanation ? `<div style="margin-top:4px">${esc(a.q.explanation)}</div>` : ''}</div>`).join('')}</div>` : '';
    const o = {
      title: boss ? (won ? 'Boss defeated!' : 'The boss wins this time') : mode === 'mock' ? 'Mock exam done' : 'Quiz done',
      lines: [`${c} / ${answers.length} correct${unanswered > 0 ? ` · ${unanswered} unanswered` : ''}`,
              `${Math.max(1, Math.round((Date.now() - started) / 60000))} min`],
      xpGained: gained,
      missedTopics: missed,
      extraHtml: review,
      onClose: close,
      onPractice: (topics) => window.SOS.practice && window.SOS.practice.startWeakSpots(scope.classId, { topic: topics[0] }),
    };
    bar.style.width = '100%';
    el.querySelector('[data-boss]').innerHTML = '';
    card.innerHTML = summary.html(o);
    summary.wire(card, o);
  };

  const next = () => { i++; if (i >= qs.length || (boss && (boss.hearts <= 0 || boss.hp <= 0.01))) finish(); else render(); };

  const feedback = (q, correct, extra = '') => {
    if (mode === 'mock') return next();
    card.insertAdjacentHTML('beforeend', `<div class="sos-quiz-fb ${correct ? 'ok' : 'bad'}">
      <b>${correct ? '✓ Correct' : '✗ Not quite'}</b>${correct ? '' : ` — answer: <code>${esc(q.answer)}</code>`}${extra}
      ${q.explanation ? `<div style="margin-top:6px;color:var(--text2)">${esc(q.explanation)}</div>` : ''}</div>
      <div class="sos-quiz-row"><button class="sos-quiz-btn primary" data-next>${i === qs.length - 1 ? 'Finish' : 'Next'} (Enter)</button></div>`);
    card.querySelector('[data-next]').onclick = next;
    card.querySelector('[data-next]').focus();
  };

  function render() {
    const q = qs[i];
    el.querySelector('[data-count]').textContent = `${i + 1}/${qs.length}`;
    bar.style.width = Math.round((i / qs.length) * 100) + '%';
    const promptHtml = esc(q.prompt).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, l, code) => `<div class="sos-quiz-pre">${code}</div>`);
    card.innerHTML = `<div class="sos-quiz-topic">${esc(q.topic || '')} · ${esc(q.type)}</div><div class="sos-quiz-q">${promptHtml}</div><div data-a></div>`;
    const a = card.querySelector('[data-a]');

    if (q.type === 'mcq') {
      a.innerHTML = `<div style="display:grid;gap:8px">${(q.choices || []).map((c, k) => `<button class="sos-quiz-choice" data-c="${k}"><b style="font-family:var(--mono);margin-right:8px">${'ABCDEF'[k]}</b>${esc(c)}</button>`).join('')}</div>`;
      a.querySelectorAll('[data-c]').forEach((b) => {
        b.onclick = () => {
          const choice = q.choices[Number(b.dataset.c)];
          const { correct } = quiz.gradeSync(q, choice);
          record(q, correct, choice);
          a.querySelectorAll('[data-c]').forEach((x) => {
            x.disabled = true;
            if (mode !== 'mock') { if (q.choices[Number(x.dataset.c)] === q.answer) x.classList.add('right'); else if (x === b) x.classList.add('wrong'); }
          });
          feedback(q, correct);
        };
      });
    } else if (q.type === 'trace' || q.type === 'sql') {
      a.innerHTML = `${q.type === 'sql' ? '<textarea class="sos-quiz-input" data-in spellcheck="false" placeholder="SELECT …"></textarea>'
        : '<input class="sos-quiz-input" data-in placeholder="exact output" autocomplete="off">'}
        <div class="sos-quiz-row" style="margin-top:8px"><button class="sos-quiz-btn primary" data-go>Submit</button></div>`;
      const inp = a.querySelector('[data-in]');
      const go = async () => {
        a.querySelector('[data-go]').disabled = true;
        const resp = inp.value;
        if (q.type === 'trace') {
          const { correct } = quiz.gradeSync(q, resp);
          if (correct === null) return selfGrade(q, resp);      // a described answer, not literal output
          record(q, correct, resp); return feedback(q, correct);
        }
        // SQL: grade by result set when the model answer runs on Cape Codd;
        // a kit's SQL may reference its own lecture's tables, so fall back to
        // self-grading rather than marking a right answer wrong.
        let verdict = null;
        try {
          const { engine, compare } = await sqlTools();
          const db1 = await engine.openDataset(q.dataset || 'capecodd');
          let exp; try { exp = engine.run(db1, q.answer); } finally { db1.close(); }
          const db2 = await engine.openDataset(q.dataset || 'capecodd');
          let mine; try { mine = engine.run(db2, resp); } catch (e) { mine = null; verdict = { ok: false, reason: e.message }; } finally { db2.close(); }
          if (mine) verdict = compare(exp, mine, {});
        } catch (e) { verdict = null; }
        if (verdict) { record(q, verdict.ok, resp); return feedback(q, verdict.ok, verdict.ok ? '' : `<div style="margin-top:4px;color:var(--text3)">${esc(verdict.reason)}</div>`); }
        selfGrade(q, resp);
      };
      a.querySelector('[data-go]').onclick = go;
      if (q.type === 'trace') inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      inp.focus();
    } else {
      a.innerHTML = `<textarea class="sos-quiz-input" data-in placeholder="Your answer (optional — then reveal)"></textarea>
        <div class="sos-quiz-row" style="margin-top:8px"><button class="sos-quiz-btn primary" data-go>Reveal answer</button></div>`;
      a.querySelector('[data-go]').onclick = () => selfGrade(q, a.querySelector('[data-in]').value);
    }
  }

  function selfGrade(q, resp) {
    card.querySelector('[data-a]').insertAdjacentHTML('beforeend', `<div class="sos-quiz-fb"><b>Answer:</b> <span style="white-space:pre-wrap">${esc(q.answer)}</span>
      ${q.explanation ? `<div style="margin-top:6px;color:var(--text2)">${esc(q.explanation)}</div>` : ''}</div>
      <div class="sos-quiz-row"><button class="sos-quiz-btn" data-self="1">✓ I got it</button><button class="sos-quiz-btn" data-self="0">✗ I missed it</button></div>`);
    const go = card.querySelector('[data-go]'); if (go) go.disabled = true;
    card.querySelectorAll('[data-self]').forEach((b) => {
      b.onclick = () => { record(q, b.dataset.self === '1', resp); next(); };
    });
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); return close(); }
    if (e.key === 'Enter') {
      const n = card.querySelector('[data-next]');
      if (n && document.activeElement && document.activeElement.tagName !== 'TEXTAREA') { e.preventDefault(); n.click(); }
    }
    if (/^[1-6]$/.test(e.key) && !/INPUT|TEXTAREA/.test((document.activeElement || {}).tagName || '')) {
      const b = card.querySelector(`[data-c="${Number(e.key) - 1}"]`);
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
    }
  }

  el.querySelector('.sos-quiz-x').onclick = close;
  document.addEventListener('keydown', onKey, true);
  if (deadline) {
    const tEl = el.querySelector('[data-timer]');
    const paintT = () => {
      const left = Math.max(0, deadline - Date.now());
      tEl.textContent = `⏱ ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
      if (!left) finish();
    };
    paintT();
    tick = setInterval(paintT, 1000);
  }
  paintBoss();
  render();
  _open = { close, el, finish };
  return _open;
}

export function closeQuiz() { if (_open) _open.close(); }

/** Other overlays (explain, boss list, mastery) reuse these styles. */
export function ensureStyles() { styleOnce(); }

/** Setup sheet: scope (module, topic), length, timed or not. */
export function openQuizSetup(classId) {
  styleOnce();
  const cls = store.getClass(classId);
  const all = quiz.forClass(classId);
  const mods = (cls && cls.modules || []).filter((m) => all.some((q) => q.moduleId === m.id));
  const topics = [...new Set(all.map((q) => q.topic).filter(Boolean))].sort();
  const el = document.createElement('div');
  el.className = 'sos-quiz';
  el.innerHTML = `<div class="sos-quiz-top"><button class="sos-quiz-x">✕</button><span>Quiz setup · ${esc(cls ? cls.name : '')}</span></div>
    <div class="sos-quiz-body"><div class="sos-quiz-card">
      ${all.length ? `
      <div class="sos-quiz-q" style="font-size:16px">${all.length} question${all.length === 1 ? '' : 's'} in this class's bank.</div>
      <label>Module <select class="sos-quiz-input" data-mod><option value="">All modules</option>${mods.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></label>
      <label>Topic <select class="sos-quiz-input" data-topic><option value="">All topics</option>${topics.map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>
      <label>Questions <select class="sos-quiz-input" data-n><option>5</option><option selected>10</option><option>15</option><option>25</option></select></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-timed> Timed (1 min per question)</label>
      <button class="sos-quiz-btn primary" data-start>Start quiz</button>`
      : `<div class="sos-quiz-q" style="font-size:16px">No questions yet for this class.</div>
         <div style="color:var(--text3);font-size:14px">Open a lecture in a documents module and press ⚡ → Study kit. Its quiz questions land here.</div>`}
    </div></div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.querySelector('.sos-quiz-x').onclick = close;
  const start = el.querySelector('[data-start]');
  if (start) start.onclick = () => {
    const mod = el.querySelector('[data-mod]').value, topic = el.querySelector('[data-topic]').value;
    const n = Number(el.querySelector('[data-n]').value);
    const timed = el.querySelector('[data-timed]').checked;
    close();
    startQuiz({ classId, moduleIds: mod ? [mod] : undefined, topics: topic ? [topic] : undefined }, { n, minutes: timed ? n : null });
  };
}

export default { startQuiz, closeQuiz, openQuizSetup, ensureStyles };
