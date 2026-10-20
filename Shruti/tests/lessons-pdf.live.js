// LIVE test: the Lessons tab's "Save as PDF", in real headless Edge on the
// real origin served from this working copy. Not run by npm test.
//
//   node Shruti/tests/lessons-pdf.live.js
//
// jsPDF is fetched once from cdnjs by this script and served to the page
// (the test browser blocks every outside site). Both profiles, 390 and 1280:
// the readers' notes for chapter 4, then an AI-made set with diacritics.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { connect, evalJs, sleep, shotPath } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'cdp.js'));
const { firebaseMock } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'fake-firebase.js'));
const ev = (c, x) => evalJs(c, /^\s*return\b/.test(x) && x.indexOf(';') < 0 ? x + ';' : x);

const URL = 'https://anthonyn99.github.io/A1/Shruti/shruti.html';
const JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const lessons = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'books', 'gita', 'lessons.json'), 'utf8'));
let jspdfText = '';

const mock = firebaseMock({
  patterns: ['https://cdnjs.cloudflare.com/*'],
  handle(req) {
    if (req.url === JSPDF) return { type: 'application/javascript', text: jspdfText };
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
  if (expr.indexOf(';') >= 0 && !/^\s*(return|const|let|var|if|for)\W/.test(expr)) expr = 'return ' + expr;
  while (Date.now() - t0 < ms) { try { if (await ev(c, expr)) return true; } catch {} await sleep(150); }
  return false;
};
const shot = async (c, name) => {
  await sleep(500);
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const data = r && (r.result ? r.result.data : r.data);
  if (data) fs.writeFileSync(shotPath('shruti-' + name), Buffer.from(data, 'base64'));
};
async function click(c, sel) {
  const at = JSON.parse(await ev(c, `const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'null'; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})`));
  if (!at) throw new Error('no ' + sel);
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
}
let RUN = String(Date.now());
const BOOT = (store) => `(()=>{ if(window.top!==window) return;
  try{ if(sessionStorage.getItem('__run')!=='${RUN}'){ localStorage.clear(); sessionStorage.clear(); ${store || ''} sessionStorage.setItem('__run','${RUN}'); } }catch(e){}
  window.__errs=[]; addEventListener('error', e=>window.__errs.push(String(e.message)));
  addEventListener('unhandledrejection', e=>window.__errs.push('rejection: '+String(e.reason && e.reason.message || e.reason)));
})();`;
let inj = null;
async function load(c, { w, h, mobile, store, hash = '' }) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  if (inj) await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier });
  inj = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOT(store) });
  await c.send('Page.navigate', { url: 'about:blank' });
  await sleep(150);
  await c.send('Page.navigate', { url: URL + hash });
  await sleep(400);
}
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'shruti-pdf-'));
async function download(c, sel) {
  for (const f of fs.readdirSync(DL)) fs.unlinkSync(path.join(DL, f));
  await click(c, sel);
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const f = fs.readdirSync(DL).find((x) => x.endsWith('.pdf'));
    if (f) { await sleep(300); return { name: f, data: new TextDecoder('windows-1252').decode(fs.readFileSync(path.join(DL, f))) }; }
    await sleep(150);
  }
  return null;
}
// jsPDF writes text uncompressed: "(…) Tj". Joined, a wrapped title reads whole again.
const pdfWords = (pdf) => (pdf.match(/\((?:\\.|[^\\)])*\) Tj/g) || []).map((s) => s.slice(1, -4).replace(/\\(.)/g, '$1')).join(' ').replace(/\s+/g, ' ');

