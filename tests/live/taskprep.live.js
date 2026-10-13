// AI task prep on BOTH TaskHubs, in the real index.html against the fake
// Firestore, a fake personal-ai worker and a fake StudyOS bridge:
//
//   • Tony's flagged task is prepped with profile 'tony' into
//     dashboards/tony_taskprep; Veda's with 'veda' into veda_taskprep. Neither
//     kit, app list, event or default assistant reaches the other's.
//   • On a PC that is Tony's (td6_mainDash 'tony'), the bridge's app list goes
//     to tony_pc_apps only, never to veda_pc_apps.
//   • The bridge is not polled in a loop (it was asked every 3 s before).
//   • ✦ on Tony's row hands the kit to the bridge with the assistant last,
//     and opens Tony's Prep panel (MAGI look) with the draft and the sites.
//   • Tony's editor: flag a new task, write a note, save -> the task carries
//     aiPrep/aiNote, a kit is built for it at once; unflag -> the fields go.
//
// Run: node tests/live/taskprep.live.js
'use strict';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');
const fs = require('fs');

const ORIGIN = 'https://anthonyn99.github.io';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const pad = (n) => ('0' + n).slice(-2);
const key = (dt) => dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
const now = new Date();
const TODAY = key(now);
const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
const task = (id, title, extra) => Object.assign({ id, title, type: 'task', done: false, category: '', repeat: 'none', notifyRepeat: 'none' }, extra || {});
const MAIN = { data: { [TODAY]: [task('tonyT1', 'Email the landlord about the lease', { aiPrep: true, aiNote: 'landlord@example.com, renew 12 months', aiSite: 'claude' }), task('tonyT2', 'Plain task')] },
  habits: [], hc: {}, goals: [], monthlyGoals: [], weekKey: key(monday), savedAt: Date.now() - 60000 };
const VEDA = { data: { [TODAY]: [task('vedaT1', 'Email Prof Kim about extension', { aiPrep: true, aiNote: 'kim@ksu.edu' })] },
  habits: [], hc: {}, goals: [], monthlyGoals: [], savedAt: Date.now() - 60000 };

const prepCalls = [];      // bodies sent to /taskhub/prep
const bridge = [];         // [method, path, body]
const APPS = [{ id: 'app_word', name: 'Microsoft Word' }, { id: 'app_zoom', name: 'Zoom' }];

