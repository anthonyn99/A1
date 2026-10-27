// Every program that mounts Notebook shows its editor exactly as MyJournal
// does in index.html (Tony, 2026-10-12: Everwell's ribbon had its selects
// stretched to full rows and the AI button grey). MyJournal is the standard:
// the same page is opened in edit mode in each host, and the editor's ribbon
// and title bar are compared to MyJournal's element by element:
//   - at rest: size, place (both ribbons laid out at the same width) and look
//   - under the cursor (:hover forced): background, border, colour, glow
//   - a real mouse over Bold, then a press: hoverfx's lift and sink
// Only what a host's mount config turns off may be missing (locks: the Lock
// button); the sync pill is left out, its colour is its state (idle/synced).
// A new host goes in HOSTS below.
//
// Run: node tests/live/notebook-look.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 1500) : '')); }
};
const ORIGIN = 'https://anthonyn99.github.io', BASE = ORIGIN + '/A1/';
const HTML = '<h2>Heading</h2><p>Some <strong>bold</strong> text.</p><ul><li>one</li></ul>';
const entry = (id, title) => ({ id, title, template: 'page', created: 1, updated: 1, tags: [], data: { html: HTML, attachments: [] }, rev: 1 });
const WIDTH = 1180;   // both ribbons are laid out at this width before measuring

const PROPS = ['width', 'height', 'padding', 'margin', 'font-size', 'font-family', 'font-weight', 'border', 'border-radius', 'background-color',
  'color', 'display', 'flex', 'line-height', 'box-shadow', 'min-height', 'min-width', 'max-width', 'gap', 'cursor', 'transition', 'opacity',
  'letter-spacing', 'text-transform', 'appearance', 'vertical-align', 'box-sizing', 'outline', 'align-items', 'justify-content', 'flex-wrap'];
// A snapshot of the subtree under `sel` (in #<K>-root): one row per element,
// keyed by its path with the key written as K and state classes dropped.
const SNAP = (K, sel) => `
  const tb = [...document.querySelectorAll(${JSON.stringify(sel)}.split('#K').join('#${K}'))].find(e => e.offsetParent);
  if (!tb) return 'null';
  const keep = [tb.style.width, tb.style.minWidth, tb.style.maxWidth];
  tb.style.width = tb.style.minWidth = tb.style.maxWidth = '${WIDTH}px';
  const base = tb.getBoundingClientRect(), out = [], P = ${JSON.stringify(PROPS)};
  const name = (c) => c.tagName.toLowerCase() + (typeof c.className === 'string' && c.className.trim()
    ? '.' + c.className.trim().split(/\\s+/).filter(k => !/sync-(idle|synced|saving|saved|error|offline|pending)$/.test(k)).join('.') : '')
    + (c.id ? '#' + c.id : '');
  const walk = (el, path) => [...el.children].forEach((c) => {
    const p = path + '/' + name(c), r = c.getBoundingClientRect(), s = getComputedStyle(c), st = {};
    P.forEach(k => st[k] = s.getPropertyValue(k));
    out.push({ p, box: [r.left - base.left, r.top - base.top, r.width, r.height].map(Math.round), st });
    walk(c, p);
  });
  const s = getComputedStyle(tb), st = {}; P.filter(k => !/width/.test(k)).forEach(k => st[k] = s.getPropertyValue(k));
  out.push({ p: 'ROOT', box: [0, 0, base.width, base.height].map(Math.round), st });
  walk(tb, '');
  [tb.style.width, tb.style.minWidth, tb.style.maxWidth] = keep;
  return JSON.stringify(out).split('${K}-').join('K-').split('#${K}').join('#K');`;

