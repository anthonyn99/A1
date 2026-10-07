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

t('counts report them as studiable, capped by the daily new-card limit', (await evalJs(
  'window.SOS.deck.countsFor("rv1").newAvailable')) === Math.min(gen.added, 15));
t('unseen cards are not "due"', (await evalJs('window.SOS.deck.countsFor("rv1").due')) === 0);

// ── Open the review surface ───────────────────────────────────────────────
console.log('\nreview surface opens (new cards: the learn flow)');
const W = (ms) => new Promise(r => setTimeout(r, ms));
await evalJs(`localStorage.removeItem('studyos_cards_settings_v1'); window.sosStudy('rv1'); true;`);
await W(500);

t('overlay mounted', (await evalJs('document.querySelectorAll(".sos-review").length')) === 1);
t('it is on top of everything', (await evalJs(
  'parseInt(getComputedStyle(document.querySelector(".sos-review")).zIndex,10) >= 10300')));
t('a question is shown', (await evalJs(
  '!!document.querySelector(".sos-review-q") && document.querySelector(".sos-review-q").textContent.length > 5')));
t('the answer is hidden before reveal', (await evalJs('document.querySelectorAll(".sos-review-a").length')) === 0);
t('a new card says so — she is not asked to rate it', /New card/i.test(await evalJs('document.querySelector(".sos-review-mode").textContent')));
t('progress shows position', (await evalJs('document.querySelector("[data-count]").textContent.indexOf("1 / ") === 0')),
  await evalJs('document.querySelector("[data-count]").textContent'));
t('a breadcrumb names the class', /CS 4400/.test(await evalJs('document.querySelector("[data-crumb]").textContent')));
t('starting a second session does not stack', (await evalJs(
  'window.sosStudy("rv1"); document.querySelectorAll(".sos-review").length')) === 1);

console.log('\nlearn: reveal, Again, Add to reviews');
await evalJs(`document.querySelector('.sos-review-face').click(); true;`);
await W(250);
t('answer revealed on tap', (await evalJs('document.querySelectorAll(".sos-review-a").length')) === 1);
t('two buttons: Again and Add to reviews', (await evalJs(
  'Array.from(document.querySelectorAll(".sos-review-btn")).map(b=>b.querySelector("span").textContent).join("|")')) === 'Again|Add to reviews');
const sizes = await evalJs(`Array.from(document.querySelectorAll('.sos-review-btn'))
  .map(b => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })`);
t('buttons are thumb-sized (>=44px tall)', sizes.every(s => s.h >= 44), sizes);
const again = await evalJs(`(async () => {
  const id = window.SOS.review.isOpen() && document.querySelector('[data-count]').textContent;
  const total = () => parseInt(document.querySelector('[data-count]').textContent.split('/')[1], 10);
  const before = total();
  const sched = JSON.stringify(window.SOS.deck.forClass('rv1').map(c => c.sched));
  document.querySelector('[data-a="again"]').click();
  await new Promise(r => setTimeout(r, 200));
  return { before, after: total(), untouched: sched === JSON.stringify(window.SOS.deck.forClass('rv1').map(c => c.sched)) };
})()`);
t('Again keeps the new card in this session', again.after === again.before + 1, again);
t('...without scheduling anything', again.untouched === true);
const add = await evalJs(`(async () => {
  document.querySelector('.sos-review-face').click();
  await new Promise(r => setTimeout(r, 150));
  document.querySelector('[data-a="add"]').click();
  await new Promise(r => setTimeout(r, 200));
  const c = window.SOS.deck.forClass('rv1').filter(c => c.sched && c.sched.reps > 0);
  return { n: c.length, intro: c.every(x => !!x.introducedAt), state: c[0] && c[0].sched.state };
})()`);
t('Add to reviews schedules the card (Good)', add.n === 1 && add.state === 'review', add);
t('...and counts it toward today\'s new cards', add.intro === true);

