// TaskHub wipe guard.
//
// 2026-08-25: a full set of goals vanished from BOTH profiles at once. Cloud and
// local agreed exactly, the day-key archives never held goals, and Firestore's
// free tier has no point-in-time recovery — so there was nothing to restore from.
// The last surviving copy was on a phone, and opening it synced the empty state
// down and destroyed that too.
//
// The guard refuses any write that destroys most of the content. It is
// deliberately biased toward refusing: a blocked legitimate delete costs one
// retry, a permitted wipe costs everything.

const fs = require('fs');
const path = require('path');

// Pull the real implementation out of index.html so the test can never drift
// from the shipped code.
const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function grab(marker) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('not found in index.html: ' + marker);
  let j = src.indexOf('{', i), depth = 0, k = j;
  for (; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(i, k + 1);
}

const code = [
  'const THB_MIN_ITEMS = 12, THB_KEEP_RATIO = 0.5;',
  'const _thbLastGood = {};',
  'let alerts = 0; function alert(){ alerts++; }',
  'const console = { error(){}, warn(){} };',
  grab('function _thbCount('),
  grab('function _thbAllow('),
  'module.exports = { _thbCount, _thbAllow, reset: () => { for (const k in _thbLastGood) delete _thbLastGood[k]; alerts = 0; }, alertCount: () => alerts };'
].join('\n');

const mod = { exports: {} };
new Function('module', code)(mod);
const { _thbCount, _thbAllow, reset, alertCount } = mod.exports;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};
const mk = (goals, habits, days) => ({
  goals: Array.from({ length: goals }, (_, i) => ({ id: 'g' + i })),
  habits: Array.from({ length: habits }, (_, i) => ({ id: 'h' + i })),
  data: Object.fromEntries(Array.from({ length: days }, (_, i) =>
    ['2026-08-' + String(i + 1).padStart(2, '0'), [{ id: 't' + i }, { id: 'u' + i }]]))
});

console.log('\n-- counting --');
ok('counts goals, habits and day items', _thbCount(mk(3, 2, 4)) === 3 + 2 + 8, _thbCount(mk(3, 2, 4)));
ok('empty payload counts zero', _thbCount({}) === 0);
ok('null is safe', _thbCount(null) === 0);

console.log('\n-- the wipe that actually happened --');
reset();
ok('first write of a session is always allowed (seeds the baseline)', _thbAllow('main', 'T', mk(20, 5, 10)));
ok('REFUSES goals+habits wiped to nothing', !_thbAllow('main', 'T', mk(0, 0, 10)));
ok('the person is told', alertCount() === 1, alertCount());
ok('a later good write still goes through', _thbAllow('main', 'T', mk(20, 5, 10)));

console.log('\n-- normal editing is never blocked --');
reset();
_thbAllow('main', 'T', mk(20, 5, 10));            // baseline: 20+5+20 = 45
ok('deleting one goal is fine', _thbAllow('main', 'T', mk(19, 5, 10)));
ok('deleting several is fine', _thbAllow('main', 'T', mk(14, 5, 10)));
ok('adding is fine', _thbAllow('main', 'T', mk(30, 8, 12)));
ok('clearing one old day is fine', _thbAllow('main', 'T', mk(30, 8, 11)));
ok('no false alarms raised', alertCount() === 0, alertCount());

console.log('\n-- boundary --');
reset();
_thbAllow('main', 'T', mk(0, 0, 10));             // baseline 20 items
ok('losing exactly half is allowed', _thbAllow('main', 'T', mk(0, 0, 5)));
reset();
_thbAllow('main', 'T', mk(0, 0, 10));
ok('losing more than half is refused', !_thbAllow('main', 'T', mk(0, 0, 4)));

console.log('\n-- small lists are not policed --');
reset();
_thbAllow('main', 'T', mk(2, 1, 1));              // 5 items, under THB_MIN_ITEMS
ok('a tiny list can be cleared without a fight', _thbAllow('main', 'T', mk(0, 0, 0)));

console.log('\n-- the two profiles are independent --');
reset();
_thbAllow('main', 'T', mk(20, 5, 10));
_thbAllow('vedasdash', 'V', mk(20, 5, 10));
ok('wiping Veda does not affect Tony baseline', !_thbAllow('vedasdash', 'V', mk(0, 0, 0)));
ok('Tony still writes normally afterwards', _thbAllow('main', 'T', mk(20, 5, 10)));

console.log('\n-- a wipe cannot sneak through by repeating --');
reset();
_thbAllow('main', 'T', mk(40, 0, 0));
ok('refused once', !_thbAllow('main', 'T', mk(0, 0, 0)));
ok('refused again — the baseline is NOT lowered by a rejected write',
   !_thbAllow('main', 'T', mk(0, 0, 0)));
ok('and again', !_thbAllow('main', 'T', mk(1, 0, 0)));

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
process.exit(fail ? 1 : 0);
