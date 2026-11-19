// Notebook's editor works in EVERY program that mounts it, on a phone, a
// tablet (portrait and landscape) and a desktop (Tony, 2026-11-18: Everwell's
// Mindset card opened its editor UNDER the page on his phone; the text ran
// over Everwell's cards and there was no bar). Each host is loaded at each
// size, its page is opened in edit mode through Notebook.open (the public API
// every host uses), and the editor must be what the person sees:
//   - phone and portrait tablet (<= 900px): the editor covers the window; no
//     host element paints over any part of it (elementFromPoint on a grid);
//     the bar has a way out (Done, or Reading mode), and Reading gives the
//     host's page back for an instance
//   - landscape tablet and desktop: the ribbon and the page sit on top where
//     the host put them (nothing of the host over them)
// A new host goes in HOSTS.
//
// Run: node tests/live/notebook-hosts-sizes.live.js [host name part]   (CDP_PORT=93xx)
'use strict';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 800) : '')); }
};
const ORIGIN = 'https://anthonyn99.github.io', BASE = ORIGIN + '/A1/';
const HTML = '<h2>Heading</h2>' + '<p>A line of test text, long enough to wrap on a phone screen.</p>'.repeat(30);
const entry = (id, title, extra) => Object.assign({ id, title, template: 'page', created: 1, updated: 1, tags: [], data: { html: HTML, attachments: [] }, rev: 1 }, extra || {});
const today = () => { const d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); };
const seed = (docs, extra) => `localStorage.clear(); sessionStorage.clear(); ${extra || ''} sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(docs))}); return 1;`;

