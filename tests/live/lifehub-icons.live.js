// LifeHub re-reads each web app's logo every time the panel opens, so a logo a
// program changes (Orca's went lighter purple, 2026-10-02) shows up on the
// next open instead of sticking to the copy found the first time.
//
// OneInbox hosts the panel; its worker, Firebase and LifeHub's icon worker are
// faked. A custom "Orca" tile has an OLD logo cached in lh_pageicons; the
// icon worker now declares a NEW one. Opening the panel must paint the new
// one, cache it, and a later change must show on the NEXT open too.
//
// Run: node tests/live/lifehub-icons.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};
const ORIGIN = 'https://anthonyn99.github.io';
const ORCA = 'https://orca.example/';
const svg = (c) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="${c}"/></svg>`);
const OLD = svg('#5a3f8a'), NEW1 = svg('#c0aeea'), NEW2 = svg('#dbd0f5');
let declared = NEW1, workerHits = 0;

const FB = `
export const initializeApp = () => ({});
export const getAuth = () => ({});
export const signInAnonymously = () => Promise.resolve({ user: { uid: 't' } });
export const onAuthStateChanged = (a, cb) => { setTimeout(() => cb({ uid: 't' }), 0); return () => {}; };
export const initializeAppCheck = () => ({});
export class ReCaptchaV3Provider {}
export const initializeFirestore = () => ({});
export const persistentLocalCache = () => ({});
export const persistentSingleTabManager = () => ({});
export const doc = (db, ...p) => ({ path: p.join('/') });
export const collection = (db, ...p) => ({ path: p.join('/') });
export const query = (c) => c;
export const orderBy = () => ({});
export const limit = () => ({});
export const getDoc = () => Promise.resolve({ exists: () => false, data: () => ({}) });
export const setDoc = (ref, data) => { (window.__fsWrites = window.__fsWrites || []).push({ path: ref.path, data }); return Promise.resolve(); };
export const onSnapshot = () => () => {};
`;

const mock = {
  patterns: ['https://oneinbox-api.av1.workers.dev/*', 'https://taskhub-reminders.av1.workers.dev/*', 'https://lifehub-icon.av1.workers.dev/*'],
  handle(req) {
    if (req.url.startsWith('https://www.gstatic.com/firebasejs/')) return { text: FB, type: 'text/javascript' };
    if (req.method === 'OPTIONS' && /workers\.dev/.test(req.url)) return { status: 204, json: null };
    if (req.url.startsWith('https://lifehub-icon.av1.workers.dev/')) { workerHits++; return { json: { icons: [declared] } }; }
    if (/^https:\/\/(oneinbox-api|taskhub-reminders)\.av1\.workers\.dev\/accounts/.test(req.url)) return { json: { ok: true, accounts: [] } };
    if (/workers\.dev/.test(req.url)) return { json: { ok: true } };
    return null;
  },
};

const orcaSrc = (c) => evalJs(c, "var l=document.querySelector('a1-lifehub'); var r=l&&(l.shadowRoot||l); var h=document.querySelectorAll('*'); var t=null; [document].concat([...h].map(e=>e.shadowRoot).filter(Boolean)).forEach(function(d){ var x=d.querySelector('.t[data-id=\"orca\"] img'); if(x) t=x; }); return t?t.src:'';");
const toggle = async (c) => { await evalJs(c, "var l=document.querySelector('a1-lifehub'); var b=(l.shadowRoot||l).querySelector('button'); b.click(); 1"); await sleep(1500); };

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setBypassServiceWorker', { bypass: true });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/oneinbox.html?blank' }); await sleep(800);
  const app = { id: 'orca', name: 'Orca', url: ORCA, icon: 'auto', tab: 'lh_orca', hidden: false };
  await evalJs(c, `localStorage.clear();
    localStorage.setItem('oneinbox_lock_session', JSON.stringify({token:'test'}));
    localStorage.setItem('lifehub:v1', JSON.stringify({ base: [${JSON.stringify(app)}], apps: [${JSON.stringify(app)}], pending: false }));
    localStorage.setItem('lh_pageicons', JSON.stringify({ ${JSON.stringify(ORCA)}: [${JSON.stringify(OLD)}] })); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/oneinbox.html' }); await sleep(3000);

  await toggle(c);
  ok('the Orca tile is drawn', !!(await orcaSrc(c)));
  ok('opening the panel paints the NEW logo, not the cached one', (await orcaSrc(c)) === NEW1, await orcaSrc(c));
  ok('the new logo is cached', (await evalJs(c, "return localStorage.getItem('lh_pageicons');")).includes(encodeURIComponent('#c0aeea').slice(0, 9)));
  const hits = workerHits;
  await toggle(c);   // close
  declared = NEW2;
  await toggle(c);   // open again
  ok('every open asks again', workerHits > hits, hits + ' -> ' + workerHits);
  ok('a logo changed since the last open shows on this one', (await orcaSrc(c)) === NEW2, await orcaSrc(c));

  console.log(`
${pass}/${pass + fail} checks passed`);
  c.ws.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
