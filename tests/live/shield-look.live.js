// Screenshots of every Shield screen, Tony's and Veda's, at desktop, the
// desktop agent's window width (520) and phone width, with a fake Firebase and
// a fake Tauri agent so the "downloaded to PC" view is what gets drawn.
//
//   node tests/live/shield-look.live.js <label> [profiles] [widths]
//     label     file prefix, e.g. before / after
//     profiles  comma list, default tony,veda
//     widths    comma list, default 1280,520,390
//
// Veda's side must not change: run it before and after a Tony-side change and
// compare her shots (the timestamps are fixed, so they are byte-comparable).
// Shots land in the OS temp dir (cdp.js SHOTS).
'use strict';
process.env.CDP_ALLOW_FONTS = '1';
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const label = process.argv[2] || 'shield';
const profiles = (process.argv[3] || 'tony,veda').split(',');
const widths = (process.argv[4] || '1280,520,390').split(',').map(Number);
const URL_ = 'https://anthonyn99.github.io/A1/shield.html';

const T0 = Date.parse('2026-10-20T15:31:00');
const tgt = (id, label, type, value, hide) => ({ id, label, match: { type, value }, hideIcons: !!hide });
function seedDoc() {
  const nowish = Date.now() - 60000;
  return {
    global: { active: false, v: 0 },
    devices: {
      dev_me: {
        name: 'PC', platform: 'windows', lastSeen: nowish, caps: { agent: true },
        closer: {
          targets: [tgt('a', 'Discord', 'exe', 'discord.exe'), tgt('b', 'Riot Games', 'folder', 'C:\\Riot Games'),
                    tgt('c', 'Brave', 'path', 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe')],
          triggers: [tgt('d', 'League of Legends', 'folder', 'C:\\Riot Games\\League of Legends')],
          targetSets: [{ id: 'default', name: 'Default' }, { id: 'work', name: 'Work', targets: [tgt('e', 'Slack', 'exe', 'slack.exe')] }],
          activeTargetSet: 'default',
        },
        emergency: { targets: [tgt('f', 'Discord', 'exe', 'discord.exe', true), tgt('g', 'Steam', 'folder', 'C:\\Program Files (x86)\\Steam')],
                     lockA1Apps: true, watchdog: true, lockWorkstation: false },
      },
      dev_zen: { name: "Tony's Zenbook", platform: 'windows', lastSeen: nowish, caps: { agent: true },
        history: [{ id: 'z1', kind: 'closer', at: T0 - 14 * 3600e3, items: [{ label: 'Discord', status: 'closed', count: 3 }] },
                  { id: 'z2', kind: 'closer', at: T0 - 15 * 3600e3, items: [] }] },
      dev_fold: { name: "Tony's Z Fold7", platform: 'android', lastSeen: Date.now() - 5 * 86400e3, caps: {} },
    },
  };
}
const HIST = [
  { id: 'h1', kind: 'closer', at: T0, deviceId: 'dev_me', items: [
    { label: 'Discord', status: 'closed', count: 3, launch: [{ path: 'C:\\x\\discord.exe', hadWindow: true }] },
    { label: 'Riot Games', status: 'notrunning' },
    { label: 'Brave', status: 'partial', count: 2, error: 'one window refused', launch: [{ path: 'C:\\b\\brave.exe', hadWindow: true }] }] },
  { id: 'h2', kind: 'emergency', scope: 'global', at: T0 - 3600e3, deviceId: 'dev_me', items: [] },
  { id: 'h3', kind: 'closer', at: T0 - 7200e3, deviceId: 'dev_me', reverted: true, revertedAt: T0 - 7000e3,
    items: [{ label: 'Steam', status: 'closed', count: 1, launch: [{ path: 'C:\\s\\steam.exe', hadWindow: true }] }] },
];

const TAURI = (emg) => `
  window.__TAURI__ = {
    core: { invoke: function(cmd){
      if (cmd === 'sh_status') return Promise.resolve({ deviceId:'dev_me', version:'1.0.0',
        hotkeys:{ close:'Ctrl+Shift+X', emergency:'Ctrl+Shift+L', all:'Ctrl+Shift+G' },
        emergency:{ active:${emg ? 'true' : 'false'}, at:${T0} } });
      if (cmd === 'sh_pull_history') return Promise.resolve([]);
      if (cmd === 'sh_apps') return Promise.resolve({
        installed:[{ name:'Discord', folder:'C:\\\\Users\\\\t\\\\AppData\\\\Local\\\\Discord', running:true },
                   { name:'Steam', folder:'C:\\\\Program Files (x86)\\\\Steam' },
                   { name:'Visual Studio Code', folder:'C:\\\\Users\\\\t\\\\AppData\\\\Local\\\\Programs\\\\Microsoft VS Code', running:true }],
        running:[{ file:'brave.exe', exe:'C:\\\\Program Files\\\\BraveSoftware\\\\brave.exe' }] });
      return Promise.resolve({});
    } },
    event: { listen: function(){ return Promise.resolve(function(){}); } }
  };`;

async function shot(c, name, w) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: w < 700 ? 860 : 900, deviceScaleFactor: 1, mobile: w < 500 });
  await sleep(450);
  const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
    clip: await evalJs(c, `JSON.stringify({x:0,y:0,width:${w},height:Math.max(document.documentElement.scrollHeight, ${w < 700 ? 860 : 900}),scale:1})`).then(JSON.parse) });
  const f = shotPath(label + '-' + name);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  console.log('shot', f);
}

