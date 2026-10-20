// Import, the part with no page in it: a file's text as paragraphs, where its
// chapters start, and the chapters as Shruti's chapter files. import.js is the
// sheet around it; tests/import.test.js runs all of this in Node.
//
// A paragraph is {t, h}: t is the source's own text (lines joined, line-break
// hyphens taken out, spaces normalised: nothing else), h is 0 for body text or
// 1-3 for a heading. PDF paragraphs also carry pg (their page, 1-based), EPUB
// ones doc and ids (their file and the element ids in them), so a table of
// contents can point at them.
//
// The reader rule holds here too: no step rewrites a word. A tidy-up by AI is
// only taken where it stays at typo level (tidyCheck), paragraph by paragraph.

/* ── text ─────────────────────────────────────────────────────────────────── */
const SOFT_HYPHEN = /­/g;
const SPACES = /[  -   　\t ]+/g;
/** Spaces as one plain space; the soft hyphens a PDF hides in words removed. */
export const clean = (s) => String(s == null ? '' : s).replace(SOFT_HYPHEN, '').replace(/[​﻿]/g, '').replace(SPACES, ' ').trim();
const ENDS_HYPHEN = /[A-Za-zÀ-ɏ]-$/;
const STARTS_LOWER = /^[a-zß-ÿā-ɏ]/;
/** Lines of one paragraph joined: a word broken over a line ("cour-" "age")
 *  is put back together; a real hyphen before a capital stays. */
export function joinLines(lines) {
  let out = '';
  for (const raw of lines) {
    const l = clean(raw);
    if (!l) continue;
    if (!out) { out = l; continue; }
    if (ENDS_HYPHEN.test(out) && STARTS_LOWER.test(l)) out = out.slice(0, -1) + l;
    else if (ENDS_HYPHEN.test(out)) out += l;   // "Self-" "Realization": a real compound
    else out += ' ' + l;
  }
  return out;
}
export const wordsOf = (s) => clean(s).split(' ').filter(Boolean);
export const wordCount = (paras) => paras.reduce((n, p) => n + wordsOf(p.t).length, 0);
/** For matching titles and anchors: letters and digits only, lower case. */
export const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const CHAPTER_WORD = /^(chapter|chap\.|part|book|section|canto|lesson|unit|prologue|epilogue|introduction|preface|foreword|afterword|appendix|conclusion)\b/i;
const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty';
const CHAPTER_LINE = new RegExp('^(chapter|chap\\.|part|book|canto)\\s+([0-9]+|[ivxlcdm]+|(' + NUMBER_WORDS + ')([- ](' + NUMBER_WORDS + '))?)\\b', 'i');
/** A line that reads like a heading in plain text: short, no full stop, and
 *  either a chapter word, a roman numeral, or all capitals. */
export function headingLike(t) {
  t = clean(t);
  if (!t || t.length > 90 || /[.,;:]$/.test(t) && !/^[ivxlcdm]+\.$/i.test(t)) return 0;
  if (CHAPTER_LINE.test(t) || CHAPTER_WORD.test(t) && t.split(' ').length <= 8) return 2;
  if (/^[IVXLCDM]+\.?$/.test(t)) return 2;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 4 && letters === letters.toUpperCase() && t.split(' ').length <= 10) return 2;
  return 0;
}

/** Plain text or pasted text: paragraphs at blank lines (or one per line when
 *  there are none); markdown # headings and heading-like lines become headings. */
