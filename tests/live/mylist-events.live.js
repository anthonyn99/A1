// LIVE test -- MyList Events: spans of days (an optional end date), both profiles,
// in a real (headless) browser. Not run by run-all.js.
// Run: node tests/live/mylist-events.live.js        (ML_URL=... to test a local copy)
//
// Firestore is never reached (see cdp.js); the page gets fixture events through
// _mlLoadEvents and every save lands in window.__evSaves.
//
//   1. Old single-day events render unchanged and save with no `end` field.
//   2. Spans render as "March 4 – 6, 2026", "Sep 26 – Oct 2, 2026",
//      "Dec 30, 2025 – Jan 2, 2026" with a day count and a capsule dot.
//   3. The modal has Date + optional End date; the end picker's calendar opens
//      on the start's month and greys out days before it.
//   4. Adding a span saves {date,end}; an end on/before the start saves none;
//      moving the start past the end clears the end; Clear removes a span.
//   5. Veda's side does the same. No page errors.
'use strict';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');

const URL = process.env.ML_URL || 'https://anthonyn99.github.io/A1/mylist.html';
const EVENTS = {
  tony: [
    { id: 'e1', date: '2026-09-26', content: 'Vegas trip' },
    { id: 'e2', date: '2026-03-04', end: '2026-03-06', content: 'Kennesaw trip' },
    { id: 'e3', date: '2025-09-26', end: '2025-10-02', content: 'Cross-month' },
    { id: 'e4', date: '2025-12-30', end: '2026-01-02', content: 'New year' },
    { id: 'e5', date: '2025-06-06', end: '2025-06-06', content: 'Bad same-day end' },
  ],
  veda: [{ id: 'v1', date: '2025-11-28', content: 'Cali trip' }],
};
const BOOT = (prof) => `(()=>{ if(window.top!==window) return;
  try{ localStorage.setItem('ml_fav_profile','${prof}'); localStorage.setItem('ml_view_${prof}','events'); }catch(e){}
  window.__evSaves=[];
  window._mlLoad=()=>Promise.resolve({tony:{lists:[]},veda:{lists:[]},locks:{},lockV:{}});
  window._mlLoadOk=true; window._mlSave=()=>{};
  window._mlLoadEvents=(p)=>Promise.resolve(JSON.parse(${JSON.stringify(JSON.stringify(EVENTS))})[p]||[]);
  window._mlSaveEvents=(p,ev)=>{ window.__evSaves.push({p:p,ev:JSON.parse(JSON.stringify(ev))}); };
  window._mlReady=true;
})();`;

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 200) + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 400) + ']' : '')); }
};
const waitFor = async (c, expr, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await evalJs(c, expr)) return true; } catch {} await sleep(150); }
  return false;
};
const shot = async (c, name) => {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64'));
  console.log('  shot  ' + shotPath(name));
};
const click = async (c, sel) => {
  const p = JSON.parse(await evalJs(c, `return JSON.stringify((()=>{ const b=(${sel}).getBoundingClientRect(); return {x:b.left+b.width/2,y:b.top+b.height/2}; })())`));
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(200);
};
const dateText = (id) => `((document.querySelector('.ev-item[data-id="${id}"] .ev-date')||{}).textContent||'').split(String.fromCharCode(160)).join(' ')`;
const lastSave = `JSON.stringify((window.__evSaves[window.__evSaves.length-1]||{}).ev||null)`;

async function boot(c, prof) {
  const inj = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOT(prof) });
  await c.send('Page.navigate', { url: URL });
  const up = await waitFor(c, `document.getElementById('app').style.display==='flex'`);
  // land on Events whatever the remembered view was
  const ev = await waitFor(c, `return (()=>{ if(document.querySelector('.ev-item')) return true; const t=[...document.querySelectorAll('button,div')].find(e=>e.children.length===0&&e.textContent.trim()==='Events'&&e.offsetParent); if(t) t.click(); return false; })()`, 20000);
  return { inj, up: up && ev };
}

