// Tests for js/modules/lesson-v2.js — the v2 lesson validator and lint.
//
//   "a model's lesson is untrusted"   ids that point nowhere, a tree that is
//       not a binary tree, an answer that is not an option — all dropped here,
//       never in front of her.
//   "an empty diagram is the running example"   the model may write
//       {kind:"tree", nodes:[]} and StudyOS fills it in.
//   "the rules are linted, not trusted"   word counts, hook first, recap
//       last, no two text-only steps, a check every 3 steps.
// Run with:  node scripts/test-lesson-v2.mjs
import * as v2 from '../StudyOS/js/modules/lesson-v2.js';
import { TREENODE, BST_SEARCH } from './fixtures/lesson-v2.mjs';

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 400))); }
};
const clone = (x) => JSON.parse(JSON.stringify(x));

console.log('\nvalidateLessonV2 — the reference lesson');
{
  const r = v2.validateLessonV2(clone(TREENODE));
  t('it validates', !!r.value, r.error);
  const L = r.value.lesson;
  t('version 2', L.version === 2);
  t('every step kept, in order', L.steps.map((x) => x.type).join() === 'hook,diagram,concept,code,check,trap,check,compare,recap', L.steps.map((x) => x.type));
  const code = L.steps[3].code;
  t('an annotation past the last line is dropped', code.annotations.length === 3, code.annotations);
  t('a highlight id that exists nowhere is dropped', code.annotations[1].highlight.join() === 'left', code.annotations[1]);
  t('a nodebox field name is a valid highlight id', code.annotations[0].highlight[0] === 'element');
  const filled = L.steps[2].diagram;
  t('an empty tree is filled from the running example', filled.nodes.length === 7 && filled.root === 'n60', filled);
  t('...keeping its own id and highlight', filled.id === 'ex-c' && filled.highlight[0] === 'n60');
  t('a check diagram is filled too', L.steps[4].check.diagram.nodes.length === 7);
  t('a short answer stays a string', L.steps[4].check.answer === '57');
  t('mcq answer is stored as the exact option', L.steps[6].check.answer === '67');
  t('compare panels kept', L.steps[7].compare.left.label === 'Linked list Node' && !!L.steps[7].compare.right.code);
  t('the cheat sheet takes the running example as its diagram', L.cheatSheet.diagram && L.cheatSheet.diagram.kind === 'tree');
  t('flashcards come back separately', r.value.flashcards.length === 4);
  t('the reference lesson passes the lint (no re-asks)', !v2.needsFix(v2.lintLessonV2(L)), v2.lintLessonV2(L));
}

console.log('\nvalidateLessonV2 — the walkthrough lesson');
{
  const r = v2.validateLessonV2(clone(BST_SEARCH));
  t('it validates', !!r.value, r.error);
  const L = r.value.lesson;
  const w = L.steps[1];
  t('the walkthrough keeps its 3 frames', w.type === 'walkthrough' && w.diagram.frames.length === 3, w);
  t('...on the running example', w.diagram.nodes.length === 7);
  t('frame highlights point at real nodes', w.diagram.frames.map((f) => f.highlight[0]).join() === 'n60,n55,n57');
  const ord = L.steps[2].check;
  t('an order check keeps its answer order', ord.format === 'order' && ord.answer.join() === '60,100,67', ord);
  const ll = L.steps[4].diagram;
  t('a null link is kept as null', ll.links[2].to === null, ll.links);
  t('fill-blank accepts several answers', Array.isArray(L.steps[5].check.answer) && L.steps[5].check.answer.length === 2);
  t('complexities kept', L.cheatSheet.complexities[0].worst === 'O(n)');
}

