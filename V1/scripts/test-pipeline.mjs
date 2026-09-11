// Tests for js/modules/pipeline.js and the addGeneratedNote bridge (spec P-3/P-5).
//
// Three behaviours here are the reason the file exists:
//
//   "regenerating replaces rather than stacks"
//       "Regenerate with a different prompt" is a listed feature, so this path
//       runs repeatedly for one deck. Without the replace, a class accumulates
//       near-identical notes and the newest is indistinguishable from the rest.
//
//   "the App Check token is attached"
//       Every /api/ai/* route is gated. If the client silently stops sending
//       the header, every pipeline call 401s and the failure looks like a
//       server problem rather than a client one.
//
//   "watchJob backs off and can be cancelled"
//       A deck takes minutes. A fixed fast poll would hammer the Worker while
//       nobody is looking, and a watch that outlives its panel leaks a timer.
//
// Run with:  npm run test:pipeline
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};

globalThis.window = {
  STUDYOS_CONFIG: { cloudflare: { ai: { enabled: true, baseUrl: 'https://ai.test' } } },
  _fbAppCheckToken: async () => 'tok-123',
};

const pipeline = await import(new URL('../js/modules/pipeline.js', import.meta.url).href);

// ── Request plumbing ──────────────────────────────────────────────────────
console.log('\npipeline: request plumbing');
let lastReq = null;
globalThis.fetch = async (url, init) => {
  lastReq = { url: String(url), init };
  return new Response(JSON.stringify({ ok: true, job: { id: 'j1', status: 'queued' } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
};

t('enabled() reflects config', pipeline.enabled() === true);

const { job, cached } = await pipeline.runPrompt({
  file: { id: 'f1', name: 'Lecture 3.pdf' },
  prompt: 'rewrite it', classId: 'c1', outputModuleId: 'm1',
});
t('posts to /api/ai/jobs', lastReq.url === 'https://ai.test/api/ai/jobs');
t('sends the App Check token', lastReq.init.headers['X-Firebase-AppCheck'] === 'tok-123');
t('returns the job', job.id === 'j1');
t('cached defaults false', cached === false);

const sent = JSON.parse(lastReq.init.body);
t('carries fileId', sent.fileId === 'f1');
t('carries the prompt text', sent.prompt === 'rewrite it');
t('omits slideCount when unknown', !('slideCount' in sent));

// A missing token must not throw here — the Worker answers 401 and that is the
// single failure path.
window._fbAppCheckToken = async () => null;
await pipeline.runPrompt({ file: { id: 'f2' }, prompt: 'p' });
t('no token still sends the request', !('X-Firebase-AppCheck' in lastReq.init.headers));
window._fbAppCheckToken = async () => 'tok-123';

// ── Errors ────────────────────────────────────────────────────────────────
console.log('\npipeline: errors');
globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'monthly_cap', spend: 20, cap: 20 }),
  { status: 402, headers: { 'Content-Type': 'application/json' } });
let caught = null;
try { await pipeline.runPrompt({ file: { id: 'f' }, prompt: 'p' }); } catch (e) { caught = e; }
t('a capped request rejects', !!caught);
t('surfaces the server reason', caught.message === 'monthly_cap');
t('keeps the status code', caught.status === 402);

// A batch reports per file rather than aborting on the first failure.
globalThis.fetch = async (url, init) => {
  const b = JSON.parse(init.body);
  if (b.fileId === 'bad') return new Response(JSON.stringify({ ok: false, error: 'nope' }), { status: 400 });
  return new Response(JSON.stringify({ ok: true, job: { id: 'j-' + b.fileId, status: 'queued' } }), { status: 200 });
};
const batch = await pipeline.runBatch(
  [{ id: 'a' }, { id: 'bad' }, { id: 'c' }], { prompt: 'p' });
t('batch runs every file', batch.length === 3);
t('one failure does not abort the rest', batch[0].ok && !batch[1].ok && batch[2].ok);
t('the failure names itself', batch[1].error === 'nope');

// ── watchJob ──────────────────────────────────────────────────────────────
console.log('\npipeline: watchJob');
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ ok: true, job: { id: 'j', status: calls >= 3 ? 'done' : 'running', progress: calls * 30 } }),
      { status: 200 });
  };
  const seen = [];
  await new Promise((res) => {
    pipeline.watchJob('j', (j) => { seen.push(j.status); if (j.status === 'done') res(); });
  });
  t('polls until done', seen[seen.length - 1] === 'done');
  t('reported progress along the way', seen.length >= 2);
}
{
  // Cancelling must stop the polling, or a closed panel leaks a timer forever.
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ ok: true, job: { id: 'j', status: 'running' } }), { status: 200 });
  };
  const cancel = pipeline.watchJob('j', () => {});
  await new Promise(r => setTimeout(r, 50));
  cancel();
  const after = calls;
  await new Promise(r => setTimeout(r, 150));
  t('cancel stops the polling', calls === after);
}

