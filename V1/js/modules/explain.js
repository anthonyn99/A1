/* ============================================================================
 * StudyOS — explain it back  (engagement upgrade 4.1)
 * ============================================================================
 * Pick a topic, explain it in your own words (typed, or dictated where the
 * browser supports speech), and get graded against the topic's KEY POINTS —
 * the answers on its flashcards and the kit's key terms.
 *
 *   with the bridge   one Claude ask (kit.py GRADE_SCHEMAS.explain) returns
 *                     {score, covered, missing, misconceptions, cards}; the
 *                     gaps become new flashcards in one tap
 *   without it        she sees the key points and ticks the ones she covered;
 *                     the ones she missed are pulled forward for review today
 *
 * Either way the attempt counts: XP by score, and a weak-spot record whose
 * miss is (1 − score).
 * ------------------------------------------------------------------------- */

import { store } from './store.js';
import * as deck from './deck.js';
import * as progress from './progress.js';
import * as xp from './xp.js';
import { ensureStyles } from './quiz-ui.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Topics with at least two cards, weakest first. */
export function topicsFor(classId) {
  const byTopic = new Map();
  for (const c of deck.forClass(classId)) {
    const t = (c.topic || '').trim();
    if (!t) continue;
    if (!byTopic.has(t)) byTopic.set(t, []);
    byTopic.get(t).push(c);
  }
  const weak = new Map(progress.weakTopics(classId, 50).map((w) => [progress.normTopic(w.topic), w.score]));
  return [...byTopic].filter(([, cs]) => cs.length >= 2)
    .map(([topic, cards]) => ({ topic, cards, weak: weak.get(progress.normTopic(topic)) || 0 }))
    .sort((a, b) => b.weak - a.weak || b.cards.length - a.cards.length);
}

export function keyPoints(cards, max = 15) {
  return cards.slice(0, max).map((c) => `${c.q.replace(/^Define:\s*/, '')} — ${c.a}`);
}

export function gradePrompt(topic, points, explanation) {
  return `A student is explaining "${topic}" from memory, to check their understanding.

KEY POINTS (from their course material):
${points.map((p) => '- ' + p).join('\n')}

STUDENT'S EXPLANATION:
${explanation}`;
}

