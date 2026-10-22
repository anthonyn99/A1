// Flashcards, from MAGI Studio's renderFlashcards: a 3D flip card, shuffle,
// "Still learning" / "Got it", a grid of every card, swipe and keys. Added
// for Shruti: what each person knows is synced, and spaced review (Leitner
// boxes) brings a card back after 1, 3, 7, 16 and 35 days.
//
//   mount(root, cards, {book, set}) -> dispose()
// Progress: study.<book>.<set>.flashcards = {b: {cardKey: box 0-5}, d: {cardKey: due ms}}
// Order: the grid of all cards can be dragged; the deck then follows that
// order (ui.js ordered), and shuffle and review still work on top of it.

import { h, btn, esc, rich, IC, keys, swipe, justSwiped, progress, saveProgress, now, DAY, ordered, saveOrder, OR } from './ui.js';

export const INTERVALS = [0, 1, 3, 7, 16, 35];   // days, per box
/** A card's key: survives reordering and small edits elsewhere in the set. */
export function cardKey(c) {
  let x = 5381;
  const s = String(c.front || '').toLowerCase().replace(/\W+/g, '');
  for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) >>> 0;
  return 'c' + x.toString(36);
}
/** Where a card stands for this person: new, learning, due or known. */
export function stateOf(p, k, t = now()) {
  const box = p.b && p.b[k];
  if (box == null) return 'new';
  if (box === 0) return 'learning';
  return (p.d && p.d[k] || 0) <= t ? 'due' : 'known';
}
/** The next box and due time after an answer. */
export function answer(box, knows, t = now()) {
  const b = knows ? Math.min(INTERVALS.length - 1, (box || 0) + 1) : 0;
  return { box: b, due: t + INTERVALS[b] * DAY };
}
/** Review order: due first (oldest first), then learning, then new; known last. */
export function reviewOrder(cards, p, t = now()) {
  const rank = { due: 0, learning: 1, new: 2, known: 3 };
  return cards.map((c, i) => ({ i, s: stateOf(p, cardKey(c), t), d: (p.d && p.d[cardKey(c)]) || 0 }))
    .sort((a, b) => rank[a.s] - rank[b.s] || a.d - b.d || a.i - b.i).map((x) => x.i);
}
export function summary(cards, p, t = now()) {
  const out = { new: 0, learning: 0, due: 0, known: 0 };
  cards.forEach((c) => { out[stateOf(p, cardKey(c), t)]++; });
  return out;
}

