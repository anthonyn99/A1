// Notebook extraction baseline (docs/Notebook/plan.md, Phase 0).
//
// The proof that pulling MyJournal, Brainstorm Journal and OurJournal out of
// index.html into Notebook/ changed NOTHING Tony or Veda can see or sync. One
// scripted session per journal is recorded twice, once from a pinned "before"
// checkout and once from this working copy, and the two recordings must match:
//
//   - every Firestore write (path, op, payload), from a fake in-memory
//     Firestore (tests/live/fake-firebase.js), with the real merge semantics
//   - every request to the lock and AI workers (bodies)
//   - every localStorage key the session leaves, and the journal caches' content
//   - per step: the sidebar rows, the open entry (title, html, tags), the sync
//     pill, the lock overlay, which elements are visible, the box of each key
//     element and its computed font/colours
//   - screenshots (desktop, tablet, phone) compared byte for byte
//
// The session, for MyJournal (Tony) and Brainstorm Journal (Veda) alike:
//   open from the "server" -> open an entry -> edit + type -> add a tag ->
//   search -> new page -> trash it (confirm dialog) -> restore it -> another
//   device renames an entry -> set a lock (hint prompt) -> lock re-shows on
//   return, wrong then right password -> AI Format (worker mocked) ->
//   OurJournal tab: new shared page + type -> back -> reload restores
//
// Run (one command does it all):
//   node tests/live/notebook-baseline.live.js            before = tag notebook-p0
//   node tests/live/notebook-baseline.live.js --ref HEAD before = any git ref
// It checks the ref out into a temp git worktree, records it, records this
// working copy, then diffs. Exit 1 on any difference. Pieces:
//   ... capture <label>           record the checkout cdp.js serves (A1_ROOT)
//   ... compare <labelA> <labelB> diff two recordings
// Recordings and shots go to the OS temp dir (cdp.js SHOTS), never the repo.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const ORIGIN = 'https://anthonyn99.github.io';
const BASE = ORIGIN + '/A1/';
const OUT = path.join(os.tmpdir(), 'magi-live-shots');
const recFile = (label) => path.join(OUT, `nb-${label}.json`);
const shotFile = (label, name) => path.join(OUT, `nb-${label}-${name}.png`);

// ── the two journals ────────────────────────────────────────────────────────
const T0 = 1791540000000;   // the fixed clock every run starts from (2026-10-09)
const entry = (id, title, html, extra) => Object.assign({ id, title, template: 'page', created: T0 - 86400000, updated: T0 - 3600000,
  tags: [], data: { html, attachments: [] }, rev: 1 }, extra || {});
const SEED_ENTRIES = [
  entry('e_1791000000001_alpha00001', 'Alpha plan', '<h2>Alpha</h2><p>First <strong>bold</strong> line with a <a href="https://example.com">link</a>.</p><ul><li>one</li><li>two</li></ul>', { tags: ['work', 'ideas'] }),
  entry('e_1791000000002_bravo00002', 'Bravo notes', '<p>Bravo body text.</p><p>Second paragraph.</p>'),
  entry('e_1791000000003_charl00003', 'Charlie', '<p>Charlie keeps <em>italics</em>.</p>', { tags: ['ideas'] }),
  entry('e_1791000000004_trash00004', 'Old trashed', '<p>gone</p>', { trashed: T0 - 7200000, trashChangedAt: T0 - 7200000 }),
];
function seedDoc() {
  const d = { _order: SEED_ENTRIES.map((e) => e.id), activeId: SEED_ENTRIES[0].id, savedAt: T0 - 3600000 };
  for (const e of SEED_ENTRIES) d['e_' + e.id] = e;
  return d;
}
const JOURNALS = [
  { key: 'tj', who: 'tony', doc: 'dashboards/tony_journal', cache: 'tony_journal_v3', open: "window._tonyNav('brainstormjournal')" },
  { key: 'bj', who: 'veda', doc: 'dashboards/journal', cache: 'brainstorm_journal_v3', open: "window._vedaNav('journal')" },
];
// Elements whose box and look are recorded at every step (when present).
const PROBES = ['root', 'sidebar', 'entries-list', 'search-box', 'new-entry-btn', 'main', 'toolbar', 'entry-title-input',
  'btn-edit', 'btn-lock', 'tags-row', 'sync-pill', 'page-toolbar', 'page-editor', 'page-editor-wrap', 'lock-overlay', 'empty-state'];