console.log('\nundo restores the exact previous schedule');
const undoTest = await evalJs(`(async () => {
  const count = document.querySelector('[data-count]').textContent;
  const before = JSON.stringify(window.SOS.deck.forClass('rv1').map(c => [c.id, c.sched, c.introducedAt || 0]));
  document.querySelector('.sos-review-face').click();
  await new Promise(r => setTimeout(r, 150));
  document.querySelector('[data-a="add"]').click();
  await new Promise(r => setTimeout(r, 200));
  const undoBtn = document.querySelector('[data-act="undo"]');
  const enabled = undoBtn && !undoBtn.disabled;
  if (enabled) undoBtn.click();
  await new Promise(r => setTimeout(r, 200));
  const after = JSON.stringify(window.SOS.deck.forClass('rv1').map(c => [c.id, c.sched, c.introducedAt || 0]));
  return { enabled, restored: before === after, count, countAfter: document.querySelector('[data-count]').textContent };
})()`);
t('undo is offered after an answer', undoTest.enabled === true);
t('undo restores the previous scheduling state', undoTest.restored === true, undoTest);
t('and steps back to that card', undoTest.countAfter === undoTest.count, undoTest);

console.log('\nkeyboard (desktop)');
const kb = await evalJs(`(async () => {
  const fire = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  fire(' ');
  await new Promise(r => setTimeout(r, 200));
  const revealed = document.querySelectorAll('.sos-review-a').length === 1;
  const before = document.querySelector('[data-count]').textContent;
  fire(' ');
  await new Promise(r => setTimeout(r, 250));
  return { revealed, moved: document.querySelector('[data-count]').textContent !== before };
})()`);
t('Space reveals', kb.revealed === true);
t('Space again adds it to reviews', kb.moved === true, kb);
await evalJs(`window.SOS.review.closeReview(); true;`);

// ── Due cards: Forgot / Remembered, with Mochi's re-review ────────────────
console.log('\nreview: Forgot / Remembered and the re-review step');
const due = await evalJs(`(async () => {
  const D = window.SOS.deck;
  // Two reviewed cards, both due now.
  const [a, b] = D.forClass('rv1').filter(c => c.sched && c.sched.reps > 0);
  for (const c of [a, b]) D.restoreSched(c.id, { ...c.sched, due: Date.now() - 1000, lastReview: Date.now() - 5 * 86400000 });
  window.SOS.review.startReview({ classId: 'rv1' }, { mode: 'review' });
  await new Promise(r => setTimeout(r, 300));
  const total = () => parseInt(document.querySelector('[data-count]').textContent.split('/')[1], 10);
  const first = total();
  document.querySelector('.sos-review-face').click();
  await new Promise(r => setTimeout(r, 150));
  const labels = Array.from(document.querySelectorAll('.sos-review-btn span')).map(s => s.textContent).join('|');
  const cur = () => D.get(window.SOS.review.isOpen() && document.querySelector('[data-count]') && D.forClass('rv1').find(c => c.sched && c.sched.reps > 0 && document.querySelector('.sos-review-q').textContent.indexOf(c.q.slice(0, 12)) >= 0).id);
  const c1 = cur();
  const s1 = JSON.stringify(c1.sched);
  document.querySelector('[data-a="forgot"]').click();               // first Forgot: no lapse yet
  await new Promise(r => setTimeout(r, 200));
  const afterForgot = { grew: total() === first + 1, untouched: JSON.stringify(D.get(c1.id).sched) === s1 };
  // Walk to the re-review copy and remember it.
  for (let k = 0; k < 10; k++) {
    if (document.querySelector('.sos-review-mode').textContent.indexOf('once more') >= 0) break;
    document.querySelector('.sos-review-face').click();
    await new Promise(r => setTimeout(r, 120));
    document.querySelector('[data-a="remembered"]').click();
    await new Promise(r => setTimeout(r, 150));
  }
  const reMode = document.querySelector('.sos-review-mode') && document.querySelector('.sos-review-mode').textContent;
  document.querySelector('.sos-review-face').click();
  await new Promise(r => setTimeout(r, 150));
  document.querySelector('[data-a="remembered"]').click();
  await new Promise(r => setTimeout(r, 200));
  const after = D.get(c1.id).sched;
  window.SOS.review.closeReview();
  return { labels, afterForgot, reMode, lapses: after.lapses, reps: after.reps, prevReps: JSON.parse(s1).reps,
           interval: after.lastInterval };
})()`);
t('two buttons: Forgot and Remembered', due.labels === 'Forgot|Remembered', due.labels);
t('the first Forgot brings it back later in the session', due.afterForgot.grew === true, due);
t('...without committing a lapse', due.afterForgot.untouched === true, due);
t('the re-review copy is labelled', /once more/.test(due.reMode || ''), due.reMode);
t('Remembered on re-review commits (Hard, a short interval) — no lapse', due.reps === due.prevReps + 1 && due.lapses === 0, due);

