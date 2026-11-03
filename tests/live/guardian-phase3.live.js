// MyList, OneInbox and MAGI on Guardian, in the real pages, against a stateful
// fake worker (and a fake oneinbox-api for OneInbox's session token):
//   MyList   — Veda's profile asks in her theme; the old ml_unlocked marker is
//              adopted; setting a lock marks it in the synced state.
//   OneInbox — a hard gate (no Cancel), no "Remove lock", the password mints the
//              mailbox token, a 401 from the mail API locks again.
//   MAGI     — the picker stays and Guardian's card rises over it; "Lock this
//              device now" puts the gate back; the old session is adopted.
// Replaces magi-forgot.live.js (MAGI's own forgot form no longer exists:
// hint and reset are Guardian's, two separate links — tests/guardian.test.js).
//
// Run: node tests/live/guardian-phase3.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const BASE = 'https://anthonyn99.github.io/A1/';
const recs = {}; let n = 0; const calls = []; let tokens = 0;
const ver = (k) => (recs[k] ? 'v' + recs[k].salt : null);
const setRec = (k, pw) => { recs[k] = { pw, salt: ++n }; };
const api = {
  patterns: ['https://taskhub-reminders.av1.workers.dev/*', 'https://oneinbox-api.av1.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const u = new URL(req.url), p = u.pathname, b = req.postData ? JSON.parse(req.postData) : {};
    calls.push(u.host.split('.')[0] + p);
    if (u.host.startsWith('oneinbox-api')) {
      if (p === '/lock/session') return { json: recs['applock:tony_oneinbox'] && recs['applock:tony_oneinbox'].pw === b.password ? { ok: true, token: 'tok' + (++tokens) } : { ok: false } };
      if (p === '/lock/check') return { json: { ok: /^tok/.test(b.token || '') } };
      if (p === '/accounts') return { json: { ok: true, accounts: [] } };
      return { json: { ok: true } };
    }
    const k = b.journal + ':' + b.entryId, r = recs[k];
    if (p === '/auth/journal/status-many') {
      const out = {}; b.locks.forEach((l) => { const kk = l.journal + ':' + l.entryId; out[kk] = { hasLock: !!recs[kk], ver: ver(kk) }; });
      return { json: { ok: true, locks: out } };
    }
    if (p === '/auth/journal/verify') return { json: r ? { ok: r.pw === b.password } : { ok: false, noLock: true } };
    if (p === '/auth/journal/set-lock') { if (r && r.pw !== b.current) return { status: 403, json: { ok: false, error: 'needs-current' } }; setRec(k, b.password); return { json: { ok: true } }; }
    return { json: { ok: false } };
  },
};

