// MyJournal + Brainstorm Journal entry locks on Guardian, in the real index.html
// with a fake Firestore (tests/live/fake-firebase.js) and a stateful fake worker:
// adoption of the old per-entry unlock, the pane that keeps a locked entry's
// content hidden (Cancel included), wrong/right password, change password (one
// set-lock with current), lock this device now, setting a new lock, and
// deleting a locked entry (Guardian's verify, then the record goes too).
//
// Run: node tests/live/guardian-journals.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const ORIGIN = 'https://anthonyn99.github.io', BASE = ORIGIN + '/A1/';
const T0 = Date.now();
const entry = (id, title, html, extra) => Object.assign({ id, title, template: 'page', created: T0 - 86400000, updated: T0 - 3600000,
  tags: [], data: { html, attachments: [] }, rev: 1 }, extra || {});
const LOCKED = 'e_1791000000001_alpha00001', OPEN = 'e_1791000000002_bravo00002';
const LV = T0 - 50000;   // the old lock version stamped on the entry
const seed = () => {
  const es = [entry(LOCKED, 'Alpha secret', '<p>SECRET BODY</p>', { lock: { locked: true, v: LV } }), entry(OPEN, 'Bravo open', '<p>Open body</p>')];
  const d = { _order: es.map((e) => e.id), activeId: OPEN, savedAt: T0 - 3600000 };
  for (const e of es) d['e_' + e.id] = e;
  return d;
};
const JOURNALS = [
  { key: 'tj', who: 'tony', doc: 'dashboards/tony_journal', open: "window._tonyNav('brainstormjournal')" },
  { key: 'bj', who: 'veda', doc: 'dashboards/journal', open: "window._vedaNav('journal')" },
];

