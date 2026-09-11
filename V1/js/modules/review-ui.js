/* ============================================================================
 * StudyOS — review surface  (upgrade spec R-3)
 * ============================================================================
 * The full-screen study mode. One card at a time, tap or Space to reveal, four
 * grades, and a recap at the end.
 *
 * ── PHONE FIRST ───────────────────────────────────────────────────────────
 * The spec calls phone review the killer feature: twenty minutes between
 * classes is the biggest reclaimable block in a student's day, and it is dead
 * time precisely because nothing else is usable one-handed. So the layout is
 * built for thumbs — the whole card face is the reveal target, and the four
 * grade buttons are a fixed bottom row above the safe-area inset, sized to be
 * hit without looking.
 *
 * Keyboard is layered on top for desktop (Space / 1-4 / u / s / Esc), which
 * costs nothing and makes a laptop session fast.
 *
 * ── WHY IT MOUNTS OUTSIDE #study-root ─────────────────────────────────────
 * Same reason .note-fullscreen-overlay does: it must cover the sticky header
 * and the bottom nav. That means the app's design tokens are NOT inherited —
 * they are scoped to #study-root — so the overlay re-declares them, exactly as
 * css/studyos.css:869 already does for .sos-modal.
 *
 * ── UNDO IS NOT OPTIONAL ──────────────────────────────────────────────────
 * A mis-tap on a phone is common and, without undo, silently corrupts a card's
 * schedule with no way back. `u` and a visible button restore the previous
 * scheduling state, which is possible only because fsrs.review() is pure and
 * returns a new object rather than mutating.
 * ------------------------------------------------------------------------- */

import * as deck from './deck.js';
import { store } from './store.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const GRADES = [
  { g: 1, key: '1', label: 'Again', color: '#ef9f9f' },
  { g: 2, key: '2', label: 'Hard',  color: '#f0bd86' },
  { g: 3, key: '3', label: 'Good',  color: '#8fd6ad' },
  { g: 4, key: '4', label: 'Easy',  color: '#9dc0ee' },
];

let _open = null;          // the live session, so a second call cannot stack two

function styleOnce() {
  if (document.getElementById('sos-review-css')) return;
  const el = document.createElement('style');
  el.id = 'sos-review-css';
  el.textContent = `
.sos-review {
  /* Tokens are scoped to #study-root and this mounts outside it. */
  --bg:#1B1C1E; --bg2:#1f2022; --bg3:#26272A; --bg4:#2e2f33;
  --border:rgba(255,255,255,0.09); --text:#ECECEE; --text2:#AFB0B5; --text3:#76777C;
  --accent:#8D769A; --mono:'IBM Plex Mono',monospace; --sans:'Nunito',sans-serif;
  position:fixed; inset:0; z-index:10300; background:var(--bg2);
  display:flex; flex-direction:column; color:var(--text); font-family:var(--sans);
  padding-top:env(safe-area-inset-top,0px);
}
.sos-review-top {
  display:flex; align-items:center; gap:10px; padding:10px 14px;
  border-bottom:1px solid var(--border); flex-shrink:0; font-family:var(--mono); font-size:11px;
}
.sos-review-progress { flex:1; height:4px; background:var(--bg4); border-radius:2px; overflow:hidden; }
.sos-review-progress > i { display:block; height:100%; background:var(--accent); transition:width .25s; }
.sos-review-x {
  background:none; border:1px solid var(--border); color:var(--text3);
  border-radius:4px; cursor:pointer; font-size:14px; line-height:1;
  min-width:34px; min-height:34px;
}
/* The whole face is the reveal target — a thumb should not have to aim. */
.sos-review-face {
  flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:18px; padding:24px 20px; text-align:center; cursor:pointer; overflow-y:auto;
  -webkit-tap-highlight-color:transparent;
}
.sos-review-q { font-size:21px; line-height:1.5; max-width:34ch; white-space:pre-wrap; }
.sos-review-a {
  font-size:17px; line-height:1.6; color:var(--text2); max-width:40ch;
  white-space:pre-wrap; border-top:1px solid var(--border); padding-top:18px;
}
.sos-review-hint { font-family:var(--mono); font-size:11px; color:var(--text3); }
.sos-review-topic { font-family:var(--mono); font-size:10px; color:var(--text3); letter-spacing:.04em; }
.sos-review-grades {
  display:grid; grid-template-columns:repeat(4,1fr); gap:8px; padding:12px 14px;
  padding-bottom:calc(12px + env(safe-area-inset-bottom,0px));
  border-top:1px solid var(--border); flex-shrink:0;
}
.sos-review-grade {
  /* 56px: comfortably above the ~44px minimum touch target, because this is
     the control used most and often one-handed. */
  min-height:56px; border-radius:6px; border:1px solid var(--border);
  background:var(--bg3); color:var(--text); cursor:pointer;
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
  font-family:var(--sans); font-size:13px; font-weight:600;
}
.sos-review-grade small { font-family:var(--mono); font-size:10px; color:var(--text3); font-weight:400; }
.sos-review-actions { display:flex; gap:8px; justify-content:center; padding:0 14px 10px; flex-shrink:0; }
.sos-review-actions button {
  background:none; border:1px solid var(--border); color:var(--text3);
  border-radius:4px; padding:6px 12px; font-family:var(--mono); font-size:11px;
  cursor:pointer; min-height:34px;
}
.sos-review-recap { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; padding:30px 20px; text-align:center; }
.sos-review-recap h2 { font-family:'Lora',serif; font-size:26px; margin:0; color:var(--accent); }
.sos-review-stat { font-family:var(--mono); font-size:13px; color:var(--text2); }
@media (min-width:760px) {
  .sos-review-q { font-size:24px; }
  .sos-review-grades { max-width:720px; margin:0 auto; width:100%; }
  .sos-review-grade { min-height:48px; }
}`;
  document.head.appendChild(el);
}

