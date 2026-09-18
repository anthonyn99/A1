// Guards LifeHub — the app switcher built once in LifeHub/lifehub.js and
// dropped into each program with two lines (an <a1-lifehub> element and one
// <script> tag).
//
// Ways this rots without anything erroring:
//
//  1. A program loses its <script> or its <a1-lifehub> — the icon just stops
//     appearing there. A new program belongs in HOSTS the day it gets LifeHub.
//  2. A host's data-lock selector stops matching its lock screen (renamed id)
//     — the launcher then shows over a locked program. The selector is checked
//     against the file it lives in.
//  3. It creeps into a place it was never meant to be: Index, or a Veda
//     program. Profile programs must pass data-profile-attr or Veda sees it.
//  4. The tab keys drift from index.html's. LifeHub and TaskHub then open
//     the same program in two different tabs.
//  5. The Spark budget erodes: a second listener, or a write outside the one
//     batched transaction.
//
// Run: node tests/lifehub-wiring.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Every program LifeHub is integrated into, with what its tag must carry.
const HOSTS = {
  'oneinbox.html': { lock: '#lockScreen' },
  'tradehub.html': { lock: '#applock-overlay' },
  'mylist.html':   { lock: '#lock-overlay', profile: true },
  'insight.html':  { lock: '#lockScreen' },
  'vault.html':    { lock: '#applock-overlay' },
  'solace.html':   { lock: '#applock-overlay' },
  'shield.html':   { lock: '#applock-overlay', profile: true },
  'riftiq.html':   { lock: '#applock-overlay' },
  'magi.html':     { lock: '#lockScreen' },
};
// Deliberately without it: Index (the suite shell) and Veda's own program.
const NEVER = ['index.html', 'wellness.html'];

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

const LH = 'LifeHub/lifehub.js';
ok('LifeHub/lifehub.js exists', fs.existsSync(path.join(ROOT, LH)));
if (!fs.existsSync(path.join(ROOT, LH))) { console.log('\n  1 failed'); process.exit(1); }
const src = read(LH);
let parsed = true;
try { new vm.Script(src, { filename: LH }); } catch (e) { parsed = false; }
ok('lifehub.js parses', parsed);
ok('it is the only LifeHub file besides its README',
  fs.readdirSync(path.join(ROOT, 'LifeHub')).filter((f) => f !== 'README.md').join() === 'lifehub.js',
  fs.readdirSync(path.join(ROOT, 'LifeHub')));

