#!/usr/bin/env node
/**
 * Veda's TaskHub AI task prep: the page side (index.html, VD-PREP block,
 * Veda's Modal, rows and the Firestore kit store).
 *
 * WHY THIS FILE EXISTS
 * - A kit is rebuilt only when its sig changes. If the sig missed a field, an
 *   edited note would keep serving the old draft. If it changed on every
 *   render, the free-tier key would be drained re-prepping the same task.
 * - The ✨ click must open the assistant tab BEFORE any shieldopen: navigation.
 *   A click buys one tab, and the protocol dialog ends the gesture.
 * - Veda's Modal rebuilds the item on save. If the AI fields were missing from
 *   any branch, editing a task would silently unflag it.
 * - This is Veda's side only. Tony's Modal and rows must never get it.
 *
 * Run: node tests/taskprep-page.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  ✗ ' + name); }
}
function section(s) { console.log('\n' + s); }

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const b = html.indexOf('VD-PREP-BEGIN'), e = html.indexOf('<!-- VD-PREP-END -->');
const block = html.slice(b, e);
const js = block.slice(block.indexOf('<script>') + 8, block.lastIndexOf('</script>'));

function sandbox(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.ls || {});
  const events = [];
  const order = [];
  const ctx = {
    console: { warn() {}, log() {} },
    Date, JSON, Promise, encodeURIComponent, setTimeout, clearTimeout,
    navigator: { userAgent: opts.ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    location: {},
    fetch: opts.fetch || (() => Promise.reject(new Error('no network'))),
  };
  ctx.window = ctx;
  ctx.dispatchEvent = ev => events.push(ev);
  ctx.open = (url) => { order.push('open:' + url); return null; };
  Object.defineProperty(ctx.location, 'href', { set: v => order.push('nav:' + v), get: () => '' });
  vm.createContext(ctx);
  vm.runInContext(js, ctx);
  return { W: ctx, events, order, store };
}

section('block');
t('helper block is present', b > 0 && e > b && js.includes('_vdPrepLaunch'));

section('sig');
{
  const { W } = sandbox();
  const base = { id: 'a1', title: 'Email Kim', aiPrep: true, aiNote: 'kim@ksu.edu', type: 'task' };
  const s0 = W._vdPrepSig(base, '2026-10-04');
  t('stable for the same task', s0 === W._vdPrepSig(Object.assign({}, base), '2026-10-04'));
  t('changes with the title', s0 !== W._vdPrepSig(Object.assign({}, base, { title: 'Email Lee' }), '2026-10-04'));
  t('changes with the note', s0 !== W._vdPrepSig(Object.assign({}, base, { aiNote: 'lee@ksu.edu' }), '2026-10-04'));
  t('changes with the date', s0 !== W._vdPrepSig(base, '2026-10-05'));
  t('changes with the assistant', s0 !== W._vdPrepSig(Object.assign({}, base, { aiSite: 'claude' }), '2026-10-04'));
  t('ignores done and category', s0 === W._vdPrepSig(Object.assign({}, base, { done: true, category: 'study' }), '2026-10-04'));
}

section('assistant');
{
  const { W, store } = sandbox();
  t('default is Perplexity', W._vdPrepDefaultSite() === 'perplexity');
  W._vdPrepSetDefaultSite('chatgpt');
  t('default is remembered', store.vdAiSite === 'chatgpt' && W._vdPrepDefaultSite() === 'chatgpt');
  W._vdPrepSetDefaultSite('evil');
  t('unknown default is refused', W._vdPrepDefaultSite() === 'chatgpt');
  t('per-task choice wins', W._vdPrepSite({ aiSite: 'claude' }) === 'claude');
  t('bad per-task choice falls back', W._vdPrepSite({ aiSite: 'x' }) === 'chatgpt');
  const u = new URL(W._vdPrepAssistantUrl('perplexity', 'a & b\nc'));
  t('prompt is encoded into the query', u.hostname === 'www.perplexity.ai' && u.searchParams.get('q') === 'a & b\nc');
  t('chatgpt and claude urls', W._vdPrepAssistantUrl('chatgpt', 'x').startsWith('https://chatgpt.com/?q=') && W._vdPrepAssistantUrl('claude', 'x').startsWith('https://claude.ai/new?q='));
  const long = new URL(W._vdPrepAssistantUrl('claude', 'x'.repeat(9000)));
  t('long prompts are cut to 6000 chars', long.searchParams.get('q').length === 6000);
}

section('due and stale');
{
  const { W } = sandbox();
  const today = '2026-10-03', tom = '2026-10-04', yest = '2026-10-02';
  const data = {
    [yest]: [{ id: 'old', title: 'x', aiPrep: true }],
    [today]: [
      { id: 'a', title: 'Email Kim', aiPrep: true },
      { id: 'b', title: 'gym' },
      { id: 'c', title: 'done one', aiPrep: true, done: true },
      { id: 'd', title: 'mirrored', aiPrep: true, _sosId: 't_1' },
    ],
    [tom]: [{ id: 'e', title: 'Book dentist', aiPrep: true }],
    '2026-10-20': [{ id: 'f', title: 'later', aiPrep: true }],
  };
  const kits = { e: { sig: W._vdPrepSig(data[tom][0], tom) } };
  const due = W._vdPrepDue(data, today, tom, kits, Date.now()).map(x => x.item.id);
  t('only unflagged-free, unfinished, own tasks without a fresh kit', JSON.stringify(due) === '["a"]', JSON.stringify(due));
  const kits2 = { e: { sig: 'old' } };
  t('a stale kit is due again', W._vdPrepDue(data, today, tom, kits2, Date.now()).some(x => x.item.id === 'e'));
  const stale = W._vdPrepStale(data, { a: {}, old: {}, f: {}, gone: {}, b: {} }, yest).sort();
  t('stale = deleted or unflagged tasks; yesterday and future kept', JSON.stringify(stale) === '["b","gone"]', JSON.stringify(stale));
  t('days before yesterday are stale', W._vdPrepStale({ '2026-09-01': [{ id: 'z', aiPrep: true }] }, { z: {} }, yest).includes('z'));
}

section('request');
(async () => {
  {
    let sent = null;
    const saved = [];
    const { W, events } = sandbox({ fetch: (u, o) => { sent = { u, body: JSON.parse(o.body) }; return Promise.resolve({ json: () => Promise.resolve({ ok: true, kit: { prompt: 'P', sites: [], apps: [], draft: { kind: 'none' } } }) }); } });
    W._fbSaveVdKit = (id, k) => saved.push([id, k]);
    W._vdPcApps = [{ id: 'w1', name: 'Word' }];
    const item = { id: 'a1', title: 'Email Kim', aiPrep: true, aiNote: 'n', aiSite: 'claude' };
    const kit = await W._vdPrepRequest(item, '2026-10-04');
    t('posts profile veda, the task, note, site and apps', sent && sent.u.endsWith('/taskhub/prep') && sent.body.profile === 'veda'
      && sent.body.task.title === 'Email Kim' && sent.body.task.date === '2026-10-04' && sent.body.note === 'n'
      && sent.body.site === 'claude' && sent.body.apps.length === 1, JSON.stringify(sent && sent.body));
    t('stores the kit with its sig', kit && kit.sig === W._vdPrepSig(item, '2026-10-04') && saved.length === 1 && saved[0][0] === 'a1');
    t('busy is cleared and the UI told', !W._vdPrepBusy.a1 && events.filter(x => x.type === 'vd-prep-update').length >= 2);
    t('a fresh kit is found', W._vdPrepKitFor(item, '2026-10-04').fresh === true);
    t('an edited task makes it stale', W._vdPrepKitFor(Object.assign({}, item, { title: 'Email Lee' }), '2026-10-04').fresh === false);
  }
  {
    let calls = 0;
    const { W } = sandbox({ fetch: () => { calls++; return Promise.resolve({ json: () => Promise.resolve({ ok: false, error: 'quota' }) }); } });
    const item = { id: 'b1', title: 'x', aiPrep: true };
    const r = await W._vdPrepRequest(item, '2026-10-03');
    t('a failed prep stores nothing', r === null && !W._vdPrepKits.b1);
    t('and is not retried for 10 minutes', W._vdPrepDue({ '2026-10-03': [item] }, '2026-10-03', '2026-10-04', {}, Date.now()).length === 0);
    t('but is after that', W._vdPrepDue({ '2026-10-03': [item] }, '2026-10-03', '2026-10-04', {}, Date.now() + 11 * 60 * 1000).length === 1);
    await W._vdPrepRequest({ id: 'bad.id', title: 'x' }, '2026-10-03');
    t('ids that are not safe field paths are never sent', calls === 1);
  }

  section('launch');
  {
    const { W, order, events } = sandbox();
    W._vdPcAppsAt = 1;
    const item = { id: 'a1', title: 'Email Kim', aiPrep: true };
    W._vdPrepKits.a1 = { sig: W._vdPrepSig(item, '2026-10-04'), prompt: 'THE PROMPT', sites: [{ label: 'G', url: 'https://x.com' }], apps: [] };
    W._vdPrepLaunch(item, '2026-10-04');
    t('assistant tab opens FIRST, then Shield', order.length === 2 && order[0].startsWith('open:https://www.perplexity.ai/search?q=THE%20PROMPT') && order[1] === 'nav:shieldopen:kit/a1', JSON.stringify(order));
    t('the panel is opened', events.some(x => x.type === 'vd-prep-open' && x.detail.id === 'a1'));
  }
  {
    const { W, order } = sandbox();
    const item = { id: 'a1', title: 'Email Kim', aiPrep: true };
    W._vdPrepKits.a1 = { sig: W._vdPrepSig(item, '2026-10-04'), prompt: 'P', sites: [{ label: 'G', url: 'https://x.com' }], apps: [] };
    W._vdPrepLaunch(item, '2026-10-04');
    t('no shieldopen until Shield has published her apps', order.length === 1 && order[0].startsWith('open:'), JSON.stringify(order));
  }
  {
    const { W, order } = sandbox({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
    W._vdPcAppsAt = 1;
    const item = { id: 'a1', title: 'Email Kim', aiPrep: true };
    W._vdPrepKits.a1 = { sig: W._vdPrepSig(item, '2026-10-04'), prompt: 'P', sites: [{ label: 'G', url: 'https://x.com' }], apps: [] };
    W._vdPrepLaunch(item, '2026-10-04');
    t('never on a phone', order.length === 1);
  }
  {
    let fetched = 0;
    const { W, order } = sandbox({ fetch: () => { fetched++; return new Promise(() => {}); } });
    W._vdPcAppsAt = 1;
    const item = { id: 'a1', title: 'Email Kim', aiPrep: true, aiNote: 'kim@ksu.edu' };
    W._vdPrepKits.a1 = { sig: 'stale', prompt: 'OLD PROMPT', sites: [{ label: 'G', url: 'https://x.com' }], apps: [] };
    W._vdPrepLaunch(item, '2026-10-04');
    const q = new URL(order[0].slice(5)).searchParams.get('q');
    t('a stale kit is not used: fallback prompt from title + note', !q.includes('OLD PROMPT') && q.includes('Email Kim') && q.includes('kim@ksu.edu'), q);
    t('no shieldopen for a stale kit', order.length === 1);
    t('and a fresh prep starts', fetched === 1);
  }

  section('Veda Modal and rows (static)');
  {
    const vStart = html.indexOf('function Modal({open,onClose,onSave,initial,dateLabel,startDateKey}){');
    const vApp = html.indexOf('function App(){', vStart);
    const tonyApp = html.indexOf('function App(){');
    const vModal = html.slice(vStart, html.indexOf('function VdPrepPanel(', vStart));
    t('Veda Modal has the AI state', /const\[aiPrep,setAiPrep\]=useState\(false\)/.test(vModal));
    t('it is loaded from the item being edited', vModal.includes('setAiPrep(!!initial?.aiPrep);setAiNote(initial?.aiNote||"");setAiSite(initial?.aiSite||"")'));
    const builds = vModal.match(/\.\.\.aiF\}/g) || [];
    t('all three item builds carry the AI fields', builds.length === 3, 'found ' + builds.length);
    t('rows show ✨ only on her own flagged items', (html.slice(vApp).match(/!edit&&[te]\.aiPrep&&![te]\._sosId&&vdPrepBtn\([te],k\)/g) || []).length === 4);
    t('the panel is mounted', html.slice(vApp).includes('RC(VdPrepPanel,{'));
    // Tony's App up to the end of its render (the shared Firestore module
    // after it serves both sides and is checked separately below).
    const tony = html.slice(tonyApp, html.indexOf('ReactDOM.render(React.createElement(Root)', tonyApp));
    t("Tony's side has none of it", !/aiPrep|vdPrep|VdPrepPanel|_vdPrep/.test(tony));
    const tonyModal = html.slice(html.indexOf('function ItemModal('), html.indexOf('function ItemModal(') + 20000);
    t("Tony's ItemModal has none of it", !/aiPrep|aiNote/.test(tonyModal));
  }

  section('Firestore');
  {
    t('kits are written per field with merge', /setDoc\(vdPrepRef, \{ kits: \{ \[taskId\]: kit \}, savedAt: Date\.now\(\) \}, \{ merge: true \}\)/.test(html));
    t('kits are pruned with deleteField on safe ids only', html.includes('upd["kits." + id] = deleteField()') && html.includes("if (/^[A-Za-z0-9_-]+$/.test(id)) upd"));
    t('only a server read counts as loaded', html.includes('window._vdPrepKitsLoaded = window._vdPrepKitsLoaded || !(snap.metadata && snap.metadata.fromCache);'));
    t('both listeners are torn down', html.includes('if (_vdPrepUnsub)    { _vdPrepUnsub();    _vdPrepUnsub    = null; }') && html.includes('if (_vdPcAppsUnsub)  { _vdPcAppsUnsub();  _vdPcAppsUnsub  = null; }'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:\n  ' + failures.join('\n  ')); process.exit(1); }
})();