export function overlay(title) {
  ensureStyles();
  const el = document.createElement('div');
  el.className = 'sos-quiz';
  el.innerHTML = `<div class="sos-quiz-top"><button class="sos-quiz-x">✕</button><span>${esc(title)}</span></div>
    <div class="sos-quiz-body"><div class="sos-quiz-card" data-card></div></div>`;
  document.body.appendChild(el);
  const close = () => { el.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  el.querySelector('.sos-quiz-x').onclick = close;
  return { el, card: el.querySelector('[data-card]'), close };
}

export function open(classId) {
  const cls = store.getClass(classId);
  const topics = topicsFor(classId);
  const ui = overlay('Explain it back · ' + (cls ? cls.name : ''));
  const started = Date.now();
  if (!topics.length) {
    ui.card.innerHTML = `<div class="sos-quiz-q" style="font-size:16px">No topics with cards yet.</div>
      <div style="color:var(--text3)">Generate a study kit for a lecture (⚡ on the file) — its topics show up here.</div>`;
    return ui;
  }
  const P = window.SOS.pipeline;
  const canGrade = !!(P && P.enabled() && P.isLocalBridge && P.isLocalBridge() && P.grade);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  ui.card.innerHTML = `
    <label>Topic <select class="sos-quiz-input" data-topic>${topics.map((t, i) => `<option value="${i}">${esc(t.topic)}${t.weak ? ' · weak spot' : ''} (${t.cards.length} cards)</option>`).join('')}</select></label>
    <div class="sos-quiz-q" style="font-size:15px">Explain it as if teaching a classmate: what it is, why it matters, how it works, an example.</div>
    <textarea class="sos-quiz-input" data-text style="min-height:180px" placeholder="Type your explanation…"></textarea>
    <div class="sos-quiz-row">
      ${SR ? '<button class="sos-quiz-btn" data-mic>🎤 Dictate</button>' : ''}
      <button class="sos-quiz-btn primary" data-go>${canGrade ? 'Grade with Claude' : 'Compare with key points'}</button>
    </div>
    <div style="font-family:var(--mono);font-size:11px;color:var(--text3)">${canGrade ? 'Uses 1 Claude message via the desktop bridge.' : 'Self-check mode — Claude grading needs the desktop bridge.'}</div>
    <div data-out></div>`;
  const q = (s) => ui.card.querySelector(s);
  const out = q('[data-out]');

  if (SR) {
    let rec = null;
    q('[data-mic]').onclick = () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.continuous = true; rec.interimResults = false; rec.lang = 'en-US';
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) q('[data-text]').value += (q('[data-text]').value ? ' ' : '') + e.results[i][0].transcript.trim();
        }
      };
      rec.onend = () => { rec = null; q('[data-mic]').textContent = '🎤 Dictate'; };
      rec.onerror = () => { rec = null; q('[data-mic]').textContent = '🎤 Dictate'; };
      rec.start();
      q('[data-mic]').textContent = '⏹ Stop';
    };
  }

  const finish = (topic, score) => {
    const gained = xp.forExplain(score);
    try { progress.recordAttempt(classId, topic, 1 - score / 100); } catch (e) {}
    try {
      window.SOS.sessions && window.SOS.sessions.log('explain', {
        classId, startedAt: started, durationMs: Date.now() - started, completed: true,
        items: 1, correct: score >= 70 ? 1 : 0, accuracy: score, xp: gained, topic,
      });
    } catch (e) {}
    return gained;
  };

  q('[data-go]').onclick = async () => {
    const t = topics[Number(q('[data-topic]').value)];
    const text = q('[data-text]').value.trim();
    if (!text) { out.innerHTML = '<div class="sos-quiz-fb bad">Write (or dictate) something first.</div>'; return; }
    const points = keyPoints(t.cards);
    q('[data-go]').disabled = true;

    if (canGrade) {
      out.innerHTML = '<div class="sos-quiz-fb">Grading… (~30–60 s)</div>';
      try {
        const g = await P.grade({ kind: 'explain', prompt: gradePrompt(t.topic, points, text), classId });
        const score = g.score == null ? 0 : g.score;
        const gained = finish(t.topic, score);
        const list = (title, items, color) => (items && items.length ? `<div style="margin-top:8px"><b style="color:${color}">${title}</b>${items.map((x) => `<div style="font-size:14px">• ${esc(x)}</div>`).join('')}</div>` : '');
        out.innerHTML = `<div class="sos-quiz-fb ${score >= 70 ? 'ok' : 'bad'}"><div style="font-size:22px;font-weight:800">${score}/100 <span style="font-size:14px;color:#f0bd86">+${gained} XP</span></div>
          ${list('Covered', g.covered, '#8fd6ad')}${list('Missing', g.missing, '#f0bd86')}${list('Misconceptions', g.misconceptions, '#ef9f9f')}</div>
          ${g.cards && g.cards.length ? `<button class="sos-quiz-btn primary" data-cards>Add ${g.cards.length} flashcard${g.cards.length === 1 ? '' : 's'} for the gaps</button>` : ''}
          <button class="sos-quiz-btn" data-again>Explain another topic</button>`;
        const add = out.querySelector('[data-cards]');
        if (add) add.onclick = () => {
          const r = deck.addExternal(classId, t.cards[0].moduleId || '', g.cards.map((c) => ({ ...c, topic: t.topic })),
            { noteId: 'explain_' + progress.normTopic(t.topic), title: 'Explain-it-back' });
          add.disabled = true;
          add.textContent = `${r.added.length} card${r.added.length === 1 ? '' : 's'} added`;
        };
        out.querySelector('[data-again]').onclick = () => { ui.close(); open(classId); };
      } catch (e) {
        out.innerHTML = `<div class="sos-quiz-fb bad">Could not grade: ${esc(e.message)}. Self-check instead:</div>`;
        selfCheck(t, points);
      }
      return;
    }
    selfCheck(t, points);
  };

  function selfCheck(t, points) {
    out.insertAdjacentHTML('beforeend', `<div class="sos-quiz-fb"><b>Key points</b> — tick the ones your explanation covered:
      ${points.map((p, i) => `<label style="display:flex;gap:8px;margin:6px 0;font-size:14px"><input type="checkbox" data-kp="${i}"> <span>${esc(p)}</span></label>`).join('')}</div>
      <button class="sos-quiz-btn primary" data-done>Done</button>`);
    out.querySelector('[data-done]').onclick = () => {
      const ticked = [...out.querySelectorAll('[data-kp]')].map((b) => b.checked);
      const score = Math.round((ticked.filter(Boolean).length / ticked.length) * 100);
      const gained = finish(t.topic, score);
      // Missed points: bring those cards forward so today's review covers them.
      const missedCards = t.cards.slice(0, ticked.length).filter((_, i) => !ticked[i]);
      for (const c of missedCards) {
        if (c.sched && c.sched.state !== 'new') deck.restoreSched(c.id, { ...c.sched, due: Date.now() });
      }
      out.innerHTML = `<div class="sos-quiz-fb ${score >= 70 ? 'ok' : 'bad'}"><div style="font-size:22px;font-weight:800">${score}/100 <span style="font-size:14px;color:#f0bd86">+${gained} XP</span></div>
        ${missedCards.length ? `<div style="margin-top:6px">${missedCards.length} card${missedCards.length === 1 ? '' : 's'} you missed ${missedCards.length === 1 ? 'is' : 'are'} due for review now.</div>` : ''}</div>
        <button class="sos-quiz-btn" data-again>Explain another topic</button>`;
      out.querySelector('[data-again]').onclick = () => { ui.close(); open(classId); };
    };
  }
  return ui;
}

export default { open, overlay, topicsFor, keyPoints, gradePrompt };
