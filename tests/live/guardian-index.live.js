// index.html on Guardian: the profile chooser, program gates, Veda's Rules and
// Reels locks, the lock menus and the "nobody notices the switch" adoption —
// driven headless against a stateful fake worker (Firebase is blocked, so the
// page runs on its local cache exactly as it does offline).
//
// Run: node tests/live/guardian-index.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const URL_ = 'https://anthonyn99.github.io/A1/index.html';

const recs = {}; let n = 0; const calls = [];
const ver = (k) => (recs[k] ? 'v' + recs[k].salt : null);
const setRec = (k, pw) => { recs[k] = { pw, salt: ++n }; };
setRec('applock:profile_tony', 'tony');
setRec('applock:profile_veda', 'veda');
setRec('applock:veda_rules', 'rules');
setRec('applock:tony_myjournal', 'mj');
const mock = {
  patterns: ['https://taskhub-reminders.av1.workers.dev/*'],
  handle: (req) => {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const p = new URL(req.url).pathname, b = req.postData ? JSON.parse(req.postData) : {};
    if (!/\/auth\//.test(p)) return { json: { ok: true } };
    calls.push(p);
    const k = b.journal + ':' + b.entryId, r = recs[k];
    if (p === '/auth/journal/status-many') {
      const out = {}; b.locks.forEach((l) => { const kk = l.journal + ':' + l.entryId; out[kk] = { hasLock: !!recs[kk], ver: ver(kk) }; });
      return { json: { ok: true, locks: out } };
    }
    if (p === '/auth/journal/verify') return { json: r ? { ok: r.pw === b.password } : { ok: false, noLock: true } };
    if (p === '/auth/journal/set-lock') { if (r && r.pw !== b.current) return { status: 403, json: { ok: false, error: 'needs-current' } }; setRec(k, b.password); return { json: { ok: true } }; }
    if (p === '/auth/journal/remove-lock') { if (r && r.pw !== b.password) return { json: { ok: false } }; delete recs[k]; return { json: { ok: true } }; }
    return { json: { ok: false } };
  },
};

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  const errors = [];
  c.on && c.on('Runtime.exceptionThrown', (m) => errors.push(m.exceptionDetails && (m.exceptionDetails.exception || {}).description));
  const sr = `document.querySelector('guardian-lock') && document.querySelector('guardian-lock').shadowRoot`;
  const dlg = () => evalJs(c, `const s = ${sr}; const ov = s && s.querySelector('.ov');
    return JSON.stringify(ov ? { open: true, theme: ov.dataset.theme, title: s.querySelector('.title').textContent,
      buttons: [...s.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean), err: (s.querySelector('.err')||{}).textContent||'' } : { open: false });`).then(JSON.parse);
  const type = (v) => evalJs(c, `const s = ${sr}; s.querySelector('input').value = ${JSON.stringify(v)}; return 1;`);
  const click = (t) => evalJs(c, `const s = ${sr}; const b = [...s.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(t)}); if (!b) return 'missing'; b.click(); return 1;`);
  const fresh = async (storage) => {
    await c.send('Page.navigate', { url: URL_ + '?blank' }); await sleep(800);
    await evalJs(c, `localStorage.clear(); sessionStorage.clear(); document.cookie.split(';').forEach(k => document.cookie = k.split('=')[0].trim() + '=; path=/; max-age=0');
      const s = ${JSON.stringify(storage || {})}; Object.keys(s).forEach(k => localStorage.setItem(k, s[k])); return 1;`);
    await c.send('Page.navigate', { url: URL_ }); await sleep(4500);
  };

  console.log('\nBoot');
  await fresh();
  ok('Guardian loaded', await evalJs(c, `!!window.Guardian && typeof window.alGate === 'function'`));
  ok('every index lock declared (incl. tony_magi, which had no label before)', await evalJs(c,
    `['tony_taskhub','tony_tradehub','tony_solace','tony_keychain','tony_myjournal','tony_warroom','tony_magi','veda_taskhub','veda_gita','veda_journal','veda_rules','veda_reels','tony_shield','veda_shield','profile_tony','profile_veda'].every(id => Guardian.defs().some(d => d.id === id))`));
  ok('the old overlay is gone', await evalJs(c, `!document.getElementById('applock-overlay')`));
  ok('one status-many call covers every lock on load', calls.filter((p) => p === '/auth/journal/status-many').length >= 1, calls.join());
  ok('profile_tony known locked after refresh', await evalJs(c, `alIsLocked('profile_tony') && !alIsUnlocked('profile_tony')`));
  ok('an unlocked program reports unlocked', await evalJs(c, `!alIsLocked('tony_taskhub') && alIsUnlocked('tony_taskhub')`));

  console.log('\nProfile chooser');
  await evalJs(c, `window._profileGoSelect(); return 1;`); await sleep(500);
  await evalJs(c, `document.getElementById('card-tony').click(); return 1;`); await sleep(600);
  let d = await dlg();
  ok('Tony card asks for his password in his theme', d.open && d.theme === 'tony' && d.title === 'Tony', JSON.stringify(d));
  await click('Cancel'); await sleep(400);
  ok('Cancel goes back to the chooser', !(await dlg()).open && (await evalJs(c, `window._activeProfile`)) == null);
  await evalJs(c, `document.getElementById('card-tony').click(); return 1;`); await sleep(500);
  await type('nope'); await click('Unlock'); await sleep(500);
  ok('wrong password refused', /Wrong password/.test((await dlg()).err));
  await type('tony'); await click('Unlock'); await sleep(1500);
  ok('right password opens Tony', !(await dlg()).open && (await evalJs(c, `window._activeProfile`)) === 'tony');
  ok('unlock stored at the worker ver', (await evalJs(c, `localStorage.getItem('gd.u.applock:profile_tony')`)) === ver('applock:profile_tony'));
  await evalJs(c, `window._profileGoSelect(); return 1;`); await sleep(400);
  await evalJs(c, `document.getElementById('card-tony').click(); return 1;`); await sleep(800);
  ok('second entry needs no password on this device', !(await dlg()).open && (await evalJs(c, `window._activeProfile`)) === 'tony');

  console.log('\nPrograms');
  await evalJs(c, `window.showTonyJournal(); return 1;`); await sleep(600);
  d = await dlg();
  ok('MyJournal gate opens over a locked program', d.open && d.title === 'MyJournal', JSON.stringify(d));
  ok('its content is hidden while locked', await evalJs(c, `document.getElementById('tj-root').style.display === 'none'`));
  await type('mj'); await click('Unlock'); await sleep(1200);
  ok('MyJournal opens after the password', !(await dlg()).open && (await evalJs(c, `document.getElementById('tj-root').style.display !== 'none'`)));
  await evalJs(c, `alManage('tony_taskhub'); return 1;`); await sleep(600);
  d = await dlg();
  ok('managing an unlocked program offers "Set password"', d.open && d.buttons.includes('Set password'), JSON.stringify(d.buttons));
  await click('Cancel'); await sleep(300);
  await evalJs(c, `alManage('tony_myjournal'); return 1;`); await sleep(600);
  d = await dlg();
  ok('locked program menu: lock now / change / remove', ['Lock this device now', 'Change password', 'Remove lock', 'Cancel'].every((t) => d.buttons.includes(t)), JSON.stringify(d.buttons));
  await click('Lock this device now'); await sleep(800);
  d = await dlg();
  ok('lock now on the visible program re-gates it at once', d.open && d.title === 'MyJournal', JSON.stringify(d));
  ok('…and hides it', await evalJs(c, `document.getElementById('tj-root').style.display === 'none'`));
  await click('Cancel'); await sleep(400);

  console.log('\nVeda');
  await evalJs(c, `window._profileGoSelect(); return 1;`); await sleep(400);
  await evalJs(c, `document.getElementById('card-veda').click(); return 1;`); await sleep(600);
  d = await dlg();
  ok('Veda card wears her theme', d.open && d.theme === 'veda' && d.title === 'Veda', JSON.stringify(d));
  await type('veda'); await click('Unlock'); await sleep(2000);
  ok('Veda opens', (await evalJs(c, `window._activeProfile`)) === 'veda');
  let opened = await evalJs(c, `window.__ro = 0; alGate('veda_rules', () => { window.__ro = 1; }); return window.__ro;`);
  await sleep(500); d = await dlg();
  ok('Rules manage view is gated, not opened', opened === 0 && d.open && d.title === 'Rules' && d.theme === 'veda', JSON.stringify(d));
  await type('rules'); await click('Unlock'); await sleep(1200);
  ok('Rules opens after her password', (await evalJs(c, `window.__ro`)) === 1);
  opened = await evalJs(c, `window.__rr = 0; alGate('veda_reels', () => { window.__rr = 1; }); return window.__rr;`);
  ok('an unlocked widget (Reels) opens synchronously, no prompt', opened === 1 && !(await dlg()).open);

  console.log('\nNobody notices the switch (adoption from the old lock records)');
  await fresh({
    al_locks: JSON.stringify({ profile_tony: { locked: true, v: 1700000000000 }, tony_myjournal: { locked: true, v: 1700000000000 } }),
    al_unlockedat_profile_tony: '1700000000500',
    al_unlockedv_tony_myjournal: 'v1700000000000',
    bio_cred_applock_profile_tony: JSON.stringify({ id: 'AQID', created: 1700000000600, v: 1700000000000, label: 'x' }),
  });
  ok('Tony, unlocked by the old system, is still unlocked', await evalJs(c, `alIsUnlocked('profile_tony') && alIsUnlocked('tony_myjournal')`));
  ok('his biometric credential carried over', await evalJs(c, `JSON.parse(localStorage.getItem('gd.b.applock:profile_tony')||'{}').id === 'AQID'`));
  await evalJs(c, `window._profileGoSelect(); return 1;`); await sleep(400);
  await evalJs(c, `document.getElementById('card-tony').click(); return 1;`); await sleep(800);
  ok('entering Tony asks nothing', !(await dlg()).open && (await evalJs(c, `window._activeProfile`)) === 'tony');
  ok('Veda (never unlocked here) still asks', await evalJs(c, `alMustBlock('profile_veda')`));

  console.log('\nA password change on another device');
  setRec('applock:profile_tony', 'tony2');
  await evalJs(c, `Guardian.refresh(['profile_tony']); return 1;`); await sleep(1200);
  ok('this device is locked out of Tony and sent to the chooser', (await evalJs(c, `alMustBlock('profile_tony')`)) && (await evalJs(c, `window._activeProfile`)) == null);
  ok('his old biometric no longer counts', await evalJs(c, `localStorage.getItem('gd.b.applock:profile_tony') === null`));

  ok('no page errors', errors.filter(Boolean).length === 0, errors.join(' | '));
  console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