async function open(c, p, emg) {
  await c.send('Page.navigate', { url: URL_ + '?blank' }); await sleep(600);
  const docs = {}; docs['dashboards/shield_' + p] = seedDoc();
  const ls = { sh_device_id: 'dev_me', sh_fav_profile: p, sh_view: 'home' };
  ls['sh_hist_' + p + '_dev_me'] = JSON.stringify(HIST);
  if (emg) ls['sh_emg_' + p] = JSON.stringify({ active: true, at: T0, source: 'local', scope: 'local', v: 0 });
  await evalJs(c, `localStorage.clear(); sessionStorage.clear();
    sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(docs))});
    const s = ${JSON.stringify(ls)}; Object.keys(s).forEach(k => localStorage.setItem(k, s[k])); return 1;`);
  await c.send('Page.navigate', { url: URL_ }); await sleep(3500);
}
const go = (c, v) => evalJs(c, `document.querySelector('.nav > .pill[data-view="${v}"]').click(); return 1;`);
const tab = (c, t) => evalJs(c, `document.querySelector('[data-tab="${t}"]').click(); return 1;`);

(async () => {
  const c = await connect({ mock: firebaseMock() });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errors = [];
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errors.push(((m.params.exceptionDetails || {}).exception || {}).description || m.params.exceptionDetails.text); });
  let sid = (await c.send('Page.addScriptToEvaluateOnNewDocument', { source: TAURI(false) })).result.identifier;

  for (const p of profiles) {
    await open(c, p);
    const gate = await evalJs(c, `document.body.getAttribute('data-gate') + ' ' + document.body.getAttribute('data-profile')`);
    if (gate !== 'app ' + p) { console.log('NOT IN APP:', gate); process.exitCode = 1; }
    for (const w of widths) {
      await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 500 });
      await go(c, 'home'); await shot(c, `${p}-${w}-home`, w);
      await go(c, 'config');
      for (const t of ['closer', 'emergency', 'security']) { await tab(c, t); await shot(c, `${p}-${w}-config-${t}`, w); }
      await tab(c, 'closer');
      await go(c, 'devices'); await shot(c, `${p}-${w}-devices`, w);
      await go(c, 'history'); await shot(c, `${p}-${w}-history`, w);
    }
    // The app picker, at the agent window's width.
    await c.send('Emulation.setDeviceMetricsOverride', { width: 520, height: 860, deviceScaleFactor: 1, mobile: false });
    await go(c, 'config'); await tab(c, 'closer');
    await evalJs(c, `document.querySelector('[data-add="closer"]').click(); return 1;`); await sleep(700);
    await shot(c, `${p}-520-picker`, 520);
    await evalJs(c, `var b=document.getElementById('pick-cancel'); b && b.click(); return 1;`);
    await go(c, 'home');
  }

  // The emergency takeover.
  await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sid });
  sid = (await c.send('Page.addScriptToEvaluateOnNewDocument', { source: TAURI(true) })).result.identifier;
  for (const p of profiles) {
    await open(c, p, true);
    await shot(c, `${p}-1280-emergency`, 1280);
    await shot(c, `${p}-390-emergency`, 390);
  }
  await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sid });

  if (errors.length) { console.log('PAGE ERRORS:\n' + errors.join('\n')); process.exitCode = 1; }
  c.ws.close();
  process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
