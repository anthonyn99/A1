#!/usr/bin/env node
/**
 * Neo inside Veda's programs, phase 1 (TaskHub/neo-connectors.js):
 * V's Notebook, Plans, Shruti and MAGI (T). Also Notebook's read API
 * (Notebook.pages / Notebook.page) that the Notebook connector stands on.
 *
 * Each connector runs against fakes of what it calls (Notebook's API,
 * PlansCore, the _fbNeo* Firestore helpers, A1Debrief), and the tests pin
 * what it reads, what it writes and in what shape, and what Neo says:
 *   · a locked program is neither read nor acted in until it is unlocked
 *   · a page with its own lock is never read out or changed
 *   · Shruti is only ever patched by field path, never written whole
 *   · asking MAGI asks first, and hands MAGI the question as Veda
 *   · nothing works on Tony's side
 *
 * Run: node tests/neo-connectors.test.js
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
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
  // ── Notebook's read API (Notebook/notebook.js) ───────────────────────────
  section('Notebook.pages / Notebook.page');
  {
    const src = read('Notebook/notebook.js');
    t('Notebook exposes pages() and page()', /\n  pages: function \(key\)/.test(src) && /\n  page: function \(key, id\)/.test(src));
    for (const [f, k] of [['Notebook/apps/brainstorm.js', 'bj'], ['Notebook/apps/myjournal.js', 'tj']]) {
      const a = read(f);
      t(`${k}: _${k}Pages / _${k}GetPage exist, read the personal journal and hold back a locked page`,
        a.includes(`window._${k}Pages = function`) && a.includes(`window._${k}GetPage = function`) && a.includes(`return _${k}WithPersonal(function() { return state.entries.filter`)
        && /if \(!m\.locked\) m\.data = /.test(a));
    }
    // Run the real pages()/page() against a fake app.
    const ctx = { console, Promise, setTimeout, document: { readyState: 'complete', addEventListener() {}, querySelectorAll: () => [], createElement: () => ({ style: {} }), head: { appendChild() {} } }, DOMParser: undefined };
    ctx.window = ctx;
    vm.createContext(ctx);
    try { vm.runInContext(src, ctx); } catch (e) { /* the file wires itself into a page; the API object is what's needed */ }
    const N = ctx.Notebook;
    t('Notebook loads in a bare context', !!(N && N.pages && N.page && N._plainText));
    if (N) {
      N.mounts = N.mounts || {};
      N.mounts.zz = { _ready: Promise.resolve() };
      ctx._zzPages = () => [{ id: 'a', title: 'A' }];
      ctx._zzGetPage = (id) => id === 'a' ? { id: 'a', title: 'A', locked: false, data: { html: '<p>Hello</p><p>world</p>', attachments: [{ name: 'x' }] } }
        : id === 'l' ? { id: 'l', title: 'L', locked: true } : null;
      const ps = await N.pages('zz');
      t('pages() hands back the app\'s list', ps.length === 1 && ps[0].id === 'a');
      const p = await N.page('zz', 'a');
      t('page() gives html and plain text, never the raw data', p.html === '<p>Hello</p><p>world</p>' && /Hello/.test(p.text) && /world/.test(p.text) && !('data' in p), JSON.stringify(p));
      const l = await N.page('zz', 'l');
      t('a locked page comes back without its words', l.locked === true && !('text' in l) && !('html' in l));
      t('no such page → null', (await N.page('zz', 'nope')) === null);
      t('plain text walks every template\'s fields, not attachments', N._plainText({ cues: 'Q1', notes: { main: 'N1' }, attachments: [{ name: 'secret.pdf' }] }) === 'Q1\nN1');
      let threw = false; try { await N.pages('nothing'); } catch (e) { threw = true; }
      t('nothing mounted → rejects', threw);
    }
  }

  // ── the connectors, in a page-like context ────────────────────────────────
  const psrc = read('TaskHub/neo-programs.js');
  const csrc = read('TaskHub/neo-connectors.js');
  function page(opts) {
    opts = opts || {};
    const log = { patch: [], put: [], opened: [], tabs: [], nav: [], magi: [], gate: [] };
    const store = Object.assign({}, opts.docs || {});
    const ctx = { console, Promise, JSON, Object, Array, String, Date, Math, setTimeout: (f, ms) => (ms > 5000 ? 0 : setTimeout(f, 0)) };
    ctx.window = ctx;
    ctx._activeProfile = 'veda';
    ctx._navGetLinks = () => [
      { id: 'sh', label: 'Shruti', url: 'https://anthonyn99.github.io/A1/shruti.html' },
      { id: 'mt', label: 'MAGI (T)', url: 'https://anthonyn99.github.io/A1/magi.html' },
    ];
    ctx._navOpenLink = (p, id) => log.opened.push(id);
    ctx._tnOpenTab = (u, k) => { log.tabs.push([u, k]); return { location: { href: u } }; };
    ctx._vedaNav = (v) => log.nav.push(v);
    ctx.fetch = async (u) => ({ json: async () => JSON.parse(read(u)) });
    ctx._fbNeoGet = async (p) => (p in store ? JSON.parse(JSON.stringify(store[p])) : null);
    ctx._fbNeoPatch = async (p, flat) => { log.patch.push([p, flat]); return p in store; };
    const locks = opts.locks || {};
    ctx.Guardian = { mustBlock: (id) => !!locks[id] };
    ctx.alGate = (id, ok, no) => { log.gate.push(id); (opts.unlock ? ok : no)(); };
    const pages = opts.pages || [];
    ctx.Notebook = {
      mounts: { bj: {} },
      pages: async () => pages.map(({ html, ...m }) => m),
      page: async (k, id) => { const p = pages.find((x) => x.id === id); if (!p) return null; const { html, ...m } = p; return p.locked ? m : Object.assign(m, { html, text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() }); },
      putPage: async (k, pg) => { log.put.push([k, pg]); return Object.assign({}, pg); },
      open: async (k, id) => { log.nav.push('open:' + id); return true; },
    };
    if (opts.plans) {
      const plans = opts.plans;
      ctx.PlansCore = {
        bucket: () => ({ ideas: plans.filter((p) => p.stage === 'idea'), confirmed: plans.filter((p) => p.stage === 'confirmed') }),
        applyEdit: (id, ti, no, d, tm) => { log.plan = ['edit', id, ti, no, d, tm]; return Promise.resolve(plans.find((p) => p.id === id).stage === 'confirmed' ? 'pending' : 'ok'); },
        proposeReschedule: (id, d, tm, why) => { log.plan = ['move', id, d, tm, why]; return Promise.resolve('ok'); },
        removePlan: (id) => { log.plan = ['remove', id]; },
      };
    }
    ctx.A1Debrief = { b64u: (s) => Buffer.from(s, 'utf8').toString('base64url'), openMagi: (u) => { log.magi.push(u); return true; } };
    vm.createContext(ctx);
    vm.runInContext(psrc, ctx);
    vm.runInContext(csrc, ctx);
    return { R: ctx._vdNeoPrograms, ctx, log, store };
  }
  const say = (r) => (r && r.say) || '';

  section('V\'s Notebook');
  {
    const pages = [
      { id: 'p1', title: 'Trip to Goa', template: 'page', updated: 3, tags: [], html: '<p>Beaches and a fort.</p>' },
      { id: 'p2', title: 'Diary', template: 'page', updated: 5, tags: ['life'], locked: true, html: '<p>secret words</p>' },
      { id: 'p3', title: 'Cornell: Biology', template: 'cornell', updated: 1, tags: [], html: '' },
    ];
    const { R, log } = page({ pages });
    t('listed first, as V\'s Notebook', R.list()[0].id === 'notebook' && R.list()[0].label === 'V\'s Notebook' && R.find('my journal').id === 'notebook');
    await R._test.refresh('notebook');
    const s = R.state().find((p) => p.id === 'notebook');
    t('summary: page count and the latest titles, a locked one marked', /^3 pages\. Most recent: "Diary" \(.*locked\); "Trip to Goa"/.test(s.summary), s.summary);
    t('…and its ops are offered', s.ops.some((o) => o.startsWith('read_page(')) && s.ops.some((o) => o.startsWith('append(')));
    t('read_page reads the page out', say(await R.run('notebook', 'read_page', { title: 'goa trip' })) === 'Trip to Goa. Beaches and a fort.');
    const lk = await R.run('notebook', 'read_page', { title: 'diary' });
    t('…never a page with its own lock', lk.ok === false && lk.reason === 'locked' && !/secret/.test(JSON.stringify(lk)));
    t('…and an unknown page is said', (await R.run('notebook', 'read_page', { title: 'mars' })).reason === 'not_found');
    t('find names the pages that mention it (never a locked one)', say(await R.run('notebook', 'find', { words: 'fort' })) === 'One page: Trip to Goa.' && /No page mentions secret/.test(say(await R.run('notebook', 'find', { words: 'secret' }))));
    t('append adds a paragraph through putPage, escaped', (await R.run('notebook', 'append', { title: 'Trip to Goa', text: 'Ate <fish>.' })) === true
      && log.put[0][0] === 'bj' && log.put[0][1].id === 'p1' && log.put[0][1].data.html === '<p>Beaches and a fort.</p><p>Ate &lt;fish&gt;.</p>' && !('title' in log.put[0][1]));
    t('…never to a locked page or a non-page template', (await R.run('notebook', 'append', { title: 'Diary', text: 'x' })).reason === 'locked'
      && (await R.run('notebook', 'append', { title: 'Cornell: Biology', text: 'x' })).reason === 'invalid' && log.put.length === 1);
    t('tag adds a tag once', (await R.run('notebook', 'tag', { title: 'Trip to Goa', tag: '#travel' })) === true && JSON.stringify(log.put[1][1].tags) === '["travel"]');
    t('new_page makes a page', (await R.run('notebook', 'new_page', { title: 'Idea', text: 'One\nTwo' })) === true && log.put[2][1].data.html === '<p>One</p><p>Two</p>' && log.put[2][1].title === 'Idea');
    t('open_page shows the Notebook and opens the page', (await R.run('notebook', 'open_page', { title: 'Trip to Goa' })) === true && log.nav.join() === 'journal,open:p1');
    t('opening V\'s Notebook is the built-in view', R.open('notebook') === true && log.nav[log.nav.length - 1] === 'journal');
  }
  {
    const { R, log } = page({ pages: [{ id: 'p1', title: 'Trip', template: 'page', html: '<p>x</p>' }], locks: { veda_journal: true } });
    await R._test.refresh('notebook');
    const s = R.state().find((p) => p.id === 'notebook');
    t('a locked Notebook: no summary read, the state says so', /^Locked\./.test(s.summary) && !R._test.summaries.notebook, s.summary);
    const r = await R.run('notebook', 'read_page', { title: 'Trip' });
    t('…and an op asks for the unlock; refused, nothing is read', r.ok === false && r.reason === 'locked' && log.gate[0] === 'veda_journal');
  }
  {
    const { R } = page({ pages: [{ id: 'p1', title: 'Trip', template: 'page', html: '<p>x</p>' }], locks: { veda_journal: true }, unlock: true });
    t('unlocked at the prompt: the op runs', say(await R.run('notebook', 'read_page', { title: 'Trip' })) === 'Trip. x');
  }

  section('Plans');
  {
    const plans = [{ id: 'a', title: 'Dinner at Nobu', stage: 'confirmed', date: '2026-11-20', time: '19:00', notes: 'n' }, { id: 'b', title: 'Hike', stage: 'idea' }];
    const { R, log } = page({ plans });
    t('edit keeps what she didn\'t change', (await R.run('plans', 'edit', { title: 'hike', new_title: 'Hike Mt Tam', date: '2026-11-22' })) === true
      && JSON.stringify(log.plan) === JSON.stringify(['edit', 'b', 'Hike Mt Tam', '', '2026-11-22', null]));
    const pe = await R.run('plans', 'edit', { title: 'dinner', time: '20:00' });
    t('…an agreed plan goes to Tony to approve, and Neo says so', pe.ok === true && /sent him the change/.test(pe.say) && log.plan[4] === '2026-11-20' && log.plan[5] === '20:00');
    t('reschedule proposes the new slot', (await R.run('plans', 'reschedule', { title: 'dinner', date: '2026-11-21', time: '19:30', reason: 'work' })) === true && log.plan.join() === 'move,a,2026-11-21,19:30,work');
    t('…a bad date is refused', (await R.run('plans', 'reschedule', { title: 'dinner', date: 'friday' })).reason === 'invalid');
    t('remove_idea asks first', /delete the plan idea hike/.test(R.opInfo('plans', 'remove_idea').op.confirm({ title: 'hike' })));
    t('…removes an idea, never an agreed plan', (await R.run('plans', 'remove_idea', { title: 'hike' })) === true && log.plan.join() === 'remove,b' && (await R.run('plans', 'remove_idea', { title: 'dinner' })).reason === 'invalid');
  }

  section('Shruti');
  {
    const doc = { last: { book: 'gita', n: 4, at: 1 }, progress: { gita: { ch1: { done: true, f: 1 }, ch2: { done: true, f: 1 }, ch4: { f: 0.4 } } },
      bookmarks: { gita: { ch2: { b3: { at: 1, label: 'Verse 47' }, b9: { at: 2, label: 'Verse 55' } } } } };
    const { R, log } = page({ docs: { 'dashboards/shruti_veda': doc } });
    await R._test.refresh('shruti');
    const s = R.state().find((p) => p.id === 'shruti').summary;
    t('summary: last opened, read, in progress, next unread, bookmarks', /Last opened: Chapter 4, /.test(s) && /Read: 1, 2\./.test(s) && /In progress: 4 \(40%\)/.test(s) && /Next unread: Chapter 3, /.test(s) && /Bookmarks: 2\./.test(s), s);
    t('mark_read patches only that chapter\'s fields', (await R.run('shruti', 'mark_read', { chapter: 'chapter five' })) === true
      && log.patch[0][0] === 'dashboards/shruti_veda' && log.patch[0][1]['progress.gita.ch5.done'] === true && log.patch[0][1]['progress.gita.ch5.f'] === 1
      && log.patch[0][1]['progress.gita.ch5.modes.read'] === 1 && log.patch[0][1].last.n === 5 && !('progress' in log.patch[0][1]), JSON.stringify(log.patch[0]));
    t('mark_unread undoes it', (await R.run('shruti', 'mark_unread', { chapter: '2' })) === true && log.patch[1][1]['progress.gita.ch2.done'] === false);
    t('a chapter that isn\'t one is refused', (await R.run('shruti', 'mark_read', { chapter: '40' })).reason === 'invalid' && log.patch.length === 2);
    t('open_chapter opens her Shruti there, in its own tab', (await R.run('shruti', 'open_chapter', { chapter: '12', mode: 'listen' })) === true
      && log.tabs[0][0] === 'https://anthonyn99.github.io/A1/shruti.html?profile=veda#/b/gita/12/listen' && log.tabs[0][1] === 'link_veda_sh', JSON.stringify(log.tabs));
    t('continue opens where she was', (await R.run('shruti', 'continue', {})) === true && /#\/b\/gita\/4$/.test(log.tabs[1][0]));
  }
  {
    const { R } = page({ docs: {} });
    t('no Shruti doc: a patch fails, it isn\'t claimed', (await R.run('shruti', 'mark_read', { chapter: '1' })).reason === 'failed');
  }

  section('MAGI (T)');
  {
    const runs = [{ id: 'r2', question: 'Should I take the Goa trip in December?', status: 'complete', created_at: '2026-11-05T10:00:00Z' }, { id: 'r1', question: 'Best laptop for school', status: 'complete', created_at: '2026-11-01T10:00:00Z' }];
    const { R, log } = page({ docs: { 'dashboards/magi_veda': { runs }, 'dashboards/magi_veda/runs/r1': { synthesis: { synthesis_ok: true, verdict: 'A MacBook Air.' } }, 'dashboards/magi_veda/runs/r2': { synthesis: { synthesis_ok: false } } } });
    t('"MAGI" is MAGI (T)', R.find('MAGI').label === 'MAGI (T)');
    await R._test.refresh('magi');
    const s = R.state().find((p) => p.id === 'magi').summary;
    t('summary: her recent questions', /Recent questions to the council: "Should I take the Goa trip in December\?" \(5 Nov\); "Best laptop for school"/.test(s), s);
    t('read_answer reads the verdict', say(await R.run('magi', 'read_answer', { question: 'laptop' })) === 'On "Best laptop for school": A MacBook Air.');
    t('…says when there is none yet', /has no verdict yet/.test(say(await R.run('magi', 'read_answer', {}))));
    t('ask asks first, saying it uses her accounts', /ask the MAGI council: Plan my week\. It uses your AI accounts/.test(R.opInfo('magi', 'ask').op.confirm({ question: 'Plan my week' })));
    t('ask hands MAGI the question as Veda, to run', (await R.run('magi', 'ask', { question: 'Plan my week' })) === true && log.magi.length === 1);
    const h = JSON.parse(Buffer.from(log.magi[0].split('#tb=')[1], 'base64url').toString('utf8'));
    t('…through MAGI (T)\'s own #tb= link', log.magi[0].startsWith('https://anthonyn99.github.io/A1/magi.html#tb=') && h.q === 'Plan my week' && h.p === 'veda' && h.run === 1 && h.src === 'neo', JSON.stringify(h));
  }

  section('Tony\'s side');
  {
    const { R, ctx, log } = page({ docs: { 'dashboards/shruti_veda': {} }, pages: [{ id: 'p1', title: 'Trip', template: 'page', html: '<p>x</p>' }] });
    ctx._activeProfile = 'tony';
    const r = [await R.run('notebook', 'read_page', { title: 'Trip' }), await R.run('shruti', 'mark_read', { chapter: '1' }), await R.run('magi', 'ask', { question: 'x' })];
    t('none of it runs there', r.every((x) => x.reason === 'no_bridge') && !log.patch.length && !log.magi.length && R.state().length === 0);
  }

  section('the page and the worker');
  {
    const html = read('index.html');
    t('index.html loads the connectors after the registry', html.indexOf('TaskHub/neo-programs.js') > 0 && html.indexOf('TaskHub/neo-connectors.js') > html.indexOf('TaskHub/neo-programs.js'));
    t('_fbNeo* reaches her MAGI doc and its runs, nothing of Tony\'s', /magi_veda\|magi_veda\\\/runs\\\//.test(html) && !/NEO_DOCS = [^\n]*\bmagi\|/.test(html) && !/NEO_DOCS = [^\n]*shruti\|/.test(html));
    const w = read('workers/personal-ai/worker.js');
    t('the prompt tells the model a read op speaks for itself', /An op that READS something out \(read_page, read_answer, find\)/.test(w));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
