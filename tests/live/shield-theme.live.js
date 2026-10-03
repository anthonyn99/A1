// Theme overhaul phase 9: Shield in MAGI's look on Tony's profile, with Veda's
// profile left exactly as it was. Shield has no reorderable lists and no
// resizable boxes, so this phase is the theme and the NUMBERS rule only.
//
// Firebase is faked: a module whose getDoc/onSnapshot answer seeded documents
// and whose writes record into window.__fsWrites. Nothing leaves the machine.
//
//   1. Tony: MAGI tokens, purple wordmark, the current nav pill solid purple
//      with a dark label, MAGI's .btn type, no gradients, no gold doing an
//      identity job, numbers in Inter 500 tabular, magi hover
//   2. dialogs: uiModal (solid purple OK, red-outline danger), the lock
//      (acd card, solid purple submit, no glows), the emergency takeover
//      (no radial glow)
//   3. the chooser: Tony's card and the mark's T half are purple
//   4. Veda: her tokens, her solid-mauve pill, her uiModal, no magi hover
//   5. phone width: nothing runs off the screen
//
// Run:          node tests/live/shield-theme.live.js
// Shots only:   node tests/live/shield-theme.live.js --shots <label>
//               (with A1_ROOT=<worktree> for a "before" of an older tag)
'use strict';
process.env.CDP_ALLOW_FONTS = '1';
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const ORIGIN = 'https://anthonyn99.github.io';
const SHOTS = process.argv[2] === '--shots' ? (process.argv[3] || 'shield') : null;

// A fixed clock keeps "Last seen 3h ago" and the history times identical
// between a before and an after run.
const NOW = 1790000000000;
const dev = (id, name, platform, seen, targets) => ({
  id, name, platform, lastSeen: seen, caps: { agent: false },
  closer: { targets },
});
const TARGETS = [
  { id: 't1', label: 'Steam', match: 'steam.exe', on: true },
  { id: 't2', label: 'Discord', match: 'discord.exe', on: false },
  { id: 't3', label: 'League of Legends', match: 'LeagueClient.exe', on: true },
];
const profileDoc = () => ({
  devices: {
    dev_test: dev('dev_test', 'Desk PC', 'windows', NOW - 60000, TARGETS),
    dev_lap: dev('dev_lap', 'Laptop', 'windows', NOW - 3 * 3600000, TARGETS.slice(0, 1)),
  },
  savedAt: 1,
});
const SEED = {
  'dashboards/shield_tony': profileDoc(),
  'dashboards/shield_veda': profileDoc(),
  'dashboards/applock': { locks: {} },
};
const HIST = [
  { id: 'h1', kind: 'closer', at: NOW - 2 * 3600000, items: [{ label: 'Steam', status: 'closed', count: 2 }, { label: 'Discord', status: 'notrunning' }, { label: 'Vanguard', status: 'partial', error: 'one process left' }] },
  { id: 'h2', kind: 'emergency', at: NOW - 26 * 3600000, items: [] },
];

const FB = `
const SEED = ${JSON.stringify(SEED)};
export const initializeApp = () => ({});
export const getAuth = () => ({});
export const signInAnonymously = () => Promise.resolve({ user: { uid: 't' } });
export const onAuthStateChanged = (a, cb) => { setTimeout(() => cb({ uid: 't' }), 0); return () => {}; };
export const initializeAppCheck = () => ({});
export class ReCaptchaV3Provider {}
export const initializeFirestore = () => ({});
export const getFirestore = () => ({});
export const memoryLocalCache = () => ({});
export const deleteField = () => ({ __delete: true });
export const doc = (db, ...p) => ({ path: p.join('/'), kind: 'doc' });
const snap = (ref) => ({ exists: () => !!SEED[ref.path], data: () => JSON.parse(JSON.stringify(SEED[ref.path])) });
const rec = (ref, data) => { (window.__fsWrites = window.__fsWrites || []).push({ path: ref.path, data: JSON.parse(JSON.stringify(data)) }); return Promise.resolve(); };
export const getDoc = (ref) => Promise.resolve(snap(ref));
export const getDocFromServer = (ref) => Promise.resolve(snap(ref));
export const setDoc = rec;
export const updateDoc = rec;
export const onSnapshot = (ref, cb) => { setTimeout(() => cb(snap(ref)), 30); return () => {}; };
`;

