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
// Clock values become T (the clock is fixed, so they only differ by how long a
// run took), and generated ids become ID1, ID2... by first appearance, so an
// extra Math.random() call or a slower step in new code cannot fake a
// difference. OurJournal's write tokens (w / pw, time-derived) become W1, W2...
function normalise(rec) {
  const ids = new Map(), toks = new Map();
  const ordinal = (map, prefix, m) => { if (!map.has(m)) map.set(m, prefix + (map.size + 1)); return map.get(m); };
  const isClock = (n) => n > 1.7e12 && n < 2e12 && Math.abs(n - T0) < 8 * 86400000;
  const str = (s) => s
    .replace(/(?<![0-9])1[789][0-9]{11}_[a-z0-9]{5,}/g, (m) => ordinal(ids, 'ID', m))
    .replace(/(?<![0-9])1[789][0-9]{11}(?![0-9])/g, (m) => (isClock(+m) ? 'T' : m));
  const walk = (v, key) => {
    if ((key === 'w' || key === 'pw') && typeof v === 'string' && v) return ordinal(toks, 'W', v);
    if (typeof v === 'number') return isClock(v) ? 'T' : v;
    if (typeof v === 'string') return str(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[str(k)] = walk(v[k], k); return o; }
    return v;
  };
  return walk(rec);
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
  // NB_INJECT: extra page script for this recording only, e.g. to prove the
  // comparison catches a change without editing the source (a monkeypatch).
  if (process.env.NB_INJECT) await c.send('Page.addScriptToEvaluateOnNewDocument', { source: process.env.NB_INJECT });
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
      // A1Backup's first-run passphrase dialog would sit over every other dialog,
      // and the daily sweep (TaskHub's, timing-dependent) would add stray writes.
      await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash', '${J.who}');
        localStorage.setItem('a1b_disabled', '1');
        var d = new Date(); localStorage.setItem('a1_sweep_day:index', d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2));
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
      // Settle: record only once two snapshots 700ms apart agree, so a status
      // that flips a moment later (the sync pill's SAVED -> SYNCED) cannot land
      // on different sides of the snapshot in two runs.
      let raw = await js(SNAP(K, PROBES));
      for (let i = 0; i < 9; i++) {
        await sleep(700);
        const again = await js(SNAP(K, PROBES));
        if (again === raw) break;
        raw = again;
      }
      const snap = JSON.parse(raw);
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

    // A device that never unlocked it: unlocks are remembered per device, so
    // forget this one's and reload.
    await js(`['${K}_unlocked_','${K}_unlockedv_','${K}_unlockedat_'].forEach(p => [localStorage, sessionStorage].forEach(st =>
      Object.keys(st).filter(k => k.startsWith(p)).forEach(k => st.removeItem(k)))); 1`);
    await boot(J, false);
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
    await js("var m=[...document.querySelectorAll('.docx-mi')].find(x=>x.innerText.trim()==='AI Format'); if(m) m.click(); 1");
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
      // Brainstorm has a second tab back to her own entries; MyJournal leaves
      // through its rail's Journal button.
      await click(K === 'tj' ? '#mjd-nav [data-sec]' : `#${K}-root .oj-tab[data-oj="0"]`);
      await step('oj-leave', { wait: 1500 });
    }

    for (const [w, h, n] of [[1024, 768, 'tablet'], [390, 844, 'phone']]) {
      await size(w, h); await step('size-' + n, { wait: 800, shot: true });
    }
    await size(1440, 900);

    await boot(J, false);
    await step('reload', { shot: true });

    // The lock fixes (Phase 2 for bj, Phase 3 for tj). Last, so a delete that
    // now works cannot change any step above. Change the password (to the same
    // one, so nothing depends on it), lock the entry on this device, then
    // delete it from the sidebar.
    const menuBtn = (text) => js(`var b=[...document.querySelectorAll('#${K}-lock-overlay button')].find(x=>x.innerText.trim()===${JSON.stringify(text)});
      if(!b) return false; b.click(); return true;`);
    const uim = (val) => js(`var o=document.getElementById('uim-overlay'); if(!o||!o.classList.contains('show')) return false;
      var i=document.querySelector('#uim-fields input'); if(i&&${JSON.stringify(val)}!==null) i.value=${JSON.stringify(val)};
      document.getElementById('uim-ok').click(); return true;`);
    await click(`#${K}-entries-list .entry-item[data-entry-id="${SEED_ENTRIES[0].id}"] .entry-item-title`);
    await click(`#${K}-btn-lock`);
    await menuBtn('Change password'); await sleep(400);
    await js(`var p=document.getElementById('${K}-lock-pw'); p.value='pw-right'; 1`);
    await click(`#${K}-lock-submit`); await sleep(800);
    await uim('pw-right'); await sleep(800);
    await step('change-pw');

    await click(`#${K}-btn-lock`);
    await menuBtn('Lock this entry now'); await sleep(400);
    await click(`#${K}-entries-list .entry-item[data-entry-id="${SEED_ENTRIES[0].id}"] .entry-delete`); await sleep(400);
    await uim('pw-right'); await sleep(800);   // the password prompt
    await uim(null); await sleep(400);         // "Delete …?"
    await step('locked-delete');

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
// Differences a phase makes ON PURPOSE (a bug fix changes what the user sees).
// Each rule names the phase and the fix, and matches the difference's path in
// the recording (e.g. /^tj\.steps\[\d+\]\.snap\.sync$/). Nothing else may differ.
// Screenshots a rule allows to differ go in `shots` (file-name regex).
const EXPECTED = [
  // Phase 2, Brainstorm lock fixes. Steps 21 and 22 are change-pw and locked-delete.
  { phase: 2, why: 'change password rotates in one set-lock call with current (was remove-lock, then set-lock)', path: /^bj\.steps\[21\]\.reqs/ },
  { phase: 2, why: 'deleting a locked entry works (it threw a ReferenceError and did nothing)', path: /^bj\.steps\[22\]\./ },
  { phase: 2, why: '...so the entry ends in the trash', path: /^bj\.store\.(fs\.dashboards\/journal\.(e_e_ID1\.(trashed|trashChangedAt|updated)|activeId|savedAt)|cache\.(entries\[\d+\]\.(trashed|trashChangedAt|updated)|activeId))$/ },
  // { phase: 3, why: 'sync pill no longer says "Saved" before any save', path: /^tj\.steps\[0\]\.snap\.sync$/, shots: /tj-open/ },
];
// Screenshots must match pixel for pixel, within this many levels per channel.
// Headless Chrome is not perfectly repeatable: two recordings of the SAME
// checkout differed by up to 2 levels on a few hundred pixels (the borders of
// Veda's nav buttons). Anything a real change makes — a moved box, a different
// colour or font — is far larger, and the per-step snapshots check computed
// colours exactly anyway.
const SHOT_TOLERANCE = 2;

