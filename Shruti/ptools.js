// What the Listen and Watch players share under their picture (Tony,
// 2026-10-22: "way better looking and cleaner"): a speed pill that opens the
// speeds only when asked, one grouped row of tool buttons, and a section that
// folds (the lessons list), remembered per person on this device.

import * as C from './core.js';

const SV = (b) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + b + '</svg>';
export const CHEV = SV('<path d="M6 9l6 6 6-6"/>');
const fmt = (s) => String(s).replace(/\.0+$/, '') + '×';

/** The speed pill and its (closed) row of speeds. */
export function speedHTML(speeds) {
  return '<button class="tl-speed" data-speed-pill aria-expanded="false" aria-controls="tl-speeds" title="Playback speed"><span>1×</span>' + CHEV + '</button>';
}
export function speedsRowHTML(speeds) {
  return '<div class="tl-speeds" id="tl-speeds" role="radiogroup" aria-label="Speed" hidden>' +
    speeds.map((s) => '<button class="chip" data-speed="' + s + '" role="radio">' + fmt(s) + '</button>').join('') + '</div>';
}
/** Wire the pill: it opens and closes the row; a speed picked closes it. */
export function bindSpeed(root, { get, set }) {
  const pill = root.querySelector('[data-speed-pill]'), row = root.querySelector('.tl-speeds');
  const open = (on) => { row.hidden = !on; pill.setAttribute('aria-expanded', String(on)); pill.classList.toggle('open', on); };
  pill.addEventListener('click', () => open(row.hidden));
  row.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => { set(Number(b.dataset.speed)); open(false); }));
  return function paint() {
    const sp = get() || 1;
    pill.querySelector('span').textContent = fmt(sp);
    pill.classList.toggle('set', sp !== 1);
    row.querySelectorAll('[data-speed]').forEach((b) => { const on = Number(b.dataset.speed) === sp; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  };
}

/** A tool button in the group: icon, and a short label from tablet width up. */
export const tool = (attrs, icon, label) => '<button class="tl-b" ' + attrs + '>' + icon + '<span>' + label + '</span></button>';

/** A section that folds: a header button and its body. Closed unless this
 *  person opened it last time (on this device). */
export function foldHTML(key, titleHtml, inner) {
  const open = C.ls.get(C.lsKey('fold.' + key)) === '1';
  return '<section class="fold' + (open ? ' open' : '') + '" data-fold="' + key + '">' +
    '<button class="fold-h" aria-expanded="' + open + '"><h3>' + titleHtml + '</h3>' + CHEV + '</button>' +
    '<div class="fold-b"' + (open ? '' : ' hidden') + '>' + inner + '</div></section>';
}
export function bindFolds(root) {
  root.querySelectorAll('[data-fold]').forEach((sec) => {
    const h = sec.querySelector('.fold-h'), b = sec.querySelector('.fold-b');
    h.addEventListener('click', () => {
      const on = b.hidden;
      b.hidden = !on; sec.classList.toggle('open', on); h.setAttribute('aria-expanded', String(on));
      C.ls.set(C.lsKey('fold.' + sec.dataset.fold), on ? '1' : '0');
    });
  });
}
