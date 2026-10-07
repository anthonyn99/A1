/* ============================================================================
 * StudyOS — review surface  (Mochi-style; overhaul §5.4–5.6)
 * ============================================================================
 * The full-screen study mode. One card at a time, centred, big type, quiet
 * chrome. Three ways in:
 *
 *   learn   new cards. Show the front, flip, then "Add to reviews" (Space) or
 *           "Again" (F) — Again keeps it in this session, a few cards back.
 *           She is never asked to RATE a card she is seeing for the first time.
 *   review  due cards. Forgot (1 / F) or Remembered (2 / J / Space).
 *           Mochi's re-review: the first Forgot does not commit a lapse — the
 *           card comes back ~5 cards later; Remembered then commits Hard (a
 *           short interval), Forgot commits Again (relearning).
 *           "Advanced grading" in settings brings back Again/Hard/Good/Easy.
 *   cram    any deck, schedule ignored, nothing written (exam mode).
 *   important  (opts.important) a document's Important pile: every card she
 *           ever marked Forgot, due or not, graded for real. Remembered there
 *           takes a card out of the pile until she forgets it again.
 *   study   (the default) due cards, then new ones within today's cap.
 *
 * Every action is one key: E edit, A archive, Del delete, U undo (any of
 * grade / edit / archive / delete), S source, ? shortcuts, Esc close.
 *
 * ── PHONE FIRST ───────────────────────────────────────────────────────────
 * Twenty minutes between classes is the biggest reclaimable block in a
 * student's day, and it is dead time because nothing else is usable
 * one-handed. The whole card face is the reveal target, and the answer
 * buttons are a fixed bottom row (56px) above the safe-area inset.
 *
 * ── WHY IT MOUNTS OUTSIDE #study-root ─────────────────────────────────────
 * It must cover the sticky header and the bottom nav, so the app's design
 * tokens (scoped to #study-root) are re-declared here, as .sos-modal does.
 *
 * ── UNDO IS NOT OPTIONAL ──────────────────────────────────────────────────
 * A mis-tap on a phone is common and would otherwise silently corrupt a
 * card's schedule. Every action snapshots the card first; undo puts the
 * snapshot back. That works because fsrs.review() is pure.
 * ------------------------------------------------------------------------- */

import * as deck from './deck.js';
import * as cards from './cards.js';
import { renderCard, closeEnough, escapeHtml as esc } from './md.js';
import { store } from './store.js';
import { cardSettings } from './card-settings.js';

const G = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };
const GRADES4 = [
  { g: 1, key: '1', label: 'Again', tone: 'bad' },
  { g: 2, key: '2', label: 'Hard', tone: 'mid' },
  { g: 3, key: '3', label: 'Good', tone: 'good' },
  { g: 4, key: '4', label: 'Easy', tone: 'blue' },
];
const REREVIEW_GAP = 5;            // a forgotten card comes back this many cards later
const AGAIN_GAP = 4;               // a new card she wants again, this many back

let _open = null;                  // the live session, so a second call cannot stack two