console.log('\nEvery host loads it, once, and places the launcher');
const tagRe = /<script\b[^>]*\bsrc=["']LifeHub\/lifehub\.js["'][^>]*><\/script>/g;
for (const [file, want] of Object.entries(HOSTS)) {
  const html = read(file);
  const tags = html.match(tagRe) || [];
  ok(file + ' loads LifeHub/lifehub.js exactly once', tags.length === 1, tags.length);
  const tag = tags[0] || '';
  ok(file + ' loads it deferred (never blocks first paint)', /\bdefer\b/.test(tag), tag);
  ok(file + ' has an <a1-lifehub> launcher', /<a1-lifehub\b/.test(html));
  const lock = (/data-lock=["']([^"']+)["']/.exec(tag) || [])[1];
  ok(file + ' names its lock screen (' + want.lock + ')', lock === want.lock, lock);
  if (lock && lock[0] === '#') {
    const id = lock.slice(1);
    const present = html.includes('id="' + id + '"') || html.includes("id='" + id + "'") ||
      new RegExp('\\.id\\s*=\\s*["\']' + id + '["\']').test(html);
    ok(file + ' actually has an element ' + lock, present);
  }
  ok(file + (want.profile ? ' shows it only for Tony (data-profile-attr)' : ' is Tony-only, no profile attr needed'),
    want.profile ? /data-profile-attr=["']data-profile["']/.test(tag) : !/data-profile-attr/.test(tag), tag);
}

console.log('\nNowhere it does not belong');
for (const f of NEVER) {
  const html = read(f);
  ok(f + ' has no LifeHub', !/lifehub\.js/i.test(html) && !/<a1-lifehub\b/.test(html));
}

console.log('\nSame tabs as TaskHub');
const index = read('index.html');
const tabsync = read('tabsync.js');
ok('same a1tab_ window-name prefix', /'a1tab_'/.test(src) && /\/\^a1tab_\(\.\+\)\$\//.test(tabsync));
ok('same a1tab: heartbeat prefix', /'a1tab:'\s*\+/.test(src) && /LS_PREFIX\s*=\s*'a1tab:'/.test(tabsync));
ok('same a1tabs channel', /new BroadcastChannel\('a1tabs'\)/.test(src));
for (const msg of ['claim', 'claimed', 'retire']) {
  ok(`"${msg}" handshake message`, src.includes(`'${msg}'`) && tabsync.includes(`'${msg}'`));
}
ok('the named-tab path never passes noopener', !/window\.open\('',\s*name,/.test(src) && !/noopener['"]\)/.test(src));
// The keys TaskHub's own buttons use. Different keys = two tabs of one program.
const tabOf = (id) => (new RegExp("\\{ id: '" + id + "'[^}]*tab: '([^']+)'").exec(src) || [])[1];
for (const [id, key] of [['tradehub', 'tradehub'], ['riftiq', 'warroom'], ['vault', 'vault'], ['solace', 'solace'], ['magi', 'magi']]) {
  ok(`${id} opens under TaskHub's key '${key}'`, tabOf(id) === key && index.includes("_tnOpenTab(URL_" ) && new RegExp("_tnOpenTab\\([A-Z_]+, '" + key + "'\\)").test(index), tabOf(id));
}
ok("Shield (HTML) opens under TaskHub's Tony key 'shield_tony'",
  tabOf('shield_html') === 'shield_tony' && /var tab = 'shield_' \+ profile;/.test(index), tabOf('shield_html'));

console.log('\nThe initial configuration');
const ids = [...src.matchAll(/\{ id: '([a-z_]+)', name: '([^']+)'/g)].map((m) => m[2]);
ok('seeds exactly the ten programs, in order', ids.join() === 'OneInbox,TradeHub,MyList,Insight,Vault,Solace,Shield,Shield (HTML),RiftIQ,MAGI', ids);
ok('the desktop Shield tile raises the agent via shieldopen:show', /url: 'shieldopen:show'/.test(src));
const rs = fs.readFileSync(path.join(ROOT, 'desktop', 'shield', 'src-tauri', 'src', 'lib.rs'), 'utf8');
ok('...and the agent understands that verb', /fn is_show_link\(/.test(rs) && /is_show_link\(&url\)/.test(rs));

console.log('\nSpark budget');
ok('exactly one onSnapshot', (src.match(/\.onSnapshot\(/g) || []).length === 1);
ok('exactly one write site, inside the batched transaction',
  (src.match(/\btx\.set\(/g) || []).length === 1 && !/\b(setDoc|updateDoc|addDoc)\(/.test(src));
ok('writes are debounced', /S\.wt = setTimeout\(flush, \d+\)/.test(src));
// connect() is the only road to Firestore; it is reached from ensureSync (the
// listener) and flush (a save) and nowhere else, and ensureSync itself is only
// wired to the launcher being approached or the panel opening.
ok('Firestore is reached only through ensureSync and flush', (src.match(/\bconnect\(\)/g) || []).length === 3,   // its definition + those two calls
  (src.match(/\bconnect\(\)/g) || []).length);
const ensureCalls = [...src.matchAll(/^.*\bensureSync\b.*$/gm)].map((m) => m[0].trim())
  .filter((l) => !/^function ensureSync/.test(l) && !/^\/\//.test(l));
ok('the listener starts only on launcher hover/focus/touch, open, or after a save',
  ensureCalls.length === 5 && ensureCalls.filter((l) => /addEventListener\('(pointerenter|focus|touchstart)', ensureSync/.test(l)).length === 3,
  ensureCalls.join(' | '));
ok('MAGI hands over its own lazily-started Firebase', /window\.LifeHubFirebase\s*=/.test(read('magi.html')));

console.log('\n' + pass + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
process.exit(fail ? 1 : 0);