// Each host: load it, reach the place its Notebook lives, and say which key
// and entry to open. `overlay`: index.html's own journals (always full screen).
const HOSTS = [
  { name: 'MyJournal (index.html)', key: 'tj', id: 'e_a', overlay: true,
    async load(H) {
      await H.js(seed({ 'dashboards/tony_journal': { _order: ['e_a'], activeId: 'e_a', savedAt: 1, e_e_a: entry('e_a', 'Alpha') } },
        `localStorage.setItem('td6_mainDash','tony'); localStorage.setItem('a1b_disabled','1'); localStorage.setItem('a1_sweep_day:index','${today()}');`));
      await H.nav(BASE + 'index.html');
      await H.until(`(function(){ var l=document.getElementById('th-boot-loader'); return !!window._profileGoTony && (!l || l.classList.contains('th-boot-hide')); })()`, 30000);
      await sleep(800); await H.js(`var l=document.getElementById('th-boot-loader'); if(l) l.remove(); window._tonyNav('brainstormjournal'); return 1;`);
    } },
  { name: "Brainstorm Journal (index.html, Veda)", key: 'bj', id: 'e_a', overlay: true,
    async load(H) {
      await H.js(seed({ 'dashboards/journal': { _order: ['e_a'], activeId: 'e_a', savedAt: 1, e_e_a: entry('e_a', 'Alpha') } },
        `localStorage.setItem('td6_mainDash','veda'); localStorage.setItem('a1b_disabled','1'); localStorage.setItem('a1_sweep_day:index','${today()}');`));
      await H.nav(BASE + 'index.html');
      await H.until(`(function(){ var l=document.getElementById('th-boot-loader'); return !!window._vedaNav && (!l || l.classList.contains('th-boot-hide')); })()`, 30000);
      await sleep(800); await H.js(`var l=document.getElementById('th-boot-loader'); if(l) l.remove(); window._vedaNav('journal'); return 1;`);
    } },
  { name: 'Everwell (Mindset card)', key: 'ewn', id: 'relationship-principles', done: true,
    async load(H) {
      await H.js(seed({ 'dashboards/everwell_notes': { _order: ['relationship-principles'], 'e_relationship-principles': entry('relationship-principles', 'Relationship Principles') } }));
      await H.nav(BASE + 'everwell.html');
      await H.until(`document.getElementById('ew-intro-overlay')`, 15000); await sleep(1500);
      await H.js(`document.getElementById('ew-intro-overlay').click(); return 1;`); await sleep(1500);
      await H.js(`EWApp.go('mindset'); return 1;`); await sleep(900);
      await H.js(`var s=[...document.querySelectorAll('#mind-seg button')].find(b=>/principles/i.test(b.textContent)); if(s) s.click(); return 1;`); await sleep(600);
      // The way Tony opens it: the card's pencil (Everwell mounts on demand).
      await H.js(`var b=document.querySelector('[data-wr-edit="relationship-principles"]'); if(b) b.click(); return 1;`);
      return 'mounted';
    } },
  { name: 'TradeHub Playbook', key: 'pb', id: 'daily-reminder',
    async load(H) {
      await H.js(seed({ 'dashboards/tradehub_playbook': { _order: ['daily-reminder'], 'e_daily-reminder': entry('daily-reminder', 'Daily Reminder') } },
        `localStorage.setItem('a1_sweep_day:tradehub','${new Date().toISOString().slice(0, 10)}');`));
      await H.nav(BASE + 'tradehub.html');
      await H.until(`document.querySelector('.tb-navtab')`, 20000); await sleep(2500);
      await H.js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="playbook"]')].find(b=>b.offsetParent) || document.querySelector('.tb-navtab[data-navid="playbook"]'); if(t) t.click(); return 1;`);
    } },
  { name: 'TradeHub prompts (Control)', key: 'prm', id: 'p_look', done: true,
    async load(H) {
      await H.js(seed({ 'dashboards/tradeboard_prompts': { prompts: [{ id: 'p_look', name: 'Look', text: '## Heading' }] },
        'dashboards/tradehub_prompts': { _order: ['p_look'], e_p_look: entry('p_look', 'Look') } },
        `localStorage.setItem('a1_sweep_day:tradehub','${new Date().toISOString().slice(0, 10)}');`));
      await H.nav(BASE + 'tradehub.html');
      await H.until(`document.querySelector('.tb-navtab')`, 20000); await sleep(2500);
      await H.js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="prompt"]')].find(b=>b.offsetParent) || document.querySelector('.tb-navtab[data-navid="prompt"]'); if(t) t.click(); return 1;`); await sleep(900);
      await H.js(`var b=[...document.querySelectorAll('#tradeboard-root .ctl-pr-bar button')].find(x=>/edit/i.test(x.innerText)); if(b) b.click(); return 1;`);
      return 'mounted';
    } },
  { name: 'StudyOS notes (V1)', key: 'stn', id: 'e_a',
    async load(H) {
      await H.js(seed({ 'dashboards/studyos': { classes: [], events: [], tasks: [], notes: [], ksu: { modules: [] } },
        'dashboards/studyos_notebook': { _order: ['e_a'], activeId: 'e_a', savedAt: 1, e_e_a: entry('e_a', 'A', { folder: 'quick' }) } }));
      await H.nav(BASE + 'V1/studyos.html');
      await H.until(`window.SOSNotes && document.body.dataset.sosGate === 'open'`, 20000);
      await H.js(`window.sosHideIntro && sosHideIntro(); switchView('notes'); return 1;`);
    } },
  { name: 'TradeBoard Strats (V1)', key: 'vtb', id: 'e_a',
    async load(H) {
      await H.js(seed({ 'tradeboard/UboRGuQZT5QlGhJa1U4zMSd7Sm12': { strats: '[]', rulesDaily: JSON.stringify({ lastCompleted: null, enabled: false }), _updated: 1 },
        'dashboards/tradeboard_strats': { _order: ['e_a'], activeId: 'e_a', savedAt: 1, e_e_a: entry('e_a', 'A') } }));
      await H.nav(BASE + 'V1/tradeboard.html');
      await H.until(`typeof TB !== 'undefined' && window._tbCloudSeen`, 20000); await sleep(800);
      await H.js(`TB.showSection('strats'); return 1;`);
    } },
];

const SIZES = [
  { label: 'phone', w: 412, h: 915, touch: true, full: true },
  { label: 'tablet portrait', w: 820, h: 1180, touch: true, full: true },
  { label: 'tablet landscape', w: 1180, h: 820, touch: true, full: false },
  { label: 'desktop', w: 1440, h: 900, touch: false, full: false },
];

