/* The emergency state machine, lifted out of shield.html and driven directly.

   These are the exact predicates that decide whether a device shows the
   takeover screen. The bug they exist to pin: emgOn() ORed the device's own
   `active` flag with the global one, so any device that entered an ALL-DEVICES
   lockdown — the one that raised it just as much as the ones that received it —
   stayed locked forever once the global was lifted anywhere else. Both
   directions failed, PC→phone and phone→PC.

   Run: node emg-state-test.js */
'use strict';
const fs = require('fs');

const SRC = fs.readFileSync(require('path').join(__dirname, '..', 'shield.html'), 'utf8');

// Pull the real functions out of the page rather than restating them here — a
// copy would pass while the shipped code stayed broken.
function grab(name) {
  const re = new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}', 'm');
  const m = SRC.match(re);
  if (!m) throw new Error('could not find function ' + name + ' in shield.html');
  return m[0];
}

let LE = { active: false }, G = { active: false, v: 0 }, OPTED = false;
const ctx = {
  localEmg: () => LE,
  globalState: () => G,
  optedOut: () => OPTED,
};
// globalOn() is a one-liner the page defines beside these; pull it in too so
// nothing here is a restatement.
const globalOnSrc = SRC.match(/function globalOn\(\)\{[^\n]*\}/)[0];
const body = [globalOnSrc, grab('localIsGlobal'), grab('emgOn'), grab('emgSource')].join('\n');
const make = new Function('localEmg', 'globalState', 'optedOut',
  body + '\nreturn { emgOn: emgOn, emgSource: emgSource, localIsGlobal: localIsGlobal };');
const F = make(ctx.localEmg, ctx.globalState, ctx.optedOut);

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
}
function scenario(le, g, opted) {
  LE = le; G = g; OPTED = !!opted;
  return { on: F.emgOn(), source: F.emgSource() };
}

const OFF = { active: false, v: 0 };
const ON = (v) => ({ active: true, v: v || 1000, byName: 'Phone' });

console.log('\nA device that RAISED an all-devices emergency');
{
  // actEmergencyGlobal: runEmergency('local','','global') then publishes.
  const le = { active: true, source: 'local', scope: 'global', v: 1000 };
  check('is locked while the global is up', scenario(le, ON()).on === true);
  // The phone lifts it. Firestore says off; this device's own flag is untouched.
  const r = scenario(le, OFF);
  check('releases when the global is lifted from another device', r.on === false,
    'this was the PC→phone half of the bug');
  check('and reports no source once released', r.source === null);
}

console.log('\nA device that RECEIVED an all-devices emergency');
{
  const le = { active: true, source: 'remote', scope: 'global', v: 1000 };
  check('is locked while the global is up', scenario(le, ON()).on === true);
  check('releases when the global is lifted elsewhere', scenario(le, OFF).on === false,
    'this was the phone→PC half');
  check('releases when it opts out on its own', scenario(le, ON(), true).on === false);
}

console.log('\nA purely LOCAL emergency is nobody else\'s business');
{
  const le = { active: true, source: 'local', scope: 'local', v: 0 };
  check('stays locked with no global at all', scenario(le, OFF).on === true);
  check('stays locked when a global is lifted elsewhere', scenario(le, OFF).on === true,
    'lifting all-devices must not release a lockdown it never owned');
  check('reports itself as local', scenario(le, OFF).source === 'local');
  check('a global arriving on top still reads as global', scenario(le, ON()).source === 'global');
}

console.log('\nRecords written before `scope` existed');
{
  // Migration: `remote` can only have come from a global command.
  const recvd = { active: true, source: 'remote', v: 900 };
  check('an old remote record is treated as global', F.localIsGlobal(recvd) === true);
  check('and releases when the global goes', scenario(recvd, OFF).on === false);
  const local = { active: true, source: 'local', v: 0 };
  check('an old local record stays local', F.localIsGlobal(local) === false);
  check('and survives the global being lifted', scenario(local, OFF).on === true);
}

console.log('\nNot locked at all');
{
  check('idle device is not locked', scenario({ active: false }, OFF).on === false);
  check('idle device with a live global IS locked', scenario({ active: false }, ON()).on === true,
    'this is what makes a reconnecting device arrive into the lockdown');
  check('idle device that opted out stays free', scenario({ active: false }, ON(), true).on === false);
}

console.log('\nThe full round trip, as the two devices actually experience it');
{
  // PC presses All My Devices.
  let pc = { active: true, source: 'local', scope: 'global', v: 1000 };
  let phone = { active: false };
  let global = ON(1000);
  check('PC locks', scenario(pc, global).on === true);
  check('phone locks on its next snapshot', scenario(phone, global).on === true);
  // The phone enters the lockdown, so it now has its own record.
  phone = { active: true, source: 'remote', scope: 'global', v: 1000 };
  // Passcode entered on the PHONE, disabling everywhere: global goes false.
  global = { active: false, v: 1001 };
  check('phone releases', scenario(phone, global).on === false);
  check('PC releases too', scenario(pc, global).on === false, 'the half that was broken');

  // And the reverse: raise from the phone, lift from the PC.
  phone = { active: true, source: 'local', scope: 'global', v: 2000 };
  pc = { active: true, source: 'remote', scope: 'global', v: 2000 };
  global = ON(2000);
  check('raised from the phone, both are locked',
    scenario(phone, global).on === true && scenario(pc, global).on === true);
  global = { active: false, v: 2001 };
  check('lifted from the PC, both release',
    scenario(phone, global).on === false && scenario(pc, global).on === false);
}

console.log('\n' + results.filter(Boolean).length + '/' + results.length + ' checks passed');
process.exit(results.every(Boolean) ? 0 : 1);