// ── addGeneratedNote (the bridge half) ────────────────────────────────────
console.log('\nbridge: addGeneratedNote');
{
  // Lift the real implementation out of studyos.js so the test covers the
  // shipped code rather than a paraphrase of it.
  const src = readFileSync(resolve(root, 'js/studyos.js'), 'utf8');
  const m = src.match(/window\._sosBridge\.addGeneratedNote = \(spec\) => \{[\s\S]*?\n\};/);
  if (!m) { fail++; console.log('  FAIL could not locate addGeneratedNote'); }
  else {
    const classes = [{ id: 'c1', name: 'DB', modules: [] }];
    let persisted = 0;
    const ctx = {
      classes,
      findClassOrKsu: (id) => classes.find(c => c.id === id),
      persistForCls: () => { persisted++; },
      renderModules: () => {}, refreshModuleNoteList: () => {},
      currentClassId: null, ICONS: { notes: '📝' },
      window: { _sosBridge: {} },
    };
    const fn = new Function(
      'classes', 'findClassOrKsu', 'persistForCls', 'renderModules',
      'refreshModuleNoteList', 'currentClassId', 'ICONS', 'window',
      m[0] + '; return window._sosBridge.addGeneratedNote;'
    )(ctx.classes, ctx.findClassOrKsu, ctx.persistForCls, ctx.renderModules,
      ctx.refreshModuleNoteList, ctx.currentClassId, ctx.ICONS, ctx.window);

    const n1 = fn({
      classId: 'c1', title: 'Rewritten — Lecture 3.pdf', body: '## Slide 1',
      meta: { sourceFileId: 'f1', promptId: 'p1', promptVersion: 2, model: 'claude-opus-5' },
    });
    t('creates the note', !!n1 && n1.title.includes('Lecture 3'));
    t('creates a Generated module on demand', classes[0].modules.length === 1
      && classes[0].modules[0].name === 'Generated' && classes[0].modules[0].type === 'notes');
    t('records provenance', n1._sos.promptVersion === 2 && n1._sos.model === 'claude-opus-5');
    t('persisted', persisted === 1);

    // Regenerating the SAME source must replace, not stack.
    const n2 = fn({
      classId: 'c1', title: 'Rewritten — Lecture 3.pdf', body: '## Slide 1 (v2)',
      meta: { sourceFileId: 'f1', promptId: 'p9', promptVersion: 1 },
    });
    t('regenerate replaces rather than stacks', classes[0].modules[0].notes.length === 1);
    t('keeps the note id stable across regenerate', n2.id === n1.id);
    t('body updated', classes[0].modules[0].notes[0].body === '## Slide 1 (v2)');

    // A DIFFERENT source is a different note.
    fn({ classId: 'c1', title: 'Lecture 4', body: 'x', meta: { sourceFileId: 'f2' } });
    t('a different source adds a note', classes[0].modules[0].notes.length === 2);

    t('unknown class is a no-op', fn({ classId: 'nope', body: 'x' }) === null);
    t('missing spec is a no-op', fn(null) === null);

    // A DOCUMENTS module must never receive the note. Every module carries a
    // `notes` array regardless of type, so this write succeeds silently and
    // then renders nowhere — the note is stored, invisible and unreachable.
    // P-4's auto-run passes the module the FILE landed in, which is a
    // documents module by definition, so without the type guard every
    // auto-run result vanishes. Caught in a real browser, not by a stub.
    const classes2 = [{
      id: 'c2', name: 'Auto', modules: [
        { id: 'docs', name: 'Source Material', type: 'documents', files: [], prompts: [], notes: [] },
      ],
    }];
    const fn2 = new Function(
      'classes', 'findClassOrKsu', 'persistForCls', 'renderModules',
      'refreshModuleNoteList', 'currentClassId', 'ICONS', 'window',
      m[0] + '; return window._sosBridge.addGeneratedNote;'
    )(classes2, (id) => classes2.find(c => c.id === id), () => {}, () => {}, () => {},
      null, { notes: '📝' }, { _sosBridge: {} });

    fn2({ classId: 'c2', moduleId: 'docs', title: 'T', body: 'B', meta: { sourceFileId: 'f9' } });
    const docsMod = classes2[0].modules.find(x => x.id === 'docs');
    const genMod = classes2[0].modules.find(x => x.name === 'Generated');
    t('a documents module never receives the note', docsMod.notes.length === 0, docsMod.notes);
    t('it goes to a Generated notes module instead', !!genMod && genMod.notes.length === 1);
    t('and that module is type notes', genMod && genMod.type === 'notes');

    // An explicit NOTES module is still honoured.
    const classes3 = [{
      id: 'c3', name: 'N', modules: [
        { id: 'mynotes', name: 'My Notes', type: 'notes', files: [], prompts: [], notes: [] },
      ],
    }];
    const fn3 = new Function(
      'classes', 'findClassOrKsu', 'persistForCls', 'renderModules',
      'refreshModuleNoteList', 'currentClassId', 'ICONS', 'window',
      m[0] + '; return window._sosBridge.addGeneratedNote;'
    )(classes3, (id) => classes3.find(c => c.id === id), () => {}, () => {}, () => {},
      null, { notes: '📝' }, { _sosBridge: {} });
    fn3({ classId: 'c3', moduleId: 'mynotes', title: 'T', body: 'B', meta: { sourceFileId: 'f1' } });
    t('an explicit notes module IS honoured',
      classes3[0].modules.find(x => x.id === 'mynotes').notes.length === 1);
    t('no extra Generated module was created', classes3[0].modules.length === 1);
  }
}

// ── The key must never be in a client file ────────────────────────────────
console.log('\nsecurity');
{
  const files = ['js/modules/pipeline.js', 'config/config.js', 'js/studyos.js'];
  let leaked = [];
  // Strip comments first. Both files legitimately DISCUSS the key and the
  // endpoint in prose explaining why neither may appear in client code — a scan
  // that cannot tell a comment from a call flags exactly the files whose
  // documentation is doing its job, and a check that cries wolf gets muted.
  const decomment = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  for (const f of files) {
    const code = decomment(readFileSync(resolve(root, f), 'utf8'));
    // A real key literal, not the env-var NAME.
    if (/sk-ant-[A-Za-z0-9_-]{10,}/.test(code)) leaked.push(f + ' (key literal)');
    if (/api\.anthropic\.com/.test(code)) leaked.push(f + ' (calls Anthropic directly)');
  }
  t('no Anthropic key or direct call in any client file', leaked.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