export function mount(root, setCards, { book, set }) {
  let O = ordered(book, set, 'flashcards', setCards), cards = O.items;
  const n = cards.length;
  const P = () => progress(book, set, 'flashcards');
  const st = { order: cards.map((_, i) => i), pos: 0, flipped: false, grid: false, done: false, review: false, gridFlip: new Set(), marked: 0 };
  const box = h('div', 'fc');
  root.replaceChildren(box);
  let dir = 0;

  const faces = (c, idx) =>
    '<div class="fc-inner"><div class="fc-face fc-front"><div class="fc-hd"><span class="fc-tag">Card</span><span class="fc-num">' + (idx + 1) + ' / ' + n + '</span></div>' +
    '<div class="fc-text">' + rich(c.front) + '</div></div>' +
    '<div class="fc-face fc-back"><div class="fc-hd"><span class="fc-tag">Answer</span><span class="fc-num">' + (c.ref ? 'Verse ' + esc(c.ref) + ' · ' : '') + (idx + 1) + ' / ' + n + '</span></div>' +
    '<div class="fc-q">' + rich(c.front) + '</div><div class="fc-text fc-text-back' + (c.back.length > 220 ? ' long' : '') + '">' + rich(c.back) + '</div></div></div>';

  const go = (d) => {
    dir = d;
    const next = st.pos + d;
    if (next < 0) return;
    if (next >= st.order.length) { st.done = true; paint(); return; }
    st.pos = next; st.flipped = false; paint();
  };
  const flip = () => {
    st.flipped = !st.flipped;
    const card = box.querySelector('.fc-stage .fc-card');
    if (card) { card.classList.toggle('flipped', st.flipped); card.setAttribute('aria-pressed', String(st.flipped)); }
  };
  const mark = (knows) => {
    const c = cards[st.order[st.pos]], k = cardKey(c), p = P();
    const a = answer(p.b && p.b[k], knows);
    saveProgress(book, set, 'flashcards', { ['b.' + k]: a.box, ['d.' + k]: a.due });
    st.marked++;
    go(1);
  };
  const shuffle = () => {
    const o = st.order;
    for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
    st.pos = 0; st.flipped = false; st.done = false; dir = 0; paint();
  };
  const startReview = () => {
    const p = P(), order = reviewOrder(cards, p).filter((i) => stateOf(p, cardKey(cards[i])) !== 'known');
    st.review = true; st.order = order.length ? order : reviewOrder(cards, p);
    st.pos = 0; st.flipped = false; st.done = false; st.grid = false; dir = 0; paint();
  };
  const restart = () => { st.review = false; st.order = cards.map((_, i) => i); st.pos = 0; st.flipped = false; st.done = false; dir = 0; paint(); };

  const paint = () => {
    const p = P(), sm = summary(cards, p);
    box.textContent = '';
    const bar = h('div', 'st-bar');
    bar.append(h('span', 'st-meta', esc(n + ' cards') +
      (sm.known ? '<i class="st-dot"></i><span class="st-good">' + sm.known + ' known</span>' : '') +
      (sm.due ? '<i class="st-dot"></i><span class="st-due">' + sm.due + ' due</span>' : '') +
      (sm.learning ? '<i class="st-dot"></i><span>' + sm.learning + ' learning</span>' : '')));
    const acts = h('div', 'st-actions');
    const toReview = sm.due + sm.learning;
    if (toReview && !st.review) acts.append(btn('Review ' + toReview, 'clock', startReview, 'sm', 'Review the cards that are due or still being learned'));
    acts.append(btn('', 'shuffle', shuffle, 'sm ic', 'Shuffle'),
      btn('', st.grid ? 'deck' : 'grid', () => { st.grid = !st.grid; paint(); }, 'sm ic', st.grid ? 'One card at a time' : 'All cards'));
    bar.append(acts);
    box.append(bar);

    if (st.grid) {
      const grid = h('div', 'fc-grid');
      cards.forEach((c, idx) => {
        const s = stateOf(p, cardKey(c)), k = O.keys[idx];
        const card = h('button', 'fc-card fc-mini ' + (st.gridFlip.has(k) ? 'flipped ' : '') + s, faces(c, idx));
        card.type = 'button'; card.dataset.dkey = k; card.title = OR.HINT;
        card.addEventListener('click', () => { st.gridFlip.has(k) ? st.gridFlip.delete(k) : st.gridFlip.add(k); card.classList.toggle('flipped', st.gridFlip.has(k)); });
        grid.append(card);
      });
      box.append(grid);
      // Drag a card to a new place: the deck plays in this order from now on.
      OR.sortable(grid, { row: '.fc-card', axis: 'grid', onMove(ks) {
        saveOrder(book, set, 'flashcards', ks);
        O = ordered(book, set, 'flashcards', setCards); cards = O.items;
        st.review = false; st.order = cards.map((_, i) => i); st.pos = 0; st.flipped = false; st.done = false;
        paint();
      } });
      return;
    }

    const total = st.order.length;
    box.append(h('div', 'st-track', '<i style="width:' + (((st.done ? total : st.pos + 1) / total) * 100).toFixed(1) + '%"></i>'));

    if (st.done) {
      const left = sm.due + sm.learning;
      const end = h('div', 'st-done', IC.tick + '<b>' + (st.review ? 'Review done' : 'Deck complete') + '</b><span>' +
        esc(left ? sm.known + ' known · ' + left + ' to review' : 'You know all ' + n + ' cards. They come back for review in a few days.') + '</span>');
      const a2 = h('div', 'st-done-acts');
      if (left) a2.append(btn('Review ' + left, 'clock', startReview, 'solid'));
      a2.append(btn('Start over', 'undo', restart, left ? '' : 'solid'));
      end.append(a2);
      box.append(end);
      return;
    }

    const idx = st.order[st.pos], s = stateOf(p, cardKey(cards[idx]));
    const stage = h('div', 'fc-stage');
    const card = h('button', 'fc-card ' + (st.flipped ? 'flipped ' : '') + s + (dir > 0 ? ' in-next' : dir < 0 ? ' in-prev' : ''), faces(cards[idx], idx));
    card.type = 'button';
    card.setAttribute('aria-pressed', String(st.flipped));
    card.setAttribute('aria-label', 'Flashcard: press to turn over');
    card.addEventListener('click', () => { if (!justSwiped(stage)) flip(); });
    stage.append(card);
    swipe(stage, () => go(1), () => go(-1));
    box.append(stage);

    const ctl = h('div', 'fc-ctl');
    const prev = btn('', 'left', () => go(-1), 'round', 'Previous card (←)');
    prev.disabled = st.pos === 0;
    ctl.append(prev, btn('Still learning', 'x', () => mark(false), 'fc-learn'), btn('Got it', 'tick', () => mark(true), 'fc-know'), btn('', 'right', () => go(1), 'round', 'Next card (→)'));
    box.append(ctl);
  };

  const off = keys(box, (e) => {
    if (st.grid) return;
    if (st.done) { if (e.key === 'ArrowLeft') { st.done = false; paint(); e.preventDefault(); } return; }
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown') flip();
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === '1') mark(false);
    else if (e.key === '2') mark(true);
    else return;
    e.preventDefault();
  });
  paint();
  return off;
}