export function fromText(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const hasBlank = /\n[ \t]*\n/.test(src);
  const chunks = hasBlank ? src.split(/\n[ \t]*\n+/) : src.split('\n');
  const out = [];
  for (const chunk of chunks) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    // A heading line glued to its first paragraph (no blank line between).
    while (lines.length > 1 && (/^#{1,6}\s/.test(lines[0]) || headingLike(lines[0]))) {
      out.push(heading(lines.shift()));
    }
    const t = joinLines(lines);
    if (!t) continue;
    if (lines.length === 1 && (/^#{1,6}\s/.test(t) || headingLike(t))) out.push(heading(t));
    else out.push({ t, h: 0 });
  }
  return out;
}
function heading(line) {
  const m = /^(#{1,6})\s+(.*)$/.exec(clean(line));
  if (m) return { t: clean(m[2]), h: Math.min(3, m[1].length) };
  return { t: clean(line), h: headingLike(line) || 2 };
}

/* ── PDF (pdf.js text items) ──────────────────────────────────────────────── */
/** pdf.js getTextContent() items of one page -> {items:[{str, x, y, size, w}], height}. */
export function pdfPage(content, viewportHeight) {
  const items = [];
  for (const it of content.items || []) {
    if (typeof it.str !== 'string') continue;
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    const size = Math.hypot(tr[2], tr[3]) || Math.abs(tr[3]) || it.height || 10;
    items.push({ str: it.str, x: tr[4], y: tr[5], size, w: it.width || 0 });
  }
  return { items, height: viewportHeight || 792 };
}
function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
/** One page's items as lines, top to bottom. */
export function pdfLines(page) {
  const its = page.items.filter((i) => i.str !== '').slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of its) {
    const l = lines.find((x) => Math.abs(x.y - it.y) <= Math.max(1.5, Math.min(x.size, it.size) * 0.45));
    if (l) { l.items.push(it); l.size = Math.max(l.size, it.str.trim() ? it.size : 0); }
    else lines.push({ y: it.y, size: it.str.trim() ? it.size : 0, items: [it] });
  }
  return lines.map((l) => {
    l.items.sort((a, b) => a.x - b.x);
    let t = '', end = null;
    for (const it of l.items) {
      if (end != null && t && !/\s$/.test(t) && !/^\s/.test(it.str) && it.x - end > it.size * 0.18) t += ' ';
      t += it.str;
      end = it.x + (it.w || it.str.length * it.size * 0.5);
    }
    return { t: clean(t), y: l.y, x: l.items[0].x, size: l.size || (l.items[0] && l.items[0].size) || 0, right: end || 0 };
  }).filter((l) => l.t).sort((a, b) => b.y - a.y);
}
const edgeKey = (t) => fold(t).replace(/\d+/g, '#').replace(/\b[ivxlcdm]+\b/g, '#');
/** Pages ({items, height}) -> paragraphs with pg. Running heads and feet that
 *  repeat on many pages, and bare page numbers, are left out (like extract.py). */
export function fromPdf(pages) {
  const all = pages.map((p) => pdfLines(p));
  // Running heads/feet: the first two and last two lines of a page whose text
  // (numbers aside) comes back on at least a third of the pages.
  const seen = new Map();
  all.forEach((ls) => {
    const keys = new Set([...ls.slice(0, 2), ...ls.slice(-2)].map((l) => edgeKey(l.t)));
    keys.forEach((k) => seen.set(k, (seen.get(k) || 0) + 1));
  });
  const minRepeat = Math.max(3, Math.ceil(pages.length / 3));
  const isEdge = (l, i, ls) => (i < 2 || i >= ls.length - 2) && (/^[\divxlcdm\s.\-–—|]+$/i.test(l.t) || (pages.length >= 3 && edgeKey(l.t) && seen.get(edgeKey(l.t)) >= minRepeat));
  const lines = [];
  all.forEach((ls, pi) => ls.forEach((l, i, a) => { if (!isEdge(l, i, a)) lines.push(Object.assign(l, { pg: pi + 1 })); }));
  if (!lines.length) return [];
  // Body text size, weighted by how much text has it; the left margin; the
  // usual distance between lines.
  const bySize = new Map();
  lines.forEach((l) => { const k = Math.round(l.size * 2) / 2; bySize.set(k, (bySize.get(k) || 0) + l.t.length); });
  const body = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const gaps = [];
  for (let i = 1; i < lines.length; i++) if (lines[i].pg === lines[i - 1].pg) { const g = lines[i - 1].y - lines[i].y; if (g > 0) gaps.push(g); }
  const gap = median(gaps) || body * 1.3;
  const bodyLines = lines.filter((l) => Math.abs(l.size - body) < body * 0.08);
  const left = median(bodyLines.map((l) => l.x));
  const width = median(bodyLines.map((l) => l.right - l.x)) || 400;
  const levelOf = (l) => (l.size >= body * 1.6 ? 1 : l.size >= body * 1.15 ? 2 : 0);

  const out = [];
  let cur = null;
  const flush = () => { if (cur) { const t = joinLines(cur.lines); if (t) out.push({ t, h: cur.h, pg: cur.pg }); } cur = null; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], prev = lines[i - 1];
    let h = levelOf(l);
    if (h && l.t.length > 140) h = 0;
    let fresh = !cur || cur.h !== h;
    if (!fresh && h) {
      // A heading over two lines stays one heading.
      fresh = prev.pg !== l.pg || prev.y - l.y > gap * 2.2;
    } else if (!fresh) {
      if (prev.pg !== l.pg) {
        // Across a page: one paragraph unless the last one ended a sentence.
        fresh = /[.!?:"”’)\]]$/.test(prev.t) && !STARTS_LOWER.test(l.t);
      } else {
        const dy = prev.y - l.y;
        const indent = l.x - left > body * 0.8 && l.x - left < width * 0.4;
        const shortPrev = prev.right - prev.x < width * 0.72 && /[.!?:"”’)]$/.test(prev.t);
        fresh = dy > gap * 1.45 || indent || shortPrev;
      }
    }
    if (fresh) { flush(); cur = { h, pg: l.pg, lines: [] }; }
    cur.lines.push(l.t);
  }
  flush();
  return out;
}

/* ── DOCX (word/document.xml) ─────────────────────────────────────────────── */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const unxml = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] != null ? ENT[e.toLowerCase()] : m;
});
/** files: {'word/document.xml': xml, 'docProps/core.xml'?: xml} -> {paras, title, author}. */
export function fromDocx(files) {
  let xml = String(files['word/document.xml'] || '');
  if (!xml) throw new Error('This Word file has no document in it.');
  // Tracked deletions are not the text; field codes are not either.
  xml = xml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, '').replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, '');
  const body = (/<w:body>([\s\S]*)<\/w:body>/.exec(xml) || [, xml])[1];
  const paras = [];
  for (const m of body.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    const p = m[1] || '';
    const style = (/<w:pStyle w:val="([^"]+)"/.exec(p) || [])[1] || '';
    const lvl = (/<w:outlineLvl w:val="(\d)"/.exec(p) || [])[1];
    let t = '';
    for (const r of p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\b[^>]*\/>|<w:noBreakHyphen\/>/g)) {
      if (r[1] != null) t += unxml(r[1]);
      else if (/noBreakHyphen/.test(r[0])) t += '-';
      else t += ' ';
    }
    t = clean(t);
    if (!t) continue;
    let h = 0;
    const sm = /^(?:heading|berschrift|titre|t[ií]tulo)\s*(\d)$/i.exec(style.replace(/[^A-Za-z0-9]/g, ' ').replace(/\s+/g, ' ').trim()) || /^Heading(\d)$/i.exec(style);
    if (/^title$/i.test(style)) h = 1;
    else if (sm) h = Math.min(3, Math.max(1, Number(sm[1])));
    else if (lvl != null) h = Math.min(3, Number(lvl) + 1);
    // A "Title" paragraph is the book's name, never a chapter (detect skips it).
    paras.push(/^title$/i.test(style) ? { t, h, ttl: true } : { t, h });
  }
  const core = String(files['docProps/core.xml'] || '');
  const title = clean(unxml((/<dc:title>([\s\S]*?)<\/dc:title>/.exec(core) || [])[1] || ''));
  const author = clean(unxml((/<dc:creator>([\s\S]*?)<\/dc:creator>/.exec(core) || [])[1] || ''));
  return { paras, title, author };
}