// Minimal PNG decoder for Chrome's screenshots (8-bit RGB/RGBA, no interlace).
function pngPixels(buf) {
  const zlib = require('zlib');
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; if (data[8] !== 8 || data[12]) throw new Error('unsupported png'); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0; if (!bpp) throw new Error('unsupported png colour type ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, o = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[o + i - bpp] : 0, b = y ? px[o - stride + i] : 0, c = i >= bpp && y ? px[o - stride + i - bpp] : 0;
      let v = raw[src + i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[o + i] = v & 255;
    }
  }
  return { w, h, bpp, px };
}
function pngDiff(A, B) {
  const a = pngPixels(A), b = pngPixels(B);
  if (a.w !== b.w || a.h !== b.h || a.bpp !== b.bpp) return { n: Infinity, max: 255 };
  let n = 0, max = 0;
  for (let i = 0; i < a.px.length; i += a.bpp) {
    let m = 0; for (let k = 0; k < a.bpp; k++) m = Math.max(m, Math.abs(a.px[i + k] - b.px[i + k]));
    if (m) { n++; if (m > max) max = m; }
  }
  return { n, max };
}

function diff(a, b, at, out) {
  // Collect every difference: a cap here once let differences past the 60th
  // (the store, recorded last) pass unseen. Only the printing is capped.
  if (out.length > 20000) return;
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
    const head = (d) => d.split('\n')[0];
    const allowed = out.filter((d) => EXPECTED.some((r) => r.path && r.path.test(head(d))));
    const byRule = new Map();
    allowed.forEach((d) => { const r = EXPECTED.find((x) => x.path && x.path.test(head(d))); byRule.set(r, (byRule.get(r) || 0) + 1); });
    byRule.forEach((n, r) => console.log(`  expected (phase ${r.phase}, ${n} difference(s)): ${r.why}`));
    out.splice(0, out.length, ...out.filter((d) => !allowed.includes(d)));
    console.log(out.length ? `  FAIL ${K}: ${out.length} difference(s)\n    ` + out.slice(0, 60).join('\n    ') + (out.length > 60 ? `\n    ... and ${out.length - 60} more` : '') : `  ok   ${K}: writes, requests, storage and every step match`);
    if (out.length) fail++;
  }
  const shots = fs.readdirSync(OUT).filter((f) => f.startsWith(`nb-${la}-`) && f.endsWith('.png'));
  const near = [];
  const bad = shots.filter((f) => !EXPECTED.some((r) => r.shots && r.shots.test(f))).filter((f) => {
    const g = path.join(OUT, f.replace(`nb-${la}-`, `nb-${lb}-`));
    if (!fs.existsSync(g)) return true;
    const A = fs.readFileSync(path.join(OUT, f)), B = fs.readFileSync(g);
    if (A.equals(B)) return false;
    const d = pngDiff(A, B);
    if (d.max <= SHOT_TOLERANCE) { near.push(`${f} (${d.n} px within ±${d.max})`); return false; }
    return true;
  });
  near.forEach((s) => console.log('  near ' + s));
  console.log(bad.length ? `  FAIL screenshots differ: ${bad.join(', ')}\n       (in ${OUT})` : `  ok   ${shots.length} screenshots identical (±${SHOT_TOLERANCE})`);
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