const twice = await evalJs(`(async () => {
  const D = window.SOS.deck;
  const c = D.forClass('rv1').find(c => c.sched && c.sched.reps > 0);
  D.restoreSched(c.id, { ...c.sched, due: Date.now() - 1000 });
  window.SOS.review.startReview({ ids: [c.id] }, { mode: 'review' });
  await new Promise(r => setTimeout(r, 300));
  for (let k = 0; k < 2; k++) {
    document.querySelector('.sos-review-face').click();
    await new Promise(r => setTimeout(r, 120));
    document.querySelector('[data-a="forgot"]').click();
    await new Promise(r => setTimeout(r, 180));
  }
  const after = D.get(c.id).sched;
  const recap = !!document.querySelector('.sos-review-recap');
  window.SOS.review.closeReview();
  return { lapses: after.lapses, state: after.state, recap };
})()`);
t('Forgot twice commits the lapse (relearning)', twice.lapses === 1 && twice.state === 'relearning', twice);

// ── Edit, archive, delete — each one key, each undoable ───────────────────
console.log('\nedit / archive / delete');
const tools = await evalJs(`(async () => {
  const D = window.SOS.deck, w = (ms) => new Promise(r => setTimeout(r, ms));
  const fire = (k, o) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...(o || {}) }));
  const c = D.forClass('rv1').find(c => c.sched && c.sched.reps > 0);
  D.restoreSched(c.id, { ...c.sched, due: Date.now() - 1000 });
  const sched = JSON.stringify(D.get(c.id).sched);
  window.SOS.review.startReview({ ids: [c.id] }, { mode: 'review' });
  await w(300);
  fire('e'); await w(150);
  const ta = document.querySelector('.sos-review-edit textarea');
  const editorOpen = !!ta;
  ta.value = 'What does **3NF** forbid?\\n---\\nTransitive dependencies on the key.';
  ta.dispatchEvent(new Event('input'));
  await w(50);
  const preview = document.querySelector('.sos-review-edit .pv').innerHTML;
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await w(200);
  const e1 = D.get(c.id);
  const edited = { sameId: !!e1, q: e1.q, sameSched: JSON.stringify(e1.sched) === sched, bold: /<strong>3NF<\\/strong>/.test(document.querySelector('.sos-review-q').innerHTML) };
  fire('u'); await w(200);
  const undoneEdit = D.get(c.id).q === c.q;
  fire('a'); await w(200);
  const archived = D.statusOf(D.get(c.id)) === 'archived';
  fire('u'); await w(200);
  const unarchived = D.statusOf(D.get(c.id)) === 'active';
  fire('Delete'); await w(200);
  const deleted = !D.get(c.id) && D.rawForClass('rv1').some(x => x.id === c.id && x.deletedAt);
  fire('u'); await w(200);
  const restored = !!D.get(c.id) && JSON.stringify(D.get(c.id).sched) === sched;
  window.SOS.review.closeReview();
  return { editorOpen, preview: /3NF/.test(preview), edited, undoneEdit, archived, unarchived, deleted, restored };
})()`);
t('E opens the editor with a live preview', tools.editorOpen && tools.preview, tools);
t('saving keeps the id and the schedule', tools.edited.sameId && tools.edited.sameSched && /3NF/.test(tools.edited.q), tools.edited);
t('the edited card renders its Markdown', tools.edited.bold === true, tools.edited);
t('U undoes the edit', tools.undoneEdit === true);
t('A archives', tools.archived === true);
t('U restores it to reviews', tools.unarchived === true);
t('Del deletes (a tombstone)', tools.deleted === true);
t('U brings it back with its schedule', tools.restored === true, tools);

