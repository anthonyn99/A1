/* ============================================================================
 * StudyOS — mock exams  (engagement upgrade 4.2)
 * ============================================================================
 * A timed, one-question-per-screen, no-going-back exam (quiz-ui mode 'mock'),
 * assembled from what already exists — free, instant, offline:
 *
 *   every class   its quiz bank (study kits), scoped to the chosen modules
 *   Databases     + generated normal-form and candidate-key questions (fd.js)
 *                 + SQL challenges graded by result set (Cape Codd)
 *   Data Str.     + Big-O snippets + "what does this print?" traces
 *
 * The mix leans on the bank when it is big enough and fills from the course
 * items when it is not. Misses feed weak spots like any quiz.
 * ------------------------------------------------------------------------- */

import { store } from './store.js';
import * as quiz from './quiz.js';
import { COURSES } from './practice.js';
import { ensureStyles } from './quiz-ui.js';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

export function courseOf(cls) {
  const s = `${(cls && cls.name) || ''} ${(cls && cls.code) || ''}`;
  if (COURSES.db.match.test(s)) return 'db';
  if (COURSES.ds.match.test(s)) return 'ds';
  return null;
}

/** Generated course questions, in quiz.js question shape. */
export async function courseItems(course, n = 20) {
  const out = [];
  if (course === 'db') {
    const F = await import('./drills/db/fd.js');
    const { CHALLENGES } = await import('./drills/db/challenges.js');
    for (let i = 0; i < Math.ceil(n / 3); i++) {
      const r = F.randomRelation(Math.floor(Math.random() * 1e9));
      const nf = F.normalForm(r.R, r.fds);
      const rel = `R(${r.R.join(', ')}) with ${r.fds.map(F.fmtFD).join('; ')}`;
      out.push({ id: 'mk_nf_' + i + '_' + r.seed, type: 'mcq', topic: 'Normal forms',
        prompt: `${rel}.\nWhat is the highest normal form R is in?`, choices: ['1NF', '2NF', '3NF', 'BCNF'], answer: nf.nf,
        explanation: nf.violations[0] ? `${F.fmtFD(nf.violations[0].fd)}: ${nf.violations[0].why}.` : 'Every determinant is a candidate key.' });
      const keys = F.candidateKeys(r.R, r.fds).map(F.fmt);
      const wrong = shuffle(r.R.flatMap((a, x) => r.R.slice(x + 1).map((b) => F.fmt(F.set([a, b])))).concat(r.R))
        .filter((k) => !keys.includes(k)).slice(0, 3);
      out.push({ id: 'mk_key_' + i + '_' + r.seed, type: 'mcq', topic: 'Candidate keys',
        prompt: `${rel}.\nWhich of these is a candidate key?`, choices: shuffle([keys[0], ...wrong]), answer: keys[0],
        explanation: `The candidate key${keys.length > 1 ? 's are' : ' is'} ${keys.join(', ')}.` });
    }
    for (const c of shuffle(CHALLENGES).slice(0, Math.ceil(n / 3))) {
      out.push({ id: 'mk_' + c.id, type: 'sql', topic: 'SQL: ' + c.topic, dataset: c.dataset,
        prompt: c.prompt + '\n(Cape Codd tables: RETAIL_ORDER, ORDER_ITEM, SKU_DATA, BUYER, CATALOG_SKU_2020/2021)',
        answer: c.solution, explanation: '' });
    }
  } else if (course === 'ds') {
    const { BANK: BIGO, OPTIONS } = await import('./drills/ds/bigo-ui.js');
    const { BANK: TRACE } = await import('./drills/ds/trace-ui.js');
    shuffle(BIGO).slice(0, Math.ceil(n / 2)).forEach((b, i) => out.push({ id: 'mk_bigo_' + i, type: 'mcq', topic: 'Big-O',
      prompt: 'What is the time complexity?\n```\n' + b.code + '\n```', choices: OPTIONS.slice(), answer: b.ans, explanation: b.why }));
    shuffle(TRACE).slice(0, Math.ceil(n / 2)).forEach((t, i) => out.push({ id: 'mk_tr_' + i, type: 'trace', topic: 'Trace: ' + t.topic,
      prompt: 'What does this print?\n```\n' + t.code + '\n```', answer: t.out, explanation: t.why }));
  }
  return shuffle(out);
}

/** Up to 2/3 from the class bank (weakest first), the rest from course items. */
export async function assemble(classId, moduleIds, n) {
  const cls = store.getClass(classId);
  const bank = quiz.buildQuiz({ classId, moduleIds }, Math.ceil((n * 2) / 3));
  const extra = await courseItems(courseOf(cls), n - bank.length);
  return shuffle([...bank, ...extra.slice(0, n - bank.length)]);
}

export function openSetup(classId) {
  ensureStyles();
  const cls = store.getClass(classId);
  const course = courseOf(cls);
  const mods = (cls && cls.modules || []).filter((m) => m.type === 'documents');
  const exam = store.getEvents().filter((e) => e && e.classId === classId && e.type === 'exam' && e.date >= new Date().toISOString().slice(0, 10))
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  const planned = new Set((exam && exam.plan && exam.plan.moduleIds) || []);
  const bankSize = quiz.forClass(classId).length;

  const el = document.createElement('div');
  el.className = 'sos-quiz';
  el.innerHTML = `<div class="sos-quiz-top"><button class="sos-quiz-x">✕</button><span>Mock exam · ${esc(cls ? cls.name : '')}</span></div>
    <div class="sos-quiz-body"><div class="sos-quiz-card">
      <div class="sos-quiz-q" style="font-size:15px">Timed, one question per screen, no going back — answers and explanations at the end.</div>
      <div style="font-family:var(--mono);font-size:12px;color:var(--text3)">${bankSize} question${bankSize === 1 ? '' : 's'} in the class bank${course ? ` + generated ${course === 'db' ? 'SQL / normalization / keys' : 'Big-O / trace'} items` : ''}${exam ? ` · next exam: ${esc(exam.name)} (${esc(exam.date)})` : ''}</div>
      ${mods.length ? `<div><b style="font-size:13px">Modules</b>${mods.map((m) => `<label style="display:flex;gap:8px;margin:4px 0;font-size:14px"><input type="checkbox" value="${esc(m.id)}"${!planned.size || planned.has(m.id) ? ' checked' : ''}> ${esc(m.name)}</label>`).join('')}</div>` : ''}
      <label>Questions <select class="sos-quiz-input" data-n><option>10</option><option selected>20</option><option>30</option></select></label>
      <label>Minutes <select class="sos-quiz-input" data-min><option>15</option><option selected>30</option><option>50</option><option>75</option></select></label>
      <button class="sos-quiz-btn primary" data-start>Start the exam</button>
      <div data-msg style="font-size:13px;color:#f0bd86"></div>
    </div></div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.querySelector('.sos-quiz-x').onclick = close;
  el.querySelector('[data-start]').onclick = async () => {
    const moduleIds = [...el.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value);
    const n = Number(el.querySelector('[data-n]').value);
    const qs = await assemble(classId, moduleIds.length === mods.length ? undefined : moduleIds, n);
    if (!qs.length) {
      el.querySelector('[data-msg]').textContent = 'No questions available yet — generate study kits for this class\'s lectures.';
      return;
    }
    close();
    window.SOS.quizUi.startQuiz({ classId, moduleIds }, { mode: 'mock', questions: qs, n: qs.length,
      minutes: Number(el.querySelector('[data-min]').value), title: 'Mock exam' });
  };
}

export default { openSetup, assemble, courseItems, courseOf };