function styleOnce() {
  if (document.getElementById('sos-review-css')) return;
  const el = document.createElement('style');
  el.id = 'sos-review-css';
  el.textContent = `
.sos-review {
  /* Tokens are scoped to #study-root and this mounts outside it. */
  --bg:#1B1C1E; --bg2:#1f2022; --bg3:#26272A; --bg4:#2e2f33;
  --border:rgba(255,255,255,0.09); --text:#ECECEE; --text2:#AFB0B5; --text3:#76777C;
  --accent:#8D769A; --good:#7fc8a0; --bad:#e39a9a; --mono:'IBM Plex Mono',monospace; --sans:'Nunito',sans-serif;
  position:fixed; inset:0; z-index:10300; background:var(--bg2);
  display:flex; flex-direction:column; color:var(--text); font-family:var(--sans);
  padding-top:env(safe-area-inset-top,0px);
}
.sos-review-top { display:flex; align-items:center; gap:12px; padding:10px 16px; flex-shrink:0;
  font-family:var(--mono); font-size:11px; color:var(--text3); }
.sos-review-crumb { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sos-review-progress { height:2px; background:var(--bg4); flex-shrink:0; }
.sos-review-progress > i { display:block; height:100%; background:var(--accent); transition:width .2s; }
.sos-review-x { background:none; border:1px solid var(--border); color:var(--text3); border-radius:6px;
  cursor:pointer; font-size:14px; line-height:1; min-width:34px; min-height:34px; }
.sos-review-body { flex:1; display:flex; flex-direction:column; min-height:0; }
/* The whole face is the reveal target — a thumb should not have to aim. */
.sos-review-face { flex:1; overflow-y:auto; cursor:pointer; -webkit-tap-highlight-color:transparent;
  display:flex; flex-direction:column; align-items:center; padding:32px 20px 24px; }
.sos-review-col { width:100%; max-width:680px; margin:auto 0; }
.sos-review-mode { font-family:var(--mono); font-size:10px; letter-spacing:.06em; text-transform:uppercase;
  color:var(--text3); margin-bottom:14px; }
.sos-review-q { font-size:22px; line-height:1.55; }
.sos-review-a { font-size:18px; line-height:1.6; color:var(--text); border-top:1px solid var(--border);
  margin-top:22px; padding-top:22px; }
.sos-review-extra { font-size:14px; line-height:1.55; color:var(--text3); margin-top:14px; }
.sos-review-q p, .sos-review-a p { margin:0 0 .6em; } .sos-review-q p:last-child, .sos-review-a p:last-child { margin-bottom:0; }
.sos-review-face pre { background:var(--bg3); border:1px solid var(--border); border-radius:6px; padding:10px 12px;
  overflow-x:auto; font-size:13.5px; line-height:1.5; text-align:left; }
.sos-review-face code { font-family:var(--mono); font-size:.88em; background:var(--bg3); padding:1px 4px; border-radius:3px; }
.sos-review-face pre code { background:none; padding:0; }
.sos-review-face table { border-collapse:collapse; font-size:15px; margin:6px 0; }
.sos-review-face th, .sos-review-face td { border:1px solid var(--border); padding:5px 10px; text-align:left; }
.sos-review-face ul, .sos-review-face ol { padding-left:1.3em; margin:.3em 0; }
.cz-hole { color:var(--accent); font-weight:700; }
.cz-ans { background:rgba(141,118,154,.28); color:var(--text); border-radius:3px; padding:0 3px; }
.sos-review-hint { font-family:var(--mono); font-size:11px; color:var(--text3); margin-top:26px; }
.sos-review-type { margin-top:18px; width:100%; background:var(--bg3); border:1px solid var(--border); color:var(--text);
  border-radius:6px; padding:10px 12px; font:16px var(--sans); }
.sos-review-typed { font-family:var(--mono); font-size:12px; margin-top:10px; }
.sos-review-bar { flex-shrink:0; padding:10px 14px; padding-bottom:calc(10px + env(safe-area-inset-bottom,0px)); }
.sos-review-btns { display:grid; gap:10px; max-width:680px; margin:0 auto; }
.sos-review-btns.two { grid-template-columns:1fr 1fr; } .sos-review-btns.four { grid-template-columns:repeat(4,1fr); }
.sos-review-btn { min-height:56px; border-radius:10px; border:1px solid var(--border); background:var(--bg3);
  color:var(--text); cursor:pointer; display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:2px; font:600 15px var(--sans); }
.sos-review-btn small { font-family:var(--mono); font-size:10px; color:var(--text3); font-weight:400; }
.sos-review-btn.bad { border-color:rgba(227,154,154,.35); } .sos-review-btn.bad span { color:var(--bad); }
.sos-review-btn.good { border-color:rgba(127,200,160,.35); } .sos-review-btn.good span { color:var(--good); }
.sos-review-btn.mid span { color:#f0bd86; } .sos-review-btn.blue span { color:#9dc0ee; }
.sos-review-tools { display:flex; gap:6px; justify-content:center; padding:0 14px 8px; flex-shrink:0; flex-wrap:wrap; }
.sos-review-tools button { background:none; border:none; color:var(--text3); font-family:var(--mono); font-size:11px;
  cursor:pointer; padding:6px 8px; min-height:32px; border-radius:6px; }
.sos-review-tools button:hover { color:var(--text2); background:var(--bg3); }
.sos-review-tools button:disabled { opacity:.35; cursor:default; background:none; }
.sos-review-recap { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px;
  padding:30px 20px; text-align:center; }
.sos-review-recap h2 { font-family:'Lora',serif; font-size:26px; margin:0; color:var(--accent); }
.sos-review-stat { font-family:var(--mono); font-size:13px; color:var(--text2); }
.sos-review-edit { flex:1; display:flex; flex-direction:column; gap:10px; padding:20px; max-width:760px; width:100%;
  margin:0 auto; min-height:0; }
.sos-review-edit textarea { flex:1; min-height:160px; background:var(--bg3); border:1px solid var(--border); color:var(--text);
  border-radius:8px; padding:12px; font:14px/1.55 var(--mono); resize:none; }
.sos-review-edit .pv { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:12px 14px;
  max-height:34vh; overflow:auto; font-size:15px; line-height:1.5; }
.sos-review-edit .row { display:flex; gap:8px; justify-content:flex-end; align-items:center; }
.sos-review-edit .row span { flex:1; font-family:var(--mono); font-size:11px; color:var(--text3); }
.sos-review-edit button, .sos-review-recap button { border-radius:8px; border:1px solid var(--border); background:var(--bg3);
  color:var(--text); padding:10px 18px; cursor:pointer; font:600 13px var(--sans); }
.sos-review-edit button.primary, .sos-review-recap button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.sos-review-toast { position:absolute; left:50%; bottom:calc(150px + env(safe-area-inset-bottom,0px)); transform:translateX(-50%);
  background:var(--bg4); border:1px solid var(--border); border-radius:8px; padding:8px 12px; font-size:13px;
  display:flex; gap:10px; align-items:center; }
.sos-review-toast button { background:none; border:none; color:var(--accent); font-weight:700; cursor:pointer; }
.sos-review-help { position:absolute; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:center; justify-content:center; }
.sos-review-help > div { background:var(--bg3); border:1px solid var(--border); border-radius:10px; padding:18px 22px;
  font-size:13px; line-height:2; min-width:260px; }
.sos-review-help kbd { font-family:var(--mono); font-size:11px; background:var(--bg4); border-radius:4px; padding:1px 6px; margin-right:8px; }
.sos-review-face.flip { animation:sosFlip .14s ease-out; }
@keyframes sosFlip { from { opacity:.35; transform:translateY(4px); } to { opacity:1; transform:none; } }
@media (prefers-reduced-motion: reduce) { .sos-review-face.flip { animation:none; } .sos-review-progress > i { transition:none; } }
@media (min-width:760px) { .sos-review-q { font-size:25px; } .sos-review-btn { min-height:52px; } }`;
  document.head.appendChild(el);
}