// ── Markdown and cloze ────────────────────────────────────────────────────
console.log('\nMarkdown and cloze render');
const md = await evalJs(`(async () => {
  const D = window.SOS.deck, w = (ms) => new Promise(r => setTimeout(r, ms));
  D.addExternal('rv1', 'rm1', [
    { front: 'What does this **SQL** return?\\n\\n\`\`\`sql\\nSELECT name FROM t;\\n\`\`\`', back: '| col | value |\\n|---|---|\\n| name | each row |' },
    { kind: 'cloze', front: 'A relation is in 3NF if it is in 2NF and has no {{1::transitive dependencies}}.', back: '' },
  ], { noteId: 'md_fixture', title: 'Markdown' });
  const ids = D.forClass('rv1').filter(c => c.sourceNoteId === 'md_fixture').map(c => c.id);
  window.SOS.review.startReview({ ids }, { mode: 'learn', anyNew: true, maxNew: 10 });
  await w(300);
  const q1 = document.querySelector('.sos-review-q').innerHTML;
  document.querySelector('.sos-review-face').click(); await w(150);
  const a1 = document.querySelector('.sos-review-a').innerHTML;
  document.querySelector('[data-a="add"]').click(); await w(200);
  const q2 = document.querySelector('.sos-review-q').innerHTML;
  document.querySelector('.sos-review-face').click(); await w(150);
  const q2r = document.querySelector('.sos-review-q').innerHTML;
  window.SOS.review.closeReview();
  return { bold: /<strong>SQL<\\/strong>/.test(q1), code: /<pre><code>SELECT name FROM t;/.test(q1), table: /<table>/.test(a1),
           hole: /cz-hole/.test(q2) && !/transitive dependencies/.test(q2), shown: /cz-ans">transitive dependencies/.test(q2r) };
})()`);
t('bold renders', md.bold, md);
t('fenced code renders', md.code, md);
t('a table renders', md.table, md);
t('a cloze hides its blank', md.hole, md);
t('...and reveals it highlighted', md.shown, md);

// ── Finish and recap ──────────────────────────────────────────────────────
console.log('\nrecap');
const recap = await evalJs(`(async () => {
  window.SOS.review.startReview({ classId: 'rv1' }, { mode: 'learn', anyNew: true, maxNew: 3 });
  await new Promise(r => setTimeout(r, 300));
  for (let i = 0; i < 20; i++) {
    if (document.querySelector('.sos-review-recap')) break;
    document.querySelector('.sos-review-face').click();
    await new Promise(r => setTimeout(r, 90));
    const g = document.querySelector('[data-a="add"]');
    if (g) g.click();
    await new Promise(r => setTimeout(r, 120));
  }
  const el = document.querySelector('.sos-review-recap');
  return el ? { shown: true, text: el.textContent.replace(/\\s+/g, ' ').trim() } : { shown: false };
})()`);
t('a recap is shown at the end', recap.shown === true, recap);
t('it reports cards learned and time', recap.shown && /new learned/.test(recap.text) && /min/.test(recap.text), recap.text);
t('it reports mastery', recap.shown && /mastered/.test(recap.text), recap.text);

await evalJs(`(document.querySelector('.sos-review-recap [data-close]')||{click(){}}).click(); true;`);
await W(300);
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
