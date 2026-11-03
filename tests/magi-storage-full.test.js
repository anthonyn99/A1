// Guards MAGI against a FULL localStorage -- the cause of "works on Tony's PC,
// not on Veda's" (2026-09-25).
//
// Every A1 page shares the anthonyn99.github.io origin's ~5 MB. On Veda's
// Brave, TaskHub data, journal canvases and StudyOS had filled it to
// 5,242,876 of 5,242,880 chars. Reads still work, so the storage guard's
// "blocked?" probe passed -- but every write threw QuotaExceededError inside
// a silent try/catch: the profile star did nothing, picking Veda reloaded
// into Tony (and, as Tony, the console refused her engine and went remote),
// and the ticked AI units were forgotten on every reload.
//
// This runs the real storage-guard script against a store that refuses new
// writes, and checks settings survive a "reload" (a fresh run of the guard
// over the same store and cookie jar) while secrets never reach a cookie.
//
// Run: node tests/magi-storage-full.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MAGI = fs.readFileSync(path.join(__dirname, '..', 'magi.html'), 'utf8');
const start = MAGI.indexOf('<script id="storage-guard">');
const GUARD = MAGI.slice(MAGI.indexOf('>', start) + 1, MAGI.indexOf('</script>', start));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

/** A Storage that is full: existing keys read fine, nothing new fits. */
function fullStore(initial) {
  const m = new Map(Object.entries(initial || {}));
  const quota = () => { const e = new Error('exceeded the quota'); e.name = 'QuotaExceededError'; e.code = 22; return e; };
  return {
    _m: m,
    getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { k = String(k); v = String(v); if (!m.has(k) || v.length > m.get(k).length) throw quota(); m.set(k, v); },
    removeItem: (k) => { m.delete(String(k)); },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}
function roomyStore() {
  const m = new Map();
  return {
    _m: m,
    getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(String(k)); },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

/** A minimal cookie jar honouring max-age=0 deletes. */
function jar() {
  const c = new Map();
  return {
    get cookie() { return [...c].map(([k, v]) => k + '=' + v).join('; '); },
    set cookie(s) {
      const [pair, ...attrs] = s.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1);
      if (attrs.some((a) => /max-age=0/.test(a))) c.delete(k); else c.set(k, v);
    },
    _c: c,
  };
}

/** One page load: a fresh window over the same store and cookies. */
function load(store, cookies) {
  const win = { localStorage: store, sessionStorage: roomyStore(), location: { pathname: '/A1/magi.html' } };
  win.window = win;
  win.document = cookies;
  vm.runInNewContext(GUARD, win);
  return win;
}

console.log('\nA full store: MAGI settings survive a reload anyway');
const store = fullStore({ td6_data: 'x'.repeat(50), 'magi.lastProfile': 'tony' });
const cookies = jar();
let w = load(store, cookies);
ok('a full store is detected', w.MAGI_STORAGE_FULL === true);
ok('and not mistaken for a blocked one', w.MAGI_STORAGE_BLOCKED === false);
ok('existing data still reads', w.localStorage.getItem('td6_data') === 'x'.repeat(50));

let threw = null;
try {
  w.localStorage.setItem('magi.favProfile', 'veda');
  w.localStorage.setItem('magi.lastProfile', 'veda');
  w.localStorage.setItem('magi.veda.units', JSON.stringify({ on: ['claude', 'gemini'] }));
  w.localStorage.setItem('magi.veda.mode', 'text');
  w.localStorage.setItem('magi.veda.token', 'SECRET-TOKEN-123');
  w.localStorage.setItem('magi.veda.engines', '[{"token":"SECRET-TOKEN-123"}]');
} catch (e) { threw = e; }
ok('a write that does not fit no longer throws', threw === null, threw && threw.name);
ok('it reads back in the same tab', w.localStorage.getItem('magi.favProfile') === 'veda');
ok('the token reads back in the same tab', w.localStorage.getItem('magi.veda.token') === 'SECRET-TOKEN-123');

w = load(store, cookies);   // reload / fresh open
ok('the favourite survives a reload', w.localStorage.getItem('magi.favProfile') === 'veda');
ok('the newer profile beats the stale one the store still holds',
   w.localStorage.getItem('magi.lastProfile') === 'veda');
ok('the ticked units survive a reload',
   w.localStorage.getItem('magi.veda.units') === JSON.stringify({ on: ['claude', 'gemini'] }));
ok('Brief/Text survives a reload', w.localStorage.getItem('magi.veda.mode') === 'text');
ok('no access key is written to a cookie', !/SECRET-TOKEN/.test(cookies.cookie), cookies.cookie);
ok('the engine registry (which holds keys) is not either', !/engines/.test(cookies.cookie));
ok('scoped by path, never site-wide', /path=" \+ CK_PATH/.test(GUARD) && !/path=\/;/.test(GUARD));

w.localStorage.removeItem('magi.favProfile');
w = load(store, cookies);
ok('un-starring survives a reload too', w.localStorage.getItem('magi.favProfile') === null);

console.log('\nOnce there is room again, the store is used and the cookie goes');
store._m.delete('td6_data');
const roomy = roomyStore();
for (const [k, v] of store._m) roomy.setItem(k, v);
w = load(roomy, cookies);
ok('a store with room is not flagged', w.MAGI_STORAGE_FULL === false);
w.localStorage.setItem('magi.veda.units', '{"on":["grok"]}');
ok('the write lands in the store', roomy.getItem('magi.veda.units') === '{"on":["grok"]}');
ok('and its cookie is dropped', !/magi_ls_magi_veda_units/.test(cookies.cookie), cookies.cookie);

console.log('\nA store with room behaves exactly as before');
const plain = roomyStore();
const plainJar = jar();
w = load(plain, plainJar);
w.localStorage.setItem('magi.favProfile', 'tony');
ok('writes go straight to the store', plain.getItem('magi.favProfile') === 'tony');
ok('and never to a cookie', plainJar.cookie === '');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
