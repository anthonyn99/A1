// Shruti's Make with AI (Phase 6), offline:
//  - generate.js, media.js parse and load in Node;
//  - the prompt: the chapter's exact text with [verse] numbers, every lesson
//    id, the reply format; long asks go as attached .txt files;
//  - reading replies: fences, chatter and trailing commas forgiven; podcast,
//    video and lessons normalised; coverage;
//  - run(): writes, checks, repairs a missing lesson once with the same
//    model, speaks, keeps the result (local without Drive, a version with it);
//  - video.js fill() gives exactly the shipped scenes for all 18 chapters
//    (so a video made here is shaped like tools/video.py's), and build()
//    times scenes from byte counts the same way;
//  - versions: record, feature, the original again, delete (and its files).
//
// Run: node Shruti/tests/generate.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const DIR = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

(async () => {
  console.log('\nThe files');
  const babel = require('@babel/parser');
  for (const f of ['generate.js', 'media.js', 'library.js', 'video.js', 'podcast.js', 'narrate.js']) {
    let err = null; try { babel.parse(read(f), { sourceType: 'module' }); } catch (e) { err = e.message; }
    ok(f + ' parses as a module', !err, err);
  }
  global.window = { SHRUTI_PROFILES: { tony: { label: 'Tony', doc: 'shruti' }, veda: { label: 'Veda', doc: 'shruti_veda' } }, SHRUTI_PROFILE: 'tony' };
  global.addEventListener = () => {};
  globalThis.atob = globalThis.atob || ((b) => Buffer.from(b, 'base64').toString('binary'));
  globalThis.btoa = globalThis.btoa || ((s) => Buffer.from(s, 'binary').toString('base64'));
  const calls = [];
  global.fetch = async (url, o = {}) => { calls.push({ url, method: o.method || 'GET' }); return { ok: true, status: 200, json: async () => ({ ok: true, connected: true }) }; };
  const G = await import(pathToFileURL(path.join(DIR, 'generate.js')).href);
  const M = await import(pathToFileURL(path.join(DIR, 'media.js')).href);
  const VID = await import(pathToFileURL(path.join(DIR, 'video.js')).href);
  const C = await import(pathToFileURL(path.join(DIR, 'core.js')).href);
  ok('they load in Node', typeof G.run === 'function' && typeof M.record === 'function');
  ok('every module the page loads is wired: app.js sets generate.js up', /G\.setUI\(/.test(read('app.js')) && /import \* as G from '\.\/generate\.js'/.test(read('app.js')));

  const lessons = JSON.parse(read('books/gita/lessons.json'));
  const ch2 = JSON.parse(read('books/gita/ch02.json'));
  const L2 = lessons[2];

  console.log('\nThe prompt');
  const hosts = [{ id: 'A', name: 'Ava', voice: 'en-US-AvaMultilingualNeural' }, { id: 'B', name: 'Andrew', voice: 'en-US-AndrewMultilingualNeural' }];
  const base = { book: 'gita', n: 2, title: 'Spiritual knowledge', ch: ch2, lessons: L2, length: 'standard', hosts };
  const pm = G.buildPrompt(Object.assign({ kind: 'podcast' }, base));
  const userText = (m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.type === 'text' ? p.text : Buffer.from(p.file.file_data.split(',')[1], 'base64').toString('utf8')).join('\n'));
  const all = userText(pm[1]);
  ok('a system and a user message; JSON only', pm.length === 2 && pm[0].role === 'system' && /ONLY the JSON/.test(pm[0].content));
  ok('the chapter\'s exact text goes in, with [verse] numbers', all.includes('[2.47] ' + ch2.blocks.flatMap((b) => b.s || []).find((s) => s.v === '2.47').t) && all.includes('## ' + ch2.blocks.find((b) => b.k === 'h').t));
  ok('every lesson id and title goes in', L2.lessons.every((l) => all.includes(l.id + ': ' + l.title)) && /Teach EVERY one of these 12 lessons/.test(all));
  ok('it names the hosts and asks for the podcast format', /Host A is Ava, host B is Andrew/.test(all) && /"segments"/.test(all));
  ok('…long text goes as attached .txt files (chapter 2 is over 12,000 characters)', Array.isArray(pm[1].content) && pm[1].content.some((p) => p.type === 'file' && p.file.filename === 'source.txt'), typeof pm[1].content);
  const short = G.buildPrompt(Object.assign({}, base, { kind: 'lessons', ch: { blocks: [{ k: 'p', s: [{ v: '1.1', t: 'A short text.' }] }] } }));
  ok('a short ask stays plain text; lessons are not sent when making lessons', typeof short[1].content === 'string' && !/<lessons>/.test(short[1].content) && /"lessons"/.test(short[1].content));
  const vp = userText(G.buildPrompt(Object.assign({ kind: 'video', extra: 'keep it light' }, base))[1]);
  ok('the video prompt explains {verse} and the seven layouts, and carries the extra ask', /\{verse\}/.test(vp) && ['title', 'story', 'verse', 'lesson', 'compare', 'steps', 'closing'].every((l) => vp.includes('"' + l + '"')) && /The reader also asks: keep it light/.test(vp));
  ok('the length changes the size asked for', /About 30 turns/.test(userText(G.buildPrompt(Object.assign({}, base, { kind: 'podcast', length: 'concise' }))[1])) && /About 28 scenes/.test(userText(G.buildPrompt(Object.assign({}, base, { kind: 'video', length: 'deep' }))[1])));

  console.log('\nReading replies');
  ok('parseJSON: fences and chatter', G.parseJSON('Sure! ```json\n{"a":1}\n``` hope it helps').a === 1);
  ok('parseJSON: trailing commas and curly quotes', G.parseJSON('{“a”: [1,2,],}').a.length === 2);
  let threw = null; try { G.parseJSON('no json here'); } catch (e) { threw = e.message; }
  ok('parseJSON: no JSON is an error', /no JSON/.test(threw));
  const ids = L2.lessons.map((l) => l.id);
  const pod = G.normPodcast({ segments: [{ title: 'Welcome', turns: [{ s: 'Ava', t: ' Hi   there ' }, { speaker: 'b', text: 'Hello', L: ['l1', 2, 'L99'] }, { s: 'A', t: '' }] }, { title: 'Empty', turns: [] }] }, hosts, ids);
  ok('normPodcast: speakers by letter or name, text tidied, empty turns and parts dropped, lesson ids read and checked', pod.segments.length === 1 && pod.segments[0].turns.length === 2 && pod.segments[0].turns[0].s === 'A' && pod.segments[0].turns[0].t === 'Hi there' && pod.segments[0].turns[1].s === 'B' && JSON.stringify(pod.segments[0].turns[1].L) === '["L1","L2"]', JSON.stringify(pod));
  const vid = G.normVideo({ scenes: [{ layout: 'Title', headline: 'x'.repeat(90), visual: 'one', say: 'Hi.' }, { layout: 'nonsense', say: 'Story.', L: 'L3' }, { layout: 'verse', ref: '2.47', say: 'Read {verse}' }, { layout: 'lesson', say: '' }] }, ids);
  ok('normVideo: layouts checked, text trimmed to fit, scenes with nothing to say dropped', vid.scenes.length === 3 && vid.scenes[0].layout === 'title' && vid.scenes[0].headline.length <= 64 && vid.scenes[1].layout === 'story' && vid.scenes[1].L[0] === 'L3' && vid.scenes[2].ref === '2.47');
  const les = G.normLessons({ lessons: [{ title: 'Be kind', body: 'Because.' }, { title: '' }, { title: 'Act', body: 'Now.' }], summary: 'S.' });
  ok('normLessons: numbered L1… in order, empty ones dropped', les.lessons.length === 2 && les.lessons[1].id === 'L2' && les.summary === 'S.');
  ok('coverage names what is missing', JSON.stringify(G.coverage('podcast', pod, ['L1', 'L2', 'L3']).missing) === '["L3"]');

  console.log('\nThe same shape as tools/video.py');
  let same = 0, scenesAll = 0, firstBad = '';
  for (let n = 1; n <= 18; n++) {
    const nn = String(n).padStart(2, '0');
    const script = JSON.parse(read('books/gita/scripts/ch' + nn + '-video.json'));
    const built = JSON.parse(read('books/gita/media/ch' + nn + '-video.json'));
    const filled = VID.fill(script, JSON.parse(read('books/gita/ch' + nn + '.json')), lessons[n]);
    filled.forEach((s, i) => {
      scenesAll++;
      const b = built.scenes[i];
      const eq = b && s.say === b.say && s.headline === b.headline && s.layout === b.layout && JSON.stringify(s.L) === JSON.stringify(b.L) && (s.verse || null) === (b.verse || null) && JSON.stringify(s.vs || null) === JSON.stringify(b.vs || null) && (s.ref || null) === (b.ref || null);
      if (eq) same++; else if (!firstBad) firstBad = 'ch' + n + ' scene ' + (i + 1) + ': ' + JSON.stringify({ s: s.say.slice(0, 80), b: b && b.say.slice(0, 80), vs: [s.vs, b && b.vs] });
    });
  }
  ok('fill() gives the shipped scenes exactly, all 18 chapters (' + same + ' of ' + scenesAll + ')', same === scenesAll, firstBad);
  const fake = (len) => async ({ text }) => ({ audio: new Blob([new Uint8Array(len(text))]), words: text.split(' ').map((w, i) => [i * 0.1, 0.08, w]) });
  const script = { book: 'gita', n: 2, title: 't', narrator: { name: 'Brian', voice: 'v' }, scenes: [
    { layout: 'title', headline: 'T', visual: [], say: 'Hello.' },
    { layout: 'verse', ref: '2.47', say: 'Listen. {verse}' },
    { layout: 'verse', ref: '9.99', say: 'Missing {verse} here.' },
    { layout: 'story', headline: 'S', visual: ['a', 'b'], say: 'A story {verse}.' },
  ] };
  const built = await VID.build(script, { key: 'k', ch: ch2, lessons: L2, speak: fake(() => 6000) });
  const S = 1728 / 6000, m = built.meta;
  ok('build(): a title is padded to 5 s', m.scenes[0].start === 0 && m.scenes[0].at === +(2 * S).toFixed(3) && m.scenes[0].end >= 5 && m.scenes[0].end < 5 + S + 0.001);
  ok('…a verse gets the book\'s words and 5 clips after it', m.scenes[1].verse.startsWith('You have control') && m.scenes[1].say.startsWith('Listen. You have control') && Math.abs(m.scenes[1].end - m.scenes[1].at - (1 + 5 * S)) < 0.002);
  ok('…a verse the book lacks becomes a story; a stray {verse} is dropped', m.scenes[2].layout === 'story' && m.scenes[2].say === 'Missing  here.'.replace('  ', ' ') || m.scenes[2].say === 'Missing here.', m.scenes[2].say);
  ok('…scenes follow each other; the length is the bytes', m.scenes.every((s, i) => i === 0 || s.start === m.scenes[i - 1].end) && m.duration === +((await built.mp3.arrayBuffer()).byteLength / 6000).toFixed(3));

  console.log('\nA run');
  // Chat: the first reply forgets L12; the repair adds it. Speech: 1 s each.
  const full = { segments: [{ title: 'Welcome', turns: [{ s: 'A', t: 'Welcome.' }, { s: 'B', t: 'Hello.' }] }].concat(ids.map((id, i) => ({ title: 'Lesson ' + (i + 1) + ' · x', turns: [{ s: i % 2 ? 'B' : 'A', t: 'About ' + id + '.', L: [id] }] }))) };
  const firstReply = JSON.parse(JSON.stringify(full)); firstReply.segments = firstReply.segments.filter((s) => !s.turns.some((t) => (t.L || []).includes('L12')));
  const chats = [];
  const chat = async ({ messages, models, onDelta, onModel }) => {
    chats.push({ messages, models });
    const model = chats.length === 1 ? models[1] : models[0];
    onModel && onModel(model);
    const text = 'Here you go:\n```json\n' + JSON.stringify(chats.length === 1 ? firstReply : full) + '\n```';
    onDelta && onDelta(text);
    return { text, model };
  };
  C.me.set({ orcaKey: 'orca_sk_test_key_12345' });
  const stages = [], covs = [];
  let deltas = '';
  const res = await G.run(Object.assign({ kind: 'podcast', models: ['deepseek/free', 'chatgpt/free'] }, base), { stage: (id) => stages.push(id), delta: (t) => { deltas += t; }, coverage: (c) => covs.push(c.missing.length) },
    { chat, speak: fake(() => 6000), saveDrive: false });
  ok('it writes, checks, repairs, speaks and is done', stages.join() === 'write,check,repair,speak,done', stages.join());
  ok('the repair goes to the model that answered, with its own reply and the missing lesson named', chats.length === 2 && chats[1].models[0] === 'chatgpt/free' && chats[1].messages.length === 4 && chats[1].messages[2].role === 'assistant' && /L12 \(/.test(chats[1].messages[3].content));
  ok('the checklist went from 1 missing to none', JSON.stringify(covs) === '[1,0]');
  ok('the streamed text reached the page', deltas.includes('"segments"'));
  ok('without Drive it is ready on this device, every turn spoken', res.local && res.built.meta.turns.length === 2 + ids.length && res.model === 'chatgpt/free');
  ok('…and nothing was saved as a version', M.versions('gita', 2, 'podcast').length === 0);
  ok('the job was cleared at the end', !C.shared.get('jobs.gita.ch2.podcast', null));

  console.log('\nVersions');
  const id1 = M.record('gita', 3, 'podcast', { mp3: { id: 'm1' }, json: { id: 'j1' }, model: 'deepseek/free', at: 1000 });
  const id2 = M.record('gita', 3, 'podcast', { mp3: { id: 'm2' }, json: { id: 'j2' }, model: 'chatgpt/free', at: 2000 });
  ok('record keeps each version and plays the newest', M.versions('gita', 3, 'podcast').map((v) => v.id).join() === [id2, id1].join() && M.featured('gita', 3, 'podcast') === id2 && C.shared.get('assets.gita.ch3.podcast').mp3.id === 'm2');
  M.feature('gita', 3, 'podcast', id1);
  ok('feature plays an older one', C.shared.get('assets.gita.ch3.podcast').mp3.id === 'm1');
  M.feature('gita', 3, 'podcast', null);
  ok('feature(null) plays the original (nothing in assets)', !C.shared.get('assets.gita.ch3.podcast', null) && M.featured('gita', 3, 'podcast') === null);
  M.feature('gita', 3, 'podcast', id2);
  calls.length = 0;
  await M.remove('gita', 3, 'podcast', id2);
  ok('remove deletes the version and its two files on Drive, and the next one plays', M.versions('gita', 3, 'podcast').length === 1 && calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop()).sort().join() === 'j2,m2' && C.shared.get('assets.gita.ch3.podcast').id === id1);
  M.job('gita', 3, 'video', { kind: 'video', stage: 'speak', text: 'Speaking 3 of 9' }, { now: true });
  ok('a job is seen while fresh', M.jobOf('gita', 3, 'video').text === 'Speaking 3 of 9' && M.jobOf('gita', 3, 'video').by === 'tony');
  C.shared.set({ 'jobs.gita.ch3.video.at': Date.now() - 11 * 60000 });
  ok('…and ignored once stale (10 minutes)', M.jobOf('gita', 3, 'video') === null);
  M.markPersonal('mybook');
  M.record('mybook', 1, 'lessons', { lessons: [{ id: 'L1', title: 't' }], model: 'deepseek/free' });
  ok('a personal book keeps its versions in the person\'s own doc', !!C.me.get('versions.mybook.ch1.lessons') && !C.shared.get('versions.mybook', null));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
