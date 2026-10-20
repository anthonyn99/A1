// Text helpers shared by the reader and read-aloud, with no DOM so they can be
// tested in Node: what a block says, how a chapter is cut into spoken
// segments, and how the voice's words line up with the words on the page.

/** A block's spoken text: headings and asides as they are; a paragraph's
 *  pieces joined with spaces, without verse numbers (the page shows those
 *  beside the text, they are not read out). */
export function blockText(bl) {
  if (!bl) return '';
  if (bl.k === 'p') return (bl.s || []).map((s) => s.t).join(' ');
  return String(bl.t || '');
}

/** The longest text one read-aloud request carries. Orca takes 4096; shorter
 *  pieces start sooner. The longest block in the Gita is about 1,700. */
export const SEG_MAX = 1500;

/** Cut text at sentence ends into parts of at most `max` characters (a
 *  single longer sentence is cut at a space). */
export function splitSentences(text, max = SEG_MAX) {
  text = String(text || '').trim();
  if (text.length <= max) return text ? [text] : [];
  const sentences = text.match(/[^.!?;:]+(?:[.!?;:]+["'’”)\]]*|$)\s*/g) || [text];
  const out = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (let s of sentences) {
    while (s.length > max) {
      push();
      let cut = s.lastIndexOf(' ', max);
      if (cut <= 0) cut = max;
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut);
    }
    if (cur && (cur + s).length > max) push();
    cur += s;
  }
  push();
  return out;
}

/** A chapter as spoken segments, in reading order: {b: block index, part,
 *  text}. Every block is spoken: headings, verses and the book's asides. */
export function segmentsFor(ch, max = SEG_MAX) {
  const out = [];
  (ch && ch.blocks || []).forEach((bl, b) => {
    splitSentences(blockText(bl), max).forEach((text, part) => out.push({ b, part, text }));
  });
  return out;
}

/** Letters and digits only, lower case: how two spellings of a word compare. */
export const norm = (w) => String(w || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');

/** The words of a text as the page shows them. */
export const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’\-.]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu;
export function words(text) { return String(text || '').match(WORD_RE) || []; }

/** Line the voice's words up with the page's: for each spoken word, the index
 *  of the page word it belongs to, or -1. Greedy with a short look-ahead, so
 *  a word the voice says differently (a number read out, a hyphenated word
 *  said as two) costs one word, never the rest of the block. */
export function align(spoken, page, look = 6) {
  const pn = page.map(norm);
  const map = new Array(spoken.length).fill(-1);
  let j = 0, rest = null;   // rest: what is left of a page word the voice split
  for (let i = 0; i < spoken.length; i++) {
    const n = norm(spoken[i]);
    if (!n) continue;
    if (rest && j > 0 && rest.startsWith(n)) {
      map[i] = j - 1; rest = rest.slice(n.length) || null; continue;
    }
    rest = null;
    for (let k = j; k < Math.min(pn.length, j + look); k++) {
      if (!pn[k]) continue;
      if (pn[k] === n || n.startsWith(pn[k])) { map[i] = k; j = k + 1; break; }
      if (pn[k].startsWith(n)) { map[i] = k; j = k + 1; rest = pn[k].slice(n.length); break; }
    }
  }
  return map;
}

/** The spoken word playing at time t (seconds): the last that started. */
export function wordAt(ws, t) {
  let lo = 0, hi = ws.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ws[mid][0] <= t + 0.02) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Without word timings (Aura): spread the words over the audio by length. */
export function spreadWords(text, duration) {
  const ws = words(text);
  const total = ws.reduce((s, w) => s + w.length + 1, 0) || 1;
  let t = 0;
  return ws.map((w) => { const d = duration * (w.length + 1) / total; const out = [+t.toFixed(3), +d.toFixed(3), w]; t += d; return out; });
}

export const fmtTime = (s) => {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};
