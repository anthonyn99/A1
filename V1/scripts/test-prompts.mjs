// Tests for js/modules/prompts.js — the prompt library (spec P-6).
//
// Two behaviours here are the reason the file exists:
//
//   "an unknown variable is left verbatim"
//       Replacing {{exam_date}} with '' produces "the exam on  covering ",
//       which reads as a model failure. Leaving the token visible names the
//       missing data instead. This is the difference between a prompt that
//       looks broken and one that says what it needs.
//
//   "class prompts are readable without migrating them"
//       The spec is explicit that her existing prompt is already well-tuned
//       and must be used verbatim. A migration that relocated it could lose
//       it, so the library reads the per-module arrays in place instead.
//
// Run with:  npm run test:prompts
let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};

// ── Stubs: localStorage + the store's bridge ──────────────────────────────
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const classes = [{
  id: 'c1', name: 'Intro to Database Systems', code: 'CS 4400', instructor: 'Prof. Lee',
  modules: [
    { id: 'm1', name: 'PROMPTS', type: 'prompts', prompts: [
      { id: 'old1', text: 'Rewrite {{class}} slides for {{instructor}}.' },
    ], files: [], notes: [] },
    { id: 'm2', name: 'Docs', type: 'documents', prompts: [], files: [], notes: [] },
  ],
}];

globalThis.window = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  _sosBridge: {
    getClasses: () => classes,
    getEvents: () => [], getTasks: () => [], getNotes: () => [],
    getKsu: () => ({ modules: [] }), getModules: () => [],
    getSnapshot: () => null, subscribe: () => () => {},
  },
};
globalThis.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = (i || {}).detail; } };

const P = await import(new URL('../js/modules/prompts.js', import.meta.url).href);

console.log('\nlibrary: add / update / remove');
{
  const p = P.add({ name: 'Slide rewrite', text: 'Rewrite every slide.' });
  t('adds a prompt', !!p.id && p.version === 1);
  t('appears in the library', P.library().length === 1);

  const v2 = P.update(p.id, { text: 'Rewrite every slide, in order.' });
  t('editing bumps the version', v2.version === 2);
  t('keeps the old text as a version', v2.versions.length === 1 && v2.versions[0].version === 1);
  t('old text is recoverable', v2.versions[0].text === 'Rewrite every slide.');

  // A rename is not a new version — only the text defines a version.
  const v3 = P.update(p.id, { name: 'Renamed' });
  t('rename does not bump the version', v3.version === 2);
  t('rename applied', v3.name === 'Renamed');

  t('remove works', P.remove(p.id) === true);
  t('removing twice is false', P.remove(p.id) === false);
  t('library is empty again', P.library().length === 0);
}

console.log('\nall(): class prompts stay where they are');
{
  const all = P.all();
  t('finds the prompt living in a class module', all.some(p => p.id === 'old1'));
  const fromClass = all.find(p => p.id === 'old1');
  t('tagged as coming from a class', fromClass.source === 'class');
  t('remembers which class', fromClass._from.classId === 'c1');
  t('named from its first line', /Rewrite \{\{class\}\}/.test(fromClass.name));
  t('the class module was NOT modified', classes[0].modules[0].prompts.length === 1);

  // The same text pasted into two classes must appear once, not twice.
  classes.push({
    id: 'c2', name: 'Art', modules: [
      { id: 'm3', name: 'PROMPTS', type: 'prompts',
        prompts: [{ id: 'dup', text: 'Rewrite {{class}} slides for {{instructor}}.' }],
        files: [], notes: [] },
    ],
  });
  t('duplicate text is de-duplicated', P.all().filter(p => /Rewrite \{\{class\}\}/.test(p.text)).length === 1);
  classes.pop();
}

console.log('\ninterpolation');
{
  const cls = classes[0];
  const out = P.interpolate('Rewrite {{class}} ({{course_code}}) for {{instructor}}.', { cls });
  t('fills class', out.includes('Intro to Database Systems'));
  t('fills course code', out.includes('CS 4400'));
  t('fills instructor', out.includes('Prof. Lee'));

  // The important one: a variable with no value must stay visible.
  const missing = P.interpolate('Ready for the exam on {{exam_date}}?', { cls });
  t('unknown variable is left verbatim', missing.includes('{{exam_date}}'));
  t('and is NOT blanked out', !/exam on \s*\?/.test(missing));

  const withEvent = P.interpolate('Exam {{exam_date}}', { cls, event: { date: '2026-10-02' } });
  t('fills exam_date when an event is given', withEvent === 'Exam 2026-10-02');

  t('tolerates whitespace in the token', P.interpolate('{{ class }}', { cls }) === 'Intro to Database Systems');
  t('is case-insensitive', P.interpolate('{{CLASS}}', { cls }) === 'Intro to Database Systems');
  t('leaves unrelated braces alone', P.interpolate('a {b} c', { cls }) === 'a {b} c');
  t('empty text is safe', P.interpolate(null, { cls }) === '');
}

console.log('\nvariablesIn');
{
  t('lists each variable once', P.variablesIn('{{class}} {{class}} {{topic}}').sort().join(',') === 'class,topic');
  t('none is an empty list', P.variablesIn('no vars here').length === 0);
}

console.log('\nforClass');
{
  const p = P.add({ name: 'Pinned', text: 'pinned text', classIds: ['c1'] });
  const forC1 = P.forClass('c1');
  const forC2 = P.forClass('nope');
  t('a pinned prompt is offered to its class', forC1.some(x => x.id === p.id));
  t('and not to another class', !forC2.some(x => x.id === p.id));
  P.remove(p.id);

  const g = P.add({ name: 'Global', text: 'global text' });
  t('an unpinned prompt is offered everywhere', P.forClass('anything').some(x => x.id === g.id));
  P.remove(g.id);
}

console.log('\nrobustness');
{
  mem.set('studyos_prompts_v1', '{ not json');
  t('a corrupt library does not throw', Array.isArray(P.library()) && P.library().length === 0);
  mem.delete('studyos_prompts_v1');
  let threw = false;
  try { P.add({ text: '   ' }); } catch (e) { threw = true; }
  t('refuses an empty prompt', threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
