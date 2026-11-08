// Tests for js/modules/diagram.js — v2 lesson diagrams drawn from data.
//   "model text never becomes markup"   every value is escaped.
//   "bad data never breaks a step"      it says "diagram unavailable".
// Run with:  node scripts/test-diagram.mjs
import * as dg from '../StudyOS/js/modules/diagram.js';
import * as v2 from '../StudyOS/js/modules/lesson-v2.js';
import { TREENODE, BST_SEARCH } from './fixtures/lesson-v2.mjs';

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + String(extra).slice(0, 400))); }
};
const ok = (html) => html.includes('<svg') || html.includes('<table');
const tn = v2.validateLessonV2(JSON.parse(JSON.stringify(TREENODE))).value.lesson;
const bst = v2.validateLessonV2(JSON.parse(JSON.stringify(BST_SEARCH))).value.lesson;

console.log('\nevery kind draws');
const samples = {
  tree: tn.runningExample,
  nulls: { ...tn.runningExample, showNulls: true },
  nodebox: tn.steps[1].diagram,
  linkedlist: bst.steps[4].diagram,
  doubly: { id: 'd', kind: 'linkedlist', doubly: true, circular: true, nodes: [{ id: 'a', value: '1' }, { id: 'b', value: '2' }], links: [{ from: 'a', to: 'b', dir: 'next' }, { from: 'b', to: 'a', dir: 'prev' }], pointers: [{ name: 'head', target: 'a' }, { name: 'tail', target: 'b' }] },
  array: { id: 'a', kind: 'array', cells: ['3', null, '9'], capacity: 6, indices: true, pointers: [{ name: 'size', index: 3 }], highlight: ['c2'] },
  stack: { id: 's', kind: 'stack', items: ['a', 'b', 'c'] },
  queue: { id: 'q', kind: 'queue', items: ['a', 'b', 'c'] },
  table: { id: 't', kind: 'table', headers: ['id', 'name'], rows: [['1', 'Ann'], ['2', 'Bo']], highlight: ['r1'] },
  flow: { id: 'f', kind: 'flow', direction: 'TB', boxes: [{ id: 'a', text: 'Start', shape: 'pill' }, { id: 'b', text: 'x < node?', shape: 'diamond' }, { id: 'c', text: 'go left' }, { id: 'd', text: 'go right' }],
    arrows: [{ from: 'a', to: 'b', label: '' }, { from: 'b', to: 'c', label: 'yes' }, { from: 'b', to: 'd', label: 'no' }, { from: 'c', to: 'b', label: 'loop' }] },
  timeline: { id: 'tl', kind: 'timeline', events: [{ id: 'e1', date: '1789', label: 'French Revolution begins' }, { id: 'e2', date: '1815', label: 'Congress of Vienna' }] },
};
for (const [k, d] of Object.entries(samples)) {
  const html = dg.renderDiagram(d);
  t(`${k} renders`, ok(html) && !html.includes('unavailable'), html);
}
t('a highlighted tree node gets the accent class', /dg-node dg-hl" data-dg="n60"/.test(dg.renderDiagram({ ...tn.runningExample, highlight: ['n60'] })));
t('a label is drawn ("root")', dg.renderDiagram(tn.runningExample).includes('>root<'));
t('null children are drawn as ∅', dg.renderDiagram(samples.nulls).includes('∅'));
t('a null link is drawn as ∅', dg.renderDiagram(samples.linkedlist).includes('∅'));
t('an array row highlight', /dg-hl" data-dg="c2"/.test(dg.renderDiagram(samples.array)));
t('a cyclic flow does not hang', ok(dg.renderDiagram(samples.flow)));

console.log('\nwalkthrough frames');
{
  const w = bst.steps[1].diagram;
  const f0 = dg.renderDiagram(w, { frame: 0 }), f2 = dg.renderDiagram(w, { frame: 2 });
  t('frame 1 lights 60', /dg-hl" data-dg="n60"/.test(f0) && !/dg-hl" data-dg="n57"/.test(f0));
  t('frame 3 lights 57 and labels it "found"', /dg-hl" data-dg="n57"/.test(f2) && f2.includes('>found<'));
  const patched = { ...samples.array, frames: [{ note: 'insert', highlight: ['c1'], patch: { cells: ['3', '5', '9'] } }] };
  t('a patch changes the structure', dg.renderDiagram(patched, { frame: 0 }).includes('>5<'));
  t('extra highlight from a code line', /dg-hl" data-dg="left"/.test(dg.renderDiagram(tn.steps[1].diagram, { extraHighlight: ['left'] })));
}

console.log('\nescaping and bad data');
{
  const evil = { id: '"><x', kind: 'tree', root: 'a', nodes: [{ id: 'a', value: '<img src=x onerror=alert(1)>' }], edges: [], caption: '<script>alert(1)</script>',
    labels: [{ target: 'a', text: '"onload="x' }] };
  const html = dg.renderDiagram(evil);
  t('no raw tag from node values or captions', !/<img|<script/.test(html), html);
  t('attribute quotes are escaped', !html.includes('"onload="') && !html.includes('"><x'), html);
  for (const bad of [{ kind: 'tree', nodes: [], edges: [], root: '' }, { kind: 'flow', boxes: [] }, { kind: 'mystery' }, { kind: 'array', cells: [] }]) {
    const h = dg.renderDiagram({ caption: 'Cap', ...bad });
    t(`${bad.kind} with no data → "diagram unavailable" + caption`, h.includes('diagram unavailable') && h.includes('Cap'), h);
  }
  t('null diagram → nothing', dg.renderDiagram(null) === '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