/* ── EPUB ─────────────────────────────────────────────────────────────────── */
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
export function resolvePath(base, href) {
  const parts = (dirOf(base) + decodeURIComponent(String(href || '').split('#')[0])).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}
const BLOCKS = new Set(['P', 'DIV', 'LI', 'BLOCKQUOTE', 'PRE', 'DD', 'DT', 'FIGCAPTION', 'TD', 'TH', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'CENTER']);
const HEAD = /^H([1-6])$/;
const tag = (el) => String(el.localName || el.nodeName || '').toUpperCase();
/** files: {path: text} of the unzipped EPUB; parseXml(str) -> Document.
 *  Resolves {paras, toc:[{title, at, depth}], title, author}. */
export function fromEpub(files, parseXml) {
  const container = files['META-INF/container.xml'];
  if (!container) throw new Error('This EPUB has no META-INF/container.xml.');
  const opfPath = (/full-path="([^"]+)"/.exec(container) || [])[1];
  const opf = opfPath && files[opfPath];
  if (!opf) throw new Error('This EPUB names no package file.');
  const title = clean(unxml((/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(opf) || [])[1] || ''));
  const author = clean(unxml((/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/.exec(opf) || [])[1] || ''));
  const items = {};
  let navId = null;
  for (const m of opf.matchAll(/<(?:opf:)?item\b([^>]*?)\/?>/g)) {
    const a = m[1], id = (/\bid="([^"]+)"/.exec(a) || [])[1], href = (/\bhref="([^"]+)"/.exec(a) || [])[1];
    if (!id || !href) continue;
    items[id] = { href: resolvePath(opfPath, href), type: (/media-type="([^"]+)"/.exec(a) || [])[1] || '' };
    if (/properties="[^"]*\bnav\b/.test(a)) navId = id;
  }
  const ncxId = (/<(?:opf:)?spine\b[^>]*\btoc="([^"]+)"/.exec(opf) || [])[1];
  const spine = [...opf.matchAll(/<(?:opf:)?itemref\b([^>]*?)\/?>/g)].map((m) => (/idref="([^"]+)"/.exec(m[1]) || [])[1]).filter((id) => items[id]);

  const paras = [];
  const where = new Map();   // "doc#id" and "doc" -> paragraph index
  for (const id of spine) {
    const it = items[id];
    if (!/html|xml/.test(it.type) && !/\.x?html?$/i.test(it.href)) continue;
    const src = files[it.href];
    if (src == null) continue;
    const d = parseXml(src);
    const body = d && (d.getElementsByTagName('body')[0] || d.documentElement);
    if (!body) continue;
    const first = paras.length;
    let pendingIds = [];
    const push = (t, h, ids) => {
      t = clean(t);
      if (!t) { pendingIds.push(...ids); return; }
      const all = pendingIds.concat(ids);
      pendingIds = [];
      all.forEach((x) => { if (!where.has(it.href + '#' + x)) where.set(it.href + '#' + x, paras.length); });
      paras.push({ t, h, doc: it.href });
    };
    const walk = (el) => {
      for (const n of Array.from(el.childNodes || [])) {
        if (n.nodeType !== 1) continue;
        const tg = tag(n);
        if (tg === 'SCRIPT' || tg === 'STYLE' || tg === 'NAV' && /toc/i.test(n.getAttribute('epub:type') || '')) continue;
        const hm = HEAD.exec(tg);
        const ids = n.getAttribute && n.getAttribute('id') ? [n.getAttribute('id')] : [];
        if (hm) { push(textOf(n), Math.min(3, Number(hm[1])), ids.concat(idsIn(n))); continue; }
        if (BLOCKS.has(tg) && !hasBlockChild(n)) { push(textOf(n), 0, ids.concat(idsIn(n))); continue; }
        if (ids.length) pendingIds.push(...ids);
        walk(n);
      }
    };
    walk(body);
    if (paras.length > first) where.set(it.href, first);
  }

  // The table of contents: EPUB 3 nav, else the EPUB 2 NCX.
  let toc = [];
  if (navId && files[items[navId].href]) {
    const navPath = items[navId].href, d = parseXml(files[navPath]);
    const navs = Array.from(d.getElementsByTagName('nav'));
    const nav = navs.find((n) => /toc/.test(n.getAttribute('epub:type') || n.getAttribute('type') || '')) || navs[0];
    const ol = nav && Array.from(nav.childNodes).find((n) => n.nodeType === 1 && /^(ol|ul)$/i.test(tag(n)));
    const walkOl = (list, depth) => {
      for (const li of Array.from(list.childNodes).filter((n) => n.nodeType === 1 && /^li$/i.test(tag(n)))) {
        const a = Array.from(li.getElementsByTagName('a'))[0];
        if (a) toc.push({ title: clean(textOf(a)), href: resolveHref(navPath, a.getAttribute('href')), depth });
        const sub = Array.from(li.childNodes).find((n) => n.nodeType === 1 && /^(ol|ul)$/i.test(tag(n)));
        if (sub) walkOl(sub, depth + 1);
      }
    };
    if (ol) walkOl(ol, 0);
  } else if (ncxId && files[items[ncxId].href]) {
    const ncxPath = items[ncxId].href, d = parseXml(files[ncxPath]);
    const walkNp = (el, depth) => {
      for (const np of Array.from(el.childNodes).filter((n) => n.nodeType === 1 && /navPoint$/i.test(tag(n)))) {
        const label = np.getElementsByTagName('text')[0], content = np.getElementsByTagName('content')[0];
        if (label && content) toc.push({ title: clean(textOf(label)), href: resolveHref(ncxPath, content.getAttribute('src')), depth });
        walkNp(np, depth + 1);
      }
    };
    const map = d.getElementsByTagName('navMap')[0];
    if (map) walkNp(map, 0);
  }
  toc = toc.map((e) => ({ title: e.title, depth: e.depth, at: where.has(e.href) ? where.get(e.href) : where.get(e.href.split('#')[0]) }))
    .filter((e) => e.title && e.at != null);
  return { paras, toc, title, author };
}
function resolveHref(base, href) {
  const [p, frag] = String(href || '').split('#');
  const full = p ? resolvePath(base, p) : base;
  return frag ? full + '#' + frag : full;
}
function textOf(el) { return String(el.textContent || ''); }
function idsIn(el) { return Array.from(el.querySelectorAll ? el.querySelectorAll('[id]') : []).map((x) => x.getAttribute('id')); }
function hasBlockChild(el) {
  for (const n of Array.from(el.children || [])) { const t = tag(n); if (BLOCKS.has(t) || HEAD.test(t) || hasBlockChild(n)) return true; }
  return false;
}