(async () => {
  const c = await connect({ mock: firebaseMock({ patterns: ['https://taskhub-reminders.av1.workers.dev/*', 'https://trade-dashboard.av1-2.workers.dev/*',
    'https://tradeboard-api.av1.workers.dev/*', 'https://newshub-api.av1.workers.dev/*'], handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const p = new URL(req.url).pathname, b = req.postData ? (() => { try { return JSON.parse(req.postData); } catch (e) { return {}; } })() : {};
    if (p === '/auth/journal/status-many') { const out = {}; (b.locks || []).forEach((l) => { out[l.journal + ':' + l.entryId] = { hasLock: false, ver: null }; }); return { json: { ok: true, locks: out } }; }
    if (p === '/auth/journal/verify') return { json: { ok: false, noLock: true } };
    return { json: { ok: true } };
  } }) });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text || '').slice(0, 300)); });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 250; i++) { if (await js(`try { return !!(${expr}); } catch (e) { return false; }`)) return true; await sleep(250); } return false; };
  const nav = async (url) => { await c.send('Page.navigate', { url }); await sleep(2500); };
  const H = { js, until, nav };
  const shot = async (n) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(shotPath('nbsz-' + n), Buffer.from(r.result.data, 'base64')); };
  const only = (process.argv[2] || '').toLowerCase();

  for (const host of HOSTS) {
    if (only && !host.name.toLowerCase().includes(only)) continue;
    const K = host.key, R = '#' + K + '-root';
    for (const S of SIZES) {
      console.log(`\n${host.name}, ${S.label} ${S.w}x${S.h}`);
      errs.length = 0;
      await c.send('Emulation.setDeviceMetricsOverride', { width: S.w, height: S.h, deviceScaleFactor: 1, mobile: S.touch });
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: S.touch, maxTouchPoints: S.touch ? 5 : 0 });
      await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
      await nav(BASE + 'LifeHub/lifehub.js');
      await host.load(H);
      const mounted = await until(`window.Notebook && Notebook.mounts && Notebook.mounts['${K}'] && document.getElementById('${K}-page-editor')`, 25000);
      ok('Notebook is mounted', mounted);
      if (!mounted) { await shot(`${K}-${S.w}-nomount`); continue; }
      await sleep(600);
      await js(`Notebook.open('${K}', '${host.id}', { edit: true }).catch(function(){}); return 1;`);
      const editing = await until(`document.querySelector('${R} .docx-toolbar.edit-mode') && document.getElementById('${K}-page-editor').getAttribute('contenteditable') === 'true'`, 15000);
      ok('the page opens in edit mode', editing);
      await sleep(900);
      await shot(`${K}-${S.w}`);
      if (S.full) {
        const r = await js(`var r=document.getElementById('${K}-root').getBoundingClientRect(); return [r.left,r.top,r.width,r.height].map(Math.round).join(',');`);
        ok('the editor covers the window', r === `0,0,${S.w},${S.h}`, r);
        const cover = await js(`var root=document.getElementById('${K}-root'), bad=[];
          for (var y=0.05; y<1; y+=0.15) for (var x=0.1; x<1; x+=0.2) { var e=document.elementFromPoint(innerWidth*x, innerHeight*y);
            if (!e || !(root.contains(e) || e.closest('[data-nb-key="${K}"]'))) bad.push(Math.round(x*100)+'%,'+Math.round(y*100)+'%: '+(e ? (e.id || e.tagName + '.' + String(e.className).slice(0,40)) : 'none')); }
          return bad.join(' | ');`);
        ok('nothing of the host paints over it anywhere', cover === '', cover);
        const out = await js(`function vis(e){ if(!e) return false; var r=e.getBoundingClientRect(); if(!r.width||!r.height) return false; var t=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return !!t && (t===e || e.contains(t)); }
          return JSON.stringify({ done: [...document.querySelectorAll('${R} .nb-done-btn')].some(vis), mode: vis(document.querySelector('${R} .nb-mh-mode')), bold: vis(document.getElementById('${K}-pt-bold')) });`).then(JSON.parse);
        ok('its bar and ribbon are on top and usable (Reading mode, Bold)', out.mode && out.bold, JSON.stringify(out));
        if (host.done) ok('the host\'s Done is in the bar', out.done, JSON.stringify(out));
        if (!host.overlay) {
          await js(`document.querySelector('${R} .nb-mh-mode').click(); return 1;`); await sleep(700);
          ok('Reading mode gives the host\'s page back (no longer full screen)', await js(`return !document.getElementById('${K}-root').classList.contains('nb-mfull') && getComputedStyle(document.documentElement).overflow !== 'hidden';`));
        }
      } else {
        const top = await js(`function vis(e){ if(!e) return 'missing'; var r=e.getBoundingClientRect(); if(!r.width||!r.height) return 'no size'; var x=r.left+Math.min(r.width/2, 40), y=r.top+Math.min(r.height/2, 40); if (y > innerHeight) return 'below the window'; var t=document.elementFromPoint(x, y); return t && document.getElementById('${K}-root').contains(t) ? '' : 'covered by ' + (t ? (t.id || t.tagName + '.' + String(t.className).slice(0,40)) : 'none'); }
          var o={ bold: vis(document.getElementById('${K}-pt-bold')), page: vis(document.getElementById('${K}-page-editor')) }; return o.bold || o.page ? JSON.stringify(o) : '';`);
        ok('the ribbon and the page are on top where the host put them', top === '', top);
        ok('not pinned full screen', await js(`return !document.getElementById('${K}-root').classList.contains('nb-mfull');`) || host.overlay);
      }
      ok('no page errors', !errs.length, errs.join(' / '));
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
