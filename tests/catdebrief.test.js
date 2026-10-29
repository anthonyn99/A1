// Guards the Catalysts debrief ▶ (catdebrief.js): when it appears, what it
// asks MAGI, which profile and units it convenes, and that both TaskHubs and
// TradeHub's settings are wired to the same file and the same doc.
//
// Run: node tests/catdebrief.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'catdebrief.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const MAGI = fs.readFileSync(path.join(ROOT, 'magi.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

/** A fresh copy of the module with a fake window: `opened` records every
 *  window.open, `tabs` decides what the named-tab lookup hands back. */
function load(opts) {
  opts = opts || {};
  const opened = [], events = [];
  const sb = {
    TextEncoder, TextDecoder, btoa, atob, Intl, Date, JSON, Math, console, setTimeout, clearTimeout,
    CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    dispatchEvent(e) { events.push(e.type); },
    localStorage: { getItem: () => opts.claimed ? JSON.stringify({ t: Date.now() }) : null },
    open(url, name) {
      opened.push({ url, name });
      if (opts.blocked) return null;
      return opts.tab || { location: { href: 'about:blank', replace(u) { this.href = u; opened.push({ nav: u }); } }, focus() {}, name: '' };
    },
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(SRC, sb);
  return { D: sb.A1Debrief, opened, events, sb };
}
const { D } = load();
const b64uDecode = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const payloadOf = (url) => JSON.parse(b64uDecode(/#tb=([^&]+)/.exec(url)[1]));
const iso = (ms) => new Date(ms).toISOString().slice(0, 16) + 'Z';

console.log('\nSettings: any stored shape becomes a whole config');
{
  const d = D.normalize(null);
  ok('both profiles get the four verified units by default', d.tony.units.join() === 'chatgpt,claude,gemini,deepseek' && d.veda.units.join() === d.tony.units.join());
  ok('and the default templates', d.templates.earnings === D.TEMPLATES.earnings && d.templates.macro === D.TEMPLATES.macro);
  const e = D.normalize({ veda: { units: [] }, tony: { units: ['gemini', 'GEMINI', 'gemini', '<x>', '', 'claude-pro'] }, templates: { earnings: '   ', macro: 'Go {event}' } });
  ok('an EMPTY unit list is a choice and is kept', Array.isArray(e.veda.units) && e.veda.units.length === 0);
  ok('junk and duplicate unit ids are dropped', e.tony.units.join() === 'gemini,claude-pro', e.tony.units);
  ok('a blank template falls back to the default', e.templates.earnings === D.TEMPLATES.earnings);
  ok('a custom one is kept', e.templates.macro === 'Go {event}');
  ok('no stored default means the built-in one', e.defaults.earnings === D.TEMPLATES.earnings && d.defaults.macro === D.TEMPLATES.macro);
  const f = D.normalize({ templates: { earnings: '', macro: 'Now {event}' }, defaults: { earnings: 'Mine {ticker}', macro: '  ' } });
  ok('a default set in TradeHub is kept', f.defaults.earnings === 'Mine {ticker}');
  ok('a blank template falls back to THAT default', f.templates.earnings === 'Mine {ticker}');
  ok('a blank default falls back to the built-in one', f.defaults.macro === D.TEMPLATES.macro && f.templates.macro === 'Now {event}');
  const L = load();
  L.D.setConfig({ tony: { units: ['grok'] } });
  ok('setConfig announces itself', L.events.includes('a1debrief:config'));
  ok('and is what config() returns', L.D.config().tony.units.join() === 'grok');
}

console.log('\nTiming: ten minutes after the release, in New York time');
{
  const cpi = { kind: 'macro', category: 'inflation', title: 'September CPI Report', date: '2026-10-14' };
  ok('an 8:30 ET release is due at 8:40 ET (EDT)', iso(D.dueAt(cpi, { hh: 8, mm: 30 })) === '2026-10-14T12:40Z', iso(D.dueAt(cpi, { hh: 8, mm: 30 })));
  ok('and across the DST change (EST)', iso(D.dueAt({ ...cpi, date: '2026-12-10' }, { hh: 8, mm: 30 })) === '2026-12-10T13:40Z');
  ok('an FOMC decision at 2:00 ET is due at 2:10', iso(D.dueAt({ ...cpi, category: 'fed' }, { hh: 14, mm: 0 })) === '2026-10-14T18:10Z');
  const earn = (when) => ({ kind: 'earnings', title: 'TSM Earnings', ticker: 'TSM', date: '2026-10-15', when });
  ok('before-the-open earnings: 8:10 ET', iso(D.dueAt(earn('bmo'))) === '2026-10-15T12:10Z', iso(D.dueAt(earn('bmo'))));
  ok('after-the-close earnings: 4:40 ET', iso(D.dueAt(earn('amc'))) === '2026-10-15T20:40Z');
  ok('untagged earnings wait for the later session', iso(D.dueAt(earn(null))) === '2026-10-15T20:40Z');
  ok('a release with no clock waits for the close', iso(D.dueAt({ kind: 'macro', title: 'Waller speaks', date: '2026-10-15' }, null)) === '2026-10-15T20:40Z');
  ok('a market holiday never gets a button', D.dueAt({ kind: 'holiday', title: 'Thanksgiving', date: '2026-11-26' }) === null);
  ok('nor does an event with a bad date', D.dueAt({ kind: 'macro', date: 'soon' }, { hh: 8, mm: 30 }) === null);
  const at = D.dueAt(cpi, { hh: 8, mm: 30 });
  ok('not due a minute before', !D.isDue(cpi, { hh: 8, mm: 30 }, at - 60000));
  ok('due from the minute itself', D.isDue(cpi, { hh: 8, mm: 30 }, at) && D.isDue(cpi, { hh: 8, mm: 30 }, at + 86400000));
  const list = [earn('amc'), cpi, { ...cpi, date: '2026-10-01' }];
  const nd = D.nextDue(list, (e) => e.kind === 'earnings' ? null : { hh: 8, mm: 30 }, at - 1000);
  ok('nextDue finds the soonest one still ahead', nd === at, iso(nd));
  ok('and nothing once all are past', D.nextDue(list, () => ({ hh: 8, mm: 30 }), Date.parse('2027-01-01')) === null);
}

console.log('\nThe prompt: fill in the blank, per event');
{
  const tsm = { kind: 'earnings', title: 'TSM Earnings', ticker: 'TSM', date: '2026-10-15', when: 'bmo', epsEst: 2.6 };
  const q = D.fill(D.TEMPLATES.earnings, tsm);
  ok('names the ticker', /^TSM just reported earnings/.test(q), q.slice(0, 60));
  ok('says when it reported', /\(before the open, Thu, Oct 15, 2026\)/.test(q), q.slice(0, 90));
  ok('carries the consensus', /consensus was \$2\.60/.test(q));
  ok('asks for results, consensus and the expected market move', /consensus/i.test(q) && /Expected market movement/.test(q) && /Guidance/.test(q));
  ok('leaves no placeholder behind', !/\{[a-zA-Z]+\}/.test(q));
  const bare = D.fill(D.TEMPLATES.earnings, { ...tsm, when: null, epsEst: null, ticker: null });
  ok('an untagged report tidies the empty blank away', /\(Thu, Oct 15, 2026\)/.test(bare) && !/\(\s*,/.test(bare), bare.slice(0, 80));
  ok('the ticker still comes from the title', /^TSM /.test(bare));
  ok('a missing consensus says so', /consensus was not available/.test(bare));
  const cpi = D.fill(D.TEMPLATES.macro, { kind: 'macro', category: 'inflation', title: 'September CPI Report', date: '2026-10-14' }, { hh: 8, mm: 30 });
  ok('a macro prompt names the release and its time', /^The September CPI Report just came out \(8:30 AM ET, Wed, Oct 14, 2026\)/.test(cpi), cpi.slice(0, 90));
  ok('and asks for actual vs. consensus and the market reaction', /vs\. consensus/.test(cpi) && /market reaction/.test(cpi));
  const speech = D.fill(D.TEMPLATES.macro, { kind: 'macro', title: 'Waller speaks', date: '2026-10-15' }, null);
  ok('no clock, no dangling comma', /came out \(Thu, Oct 15, 2026\)/.test(speech), speech.slice(0, 60));
  ok('{category} reads as a label', D.fill('{category}', { category: 'ecb' }) === 'ECB' && D.fill('{category}', { category: 'jobs' }) === 'Jobs');
  ok('unknown braces are left alone', D.fill('Use {json} here', tsm) === 'Use {json} here');
  const two = D.prompt([tsm, { kind: 'earnings', title: 'NFLX Earnings', date: '2026-10-15', when: 'amc' }], D.normalize(null));
  ok('a grouped card debriefs each report separately', /^Debrief each of these 2 reports separately \(TSM, NFLX\)/.test(two) && /### 1\. TSM/.test(two) && /### 2\. NFLX/.test(two), two.slice(0, 80));
  const cust = D.prompt(tsm, D.normalize({ templates: { earnings: '{ticker} earnings just came out. Give me the results, consensus, expected market movement' } }));
  ok('a custom template is used as written', cust === 'TSM earnings just came out. Give me the results, consensus, expected market movement', cust);
}

console.log('\nThe link MAGI reads');
{
  const u = D.link('hello', ['gemini'], 'veda');
  const p = payloadOf(u);
  ok('goes to the console', u.split('#')[0] === 'https://anthonyn99.github.io/A1/magi.html');
  ok('carries prompt, units, a run and the profile', p.q === 'hello' && p.units.join() === 'gemini' && p.run === 1 && p.p === 'veda' && p.src === 'catalysts', JSON.stringify(p));
  ok('an unknown profile is sent as Tony', payloadOf(D.link('x', [], 'mallory')).p === 'tony');
  ok('a base url that already has a fragment is not doubled', D.link('x', [], 'tony', 'https://h/magi.html#old').split('#').length === 2);
  ok('magi.html decodes the same regex the link uses', /\/\[#&\]tb=\(\[\^&\]\+\)\//.test(MAGI));
}

console.log('\nThe button press');
{
  const L = load();
  L.D.setConfig({ tony: { units: ['chatgpt'] }, veda: { units: ['gemini', 'claude'] } });
  const cpi = { kind: 'macro', title: 'September CPI Report', date: '2026-10-14', category: 'inflation' };
  ok('opens the one MAGI tab', L.D.launch([cpi], 'veda', { macroET: () => ({ hh: 8, mm: 30 }) }) === true && L.opened[0].name === 'a1tab_magi');
  const nav = L.opened.find((o) => o.nav);
  const p = nav && payloadOf(nav.nav);
  ok('in Veda’s profile, with Veda’s units', p && p.p === 'veda' && p.units.join() === 'gemini,claude', p && JSON.stringify(p.units));
  ok('debriefing that event', p && /September CPI Report just came out \(8:30 AM ET/.test(p.q));
  L.opened.length = 0;
  L.D.launch([cpi], 'tony', {});
  const p2 = payloadOf(L.opened.find((o) => o.nav).nav);
  ok('Tony’s press uses Tony’s profile and units', p2.p === 'tony' && p2.units.join() === 'chatgpt');

  // A console already open: only the fragment changes, so MAGI hears it on
  // hashchange instead of reloading.
  const tab = { location: { href: 'https://anthonyn99.github.io/A1/magi.html', replace(u) { this.href = u; } }, focus() { this.focused = true; } };
  const O = load({ tab });
  O.D.launch([cpi], 'tony', {});
  ok('an open console is handed the prompt, not just focused', /magi\.html#tb=/.test(tab.location.href) && tab.focused, tab.location.href.slice(0, 60));
  // window.name survives navigation: a tab that once held MAGI and now holds
  // TaskHub is itself 'a1tab_magi'. The lookup must not hand TaskHub back to
  // be navigated away, and its own tabsync must not be asked to take it.
  const S = load({ claimed: true });
  S.sb.name = 'a1tab_magi';
  S.sb.sessionStorage = { getItem: (k) => (k === 'a1TabKey' ? 'magi' : null) };
  const realOpen = S.sb.open;
  S.sb.open = function (u, n) { if (n === S.sb.name) { S.opened.push({ self: true }); return S.sb; } return realOpen.call(this, u, n); };
  S.sb.location = { href: 'https://anthonyn99.github.io/A1/index.html' };
  S.D.launch([cpi], 'tony', {});
  ok('a TaskHub tab carrying MAGI’s name gives it up', S.sb.name === '' && !S.opened.some((o) => o.self), JSON.stringify(S.opened).slice(0, 120));
  ok('…and the debrief goes to a real MAGI tab, not to TaskHub', S.opened.some((o) => o.nav && /magi\.html#tb=/.test(o.nav)) && S.sb.location.href.endsWith('index.html'));
  const B = load({ blocked: true });
  ok('a blocked popup is reported, not swallowed', B.D.launch([cpi], 'tony', {}) === false);
}

console.log('\nBoth TaskHubs are wired to it');
{
  ok('index.html loads catdebrief.js', /<script src="catdebrief\.js"><\/script>/.test(INDEX));
  ok('it listens to the settings doc the module names', INDEX.includes('doc(db, "' + D.DOC + '")') && /A1Debrief\.setConfig\(snap\.exists\(\)/.test(INDEX));
  ok('Tony’s card launches in Tony’s profile', /window\._mcDebrief\(l,"tony",/.test(INDEX));
  ok('Veda’s card launches in Veda’s profile', /window\._mcDebrief\(l,"veda",/.test(INDEX));
  ok('both cards draw the button', /mcDebriefBtn\(e,!\(e\.importance/.test(INDEX) && /vdDebriefBtn\(e,!\(e\.importance/.test(INDEX));
  ok('both keep the fields the prompt needs', (INDEX.match(/ticker:ev\.ticker\|\|null,when:ev\.when\|\|null,epsEst:/g) || []).length === 2);
  ok('a grouped earnings card carries its events', (INDEX.match(/_past:g\.every\(e=>e\._past\),_group:g\}/g) || []).length === 2);
  ok('both TaskHubs draw cards in A1Debrief.groups order', (INDEX.match(/return mcGroupsOf\(mcDay\)\.map\(/g) || []).length === 2
    && (INDEX.match(/function mcGroupsOf\(day\)\{const D=window\.A1Debrief;if\(D&&D\.groups\)return D\.groups\(day,mcMacroET\)/g) || []).length === 2);
  ok('both draw a group of releases as one card with one ▶', /mcDebriefBtn\(\{_group:g\}/.test(INDEX) && /vdDebriefBtn\(\{_group:g\}/.test(INDEX));
  ok('both ask debriefable() which events the ▶ covers', (INDEX.match(/D\.debriefable\(g,mcMacroET\)/g) || []).length === 2);
  ok('both redraw when the grouping window changes', (INDEX.match(/addEventListener\("a1debrief:config",f\)/g) || []).length === 2);
  ok('both re-render when the next one comes due', (INDEX.match(/D\.nextDue\(marketCal,e=>mcMacroET\(e\)\)/g) || []).length === 2);
  ok('the launcher passes the profile through to the module', /D\.launch\(events, profile, \{ macroET: macroET, magiUrl: base \}\)/.test(INDEX));
}

console.log('\nTradeHub edits the same settings');
{
  const M = require('./moved');
  if (!M.has('tradehub.html')) { M.skipNote('tradehub.html'); }
  else {
    const TB = M.read('tradehub.html');
    ok('TradeHub loads catdebrief.js unpinned', /<script src="https:\/\/anthonyn99\.github\.io\/A1\/catdebrief\.js"><\/script>/.test(TB));
    ok('and writes the doc index.html reads', TB.includes("'" + D.DOC + "'") || TB.includes('"' + D.DOC + '"'));
    const units = [...TB.matchAll(/\{id:'([a-z-]+)',\s*label:/g)].map((m) => m[1]);
    ok('every default unit is one TradeHub offers', D.DEFAULT_UNITS.every((u) => units.includes(u)), units);
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
