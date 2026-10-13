#!/usr/bin/env node
/**
 * Veda's TaskHub AI task prep: the page side (index.html, VD-PREP block,
 * Veda's Modal, rows and the Firestore kit store).
 *
 * WHY THIS FILE EXISTS
 * - A kit is rebuilt only when its sig changes. If the sig missed a field, an
 *   edited note would keep serving the old draft. If it changed on every
 *   render, the free-tier key would be drained re-prepping the same task.
 * - The ✨ click must open the assistant tab first (a click buys one tab), and
 *   hand the kit's apps and sites to the StudyOS bridge, never to Shield.
 * - Veda's Modal rebuilds the item on save. If the AI fields were missing from
 *   any branch, editing a task would silently unflag it.
 * - Tony has the same feature (TH-PREP block, his ItemModal, rows and panel),
 *   built on his own docs, key, events and storage. TH-PREP is VD-PREP with
 *   comments removed and names moved to _th; this file rebuilds it that way
 *   and fails on any difference, so the two can never drift. Neither side may
 *   touch a single name of the other's.
 * - Both TaskHubs run on every device and share one PC bridge, so whose PC it
 *   is (td6_mainDash) decides whose app list it may publish.
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
    Date, JSON, Promise, encodeURIComponent, setTimeout, clearTimeout, AbortController,
    navigator: Object.assign({ userAgent: opts.ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      opts.perms ? { permissions: { query: ({ name }) => (name in opts.perms ? Promise.resolve({ state: opts.perms[name] }) : Promise.reject(new TypeError('unknown permission'))) } } : {}),
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
  vm.runInContext(opts.js || js, ctx);
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

  section('launch (StudyOS bridge, no Shield)');
  // fetch that records into the same order list as window.open, so the
  // assistant-tab-first rule is checked across both.
  const recFetch = (order, answer) => (u, o) => {
    order.push('fetch:' + (o && o.method || 'GET') + ' ' + u + (o && o.body ? ' ' + o.body : ''));
    return Promise.resolve({ json: () => Promise.resolve(answer || { ok: true, opened: [] }) });
  };
  {
    const order = [];
    const { W, events } = sandbox({ fetch: recFetch(order) });
    const origOpen = W.open; W.open = (u) => { order.push('open:' + u); return null; };
    const item = { id: 'a1', title: 'Email Kim', aiPrep: true };
    W._vdPrepKits.a1 = { sig: W._vdPrepSig(item, '2026-10-04'), prompt: 'THE PROMPT', sites: [{ label: 'G', url: 'https://x.com' }], apps: ['w1'] };
    W._vdPrepLaunch(item, '2026-10-04');
    await new Promise(r => setTimeout(r, 0));
    t('assistant tab opens FIRST, then the bridge gets the kit',
      order.length === 2 && order[0].startsWith('open:https://www.perplexity.ai/search?q=THE%20PROMPT')
      && order[1] === 'fetch:POST http://127.0.0.1:8781/api/launch {"apps":["w1"],"urls":["https://x.com"]}', JSON.stringify(order));
    t('the panel is opened', events.some(x => x.type === 'vd-prep-open' && x.detail.id === 'a1'));
    t('no shieldopen anywhere', !order.some(o => o.includes('shieldopen')));
    W.open = origOpen;
  }
  {
    const order = [];
    const { W } = sandbox({ fetch: recFetch(order), ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
    W.open = (u) => { order.push('open:' + u); return null; };
    const item = { id: 'a1', title: 'Email Kim', aiPrep: true };
    W._vdPrepKits.a1 = { sig: W._vdPrepSig(item, '2026-10-04'), prompt: 'P', sites: [{ label: 'G', url: 'https://x.com' }], apps: ['w1'] };
    W._vdPrepLaunch(item, '2026-10-04');
    await new Promise(r => setTimeout(r, 0));
    t('a phone never calls the bridge', order.length === 1 && order[0].startsWith('open:'), JSON.stringify(order));
  }
  {
    const order = [];
    const { W } = sandbox({ fetch: recFetch(order) });
    W.open = (u) => { order.push('open:' + u); return null; };
    const item = { id: 'a1', title: 'Email Kim', aiPrep: true };
    W._vdPrepKits.a1 = { sig: W._vdPrepSig(item, '2026-10-04'), prompt: 'P', sites: [], apps: [] };
    W._vdPrepLaunch(item, '2026-10-04');
    await new Promise(r => setTimeout(r, 0));
    t('a kit with nothing to open does not call the bridge', order.length === 1);
  }
  {
    const order = [];
    const { W } = sandbox({ fetch: (u, o) => { order.push('fetch:' + u); return new Promise(() => {}); } });
    W.open = (u) => { order.push('open:' + u); return null; };
    const item = { id: 'a1', title: 'Email Kim', aiPrep: true, aiNote: 'kim@ksu.edu' };
    W._vdPrepKits.a1 = { sig: 'stale', prompt: 'OLD PROMPT', sites: [{ label: 'G', url: 'https://x.com' }], apps: ['w1'] };
    W._vdPrepLaunch(item, '2026-10-04');
    const q = new URL(order[0].slice(5)).searchParams.get('q');
    t('a stale kit is not used: fallback prompt from title + note', !q.includes('OLD PROMPT') && q.includes('Email Kim') && q.includes('kim@ksu.edu'), q);
    t('a stale kit opens nothing on the PC, and a fresh prep starts',
      order.length === 2 && order[1].endsWith('/taskhub/prep'), JSON.stringify(order));
  }
  {
    const { W } = sandbox({ fetch: () => Promise.reject(new Error('ECONNREFUSED')) });
    W._vdBridgeUp = true;
    const r = await W._vdPrepOpenLocal(['w1'], []);
    t('bridge down: resolves null and marks it down', r === null && W._vdBridgeUp === false);
    t('no permission info: reported as not running', W._vdBridgeErr === 'down');
  }
  {
    // MEASURED: the real failure from github.io was LocalNetworkAccessPermissionDenied.
    const { W, events } = sandbox({ fetch: () => Promise.reject(new TypeError('Failed to fetch')), perms: { 'loopback-network': 'denied' } });
    await W._vdPrepOpenLocal([], ['https://studentaid.gov']);
    t('browser blocked loopback: reported as blocked, not as bridge down', W._vdBridgeErr === 'blocked');
    t('and the panel is told to repaint', events.some(x => x.type === 'vd-prep-update'));
  }
  {
    const { W } = sandbox({ fetch: () => Promise.reject(new TypeError('Failed to fetch')), perms: { 'local-network-access': 'denied' } });
    await W._vdPrepOpenLocal([], ['https://studentaid.gov']);
    t('older browsers: local-network-access is the fallback permission', W._vdBridgeErr === 'blocked');
  }
  {
    const { W } = sandbox({ fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, opened: ['x'] }) }) });
    W._vdBridgeErr = 'blocked';
    await W._vdPrepOpenLocal([], ['https://studentaid.gov']);
    t('a later success clears the error', W._vdBridgeErr === '' && W._vdBridgeUp === true);
  }

  {
    // Her report: the sites opened AFTER the assistant tab and buried it. With
    // the bridge up, the page opens NO tab; the bridge opens the assistant last.
    const order = [];
    const { W } = sandbox({ fetch: recFetch(order) });
    W.open = (u) => { order.push('open:' + u); return null; };
    W._vdBridgeUp = true;
    const item = { id: 'a1', title: 'FAFSA', aiPrep: true };
    W._vdPrepKits.a1 = { sig: W._vdPrepSig(item, '2026-10-04'), prompt: 'THE PROMPT', sites: [{ label: 'S', url: 'https://studentaid.gov/' }], apps: ['w1'] };
    W._vdPrepLaunch(item, '2026-10-04');
    await new Promise(r => setTimeout(r, 0));
    const body = order[0] && order[0].startsWith('fetch:POST') ? JSON.parse(order[0].slice(order[0].indexOf('{'))) : null;
    t('bridge up: the page opens no tab of its own', !order.some(o => o.startsWith('open:')), JSON.stringify(order));
    t('and hands the assistant to the bridge as focus (opened last)',
      body && body.focus === 'https://www.perplexity.ai/search?q=THE%20PROMPT' && body.urls[0] === 'https://studentaid.gov/' && body.apps[0] === 'w1', JSON.stringify(body));
  }
  {
    const order = [];
    const { W } = sandbox({ fetch: recFetch(order) });
    W.open = (u) => { order.push('open:' + u); return null; };
    W._vdBridgeUp = true;
    const item = { id: 'a1', title: 'gym', aiPrep: true };
    W._vdPrepKits.a1 = { sig: W._vdPrepSig(item, '2026-10-04'), prompt: 'P', sites: [], apps: [] };
    W._vdPrepLaunch(item, '2026-10-04');
    await new Promise(r => setTimeout(r, 0));
    t('bridge up but nothing else to open: the page just opens the assistant', order.length === 1 && order[0].startsWith('open:'), JSON.stringify(order));
  }

  section('bridge probe → veda_pc_apps');
  {
    const order = [];
    const writes = [];
    const { W } = sandbox({ fetch: recFetch(order, { ok: true, apps: [{ id: 'w1', name: 'Word' }, { id: 'z1', name: 'Zoom' }, { bad: 1 }] }) });
    W._fbSaveVdPcApps = a => writes.push(a);
    W._vdPcAppsLoaded = true;
    W._vdPcApps = [];
    const ok = await W._vdBridgeProbe();
    t('GETs /api/apps from the bridge', ok === true && order[0] === 'fetch:GET http://127.0.0.1:8781/api/apps', JSON.stringify(order));
    t('publishes names + ids only, junk dropped', writes.length === 1 && JSON.stringify(writes[0]) === '[{"id":"w1","name":"Word"},{"id":"z1","name":"Zoom"}]', JSON.stringify(writes));
    t('marks the bridge up', W._vdBridgeUp === true);
    await W._vdBridgeProbe();
    t('an unchanged list is not rewritten', writes.length === 1);
  }
  {
    const writes = [];
    const { W } = sandbox({ fetch: recFetch([], { ok: true, apps: [{ id: 'w1', name: 'Word' }] }) });
    W._fbSaveVdPcApps = a => writes.push(a);
    W._vdPcApps = [];
    await W._vdBridgeProbe();
    t('nothing is written before the server copy has loaded', writes.length === 0);
  }
  {
    let fetched = 0;
    const { W } = sandbox({ fetch: () => { fetched++; return Promise.resolve({ json: () => Promise.resolve({ ok: true, apps: [] }) }); }, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' });
    const ok = await W._vdBridgeProbe();
    t('only probed on Windows', ok === false && fetched === 0);
  }
  {
    const { W } = sandbox({ fetch: () => Promise.reject(new Error('ECONNREFUSED')) });
    W._vdBridgeUp = true;
    const ok = await W._vdBridgeProbe();
    t('bridge down: probe says so', ok === false && W._vdBridgeUp === false);
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
    t("Veda's side never names Tony's prep", !/_thPrep|_thBridge|_thPcApps|th-prep-|ThPrepPanel/.test(html.slice(vStart, html.indexOf('ReactDOM.render(RC(App)', vStart))));
  }

  section("Tony's Modal, rows and panel (static)");
  {
    // Tony's App up to the end of its render (the shared Firestore module
    // after it serves both sides and is checked separately below).
    const tonyApp = html.indexOf('function App(){');
    const tony = html.slice(tonyApp, html.indexOf('ReactDOM.render(React.createElement(Root)', tonyApp));
    t("Tony's App never names Veda's prep", !/vdPrep|VdPrepPanel|_vdPrep|_vdBridge|_vdPcApps|vd-prep-/.test(tony));
    const mS = html.indexOf('function ItemModal('), mE = html.indexOf('function PlanCheck(', mS);
    const tModal = html.slice(mS, mE);
    t("Tony's ItemModal has the AI state", /const\[aiPrep,setAiPrep\]=useState\(false\)/.test(tModal));
    t('it is loaded from the item being edited', tModal.includes('setAiPrep(!!initial?.aiPrep);setAiNote(initial?.aiNote||"");setAiSite(initial?.aiSite||"")'));
    t('all three item builds carry the AI fields', (tModal.match(/\.\.\.aiF,\n/g) || []).length === 3, 'found ' + (tModal.match(/\.\.\.aiF,\n/g) || []).length);
    t('a saved flagged task is prepped with Tony\'s request, never Veda\'s', tModal.includes('window._thPrepRequest(item,startDateKey)') && !/_vdPrep/.test(tModal));
    t('the panel is Tony\'s own', html.includes('function ThPrepPanel({item,dateKey,onClose,T})') && !/_vd/.test(html.slice(html.indexOf('function ThPrepPanel('), html.indexOf('function PlanCheck('))));
    t('rows show ✦ on his flagged items, both week layouts', (tony.match(/!edit&&[te]\.aiPrep&&![te]\._sosId&&thPrepBtn\([te],k\)/g) || []).length === 4);
    t('the panel is mounted', tony.includes('React.createElement(ThPrepPanel,{T,'));
    t('the background run reads Tony\'s data', tony.includes('window._thPrepRun(stateRef.current.data,'));
  }

  section('TH-PREP is VD-PREP, renamed (no drift)');
  const tb = html.indexOf('TH-PREP-BEGIN'), te = html.indexOf('<!-- TH-PREP-END -->');
  const tBlock = html.slice(tb, te);
  const thJs = tBlock.slice(tBlock.indexOf('<script>') + 8, tBlock.lastIndexOf('</script>'));
  {
    // The SAME transform that generated it. If VD-PREP changes, regenerate.
    const strip = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s+\/\/ .*$/, '')).join('\n');
    const toTony = (src) => src
      .replace(/_vd(Prep|Bridge|PcApps|CloudLoaded)/g, '_th$1')
      .replace(/_fb(Save|Drop)Vd/g, '_fb$1Th')
      .replace(/'vd-prep-/g, "'th-prep-")
      .replace(/'vdAiSite'/g, "'thAiSite'")
      .replace(/profile: 'veda'/g, "profile: 'tony'");
    t('the block is present, after VD-PREP', tb > e && te > tb);
    t('it equals VD-PREP renamed', thJs === toTony(strip(js)));
    t('not one Veda name in it', !/_vd|vd-prep|vdAiSite|'veda'|_fbSaveVd|_fbDropVd/.test(thJs));
  }
  {
    let sent = null;
    const saved = [];
    const { W, events, store } = sandbox({ js: thJs, fetch: (u, o) => { sent = { u, body: JSON.parse(o.body) }; return Promise.resolve({ json: () => Promise.resolve({ ok: true, kit: { prompt: 'P', sites: [], apps: [], draft: { kind: 'none' } } }) }); } });
    W._fbSaveThKit = (id, k) => saved.push([id, k]);
    W._fbSaveVdKit = () => saved.push(['VEDA']);
    W._thPcApps = [{ id: 't1', name: 'Excel' }];
    W._vdPcApps = [{ id: 'v1', name: 'HER APP' }];
    const item = { id: 'x1', title: 'Email the landlord', aiPrep: true, aiNote: 'n' };
    await W._thPrepRequest(item, '2026-10-14');
    t("Tony's request posts profile tony with his own app list", sent && sent.body.profile === 'tony' && JSON.stringify(sent.body.apps) === '[{"id":"t1","name":"Excel"}]', JSON.stringify(sent && sent.body));
    t('his kit goes to his store only', saved.length === 1 && saved[0][0] === 'x1');
    t('his events are th-prep-*', events.length && events.every((x) => /^th-prep-/.test(x.type)));
    t("Veda's globals are untouched", !W._vdPrepKits && !W._vdPrepBusy && JSON.stringify(W._vdPcApps) === '[{"id":"v1","name":"HER APP"}]');
    W._thPrepSetDefaultSite('claude');
    t('his default assistant is his own key', store.thAiSite === 'claude' && !('vdAiSite' in store));
  }

  section('bridge probe: no repaint loop, and whose PC it is');
  {
    // MEASURED before the fix: the App re-runs its prep effect on every
    // repaint, the probe ended every run with a repaint event, so the bridge
    // was asked every 3 seconds forever on every Windows PC.
    for (const [name, src, pfx] of [['Veda', js, 'vd'], ['Tony', thJs, 'th']]) {
      const { W, events } = sandbox({ js: src, fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, apps: [{ id: 'w1', name: 'Word' }] }) }) });
      const P = '_' + pfx, F = pfx === 'vd' ? 'Vd' : 'Th';
      W['_fbSave' + F + 'PcApps'] = () => {};
      W[P + 'PcAppsLoaded'] = true; W[P + 'PcApps'] = [];
      await W[P + 'BridgeProbe']();
      const n1 = events.length;
      await W[P + 'BridgeProbe']();
      t(name + ': a probe that changes nothing does not repaint', n1 === 1 && events.length === 1, n1 + ' then ' + events.length);
      const down = sandbox({ js: src, fetch: () => Promise.reject(new Error('ECONNREFUSED')) });
      await down.W[P + 'BridgeProbe']();
      const d1 = down.events.length;
      await down.W[P + 'BridgeProbe']();
      t(name + ': a bridge that stays down repaints once, not on every probe', d1 === 1 && down.events.length === 1, d1 + ' then ' + down.events.length);
      const refused = sandbox({ js: src, fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, apps: [{ id: 'w1', name: 'Word' }] }) }) });
      refused.W['_fbSave' + F + 'PcApps'] = () => false;
      refused.W[P + 'PcAppsLoaded'] = true; refused.W[P + 'PcApps'] = [];
      await refused.W[P + 'BridgeProbe']();
      t(name + ': a refused save (not their PC) keeps no app list either', refused.W[P + 'PcApps'].length === 0);
    }
  }
  {
    const fsStart = html.indexOf('// ── AI task prep kits (Veda)');
    const fsMod = html.slice(fsStart, html.indexOf('// ── Resilient write helpers', fsStart));
    t("Veda's app list is never published from Tony's PC", /window\._fbSaveVdPcApps = \(apps\) => \{\n\s+if \(_prepMainDash\(\) === "tony"\) return false;/.test(fsMod));
    t("Tony's only from a PC that is explicitly his", /window\._fbSaveThPcApps = \(apps\) => \{\n\s+if \(_prepMainDash\(\) !== "tony"\) return false;/.test(fsMod));
    t("Tony's kits and apps live in his own docs", fsMod.includes('doc(db, "dashboards/tony_taskprep")') && fsMod.includes('doc(db, "dashboards/tony_pc_apps")'));
    t('his kits are written per field with merge', fsMod.includes('setDoc(thPrepRef, { kits: { [taskId]: kit }, savedAt: Date.now() }, { merge: true })'));
    t("his writes never use Veda's refs", !/_fbSaveTh[\s\S]{0,200}vdP|_fbDropTh[\s\S]{0,300}vdPrepRef/.test(fsMod));
    t('both of his listeners are torn down', html.includes('if (_thPrepUnsub)    { _thPrepUnsub();    _thPrepUnsub    = null; }') && html.includes('if (_thPcAppsUnsub)  { _thPcAppsUnsub();  _thPcAppsUnsub  = null; }'));
  }

  section('"All future repeats" keeps the AI prep edit (both sides)');
  {
    t('Tony: repeating series', html.includes('const _ai=item.aiPrep?{aiPrep:true,aiNote:item.aiNote||"",aiSite:item.aiSite||""}:null;\n') && /if\(_ai\)Object\.assign\(nt,_ai\);else\{delete nt\.aiPrep;delete nt\.aiNote;delete nt\.aiSite;\}return nt;\}\);\n/.test(html));
    t('Veda: repeating series', /const _ai=item\.aiPrep\?\{aiPrep:true,aiNote:item\.aiNote\|\|"",aiSite:item\.aiSite\|\|""\}:null;Object\.keys\(next\)/.test(html));
    t('both: alternating sequences', (html.match(/notifyRepeatId:item\.notifyRepeatId,\s*aiPrep:item\.aiPrep\|\|undefined,/g) || []).length === 2);
  }

  section('Firestore');
  {
    t('no Shield anywhere in AI prep', !/shieldopen:kit|_vdPrepShieldReady/.test(html));
    t('kits are written per field with merge', /setDoc\(vdPrepRef, \{ kits: \{ \[taskId\]: kit \}, savedAt: Date\.now\(\) \}, \{ merge: true \}\)/.test(html));
    t('kits are pruned with deleteField on safe ids only', html.includes('upd["kits." + id] = deleteField()') && html.includes("if (/^[A-Za-z0-9_-]+$/.test(id)) upd"));
    t('only a server read counts as loaded', html.includes('window._vdPrepKitsLoaded = window._vdPrepKitsLoaded || !(snap.metadata && snap.metadata.fromCache);'));
    t('both listeners are torn down', html.includes('if (_vdPrepUnsub)    { _vdPrepUnsub();    _vdPrepUnsub    = null; }') && html.includes('if (_vdPcAppsUnsub)  { _vdPcAppsUnsub();  _vdPcAppsUnsub  = null; }'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:\n  ' + failures.join('\n  ')); process.exit(1); }
})();
