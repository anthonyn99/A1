// Guards the "one tab per destination" wiring — index.html's _tnOpenTab on the
// opening side, tabsync.js on the destination side.
//
// The pairing normally runs on window names, which only work inside one
// browsing-context group. Closing the browser breaks every one of those links,
// so after a restart a click used to open a SECOND MAGI tab beside the restored
// one. tabsync.js is the second channel that survives a restart: a localStorage
// heartbeat plus a BroadcastChannel handshake.
//
// Three ways that can rot without anything erroring:
//
//  1. A page stops loading tabsync.js — its tab silently stops answering, and
//     the duplicate comes back for that destination only. A NEW single-file app
//     belongs in PAGES the day it ships.
//  2. The two sides drift apart. They agree by convention on a storage prefix,
//     a channel name and three message types; rename one end and the handshake
//     stops matching, which looks exactly like "no tab answered".
//  3. _tnOpenTab stops asking. Every external button in TaskHub — both profiles,
//     built-in programs and custom links alike — funnels through it, so the
//     check living there is what makes this apply to links added later.
//
// Run: node tests/tabsync-wiring.test.js

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Every same-origin page that can be opened as a named tab from TaskHub.
// StudyOS is deliberately absent: it is served from a Cloudflare Worker on a
// different origin, where neither localStorage nor a BroadcastChannel is shared
// with this one, so it can only ever have the window-name pairing.
const PAGES = [
  'index.html', 'magi.html', 'riftiq.html', 'tradehub.html', 'shield.html',
  'mylist.html', 'solace.html', 'vault.html', 'insight.html', 'oneinbox.html',
  'wellness.html',
];

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

const syncPath = path.join(ROOT, 'tabsync.js');
ok('tabsync.js exists at the repo root', fs.existsSync(syncPath));
if (!fs.existsSync(syncPath)) { console.log('\n  1 failed'); process.exit(1); }
const sync = fs.readFileSync(syncPath, 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

console.log('\nEvery A1 page answers for its tab');
for (const p of PAGES) {
  const html = fs.readFileSync(path.join(ROOT, p), 'utf8');
  ok(p + ' loads tabsync.js', /<script[^>]+src=["']tabsync\.js["']/.test(html));
}

console.log('\nThe two sides speak the same protocol');
ok('both use the a1tab_ window-name prefix',
  /'a1tab_'/.test(index) && /\/\^a1tab_\(\.\+\)\$\//.test(sync));
ok('both use the a1tab: storage prefix',
  /'a1tab:'\s*\+/.test(index) && /LS_PREFIX\s*=\s*'a1tab:'/.test(sync));
ok('both use the a1tabs channel',
  /new BroadcastChannel\('a1tabs'\)/.test(index) && /CHANNEL\s*=\s*'a1tabs'/.test(sync));
for (const [msg, who] of [['claim', 'the opener asks'], ['claimed', 'the tab answers'], ['retire', 'the tab stands down']]) {
  ok(`"${msg}" is handled on both ends (${who})`,
    index.includes(`'${msg}'`) && sync.includes(`'${msg}'`));
}

console.log('\nThe opener actually consults the heartbeat');
ok('_tnOpenTab exists', /window\._tnOpenTab\s*=\s*function/.test(index));
const body = index.slice(index.indexOf('window._tnOpenTab = function'));
const fn = body.slice(0, body.indexOf('\n};'));
ok('a blank tab triggers the handover', /claimedElsewhere\([^)]*\)\s*\)?\s*handOver\(/.test(fn), fn.slice(-400));
ok('the key is sanitised the same way the tab will read it back',
  /storeKey\(key\)/.test(fn) && /function storeKey\(key\)\{ return tabName\(key\)\.slice\(6\); \}/.test(index));
// The name pairing only works while the destination keeps an opener handle back
// to this page; noopener would put it in its own group and every click would
// spawn a fresh tab. This has regressed once already.
ok('the named-tab path never passes noopener', !/window\.open\('',\s*name,/.test(index));

console.log('\nA tab that was not opened from TaskHub stays out of it');
ok('no key means tabsync does nothing', /if \(!key\) return;/.test(sync));
ok('a tab only ever clears its own claim', /r\.id === ID\) localStorage\.removeItem/.test(sync));
const retire = sync.slice(sync.indexOf('function retire()'));
ok('retiring gives up the key before trying to close',
  retire.indexOf("window.name = ''") > 0 && retire.indexOf("window.name = ''") < retire.indexOf('window.close()'));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
