// Import a book (Phase 8): a PDF, EPUB, Word file, text file or pasted text.
//   1. the text is read here, in the browser (pdf.js for PDF, JSZip for EPUB
//      and Word), as paragraphs (extract.js);
//   2. chapters are found from the file's own contents or headings, or by AI
//      through Orca (a table of contents with exact start anchors), and the
//      text is cut there deterministically: no word is ever retyped;
//   3. an optional tidy-up by AI is taken only where it stays at typo level;
//   4. the review screen: rename, merge, split, leave out, drag into order;
//   5. saved to Mine (only this person) or Shared (both), books.js; the
//      original goes to Drive too when Drive is connected.

import * as C from './core.js';
import * as O from './orca.js';
import * as G from './generate.js';
import * as M from './media.js';
import * as B from './books.js';
import * as X from './extract.js';
import * as OR from './order.js';

export const PDFJS = '../V1/vendor/pdfjs-6.3.289/';            // A1's vendored pdf.js (README "Moving Shruti")
export const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
const TIDY_MAX = 40000;   // characters: longer chapters are not sent for a tidy-up

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const I = (b) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + b + '</svg>';
const IC = {
  x: I('<path d="M6 6l12 12M18 6L6 18"/>'),
  upload: I('<path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>'),
  split: I('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>'),
  merge: I('<path d="M7 4v5a5 5 0 0 0 5 5h0a5 5 0 0 1 5 5v1"/><path d="M17 4v5a5 5 0 0 1-5 5"/><path d="M14 18l3 3 3-3"/>'),
  eye: I('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: I('<path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.1 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  spark: G.ICON,
  file: I('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'),
};

/* ── loading the readers ─────────────────────────────────────────────────── */
let pdfjsP = null, zipP = null;
function pdfjs() {
  if (!pdfjsP) pdfjsP = import(new URL(PDFJS + 'pdf.min.mjs', import.meta.url).href).then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL(PDFJS + 'pdf.worker.min.mjs', import.meta.url).href;
    return m;
  }).catch((e) => { pdfjsP = null; throw new Error('The PDF reader could not be loaded (' + (e.message || e) + ').'); });
  return pdfjsP;
}
function jszip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!zipP) zipP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = JSZIP_URL; s.async = true;
    s.onload = () => (window.JSZip ? res(window.JSZip) : rej(new Error('The EPUB and Word reader did not load.')));
    s.onerror = () => { zipP = null; rej(new Error('The EPUB and Word reader could not be loaded. Check the connection and try again.')); };
    document.head.appendChild(s);
  });
  return zipP;
}
async function unzip(file, want) {
  const Z = await jszip();
  const z = await Z.loadAsync(await file.arrayBuffer());
  const out = {};
  await Promise.all(Object.keys(z.files).filter((p) => !z.files[p].dir && want(p)).map(async (p) => { out[p] = await z.files[p].async('string'); }));
  return out;
}
function parseXml(s) {
  let d = new DOMParser().parseFromString(s, 'application/xhtml+xml');
  if (d.getElementsByTagName('parsererror').length) d = new DOMParser().parseFromString(s, 'text/html');
  return d;
}

