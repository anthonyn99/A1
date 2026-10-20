// Study parsers. The labelled-text parsers are MAGI Studio's, ported verbatim
// from magi.html (studioClean, numberedBlocks, studioParseFlashcards,
// studioParseQuiz, studioParseSlides, studioParseMindmap): a model's reply
// often loses its newlines or bolds its labels, and these still read it.
// `items(kind, x)` is the one entry point: it takes Shruti's own JSON shape
// (the ready-made sets), or a model's labelled text.

/** "**FRONT:**", "**FRONT**:", "__TITLE__:" -> "FRONT:", so every parser sees
 *  one label shape whichever way a model decided to bold it. */
export const studioClean = (raw) => String(raw || '')
  .replace(/\r/g, '')
  .replace(/(\*\*|__)\s*([A-Z][A-Z ]{0,18}?\s*\d{0,2})\s*(:?)\s*\1\s*(:?)/g,
    (m, _w, label, c1, c2) => (/^(CARD|FRONT|BACK|SLIDE|TITLE|CORRECT|WHY|HOST|ROOT|Q)\b/i.test(label)
      ? `${label}${c1 || c2}` : m))
  .trim();

/** Splits text on a numbered marker ("CARD 3", "Q3.", "SLIDE 3") and returns
 *  the bodies of the LAST numbered run. A capture sometimes holds the answer
 *  twice -- a draft and then the final, both numbered from 1 -- and sixteen
 *  slides that are two copies of eight is worse than eight. */
export function numberedBlocks(text, marker, punct = '[:.)\\-–—]?') {
  // Uppercase markers match anywhere, even glued to the previous word
  // ("...recycled waterSLIDE 1") -- that is exactly what a lost newline looks
  // like. Any other casing ("Slide 1") only counts at the start of a line and
  // with punctuation after it, so prose that mentions "slide 3" never splits.
  const tail = String.raw`\s*(\d{1,3})\s*${punct}\s*`;
  const strict = String.raw`\s*(\d{1,3})\s*(?:[:.)\-–—]|(?=\n)|$)\s*`;
  const anyCase = marker.replace(/[A-Za-z]/g, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);
  const re = new RegExp(String.raw`(?<![A-Z0-9])${marker}${tail}|(?<=^|\n)[ \t]*${anyCase}${strict}`, 'g');
  const num = (m) => +(m[1] || m[2]);
  // Only an unbroken 1, 2, 3... sequence counts, so "Q4 earnings" inside
  // question 2 stays text rather than becoming a fourth question.
  const hits = [];
  let start = 0;
  for (const m of text.matchAll(re)) {
    const n = num(m);
    if (n === 1) { start = hits.length; hits.push(m); }
    else if (hits.length && n === num(hits[hits.length - 1]) + 1) hits.push(m);
  }
  const out = [];
  for (let k = start; k < hits.length; k++) {
    const e = k + 1 < hits.length ? hits[k + 1].index : text.length;
    out.push(text.slice(hits[k].index + hits[k][0].length, e).trim());
  }
  return out;
}

export function studioParseFlashcards(raw) {
  const c = studioClean(raw);
  const blocks = numberedBlocks(c, 'CARD');
  const t = blocks.length ? blocks.join('\n') : c;
  const cards = [];
  const re = /FRONT\s*:\s*([\s\S]*?)\s*BACK\s*:\s*([\s\S]*?)\s*(?=FRONT\s*:|$)/gi;
  let m;
  while ((m = re.exec(t))) {
    const front = m[1].trim(), back = m[2].trim();
    if (front && back) cards.push({ front, back });
  }
  return cards;
}

export function studioParseQuiz(raw) {
  const out = [];
  for (const block of numberedBlocks(studioClean(raw), 'Q(?:uestion)?', '[.):]')) {
    const cm = block.match(/(?<![A-Z])(?:CORRECT(?:\s+ANSWER)?|ANSWER|[Cc]orrect(?:\s+answer)?|[Aa]nswer)\s*[:\-–]\s*\(?\s*([A-Da-d])\b/);
    if (!cm) continue;
    const body = block.slice(0, cm.index);
    const wm = block.slice(cm.index + cm[0].length)
      .match(/(?<![A-Z])(?:WHY|EXPLANATION|[Ww]hy|[Ee]xplanation)\s*[:\-–]\s*([\s\S]*)$/);
    // Walk back from the end: the last D, then the last C before it, then B,
    // then A. A letter inside the question itself ("Plan B. ...") sits BEFORE
    // the real option markers, so searching backwards never lands on it.
    const marks = [];
    let end = body.length;
    for (const L of ['D', 'C', 'B', 'A']) {
      const re = new RegExp(String.raw`(?:^|\s)\(?${L}[.):]\s+`, 'g');
      const head = body.slice(0, end);
      let mm, last = null;
      while ((mm = re.exec(head))) last = mm;
      if (last) { marks.unshift({ L, at: last.index, len: last[0].length }); end = last.index; }
    }
    if (marks.length < 2) continue;
    const text = body.slice(0, marks[0].at).trim();
    const options = {};
    marks.forEach((mk, i) => {
      const stop = i + 1 < marks.length ? marks[i + 1].at : body.length;
      options[mk.L] = body.slice(mk.at + mk.len, stop).trim();
    });
    const correct = cm[1].toUpperCase();
    if (!text || !(correct in options)) continue;
    out.push({ text, options, correct, why: wm ? wm[1].trim() : '' });
  }
  return out;
}

export function studioParseSlides(raw) {
  const slides = [];
  for (let b of numberedBlocks(studioClean(raw), 'SLIDE')) {
    b = b.replace(/^TITLE\s*:\s*/i, '');
    let title, rest;
    const nl = b.indexOf('\n');
    if (nl >= 0) { title = b.slice(0, nl); rest = b.slice(nl + 1); }
    else {
      // All on one line: the title runs up to the first " - " bullet.
      const k = b.search(/\s[-•*]\s+/);
      title = k >= 0 ? b.slice(0, k) : b; rest = k >= 0 ? b.slice(k) : '';
    }
    const bullets = /\n/.test(rest.trim())
      ? rest.split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => l.replace(/^(?:[-•*]|\d+[.)])\s+/, ''))
      : rest.split(/(?:^|\s)[-•*]\s+/).map((s) => s.trim()).filter(Boolean);
    title = title.replace(/^#+\s*/, '').trim();
    if (title || bullets.length) slides.push({ title, bullets });
  }
  return slides;
}

