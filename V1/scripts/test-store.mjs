// Tests for js/modules/store.js (F-2) and the escHtml sink fix (F-3).
//
// Two things here are the reason the file exists:
//
//   "getSnapshot is a deep copy"
//       The search index (F-4) and any pipeline job will hold a snapshot for
//       longer than one tick. If getSnapshot ever returns the live arrays, an
//       indexer could mutate user data by accident, and a stale index would
//       silently alias whatever studyos.js did next.
//
//   "escHtml('R&amp;D')"
//       F-3 as specced wanted a migration rewriting stored '&amp;' back to
//       '&'. That would corrupt a class genuinely named "R&amp;D". The bug was
//       never double-escaping -- names are stored raw and were injected into
//       innerHTML unescaped -- so the fix escapes at the sink and this test
//       pins the behavior that made the migration wrong.
//
// Run with:  npm run test:store
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};

// ── A window stub shaped like the one studyos.js runs against ──────────────
const bus = new EventEmitter();
bus.setMaxListeners(0);
globalThis.window = {
  addEventListener: (type, fn) => bus.on(type, fn),
  removeEventListener: (type, fn) => bus.off(type, fn),
  dispatchEvent: (ev) => { bus.emit(ev.type, ev); return true; },
};
globalThis.CustomEvent = class {
  constructor(type, init) { this.type = type; this.detail = (init || {}).detail; }
};

const { store } = await import(
  new URL('../js/modules/store.js', import.meta.url).href
);

// ── Before studyos.js boots, every read must degrade, not throw ────────────
console.log('\nstore: before boot');
t('not ready', store.ready === false);
t('getClasses -> []', Array.isArray(store.getClasses()) && store.getClasses().length === 0);
t('getTasks -> []', Array.isArray(store.getTasks()));
t('getKsu -> {modules:[]}', Array.isArray(store.getKsu().modules));
t('getSnapshot -> null', store.getSnapshot() === null);
t('setTaskDone -> false', store.setTaskDone('x', true) === false);
t('on() still returns an unsub', typeof store.on('tasks', () => {}) === 'function');

// ── Install a bridge with the same contract studyos.js installs ────────────
const tasks = [{ id: 't1', name: 'HW3', done: false }];
const classes = [{ id: 'c1', name: 'Computer Organization & Architecture' }];
window._sosBridge = {
  getClasses: () => classes,
  getEvents: () => [],
  getTasks: () => tasks,
  getNotes: () => [],
  getKsu: () => ({ modules: [] }),
  getModules: () => [],
  getSnapshot: () => JSON.parse(JSON.stringify({ classes, tasks })),
  setTaskDone: (id, done) => {
    const x = tasks.find(y => y.id === id);
    if (!x || x.done === done) return false;
    x.done = done;
    window.dispatchEvent(new CustomEvent('sos-changed', { detail: { entity: 'tasks' } }));
    return true;
  },
  subscribe: (fn) => {
    const onLocal = (e) => { try { fn((e.detail && e.detail.entity) || 'all', 'local'); } catch (_) {} };
    const onRemote = () => { try { fn('all', 'remote'); } catch (_) {} };
    window.addEventListener('sos-changed', onLocal);
    window.addEventListener('fb-sos-remote', onRemote);
    return () => {
      window.removeEventListener('sos-changed', onLocal);
      window.removeEventListener('fb-sos-remote', onRemote);
    };
  },
};

console.log('\nstore: reads');
t('ready once bridged', store.ready === true);
t('getTasks reads live data', store.getTasks()[0].id === 't1');
t('getClass finds by id', store.getClass('c1').name.includes('&'));
t('getClass -> null on miss', store.getClass('nope') === null);

const snap = store.getSnapshot();
snap.tasks[0].name = 'MUTATED';
t('getSnapshot is a deep copy', tasks[0].name === 'HW3');

console.log('\nstore: subscription');
let hits = [];
const off = store.on('tasks', (entity, origin) => hits.push([entity, origin]));
store.setTaskDone('t1', true);
t('local edit notifies', hits.length === 1 && hits[0][0] === 'tasks' && hits[0][1] === 'local');
t('and actually flipped it', tasks[0].done === true);

