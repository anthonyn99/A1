/* ============================================================================
 * StudyOS — exam back-planner  (engagement upgrade 2.5)
 * ============================================================================
 * Pick an exam and the modules it covers; the planner works BACKWARDS from
 * the exam date to today and writes one study task per day:
 *
 *   new cards   the unseen cards in scope, spread so they are all introduced
 *               two days before the exam (FSRS needs a couple of reviews to
 *               stick — new material the night before is the least useful)
 *   reviews     "clear today's due cards" every day
 *   quiz        a practice quiz every third day, counted back from the exam
 *   final day   the day before: a mock exam over the covered modules
 *
 * Tasks land in the ordinary task list (and so on the calendar) with a
 * `planId`, so re-planning replaces only the plan's unfinished tasks.
 * The covered modules are stored on the exam (event.plan.moduleIds), which is
 * what deck.buildQueue({examId}) and mock exams scope themselves by.
 *
 * compute() is pure (every input passed in) and pinned by test-planner.mjs.
 * ------------------------------------------------------------------------- */

import { store } from './store.js';

const MAX_DAYS = 21;
const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param {object} o { exam: {id, name, date, classId}, unseen, questions, today: 'YYYY-MM-DD' }
 * @returns {{ days: [{date, newCards, quiz, mock, label}], tasks: [...] }}
 */
export function compute({ exam, unseen = 0, questions = 0, today }) {
  const start = new Date(today + 'T12:00:00');
  const examDay = new Date(exam.date + 'T12:00:00');
  const span = Math.round((examDay - start) / 86400000);
  if (span <= 0) return { days: [], tasks: [] };
  // Plan days: today … the day before the exam, at most MAX_DAYS of them.
  const n = Math.min(span, MAX_DAYS);
  const first = new Date(examDay); first.setDate(first.getDate() - n);
  const dates = [...Array(n)].map((_, i) => { const d = new Date(first); d.setDate(d.getDate() + i); return dayStr(d); });

  // New cards finish two days out when there is room, else as early as possible.
  const newDays = Math.max(1, n - 2);
  const perDay = unseen ? Math.ceil(unseen / newDays) : 0;
  let left = unseen;
  const days = dates.map((date, i) => {
    const untilExam = n - i;                           // 1 = the day before the exam
    const newCards = i < newDays ? Math.min(perDay, left) : 0;
    left -= newCards;
    const mock = untilExam === 1;
    const quiz = !mock && questions > 0 && untilExam % 3 === 1;
    return { date, newCards, quiz, mock, untilExam };
  });

  const tasks = days.map((d) => {
    const bits = [];
    if (d.mock) bits.push('mock exam');
    if (d.newCards) bits.push(`${d.newCards} new cards`);
    bits.push('due reviews');
    if (d.quiz) bits.push('practice quiz');
    const label = `${exam.name}: ${bits.join(' + ')}`;
    d.label = label;
    return {
      id: 'pt_' + exam.id + '_' + d.date,
      name: label,
      dueDate: d.date,
      dueTime: '',
      type: 'other',
      priority: d.untilExam <= 3 ? 'high' : 'medium',
      classId: exam.classId,
      notes: `Study plan for ${exam.name} (${exam.date}). Press "Start now" on the dashboard — it picks today's cards and quizzes for this class.`,
    };
  });
  return { days, tasks };
}

/** The unseen cards and questions an exam's modules cover. */
export function scopeCounts(classId, moduleIds) {
  const S = window.SOS || {};
  const m = new Set(moduleIds || []);
  const inScope = (x) => !m.size || m.has(x.moduleId);
  const cards = S.deck ? S.deck.forClass(classId).filter(inScope) : [];
  const unseen = cards.filter((c) => !c.sched || c.sched.state === 'new').length;
  const questions = S.quiz ? S.quiz.forClass(classId).filter(inScope).length : 0;
  return { cards: cards.length, unseen, questions };
}

// ── The sheet ───────────────────────────────────────────────────────────────
export function openPlanner(eventId) {
  const ev = store.getEvents().find((e) => e && e.id === eventId);
  if (!ev) return;
  const cls = store.getClass(ev.classId);
  if (!cls) return;
  const mods = (cls.modules || []).filter((m) => m.type === 'documents' || m.type === 'notes');
  const chosen = new Set((ev.plan && ev.plan.moduleIds) || []);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay sos-modal sos-plan-sheet';
  overlay.innerHTML = `<div class="modal" style="max-width:640px">
      <div class="modal-title">Plan for ${esc(ev.name)}</div>
      <div class="modal-scroll-body">
        <div style="font-size:12px;color:var(--text3);font-family:var(--mono);margin-bottom:10px">${esc(cls.name)} · ${esc(ev.date)}</div>
        <div class="field"><label>Covered modules</label>
          <div data-mods style="display:grid;gap:4px">${mods.map((m) => `<label style="display:flex;gap:8px;align-items:center;text-transform:none;font-size:13px">
            <input type="checkbox" value="${esc(m.id)}"${chosen.has(m.id) ? ' checked' : ''}> ${esc(m.name)}</label>`).join('') || '<span style="font-size:12px;color:var(--text3)">No modules yet.</span>'}</div></div>
        <div data-preview style="font-size:12px;font-family:var(--mono);margin-top:10px"></div>
      </div>
      <div class="modal-footer"><button class="btn" data-cancel>Cancel</button>${ev.plan ? '<button class="btn" data-clear>Remove plan</button>' : ''}<button class="btn primary" data-save>Create plan</button></div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  const close = () => { overlay.classList.remove('open'); setTimeout(() => overlay.remove(), 200); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const selected = () => [...overlay.querySelectorAll('[data-mods] input:checked')].map((i) => i.value);
  const today = dayStr(new Date());

  const preview = () => {
    const c = scopeCounts(cls.id, selected());
    const plan = compute({ exam: ev, unseen: c.unseen, questions: c.questions, today });
    overlay.querySelector('[data-preview]').innerHTML = !plan.days.length
      ? '<span style="color:#f0bd86">The exam is today or past — nothing to plan.</span>'
      : `<div style="color:var(--text2);margin-bottom:6px">${c.cards} cards (${c.unseen} unseen) · ${c.questions} quiz questions in scope</div>
         ${plan.days.map((d) => `<div>${esc(d.date)} — ${esc(d.label.replace(ev.name + ': ', ''))}</div>`).join('')}
         ${c.cards === 0 ? '<div style="color:#f0bd86;margin-top:6px">No cards in these modules yet — generate study kits for their lectures first.</div>' : ''}`;
    return plan;
  };
  overlay.querySelectorAll('[data-mods] input').forEach((i) => { i.onchange = preview; });
  preview();
  overlay.querySelector('[data-cancel]').onclick = close;
  const B = window._sosBridge;
  const clear = overlay.querySelector('[data-clear]');
  if (clear) clear.onclick = () => { B.replacePlanTasks('pl_' + ev.id, []); B.setEventPlan(ev.id, null); close(); };
  overlay.querySelector('[data-save]').onclick = () => {
    const plan = preview();
    if (!plan.days.length) return close();
    B.setEventPlan(ev.id, { moduleIds: selected(), generatedAt: Date.now() });
    const n = B.replacePlanTasks('pl_' + ev.id, plan.tasks);
    try { window.showNotif && window.showNotif('🗓', 'Study plan created', esc(`${n} daily task${n === 1 ? '' : 's'} until ${ev.name}`)); } catch (e) {}
    close();
  };
}

export default { compute, scopeCounts, openPlanner };
