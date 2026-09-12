// Guards the TradeHub → MAGI hand-off: one prompt, three codebases, one link.
//
// TradeHub's Analysis tab stopped opening a chat site and typing into it. It
// now opens magi.html with the prompt and the ticked units in the URL FRAGMENT
// and the council convenes on arrival. The same link is built a second time, in
// Python, by the morning launcher (trading-auto-launch/launch.py), and read a
// third time by magi.html.
//
// Nothing connects those three but the shape of that fragment. Nothing errors
// when they drift, either — a mangled payload is caught and dropped by design,
// so the failure mode is a console that opens with an empty box and no reason
// given. Hence this file.
//
// What it pins:
//   1. Encoder and decoder agree, including on a long non-ASCII prompt (the
//      chunked base64 path, and the reason it is chunked).
//   2. Python's builder produces a link the JS reader accepts, field for field.
//   3. The unit ids TradeHub offers are ids the MAGI engine actually has —
//      a typo here ships a tick box that silently does nothing.
//   4. The link is consumed ONCE: the reader strips the fragment before acting
//      on it, or a reload re-runs a council against four paid accounts.
//   5. No search entry can be mistaken for the console (and vice versa), which
//      is the trap in MAGI sharing a hostname with every other A1 page.
//
// Run: node tests/magi-handoff.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TRADEHUB = fs.readFileSync(path.join(ROOT, 'tradehub.html'), 'utf8');
const MAGI = fs.readFileSync(path.join(ROOT, 'magi.html'), 'utf8');
const LAUNCH = fs.readFileSync(path.join(ROOT, 'trading-auto-launch', 'launch.py'), 'utf8');
const WORKER = fs.readFileSync(path.join(ROOT, 'workers2', 'trade-dashboard', 'worker.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

/** Lift a top-level `function name(...) { ... }` out of a single-file app.
 *  Brace-counting, not a regex: these bodies contain braces of their own. */
function lift(src, name) {
  let at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('not found: ' + name);
  // Keep the `async` that some of them carry, or the body's awaits are orphaned.
  if (src.slice(at - 6, at) === 'async ') at -= 6;
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}

// ── the two halves, taken from the shipping files rather than restated ──
const TB_MAGI_URL = (/const TB_MAGI_URL='([^']+)'/.exec(TRADEHUB) || [])[1];
const encode = new Function(
  'TB_MAGI_URL',
  lift(TRADEHUB, 'tbB64u') + '\n' + lift(TRADEHUB, 'tbMagiLink') +
  '\nreturn { tbB64u, tbMagiLink };'
)(TB_MAGI_URL);
const decode = new Function(
  lift(MAGI, 'b64uDecode') + '\nreturn { b64uDecode };'
)();

/** What magi.html's takeHandoff() pulls out of a url — the same regex, so a
 *  change to it fails here rather than at 6am. */
const TB_PARAM = (/const m = (\/[^;]+\/)\.exec\(location\.hash/.exec(MAGI) || [])[1];
function readLink(url) {
  const re = new RegExp(TB_PARAM.slice(1, TB_PARAM.lastIndexOf('/')));
  const m = re.exec(url.slice(url.indexOf('#')));
  if (!m) return null;
  return JSON.parse(decode.b64uDecode(decodeURIComponent(m[1])));
}

console.log('\nThe link survives the round trip');
{
  ok('the regex magi.html reads with was found', !!TB_PARAM, TB_PARAM);
  const q = 'Give me today’s SPY read — “premarket”, €/¥ flows, トレード 📈 & <tags> ?q=1#x';
  const link = encode.tbMagiLink(q, ['chatgpt', 'claude']);
  const got = readLink(link);
  ok('the prompt comes back byte for byte', got && got.q === q, got && got.q);
  ok('so do the units', got && got.units.join(',') === 'chatgpt,claude', got && got.units);
  ok('it asks for a run', !!(got && got.run));
  ok('it says who sent it', got && got.src === 'tradehub', got && got.src);
  ok('the payload is in the FRAGMENT, never the query',
    link.indexOf('#tb=') > 0 && link.slice(0, link.indexOf('#')).indexOf('tb=') < 0, link.slice(0, 120));
  ok('nothing in it needs escaping in a url', !/[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]/.test(link));
}

console.log('\nA prompt long enough to break the naive encoder');
{
  // String.fromCharCode.apply over one array is what blows the stack, somewhere
  // north of ~100k arguments. Trading prompts are nowhere near it; this is the
  // guard on the chunking, not on the prompt.
  const q = ('é中🚀 ').repeat(40000);
  let link = null, err = null;
  try { link = encode.tbMagiLink(q, ['gemini']); } catch (e) { err = e; }
  ok('a 160k-character prompt encodes at all', !!link, err && err.message);
  ok('and decodes back to itself', link && readLink(link).q === q);
}

console.log('\nPython builds the same link JS reads');
{
  // Import launch.py without running it: it is a script with a __main__ guard,
  // and everything we need is module-level.
  const py = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("al", r"${path.join(ROOT, 'trading-auto-launch', 'launch.py').replace(/\\/g, '\\\\')}")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(m._magi_link("https://anthonyn99.github.io/A1/magi.html", "\\u00e9 caf\\u00e9 \\u2014 SPY?", ["claude", "gemini"]))
print(json.dumps([m._is_magi_url("https://anthonyn99.github.io/A1/magi.html#tb=x"),
                  m._is_magi_url("https://anthonyn99.github.io/A1/index.html"),
                  m._is_magi_url("https://www.google.com/search?q=magi.html")]))
`;
  const r = spawnSync('python', ['-c', py], { encoding: 'utf8' });
  if (r.status !== 0) {
    ok('launch.py imports', false, (r.stderr || '').trim().split('\n').slice(-3).join(' | '));
  } else {
    const [link, flags] = r.stdout.trim().split('\n');
    ok('launch.py imports', true);
    ok('its link points at the console TradeHub uses',
      link.split('#')[0] === TB_MAGI_URL, link.split('#')[0]);
    let got = null, err = null;
    try { got = readLink(link); } catch (e) { err = e; }
    ok('magi.html can read what Python wrote', !!got, err && err.message);
    ok('with the prompt intact', got && got.q === 'é café — SPY?', got && got.q);
    ok('and the units intact', got && got.units.join(',') === 'claude,gemini', got && got.units);
    ok('it asks for a run too', !!(got && got.run));
    ok('and carries a nonce, so two identical mornings are two urls',
      !!(got && got.t), got && got.t);
    const f = JSON.parse(flags);
    ok('the launcher recognises the console', f[0] === true);
    ok('...and does not mistake another A1 page for it', f[1] === false);
    ok('...nor a search that merely mentions it', f[2] === false);
  }
}

console.log('\nThe unit ids are the engine’s own');
{
  const yaml = fs.readFileSync(path.join(ROOT, 'magi', 'config', 'selectors.yaml'), 'utf8');
  // Top-level keys under `sites:` — two-space indent, which is the file's shape.
  const sites = new Set();
  let inSites = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^sites:\s*$/.test(line)) { inSites = true; continue; }
    if (inSites && /^\S/.test(line)) break;
    const m = inSites && /^ {2}([a-z0-9_]+):\s*$/.exec(line);
    if (m) sites.add(m[1]);
  }
  ok('selectors.yaml parsed', sites.size >= 4, [...sites].join(','));
  const offered = [...TRADEHUB.matchAll(/\{id:'([a-z]+)',\s*label:'[^']+',\s*code:'/g)].map((m) => m[1]);
  ok('TradeHub offers the whole council', offered.length === 6, offered.join(','));
  for (const id of offered) ok(`  ${id} is a configured unit`, sites.has(id));
  // The worker allow-list is a third copy of the same list.
  const wl = (/const ok=new Set\(\[([^\]]+)\]\);/.exec(WORKER) || [])[1] || '';
  const allowed = wl.split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
  for (const id of offered) ok(`  ${id} survives the worker`, allowed.includes(id), allowed.join(','));
}

console.log('\nThe hand-off is consumed exactly once');
{
  const take = lift(MAGI, 'takeHandoff');
  ok('the fragment is stripped before the payload is used',
    take.indexOf('history.replaceState') < take.indexOf('JSON.parse'), 'strip must come first');
  ok('...and stripped even when the payload is junk',
    take.indexOf('history.replaceState') < take.indexOf('b64uDecode'));
  ok('a browser that refuses to strip it does not also eat the prompt',
    /replaceState\([\s\S]*?\);\s*\} catch \{\}/.test(take));
  ok('a run is only started for a link that asked for one',
    /if \(!h\.run\) return;/.test(lift(MAGI, 'applyHandoff')));
  ok('an already-open console still hears a second link',
    /addEventListener\("hashchange"/.test(MAGI));
  ok('a handoff never lands on top of a running council',
    /if \(S\.running \|\| S\.refining\) return;/.test(lift(MAGI, 'handoffTry')));
  ok('...and is retried when that run ends', /handoffTry\(\);/.test(lift(MAGI, 'endRun')));
  ok('a locked console holds it rather than dropping it',
    /handoffTry\(\)/.test(lift(MAGI, 'hideLock')));
  ok('it waits for the unit list before ticking anything',
    /if \(online\(\) && !S\.providers\.length\) return;/.test(lift(MAGI, 'handoffTry')));
}

console.log('\nTradeHub keeps the two kinds of destination apart');
{
  const isAi = lift(TRADEHUB, 'tbIsAiUrl');
  ok('MAGI is matched on the page, not the shared hostname',
    /site\.magi\)return \/\\\/magi\\\.html/.test(isAi), isAi.split('\n')[3]);
  ok('the MAGI entry claims no hosts, so it cannot swallow an A1 search',
    /\{id:'magi',[^}]*hosts:\[\], magi:true\}/.test(TRADEHUB));
  ok('the morning push carries the units', /magiUnits\}\)\}\)/.test(TRADEHUB) || /aiUrl,magiUnits\}/.test(TRADEHUB));
  ok('the worker stores them', /magiUnits:tdMagiUnits\(/.test(WORKER));
  ok('the worker hands them back', /magiUnits:p\.magiUnits/.test(WORKER));
  ok('the launcher only treats it as MAGI when BOTH agree',
    /use_magi = bool\(magi_units\) and _is_magi_url\(ai_url\)/.test(LAUNCH));
  ok('the extension’s #tbauto marker never reaches the console',
    /if use_magi:\n        tabs = \[u for u in \(_resolve_search_url/.test(LAUNCH));
}


// ── The state machine, run for real ────────────────────────────────────────
// The four functions lifted out of magi.html and given a fake console, so the
// ORDER they cooperate in is tested rather than asserted about. Every one of
// these was a way to lose a prompt: a locked page drops it, an offline engine
// drops it, a run in flight drops it, a reload runs it twice.
function consoleFor(opts) {
  const o = Object.assign({ hash: '', locked: false, lockDecided: true, online: true, providers: ['chatgpt', 'claude', 'gemini'], running: false }, opts);
  const calls = { start: 0, err: null, saved: 0, rendered: 0, views: [] };
  const loc = { hash: o.hash, pathname: '/A1/magi.html', search: '' };
  const hist = {
    state: null,
    replaceState(st, t, url) { loc.hash = ''; hist.last = url; },
  };
  const els = { lockScreen: { hidden: !o.locked }, composer: { value: '' } };
  const S = {
    running: o.running, refining: false, preRefine: 'older text',
    providers: o.providers.map((id) => ({ id, enabled: true })),
    selected: new Set(['deepseek']),
  };
  const LOCK = { booted: o.lockDecided };
  const env = new Function(
    'location', 'history', 'S', 'LOCK', '$', 'online', 'autosize', 'saveUnitPicks',
    'renderUnitChips', 'setView', 'updateEnabled', 'setErr', 'start', 'calls',
    lift(MAGI, 'b64uDecode') + '\n' +
    'let HANDOFF = null;\n' +
    lift(MAGI, 'takeHandoff') + '\n' +
    lift(MAGI, 'handoffTry') + '\n' +
    lift(MAGI, 'applyHandoff') + '\n' +
    'HANDOFF = takeHandoff();\n' +
    'return { handoffTry, pending: () => !!HANDOFF };'
  )(
    loc, hist, S, LOCK, (id) => els[id], () => o.online, () => {},
    () => { calls.saved++; }, () => { calls.rendered++; },
    (v) => calls.views.push(v), () => {}, (id, msg) => { calls.err = msg; },
    () => { calls.start++; }, calls
  );
  return { env, calls, loc, els, S, LOCK };
}

const LINK = encode.tbMagiLink('Morning read on SPY', ['claude', 'gemini']);
const HASH = LINK.slice(LINK.indexOf('#'));

console.log('\nThe ordinary case: the console is up and unlocked');
{
  const c = consoleFor({ hash: HASH });
  c.env.handoffTry();
  ok('the prompt lands in the box', c.els.composer.value === 'Morning read on SPY', c.els.composer.value);
  ok('the units sent are the units ticked', [...c.S.selected].join(',') === 'claude,gemini', [...c.S.selected]);
  ok('the tick is remembered on this device', c.calls.saved === 1);
  ok('the council convenes', c.calls.start === 1);
  ok('an old Refine undo is not left pointing at a different prompt', c.S.preRefine === null);
  ok('the fragment is gone from the url', c.loc.hash === '', c.loc.hash);
  ok('and nothing is left pending', !c.env.pending());
}

console.log('\nLocked: held, not dropped');
{
  const c = consoleFor({ hash: HASH, locked: true });
  c.env.handoffTry();
  ok('nothing runs behind the lock screen', c.calls.start === 0 && c.els.composer.value === '');
  ok('but the link is still held', c.env.pending());
  c.els.lockScreen.hidden = true;          // hideLock() does exactly this
  c.env.handoffTry();
  ok('unlocking runs it', c.calls.start === 1 && c.els.composer.value === 'Morning read on SPY');
}

console.log('\nThe lock has not answered yet');
{
  // Whether MAGI is locked is a network round-trip, and it can land AFTER the
  // engine has listed its units. Asking the lock SCREEN is therefore not the
  // same question as asking whether this page is locked — measured in a real
  // browser, where the units arrived first and the lock painted afterwards.
  const c = consoleFor({ hash: HASH, lockDecided: false });
  c.env.handoffTry();
  ok('nothing runs before the lock has decided', c.calls.start === 0 && c.els.composer.value === '');
  ok('the link is held', c.env.pending());
  c.LOCK.booted = true;                    // lockBoot()'s finally does this
  c.env.handoffTry();
  ok('and goes once it has', c.calls.start === 1);
}

console.log('\nA council already in flight');
{
  const c = consoleFor({ hash: HASH, running: true });
  c.env.handoffTry();
  ok('a second question never lands on top of a live run', c.calls.start === 0);
  ok('it waits', c.env.pending());
  c.S.running = false;                     // endRun() does exactly this
  c.env.handoffTry();
  ok('and goes as soon as the run ends', c.calls.start === 1);
}

console.log('\nThe engine is asleep');
{
  const c = consoleFor({ hash: HASH, online: false, providers: [] });
  c.env.handoffTry();
  ok('the prompt is still put in the box', c.els.composer.value === 'Morning read on SPY');
  ok('nothing is run', c.calls.start === 0);
  ok('and the reason is on screen', /engine offline/i.test(c.calls.err || ''), c.calls.err);
}

console.log('\nUnits the engine does not have');
{
  const link = encode.tbMagiLink('x', ['perplexity']);
  const c = consoleFor({ hash: link.slice(link.indexOf('#')), providers: ['chatgpt'] });
  c.env.handoffTry();
  ok('an unconfigured unit cannot empty the selection', c.S.selected.size === 1, [...c.S.selected]);
  ok('and the run still happens with what is ticked', c.calls.start === 1);
}

console.log('\nA mangled link');
{
  const c = consoleFor({ hash: '#tb=not%20base64%21%21' });
  ok('nothing is pending', !c.env.pending());
  c.env.handoffTry();
  ok('nothing runs', c.calls.start === 0);
  ok('the console is left usable', c.els.composer.value === '');
  ok('and the junk is still stripped from the url', c.loc.hash === '', c.loc.hash);
}

console.log('\nNo link at all');
{
  const c = consoleFor({ hash: '' });
  c.env.handoffTry();
  ok('an ordinary visit is untouched', c.calls.start === 0 && c.calls.saved === 0);
}


// ── One tab, even after a browser restart ──────────────────────────────────
// The opener lifted out of tradehub.html and run against a fake browser. Every
// branch below was a way to end up with two MAGI tabs, or with one tab that
// never heard the question.
const TABSYNC = fs.readFileSync(path.join(ROOT, 'tabsync.js'), 'utf8');

/** A window.open() result: a tab, real or blank, with the bits the opener reads. */
function fakeTab(href, opts) {
  const t = Object.assign({ href, name: '', closed: false, focused: 0, navs: [] }, opts || {});
  t.location = {
    get href() { if (t.crossOrigin) throw new Error('cross-origin'); return t.href; },
    set href(v) { t.navs.push(v); t.href = v; },
    replace(v) { t.navs.push(v); t.href = v; },
  };
  t.focus = () => { t.focused++; };
  t.close = () => { t.closed = true; };
  return t;
}

/** The opener, with window.open, localStorage and BroadcastChannel in hand. */
function opener(scenario) {
  const posted = [];
  const chans = [];
  const store = scenario.claim
    ? { 'a1tab:magi': JSON.stringify({ id: 'x', t: Date.now() - (scenario.claimAge || 0) }) }
    : {};
  function Chan() {
    const c = { onmessage: null, closed: false, postMessage: (m) => { posted.push(m); if (c.onmessage) chans.push(c); }, close() { c.closed = true; } };
    chans.push(c);
    return c;
  }
  const env = new Function(
    'window', 'localStorage', 'BroadcastChannel', 'opened',
    lift(TRADEHUB, 'tbTabClaimed') + '\n' + lift(TRADEHUB, 'tbTabGo') + '\n' +
    lift(TRADEHUB, 'tbHandOverMagi') + '\n' + lift(TRADEHUB, 'tbOpenMagi') + '\n' +
    "const TB_MAGI_TAB_KEY='magi';const TB_MAGI_TAB_NAME='a1tab_'+TB_MAGI_TAB_KEY;\n" +
    'return tbOpenMagi;'
  )(
    { open: (u, n) => { scenario.opened.push({ u, n }); return scenario.tab; } },
    { getItem: (k) => (k in store ? store[k] : null) },
    Chan, scenario.opened
  );
  return { run: (url) => env(url), posted, chans };
}

console.log('\nOne MAGI tab, whatever state the browser is in');
(async () => {
  const URL_ONE = 'https://anthonyn99.github.io/A1/magi.html#tb=AAA';
  const URL_TWO = 'https://anthonyn99.github.io/A1/magi.html#tb=BBB';
  const settle = () => new Promise((r) => setTimeout(r, 420));

  // 1 — nothing open yet.
  {
    const tab = fakeTab('about:blank');
    const o = opener({ tab, opened: [], claim: false });
    const r = o.run(URL_ONE);
    ok('a first launch opens one tab and navigates it', r === true && tab.navs.length === 1 && tab.navs[0] === URL_ONE, tab.navs);
    ok('  it claims the name TaskHub uses', tab.name === 'a1tab_magi', tab.name);
    ok('  and it is brought forward', tab.focused === 1);
  }

  // 2 — the console is already open in this browsing-context group.
  {
    const tab = fakeTab('https://anthonyn99.github.io/A1/magi.html');
    const opened = [];
    const o = opener({ tab, opened, claim: false });
    o.run(URL_TWO);
    ok('an open console is re-used, not duplicated', opened.length === 1 && opened[0].u === '', opened);
    ok('  and it is handed the new prompt', tab.navs.length === 1 && tab.navs[0] === URL_TWO, tab.navs);
    ok('  by fragment only, so it is not reloaded',
      tab.navs[0].split('#')[0] === 'https://anthonyn99.github.io/A1/magi.html');
    ok('  and brought forward', tab.focused === 1);
  }

  // 3 — a console restored by the browser: invisible to the name lookup, but
  //     still claiming the key, and able to focus itself.
  {
    const tab = fakeTab('about:blank');
    const o = opener({ tab, opened: [], claim: true });
    o.run(URL_ONE);
    const claim = o.posted.find((m) => m.t === 'claim');
    ok('a restored console is asked before a second tab is used', !!claim, o.posted);
    o.chans.filter((c) => c.onmessage).forEach((c) => c.onmessage({ data: { t: 'claimed', k: 'magi', rid: claim.rid, ok: true } }));
    await settle();
    const deliver = o.posted.find((m) => m.t === 'deliver');
    ok('it is handed the prompt rather than merely focused', !!deliver && deliver.url === URL_ONE, o.posted);
    ok('  and our spare tab is closed, so there is one', tab.closed === true);
    ok('  the spare is never navigated', tab.navs.length === 0, tab.navs);
  }

  // 4 — the same, but it cannot bring itself forward (the usual outcome: Chrome
  //     only lets a background tab focus itself with recent interaction).
  {
    const tab = fakeTab('about:blank');
    const o = opener({ tab, opened: [], claim: true });
    o.run(URL_ONE);
    const claim = o.posted.find((m) => m.t === 'claim');
    o.chans.filter((c) => c.onmessage).forEach((c) => c.onmessage({ data: { t: 'claimed', k: 'magi', rid: claim.rid, ok: false } }));
    await settle();
    ok('a console that cannot come forward stands down', o.posted.some((m) => m.t === 'retire'));
    ok('  and our tab takes the prompt, so there is still one', tab.navs[0] === URL_ONE && !tab.closed);
  }

  // 5 — the heartbeat was stale: nobody is really there.
  {
    const tab = fakeTab('about:blank');
    const o = opener({ tab, opened: [], claim: true });
    o.run(URL_ONE);
    await settle();
    ok('an unanswered claim just opens the tab', tab.navs[0] === URL_ONE && !tab.closed);
    ok('  and nothing is told to retire', !o.posted.some((m) => m.t === 'retire'), o.posted);
  }

  // 6 — an expired heartbeat is not consulted at all.
  {
    const tab = fakeTab('about:blank');
    const o = opener({ tab, opened: [], claim: true, claimAge: 60000 });
    o.run(URL_ONE);
    ok('a stale claim costs no handshake', !o.posted.length && tab.navs[0] === URL_ONE, o.posted);
  }

  // 7 — popup blocked.
  {
    const opened = [];
    const o = opener({ tab: null, opened, claim: false });
    const r = o.run(URL_ONE);
    ok('a blocked popup still aims at the same tab name',
      r === false || (opened.length === 2 && opened[1].n === 'a1tab_magi'), opened);
  }

  // ── and the other end: the console answering ────────────────────────────
  console.log('\nThe console answers for its own tab');
  {
    // tabsync.js in a fake browser, so a real navigation can be observed.
    function tab(url, name) {
      const st = { navs: [], focused: 0, closed: false, name, ls: {}, ss: {}, chans: [] };
      const location = {
        get href() { return url; },
        set href(v) { st.navs.push(v); },
        origin: 'https://anthonyn99.github.io', pathname: '/A1/magi.html', search: '', hash: '',
      };
      const win = {
        get name() { return st.name; }, set name(v) { st.name = v; },
        addEventListener() {}, focus() { st.focused++; }, close() { st.closed = true; },
      };
      function Chan() {
        const c = { onmessage: null, postMessage() {}, close() {} };
        st.chans.push(c);
        return c;
      }
      new Function('window', 'location', 'localStorage', 'sessionStorage', 'history',
        'document', 'BroadcastChannel', 'setInterval', 'clearInterval', 'URLSearchParams', 'URL', TABSYNC)(
        win, location,
        { getItem: (k) => (k in st.ls ? st.ls[k] : null), setItem: (k, v) => { st.ls[k] = v; }, removeItem: (k) => { delete st.ls[k]; } },
        { getItem: (k) => (k in st.ss ? st.ss[k] : null), setItem: (k, v) => { st.ss[k] = v; }, removeItem: (k) => { delete st.ss[k]; } },
        { replaceState() {} }, { addEventListener() {}, visibilityState: 'hidden' },
        Chan, () => 0, () => {}, URLSearchParams, URL);
      return st;
    }

    const t = tab('https://anthonyn99.github.io/A1/magi.html', 'a1tab_magi');
    ok('it claims the key on load', !!t.ls['a1tab:magi']);
    const send = (d) => t.chans.forEach((c) => c.onmessage && c.onmessage({ data: d }));

    send({ t: 'deliver', k: 'magi', url: URL_ONE });
    ok('a delivered url navigates it', t.navs[0] === URL_ONE, t.navs);
    ok('  and it tries to come forward', t.focused >= 1);

    send({ t: 'deliver', k: 'vault', url: URL_TWO });
    ok('a delivery for another destination is ignored', t.navs.length === 1, t.navs);

    send({ t: 'deliver', k: 'magi', url: 'https://evil.example/steal' });
    ok('an off-origin url is refused', t.navs.length === 1, t.navs);

    send({ t: 'retire', k: 'magi' });
    ok('retire still stands the tab down', t.closed === true && !t.ls['a1tab:magi']);
  }

// ── The worker actually stores and returns them ────────────────────────────
// Lifted and run against a fake KV, because "the field is in the file" is not
// the same as "the field survives a write and a read".
console.log('\nThe worker round-trips the unit list');
{
  const kv = {};
  const env = { TD_KV: {
    get: async (k) => (k in kv ? JSON.parse(kv[k]) : null),
    put: async (k, v) => { kv[k] = v; },
  } };
  const w = new Function(
    lift(WORKER, 'kvGet') + '\n' + lift(WORKER, 'kvPut') + '\n' +
    lift(WORKER, 'tdAiUrl') + '\n' + lift(WORKER, 'tdMagiUnits') + '\n' +
    lift(WORKER, 'getAnalysisConfig') + '\n' + lift(WORKER, 'setAnalysisConfig') + '\n' +
    'return { getAnalysisConfig, setAnalysisConfig };'
  )();
  (async () => {
    await w.setAnalysisConfig(env, {
      name: 'Morning', text: 'read SPY', searches: ['spy premarket'],
      aiUrl: 'https://anthonyn99.github.io/A1/magi.html',
      magiUnits: ['claude', 'CHATGPT', 'claude', 'notamodel', ''],
    });
    const got = await w.getAnalysisConfig(env);
    ok('the units come back', got && got.magiUnits.join(',') === 'claude,chatgpt', got && got.magiUnits);
    ok('  case-folded, de-duplicated, and junk dropped', got.magiUnits.length === 2);
    ok('the destination survives with them', got.aiUrl.endsWith('/magi.html'), got.aiUrl);
    // Switching back to a chat site must clear them, or the launcher would keep
    // convening a council the Analysis tab is no longer set to.
    await w.setAnalysisConfig(env, { name: 'Morning', text: 'read SPY', searches: [], aiUrl: 'https://chatgpt.com/' });
    const back = await w.getAnalysisConfig(env);
    ok('switching back to a chat site clears them', back.magiUnits.length === 0, back.magiUnits);
    // A config written before this field existed reads as "no units", not as junk.
    kv['td_analysis_prompt'] = JSON.stringify({ name: 'Old', text: 'x', searches: [] });
    const old = await w.getAnalysisConfig(env);
    ok('a pre-MAGI config is not mistaken for one', old.magiUnits.length === 0);

    console.log(`\n  ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}
})();