/** How a unit reads: front, back, extra — Markdown with cloze marks. */
export function faces(card, unit) {
  if (!card) return null;
  if (cards.isClozeCard(card)) {
    const n = unit.cloze || cards.clozeNumbers(card.q)[0] || 1;
    return {
      front: cards.clozeText(card.q, n, false, { marks: true }),
      back: cards.clozeText(card.q, n, true, { marks: true }),
      answer: cards.clozeAnswer(card.q, n),
      note: card.a || '', extra: card.extra || '', cloze: true,
    };
  }
  if (unit.reverse) return { front: card.a, back: card.q, extra: card.extra || '', cloze: false };
  return { front: card.q, back: card.a, extra: card.extra || '', cloze: false };
}

const fmt = (d) => (d == null ? '' : d === 0 ? 'now' : d === 1 ? '1d' : d < 30 ? d + 'd' : d < 365 ? Math.round(d / 30) + 'mo' : Math.round(d / 365) + 'y');

/**
 * Start a session.
 * @param scope { classId } | { classId, noteId } | { notePrefix } | { deck } | { tag } | { ids } | {}
 * @param opts  { mode: 'study'|'learn'|'review'|'cram', limit, maxNew, cramWrites, title, units }
 */
export function startReview(scope = {}, opts = {}) {
  if (_open) return _open;                 // never stack two sessions
  styleOnce();
  // Important: every card she forgot, due or not, graded for real — so it is
  // cram's queue with its writes on. Remembered here takes a card out again.
  if (opts.important) {
    scope = { ...scope, important: true };
    opts = { ...opts, mode: 'cram', cramWrites: true };
  }
  const set = cardSettings();
  const mode = opts.mode || 'study';
  const cram = mode === 'cram';
  const eligible = set.onlyReadLessons && !opts.anyNew ? deck.fromReadLesson : null;

  const queue = (opts.units ? opts.units.slice()
    : cram ? deck.cramUnits(scope, { limit: opts.limit })
    : deck.studyQueue(scope, { mode, eligible, limit: opts.limit, maxNew: opts.maxNew })).map((u) => ({ ...u }));

  if (!queue.length) {
    const c = deck.countsFor(scope.classId || null);
    const why = c.waiting && mode !== 'review'
      ? `${c.waiting} new card${c.waiting === 1 ? ' waits' : 's wait'} in lessons you haven't opened yet.`
      : mode === 'learn' && !deck.newRemaining(Date.now(), scope.classId) ? 'You have learned today\'s new cards. More tomorrow.'
      : 'No cards are waiting for this selection.';
    try { window.showNotif && window.showNotif('✅', 'Nothing to study', why); } catch (e) {}
    return null;
  }

  const cls = scope.classId ? store.getClass(scope.classId) : null;
  const started = Date.now();
  const stats = { learned: 0, reviewed: 0, remembered: 0, forgot: 0, edited: 0, archived: 0, deleted: 0 };
  let i = 0, revealed = false, typed = null, editing = false, helpOpen = false;
  const history = [];                       // undo stack: { card, queue, i, stats, label }
  let logged = false;                       // an undo from the recap must not log the session twice

  const el = document.createElement('div');
  el.className = 'sos-review';
  el.innerHTML = `
    <div class="sos-review-top">
      <button class="sos-review-x" data-close title="Close (Esc)">✕</button>
      <span class="sos-review-crumb" data-crumb></span>
      <span data-count></span>
    </div>
    <div class="sos-review-progress"><i style="width:0%"></i></div>
    <div class="sos-review-body"></div>`;
  document.body.appendChild(el);

  const body = el.querySelector('.sos-review-body');
  const bar = el.querySelector('.sos-review-progress > i');
  const countEl = el.querySelector('[data-count]');
  const crumbEl = el.querySelector('[data-crumb]');

  function close() {
    document.removeEventListener('keydown', onKey, true);
    el.remove();
    _open = null;
    try { window.updateStats && window.updateStats(); } catch (e) {}
  }

  const unit = () => queue[i];
  const cardOf = (u) => (u ? deck.get(u.id) : null);

  /** class › document › topic, from what the card knows. */
  function crumb(card) {
    const c = store.getClass(card.classId);
    const parts = [c ? (c.code || c.name) : ''];
    const m = /^topic_(.+)_(t[0-9a-z]+)$/.exec(String(card.sourceNoteId || ''));
    if (m) {
      const bd = window.SOS && window.SOS.breakdown;
      const doc = bd && bd.peek && bd.peek(m[1]);
      parts.push(doc ? String(doc.sourceName || '').replace(/\.\w+$/, '') : '');
    }
    parts.push(card.topic || card.sourceTitle || '');
    return parts.filter(Boolean).join(' › ');
  }

  function finish() {
    const mins = Math.max(1, Math.round((Date.now() - started) / 60000));
    const done = stats.learned + stats.reviewed;
    // Studying counts toward streaks and hours exactly as a focus block does
    // (S-3) — logged once per session, not per card.
    try {
      if (window.SOS && window.SOS.sessions && done > 0 && !cram && !logged) {
        logged = true;
        window.SOS.sessions.log(stats.reviewed ? 'review' : 'learn', {
          classId: (scope && scope.classId) || '', startedAt: started, durationMs: Date.now() - started,
          completed: true, cards: done,
          accuracy: stats.reviewed ? Math.round((stats.remembered / stats.reviewed) * 100) : null,
          note: stats.learned ? `${stats.learned} new learned` : '',
        });
      }
    } catch (e) { console.warn('[review] session log failed:', e); }
    const m = cls ? deck.mastery(cls.id) : deck.mastery(null);
    const acc = stats.reviewed ? Math.round((stats.remembered / stats.reviewed) * 100) : null;
    const left = deck.countsFor(scope.classId || null);
    body.innerHTML = `
      <div class="sos-review-recap">
        <h2>${opts.important ? 'Important — done' : cram ? 'Cram done' : 'Done'}</h2>
        ${stats.learned ? `<div class="sos-review-stat">${stats.learned} new learned</div>` : ''}
        ${stats.reviewed ? `<div class="sos-review-stat">${stats.reviewed} reviewed · ${acc}% remembered</div>` : ''}
        <div class="sos-review-stat">${mins} min</div>
        ${cls ? `<div class="sos-review-stat">${esc(cls.name)} — ${m.pct}% mastered</div>` : ''}
        ${!cram && mode !== 'learn' && left.newAvailable
          ? `<button data-more>Learn ${left.newAvailable} new card${left.newAvailable === 1 ? '' : 's'}</button>` : ''}
        <button class="primary" data-close style="min-width:120px;margin-top:6px">Close</button>
      </div>`;
    bar.style.width = '100%';
    countEl.textContent = '';
    body.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
    const more = body.querySelector('[data-more]');
    if (more) more.onclick = () => { close(); startReview(scope, { ...opts, mode: 'learn' }); };
  }

  function render(flip = false) {
    // Skip units whose card was deleted or archived elsewhere mid-session.
    while (i < queue.length && !(cardOf(queue[i]) && deck.statusOf(cardOf(queue[i])) === 'active')) i++;
    if (i >= queue.length) return finish();
    editing = false;
    const u = unit(), card = cardOf(u), f = faces(card, u);
    const isLearn = u.isNew && !cram;
    countEl.textContent = `${i + 1} / ${queue.length}`;
    bar.style.width = Math.round((i / queue.length) * 100) + '%';
    crumbEl.textContent = crumb(card);
    const typing = set.typeCloze && f.cloze && !revealed;
    const label = cram ? (opts.important ? 'Important' : 'Cram') : isLearn ? 'New card' : u.rereview ? 'Again — try once more' : 'Review';
    const answerHtml = !revealed ? '' : f.cloze
      ? `${f.note ? `<div class="sos-review-a">${renderCard(f.note)}</div>` : ''}`
      : `<div class="sos-review-a">${renderCard(f.back)}</div>`;
    const typedHtml = revealed && typed != null
      ? `<div class="sos-review-typed" style="color:${closeEnough(typed, f.answer) ? 'var(--good)' : 'var(--bad)'}">${
          closeEnough(typed, f.answer) ? '✓' : '✗'} you typed: ${esc(typed || '(nothing)')}</div>` : '';
    body.innerHTML = `
      <div class="sos-review-face${flip ? ' flip' : ''}" data-face>
        <div class="sos-review-col">
          <div class="sos-review-mode">${esc(label)}</div>
          <div class="sos-review-q">${renderCard(revealed && f.cloze ? f.back : f.front)}</div>
          ${typing ? '<input class="sos-review-type" data-type placeholder="Type the hidden text, then Enter" autocomplete="off" spellcheck="false">' : ''}
          ${typedHtml}${answerHtml}
          ${revealed && f.extra ? `<div class="sos-review-extra">${renderCard(f.extra)}</div>` : ''}
          ${revealed && (card.tags || []).includes('leech') ? `<div class="sos-review-extra" data-leech>This card keeps slipping.
            <button class="sos-review-x" data-act="rewrite" style="min-width:0;padding:4px 10px;font-size:12px;margin-left:6px">Rewrite it with AI</button></div>` : ''}
          ${!revealed && !typing ? '<div class="sos-review-hint">tap or Space to reveal</div>' : ''}
        </div>
      </div>
      ${revealed ? `<div class="sos-review-bar">${buttonsHtml(u, isLearn)}</div>` : ''}
      <div class="sos-review-tools">
        <button data-act="undo" title="Undo (U)" ${history.length ? '' : 'disabled'}>↶ undo</button>
        <button data-act="edit" title="Edit (E)">edit</button>
        <button data-act="archive" title="Archive (A)">archive</button>
        <button data-act="delete" title="Delete (Del)">delete</button>
        ${sourceOf(card) ? '<button data-act="src" title="Source (S)">source</button>' : ''}
        <button data-act="skip" title="Skip">skip</button>
        <button data-act="help" title="Shortcuts (?)">?</button>
      </div>`;
    body.querySelector('[data-face]').onclick = (e) => { if (!e.target.closest('input')) reveal(); };
    body.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => answer(b.dataset.a); });
    body.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => tool(b.dataset.act); });
    const inp = body.querySelector('[data-type]');
    if (inp) {
      inp.focus();
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); typed = inp.value; reveal(); }
      });
    }
  }

  function buttonsHtml(u, isLearn) {
    if (isLearn) {
      return `<div class="sos-review-btns two">
        <button class="sos-review-btn" data-a="again"><span>Again</span><small>F</small></button>
        <button class="sos-review-btn good" data-a="add"><span>Add to reviews</span><small>Space</small></button></div>`;
    }
    if (cram) {
      return `<div class="sos-review-btns two">
        <button class="sos-review-btn bad" data-a="forgot"><span>Forgot</span><small>1 · F</small></button>
        <button class="sos-review-btn good" data-a="remembered"><span>Remembered</span><small>2 · Space</small></button></div>`;
    }
    const p = deck.previewCard(u.id, Date.now(), u.sub) || {};
    if (set.advancedGrading) {
      return `<div class="sos-review-btns four">${GRADES4.map((g) => `
        <button class="sos-review-btn ${g.tone}" data-a="g${g.g}"><span>${g.label}</span>
          <small>${g.key} · ${fmt(p[g.label.toLowerCase()] && p[g.label.toLowerCase()].days)}</small></button>`).join('')}</div>`;
    }
    const rem = u.rereview ? p.hard : p.good;
    return `<div class="sos-review-btns two">
      <button class="sos-review-btn bad" data-a="forgot"><span>Forgot</span><small>${u.rereview ? fmt(p.again && p.again.days) : 'again soon'}</small></button>
      <button class="sos-review-btn good" data-a="remembered"><span>Remembered</span><small>${fmt(rem && rem.days)}</small></button></div>`;
  }

  function reveal() {
    if (revealed || editing || i >= queue.length) return;
    revealed = true;
    render(true);
  }

  function snapshot(label) {
    const card = cardOf(unit());
    history.push({ card: card ? JSON.parse(JSON.stringify(card)) : null, queue: queue.map((u) => ({ ...u })),
      i, stats: { ...stats }, label });
    if (history.length > 30) history.shift();
  }

  function next() { i++; revealed = false; typed = null; render(); }

  function commit(grade) { const u = unit(); deck.gradeCard(u.id, grade, { sub: u.sub }); }

  /** Put a unit back into the queue `gap` cards later. */
  function later(u, gap, extra) {
    const at = Math.min(queue.length, i + 1 + gap);
    queue.splice(at, 0, { ...u, ...extra });
  }

  function answer(a) {
    if (!revealed || i >= queue.length) return;
    const u = unit();
    const isLearn = u.isNew && !cram;
    snapshot(a);
    if (isLearn) {
      if (a === 'add') { commit(G.GOOD); stats.learned++; }
      else if (a === 'again') later(u, AGAIN_GAP, { again: (u.again || 0) + 1 });
      else return;
      return next();
    }
    // Any Forgot puts the card in its document's Important pile; only a
    // Remembered inside an Important session takes it out. The snapshot above
    // already holds the flag, so undo puts it back too.
    if (a === 'forgot' || a === 'g1') deck.setImportant(u.id, true);
    else if (opts.important && (a === 'remembered' || /^g[234]$/.test(a))) deck.setImportant(u.id, false);
    if (cram) {
      if (a === 'forgot') {
        stats.reviewed++; stats.forgot++;
        if (!u.crammed) queue.push({ ...u, crammed: true });
        if (opts.cramWrites) commit(G.AGAIN);
      } else if (a === 'remembered') {
        stats.reviewed++; stats.remembered++;
        if (opts.cramWrites) commit(G.GOOD);
      } else return;
      return next();
    }
    if (a.startsWith('g')) {
      const g = Number(a.slice(1));
      commit(g);
      stats.reviewed++;
      if (g === G.AGAIN) { stats.forgot++; if (!u.requeued) queue.push({ ...u, requeued: true }); }
      else stats.remembered++;
      return next();
    }
    if (a === 'forgot') {
      if (u.rereview) { commit(G.AGAIN); stats.reviewed++; stats.forgot++; }
      else { later(u, REREVIEW_GAP, { rereview: true }); }
    } else if (a === 'remembered') {
      commit(u.rereview ? G.HARD : G.GOOD);
      stats.reviewed++;
      if (!u.rereview) stats.remembered++;
    } else return;
    next();
  }

  function undo() {
    const h = history.pop();
    if (!h) return;
    if (h.card) deck.restoreCard(h.card);
    queue.length = 0;
    h.queue.forEach((u) => queue.push(u));
    i = h.i;
    Object.assign(stats, h.stats);
    revealed = false; typed = null;
    hideToast();
    render();
  }

  // ── Tools ────────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(text) {
    hideToast();
    const t = document.createElement('div');
    t.className = 'sos-review-toast';
    t.innerHTML = `<span>${esc(text)}</span><button data-undo>Undo</button>`;
    t.querySelector('[data-undo]').onclick = undo;
    el.appendChild(t);
    toastTimer = setTimeout(hideToast, 5000);
  }
  function hideToast() { clearTimeout(toastTimer); const t = el.querySelector('.sos-review-toast'); if (t) t.remove(); }

  /** Drop every later unit of a card (archived or deleted mid-session). */
  function dropCard(id) {
    for (let k = queue.length - 1; k > i; k--) if (queue[k].id === id) queue.splice(k, 1);
    queue.splice(i, 1);
  }

  function tool(act) {
    if (i >= queue.length) return;
    const u = unit(), card = cardOf(u);
    if (act === 'undo') return undo();
    if (act === 'help') return help();
    if (act === 'skip') { revealed = false; typed = null; i++; return render(); }
    if (act === 'src') return openSource(card);
    if (act === 'edit') return edit(card);
    if (act === 'rewrite') {
      const C = window.SOS && window.SOS.cardsUi;
      const box = body.querySelector('[data-leech]');
      if (!C) return;
      snapshot('rewrite');
      if (box) box.textContent = 'Rewriting…';
      C.rewriteLeech(card).then((r) => {
        if (i < queue.length && unit().id === card.id) render();
        toast(r.added.length ? `Rewritten as ${r.added.length + 1} cards.` : 'Rewritten.');
      }, (err) => { if (box) box.textContent = 'Could not rewrite: ' + ((err && err.message) || err); });
      return;
    }
    if (act === 'archive') {
      snapshot('archive');
      deck.setStatus(card.id, 'archived');
      stats.archived++;
      dropCard(card.id); revealed = false; typed = null;
      render(); toast('Archived — out of your reviews.');
      return;
    }
    if (act === 'delete') {
      snapshot('delete');
      deck.remove(card.classId, card.id);
      stats.deleted++;
      dropCard(card.id); revealed = false; typed = null;
      render(); toast('Card deleted.');
    }
  }

  function edit(card) {
    editing = true;
    const content = cards.contentOf(card);
    body.innerHTML = `
      <div class="sos-review-edit">
        <div class="row"><span>Markdown · a line with --- separates the sides · {{1::hidden}} makes a cloze</span></div>
        <textarea data-ed spellcheck="true">${esc(content)}</textarea>
        <div class="pv" data-pv></div>
        <div class="row"><span>Ctrl+Enter save · Esc cancel</span>
          <button data-cancel>Cancel</button><button class="primary" data-save>Save</button></div>
      </div>`;
    const ta = body.querySelector('[data-ed]'), pv = body.querySelector('[data-pv]');
    const preview = () => {
      const tmp = cards.withContent(card, { content: ta.value });
      const f = faces(tmp, { cloze: cards.clozeNumbers(tmp.q)[0] || 1 });
      pv.innerHTML = `<div style="font-size:11px;color:var(--text3);font-family:var(--mono)">FRONT</div>${renderCard(f.front)}
        <div style="font-size:11px;color:var(--text3);font-family:var(--mono);margin-top:10px">BACK</div>${renderCard(f.cloze ? f.back : f.back || '')}${
        f.extra ? `<div class="sos-review-extra">${renderCard(f.extra)}</div>` : ''}`;
    };
    preview();
    ta.addEventListener('input', preview);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editing = false; render(); }
      // Ctrl+Shift+C wraps the selection in the next cloze number.
      if (e.key.toLowerCase() === 'c' && e.ctrlKey && e.shiftKey) { e.preventDefault(); wrapCloze(ta); preview(); }
    });
    const save = () => {
      if (!ta.value.trim()) return;
      snapshot('edit');
      deck.edit(card.id, { content: ta.value });
      stats.edited++;
      editing = false;
      const c2 = deck.get(card.id);
      // A card that became (or stopped being) a cloze changes its units:
      // rebuild this card's place in the queue from its new units.
      const units = cards.unitsOf(c2);
      if (!units.some((x) => x.key === unit().sub)) queue[i] = { ...unit(), sub: units[0].key, cloze: units[0].cloze || 0 };
      else if (units[0].cloze) queue[i] = { ...unit(), cloze: units.find((x) => x.key === unit().sub).cloze };
      render();
    };
    body.querySelector('[data-save]').onclick = save;
    body.querySelector('[data-cancel]').onclick = () => { editing = false; render(); };
    ta.focus();
  }

  function help() {
    if (helpOpen) return;
    helpOpen = true;
    const h = document.createElement('div');
    h.className = 'sos-review-help';
    const rows = [
      ['Space', 'reveal, then Remembered / Add to reviews'], ['1 · F', 'Forgot / Again'], ['2 · J', 'Remembered'],
      ['E', 'edit the card'], ['A', 'archive (out of reviews)'], ['Del', 'delete'], ['U', 'undo'],
      ['S', 'open the source lesson'], ['Esc', 'close'],
    ];
    h.innerHTML = `<div>${rows.map(([k, v]) => `<div><kbd>${k}</kbd>${v}</div>`).join('')}</div>`;
    h.onclick = () => { h.remove(); helpOpen = false; };
    el.appendChild(h);
  }

  function onKey(e) {
    if (helpOpen) { e.preventDefault(); el.querySelector('.sos-review-help').click(); return; }
    if (editing) return;                               // the editor's own handler
    if (e.target && /input|textarea/i.test(e.target.tagName)) {
      if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'Escape') { e.preventDefault(); return close(); }
    // Undo works from the recap too: archiving the last card ends the session.
    if (k === 'u') { e.preventDefault(); return undo(); }
    if (i >= queue.length) return;
    const u = unit();
    const isLearn = u && u.isNew && !cram;
    const handled = () => e.preventDefault();
    if (k === ' ' || k === 'Enter') {
      handled();
      if (!revealed) return reveal();
      if (isLearn) return answer('add');
      return answer(set.advancedGrading && !cram ? 'g3' : 'remembered');
    }
    if (k === 'e') { handled(); return tool('edit'); }
    if (k === 'a') { handled(); return tool('archive'); }
    if (k === 'Delete') { handled(); return tool('delete'); }
    if (k === 's') { handled(); return tool('src'); }
    if (k === '?') { handled(); return help(); }
    if (!revealed) return;
    if (set.advancedGrading && !cram && !isLearn && /^[1-4]$/.test(k)) { handled(); return answer('g' + k); }
    if (k === '1' || k === 'f') { handled(); return answer(isLearn ? 'again' : 'forgot'); }
    if (k === '2' || k === 'j') { handled(); return answer(isLearn ? 'add' : 'remembered'); }
  }

  el.querySelector('[data-close]').onclick = close;
  // Capture phase: the app installs its own Escape handlers, and this overlay
  // is on top, so it must win.
  document.addEventListener('keydown', onKey, true);

  render();
  _open = { close, el, queue, mode };
  return _open;
}