/** A file -> {paras, toc, title, author, kind}. onStep(text) reports progress. */
export async function readFile(file, onStep = () => {}) {
  const kind = X.KIND(file.name, file.type);
  if (!kind) throw new Error('Shruti can import PDF, EPUB, Word (.docx) and text files. “' + file.name + '” is none of these.');
  const name = X.titleFromName(file.name);
  if (kind === 'text') { onStep('Reading the text…'); return { kind, paras: X.fromText(await file.text()), title: name }; }
  if (kind === 'docx') {
    onStep('Opening the Word file…');
    const r = X.fromDocx(await unzip(file, (p) => p === 'word/document.xml' || p === 'docProps/core.xml'));
    return { kind, paras: r.paras, title: r.title || name, author: r.author };
  }
  if (kind === 'epub') {
    onStep('Opening the EPUB…');
    const r = X.fromEpub(await unzip(file, (p) => /\.(x?html?|xml|opf|ncx)$/i.test(p) || p === 'META-INF/container.xml'), parseXml);
    return { kind, paras: r.paras, toc: r.toc, title: r.title || name, author: r.author };
  }
  onStep('Opening the PDF…');
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    pages.push(X.pdfPage(await p.getTextContent(), p.getViewport({ scale: 1 }).height));
    if (i % 5 === 0 || i === doc.numPages) onStep('Reading page ' + i + ' of ' + doc.numPages + '…');
  }
  const paras = X.fromPdf(pages);
  if (!paras.length) throw new Error('This PDF has no text in it (it may be scanned pages). Shruti cannot read scans yet.');
  let title = name, author = '';
  try { const m = await doc.getMetadata(); if (m && m.info) { title = X.clean(m.info.Title) || name; author = X.clean(m.info.Author); } } catch (e) {}
  let toc = [];
  try {
    const flat = [];
    const walk = async (items, depth) => {
      for (const it of items || []) {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await doc.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) {
          const page = typeof dest[0] === 'number' ? dest[0] + 1 : (await doc.getPageIndex(dest[0])) + 1;
          flat.push({ title: X.clean(it.title), page, depth });
        }
        if (it.items && it.items.length && depth < 2) await walk(it.items, depth + 1);
      }
    };
    await walk(await doc.getOutline(), 0);
    toc = X.outlineToToc(paras, flat);
  } catch (e) {}
  doc.destroy && doc.destroy();
  return { kind, paras, toc, title, author };
}

/* ── the sheet ───────────────────────────────────────────────────────────── */
let seq = 0;
const nid = () => 'c' + (++seq);
const keyOf = () => C.orcaKey();
const UNITS = ['Chapter', 'Part', 'Section'];