/* ── where the chapters start ─────────────────────────────────────────────── */
/** starts: [{title, at}] sorted, unique, inside the text. */
function tidyStarts(starts, n) {
  const out = [];
  for (const s of starts.slice().sort((a, b) => a.at - b.at)) {
    if (!(s.at >= 0 && s.at < n)) continue;
    if (out.length && out[out.length - 1].at === s.at) continue;
    out.push({ title: clean(s.title) || 'Untitled', at: s.at });
  }
  return out;
}
/** Chapters from the file's own structure, no AI: its table of contents
 *  (EPUB nav or PDF outline), else its headings, else "Chapter N" lines.
 *  Resolves {starts:[{title, at}], how}. */
export function detect(paras, { toc } = {}) {
  const n = paras.length;
  if (toc && toc.length >= 2) {
    const top = toc.filter((e) => !e.depth);
    const use = top.length >= 2 ? top : toc;
    return { starts: tidyStarts(use.map((e) => ({ title: e.title, at: e.at })), n), how: 'contents' };
  }
  // The highest heading level that comes back at least twice; a single h1
  // (the book's own title) does not count.
  for (const lv of [1, 2, 3]) {
    const at = paras.map((p, i) => (p.h === lv && !p.ttl ? i : -1)).filter((i) => i >= 0);
    if (at.length >= 2 && at.length <= Math.max(2, n / 2)) return { starts: tidyStarts(at.map((i) => ({ title: paras[i].t, at: i })), n), how: 'headings' };
  }
  const lines = paras.map((p, i) => (CHAPTER_LINE.test(p.t) && p.t.length < 120 ? i : -1)).filter((i) => i >= 0);
  if (lines.length >= 2) return { starts: tidyStarts(lines.map((i) => ({ title: paras[i].t, at: i })), n), how: 'chapter lines' };
  return { starts: n ? [{ title: 'The whole text', at: 0 }] : [], how: 'none' };
}
/** pdf.js outline entries resolved to pages [{title, page, depth}] -> toc
 *  entries pointing at the first paragraph of that page whose text matches
 *  the title (else the first on the page). */
