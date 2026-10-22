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
//  3. It creeps into a place it was never meant to be: Wellness, or a
//     launcher in Index (Index uses it headless: Tony's External Links ARE
//     his LifeHub list, shown as header buttons, since 2026-10-12).
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
  'oneinbox.html': { lock: 'guardian' },
  'tradehub.html': { lock: 'guardian' },
  'mylist.html':   { lock: 'guardian', profile: true },
  'insight.html':  { lock: 'guardian' },
  'vault.html':    { lock: 'guardian' },
  'everwell.html': { lock: 'guardian' },
  'shield.html':   { lock: 'guardian', profile: true },
  'riftiq.html':   { lock: 'guardian' },
  'magi.html':     { lock: '#lockScreen' },
  'Shruti/shruti.html': { lock: 'guardian', profile: true },
};
// Deliberately without it: Veda's own program.
const NEVER = ['wellness.html'];

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
// Its README lives in docs/LifeHub/ with every other doc (2026-10-01).
ok('it is the only LifeHub file',
  fs.readdirSync(path.join(ROOT, 'LifeHub')).join() === 'lifehub.js',
  fs.readdirSync(path.join(ROOT, 'LifeHub')));

console.log('\nEvery host loads it, once, and places the launcher');
// TradeHub, Insight and Vault live in ../A1-Priv and load it by absolute URL
// (tests/moved.js).
const M = require('./moved');
const tagRe = new RegExp('<script\\b[^>]*\\bsrc=["\']' + M.src('LifeHub/lifehub.js') + '["\'][^>]*><\\/script>', 'g');
for (const [file, want] of Object.entries(HOSTS)) {
  if (M.isMoved(file) && !M.has(file)) { M.skipNote(file); continue; }
  const html = M.read(file);
  const tags = html.match(tagRe) || [];
  ok(file + ' loads LifeHub/lifehub.js exactly once', tags.length === 1, tags.length);
  const tag = tags[0] || '';
  ok(file + ' loads it deferred (never blocks first paint)', /\bdefer\b/.test(tag), tag);
  ok(file + ' has an <a1-lifehub> launcher', /<a1-lifehub\b/.test(html));
  const lock = (/data-lock=["']([^"']+)["']/.exec(tag) || [])[1];
  ok(file + ' names its lock screen (' + want.lock + ')', lock === want.lock, lock);
  // 'guardian' = the host locks with Guardian; LifeHub asks Guardian.isOpen().
  if (lock === 'guardian') ok(file + ' loads Guardian for that lock', html.includes('Guardian/guardian.js'));
  if (lock && lock[0] === '#') {
    const id = lock.slice(1);
    const present = html.includes('id="' + id + '"') || html.includes("id='" + id + "'") ||
      new RegExp('\\.id\\s*=\\s*["\']' + id + '["\']').test(html);
    ok(file + ' actually has an element ' + lock, present);
  }
  ok(file + (want.profile ? ' follows the Tony/Veda profile (data-profile-attr)' : ' is Tony-only, no profile attr needed'),
    want.profile ? /data-profile-attr=["']data-profile["']/.test(tag) : !/data-profile-attr/.test(tag), tag);
}

console.log('\nPrograms that moved to A1-Priv (docs/a1-priv-move-plan.md)');
{
  const moved = ['tradehub', 'insight', 'vault', 'riftiq'];
  for (const p of moved) ok(p + ' seeds on its new host', new RegExp("\{ id: '" + p + "'[^}]*url: PRIV \+ '" + p + "\.html'").test(src));
  ok("LifeHub's PRIV is the private host", /var PRIV = 'https://a1-priv.av1.workers.dev/';/.test(src));
  ok('LifeHub has no Solace icon or seed left', !/solace: "<svg/.test(src) && !/id: 'solace'/.test(src));
  // Every stored link was checked on the server to be on its new address
  // (2026-10-22), so neither launcher keeps an old-to-new table any more, and
  // the old pages are gone: no redirects anywhere.
  const idx = read('index.html');
  ok('LifeHub has no old-address table', !/var MOVED = \{/.test(src) && !/movedUrl|movedPatch/.test(src));
  ok('Index has no old-address table', !/MOVED_PROGRAMS|_movedUrl/.test(idx) && !/id:'solace'/.test(idx));
  ok('Index no longer forwards ?goto=keychain', !/_gotoKeychain/.test(idx));
  for (const p of [...moved, 'solace']) ok('A1 holds no copy of ' + p + '.html', !fs.existsSync(path.join(ROOT, p + '.html')));
}

console.log("\nIndex: Tony's External Links are his LifeHub list");
{
  const idx = read('index.html');
  const tags = idx.match(tagRe) || [];
  ok('index.html loads LifeHub/lifehub.js exactly once, deferred, Guardian lock',
    tags.length === 1 && /\bdefer\b/.test(tags[0]) && /data-lock="guardian"/.test(tags[0]), tags.join(' '));
  ok('…headless: no <a1-lifehub> launcher (the header buttons are the display)', !/<a1-lifehub\b/.test(idx));
  ok("its header follows LifeHub.watch('tony') and opens through LifeHub.launch",
    /LH\.watch\('tony', _lhApply\)/.test(idx) && /LH\.launch\('tony', id\)/.test(idx));
  ok('Settings edits go to LifeHub (add / update / remove / reorder)',
    /LH\.add\('tony',/.test(idx) && /LH\.update\('tony',id,/.test(idx) && /LH\.remove\('tony',id\)/.test(idx) && /LH\.reorder\('tony',idArray\)/.test(idx));
  ok('hidden apps, and PC programs on a device that cannot start them, stay out of the header',
    /function _lhInHeader\(a\)\{ return !!\(a && a\.url && !a\.hidden && \(!_isLocalPath\(a\.url\) \|\| _lhCanLocal\(\)\)\); \}/.test(idx));
  ok("Tony's external buttons have no App Lock gate",
    !/alGate\('tony_(tradehub|warroom|everwell|magi)'/.test(idx) && !/alGate\(profile \+ '_shield'/.test(idx) && /profile === 'veda' && window\.alGate\) window\.alGate\('veda_shield'/.test(idx));
  ok('LifeHub exposes the headless API Index uses',
    ['watch', 'list', 'launch', 'add', 'update', 'remove', 'reorder', 'reconnect', 'canLocal'].every((k) => new RegExp('\\n    ' + k + ': ').test(src)));
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
for (const [id, key] of [['tradehub', 'tradehub'], ['riftiq', 'warroom'], ['vault', 'vault'], ['everwell', 'everwell'], ['magi', 'magi']]) {
  ok(`${id} opens under TaskHub's key '${key}'`, tabOf(id) === key && index.includes("_tnOpenTab(URL_" ) && new RegExp("_tnOpenTab\\([A-Z_]+, '" + key + "'\\)").test(index), tabOf(id));
}
ok("Shield (HTML) opens under TaskHub's Tony key 'shield_tony'",
  tabOf('shield_html') === 'shield_tony' && /var tab = 'shield_' \+ profile;/.test(index), tabOf('shield_html'));

console.log('\nThe initial configuration');
// The body of `var NAME = [ … ];` in lifehub.js.
const block = (name) => (new RegExp('var ' + name + ' = \\[([\\s\\S]*?)\\n  \\];').exec(src) || [])[1] || '';
const names = (b) => [...b.matchAll(/\{ id: '([a-z_]+)', name: '([^']+)'/g)].map((m) => m[2]);
const tony = block('DEFAULT_APPS'), veda = block('VEDA_APPS');
ok("seeds exactly Tony's eleven programs, in order", names(tony).join() === 'OneInbox,TradeHub,MyList,Insight,Vault,Everwell,Shield,Shield (HTML),RiftIQ,MAGI,Shruti', names(tony));
ok("seeds Veda's own list: the programs with a Veda profile", names(veda).join() === 'MyList,Shield,Shield (HTML),Shruti', names(veda));
// A program added after the lists exist reaches them once per device, never twice.
ok('a later program is added to existing lists once (ADDED_LATER)', /var ADDED_LATER = \['shruti'\];/.test(src) && /ADDED_LATER\.forEach\([\s\S]{0,400}localStorage\.setItem\(mark, '1'\)[\s\S]{0,120}if \(!byId\(list, id\)\) commit\(st, addOp/.test(src));
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

console.log('\nIcons');
{
  // The real a1IconFor, with the real BASE / PRIV / ICONS keys and destKey.
  const ib = {};
  const keys = (/var ICONS = \{([\s\S]*?)\n  \};/.exec(src) || ['', ''])[1];
  const iconKeys = [...keys.matchAll(/^\s*'?([a-z-]+)'?:\s*"/gm)].map((m) => m[1]);
  vm.runInNewContext([
    "var URL = this.URL, location = { href: 'https://anthonyn99.github.io/A1/index.html' };",
    "var BASE = 'https://anthonyn99.github.io/A1/', PRIV = 'https://a1-priv.av1.workers.dev/';",
    'var ICONS = {' + iconKeys.map((k) => JSON.stringify(k) + ':1').join(',') + '};',
    fnSrc('destKey'), fnSrc('a1IconFor'), 'this.f = a1IconFor;'].join('\n'), Object.assign(ib, { URL }));
  const f = ib.f || (() => 'missing');
  ok('an automatic tile on the private host gets its built-in icon (Everwell)', f('https://a1-priv.av1.workers.dev/everwell.html') === 'everwell', f('https://a1-priv.av1.workers.dev/everwell.html'));
  ok('…and on A1\'s host', f('https://anthonyn99.github.io/A1/magi.html') === 'magi');
  ok('another site with a same-named page does not', f('https://example.com/everwell.html') === '');

  // A local program: its built-in icon by file name (a Shield tile showed "S").
  const lb = {};
  vm.runInNewContext(['var ICONS = {' + iconKeys.map((k) => JSON.stringify(k) + ':1').join(',') + '};',
    fnSrc('isLocalPath'), fnSrc('localIconFor'), 'this.f = localIconFor;'].join('\n'), lb);
  const L = lb.f || (() => 'missing');
  ok('a local Shield (the agent .exe, any user; its desktop shortcut; shieldopen:) gets Shield\'s icon',
    L('C:\\Users\\antho\\AppData\\Local\\Shield\\shield-agent.exe') === 'shield' && L('C:\\Users\\vedap\\AppData\\Local\\Shield\\shield-agent.exe') === 'shield' &&
    L('C:\\Users\\antho\\Desktop\\Shield.lnk') === 'shield' && L('shieldopen:show') === 'shield',
    L('C:\\Users\\antho\\AppData\\Local\\Shield\\shield-agent.exe'));
  ok('…another local program, a web page or a "link" file gets none', L('C:\\Games\\League.exe') === '' && L('https://x.y/shield.exe') === '' && L('C:\\a\\link.lnk') === '');
  ok('an automatic tile, a built-in icon that no longer exists, or an image that fails all fall back to the program\'s own',
    /var auto = !ic \|\| ic === 'auto' \|\| \(key && !ICONS\[key\]\);/.test(src) && /if \(auto\) key = a1IconFor\(a\.url\) \|\| localIconFor\(a\.url\);/.test(src) &&
    /var fk = a1IconFor\(a\.url\) \|\| localIconFor\(a\.url\);/.test(src));

  // A program changes its favicon: LifeHub's copy must change with it, or the
  // launcher keeps showing the old mark. Each built-in icon is checked against
  // its program's <link rel="icon"> (private-repo pages when that repo is here).
  const PAGES = { oneinbox: 'oneinbox.html', tradehub: '../A1-Priv/tradehub.html', mylist: 'mylist.html', insight: '../A1-Priv/insight.html', vault: '../A1-Priv/vault.html',
    everwell: '../A1-Priv/everwell.html', shield: 'shield.html', riftiq: '../A1-Priv/riftiq.html', magi: 'magi.html', taskhub: 'index.html', shruti: 'Shruti/shruti.html' };
  const svgs = {};
  for (const m of keys.matchAll(/^\s*'?([a-z-]+)'?:\s*"([^"]*)"/gm)) svgs[m[1]] = m[2];
  const favicon = (f) => {
    const h = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const tag = (h.match(/<link\b[^>]*>/gi) || []).find((t) => /\brel=["'](?:shortcut )?icon["']/i.test(t));
    const m = tag && (/href="([^"]+)"/.exec(tag) || /href='([^']+)'/.exec(tag));
    return m ? decodeURIComponent(m[1].replace(/^data:image\/svg\+xml(;utf8)?,/, '')) : null;
  };
  Object.keys(PAGES).forEach((k) => {
    if (!fs.existsSync(path.join(ROOT, PAGES[k]))) { console.log('  skip ' + k + ' (' + PAGES[k] + ' not here)'); return; }
    ok('LifeHub\'s ' + k + ' icon is ' + PAGES[k] + '\'s favicon', svgs[k] === favicon(PAGES[k]), 'update ICONS.' + k + ' in LifeHub/lifehub.js');
  });
  ok('every built-in icon is checked (a new one belongs in PAGES)', iconKeys.every((k) => PAGES[k] || k === 'shield-desktop' || k === 'link'), iconKeys.join());
  const wk = read('workers/lifehub-icon/worker.js');
  ok('the icon worker says when it could not read the page', /read: !!html/.test(wk));
  ok('…and LifeHub then reads the page itself, keeping the worker\'s guess as a fallback',
    /if \(list\.length && !read\) \{ guess = list; tryRoute\(i \+ 1\); \}/.test(src) && /done\(guess\)/.test(src));
  ok('a tile TaskHub\'s import duplicated (link_ tab, same page as another tile) is removed once',
    /if \(!st\.dupDone\)/.test(src) && /commit\(st, removeOp\(id\)\)/.test(src));
}

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
// save, retry(), localLinks (inside the Shield agent only), watch (a headless
// host: Index) and reconnect (that host's Firestore was replaced).
const ensureCalls = [...src.matchAll(/^.*\bensureSync\b.*$/gm)].map((m) => m[0].trim())
  .filter((l) => !/^function ensureSync/.test(l) && !/^\/\//.test(l));
ok('the listener starts only on launcher approach, open, a save, a retry, the agent, or a headless host',
  ensureCalls.length === 7 &&
  [...src.matchAll(/addEventListener\('(pointerenter|focus|touchstart)', warm/g)].length === 3 &&
  /function warm\(\) \{[\s\S]*?ensureSync\(S\);/.test(src),
  ensureCalls.join(' | '));
ok('failed attempts retry on a backoff, never a hot loop', /var RETRY_MS = \[\d{4,}/.test(src));
ok('a retry can never stack a second listener (generation guard)', /if \(gen !== st\.gen\) return;/.test(src) && /st\.gen\+\+;/.test(src));
// GitHub Pages caches this file for 10 minutes; a plain refresh must still run
// the deployed version (a conditional revalidation, then a one-off url).
ok('it revalidates itself on load and swaps in a newer deploy',
  /fetch\(BOOT\.src, \{ cache: 'no-cache'/.test(src) && /txt\.indexOf\(String\(main\)\)/.test(src) && /'lhfresh='/.test(src));
ok('hosts that need it after load wait for lifehub:ready',
  /dispatchEvent\(new Event\('lifehub:ready'\)\)/.test(src) && /addEventListener\('lifehub:ready'/.test(read('shield.html')));
ok('MAGI hands over its own lazily-started Firebase', /window\.LifeHubFirebase\s*=/.test(read('magi.html')));

console.log('\n' + pass + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
process.exit(fail ? 1 : 0);