/** Open the Import sheet. go: the router's go(hash). */
/** where: the shelf it was opened from (Mine or Shared), the review's first choice. */
export function open({ go, where = 'mine', file = null, text = '' } = {}) {
  if (document.getElementById('imp-sheet')) return;
  const st = { step: 'source', file: null, paras: [], toc: null, title: '', author: '', chs: [], how: '', where: where === 'shared' ? 'shared' : 'mine', unit: 'Chapter', run: null, split: null, abort: null, tidy: null };
  const dim = document.createElement('div');
  dim.className = 'sheet-dim'; dim.id = 'imp-sheet';
  dim.innerHTML = '<aside class="sheet gen imp" role="dialog" aria-modal="true" aria-labelledby="imp-h"><div class="sh-h"><h2 id="imp-h">Import a book</h2><button class="ib" data-close aria-label="Close">' + IC.x + '</button></div><div id="imp-body"></div></aside>';
  document.body.appendChild(dim);
  const body = dim.querySelector('#imp-body');
  const busy = () => st.step === 'reading' || st.step === 'saving' || (st.run && !st.run.done && !st.run.error);
  const close = async () => {
    if (st.step === 'review' && st.chs.length && !(await window.uiConfirm('Close without saving this book?', { title: 'Import', okLabel: 'Close', cancelLabel: 'Keep going' }))) return;
    if (st.abort) st.abort.abort();
    dim.remove(); removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape' && !busy() && !document.querySelector('.ui-dim')) close(); };
  addEventListener('keydown', onKey);
  dim.addEventListener('click', (e) => { if ((e.target === dim || e.target.closest('[data-close]')) && !busy()) close(); });
  // A problem box's "Open Settings" (G.problemHTML): Settings opens over the sheet, which keeps the work.
  dim.addEventListener('click', (e) => { if (e.target.closest('[data-ai-settings]') && window.Shruti) window.Shruti.openSettings(); });

  const paint = () => {
    if (st.step === 'source') return paintSource();
    if (st.step === 'reading') { body.innerHTML = '<section class="card"><div class="stat busy"><i></i><span>' + esc(st.reading || 'Reading…') + '</span></div></section>'; return; }
    if (st.step === 'saving') { body.innerHTML = '<section class="card"><div class="stat busy"><i></i><span>' + esc(st.saving || 'Saving…') + '</span></div></section>'; return; }
    paintReview();
  };

  /* step 1: a file or pasted text */
  const paintSource = (err) => {
    body.innerHTML = '<p class="gen-sub">A PDF, EPUB, Word file or text. Its chapters are found for you; the text stays exactly as the book has it.</p>' +
      '<section class="card"><label class="imp-drop" id="imp-drop">' + IC.upload + '<b>Choose a file, or drop it here</b><span>PDF · EPUB · Word (.docx) · text (.txt, .md)</span>' +
      '<input type="file" id="imp-file" accept=".pdf,.epub,.docx,.txt,.md,.markdown,application/pdf,application/epub+zip,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"></label></section>' +
      '<section class="card"><h3>Or paste the text</h3><textarea id="imp-paste" rows="6" placeholder="Paste a book, an essay or notes. Blank lines separate paragraphs; lines like “Chapter 2” or “# Title” start chapters."></textarea>' +
      '<div class="gen-go"><button class="btn solid" id="imp-use">Use this text</button></div></section>' +
      (err ? '<div class="stat bad"><i></i><span>' + esc(err) + '</span></div>' : '');
    const inp = body.querySelector('#imp-file'), drop = body.querySelector('#imp-drop');
    inp.addEventListener('change', () => { if (inp.files && inp.files[0]) take(inp.files[0]); });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) take(f); });
    body.querySelector('#imp-use').addEventListener('click', () => {
      const t = body.querySelector('#imp-paste').value;
      const paras = X.fromText(t);
      if (!paras.length) { paintSource('Paste some text first.'); return; }
      const first = paras.find((p) => p.h);
      begin({ kind: 'paste', paras, title: first && first.h === 1 ? first.t : 'Pasted text' }, null);
    });
  };
  const take = async (file) => {
    st.step = 'reading'; st.reading = 'Opening “' + file.name + '”…'; paint();
    try {
      const r = await readFile(file, (t) => { st.reading = t; if (st.step === 'reading') paint(); });
      if (!dim.isConnected) return;
      begin(r, file);
    } catch (e) {
      st.step = 'source'; paintSource((e && e.message) || String(e));
    }
  };
  const begin = (r, file) => {
    st.file = file ? { name: file.name, kind: r.kind, size: file.size, blob: file } : null;
    st.paras = r.paras; st.toc = r.toc || null;
    st.title = r.title || 'Untitled'; st.author = r.author || '';
    useDetect();
    st.step = 'review'; paint();
  };
  const fromStarts = (starts) => X.split(st.paras, starts).map((c) => ({ id: nid(), title: c.title, paras: c.paras, skip: false }));
  const useDetect = () => {
    const d = X.detect(st.paras, { toc: st.toc });
    st.chs = fromStarts(d.starts);
    st.how = { contents: 'the file’s own contents', 'contents page': 'its contents page', headings: 'its headings', 'chapter lines': 'its “Chapter …” lines', none: 'nothing: it is one part for now' }[d.how];
    st.run = null;
  };

  /* step 2: review */
  const included = () => st.chs.filter((c) => !c.skip);
  const paintReview = () => {
    const words = X.wordCount(st.paras), inc = included();
    let n = 0;
    const row = (c, i) => {
      const num = c.skip ? '' : ++n, w = X.wordCount(c.paras), first = (c.paras.find((p) => !p.h) || c.paras[0] || { t: '' }).t;
      return '<div class="imp-ch' + (c.skip ? ' skip' : '') + '" data-dkey="' + c.id + '" title="' + esc(OR.HINT) + '" tabindex="0">' +
        '<span class="imp-n">' + num + '</span>' +
        '<div class="imp-main"><input class="imp-t" data-title="' + c.id + '" value="' + esc(c.title) + '" aria-label="Title" spellcheck="false">' +
        '<span class="imp-m">' + w.toLocaleString() + ' words · ' + c.paras.length + ' paragraph' + (c.paras.length === 1 ? '' : 's') + (first ? ' · “' + esc(first.slice(0, 70)) + (first.length > 70 ? '…' : '') + '”' : '') + '</span></div>' +
        '<div class="imp-acts">' +
        '<button class="ib sm" data-split="' + c.id + '" title="Split it" aria-label="Split it"' + (c.paras.length < 2 ? ' disabled' : '') + '>' + IC.split + '</button>' +
        '<button class="ib sm" data-merge="' + c.id + '" title="Merge with the next one" aria-label="Merge with the next one"' + (i === st.chs.length - 1 ? ' disabled' : '') + '>' + IC.merge + '</button>' +
        '<button class="ib sm" data-skip="' + c.id + '" title="' + (c.skip ? 'Put it back' : 'Leave it out (title pages, contents, index…)') + '" aria-label="' + (c.skip ? 'Put it back' : 'Leave it out') + '" aria-pressed="' + c.skip + '">' + (c.skip ? IC.eyeOff : IC.eye) + '</button></div>' +
        (st.split === c.id ? splitPanel(c) : '') + '</div>';
    };
    const R = st.run;
    body.innerHTML =
      '<section class="card"><div class="imp-src">' + IC.file + '<span><b>' + esc(st.file ? st.file.name : 'Pasted text') + '</b><span>' + words.toLocaleString() + ' words · ' + st.paras.length.toLocaleString() + ' paragraphs</span></span>' +
      '<button class="btn ghost sm" data-again>Another file</button></div>' +
      '<label class="gen-f"><span>Title</span><input id="imp-title" value="' + esc(st.title) + '" spellcheck="false"></label>' +
      '<label class="gen-f"><span>Author (optional)</span><input id="imp-author" value="' + esc(st.author) + '" spellcheck="false"></label></section>' +
      '<section class="card"><h3>' + inc.length + ' ' + esc(st.unit.toLowerCase()) + (inc.length === 1 ? '' : 's') + '<span class="gen-model">' + esc(R && R.done ? 'found by ' + G.modelName(R.model) : 'from ' + st.how) + '</span></h3>' +
      '<div class="chips"><button class="chip" data-ai>' + IC.spark + 'Find chapters with AI</button>' + (R && R.done ? '<button class="chip" data-detect>Use the file’s own</button>' : '') +
      '<button class="chip" data-tidy title="Fixes broken and run-together words only; any other change is refused">' + IC.spark + 'Tidy the text with AI</button></div>' +
      (R ? runHtml(R) : '') + (st.tidy ? tidyHtml(st.tidy) : '') +
      '<p class="hint">Rename, split, merge or leave out parts, and drag them into order. The text itself is never changed.</p>' +
      '<div class="imp-chs" id="imp-chs">' + st.chs.map(row).join('') + '</div></section>' +
      '<section class="card"><h3>Save</h3>' +
      '<div class="gen-f"><span>Where</span><div class="chips" role="radiogroup"><button class="chip' + (st.where === 'mine' ? ' on' : '') + '" role="radio" aria-checked="' + (st.where === 'mine') + '" data-where="mine">Mine (only ' + esc((C.PROFILES[C.P] || {}).label || 'me') + ')</button><button class="chip' + (st.where === 'shared' ? ' on' : '') + '" role="radio" aria-checked="' + (st.where === 'shared') + '" data-where="shared">Shared (both of you)</button></div></div>' +
      '<div class="gen-f"><span>Its parts are called</span><div class="chips" role="radiogroup">' + UNITS.map((u) => '<button class="chip' + (st.unit === u ? ' on' : '') + '" role="radio" aria-checked="' + (st.unit === u) + '" data-unit="' + u + '">' + u + 's</button>').join('') + '</div></div>' +
      '<div class="gen-go"><button class="btn solid" data-save' + (inc.length ? '' : ' disabled') + '>Save ' + inc.length + ' ' + esc(st.unit.toLowerCase()) + (inc.length === 1 ? '' : 's') + '</button><span class="hint" id="imp-save-msg"></span></div></section>';
    const pre = body.querySelector('.gen-live pre'); if (pre) pre.scrollTop = pre.scrollHeight;
    body.querySelector('#imp-title').addEventListener('input', (e) => { st.title = e.target.value; });
    body.querySelector('#imp-author').addEventListener('input', (e) => { st.author = e.target.value; });
    body.querySelector('[data-again]').addEventListener('click', async () => { if (await window.uiConfirm('Start again with another file?', { okLabel: 'Start again' })) { if (st.abort) st.abort.abort(); st.step = 'source'; st.chs = []; st.run = null; st.tidy = null; paint(); } });
    body.querySelector('[data-ai]').addEventListener('click', findWithAI);
    const dt = body.querySelector('[data-detect]'); if (dt) dt.addEventListener('click', () => { useDetect(); paint(); });
    body.querySelector('[data-tidy]').addEventListener('click', tidy);
    const cc = body.querySelector('[data-cancel-run]'); if (cc) cc.addEventListener('click', () => st.abort && st.abort.abort());
    body.querySelectorAll('[data-where]').forEach((b) => b.addEventListener('click', () => { st.where = b.dataset.where; paint(); }));
    body.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => { st.unit = b.dataset.unit; paint(); }));
    body.querySelectorAll('[data-title]').forEach((inp) => inp.addEventListener('input', () => { const c = st.chs.find((x) => x.id === inp.dataset.title); if (c) c.title = inp.value; }));
    body.querySelectorAll('[data-skip]').forEach((b) => b.addEventListener('click', () => { const c = st.chs.find((x) => x.id === b.dataset.skip); c.skip = !c.skip; paint(); }));
    body.querySelectorAll('[data-merge]').forEach((b) => b.addEventListener('click', () => {
      const i = st.chs.findIndex((x) => x.id === b.dataset.merge), a = st.chs[i], nx = st.chs[i + 1];
      if (!nx) return;
      st.chs.splice(i, 2, { id: nid(), title: a.title, paras: a.paras.concat(nx.paras), skip: a.skip && nx.skip });
      st.split = null; paint();
    }));
    body.querySelectorAll('[data-split]').forEach((b) => b.addEventListener('click', () => { st.split = st.split === b.dataset.split ? null : b.dataset.split; paint(); }));
    body.querySelectorAll('[data-at]').forEach((b) => b.addEventListener('click', () => {
      const i = st.chs.findIndex((x) => x.id === st.split), c = st.chs[i], at = Number(b.dataset.at);
      if (!c || !(at > 0 && at < c.paras.length)) return;
      const tail = c.paras.slice(at), head = tail[0];
      st.chs.splice(i, 1, { id: nid(), title: c.title, paras: c.paras.slice(0, at), skip: c.skip }, { id: nid(), title: head.h || head.t.length <= 80 ? head.t.slice(0, 80) : 'Untitled part', paras: tail, skip: c.skip });
      st.split = null; paint();
    }));
    body.querySelector('[data-save]').addEventListener('click', save);
    OR.sortable(body.querySelector('#imp-chs'), {
      row: '.imp-ch', ignore: '.imp-split',
      onMove(keys) { const by = new Map(st.chs.map((c) => [c.id, c])); st.chs = keys.map((k) => by.get(k)).filter(Boolean); paint(); },
    });
  };
  const splitPanel = (c) => '<div class="imp-split"><p class="hint">Start a new part at:</p><div class="imp-at">' +
    c.paras.slice(1, 601).map((p, j) => '<button data-at="' + (j + 1) + '" class="' + (p.h ? 'h' : '') + '">' + esc(p.t.slice(0, 90)) + (p.t.length > 90 ? '…' : '') + '</button>').join('') +
    (c.paras.length > 601 ? '<p class="hint">Only the first 600 paragraphs are listed: split again further on.</p>' : '') + '</div></div>';
  const runHtml = (R) => '<div class="imp-run">' +
    (R.done ? '<div class="stat good"><i></i><span>' + esc(R.done) + '</span></div>'
      : R.error ? G.problemHTML(R.error)
        : '<div class="stat busy"><i></i><span>' + esc((R.model ? G.modelName(R.model) + ' is reading the book' : 'Asking') + '…') + '</span><button class="btn ghost sm" data-cancel-run>Cancel</button></div>') +
    (R.stream ? '<details class="gen-live"' + (R.done || R.error ? '' : ' open') + '><summary>What ' + esc(G.modelName(R.model) || 'the unit') + ' wrote</summary><pre>' + esc(R.stream.slice(-4000)) + '</pre></details>' : '') + '</div>';
  const tidyHtml = (T) => '<div class="imp-run">' + (T.error ? G.problemHTML(T.error) : '<div class="stat ' + (T.doing ? 'busy' : 'good') + '"><i></i><span>' + esc(T.text) + '</span>' + (T.doing ? '<button class="btn ghost sm" data-cancel-run>Cancel</button>' : '') + '</div>') + '</div>';

  /** Nothing is sent when it cannot work: no key, a refused key, no unit allowed. */
  async function needKey() {
    const stop = await G.aiReady();
    if (!stop) return true;
    const goS = await window.uiConfirm(stop.text, { title: stop.title, okLabel: 'Open Settings' });
    if (goS && window.Shruti) window.Shruti.openSettings();
    return false;
  }
  async function findWithAI() {
    if (busy() || !(await needKey())) return;
    const R = st.run = { stream: '', model: null };
    st.abort = new AbortController();
    let t = 0;
    const repaint = (force) => { if (force || Date.now() - t > 200) { t = Date.now(); if (st.step === 'review' && dim.isConnected) paint(); } };
    repaint(true);
    try {
      const msgs = X.tocPrompt(st.paras, { title: st.title });
      msgs[1].content = G.spill(msgs[1].content);
      const r = await O.chat({ key: keyOf(), messages: msgs, models: O.chain(C.me.get('units', {}) || {}, O.cachedModels(keyOf())), signal: st.abort.signal,
        onDelta: (d) => { R.stream += d; repaint(); }, onModel: (m) => { R.model = m; repaint(true); } });
      R.model = r.model;
      const res = X.checkToc(st.paras, G.parseJSON(r.text));
      if (!res.starts.length) throw new Error(G.modelName(r.model) + '’s chapters could not be found in the text. Try again, or another unit.');
      st.chs = fromStarts(res.starts);
      if (res.title && (!st.title || st.title === 'Pasted text' || st.title === X.titleFromName(st.file && st.file.name))) st.title = res.title;
      if (res.author && !st.author) st.author = res.author;
      R.done = res.starts.length + ' found' + (res.moved ? ', ' + res.moved + ' moved to where their first words really are' : '') + (res.dropped ? ', ' + res.dropped + ' left out (their first words are not in the text)' : '') + '.';
    } catch (e) {
      R.error = O.explain(e);
      if (e && e.code === 'key') O.forget();
    }
    st.abort = null;
    repaint(true);
  }
  async function tidy() {
    if (busy() || (st.tidy && st.tidy.doing) || !(await needKey())) return;
    const todo = included().filter((c) => c.paras.reduce((n, p) => n + p.t.length, 0) <= TIDY_MAX);
    const long = included().length - todo.length;
    const T = st.tidy = { doing: true, text: 'Tidying 1 of ' + todo.length + '…', taken: 0, refused: 0 };
    st.abort = new AbortController();
    paint();
    let failed = 0;
    for (let i = 0; i < todo.length; i++) {
      if (st.abort.signal.aborted) break;
      const c = todo[i];
      T.text = 'Tidying ' + (i + 1) + ' of ' + todo.length + ': ' + c.title + '…'; paint();
      try {
        const msgs = X.tidyPrompt(c.title, c.paras);
        msgs[1].content = G.spill(msgs[1].content);
        const r = await O.chat({ key: keyOf(), messages: msgs, models: O.chain(C.me.get('units', {}) || {}, O.cachedModels(keyOf())), signal: st.abort.signal, temperature: 0 });
        const res = X.applyTidy(c.paras, G.parseJSON(r.text));
        c.paras = res.paras; T.taken += res.taken; T.refused += res.refused;
      } catch (e) {
        if (e && e.code === 'abort') break;
        if (e && (e.code === 'key' || e.code === 'none') && i === 0) { T.error = O.explain(e); if (e.code === 'key') O.forget(); break; }
        failed++;
      }
    }
    T.doing = false;
    if (!T.error) T.text = (st.abort && st.abort.signal.aborted ? 'Stopped. ' : '') + T.taken + ' paragraph' + (T.taken === 1 ? '' : 's') + ' fixed' + (T.refused ? ', ' + T.refused + ' change' + (T.refused === 1 ? '' : 's') + ' refused (more than a typo)' : '') + (failed ? ', ' + failed + ' part' + (failed === 1 ? '' : 's') + ' could not be asked' : '') + (long ? ', ' + long + ' long part' + (long === 1 ? '' : 's') + ' not sent' : '') + '.';
    st.abort = null;
    if (dim.isConnected) paint();
  }

  /* step 3: save */
  async function save() {
    const inc = included();
    if (!inc.length) return;
    const title = X.clean(st.title) || 'Untitled';
    const id = X.newBookId();
    const chapters = inc.map((c, i) => X.toChapter(i + 1, X.clean(c.title) || st.unit + ' ' + (i + 1), c.paras));
    const book = {
      id, title, author: X.clean(st.author), unit: st.unit,
      chapters: chapters.map((c, i) => ({ n: c.n, title: c.title, file: X.fileOf(c.n), words: X.wordCount(inc[i].paras) })),
      words: inc.reduce((n, c) => n + X.wordCount(c.paras), 0),
      src: st.file ? { name: st.file.name, kind: st.file.kind, size: st.file.size } : { name: 'pasted text', kind: 'paste' },
      how: st.run && st.run.done ? 'ai:' + st.run.model : 'file',
    };
    st.step = 'saving'; st.saving = 'Saving the text…'; paint();
    try {
      // The original goes to Drive first when Drive is there (never required):
      // a book of Mine to the person's own Drive, a shared one to Tony's.
      M.markPersonal(id, st.where === 'mine');
      if (st.file && keyOf() && await M.driveReady(id).catch(() => false)) {
        st.saving = 'Keeping the original in Drive…'; paint();
        try { const f = await M.upload({ book: id, chapter: 'source', body: st.file.blob, type: st.file.blob.type || 'application/octet-stream', name: st.file.name }); book.src.drive = { id: f.id, size: f.size, acct: f.acct }; } catch (e) { console.warn('Shruti import: original not kept in Drive', e); }
      }
      await B.save(st.where, book, chapters, { onStep: (i, n) => { st.saving = 'Saving ' + st.unit.toLowerCase() + ' ' + i + ' of ' + n + '…'; paint(); } });
      dim.remove(); removeEventListener('keydown', onKey);
      window.Shruti && window.Shruti.toast('“' + title + '” is in ' + (st.where === 'mine' ? 'your library' : 'the shared library'));
      if (go) go('#/b/' + id);
    } catch (e) {
      st.step = 'review'; paint();
      const m = body.querySelector('#imp-save-msg'); if (m) m.textContent = 'Could not save: ' + ((e && e.message) || e);
    }
  }

  // Dropped on the library (library.js dropImport): start with it at once.
  if (file) take(file);
  else if (text && text.trim()) {
    const paras = X.fromText(text);
    const first = paras.find((p) => p.h);
    if (paras.length) begin({ kind: 'paste', paras, title: first && first.h === 1 ? first.t : 'Dropped text' }, null);
  }
  paint();
  return { state: st, paint, take, begin };
}

