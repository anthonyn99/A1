// Slide deck, from MAGI Studio's slideEl / renderSlides: one 16:9 slide laid
// out in container units, so the same element is the stage, a filmstrip
// thumbnail and the projector slide. Stage, filmstrip, grid and Present mode;
// branded Shruti. Added: "Narrate deck" reads each slide aloud through Orca's
// speech (the person's read-aloud voice) and moves on by itself.
//
//   mount(root, slides, {book, set, title}) -> dispose()
// Progress: study.<book>.<set>.slides = {i}

import * as C from '../core.js';
import * as O from '../orca.js';
import { h, btn, esc, rich, IC, keys, swipe, justSwiped, progress, saveProgress } from './ui.js';

/** What a slide says when narrated: its own `say`, else its title and points. */
export const sayOf = (s) => s.say || [s.title, ...(s.bullets || [])].filter(Boolean).map((t) => t.replace(/\*\*/g, '').replace(/[.:;!?]?$/, '.')).join(' ');

export function slideEl(s, idx, n, deck) {
  const kind = idx === 0 ? 'is-title' : idx === n - 1 && n > 2 ? 'is-end' : '';
  return h('div', 'sd-slide', '<div class="sd-inner ' + kind + '"><div class="sd-top"><span class="sd-brand">Shruti</span><span class="sd-no">' + String(idx + 1).padStart(2, '0') + '</span></div>' +
    '<div class="sd-body"><div class="sd-title">' + rich(s.title || '') + '</div>' +
    (s.bullets && s.bullets.length ? '<ul class="sd-bullets">' + s.bullets.map((b) => '<li>' + rich(b) + '</li>').join('') + '</ul>' : '') + '</div>' +
    '<div class="sd-foot"><span>' + esc(kind === 'is-title' ? deck || '' : kind === 'is-end' ? 'Summary' : '') + '</span><span>' + (idx + 1) + ' / ' + n + '</span></div></div>');
}

