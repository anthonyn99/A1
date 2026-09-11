// Tests for js/modules/cards.js — card extraction (spec R-1).
//
// The failure that matters most here is not a crash, it is BAD CARDS. A deck
// full of one-word answers and paragraph-length questions teaches nothing, costs
// reviews, and makes the whole feature feel like noise — at which point she
// stops opening it. So most of this file is about what gets REJECTED.
//
// The cases that earn their place:
//
//   "re-extracting an edited note keeps scheduling state"
//       Notes get edited constantly. If a re-run reset every card's schedule,
//       weeks of review history would evaporate silently.
//
//   "cards whose source vanished are reported, not deleted"
//       She may have reviewed them for weeks. Deleting without asking is the
//       worst available behaviour.
//
//   "both note systems are handled"
//       Module notes are plain text; page-editor notes are real HTML. A
//       generator that handles one strands half her material.
//
// Run with:  npm run test:cards
import * as C from '../js/modules/cards.js';

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 400))); }
};

const SRC = { classId: 'c1', moduleId: 'm1', noteId: 'n1', title: 'Normalization' };

// ── Plain text (module notes) ─────────────────────────────────────────────
console.log('\nplain text: headings become questions');
{
  const cards = C.fromPlainText(`
# Third Normal Form
A relation is in 3NF when it is in 2NF and no non-key attribute is transitively dependent on the primary key.
`, SRC);
  t('produced a card', cards.length >= 1, cards.map(c => c.q));
  const qa = cards.find(c => c.kind === 'qa');
  t('question built from the heading', qa && /What is Third Normal Form\?/.test(qa.q), qa && qa.q);
  t('answer is the body', qa && /transitively dependent/.test(qa.a));
  t('carries the source note', qa && qa.sourceNoteId === 'n1' && qa.classId === 'c1');
}

console.log('\nplain text: definitions and clozes');
{
  const cards = C.fromPlainText(`
# Keys
A **superkey** is any set of attributes that uniquely identifies a row.
Candidate key: a minimal superkey with no redundant attributes.
`, SRC);
  const cloze = cards.find(c => c.kind === 'cloze');
  t('cloze made from the bold term', !!cloze, cards.map(c => [c.kind, c.q]));
  t('the term is blanked out', cloze && cloze.q.includes('[...]') && !/superkey/i.test(cloze.q), cloze && cloze.q);
  t('the term is the answer', cloze && /superkey/i.test(cloze.a));
  const def = cards.find(c => /Candidate key/i.test(c.q));
  t('"Term: definition" becomes a card', !!def, cards.map(c => c.q));
  t('and reads as a question', def && /^What is /.test(def.q), def && def.q);
}

console.log('\nplain text: bullet runs');
{
  const cards = C.fromPlainText(`
## Anomalies
- Insertion anomaly
- Update anomaly
- Deletion anomaly
`, SRC);
  const list = cards.find(c => c.kind === 'list');
  t('a bullet run becomes one enumeration card', !!list, cards.map(c => c.kind));
  t('all items are in the answer', list && ['Insertion', 'Update', 'Deletion'].every(x => list.a.includes(x)));
  t('it is one card, not three', cards.filter(c => c.kind === 'list').length === 1);
}

// ── The quality gate ──────────────────────────────────────────────────────
console.log('\nquality gate: bad cards are rejected');
{
  t('a lone heading with no body makes nothing',
    C.fromPlainText('# Orphan Heading\n', SRC).length === 0);
  t('boilerplate headings are skipped',
    C.fromPlainText('# Overview\nSome text here about things.\n', SRC)
      .filter(c => /Overview/i.test(c.q)).length === 0);
  t('"Agenda" is skipped too',
    C.fromPlainText('# Agenda\nFirst we cover A then B.\n', SRC)
      .filter(c => /Agenda/i.test(c.q)).length === 0);
  t('a slide-number heading is not a topic',
    C.fromPlainText('## Slide 4\nSome content on this slide.\n', SRC)
      .filter(c => /Slide 4/.test(c.q)).length === 0);
  t('a one-word answer is rejected',
    C.fromPlainText('# X\nY\n', SRC).length === 0);
  t('a paragraph-length heading is rejected',
    C.fromPlainText('# ' + 'word '.repeat(60) + '\nbody text here\n', SRC).length === 0);
  t('an enormous answer is rejected',
    C.fromPlainText('# Topic Name\n' + 'x'.repeat(900) + '\n', SRC).length === 0);
  t('empty input is safe', C.fromPlainText('', SRC).length === 0);
  t('null input is safe', C.fromPlainText(null, SRC).length === 0);
  t('a single bullet is not an enumeration',
    C.fromPlainText('## T\n- only one\n', SRC).filter(c => c.kind === 'list').length === 0);
  t('a cloze is not made when the term IS the sentence',
    C.fromPlainText('# T\n**Everything here is bold and nothing else.**\n', SRC)
      .filter(c => c.kind === 'cloze').length === 0);
}