hits = [];
t('no-op edit -> false', store.setTaskDone('t1', true) === false);
t('no-op edit does not notify', hits.length === 0);

hits = [];
window.dispatchEvent(new CustomEvent('sos-changed', { detail: { entity: 'notes' } }));
t('unrelated entity filtered out', hits.length === 0);

hits = [];
window.dispatchEvent(new CustomEvent('fb-sos-remote', { detail: {} }));
t('remote arrives as all/remote', hits.length === 1 && hits[0][0] === 'all' && hits[0][1] === 'remote');

let wild = 0;
const offWild = store.on('*', () => wild++);
window.dispatchEvent(new CustomEvent('sos-changed', { detail: { entity: 'notes' } }));
window.dispatchEvent(new CustomEvent('sos-changed', { detail: { entity: 'events' } }));
t('wildcard sees every entity', wild === 2);
offWild();

hits = [];
off();
store.setTaskDone('t1', false);
t('unsubscribe detaches', hits.length === 0);

// A throwing subscriber must not break the save that triggered it, nor the
// other subscribers -- this is why subscribe() try/catches each callback.
let after = 0;
const offBad = store.on('*', () => { throw new Error('boom'); });
const offGood = store.on('*', () => after++);
let threw = false;
try { window.dispatchEvent(new CustomEvent('sos-changed', { detail: { entity: 'tasks' } })); }
catch (e) { threw = true; }
t('throwing listener is contained', threw === false);
t('other listeners still run', after === 1);
offBad(); offGood();

// ── F-3: escHtml, lifted out of js/studyos.js so the real one is tested ────
console.log('\nescHtml (F-3)');
const src = readFileSync(resolve(root, 'js/studyos.js'), 'utf8');
const m = src.match(/function escHtml\(s\) \{[\s\S]*?\n\}/);
if (!m) {
  fail++;
  console.log('  FAIL could not locate escHtml in js/studyos.js');
} else {
  const escHtml = new Function(m[0] + '; return escHtml;')();
  t('escapes a bare &', escHtml('Computer Organization & Architecture')
      === 'Computer Organization &amp; Architecture');
  // The case that made the specced migration wrong: this is a legitimate name,
  // not corrupted data, and must survive a round trip as itself.
  t('does not "repair" a real &amp;', escHtml('R&amp;D') === 'R&amp;amp;D');
  t('escapes <', escHtml('Math < Physics') === 'Math &lt; Physics');
  t('escapes >', escHtml('a > b') === 'a &gt; b');
  t('null -> empty', escHtml(null) === '');
  t('undefined -> empty', escHtml(undefined) === '');
  t('coerces numbers', escHtml(42) === '42');
  t('blocks a script tag', !escHtml('<script>alert(1)</script>').includes('<script>'));
}

// ── No user text may reach innerHTML unescaped (the F-3 regression guard) ──
console.log('\nrender sinks (F-3 regression guard)');
const lines = src.split('\n');
const risky = /\$\{\s*[A-Za-z_$][\w$]*\.(name|code|instructor|title|text|notes|label)(\s*\|\|[^}]*)?\s*\}/;
const offenders = [];
lines.forEach((l, i) => {
  if (risky.test(l) && !/escHtml|esc\(/.test(l)) offenders.push((i + 1) + ': ' + l.trim());
});
offenders.forEach(o => console.log('       ' + o));
t('no unescaped user text in template sinks', offenders.length === 0);

const rawInner = [];
lines.forEach((l, i) => {
  if (/innerHTML\s*=/.test(l) && /\b(cls|ev|task|mod|m|c|t|n)\.(name|title|label)\b/.test(l)
      && !/escHtml/.test(l)) rawInner.push((i + 1) + ': ' + l.trim());
});
rawInner.forEach(o => console.log('       ' + o));
t('no bare innerHTML = <user text>', rawInner.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
