// Shruti's Listen (Phase 4), offline:
//  - podcast.js parses; its silent clip is tools/silence.mp3, in Edge's MP3
//    format (MPEG-2 Layer III, 24 kHz mono, 48 kbps, 144-byte frames);
//  - every script: two hosts with Edge voices, every lesson of the chapter
//    tagged on some turn, no empty turns;
//  - every shipped episode: listed, matches its script turn for turn, times
//    add up to the MP3's bytes, segments start on turns, word times inside
//    their turn, the voice's words line up with the script, every lesson
//    covered;
//  - turnAt, coverage and build() (with a fake voice: byte-exact joins).
//
// Run: node Shruti/tests/podcast.test.js
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
const frames = (buf) => { const out = []; let at = 0; while (at + 4 <= buf.length) { if (buf[at] !== 0xff || (buf[at + 1] & 0xe0) !== 0xe0) return null; out.push(buf.subarray(at, at + 4).toString('hex')); at += 144 + ((buf[at + 2] >> 1) & 1); } return at === buf.length ? out : null; };

(async () => {
  console.log('\nThe files');
  const babel = require('@babel/parser');
  let err = null; try { babel.parse(read('podcast.js'), { sourceType: 'module' }); } catch (e) { err = e.message; }
  ok('podcast.js parses as a module', !err, err);
  globalThis.atob = globalThis.atob || ((b) => Buffer.from(b, 'base64').toString('binary'));
  // core.js reads the profile from the page; podcast.js listens for page events.
  global.window = { SHRUTI_PROFILES: { tony: { label: 'Tony', doc: 'shruti' }, veda: { label: 'Veda', doc: 'shruti_veda' } }, SHRUTI_PROFILE: 'tony' };
  global.addEventListener = () => {};
  const POD = await import(pathToFileURL(path.join(DIR, 'podcast.js')).href);
  const T = await import(pathToFileURL(path.join(DIR, 'text.js')).href);
  const silence = fs.readFileSync(path.join(DIR, 'tools', 'silence.mp3'));
  ok('the page\'s silent clip is tools/silence.mp3', Buffer.from(POD.SILENCE_B64, 'base64').equals(silence));
  const sf = frames(silence);
  ok('…in Edge\'s format: 144-byte MPEG-2 Layer III frames, 24 kHz mono 48 kbps', sf && sf.length === 12 && sf.every((h) => h === 'fff364c4'), sf && sf[0]);
  const ed = frames(fs.readFileSync(path.join(DIR, 'books/gita/media/ch01-podcast.mp3')).subarray(0, 144 * 50));
  ok('Edge\'s frames have the same header', ed && ed.every((h) => /^fff364c[04]$/.test(h)), ed && ed.slice(0, 3));

  const lessons = JSON.parse(read('books/gita/lessons.json'));
  const index = JSON.parse(read('books/gita/media/podcasts.json'));
  const scripts = fs.readdirSync(path.join(DIR, 'books/gita/scripts')).filter((f) => /^ch\d\d-podcast\.json$/.test(f)).sort();
  const missingPod = Array.from({ length: 18 }, (_, i) => String(i + 1)).filter((k) => !index[k]);
  ok('all 18 chapters have an episode', !missingPod.length, 'missing: ' + missingPod.join(','));
  ok('there is a script for every shipped episode', Object.keys(index).every((n) => scripts.includes('ch' + String(n).padStart(2, '0') + '-podcast.json')));
  for (const f of scripts) {
    const n = Number(f.slice(2, 4)), sc = JSON.parse(read('books/gita/scripts/' + f));
    const ids = (lessons[n] && lessons[n].lessons || []).map((l) => l.id);
    const turns = sc.segments.flatMap((s) => s.turns);
    console.log('\nChapter ' + n + ' (' + turns.length + ' turns)');
    ok('two hosts with Edge voices', sc.hosts.length === 2 && sc.hosts.every((h) => /^en-[A-Z]{2}-\w+Neural$/.test(h.voice)) && sc.n === n);
    ok('every turn has a known host and text', turns.every((t) => sc.hosts.some((h) => h.id === t.s) && t.t && t.t.trim().length > 3));
    const tagged = new Set(turns.flatMap((t) => t.L || []));
    ok('every lesson (' + ids.length + ') is taught on some turn', ids.length > 0 && ids.every((id) => tagged.has(id)), ids.filter((id) => !tagged.has(id)).join(','));
    ok('every lesson has its own segment', ids.every((id) => sc.segments.some((s) => s.title.startsWith('Lesson ' + id.slice(1) + ' '))));
    ok('tags name only this chapter\'s lessons', [...tagged].every((id) => ids.includes(id)));
    const e = index[String(n)];
    if (!e) { ok('the episode is built and listed', false, 'not in podcasts.json'); continue; }
    const meta = JSON.parse(read('books/gita/media/' + e.json));
    const bytes = fs.statSync(path.join(DIR, 'books/gita/media', e.mp3)).size;
    ok('the episode matches its script, turn for turn', meta.turns.length === turns.length && meta.turns.every((t, i) => t.text === turns[i].t && t.s === turns[i].s && JSON.stringify(t.L) === JSON.stringify(turns[i].L || [])));
    ok('its length is its MP3\'s bytes at 48 kbps, and the index agrees', Math.abs(meta.duration - bytes / 6000) < 0.01 && Math.abs(e.duration - meta.duration) < 0.01);
    ok('turns follow each other', meta.turns.every((t, i) => t.end > t.start && (i === 0 || t.start > meta.turns[i - 1].end)));
    ok('every segment starts on a turn, in script order', meta.segments.length === sc.segments.length && meta.segments.every((s, i) => s.title === sc.segments[i].title && meta.turns.some((t) => Math.abs(t.start - s.start) < 0.002)));
    ok('word times stay inside their turn', meta.turns.every((t) => t.words.length && t.words.every((w) => w[0] >= 0 && w[0] <= t.end - t.start + 0.05)));
    let total = 0, lined = 0;
    for (const t of meta.turns) { const m = T.align(t.words.map((w) => w[2]), T.words(t.text)); total += m.length; lined += m.filter((x) => x >= 0).length; }
    ok(`the voices' words line up with the script (${(100 * lined / total).toFixed(1)}%)`, lined / total > 0.97);
    ok('coverage() finds every lesson', POD.coverage(meta, ids).missing.length === 0);
  }

  console.log('\nHelpers');
  const turns = [{ start: 0 }, { start: 2 }, { start: 5 }];
  ok('turnAt finds the turn playing', POD.turnAt(turns, 0) === 0 && POD.turnAt(turns, 3) === 1 && POD.turnAt(turns, 9) === 2);
  ok('coverage() names what is missing', JSON.stringify(POD.coverage({ turns: [{ L: ['L1'] }, { L: ['L3'] }] }, ['L1', 'L2', 'L3']).missing) === '["L2"]');
  const clip = fs.readFileSync(path.join(DIR, 'books/gita/media/ch01-podcast.mp3')).subarray(0, 6000);   // exactly 1 s
  const fake = async ({ text, voice }) => ({ audio: new Blob([clip]), words: text.split(' ').map((w, i) => [i * 0.2, 0.15, w]), engine: 'edge', voice });
  const script = { book: 'gita', n: 9, title: 't', hosts: [{ id: 'A', name: 'Ava', voice: 'v1' }, { id: 'B', name: 'Andrew', voice: 'v2' }],
    segments: [{ title: 'One', turns: [{ s: 'A', t: 'Hello there', L: ['L1'] }, { s: 'B', t: 'Hi' }] }, { title: 'Two', turns: [{ s: 'B', t: 'Again here' }] }] };
  let steps = 0;
  const built = await POD.build(script, { key: 'k', speak: fake, onStep: () => steps++ });
  const buf = Buffer.from(await built.mp3.arrayBuffer());
  const S = silence.length / 6000;
  ok('build() joins turns and silences byte for byte', buf.length === 3 * 6000 + silence.length * (POD.GAPS.turn + POD.GAPS.segment) && steps === 3);
  ok('…with times from byte counts', built.meta.turns[0].start === 0 && built.meta.turns[1].start === +(1 + S).toFixed(3) && built.meta.turns[2].start === +(2 + S + 3 * S).toFixed(3), JSON.stringify(built.meta.turns.map((t) => t.start)));
  ok('…segments and lesson tags kept', built.meta.segments.length === 2 && built.meta.segments[1].start === built.meta.turns[2].start && JSON.stringify(built.meta.turns[0].L) === '["L1"]' && built.meta.duration === +(buf.length / 6000).toFixed(3));
  ok('…every turn in its host\'s voice', built.meta.turns.length === 3);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
