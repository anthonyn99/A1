// Guards MAGI's profile split: two people, two MAGIs, one file.
//
// Tony and Veda each get their own AI accounts, their own history, their own
// settings and their own password. The split is made of three small things,
// and every one of them fails SILENTLY and in the worst possible direction if
// it drifts:
//
//   1. The Firestore document path. `_indexDoc()` decides whose deliberations
//      this console reads. Hard-code it back to "magi" and Veda quietly reads
//      Tony's history -- no error, no warning, just the wrong person's
//      transcripts on screen.
//   2. The localStorage namespace. Every per-person key goes through lsKey().
//      A bare `magi.<name>` key is one both profiles read and write, so the
//      symptom is Veda inheriting Tony's API token and unit picks.
//   3. The unlock gate on the network. cloudInit() and tryReconnect() must
//      both refuse while PROFILE.unlocked is false, or a locked profile
//      fetches its own document -- into a persistent IndexedDB cache that
//      then sits on a machine its owner never unlocked.
//
// None of those throw. This file is the thing that notices.
//
// It is a static read of magi.html, like tests/magi-handoff.test.js: the
// end-to-end behaviour is proved in a real browser over CDP (see
// .claude/skills/verify), which needs a browser and so cannot run here.
//
// Run: node tests/magi-profiles.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAGI = fs.readFileSync(path.join(ROOT, 'magi.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

/** Lift a top-level function or const body out of the file by name. */
function lift(name) {
  const i = MAGI.indexOf(name);
  if (i < 0) return '';
  return MAGI.slice(i, i + 2600);
}

console.log('\nBoth profiles exist, and Tony keeps the document he already has');
const profiles = lift('const MAGI_PROFILES = {');
ok('there is a profile table', /const MAGI_PROFILES\s*=/.test(MAGI));
ok('Tony is in it', /\btony:\s*\{/.test(profiles));
ok('Veda is in it', /\bveda:\s*\{/.test(profiles));
// Tony's doc must stay "magi". Changing it silently orphans every deliberation
// he has ever run -- they do not move, the console just stops looking at them.
ok('Tony still reads dashboards/magi', /tony:[^}]*doc:\s*"magi"/.test(profiles), profiles.slice(0, 200));
ok('Veda reads a different document', /veda:[^}]*doc:\s*"magi_veda"/.test(profiles));
ok('their lock records are separate',
   /tony:[^}]*lock:\s*"tony_magi"/.test(profiles) && /veda:[^}]*lock:\s*"veda_magi"/.test(profiles));
ok('they are visually distinguishable',
   /tony:[^}]*color:\s*"#e0b874"/.test(profiles) && /veda:[^}]*color:\s*"#8D769A"/.test(profiles));

