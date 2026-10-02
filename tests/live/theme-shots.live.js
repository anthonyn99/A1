// Screenshots + hover/press probe for the theme overhaul
// (docs/theme-overhaul-plan.md). One run captures a program the way a phase
// needs to judge it: Tony's view, Veda's view, phone width, and the shared
// overlays, plus what hoverfx actually wrote on a real button under a real mouse.
//
//   node tests/live/theme-shots.live.js <label> [page] [views]
//     label  file prefix, e.g. p3-before / p3-after
//     page   index.html (default) or any other root page
//     views  comma list: chooser,tony,veda,overlays,journals
//            (default: all but journals)
//
// Before/after of the SAME moment: serve an older checkout under the same origin
//   git worktree add <dir> theme-pN-start
//   A1_ROOT=<dir> node tests/live/theme-shots.live.js pN-before
//   node tests/live/theme-shots.live.js pN-after
// then pixel-diff Veda's shots (see §"Verifying a phase" in the plan). The
// quote and weather band differ run to run (random quote, live temperature);
// everything else in Veda's shots must be identical.
//
// Firebase stays blocked (cdp.js), so TaskHub shows its seeded demo data.
// Shots land in the OS temp dir (cdp.js SHOTS), never in the repo.

'use strict';
process.env.CDP_ALLOW_FONTS = '1';
const fs = require('fs');
const path = require('path');
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');

const label = process.argv[2] || 'theme';
const page = process.argv[3] || 'index.html';
const views = (process.argv[4] || 'chooser,tony,veda,overlays').split(',');
const ORIGIN = 'https://anthonyn99.github.io';
const BASE = ORIGIN + '/A1/';

async function shot(c, name, w, h) {
  await c.send('Emulation.setDeviceMetricsOverride',
    { width: w || 1440, height: h || 900, deviceScaleFactor: 1, mobile: (w || 1440) < 700 });
  await sleep(600);
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const f = shotPath(label + '-' + name);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  console.log('shot', f);
}

// index.html picks its profile from td6_mainDash; other pages ignore it.
async function load(c, who) {
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: BASE + 'oneinbox.html' }); await sleep(800);
  await evalJs(c, `localStorage.clear(); ${who ? `localStorage.setItem('td6_mainDash','${who}');` : ''} 1`);
  await c.send('Page.navigate', { url: BASE + page });
  await sleep(9000);   // babel compiles the TaskHubs in-page; the boot loader gives up at 4s
  await evalJs(c, "var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
}

// Hover then press the first real button in `rootSel`, report what hoverfx wrote.
async function probe(c, rootSel) {
  const pos = await evalJs(c, `return JSON.stringify((function(){
    var root=document.querySelector(${JSON.stringify(rootSel)}); if(!root) return null;
    var b=[...root.querySelectorAll('button')].find(b=>{var r=b.getBoundingClientRect();return r.width>20&&r.height>16&&r.top>40&&r.top<400;});
    if(!b) return null; b.id=b.id||'theme-probe'; var r=b.getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2,id:b.id};})())`);
  const p = JSON.parse(pos || 'null');
  if (!p) { console.log('probe', rootSel, 'no button'); return; }
  const read = () => evalJs(c, `JSON.stringify({filter:document.getElementById('${p.id}').style.filter,translate:document.getElementById('${p.id}').style.translate})`);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await sleep(300);
  console.log('hover', rootSel, await read());
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await sleep(80);
  console.log('press', rootSel, await read());
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 895 }); await sleep(300);
  await evalJs(c, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1");
}

async function overlays(c, who) {
  await evalJs(c, `window._openSettings&&window._openSettings('${who}'); 1`);
  await shot(c, who + '-settings');
  await evalJs(c, "var o=document.getElementById('thset-overlay'); if(o) o.style.display='none'; 1");
  await evalJs(c, "window.uiConfirm&&window.uiConfirm('Delete this task? This cannot be undone.',{title:'Delete task'}); 1");
  await shot(c, who + '-confirm');
  await evalJs(c, "var b=document.getElementById('uim-cancel'); if(b) b.click(); 1");
  await evalJs(c, `window.alManage&&window.alManage('${who}_taskhub'); 1`);
  await shot(c, who + '-lock');
}

// The journals (index.html only): Tony's MyJournal and Veda's Brainstorm
// Journal, empty (Firebase is blocked), then each one's template picker.
async function journals(c, who) {
  await load(c, who);
  await evalJs(c, who === 'tony' ? "window._tonyNav('brainstormjournal'); 1" : "window._vedaNav('journal'); 1");
  await sleep(2500);
  await shot(c, who + '-journal'); await shot(c, who + '-journal-mobile', 400, 860);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  if (who === 'tony') await probe(c, '#tj-root');
  const p = who === 'tony' ? 'tj' : 'bj';
  await evalJs(c, `var b=document.getElementById('${p}-new-entry-btn'); if(b) b.click(); 1`);
  await sleep(600);
  await shot(c, who + '-journal-templates');
}

(async () => {
  const c = await connect();
  if (views.includes('journals') && page === 'index.html') {
    await journals(c, 'tony'); await journals(c, 'veda');
    if (views.length === 1) { c.ws.close(); process.exit(0); }
  }
  if (views.includes('chooser')) { await load(c, null); await shot(c, 'chooser'); }
  for (const who of ['tony', 'veda']) {
    if (!views.includes(who)) continue;
    await load(c, who);
    await shot(c, who); await shot(c, who + '-mobile', 400, 860);
    if (page === 'index.html') await probe(c, who === 'tony' ? '#root' : '#veda-root');
    if (views.includes('overlays') && page === 'index.html') await overlays(c, who);
  }
  c.ws.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
