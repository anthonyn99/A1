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
//  4. The Vault extension drifts. Its toolbar popup is a THIRD opener for
//     vault.html, and it cannot name a window, so it hands the key over as
//     ?a1tab=<key> instead. That key is a bare string in a different codebase
//     from the one index.html uses — nothing links them but this check, and a
//     mismatch shows up only as Vault quietly opening twice.
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
// The fourth message has a different opener: TradeHub, handing MAGI a prompt.
// Focus alone would bring the console forward without the question it was sent.
const tradehub = fs.readFileSync(path.join(ROOT, 'tradehub.html'), 'utf8');
ok('"deliver" is handled on both ends (the opener hands over a url)',
  /t:'deliver'/.test(tradehub) && /d\.t === 'deliver'/.test(sync));
ok('a delivered url must be same-origin', /function ownOrigin\(/.test(sync) && /ownOrigin\(d\.url\)/.test(sync));

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

console.log('\nTradeHub opens MAGI through the same pairing');
// Analysis sends its prompt to the console rather than to a chat site, so it is
// a second opener for a tab TaskHub also opens. Two openers that disagree about
// the key are two tabs.
const magiKey = (/const TB_MAGI_TAB_KEY='([^']+)'/.exec(tradehub) || [])[1];
ok('TradeHub names a tab key for MAGI', !!magiKey, magiKey);
ok("it is the key index.html uses for MAGI ('" + magiKey + "')",
  index.includes("_tnOpenTab(URL_MAGI, '" + magiKey + "')"));
ok('and it builds the same window name', /const TB_MAGI_TAB_NAME='a1tab_'\+TB_MAGI_TAB_KEY/.test(tradehub));
const opener = tradehub.slice(tradehub.indexOf('function tbOpenMagi(url){'));
const openerFn = opener.slice(0, opener.indexOf('\n}'));
ok('it claims the tab by name before opening anything',
  /window\.open\('',\s*TB_MAGI_TAB_NAME\)/.test(openerFn), openerFn.slice(0, 300));
ok('a blank tab triggers the handover', /tbTabClaimed\([^)]*\)\)\{tbHandOverMagi\(/.test(openerFn), openerFn.slice(-400));
ok('it reads the same heartbeat key tabsync writes', /'a1tab:'\+key/.test(tradehub));
ok('the named-tab path never passes noopener', !/window\.open\('',\s*TB_MAGI_TAB_NAME,/.test(tradehub));

console.log('\nA tab that was not opened from TaskHub stays out of it');
ok('no key means tabsync does nothing', /if \(!key\) return;/.test(sync));
ok('a tab only ever clears its own claim', /r\.id === ID\) localStorage\.removeItem/.test(sync));
const retire = sync.slice(sync.indexOf('function retire()'));
ok('retiring gives up the key before trying to close',
  retire.indexOf("window.name = ''") > 0 && retire.indexOf("window.name = ''") < retire.indexOf('window.close()'));

console.log('\nThe Vault extension opens the SAME tab, not a second one');
const popup = fs.readFileSync(path.join(ROOT, 'Vault', 'popup.js'), 'utf8');
// The gear is the extension's only route into vault.html. A bare
// chrome.tabs.create there is the whole bug: it always makes a new tab.
const gear = popup.slice(popup.indexOf('gearEl.addEventListener("click"')).slice(0, 400);
ok('the gear goes through openVaultApp', /openVaultApp\(/.test(gear), gear);
ok('the gear no longer opens a tab unconditionally', !/chrome\.tabs\.create/.test(gear));
ok('an already-open Vault is focused rather than re-created',
  /chrome\.tabs\.query\(/.test(popup) && /chrome\.tabs\.update\(/.test(popup));
// Focusing the tab alone leaves it behind another window, and the click then
// looks like it did nothing at all.
ok('and its window is raised too', /chrome\.windows\.update\([^)]*focused/.test(popup));

// The one constant shared across the two codebases. index.html opens Vault as
// _tnOpenTab(url, 'vault'); the extension must hand the tab that same key, or
// the two openers pair with two different tabs.
const vaultKey = (/const VAULT_TAB_KEY = "([^"]+)"/.exec(popup) || [])[1];
ok('the extension names a tab key', !!vaultKey, vaultKey);
ok("it is the key index.html uses for Vault ('" + vaultKey + "')",
  index.includes("_tnOpenTab(URL_VAULT, '" + vaultKey + "')"));
ok('it travels as ?a1tab=', /a1tab=/.test(popup));
ok('tabsync reads that parameter', /params\.get\('a1tab'\)/.test(sync));
// Left in the url it would survive into every later read of location.search,
// and into anything the user bookmarks or shares.
ok('and strips it back out of the address bar',
  /params\.delete\('a1tab'\)/.test(sync) && /history\.replaceState/.test(sync));
ok('a url key outranks a stale sessionStorage one', /var key = urlKey;/.test(sync));

console.log('\nA url key really does pair the tab (jsdom)');
try {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://anthonyn99.github.io/A1/vault.html?vaulttab=payments&a1tab=vault',
    runScripts: 'outside-only',
  });
  dom.window.eval(sync);
  const w = dom.window;
  ok('the tab takes the name index.html looks for', w.name === 'a1tab_vault', w.name);
  ok('the parameter is gone from the url', w.location.search === '?vaulttab=payments', w.location.search);
  ok('?vaulttab still reaches vault-ui.js',
    new w.URLSearchParams(w.location.search).get('vaulttab') === 'payments');
  const beat = JSON.parse(w.localStorage.getItem('a1tab:vault') || 'null');
  ok('it heartbeats under that key, so a restarted Index finds it', !!(beat && beat.t));
  ok('the key survives a name wipe, via sessionStorage',
    w.sessionStorage.getItem('a1TabKey') === 'vault');
  dom.window.close();
} catch (e) {
  ok('jsdom run', false, e && e.message);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