// ── worker mocks (recorded) ─────────────────────────────────────────────────
const workerLog = [];
function workerMock() {
  const AUTH = 'https://taskhub-reminders.av1.workers.dev/auth/journal/';
  const AI = 'https://personal-ai.av1.workers.dev/journal/format';
  return {
    patterns: [AUTH + '*', AI + '*'],
    handle(req) {
      if (req.method === 'OPTIONS') return { status: 204, text: '' };
      let body = null; try { body = JSON.parse(req.postData || 'null'); } catch (e) { body = req.postData || null; }
      if (req.url.startsWith(AUTH)) {
        const op = req.url.slice(AUTH.length);
        workerLog.push({ url: req.url, body });
        if (op === 'verify') return { json: body && body.password === 'pw-right' ? { ok: true } : { ok: false } };
        return { json: { ok: true } };
      }
      if (req.url.startsWith(AI)) {
        workerLog.push({ url: req.url, body: body && { profile: body.profile, hasPrompt: !!body.prompt, text: body.text } });
        return { json: { ok: true, html: '<h3>Formatted</h3><p>Formatted <strong>body</strong>.</p>' } };
      }
      return null;
    },
  };
}

// ── page-side helpers (injected) ────────────────────────────────────────────
// A fixed clock (real time, shifted so every run starts at T0) and a seeded
// Math.random, before any page script runs: ids, dates and "updated" labels
// come out the same in both recordings.
const DETERMINISM = (shift) => `(() => {
  const SHIFT = ${shift};
  const RD = Date; const now = () => RD.now() - SHIFT;
  function D(...a) { return a.length ? new RD(...a) : new RD(now()); }
  D.prototype = RD.prototype; D.now = now; D.parse = RD.parse; D.UTC = RD.UTC;
  window.Date = D;
  let s = 0x9e3779b9;
  Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e9) / 1e9; };
  const st = document.createElement('style');
  st.textContent = '*{caret-color:transparent!important;animation-duration:0s!important;transition:none!important}';
  document.addEventListener('DOMContentLoaded', () => document.head.appendChild(st));
})();`;

const SNAP = (key, probes) => `return (() => {
  const K = ${JSON.stringify(key)};
  const $ = (id) => document.getElementById(K + '-' + id);
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const root = $('root');
  const box = {};
  for (const p of ${JSON.stringify(probes)}) {
    const el = $(p); if (!el) { box[p] = null; continue; }
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    box[p] = vis(el) ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      font: cs.fontFamily + ' ' + cs.fontSize + ' ' + cs.fontWeight, color: cs.color, bg: cs.backgroundColor, border: cs.borderTopColor } : 'hidden';
  }
  const rows = [...document.querySelectorAll('#' + K + '-entries-list .entry-item')].map((r) => ({ id: r.dataset.entryId, active: r.classList.contains('active'), text: r.innerText.replace(/\\s+/g, ' ').trim() }));
  const visibleIds = root ? [...root.querySelectorAll('[id]')].filter(vis).map((e) => e.id).sort() : [];
  const ed = $('page-editor');
  const tags = [...document.querySelectorAll('#' + K + '-tags-row .tag-chip, #' + K + '-tags-row [class*=tag]')].map((t) => t.innerText.trim()).filter(Boolean);
  const ojTabs = [...document.querySelectorAll('#' + K + '-root .oj-tab')].map((b) => b.getAttribute('data-oj') + (b.classList.contains('on') ? '*' : ''));
  return JSON.stringify({ rows, visibleIds, box, ojTabs,
    title: ($('entry-title-input') || {}).value, html: ed ? ed.innerHTML : null, editable: ed ? ed.getAttribute('contenteditable') : null,
    tags, sync: ($('sync-text') || $('sync-pill') || {}).innerText || null, modeLabel: ($('mode-label') || {}).innerText || null,
    lockShown: vis($('lock-overlay')), lockErr: ($('lock-err') || {}).innerText || '' });
})()`;