/** Rename an imported book (its title and author). after() redraws. */
export function rename(b, after) {
  if (document.getElementById('imp-rename')) return;
  const dim = document.createElement('div');
  dim.className = 'sheet-dim'; dim.id = 'imp-rename';
  dim.style.cssText = 'justify-content:center;align-items:center;padding:16px';
  dim.innerHTML = '<div class="card" role="dialog" aria-modal="true" aria-labelledby="rn-h" style="max-width:420px;width:100%;margin:0;box-shadow:var(--sh2)"><h3 id="rn-h">Rename</h3>' +
    '<label class="gen-f"><span>Title</span><input id="rn-title" value="' + esc(b.title) + '" spellcheck="false"></label>' +
    '<label class="gen-f"><span>Author</span><input id="rn-author" value="' + esc(b.author || '') + '" spellcheck="false"></label>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button class="btn ghost" data-r="0">Cancel</button><button class="btn solid" data-r="1">Save</button></div></div>';
  const done = (yes) => {
    if (yes) { B.rename(b.id, { title: dim.querySelector('#rn-title').value, author: dim.querySelector('#rn-author').value }); if (after) after(); }
    dim.remove(); removeEventListener('keydown', key);
  };
  const key = (e) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
  dim.addEventListener('click', (e) => { const r = e.target.closest('[data-r]'); if (r) done(r.dataset.r === '1'); else if (e.target === dim) done(false); });
  addEventListener('keydown', key);
  document.body.appendChild(dim);
  dim.querySelector('#rn-title').select();
}
