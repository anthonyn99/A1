// LIVE test: Shruti's shell (Phase 2) in real headless Edge, on its real origin
// (https://anthonyn99.github.io/A1/Shruti/shruti.html served from this working
// copy), both profiles, at 390 and 1280 px. Not run by npm test.
//
//   node Shruti/tests/shell.live.js            (CDP_ALLOW_FONTS=1 for real typefaces)
//
// Nothing real is reached: Firebase is tests/live/fake-firebase.js, Guardian's
// lock check says "no locks", and Orca and the Drive worker are answered here.
// Screenshots go to %TEMP%\magi-live-shots\shruti-*.png.
'use strict';
const path = require('path');
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'cdp.js'));
const { firebaseMock } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'fake-firebase.js'));
const ev = (c, x) => evalJs(c, /^\s*return\b/.test(x) && x.indexOf(';') < 0 ? x + ';' : x);

const URL = 'https://anthonyn99.github.io/A1/Shruti/shruti.html';
const KEY = 'orca_sk_live_test_key_123';
const MODELS = [
  { id: 'deepseek/free', routable: true }, { id: 'chatgpt/free', routable: true }, { id: 'gemini_web/free', routable: false },
  { id: 'perplexity/free', routable: true }, { id: 'claude/free', routable: true },
];
const orcaCalls = [];
const mock = firebaseMock({
  patterns: ['https://orca.vedapatel05.workers.dev/*', 'https://shruti-drive.av1-2.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    if (req.url.startsWith('https://orca.vedapatel05.workers.dev/v1/models')) {
      const auth = (req.headers && (req.headers.Authorization || req.headers.authorization)) || '';
      orcaCalls.push(auth);
      return auth === 'Bearer ' + KEY ? { json: { object: 'list', data: MODELS } } : { status: 401, json: { error: 'bad key' } };
    }
    if (req.url.startsWith('https://shruti-drive.av1-2.workers.dev/health')) return { json: { ok: true, configured: true, connected: false, email: null } };
    return null;
  },
});

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  -> ' + String(d).slice(0, 400) : '')); }
};
const waitFor = async (c, expr, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(c, expr)) return true; } catch {} await sleep(150); }
  return false;
};
const shot = async (c, name) => {
  await sleep(800);   // view transitions and toasts settle
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const data = r && (r.result ? r.result.data : r.data);
  if (data) fs.writeFileSync(shotPath('shruti-' + name), Buffer.from(data, 'base64'));
};
const RUN = String(Date.now());
// The slate is wiped once per run, not on the reloads the page itself makes.
const BOOT = (store) => `(()=>{ if(window.top!==window) return;
  ${store ? `try{ if(sessionStorage.getItem('__run')!=='${RUN}'){ localStorage.clear(); sessionStorage.clear(); ${store} sessionStorage.setItem('__run','${RUN}'); } }catch(e){}` : ''}
  window.__errs=[]; addEventListener('error', e=>window.__errs.push(String(e.message)));
  addEventListener('unhandledrejection', e=>window.__errs.push('rejection: '+String(e.reason && e.reason.message || e.reason)));
})();`;
let inj = null;
async function load(c, { w, h, mobile, store, hash = '' }) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  if (inj) await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier });
  inj = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOT(store) });
  await c.send('Page.navigate', { url: URL + hash });
  await sleep(400);
}

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  // A clean origin: the fake Firestore keeps its store in sessionStorage.
  await load(c, { w: 1280, h: 860, mobile: false, store: "sessionStorage.removeItem('__fakefs_docs');" });

  console.log('\nNobody chosen: the picker, and nothing reaches Firestore');
  ok('the picker shows both people', await waitFor(c, `!document.getElementById('picker').hidden && document.querySelectorAll('.pk-card').length===2`));
  ok('the app stays hidden', await ev(c, `return document.getElementById('app').hidden`));
  ok('Firestore was not started', await ev(c, `return !window.__fakeFs || !Object.keys(window.__fakeFs.docs||{}).some(k=>/shruti/.test(k))`));
  await shot(c, 'picker-1280');

  console.log('\nTony');
  await ev(c, `document.querySelector('.pk-card.tony').click(); return 1`);
  ok('choosing Tony opens his Shruti (one reload)', await waitFor(c, `window.SHRUTI_PROFILE==='tony' && !document.getElementById('app').hidden && !!document.querySelector('.book')`));
  ok("his look: MAGI purple, Manrope headings, MAGI hover", await ev(c, `return getComputedStyle(document.body).getPropertyValue('--ac').trim()==='#c0aeea' && /Manrope/.test(getComputedStyle(document.querySelector('.lib-hero h1')).fontFamily) && document.body.dataset.hoverfx==='magi'`));
  ok('the header mark is the Heard book', await ev(c, `return !!document.querySelector('#top .a1-app-ic[data-a1-filled="shruti"] svg')`));
  ok('the profile button is his fleur-de-lis in a ring', await ev(c, `const a=document.querySelector('#switch-btn .pf-av'); return !!(a && a.querySelector('svg')) && parseFloat(getComputedStyle(a).borderTopWidth)>=1 && getComputedStyle(a).borderRadius==='50%'`),
    await ev(c, `const a=document.querySelector('#switch-btn'); const s=a.querySelector('.pf-av'); return a.innerHTML.slice(0,80)+' | '+(s&&getComputedStyle(s).borderTopWidth+' '+getComputedStyle(s).borderRadius)`));
  ok('Library and Continue stay put while the sync pill changes', await ev(c, `const n=document.querySelector('#top .tnav'), pill=document.getElementById('sync-pill'); const x=()=>n.getBoundingClientRect().left; const xs=[]; for (const k of ['idle','busy','ok','err','idle']) { A1Head.sync(pill,k); xs.push(x()); } return xs.every(v=>v===xs[0]) && pill.getBoundingClientRect().left>=n.getBoundingClientRect().right`));
  ok('LifeHub sits in the header', await ev(c, `return !!document.querySelector('#top a1-lifehub')`));
  ok('the Gita is on the Shared shelf with its progress bar', await ev(c, `return document.querySelector('#shelf-shared .book .bk-t').textContent==='Bhagavad-Gita' && !!document.querySelector('.bk-bar i')`));
  ok('his document is dashboards/shruti, read after the unlock', await waitFor(c, `return window.Shruti.core.me.loaded && window.Shruti.core.me.path==='dashboards/shruti'`));
  await shot(c, 'tony-library-1280');

  await ev(c, `document.querySelector('.book').click(); return 1`);
  ok('the book lists 18 chapters with rings and mode badges', await waitFor(c, `document.querySelectorAll('.ch').length===18 && document.querySelectorAll('.ch .ring').length===18 && document.querySelectorAll('.ch .bdg').length===72`));
  ok('Read, Watch and Study are available on every chapter', await waitFor(c, `[...document.querySelectorAll('.ch .badges')].every(x=>x.children[0].classList.contains('av') && x.children[2].classList.contains('av') && x.children[3].classList.contains('av'))`));
  await shot(c, 'tony-book-1280');

  await ev(c, `document.querySelectorAll('.ch')[1].click(); return 1`);
  ok('chapter 2 opens on Read with five modes', await waitFor(c, `location.hash==='#/b/gita/2' && document.querySelectorAll('.modes button').length===5 && !!document.querySelector('.rd p')`));
  const ch2 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'books', 'gita', 'ch02.json'), 'utf8'));
  const firstP = ch2.blocks.find((b) => b.k === 'p');
  const sample = firstP.s[0].t;
  ok('the reader shows the source text exactly', await ev(c, `return document.querySelector('.rd').textContent.includes(${JSON.stringify(sample)})`), sample);
  ok('verse 2.11 is there', await ev(c, `return [...document.querySelectorAll('.rd .vn')].some(v=>v.textContent==='2.11')`));
  ok('key verses are marked', await ev(c, `return document.querySelectorAll('.rd .key').length>0`));
  ok('the breadcrumb names the book and chapter', await ev(c, `return document.getElementById('crumbs').textContent.replace(/\\s+/g,' ').includes('Bhagavad-Gita/Chapter 2')`));
  await shot(c, 'tony-chapter-1280');

  // Read to the end: the ring fills and the person's doc records it.
  await ev(c, `scrollTo(0, document.body.scrollHeight); dispatchEvent(new Event('scroll')); return 1`);
  await sleep(300);
  await ev(c, `return window.Shruti.core.me.flush()`);
  ok('reading to the end marks chapter 2 read, in his doc', await waitFor(c, `const d=window.__fakeFs.docs['dashboards/shruti']; return !!(d && d.progress && d.progress.gita && d.progress.gita.ch2 && d.progress.gita.ch2.done===true && d.progress.gita.ch2.modes.read===1)`),
    await ev(c, `return JSON.stringify(window.__fakeFs.docs['dashboards/shruti'])`));
  ok('the header button then offers "Mark as unread"', await ev(c, `return /Mark as unread/.test(document.getElementById('mark-read').textContent)`));
  await ev(c, `document.getElementById('mark-read').click(); return 1`);
  await ev(c, `return window.Shruti.core.me.flush()`);
  ok('marking it unread clears it in his doc (no longer read)', await waitFor(c, `const g=window.__fakeFs.docs['dashboards/shruti'].progress.gita.ch2; return g.done===false && g.f===0 && g.modes.read===0`) &&
    await ev(c, `return /Mark as read/.test(document.getElementById('mark-read').textContent)`));
  await ev(c, `document.getElementById('mark-read').click(); return 1`);
  await ev(c, `return window.Shruti.core.me.flush()`);
  ok('…and "Mark as read" sets it back', await waitFor(c, `window.__fakeFs.docs['dashboards/shruti'].progress.gita.ch2.done===true`));
  ok('…and where he is (last)', await ev(c, `const d=window.__fakeFs.docs['dashboards/shruti']; return d.last && d.last.book==='gita' && d.last.n===2`));

  await ev(c, `document.querySelector('.modes [data-mode=lessons]').click(); return 1`);
  ok('Lessons shows all 12 of chapter 2', await waitFor(c, `location.hash==='#/b/gita/2/lessons' && document.querySelectorAll('.ls-i').length===12`));
  await ev(c, `document.querySelector('.modes [data-mode=study]').click(); return 1`);
  ok('Study opens the ready-made set (study.live.js tests it in full)', await waitFor(c, `location.hash==='#/b/gita/2/study' && document.querySelectorAll('.sh-kind').length===4`));

  console.log('\nAnother device moves on');
  await ev(c, `location.hash='#/b/gita'; return 1`);
  await waitFor(c, `document.querySelectorAll('.ch').length===18`);
  await ev(c, `window.__fakeFs.remote('dashboards/shruti', {progress:{gita:{ch3:{f:1,done:true}}}}, {merge:true}); return 1`);
  ok("its progress shows here with no reload (chapter 3's ring fills)", await waitFor(c, `document.querySelectorAll('.ch')[2].querySelector('.ring').classList.contains('done')`));
  ok('chapters 2 and 3 count as finished', await ev(c, `return /2 finished/.test(document.querySelector('.bk-head .stats').textContent.replace(/\\s+/g,' '))`));

  console.log('\nSettings: the Orca key and AI units');
  await ev(c, `document.getElementById('settings-btn').click(); return 1`);
  ok('Settings opens with Orca, units, Drive and profile', await waitFor(c, `!!document.querySelector('#settings #st-orca') && /Not connected/.test(document.getElementById('st-drive').textContent)`));
  ok('no key yet says AI is off', await ev(c, `return /No key yet/.test(document.getElementById('orca-stat').textContent)`));
  await ev(c, `const i=document.getElementById('orca-key'); i.value='orca_sk_wrong_key_0000'; document.getElementById('orca-save').click(); return 1`);
  ok('a wrong key is refused and not saved', await waitFor(c, `/rejected/.test(document.getElementById('orca-stat').textContent)`) && await ev(c, `return !window.Shruti.core.me.get('orcaKey')`));
  await ev(c, `const i=document.getElementById('orca-key'); i.value=${JSON.stringify(KEY)}; document.getElementById('orca-save').click(); return 1`);
  ok('the right key is checked live and saved to his doc', await waitFor(c, `/Working · 4 of 5 models ready/.test(document.getElementById('orca-stat').textContent)`) &&
    await waitFor(c, `const d=window.__fakeFs.docs['dashboards/shruti']; return d && d.orcaKey===${JSON.stringify(KEY)}`));
  ok('Orca was asked with the key as a bearer token', orcaCalls.includes('Bearer ' + KEY));
  ok('the units show ready / offline from Orca; Claude unticked', await ev(c, `const u=[...document.querySelectorAll('.unit')]; const g=u.find(x=>x.dataset.dkey==='gemini_web/free'); const cl=u.find(x=>x.dataset.dkey==='claude/free'); return u.length===5 && /offline/.test(g.textContent) && !cl.classList.contains('on')`));
  await ev(c, `document.querySelector('.unit[data-dkey="claude/free"] .tick').click(); return 1`);
  await ev(c, `return window.Shruti.core.me.flush()`);
  ok('ticking Claude is saved to his doc', await waitFor(c, `const d=window.__fakeFs.docs['dashboards/shruti']; return d.units && d.units.on && d.units.on['claude/free']===true`));
  ok('Drive offers the connect button once a key exists', await waitFor(c, `!!document.getElementById('drive-act')`));
  await shot(c, 'tony-settings-1280');
  await ev(c, `document.querySelector('#settings [data-close]').click(); return 1`);

  console.log('\nTony on a phone (390)');
  await load(c, { w: 390, h: 844, mobile: true, hash: '#/b/gita' });
  ok('the book opens straight away (he was here last)', await waitFor(c, `document.querySelectorAll('.ch').length===18`));
  ok('the bottom nav shows; the desktop tabs and crumbs hide', await ev(c, `return getComputedStyle(document.querySelector('.bnav')).display==='flex' && getComputedStyle(document.querySelector('#top .tnav')).display==='none'`));
  ok('nothing scrolls sideways', await ev(c, `return document.documentElement.scrollWidth<=innerWidth`), await ev(c, `return document.documentElement.scrollWidth+' > '+innerWidth`));
  ok('touch targets are at least 44px', await ev(c, `return [...document.querySelectorAll('#top .ib')].every(b=>b.getBoundingClientRect().height>=44)`));
  await shot(c, 'tony-book-390');
  await ev(c, `window.Shruti.player.show({title:'Chapter 2 · Spiritual knowledge', sub:'Read-aloud'}); return 1`);
  await sleep(700);   // its slide-in has settled
  ok('the mini-player sits above the bottom nav', await ev(c, `const m=document.querySelector('#mini .mp').getBoundingClientRect(), n=document.querySelector('.bnav').getBoundingClientRect(); return m.bottom<=n.top+1 && m.height>40`));
  await shot(c, 'tony-mini-390');
  await ev(c, `window.Shruti.player.hide(); location.hash='#/b/gita/2'; return 1`);
  await waitFor(c, `!!document.querySelector('.rd p')`);
  ok('the chapter reads at phone width with no sideways scroll', await ev(c, `return document.documentElement.scrollWidth<=innerWidth`));
  ok('all five modes fit across the phone', await ev(c, `const m=document.querySelector('.modes'); return m.scrollWidth<=m.clientWidth && [...m.children].every(b=>b.getBoundingClientRect().right<=innerWidth)`));
  await shot(c, 'tony-chapter-390');

  console.log('\nVeda');
  await ev(c, `document.getElementById('switch-btn').click(); return 1`);
  ok('the profile button brings back the picker', await waitFor(c, `!document.getElementById('picker').hidden`));
  await ev(c, `document.querySelector('.pk-card.veda').click(); return 1`);
  ok("choosing Veda reloads into hers, on the same page", await waitFor(c, `window.SHRUTI_PROFILE==='veda' && !document.getElementById('app').hidden && !!document.querySelector('.rd p')`));
  await ev(c, `location.hash='#/'; return 1`);
  await waitFor(c, `!!document.querySelector('.book')`);
  ok('her look: StudyOS purple, Lora headings, Nunito body, classic hover', await ev(c, `return getComputedStyle(document.body).getPropertyValue('--ac').trim()==='#A892B0' && /Lora/.test(getComputedStyle(document.querySelector('.lib-hero h1')).fontFamily) && /Nunito/.test(getComputedStyle(document.body).fontFamily) && !document.body.dataset.hoverfx`));
  ok('her profile button is her star in a ring', await ev(c, `const a=document.querySelector('#switch-btn .pf-av'); return a && !!a.querySelector('svg path') && getComputedStyle(a).borderRadius==='50%' && (()=>{const r=a.getBoundingClientRect(), q=a.querySelector('svg').getBoundingClientRect(); return Math.abs((r.left+r.right)/2-(q.left+q.right)/2)<1 && Math.abs((r.top+r.bottom)/2-(q.top+q.bottom)/2)<1})()`));
  ok('her tab icon is her colour', await ev(c, `return /%23A892B0/.test(document.querySelector('link[rel=icon]').href)`));
  ok('her document is dashboards/shruti_veda', await waitFor(c, `return window.Shruti.core.me.loaded && window.Shruti.core.me.path==='dashboards/shruti_veda'`));
  ok("Tony's progress is not hers (the shelf bar is empty)", await ev(c, `return parseFloat(document.querySelector('.bk-bar i').style.width)===0`), await ev(c, `return document.querySelector('.bk-bar i').style.width+' '+JSON.stringify(window.__fakeFs.docs['dashboards/shruti_veda'])`));
  ok("…and neither is his key", await ev(c, `return !window.Shruti.core.me.get('orcaKey')`));
  await shot(c, 'veda-library-390');
  await load(c, { w: 1280, h: 860, mobile: false, hash: '#/b/gita/2' });
  ok('Veda at 1280 opens chapter 2', await waitFor(c, `window.SHRUTI_PROFILE==='veda' && !!document.querySelector('.rd p')`));
  await shot(c, 'veda-chapter-1280');
  await ev(c, `location.hash='#/'; return 1`);
  await waitFor(c, `!!document.querySelector('.book')`);
  await shot(c, 'veda-library-1280');
  await ev(c, `location.hash='#/b/gita'; return 1`);
  await waitFor(c, `document.querySelectorAll('.ch').length===18`);
  await shot(c, 'veda-book-1280');

  const errs = await ev(c, `return JSON.stringify(window.__errs||[])`);
  ok('no page errors', errs === '[]', errs);
  console.log('\nScreenshots: ' + path.dirname(shotPath('x')));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