console.log('\nbad input never crashes');
{
  for (const junk of [null, 'text', 42, [], { steps: 'no' }, { steps: [null, 1, 'x', { type: 'poem' }] }]) {
    let r, threw = false;
    try { r = v2.validateLessonV2(junk); } catch (e) { threw = e; }
    t(`junk ${JSON.stringify(junk).slice(0, 30)} → error, no throw`, !threw && r && r.error, threw && threw.message);
  }
  const bad = clone(TREENODE);
  bad.steps[2].diagram = { id: 'two', kind: 'tree', root: 'a', nodes: [{ id: 'a', value: '1' }, { id: 'b', value: '2' }, { id: 'c', value: '3' }],
    edges: [{ from: 'a', to: 'b', side: 'left' }, { from: 'a', to: 'c', side: 'left' }] };
  const r = v2.validateLessonV2(bad);
  t('a node with two left children: the diagram is dropped, the step kept', r.value && !r.value.lesson.steps[2].diagram && r.value.lesson.steps[2].body, r.value && r.value.lesson.steps[2]);
  t('two parents → invalid tree', !v2.validTree([{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    [{ from: 'a', to: 'c', side: 'left' }, { from: 'b', to: 'c', side: 'left' }, { from: 'a', to: 'b', side: 'right' }], 'a'));
  t('a cycle → invalid tree', !v2.validTree([{ id: 'a' }, { id: 'b' }], [{ from: 'a', to: 'b', side: 'left' }, { from: 'b', to: 'a', side: 'left' }], 'a'));
  t('a valid tree', v2.validTree(TREENODE.runningExample.nodes, TREENODE.runningExample.edges, 'n60'));
  const noAns = clone(TREENODE);
  noAns.steps[6].check.answer = 'nothing like it';
  const r2 = v2.validateLessonV2(noAns);
  t('an mcq whose answer is not an option: the step is dropped (no body to keep)', r2.value.lesson.steps.length === 8, r2.value.lesson.steps.map((x) => x.type));
  const svg = clone(TREENODE);
  svg.steps[1].diagram = { kind: 'svg', svg: '<svg><script>alert(1)</script></svg>' };
  const r3 = v2.validateLessonV2(svg);
  t('an unknown diagram kind (e.g. raw SVG) is dropped', r3.value && r3.value.lesson.steps.every((x) => !x.diagram || x.diagram.kind !== 'svg'));
  const wire = v2.toWire(v2.validateLessonV2(clone(TREENODE)).value.lesson);
  const back = v2.validateLessonV2({ ...wire, flashcards: TREENODE.flashcards });
  t('the strict wire shape (every field, kind "none") round-trips', back.value && back.value.lesson.steps.length === 9, back.error);
}

console.log('\nlint');
{
  const L = v2.validateLessonV2(clone(TREENODE)).value.lesson;
  const long = clone(L);
  long.steps[5].body = Array.from({ length: 130 }, () => 'word').join(' ');
  t('a body over 120 words is a re-ask', v2.lintLessonV2(long).some((p) => p.step === 6 && p.reask));
  long.steps[5].body = Array.from({ length: 95 }, () => 'word').join(' ');
  const p95 = v2.lintLessonV2(long).find((p) => p.step === 6);
  t('a body of 81-120 words is flagged, not re-asked', p95 && !p95.reask, p95);
  const textRun = clone(L);
  textRun.steps.splice(6, 0, { type: 'concept', heading: 'More words', body: 'Just text.' });
  t('two text-only steps in a row → re-ask naming the step', v2.lintLessonV2(textRun).some((p) => p.reask && /text-only/.test(p.note)), v2.lintLessonV2(textRun));
  const noHook = clone(L);
  noHook.steps.shift();
  t('missing hook → re-ask', v2.lintLessonV2(noHook).some((p) => p.step === 1 && p.reask));
  const noChecks = clone(L);
  noChecks.steps = noChecks.steps.filter((x) => !x.check);
  t('too few checks → re-ask', v2.lintLessonV2(noChecks).some((p) => /check/.test(p.note) && p.reask));
  t('word count ignores fenced code', v2.wordCount('two words\n```\na b c d e f\n```') === 2);
}

console.log('\ncards and the checks against the document');
{
  const { lesson, flashcards } = v2.validateLessonV2(clone(TREENODE)).value;
  const blocks = v2.asBlocks(lesson);
  t('asBlocks gives the checks text to read', blocks.some((b) => /NullPointerException/.test(b.markdown || '')));
  t('asBlocks keeps the recap points', blocks.find((b) => b.kind === 'recap').points.length === 5);
  const items = v2.cardItems(flashcards, ['what three fields does a treenode have']);
  t('a card whose front the topic already has is skipped (normalised)', items.length === 3, items);
  t('cards carry their tag', items[0].tags[0] === 'code');
  const card = v2.cardFromCheck(lesson.steps[4].check);
  t('a wrong check becomes a card', card.front.includes('root.left.right') && card.back === '57');
  const more = v2.insertSteps(lesson, [{ type: 'concept', heading: 'x', body: 'y', diagram: lesson.runningExample }]);
  t('gap steps go before the recap', more.steps[more.steps.length - 2].heading === 'x' && more.steps[more.steps.length - 1].type === 'recap');
}

console.log('\nschema');
{
  const walk = (o, path = '') => {
    if (o && o.type === 'object') {
      if (o.additionalProperties !== false) return path;
      if (JSON.stringify(Object.keys(o.properties).sort()) !== JSON.stringify([...o.required].sort())) return path;
      for (const [k, v] of Object.entries(o.properties)) { const bad = walk(v, path + '.' + k); if (bad) return bad; }
    }
    if (o && o.type === 'array') return walk(o.items, path + '[]');
    return '';
  };
  t('the wire schema is strict-mode safe (every object closed, every field required)', walk(v2.LESSON_V2_SCHEMA) === '', walk(v2.LESSON_V2_SCHEMA));
  const p = v2.lessonV2Prompt({ topic: { id: 't', title: 'Trees', summary: 's', key_points: ['k'] }, all: [{ id: 'p', title: 'Lists' }, { id: 't', title: 'Trees' }], source: 'SRC' });
  t('the prompt names the previous topic for a compare', /prev=Lists/.test(p));
  t('the prompt never asks for SVG', /Never output SVG/.test(p));
  t('the prompt carries the source', p.includes('SRC'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