export function outlineToToc(paras, outline) {
  const out = [];
  for (const e of outline || []) {
    const onPage = paras.map((p, i) => (p.pg === e.page ? i : -1)).filter((i) => i >= 0);
    if (!onPage.length) continue;
    const f = fold(e.title);
    const hit = onPage.find((i) => f && (fold(paras[i].t).startsWith(f) || f.startsWith(fold(paras[i].t)) && fold(paras[i].t).length > 3));
    out.push({ title: e.title, depth: e.depth || 0, at: hit != null ? hit : onPage[0] });
  }
  return out;
}

/* ── chapters by AI: the ask and the check ───────────────────────────────── */
export const TOC_SPILL = 160;   // characters of each paragraph the model sees
/** What the model reads: each paragraph's number and how it starts, headings
 *  marked. A very long book sends its headings and short lines, plus every
 *  20th paragraph, so the ask stays readable. */
export function tocListing(paras, { max = 150000 } = {}) {
  const line = (p, i) => i + (p.h ? ' [H' + p.h + ']' : '') + ' | ' + (p.t.length > TOC_SPILL ? p.t.slice(0, TOC_SPILL) + '…' : p.t);
  let rows = paras.map(line);
  if (rows.join('\n').length > max) rows = paras.map((p, i) => (p.h || p.t.length <= 100 || i % 20 === 0 ? line(p, i) : null)).filter(Boolean);
  return rows.join('\n');
}
export function tocPrompt(paras, { title, extra } = {}) {
  const sys = 'You find the chapters of a book for Shruti, a reading app. Reply with ONLY the JSON object described, nothing before or after it.';
  const user = 'Below is a book' + (title ? ' ("' + title + '")' : '') + ', one numbered paragraph per line ("number | how it starts"; [H1]-[H3] mark headings the file itself has).\n' +
    'Find where each chapter (or the book\'s own top-level parts, if it has no chapters) starts. Front matter (title page, contents, copyright) is not a chapter; an introduction or preface is.\n' +
    'For each chapter give its title as the book names it, the number of the paragraph it starts at, and "anchor": the first eight or so words of that paragraph, copied exactly.\n' +
    'Also give the book\'s title and author if the text says them.' + (extra ? '\nThe reader also asks: ' + extra : '') +
    '\n\nReply format (JSON only):\n{"title":"…","author":"…","chapters":[{"title":"…","start":12,"anchor":"…"}]}' +
    '\n\n<source>\n' + tocListing(paras) + '\n</source>';
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}
/** The model's chapters, checked against the text: a start is kept where its
 *  anchor really begins there, moved to where it does (nearest first), or
 *  dropped. Resolves {starts, title, author, moved, dropped}. */
