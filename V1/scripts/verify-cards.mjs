// Exercises the HTML half of js/modules/cards.js in a REAL browser.
//
// scripts/test-cards.mjs skips these: Node has no DOMParser. That would leave
// the BETTER extraction path untested — HTML notes are where <h2>/<strong>/<li>
// are reliable structure rather than inferred convention, and it is also where
// every pipeline-generated note lands. So it runs here instead.
//
// Run:  node scripts/verify-cards.mjs      (after npm run build)
import { launch, connect } from './cdp.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist/studyos/index.html');
if (!existsSync(dist)) { console.error('Build first:  npm run build'); process.exit(2); }
const PAGE = 'file:///' + dist.split(String.fromCharCode(92)).join('/');

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 400))); }
};

try {
  await launch();
} catch (e) {
  if (e.code === 'NO_BROWSER') { console.log('SKIP: ' + e.message); process.exit(0); }
  throw e;
}
const { send, evalJs, events } = await connect();
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: PAGE });
await new Promise(r => setTimeout(r, 4000));

// Load the module in the page, where DOMParser exists.
await evalJs(`import('./js/modules/cards.js').then(m => { window.__cards = m; return 'ok'; })`);
await new Promise(r => setTimeout(r, 800));

console.log('\nmodule loads in the page');
t('cards module imported', await evalJs('typeof window.__cards === "object"'));

const HTML = `
  <h2>Functional Dependencies</h2>
  <p>A functional dependency holds when one attribute determines another attribute.</p>
  <p>The <strong>determinant</strong> is the attribute on the left-hand side of the arrow.</p>
  <ul><li>Full dependency</li><li>Partial dependency</li><li>Transitive dependency</li></ul>
  <h3>Slide 9</h3>
  <p>This section was generated from slide nine of the lecture deck.</p>
  <h2>Overview</h2>
  <p>Boilerplate that should not become a card at all.</p>`;

const res = await evalJs(`(() => {
  const src = { classId:'c1', moduleId:'m1', noteId:'n1', title:'DB' };
  const cards = window.__cards.fromHtml(${JSON.stringify(HTML)}, src);
  return cards.map(c => ({ kind:c.kind, q:c.q, a:c.a, slide:c.sourceSlide, fp:c.fp }));
})()`);

console.log('\nHTML extraction');
t('produced cards', res.length >= 3, res.map(c => [c.kind, c.q]));
t('heading became a question', res.some(c => /What is Functional Dependencies\?/.test(c.q)),
  res.map(c => c.q));
t('<strong> became a cloze', res.some(c => c.kind === 'cloze' && /determinant/i.test(c.a)),
  res.filter(c => c.kind === 'cloze'));
t('the cloze blanks the term out',
  res.filter(c => c.kind === 'cloze').every(c => c.q.includes('[...]') && !/determinant/i.test(c.q)));
t('<ul> became exactly one enumeration', res.filter(c => c.kind === 'list').length === 1);
t('every list item is in the answer', (() => {
  const l = res.find(c => c.kind === 'list');
  return l && ['Full', 'Partial', 'Transitive'].every(x => l.a.includes(x));
})());
t('slide number captured for jump-back', res.some(c => c.slide === 9), res.map(c => c.slide));
t('"Slide 9" is not itself a question', !res.some(c => /What is Slide 9/i.test(c.q)));
t('"Overview" boilerplate is skipped', !res.some(c => /What is Overview/i.test(c.q)));

console.log('\nrobustness in a real DOM');
t('malformed HTML does not throw', (await evalJs(
  `Array.isArray(window.__cards.fromHtml('<p>unclosed <strong>x', {}))`)) === true);
t('empty input is safe', (await evalJs('window.__cards.fromHtml("", {}).length')) === 0);
// A parsed document is inert: nothing in stored note content can execute.
t('a script tag neither runs nor becomes a card', (await evalJs(`(() => {
  window.__pwned = false;
  const cards = window.__cards.fromHtml(
    '<h2>Topic Name</h2><scr'+'ipt>window.__pwned=true</scr'+'ipt><p>Real body text here.</p>', {});
  return !window.__pwned && !cards.some(c => /pwned/.test(c.a));
})()`) === true));

console.log('\nfromSelection routes correctly in the page');
t('an HTML fragment uses the HTML parser', (await evalJs(
  `window.__cards.fromSelection('<h2>Indexing</h2><p>An index avoids a full table scan.</p>', {}).length >= 1`)) === true);
t('a plain fragment uses the text parser', (await evalJs(
  `window.__cards.fromSelection('# Indexing\\nAn index avoids a full table scan.', {}).length >= 1`)) === true);

console.log('\nfingerprints are stable across runtimes');
t('same content gives the same fp twice', (await evalJs(`(() => {
  const a = window.__cards.fromHtml(${JSON.stringify(HTML)}, {});
  const b = window.__cards.fromHtml(${JSON.stringify(HTML)}, {});
  return a.length === b.length && a.every((c, i) => c.fp === b[i].fp);
})()`)) === true);

const errs = events
  .filter(e => e.method === 'Runtime.exceptionThrown')
  .map(e => e.params.exceptionDetails?.exception?.description || '?')
  .filter(e => !/firebase|firestore|net::|Failed to load|recaptcha|appCheck|installations|FirebaseError|gstatic|ERR_/i.test(e));
t('no uncaught exceptions', errs.length === 0, errs.slice(0, 3));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
