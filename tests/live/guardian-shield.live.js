// shield.html on Guardian: the T / V profile gate (each in its own theme, and
// never the full names — Shield's brief), the always-ask verify used to lift
// Emergency Mode (with its offline fallback), and adoption from the old lock.
//
// Run: node tests/live/guardian-shield.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const URL_ = 'https://anthonyn99.github.io/A1/shield.html';
const recs = {}; let n = 0, down = false;
const ver = (k) => (recs[k] ? 'v' + recs[k].salt : null);
const setRec = (k, pw) => { recs[k] = { pw, salt: ++n }; };
setRec('applock:tony_shield', 'tsh'); setRec('applock:veda_shield', 'vsh');
const mock = {
  patterns: ['https://taskhub-reminders.av1.workers.dev/*'],
  handle: (req) => {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const p = new URL(req.url).pathname, b = req.postData ? JSON.parse(req.postData) : {};
    if (!/\/auth\//.test(p)) return { json: { ok: true } };
    if (down) return null;   // refused = network error
    const k = b.journal + ':' + b.entryId, r = recs[k];
    if (p === '/auth/journal/status-many') {
      const out = {}; b.locks.forEach((l) => { const kk = l.journal + ':' + l.entryId; out[kk] = { hasLock: !!recs[kk], ver: ver(kk) }; });
      return { json: { ok: true, locks: out } };
    }
    if (p === '/auth/journal/verify') return { json: r ? { ok: r.pw === b.password } : { ok: false, noLock: true } };
    return { json: { ok: false } };
  },
};

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  const errors = [];
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errors.push(((m.params.exceptionDetails || {}).exception || {}).description || m.params.exceptionDetails.text); });
  const sr = `document.querySelector('guardian-lock') && document.querySelector('guardian-lock').shadowRoot`;
  const dlg = () => evalJs(c, `const s = ${sr}; const ov = s && s.querySelector('.ov');
    return JSON.stringify(ov ? { open: true, theme: ov.dataset.theme, text: s.querySelector('.card').innerText, err: (s.querySelector('.err')||{}).textContent||'' } : { open: false });`).then(JSON.parse);
  const type = (v) => evalJs(c, `const s = ${sr}; s.querySelector('input').value = ${JSON.stringify(v)}; return 1;`);
  const click = (t) => evalJs(c, `const s = ${sr}; const b = [...s.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(t)}); if (!b) return 'missing'; b.click(); return 1;`);
  const fresh = async (storage) => {
    await c.send('Page.navigate', { url: URL_ + '?blank' }); await sleep(700);
    await evalJs(c, `localStorage.clear(); sessionStorage.clear(); document.cookie.split(';').forEach(k => document.cookie = k.split('=')[0].trim() + '=; path=/; max-age=0');
      const s = ${JSON.stringify(storage || {})}; Object.keys(s).forEach(k => localStorage.setItem(k, s[k])); return 1;`);
    await c.send('Page.navigate', { url: URL_ }); await sleep(3500);
  };

  console.log('\nProfile gate');
  await fresh();
  ok('old Shield overlay and Bio are gone', await evalJs(c, `!document.getElementById('applock-overlay') && !window.Bio && !!window.Guardian`));
  await evalJs(c, `document.getElementById('pf-t').click(); return 1;`); await sleep(700);
  let d = await dlg();
  ok('T asks for the Shield passcode, Tony theme', d.open && d.theme === 'tony' && /Shield/.test(d.text), JSON.stringify(d));
  ok('the card says T, never "Tony"', /T · LOCKED/i.test(d.text) && !/Tony/.test(d.text), d.text);
  await sleep(800);   // LifeHub re-checks visibility twice a second
  ok('LifeHub launcher hides while the lock is up', await evalJs(c, `return (() => { const e = document.querySelector('a1-lifehub'); return !e || getComputedStyle(e).display === 'none' || !e.getClientRects().length || e.hidden; })()`));
  await click('Cancel'); await sleep(400);
  ok('Cancel returns to the chooser', !(await dlg()).open && (await evalJs(c, `document.body.getAttribute('data-gate')`)) !== 'app');
  await evalJs(c, `document.getElementById('pf-v').click(); return 1;`); await sleep(700);
  d = await dlg();
  ok('V wears Veda\'s theme and says V', d.open && d.theme === 'veda' && /V · LOCKED/i.test(d.text) && !/Veda/.test(d.text), JSON.stringify(d));
  await click('Cancel'); await sleep(300);
  await evalJs(c, `document.getElementById('pf-t').click(); return 1;`); await sleep(600);
  await type('tsh'); await click('Unlock'); await sleep(1500);
  ok('T opens Shield', !(await dlg()).open && (await evalJs(c, `window.SH._state.profile`)) === 'tony');

  console.log('\nEmergency Mode verify');
  await evalJs(c, `window.__v = 'pending'; window.AL.verify('tony_shield', 'Disable on all devices', 'Enter the Shield passcode.').then(p => window.__v = p); return 1;`); await sleep(600);
  d = await dlg();
  ok('asks even though this device is unlocked', d.open && /Disable on all devices/i.test(d.text), JSON.stringify(d));
  await type('tsh'); await click('Continue'); await sleep(900);
  ok('resolves the password for the worker', (await evalJs(c, `window.__v`)) === 'tsh');
  await sleep(600);
  ok('offline verifier stored on this device', await evalJs(c, `window.AL.hasOffline('tony_shield')`));
  down = true;
  await evalJs(c, `window.__v = 'pending'; window.AL.verify('tony_shield', 'Disable', 'x').then(p => window.__v = p); return 1;`); await sleep(500);
  await type('wrong'); await click('Continue'); await sleep(1500);
  ok('offline: wrong passcode refused', /Wrong/.test((await dlg()).err), (await dlg()).err);
  await type('tsh'); await click('Continue'); await sleep(1500);
  ok('offline: right passcode lifts it', (await evalJs(c, `window.__v`)) === 'tsh');
  down = false;

  console.log('\nRe-lock A1 apps (Emergency action) + adoption');
  await fresh({
    al_locks: JSON.stringify({ tony_shield: { locked: true, v: 1700000000000 }, veda_shield: { locked: true, v: 1700000000000 } }),
    al_unlockedat_tony_shield: '1700000000001',
    sh_offline_tony_shield: JSON.stringify({ hash: 'x', salt: 'eA==', iter: 1 }),
  });
  ok('T, unlocked by the old Shield lock, opens with no prompt', await evalJs(c, `window.AL.isUnlocked('tony_shield') && !window.AL.mustBlock('tony_shield')`));
  ok('old offline verifier still counts', await evalJs(c, `window.AL.hasOffline('tony_shield')`));
  ok('V (never unlocked here) still asks', await evalJs(c, `window.AL.mustBlock('veda_shield')`));
  await evalJs(c, `window.AL.markLocked('tony_shield'); return 1;`); await sleep(300);
  ok('markLocked (re-lock A1 apps) locks this device', await evalJs(c, `window.AL.mustBlock('tony_shield')`));

  ok('no page errors', errors.filter(Boolean).length === 0, errors.join(' | '));
  console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