// opts.sizeOnly: compare sizes, not places (a bar a host's mount shortens);
// opts.flex: elements whose width is the room left over, not a size of their own.
function compare(a, b, allowMissing, opts) {
  opts = opts || {};
  const norm = (p) => p;
  const box = (o) => (opts.sizeOnly ? o.box.slice(2) : o.box).filter((v, i, all) => !(opts.flex && opts.flex.test(o.p) && i === all.length - 2)).join();
  const mb = new Map(); b.forEach((o) => { if (!mb.has(norm(o.p))) mb.set(norm(o.p), []); mb.get(norm(o.p)).push(o); });
  const seen = new Map(), diffs = [];
  for (const o of a) {
    const k = norm(o.p), i = seen.get(k) || 0; seen.set(k, i + 1);
    const x = (mb.get(k) || [])[i];
    if (allowMissing.some((re) => re.test(o.p))) continue;   // a host may hide or drop it
    if (!x) { diffs.push('missing ' + o.p); continue; }
    const d = [];
    const shown = o.st.display !== 'none' && (o.box[2] || o.box[3]);   // a closed menu's options measure 0x0 off-screen
    if (shown && box(o) !== box(x)) d.push('box ' + o.box + ' -> ' + x.box);
    for (const p in o.st) if (o.st[p] !== x.st[p] && !(p === 'width' && opts.flex && opts.flex.test(o.p))) d.push(p + ': ' + o.st[p] + ' -> ' + x.st[p]);
    if (d.length) diffs.push(o.p.slice(-90) + ' { ' + d.join('; ') + ' }');
  }
  for (const [k, arr] of mb) arr.slice(seen.get(k) || 0).forEach((o) => diffs.push('extra ' + o.p));
  return diffs;
}

// Forced :hover on every control in the ribbon and the title bar, then a real
// mouse over Bold and a press on it (hoverfx writes inline filter/translate).
async function hover(c, js, K) {
  const doc = await c.send('DOM.getDocument', { depth: -1 });
  const q = await c.send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId,
    selector: `#${K}-root .docx-toolbar button, #${K}-root .docx-toolbar select, #${K}-toolbar button` });
  const out = [];
  for (const nodeId of q.result.nodeIds) {
    await c.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] }); await sleep(220);   // past the .12s transitions
    const r = await c.send('DOM.resolveNode', { nodeId });
    const v = await c.send('Runtime.callFunctionOn', { objectId: r.result.object.objectId, returnByValue: true, functionDeclaration: `function(){
      if (!this.offsetParent) return null; const s = getComputedStyle(this);
      return [(this.tagName + '.' + this.className + '#' + this.id).split('${K}-').join('K-'),
        ['background-color', 'border-color', 'color', 'box-shadow', 'opacity', 'cursor'].map(k => k + '=' + s.getPropertyValue(k)).join(' | ')]; }` });
    await c.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    if (v.result.result.value) out.push(v.result.result.value);
  }
  const b = JSON.parse(await js(`const b = [...document.querySelectorAll('#${K}-root .docx-toolbar button')].find(x => x.offsetParent && x.textContent.trim() === 'B');
    const r = b.getBoundingClientRect(); return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2]);`));
  const at = `document.elementFromPoint(${b[0]}, ${b[1]}).closest('button')`;
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b[0], y: b[1] }); await sleep(300);
  out.push(['mouse over Bold', await js(`const b = ${at}; return b.style.filter + ' / ' + b.style.translate + ' / ' + getComputedStyle(b).boxShadow;`)]);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b[0], y: b[1], button: 'left', clickCount: 1 }); await sleep(150);
  out.push(['press on Bold', await js(`const b = ${at}; return b.style.filter + ' / ' + b.style.translate;`)]);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b[0], y: b[1], button: 'left', clickCount: 1 }); await sleep(150);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 }); await sleep(200);
  return out;
}

// Each host: how to reach its editor with the test page open in edit mode.
const HOSTS = [
  { name: 'Everwell', key: 'ewn', missing: [/#K-btn-lock/],
    async open(c, js, until) {
      await js(`localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/everwell_notes': { _order: ['prayer'], e_prayer: ${JSON.stringify(entry('prayer', 'Prayer'))} } })); return 1;`);
      await c.send('Page.navigate', { url: BASE + 'everwell.html' }); await sleep(2800);
      await js(`document.getElementById('ew-intro-overlay').click(); return 1;`); await sleep(1500);
      await js(`window.Notebook && 1; EWApp.go('prayer'); return 1;`); await sleep(800);
      await js(`const b = document.querySelector('#pray-note [data-note-edit], #pray-note [data-rd="edit"], [data-note-edit="prayer"]'); if (b) b.click(); return 1;`);
      return until(`document.querySelector('#ewn-root .docx-toolbar.edit-mode')`, 20000);
    } },
  { name: 'TradeHub Playbook', key: 'pb', missing: [/#K-btn-lock/],
    async open(c, js, until) {
      await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10));
        sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/tradehub_playbook': { _order: ['daily-reminder'], 'e_daily-reminder': ${JSON.stringify(entry('daily-reminder', 'Daily Reminder'))} } })); return 1;`);
      await c.send('Page.navigate', { url: BASE + 'tradehub.html' });
      if (!(await until(`document.querySelector('.tb-navtab')`, 15000))) return false;
      await sleep(2500);
      await js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="playbook"]')].find(b=>b.offsetParent); if(t) t.click(); return 1;`);
      if (!(await until(`document.querySelector('#pb-entries-list .entry-item')`, 20000))) return false;
      await js(`document.querySelector('#pb-entries-list .entry-item .entry-item-title').click(); return 1;`); await sleep(700);
      await js(`if (document.getElementById('pb-page-editor').getAttribute('contenteditable') !== 'true') document.getElementById('pb-btn-edit').click(); return 1;`);
      return until(`document.querySelector('#pb-root .docx-toolbar.edit-mode')`, 10000);
    } },
];