export function checkToc(paras, reply) {
  const list = (reply && Array.isArray(reply.chapters) ? reply.chapters : Array.isArray(reply) ? reply : []);
  const heads = paras.map((p) => fold(p.t));
  let moved = 0, dropped = 0;
  const starts = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') { dropped++; continue; }
    const want = Number(c.start), a = fold(c.anchor || '').split(' ').slice(0, 8).join(' ');
    const begins = (i) => i >= 0 && i < heads.length && (!a || heads[i].startsWith(a) || (a.length > 12 && heads[i].startsWith(a.slice(0, Math.floor(a.length * 0.7)))));
    let at = -1;
    if (Number.isInteger(want) && begins(want)) at = want;
    else if (a) {
      // Nearest paragraph that starts with the anchor.
      let best = -1, bd = Infinity;
      heads.forEach((h, i) => { if (begins(i)) { const d = Number.isInteger(want) ? Math.abs(i - want) : i; if (d < bd) { bd = d; best = i; } } });
      if (best < 0 && a.split(' ').length >= 3) {
        // Or one that contains it (a heading and its first words in one paragraph).
        heads.forEach((h, i) => { if (best < 0 && h.includes(a)) best = i; });
      }
      at = best;
      if (at >= 0) moved++;
    } else if (Number.isInteger(want) && want >= 0 && want < heads.length) at = want;
    if (at < 0) { dropped++; continue; }
    starts.push({ title: c.title || paras[at].t.slice(0, 80), at });
  }
  return { starts: tidyStarts(starts, paras.length), title: clean(reply && reply.title), author: clean(reply && reply.author), moved, dropped };
}

