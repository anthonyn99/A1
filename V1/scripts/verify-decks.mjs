// Drives the class page's Flashcards section, Browse and the card editor
// (overhaul §5.3, §5.7) in a real browser.
//
// The cases that earn their place:
//
//   "the deck tree is built from the cards"
//       Class ▸ Document ▸ Topic, with New · Due · mastery per row — nothing
//       stored, so it can never drift from the cards.
//
//   "a bulk action reaches every selected card"
//       2,000 cards are only manageable in bulk; a bulk Archive that missed
//       half the selection would be worse than none.
//
//   "a card made by hand is a first-class card"
//       Markdown, cloze, tags, its own deck — and it studies like any other.
//
// Run:  node scripts/verify-decks.mjs      (after npm run build)
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
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 350))); }
};
const W = (ms) => new Promise((r) => setTimeout(r, ms));

try { await launch(); } catch (e) {
  if (e.code === 'NO_BROWSER') { console.log('SKIP: ' + e.message); process.exit(0); }
  throw e;
}
const { send, evalJs, events } = await connect();
await send('Runtime.enable');
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { Object.keys(localStorage).filter(k => /^studyos_cards/.test(k)).forEach(k => localStorage.removeItem(k)); } catch (e) {}`,
});
await send('Page.navigate', { url: PAGE });
await W(5000);

console.log('\nseed a class with a breakdown\'s cards and a note');
await evalJs(`(() => {
  const cls = { id:'dk1', name:'Computer Organization & Architecture', code:'CS 3503', color:'#9dc0ee', modules:[
    { id:'dm1', name:'Lectures', type:'documents', files:[], prompts:[], notes:[] }] };
  classes.push(cls);
  const D = window.SOS.deck;
  D.load();
  D.addExternal('dk1', 'dm1', [
    { front: 'What does two\\'s complement make easy?', back: 'Subtraction: it is addition of the negation.', priority: 1, status: 'active' },
    { front: 'How do you negate in two\\'s complement?', back: 'Invert every bit, then add 1.', priority: 1, status: 'active' },
    { front: 'What is the range of 8-bit two\\'s complement?', back: '-128 to 127.', priority: 2, status: 'suggested' },
  ], { noteId: 'topic_fileA_t11aa', title: 'Two\\'s complement' });
  D.addExternal('dk1', 'dm1', [
    { front: 'What is a radix?', back: 'The base of a number system.', priority: 1, status: 'active' },
  ], { noteId: 'topic_fileA_t22bb', title: 'Number bases' });
  D.markLessonRead('dk1', 'topic_fileA_t11aa');
  switchView('class', 'dk1');
  return true;
})()`);
await W(600);

const sec = await evalJs(`(() => {
  const m = document.getElementById('class-cards');
  return { html: !!m && m.innerHTML.length > 0, rows: m.querySelectorAll('.sc-row').length,
    meta: (m.querySelector('.sc-meta') || {}).textContent, title: (m.querySelector('h2') || {}).textContent };
})()`);
t('the class page has a Flashcards section', sec.html && /Flashcards/.test(sec.title), sec);
t('it says what is new, due and mastered', /new/.test(sec.meta) && /due/.test(sec.meta) && /mastered/.test(sec.meta), sec.meta);
t('suggestions are counted apart, not as new', /1 suggested/.test(sec.meta), sec.meta);
t('cards waiting for an unopened lesson say so', /1 waiting for their lesson/.test(sec.meta), sec.meta);
t('the class name renders as text (no "& amp")', (await evalJs('document.getElementById("detail-title").textContent')) === 'Computer Organization & Architecture');

console.log('\nthe deck tree');
const tree = await evalJs(`(async () => {
  const m = document.getElementById('class-cards');
  const docRow = m.querySelector('.sc-row');
  const caret = docRow.querySelector('[data-toggle]');
  caret.click();
  await new Promise(r => setTimeout(r, 200));
  const rows = Array.from(document.querySelectorAll('#class-cards .sc-row')).map(r => r.querySelector('.sc-name').textContent.trim());
  return { rows };
})()`);
t('a document row expands into its topics', tree.rows.length >= 3 && tree.rows.some((r) => /Two's complement/.test(r)) && tree.rows.some((r) => /Number bases/.test(r)), tree.rows);

const study = await evalJs(`(async () => {
  const row = Array.from(document.querySelectorAll('#class-cards .sc-row')).find(r => /Two's complement/.test(r.textContent));
  row.querySelector('[data-study]').click();
  await new Promise(r => setTimeout(r, 300));
  const n = document.querySelector('.sos-review [data-count]');
  const out = { open: !!document.querySelector('.sos-review'), count: n && n.textContent };
  window.SOS.review.closeReview();
  return out;
})()`);
t('clicking a topic studies just that deck (2 active, the suggestion stays out)', study.open && /\/ 2$/.test(study.count || ''), study);

console.log('\nmy own decks');
const ud = await evalJs(`(async () => {
  const D = window.SOS.deck;
  const d = D.createDeck('dk1', 'Midterm 1');
  D.moveCards(D.forClass('dk1').filter(c => /radix/.test(c.q)).map(c => c.id), d.id);
  window.sosDecorateClass(classes.find(c => c.id === 'dk1'));
  await new Promise(r => setTimeout(r, 200));
  const row = Array.from(document.querySelectorAll('#class-cards .sc-row')).find(r => /Midterm 1/.test(r.textContent));
  return { row: !!row, meta: row && row.querySelector('.sc-meta').textContent };
})()`);
t('a deck of her own appears with its cards counted (this one waits for its lesson)', ud.row && /1 waiting/.test(ud.meta || ''), ud);

console.log('\nbrowse');
const br = await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('#class-cards .sc-head [data-browse]').click();
  await w(250);
  const ov = document.querySelector('.sc-ov');
  const all = ov.querySelectorAll('.sc-item').length;
  const q = ov.querySelector('[data-q]');
  q.value = 'negate'; q.dispatchEvent(new Event('input'));
  await w(150);
  const found = document.querySelectorAll('.sc-ov .sc-item').length;
  const q2 = document.querySelector('.sc-ov [data-q]');
  q2.value = ''; q2.dispatchEvent(new Event('input'));
  await w(150);
  const st = document.querySelector('.sc-ov [data-status]');
  st.value = 'suggested'; st.dispatchEvent(new Event('change'));
  await w(150);
  const sugg = document.querySelectorAll('.sc-ov .sc-item').length;
  const st2 = document.querySelector('.sc-ov [data-status]');
  st2.value = 'all'; st2.dispatchEvent(new Event('change'));
  await w(150);
  document.querySelector('.sc-ov [data-all]').click();
  await w(150);
  const bulk = !!document.querySelector('.sc-ov .sc-bulk');
  const tagIn = document.querySelector('.sc-ov [data-tagto]');
  tagIn.value = 'midterm';
  document.querySelector('.sc-ov [data-tagbtn]').click();
  await w(150);
  const tagged = window.SOS.deck.forClass('dk1').filter(c => (c.tags || []).includes('midterm')).length;
  document.querySelector('.sc-ov [data-bulk="archived"]').click();
  await w(150);
  const archived = window.SOS.deck.forClass('dk1').filter(c => window.SOS.deck.statusOf(c) === 'archived').length;
  return { all, found, sugg, bulk, tagged, archived };
})()`);
t('every card is listed, any status', br.all === 4, br);
t('search narrows the list', br.found === 1, br);
t('the status filter finds the suggestion', br.sugg === 1, br);
t('select all shows the bulk bar', br.bulk === true);
t('a bulk tag reaches every selected card', br.tagged === 4, br);
t('a bulk archive reaches every selected card', br.archived === 4, br);
await evalJs(`(() => { const D = window.SOS.deck; D.setStatus(D.forClass('dk1').map(c => c.id), 'active'); return true; })()`);

console.log('\nthe editor: a card made by hand');
const ed = await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('.sc-ov [data-new]').click();
  await w(200);
  const box = document.querySelector('.sc-ed');
  const ta = box.querySelector('textarea');
  ta.value = 'Overflow happens when two {{1::positive}} numbers sum to a {{2::negative}} one.';
  ta.dispatchEvent(new Event('input'));
  await w(80);
  const pv = box.querySelector('[data-pv]').innerHTML;
  box.querySelector('[data-tags]').value = 'overflow, exam';
  box.querySelector('[data-save]').click();
  await w(200);
  const c = window.SOS.deck.forClass('dk1').find(x => /Overflow happens/.test(x.q));
  return { previewHole: /cz-hole/.test(pv), blanks: /2 blanks/.test(pv), saved: !!c, kind: c && c.kind, tags: c && c.tags,
           units: c && window.SOS.deck.studyQueue({ ids: [c.id] }, { mode: 'learn' }).length, listed: document.querySelectorAll('.sc-ov .sc-item').length };
})()`);
t('the preview hides the blank', ed.previewHole, ed);
t('...and says each blank is reviewed on its own', ed.blanks, ed);
t('the card is saved as a cloze with its tags', ed.saved && ed.kind === 'cloze' && ed.tags.join() === 'overflow,exam', ed);
t('it studies as two units, introduced right away (she made it)', ed.units === 2, ed);
t('browse lists it at once', ed.listed === 5, ed);

const edit = await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const D = window.SOS.deck;
  const c = D.forClass('dk1').find(x => /radix/.test(x.q));
  D.gradeCard(c.id, 3);
  const before = JSON.stringify(D.get(c.id).sched);
  const row = Array.from(document.querySelectorAll('.sc-ov .sc-item')).find(r => /radix/.test(r.textContent));
  row.click();
  await w(200);
  const ta = document.querySelector('.sc-ed textarea');
  ta.value = 'What is the radix of hexadecimal?\\n---\\n16.';
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await w(200);
  const after = D.get(c.id);
  return { sameId: !!after, q: after.q, schedKept: JSON.stringify(after.sched) === before, closed: !document.querySelector('.sc-ed') };
})()`);
t('editing from Browse keeps the id and the schedule', edit.sameId && edit.schedKept && /hexadecimal/.test(edit.q), edit);
t('Ctrl+Enter saves and closes', edit.closed === true);

await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true;`);
await W(200);
t('Esc closes Browse', (await evalJs('!document.querySelector(".sc-ov")')) === true);

const errs = events
  .filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params.exceptionDetails?.exception?.description || '?')
  .filter((e) => !/firebase|firestore|net::|Failed to load|recaptcha|appCheck|installations|FirebaseError|gstatic|ERR_/i.test(e));
t('no uncaught exceptions throughout', errs.length === 0, errs.slice(0, 3));

await evalJs(`(() => { for (let i = classes.length - 1; i >= 0; i--) if (classes[i].id === 'dk1') classes.splice(i, 1); return true; })()`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