/** Where a card came from, to open: its lesson, or its class. */
function sourceOf(card) {
  if (!card) return null;
  const m = /^topic_(.+)_(t[0-9a-z]+)$/.exec(String(card.sourceNoteId || ''));
  if (m) return { fileId: m[1], topicId: m[2] };
  return card.classId ? { classId: card.classId } : null;
}

function openSource(card) {
  const src = sourceOf(card);
  if (!src) return;
  closeReview();
  try {
    const L = window.SOS && window.SOS.lessonUi;
    if (src.topicId && L) {
      L.open(src.fileId, src.topicId, { page: card.sourceSlide }).then((ok) => {
        if (!ok && window.switchView) window.switchView('class', card.classId);
      });
      return;
    }
    if (window.switchView) window.switchView('class', card.classId);
    window.showNotif && window.showNotif('📄', 'Source', card.sourceTitle
      ? `${card.sourceTitle}${card.sourceSlide != null ? ' · slide ' + card.sourceSlide : ''}`
      : 'Opened the class.');
  } catch (e) {}
}

/** Wrap a textarea's selection in the next free cloze number. */
export function wrapCloze(ta) {
  const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
  if (a === b) return;
  const used = cards.clozeNumbers(v);
  const n = used.length ? Math.max(...used) + 1 : 1;
  ta.value = v.slice(0, a) + `{{${n}::${v.slice(a, b)}}}` + v.slice(b);
  ta.selectionStart = ta.selectionEnd = b + String(n).length + 6;
}

/** Close any open session. Exported so a view switch can tear it down. */
export function closeReview() {
  if (_open) _open.close();
}

export const isOpen = () => !!_open;

export default { startReview, closeReview, faces, wrapCloze, isOpen };
