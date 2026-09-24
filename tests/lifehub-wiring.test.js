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
//  3. It creeps into a place it was never meant to be: Index, or Wellness.
//     Profile programs must pass data-profile-attr, or Veda would be shown
//     Tony's list instead of her own.
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
  ok(file + (want.profile ? ' follows the Tony/Veda profile (data-profile-attr)' : ' is Tony-only, no profile attr needed'),
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
// The body of `var NAME = [ … ];` in lifehub.js.
const block = (name) => (new RegExp('var ' + name + ' = \\[([\\s\\S]*?)\\n  \\];').exec(src) || [])[1] || '';
const names = (b) => [...b.matchAll(/\{ id: '([a-z_]+)', name: '([^']+)'/g)].map((m) => m[2]);
const tony = block('DEFAULT_APPS'), veda = block('VEDA_APPS');
ok("seeds exactly Tony's ten programs, in order", names(tony).join() === 'OneInbox,TradeHub,MyList,Insight,Vault,Solace,Shield,Shield (HTML),RiftIQ,MAGI', names(tony));
ok("seeds Veda's own list: the programs with a Veda profile", names(veda).join() === 'MyList,Shield,Shield (HTML)', names(veda));
ok("each profile has its own document and mirror (Tony's unchanged)",
  /tony: \{ doc: 'lifehub', ls: 'lifehub:v1'/.test(src) && /veda: \{ doc: 'lifehub_veda', ls: 'lifehub:v1:veda'/.test(src));
ok("Veda's Shield (HTML) opens under TaskHub's Veda key 'shield_veda'", /\{ id: 'shield_html'[^}]*tab: 'shield_veda'/.test(veda));
ok("the desktop Shield tile is the agent's installed path, per profile",
  /url: SHIELD_EXE\.tony/.test(tony) && /url: SHIELD_EXE\.veda/.test(veda) &&
  src.includes("tony: 'C:\\\\Users\\\\antho\\\\AppData\\\\Local\\\\Shield\\\\shield-agent.exe'"));
ok('lists still on shieldopen:show are moved to the path, once', /LEGACY_SHIELD_LINK = 'shieldopen:show'/.test(src) && /function migrate\(/.test(src));

console.log('\nLocal programs');
const shieldHtml = read('shield.html');
const localRe = (code) => (/function _?isLocalPath\(u\)\s*\{\s*return ([^\r\n]+)/.exec(code) || [])[1];
ok('the local-path test is identical in lifehub.js, index.html and shield.html',
  !!localRe(src) && localRe(src) === localRe(index) && localRe(src) === localRe(shieldHtml),
  [localRe(src), localRe(index), localRe(shieldHtml)].join(' | '));
ok('LifeHub sends shieldopen:lh:<profile>:<id>',
  /'shieldopen:' \+ localKey\(/.test(src) && /return 'lh:' \+ profile \+ ':' \+ id;/.test(src));
ok('shield.html pushes those same keys into the agent map, merged with the others',
  /_lastLhLinks = out;/.test(shieldHtml) && /Object\.keys\(_lastLhLinks\)/.test(shieldHtml) && shieldHtml.includes('/^lh:(tony|veda):[A-Za-z0-9_-]+$/'));
ok('shield.html starts it only where there is an agent (inside attachNavorder)', /_classAppsListen\(\);\s*_whenLifeHub\(\);/.test(shieldHtml));
const rs = fs.readFileSync(path.join(ROOT, 'desktop', 'shield', 'src-tauri', 'src', 'lib.rs'), 'utf8');
ok('the agent pins the lh: link grammar in a test', /fn lifehub_link_path_is_its_map_key\(/.test(rs));
ok('the agent still understands shieldopen:show (old links in the wild)', /fn is_show_link\(/.test(rs) && /is_show_link\(&url\)/.test(rs));

// The pure helpers, run for real — lifted out of the IIFE by name.
const fnSrc = (name) => (new RegExp('\\n  function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}').exec(src) || [''])[0];
const box = {};
vm.runInNewContext([
  (/var BAD_SCHEME = [^\n]+/.exec(src) || [''])[0], fnSrc('isLocalPath'), fnSrc('normUrl'),
  'this.normUrl = normUrl;'].join('\n'), box);
const N = box.normUrl || (() => 'missing');
ok('a plain path is kept', N('C:\\Apps\\x.exe') === 'C:\\Apps\\x.exe', N('C:\\Apps\\x.exe'));
ok("Explorer's quoted \"Copy as path\" is unwrapped", N('"C:\\Program Files\\x.exe"') === 'C:\\Program Files\\x.exe', N('"C:\\Program Files\\x.exe"'));
ok('file:/// becomes a path', N('file:///C:/Program%20Files/x.exe') === 'C:\\Program Files\\x.exe', N('file:///C:/Program%20Files/x.exe'));
ok('UNC paths are kept', N('\\\\nas\\share\\a.exe') === '\\\\nas\\share\\a.exe');
ok('paths with forbidden characters are refused',
  N('C:\\a.exe"&calc') === '' && N('C:\\a\nb.exe') === '' && N('C:\\a|b') === '' && N('C:\\a:b') === '');
ok('web links behave as before',
  N('example.com') === 'https://example.com' && N('https://x.y/a') === 'https://x.y/a' && N('javascript:alert(1)') === '' && N('file:///etc/passwd') === '');

console.log('\nSpark budget');
ok('exactly one onSnapshot', (src.match(/\.onSnapshot\(/g) || []).length === 1);
ok('exactly one write site, inside the batched transaction',
  (src.match(/\btx\.set\(/g) || []).length === 1 && !/\b(setDoc|updateDoc|addDoc)\(/.test(src));
ok('writes are debounced', /st\.wt = setTimeout\(function \(\) \{ flush\(st\); \}, \d+\)/.test(src));
// connect() is the only road to Firestore; it is reached from ensureSync (the
// listener) and flush (a save) and nowhere else.
ok('Firestore is reached only through ensureSync and flush', (src.match(/\bconnect\(\)/g) || []).length === 3,   // its definition + those two calls
  (src.match(/\bconnect\(\)/g) || []).length);
// ensureSync's callers: warm() (launcher hover/focus/touch), open(), a finished
// save, retry(), and localLinks (inside the Shield agent only).
const ensureCalls = [...src.matchAll(/^.*\bensureSync\b.*$/gm)].map((m) => m[0].trim())
  .filter((l) => !/^function ensureSync/.test(l) && !/^\/\//.test(l));
ok('the listener starts only on launcher approach, open, a save, a retry, or the agent',
  ensureCalls.length === 5 &&
  [...src.matchAll(/addEventListener\('(pointerenter|focus|touchstart)', warm/g)].length === 3 &&
  /function warm\(\) \{[\s\S]*?ensureSync\(S\);/.test(src),
  ensureCalls.join(' | '));
ok('failed attempts retry on a backoff, never a hot loop', /var RETRY_MS = \[\d{4,}/.test(src));
ok('a retry can never stack a second listener (generation guard)', /if \(gen !== st\.gen\) return;/.test(src) && /st\.gen\+\+;/.test(src));
ok('MAGI hands over its own lazily-started Firebase', /window\.LifeHubFirebase\s*=/.test(read('magi.html')));

console.log('\n' + pass + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
process.exit(fail ? 1 : 0);
