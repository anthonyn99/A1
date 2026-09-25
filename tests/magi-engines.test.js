// Guards MAGI's engine registry: one profile, engines on several machines.
//
// MAGI's engine cannot move -- it drives real Chrome profiles holding live
// logins -- so "where is the engine?" used to have exactly one answer. It has
// more than one the moment a second machine runs one, and three things about
// that fail silently if they drift:
//
//   1. Each engine needs its OWN token. `magi-link` keys its KV records by the
//      SHA-256 of the token, so two engines sharing one would overwrite each
//      other's "where am I" record and the phone would follow whichever
//      published last. A shared token also lets either person's console reach
//      the other's engine and the accounts signed in behind it.
//   2. The registry must be keyed on the engine's OWN id, not on the process.
//      `instance` is fresh per process -- right for tunnel adoption, wrong for
//      "is this the same laptop as yesterday?" -- so keying on it would grow a
//      new row in the picker on every reboot.
//   3. Syncing it must not cost a second Firestore listener. It rides the
//      document that already has one.
//
// Run: node tests/magi-engines.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAGI = fs.readFileSync(path.join(ROOT, 'magi.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'magi', 'app.py'), 'utf8');
const IDENT = fs.readFileSync(path.join(ROOT, 'magi', 'ident.py'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};
function lift(name, n = 3000) {
  const i = MAGI.indexOf(name);
  return i < 0 ? '' : MAGI.slice(i, i + n);
}

console.log('\nAn engine identifies itself, and the identity outlives the process');
ok('there is an engine identity', /def engine_identity\(\)/.test(IDENT));
ok('it is written down, not minted per run', /engine\.json/.test(IDENT));
ok('and it is distinct from the per-process instance',
   /INSTANCE = uuid\.uuid4\(\)\.hex/.test(IDENT) && /def engine_identity/.test(IDENT),
   'instance is right for tunnel adoption and wrong for naming a machine');
ok('health reports the engine', /"engine": ident\.engine_identity\(\)/.test(APP));
ok('health reports the profile', /"profile": active_profile\(\)/.test(APP));

console.log('\nThe console keeps a registry, learned from the engines themselves');
ok('there is a registry', /const ENG = \{/.test(MAGI));
ok('it is per profile', /const ENGINES_KEY = lsKey\("engines"\)/.test(MAGI));
const seen = lift('function engSeen(');
ok('an engine that answers is recorded', /function engSeen\(/.test(MAGI));
ok('keyed on the engine id, not the process',
   /health\.engine/.test(seen) && !/instance/.test(seen));
// An upgrade must not leave two rows for one machine.
ok('the pre-registry token is absorbed, not duplicated',
   /ENG\.list\.find\(\(x\) => !x\.id && x\.token === token\)/.test(seen),
   'otherwise the first connection after an upgrade shows two rows for one PC');
ok('a label you typed is not overwritten by the machine\'s guess',
   /if \(!e\.label\) e\.label = label/.test(seen));

console.log('\nEvery engine carries its own token');
const add = lift('function engAdd(');
ok('adding one takes a token', /function engAdd\(token\)/.test(MAGI));
ok('entries store a token each', /token: t, port: 8000/.test(add));
ok('the same token is not added twice', /ENG\.list\.find\(\(e\) => e\.token === t\)/.test(add));
// The engine's own env var name differs per profile for the same reason.
const settings = fs.readFileSync(path.join(ROOT, 'magi', 'settings.py'), 'utf8');
ok('the engine reads a per-profile token variable', /def api_token_env\(\)/.test(settings));
ok('and Tony keeps the name his devices already use',
   /"MAGI_API_TOKEN" if p == DEFAULT_PROFILE/.test(settings));

console.log('\nDiscovery walks the registry, not a single hard-coded engine');
const conn = lift('async function connect(quiet = false)');
ok('connect tries each engine', /for \(const eng of order\)/.test(conn));
ok('the active one is tried first', /if \(act\) order\.push\(act\)/.test(conn),
   'the machine you usually use should not wait behind one that is asleep');
ok('it stops at the first that answers', /if \(online\(\)\) \{ syncEngineBtn\(\); return r; \}/.test(conn));
const to = lift('async function connectTo(eng, quiet = false)', 6000);
ok('each engine brings its own port', /const ENG_PORT = \(eng && eng\.port\) \|\| 8000/.test(to));
ok('and its own token', /link\.token = \(eng && eng\.token\) \|\| loadToken\(\)/.test(to));
ok('loopback uses that port', /probe\(ENG_LOCAL\)/.test(to),
   'a second engine on 8001 is unreachable if discovery only ever tries 8000');
// First contact on a PC where 8000 is held by something else (Tony's engine,
// or an unrelated server): the fresh browser only knows 8000, so it must also
// try the port onboard gave this profile, or it never finds the engine.
ok('first contact also tries the profile\'s spare port',
   /const spare = PROFILE_SPARE_PORTS\[PROFILE\.id\]/.test(to) &&
   /!\(eng && eng\.id\)/.test(to) && /await probe\(alt\) === "ok"/.test(to),
   'a new browser on Veda\'s PC hit whatever held 8000 and stopped there');
const ONBOARD = fs.readFileSync(path.join(ROOT, 'magi', 'cli', 'onboard.py'), 'utf8');
const pyPorts = (ONBOARD.match(/PROFILE_PORTS = \{([^}]*)\}/) || [])[1] || '';
const jsPorts = (MAGI.match(/const PROFILE_SPARE_PORTS = \{([^}]*)\}/) || [])[1] || '';
const pairs = (s) => [...s.matchAll(/"?(\w+)"?\s*:\s*(\d+)/g)].map((m) => m[1] + ':' + m[2]);
ok('the console\'s spare ports match onboard\'s',
   pairs(pyPorts).filter((p) => !/:8000$/.test(p)).sort().join() === pairs(jsPorts).sort().join(),
   pyPorts + ' vs ' + jsPorts);

console.log('\nAn engine belonging to someone else is refused');
const probe = lift('async function probe(base');
ok('the profile is checked', /theirs !== PROFILE\.id/.test(probe));
ok('and refused by name', /return "wrongprofile"/.test(probe));
ok('the console says whose it is', /link\.otherProfile = theirs/.test(probe));
ok('a pre-profile engine is treated as the default profile',
   /String\(h\.profile \|\| "tony"\)/.test(probe),
   'older engines report nothing there, and those are Tony\'s');

console.log('\nSyncing costs no extra listener and no extra read');
ok('engines ride the existing index document',
   /setDoc\(_indexDoc\(\), \{ engines: rows \}, \{ merge: true \}\)/.test(MAGI));
ok('the write is debounced', /_engCloudT = setTimeout/.test(MAGI));
ok('inbound engines fold in on the listener already attached',
   /Array\.isArray\(d\.engines\) && engMerge\(d\.engines\)/.test(MAGI));
ok('no second onSnapshot was added',
   (MAGI.match(/onSnapshot\(/g) || []).length === 1,
   'its cost is bounded by write volume; a second one doubles it forever');
// lastSeen is what THIS device reached, so syncing it would have a phone claim
// the laptop is up because the desktop saw it a minute ago.
ok('lastSeen stays local',
   /\.map\(\(e\) => \(\{ id: e\.id, label: e\.label \|\| "", token: e\.token, port: e\.port \|\| 8000 \}\)\)/.test(MAGI));
ok('merging is a union, not a replace', /function engMerge\(rows\)/.test(MAGI));

console.log('\nThe picker is ours, and stays out of the way');
const pick = lift('function openEnginePicker()', 5000);
ok('there is a picker', /function openEnginePicker\(\)/.test(MAGI));
ok('hidden until there is a choice', /const many = ENG\.list\.filter\(\(e\) => e\.id\)\.length > 1/.test(MAGI));
ok('no native dialog', !/\b(window\.)?(alert|confirm|prompt)\s*\(/.test(pick));
ok('forgetting one asks first', /uiConfirmMagi\(/.test(pick));
ok('opening it does not wake every machine', !/await probe\(/.test(pick),
   'reachability shown is what the last connection found');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
