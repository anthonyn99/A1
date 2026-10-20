// The reader: the chapter's exact text, set the way each person likes it
// (size, spacing, typeface, width; synced), with the book's key verses
// marked, bookmarks, and "where you were" on every device. Read-aloud
// (narrate.js) lights the word being said here and follows it.
//
// Imports from library.js are used only inside functions: library.js imports
// this module, so they are not ready while this file is first evaluated.

import * as C from './core.js';
import * as T from './text.js';
import * as NR from './narrate.js';
import { esc, IC, fracOf, setProgress } from './library.js';

export const SIZES = [16, 17, 18, 20, 22];
export const LEADS = [1.55, 1.75, 1.95];
export const WIDTHS = [600, 720, 860];
export const settings = () => Object.assign({ size: 2, lead: 1, font: 'serif', width: 1 }, C.me.get('reader', {}) || {});

const RIBBON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';
const LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9v14l-4.5-3L6 17z"/><path d="M19 7v14l-5-3"/></svg>';
const SLIDERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

/** One verse piece: the key verse marked whole, or only its highlighted ranges. */
function pieceHtml(s) {
  const t = String(s.t || '');
  if (s.hl && s.hl.length) {
    let out = '', at = 0;
    for (const [a, b] of s.hl) {
      if (a > at) out += esc(t.slice(at, a));
      out += '<span class="key">' + esc(t.slice(a, b)) + '</span>';
      at = b;
    }
    return out + esc(t.slice(at));
  }
  return s.key ? '<span class="key">' + esc(t) + '</span>' : esc(t);
}
function blockHtml(bl, b, marks) {
  const bm = marks['b' + b] ? ' bm' : '';
  if (bl.k === 'h') return bl.minor ? '<h4 data-b="' + b + '" class="' + bm + '">' + esc(bl.t) + '</h4>' : '<h3 data-b="' + b + '" class="' + bm + '">' + esc(bl.t) + '</h3>';
  if (bl.k === 'p') {
    return '<p data-b="' + b + '" class="' + bm + '">' + (bl.s || []).map((s) =>
      (s.v ? '<button class="vn" data-vn="' + b + '" title="Bookmark verse ' + esc(s.v) + '" aria-label="Verse ' + esc(s.v) + ': bookmark">' + esc(s.v) + '</button>' : '') + pieceHtml(s)).join(' ') + '</p>';
  }
  if (bl.k === 'a') return '<aside data-b="' + b + '" class="' + esc(bl.style || '') + bm + '">' + esc(bl.t) + '</aside>';
  return '';
}
/** What a bookmark is called: its verse, else its heading, else its first words. */
export function markLabel(ch, b) {
  const bl = ch.blocks[b] || {};
  if (bl.k === 'p') { const v = (bl.s || []).find((x) => x.v); if (v) return 'Verse ' + v.v; }
  if (bl.k === 'h') return bl.t;
  const w = T.words(T.blockText(bl)).slice(0, 7).join(' ');
  return w + '…';
}
const marksOf = (book, n) => C.me.get('bookmarks.' + book + '.ch' + n, {}) || {};

/** The person's look, on the reader's container so its bar shares the width. */
function applyLook(art) {
  const s = settings(), box = art.parentElement;
  box.style.setProperty('--rd-size', (SIZES[s.size] || 18) + 'px');
  box.style.setProperty('--rd-lead', LEADS[s.lead] || 1.75);
  box.style.setProperty('--rd-width', (WIDTHS[s.width] || 720) + 'px');
  art.classList.toggle('sans', s.font === 'sans');
}

