#!/usr/bin/env node
/**
 * MyList list-ops regression tests (workers/personal-ai/worker.js).
 *
 * WHY THIS FILE EXISTS
 * MyList grew from a shopping list into typed lists (shopping, packing,
 * itinerary, to-do, reminders, other). The model only emits small ops; the
 * worker applies them deterministically in applyListOps(). These tests pin that
 * applier — the part that decides whether a voice command lands on the right
 * item — plus the per-type prompt and the chain's dictation/lossy heuristics,
 * without calling Gemini.
 *
 * Run: node tests/mylist-list-ops.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  ✗ ' + name); }
}
function section(s) { console.log('\n' + s); }

// Load the worker as a plain script: drop the ESM default export and hand the
// list functions back through a sandbox global.
const src = fs.readFileSync(path.join(__dirname, '..', 'workers', 'personal-ai', 'worker.js'), 'utf8')
  .replace(/^export default\s*\{/m, 'const __workerDefault = {');
const ctx = { console, URL, Response: function () {}, fetch: () => Promise.reject(new Error('no network in tests')), setTimeout, clearTimeout, AbortController };
vm.createContext(ctx);
vm.runInContext(src + '\n;globalThis.__T = { applyListOps, buildListPrompt, listInputEntries, isListDictation, salvageListOps, normListType, sanitizeItems, LIST_TYPES, runStaggered, missingNumbers };', ctx);
const W = ctx.__T;

const base = () => [
  { id: 'a', name: 'Red Rocks Park & Amphitheater', qty: '', when: '', store: '', desc: '', done: false },
  { id: 'b', name: 'Union Station', qty: '', when: '', store: '', desc: '', done: false },
  { id: 'c', name: '16th Street Mall', qty: '', when: '', store: '', desc: '', done: false },
  { id: 'd', name: 'Larimer Square', qty: '', when: '', store: '', desc: '', done: false },
];
const names = (r) => r.items.map((i) => i.name).join(' | ');

section('when field');
{
  const r = W.applyListOps([], [], [{ op: 'add', name: 'Dinner at Linger', when: '7:30 PM', store: 'Saturday', desc: 'reservation under Patel' }]);
  t('add keeps when/store/desc', r.items[0].when === '7:30 PM' && r.items[0].store === 'Saturday' && r.items[0].desc === 'reservation under Patel');
  t('a new group becomes a saved group', r.stores.includes('Saturday'));
  const u = W.applyListOps(base(), [], [{ op: 'update', index: 2, match: 'Union Station', set: { when: '1:00 PM' } }]);
  t('update sets when', u.items[1].when === '1:00 PM');
  const k = W.applyListOps([{ name: 'X', when: '9 AM', qty: '', store: '', desc: '', done: false }], [], [{ op: 'update', index: 1, match: 'X', set: { when: '' } }]);
  t('an empty when never wipes the existing one', k.items[0].when === '9 AM');
  const s = W.sanitizeItems([{ name: 'A', when: ' 5 PM ', id: 'z', watchId: 'w' }]);
  t('sanitizeItems passes when through, trimmed', s[0].when === '5 PM' && s[0].id === 'z' && s[0].watchId === undefined);
}

section('time-only details move into when (timed lists only)');
{
  let r = W.applyListOps(base(), [], [{ op: 'update', index: 1, match: 'Red Rocks', set: { store: 'Saturday', desc: 'Morning' } }], 'itinerary');
  t('update: desc "Morning" → when', r.items[0].when === 'Morning' && r.items[0].desc === '' && r.items[0].store === 'Saturday', JSON.stringify(r.items[0]));
  r = W.applyListOps([], [], [{ op: 'add', name: 'Dinner at Linger', desc: '7:30 PM' }], 'itinerary');
  t('add: desc "7:30 PM" → when', r.items[0].when === '7:30 PM' && !r.items[0].desc);
  r = W.applyListOps([], [], [{ op: 'add', name: 'Union Station', desc: 'lunch' }], 'itinerary');
  t('a real detail stays in desc', r.items[0].desc === 'lunch' && !r.items[0].when);
  r = W.applyListOps([], [], [{ op: 'add', name: 'Dinner', when: '7 PM', desc: '8 PM' }], 'itinerary');
  t('an explicit when is never overwritten', r.items[0].when === '7 PM' && r.items[0].desc === '8 PM');
  r = W.applyListOps([], [], [{ op: 'add', name: 'Eggs', desc: 'morning' }], 'shopping');
  t('shopping lists are left alone', r.items[0].desc === 'morning' && !r.items[0].when);
}

section('move (reorder)');
{
  let r = W.applyListOps(base(), [], [{ op: 'move', index: 2, match: 'Union Station', before: 1 }]);
  t('move before item 1', names(r).startsWith('Union Station | Red Rocks'), names(r));
  r = W.applyListOps(base(), [], [{ op: 'move', index: 1, match: 'Red Rocks', pos: 'bottom' }]);
  t('move to bottom', names(r).endsWith('Larimer Square | Red Rocks Park & Amphitheater'), names(r));
  r = W.applyListOps(base(), [], [{ op: 'move', index: 4, match: 'Larimer Square', pos: 'top' }]);
  t('move to top', r.items[0].name === 'Larimer Square', names(r));
  r = W.applyListOps(base(), [], [{ op: 'move', index: 3, match: '16th Street Mall' }]);
  t('move with no destination is a no-op', names(r) === names({ items: base() }));
  // Indexes refer to the list the MODEL saw: after removing item 1, "index 3"
  // must still mean 16th Street Mall, not Larimer Square.
  r = W.applyListOps(base(), [], [{ op: 'remove', index: 1, match: 'Red Rocks' }, { op: 'update', index: 3, match: '', set: { done: true } }]);
  t('indexes resolve against the original numbering', r.items.find((i) => i.name === '16th Street Mall').done === true && !r.items.find((i) => i.name === 'Larimer Square').done, JSON.stringify(r.items));
  const g = [{ name: 'A', store: 'Day 1', qty: '', when: '', desc: '', done: false }, { name: 'B', store: 'Day 2', qty: '', when: '', desc: '', done: false }];
  r = W.applyListOps(g, ['Day 1', 'Day 2'], [{ op: 'move', index: 1, match: 'A', before: 2 }]);
  t('moving before an item in another group joins that group', r.items[0].name === 'A' && r.items[0].store === 'Day 2');
}

section('list type ops');
{
  let r = W.applyListOps(base(), [], [{ op: 'set_type', type: 'itinerary' }]);
  t('set_type returns listType', r.listType === 'itinerary');
  r = W.applyListOps(base(), [], [{ op: 'set_type', type: 'banana' }]);
  t('unknown type is ignored', !r.listType);
  r = W.applyListOps(base(), [], [{ op: 'new_list', name: 'Denver Trip', type: 'packing' }, { op: 'add', name: 'Laptop' }, { op: 'add', name: 'Sunglasses' }]);
  t('new_list carries its type and items', r.newList && r.newList.type === 'packing' && r.newList.items.length === 2 && r.items.length === 4);
  t('normListType defaults to shopping', W.normListType('') === 'shopping' && W.normListType('TODO') === 'todo');
}

section('existing behaviour unchanged');
{
  const shop = [{ name: 'Milk', qty: '1', store: 'Costco', when: '', desc: '', done: false }, { name: 'Eggs', qty: '', store: '', when: '', desc: '', done: false }];
  let r = W.applyListOps(shop, ['Costco'], [{ op: 'update', index: 1, match: 'Milk', set: { store: '__NONE__' } }]);
  t('__NONE__ unassigns the group', r.items[0].store === '');
  r = W.applyListOps(shop, ['Costco'], [{ op: 'add', name: 'Milk', store: 'Walmart' }]);
  t('same item at a different store is kept as a copy', r.items.filter((i) => i.name === 'Milk').length === 2);
  r = W.applyListOps(shop, ['Costco'], [{ op: 'add', name: 'milk', qty: '2' }]);
  t('re-adding merges into the existing item', r.items.length === 2 && r.items[0].qty === '2');
  r = W.applyListOps(shop, ['Costco'], [{ op: 'move_all', from: 'Costco', to: 'Target' }, { op: 'remove_store', name: 'Costco' }]);
  t('move_all + remove_store', r.items[0].store === 'Target' && !r.stores.includes('Costco'));
  r = W.applyListOps(shop, ['Costco'], [{ op: 'check_all' }, { op: 'remove_all', done: true }]);
  t('check_all then remove_all done clears the list', r.items.length === 0);
}

section('prompt is built for the list type');
{
  const p = W.buildListPrompt('hike red rocks saturday morning', base(), [], false, 'itinerary', 'Denver Itinerary', 'Fri, Oct 2, 2026');
  t('itinerary prompt names the DAY group', /group is a DAY/.test(p));
  t('itinerary prompt carries today + list name', p.includes('TODAY: Fri, Oct 2, 2026') && p.includes('LIST NAME: Denver Itinerary'));
  t('items are numbered with their when/group', p.includes('2. Union Station') && p.includes('group: (none)'));
  const s = W.buildListPrompt('milk', [], [], false, undefined, '', '');
  t('no type → shopping prompt', /group is a STORE/.test(s) && s.includes('LIST TYPE: shopping'));
  for (const ty of W.LIST_TYPES) {
    const q = W.buildListPrompt('x', [], [], true, ty, 'L', 'today');
    t('prompt builds for ' + ty + ' (audio)', q.includes('LIST TYPE: ' + ty) && q.includes('attached audio') && !q.includes('USER INPUT'));
  }
}

section('dictation + quality heuristics');
{
  t('pasted list counts its lines', W.listInputEntries('- Laptop\n- Charger\n• Phone\n1. Passport\n[ ] Socks') === 5);
  t('a one-line command is not a list', W.listInputEntries('move the milk to Costco') === 0);
  t('long typed input is dictation', W.isListDictation('word '.repeat(50), '') === true);
  t('short typed input is not', W.isListDictation('add milk and eggs', '') === false);
  t('a long voice clip is dictation', W.isListDictation('', 'x'.repeat(300000)) === true);
  t('a short voice clip is not', W.isListDictation('', 'x'.repeat(50000)) === false);
  const said = 'dinner at Linger at 7:30, Sunday the art museum at 10, budget 2 hours';
  t('dropped times are caught', W.missingNumbers(said, [{ op: 'add', name: 'Dinner at Linger' }, { op: 'add', name: 'Denver Art Museum' }]).join() === '7,30,10,2');
  t('numbers kept anywhere in the ops pass', W.missingNumbers(said, [{ op: 'add', name: 'Dinner at Linger', when: '7:30 PM' }, { op: 'add', name: 'Denver Art Museum', when: '10:00 AM', desc: '~2 hrs' }]).length === 0);
  t('item numbers used as index count', W.missingNumbers('check off number 3', [{ op: 'update', index: 3, match: 'x', set: { done: true } }]).length === 0);
  t('removal-only commands are not checked', W.missingNumbers('remove the 2 eggs', [{ op: 'remove', index: 1, match: 'Eggs' }]).length === 0);
  t('nested set fields count', W.missingNumbers('make it 3 avocados', [{ op: 'update', index: 5, match: 'Avocados', set: { qty: '3' } }]).length === 0);
  const cut = '{"ops":[{"op":"add","name":"Laptop"},{"op":"add","name":"Pho';
  const sv = W.salvageListOps(cut);
  t('truncated ops salvage the complete ones', sv && sv.ops.length === 1 && sv.ops[0].name === 'Laptop' && sv.truncated === true);
}

// runStaggered with a scripted geminiOnce: each model answers after `ms` with a
// given outcome. Times are scaled down so the suite stays fast.
async function race(script, opts) {
  const calls = [];
  ctx.geminiOnce = (model) => {
    calls.push(model);
    const s = script[model] || { ms: 5, cls: 'fatal', err: model + ': no script' };
    return new Promise((r) => setTimeout(() => r(s.cls === 'ok' ? { cls: 'ok', value: s.value } : { cls: s.cls, err: model + ': ' + s.cls }), s.ms));
  };
  const t0 = Date.now();
  try {
    const v = await ctx.runStaggered(Object.keys(script), 'k', Object.assign({ staggerMs: 60, timeoutMs: 2000, deadlineMs: 3000 }, opts || {}));
    return { v, calls, ms: Date.now() - t0 };
  } catch (e) { return { err: e, calls, ms: Date.now() - t0 }; }
}

(async () => {
  section('staggered model race');
  const OK = (n) => ({ ops: new Array(n).fill({ op: 'add', name: 'x' }) });
  let r = await race({ A: { ms: 10, cls: 'ok', value: OK(1) }, B: { ms: 10, cls: 'ok', value: OK(1) } });
  t('a fast lead wins alone — no second call', r.v && r.v.model === 'A' && r.calls.join() === 'A', r.calls.join());
  r = await race({ A: { ms: 400, cls: 'ok', value: OK(1) }, B: { ms: 20, cls: 'ok', value: OK(1) } });
  t('a slow lead gets a racer after the stagger, and the racer wins', r.v && r.v.model === 'B' && r.ms < 300, r.v && r.v.model + ' ' + r.ms + 'ms');
  r = await race({ A: { ms: 5, cls: 'quota' }, B: { ms: 5, cls: 'ok', value: OK(1) } }, { staggerMs: 5000 });
  t('a quota answer starts the next model immediately', r.v && r.v.model === 'B' && r.ms < 200, r.ms + 'ms');
  r = await race({ A: { ms: 5, cls: 'ok', value: OK(1) }, B: { ms: 5, cls: 'ok', value: OK(5) } }, { validate: (v) => v.ops.length >= 4 });
  t('a lossy answer escalates to the next model', r.v && r.v.model === 'B' && !r.v.soft);
  r = await race({ A: { ms: 5, cls: 'ok', value: OK(1) }, B: { ms: 5, cls: 'fatal' } }, { validate: (v) => v.ops.length >= 4 });
  t('…and is still returned (soft) when nothing better comes back', r.v && r.v.model === 'A' && r.v.soft === true);
  r = await race({ A: { ms: 5, cls: 'fatal' }, B: { ms: 5, cls: 'quota' } });
  t('every model failing rejects with what was tried', r.err && r.err.tried.join() === 'A,B', r.err && r.err.message);
  r = await race({ A: { ms: 900, cls: 'ok', value: OK(1) }, B: { ms: 900, cls: 'ok', value: OK(1) }, C: { ms: 900, cls: 'ok', value: OK(1) }, D: { ms: 10, cls: 'ok', value: OK(1) } }, { maxLive: 3 });
  t('never more than maxLive calls in flight', r.v && r.v.model === 'A' && r.calls.length === 3, r.calls.join());

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:\n  ' + failures.join('\n  ')); process.exit(1); }
})();