(async () => {
  const c = await connect({ mock: firebaseMock(api) });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text); });
  // evalJs reads a bare `return x` (no ;) as an expression; give it a statement.
  const js = (e) => evalJs(c, e.trim().indexOf('return') === 0 && e.indexOf(';') < 0 ? e + ';' : e);
  const sr = `document.querySelector('guardian-lock') && document.querySelector('guardian-lock').shadowRoot`;
  const dlg = () => js(`const s = ${sr}; const ov = s && s.querySelector('.ov');
    return JSON.stringify(ov ? { open: true, theme: ov.dataset.theme, text: s.querySelector('.card').innerText, err: (s.querySelector('.err')||{}).textContent||'',
      buttons: [...s.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean) } : { open: false });`).then(JSON.parse);
  const gtype = (ph, v) => js(`const s = ${sr}; const i = [...s.querySelectorAll('input')].find(i => i.placeholder === ${JSON.stringify(ph)}); if (!i) return 'missing'; i.value = ${JSON.stringify(v)}; return 1;`);
  const gclick = (t) => js(`const s = ${sr}; const b = [...s.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(t)}); if (!b) return 'missing'; b.click(); return 1;`).then(async (r) => { await sleep(800); return r; });
  const fresh = async (file, storage, boot) => {
    await c.send('Page.navigate', { url: BASE + 'LifeHub/lifehub.js' }); await sleep(400);
    await js(`localStorage.clear(); sessionStorage.clear(); document.cookie.split(';').forEach(k => document.cookie = k.split('=')[0].trim() + '=; path=/; max-age=0');
      const s = ${JSON.stringify(storage || {})}; Object.keys(s).forEach(k => localStorage.setItem(k, s[k])); return 1;`);
    if (boot) { const id = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: boot }); c._boot = id.result.identifier; }
    await c.send('Page.navigate', { url: BASE + file }); await sleep(4500);
    if (boot) await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: c._boot });
  };

  // ── MyList ────────────────────────────────────────────────────────────────
  console.log('\nMyList');
  setRec('mylist:profile_veda', 'vpw'); setRec('mylist:profile_tony', 'tpw');
  const ML = (locks, lockV) => `(()=>{ if(window.top!==window) return;
    window._mlLoad=()=>Promise.resolve({ tony:{lists:[]}, veda:{lists:[]}, locks:${JSON.stringify(locks)}, lockV:${JSON.stringify(lockV)} });
    window._mlLoadOk=true; window.__saves=[]; window._mlSave=(d)=>window.__saves.push(JSON.parse(JSON.stringify(d))); window._mlReady=true; })();`;
  await fresh('mylist.html', { ml_unlocked_tony: 'v500' }, ML({ tony: true, veda: true }, { tony: 500, veda: 600 }));
  await js(`ML.chooseProfile('tony'); return 1;`); await sleep(800);
  ok('Tony, unlocked by the old MyList lock, enters with no prompt', !(await dlg()).open && (await js(`return document.body.getAttribute('data-profile')`)) === 'tony');
  await fresh('mylist.html', {}, ML({ tony: true, veda: true }, { tony: 500, veda: 600 }));
  await js(`ML.chooseProfile('veda'); return 1;`); await sleep(800);
  let d = await dlg();
  ok("Veda's lists ask, in Veda's theme", d.open && d.theme === 'veda' && /Veda's lists/.test(d.text), JSON.stringify(d));
  await gtype('Password', 'vpw'); await gclick('Unlock'); await sleep(500);
  ok('her password opens her lists', !(await dlg()).open && (await js(`return document.body.getAttribute('data-profile')`)) === 'veda');
  await js(`ML.manageLock(); return 1;`); await sleep(600);
  d = await dlg();
  ok('the lock button opens Guardian\'s menu (with Remove lock)', d.open && d.buttons.includes('Change password') && d.buttons.includes('Remove lock'), JSON.stringify(d.buttons));
  await gclick('Lock this device now'); await sleep(600);
  ok('lock now returns to the profile picker', (await js(`return getComputedStyle(document.getElementById('profile-overlay')).display`)) !== 'none');

  // ── OneInbox ──────────────────────────────────────────────────────────────
  console.log('\nOneInbox');
  setRec('applock:tony_oneinbox', 'oipw');
  await fresh('oneinbox.html');
  d = await dlg();
  ok('a hard gate: asks, with no Cancel', d.open && d.theme === 'tony' && !d.buttons.includes('Cancel'), JSON.stringify(d));
  ok('the inbox is hidden behind it', (await js(`return getComputedStyle(document.getElementById('app')).visibility`)) === 'hidden');
  await gtype('Password', 'oipw'); await gclick('Unlock'); await sleep(800);
  ok('the password mints the mailbox token', JSON.parse(await js(`return localStorage.getItem('oneinbox_lock_session') || 'null'`)) && /^tok/.test(JSON.parse(await js(`return localStorage.getItem('oneinbox_lock_session')`)).token));
  ok('and opens the inbox', !(await dlg()).open && (await js(`return getComputedStyle(document.getElementById('app')).visibility`)) === 'visible');
  await js(`document.getElementById('lockNowBtn').click(); return 1;`); await sleep(600);
  d = await dlg();
  ok('the menu shows Remove lock like every program', d.open && d.buttons.includes('Lock this device now') && d.buttons.includes('Remove lock'), JSON.stringify(d.buttons));
  await gclick('Remove lock');
  ok('…which explains the password protects the mailboxes, and removes nothing', /This lock stays on/i.test((await dlg()).text) && !calls.includes('taskhub-reminders/auth/journal/remove-lock'));
  await gclick('OK');
  await gclick('Lock this device now');
  ok('lock now: gate back, inbox hidden', (await dlg()).open && (await js(`return getComputedStyle(document.getElementById('app')).visibility`)) === 'hidden');
  ok('…and the token is ended (no biometric to park it for)', (await js(`return localStorage.getItem('oneinbox_lock_session')`)) === null && calls.includes('oneinbox-api/lock/end'));
  await fresh('oneinbox.html', { oneinbox_lock_session: JSON.stringify({ token: 'tokOLD' }) });
  ok('an old trusted token is adopted: straight into the inbox', !(await dlg()).open && (await js(`return getComputedStyle(document.getElementById('app')).visibility`)) === 'visible');

  // ── MAGI ──────────────────────────────────────────────────────────────────
  console.log('\nMAGI');
  setRec('applock:tony_magi', 'mpw');
  await fresh('magi.html');
  d = await dlg();
  ok('the gate (picker) is up with Guardian\'s card over it', d.open && /MAGI/.test(d.text) && (await js(`return !!document.getElementById('lockScreen') && !document.getElementById('lockScreen').hidden`)), JSON.stringify(d));
  ok('nothing reaches the engine or Firestore while locked', await js(`return PROFILE.unlocked === false && LOCK.booted === true`));
  await gclick('Cancel');
  ok('Cancel leaves the picker, its own card marked Locked', !(await dlg()).open && (await js(`return /Locked/i.test(document.querySelector('#lockScreen .pk-card.tony .pk-note').textContent)`)));
  await js(`document.querySelector('#lockScreen .pk-card.tony').click(); return 1;`); await sleep(500);
  await gtype('Password', 'mpw'); await gclick('Unlock'); await sleep(800);
  ok('the password opens the console', (await js(`return PROFILE.unlocked === true && document.getElementById('lockScreen').hidden`)));
  ok('the header padlock shows locked', await js(`return LOCK.hasLock === true`));
  await js(`document.getElementById('lockBtn').click(); return 1;`); await sleep(600);
  await gclick('Lock this device now'); await sleep(500);
  ok('lock now puts the gate and the card back', (await dlg()).open && (await js(`return PROFILE.unlocked === false && !document.getElementById('lockScreen').hidden`)));
  await fresh('magi.html', { 'magi.tony.lock_session': JSON.stringify({ at: 1, ver: ver('applock:tony_magi') }) });
  ok("MAGI's old session (same password ver) is adopted: no prompt", !(await dlg()).open && (await js(`return PROFILE.unlocked === true`)));
  setRec('applock:tony_magi', 'mpw2');
  await fresh('magi.html', { 'magi.tony.lock_session': JSON.stringify({ at: 1, ver: 'vSTALE' }) });
  await sleep(1500);
  ok('an old session from before a password change is NOT adopted', (await dlg()).open && (await js(`return PROFILE.unlocked === false`)));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