// ── normalisation ───────────────────────────────────────────────────────────
// Clock values become T±seconds from the run's own start (the clock is fixed,
// so these agree unless the code times things differently), and generated ids
// become ID1, ID2... by first appearance, so an extra Math.random() call in
// new code cannot fake a difference.
function normalise(rec) {
  const ids = new Map();
  const s = JSON.stringify(rec)
    .replace(/\b(1[789]\d{11})_([a-z0-9]{5,})\b/g, (m) => { if (!ids.has(m)) ids.set(m, 'ID' + (ids.size + 1)); return ids.get(m); })
    .replace(/\b(1[789]\d{11})\b/g, (m) => { const d = Math.round((+m - T0) / 1000); return d >= -604800 && d <= 86400 ? 'T' : m; });
  return JSON.parse(s);
}

// ── capture ─────────────────────────────────────────────────────────────────
async function capture(label) {
  const { connect, evalJs, sleep } = require('./cdp.js');
  const { firebaseMock } = require('./fake-firebase.js');
  process.env.CDP_ALLOW_FONTS = '1';
  const c = await connect({ mock: firebaseMock(workerMock()) });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: DETERMINISM(Date.now() - T0) });
  const js = (e) => evalJs(c, e);
  const rec = { label, journals: {} };

  async function size(w, h) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
    await c.send('Emulation.setTouchEmulationEnabled', { enabled: w < 700, maxTouchPoints: w < 700 ? 5 : 0 });
    await sleep(500);
  }
  async function shot(name) {
    await sleep(300);
    const r = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shotFile(label, name), Buffer.from(r.result.data, 'base64'));
  }
  async function boot(J, fresh) {
    if (fresh) {
      await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
      await c.send('Page.navigate', { url: BASE + 'LifeHub/lifehub.js' }); await sleep(500);   // a same-origin page that runs nothing
      await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash', '${J.who}');
        sessionStorage.setItem('__fakefs_docs', JSON.stringify({ '${J.doc}': ${JSON.stringify(seedDoc())} })); 1`);
    }
    await c.send('Page.navigate', { url: BASE + 'index.html' });
    await sleep(9000);   // babel compiles the TaskHubs in-page
    await js(`var l=document.getElementById('th-boot-loader'); if(l) l.remove(); ${J.open}; 1`);
    await sleep(2500);
  }
  const click = async (sel) => {
    const ok = await js(`var el=document.querySelector(${JSON.stringify(sel)}); if(!el) return false;
      var r=el.getBoundingClientRect(), o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0};
      el.dispatchEvent(new MouseEvent('mousedown',o)); el.dispatchEvent(new MouseEvent('mouseup',o)); el.click(); return true;`);
    await sleep(500);
    return ok;
  };
  const type = async (text) => { await c.send('Input.insertText', { text }); await sleep(200); };
  const key = async (k, code) => {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: code || k, windowsVirtualKeyCode: k === 'Enter' ? 13 : 0 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code || k, windowsVirtualKeyCode: k === 'Enter' ? 13 : 0 });
    await sleep(200);
  };
  const caretEnd = (K) => js(`var e=document.getElementById('${K}-page-editor'); e.focus(); var r=document.createRange(); r.selectNodeContents(e); r.collapse(false);
    var s=getSelection(); s.removeAllRanges(); s.addRange(r); 1`);

  for (const J of JOURNALS) {
    const K = J.key;
    const steps = [];
    let logMark = 0, workerMark = workerLog.length;
    const step = async (name, opts) => {
      await sleep((opts && opts.wait) || 2600);   // autosave debounce + Firebase debounce
      const snap = JSON.parse(await js(SNAP(K, PROBES)));
      const writes = JSON.parse(await js(`return JSON.stringify(__fakeFs.log.slice(${logMark}).filter(l => /journal|ourjournal/.test(l.path)));`));
      logMark = await js('return __fakeFs.log.length;');
      const reqs = workerLog.slice(workerMark); workerMark = workerLog.length;
      steps.push({ name, snap, writes, reqs });
      if (opts && opts.shot) await shot(K + '-' + name);
    };
    console.log(`\n[${label}] ${J.who}: ${K}`);
    await size(1440, 900);
    await boot(J, true);
    await step('open', { shot: true });

    await click(`#${K}-entries-list .entry-item[data-entry-id="${SEED_ENTRIES[1].id}"] .entry-item-title`);
    await step('open-entry');

    await click(`#${K}-btn-edit`);
    await caretEnd(K); await type(' Typed by the baseline.');
    await step('edit-type', { shot: true });

    await js(`document.getElementById('${K}-add-tag-input').focus(); 1`);
    await type('baseline'); await key('Enter');
    await step('add-tag');

    await js(`var s=document.getElementById('${K}-search-box'); s.value='char'; s.dispatchEvent(new Event('input',{bubbles:true})); 1`);
    await step('search', { wait: 800 });
    await js(`var s=document.getElementById('${K}-search-box'); s.value=''; s.dispatchEvent(new Event('input',{bubbles:true})); 1`);

    await click(`#${K}-new-entry-btn`);
    await click(`#${K}-root .template-card[data-template="page"]`);
    await caretEnd(K); await type('Fresh page line');
    await step('new-page', { shot: true });

    const newId = await js(`return (document.querySelector('#${K}-entries-list .entry-item.active')||{dataset:{}}).dataset.entryId || null;`);
    await click(`#${K}-entries-list .entry-item.active .entry-delete`);
    await click('#uim-ok');
    await step('trash');

    await js(`window._${K}TrashAPI.restore([${JSON.stringify(newId)}]); 1`);
    await step('restore');

    await js(`__fakeFs.remote('${J.doc}', { 'e_${SEED_ENTRIES[2].id}': Object.assign(${JSON.stringify(SEED_ENTRIES[2])}, { title: 'Charlie renamed elsewhere', updated: Date.now(), rev: 5 }), savedAt: Date.now() }, { merge: true }); 1`);
    await step('remote-rename');

    await click(`#${K}-entries-list .entry-item[data-entry-id="${SEED_ENTRIES[0].id}"] .entry-item-title`);
    await click(`#${K}-btn-lock`);
    await step('lock-dialog', { wait: 600, shot: true });
    await js(`var p=document.getElementById('${K}-lock-pw'); p.focus(); p.value='pw-right'; 1`);
    await click(`#${K}-lock-submit`);
    await sleep(600);
    await click('#uim-ok');   // the optional hint prompt
    await step('lock-set');

    await click(`#${K}-entries-list .entry-item[data-entry-id="${SEED_ENTRIES[1].id}"] .entry-item-title`);
    await js(`localStorage.removeItem('${K}_unlocked_${SEED_ENTRIES[0].id}'); sessionStorage.clear(); ['${K}_unlocked_','${K}_unlockedv_','${K}_unlockedat_'].forEach(p=>{Object.keys(localStorage).filter(k=>k.startsWith(p)).forEach(k=>localStorage.removeItem(k)); Object.keys(sessionStorage).filter(k=>k.startsWith(p)).forEach(k=>sessionStorage.removeItem(k));}); 1`);
    await click(`#${K}-entries-list .entry-item[data-entry-id="${SEED_ENTRIES[0].id}"] .entry-item-title`);
    await step('locked-again', { wait: 800, shot: true });
    await js(`var p=document.getElementById('${K}-lock-pw'); p.value='pw-wrong'; 1`);
    await click(`#${K}-lock-submit`);
    await step('wrong-pw', { wait: 800 });
    await js(`var p=document.getElementById('${K}-lock-pw'); p.value='pw-right'; 1`);
    await click(`#${K}-lock-submit`);
    await step('right-pw');

    await click(`#${K}-entries-list .entry-item[data-entry-id="${SEED_ENTRIES[2].id}"] .entry-item-title`);
    if (!(await js(`return document.getElementById('${K}-page-editor').getAttribute('contenteditable')==='true';`))) await click(`#${K}-btn-edit`);
    await click(`#${K}-root .docx-ai-btn`);
    await sleep(800);
    const veil = async () => js("return !!document.querySelector('.docx-ai-veil');");
    for (let i = 0; i < 20 && await veil(); i++) await sleep(500);
    await step('ai-format', { shot: true });

    const ojOk = await click(`#${K}-root .oj-tab[data-oj="1"]`);
    await step('oj-enter', { wait: 1500, shot: true });
    if (ojOk) {
      await click(`#${K}-new-entry-btn`);
      await click(`#${K}-root .template-card[data-template="page"]`);
      await caretEnd(K); await type('Shared line');
      await step('oj-new-page');
      await click(`#${K}-root .oj-tab[data-oj="0"]`);
      await step('oj-leave', { wait: 1500 });
    }

    for (const [w, h, n] of [[1024, 768, 'tablet'], [390, 844, 'phone']]) {
      await size(w, h); await step('size-' + n, { wait: 800, shot: true });
    }
    await size(1440, 900);

    await boot(J, false);
    await step('reload', { shot: true });

    const store = JSON.parse(await js(`return JSON.stringify({
      fs: Object.fromEntries(Object.entries(__fakeFs.docs).filter(([p]) => /journal|ourjournal/.test(p))),
      lsKeys: Object.keys(localStorage).sort(),
      cache: JSON.parse(localStorage.getItem('${J.cache}') || 'null'),
      ssKeys: Object.keys(sessionStorage).filter(k => k !== '__fakefs_docs').sort() });`));
    rec.journals[K] = { steps, store };
  }
  rec.pageErrors = errs;
  fs.writeFileSync(recFile(label), JSON.stringify(normalise(rec), null, 1));
  console.log(`\nrecorded ${recFile(label)}  (${errs.length} page errors)`);
  c.ws.close();
}