/** ROOT: plus a dash outline, two levels deep. Deeper nesting is flattened
 *  onto the second level -- a badly indented answer still draws. */
export function studioParseMindmap(raw) {
  let root = '';
  const branches = [];
  const stack = [];
  // A capture that lost its newlines: " - " runs become bullets again.
  let t = studioClean(raw);
  if (!/\n\s*[-•*]\s/.test(t)) t = t.replace(/\s[-•*]\s+/g, '\n- ');
  for (const line of t.split('\n')) {
    if (!line.trim()) continue;
    const rm = line.match(/^\s*ROOT\s*:\s*(.+)$/i);
    if (rm) { root = rm[1].trim(); continue; }
    const bm = line.match(/^(\s*)[-•*]\s+(.*)$/);
    if (!bm) { if (!root && !branches.length) root = line.replace(/^#+\s*/, '').trim(); continue; }
    const indent = bm[1].replace(/\t/g, '  ').length;
    const node = { text: bm[2].trim(), children: [] };
    while (stack.length && indent <= stack[stack.length - 1][0]) stack.pop();
    if (!stack.length) branches.push(node);
    else stack[0][1].children.push(node);
    stack.push([indent, node]);
  }
  return root || branches.length ? [{ root, branches }] : [];
}

/* ── Shruti's shape ──────────────────────────────────────────────────────── */
const s = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
const ids = (x) => (Array.isArray(x) ? x : x ? [x] : []).map(String).filter((v) => /^L\d+$/.test(v));
const LABELLED = { flashcards: studioParseFlashcards, quiz: studioParseQuiz, slides: studioParseSlides, mindmap: (t) => studioParseMindmap(t)[0] || null };

/** Clean one kind's items, whatever shape they came in.
 *  flashcards: [{front, back, L, ref}]; quiz: [{text, options:{A..D}, correct, why, L}];
 *  slides: [{title, bullets, say, L}]; mindmap: {root, branches:[{text, L, children:[{text, L}]}]}. */
export function items(kind, x) {
  if (typeof x === 'string') x = LABELLED[kind](x);
  if (kind === 'mindmap') {
    if (!x || (!x.root && !(x.branches || []).length)) return null;
    const node = (n, deep) => ({ text: s(n.text), L: ids(n.L), children: deep ? (n.children || []).map((c) => node(c, false)).filter((c) => c.text) : [] });
    return { root: s(x.root), branches: (x.branches || []).map((b) => node(b, true)).filter((b) => b.text) };
  }
  const list = Array.isArray(x) ? x : [];
  if (kind === 'flashcards') return list.map((c) => ({ front: s(c.front), back: s(c.back), L: ids(c.L), ...(c.ref ? { ref: s(c.ref) } : {}) })).filter((c) => c.front && c.back);
  if (kind === 'quiz') return list.map((q) => {
    const options = {};
    for (const L of ['A', 'B', 'C', 'D']) if (q.options && s(q.options[L])) options[L] = s(q.options[L]);
    return { text: s(q.text), options, correct: s(q.correct).toUpperCase(), why: s(q.why), L: ids(q.L) };
  }).filter((q) => q.text && Object.keys(q.options).length >= 2 && q.correct in q.options);
  if (kind === 'slides') return list.map((d) => ({ title: s(d.title), bullets: (d.bullets || []).map(s).filter(Boolean), say: s(d.say), L: ids(d.L) })).filter((d) => d.title || d.bullets.length);
  return [];
}
export const KINDS = ['flashcards', 'quiz', 'mindmap', 'slides'];
export const count = (kind, it) => (!it ? 0 : kind === 'mindmap' ? it.branches.length : it.length);
/** Which lesson ids a kind's items name. */
export function lessonsIn(kind, it) {
  if (!it) return [];
  const all = kind === 'mindmap' ? it.branches.flatMap((b) => [...b.L, ...b.children.flatMap((c) => c.L)]) : it.flatMap((x) => x.L || []);
  return [...new Set(all)];
}
