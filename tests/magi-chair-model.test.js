// The chairman's model on screen (2026-10-01): the verdict header, a
// Brainstorm round's "merged by", and the finished plan carry the same model
// chip a unit card does. Runs planChairOf and roundsFromTurns for real;
// checks the headers statically.
//
// Run: node tests/magi-chair-model.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const MAGI = fs.readFileSync(process.env.MAGI_HTML || path.join(__dirname, '..', 'magi.html'), 'utf8')
  .replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};
function lift(name) {
  const at = MAGI.search(new RegExp('(^|\\n)(async )?function ' + name + '\\('));
  if (at < 0) throw new Error('not found: ' + name);
  let i = MAGI.indexOf('{', MAGI.indexOf(')', at)), depth = 0;
  for (let j = i; j < MAGI.length; j++) {
    if (MAGI[j] === '{') depth++;
    else if (MAGI[j] === '}' && --depth === 0) return MAGI.slice(at, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}

const F = new Function([
  'const normaliseQuestion = (q) => q;',
  lift('planChairOf'), lift('roundsFromTurns'),
  'return { planChairOf, roundsFromTurns };'].join('\n'))();

console.log('\nBrainstorm: the model comes off the chairman turn');
const turns = [
  { role: 'council', round_no: 1, provider_id: 'claude', content: 'x', model: 'Sonnet 5.5' },
  { role: 'chairman', round_no: 1, provider_id: 'gemini', parsed_json: { plan_so_far: 'P' },
    content: 'raw', model: 'Gemini Pro', model_fallback: '' },
  { role: 'chairman', round_no: 2, phase: 'finalize', provider_id: 'gemini',
    parsed_json: { kind: 'plan', body: 'B' }, model: 'Gemini Flash', model_fallback: 'Asked for Pro, got Flash' },
];
const rounds = F.roundsFromTurns(turns);
const r1 = rounds.find((r) => r.round_no === 1);
ok('a round carries its merge\'s model', r1 && r1.chairman_model === 'Gemini Pro', JSON.stringify(r1));
ok('the plan turn is not a round', !rounds.some((r) => r.plan_so_far === 'B'));
const pc = F.planChairOf(turns);
ok('the plan\'s writer and model', pc && pc.chairman === 'gemini' && pc.model === 'Gemini Flash'
   && pc.model_fallback === 'Asked for Pro, got Flash');
ok('no plan yet -> null', F.planChairOf(turns.slice(0, 2)) === null);
ok('a session from before this -> model ""', F.planChairOf([{ role: 'chairman', parsed_json: { kind: 'plan' } }]).model === '');

console.log('\nThe headers draw it');
const rv = lift('renderVerdict');
ok('the verdict header adds the chairman\'s chip (not on a sole unit)',
   /if \(!solo && v\.chairman_model\) \{\s*const chip = modelChip\(v\.chairman_model, v\.chairman_model_fallback\)/.test(rv));
ok('History reads it back from the stored synthesis',
   /chairman_model: syn\.model \|\| "", chairman_model_fallback: syn\.model_fallback \|\| ""/.test(MAGI));
ok('"merged by" carries the round\'s chip',
   /if \(latest\.chairman_model\) \{\s*const chip = modelChip\(latest\.chairman_model, latest\.chairman_model_fallback\)/.test(MAGI));
ok('the finished plan says who wrote it, with the chip',
   /written by \$\{/.test(MAGI) && /by\.append\(modelChip\(pc\.model, pc\.model_fallback\)\)/.test(MAGI));
ok('both loaders keep planChair', (MAGI.match(/planChairOf\(data\.turns\)/g) || []).length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
