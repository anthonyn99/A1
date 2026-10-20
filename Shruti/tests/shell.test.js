// Shruti's shell (Phase 2), offline:
//  - every module parses; the page loads shared A1 scripts from ../ and its own
//    from beside it, and its Drive worker is the one the deploy lane ships;
//  - who is here: the profile order (pick, ?profile=, favourite, last, picker);
//  - the lock comes first: nothing reaches Firestore before Guardian opens;
//  - the sync layer: field-path writes, the first-load write barrier, the
//    first write of a missing document, a failed write kept for later;
//  - the Orca client: unit order and ticks, Claude off by default, and the
//    fallback chain (404 next, 401 stops, 429 waits once).
//
// Run: node Shruti/tests/shell.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const DIR = path.join(__dirname, '..');
const ROOT = path.join(DIR, '..');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

(async () => {
  console.log('\nThe files');
  let babel = null;
  try { babel = require('@babel/parser'); } catch (e) {}
  for (const f of ['core.js', 'orca.js', 'library.js', 'app.js', 'worker/worker.js']) {
    let err = null;
    if (babel) { try { babel.parse(read(f), { sourceType: 'module' }); } catch (e) { err = e.message; } }
    ok(f + ' parses as a module', !err, err);
  }
  const html = read('shruti.html');
  for (const s of ['dragsort.js', 'Guardian/guardian.js', 'scrollbar.js', 'apphead.js', 'tabsync.js', 'hoverfx.js', 'LifeHub/lifehub.js']) {
    ok('the page loads the shared ' + s + ' from ../', new RegExp('<script[^>]+src="\\.\\./' + s.replace(/[./]/g, '\\$&') + '"').test(html) && fs.existsSync(path.join(ROOT, s)));
  }
  ok('its own module and stylesheet load from beside it', /<script type="module" src="app\.js"><\/script>/.test(html) && /<link rel="stylesheet" href="styles\.css">/.test(html));
  ok('the books it reads are relative to the page', /'books\/' \+ id \+ '\/book\.json'/.test(read('library.js')) && fs.existsSync(path.join(DIR, 'books', 'gita', 'book.json')));
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-workers2.yml'), 'utf8');
  ok('the account-2 lane deploys Shruti/worker on a push to it', /- 'Shruti\/worker\/\*\*'/.test(wf) && /find workers2 Shruti\/worker -maxdepth 2/.test(wf));
  ok('…and resolves its KV title from any folder', /node "\$GITHUB_WORKSPACE\/workers2\/kv-provision\.mjs"/.test(wf) && /id = "kv:SHRUTI_DRIVE"/.test(read('worker/wrangler.toml')));
  ok('the page talks to that worker, by its account-2 name', /https:\/\/shruti-drive\.av1-2\.workers\.dev/.test(read('app.js')) && /name = "shruti-drive"/.test(read('worker/wrangler.toml')));
  const fav = (html.match(/<link rel="icon"[^>]*href="([^"]+)"/) || [])[1] || '';
  ok('the favicon is the Heard book on the suite charcoal', /%23c0aeea/.test(fav) && /M48%2040c-6-4-14-6-24-6v38/.test(fav));

  console.log('\nWho is here');
  const resolveSrc = (html.match(/<script id="profile-resolve">([\s\S]*?)<\/script>/) || [])[1];
  const resolve = ({ pick, q, fav, last }) => {
    const store = (o) => ({ getItem: (k) => (k in o ? o[k] : null) });
    const win = {
      sessionStorage: store(pick ? { 'shruti.pick': pick } : {}),
      localStorage: store(Object.assign({}, fav ? { 'shruti.favProfile': fav } : {}, last ? { 'shruti.lastProfile': last } : {})),
    };
    const ctx = { window: win, location: { href: 'https://x/A1/Shruti/shruti.html' + (q ? '?profile=' + q : '') }, URL };
    win.window = win;
    vm.runInNewContext(resolveSrc.replace(/window\[store\]/g, 'window[store]'), Object.assign(ctx, win));
    return win.SHRUTI_PROFILE;
  };
  ok('nothing known: the picker (no profile)', resolve({}) === null);
  ok('whoever was here last', resolve({ last: 'veda' }) === 'veda');
  ok('the favourite beats the last', resolve({ fav: 'tony', last: 'veda' }) === 'tony');
  ok('?profile= beats the favourite (a pick that rode a reload)', resolve({ q: 'veda', fav: 'tony' }) === 'veda');
  ok("this tab's pick beats everything", resolve({ pick: 'tony', q: 'veda', fav: 'veda' }) === 'tony');
  ok('an unknown name is ignored', resolve({ pick: 'eve', last: 'veda' }) === 'veda');
  ok('each person is their own lock and document', /tony: \{ label: 'Tony', doc: 'shruti'/.test(html) && /veda: \{ label: 'Veda', doc: 'shruti_veda'/.test(html) && /window\.SHRUTI_GID = p \? p \+ '_shruti' : null/.test(html));

  console.log('\nThe lock comes first');
  const gIdx = html.indexOf('src="../Guardian/guardian.js"'), defIdx = html.indexOf("Guardian.define(p + '_shruti'"), preIdx = html.indexOf('Guardian.prepaint([window.SHRUTI_GID])'), bodyIdx = html.indexOf('<body');
  ok('Guardian loads, the lock is declared and painted over, all before <body>', gIdx > 0 && gIdx < defIdx && defIdx < preIdx && preIdx < bodyIdx);
  ok('the lock hides #app', /root: '#app'/.test(html));
  const app = read('app.js');
  const boots = [...app.matchAll(/C\.boot\(\)/g)].length;
  ok('Firestore starts in one place only: enter()', boots === 1 && /function enter\(\) \{[\s\S]{0,300}C\.boot\(\);/.test(app));
  ok('enter() runs only after Guardian.gate opens', /Guardian\.gate\(GID\)\.then\(\(ok\) => \{ if \(ok\) enter\(\)/.test(app) && [...app.matchAll(/\benter\(\)/g)].length === 2);
  ok('switching person reloads the page (no state carried over)', /function choose\(id\)[\s\S]{0,700}location\.(?:reload|replace)/.test(app));
  ok('a lock change rings the other devices (lockV) and they ask the worker', /C\.me\.set\(\{ lockV: Date\.now\(\) \}/.test(app) && /Guardian\.refresh\(\[GID\], true\)/.test(app));
  ok('no native alert/confirm dialogs', !/(?<![\w.])confirm\(/.test(app) && /window\.uiConfirm = /.test(app));

  console.log('\nThe sync layer');
  global.window = { SHRUTI_PROFILES: { tony: { label: 'Tony', doc: 'shruti' }, veda: { label: 'Veda', doc: 'shruti_veda' } }, SHRUTI_PROFILE: 'tony' };
  global.addEventListener = () => {};
  const C = await import(pathToFileURL(path.join(DIR, 'core.js')).href);
  ok('nest() turns field paths into a document', JSON.stringify(C.nest({ 'a.b': 1, 'a.c.d': 2, e: 3 })) === '{"a":{"b":1,"c":{"d":2}},"e":3}');
  ok("Tony's document is dashboards/shruti", C.me.path === 'dashboards/shruti' && C.shared.path === 'dashboards/shruti_shared');
  const writes = [];
  let snapCb = null, updateFails = null;
  const fakeFs = {
    doc: (db, p) => ({ p }),
    onSnapshot: (ref, cb) => { snapCb = cb; return () => {}; },
    updateDoc: async (ref, o) => { writes.push(['update', ref.p, o]); if (updateFails) { const e = updateFails; updateFails = null; throw e; } },
    setDoc: async (ref, o, opt) => { writes.push(['set', ref.p, o, opt]); },
    deleteField: () => '<delete>',
  };
  C._useFirebase({ db: {}, fs: fakeFs });
  const d = new C.Doc('dashboards/shruti', 'me');
  await d.start();
  d.set({ 'progress.gita.ch2.f': 0.4 }, { now: true });
  ok('a change shows here at once', d.get('progress.gita.ch2.f') === 0.4);
  await d.flush();
  ok('nothing is written before the first read (the write barrier)', writes.length === 0);
  snapCb({ exists: () => true, data: () => ({ orcaKey: 'orca_sk_x', progress: { gita: { ch1: { f: 1 } } } }), metadata: { hasPendingWrites: false } });
  ok('the snapshot keeps the unsent change on top of the server copy', d.get('progress.gita.ch2.f') === 0.4 && d.get('progress.gita.ch1.f') === 1);
  await d.flush();
  ok('after the read, it writes the field path only', writes.length === 1 && writes[0][0] === 'update' && JSON.stringify(writes[0][2]) === '{"progress.gita.ch2.f":0.4}', JSON.stringify(writes));
  d.set({ orcaKey: C.DELETE }, { now: true });
  await d.flush();
  ok('a removal is a deleteField, not an empty value', writes[1] && writes[1][2].orcaKey === '<delete>' && d.get('orcaKey') === undefined);
  updateFails = Object.assign(new Error('missing'), { code: 'not-found' });
  d.set({ 'units.order': ['deepseek/free'] }, { now: true });
  await d.flush();
  const first = writes.find((w) => w[0] === 'set');
  ok('the first write of a missing document is a merge with nested fields', first && JSON.stringify(first[2]) === '{"units":{"order":["deepseek/free"]}}' && first[3] && first[3].merge === true, JSON.stringify(first));
  updateFails = Object.assign(new Error('offline'), { code: 'unavailable' });
  d.set({ 'shelf.order': ['gita'] }, { now: true });
  await d.flush();
  ok('a failed write is kept to be sent again', d.pending['shelf.order'] && d.pending['shelf.order'][0] === 'gita');
  clearTimeout(d.timer);
  d.set({ 'progress.gita.ch3.f': 0.1 }, { lazy: true });
  ok('progress is lazy (sent within 30 s, or with the next write)', d.timer !== null);
  clearTimeout(d.timer);

  console.log('\nThe Orca client');
  const O = await import(pathToFileURL(path.join(DIR, 'orca.js')).href);
  let rows = O.unitRows({}, null);
  ok("default order is MAGI's: DeepSeek, ChatGPT, Gemini, Perplexity, Claude", rows.map((r) => r.name).join() === 'DeepSeek,ChatGPT,Gemini,Perplexity,Claude', rows.map((r) => r.name).join());
  ok('Claude is off unless ticked', rows.find((r) => r.name === 'Claude').on === false && rows.filter((r) => r.on).length === 4);
  const models = [{ id: 'deepseek/free', routable: true }, { id: 'chatgpt/free', routable: false }, { id: 'gemini_web/free', routable: true }, { id: 'perplexity/free', routable: true }, { id: 'groq/gpt-oss-120b', routable: true }, { id: 'claude/free', routable: true }];
  rows = O.unitRows({ order: ['gemini_web/free', 'deepseek/free'], on: { 'perplexity/free': false } }, models);
  ok('the person\'s order comes first, then the rest', rows.map((r) => r.id).slice(0, 3).join() === 'gemini_web/free,deepseek/free,chatgpt/free');
  ok('Groq shows when Orca routes it', rows.some((r) => r.name === 'Groq'));
  ok('a model Orca cannot route shows offline', rows.find((r) => r.id === 'chatgpt/free').status === 'offline');
  ok('the chain is ticked and routable, in order', O.chain({ order: ['gemini_web/free', 'deepseek/free'], on: { 'perplexity/free': false } }, models).join() === 'gemini_web/free,deepseek/free,groq/gpt-oss-120b');
  ok('a key is checked for its shape before any call', (await O.checkKey('nope', { fetch: () => { throw new Error('called'); } })).ok === false);
  const keyRes = await O.checkKey('orca_sk_abcdefghij', { fetch: async (u, i) => new Response(JSON.stringify({ data: models }), { status: u.endsWith('/models') && i.headers.authorization === 'Bearer orca_sk_abcdefghij' ? 200 : 500 }) });
  ok('a working key returns its models', keyRes.ok && keyRes.models.length === 6);
  ok('a rejected key says so', (await O.checkKey('orca_sk_abcdefghij', { fetch: async () => new Response('', { status: 401 }) })).error === 'Orca rejected this key.');

  const seen = [];
  const sse = (t) => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  let tries = 0;
  const fake = async (u, i) => {
    const m = JSON.parse(i.body).model; seen.push(m);
    if (m === 'a') return new Response('', { status: 404 });
    if (m === 'b') { tries++; return tries === 1 ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : new Response('', { status: 503 }); }
    return sse('hello');
  };
  let streamed = '';
  const res = await O.chat({ key: 'k', messages: [], models: ['a', 'b', 'c'], fetch: fake, onDelta: (t) => { streamed += t; } });
  ok('404 moves on; 429 waits once then moves on; the answer streams', res.text === 'hello' && res.model === 'c' && streamed === 'hello' && seen.join() === 'a,b,b,c', seen.join());
  let stopped = null;
  try { await O.chat({ key: 'k', messages: [], models: ['x', 'y'], fetch: async () => new Response('', { status: 401 }) }); } catch (e) { stopped = e; }
  ok('401 stops the chain and points at the key', stopped && stopped.code === 'key');
  let none = null;
  try { await O.chat({ key: 'k', messages: [], models: [] }); } catch (e) { none = e; }
  ok('no ticked units is said plainly', none && none.code === 'none');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