// ── HTML (page-editor entries, pipeline output) ───────────────────────────
console.log('\nHTML: structure is reliable here');
{
  const html = `
    <h2>Functional Dependencies</h2>
    <p>A functional dependency holds when one attribute determines another.</p>
    <p>The <strong>determinant</strong> is the attribute on the left-hand side.</p>
    <ul><li>Full dependency</li><li>Partial dependency</li><li>Transitive dependency</li></ul>
    <h2>Slide 9</h2>
    <p>This section came from slide nine of the deck.</p>`;

  if (typeof DOMParser === 'undefined') {
    console.log('  --   skipped (no DOMParser in this runtime)');
  } else {
    const cards = C.fromHtml(html, SRC);
    t('extracted from HTML', cards.length >= 2, cards.map(c => [c.kind, c.q]));
    t('heading became a question', cards.some(c => /What is Functional Dependencies\?/.test(c.q)));
    t('<strong> became a cloze', cards.some(c => c.kind === 'cloze' && /determinant/i.test(c.a)));
    t('<ul> became one enumeration', cards.filter(c => c.kind === 'list').length === 1);
    t('slide number captured for jump-back',
      cards.some(c => c.sourceSlide === 9), cards.map(c => c.sourceSlide));
    t('"Slide 9" itself is not a question', !cards.some(c => /What is Slide 9/.test(c.q)));
    t('malformed HTML does not throw', C.fromHtml('<p>unclosed <strong>x', SRC).length >= 0);
    t('empty HTML is safe', C.fromHtml('', SRC).length === 0);
    // A parsed document is inert — nothing in stored content can execute.
    t('script content is not turned into a card',
      !C.fromHtml('<h2>T</h2><script>alert(1)</script><p>body text here</p>', SRC)
        .some(c => /alert/.test(c.a)));
  }
}

console.log('\nfromSelection picks the right parser');
{
  if (typeof DOMParser !== 'undefined') {
    t('HTML fragment routes to the HTML parser',
      C.fromSelection('<h2>Indexing</h2><p>An index speeds up lookups considerably.</p>', SRC).length >= 1);
  }
  t('plain fragment routes to the text parser',
    C.fromSelection('# Indexing\nAn index speeds up lookups considerably.', SRC).length >= 1);
}

// ── Fingerprints and merging ──────────────────────────────────────────────
console.log('\nfingerprints');
{
  const a = C.fingerprint('qa', 'What is X?', 'A thing');
  t('same content, same fingerprint', a === C.fingerprint('qa', 'What is X?', 'A thing'));
  t('whitespace-insensitive', a === C.fingerprint('qa', '  What   is X? ', 'A thing'));
  t('case-insensitive', a === C.fingerprint('qa', 'what is x?', 'a thing'));
  t('different answer, different fingerprint', a !== C.fingerprint('qa', 'What is X?', 'Other'));
  t('different kind, different fingerprint', a !== C.fingerprint('cloze', 'What is X?', 'A thing'));
}

console.log('\nmerge: re-extraction must not destroy review history');
{
  const note = '# Indexing\nAn index speeds up lookups by avoiding a full scan.\n';
  const first = C.fromPlainText(note, SRC);
  t('first extraction produced cards', first.length >= 1);

  // Simulate weeks of review on the existing card.
  const studied = first.map(c => ({ ...c, sched: { stability: 42, reps: 9, due: 123 } }));

  // Re-run on the SAME note.
  const again = C.fromPlainText(note, SRC);
  const m1 = C.mergeCards(studied, again);
  t('no duplicates on re-extraction', m1.merged.length === studied.length, m1.merged.length);
  t('nothing counted as new', m1.added.length === 0);
  t('scheduling state survived', m1.merged.every(c => c.sched && c.sched.reps === 9),
    m1.merged.map(c => c.sched));

  // Now she EDITS the note, adding a section.
  const edited = note + '\n# Clustered Index\nA clustered index determines the physical row order.\n';
  const m2 = C.mergeCards(studied, C.fromPlainText(edited, SRC));
  t('new material is added', m2.added.length >= 1, m2.added.map(c => c.q));
  t('the old card is still there with its schedule',
    m2.merged.some(c => c.sched && c.sched.reps === 9));

  // And she DELETES the original section.
  const gutted = '# Clustered Index\nA clustered index determines the physical row order.\n';
  const m3 = C.mergeCards(studied, C.fromPlainText(gutted, SRC));
  t('orphans are reported', m3.orphaned.length >= 1, m3.orphaned.map(c => c.q));
  t('orphans are NOT silently deleted', m3.merged.some(c => c.sched && c.sched.reps === 9));
}

console.log('\ndedupe');
{
  const dupes = C.fromPlainText('# T\nSome body text here.\n', SRC);
  t('dedupe keeps one of an identical pair',
    C.dedupe([...dupes, ...dupes]).length === dupes.length);
  t('dedupe of nothing is safe', C.dedupe(null).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
