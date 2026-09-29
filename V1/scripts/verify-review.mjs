// Drives the review surface (spec R-3) in a real browser.
//
// Unit tests cover the scheduler and the store; none of them prove a card can
// actually be REVIEWED. This clicks through a real session: reveal, grade,
// undo, keyboard, phone-sized touch targets, and the recap.
//
// The cases that earn their place:
//
//   "undo restores the exact previous schedule"
//       A mis-tap on a phone is common. Without a working undo it silently
//       corrupts a card's schedule with no way back and no visible symptom.
//
//   "grade buttons are big enough for a thumb"
//       The spec calls phone review the killer feature. A 30px target in a
//       one-handed context is the difference between using it and not.
//
//   "Again re-queues the card in this session"
//       That is what grading Again means; sending it to tomorrow instead makes
//       the grade a lie.
//
// Run:  node scripts/verify-review.mjs      (after npm run build)
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

try {
  await launch();
} catch (e) {
  if (e.code === 'NO_BROWSER') { console.log('SKIP: ' + e.message); process.exit(0); }
  throw e;
}
const { send, evalJs, events } = await connect();
await send('Runtime.enable');
await send('Page.enable');

// Clear any deck this file left behind on a previous run BEFORE the app boots.
// The card store persists to localStorage by design, and a headless profile
// keeps it between runs — so a second run found the cards already present and
// correctly reported "0 added", which looked like an extraction bug and was
// not. An un-isolated test that cries wolf is worse than no test.
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try {
    Object.keys(localStorage)
      .filter(k => k.indexOf('studyos_cards_') === 0)
      .forEach(k => localStorage.removeItem(k));
  } catch (e) {}`,
});

await send('Page.navigate', { url: PAGE });
await new Promise(r => setTimeout(r, 5000));

console.log('\nmodules loaded');
t('deck module available', await evalJs('typeof (window.SOS && window.SOS.deck) === "object"'));
t('review module available', await evalJs('typeof (window.SOS && window.SOS.review) === "object"'));
t('study hook defined', await evalJs('typeof window.sosStudy === "function"'));
t('make-cards hook defined', await evalJs('typeof window.sosMakeCards === "function"'));
t('in-page make-cards helper defined', await evalJs('typeof window.sosMakeCardsHere === "function"'));

// ── Seed a class with a note, then generate cards through the real path ───
console.log('\ncard generation through the app');
const gen = await evalJs(`(() => {
  const cls = { id:'rv1', name:'Databases', code:'CS 4400', color:'#9dc0ee', modules:[] };
  const mod = { id:'rm1', name:'Lecture Notes', type:'notes', files:[], prompts:[], notes:[
    { id:'rn1', title:'Normalization', updated: Date.now(), body:
      '# Third Normal Form\\nA relation is in 3NF when no non-key attribute is transitively dependent on the primary key.\\n\\n## Anomalies\\n- Insertion anomaly\\n- Update anomaly\\n- Deletion anomaly\\n\\n# Keys\\nA **superkey** is any set of attributes that uniquely identifies a row in the table.\\n' },
  ]};
  cls.modules.push(mod);
  classes.push(cls);
  const r = window.sosMakeCards('rv1','rm1','rn1',false);
  return { added: r.added.length, total: window.SOS.deck.countsFor('rv1').total,
           kinds: [...new Set(r.added.map(c=>c.kind))] };
})()`);
t('cards were generated', gen.added >= 3, gen);
t('several kinds produced', gen.kinds.length >= 2, gen.kinds);
t('stored against the class', gen.total === gen.added);

t('counts report them as studiable', (await evalJs(
  'window.SOS.deck.countsFor("rv1").dueNow')) === gen.added);

// ── Open the review surface ───────────────────────────────────────────────
console.log('\nreview surface opens');
await evalJs(`window.sosStudy('rv1'); true;`);
await new Promise(r => setTimeout(r, 500));

t('overlay mounted', (await evalJs('document.querySelectorAll(".sos-review").length')) === 1);
t('it is on top of everything', (await evalJs(
  'parseInt(getComputedStyle(document.querySelector(".sos-review")).zIndex,10) >= 10300')));
t('a question is shown', (await evalJs(
  '!!document.querySelector(".sos-review-q") && document.querySelector(".sos-review-q").textContent.length > 5')));
t('the answer is hidden before reveal', (await evalJs(
  'document.querySelectorAll(".sos-review-a").length')) === 0);
t('progress shows position', (await evalJs(
  'document.querySelector("[data-count]").textContent.indexOf("1/") === 0')),
  await evalJs('document.querySelector("[data-count]").textContent'));
t('starting a second session does not stack', (await evalJs(
  'window.sosStudy("rv1"); document.querySelectorAll(".sos-review").length')) === 1);

// ── Reveal ────────────────────────────────────────────────────────────────
console.log('\nreveal');
await evalJs(`document.querySelector('.sos-review-face').click(); true;`);
await new Promise(r => setTimeout(r, 250));
t('answer revealed on tap', (await evalJs('document.querySelectorAll(".sos-review-a").length')) === 1);
t('four grade buttons appear', (await evalJs('document.querySelectorAll(".sos-review-grade").length')) === 4);
t('each names its next interval', (await evalJs(
  'Array.from(document.querySelectorAll(".sos-review-grade small")).every(s=>s.textContent.trim().length>0)')),
  await evalJs('Array.from(document.querySelectorAll(".sos-review-grade small")).map(s=>s.textContent)'));

// Phone-first: the spec's killer feature depends on these being thumb-sized.
const sizes = await evalJs(`Array.from(document.querySelectorAll('.sos-review-grade'))
  .map(b => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })`);
t('grade buttons are thumb-sized (>=44px tall)', sizes.every(s => s.h >= 44), sizes);
t('the whole face is the reveal target', (await evalJs(`(() => {
  const f = document.querySelector('.sos-review-face').getBoundingClientRect();
  return f.height > 150 && f.width > 200;
})()`)));

// ── Grading ───────────────────────────────────────────────────────────────
console.log('\ngrading');
const beforeGrade = await evalJs(`(() => {
  const c = window.SOS.deck.forClass('rv1').find(c => !c.sched || c.sched.state === 'new');
  return { id: c && c.id, reps: c && c.sched ? c.sched.reps : 0 };
})()`);
await evalJs(`document.querySelector('.sos-review-grade[data-g="3"]').click(); true;`);
await new Promise(r => setTimeout(r, 300));
t('a card was scheduled', (await evalJs(
  `window.SOS.deck.forClass('rv1').filter(c => c.sched && c.sched.reps > 0).length`)) >= 1);
t('advanced to the next card', (await evalJs(
  'document.querySelector("[data-count]").textContent')) !== '1/' + gen.added,
  await evalJs('document.querySelector("[data-count]").textContent'));
t('the next card is unrevealed', (await evalJs('document.querySelectorAll(".sos-review-a").length')) === 0);

// ── Undo ──────────────────────────────────────────────────────────────────
console.log('\nundo restores the exact previous schedule');
await evalJs(`document.querySelector('.sos-review-face').click(); true;`);
await new Promise(r => setTimeout(r, 200));
const undoTest = await evalJs(`(async () => {
  const count = document.querySelector('[data-count]').textContent;
  const cardsBefore = JSON.stringify(window.SOS.deck.forClass('rv1').map(c => [c.id, c.sched && c.sched.reps]));
  document.querySelector('.sos-review-grade[data-g="4"]').click();
  await new Promise(r => setTimeout(r, 250));
  document.querySelector('.sos-review-face').click();
  await new Promise(r => setTimeout(r, 150));
  const undoBtn = document.querySelector('[data-act="undo"]');
  const enabled = undoBtn && !undoBtn.disabled;
  if (enabled) undoBtn.click();
  await new Promise(r => setTimeout(r, 250));
  const cardsAfter = JSON.stringify(window.SOS.deck.forClass('rv1').map(c => [c.id, c.sched && c.sched.reps]));
  return { enabled, restored: cardsBefore === cardsAfter, count,
           countAfter: document.querySelector('[data-count]').textContent };
})()`);
t('undo is offered after a grade', undoTest.enabled === true);
t('undo restores the previous scheduling state', undoTest.restored === true, undoTest);
t('and steps back to that card', undoTest.countAfter === undoTest.count, undoTest);

// ── Keyboard ──────────────────────────────────────────────────────────────
console.log('\nkeyboard (desktop)');
const kb = await evalJs(`(async () => {
  const fire = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  fire(' ');
  await new Promise(r => setTimeout(r, 200));
  const revealed = document.querySelectorAll('.sos-review-a').length === 1;
  const before = document.querySelector('[data-count]').textContent;
  fire('3');
  await new Promise(r => setTimeout(r, 250));
  return { revealed, moved: document.querySelector('[data-count]').textContent !== before };
})()`);
t('Space reveals', kb.revealed === true);
t('a number key grades', kb.moved === true, kb);

// ── Again re-queues within the session ────────────────────────────────────
console.log('\nAgain comes back this session');
const againTest = await evalJs(`(async () => {
  document.querySelector('.sos-review-face').click();
  await new Promise(r => setTimeout(r, 200));
  const before = parseInt(document.querySelector('[data-count]').textContent.split('/')[1], 10);
  document.querySelector('.sos-review-grade[data-g="1"]').click();
  await new Promise(r => setTimeout(r, 250));
  const after = parseInt(document.querySelector('[data-count]').textContent.split('/')[1], 10);
  return { before, after };
})()`);
t('the queue grows so the card returns', againTest.after === againTest.before + 1, againTest);

// ── Finish and recap ──────────────────────────────────────────────────────
console.log('\nrecap');
const recap = await evalJs(`(async () => {
  for (let i = 0; i < 40; i++) {
    if (document.querySelector('.sos-review-recap')) break;
    const face = document.querySelector('.sos-review-face');
    if (face) face.click();
    await new Promise(r => setTimeout(r, 90));
    const g = document.querySelector('.sos-review-grade[data-g="3"]');
    if (g) g.click();
    await new Promise(r => setTimeout(r, 120));
  }
  const el = document.querySelector('.sos-review-recap');
  return el ? { shown: true, text: el.textContent.replace(/\\s+/g, ' ').trim() } : { shown: false };
})()`);
t('a recap is shown at the end', recap.shown === true, recap);
t('it reports cards and time', recap.shown && /card/.test(recap.text) && /min/.test(recap.text), recap.text);
t('it reports mastery', recap.shown && /mastered/.test(recap.text), recap.text);

await evalJs(`(document.querySelector('.sos-review-recap button')||{click(){}}).click(); true;`);
await new Promise(r => setTimeout(r, 300));
t('closing removes the overlay', (await evalJs('document.querySelectorAll(".sos-review").length')) === 0);

// ── Dashboard tile ────────────────────────────────────────────────────────
console.log('\ndashboard');
t('the Cards Due tile exists', (await evalJs('!!document.getElementById("stat-cards")')));
t('the anxiety-only Exams tile is gone', (await evalJs('!document.getElementById("stat-exams")')));
t('the tile is clickable', (await evalJs(
  'getComputedStyle(document.getElementById("stat-card-cards")).cursor')) === 'pointer');
await evalJs('updateStats(); true;');
t('it shows a number', (await evalJs(
  'document.getElementById("stat-cards").textContent.trim().length > 0')),
  await evalJs('document.getElementById("stat-cards").textContent'));

// ── Empty state ───────────────────────────────────────────────────────────
console.log('\nempty state');
t('studying a class with no cards does not open an overlay', (await evalJs(`(() => {
  classes.push({ id:'empty1', name:'Empty', color:'#888', modules:[] });
  window.sosStudy('empty1');
  return document.querySelectorAll('.sos-review').length;
})()`)) === 0);

const errs = events
  .filter(e => e.method === 'Runtime.exceptionThrown')
  .map(e => e.params.exceptionDetails?.exception?.description || '?')
  .filter(e => !/firebase|firestore|net::|Failed to load|recaptcha|appCheck|installations|FirebaseError|gstatic|ERR_/i.test(e));
t('no uncaught exceptions throughout', errs.length === 0, errs.slice(0, 3));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
