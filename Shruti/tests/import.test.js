// Shruti's Import and drag to reorder (Phase 8), offline:
//  - extract.js: text, PDF (pdf.js text items), Word and EPUB to paragraphs;
//    lines joined, line-break hyphens put back, running heads and page
//    numbers left out; chapters from the file's own contents, headings or
//    "Chapter N" lines; the AI's table of contents checked against the text
//    (kept, moved to where its first words really are, or dropped); the cut
//    keeps every word; a tidy-up is taken only at typo level;
//  - books.js: a chapter's text in Firestore (cut into parts when large),
//    read back, the book in Mine or Shared, rename, delete;
//  - order.js: each person's order of a list (new items keep their place).
//
// Run: node Shruti/tests/import.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const DIR = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};

// A small Firestore: documents by path, dotted updates, snapshots.
function fakeFirestore() {
  const docs = new Map(), subs = new Map();
  const DEL = { __del: 1 };
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const snap = (p) => ({ exists: () => docs.has(p), data: () => clone(docs.get(p)), metadata: { hasPendingWrites: false } });
  const fire = (p) => (subs.get(p) || []).forEach((cb) => cb(snap(p)));
  const setPath = (o, k, v) => { const ks = k.split('.'); let c = o; for (let i = 0; i < ks.length - 1; i++) { if (!c[ks[i]] || typeof c[ks[i]] !== 'object') c[ks[i]] = {}; c = c[ks[i]]; } if (v === DEL) delete c[ks[ks.length - 1]]; else c[ks[ks.length - 1]] = clone(v); };
  const api = {
    docs,
    doc: (db, p) => ({ p, path: p }),
    onSnapshot: (ref, cb) => { if (!subs.has(ref.p)) subs.set(ref.p, []); subs.get(ref.p).push(cb); setTimeout(() => cb(snap(ref.p)), 0); return () => {}; },
    getDoc: async (ref) => snap(ref.p),
    setDoc: async (ref, o, opt) => { const cur = opt && opt.merge && docs.has(ref.p) ? docs.get(ref.p) : {}; docs.set(ref.p, Object.assign(cur, clone(o))); fire(ref.p); },
    updateDoc: async (ref, o) => { if (!docs.has(ref.p)) throw Object.assign(new Error('nf'), { code: 'not-found' }); const d = docs.get(ref.p); for (const [k, v] of Object.entries(o)) setPath(d, k, v); fire(ref.p); },
    deleteDoc: async (ref) => { docs.delete(ref.p); },
    deleteField: () => DEL,
  };
  return api;
}

