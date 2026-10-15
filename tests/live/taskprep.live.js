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
//   • A kit's old /mail/?view=cm Gmail link (its redirect drops the email's
//     line breaks) is rebuilt as the direct compose link everywhere.
//   • The note box has A1's corner grip, and dragging it resizes the box.
//   • Gemini: picked in the editor, ✦ copies the prompt (Gemini takes none
//     from its URL) and the panel says to paste it.
//   • No bridge: pop-ups blocked -> the assistant alone + a hint; allowed ->
//     every site, and once learned, the assistant last (in front).
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
let bridgeDown = false;   // the "another PC" case: nothing answers on 127.0.0.1
const APPS = [{ id: 'app_word', name: 'Microsoft Word' }, { id: 'app_zoom', name: 'Zoom' }];

(async () => {
  const fb = firebaseMock();
  const cors = (json) => ({ json });
  const mock = {
    patterns: [...fb.patterns, 'http://127.0.0.1:8781/*', 'https://personal-ai.av1.workers.dev/*'],
    handle(r) {
      if (r.url.startsWith('http://127.0.0.1:8781')) {
        if (bridgeDown) return { status: 502, text: 'down' };
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
  const gm = lb && lb.urls.find((u) => /mail\.google\.com/.test(u));
  ok("the kit's old view=cm Gmail link goes out as the direct compose link, line breaks kept",
    gm && gm.startsWith('https://mail.google.com/mail/u/0/?fs=1&tf=cm&') && !/view=cm/.test(gm)
    && new URL(gm).searchParams.get('body') === 'Hi,\n\nI would like to renew.\n\nTony', gm);
  ok("Tony's Prep panel opens", await js(`return !!document.querySelector('[data-th-prep-panel]');`));
  const panelTxt = await js(`return document.querySelector('[data-th-prep-panel]').innerText;`);
  ok('it shows his summary, the email draft and the sites', /KIT FOR Tony/.test(panelTxt) && /Lease renewal/.test(panelTxt) && /I would like to renew/.test(panelTxt) && /Lease portal/i.test(panelTxt), panelTxt);
  ok('…and the app by name, from his own list', /Microsoft Word/.test(panelTxt));
  ok("the panel's Gmail draft link is the direct one too", await js(`const a = [...document.querySelectorAll('[data-th-prep-panel] a')].find(x => /Gmail/.test(x.textContent)); return !!a && a.href.startsWith('https://mail.google.com/mail/u/0/?fs=1&tf=cm&') && /%0A%0A/.test(a.href);`));
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
  ok('Gemini is one of the assistants', await js(`return [...document.querySelectorAll('#root button')].some(b => b.textContent === 'Gemini');`));
  ok("the note box has A1's corner grip, not the native one", await js(`const ta = document.querySelector('#root textarea[placeholder^="Details for the AI"]');
    return !!ta.parentElement.querySelector(':scope > .a1-grip') && getComputedStyle(ta).resize === 'none';`));
  {
    const r = JSON.parse(await js(`const ta = document.querySelector('#root textarea[placeholder^="Details for the AI"]'); ta.scrollIntoView({ block: 'center' });
      const g = ta.parentElement.querySelector('.a1-grip').getBoundingClientRect(); return JSON.stringify({ x: g.left + g.width / 2, y: g.top + g.height / 2, h: ta.getBoundingClientRect().height });`));
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 6; i++) await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y + i * 10, button: 'left' });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y + 60, button: 'left', clickCount: 1 });
    const h2 = await js(`return document.querySelector('#root textarea[placeholder^="Details for the AI"]').getBoundingClientRect().height;`);
    ok('dragging the grip down 60px grows the box by 60px', Math.abs(h2 - r.h - 60) <= 2, r.h + ' -> ' + h2);
  }
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

  console.log('\nGemini');
  await js(`window._thVoice.setEdit(true); 1`); await sleep(800);
  await js(`[...document.querySelectorAll('#root button')].find(b => b.textContent.trim() === '+ Add').click(); 1`);
  await sleep(800);
  await setVal(`document.querySelector('#root textarea[placeholder="Enter title..."], #root [placeholder="Enter title..."]')`, 'Plan the Denver trip');
  await js(`[...document.querySelectorAll('#root label')].find(l => /AI prep/.test(l.textContent)).querySelector('input').click(); 1`);
  await sleep(300);
  await js(`[...document.querySelectorAll('#root button')].find(b => b.textContent === 'Gemini').click(); 1`);
  await sleep(200);
  const nG = prepCalls.length;
  await js(`[...document.querySelectorAll('#root button')].find(b => b.textContent.trim().toLowerCase() === 'save').click(); 1`);
  await waitFor(async () => { const x = await docs(); const t = Object.values(x['dashboards/main'].data).flat().find((i) => i && i.title === 'Plan the Denver trip'); return !!(t && ((x['dashboards/tony_taskprep'] || {}).kits || {})[t.id]); });
  const gCall = prepCalls.slice(nG).find((b) => b.task.title === 'Plan the Denver trip');
  ok('a task set to Gemini is prepped for Gemini', gCall && gCall.site === 'gemini' && gCall.profile === 'tony', JSON.stringify(prepCalls.slice(nG)));
  await js(`window._thVoice.setEdit(false); 1`); await sleep(800);
  const gId = (Object.values((await docs())['dashboards/main'].data).flat().find((t) => t && t.title === 'Plan the Denver trip') || {}).id;
  await js(`window.__clip = []; try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__clip.push(t); return Promise.resolve(); } } }); } catch (e) {} 1`);
  const nL2 = bridge.filter((x) => x[1] === '/api/launch').length;
  await js(`document.querySelector('#root [data-th-prep-btn="${gId}"]').click(); 1`);
  await sleep(1200);
  const gl = bridge.filter((x) => x[1] === '/api/launch').slice(nL2)[0];
  const glb = gl ? JSON.parse(gl[2]) : null;
  ok('✦ opens Gemini last, on the bridge', glb && glb.focus === 'https://gemini.google.com/app', JSON.stringify(glb));
  ok('…with the prompt on the clipboard (Gemini takes none from a link)', await js(`return window.__clip.length === 1 && window.__clip[0] === 'PROMPT FOR Tony';`), await js(`return JSON.stringify(window.__clip);`));
  ok('the panel says to paste it', await js(`const p = document.querySelector('[data-th-prep-panel] [data-prep-paste]'); return !!p && /Ctrl\\+V/.test(p.textContent) && /Gemini/.test(p.textContent);`), await js(`const p = document.querySelector('[data-th-prep-panel]'); return p ? p.innerText : 'no panel';`));
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(700);
  await shot('taskprep-panel-gemini-390');
  ok('the Gemini panel fits at 390px', await js(`const b = document.querySelector('[data-th-prep-panel]').getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth + 0.5;`));
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await js(`[...document.querySelectorAll('[data-th-prep-panel] button')].find(b => b.textContent === 'Close').click(); 1`);
  await sleep(400);

  console.log('\nNo bridge: tabs from the page');
  // The bridge is gone (another PC): launches go nowhere, and window.open is
  // the only way. First with pop-ups blocked (one tab per click), then allowed.
  bridgeDown = true;
  const noBridge = `window._thBridgeUp = false; window._thBridgeProbe = function(){ return Promise.resolve(false); }; 1`;
  await js(noBridge);
  await js(`localStorage.removeItem('a1PrepTabs'); window.__opened = []; window.__n = 0; window.open = function(u){ window.__opened.push(u); return (window.__n++ === 0) ? {} : null; }; 1`);
  await js(`document.querySelector('#root [data-th-prep-btn="tonyT1"]').click(); 1`);
  await sleep(800);
  let op = JSON.parse(await js(`return JSON.stringify(window.__opened);`));
  ok('blocked: the assistant opens first (the one tab a click may open)', /^https:\/\/claude\.ai\/new\?q=PROMPT/.test(op[0] || ''), JSON.stringify(op));
  ok('…the sites were tried, and the panel says to allow pop-ups', op.length === 3 && await js(`return !!document.querySelector('[data-th-prep-panel] [data-prep-tabs-blocked]');`), JSON.stringify(op));
  ok('…and nothing is learned', await js(`return localStorage.getItem('a1PrepTabs') === null;`));
  await js(`[...document.querySelectorAll('[data-th-prep-panel] button')].find(b => b.textContent === 'Close').click(); 1`);
  await sleep(300);
  await js(noBridge + `; window.__opened = []; window.open = function(u){ window.__opened.push(u); return {}; }; 1`);
  await js(`document.querySelector('#root [data-th-prep-btn="tonyT1"]').click(); 1`);
  await sleep(800);
  op = JSON.parse(await js(`return JSON.stringify(window.__opened);`));
  ok('allowed: every tab opens (assistant, Gmail draft, portal)', op.length === 3 && op.some((u) => /mail\.google\.com\/mail\/u\/0\/\?fs=1&tf=cm/.test(u)) && op.includes('https://portal.example.com/'), JSON.stringify(op));
  ok('…learned for this browser, and no pop-up hint', await js(`return localStorage.getItem('a1PrepTabs') === '1' && !document.querySelector('[data-th-prep-panel] [data-prep-tabs-blocked]');`));
  await js(`[...document.querySelectorAll('[data-th-prep-panel] button')].find(b => b.textContent === 'Close').click(); 1`);
  await sleep(300);
  await js(noBridge + `; window.__opened = []; 1`);
  await js(`document.querySelector('#root [data-th-prep-btn="tonyT1"]').click(); 1`);
  await sleep(800);
  op = JSON.parse(await js(`return JSON.stringify(window.__opened);`));
  ok('once learned: the sites first and the assistant LAST, so it is the tab in front', op.length === 3 && /^https:\/\/claude\.ai\//.test(op[2]), JSON.stringify(op));
  await js(`[...document.querySelectorAll('[data-th-prep-panel] button')].find(b => b.textContent === 'Close').click(); 1`);
  await sleep(300);

  bridgeDown = false;

  console.log('\nSeparation in the page');
  ok("Tony's default assistant is stored under his key only", await js(`window._thPrepSetDefaultSite('chatgpt'); return localStorage.getItem('thAiSite') === 'chatgpt' && localStorage.getItem('vdAiSite') === null;`));
  ok("Veda's kits in memory hold only hers, Tony's only his", await js(`return Object.keys(window._vdPrepKits).every(k => k.startsWith('veda')) && Object.keys(window._thPrepKits).every(k => !k.startsWith('veda'));`));

  console.log('\nPage health');
  ok('no uncaught exceptions', errs.length === 0, errs.join('\n'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