const recs = {}; let n = 0; const calls = [];
const ver = (k) => (recs[k] ? 'v' + recs[k].salt : null);
const setRec = (k, pw) => { recs[k] = { pw, salt: ++n }; };
const worker = {
  patterns: ['https://taskhub-reminders.av1.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const p = new URL(req.url).pathname, b = req.postData ? JSON.parse(req.postData) : {};
    if (!/\/auth\//.test(p)) return { json: { ok: true } };
    calls.push({ p, b });
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
  const c = await connect({ mock: firebaseMock(worker) });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text); });
  const js = (e) => evalJs(c, e);
  const sr = `document.querySelector('guardian-lock') && document.querySelector('guardian-lock').shadowRoot`;
  const dlg = () => js(`const s = ${sr}; const ov = s && s.querySelector('.ov');
    return JSON.stringify(ov ? { open: true, theme: ov.dataset.theme, text: s.querySelector('.card').innerText, err: (s.querySelector('.err')||{}).textContent||'',
      buttons: [...s.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean) } : { open: false });`).then(JSON.parse);
  const gtype = (ph, v) => js(`const s = ${sr}; const i = [...s.querySelectorAll('input')].find(i => i.placeholder === ${JSON.stringify(ph)}); if (!i) return 'missing'; i.value = ${JSON.stringify(v)}; return 1;`);
  const gclick = (t) => js(`const s = ${sr}; const b = [...s.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(t)}); if (!b) return 'missing'; b.click(); return 1;`).then(async (r) => { await sleep(700); return r; });
  const click = (sel) => js(`var el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true;`).then(async (r) => { await sleep(600); return r; });

  for (const J of JOURNALS) {
    const K = J.key;
    console.log('\n' + K + ' (' + J.who + ')');
    Object.keys(recs).forEach((k) => delete recs[k]);
    setRec(K + ':' + LOCKED, 'pw1');
    await c.send('Page.navigate', { url: BASE + 'LifeHub/lifehub.js' }); await sleep(400);
    await js(`localStorage.clear(); sessionStorage.clear(); document.cookie.split(';').forEach(k => document.cookie = k.split('=')[0].trim() + '=; path=/; max-age=0');
      localStorage.setItem('td6_mainDash', '${J.who}'); localStorage.setItem('a1b_disabled', '1');
      var d = new Date(); localStorage.setItem('a1_sweep_day:index', d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2));
      ${K === 'tj' ? `localStorage.setItem('tj_unlockedat_${LOCKED}', '${LV + 10}'); localStorage.setItem('bio_cred_tj_${LOCKED}', JSON.stringify({ id: 'AQID', created: ${LV + 20}, v: ${LV} }));` : ''}
      sessionStorage.setItem('__fakefs_docs', JSON.stringify({ '${J.doc}': ${JSON.stringify(seed())} })); 1`);
    await c.send('Page.navigate', { url: BASE + 'index.html' }); await sleep(9000);
    await js(`var l=document.getElementById('th-boot-loader'); if(l) l.remove(); ${J.open}; 1`); await sleep(2500);
    const pane = () => js(`var p = document.getElementById('${K}-locked-pane'); return !!p && p.style.display !== 'none';`);
    const title = () => js(`return document.getElementById('${K}-entry-title-input').value;`);
    // What is ON SCREEN: a hidden editor (the load guard hides it behind the pane) shows nothing.
    const body = () => js(`var e = document.getElementById('${K}-page-editor'); return e && e.getClientRects().length ? e.innerText : '';`);

    await click(`#${K}-entries-list .entry-item[data-entry-id="${LOCKED}"] .entry-item-title`); await sleep(800);
    let d = await dlg();
    if (K === 'tj') {
      ok('a device the old lock had unlocked opens the entry with no prompt', !d.open && !(await pane()) && /SECRET BODY/.test(await body()), JSON.stringify(d));
      ok('its old biometric came along', await js(`return JSON.parse(localStorage.getItem('gd.b.tj:${LOCKED}') || '{}').id === 'AQID';`));
    } else {
      ok('a locked entry asks, in Veda\'s theme', d.open && d.theme === 'veda' && /Alpha secret/.test(d.text), JSON.stringify(d));
      ok('…with the pane over the editor and no content', (await pane()) && (await title()) === '' && !/SECRET/.test(await body()));
      await gclick('Cancel');
      ok('Cancel keeps the content hidden behind the pane', !(await dlg()).open && (await pane()) && !/SECRET/.test(await body()));
      await click(`#${K}-locked-pane button`);
      await gtype('Password', 'nope'); await gclick('Unlock');
      ok('wrong password refused', /Wrong password/.test((await dlg()).err));
      await gtype('Password', 'pw1'); await gclick('Unlock'); await sleep(600);
      ok('right password shows the entry', !(await dlg()).open && !(await pane()) && /SECRET BODY/.test(await body()));
    }

    // Change password through the lock button → Guardian's menu.
    await click(`#${K}-btn-lock`);
    d = await dlg();
    ok('lock button opens the menu', d.open && ['Lock this device now', 'Change password', 'Remove lock'].every((t) => d.buttons.includes(t)), JSON.stringify(d.buttons));
    await gclick('Change password');
    await gtype('Current password', 'pw1'); await gtype('New password', 'pw2'); await gtype('Confirm new password', 'pw2');
    calls.length = 0;
    await gclick('Change password'); await sleep(500);
    ok('change is ONE set-lock with current', calls.filter((x) => x.p === '/auth/journal/set-lock' && x.b.current === 'pw1').length === 1 && !calls.some((x) => x.p === '/auth/journal/remove-lock'), JSON.stringify(calls.map((x) => x.p)));
    ok('entry.lock.v moved (other devices re-lock)', await js(`return (window.__fakeFs.docs['${J.doc}']['e_${LOCKED}'].lock || {}).v > ${LV};`));
    await gclick('OK');

    // Lock this device now.
    await click(`#${K}-btn-lock`); await gclick('Lock this device now');
    ok('lock now: the pane and the prompt are back', (await pane()) && (await dlg()).open && !/SECRET/.test(await body()));
    await gclick('Cancel');

    // Delete the locked entry from the sidebar.
    await click(`#${K}-entries-list .entry-item[data-entry-id="${LOCKED}"] .entry-delete`); await sleep(500);
    d = await dlg();
    ok('deleting a locked entry asks for its password (Guardian verify)', d.open && /Delete entry/i.test(d.text), JSON.stringify(d));
    await gtype('Password', 'pw2'); await gclick('Continue'); await sleep(500);
    await js(`var o = document.getElementById('uim-ok'); if (o) o.click(); return 1;`); await sleep(1200);
    ok('the entry is trashed', await js(`return !!window.__fakeFs.docs['${J.doc}']['e_${LOCKED}'].trashed;`));
    ok('and its lock record is gone from the worker', !recs[K + ':' + LOCKED]);

    // Set a new lock on the open entry.
    await click(`#${K}-entries-list .entry-item[data-entry-id="${OPEN}"] .entry-item-title`);
    await click(`#${K}-btn-lock`);
    ok('an unlocked entry offers "Set password"', (await dlg()).buttons.includes('Set password'));
    await gtype('New password', 'np'); await gtype('Confirm password', 'np'); await gclick('Set password'); await sleep(500);
    ok('the new lock is on the worker and marked on the entry', recs[K + ':' + OPEN] && recs[K + ':' + OPEN].pw === 'np' && await js(`return !!window.__fakeFs.docs['${J.doc}']['e_${OPEN}'].lock;`));
    ok('this device stays unlocked on it', !(await pane()) && /Open body/.test(await body()));
    await js(`(${sr}) && Guardian.close(); return 1;`);
  }
  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
