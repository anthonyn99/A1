// Tests for js/modules/drills/db/fd.js — FDs, keys, normal forms, decomposition.
//
// These functions GRADE her answers, so a wrong one marks correct work wrong.
// Every case below is a textbook example whose answer is known independently.
//
// Run with:  npm run test:fd
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 400))); }
};
const F = await import(new URL('../js/modules/drills/db/fd.js', import.meta.url).href);
const P = F.parseFDs, A = F.parseAttrs;
const keysStr = (ks) => ks.map(F.fmt).sort().join(' ');

console.log('\nparsing');
t('single letters run together', F.eq(A('ABC'), ['A', 'B', 'C']));
t('names split on commas/spaces', F.eq(A('SKU, Buyer'), ['Buyer', 'SKU']));
t('arrows in both spellings', P('A->B; BC → D').length === 2);
t('junk lines are ignored', P('A->B\nnonsense\n').length === 1);

console.log('\nclosure');
const f1 = P('A->B; B->C; CD->E');
t('A+ = ABC', F.fmt(F.closure(['A'], f1)) === 'ABC');
t('AD+ = ABCDE', F.fmt(F.closure(['A', 'D'], f1)) === 'ABCDE');
t('E+ = E', F.fmt(F.closure(['E'], f1)) === 'E');

console.log('\ncandidate keys');
t('R(ABCDE), A→B, B→C, CD→E: key AD', keysStr(F.candidateKeys(A('ABCDE'), f1)) === 'AD');
t('R(ABC), AB→C, C→B: keys AB and AC', keysStr(F.candidateKeys(A('ABC'), P('AB->C; C->B'))) === 'AB AC');
t('R(ABCD), A→B, B→C, C→D, D→A: every single attribute', keysStr(F.candidateKeys(A('ABCD'), P('A->B;B->C;C->D;D->A'))) === 'A B C D');
t('no FDs: the whole relation', keysStr(F.candidateKeys(A('ABC'), [])) === 'ABC');
t('keys are minimal (no superset of another key)', (() => {
  const ks = F.candidateKeys(A('ABCDE'), P('AB->C; C->D; D->A; E->B'));
  return ks.every((k, i) => !ks.some((o, j) => j !== i && F.subset(o, k)));
})());

console.log('\nnormal forms');
{
  const n1 = F.normalForm(A('ABCD'), P('AB->C; A->D'));
  t('partial dependency -> 1NF', n1.nf === '1NF', n1);
  t('...and names it', /part of the key/.test(n1.violations[0].why), n1.violations);
  const n2 = F.normalForm(A('ABC'), P('A->B; B->C'));
  t('transitive dependency -> 2NF', n2.nf === '2NF', n2);
  t('...and names it', /transitive/.test(n2.violations[0].why), n2.violations);
  const n3 = F.normalForm(A('ABC'), P('AB->C; C->B'));
  t('determinant that is not a key, prime RHS -> 3NF', n3.nf === '3NF', n3);
  t('key-only dependencies -> BCNF', F.normalForm(A('ABC'), P('A->B; A->C')).nf === 'BCNF');
  // Cape Codd: in SKU_DATA, Buyer determines Department.
  const sku = ['SKU', 'SKU_Description', 'Department', 'Buyer'];
  const skuFDs = P('SKU -> SKU_Description, Department, Buyer; Buyer -> Department');
  const n4 = F.normalForm(sku, skuFDs);
  t('SKU_DATA with Buyer → Department is in 2NF (transitive)', n4.nf === '2NF' && F.fmt(n4.keys[0]) === 'SKU', n4);
}

console.log('\nminimal cover');
{
  const mc = F.minimalCover(P('A->BC; B->C; AB->C'));
  const s = mc.map(F.fmtFD).sort().join(' | ');
  t('A→BC, B→C, AB→C  ⇒  A→B, B→C', s === 'A → B | B → C', s);
}

console.log('\ndecomposition');
{
  const R = A('ABC');
  t('AB + BC is lossless for A→B, B→C', F.isLossless(R, [A('AB'), A('BC')], P('A->B; B->C')));
  t('AB + BC is LOSSY for A→B alone', !F.isLossless(R, [A('AB'), A('BC')], P('A->B')));
  const d = F.bcnfDecompose(A('ABC'), P('AB->C; C->B'));
  t('BCNF of R(ABC), AB→C, C→B is {BC, AC}', d.map(F.fmt).sort().join(' ') === 'AC BC', d);
  t('...which is lossless', F.isLossless(R, d, P('AB->C; C->B')));
  t('...but loses AB→C (the classic trade-off)', !F.preservesDependencies(d, P('AB->C; C->B')).ok);

  const good = F.checkDecomposition(A('ABC'), P('A->B; B->C'), [A('AB'), A('BC')]);
  t('a correct BCNF split passes', good.ok && good.preserves, good);
  const lossy = F.checkDecomposition(A('ABC'), P('A->B; B->C'), [A('AB'), A('AC')]);
  t('a lossless-but-not-BCNF-free split still passes when every part is BCNF', lossy.ok, lossy);
  const bad = F.checkDecomposition(A('ABCD'), P('A->B; B->C'), [A('AB'), A('CD')]);
  t('a lossy split is rejected and explained', !bad.ok && bad.problems.some((p) => /lossy/.test(p)), bad);
  const notBcnf = F.checkDecomposition(A('ABCD'), P('A->B; B->C; A->D'), [A('ABC'), A('AD')]);
  t('a part still violating BCNF is named', !notBcnf.ok && notBcnf.problems.some((p) => /ABC is only in 2NF/.test(p)), notBcnf);
  const missing = F.checkDecomposition(A('ABC'), P('A->B'), [A('AB')]);
  t('a missing attribute is named', missing.problems.some((p) => /C is in no relation/.test(p)), missing);

  // Every generated BCNF decomposition must pass its own check.
  let allGood = true, bad1 = null;
  for (let seed = 1; seed <= 60; seed++) {
    const q = F.randomRelation(seed);
    const parts = F.bcnfDecompose(q.R, q.fds);
    const c = F.checkDecomposition(q.R, q.fds, parts);
    if (!c.ok) { allGood = false; bad1 = { q, parts, c }; break; }
  }
  t('60 random relations: bcnfDecompose always passes checkDecomposition', allGood, bad1);
}

console.log('\ngeneration');
{
  const q1 = F.randomRelation(42), q2 = F.randomRelation(42);
  t('the same seed gives the same question', JSON.stringify(q1) === JSON.stringify(q2));
  let nonBcnf = 0;
  for (let s = 1; s <= 30; s++) if (F.normalForm(F.randomRelation(s).R, F.randomRelation(s).fds).nf !== 'BCNF') nonBcnf++;
  t('default questions are never already BCNF', nonBcnf === 30, nonBcnf);
  const want = F.randomRelation(7, { wantNF: '2NF' });
  t('a requested normal form is honoured', F.normalForm(want.R, want.fds).nf === '2NF', want);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