const mock = {
  patterns: ['https://taskhub-reminders.av1.workers.dev/*'],
  handle(req) {
    if (req.url.startsWith('https://www.gstatic.com/firebasejs/')) return { text: FB, type: 'text/javascript' };
    if (!/\.workers\.dev/.test(req.url)) return null;
    if (req.method === 'OPTIONS') return { status: 204, json: null };
    return { json: { ok: true } };
  },
};

const css = (c, sel, prop) => evalJs(c, `var e=document.querySelector(${JSON.stringify(sel)}); return e?getComputedStyle(e)[${JSON.stringify(prop)}]:'(none)';`);
const PURPLE = 'rgb(192, 174, 234)', DARK = 'rgb(26, 26, 29)', ACL = 'rgb(219, 208, 245)', ACD = 'rgb(154, 134, 201)';
const MAUVE = 'rgb(141, 118, 154)';

// profile: 'tony' | 'veda' | null (the chooser). emg: start locked down.
async function load(c, w, h, mobile, profile, emg) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/shield.html?blank' }); await sleep(700);
  await evalJs(c, `localStorage.clear();
    localStorage.setItem('sh_device_id', 'dev_test');
    ${profile ? `localStorage.setItem('sh_fav_profile', '${profile}'); localStorage.setItem('sh_profile', '${profile}');
    localStorage.setItem('sh_hist_${profile}_dev_test', ${JSON.stringify(JSON.stringify(HIST))});` : ''}
    ${emg ? `localStorage.setItem('sh_emg_${profile}', JSON.stringify({ active: true, at: ${NOW - 600000}, source: 'local', scope: 'local', v: 0 }));` : ''}
    1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/shield.html' });
  await sleep(2000);
}
const view = (c, v) => evalJs(c, `document.querySelector('.nav > .pill[data-view="${v}"]').click(); 1`).then(() => sleep(350));
async function shot(c, name) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const f = shotPath(SHOTS + '-' + name);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  console.log('shot', f);
}

async function shotsFor(c, p) {
  await load(c, 1280, 900, false, p);
  await shot(c, p + '-home');
  await view(c, 'config'); await shot(c, p + '-config');
  await view(c, 'devices'); await shot(c, p + '-devices');
  await view(c, 'history'); await shot(c, p + '-history');
  await view(c, 'home');
  await evalJs(c, "uiConfirm('Close every target app?', {title:'Close apps', okLabel:'Close'}); 1"); await sleep(300);
  await shot(c, p + '-uiconfirm');
  await evalJs(c, "document.getElementById('uim-cancel').click(); uiConfirm('Delete?', {danger:true, okLabel:'Delete'}); 1"); await sleep(300);
  await shot(c, p + '-uidanger');
  await evalJs(c, "document.getElementById('uim-cancel').click(); uiPrompt('Name for this device', {title:'Rename device', default:'Desk PC'}); 1"); await sleep(300);
  await shot(c, p + '-uiprompt');
  await evalJs(c, "document.getElementById('uim-cancel').click(); document.getElementById('lock-btn').click(); 1"); await sleep(500);
  await shot(c, p + '-lock');
  await evalJs(c, "document.getElementById('applock-cancel').click(); 1"); await sleep(200);
  await load(c, 1280, 900, false, p, true);
  await shot(c, p + '-emergency');
  await load(c, 400, 860, true, p);
  await shot(c, p + '-phone-home');
  await view(c, 'config'); await shot(c, p + '-phone-config');
}

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  await c.send('Network.setBypassServiceWorker', { bypass: true });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  // A fixed "now", so relative times match between a before and an after run.
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.now = () => ${NOW};` });

  if (SHOTS) {
    await load(c, 1280, 900, false, null);
    await shot(c, 'chooser');
    await shotsFor(c, 'tony');
    await shotsFor(c, 'veda');
    c.ws.close(); process.exit(0);
  }

  // ── 1. Tony ──
  await load(c, 1280, 900, false, 'tony');
  console.log('tony');
  ok('Tony is in the app', (await evalJs(c, "return document.body.dataset.profile + '/' + document.body.dataset.gate;")) === 'tony/app');
  ok('body opts into MAGI hover', (await evalJs(c, "return document.body.dataset.hoverfx;")) === 'magi');
  ok('--ac is MAGI purple', (await evalJs(c, "return getComputedStyle(document.body).getPropertyValue('--ac').trim();")) === '#c0aeea');
  ok('the wordmark is acl', (await css(c, '.brand', 'color')) === ACL);
  ok('the current nav pill is solid purple', (await css(c, '.nav > .pill.on', 'backgroundColor')) === PURPLE);
  ok('its label is dark', (await css(c, '.nav > .pill.on', 'color')) === DARK);
  ok('the current pill has no halo', (await css(c, '.nav > .pill.on', 'boxShadow')) === 'none');
  ok(".btn is MAGI's (10px / 700 / 1px)", (await css(c, '.btn', 'fontSize')) === '10px' && (await css(c, '.btn', 'fontWeight')) === '700' && (await css(c, '.btn', 'letterSpacing')) === '1px');
  ok('cards sit on a hairline, radius 8', (await css(c, '.card, .dev', 'borderTopLeftRadius')) === '8px');
  ok('the Close Apps button is an acd outline', (await css(c, '.big.close', 'borderTopColor')) === ACD);
  const grad = await evalJs(c, "return [...document.querySelectorAll('#app *')].filter(e=>/gradient\\(/.test(getComputedStyle(e).backgroundImage)).length;");
  ok('no gradient fills in the app', grad === 0, grad);
  const gold = await evalJs(c, "return [...document.querySelectorAll('#app *')].filter(e=>!e.closest('.warn,.part')).filter(e=>{const s=getComputedStyle(e); return [s.color,s.borderTopColor,s.backgroundColor].some(v=>/224, 184, 116/.test(v));}).map(e=>e.className).slice(0,5).join('|');");
  ok('no gold doing an identity job', gold === '', gold);
  ok('body numbers are tabular', (await css(c, 'body', 'fontVariantNumeric')) === 'tabular-nums');
  ok('buttons are tabular too', (await css(c, '.btn', 'fontVariantNumeric')) === 'tabular-nums');
  ok('the UI face is Inter', /^Inter/.test(await css(c, 'body', 'fontFamily')));
  await view(c, 'devices');
  ok('device times are Inter 500 tabular', /^Inter/.test(await css(c, '.dev-meta', 'fontFamily')) && (await css(c, '.dev-meta', 'fontVariantNumeric')) === 'tabular-nums');
  ok('"This device" row is an acd outline', (await css(c, '.dev.me', 'borderTopColor')) === ACD);
  await view(c, 'config');
  ok('a set chip count is Inter 500', (await css(c, '.setchip-n', 'fontWeight')) === '500');
  await evalJs(c, "document.querySelector('.toggle').classList.add('on'); 1"); await sleep(400);
  ok('a toggle that is on is solid purple', (await css(c, '.toggle.on', 'backgroundColor')) === PURPLE, await css(c, '.toggle.on', 'backgroundColor'));
  ok('a sub-tab that is on is an accent outline', (await css(c, '.pill.sub.on', 'borderTopColor')) === PURPLE);
  ok('a selected set chip has no halo', (await css(c, '.setchip.on', 'boxShadow')) === 'none');
  await view(c, 'home');

  // ── 2. dialogs ──
  console.log('dialogs');
  await evalJs(c, "uiConfirm('Sure?', {okLabel:'Yes'}); 1"); await sleep(300);
  ok('uiModal OK is solid purple with a dark label', (await css(c, '#uim-ok', 'backgroundColor')) === PURPLE && (await css(c, '#uim-ok', 'color')) === DARK);
  ok('uiModal backdrop is .62 with a 2px blur', (await css(c, '#uim-overlay', 'backgroundColor')) === 'rgba(0, 0, 0, 0.62)' && (await css(c, '#uim-overlay', 'backdropFilter')) === 'blur(2px)');
  ok('uiModal box is s1, radius 8', (await css(c, '#uim-box', 'backgroundColor')) === 'rgb(35, 35, 39)' && (await css(c, '#uim-box', 'borderTopLeftRadius')) === '8px');
  ok('the uiModal title is Manrope', /^Manrope/.test(await css(c, '#uim-title', 'fontFamily')));
  await evalJs(c, "document.getElementById('uim-cancel').click(); uiConfirm('Delete?', {danger:true, okLabel:'Delete'}); 1"); await sleep(300);
  ok('a danger OK is a red outline', (await css(c, '#uim-ok', 'backgroundColor')) === 'rgba(0, 0, 0, 0)' && (await css(c, '#uim-ok', 'color')) === 'rgb(214, 138, 124)');
  await evalJs(c, "document.getElementById('uim-cancel').click(); document.getElementById('lock-btn').click(); 1"); await sleep(500);
  ok('the lock card outline is acd, radius 8', (await css(c, '#applock-box', 'borderTopColor')) === ACD && (await css(c, '#applock-box', 'borderTopLeftRadius')) === '8px');
  ok('"Set Password" is solid purple', (await css(c, '#applock-submit', 'backgroundColor')) === PURPLE && (await css(c, '#applock-submit', 'color')) === DARK);
  await evalJs(c, "document.getElementById('applock-cancel').click(); 1"); await sleep(200);
  await load(c, 1280, 900, false, 'tony', true);
  ok('the emergency takeover is on', (await evalJs(c, "return document.getElementById('emg-screen').classList.contains('on');")) === true);
  ok('the takeover has no radial glow', (await css(c, '#emg-screen', 'backgroundImage')) === 'none');
  ok('the takeover title is Manrope', /^Manrope/.test(await css(c, '.emg-title', 'fontFamily')));

  // ── 3. chooser ──
  console.log('chooser');
  await load(c, 1280, 900, false, null);
  ok("Tony's card glyph is purple", (await css(c, '.pf-card.t .glyph', 'color')) === PURPLE);
  ok("the mark's T half is purple", (await evalJs(c, "return document.querySelector('.pf-mark path').getAttribute('stroke').toLowerCase();")) === '#c0aeea');
  ok("Veda's card is untouched", (await css(c, '.pf-card.v .glyph', 'color')) === MAUVE);

  // ── 4. Veda ──
  console.log('veda');
  await load(c, 1280, 900, false, 'veda');
  ok('Veda is in the app', (await evalJs(c, "return document.body.dataset.profile + '/' + document.body.dataset.gate;")) === 'veda/app');
  ok('Veda has no magi hover', (await evalJs(c, "return document.body.dataset.hoverfx || '';")) !== 'magi');
  ok('her --ac is mauve', (await evalJs(c, "return getComputedStyle(document.body).getPropertyValue('--ac').trim();")) === '#8D769A');
  ok('her current pill is solid mauve', (await css(c, '.nav > .pill.on', 'backgroundColor')) === MAUVE);
  ok('her .btn keeps 10.5px / 600', (await css(c, '.btn:not(.sm)', 'fontSize')) === '10.5px' && (await css(c, '.btn:not(.sm)', 'fontWeight')) === '600', (await css(c, '.btn:not(.sm)', 'fontSize')) + ' ' + (await css(c, '.btn:not(.sm)', 'fontWeight')) + ' ' + (await evalJs(c, "return document.querySelector('.btn:not(.sm)').outerHTML.slice(0,120)")));
  ok('her face is Plex Mono', /IBM Plex Mono/.test(await css(c, 'body', 'fontFamily')));
  await evalJs(c, "uiConfirm('Sure?', {okLabel:'Yes'}); 1"); await sleep(300);
  ok('her uiModal OK is a mauve outline', (await css(c, '#uim-ok', 'backgroundColor')) === 'rgba(0, 0, 0, 0)' && (await css(c, '#uim-ok', 'color')) === MAUVE);
  ok('her uiModal backdrop is unchanged', (await css(c, '#uim-overlay', 'backgroundColor')) === 'rgba(14, 14, 16, 0.66)');
  await evalJs(c, "document.getElementById('uim-cancel').click(); 1");

  // ── 5. phone ──
  console.log('phone');
  await load(c, 400, 860, true, 'tony');
  ok('nothing runs off a phone screen (home)', (await evalJs(c, "return document.documentElement.scrollWidth > innerWidth;")) === false);
  await view(c, 'config');
  ok('nothing runs off a phone screen (config)', (await evalJs(c, "return document.documentElement.scrollWidth > innerWidth;")) === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
