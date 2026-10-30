#!/usr/bin/env node
/** THMerge.syncMerge — two devices saved the same TaskHub at once. Run: node tests/taskhub-merge.test.js */
'use strict';
const { syncMerge } = require('../taskhub-merge.js');
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FAIL  ') + m); if (!c) fails++; };
const ids = (a) => (a || []).map((x) => x.id).join(',');
const clone = (x) => JSON.parse(JSON.stringify(x));

const base = {
  savedAt: 1, rev: 4, weekKey: '2026-10-12',
  goals: [{ id: 'g1', title: 'Goal one', done: false }, { id: 'g2', title: 'Goal two', done: false }],
  habits: [{ id: 'h1', name: 'Read' }],
  hc: { 'h1|mon': true },
  goalPrefs: { sort: 'manual' },
  data: {
    '2026-10-17': [{ id: 'a', title: 'Old A' }, { id: 'b', title: 'Old B' }],
    '2026-10-18': [{ id: 'c', title: 'Sunday C', done: false }]
  }
};

console.log('\nThe 2026-10-19 reset, replayed');
{
  // The PC added two tasks yesterday and one today (theirs). A device asleep
  // since before that (base) wakes and ticks one task (mine).
  const theirs = clone(base); theirs.rev = 9;
  theirs.data['2026-10-18'].push({ id: 'n1', title: 'Orca visual' }, { id: 'n2', title: 'WarRoom fix' });
  theirs.data['2026-10-19'] = [{ id: 'n3', title: 'Record yunara game' }];
  const mine = clone(base); mine.data['2026-10-17'][0].done = true;
  const r = syncMerge(base, mine, theirs);
  ok(ids(r.data['2026-10-18']) === 'c,n1,n2', 'yesterday’s added tasks survive');
  ok(ids(r.data['2026-10-19']) === 'n3', 'today’s added task survives');
  ok(r.data['2026-10-17'][0].done === true, 'the waking device’s own tick survives');
}

console.log('\nAdditions and deletions on both sides');
{
  const mine = clone(base), theirs = clone(base);
  mine.goals.push({ id: 'g3', title: 'Mine new' });
  theirs.goals.push({ id: 'g4', title: 'Theirs new' });
  mine.goals = mine.goals.filter((g) => g.id !== 'g1');          // deleted here
  theirs.data['2026-10-17'] = theirs.data['2026-10-17'].filter((x) => x.id !== 'b');   // deleted there
  const r = syncMerge(base, mine, theirs);
  ok(ids(r.goals) === 'g2,g3,g4' || ids(r.goals) === 'g2,g4,g3', 'both new goals kept, my deletion applied: ' + ids(r.goals));
  ok(ids(r.data['2026-10-17']) === 'a', 'their deletion applied');
}

console.log('\nEdits');
{
  const mine = clone(base), theirs = clone(base);
  mine.goals[0].done = true;                        // I ticked g1
  theirs.goals[0].title = 'Goal one, renamed';      // they renamed g1
  theirs.goals[1].done = true;                      // they ticked g2
  const r = syncMerge(base, mine, theirs);
  ok(r.goals[0].done === true && r.goals[0].title === 'Goal one, renamed', 'different fields of one item both survive');
  ok(r.goals[1].done === true, 'their edit to another item survives');
}
{
  const mine = clone(base), theirs = clone(base);
  mine.goals[0].title = 'Mine';
  theirs.goals[0].title = 'Theirs';
  ok(syncMerge(base, mine, theirs).goals[0].title === 'Mine', 'same field changed on both: this device wins');
}
{
  const mine = clone(base), theirs = clone(base);
  mine.goals = mine.goals.filter((g) => g.id !== 'g1');
  theirs.goals[0].done = true;
  ok(syncMerge(base, mine, theirs).goals.some((g) => g.id === 'g1'), 'deleted here but edited there: kept');
  const m2 = clone(base), t2 = clone(base);
  t2.goals = t2.goals.filter((g) => g.id !== 'g1');
  m2.goals[0].done = true;
  ok(syncMerge(base, m2, t2).goals.some((g) => g.id === 'g1'), 'deleted there but edited here: kept');
}

