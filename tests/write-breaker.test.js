/* The write circuit breaker, lifted out of shield.html and driven directly.

   This is the guard that exists because a feedback loop between a write and its
   own snapshot once burned 18,000 writes and 43,000 reads in a single hour. The
   bug is fixed; the CLASS of bug is easy to reintroduce, so the breaker matters
   more than any individual fix and deserves a test that does not depend on a
   browser being willing to run 70 rejected promises. */
'use strict';
const fs = require('fs');
const SRC = fs.readFileSync(require('path').join(__dirname,'..','shield.html'), 'utf8');

function grab(name) {
  const m = SRC.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}', 'm'));
  if (!m) throw new Error('cannot find ' + name);
  return m[0];
}
const consts = (SRC.match(/var WRITE_LIMIT = \d+, WRITE_WINDOW = \d+;/) || [])[0];
if (!consts) throw new Error('cannot find WRITE_LIMIT / WRITE_WINDOW');

let NOW = 1000000;
const make = () => new Function('now', 'syncState', 'toast', 'console', `
  ${consts}
  var _wrTripped = false, _wrTimes = [];
  ${grab('writeAllowed')}
  return { allowed: writeAllowed, tripped: function(){ return _wrTripped; },
           limit: WRITE_LIMIT, window: WRITE_WINDOW };
`)(() => NOW, () => {}, () => {}, { error: () => {}, warn: () => {} });

const results = [];
const check = (n, p, d) => { results.push(p); console.log('  ' + (p ? 'PASS  ' : 'FAIL  ') + n + (d ? '  [' + d + ']' : '')); };

console.log('\nNormal use is never impeded');
{
  const B = make();
  console.log('  (ceiling: ' + B.limit + ' writes per ' + B.window / 1000 + 's)');
  // Real usage: a registration, some config edits, a heartbeat every 15 min.
  NOW = 1000000;
  let ok = 0;
  for (let i = 0; i < 200; i++) { NOW += 20000; if (B.allowed()) ok++; }   // one every 20s for ~66min
  check('a write every 20 seconds for an hour is fine', ok === 200 && !B.tripped(), ok + '/200');
}
{
  const B = make();
  NOW = 1000000;
  let ok = 0;
  // A burst of edits: adding several targets quickly is legitimate.
  for (let i = 0; i < 20; i++) { NOW += 300; if (B.allowed()) ok++; }
  check('a burst of 20 edits in 6s is fine', ok === 20 && !B.tripped(), ok + '/20');
}

console.log('\nA runaway is cut off');
{
  const B = make();
  NOW = 1000000;
  let ok = 0;
  for (let i = 0; i < 1000; i++) { NOW += 10; if (B.allowed()) ok++; }   // 100/sec
  check('a 100-per-second loop is stopped', ok <= B.limit, 'let through ' + ok + ' of 1000');
  check('and the breaker latches', B.tripped() === true);
  check('it stays latched for the session', B.allowed() === false,
    'must not recover on its own - the loop would just resume');
  NOW += 10 * 60 * 1000;
  check('even ten minutes later', B.allowed() === false);
}

console.log('\nThe window really is a sliding one');
{
  const B = make();
  NOW = 1000000;
  // Sit just under the ceiling, repeatedly, with the window rolling past.
  let ok = 0, blocked = 0;
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < B.limit - 1; i++) { NOW += 100; B.allowed() ? ok++ : blocked++; }
    NOW += B.window + 1000;   // let the window drain
  }
  check('staying under the ceiling never trips it', blocked === 0 && !B.tripped(),
    ok + ' allowed, ' + blocked + ' blocked');
}

console.log('\nThe exact boundary');
{
  const B = make();
  NOW = 1000000;
  let ok = 0;
  for (let i = 0; i < B.limit; i++) { NOW += 1; if (B.allowed()) ok++; }
  check('exactly ' + B.limit + ' rapid writes are allowed', ok === B.limit && !B.tripped(), ok + '');
  check('the very next one trips it', B.allowed() === false && B.tripped() === true);
}

console.log('\n' + results.filter(Boolean).length + '/' + results.length + ' checks passed');
process.exit(results.every(Boolean) ? 0 : 1);
