// Loads the REAL built StudyOS page in a real headless browser and asserts it
// boots without errors. Unit tests stub window/localStorage, so they cannot
// catch a load-order fault, a missing global, or a module that throws on import.
import { launch, connect } from './cdp.mjs';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist/studyos/index.html');
if (!existsSync(dist)) {
  console.error('Build first:  npm run build');
  process.exit(2);
}
const PAGE = 'file:///' + dist.split(String.fromCharCode(92)).join('/');

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name, extra == null ? '' : '\n       ' + JSON.stringify(extra)); }
};

try {
  await launch();
} catch (e) {
  if (e.code === 'NO_BROWSER') { console.log('SKIP: ' + e.message); process.exit(0); }
  throw e;
}
const { send, evalJs, events } = await connect();

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

await send('Page.navigate', { url: PAGE });
// The app gates boot behind SOS_GATE (app lock) and Firebase; give it room.
await new Promise(r => setTimeout(r, 6000));

// ── Collect everything the page complained about ──────────────────────────
const pageErrors = events
  .filter(e => e.method === 'Runtime.exceptionThrown')
  .map(e => e.params.exceptionDetails?.exception?.description
         || e.params.exceptionDetails?.text || 'unknown');

const consoleErrors = events
  .filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
  .map(e => e.params.entry.text);

console.log('\nload');
const title = await evalJs('document.title');
t('page loaded', typeof title === 'string' && title.length > 0, title);

// Firebase/network failures are expected offline from file:// and are not what
// this run is checking. Anything else is a real fault.
const ignorable = /firebase|firestore|net::|Failed to load resource|recaptcha|appCheck|installations|FirebaseError|gstatic|ERR_/i;
const realPageErrors = pageErrors.filter(e => !ignorable.test(e));
const realConsoleErrors = consoleErrors.filter(e => !ignorable.test(e));

t('no uncaught exceptions from our code', realPageErrors.length === 0, realPageErrors.slice(0, 5));
t('no console errors from our code', realConsoleErrors.length === 0, realConsoleErrors.slice(0, 5));

// ── The F-2 store seam must be live ───────────────────────────────────────
console.log('\nF-2 store seam');
t('bridge installed', await evalJs('!!window._sosBridge'));
for (const m of ['getClasses', 'getEvents', 'getTasks', 'getNotes', 'getKsu',
                 'getModules', 'getSnapshot', 'subscribe', 'setTaskDone',
                 'addGeneratedNote', 'addGeneratedDoc', 'setModuleDefaultPrompt']) {
  t('bridge.' + m, await evalJs(`typeof window._sosBridge.${m} === "function"`));
}
t('SOS.store exposed by boot.js', await evalJs('!!(window.SOS && window.SOS.store)'));
t('store reads through the bridge', await evalJs('Array.isArray(window.SOS.store.getClasses())'));

// getSnapshot must deep-copy, not alias live state.
t('getSnapshot returns an object', await evalJs('typeof window._sosBridge.getSnapshot() === "object"'));

// ── The pipeline must match whatever config says, in BOTH directions ──────
// Asserting "off" outright made this fail the moment the feature was switched
// on, which is a check that punishes shipping rather than catching a bug. What
// actually matters is that the flag and the runtime agree: off means nothing
// loads and nothing renders; on means the hooks exist. A mismatch either way is
// the real fault.
const aiOn = await evalJs('!!(window.STUDYOS_CONFIG.cloudflare.ai || {}).enabled');
console.log(`\npipeline wiring (config says ${aiOn ? 'ENABLED' : 'disabled'})`);
if (aiOn) {
  t('run hook defined', (await evalJs('typeof window.sosRunPrompt')) === 'function');
  t('jobs hook defined', (await evalJs('typeof window.sosOpenJobs')) === 'function');
  t('pipeline module loaded', (await evalJs('typeof (window.SOS&&window.SOS.pipeline)')) === 'object');
  t('prompts module loaded', (await evalJs('typeof (window.SOS&&window.SOS.prompts)')) === 'object');
  t('a baseUrl is configured', (await evalJs(
    '!!(window.STUDYOS_CONFIG.cloudflare.ai.baseUrl||"").length')) === true);
} else {
  t('no run hook defined', (await evalJs('typeof window.sosRunPrompt')) === 'undefined');
  t('pipeline module not loaded', (await evalJs('typeof (window.SOS&&window.SOS.pipeline)')) === 'undefined');
}
// True either way: with no class open there is no file row to carry one.
t('no stray ⚡ button on the dashboard', (await evalJs(
  'Array.from(document.querySelectorAll("button")).filter(b=>b.textContent==="⚡").length')) === 0);