console.log('\nMaps, scalars, days');
{
  const mine = clone(base), theirs = clone(base);
  mine.hc['h1|tue'] = true;
  theirs.hc['h1|wed'] = true;
  delete theirs.hc['h1|mon'];
  const r = syncMerge(base, mine, theirs);
  ok(r.hc['h1|tue'] && r.hc['h1|wed'] && !('h1|mon' in r.hc), 'habit checks merge key by key, deletions included');
  const m2 = clone(base), t2 = clone(base); t2.weekKey = '2026-10-19';
  ok(syncMerge(base, m2, t2).weekKey === '2026-10-19', 'a scalar only they changed takes theirs');
  const m3 = clone(base), t3 = clone(base); delete t3.data['2026-10-17'];
  ok(!('2026-10-17' in syncMerge(base, m3, t3).data), 'a day they archived stays out');
  const m4 = clone(base), t4 = clone(base); delete t4.data['2026-10-17']; m4.data['2026-10-17'][1].done = true;
  ok(ids(syncMerge(base, m4, t4).data['2026-10-17']) === 'b', 'an archived day keeps only what I edited since');
  const m5 = clone(base), t5 = clone(base); m5.data['2026-10-20'] = [{ id: 'z', title: 'New day' }];
  ok(ids(syncMerge(base, m5, t5).data['2026-10-20']) === 'z', 'a day I added is kept');
}

console.log('\nNo base (a fresh page edited before the cloud copy arrived)');
{
  const mine = clone(base), theirs = clone(base);
  mine.goals = [{ id: 'g1', title: 'Goal one', done: true }];   // stale local copy, missing g2
  theirs.goals.push({ id: 'g9', title: 'Added elsewhere' });
  delete mine.hc;
  const r = syncMerge(null, mine, theirs);
  ok(ids(r.goals) === 'g1,g2,g9', 'union: nothing is deleted');
  ok(r.goals[0].done === true, 'my edit still wins');
  ok(r.hc && r.hc['h1|mon'], 'an absent field is no news');
}

console.log('\nA fresh device’s sample week (2026-10-29)');
{
  const theirs = clone(base);
  const mine = { goals: [{ id: 'd1', title: 'Review project roadmap', _demo: true }],
    data: { '2026-10-28': [{ id: 'd2', title: 'Morning run', _demo: true }, { id: 'n1', title: 'Orca visual' }] } };
  const r = syncMerge(null, mine, theirs);
  ok(!r.goals.some((g) => g.id === 'd1') && ids(r.goals) === ids(base.goals), 'a demo goal the cloud never had is not added');
  ok(ids(r.data['2026-10-28']) === 'n1', 'a demo task is not added, a real one made beside it is');
  const both = clone(base); both.goals.push({ id: 'd1', title: 'Kept', _demo: true });
  ok(syncMerge(null, clone(both), clone(both)).goals.some((g) => g.id === 'd1'), 'a demo item the cloud already holds stays');
}

console.log('\nBookkeeping');
{
  const mine = clone(base), theirs = clone(base);
  mine._gen = 3; mine.savedAt = 100; theirs.savedAt = 50; theirs.rev = 7;
  const r = syncMerge(base, mine, theirs);
  ok(!('_gen' in r) && !('rev' in r) && !('savedAt' in r), 'internal fields, rev and savedAt are left to the caller');
  ok(JSON.stringify(syncMerge(base, clone(base), clone(base)).goals) === JSON.stringify(base.goals), 'no changes on either side: unchanged');
  const quotes = { m: clone(base), t: clone(base) };
  quotes.m.quotes = ['a', 'b']; quotes.t.quotes = ['a'];
  ok(JSON.stringify(syncMerge(base, quotes.m, quotes.t).quotes) === '["a","b"]', 'id-less lists merge as one value');
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
