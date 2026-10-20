// Shruti's reader and read-aloud (Phase 3), offline:
//  - the new modules parse;
//  - text.js: what each block says (no verse numbers), segments at sentence
//    ends within the size limit, words, and lining the voice's words up with
//    the page's (numbers said aloud, hyphenated words said as two);
//  - the shipped narrations: one per listed chapter, every block spoken in
//    order, times that add up to the MP3's length, and words that line up
//    with the exact text;
//  - the Orca speech client: timestamps asked for, base64 audio decoded, a
//    refused key stops, 503 waits once.
//
// Run: node Shruti/tests/reader.test.js
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
  let babel = null;
  try { babel = require('@babel/parser'); } catch (e) {}
  for (const f of ['text.js', 'reader.js', 'narrate.js']) {
    let err = null;
    if (babel) { try { babel.parse(read(f), { sourceType: 'module' }); } catch (e) { err = e.message; } }
    ok(f + ' parses as a module', !err, err);
  }
  ok('reader.js uses library.js only inside functions (they import each other)', (() => {
    const src = read('reader.js');
    const top = src.split('\n').filter((l) => /^(const|let|var|export const)\b/.test(l));
    return !top.some((l) => /\b(IC|esc|fracOf|setProgress)\b/.test(l.replace(/^.*?=/, '')));
  })());

  const T = await import(pathToFileURL(path.join(DIR, 'text.js')).href);
  console.log('\ntext.js');
  ok('a paragraph is spoken without its verse numbers', T.blockText({ k: 'p', s: [{ v: '2.11', t: 'The Lord said:' }, { v: '2.12', t: 'There was never a time.' }] }) === 'The Lord said: There was never a time.');
  ok('headings and asides are spoken as written', T.blockText({ k: 'h', t: 'Duty' }) === 'Duty' && T.blockText({ k: 'a', style: 'note', t: 'NOTE: x' }) === 'NOTE: x');
  const long = 'Arjuna said: O Krishna, I see my kinsmen here. '.repeat(60).trim();
  const parts = T.splitSentences(long, 300);
  ok('long text is cut at sentence ends, within the limit, losing nothing', parts.length > 5 && parts.every((p) => p.length <= 300) &&
    parts.join(' ').replace(/\s+/g, ' ') === long && parts.slice(0, -1).every((p) => /[.:]$/.test(p)), parts.map((p) => p.length).join(','));
  const oneLong = ('word ').repeat(500).trim();
  ok('a single over-long sentence is cut at spaces', T.splitSentences(oneLong, 400).every((p) => p.length <= 400) && T.splitSentences(oneLong, 400).join(' ') === oneLong);
  const ch2 = JSON.parse(read('books/gita/ch02.json'));
  const segs = T.segmentsFor(ch2);
  ok('chapter 2: every block is spoken, in order', [...new Set(segs.map((s) => s.b))].join() === ch2.blocks.map((_, i) => i).join());
  ok('chapter 2: no segment over 1,500 characters', segs.every((s) => s.text.length <= T.SEG_MAX));
  ok('blockTextPart gives back a segment\'s text', segs.every((s) => T.blockTextPart(ch2, s) === s.text));
  ok('words keep inner apostrophes, hyphens and decimals', JSON.stringify(T.words("Krishna's self-realization, verse 2.11.")) === JSON.stringify(["Krishna's", 'self-realization', 'verse', '2.11']));
  const page = T.words('He has 18 chapters and a self-realized mind, O Arjuna.');
  const spoken = ['He', 'has', 'eighteen', 'chapters', 'and', 'a', 'self', 'realized', 'mind', 'O', 'Arjuna'];
  const map = T.align(spoken, page);
  ok('a number said aloud costs one word, not the rest', map[0] === 0 && map[2] === -1 && map[3] === 3 && map[10] === page.indexOf('Arjuna'), JSON.stringify(map));
  ok('a hyphenated word said as two lights the same page word', map[6] === page.indexOf('self-realized') && map[7] === page.indexOf('self-realized'), JSON.stringify(map));
  ok('wordAt finds the word playing', T.wordAt([[0, .3, 'a'], [.4, .3, 'b'], [.9, .3, 'c']], .5) === 1 && T.wordAt([[0.2, .3, 'a']], 0.1) === -1);
  const spread = T.spreadWords('one three fives', 3);
  ok('without timings, words are spread over the audio by length', spread.length === 3 && spread[0][0] === 0 && Math.abs(spread[2][0] + spread[2][1] - 3) < 0.01 && spread[2][1] > spread[0][1]);
  ok('times read as m:ss', T.fmtTime(808.6) === '13:29' && T.fmtTime(3725) === '1:02:05');

  console.log('\nThe shipped narrations');
  const index = JSON.parse(read('books/gita/media/index.json'));
  ok('the introduction and chapters 1-3 come with a narration', ['0', '1', '2', '3'].every((k) => index[k]));
  for (const [n, e] of Object.entries(index)) {
    const meta = JSON.parse(read('books/gita/media/' + e.json));
    const ch = JSON.parse(read('books/gita/ch' + String(n).padStart(2, '0') + '.json'));
    const bytes = fs.statSync(path.join(DIR, 'books/gita/media', e.mp3)).size;
    const blocks = [...new Set(meta.segs.map((s) => s.b))];
    ok(`ch${n}: every block spoken, in order`, blocks.join() === ch.blocks.map((_, i) => i).join());
    ok(`ch${n}: each segment's text is the page's own`, meta.segs.every((s) => T.blockText(ch.blocks[s.b]).includes(s.text)));
    let t = 0, mono = true;
    for (const s of meta.segs) { if (Math.abs(s.start - t) > 0.01) mono = false; t += s.dur; }
    ok(`ch${n}: segments follow each other and add up to the MP3 (48 kbps)`, mono && Math.abs(t - bytes / 6000) < 0.05 && Math.abs(meta.duration - t) < 0.05, t + ' vs ' + bytes / 6000);
    ok(`ch${n}: the index has the voice and length`, e.voice === meta.voice && Math.abs(e.duration - meta.duration) < 0.01);
    ok(`ch${n}: word times stay inside their segment`, meta.segs.every((s) => s.words.every((w) => w[0] >= 0 && w[0] <= s.dur + 0.05)));
    let total = 0, lined = 0;
    for (const s of meta.segs) { const m = T.align(s.words.map((w) => w[2]), T.words(s.text)); total += m.length; lined += m.filter((x) => x >= 0).length; }
    ok(`ch${n}: the voice's words line up with the text (${(100 * lined / total).toFixed(1)}%)`, lined / total > 0.97);
  }

  console.log('\nThe Orca speech client');
  globalThis.atob = globalThis.atob || ((b) => Buffer.from(b, 'base64').toString('binary'));
  const O = await import(pathToFileURL(path.join(DIR, 'orca.js')).href);
  const calls = [];
  const reply = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] || null }, json: async () => body });
  const audioB64 = Buffer.from([1, 2, 3, 4]).toString('base64');
  let seq = [];
  const f = async (url, init) => { calls.push({ url, init }); return seq.shift(); };
  seq = [reply(200, { audio: audioB64, words: [[0, .3, 'Hello']], engine: 'edge', voice: 'en-GB-RyanNeural' })];
  const r = await O.speak({ key: 'orca_sk_test_key_1', text: 'Hello', voice: 'en-GB-RyanNeural', fetch: f });
  const body = JSON.parse(calls[0].init.body);
  ok('it asks /v1/audio/speech for timestamps, with the key and voice', calls[0].url === O.ORCA + '/audio/speech' && body.timestamps === true && body.voice === 'en-GB-RyanNeural' && body.input === 'Hello' && calls[0].init.headers.authorization === 'Bearer orca_sk_test_key_1');
  ok('it hands back the MP3 and the words', r.audio.size === 4 && r.audio.type === 'audio/mpeg' && r.words[0][2] === 'Hello' && r.engine === 'edge');
  seq = [reply(401, {})];
  let e1 = null; try { await O.speak({ key: 'orca_sk_test_key_1', text: 'x', fetch: f }); } catch (e) { e1 = e; }
  ok('a refused key stops with code "key"', e1 && e1.code === 'key');
  seq = [reply(503, {}, { 'retry-after': '1' }), reply(200, { audio: audioB64, words: null, engine: 'aura', voice: 'aura:asteria' })];
  calls.length = 0;
  const r2 = await O.speak({ key: 'orca_sk_test_key_1', text: 'x', fetch: f });
  ok('503 waits once, then the answer (Aura: no words) comes through', calls.length === 2 && r2.words === null && r2.engine === 'aura');
  seq = [reply(400, { error: { message: 'input is too long' } })];
  let e2 = null; try { await O.speak({ key: 'orca_sk_test_key_1', text: 'x', fetch: f }); } catch (e) { e2 = e; }
  ok('another error says what Orca said', e2 && e2.code === 'tts' && /too long/.test(e2.message));
  let e3 = null; try { await O.speak({ key: '', text: 'x', fetch: f }); } catch (e) { e3 = e; }
  ok('no key asks for one before calling', e3 && e3.code === 'key');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