// ── F-3: the bug that started all this, in a real DOM ─────────────────────
console.log('\nF-3 escaping, live');
const escRes = await evalJs(`(function(){
  // Drive the REAL render path rather than testing escHtml in isolation.
  var el = document.createElement('div');
  el.id = 'sos-xtest';
  document.body.appendChild(el);
  var out = {};
  try {
    // Sidebar path: textContent.
    var item = document.createElement('div');
    item.textContent = 'Computer Organization & Architecture';
    out.sidebar = item.innerHTML;
    // Priority-queue path: the real escHtml from studyos.js.
    out.esc = (typeof escHtml === 'function') ? escHtml('Computer Organization & Architecture') : null;
    out.escAmp = (typeof escHtml === 'function') ? escHtml('R&amp;D') : null;
    out.escNull = (typeof escHtml === 'function') ? escHtml(null) : null;
  } catch (e) { out.error = String(e); }
  el.remove();
  return out;
})()`);
t('escHtml reachable in the page', escRes.esc !== null, escRes);
t('ampersand escapes once', escRes.esc === 'Computer Organization &amp; Architecture', escRes.esc);
t('sidebar textContent escapes it', escRes.sidebar === 'Computer Organization &amp; Architecture', escRes.sidebar);
t('a real R&amp;D is not "repaired"', escRes.escAmp === 'R&amp;amp;D', escRes.escAmp);
t('null coerces instead of throwing', escRes.escNull === '', escRes.escNull);

// Render a class with an ampersand through the ACTUAL renderer and read the DOM.
console.log('\nF-3 through the real renderer');
const rendered = await evalJs(`(function(){
  try {
    if (typeof classes === 'undefined' || typeof renderSidebarClasses !== 'function') {
      return { skipped: 'renderer not in scope' };
    }
    var before = classes.slice();
    classes.length = 0;
    classes.push({ id:'xt1', name:'Computer Organization & Architecture', code:'CS<1>', instructor:'', color:'#888', modules:[] });
    renderSidebarClasses();
    var sb = document.getElementById('sidebar-classes');
    var text = sb ? sb.textContent : '';
    var html = sb ? sb.innerHTML : '';
    var cardsHtml = '';
    if (typeof renderClasses === 'function') {
      renderClasses();
      var g = document.getElementById('classes-grid') || document.querySelector('.class-grid');
      cardsHtml = g ? g.innerHTML : '';
    }
    classes.length = 0; before.forEach(function(c){ classes.push(c); });
    try { renderSidebarClasses(); if (typeof renderClasses==='function') renderClasses(); } catch(e){}
    return { text: text, html: html, cards: cardsHtml };
  } catch (e) { return { error: String(e) }; }
})()`);

if (rendered.skipped) {
  console.log('  --   skipped: ' + rendered.skipped);
} else if (rendered.error) {
  t('renderer ran', false, rendered.error);
} else {
  t('sidebar shows the real name', rendered.text.includes('Computer Organization & Architecture'), rendered.text);
  t('sidebar does NOT show "& amp"', !/&\s*amp/i.test(rendered.text), rendered.text);
  t('sidebar HTML has the entity, not raw &', rendered.html.includes('&amp;'), rendered.html.slice(0, 120));
  if (rendered.cards) {
    t('class card escapes the name too', rendered.cards.includes('&amp;'), rendered.cards.slice(0, 160));
    t('class card escapes < in the code', !/<1>/.test(rendered.cards), rendered.cards.slice(0, 160));
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (realPageErrors.length) console.log('\npage errors:\n' + realPageErrors.join('\n'));
if (realConsoleErrors.length) console.log('\nconsole errors:\n' + realConsoleErrors.join('\n'));
process.exit(fail ? 1 : 0);