(async () => {
  const c = await connect({ mock: firebaseMock({ patterns: ['https://taskhub-reminders.av1.workers.dev/*', 'https://trade-dashboard.av1-2.workers.dev/*',
    'https://tradeboard-api.av1.workers.dev/*', 'https://newshub-api.av1.workers.dev/*'], handle: (r) => r.method === 'OPTIONS' ? { status: 204, text: '' } : { json: { ok: true } } }) });
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('DOM.enable'); await c.send('CSS.enable');
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 250; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(250); } return false; };
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  const fresh = async () => {
    await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
    await c.send('Page.navigate', { url: BASE + 'LifeHub/lifehub.js' }); await sleep(400);
  };
  const take = async (K) => ({
    ribbon: JSON.parse(await js(SNAP(K, '#K-root .docx-toolbar'))),
    bar: JSON.parse(await js(SNAP(K, '#K-toolbar'))),
    hover: await hover(c, js, K),
  });

  console.log('\nMyJournal (index.html): the standard');
  await fresh();
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','tony'); localStorage.setItem('a1b_disabled','1');
    var d = new Date(); localStorage.setItem('a1_sweep_day:index', d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2));
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/tony_journal': { _order: ['e_a'], activeId: 'e_a', savedAt: 1, e_e_a: ${JSON.stringify(entry('e_a', 'A'))} } })); return 1;`);
  await c.send('Page.navigate', { url: BASE + 'index.html' }); await sleep(3000);
  await until(`(function(){ var l=document.getElementById('th-boot-loader'); return !!window._profileGoTony && (!l || l.classList.contains('th-boot-hide')); })()`, 30000);
  await sleep(800);
  await js(`var l=document.getElementById('th-boot-loader'); if(l) l.remove(); window._tonyNav('brainstormjournal'); return 1;`); await sleep(2500);
  await js(`document.querySelector('#tj-entries-list .entry-item .entry-item-title').click(); return 1;`); await sleep(800);
  await js(`document.getElementById('tj-btn-edit').click(); return 1;`);
  ok('MyJournal opens the page in edit mode', await until(`document.querySelector('#tj-root .docx-toolbar.edit-mode')`, 10000));
  await sleep(1000);
  const std = await take('tj');
  ok('...and its ribbon is measured (menu bar + ribbon row, the AI button among them)', std.ribbon.length > 40 && std.ribbon.some((o) => /docx-ai-btn/.test(o.p)), std.ribbon.length);

  for (const H of HOSTS) {
    console.log('\n' + H.name + ' (' + H.key + ')');
    await fresh();
    const opened = await H.open(c, js, until);
    ok('it opens the page in Notebook\'s editor, in edit mode', opened);
    if (!opened) continue;
    await sleep(1500);
    const got = await take(H.key);
    let d = compare(std.ribbon, got.ribbon, []);
    ok('its ribbon is MyJournal\'s: every button in the same place, the same size, the same look', d.length === 0, d.join('\n      '));
    d = compare(std.bar, got.bar, H.missing.concat([/#K-sync-pill/]), { sizeOnly: true, flex: /#K-entry-title-input$/ });
    ok('its title bar is MyJournal\'s (less what its mount turns off)', d.length === 0, d.join('\n      '));
    const hm = new Map(); got.hover.forEach(([k, v]) => { if (!hm.has(k)) hm.set(k, []); hm.get(k).push(v); });
    const seen = new Map();
    d = [];
    for (const [k, v] of std.hover) {
      const i = seen.get(k) || 0; seen.set(k, i + 1);
      const w = (hm.get(k) || [])[i];
      if (w === undefined && H.missing.some((re) => re.test('#' + k.split('#')[1]))) continue;
      if (w !== v) d.push(k + '\n        MyJournal: ' + v + '\n        ' + H.name + ': ' + w);
    }
    ok('under the cursor every control answers as in MyJournal (hover colours and glow, hoverfx lift, press)', d.length === 0, d.join('\n      '));
  }

  // ── Veda's side: her journal in index.html is the standard, and a program's
  // own Notebook on her side ({ profile: 'veda' }) must look exactly like it.
  console.log('\nVeda\'s journal (index.html): her standard');
  await fresh();
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','veda'); localStorage.setItem('a1b_disabled','1');
    var d = new Date(); localStorage.setItem('a1_sweep_day:index', d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2));
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/journal': { _order: ['e_a'], activeId: 'e_a', savedAt: 1, e_e_a: ${JSON.stringify(entry('e_a', 'A'))} } })); return 1;`);
  await c.send('Page.navigate', { url: BASE + 'index.html' }); await sleep(3000);
  await until(`(function(){ var l=document.getElementById('th-boot-loader'); return !!window._profileGoTony && (!l || l.classList.contains('th-boot-hide')); })()`, 30000);
  await sleep(800);
  await js(`var l=document.getElementById('th-boot-loader'); if(l) l.remove(); window._vedaNav('journal'); return 1;`); await sleep(2500);
  await js(`document.querySelector('#bj-entries-list .entry-item .entry-item-title').click(); return 1;`); await sleep(800);
  await js(`if (document.getElementById('bj-page-editor').getAttribute('contenteditable') !== 'true') document.getElementById('bj-btn-edit').click(); return 1;`);
  ok('her journal opens the page in edit mode', await until(`document.querySelector('#bj-root .docx-toolbar.edit-mode')`, 10000));
  await sleep(1000);
  const vstd = await take('bj');
  ok('...and its ribbon is measured', vstd.ribbon.length > 40 && vstd.ribbon.some((o) => /docx-ai-btn/.test(o.p)), vstd.ribbon.length);

  console.log('\nA program\'s own Notebook on Veda\'s side (vn)');
  await fresh();
  await js(`localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/vn_test': { _order: ['e_a'], activeId: 'e_a', savedAt: 1, e_e_a: ${JSON.stringify(entry('e_a', 'A'))} } })); return 1;`);
  await c.send('Page.navigate', { url: BASE + 'tests/live/fixtures/notebook-host.html' });
  await until('window.__hostReady', 10000);
  await js(`window.__mount({ profile: 'veda', key: 'vn', store: 'vn_test', title: 'Veda Notes', pinned: [], templates: null }).then(() => { window.__mounted = true; }); return 1;`);
  await until('window.__mounted && document.querySelector("#vn-entries-list .entry-item")', 15000);
  await js(`document.querySelector('#vn-entries-list .entry-item .entry-item-title').click(); return 1;`); await sleep(800);
  await js(`if (document.getElementById('vn-page-editor').getAttribute('contenteditable') !== 'true') document.getElementById('vn-btn-edit').click(); return 1;`);
  ok('it opens the page in Notebook\'s editor, in edit mode', await until(`document.querySelector('#vn-root .docx-toolbar.edit-mode')`, 10000));
  await sleep(1500);
  const vgot = await take('vn');
  let vd = compare(vstd.ribbon, vgot.ribbon, []);
  ok('its ribbon is her journal\'s: every button in the same place, the same size, the same look', vd.length === 0, vd.join('\n      '));
  vd = compare(vstd.bar, vgot.bar, [/#K-btn-lock/, /#K-sync-pill/], { sizeOnly: true, flex: /#K-entry-title-input$/ });
  ok('its title bar is her journal\'s (less the lock, off for an instance)', vd.length === 0, vd.join('\n      '));
  const vhm = new Map(); vgot.hover.forEach(([k, v]) => { if (!vhm.has(k)) vhm.set(k, []); vhm.get(k).push(v); });
  const vseen = new Map();
  vd = [];
  for (const [k, v] of vstd.hover) {
    const i = vseen.get(k) || 0; vseen.set(k, i + 1);
    const w = (vhm.get(k) || [])[i];
    if (w === undefined && /#K-btn-lock/.test('#' + k.split('#')[1])) continue;
    if (w !== v) vd.push(k + '\n        Veda\'s journal: ' + v + '\n        instance: ' + w);
  }
  ok('under the cursor every control answers as in her journal (hover colours and glow, hoverfx lift, press)', vd.length === 0, vd.join('\n      '));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
