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
  ok('a system and a user message; labelled plain text, not JSON, ending in END (Tony, 2026-10-22)', pm.length === 2 && pm[0].role === 'system' && /no JSON, no code block/.test(pm[0].content) && /line that says only END/.test(pm[0].content) && /Do not search the web/.test(pm[0].content));
  ok('the chapter\'s exact text goes in, with [verse] numbers', all.includes('[2.47] ' + ch2.blocks.flatMap((b) => b.s || []).find((s) => s.v === '2.47').t) && all.includes('## ' + ch2.blocks.find((b) => b.k === 'h').t));
  ok('every lesson id and title goes in', L2.lessons.every((l) => all.includes(l.id + ': ' + l.title)) && /Teach EVERY one of these 12 lessons/.test(all));
  ok('it names the hosts and asks for the podcast format', /Host A is Ava, host B is Andrew/.test(all) && /PART: Welcome\nA: what Ava says\nB: what Andrew says/.test(all) && /\[L1\]/.test(all));
  ok('…long text goes as attached .txt files (chapter 2 is over 12,000 characters)', Array.isArray(pm[1].content) && pm[1].content.some((p) => p.type === 'file' && p.file.filename === 'source.txt'), typeof pm[1].content);
  const short = G.buildPrompt(Object.assign({}, base, { kind: 'lessons', ch: { blocks: [{ k: 'p', s: [{ v: '1.1', t: 'A short text.' }] }] } }));
  ok('a short ask stays plain text; lessons are not sent when making lessons', typeof short[1].content === 'string' && !/<lessons>/.test(short[1].content) && /LESSON 1\nTITLE: …\nBODY: …/.test(short[1].content));
  const vp = userText(G.buildPrompt(Object.assign({ kind: 'video', extra: 'keep it light' }, base))[1]);
  ok('the video prompt explains {verse}, the seven layouts and the artwork, and carries the extra ask', /\{verse\}/.test(vp) && ['title', 'story', 'verse', 'lesson', 'compare', 'steps', 'closing'].every((l) => vp.includes('"' + l + '"')) && /ART \(story, title and closing scenes\)/.test(vp) && /chariot, conch/.test(vp) && /The reader also asks: keep it light/.test(vp));
  ok('podcasts aim at about 10 minutes, videos stay under 10 (Tony, 2026-10-22)', /about 1500 words in all \(about 10 minutes spoken\)/.test(all) && /under ten minutes/.test(vp));
  ok('the length changes how long', /about 1050 words/.test(userText(G.buildPrompt(Object.assign({}, base, { kind: 'podcast', length: 'concise' }))[1])) && /About 24 scenes/.test(userText(G.buildPrompt(Object.assign({}, base, { kind: 'video', length: 'deep' }))[1])));
  const lsp = (len) => G.buildPrompt(Object.assign({}, base, { kind: 'lessons', length: len, ch: { blocks: [{ k: 'p', s: [{ v: '1.1', t: 'A short text.' }] }] } }))[1].content;
  ok('lessons: EVERY lesson at any length; the length is how much each explains (Tony, 2026-10-22)', ['concise', 'standard', 'deep'].every((l) => /List EVERY lesson this chapter teaches/.test(lsp(l)) && /depends only on the chapter/.test(lsp(l))) && /BODY of one sentence, at most 25 words/.test(lsp('concise')) && /BODY of two or three sentences, at most 60 words/.test(lsp('standard')) && /BODY of four to six sentences.*at most 120 words/.test(lsp('deep')));

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

  console.log('\nLabelled replies, as each unit sends them');
  const F = await import(pathToFileURL(path.join(DIR, 'formats.js')).href);
  const pctx = { hosts, lessonIds: ['L1', 'L2', 'L3'] };
  const gpt = 'Sure! Here is the episode.\n\n**PART:** Welcome\n**Ava:** Welcome back to Shruti.\n**Andrew:** Glad to be here.\n\n**PART:** Lesson 1 · Do your duty **[L1]**\n**A:** Duty first.\nIt carries on here.\n**B:** Agreed.\n\nEND';
  const p1 = F.parseReply('podcast', gpt, pctx);
  ok('ChatGPT style: bold labels, names or letters, a line that runs on', p1.segments.length === 2 && p1.segments[0].turns[1].s === 'B' && p1.segments[1].turns[0].t === 'Duty first. It carries on here.' && JSON.stringify(p1.segments[1].turns[0].L) === '["L1"]' && p1.segments[1].title === 'Lesson 1 · Do your duty', JSON.stringify(p1));
  const pplx = 'PART: Welcome A: Hello there [1]. B: Hi [2, 3]. PART: Lesson 2 · Equanimity [L2] A: Stay even [4]. B: Yes. END';
  const p2 = F.parseReply('podcast', pplx, pctx);
  ok('Perplexity style: lost newlines and citations', p2.segments.length === 2 && p2.segments[0].turns[0].t === 'Hello there.' && p2.segments[0].turns[1].t === 'Hi.' && p2.segments[1].turns[1].t === 'Yes.' && JSON.stringify(p2.segments[1].turns[0].L) === '["L2"]', JSON.stringify(p2));
  ok('…its old garbled JSON is not mistaken for a script', (() => { try { F.parseReply('podcast', '{\n"lessons\n\n{\n"lessons', pctx); return false; } catch (e) { return /no podcast lines/.test(e.message); } })());
  const vt = 'SCENE 1\nLAYOUT: title\nHEADLINE: The field of duty\nVISUAL:\n- Two armies face each other\nART: battlefield, conch, unicorn\nNARRATION: In scene two we meet them. It begins.\n\nSCENE 2 LAYOUT: Verse VERSE: 2 . 47 NARRATION: Krishna says, {verse}\n\nSCENE 3\nLAYOUT: lesson\nLESSON: L1\nHEADLINE: Act, then let go\nVISUAL: - Do the work - Leave the fruit\nNARRATION: Lesson one. Act without clinging.\n\nSCENE 4\nLAYOUT: closing\nHEADLINE: Duty, done freely\nVISUAL:\n- one\n- two\n- three\nNARRATION: That is chapter two.\nEND';
  const v1 = F.parseReply('video', vt, pctx);
  ok('a video: layouts, verse refs tidied, art kept only from the list, lesson ids, inline visuals', v1.scenes.length === 4 && v1.scenes[0].art.join() === 'battlefield,conch' && v1.scenes[1].layout === 'verse' && v1.scenes[1].ref === '2.47' && v1.scenes[2].L[0] === 'L1' && v1.scenes[2].visual.join('|') === 'Do the work|Leave the fruit' && v1.scenes[3].layout === 'closing' && !/scene two/i.test(v1.scenes.map((s) => s.layout).join()), JSON.stringify(v1.scenes.map((s) => [s.layout, s.ref, s.art, s.L])));
  ok('"scene two" in a sentence does not start a scene', v1.scenes[0].say === 'In scene two we meet them. It begins.');
  const lt = 'LESSON 1\nTITLE: The self is eternal.\nBODY: It is never born and never dies, as lesson 2 explains.\n\nLESSON 2\nTITLE: Do your duty.\nBODY: Act well.\n\nSummary: Duty and the eternal self.\nEND';
  const l1 = F.parseReply('lessons', lt);
  ok('lessons: numbered, "lesson 2" inside a body is just words, the summary read', l1.lessons.length === 2 && /as lesson 2 explains/.test(l1.lessons[0].body) && l1.summary === 'Duty and the eternal self.', JSON.stringify(l1));
  ok('an old JSON reply is still read', F.parseReply('lessons', '```json\n{"lessons":[{"title":"A","body":"B"}],"summary":"S"}\n```').lessons[0].title === 'A');
  ok('finished: END, or a summary for lessons; a reply cut mid-way is not', F.finished('video', vt) && F.finished('lessons', 'LESSON 1 TITLE: x SUMMARY: All done.') && !F.finished('video', vt.slice(0, 300)) && !F.finished('podcast', 'PART: Welcome\nA: Hi'));
  const found = F.parseLessons('LESSON 1\nTITLE: Senses are restless.\nBODY: Guard them.\nAFTER: 1\nEND');
  const merged = F.mergeFound(l1, found);
  ok('a second look\'s lesson goes where it says, and all are renumbered', merged.lessons.map((l) => l.id + ':' + l.title).join('|') === 'L1:The self is eternal.|L2:Senses are restless.|L3:Do your duty.', JSON.stringify(merged.lessons));
  const pod3 = F.parsePodcast('PART: Welcome\nA: Hi.\nPART: Lesson 1 · a [L1]\nB: one.\nPART: Lesson 3 · c [L3]\nA: three.\nPART: Wrap-up\nB: Bye.\nEND', hosts, ['L1', 'L2', 'L3']);
  const add = F.parsePodcast('PART: Welcome\nA: Hi again.\nPART: Lesson 2 · b [L2]\nB: two.\nPART: Lesson 3 · c [L3]\nA: again.\nEND', hosts, ['L1', 'L2', 'L3']);
  const m3 = F.mergeLessons('podcast', pod3, add, ['L2']);
  ok('a missing lesson part goes in its place, and only what was missing is taken', m3.segments.map((s) => s.title).join('|') === 'Welcome|Lesson 1 · a|Lesson 2 · b|Lesson 3 · c|Wrap-up', m3.segments.map((s) => s.title).join('|'));
  const longOne = { lessons: [{ id: 'L1', title: 'Short.', body: 'word '.repeat(40) }, { id: 'L2', title: 'Fine.', body: 'Two words.' }] };
  ok('lengths: 40 words is long for concise, fine for standard', F.longLessons(longOne, 'concise').join() === '1' && F.longLessons(longOne, 'standard').length === 0);

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
  // Speech as Edge sends it: whole 144-byte frames (24 kHz mono 48 kbps), word timings inside the clip.
  const frames = (n) => { const b = new Uint8Array(Math.round(n / 144) * 144); for (let k = 0; k < b.length; k += 144) b.set([0xff, 0xf3, 0x64, 0xc4], k); return b; };
  const fake = (len, engine = 'edge') => async ({ text }) => { const b = frames(len(text)), ws = text.split(' '); return { audio: new Blob([b]), engine, words: ws.map((w, i) => [+(i * (b.length / 6000) * 0.9 / ws.length).toFixed(3), 0.05, w]) }; };
  const script = { book: 'gita', n: 2, title: 't', narrator: { name: 'Brian', voice: 'v' }, scenes: [
    { layout: 'title', headline: 'T', visual: [], say: 'Hello.' },
    { layout: 'verse', ref: '2.47', say: 'Listen. {verse}' },
    { layout: 'verse', ref: '9.99', say: 'Missing {verse} here.' },
    { layout: 'story', headline: 'S', visual: ['a', 'b'], say: 'A story {verse}.' },
  ] };
  const built = await VID.build(script, { key: 'k', ch: ch2, lessons: L2, speak: fake(() => 6048) });
  const S = 1728 / 6000, m = built.meta, ONE = 6048 / 6000;
  ok('build(): a title is padded to 5 s', m.scenes[0].start === 0 && m.scenes[0].at === +(2 * S).toFixed(3) && m.scenes[0].end >= 5 && m.scenes[0].end < 5 + S + 0.001);
  ok('…a verse gets the book\'s words and 5 clips after it', m.scenes[1].verse.startsWith('You have control') && m.scenes[1].say.startsWith('Listen. You have control') && Math.abs(m.scenes[1].end - m.scenes[1].at - (ONE + 5 * S)) < 0.002);
  ok('…a verse the book lacks becomes a story; a stray {verse} is dropped', m.scenes[2].layout === 'story' && m.scenes[2].say === 'Missing here.' && m.scenes[3].say === 'A story.', m.scenes[2].say + ' | ' + m.scenes[3].say);
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
    { chat, speak: fake(() => 6048), saveDrive: false });
  ok('it writes, checks, repairs, speaks and is done', stages.join() === 'write,check,repair,speak,done', stages.join());
  ok('the repair goes to the model that answered, with its own reply and the missing lesson named', chats.length === 2 && chats[1].models[0] === 'chatgpt/free' && chats[1].messages.length === 4 && chats[1].messages[2].role === 'assistant' && /L12 \(/.test(chats[1].messages[3].content));
  ok('the checklist went from 1 missing to none', JSON.stringify(covs) === '[1,0]');
  ok('the streamed text reached the page', deltas.includes('"segments"'));
  ok('without Drive it is ready on this device, every turn spoken', res.local && res.built.meta.turns.length === 2 + ids.length && res.model === 'chatgpt/free');
  ok('…and nothing was saved as a version', M.versions('gita', 2, 'podcast').length === 0);
  ok('the job was cleared at the end', !C.shared.get('jobs.gita.ch2.podcast', null));

  // Lessons must be concise (Tony, 2026-10-20): the prompt says so, and a long reply goes back once.
  const lp = G.buildPrompt(Object.assign({}, base, { kind: 'lessons' }));
  const lpText = JSON.stringify(lp);
  ok('the lessons prompt asks for short, true lessons', lpText.includes('at most ' + G.LESSON_BODY_WORDS + ' words') && /concise, true and to the point/.test(lpText));
  const longBody = Array(80).fill('word').join(' ');
  const lchats = [];
  const lchat = async ({ messages, models, onModel }) => {
    lchats.push(messages);
    onModel && onModel(models[0]);
    const reply = { lessons: [{ title: 'Act without craving.', body: lchats.length === 1 ? longBody : 'Work, and let the result go.' }, { title: 'Offer each deed.', body: 'Give the work to God.' }], summary: 'S.' };
    return { text: JSON.stringify(reply), model: models[0] };
  };
  const lstages = [];
  const lres = await G.run(Object.assign({}, base, { kind: 'lessons', n: 5, models: ['deepseek/free'] }), { stage: (id) => lstages.push(id) }, { chat: lchat, saveDrive: false });
  ok('a long lesson is sent back once to shorten, naming it', lstages.join() === 'write,check,repair,done' && /too long: L1\b/.test(lchats[1][lchats[1].length - 1].content), lstages.join());
  ok('…and the short one is kept', lres.rec && lres.rec.lessons[0].body === 'Work, and let the result go.');
  ok('longLessons ignores lessons within the limit', G.longLessons({ lessons: [{ id: 'L1', title: 'Short.', body: Array(45).fill('w').join(' ') }] }).length === 0);
  M.remove('gita', 5, 'lessons', lres.rec.id);

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
  ok('remove deletes the version and its two files on Drive, and the next one plays', M.versions('gita', 3, 'podcast').length === 1 && calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop()).sort().join() === 'j2?a=tony,m2?a=tony' && C.shared.get('assets.gita.ch3.podcast').id === id1);
  M.job('gita', 3, 'video', { kind: 'video', stage: 'speak', text: 'Speaking 3 of 9' }, { now: true });
  ok('a job is seen while fresh', M.jobOf('gita', 3, 'video').text === 'Speaking 3 of 9' && M.jobOf('gita', 3, 'video').by === 'tony');
  C.shared.set({ 'jobs.gita.ch3.video.at': Date.now() - 11 * 60000 });
  ok('…and ignored once stale (10 minutes)', M.jobOf('gita', 3, 'video') === null);
  M.markPersonal('mybook');
  M.record('mybook', 1, 'lessons', { lessons: [{ id: 'L1', title: 't' }], model: 'deepseek/free' });
  ok('a personal book keeps its versions in the person\'s own doc', !!C.me.get('versions.mybook.ch1.lessons') && !C.shared.get('versions.mybook', null));

  console.log('\nOne Drive per person, links that need no key');
  ok('a shared book\'s media goes to Tony\'s Drive, a personal one to its owner\'s', M.acctFor('gita') === 'tony' && M.acctFor('mybook') === 'tony');
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, o = {}) => {
    seen.push({ url, o });
    if (/\/health/.test(url)) return { ok: true, status: 200, json: async () => ({ ok: true, configured: true, connected: true, accounts: { tony: { connected: true }, veda: { connected: false } } }) };
    if (/\/f\?/.test(url)) return { ok: true, status: 200, json: async () => ({ ok: true, id: 'file_' + seen.length, size: 3, acct: /acct=veda/.test(url) ? 'veda' : 'tony', url: 'https://x/f/file_' + seen.length + '?e=0&s=sig' }) };
    if (/\/sign$/.test(url)) { const b = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ ok: true, urls: Object.fromEntries(b.ids.map((id) => [id, 'https://x/f/' + id + '?' + (b.acct === 'veda' ? 'a=veda&' : '') + 'e=0&s=p'])) }) }; }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  ok('driveReady asks the book\'s own Drive', (await M.driveReady('gita')) === true);
  const up = await M.upload({ book: 'gita', n: 3, body: 'abc', type: 'audio/mpeg', name: 'podcast.mp3', key: 'orca_sk_x' });
  ok('an upload keeps its Drive and its permanent link', up.acct === 'tony' && /e=0/.test(up.url) && /&acct=tony/.test(seen[seen.length - 1].url), JSON.stringify(up));
  const ls1 = await M.links({ mp3: { id: 'a1', url: 'https://x/keep' }, json: { id: 'a2', url: 'https://x/keep2' } });
  ok('a record with its links plays with no call at all', ls1.mp3 === 'https://x/keep' && ls1.json === 'https://x/keep2' && !/\/sign$/.test(seen[seen.length - 1].url));
  C.me.set({ orcaKey: 'orca_sk_testkey123' });
  const n0 = seen.length;
  const ls2 = await M.links({ mp3: { id: 'old_mp3_id_1' }, json: { id: 'old_json_id', acct: 'veda' } });
  ok('an older record is signed for good, each file on its own Drive', ls2.mp3 === 'https://x/f/old_mp3_id_1?e=0&s=p' && ls2.json === 'https://x/f/old_json_id?a=veda&e=0&s=p' && seen.slice(n0).filter((c) => /\/sign$/.test(c.url)).length === 2);
  C.shared.set({ 'assets.gita.ch5.video': { id: 'v9', mp3: { id: 'mp3_upgrade_1' }, json: { id: 'json_upgrade1' } }, 'versions.gita.ch5.video.v9': { id: 'v9', mp3: { id: 'mp3_upgrade_1' }, json: { id: 'json_upgrade1' } } });
  C.shared.loaded = true; C.me.loaded = true;
  await M.upgradeLinks();
  ok('upgradeLinks gives older records their links, in assets and versions', /e=0/.test(C.shared.get('assets.gita.ch5.video.mp3.url') || '') && /e=0/.test(C.shared.get('versions.gita.ch5.video.v9.json.url') || '') && C.shared.get('assets.gita.ch5.video.mp3.acct') === 'tony');
  C.me.set({ orcaKey: C.DELETE });
  let noKey = null;
  try { await M.links({ mp3: { id: 'old_mp3_id_2' } }); } catch (e) { noKey = e; }
  ok('without a key, an unlinked older file says why in plain words', noKey && noKey.code === 'nolink' && /Orca key/.test(noKey.message));
  global.fetch = realFetch;

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