/** Wait until the view is on the page (the router swaps it in after we return). */
function whenShown(el, fn) {
  const t0 = Date.now();
  const check = () => { if (el.isConnected) fn(); else if (Date.now() - t0 < 4000) requestAnimationFrame(check); };
  requestAnimationFrame(check);
}
const topH = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--top-h')) || 58;
function scrollToBlock(art, b, smooth) {
  const el = art.querySelector('[data-b="' + b + '"]');
  if (!el) return;
  const modes = document.querySelector('.modes');
  const off = topH() + (modes ? modes.offsetHeight : 0) + 18;
  scrollTo({ top: Math.max(0, scrollY + el.getBoundingClientRect().top - off), behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
}
/** The block at the top of the reading area. */
function topBlock(art) {
  const modes = document.querySelector('.modes');
  const line = topH() + (modes ? modes.offsetHeight : 0) + 24;
  let best = 0;
  for (const el of art.querySelectorAll('[data-b]')) {
    if (el.getBoundingClientRect().top <= line) best = Number(el.dataset.b); else break;
  }
  return best;
}

export function renderRead(body, ch, book, n, { title, at } = {}) {
  const marks = marksOf(book, n);
  const nMarks = Object.keys(marks).length;
  body.innerHTML =
    '<div class="rd-bar">' +
      '<button class="btn solid" data-ra>' + IC.play + '<span>Listen</span></button>' +
      '<span class="sp"></span>' +
      '<button class="ib" data-bmhere title="Bookmark this spot" aria-label="Bookmark this spot">' + RIBBON + '</button>' +
      '<button class="ib cnt-b" data-bms title="Bookmarks" aria-label="Bookmarks" aria-expanded="false">' + LIST + '<i class="cnt"' + (nMarks ? '' : ' hidden') + '>' + nMarks + '</i></button>' +
      '<button class="ib" data-voice title="Read-aloud: voice, speed, sleep timer" aria-label="Read-aloud settings">' + SLIDERS + '</button>' +
      '<button class="ib aa" data-aa title="Text size and spacing" aria-label="Text size and spacing" aria-expanded="false">Aa</button>' +
    '</div>' +
    '<div class="rd-pop" id="rd-aa" hidden></div><div class="rd-pop" id="rd-bms" hidden></div>' +
    '<div class="rd-resume" id="rd-resume" hidden></div>' +
    '<article class="rd">' + (ch.blocks || []).map((bl, b) => blockHtml(bl, b, marks)).join('') + '</article>' +
    '<button class="rd-follow" id="rd-follow" hidden>' + IC.listen + 'Back to the voice</button>';
  const art = body.querySelector('.rd');
  applyLook(art);

  /* ── look ── */
  const aa = body.querySelector('#rd-aa'), bms = body.querySelector('#rd-bms');
  const seg = (label, key, opts) => '<div class="seg-row"><span>' + label + '</span><div class="seg" role="radiogroup" aria-label="' + label + '">' +
    opts.map(([v, t]) => '<button role="radio" data-k="' + key + '" data-v="' + v + '" aria-checked="' + (String(settings()[key]) === String(v)) + '">' + t + '</button>').join('') + '</div></div>';
  const drawAa = () => {
    aa.innerHTML = seg('Size', 'size', SIZES.map((px, i) => [i, '<span style="font-size:' + (11 + i * 1.6).toFixed(1) + 'px">A</span>'])) +
      seg('Spacing', 'lead', [[0, 'Tight'], [1, 'Normal'], [2, 'Airy']]) +
      seg('Type', 'font', [['serif', '<span style="font-family:var(--f-read)">Serif</span>'], ['sans', '<span style="font-family:var(--f-ui)">Sans</span>']]) +
      seg('Width', 'width', [[0, 'Narrow'], [1, 'Normal'], [2, 'Wide']]);
    aa.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.k, v = k === 'font' ? b.dataset.v : Number(b.dataset.v);
      const keep = topBlock(art);
      C.me.set({ ['reader.' + k]: v });
      applyLook(art); drawAa();
      scrollToBlock(art, keep, false);   // the same text stays in front of the reader
    }));
  };
  const toggle = (pop, btn, draw) => {
    const open = pop.hidden;
    [aa, bms].forEach((p) => { p.hidden = true; });
    body.querySelectorAll('[aria-expanded]').forEach((x) => x.setAttribute('aria-expanded', 'false'));
    if (open) { draw(); pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
  };
  body.querySelector('[data-aa]').addEventListener('click', (e) => toggle(aa, e.currentTarget, drawAa));

  /* ── bookmarks ── */
  const paintCount = () => {
    const k = Object.keys(marksOf(book, n)).length, c = body.querySelector('.cnt');
    c.textContent = k; c.hidden = !k;
  };
  const setMark = (b, on) => {
    const el = art.querySelector('[data-b="' + b + '"]');
    C.me.set({ ['bookmarks.' + book + '.ch' + n + '.b' + b]: on ? { at: Date.now(), label: markLabel(ch, b) } : C.DELETE }, { now: true });
    if (el) el.classList.toggle('bm', on);
    paintCount();
    if (!bms.hidden) drawBms();
  };
  const drawBms = () => {
    const m = marksOf(book, n);
    const list = Object.keys(m).map((k) => Number(k.slice(1))).sort((a, b) => a - b);
    bms.innerHTML = list.length
      ? '<ul class="bm-list">' + list.map((b) => '<li><button class="bm-go" data-go-b="' + b + '">' + RIBBON + '<span><b>' + esc(m['b' + b].label || markLabel(ch, b)) + '</b><span>' + esc(T.words(T.blockText(ch.blocks[b])).slice(0, 14).join(' ')) + '…</span></span></button>' +
        '<button class="ib" data-del-b="' + b + '" aria-label="Remove bookmark" title="Remove"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></li>').join('') + '</ul>'
      : '<p class="hint">No bookmarks in this chapter. Tap a verse number, or the ribbon above to mark where you are.</p>';
    bms.querySelectorAll('[data-go-b]').forEach((x) => x.addEventListener('click', () => { bms.hidden = true; scrollToBlock(art, Number(x.dataset.goB), true); }));
    bms.querySelectorAll('[data-del-b]').forEach((x) => x.addEventListener('click', () => setMark(Number(x.dataset.delB), false)));
  };
  body.querySelector('[data-bms]').addEventListener('click', (e) => toggle(bms, e.currentTarget, drawBms));
  body.querySelector('[data-bmhere]').addEventListener('click', () => {
    const b = topBlock(art), on = !marksOf(book, n)['b' + b];
    setMark(b, on);
    window.Shruti && Shruti.toast(on ? 'Bookmarked: ' + markLabel(ch, b) : 'Bookmark removed');
  });

  /* ── read-aloud ── */
  const raBtn = body.querySelector('[data-ra]');
  let shownOnce = false;
  const paintRa = () => {
    const on = NR.active(book, n), st = NR.state;
    raBtn.innerHTML = on && st.playing ? PAUSE + '<span>Pause</span>' : IC.play + '<span>' + (on ? 'Resume' : 'Listen') + '</span>';
    body.querySelector('#rd-follow').hidden = !(on && st.playing && st.away && st.follow);
    art.classList.toggle('ra-on', on);
  };
  // Listens until this view leaves the page.
  const offNR = NR.onChange(() => { if (shownOnce && !art.isConnected) { offNR(); return; } paintRa(); });
  raBtn.addEventListener('click', () => {
    if (NR.active(book, n)) { NR.toggle(); return; }
    // From the resume point, else from where the reader is, else the start.
    const ra = C.me.get('progress.' + book + '.ch' + n + '.ra', null);
    const tb = topBlock(art);
    NR.start({ book, n, ch, title, from: ra && ra.i > 0 ? null : tb > 0 ? { b: tb, word: 0 } : null });
  });
  body.querySelector('[data-voice]').addEventListener('click', () => NR.openSheet({ book, n, ch, title }));
  body.querySelector('#rd-follow').addEventListener('click', () => NR.backToVoice());
  art.addEventListener('click', (e) => {
    const vn = e.target.closest('[data-vn]');
    if (vn) { const b = Number(vn.dataset.vn); setMark(b, !marksOf(book, n)['b' + b]); return; }
    // While read-aloud is on this chapter, tapping a word reads from there.
    if (!NR.active(book, n)) return;
    const blk = e.target.closest('[data-b]');
    if (!blk) return;
    const b = Number(blk.dataset.b), w = wrap(b);
    const idx = e.target.classList && e.target.classList.contains('w') ? w.spans.indexOf(e.target) : 0;
    NR.backToVoice();
    NR.playFrom(b, Math.max(0, idx));
  });
  /** The block's words as spans (made the first time the voice reaches it). */
  function wrap(b) {
    const el = art.querySelector('[data-b="' + b + '"]');
    if (!el) return null;
    if (!el.__words) {
      const spans = [], walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.parentElement.closest('.vn') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const t of nodes) {
        const s = t.nodeValue, frag = document.createDocumentFragment();
        let at = 0;
        for (const m of s.matchAll(T.WORD_RE)) {
          if (m.index > at) frag.appendChild(document.createTextNode(s.slice(at, m.index)));
          const sp = document.createElement('span'); sp.className = 'w'; sp.textContent = m[0];
          frag.appendChild(sp); spans.push(sp); at = m.index + m[0].length;
        }
        if (at < s.length) frag.appendChild(document.createTextNode(s.slice(at)));
        t.parentNode.replaceChild(frag, t);
      }
      el.__words = spans;
    }
    return { el, spans: el.__words };
  }
  NR.attach({ book, n, art, wrap });

  /* ── marked read by hand (the chapter header's button) ── */
  let best = fracOf(book, n);
  body.addEventListener('shruti:mark', (e) => { best = e.detail.done ? 1 : 0; });

  /* ── where they are, and how far they read ── */
  let posT = 0, lastPos = -1;
  const measure = () => {
    if (!art.isConnected) { if (shownOnce) { removeEventListener('scroll', measure); offNR(); } return; }
    const r = art.getBoundingClientRect();
    const seen = Math.min(1, Math.max(0, (innerHeight - r.top) / Math.max(1, r.height)));
    if (seen > best + 0.02 || (seen >= 0.98 && best < 1)) {
      best = seen >= 0.98 ? 1 : seen;
      setProgress(book, n, best >= 1 ? { f: 1, done: true, 'modes.read': 1 } : { f: +best.toFixed(3) });
      if (best >= 1) body.dispatchEvent(new CustomEvent('shruti:read'));
    }
    if (Date.now() - posT > 1500) {
      posT = Date.now();
      const p = topBlock(art);
      if (p !== lastPos) { lastPos = p; setProgress(book, n, { pos: p }); }
    }
  };
  whenShown(art, () => {
    shownOnce = true;
    const pos = Number((C.me.get('progress.' + book + '.ch' + n, {}) || {}).pos) || 0;
    if (at != null) { scrollToBlock(art, at, false); flash(art, at); }
    else if (pos > 0 && pos < (ch.blocks || []).length) {
      scrollToBlock(art, pos, false);
      lastPos = pos;
      const chip = body.querySelector('#rd-resume');
      chip.innerHTML = '<span>Back where you were: <b>' + esc(markLabel(ch, pos)) + '</b></span><button class="btn ghost" data-top>Start from the top</button>';
      chip.hidden = false;
      chip.querySelector('[data-top]').addEventListener('click', () => { chip.hidden = true; scrollTo({ top: 0, behavior: 'smooth' }); });
      setTimeout(() => { chip.classList.add('out'); setTimeout(() => { chip.hidden = true; }, 400); }, 7000);
    }
    addEventListener('scroll', measure, { passive: true });
    paintRa();
  });
}
function flash(art, b) {
  const el = art.querySelector('[data-b="' + b + '"]');
  if (!el) return;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1800);
}
