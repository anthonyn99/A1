// Scratch: Veda's editor with the AI prep note grip + Gemini (deleted after use).
'use strict';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');
const fs = require('fs');
const ORIGIN = 'https://anthonyn99.github.io';
const pad = (n) => ('0' + n).slice(-2);
const now = new Date();
const TODAY = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
(async () => {
  const fb = firebaseMock();
  const mock = { patterns: [...fb.patterns, 'http://127.0.0.1:8781/*', 'https://personal-ai.av1.workers.dev/*'],
    handle(r) { if (r.url.startsWith('http://127.0.0.1:8781') || r.url.startsWith('https://personal-ai')) return { status: 502, text: 'x' }; return fb.handle(r); } };
  const c = await connect({ mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const js = (e) => evalJs(c, e);
  const W = +(process.argv[2] || 1280);
  await c.send('Emulation.setDeviceMetricsOverride', { width: W, height: W < 700 ? 844 : 1000, deviceScaleFactor: 1, mobile: W < 700 });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); localStorage.setItem('td6_mainDash','veda'); localStorage.setItem('td6_lastDash','veda'); localStorage.setItem('a1b_disabled','1');
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/vedasdash': { data: { ${JSON.stringify(TODAY)}: [] }, habits: [], hc: {}, goals: [], monthlyGoals: [], savedAt: 1 } })); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  await sleep(10000);
  await js("var l=document.getElementById('th-boot-loader'); if(l) l.remove(); if(window._profileGoVeda) window._profileGoVeda(); 1");
  await sleep(2500);
  if (window) {}
  const btns = await js(`return JSON.stringify([...document.querySelectorAll('button')].filter(b => b.offsetParent).map(b => b.textContent.trim()).filter(Boolean).slice(0, 60));`);
  console.log(btns);
  await js(`window._vdVoice && window._vdVoice.setEdit && window._vdVoice.setEdit(true); 1`); await sleep(800);
  const clicked = await js(`const b = [...document.querySelectorAll('button')].filter(b => b.offsetParent).find(b => /^\\+\\s*Add/i.test(b.textContent.trim())); if (b) { b.click(); return b.textContent; } return 'none';`);
  console.log('clicked', clicked);
  await sleep(800);
  await js(`const l = [...document.querySelectorAll('label')].find(l => /AI prep/i.test(l.textContent)); if (l) { l.querySelector('input').click(); l.scrollIntoView({ block: 'center' }); } 1`);
  await sleep(600);
  console.log('grip', await js(`const ta = document.querySelector('textarea[placeholder^="Details for the AI"]'); return !!ta && !!ta.parentElement.querySelector('.a1-grip') && getComputedStyle(ta).resize + ' ' + getComputedStyle(ta.parentElement.querySelector('.a1-grip')).color;`));
  console.log('gemini', await js(`return [...document.querySelectorAll('button')].some(b => b.textContent === 'Gemini');`));
  console.log('fits', await js(`const ta = document.querySelector('textarea[placeholder^="Details for the AI"]'); const r = ta.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth;`));
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath('vd-prep-editor-' + W), Buffer.from(r.result.data, 'base64'));
  console.log('errors', errs);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