(async () => {
  const r = await fetch(JSPDF);
  if (!r.ok) throw new Error('jsPDF could not be fetched: ' + r.status);
  jspdfText = await r.text();
  const c = await connect({ mock });
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  for (const [who, w, h, mobile] of [['tony', 1280, 900, false], ['veda', 390, 844, true]]) {
    console.log('\n' + who + ' at ' + w);
    RUN = String(Date.now());   // a fresh store, so this profile's pick applies
    await load(c, { w, h, mobile, store: "sessionStorage.removeItem('__fakefs_docs'); sessionStorage.setItem('shruti.pick','" + who + "');", hash: '#/b/gita/4/lessons' });
    await waitFor(c, `!!window.Shruti && !!window.Shruti.core.me.loaded`, 15000);
    ok('it is ' + who + '’s side', await waitFor(c, `document.body.dataset.profile==='${who}'`));
    ok('the Lessons tab has Save as PDF', await waitFor(c, `!!document.querySelector('#ls-pdf') && document.querySelectorAll('.ls-i').length===${lessons[4].lessons.length}`));
    ok('the button sits on the count line, inside the page', await waitFor(c, `const b=document.querySelector('#ls-pdf').getBoundingClientRect(); return b.width>0 && b.right<=innerWidth && document.documentElement.scrollWidth<=innerWidth`));
    await shot(c, 'lessons-pdf-' + who + '-' + w);
    const got = await download(c, '#ls-pdf');
    ok('pressing it downloads a PDF named for the chapter', got && got.name === 'Bhagavad-Gita - Chapter 4 lessons.pdf' && got.data.startsWith('%PDF-'), got && got.name);
    const words = got ? pdfWords(got.data) : '';
    const missing = lessons[4].lessons.filter((l) => !words.includes(l.title.replace(/\s+/g, ' ').slice(0, 25)));
    ok('every lesson title is in it', got && !missing.length, missing.map((l) => l.id).join());
    ok('…with the chapter title and who wrote them', /Path of renunciation/.test(words) && /lessons from Tony and Veda/.test(words), words.slice(0, 200));
    ok('the button is ready again', await waitFor(c, `const b=document.querySelector('#ls-pdf'); return !b.disabled && /Save as PDF/.test(b.textContent)`));
  }

  console.log('\nAn AI-made set');
  RUN = String(Date.now());
  await load(c, { w: 1280, h: 900, mobile: false, store: "sessionStorage.removeItem('__fakefs_docs'); sessionStorage.setItem('shruti.pick','tony');", hash: '#/b/gita/4/lessons' });
  await waitFor(c, `!!window.Shruti && !!window.Shruti.core.me.loaded && !!document.querySelector('#ls-pdf')`, 15000);
  await waitFor(c, `!!window.Shruti.core.shared.loaded`, 5000);
  await ev(c,`window.Shruti.core.shared.set({'assets.gita.ch4.lessons': {id:'v1', model:'deepseek/free', lessons:[{id:'L1', title:'Karma-yoga is ancient (Śrī Kṛṣṇa’s words).', body:'Receive it as old wisdom — kept by saintly kings.'},{id:'L2', title:'God comes by his own power.', body:'Not by karma.'}], summary:'Selfless work, offered to God, frees.'}},{now:true}); return 1`);
  await waitFor(c, `!!window.Shruti.core.shared.get('assets.gita.ch4.lessons',null) && (JSON.parse(sessionStorage.getItem('__fakefs_docs')||'{}')['dashboards/shruti_shared']||{}).assets`, 8000);
  await load(c, { w: 1280, h: 900, mobile: false, hash: '#/b/gita/4/lessons' });
  const shows = await waitFor(c, `/drawn by DeepSeek/.test(document.querySelector('.ls-k')?.textContent||'')`);
  ok('it shows the AI set', shows, await ev(c, `return document.body.dataset.profile+' '+JSON.stringify(window.Shruti.core.shared.get('assets.gita.ch4.lessons',null))+' '+(document.querySelector('.ls-k')?.textContent)`));
  const ai = await download(c, '#ls-pdf');
  const aw = ai ? pdfWords(ai.data) : '';
  ok('its PDF is named for the unit', ai && ai.name === 'Bhagavad-Gita - Chapter 4 lessons (DeepSeek).pdf', ai && ai.name);
  ok('diacritics lose only their marks; dashes and quotes stay', /Sri Krsna/.test(aw) && aw.includes('—') && aw.includes('’'), aw.slice(0, 200));
  ok('the summary is in it', /CHAPTER SUMMARY/.test(aw) && /Selfless work, offered to God, frees/.test(aw));
  ok('no page errors', !(await ev(c, `return (window.__errs||[]).join(' | ')`)), await ev(c, `return (window.__errs||[]).join(' | ')`));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