(async () => {
  console.log('\nThe files');
  const babel = require('@babel/parser');
  for (const f of ['extract.js', 'books.js', 'order.js', 'import.js', 'library.js', 'study/hub.js', 'study/ui.js', 'study/flashcards.js', 'study/quiz.js', 'study/slides.js', 'study/mindmap.js', 'generate.js']) {
    let err = null; try { babel.parse(read(f), { sourceType: 'module' }); } catch (e) { err = e.message; }
    ok(f + ' parses as a module', !err, err);
  }
  global.window = { SHRUTI_PROFILES: { tony: { label: 'Tony', doc: 'shruti' }, veda: { label: 'Veda', doc: 'shruti_veda' } }, SHRUTI_PROFILE: 'tony' };
  global.addEventListener = () => {};
  global.dispatchEvent = () => {};
  global.document = { addEventListener() {}, querySelector() { return null; } };
  global.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const X = await import(pathToFileURL(path.join(DIR, 'extract.js')).href);
  const C = await import(pathToFileURL(path.join(DIR, 'core.js')).href);
  const OR = await import(pathToFileURL(path.join(DIR, 'order.js')).href);
  const B = await import(pathToFileURL(path.join(DIR, 'books.js')).href);
  const M = await import(pathToFileURL(path.join(DIR, 'media.js')).href);
  const G = await import(pathToFileURL(path.join(DIR, 'generate.js')).href);
  const H = await import(pathToFileURL(path.join(DIR, 'study/hub.js')).href);
  const U = await import(pathToFileURL(path.join(DIR, 'study/ui.js')).href);
  ok('they load in Node', typeof X.fromPdf === 'function' && typeof B.save === 'function' && typeof OR.sortable === 'function');
  ok('the library reads imported books through books.js, shipped ones from the repo', /isShipped\(id\) \? getJSON\('books\/' \+ id \+ '\/book\.json'\) : B\.get\(id\)/.test(read('library.js')) && /B\.chapter\(id, file\)/.test(read('library.js')));
  ok('only shipped books fetch shipped media and study sets', ['podcast.js', 'video.js', 'narrate.js'].every((f) => /if \(!C\.isShipped\(book\)\) return Promise\.resolve\(\{\}\);/.test(read(f))) && /!C\.isShipped\(book\) \? Promise\.resolve\(\{\}\)/.test(read('study/hub.js')));
  ok('a personal book\'s media is read from the person\'s own doc', ['podcast.js', 'video.js', 'narrate.js'].every((f) => /M\.docFor\(book\)\.get\('assets\./.test(read(f)) && !/C\.shared\.get\('assets\./.test(read(f))));
  ok('pdf.js comes from A1\'s vendored copy, JSZip pinned from cdnjs', /'\.\.\/V1\/vendor\/pdfjs-6\.3\.289\/'/.test(read('import.js')) && fs.existsSync(path.join(DIR, '..', 'V1', 'vendor', 'pdfjs-6.3.289', 'pdf.min.mjs')) && /cdnjs\.cloudflare\.com\/ajax\/libs\/jszip\/3\.10\.1\/jszip\.min\.js/.test(read('import.js')));
  ok('the README says how to move Shruti with pdf.js outside it', /V1\/vendor\/pdfjs-6\.3\.289/.test(read('docs/README.md')));

  console.log('\nText');
  ok('a word broken over a line is put back', X.joinLines(['the cour-', 'age of Arjuna']) === 'the courage of Arjuna');
  ok('a real hyphen before a capital stays, with no space', X.joinLines(['Self-', 'Realization']) === 'Self-Realization');
  ok('soft hyphens and odd spaces go', X.clean('in­deed  now\t') === 'indeed now');
  const txt = '# The Book\n\nChapter 1\nThe first para-\ngraph runs on.\n\nSecond paragraph.\n\nCHAPTER TWO\n\nIn the end.';
  const tp = X.fromText(txt);
  ok('text: headings and paragraphs', JSON.stringify(tp.map((p) => [p.h, p.t])) === JSON.stringify([[1, 'The Book'], [2, 'Chapter 1'], [0, 'The first paragraph runs on.'], [0, 'Second paragraph.'], [2, 'CHAPTER TWO'], [0, 'In the end.']]), JSON.stringify(tp));
  ok('text with no blank lines: one paragraph per line', X.fromText('One.\nTwo.\nThree.').length === 3);
  ok('a sentence is not a heading', X.headingLike('This is a sentence.') === 0 && X.headingLike('Chapter 12') === 2 && X.headingLike('XIV') === 2);

  console.log('\nPDF');
  const it = (str, x, y, size = 10) => ({ str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5 });
  const page = (n, lines) => X.pdfPage({ items: [it('THE GREAT BOOK', 200, 760, 8), ...lines, it(String(n), 300, 30, 8)] }, 792);
  const pages = [
    page(1, [it('Chapter One', 72, 700, 18), it('It was a bright cold day in April, and the clocks were strik-', 72, 660), it('ing thirteen. Winston hurried home.', 72, 648), it('A new paragraph starts here after a gap.', 90, 620)]),
    page(2, [it('it carries on from the last page, as one paragraph.', 72, 700), it('Chapter Two', 72, 640, 18), it('The second chapter begins.', 72, 600)]),
    page(3, [it('Its last line.', 72, 700)]),
  ];
  const pp = X.fromPdf(pages);
  ok('running heads and page numbers are left out', !pp.some((p) => /GREAT BOOK/.test(p.t) || /^\d+$/.test(p.t)), JSON.stringify(pp.map((p) => p.t)));
  ok('the bigger type is a heading', pp[0].h > 0 && pp[0].t === 'Chapter One' && pp.some((p) => p.h && p.t === 'Chapter Two'));
  ok('lines join, the broken word is whole again', pp[1].t === 'It was a bright cold day in April, and the clocks were striking thirteen. Winston hurried home.', pp[1] && pp[1].t);
  ok('an indented line starts a paragraph, and it runs on over the page', pp[2].t === 'A new paragraph starts here after a gap. it carries on from the last page, as one paragraph.', pp[2] && pp[2].t);
  ok('paragraphs know their page', pp[0].pg === 1 && pp.find((p) => p.t === 'Chapter Two').pg === 2);
  const toc = X.outlineToToc(pp, [{ title: 'Chapter One', page: 1, depth: 0 }, { title: 'Chapter Two', page: 2, depth: 0 }]);
  ok('a PDF outline points at its headings', toc.length === 2 && pp[toc[0].at].t === 'Chapter One' && pp[toc[1].at].t === 'Chapter Two');
  ok('…and finds the chapters', X.detect(pp, { toc }).how === 'contents' && X.detect(pp, { toc }).starts.length === 2);

  console.log('\nWord');
  const docx = { 'word/document.xml': '<w:document><w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>My Notes</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Part one</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">Dharma &amp; duty, </w:t></w:r><w:del><w:r><w:t>deleted</w:t></w:r></w:del><w:r><w:tab/><w:t>said Kṛṣṇa.</w:t></w:r></w:p>' +
    '<w:p/>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Part two</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>The end.</w:t></w:r></w:p></w:body></w:document>',
  'docProps/core.xml': '<cp:coreProperties><dc:title>My Notes</dc:title><dc:creator>Tony</dc:creator></cp:coreProperties>' };
  const dx = X.fromDocx(docx);
  ok('Word: title, headings, text with entities and tabs; tracked deletions left out', dx.paras[0].ttl === true && JSON.stringify(dx.paras.map((p) => [p.h, p.t])) === JSON.stringify([[1, 'My Notes'], [1, 'Part one'], [0, 'Dharma & duty, said Kṛṣṇa.'], [1, 'Part two'], [0, 'The end.']]), JSON.stringify(dx.paras));
  ok('Word: its title and author', dx.title === 'My Notes' && dx.author === 'Tony');
  const dd = X.detect(dx.paras);
  ok('Word: chapters at the repeated heading level, the book title not one', dd.how === 'headings' && dd.starts.map((s) => s.title).join('|') === 'Part one|Part two', JSON.stringify(dd));

  console.log('\nEPUB');
  const { JSDOM } = require('jsdom');
  const parseXml = (s) => new (new JSDOM('').window.DOMParser)().parseFromString(s, 'application/xhtml+xml');
  const xhtml = (body) => '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>x</title></head><body>' + body + '</body></html>';
  const epub = {
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    'OEBPS/content.opf': '<package><metadata><dc:title>The Small Book</dc:title><dc:creator>A. Writer</dc:creator></metadata><manifest>' +
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/one.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/two.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
    'OEBPS/nav.xhtml': xhtml('<nav epub:type="toc"><ol><li><a href="text/one.xhtml">One</a></li><li><a href="text/two.xhtml#s2">Two</a><ol><li><a href="text/two.xhtml#deep">Deeper</a></li></ol></li></ol></nav>'),
    'OEBPS/text/one.xhtml': xhtml('<h1>One</h1><p>First <i>words</i> here.</p><div><p>Nested paragraph.</p></div>'),
    'OEBPS/text/two.xhtml': xhtml('<p>Before the section.</p><section id="s2"><h2>Two</h2><p>Second chapter.</p><p id="deep">Deeper part.</p></section>'),
  };
  const ep = X.fromEpub(epub, parseXml);
  ok('EPUB: paragraphs in spine order, headings kept', JSON.stringify(ep.paras.map((p) => [p.h, p.t])) === JSON.stringify([[1, 'One'], [0, 'First words here.'], [0, 'Nested paragraph.'], [0, 'Before the section.'], [2, 'Two'], [0, 'Second chapter.'], [0, 'Deeper part.']]), JSON.stringify(ep.paras));
  ok('EPUB: title and author', ep.title === 'The Small Book' && ep.author === 'A. Writer');
  ok('EPUB: the nav points at the right paragraphs (file, and file#id)', ep.toc.length === 3 && ep.toc[0].at === 0 && ep.toc[1].at === 4 && ep.toc[2].at === 6 && ep.toc[2].depth === 1, JSON.stringify(ep.toc));
  const ed = X.detect(ep.paras, { toc: ep.toc });
  ok('EPUB: chapters from the top level of its contents', ed.how === 'contents' && ed.starts.map((s) => s.at).join() === '0,4');
  const epub2 = Object.assign({}, epub, { 'OEBPS/content.opf': epub['OEBPS/content.opf'].replace(' properties="nav"', '').replace('<spine>', '<spine toc="ncx">').replace('</manifest>', '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>'),
    'OEBPS/toc.ncx': '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="a"><navLabel><text>One</text></navLabel><content src="text/one.xhtml"/></navPoint><navPoint id="b"><navLabel><text>Two</text></navLabel><content src="text/two.xhtml#s2"/></navPoint></navMap></ncx>' });
  const ep2 = X.fromEpub(epub2, parseXml);
  ok('EPUB 2: the NCX works the same', ep2.toc.length === 2 && ep2.toc[1].at === 4, JSON.stringify(ep2.toc));

  console.log('\nChapters');
  const paras = [
    { t: 'Title Page', h: 0 }, { t: 'Copyright 2026', h: 0 },
    { t: 'Chapter 1: Beginnings', h: 0 }, { t: 'Once upon a time there was a reader who loved books.', h: 0 }, { t: 'She read every night.', h: 0 },
    { t: 'Chapter 2: The Middle', h: 0 }, { t: 'Things happened in the middle of the story.', h: 0 },
    { t: 'Chapter 3: The End', h: 0 }, { t: 'And then it ended well for everyone.', h: 0 },
  ];
  const dl = X.detect(paras);
  ok('"Chapter N" lines are found without AI', dl.how === 'chapter lines' && dl.starts.map((s) => s.at).join() === '2,5,7');
  ok('nothing to go on: one part', X.detect([{ t: 'just text', h: 0 }]).starts.length === 1);
  const parts = X.split(paras, dl.starts);
  ok('the pages before chapter 1 are a part of their own (nothing is lost)', parts.length === 4 && parts[0].front && parts[0].paras.length === 2);
  ok('every word is in the chapters, in order', X.sameWords(paras, parts));
  const ch = X.toChapter(1, 'Chapter 1: Beginnings', parts[1].paras);
  ok('a chapter file: its own title dropped, paragraphs as p blocks with no verse', ch.n === 1 && ch.blocks.length === 2 && ch.blocks[0].k === 'p' && ch.blocks[0].s[0].v === null && ch.blocks[0].s[0].t === paras[3].t);
  const hch = X.toChapter(2, 'Part one', [{ t: 'Part one', h: 1 }, { t: 'A section', h: 2 }, { t: 'Its text.', h: 0 }]);
  ok('headings inside a chapter are h blocks, so Study finds its sections', hch.blocks[0].k === 'h' && H.sectionsOf(hch).length === 1 && H.sectionsOf(hch)[0].title === 'A section');
  ok('Make with AI reads an imported chapter like the Gita\'s', G.sourceText(hch) === '## A section\n\nIts text.');
  ok('parasOf turns a chapter back into paragraphs', X.parasOf(hch).map((p) => p.t).join('|') === 'A section|Its text.');

  console.log('\nChapters by AI');
  const msgs = X.tocPrompt(paras, { title: 'Tale' });
  ok('the ask: numbered paragraph starts with headings marked, JSON only', /ONLY the JSON/.test(msgs[0].content) && /\n2 \| Chapter 1: Beginnings\n/.test(msgs[1].content) && /"anchor"/.test(msgs[1].content));
  const big = Array.from({ length: 4000 }, (_, i) => ({ t: (i % 500 === 0 ? 'Chapter ' + (i / 500 + 1) : 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua number ' + i + '.'), h: 0 }));
  const lst = X.tocListing(big);
  ok('a very long book sends its short lines and every 20th paragraph', lst.length <= 150000 && /\n500 \| Chapter 2\n/.test(lst) && !/\n501 \|/.test(lst));
  const rep = { title: 'Tale', author: 'Someone', chapters: [
    { title: 'Beginnings', start: 2, anchor: 'Chapter 1: Beginnings' },
    { title: 'The Middle', start: 3, anchor: 'Chapter 2: The Middle' },          // wrong number, right words
    { title: 'Invented', start: 8, anchor: 'Words that are nowhere in it' },      // not in the text
    { title: 'The End', anchor: 'chapter 3 the end' },                            // no number, folded words
  ] };
  const ct = X.checkToc(paras, rep);
  ok('a start whose first words match is kept', ct.starts[0].at === 2);
  ok('a wrong number is moved to where its first words really are', ct.starts[1].at === 5 && ct.moved >= 1);
  ok('a chapter whose words are not in the text is dropped', ct.dropped === 1 && !ct.starts.some((s) => s.title === 'Invented'));
  ok('…and one without a number is found by its words', ct.starts.length === 3 && ct.starts[2].at === 7, JSON.stringify(ct));
  ok('title and author come back', ct.title === 'Tale' && ct.author === 'Someone');
  ok('garbage in, nothing out', X.checkToc(paras, { chapters: [null, 5, { start: 99 }] }).starts.length === 0);

  console.log('\nTidy-up, held to typo level');
  ok('a broken word fixed: taken', X.tidyCheck('the cour age of Arjuna', 'the courage of Arjuna').ok);
  ok('a misread letter: taken', X.tidyCheck('Krishna spoke to Arjuua on the field', 'Krishna spoke to Arjuna on the field').ok);
  ok('a hyphen put right: taken', X.tidyCheck('self-realization is the goal here', 'selfrealization is the goal here').ok);
  ok('a word changed: refused', !X.tidyCheck('the warrior was afraid of the battle', 'the warrior was scared of the battle').ok);
  ok('a word added: refused', !X.tidyCheck('he went home', 'he quickly went home').ok);
  ok('a word removed: refused', !X.tidyCheck('he went home now', 'he went home').ok);
  ok('too many fixes in a short paragraph: refused', !X.tidyCheck('teh cat sat on teh mat wiht teh hat', 'the cat sat on the mat with the hat').ok);
  const runs = X.wordRuns('a b c d e', 'a x c d f');
  ok('the word diff finds each change', runs.length === 2 && runs[0].del[0] === 'b' && runs[0].ins[0] === 'x' && runs[1].del[0] === 'e' && runs[1].ins[0] === 'f', JSON.stringify(runs));
  const tparas = [{ t: 'the cour age was great', h: 0 }, { t: 'he went home', h: 0 }, { t: 'All is well.', h: 0 }];
  const at = X.applyTidy(tparas, { paragraphs: ['the courage was great', 'he quickly went home', 'All is well.'] });
  ok('applyTidy takes the typo fix and refuses the rewrite', at.taken === 1 && at.refused === 1 && at.paras[0].t === 'the courage was great' && at.paras[1].t === 'he went home');
  ok('a reply that loses paragraphs is refused whole', X.applyTidy(tparas, { paragraphs: ['x'] }).taken === 0);
  ok('the tidy ask forbids rewording', /never add or remove words/.test(X.tidyPrompt('T', tparas)[1].content));

  console.log('\nNames');
  ok('a title from a file name', X.titleFromName('the_gita-final (2).pdf') === 'The gita final');
  ok('file kinds', X.KIND('a.PDF') === 'pdf' && X.KIND('b.epub') === 'epub' && X.KIND('c.docx') === 'docx' && X.KIND('d.md') === 'text' && X.KIND('e.doc') === null);
  ok('book ids are not the Gita\'s, chapter files are chNN', /^u[a-z0-9]+$/.test(X.newBookId()) && X.fileOf(3) === 'ch03');

  console.log('\nOrder (each person\'s own)');
  ok('arrange: the saved order, new items after in their own order', OR.arrange(['a', 'b', 'c', 'd'], (x) => x, ['c', 'a']).join('') === 'cabd');
  ok('arrange with nothing saved keeps the items as they are', OR.arrange([3, 1, 2], String, []).join('') === '312');
  ok('repeated keys are made unique', OR.uniq(['k', 'k', 'j', 'k']).join() === 'k,k~2,j,k~3');
  ok('move', OR.move([1, 2, 3, 4], 0, 2).join('') === '2314');
  ok('hashKey ignores case and punctuation', OR.hashKey('What is Dharma?') === OR.hashKey('what is dharma') && OR.hashKey('a') !== OR.hashKey('b'));

  console.log('\nBooks in Firestore');
  const ff = fakeFirestore();
  C._useFirebase({ db: {}, fs: ff });
  await C.boot();
  await new Promise((r) => setTimeout(r, 20));
  ok('both docs are loaded', C.me.loaded && C.shared.loaded);
  const pBig = 'ś'.repeat(400000) + '😀'.repeat(100000) + 'a'.repeat(300000);
  const cut = B.parts(pBig, 700000);
  const enc = (s) => Buffer.byteLength(s, 'utf8');
  ok('a big text is cut into parts under the limit, never inside a character', cut.length >= 3 && cut.every((x) => enc(x) <= 700000) && cut.join('') === pBig && cut.every((x) => !/[\uD800-\uDBFF]$/.test(x) && !/^[\uDC00-\uDFFF]/.test(x)), cut.map(enc).join());
  const id = X.newBookId();
  const chapters = [X.toChapter(1, 'One', [{ t: 'Alpha text.', h: 0 }]), X.toChapter(2, 'Two', [{ t: 'Beta ' + 'word '.repeat(200000), h: 0 }])];
  const book = { id, title: 'My Book', author: '', unit: 'Chapter', chapters: [{ n: 1, title: 'One', file: 'ch01', words: 2 }, { n: 2, title: 'Two', file: 'ch02', words: 200001 }], words: 200003, src: { name: 'x.txt', kind: 'text' } };
  const steps = [];
  await B.save('mine', book, chapters, { onStep: (i, n) => steps.push(i + '/' + n) });
  ok('saving writes each chapter, then the book into the person\'s doc', steps.join() === '1/2,2/2' && C.me.get('books.' + id + '.title') === 'My Book' && !C.shared.get('books.' + id, null));
  ok('each chapter is its own document beside the doc', ff.docs.has('dashboards/shruti/texts/' + id + '_ch01') && ff.docs.has('dashboards/shruti/texts/' + id + '_ch02'));
  ok('a book of Mine is personal: its media goes to the person\'s doc', M.docFor(id) === C.me);
  ok('it is listed in Mine', B.list().mine.some((b) => b.id === id) && B.whereOf(id) === 'mine');
  const sharedId = X.newBookId();
  await B.save('shared', Object.assign({}, book, { id: sharedId, title: 'Ours' }), chapters.slice(0, 1).concat([X.toChapter(2, 'Two', [{ t: 'Gamma.', h: 0 }])]));
  ok('a Shared book goes to the shared doc and its texts beside it', C.shared.get('books.' + sharedId + '.title') === 'Ours' && ff.docs.has('dashboards/shruti_shared/texts/' + sharedId + '_ch01') && M.docFor(sharedId) === C.shared);
  // Read back with an empty cache (another device).
  const B2 = await import(pathToFileURL(path.join(DIR, 'books.js')).href + '?fresh');
  const back = await B2.chapter(id, 'ch02');
  ok('a chapter reads back exactly, from its parts', JSON.stringify(back) === JSON.stringify(chapters[1]) && ff.docs.has('dashboards/shruti/texts/' + id + '_ch02~1') === (B.parts(JSON.stringify(chapters[1])).length > 1));
  const gb = await B.get(id);
  ok('get() gives the book like a book.json, with where it lives', gb.title === 'My Book' && gb.where === 'mine' && gb.chapters.length === 2);
  let missing = null; try { await B.get('unope'); } catch (e) { missing = e.message; }
  ok('an unknown book says so', /not in your library/.test(missing || ''));
  B.rename(id, { title: '  New name ', author: 'Me' });
  ok('rename', C.me.get('books.' + id + '.title') === 'New name' && C.me.get('books.' + id + '.author') === 'Me');
  C.me.set({ ['sets.' + id + '.s1']: { id: 's1', kinds: {} }, ['versions.' + id + '.ch1.lessons.v1']: { id: 'v1' } }, { now: true });
  await B.remove(id);
  await new Promise((r) => setTimeout(r, 1300));
  ok('delete takes the book, its texts and what was made for it', !C.me.get('books.' + id, null) && !ff.docs.has('dashboards/shruti/texts/' + id + '_ch01') && !ff.docs.has('dashboards/shruti/texts/' + id + '_ch02') && !C.me.get('sets.' + id, null) && !C.me.get('versions.' + id, null));
  ok('…and it is no longer personal', M.docFor(id) === C.shared);

  console.log('\nStudy items in each person\'s order');
  const cards = [{ front: 'A?' }, { front: 'B?' }, { front: 'C?' }];
  const o1 = U.ordered('gita', 'ch4', 'flashcards', cards);
  ok('no order saved: the set\'s own', o1.items.map((c) => c.front).join('') === 'A?B?C?' && o1.orig.join() === '0,1,2');
  U.saveOrder('gita', 'ch4', 'flashcards', [o1.keys[2], o1.keys[0], o1.keys[1]]);
  const o2 = U.ordered('gita', 'ch4', 'flashcards', cards);
  ok('a saved order is the person\'s, in their doc', o2.items.map((c) => c.front).join('') === 'C?A?B?' && o2.orig.join() === '2,0,1' && Array.isArray(C.me.get('order.items.gita.ch4.flashcards')));
  ok('…and never touches the shared doc', !C.shared.get('order', null));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
