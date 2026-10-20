// Quiz, from MAGI Studio's renderQuiz: one question at a time, the answer
// locks, WHY shows after it, a results ring, retry the missed ones. Added for
// Shruti: the attempt in progress and every finished score are synced per
// person, and the results show the history.
//
//   mount(root, questions, {book, set}) -> dispose()
// Progress: study.<book>.<set>.quiz = {picked: {i: 'B'}, i, scores: [{s, n, at}]}

import { h, btn, esc, rich, IC, keys, progress, saveProgress, now } from './ui.js';

export const score = (qs, picked) => qs.filter((q, i) => picked[i] === q.correct).length;
export const best = (scores) => (scores || []).reduce((b, x) => (!b || x.s / x.n > b.s / b.n ? x : b), null);
const MAX_SCORES = 20;

export function mount(root, questions, { book, set }) {
  const n = questions.length;
  const P = () => progress(book, set, 'quiz');
  const p0 = P();
  const st = { i: Math.min(n - 1, Number(p0.i) || 0), picked: Object.assign({}, p0.picked || {}), results: false, logged: false };
  const box = h('div', 'qz');
  root.replaceChildren(box);

  const answered = () => Object.keys(st.picked).length;
  const save = (extra) => saveProgress(book, set, 'quiz', Object.assign({ picked: st.picked, i: st.i }, extra || {}));
  const go = (i) => { st.results = false; st.i = Math.max(0, Math.min(n - 1, i)); save(); paint(); };
  const showResults = () => {
    st.results = true;
    // A finished attempt is logged once: every question answered.
    if (answered() === n && !st.logged) {
      st.logged = true;
      const scores = (P().scores || []).concat([{ s: score(questions, st.picked), n, at: now() }]).slice(-MAX_SCORES);
      save({ scores });
    }
    paint();
  };
  const next = () => (st.i < n - 1 ? go(st.i + 1) : showResults());
  const pick = (L) => { if (st.picked[st.i]) return; st.picked[st.i] = L; save(); paint(); };
  const reset = (only) => {
    if (only) only.forEach((i) => delete st.picked[i]); else st.picked = {};
    st.logged = false; go(only && only.length ? only[0] : 0);
  };

  const paint = () => {
    box.textContent = '';
    const bar = h('div', 'st-bar');
    bar.append(h('span', 'st-meta', esc(n + ' questions') + (answered() ? '<i class="st-dot"></i><span class="st-good">' + score(questions, st.picked) + ' / ' + answered() + ' correct</span>' : '')));
    const acts = h('div', 'st-actions');
    if (answered()) acts.append(btn('Restart', 'undo', () => reset(), 'sm'));
    if (!st.results && answered()) acts.append(btn('Results', 'tick', showResults, 'sm'));
    bar.append(acts);
    box.append(bar);

    const segs = h('div', 'qz-segs');
    questions.forEach((q, i) => {
      const s = h('button', 'qz-seg');
      s.type = 'button'; s.title = 'Question ' + (i + 1); s.setAttribute('aria-label', 'Go to question ' + (i + 1));
      if (st.picked[i]) s.classList.add(st.picked[i] === q.correct ? 'ok' : 'bad');
      if (!st.results && i === st.i) s.classList.add('cur');
      s.addEventListener('click', () => go(i));
      segs.append(s);
    });
    box.append(segs);
    if (st.results) return paintResults();

    const q = questions[st.i], chosen = st.picked[st.i];
    const card = h('div', 'qz-card', '<div class="qz-kicker">Question ' + (st.i + 1) + ' of ' + n + '</div><div class="qz-q">' + rich(q.text) + '</div>');
    const opts = h('div', 'qz-opts');
    const letters = Object.keys(q.options);
    letters.forEach((L, k) => {
      const state = !chosen ? '' : L === q.correct ? 'correct' : L === chosen ? 'wrong' : 'dim';
      const b = h('button', 'qz-opt ' + state, '<span class="qz-letter">' + L + '</span><span class="qz-txt">' + rich(q.options[L]) + '</span>' + (state === 'correct' ? IC.tick : state === 'wrong' ? IC.x : ''));
      b.type = 'button'; b.disabled = !!chosen; b.title = 'Answer ' + L + ' (key ' + (k + 1) + ')';
      b.addEventListener('click', () => pick(L));
      opts.append(b);
    });
    card.append(opts);
    // The explanation only appears once an answer is locked in.
    if (chosen) {
      const ok = chosen === q.correct;
      card.append(h('div', 'qz-fb ' + (ok ? 'ok' : 'bad'), '<div class="qz-fb-hd">' + (ok ? IC.tick : IC.x) + '<span>' + (ok ? 'Correct' : 'Not quite: the answer is ' + q.correct) + '</span></div>' + (q.why ? '<div class="qz-why">' + rich(q.why) + '</div>' : '')));
    }
    box.append(card);
    const nav = h('div', 'qz-nav');
    const prev = btn('Back', 'left', () => go(st.i - 1));
    prev.disabled = st.i === 0;
    const last = st.i === n - 1;
    nav.append(prev, btn(!chosen ? 'Skip' : last ? 'See results' : 'Next question', last && chosen ? 'tick' : 'right', next, 'ic-end' + (chosen ? ' solid' : '')));
    box.append(nav);
    box.append(h('div', 'st-keys', '1–4 or A–D answer · Enter next · ← back'));
  };

  const paintResults = () => {
    const s = score(questions, st.picked), pct = Math.round((s / n) * 100);
    const R = 42, Cc = 2 * Math.PI * R;
    const msg = pct === 100 ? 'Perfect score.' : pct >= 80 ? 'Great work.' : pct >= 50 ? 'A good start: look again at the ones you missed.' : 'Worth another pass.';
    const scores = P().scores || [], b = best(scores);
    const res = h('div', 'qz-results',
      '<div class="qz-res-hd"><div class="qz-ring"><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="' + R + '" class="bg"/><circle cx="50" cy="50" r="' + R + '" class="fg" stroke-dasharray="' + Cc.toFixed(2) + '" stroke-dashoffset="' + (Cc * (1 - s / n)).toFixed(2) + '"/></svg><b>' + pct + '%</b></div>' +
      '<div><div class="qz-res-t">' + s + ' of ' + n + ' correct</div><div class="qz-res-s">' + esc(msg) + '</div>' +
      (scores.length ? '<div class="qz-hist" title="Your last attempts">' + scores.slice(-8).map((x) => '<i style="height:' + Math.max(8, Math.round(100 * x.s / x.n)) + '%" title="' + x.s + '/' + x.n + ' · ' + new Date(x.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + '"></i>').join('') + '</div><div class="qz-res-s">' + scores.length + ' attempt' + (scores.length > 1 ? 's' : '') + (b ? ' · best ' + b.s + '/' + b.n : '') + '</div>' : '') +
      '</div></div>');
    const list = h('div', 'qz-review');
    questions.forEach((q, i) => {
      const pk = st.picked[i], ok = pk === q.correct;
      const row = h('button', 'qz-rv ' + (!pk ? 'skip' : ok ? 'ok' : 'bad'), (!pk ? IC.right : ok ? IC.tick : IC.x) + '<div><div class="qz-rv-q">' + rich(q.text) + '</div><div class="qz-rv-a">' + esc(!pk ? 'Skipped · answer ' + q.correct : ok ? 'Your answer ' + pk : 'Your answer ' + pk + ' · correct ' + q.correct) + '</div></div>');
      row.type = 'button';
      row.addEventListener('click', () => go(i));
      list.append(row);
    });
    res.append(list);
    const missed = questions.map((q, i) => i).filter((i) => st.picked[i] !== questions[i].correct);
    const acts = h('div', 'qz-nav');
    if (missed.length && missed.length < n) acts.append(btn('Retry ' + missed.length + ' missed', 'undo', () => reset(missed)));
    acts.append(btn('Take it again', 'undo', () => reset(), 'solid ic-end'));
    res.append(acts);
    box.append(res);
  };

  const off = keys(box, (e) => {
    if (st.results) return;
    const q = questions[st.i], letters = Object.keys(q.options), k = e.key.toUpperCase();
    const byNum = /^[1-4]$/.test(k) ? letters[+k - 1] : null;
    const L = byNum || (letters.includes(k) ? k : null);
    if (L && !st.picked[st.i]) pick(L);
    else if (e.key === 'Enter' || e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') go(st.i - 1);
    else return;
    e.preventDefault();
  });
  // Opened with every question answered: straight to the results.
  if (answered() === n) { st.results = true; st.logged = true; }
  paint();
  return off;
}
