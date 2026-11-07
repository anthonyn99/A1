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
    const log = { patch: [], put: [], opened: [], tabs: [], nav: [], magi: [], gate: [], tx: [], later: [] };
    const store = Object.assign({}, opts.docs || {});
    // The 3 s look-again after a StudyOS write is queued (log.later) so a test can run it when it likes.
    const ctx = { console, Promise, JSON, Object, Array, String, Date, Math, crypto: require('crypto').webcrypto, clearTimeout: () => {},
      setTimeout: (f, ms) => (ms === 3000 ? (log.later.push(f), 0) : ms > 5000 ? 0 : setTimeout(f, 0)) };
    ctx.window = ctx;
    ctx._activeProfile = 'veda';
    ctx._navGetLinks = () => [
      { id: 'sh', label: 'Shruti', url: 'https://anthonyn99.github.io/A1/shruti.html' },
      { id: 'mt', label: 'MAGI (T)', url: 'https://anthonyn99.github.io/A1/magi.html' },
      { id: 'st', label: 'STUDY', url: 'https://tradeboard.vedapatel05.workers.dev/studyos/' },
      { id: 'li', label: 'LIST', url: 'https://anthonyn99.github.io/A1/mylist.html' },
      { id: 'tr', label: 'TRADE', url: 'https://tradeboard.vedapatel05.workers.dev/' },
      { id: 'fi', label: 'FINANCE', url: 'https://tradeboard.vedapatel05.workers.dev/finance/' },
    ];
    ctx._navOpenLink = (p, id) => log.opened.push(id);
    ctx._tnOpenTab = (u, k) => { log.tabs.push([u, k]); return { location: { href: u } }; };
    ctx._vedaNav = (v) => log.nav.push(v);
    ctx.fetch = async (u, o) => {
      if (/^https:/.test(u)) { const b = JSON.parse((o && o.body) || '{}'); log.auth.push([u, b]); return { json: async () => (opts.authReply ? opts.authReply(u, b) : { ok: false }) }; }
      return { json: async () => JSON.parse(read(u)) };
    };
    ctx._fbNeoGet = async (p) => (p in store ? JSON.parse(JSON.stringify(store[p])) : null);
    ctx._fbNeoPatch = async (p, flat) => { log.patch.push([p, flat]); return p in store; };
    // A transaction as Firestore runs it: fn sees the server copy, its fields are merged in (set when new).
    ctx._fbNeoTx = async (p, fn) => {
      const d = p in store ? JSON.parse(JSON.stringify(store[p])) : null;
      const u = fn(d); if (!u) return false;
      log.tx.push([p, Object.keys(u)]);
      // Dotted keys are field paths (tx.update), as in Firestore.
      const out = d || {};
      for (const [key, v] of Object.entries(JSON.parse(JSON.stringify(u)))) {
        const parts = key.split('.'); let o = out;
        for (const q of parts.slice(0, -1)) o = (o[q] = o[q] && typeof o[q] === 'object' ? o[q] : {});
        o[parts[parts.length - 1]] = v;
      }
      store[p] = out; return true;
    };
    const locks = opts.locks || {};
    log.defs = {};
    ctx.Guardian = { mustBlock: (id) => !!locks[id], define: (id, o) => { log.defs[id] = o; return id; }, refresh: () => Promise.resolve() };
    // tradeboard-6b2ea, a store of its own (index.html _fbTb*).
    const tb = Object.assign({}, opts.tb || {});
    log.tb = tb; log.tbtx = []; log.auth = [];
    ctx._fbTbGet = async (p) => (p in tb ? JSON.parse(JSON.stringify(tb[p])) : null);
    ctx._fbTbList = async (col, field, n) => Object.keys(tb).filter((k) => k.startsWith(col + '/') && k.split('/').length === col.split('/').length + 1).map((k) => JSON.parse(JSON.stringify(tb[k])));
    ctx._fbTbTx = async (p, fn) => { const d = p in tb ? JSON.parse(JSON.stringify(tb[p])) : null; const u = fn(d); if (!u) return false; log.tbtx.push([p, Object.keys(u)]); tb[p] = Object.assign(d || {}, JSON.parse(JSON.stringify(u))); return true; };
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
  const ctxFnv = (...a) => page({})['ctx']._vdNeoConnectors.fnv(...a);

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

  section('StudyOS');
  {
    const cls = [{ id: 'c1', name: 'Biology', code: 'BIO 101', modules: [{ id: 'm1', name: 'Slides', type: 'documents', files: [], prompts: [], notes: [] }, { id: 'm2', name: 'Lecture notes', type: 'notes', files: [], prompts: [], notes: [] }] },
      { id: 'c2', name: 'Calculus', modules: [] }];
    const today = new Date(), k = (n) => { const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + n); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); };
    const docs = {
      'dashboards/studyos': { classes: cls, events: [{ id: 'e1', name: 'Bio midterm', date: k(5), time: '10:00', classId: 'c1', type: 'exam' }],
        tasks: [{ id: 't1', name: 'Lab report', dueDate: k(2), dueTime: '23:59', classId: 'c1', type: 'hw', done: false }, { id: 't0', name: 'Old reading', dueDate: k(-3), classId: 'c2', done: false }],
        notes: [], ksu: { modules: [] }, d2l: {} },
      'studyos_cards/c1': { cards: [{ id: 'cd_a', fp: 'x', q: 'Q', a: 'A', sched: { state: 'review', due: Date.now() - 1000 } }, { id: 'cd_b', fp: 'y', q: 'Q2', a: 'A2', sched: null },
        { id: 'cd_c', fp: 'z', deletedAt: 1 }, { id: 'cd_d', fp: 'w', status: 'archived', sched: { state: 'review', due: 0 } }], meta: { v: 2 }, savedAt: 1 },
      'dashboards/studyos_sessions': { sessions: [{ id: 's1', startedAt: Date.now() - 60000, durationMs: 45 * 60000 }] },
      'dashboards/studyos_notebook': { e_old: { id: 'old', title: 'x' }, _order: ['old'], savedAt: 1 },
    };
    const { R, log, store } = page({ docs });
    t('"study" is StudyOS', R.find('study').id === 'studyos');
    await R._test.refresh('studyos');
    const s = R._test.summaries.studyos || '';
    t('summary: classes and their Notes modules, open tasks (overdue counted), events, cards due, time studied',
      /Biology \(BIO 101\), notes modules: Lecture notes/.test(s) && /\(1 overdue\)/.test(s) && /"Lab report" \[Biology\]/.test(s) && /"Bio midterm" \[Biology\].*\(exam\)/.test(s)
      && /Biology: 1 due, 1 new/.test(s) && /Studied this week: 45 min/.test(s), s);
    t('add_task builds StudyOS\'s own task, in a transaction on tasks only', (await R.run('studyos', 'add_task', { title: 'Problem set 4', class: 'calc', date: k(3), time: '17:00', type: 'hw' })) === true
      && JSON.stringify(log.tx[0]) === JSON.stringify(['dashboards/studyos', ['tasks']]), JSON.stringify(log.tx));
    const nt = store['dashboards/studyos'].tasks.find((x) => x.name === 'Problem set 4');
    t('…with every field the form writes, nothing undefined', nt && nt.classId === 'c2' && nt.dueDate === k(3) && nt.dueTime === '17:00' && nt.done === false && nt.priority === 'medium' && nt.type === 'hw'
      && nt.repeat === 'none' && Array.isArray(nt.repeatDays) && nt.notif === 'none' && typeof nt.createdAt === 'number' && /^[a-z0-9]{10,}$/.test(nt.id) && !Object.values(nt).some((v) => v === undefined), JSON.stringify(nt));
    t('…the other arrays untouched', store['dashboards/studyos'].events.length === 1 && store['dashboards/studyos'].classes.length === 2);
    // An open tab saves its stale copy over it; the look-again puts it back once.
    const before = JSON.parse(JSON.stringify(store['dashboards/studyos'].tasks.filter((x) => x.id !== nt.id)));
    store['dashboards/studyos'].tasks = before;
    for (const f of log.later.splice(0)) f();
    await new Promise((r) => setTimeout(r, 20));
    t('overwritten by an open tab → put back, once', store['dashboards/studyos'].tasks.filter((x) => x.id === nt.id).length === 1);
    for (const f of log.later.splice(0)) f();
    t('an unknown class is said, not guessed', (await R.run('studyos', 'add_task', { title: 'x', class: 'chemistry' })).reason === 'not_found');
    t('complete_task ticks the open one', (await R.run('studyos', 'complete_task', { title: 'lab report' })) === true && store['dashboards/studyos'].tasks.find((x) => x.id === 't1').done === true);
    t('move_task moves it', (await R.run('studyos', 'move_task', { title: 'problem set', date: k(4) })) === true && store['dashboards/studyos'].tasks.find((x) => x.id === nt.id).dueDate === k(4));
    t('remove_task removes only it', (await R.run('studyos', 'remove_task', { title: 'old reading' })) === true && !store['dashboards/studyos'].tasks.some((x) => x.id === 't0') && store['dashboards/studyos'].tasks.length === 2);
    t('add_event builds StudyOS\'s own event', (await R.run('studyos', 'add_event', { title: 'Quiz 3', date: k(6), class: 'biology', type: 'quiz' })) === true
      && (() => { const e = store['dashboards/studyos'].events.find((x) => x.name === 'Quiz 3'); return e && e.classId === 'c1' && e.type === 'quiz' && e.weight === 0 && e.time === ''; })());
    t('remove_event removes it', (await R.run('studyos', 'remove_event', { title: 'bio midterm' })) === true && !store['dashboards/studyos'].events.some((x) => x.id === 'e1'));
    const n1 = await R.run('studyos', 'add_note', { class: 'biology', text: 'Mitochondria\nmake ATP', title: 'Cells' });
    const pg = Object.keys(store['dashboards/studyos_notebook']).filter((x) => /^e_neo/.test(x)).map((x) => store['dashboards/studyos_notebook'][x])[0];
    t('add_note: a page in the class\'s Notes module folder, on top of the order', n1.say === 'Noted in Biology Lecture notes.' && pg && pg.folder === 'm2' && pg.template === 'page' && pg.title === 'Cells'
      && pg.data.html === '<p>Mitochondria</p><p>make ATP</p>' && store['dashboards/studyos_notebook']._order[0] === pg.id && store['dashboards/studyos_notebook']._order[1] === 'old' && store['dashboards/studyos_notebook'].e_old.title === 'x', JSON.stringify(pg));
    t('…never into a documents module; a class with none says so', (await R.run('studyos', 'add_note', { class: 'calculus', text: 'x' })).say === 'Calculus has no Notes module yet.');
    t('…no class: Quick Notes', (await R.run('studyos', 'add_note', { text: 'Buy a calculator' })).say === 'Noted in Quick Notes.');
    t('add_card: a v2 card with StudyOS\'s fingerprint', (await R.run('studyos', 'add_card', { class: 'bio', question: 'What makes ATP?', answer: 'Mitochondria' })) === true
      && (() => { const c = store['studyos_cards/c1'].cards.find((x) => x.q === 'What makes ATP?'); return c && /^cd_[a-z0-9]{12}$/.test(c.id) && c.fp === ctxFnv('qa', 'What makes ATP?', 'Mitochondria') && c.sched === null && c.kind === 'qa' && c.classId === 'c1'; })()
      && store['studyos_cards/c1'].meta.v === 2 && store['studyos_cards/c1'].cards.length === 5);
    t('…the same card twice is not added', (await R.run('studyos', 'add_card', { class: 'bio', question: 'what makes  ATP?', answer: 'mitochondria' })).reason === 'already' && store['studyos_cards/c1'].cards.length === 5);
    t('…a class with no deck: Neo doesn\'t make one', /has no flashcards yet/.test((await R.run('studyos', 'add_card', { class: 'calculus', question: 'q', answer: 'a' })).say) && !store['studyos_cards/c2']);
    t('open_class opens StudyOS on that class, in its STUDY tab', (await R.run('studyos', 'open_class', { class: 'bio' })) === true && log.tabs[log.tabs.length - 1][0] === 'https://tradeboard.vedapatel05.workers.dev/studyos/?class=c1' && log.tabs[log.tabs.length - 1][1] === 'link_veda_st', JSON.stringify(log.tabs));
  }
  {
    const { R, store } = page({ docs: { 'dashboards/studyos': { classes: [], tasks: [], events: [] } }, locks: { veda_studyos: true } });
    await R._test.refresh('studyos');
    t('a locked StudyOS: nothing read, nothing written', !R._test.summaries.studyos && (await R.run('studyos', 'add_task', { title: 'x' })).reason === 'locked' && store['dashboards/studyos'].tasks.length === 0);
  }
  {
    // StudyOS's own fingerprint, copied here from its module, must match Neo's.
    const m = /export function fingerprint[\s\S]*?\r?\n}\r?\n/.exec(read('V1/StudyOS/js/modules/cards.js'));
    const own = new Function(m[0].replace('export ', '') + '; return fingerprint;')();
    t('Neo\'s card fingerprint is StudyOS\'s', ['What makes ATP?|Mitochondria', '  Two  spaces |X', 'Ünïcode|∑'].every((x) => { const [q, a] = x.split('|'); return own('qa', q, a) === ctxFnv('qa', q, a); }));
  }

  section('MyList');
  {
    const tonyLists = [{ id: 'T1', name: 'Tony groceries', items: [{ id: 'x', name: 'Steak', done: false }] }];
    const docs = { 'dashboards/mylist': { tony: { lists: tonyLists }, veda: { lists: [
      { id: 'g', name: 'Groceries', type: 'shopping', stores: ['Costco'], items: [{ id: 'i1', name: 'Milk', qty: '2', store: 'Costco', desc: '', done: false }, { id: 'i2', name: 'Eggs', done: true }] },
      { id: 'p', name: 'Packing', type: 'packing', stores: [], items: [] }] }, locks: { a: 1 }, lockV: {} } };
    const { R, log, store } = page({ docs });
    const veda = () => store['dashboards/mylist'].veda.lists;
    t('"list" is MyList', R.find('list').id === 'mylist');
    await R._test.refresh('mylist');
    const s = R._test.summaries.mylist || '';
    t('summary: her lists, what is left on each (never Tony\'s)', /"Groceries" \(shopping, 1 to do, 1 done\): Milk \(2\) @Costco/.test(s) && /"Packing"/.test(s) && !/Steak|Tony groceries/.test(s), s);
    t('read_list reads what is left', say(await R.run('mylist', 'read_list', { list: 'groceries' })) === 'Groceries: Milk, 2.');
    t('…two lists and none named: Neo asks which', /Which list, Groceries and Packing\?/.test((await R.run('mylist', 'read_list', {})).say));
    t('add_item writes only veda.lists, in a transaction', (await R.run('mylist', 'add_item', { list: 'groceries', item: 'Bread', store: 'trader joes' })) === true
      && JSON.stringify(log.tx[0]) === JSON.stringify(['dashboards/mylist', ['veda.lists', 'savedAt']]), JSON.stringify(log.tx));
    const br = veda()[0].items.find((x) => x.name === 'Bread');
    t('…an item shaped as MyList makes it, its store added to the list', br && br.done === false && br.qty === '' && br.desc === '' && br.store === 'trader joes' && veda()[0].stores.join() === 'Costco,trader joes' && /^[a-z0-9]{9,}$/.test(br.id));
    t('…Tony\'s lists and the locks untouched', JSON.stringify(store['dashboards/mylist'].tony.lists) === JSON.stringify(tonyLists) && store['dashboards/mylist'].locks.a === 1);
    // An open tab saves its stale copy; the look-agains (3 s, 12 s) put it back once.
    store['dashboards/mylist'].veda.lists[0].items = veda()[0].items.filter((x) => x.name !== 'Bread');
    for (const f of log.later.splice(0)) f();
    await new Promise((r) => setTimeout(r, 20));
    t('overwritten by an open tab → put back, once', veda()[0].items.filter((x) => x.name === 'Bread').length === 1);
    t('check_item ticks it, on any list', (await R.run('mylist', 'check_item', { item: 'milk' })) === true && veda()[0].items.find((x) => x.id === 'i1').done === true);
    t('uncheck_item unticks', (await R.run('mylist', 'uncheck_item', { item: 'eggs' })) === true && veda()[0].items.find((x) => x.id === 'i2').done === false);
    t('remove_item removes only it', (await R.run('mylist', 'remove_item', { item: 'bread' })) === true && !veda()[0].items.some((x) => x.name === 'Bread') && veda()[0].items.length === 2);
    t('an item that isn\'t there is said', (await R.run('mylist', 'check_item', { item: 'caviar' })).reason === 'not_found');
    t('clear_checked asks first', /clear the ticked items off groceries/.test(R.opInfo('mylist', 'clear_checked').op.confirm({ list: 'groceries' })));
    await R.run('mylist', 'check_item', { item: 'eggs' }); await R.run('mylist', 'uncheck_item', { item: 'milk' });
    t('…and clears only ticked ones', (await R.run('mylist', 'clear_checked', { list: 'groceries' })) === true && veda()[0].items.length === 1 && veda()[0].items[0].id === 'i1');
    t('new_list makes a list as MyList does', (await R.run('mylist', 'new_list', { name: 'Gifts', type: 'todo' })) === true
      && (() => { const l = veda().find((x) => x.name === 'Gifts'); return l && l.type === 'todo' && Array.isArray(l.items) && Array.isArray(l.stores) && typeof l.createdAt === 'number'; })());
    t('…never a second one with that name', (await R.run('mylist', 'new_list', { name: 'gifts' })).reason === 'already');
    t('Tony\'s lists still untouched after all of it', JSON.stringify(store['dashboards/mylist'].tony.lists) === JSON.stringify(tonyLists));
  }
  {
    const { R, store } = page({ docs: { 'dashboards/mylist': { tony: { lists: [{ id: 'T' }] } } } });
    t('no lists of hers to read: nothing is written', (await R.run('mylist', 'new_list', { name: 'X' })).reason === 'no_bridge' && !store['dashboards/mylist'].veda);
  }
  {
    const { R } = page({ docs: { 'dashboards/mylist': { veda: { lists: [] } } }, locks: { 'mylist:profile_veda': true } });
    t('her MyList locked: nothing written', (await R.run('mylist', 'new_list', { name: 'X' })).reason === 'locked');
  }

  section('each program\'s own lock');
  {
    const TBD = 'tradeboard/UboRGuQZT5QlGhJa1U4zMSd7Sm12';
    const { R, log } = page({ docs: { 'dashboards/studyos_lock': { locks: { studyos: { locked: true, v: 77 } } } },
      tb: { [TBD]: { _applock: JSON.stringify({ tradeboard_sec_journal: { locked: true, v: 5 } }) } },
      authReply: (u, b) => /hint/.test(u) ? (b.entryId === 'finance' ? { ok: true, hint: 'h' } : { noLock: true }) : { ok: b.password === 'pw' } });
    const d = log.defs;
    t('MyList\'s lock is declared on MyList\'s own record (mylist / profile_veda)', d['mylist:profile_veda'] && d['mylist:profile_veda'].journal === 'mylist' && d['mylist:profile_veda'].entryId === 'profile_veda' && d['mylist:profile_veda'].owner === 'veda');
    t('Shruti and MAGI: Guardian\'s default record, as their pages declare them', d.veda_shruti && !d.veda_shruti.journal && d.veda_magi && !d.veda_magi.backend);
    t('StudyOS: its own record and backend', d.veda_studyos.journal === 'studyos_applock' && d.veda_studyos.entryId === 'studyos' && !!d.veda_studyos.backend);
    t('…its lock state comes from its Firestore doc', JSON.stringify(await d.veda_studyos.backend.status()) === '{"hasLock":true,"ver":"77"}');
    t('…its password is checked by studyos-api, on its record', (await d.veda_studyos.backend.verify({}, 'pw')).ok === true
      && log.auth[0][0] === 'https://studyos-api.vedapatel05.workers.dev/auth/journal/verify' && log.auth[0][1].journal === 'studyos_applock' && log.auth[0][1].entryId === 'studyos');
    t('…and from TaskHub it is never set, removed or reset', ['set', 'remove', 'resetRequest', 'resetConfirm'].every((k) => typeof d.veda_studyos.backend[k] === 'function'));
    const nope = await d.veda_studyos.backend.set({}, 'x');
    t('…(each refuses)', nope.ok === false && !log.auth.some((a) => /set-lock|remove-lock|reset/.test(a[0])));
    t('TradeBoard: app lock and each section on the suite\'s lock worker', ['veda_tradeboard', 'veda_tradeboard_portfolio', 'veda_tradeboard_journal', 'veda_tradeboard_control'].every((k) => d[k].journal === 'applock')
      && d.veda_tradeboard.entryId === 'tradeboard_app' && d.veda_tradeboard_control.entryId === 'tradeboard_sec_control');
    t('…which are on comes from TradeBoard\'s _applock, versioned', JSON.stringify(await d.veda_tradeboard_journal.backend.status()) === '{"hasLock":true,"ver":"5"}' && JSON.stringify(await d.veda_tradeboard.backend.status()) === '{"hasLock":false}');
    t('Finance: its own record; "is there a password" from the worker', d.veda_finance.entryId === 'finance' && JSON.stringify(await d.veda_finance.backend.status()) === '{"hasLock":true,"ver":null}');
    t('…its password checked there', (await d.veda_finance.backend.verify({}, 'nope')).ok === false && log.auth.some((a) => /tradeboard-auth.*verify/.test(a[0]) && a[1].entryId === 'finance'));
    t('connectors name these locks', R._test.connectors.studyos.lock === 'veda_studyos' && R._test.connectors.mylist.lock === 'mylist:profile_veda' && R._test.connectors.finance.lock === 'veda_finance' && R._test.connectors.tradeboard.lock === 'veda_tradeboard');
  }

  section('TRADE (TradeBoard)');
  {
    const TBD = 'tradeboard/UboRGuQZT5QlGhJa1U4zMSd7Sm12';
    const tbDoc = {
      positions: JSON.stringify({ broker: 'webull', generated_at: '2026-11-06T20:00:00Z', account: { net_liquidation: 52000, cash: 4000, day_pnl: 312.5, day_pnl_pct: 0.6 },
        positions: [{ symbol: 'NVDA', qty: 10, avg: 120, last: 140, market_value: 1400, unrealized: 200, unrealized_pct: 16.7 }] }),
      trades: JSON.stringify([{ id: 'a', date: '2026-11-05', symbol: 'AAPL', side: 'long', qty: 10, entry: 100, exit: 110, fees: 2 }, { id: 'b', date: '2026-11-06', symbol: 'TSLA', side: 'short', qty: 5, entry: 250, exit: null, fees: 0 }]),
      watchlist: JSON.stringify(['NVDA', 'AAPL']), watchlistTrash: JSON.stringify([{ t: 'AMD', trashed: 1 }]), account: '{"x":1}', _applock: '{}',
    };
    const { R, log } = page({ tb: { [TBD]: tbDoc } });
    t('"trade" is TradeBoard', R.find('trade').id === 'tradeboard');
    await R._test.refresh('tradeboard');
    const s = R._test.summaries.tradeboard || '';
    t('summary: portfolio, journal with P&L and open trades, watchlist', /total \$52,000/.test(s) && /NVDA 10 @ 120, last 140, \$200 \(16\.7%\)/.test(s) && /2 trades, 1 open \(TSLA\)/.test(s) && /long AAPL x10 \$98/.test(s) && /Watchlist: NVDA, AAPL\./.test(s), s);
    t('watch_add adds, taking it out of the trash, in one transaction', (await R.run('tradeboard', 'watch_add', { tickers: 'amd, $msft' })) === true
      && JSON.parse(log.tb[TBD].watchlist).join() === 'NVDA,AAPL,AMD,MSFT' && JSON.parse(log.tb[TBD].watchlistTrash).length === 0 && JSON.stringify(log.tbtx[0][1]) === '["watchlist","watchlistTrash","_updated"]', JSON.stringify(log.tbtx));
    t('…never touching trades, positions or the account', log.tb[TBD].trades === tbDoc.trades && log.tb[TBD].positions === tbDoc.positions && log.tb[TBD].account === tbDoc.account);
    t('…one already there is said', (await R.run('tradeboard', 'watch_add', { tickers: 'nvda' })).reason === 'already');
    t('watch_remove moves it to the 30-day trash', (await R.run('tradeboard', 'watch_remove', { ticker: 'AAPL' })) === true
      && JSON.parse(log.tb[TBD].watchlist).indexOf('AAPL') < 0 && JSON.parse(log.tb[TBD].watchlistTrash)[0].t === 'AAPL' && typeof JSON.parse(log.tb[TBD].watchlistTrash)[0].trashed === 'number');
    t('…a ticker not on it is said', (await R.run('tradeboard', 'watch_remove', { ticker: 'XYZ' })).reason === 'not_found');
    t('no order op exists, nor any write to trades or positions', !Object.keys(R._test.connectors.tradeboard.ops).some((k) => /order|buy|sell|trade|position/.test(k)));
  }
  {
    const TBD = 'tradeboard/UboRGuQZT5QlGhJa1U4zMSd7Sm12';
    const { R, log } = page({ tb: { [TBD]: { watchlist: null, trades: '[]', positions: 'null' } } });
    t('a watchlist never saved: Neo won\'t replace TradeBoard\'s default', /never been saved/.test((await R.run('tradeboard', 'watch_add', { tickers: 'AMD' })).say) && !log.tbtx.length);
  }
  {
    const TBD = 'tradeboard/UboRGuQZT5QlGhJa1U4zMSd7Sm12';
    const { R, log } = page({ tb: { [TBD]: { watchlist: '["NVDA"]', trades: '[{"date":"2026-11-01","symbol":"X","side":"long","qty":1,"entry":1,"exit":2}]', positions: '{"account":{"net_liquidation":1}}' } },
      locks: { veda_tradeboard_portfolio: true, veda_tradeboard_control: true } });
    await R._test.refresh('tradeboard');
    const s = R._test.summaries.tradeboard || '';
    t('a locked section is not read; the others are', /Portfolio: locked\./.test(s) && /Watchlist: locked\./.test(s) && /Journal: 1 trades/.test(s) && !/NVDA/.test(s), s);
    t('…and its op asks for that section\'s lock', (await R.run('tradeboard', 'watch_add', { tickers: 'AMD' })).reason === 'locked' && log.gate.join() === 'veda_tradeboard_control' && !log.tbtx.length);
  }

  section('FINANCE');
  {
    const mk = new Date().toISOString().slice(0, 7);
    const tbs = {
      ['finance/meta/plaid_transactions/p1']: { id: 'p1', date: mk + '-02', name: 'TRADER JOES', merchant: 'Trader Joe\'s', amount: 54.2, category: 'Groceries', pending: false },
      ['finance/meta/plaid_transactions/p2']: { id: 'p2', date: mk + '-03', name: 'PAYROLL', amount: -1500, category: 'Paycheck', pending: false },
      ['finance/meta/plaid_transactions/p3']: { id: 'p3', date: mk + '-04', name: 'CC PAYMENT', amount: 400, category: 'Credit Card Payment', pending: false },
      ['finance/meta/accounts/a1']: { institution: 'Chase', type: 'depository', balance_current: 3000 },
      ['finance/meta/accounts/a2']: { institution: 'Chase', type: 'credit', balance_current: 500 },
      ['finance/meta/sub/ledger']: { budgets: [{ category: 'Groceries', limit: 300 }], cash: 40 },
    };
    const { R, log } = page({ tb: tbs });
    t('"finance" is Finance', R.find('finance').id === 'finance');
    await R._test.refresh('finance');
    const s = R._test.summaries.finance || '';
    t('summary: net worth, cash, this month (card payments and transfers left out), budgets, recent', /Net worth \$2,500 \(assets \$3,000, debts \$500\)/.test(s) && /Cash on hand \$40/.test(s)
      && /spent \$54\.20, income \$1,500/.test(s) && /Groceries \$54\.20 of \$300/.test(s) && /Trader Joe's \$54\.20 \(Groceries\)/.test(s), s);
    t('add_expense writes Finance\'s own manual record, as a new document', (await R.run('finance', 'add_expense', { amount: '$12.50', name: 'Lunch', category: 'food' })) === true);
    const k = Object.keys(log.tb).find((x) => /manual_transactions\/m_/.test(x)), rec = log.tb[k];
    t('…an expense is positive, with every field the form writes', rec && rec.amount === 12.5 && rec.category === 'Food & Drink' && rec.source === 'manual' && rec.institution === 'Manual' && rec.merchant === 'Lunch'
      && rec.currency === 'USD' && rec.pending === false && /^\d{4}-\d{2}-\d{2}$/.test(rec.date) && rec.id === k.split('/').pop() && rec.account_id === null, JSON.stringify(rec));
    t('add_income is negative (Plaid\'s sign)', (await R.run('finance', 'add_income', { amount: 200, name: 'Tutoring', category: 'side gig' })) === true
      && Object.values(log.tb).some((r) => r && r.name === 'Tutoring' && r.amount === -200 && r.category === 'Side Gig'));
    t('…an unknown category is Other; a bad amount is refused', (await R.run('finance', 'add_expense', { amount: 'lots', name: 'x' })).reason === 'invalid');
    t('Plaid\'s transactions and accounts are never written', !log.tbtx.some((x) => /plaid|accounts|ledger/.test(x[0])));
  }
  {
    const { R, log } = page({ tb: { 'finance/meta/sub/ledger': { cash: 1 } }, locks: { veda_finance: true } });
    await R._test.refresh('finance');
    t('Finance locked: nothing read, nothing written, its own password asked for', !R._test.summaries.finance && (await R.run('finance', 'add_expense', { amount: 5, name: 'x' })).reason === 'locked' && log.gate[0] === 'veda_finance' && !log.tbtx.length);
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
