// node tests/backup-merge.test.js — the three-way TaskHub restore merge.
'use strict';
const M = require('../backup-merge.js');
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FAIL  ') + m); if (!c) fails++; };
const titles = (a) => (a || []).map((x) => x.title);

const base = { goals: [{ id: 'g1', title: 'Old goal', done: false }],
  data: { '2026-10-01': [{ id: 'a', title: 'Archived day task' }],
          '2026-10-02': [{ id: 't1', title: 'Cook', done: false }, { id: 't2', title: 'Check out sofi banking' },
                         { id: 't3', title: 'Laundry', done: false }] },
  hc: { x: 1 }, savedAt: 1 };
const good = { goals: [{ id: 'g1', title: 'Old goal', done: true }, { id: 'g2', title: 'HYSA research' }],
  data: { '2026-10-01': [{ id: 'a', title: 'Archived day task' }],
          '2026-10-02': [{ id: 't1', title: 'Cook', done: true }, { id: 't3', title: 'Laundry', done: false },
                         { id: 't4', title: 'Bring cold medicine on car ride', done: false }] },
  hc: { x: 2 }, savedAt: 2 };
const live = { goals: [{ id: 'g1', title: 'Old goal', done: false }, { id: 'g9', title: 'Fix the reset' }],
  data: { '2026-10-02': [{ id: 't1', title: 'Cook', done: false }, { id: 't2', title: 'Check out sofi banking' },
                         { id: 't3', title: 'Laundry', done: true }, { id: 't5', title: 'Medicine car ride', done: true }] },
  hc: { x: 1 }, savedAt: 3 };

const { doc, report } = M.mergeDoc(base, good, live);
const day = doc.data['2026-10-02'];
ok(doc.goals.find((g) => g.id === 'g1').done === true, 'a check-off made last night comes back');
ok(titles(doc.goals).includes('HYSA research'), 'an item added last night comes back');
ok(titles(doc.goals).includes('Fix the reset'), 'an item added after the reset is kept');
ok(day.find((t) => t.id === 't1').done === true, 'day task check-off restored');
ok(!titles(day).includes('Check out sofi banking'), 'an item deleted last night stays deleted');
ok(day.find((t) => t.id === 't3').done === true, 'a check-off made after the reset is kept');
ok(titles(day).includes('Bring cold medicine on car ride') && !titles(day).includes('Medicine car ride'),
   're-typed copy replaced by the original');
ok(day.find((t) => t.id === 't4').done === true, 'the copy’s check-off carries to the original');
ok(!('2026-10-01' in doc.data), 'a day archived since the backup is not re-added');
ok(doc.hc.x === 2, 'plain fields changed only in the backup are restored');
ok(doc.savedAt === 3, 'savedAt is left for the writer to stamp');
ok(report.some((r) => r.op === 'dropped-copy'), 'report names the dropped copy');
ok(!M.looksRetyped({ title: 'Cook' }, { title: 'Dishes' }), 'unrelated titles are not treated as copies');

const pb = M.pickBase([good, base], live);
ok(pb.base === base, 'pickBase finds the state live was reset to');

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