/* ── chapters as Shruti chapter files ────────────────────────────────────── */
/** Cut the text at the starts. Anything before the first start becomes a
 *  first part of its own ("Before chapter 1"), so no text is ever lost. */
export function split(paras, starts) {
  const ss = tidyStarts(starts, paras.length);
  if (!ss.length) return paras.length ? [{ title: 'The whole text', paras: paras.slice() }] : [];
  const out = [];
  if (ss[0].at > 0) out.push({ title: 'Opening pages', paras: paras.slice(0, ss[0].at), front: true });
  ss.forEach((s, i) => out.push({ title: s.title, paras: paras.slice(s.at, i + 1 < ss.length ? ss[i + 1].at : paras.length) }));
  return out;
}
/** One chapter's paragraphs -> {n, title, blocks} (README "Chapter file
 *  format"). Its first paragraph is dropped only when it is the chapter's own
 *  title, which the chapter page already shows. */
export function toChapter(n, title, paras) {
  const ps = paras.slice();
  if (ps.length > 1 && fold(ps[0].t) === fold(title)) ps.shift();
  const blocks = ps.map((p) => (p.h ? { k: 'h', t: p.t } : { k: 'p', s: [{ t: p.t, v: null }] }));
  return { n, title, blocks };
}
/** The text of a chapter file as paragraphs again (for the review screen). */
export const parasOf = (ch) => (ch.blocks || []).map((b) => (b.k === 'h' ? { t: b.t, h: 2 } : { t: (b.s || []).map((s) => s.t).join(' '), h: 0 }));
/** Every word of the source is in the chapters, in order (the import check). */
export function sameWords(paras, chapters) {
  const a = paras.map((p) => p.t).join(' ');
  const b = chapters.map((c) => c.paras.map((p) => p.t).join(' ')).join(' ');
  return wordsOf(a).join(' ') === wordsOf(b).join(' ');
}

/* ── a tidy-up by AI, held to typo level ─────────────────────────────────── */
function lev(a, b, cap = 4) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let lo = cur[0];
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); lo = Math.min(lo, cur[j]); }
    if (lo > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}
/** Word-level edit script between two texts (Myers), as runs of
 *  {del:[words], ins:[words]}. Gives up (null) past maxD edits. */
export function wordRuns(a, b, maxD = 200) {
  const A = wordsOf(a), B = wordsOf(b), N = A.length, M = B.length, MAX = Math.min(N + M, maxD);
  const V = new Map([[1, 0]]), trace = [];
  let found = false;
  for (let d = 0; d <= MAX && !found; d++) {
    trace.push(new Map(V));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (V.get(k - 1) ?? -1) < (V.get(k + 1) ?? -1)) ? (V.get(k + 1) ?? 0) : (V.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      V.set(k, x);
      if (x >= N && y >= M) { found = true; break; }
    }
  }
  if (!found) return null;
  // Walk back to the edits.
  const edits = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d > 0; d--) {
    const Vd = trace[d], k = x - y;
    const down = k === -d || (k !== d && (Vd.get(k - 1) ?? -1) < (Vd.get(k + 1) ?? -1));
    const pk = down ? k + 1 : k - 1, px = Vd.get(pk) ?? 0, py = px - pk;
    while (x > px && y > py) { x--; y--; edits.push({ eq: A[x] }); }
    if (down) { y--; edits.push({ ins: B[y] }); } else { x--; edits.push({ del: A[x] }); }
    x = px; y = py;
  }
  while (x > 0 && y > 0) { x--; y--; edits.push({ eq: A[x] }); }
  edits.reverse();
  const runs = [];
  let r = null;
  for (const e of edits) {
    if (e.eq != null) { r = null; continue; }
    if (!r) runs.push(r = { del: [], ins: [] });
    if (e.del != null) r.del.push(e.del); else r.ins.push(e.ins);
  }
  return runs;
}
/** Is the tidied paragraph the same text up to typos? Each change must be a
 *  word or two fixed (a split or joined word, a broken hyphen, a misread
 *  letter or two); changes in all at most max(2, 3 % of the words). */
