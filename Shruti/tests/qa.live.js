// LIVE test: Phase 9's polish and QA, in real headless Edge on the real origin
// served from this working copy. Not run by npm test.
//
//   node Shruti/tests/qa.live.js
//
// 1. Empty and error states: no key, a refused key, a key that may not use the
//    ticked units, every unit down, Drive not connected. Each says what is
//    wrong in plain words and, when the fix is in Settings, leads there.
// 2. An accessibility audit of every view and sheet, both profiles, 390 and
//    1280: every control has a name, text meets WCAG AA contrast, controls are
//    at least 24 px (WCAG 2.2 target size; inline verse numbers excepted), the
//    keyboard focus ring shows, ids are unique, nothing scrolls sideways.
// 3. Import's code loads only when Import opens; how long the reader takes.
'use strict';
const path = require('path');
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'cdp.js'));
const { firebaseMock } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'fake-firebase.js'));
const ev = (c, x) => evalJs(c, /^\s*return\b/.test(x) && x.indexOf(';') < 0 ? x + ';' : x);

const URL = 'https://anthonyn99.github.io/A1/Shruti/shruti.html';
const ORCA = 'https://orca.vedapatel05.workers.dev';
const GOOD = 'orca_sk_live_good_key_123', NARROW = 'orca_sk_live_narrow_key_9', BAD = 'orca_sk_live_revoked_key_7';
const ids = ['deepseek/free', 'chatgpt/free', 'gemini_web/free', 'perplexity/free', 'claude/free'];
const MODELS = {
  [GOOD]: ids.map((id) => ({ id, routable: id !== 'gemini_web/free', in_key_scope: true })),
  // A key limited on Orca's Keys page to Claude only.
  [NARROW]: ids.map((id) => ({ id, routable: id === 'claude/free', in_key_scope: id === 'claude/free' })),
};
let chatStatus = 503;
const chats = [];
const mock = firebaseMock({
  patterns: [ORCA + '/*', 'https://shruti-drive.av1-2.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const auth = ((req.headers && (req.headers.Authorization || req.headers.authorization)) || '').replace(/^Bearer /, '');
    if (req.url.startsWith(ORCA + '/v1/models')) return MODELS[auth] ? { json: { object: 'list', data: MODELS[auth] } } : { status: 401, json: { error: { message: 'bad key' } } };
    if (req.url.startsWith(ORCA + '/v1/chat/completions')) {
      chats.push(JSON.parse(req.postData || '{}').model);
      if (!MODELS[auth]) return { status: 401, json: { error: { message: 'bad key' } } };
      return { status: chatStatus, json: { error: { message: 'busy' } } };
    }
    if (req.url.startsWith(ORCA + '/v1/audio/voices')) return { json: { voices: [] } };
    if (req.url.startsWith('https://shruti-drive.av1-2.workers.dev/health')) return { json: { ok: true, configured: true, connected: false, email: null } };
    return null;
  },
});

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  -> ' + String(d).slice(0, 600) : '')); }
};
const waitFor = async (c, expr, ms = 12000) => {
  const t0 = Date.now();
  if (expr.indexOf(';') >= 0 && !/^\s*(return|const|let|var|if|for)\W/.test(expr)) expr = 'return ' + expr;
  while (Date.now() - t0 < ms) { try { if (await ev(c, expr)) return true; } catch {} await sleep(150); }
  return false;
};
const shot = async (c, name) => {
  await sleep(400);
  const r = await Promise.race([c.send('Page.captureScreenshot', { format: 'png' }), sleep(6000).then(() => null)]);
  const data = r && (r.result ? r.result.data : r.data);
  if (data) fs.writeFileSync(shotPath('shruti-' + name), Buffer.from(data, 'base64'));
};
let RUN = String(Date.now());
const BOOT = (store) => `(()=>{ if(window.top!==window) return;
  try{ if(sessionStorage.getItem('__run')!=='${RUN}'){ localStorage.clear(); sessionStorage.clear(); ${store || ''} sessionStorage.setItem('__run','${RUN}'); } }catch(e){}
  window.__errs=[]; addEventListener('error', e=>window.__errs.push(String(e.message)));
  addEventListener('unhandledrejection', e=>window.__errs.push('rejection: '+String(e.reason && e.reason.message || e.reason)));
})();`;
let inj = null;
async function load(c, { w, h, mobile, who, hash = '' }) {
  RUN = String(Date.now());
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  if (inj) await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier });
  inj = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOT(`sessionStorage.removeItem('__fakefs_docs'); sessionStorage.setItem('shruti.pick','${who}');`) });
  await c.send('Page.navigate', { url: 'about:blank' });
  await sleep(150);
  await c.send('Page.navigate', { url: URL + hash });
  await sleep(400);
  await waitFor(c, `!!window.Shruti && window.Shruti.core.me.loaded && window.Shruti.core.shared.loaded`, 15000);
}
const go = async (c, hash, until) => { await ev(c, `location.hash=${JSON.stringify(hash)}; return 1`); return waitFor(c, until); };
const setKey = (c, k) => ev(c, `window.Shruti.orca.forget(); window.Shruti.core.me.set({orcaKey:${k ? JSON.stringify(k) : 'window.Shruti.core.DELETE'}},{now:true}); return 1`);
const closeSheets = (c) => ev(c, `document.querySelectorAll('.sheet-dim').forEach(d=>d.remove()); return 1`);

