/* ============================================================================
 * StudyOS — boss fights and mastery bars  (engagement upgrade 5.1 / 5.2)
 * ============================================================================
 * Each module with cards has a boss. It UNLOCKS when the module's mastery
 * (mean retrievability of its cards — deck.js's definition, not "cards seen")
 * reaches 80% over at least 10 cards: the fight is a reward for having done
 * the reviews, not a shortcut around them.
 *
 * The fight is a quiz-ui 'boss' round over that module: every right answer
 * hits the boss's HP bar, every miss costs one of three hearts. A win is
 * recorded in progress.js (synced) and pays the boss XP bonus.
 *
 * The same screen shows per-topic mastery bars for the class (5.1).
 * ------------------------------------------------------------------------- */

import { store } from './store.js';
import * as deck from './deck.js';
import * as fsrs from './fsrs.js';
import * as quiz from './quiz.js';
import * as progress from './progress.js';
import { ensureStyles } from './quiz-ui.js';

export const UNLOCK_PCT = 80;
export const UNLOCK_MIN_CARDS = 10;
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NAMES = ['the Null Pointer', 'the Infinite Loop', 'the Off-By-One', 'the Stack Overflow', 'the Race Condition',
  'the Lossy Join', 'the Transitive Dependency', 'the Cartesian Product', 'the Dangling Reference', 'the Segfault'];
const nameFor = (moduleId) => NAMES[[...String(moduleId)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % NAMES.length];

/** Mastery of an arbitrary list of cards (mean retrievability, 0–100). */
export function masteryOf(cards, now = Date.now()) {
  if (!cards.length) return 0;
  let sum = 0;
  for (const c of cards) {
    const s = c.sched;
    if (s && s.lastReview && s.state !== fsrs.STATE.NEW) sum += fsrs.retrievability((now - s.lastReview) / 86400000, s.stability);
  }
  return Math.round((sum / cards.length) * 100);
}

export function bossesFor(classId, now = Date.now()) {
  const cls = store.getClass(classId);
  const cards = deck.forClass(classId);
  const won = new Map(progress.bosses(classId).map((b) => [b.moduleId, b]));
  return ((cls && cls.modules) || [])
    .map((m) => {
      const mc = cards.filter((c) => c.moduleId === m.id);
      const pct = masteryOf(mc, now);
      return { module: m, cards: mc.length, pct, name: nameFor(m.id),
        unlocked: mc.length >= UNLOCK_MIN_CARDS && pct >= UNLOCK_PCT, record: won.get(m.id) || null };
    })
    .filter((b) => b.cards > 0);
}

/** A boss round: the module's quiz questions, topped up with its cards. */
export function questionsFor(classId, moduleId, n = 10) {
  const qs = quiz.buildQuiz({ classId, moduleIds: [moduleId] }, n);
  if (qs.length >= n) return qs;
  const cards = deck.forClass(classId).filter((c) => c.moduleId === moduleId)
    .sort(() => Math.random() - 0.5).slice(0, n - qs.length)
    .map((c) => ({ id: 'bc_' + c.id, type: 'short', topic: c.topic, prompt: c.q, answer: c.a, explanation: '' }));
  return [...qs, ...cards];
}

export function fight(classId, moduleId) {
  const b = bossesFor(classId).find((x) => x.module.id === moduleId);
  if (!b) return null;
  const qs = questionsFor(classId, moduleId);
  return window.SOS.quizUi.startQuiz({ classId, moduleIds: [moduleId] }, {
    mode: 'boss', questions: qs, n: qs.length, title: `Boss: ${b.module.name}`,
    boss: {
      name: b.name,
      onWin: ({ correct, total }) => {
        const prev = b.record || {};
        progress.recordBoss(classId, moduleId, { defeatedAt: Date.now(), wins: (prev.wins || 0) + 1,
          best: Math.max(prev.best || 0, Math.round((correct / Math.max(1, total)) * 100)), name: b.name });
      },
    },
  });
}

export function openBossList(classId) {
  ensureStyles();
  const cls = store.getClass(classId);
  const list = bossesFor(classId);
  const topics = deck.topicBreakdown(classId);
  const el = document.createElement('div');
  el.className = 'sos-quiz';
  const bar = (pct, color) => `<div style="height:8px;background:var(--bg4);border-radius:4px;overflow:hidden"><i style="display:block;height:100%;width:${pct}%;background:${color}"></i></div>`;
  el.innerHTML = `<div class="sos-quiz-top"><button class="sos-quiz-x">✕</button><span>Bosses & mastery · ${esc(cls ? cls.name : '')}</span></div>
    <div class="sos-quiz-body"><div class="sos-quiz-card">
      <div class="sos-quiz-q" style="font-size:16px">🐉 Boss fights</div>
      <div style="font-family:var(--mono);font-size:11px;color:var(--text3)">A module's boss unlocks at ${UNLOCK_PCT}% mastery over ${UNLOCK_MIN_CARDS}+ cards. Mastery is how much you would recall right now — reviews raise it, time lowers it.</div>
      ${list.length ? list.map((b) => `
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:10px 12px;display:grid;gap:6px">
          <div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${esc(b.module.name)}</b>
            <span style="font-family:var(--mono);font-size:11px;color:var(--text3)">${b.cards} cards · ${b.pct}%</span></div>
          ${bar(b.pct, b.unlocked ? '#8fd6ad' : 'var(--accent)')}
          <div style="display:flex;gap:8px;align-items:center;font-size:13px">
            <span style="flex:1;color:var(--text2)">${b.record ? `✅ Defeated ${esc(b.name)} (${b.record.wins || 1}×, best ${b.record.best || 0}%)` : b.unlocked ? `${esc(b.name)} awaits.` : b.cards < UNLOCK_MIN_CARDS ? `Needs ${UNLOCK_MIN_CARDS - b.cards} more cards.` : `Unlocks at ${UNLOCK_PCT}% — ${UNLOCK_PCT - b.pct} to go.`}</span>
            <button class="sos-quiz-btn${b.unlocked ? ' primary' : ''}" data-fight="${esc(b.module.id)}" ${b.unlocked ? '' : 'disabled'}>${b.record ? 'Rematch' : 'Fight'}</button>
          </div></div>`).join('') : '<div style="color:var(--text3)">No modules with cards yet.</div>'}
      <div class="sos-quiz-q" style="font-size:16px;margin-top:10px">📊 Mastery by topic</div>
      ${topics.length ? topics.map((t) => `<div style="display:grid;grid-template-columns:minmax(120px,1fr) 2fr 44px;gap:10px;align-items:center;font-size:13px">
          <span>${esc(t.topic)}</span>${bar(t.pct, t.pct >= 80 ? '#8fd6ad' : t.pct >= 50 ? '#f0bd86' : '#ef9f9f')}<span style="font-family:var(--mono);font-size:11px;color:var(--text3)">${t.pct}%</span></div>`).join('')
        : '<div style="color:var(--text3)">Topics appear once cards exist.</div>'}
    </div></div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.querySelector('.sos-quiz-x').onclick = close;
  el.querySelectorAll('[data-fight]').forEach((btn) => { btn.onclick = () => { close(); fight(classId, btn.dataset.fight); }; });
}

export default { openBossList, fight, bossesFor, masteryOf, questionsFor, UNLOCK_PCT, UNLOCK_MIN_CARDS };
