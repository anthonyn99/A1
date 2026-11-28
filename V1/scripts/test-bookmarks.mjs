// Tests for js/modules/bookmarks.js — bookmarks on lesson steps and passages.
//
//   "a bookmark survives a rewrite"   steps have no ids, so a bookmark finds
//       its step by heading when steps were inserted or reordered, by page for
//       a figure, and falls back to its index clamped to the lesson.
//   "toggling is idempotent"   a step has at most one whole-step bookmark; the
//       same passage on the same step is never saved twice.
// Run with:  node scripts/test-bookmarks.mjs
import * as bm from '../StudyOS/js/modules/bookmarks.js';
import { insertSteps } from '../StudyOS/js/modules/lesson-v2.js';
import { TREENODE } from './fixtures/lesson-v2.mjs';

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 400))); }
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const steps = clone(TREENODE.steps);

console.log('findStep');
const mark = bm.make(3, steps[3]);
t('snapshot keeps heading and type', mark.heading === steps[3].heading && mark.type === steps[3].type && mark.text === '');
t('exact match stays on its index', bm.findStep(steps, mark) === 3);

const lesson = clone(TREENODE);
insertSteps(lesson, [{ type: 'concept', heading: 'An extra step', body: 'Inserted before the recap.' }]);
const shifted = [{ type: 'concept', heading: 'Inserted first', body: 'x' }, ...lesson.steps];
t('a step that moved is found by heading', bm.findStep(shifted, mark) === 4, bm.findStep(shifted, mark));

const reordered = [...steps].reverse();
t('a reordered rewrite is matched by heading', reordered[bm.findStep(reordered, mark)].heading === steps[3].heading);

const twice = [{ heading: 'Same' }, { heading: 'Other' }, { heading: 'Other' }, { heading: 'Same' }];
t('the nearest same heading wins', bm.findStep(twice, { heading: 'Same', block: 2 }) === 3);

const figs = [{ type: 'hook', heading: 'a' }, { type: 'figure', heading: 'Old', page: 6 }, { type: 'figure', heading: 'b', page: 9 }];
t('a figure is found by page when its heading changed', bm.findStep(figs, { heading: 'Gone', block: 0, page: 9, type: 'figure' }) === 2);
t('nothing matches: index clamped', bm.findStep(steps.slice(0, 3), { heading: 'Gone', block: 10 }) === 2);
t('v1 blocks match by title', bm.findStep([{ kind: 'read', title: 'A' }, { kind: 'example', title: 'B' }], { heading: 'B', block: 0 }) === 1);
t('empty lesson is step 0', bm.findStep([], mark) === 0);

console.log('toggle / add / remove');
let list = bm.toggleStep([], 2, steps[2]);
t('toggle adds a whole-step bookmark', list.length === 1 && bm.stepMark(list, 2));
list = bm.add(list, bm.make(2, steps[2], 'root points at 60'));
list = bm.add(list, bm.make(2, steps[2], '  root  points at 60 '));
t('the same passage is not saved twice', list.length === 2, list);
t('a passage is not a step bookmark', bm.stepMark(list, 2).text === '');
list = bm.toggleStep(list, 2, steps[2]);
t('toggle again removes only the step bookmark', list.length === 1 && list[0].text === 'root points at 60');
list = bm.remove(list, list[0].id);
t('remove by id', list.length === 0);
let many = [];
for (let i = 0; i < bm.MAX_PER_TOPIC + 5; i++) many = bm.add(many, bm.make(i, { heading: 'h' + i }));
t('capped per topic, newest kept', many.length === bm.MAX_PER_TOPIC && many[many.length - 1].block === bm.MAX_PER_TOPIC + 4);
t('no underscore keys (they are stripped on save)', Object.keys(bm.make(0, steps[0], 'x')).every((k) => k[0] !== '_'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
