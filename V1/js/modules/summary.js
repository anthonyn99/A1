/* ============================================================================
 * StudyOS — end-of-session summary  (engagement upgrade 5.4)
 * ============================================================================
 * One recap for every kind of session (review, quiz, mock exam, boss fight):
 * what was done, XP gained, streak, level progress, and THE NEXT THING TO DO
 * — straight from startnow.pick(), so finishing a session is never a dead end.
 * ------------------------------------------------------------------------- */

import * as xp from './xp.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param {object} o { title, lines: [string], xpGained, missedTopics: [string],
 *                     onPractice(topics), onClose(), extraHtml }
 * @returns {string} HTML (caller wires buttons via wire()).
 */
export function html(o) {
  const S = window.SOS || {};
  const streak = S.sessions ? S.sessions.streak() : 0;
  const lv = xp.levelInfo();
  let next = null;
  try { next = S.startnow ? S.startnow.pick() : null; } catch (e) {}
  const pct = lv.span ? Math.round((lv.into / lv.span) * 100) : 0;
  return `
    <div class="sos-sum">
      <h2>${esc(o.title || 'Done')}</h2>
      ${(o.lines || []).map((l) => `<div class="sos-sum-stat">${esc(l)}</div>`).join('')}
      ${o.extraHtml || ''}
      <div class="sos-sum-xp">+${o.xpGained || 0} XP</div>
      <div class="sos-sum-level" title="${lv.xp} XP total">
        <div>Level ${lv.level}</div>
        <div class="sos-sum-bar"><i style="width:${pct}%"></i></div>
        <div class="sos-sum-muted">${lv.into}/${lv.span} to level ${lv.level + 1}</div>
      </div>
      <div class="sos-sum-stat">🔥 ${streak ? `${streak}-day streak` : 'Start a streak today'}</div>
      ${o.missedTopics && o.missedTopics.length ? `<div class="sos-sum-muted">Missed: ${o.missedTopics.map(esc).join(', ')}</div>
        <button class="sos-sum-btn" data-sum-practice>Practice these</button>` : ''}
      ${next ? `<div class="sos-sum-muted" style="margin-top:6px">Next up: ${esc(next.reason)}</div>
        <button class="sos-sum-btn primary" data-sum-next>Start next · 10 min</button>` : ''}
      <button class="sos-sum-btn" data-sum-close>Close</button>
    </div>`;
}

export function wire(root, o) {
  const b = (sel, fn) => { const el = root.querySelector(sel); if (el) el.onclick = fn; };
  b('[data-sum-close]', () => o.onClose && o.onClose());
  b('[data-sum-practice]', () => { if (o.onClose) o.onClose(); if (o.onPractice) o.onPractice(o.missedTopics); });
  b('[data-sum-next]', () => { if (o.onClose) o.onClose(); setTimeout(() => window.sosStartNow && window.sosStartNow(), 50); });
}

export const CSS = `
.sos-sum { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:26px 20px; text-align:center; overflow-y:auto; }
.sos-sum h2 { font-family:'Lora',serif; font-size:26px; margin:0; color:var(--accent); }
.sos-sum-stat { font-family:var(--mono); font-size:13px; color:var(--text2); }
.sos-sum-muted { font-family:var(--mono); font-size:11px; color:var(--text3); }
.sos-sum-xp { font-size:28px; font-weight:800; color:#f0bd86; font-family:var(--mono); }
.sos-sum-level { width:min(320px, 90%); font-family:var(--mono); font-size:12px; color:var(--text2); display:grid; gap:4px; }
.sos-sum-bar { height:8px; background:var(--bg4); border-radius:4px; overflow:hidden; }
.sos-sum-bar > i { display:block; height:100%; background:var(--accent); }
.sos-sum-btn { background:var(--bg3); border:1px solid var(--border); color:var(--text); border-radius:5px; padding:10px 18px;
  min-width:200px; cursor:pointer; font-family:inherit; font-size:14px; min-height:44px; }
.sos-sum-btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:700; }`;

export default { html, wire, CSS };