/**
 * Start a review session.
 * @param scope { classId } | { classId, topic } | { classId, noteId } | {}
 */
export function startReview(scope = {}, opts = {}) {
  if (_open) return _open;                 // never stack two sessions
  styleOnce();

  const queue = deck.buildQueue(scope, opts);
  if (!queue.length) {
    try { window.showNotif && window.showNotif('✅', 'Nothing due', 'No cards are waiting for this selection.'); }
    catch (e) {}
    return null;
  }

  const cls = scope.classId ? store.getClass(scope.classId) : null;
  const started = Date.now();
  const stats = { done: 0, again: 0, good: 0, total: queue.length };
  let i = 0, revealed = false;
  let lastAction = null;                    // { cardId, prevSched } for undo

  const el = document.createElement('div');
  el.className = 'sos-review';
  el.innerHTML = `
    <div class="sos-review-top">
      <button class="sos-review-x" title="Close (Esc)">✕</button>
      <div class="sos-review-progress"><i style="width:0%"></i></div>
      <span data-count></span>
    </div>
    <div class="sos-review-body"></div>`;
  document.body.appendChild(el);

  const body = el.querySelector('.sos-review-body');
  body.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0';
  const bar = el.querySelector('.sos-review-progress > i');
  const countEl = el.querySelector('[data-count]');

  function close() {
    document.removeEventListener('keydown', onKey, true);
    el.remove();
    _open = null;
    try { window.updateStats && window.updateStats(); } catch (e) {}
  }

  function finish() {
    const mins = Math.max(1, Math.round((Date.now() - started) / 60000));
    const m = cls ? deck.mastery(cls.id) : deck.mastery(null);
    const acc = stats.done ? Math.round(((stats.done - stats.again) / stats.done) * 100) : 0;
    body.innerHTML = `
      <div class="sos-review-recap">
        <h2>Done</h2>
        <div class="sos-review-stat">${stats.done} card${stats.done === 1 ? '' : 's'} · ${mins} min · ${acc}% recalled</div>
        ${cls ? `<div class="sos-review-stat">${esc(cls.name)} — ${m.pct}% mastered</div>` : ''}
        ${m.weakest && m.weakest.topic ? `<div class="sos-review-stat" style="color:var(--text3)">weakest: ${esc(m.weakest.topic)}</div>` : ''}
        <button class="sos-review-x" style="padding:10px 20px;min-width:120px;margin-top:8px">Close</button>
      </div>`;
    bar.style.width = '100%';
    body.querySelector('button').onclick = close;
  }

  function render() {
    if (i >= queue.length) return finish();
    const card = queue[i];
    revealed = false;
    countEl.textContent = `${i + 1}/${queue.length}`;
    bar.style.width = Math.round((i / queue.length) * 100) + '%';

    body.innerHTML = `
      <div class="sos-review-face">
        ${card.topic ? `<div class="sos-review-topic">${esc(card.topic)}</div>` : ''}
        <div class="sos-review-q">${esc(card.q)}</div>
        <div class="sos-review-hint">tap to reveal · space</div>
      </div>`;
    body.querySelector('.sos-review-face').onclick = reveal;
  }

  function reveal() {
    if (revealed) return;
    revealed = true;
    const card = queue[i];
    const p = deck.previewCard(card.id) || {};
    const fmt = (d) => (d === 0 ? 'now' : d === 1 ? '1d' : d < 30 ? d + 'd' : Math.round(d / 30) + 'mo');

    body.innerHTML = `
      <div class="sos-review-face">
        ${card.topic ? `<div class="sos-review-topic">${esc(card.topic)}</div>` : ''}
        <div class="sos-review-q">${esc(card.q)}</div>
        <div class="sos-review-a">${esc(card.a)}</div>
      </div>
      <div class="sos-review-grades">
        ${GRADES.map(g => `
          <button class="sos-review-grade" data-g="${g.g}" style="border-color:${g.color}44">
            <span style="color:${g.color}">${g.label}</span>
            <small>${p[g.label.toLowerCase()] ? fmt(p[g.label.toLowerCase()].days) : ''}</small>
          </button>`).join('')}
      </div>
      <div class="sos-review-actions">
        <button data-act="undo"${lastAction ? '' : ' disabled style="opacity:.35"'}>↶ undo</button>
        ${card.sourceSlide != null ? `<button data-act="src">slide ${card.sourceSlide}</button>` : ''}
        <button data-act="skip">skip</button>
      </div>`;

    body.querySelectorAll('[data-g]').forEach(b => {
      b.onclick = () => grade(parseInt(b.dataset.g, 10));
    });
    const undoBtn = body.querySelector('[data-act="undo"]');
    if (undoBtn) undoBtn.onclick = undo;
    const skipBtn = body.querySelector('[data-act="skip"]');
    if (skipBtn) skipBtn.onclick = () => { i++; render(); };
    const srcBtn = body.querySelector('[data-act="src"]');
    if (srcBtn) srcBtn.onclick = () => jumpToSource(card);
  }

  function grade(g) {
    if (!revealed) return;
    const card = queue[i];
    lastAction = {
      cardId: card.id,
      prevSched: card.sched ? { ...card.sched } : null,
      index: i,
      wasAgain: g === 1,
    };
    deck.gradeCard(card.id, g);
    stats.done++;
    if (g === 1) {
      stats.again++;
      // A failed card comes back at the END of this session rather than
      // tomorrow — that is what grading it Again means.
      queue.push(deck.get(card.id) || card);
    } else {
      stats.good++;
    }
    i++;
    render();
  }

  /** Restore the previous schedule. Possible only because fsrs.review is pure. */
  function undo() {
    if (!lastAction) return;
    const { cardId, prevSched, index, wasAgain } = lastAction;
    deck.restoreSched(cardId, prevSched);
    stats.done = Math.max(0, stats.done - 1);
    if (wasAgain) {
      stats.again = Math.max(0, stats.again - 1);
      queue.pop();                    // drop the re-queued copy
    } else {
      stats.good = Math.max(0, stats.good - 1);
    }
    lastAction = null;
    i = index;
    render();
  }

  function jumpToSource(card) {
    close();
    try {
      if (card.classId && window.switchView) window.switchView('class', card.classId);
      window.showNotif && window.showNotif('📄', 'Source', card.sourceTitle
        ? `${card.sourceTitle}${card.sourceSlide != null ? ' · slide ' + card.sourceSlide : ''}`
        : 'Opened the class.');
    } catch (e) {}
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); return close(); }
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); return reveal(); }
    if (e.key === 'u') { e.preventDefault(); return undo(); }
    if (e.key === 's') {
      e.preventDefault();
      const c = queue[i];
      return c && jumpToSource(c);
    }
    if (revealed && /^[1-4]$/.test(e.key)) { e.preventDefault(); return grade(parseInt(e.key, 10)); }
  }

  el.querySelector('.sos-review-x').onclick = close;
  // Capture phase: the app installs its own Escape handlers, and this overlay
  // is on top, so it must win.
  document.addEventListener('keydown', onKey, true);

  render();
  _open = { close, el };
  return _open;
}

/** Close any open session. Exported so a view switch can tear it down. */
export function closeReview() {
  if (_open) _open.close();
}

export default { startReview, closeReview };