// ── compare ─────────────────────────────────────────────────────────────────
function diff(a, b, at, out) {
  if (out.length > 60) return;
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diff(a[k], b[k], at + (Array.isArray(a) ? `[${k}]` : '.' + k), out);
    return;
  }
  out.push(`${at}\n      before: ${JSON.stringify(a)?.slice(0, 300)}\n      after:  ${JSON.stringify(b)?.slice(0, 300)}`);
}
function compare(la, lb) {
  const A = JSON.parse(fs.readFileSync(recFile(la), 'utf8'));
  const B = JSON.parse(fs.readFileSync(recFile(lb), 'utf8'));
  let fail = 0;
  for (const K of Object.keys(A.journals)) {
    const out = [];
    diff(A.journals[K], B.journals[K], K, out);
    console.log(out.length ? `  FAIL ${K}: ${out.length} difference(s)\n    ` + out.join('\n    ') : `  ok   ${K}: writes, requests, storage and every step match`);
    if (out.length) fail++;
  }
  const shots = fs.readdirSync(OUT).filter((f) => f.startsWith(`nb-${la}-`) && f.endsWith('.png'));
  const bad = shots.filter((f) => {
    const g = path.join(OUT, f.replace(`nb-${la}-`, `nb-${lb}-`));
    return !fs.existsSync(g) || !fs.readFileSync(g).equals(fs.readFileSync(path.join(OUT, f)));
  });
  console.log(bad.length ? `  FAIL screenshots differ: ${bad.join(', ')}\n       (in ${OUT})` : `  ok   ${shots.length} screenshots identical`);
  if (bad.length) fail++;
  const newErr = B.pageErrors.filter((e) => !A.pageErrors.includes(e));
  console.log(newErr.length ? `  FAIL new page errors: ${newErr.join(' | ')}` : `  ok   no new page errors (${B.pageErrors.length} known)`);
  if (newErr.length) fail++;
  return fail;
}

// ── orchestration ───────────────────────────────────────────────────────────
function run(args, env) {
  const r = spawnSync(process.execPath, [__filename, ...args], { stdio: 'inherit', env: Object.assign({}, process.env, env || {}) });
  if (r.status !== 0) throw new Error(`${args.join(' ')} exited ${r.status}`);
}
async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'capture') return capture(a || 'run');
  if (cmd === 'compare') return process.exit(compare(a, b) ? 1 : 0);
  const ri = process.argv.indexOf('--ref');
  const ref = ri > 0 ? process.argv[ri + 1] : 'notebook-p0';
  const wt = path.join(os.tmpdir(), 'notebook-baseline-wt');
  spawnSync('git', ['-C', REPO, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' });
  const add = spawnSync('git', ['-C', REPO, 'worktree', 'add', '--detach', wt, ref], { encoding: 'utf8' });
  if (add.status !== 0) { console.error(add.stderr); process.exit(2); }
  try {
    console.log(`before = ${ref} (${wt})`);
    run(['capture', 'before'], { A1_ROOT: wt });
    run(['capture', 'after']);
  } finally {
    spawnSync('git', ['-C', REPO, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' });
  }
  console.log('\nCompare');
  process.exit(compare('before', 'after') ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