/* ── the audit, run inside the page ─────────────────────────────────────── */
const AUDIT = `
const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
const rgba = (c) => { cx.clearRect(0,0,1,1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0,0,1,1); const d = cx.getImageData(0,0,1,1).data; return [d[0], d[1], d[2], d[3] / 255]; };
const over = (a, b) => [a[0]*a[3] + b[0]*(1-a[3]), a[1]*a[3] + b[1]*(1-a[3]), a[2]*a[3] + b[2]*(1-a[3]), 1];
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); const b = rgba(s.backgroundColor); if (b[3] > 0) stack.push(b); if (b[3] >= 1) break; if (s.backgroundImage !== 'none' && /gradient/.test(s.backgroundImage)) return null; } let c = rgba(getComputedStyle(document.body).backgroundColor); if (c[3] < 1) c = [0,0,0,1]; for (let i = stack.length - 1; i >= 0; i--) c = over(stack[i], c); return c; };
const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0 || e.hidden || e.getAttribute('aria-hidden') === 'true') return false; } return true; };
const scope = document.querySelector('.sheet-dim:last-of-type') || document.querySelector('#picker:not([hidden])') || document.body;
const nameOf = (el) => { const l = el.getAttribute('aria-label'); if (l && l.trim()) return l.trim(); const lb = el.getAttribute('aria-labelledby'); if (lb) return lb.split(' ').map((i) => (document.getElementById(i) || {}).textContent || '').join(' ').trim(); if (el.labels && el.labels.length) return [...el.labels].map((x) => x.textContent).join(' ').trim(); const t = (el.textContent || '').trim(); if (t) return t; if (el.title) return el.title; if (el.placeholder) return el.placeholder; const img = el.querySelector('img[alt]'); return img ? img.alt : ''; };
const desc = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') + ' "' + (el.textContent || '').trim().slice(0, 30) + '"';
const controls = [...scope.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=checkbox], [role=radio], [role=tab], [tabindex]:not([tabindex="-1"])')].filter(vis);
const unnamed = controls.filter((el) => !nameOf(el)).map(desc);
const small = controls.filter((el) => { if (el.closest('.rd') || el.closest('p, li') && getComputedStyle(el).display === 'inline') return false; const lab = el.closest('label'); const r = (lab && el.matches('input') ? lab : el).getBoundingClientRect(); return r.width < 24 || r.height < 24; }).map((el) => { const r = el.getBoundingClientRect(); return desc(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); });
const lowc = [];
const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
const seen = new Set();
for (let n = walker.nextNode(); n; n = walker.nextNode()) {
  const el = n.parentElement; if (!el || seen.has(el) || !n.textContent.trim() || !vis(el)) continue; seen.add(el);
  if (el.closest('button[disabled], [aria-disabled=true], .off, del, s, canvas, svg, .sheet-dim:not(:last-of-type)')) continue;
  const s = getComputedStyle(el), bg = bgOf(el); if (!bg) continue;
  let fg = rgba(s.color); let op = 1; for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity); fg = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
  const px = parseFloat(s.fontSize), big = px >= 24 || (px >= 18.66 && Number(s.fontWeight) >= 700);
  const r = ratio(fg, bg);
  if (r < (big ? 3 : 4.5)) lowc.push(desc(el) + ' ' + r.toFixed(2) + ' (' + s.color + ' on ' + bg.slice(0, 3).map(Math.round).join(',') + ')');
}
const idc = {}; document.querySelectorAll('[id]').forEach((e) => { idc[e.id] = (idc[e.id] || 0) + 1; });
const dupes = Object.keys(idc).filter((k) => idc[k] > 1);
return JSON.stringify({ n: controls.length, unnamed, small, lowc, dupes, wide: document.documentElement.scrollWidth > innerWidth + 1 ? document.documentElement.scrollWidth : 0 });`;
async function audit(c, label) {
  const r = JSON.parse(await ev(c, AUDIT));
  ok(label + ': ' + r.n + ' controls, every one named', !r.unnamed.length, r.unnamed.join(' | '));
  ok(label + ': text meets AA contrast', !r.lowc.length, r.lowc.slice(0, 8).join(' | '));
  ok(label + ': controls are at least 24 px', !r.small.length, r.small.slice(0, 8).join(' | '));
  ok(label + ': ids unique, no sideways scroll', !r.dupes.length && !r.wide, JSON.stringify({ dupes: r.dupes, wide: r.wide }));
  return r;
}

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  // A view transition can stall a headless tab: none here.
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

  /* ── 1. error states ── */
  console.log('\nError states (Tony, 1280)');
  // On Listen, Make with AI makes a podcast (each tab makes its own kind).
  await load(c, { w: 1280, h: 900, mobile: false, who: 'tony', hash: '#/b/gita/4/listen' });
  ok('chapter 4 opens', await waitFor(c, `!!document.getElementById('make-ai')`));
  ok('Import is not loaded yet', await ev(c, `return !performance.getEntriesByType('resource').some(r=>/\\/(import|extract)\\.js/.test(r.name))`));

  // No key.
  await ev(c, `document.getElementById('make-ai').click(); return 1`);
  ok('no key: Make with AI says so before anything is pressed', await waitFor(c, `/Your Orca key is needed/.test(document.querySelector('#gen-run .ai-prob')?.textContent||'')`));
  await ev(c, `document.querySelector('#gen-run [data-make]').click(); return 1`);
  await sleep(400);
  ok('…pressing Make sends nothing to Orca', chats.length === 0);
  await ev(c, `document.querySelector('#gen-run [data-ai-settings]').click(); return 1`);
  ok('…and Open Settings opens Settings on the Orca key', await waitFor(c, `!!document.getElementById('settings') && !document.getElementById('gen-sheet') && /No key yet/.test(document.getElementById('orca-stat').textContent)`));
  await shot(c, 'qa-nokey-settings-1280');
  await closeSheets(c);

  // A key Orca refuses.
  await setKey(c, BAD);
  await ev(c, `document.getElementById('make-ai').click(); return 1`);
  await waitFor(c, `!!document.querySelector('#gen-run [data-make]')`);
  await ev(c, `document.querySelector('#gen-run [data-make]').click(); return 1`);
  ok('a refused key: "Orca rejected your key", with the way to fix it', await waitFor(c, `/Orca rejected your key/.test(document.querySelector('#gen-run .ai-prob')?.textContent||'') && !!document.querySelector('#gen-run [data-ai-settings]')`),
    await ev(c, `return document.getElementById('gen-run').textContent`));
  ok('…and no chat was sent with it', chats.length === 0, chats.join());
  await closeSheets(c);
  await ev(c, `window.Shruti.openSettings(); return 1`);
  ok('Settings says the key was rejected and why', await waitFor(c, `/Orca rejected this key: it may have been deleted/.test(document.getElementById('orca-stat').textContent)`));
  await closeSheets(c);

  // A key limited to units that are not ticked.
  await setKey(c, NARROW);
  await ev(c, `window.Shruti.openSettings(); return 1`);
  ok('Settings marks units this key may not use (not "offline")', await waitFor(c, `const st=[...document.querySelectorAll('#unit-list .unit')].map(u=>u.querySelector('.nm').textContent+':'+u.querySelector('.st').textContent); return st.includes('DeepSeek:not allowed on this key') && st.includes('Claude:ready')`),
    await ev(c, `return [...document.querySelectorAll('#unit-list .unit')].map(u=>u.textContent).join(' | ')`));
  await shot(c, 'qa-scope-settings-1280');
  await closeSheets(c);
  await ev(c, `document.getElementById('make-ai').click(); return 1`);
  ok('Make with AI names the units the key may not use', await waitFor(c, `/DeepSeek, ChatGPT, Gemini and Perplexity are not allowed on this key/.test(document.querySelector('#gen-run .ai-prob')?.textContent||'')`),
    await ev(c, `return document.getElementById('gen-run').textContent`));
  ok('…and its unit chips say so too', await ev(c, `return document.querySelector('#gen-opts [data-unit="deepseek/free"]').getAttribute('aria-label')==='DeepSeek, not allowed on this key'`));
  await shot(c, 'qa-scope-make-1280');
  await closeSheets(c);

  // Every unit down.
  await setKey(c, GOOD);
  chatStatus = 502;
  await ev(c, `location.hash='#/b/gita/4/lessons'; return 1`);
  await waitFor(c, `location.hash.endsWith('/lessons') && !!document.getElementById('make-ai')`);
  await sleep(400);
  await ev(c, `document.getElementById('make-ai').click(); return 1`);
  await waitFor(c, `!!document.querySelector('#gen-run [data-make]') && !document.querySelector('#gen-run .ai-prob')`);
  await ev(c, `document.querySelector('#gen-run [data-make]').click(); return 1`);
  ok('every unit down: "No unit could answer just now", each named', await waitFor(c, `const t=document.querySelector('#gen-run .ai-prob')?.textContent||''; return /No unit could answer just now/.test(t) && /DeepSeek offline/.test(t) && /Perplexity offline/.test(t)`, 30000),
    await ev(c, `return document.getElementById('gen-run').textContent`));
  ok('…Gemini (offline on Orca) was not even asked', !chats.includes('gemini_web/free') && chats.includes('deepseek/free'), chats.join());
  ok('…and Try again is offered', await ev(c, `return !!document.querySelector('#gen-run [data-again]')`));
  await shot(c, 'qa-down-make-1280');
  await closeSheets(c);

  // Study: no key.
  await setKey(c, null);
  ok('Study opens', await go(c, '#/b/gita/4/study', `!!document.querySelector('.sh-make, [data-make]')`));
  await ev(c, `document.querySelector('.sh-make, [data-make]').click(); return 1`);
  ok('Make a study set says the key is needed, with Open Settings', await waitFor(c, `/Your Orca key is needed/.test(document.querySelector('#sm-run .ai-prob')?.textContent||'') && !!document.querySelector('#sm-run [data-ai-settings]')`));
  await closeSheets(c);

  // Drive not connected: saving a narration in another voice.
  await setKey(c, GOOD);
  await ev(c, `window.Shruti.core.me.set({'narration.voice':'en-US-AndrewMultilingualNeural'},{now:true}); return 1`);
  await go(c, '#/b/gita/4', `!!document.querySelector('.rd [data-voice], [data-voice]')`);
  await ev(c, `document.querySelector('[data-voice]').click(); return 1`);
  ok('Drive not connected: Save narration says so, and is off', await waitFor(c, `/Google Drive is not connected/.test(document.getElementById('ra-save')?.textContent||'') && document.getElementById('ra-save-btn').disabled && !!document.querySelector('#ra-save [data-ra-drive]')`),
    await ev(c, `return document.getElementById('ra-save')?.textContent`));
  await ev(c, `document.querySelector('#ra-save [data-ra-drive]').click(); return 1`);
  ok('…its button opens Settings at Google Drive', await waitFor(c, `!!document.getElementById('st-drive') && /Not connected/.test(document.getElementById('st-drive').textContent)`));
  await closeSheets(c);
  await ev(c, `window.Shruti.core.me.set({'narration.voice':'en-US-AvaMultilingualNeural'},{now:true}); return 1`);

  // Import loads when it opens.
  await go(c, '#/', `!!document.querySelector('[data-import]')`);
  await ev(c, `document.querySelector('[data-import]').click(); return 1`);
  ok('Import loads its code when it opens, and opens', await waitFor(c, `!!document.querySelector('.sheet-dim .imp, .sheet-dim [data-paste], .sheet-dim input[type=file]') && performance.getEntriesByType('resource').some(r=>/\\/import\\.js/.test(r.name))`));
  await closeSheets(c);
  ok('no page errors', !(await ev(c, `return (window.__errs||[]).join(' | ')`)), await ev(c, `return (window.__errs||[]).join(' | ')`));

  /* ── 2. accessibility, both profiles ── */
  for (const [who, w, h, mobile] of [['tony', 1280, 900, false], ['veda', 390, 844, true], ['tony', 390, 844, true], ['veda', 1280, 900, false]]) {
    console.log('\nAccessibility: ' + who + ' at ' + w);
    await load(c, { w, h, mobile, who });
    await setKey(c, GOOD);
    await waitFor(c, `!!document.querySelector('.book')`);
    await audit(c, 'library');
    await go(c, '#/b/gita', `document.querySelectorAll('.ch').length===18`); await audit(c, 'book');
    for (const md of ['read', 'listen', 'watch', 'study', 'lessons']) {
      await go(c, '#/b/gita/2' + (md === 'read' ? '' : '/' + md), `!!document.querySelector('.modes [data-mode=${md}].on, .modes [data-mode=${md}][aria-selected=true]') || (location.hash.endsWith('/2${md === 'read' ? '' : '/' + md}') && document.querySelector('#view').textContent.length>200)`);
      await sleep(600);
      await audit(c, 'chapter 2 ' + md);
    }
    await go(c, '#/b/gita/2', `!!document.getElementById('make-ai')`);
    await ev(c, `window.Shruti.openSettings(); return 1`); await waitFor(c, `!!document.querySelector('#unit-list .unit .st.ok')`);
    await audit(c, 'Settings'); if (w === 390) await shot(c, 'qa-settings-' + who + '-390');
    await closeSheets(c);
    await ev(c, `document.getElementById('make-ai').click(); return 1`); await waitFor(c, `!!document.querySelector('#gen-run [data-make]')`);
    await audit(c, 'Make with AI');
    await closeSheets(c);
    await ev(c, `document.querySelector('[data-voice]').click(); return 1`); await waitFor(c, `!!document.getElementById('ra-save-btn')`);
    await audit(c, 'read-aloud sheet');
    await closeSheets(c);
    // The keyboard focus ring: Tab onto the first control of the page.
    await ev(c, `document.activeElement && document.activeElement.blur(); return 1`);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    ok('the keyboard focus ring shows', await waitFor(c, `const e=document.activeElement; if(!e||e===document.body) return false; const s=getComputedStyle(e); return e.matches(':focus-visible') && ((s.outlineStyle!=='none' && parseFloat(s.outlineWidth)>=1.5) || /\\d+px\\s+\\d+px/.test(s.boxShadow) && s.boxShadow!=='none')`, 3000),
      await ev(c, `const e=document.activeElement; const s=getComputedStyle(e); return (e&&e.outerHTML.slice(0,80))+' | '+s.outline+' | '+s.boxShadow`));
  }

  /* ── 3. the reader's speed ── */
  console.log('\nPerformance');
  await load(c, { w: 1280, h: 900, mobile: false, who: 'tony', hash: '#/' });
  const ms = JSON.parse(await ev(c, `const t0=performance.now(); location.hash='#/b/gita/2'; await new Promise(r=>{ const f=()=>document.querySelector('.rd [data-b]')?r():requestAnimationFrame(f); f(); }); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); return JSON.stringify({ms:Math.round(performance.now()-t0), blocks:document.querySelectorAll('.rd [data-b]').length})`));
  console.log('  chapter 2 (' + ms.blocks + ' blocks) painted in ' + ms.ms + ' ms');
  ok('the longest chapter opens in under a second', ms.ms < 1000, ms.ms);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