(async () => {
  const fb = firebaseMock();
  const cors = (json) => ({ json });
  const mock = {
    patterns: [...fb.patterns, 'http://127.0.0.1:8781/*', 'https://personal-ai.av1.workers.dev/*'],
    handle(r) {
      if (r.url.startsWith('http://127.0.0.1:8781')) {
        if (r.method === 'OPTIONS') return { status: 204, text: '' };
        const p = new URL(r.url).pathname;
        bridge.push([r.method, p, r.postData || '']);
        if (p === '/api/apps') return cors({ ok: true, apps: APPS });
        if (p === '/api/launch') return cors({ ok: true, opened: [] });
        return null;
      }
      if (r.url.startsWith('https://personal-ai.av1.workers.dev/taskhub/prep')) {
        if (r.method === 'OPTIONS') return { status: 204, text: '' };
        const b = JSON.parse(r.postData || '{}');
        prepCalls.push(b);
        const who = b.profile === 'tony' ? 'Tony' : 'Veda';
        return cors({ ok: true, site: b.site, kit: {
          helpful: true, summary: 'KIT FOR ' + who + ': ' + b.task.title, prompt: 'PROMPT FOR ' + who,
          draft: { kind: 'email', to: 'landlord@example.com', subject: 'Lease renewal', body: 'Hi,\n\nI would like to renew.\n\n' + who },
          sites: [{ label: 'Gmail draft', url: 'https://mail.google.com/mail/?view=cm&fs=1&su=Lease' }, { label: 'Lease portal', url: 'https://portal.example.com/' }],
          apps: (b.apps || []).slice(0, 1).map((a) => a.id),
        } });
      }
      if (r.url.startsWith('https://personal-ai.av1.workers.dev/')) return null;
      return fb.handle(r);
    },
  };
  const c = await connect({ mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const js = (e) => evalJs(c, e);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','tony'); localStorage.setItem('td6_lastDash','tony'); localStorage.setItem('a1b_disabled','1');
    localStorage.setItem('a1_sweep_day:index', ${JSON.stringify(TODAY)});
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/main': ${JSON.stringify(MAIN)}, 'dashboards/vedasdash': ${JSON.stringify(VEDA)}, 'dashboards/tony_pc_apps': { apps: ${JSON.stringify(APPS.slice(0, 1))}, savedAt: 1 } })); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  await sleep(10000);
  await js("var l=document.getElementById('th-boot-loader'); if(l) l.remove(); if(window._profileGoTony) window._profileGoTony(); 1");
  const docs = () => js(`return JSON.stringify(__fakeFs.docs);`).then(JSON.parse);
  // Poll, never a fixed sleep: background prep starts 3 s after the data settles.
  const waitFor = async (fn, ms) => { const end = Date.now() + (ms || 20000); while (Date.now() < end) { if (await fn()) return true; await sleep(300); } return false; };
  await waitFor(async () => { const x = await docs(); return !!(((x['dashboards/tony_taskprep'] || {}).kits || {}).tonyT1 && ((x['dashboards/veda_taskprep'] || {}).kits || {}).vedaT1 && x['dashboards/tony_pc_apps'] && x['dashboards/tony_pc_apps'].apps.length === 2); });


  console.log('\nBackground prep, one per person');
  let d = await docs();
  const tonyCall = prepCalls.find((b) => b.task && b.task.title === MAIN.data[TODAY][0].title);
  const vedaCall = prepCalls.find((b) => b.task && b.task.title === VEDA.data[TODAY][0].title);
  ok("Tony's flagged task was prepped as profile 'tony'", tonyCall && tonyCall.profile === 'tony' && tonyCall.site === 'claude' && tonyCall.note === MAIN.data[TODAY][0].aiNote, JSON.stringify(prepCalls.map((b) => [b.profile, b.task && b.task.title])));
  ok("Veda's flagged task was prepped as profile 'veda' (her feature still works)", vedaCall && vedaCall.profile === 'veda', JSON.stringify(prepCalls.map((b) => [b.profile, b.task && b.task.title])));
  ok('an unflagged task is never prepped', !prepCalls.some((b) => b.task && b.task.title === 'Plain task'));
  const tk = (d['dashboards/tony_taskprep'] || {}).kits || {};
  const vk = (d['dashboards/veda_taskprep'] || {}).kits || {};
  ok("Tony's kit is in tony_taskprep, and only his", Object.keys(tk).join() === 'tonyT1' && /KIT FOR Tony/.test(tk.tonyT1.summary), JSON.stringify(Object.keys(tk)));
  ok("Veda's kit is in veda_taskprep, and only hers", Object.keys(vk).join() === 'vedaT1' && /KIT FOR Veda/.test(vk.vedaT1.summary), JSON.stringify(Object.keys(vk)));
  ok("on Tony's PC a changed app list (Zoom added) goes to tony_pc_apps", JSON.stringify((d['dashboards/tony_pc_apps'] || {}).apps) === JSON.stringify(APPS), JSON.stringify(d['dashboards/tony_pc_apps']));
  ok('…and never to veda_pc_apps', !d['dashboards/veda_pc_apps'], JSON.stringify(d['dashboards/veda_pc_apps']));
  ok("Veda's in-memory list is not filled from Tony's PC either", await js(`return (window._vdPcApps || []).length === 0;`));
  ok('the task docs themselves are unchanged by prep (kits live outside td_data)', JSON.stringify(d['dashboards/main'].data[TODAY][0].aiNote) === JSON.stringify(MAIN.data[TODAY][0].aiNote));

  const shot = async (name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64')); };
  await shot('taskprep-row');

  console.log('\nNo bridge polling loop');
  await sleep(8000);   // let both sides settle after their kits land
  const b0 = bridge.filter((x) => x[1] === '/api/apps').length;
  await sleep(20000);
  const b1 = bridge.filter((x) => x[1] === '/api/apps').length;
  ok('settled, 20 s with both TaskHubs open: at most 1 probe (was ~7 per side before the fix)', b1 - b0 <= 1, (b1 - b0) + ' probes');

  console.log("\n✦ on Tony's row");
  ok('the ✦ button is on his flagged task only', await js(`return !!document.querySelector('#root [data-th-prep-btn="tonyT1"]') && !document.querySelector('#root [data-th-prep-btn="tonyT2"]');`));
  ok('it is lit (kit ready)', await js(`return getComputedStyle(document.querySelector('#root [data-th-prep-btn="tonyT1"]')).opacity === '1';`));
  await js(`window.__opened = []; window.open = function(u){ window.__opened.push(u); return null; }; 1`);
  const nLaunch = bridge.filter((x) => x[1] === '/api/launch').length;
  await js(`document.querySelector('#root [data-th-prep-btn="tonyT1"]').click(); 1`);
  await sleep(1200);
  const launch = bridge.filter((x) => x[1] === '/api/launch').slice(nLaunch);
  const lb = launch[0] ? JSON.parse(launch[0][2]) : null;
  ok('the bridge gets his kit, with his assistant (Claude) as focus, opened last', lb && /^https:\/\/claude\.ai\/new\?q=PROMPT%20FOR%20Tony/.test(lb.focus) && lb.urls.includes('https://portal.example.com/') && lb.apps[0] === 'app_word', JSON.stringify(lb));
  ok('the page opens no tab of its own (it would end up buried)', await js(`return window.__opened.length === 0;`), await js(`return JSON.stringify(window.__opened);`));
  ok("Tony's Prep panel opens", await js(`return !!document.querySelector('[data-th-prep-panel]');`));
  const panelTxt = await js(`return document.querySelector('[data-th-prep-panel]').innerText;`);
  ok('it shows his summary, the email draft and the sites', /KIT FOR Tony/.test(panelTxt) && /Lease renewal/.test(panelTxt) && /I would like to renew/.test(panelTxt) && /Lease portal/i.test(panelTxt), panelTxt);
  ok('…and the app by name, from his own list', /Microsoft Word/.test(panelTxt));
  ok('MAGI look: solid purple primary button, s1 box, radius 8', await js(`const p = document.querySelector('[data-th-prep-panel]'); const s = getComputedStyle(p);
    const prim = [...p.querySelectorAll('button')].find(b => /Open in Claude/i.test(b.textContent)); const ps = getComputedStyle(prim);
    return s.backgroundColor === 'rgb(35, 35, 39)' && s.borderRadius === '8px' && ps.backgroundColor === 'rgb(192, 174, 234)' && ps.color === 'rgb(26, 26, 29)';`));
  ok('no Veda names in it', !/Veda/.test(panelTxt));
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
    await sleep(700);
    const r = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shotPath('taskprep-panel-' + w), Buffer.from(r.result.data, 'base64'));
    ok('panel fits at ' + w + 'px (no horizontal overflow)', await js(`const b = document.querySelector('[data-th-prep-panel]').getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth + 0.5;`));
  }
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await js(`[...document.querySelectorAll('[data-th-prep-panel] button')].find(b => b.textContent === 'Close').click(); 1`);
  await sleep(500);
  ok('Close closes it', await js(`return !document.querySelector('[data-th-prep-panel]');`));

  console.log("\nTony's editor");
  await js(`window._thVoice.setEdit(true); 1`); await sleep(800);
  await js(`[...document.querySelectorAll('#root button')].find(b => b.textContent.trim() === '+ Add').click(); 1`);
  await sleep(800);
  ok('the editor has the AI prep switch', await js(`return [...document.querySelectorAll('#root label')].some(l => /AI prep/.test(l.textContent));`));
  const setVal = (sel, v) => js(`const el = ${sel}; const P = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); 1`);
  await setVal(`document.querySelector('#root textarea[placeholder="Enter title..."], #root [placeholder="Enter title..."]')`, 'Book the dentist');
  await js(`[...document.querySelectorAll('#root label')].find(l => /AI prep/.test(l.textContent)).querySelector('input').click(); 1`);
  await sleep(300);
  ok('flagging shows the note and assistant picker', await js(`return !!document.querySelector('#root textarea[placeholder^="Details for the AI"]') && [...document.querySelectorAll('#root button')].some(b => b.textContent === 'ChatGPT');`));
  await setVal(`document.querySelector('#root textarea[placeholder^="Details for the AI"]')`, 'Dr Lee, any weekday morning');
  await js(`[...document.querySelectorAll('#root label')].find(l => /AI prep/.test(l.textContent)).scrollIntoView({ block: 'center' }); 1`); await sleep(300);
  await shot('taskprep-editor');
  await js(`[...document.querySelectorAll('#root button')].find(b => b.textContent === 'ChatGPT').click(); 1`);
  await sleep(200);
  const nCalls = prepCalls.length;
  await js(`[...document.querySelectorAll('#root button')].find(b => b.textContent.trim().toLowerCase() === 'save').click(); 1`);
  await waitFor(async () => { const x = await docs(); const t = Object.values(x['dashboards/main'].data).flat().find((i) => i && i.title === 'Book the dentist'); return !!(t && ((x['dashboards/tony_taskprep'] || {}).kits || {})[t.id]); });
  d = await docs();
  const all = Object.values(d['dashboards/main'].data).flat();
  const dentist = all.find((t) => t && t.title === 'Book the dentist');
  ok('the new task is saved with its AI fields', dentist && dentist.aiPrep === true && dentist.aiNote === 'Dr Lee, any weekday morning' && dentist.aiSite === 'chatgpt', JSON.stringify(dentist));
  const newCall = prepCalls.slice(nCalls).find((b) => b.task.title === 'Book the dentist');
  ok('…and is prepped at once, as Tony, with ChatGPT', newCall && newCall.profile === 'tony' && newCall.site === 'chatgpt' && newCall.note === 'Dr Lee, any weekday morning', JSON.stringify(prepCalls.slice(nCalls)));
  ok('…kit in his doc', !!((d['dashboards/tony_taskprep'] || {}).kits || {})[dentist && dentist.id]);
  ok("Veda's doc never got Tony's task", !JSON.stringify(d['dashboards/vedasdash']).includes('Book the dentist') && !JSON.stringify(d['dashboards/veda_taskprep']).includes('Book the dentist'));

  // Edit it again: unflag.
  await js(`const row = [...document.querySelectorAll('#root [title="Edit"]')].find(b => b.parentElement && b.parentElement.innerText.includes('Book the dentist')); row.click(); 1`);
  await sleep(800);
  ok('re-opening shows it flagged, with its note', await js(`const cb = [...document.querySelectorAll('#root label')].find(l => /AI prep/.test(l.textContent)).querySelector('input'); return cb.checked && document.querySelector('#root textarea[placeholder^="Details for the AI"]').value === 'Dr Lee, any weekday morning';`));
  await js(`[...document.querySelectorAll('#root label')].find(l => /AI prep/.test(l.textContent)).querySelector('input').click(); 1`);
  await sleep(200);
  await js(`[...document.querySelectorAll('#root button')].find(b => b.textContent.trim().toLowerCase() === 'save').click(); 1`);
  await sleep(3000);
  d = await docs();
  const dentist2 = Object.values(d['dashboards/main'].data).flat().find((t) => t && t.title === 'Book the dentist');
  ok('unflagging removes the AI fields from the task', dentist2 && !dentist2.aiPrep && !('aiNote' in dentist2), JSON.stringify(dentist2));
  await js(`window._thVoice.setEdit(false); 1`); await sleep(800);
  ok('…and its ✦ is gone', await js(`return !document.querySelector('#root [data-th-prep-btn="${dentist2 && dentist2.id}"]');`));

  console.log('\nSeparation in the page');
  ok("Tony's default assistant is stored under his key only", await js(`window._thPrepSetDefaultSite('chatgpt'); return localStorage.getItem('thAiSite') === 'chatgpt' && localStorage.getItem('vdAiSite') === null;`));
  ok("Veda's kits in memory hold only hers, Tony's only his", await js(`return Object.keys(window._vdPrepKits).every(k => k.startsWith('veda')) && Object.keys(window._thPrepKits).every(k => !k.startsWith('veda'));`));

  console.log('\nPage health');
  ok('no uncaught exceptions', errs.length === 0, errs.join('\n'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