(async () => {
  const c = await connect();
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text); });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 909, height: 1000, deviceScaleFactor: 1, mobile: false });

  // ── Tony ──
  let b = await boot(c, 'tony');
  ok('Tony boots into Events', b.up);
  ok('single day unchanged', /september 26, 2026/i.test(await evalJs(c, dateText('e1'))), await evalJs(c, dateText('e1')));
  ok('same-month span', /march 4 – 6, 2026/i.test(await evalJs(c, dateText('e2'))) && /3 days/.test(await evalJs(c, dateText('e2'))), await evalJs(c, dateText('e2')));
  ok('cross-month span', /sep 26 – oct 2, 2025/i.test(await evalJs(c, dateText('e3'))) && /7 days/.test(await evalJs(c, dateText('e3'))), await evalJs(c, dateText('e3')));
  ok('cross-year span', /dec 30, 2025 – jan 2, 2026/i.test(await evalJs(c, dateText('e4'))) && /4 days/.test(await evalJs(c, dateText('e4'))), await evalJs(c, dateText('e4')));
  ok('same-day end dropped on load', !/–/.test(await evalJs(c, dateText('e5'))), await evalJs(c, dateText('e5')));
  ok('span gets a capsule dot', await evalJs(c, `document.querySelector('.ev-item[data-id="e2"]').classList.contains('span') && !document.querySelector('.ev-item[data-id="e1"]').classList.contains('span') && parseFloat(getComputedStyle(document.querySelector('.ev-item[data-id="e2"]'),'::before').height)>parseFloat(getComputedStyle(document.querySelector('.ev-item[data-id="e1"]'),'::before').height)`));
  ok('search finds a span by its end date', await evalJs(c, `const s=document.getElementById('ev-search'); s.value='march 6'; s.dispatchEvent(new Event('input')); const n=[...document.querySelectorAll('.ev-item')].map(e=>e.dataset.id).join(','); s.value=''; s.dispatchEvent(new Event('input')); return n==='e2'`));
  await shot(c, 'mylist-events-tony-list');

  // edit the span: both pickers filled, end picker opens on March 2026 with earlier days disabled
  await click(c, `document.querySelector('.ev-item[data-id="e2"] .ib')`);
  ok('edit modal shows both dates', await evalJs(c, `document.getElementById('ev-date').value==='2026-03-04' && document.getElementById('ev-end').value==='2026-03-06' && document.getElementById('ev-end').min==='2026-03-04'`));
  await shot(c, 'mylist-events-tony-modal');
  await click(c, `document.getElementById('ev-end')._a1cBtn`);
  ok('end calendar on March 2026, days before start disabled', await evalJs(c, `const p=document.querySelector('.a1c-cal'); if(!p) return false; const t=p.querySelector('.a1c-cal-title').textContent; const c3=[...p.querySelectorAll('.a1c-cell:not(.out)')].find(x=>x.textContent==='3'); return /March 2026/.test(t) && c3 && c3.disabled`));
  await click(c, `[...document.querySelectorAll('.a1c-cal .a1c-cell:not(.out)')].find(x=>x.textContent==='8')`);
  ok('picked Mar 8', await evalJs(c, `document.getElementById('ev-end').value==='2026-03-08'`));
  await click(c, `[...document.querySelectorAll('#ev-modal .btn.solid')][0]`);
  ok('saved span {date,end}', await evalJs(c, `const e=((window.__evSaves.at(-1)||{}).ev||[]).find(x=>x.id==='e2'); return !!e && e.date==='2026-03-04' && e.end==='2026-03-08'`), await evalJs(c, lastSave));
  ok('old events saved without end', await evalJs(c, `const ev=(window.__evSaves.at(-1)||{}).ev||[]; return !('end' in ev.find(x=>x.id==='e1')) && !('end' in ev.find(x=>x.id==='e5'))`));

  // new event: empty end picker opens on the START's month (a past one)
  await click(c, `document.querySelector('.ev-add')`);
  ok('new event: end empty, placeholder', await evalJs(c, `document.getElementById('ev-end').value==='' && /same day/i.test(document.getElementById('ev-end')._a1cBtn.textContent)`));
  await evalJs(c, `const d=document.getElementById('ev-date'); d.value='2025-07-10'; d.dispatchEvent(new Event('change')); return 1`);
  await click(c, `document.getElementById('ev-end')._a1cBtn`);
  ok('empty end calendar opens on start month (Jul 2025)', await evalJs(c, `/July 2025/.test((document.querySelector('.a1c-cal .a1c-cal-title')||{}).textContent||'')`));
  await click(c, `[...document.querySelectorAll('.a1c-cal .a1c-cell:not(.out)')].find(x=>x.textContent==='12')`);
  await waitFor(c, `!document.querySelector('.a1c-cal') && document.getElementById('ev-end').value==='2025-07-12'`, 3000);
  // moving the start past the end clears the end
  await evalJs(c, `const d=document.getElementById('ev-date'); d.value='2025-07-15'; d.dispatchEvent(new Event('change')); return 1`);
  ok('start past end clears end', await evalJs(c, `document.getElementById('ev-end').value===''`));
  await evalJs(c, `document.getElementById('ev-end').value='2025-07-16'; document.getElementById('ev-content').value='Beach weekend'; return 1`);
  await click(c, `[...document.querySelectorAll('#ev-modal .btn.solid')][0]`);
  ok('added span saved', await evalJs(c, `const e=((window.__evSaves.at(-1)||{}).ev||[]).find(x=>x.content==='Beach weekend'); return !!e && e.date==='2025-07-15' && e.end==='2025-07-16'`));
  ok('added span renders', await waitFor(c, `[...document.querySelectorAll('.ev-item')].some(e=>/july 15 – 16, 2025/i.test(e.textContent.split(String.fromCharCode(160)).join(' '))&&/2 days/.test(e.textContent))`, 3000));

  // Clear removes the span
  await click(c, `document.querySelector('.ev-item[data-id="e2"] .ib')`);
  await click(c, `document.getElementById('ev-end')._a1cBtn`);
  await click(c, `[...document.querySelectorAll('.a1c-cal .a1c-link')].find(x=>x.textContent==='Clear')`);
  await click(c, `[...document.querySelectorAll('#ev-modal .btn.solid')][0]`);
  ok('Clear → single day again', await evalJs(c, `const e=((window.__evSaves.at(-1)||{}).ev||[]).find(x=>x.id==='e2'); return !!e && !('end' in e)`));
  await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: b.inj.result.identifier });

  // ── Veda ──
  b = await boot(c, 'veda');
  ok('Veda boots into Events', b.up && (await evalJs(c, `document.body.dataset.profile`)) === 'veda');
  await click(c, `document.querySelector('.ev-add')`);
  await evalJs(c, `const d=document.getElementById('ev-date'); d.value='2026-03-04'; d.dispatchEvent(new Event('change')); document.getElementById('ev-end').value='2026-03-06'; document.getElementById('ev-content').value='Spa days'; return 1`);
  await shot(c, 'mylist-events-veda-modal');
  await click(c, `[...document.querySelectorAll('#ev-modal .btn.solid')][0]`);
  ok('Veda span saved to her doc', await evalJs(c, `const s=window.__evSaves.at(-1)||{}; const e=(s.ev||[]).find(x=>x.content==='Spa days'); return s.p==='veda' && !!e && e.end==='2026-03-06'`));
  ok('Veda span renders', await waitFor(c, `[...document.querySelectorAll('.ev-item')].some(e=>/march 4 – 6, 2026/i.test(e.textContent.split(String.fromCharCode(160)).join(' ')))`, 3000));
  await shot(c, 'mylist-events-veda-list');

  // phone width: dates stack, nothing overflows
  await c.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 760, deviceScaleFactor: 2, mobile: true });
  await click(c, `document.querySelector('.ev-add')`);
  ok('phone: date fields stack, no overflow', await evalJs(c, `const a=document.getElementById('ev-date')._a1cBtn.getBoundingClientRect(), b=document.getElementById('ev-end')._a1cBtn.getBoundingClientRect(); return b.top>a.bottom && document.documentElement.scrollWidth<=360`));
  await shot(c, 'mylist-events-phone-modal');

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