export function tidyCheck(before, after) {
  if (clean(before) === clean(after)) return { ok: true, changes: 0 };
  const n = wordsOf(before).length;
  const runs = wordRuns(before, after, Math.max(12, Math.ceil(n * 0.1)));
  if (!runs) return { ok: false, why: 'too many changes' };
  const limit = Math.max(2, Math.ceil(n * 0.03));
  if (runs.length > limit) return { ok: false, why: runs.length + ' changes (at most ' + limit + ')' };
  for (const r of runs) {
    if (r.del.length > 2 || r.ins.length > 2 || !r.del.length || !r.ins.length) return { ok: false, why: 'words added or taken out' };
    const a = r.del.join(''), b = r.ins.join('');
    const strip = (s) => s.replace(/[-‐‑]/g, '');
    if (strip(a) === strip(b)) continue;
    if (lev(a.toLowerCase(), b.toLowerCase(), 3) > Math.min(3, Math.max(1, Math.floor(a.length / 3)))) return { ok: false, why: '“' + r.del.join(' ') + '” became “' + r.ins.join(' ') + '”' };
  }
  return { ok: true, changes: runs.length };
}
export function tidyPrompt(title, paras) {
  const sys = 'You repair text that was extracted from a book file. Reply with ONLY the JSON object described.';
  const user = 'These are the paragraphs of "' + title + '", numbered. Fix ONLY extraction errors: words broken by a line break or hyphen, words run together, a letter or two misread. Do not change the wording, spelling choices, punctuation style or anything else, and never add or remove words. Return every paragraph, in order, changed or not.\n\n' +
    'Reply format (JSON only):\n{"paragraphs":["…","…"]}\n\n<source>\n' + paras.map((p, i) => i + ' | ' + p.t).join('\n') + '\n</source>';
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}
/** Take the model's paragraphs where each one passes tidyCheck; the rest stay
 *  as they were. Resolves {paras, taken, refused, why}. */
export function applyTidy(paras, reply) {
  const got = reply && Array.isArray(reply.paragraphs) ? reply.paragraphs : null;
  if (!got || got.length !== paras.length) return { paras, taken: 0, refused: paras.length, why: 'the reply did not keep the paragraphs' };
  let taken = 0, refused = 0, why = '';
  const out = paras.map((p, i) => {
    const t = clean(String(got[i] == null ? '' : got[i]).replace(/^\d+\s*\|\s*/, ''));
    if (t === p.t) return p;
    const c = tidyCheck(p.t, t);
    if (c.ok) { taken++; return Object.assign({}, p, { t }); }
    refused++; why = why || c.why;
    return p;
  });
  return { paras: out, taken, refused, why };
}

/* ── ids and names ────────────────────────────────────────────────────────── */
export const newBookId = () => 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
export const fileOf = (n) => 'ch' + String(n).padStart(2, '0');
/** A title from a file name: "the_gita-final (2).pdf" -> "The gita final". */
export function titleFromName(name) {
  const t = clean(String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').replace(/\s*\(\d+\)$/, '').replace(/-+/g, ' '));
  return t ? t[0].toUpperCase() + t.slice(1) : 'Untitled';
}
export const KIND = (name, type) => {
  const n = String(name || '').toLowerCase();
  if (/\.pdf$/.test(n) || type === 'application/pdf') return 'pdf';
  if (/\.epub$/.test(n) || type === 'application/epub+zip') return 'epub';
  if (/\.docx$/.test(n) || /wordprocessingml/.test(type || '')) return 'docx';
  if (/\.(txt|md|markdown|text)$/.test(n) || /^text\//.test(type || '')) return 'text';
  return null;
};