export function mount(root, slides, { book, set, title }) {
  const n = slides.length;
  const st = { i: Math.min(n - 1, Number(progress(book, set, 'slides').i) || 0), grid: false };
  const box = h('div', 'sd');
  root.replaceChildren(box);
  let overlay = null, dir = 0;
  const narr = { on: false, audio: null, ctrl: null, cache: new Map() };

  const go = (i, fromNarration) => {
    const t = Math.max(0, Math.min(n - 1, i));
    if (t === st.i) return;
    dir = t > st.i ? 1 : -1;
    st.i = t;
    saveProgress(book, set, 'slides', { i: t });
    paint();
    if (overlay) paintOverlay();
    if (narr.on && !fromNarration) speakCurrent();
  };

  /* ── present ── */
  const closePresent = () => {
    if (!overlay) return;
    const o = overlay; overlay = null;
    o.remove();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.body.classList.remove('sd-presenting');
  };
  const onFs = () => { if (!document.fullscreenElement && overlay) closePresent(); };
  document.addEventListener('fullscreenchange', onFs);
  const paintOverlay = () => {
    const stage = overlay.querySelector('.sd-present-stage');
    stage.replaceChildren(slideEl(slides[st.i], st.i, n, title));
    overlay.querySelector('.sd-present-count').textContent = (st.i + 1) + ' / ' + n;
  };
  const present = () => {
    if (overlay) return;
    overlay = h('div', 'sd-present');
    const stage = h('div', 'sd-present-stage');
    stage.addEventListener('click', (e) => {
      if (justSwiped(stage)) return;
      const r = stage.getBoundingClientRect();
      go(e.clientX - r.left < r.width * 0.33 ? st.i - 1 : st.i + 1);
    });
    swipe(stage, () => go(st.i + 1), () => go(st.i - 1));
    const hud = h('div', 'sd-present-hud');
    hud.append(btn('', 'left', () => go(st.i - 1), 'round', 'Previous'), h('span', 'sd-present-count'), btn('', 'right', () => go(st.i + 1), 'round', 'Next'),
      btn('', narr.on ? 'pause' : 'voice', () => { toggleNarration(); hud.querySelector('[data-nar]').innerHTML = narr.on ? IC.pause : IC.voice; }, 'round', 'Narrate'), btn('', 'x', closePresent, 'round', 'Exit (Esc)'));
    hud.children[3].dataset.nar = '1';
    overlay.append(stage, hud);
    document.body.append(overlay);
    document.body.classList.add('sd-presenting');
    paintOverlay();
    // Real full screen where the platform allows it; the overlay alone is the
    // presentation on iPhone, which has no element full screen.
    if (overlay.requestFullscreen) overlay.requestFullscreen().catch(() => {});
  };

  /* ── narrate ── */
  const stopNarration = () => {
    narr.on = false;
    if (narr.ctrl) narr.ctrl.abort();
    if (narr.audio) { narr.audio.pause(); narr.audio.src = ''; }
    narr.audio = null; narr.ctrl = null;
    paintBar();
  };
  const speakCurrent = async () => {
    if (narr.ctrl) narr.ctrl.abort();
    if (narr.audio) narr.audio.pause();
    const i = st.i, key = String(C.me.get('orcaKey', '') || '');
    const voice = (C.me.get('narration', {}) || {}).voice || O.DEFAULT_VOICE;
    const ctrl = narr.ctrl = new AbortController();
    narr.state = 'loading'; paintBar();
    try {
      let url = narr.cache.get(i + voice);
      if (!url) {
        const r = await O.speak({ key, text: sayOf(slides[i]), voice, signal: ctrl.signal });
        url = URL.createObjectURL(r.audio);
        narr.cache.set(i + voice, url);
      }
      if (!narr.on || ctrl.signal.aborted) return;
      const a = narr.audio = narr.audio || new Audio();
      a.src = url;
      a.playbackRate = Number((C.me.get('narration', {}) || {}).speed) || 1;
      a.onended = () => { if (!narr.on) return; if (st.i < n - 1) { go(st.i + 1, true); speakCurrent(); } else stopNarration(); };
      await a.play();
      narr.state = 'playing'; paintBar();
      // Fetch the next slide's voice while this one plays.
      if (i + 1 < n && !narr.cache.has(i + 1 + voice)) O.speak({ key, text: sayOf(slides[i + 1]), voice }).then((r) => narr.cache.set(i + 1 + voice, URL.createObjectURL(r.audio))).catch(() => {});
    } catch (e) {
      if (e && e.code === 'abort') return;
      stopNarration();
      window.Shruti && window.Shruti.toast(e && e.code === 'key' ? 'Narration needs your Orca key (Settings).' : 'The deck could not be narrated: ' + (e.message || e), true);
    }
  };
  const toggleNarration = () => {
    if (narr.on) { stopNarration(); return; }
    if (!C.me.get('orcaKey', '')) { window.Shruti && window.Shruti.toast('Narration uses Orca: paste your key in Settings.', true); return; }
    narr.on = true;
    dispatchEvent(new CustomEvent('shruti:playing', { detail: { who: 'slides' } }));
    speakCurrent();
  };
  const onOther = (e) => { if (e.detail.who !== 'slides' && narr.on) stopNarration(); };
  addEventListener('shruti:playing', onOther);

  let barActs = null;
  const paintBar = () => {
    if (!barActs) return;
    barActs.replaceChildren(
      btn(narr.on ? (narr.state === 'loading' ? 'Getting the voice…' : 'Stop narration') : 'Narrate deck', narr.on ? 'pause' : 'voice', toggleNarration, 'sm' + (narr.on ? ' on' : ''), 'Read each slide aloud and move on by itself'),
      btn('Present', 'present', present, 'sm', 'Present full screen (P)'),
      btn('', st.grid ? 'deck' : 'grid', () => { st.grid = !st.grid; paint(); }, 'sm ic', st.grid ? 'Slide view' : 'All slides'));
  };

  const paint = () => {
    box.textContent = '';
    const bar = h('div', 'st-bar');
    bar.append(h('span', 'st-meta', esc(n + ' slides')));
    barActs = h('div', 'st-actions');
    bar.append(barActs);
    paintBar();
    box.append(bar);
    if (st.grid) {
      const grid = h('div', 'sd-grid');
      slides.forEach((s, i) => {
        const t = h('button', 'sd-thumb' + (i === st.i ? ' on' : ''));
        t.type = 'button'; t.setAttribute('aria-label', 'Slide ' + (i + 1));
        t.append(slideEl(s, i, n, title));
        t.addEventListener('click', () => { st.grid = false; dir = 0; st.i = i; saveProgress(book, set, 'slides', { i }); paint(); });
        grid.append(t);
      });
      box.append(grid);
      return;
    }
    const stage = h('div', 'sd-stage' + (dir > 0 ? ' in-next' : dir < 0 ? ' in-prev' : ''));
    stage.append(slideEl(slides[st.i], st.i, n, title));
    stage.addEventListener('click', (e) => { if (justSwiped(stage)) return; const r = stage.getBoundingClientRect(); go(e.clientX - r.left < r.width * 0.33 ? st.i - 1 : st.i + 1); });
    swipe(stage, () => go(st.i + 1), () => go(st.i - 1));
    box.append(stage);
    const nav = h('div', 'sd-nav');
    const prev = btn('', 'left', () => go(st.i - 1), 'round', 'Previous slide (←)'); prev.disabled = st.i === 0;
    const next = btn('', 'right', () => go(st.i + 1), 'round', 'Next slide (→)'); next.disabled = st.i === n - 1;
    nav.append(prev, h('span', 'sd-count', (st.i + 1) + ' / ' + n), next);
    box.append(nav);
    const strip = h('div', 'sd-strip');
    slides.forEach((s, i) => {
      const t = h('button', 'sd-thumb' + (i === st.i ? ' on' : ''));
      t.type = 'button'; t.setAttribute('aria-label', 'Slide ' + (i + 1));
      t.append(slideEl(s, i, n, title));
      t.addEventListener('click', () => go(i));
      strip.append(t);
    });
    box.append(strip);
    const on = strip.children[st.i];
    if (on) requestAnimationFrame(() => { try { strip.scrollTo({ left: on.offsetLeft - strip.clientWidth / 2 + on.clientWidth / 2, behavior: 'smooth' }); } catch (e) {} });
    box.append(h('div', 'st-keys', '← → move · P present · N narrate · G all slides'));
    dir = 0;
  };

  const off = keys(box, (e) => {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || (overlay && e.key === ' ')) go(st.i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(st.i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(n - 1);
    else if (e.key === 'p' || e.key === 'P') overlay ? closePresent() : present();
    else if (e.key === 'n' || e.key === 'N') toggleNarration();
    else if (e.key === 'g' || e.key === 'G') { st.grid = !st.grid; paint(); }
    else if (e.key === 'Escape' && overlay) closePresent();
    else return;
    e.preventDefault();
  });
  paint();
  return () => {
    off(); stopNarration(); closePresent();
    removeEventListener('shruti:playing', onOther);
    document.removeEventListener('fullscreenchange', onFs);
    narr.cache.forEach((u) => URL.revokeObjectURL(u));
  };
}