console.log('\nThe Firestore path is derived, never hard-coded');
ok('_indexDoc asks the profile', /_indexDoc\s*=\s*\(\)\s*=>[^;]*prof\(\)\.doc/.test(MAGI));
ok('_runDoc asks the profile', /_runDoc\s*=\s*\(id\)\s*=>[^;]*prof\(\)\.doc/.test(MAGI));
ok('neither names a document literally',
   !/CLOUD\.fs\.doc\(CLOUD\.db,\s*"dashboards",\s*"magi"/.test(MAGI));

console.log('\nEvery per-person key is namespaced');
// The keys that are one person's data. A bare "magi.x" for any of these is a
// key both profiles share.
for (const [decl, key] of [
  ['TOKEN_KEY', 'token'], ['GOOD_TOKEN_KEY', 'token.ok'],
  ['UNIT_ORDER_KEY', 'unitorder'], ['UNIT_PICK_KEY', 'units'],
  ['AUDIO_PREFS_KEY', 'studio.audio'], ['QUEUE_KEY', 'queue'],
  ['PIN_KEY', 'pins'], ['UNPIN_KEY', 'unpinned'], ['NICK_KEY', 'nicks'],
  ['BS_PIN_KEY', 'bspins'], ['BS_NICK_KEY', 'bsnicks'], ['BS_UNPIN_KEY', 'bsunpinned'],
]) {
  const re = new RegExp('const ' + decl + '\\s*=\\s*lsKey\\("' + key.replace('.', '\\.') + '"\\)');
  ok(decl + ' is per profile', re.test(MAGI));
}
ok('lsKey really namespaces', /const lsKey\s*=\s*\(name\)\s*=>\s*`magi\.\$\{PROFILE\.id\}\.\$\{name\}`/.test(MAGI));
ok('the lock session is per profile', /const LOCK_LS\s*=\s*lsKey\("lock_session"\)/.test(MAGI));
ok('the locked flag is per profile', /const LOCKED_LS\s*=\s*lsKey\("locked"\)/.test(MAGI));
ok('the lock record is per profile', /entryId:\s*prof\(\)\.lock/.test(MAGI));
ok('the biometric credential is per profile', /BIO_ID\s*=\s*PROFILE\.id/.test(MAGI));

console.log('\nDevice-shaped settings stay shared');
// Muting MAGI must not un-mute itself because you switched profile.
for (const k of ['magi.muted', 'magi.nav.collapsed', 'magi.device', 'magi.cloud']) {
  ok(k + ' is not namespaced', MAGI.indexOf('"' + k + '"') >= 0, k);
}

console.log('\nTony\'s existing keys are carried over, once');
const mig = lift('function migrateLegacyKeys');
ok('there is a migration', /migrateLegacyKeys/.test(MAGI));
ok('it marks itself done', /magi\.tony\.migrated/.test(mig));
ok('it copies rather than moves', !/removeItem/.test(mig), 'an older tab still reads the legacy names');
for (const k of ['magi.token', 'magi.pins', 'magi_lock_session']) {
  ok('it carries ' + k, mig.indexOf('"' + k + '"') >= 0);
}

console.log('\nNothing reaches the network while a profile is locked');
const ci = lift('function cloudInit()');
ok('cloudInit refuses when locked', /if\s*\(!PROFILE\.unlocked\)\s*return/.test(ci));
// If the refusal were memoised into CLOUD.ready, sync would stay dead for the
// rest of the session after the unlock.
ok('and does not memoise the refusal',
   /if\s*\(!PROFILE\.unlocked\)\s*return\s+Promise\.resolve\(false\);/.test(ci));
const tr = lift('async function tryReconnect()');
ok('tryReconnect refuses when locked', /if\s*\(!PROFILE\.unlocked\)\s*return;/.test(tr),
   'pageshow fires on every load, so without this a locked console probes the engine');
ok('discovery is not started at boot beside the gate',
   !/^lockBoot\(\);\s*\nconnect\(\)/m.test(MAGI));
ok('it is started by the unlock instead', /function openUp\(\)/.test(MAGI) && /openUp\(\);/.test(lift('function hideLock()')));

console.log('\nThe gate is ours, not the browser\'s');
const gate = lift('function renderLock()') + lift('function lockFormInto(box)')
           + lift('function gateCard(id)') + lift('function pwField(');
ok('no native dialog in the gate', !/\b(window\.)?(alert|confirm|prompt)\s*\(/.test(gate));
ok('the password field is drawn', /function pwField\(/.test(MAGI));
ok('it has a reveal toggle', /gate-eye/.test(MAGI));
ok('it warns about caps lock', /getModifierState\("CapsLock"\)/.test(MAGI));
ok('both cards are rendered', /for \(const id of PROFILE_ORDER\) cards\.append\(gateCard\(id\)\)/.test(MAGI));

console.log('\nSwitching profile is a reload, not a reassignment');
const sel = lift('function selectProfile(id)');
ok('the other profile reloads', /location\.reload\(\)/.test(sel),
   'key constants are evaluated once at load; reassigning PROFILE.id would strand them');
ok('the choice is remembered first', /setItem\(LAST_PROFILE_LS, id\)/.test(sel));
ok('PROFILE.id is resolved from storage at load', /localStorage\.getItem\(LAST_PROFILE_LS\)/.test(MAGI));

console.log('\nThe console says whose MAGI it is');
ok('there is a profile chip', /id="profBtn"/.test(MAGI));
ok('and one on mobile too', /id="profBtnM"/.test(MAGI),
   'the sidebar is a shut drawer on a phone');
ok('it is painted from the profile', /function syncProfileBtn\(\)/.test(MAGI));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
