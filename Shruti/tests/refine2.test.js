// Refinements 2 (Tony, 2026-10-22), offline:
//  - every lesson has its detail for the Lessons popup (what it means, a
//    real-world example, one thing to try), concise, and its verse is in the
//    chapter as this rendition numbers it;
//  - every voice Shruti offers has a preview clip (whole Edge frames), and
//    every host pair is made of offered voices;
//  - host pairs are kept by id, and older choices (a place in the old list of
//    four) still find their pair;
//  - the shared player pieces (ptools.js) parse.
//
// Run: node Shruti/tests/refine2.test.js
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
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

(async () => {
  console.log('\nThe Lessons popup: every lesson\'s detail');
  const L = JSON.parse(read('books/gita/lessons.json'));
  const more = JSON.parse(read('books/gita/lessons-more.json'));
  const span = (v) => { const m = /^(\d+)\.(\d+)(?:-(\d+))?$/.exec(String(v || '')); return m ? [+m[1], +m[2], +(m[3] || m[2])] : null; };
  let all = 0, missing = [], long = [], badVerse = [], extra = [];
  for (const n of Object.keys(L)) {
    const ch = JSON.parse(read('books/gita/ch' + n.padStart(2, '0') + '.json'));
    for (const l of L[n].lessons) {
      all++;
      const d = more[n] && more[n][l.id];
      if (!d || !d.meaning || !d.example || !d.practice) { missing.push(n + ' ' + l.id); continue; }
      if (words(d.meaning) > 80 || words(d.example) > 80 || words(d.practice) > 30) long.push(n + ' ' + l.id);
      if (d.verses) {
        const w = span(d.verses);
        const hit = w && w[0] === Number(n) && ch.blocks.some((b) => (b.s || []).some((x) => { const q = span(x.v); return q && q[0] === w[0] && q[1] <= w[1] && w[1] <= q[2]; }));
        if (!hit) badVerse.push(n + ' ' + l.id + ' ' + d.verses);
      }
    }
    for (const id of Object.keys(more[n] || {})) if (!L[n].lessons.some((l) => l.id === id)) extra.push(n + ' ' + id);
  }
  ok('every one of the ' + all + ' lessons has what it means, an example and one thing to try', !missing.length, missing.join(', '));
  ok('…each concise (meaning and example up to 80 words, the try up to 30)', !long.length, long.join(', '));
  ok('…every verse named is in its chapter, as this rendition numbers it', !badVerse.length, badVerse.join(', '));
  ok('…and no detail for a lesson that is not there', !extra.length, extra.join(', '));
  ok('most lessons name their verse', Object.values(more).filter((x) => typeof x === 'object').reduce((s, c) => s + Object.values(c).filter((d) => d.verses).length, 0) >= all - 10);
  const lib = read('library.js');
  ok('the popup has arrows, keys and swipe', /data-step="-1"/.test(lib) && /data-step="1"/.test(lib) && /ArrowRight/.test(lib) && /touchend/.test(lib));
  ok('the lesson list opens it', /data-li=/.test(lib) && /openLesson\(/.test(lib));

  console.log('\nVoice previews');
  const orca = read('orca.js');
  const block = orca.slice(orca.indexOf('export const VOICES = ['), orca.indexOf('].map(', orca.indexOf('export const VOICES = [')));
  const voices = [...block.matchAll(/\['([a-zA-Z-]+Neural)'/g)].map((m) => m[1]);
  ok('the offered voices are read (' + voices.length + ')', voices.length >= 18);
  const noClip = [], badClip = [];
  for (const v of voices) {
    const f = path.join(DIR, 'media', 'voices', v + '.mp3');
    if (!fs.existsSync(f)) { noClip.push(v); continue; }
    const b = fs.readFileSync(f);
    if (b.length < 6000 || b.length % 144) badClip.push(v + ' ' + b.length);
  }
  ok('every offered voice has a preview clip', !noClip.length, noClip.join(', '));
  ok('…each a real clip in whole Edge frames (over a second)', !badClip.length, badClip.join(', '));
  ok('narrate.js plays the clip, Orca only for a voice without one', /media\/voices\//.test(read('narrate.js')) && /export function stopPreview/.test(read('narrate.js')));
  ok('the podcast pairs, the narrator list, any two voices and Build everything can all be heard', (() => {
    const mk = read('make.js');
    return /data-try="' \+ esc\(h\.hosts\[0\]\[1\] \+ ','/.test(mk) && /data-try-sel=/.test(mk) && /tryChip\(/.test(mk) && /data-try=/.test(read('study/slides.js'));
  })());

  console.log('\nHost pairs');
  global.window = { SHRUTI_PROFILES: { tony: { label: 'Tony', doc: 'shruti' }, veda: { label: 'Veda', doc: 'shruti_veda' } }, SHRUTI_PROFILE: 'tony' };
  global.addEventListener = () => {};
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.document = { addEventListener() {}, querySelector: () => null };
  const G = await import(pathToFileURL(path.join(DIR, 'generate.js')).href);
  const ids = G.HOST_PRESETS.map((h) => h.id);
  ok('pairs have unique ids', new Set(ids).size === ids.length);
  ok('the default pair is Sonia and Ryan, first in the list (Tony, 2026-10-22)', G.HOST_PRESETS[0].id === 'sonia-ryan' && G.hostsOf({})[0].voice === 'en-GB-SoniaNeural' && G.hostsOf({})[1].voice === 'en-GB-RyanNeural' && G.HOST_PRESETS[1].id === 'sonia-brian');
  ok('each pair is two offered voices', G.HOST_PRESETS.every((h) => h.hosts.length === 2 && h.hosts.every(([, v]) => voices.includes(v))), G.HOST_PRESETS.filter((h) => !h.hosts.every(([, v]) => voices.includes(v))).map((h) => h.name).join());
  ok('the default is the first pair', G.hostsOf({})[0].voice === G.HOST_PRESETS[0].hosts[0][1]);
  ok('an old choice by place still finds its pair (2 was Sonia & Ryan)', G.presetId(2) === 'sonia-ryan' && G.hostsOf({ hosts: 2 })[0].voice === 'en-GB-SoniaNeural' && G.presetId(1) === 'ava-andrew');
  ok('a new choice is kept by id', G.hostsOf({ hosts: 'emily-connor' })[1].voice === 'en-IE-ConnorNeural');
  ok('an unknown choice falls back to the default', G.presetId('nope') === ids[0] && G.presetId(99) === ids[0]);

  console.log('\nThe player pieces');
  const babel = require('@babel/parser');
  for (const f of ['ptools.js', 'podcast.js', 'video.js', 'study/hub.js', 'study/flashcards.js', 'study/mindmap.js', 'import.js']) {
    let err = null; try { babel.parse(read(f), { sourceType: 'module' }); } catch (e) { err = e.message; }
    ok(f + ' parses as a module', !err, err);
  }
  ok('Listen and Watch open their speeds only from the speed pill', /speedHTML\(\)/.test(read('podcast.js')) && /speedHTML\(\)/.test(read('video.js')) && /tl-speeds" id="tl-speeds" role="radiogroup" aria-label="Speed" hidden/.test(read('ptools.js')));
  ok('the lessons under Listen and Watch fold', /foldHTML\('podLessons'/.test(read('podcast.js')) && /foldHTML\('vidLessons'/.test(read('video.js')));
  ok('a flashcard mark can be taken back', /DELETE/.test(read('study/flashcards.js')) && /aria-pressed/.test(read('study/flashcards.js')));
  ok('mind map nodes opt out of the hover filter', /data-no-hoverfx/.test(read('study/mindmap.js')));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
