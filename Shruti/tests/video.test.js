// Shruti's Watch (Phase 5), offline:
//  - video.js parses and loads in Node (its timing helpers have no DOM);
//  - every chapter has a scene script and a built video;
//  - every script: one Edge narrator (Sonia, who is also a podcast host since
//    Tony chose her for both, 2026-10-22), known layouts,
//    a title first and a summary last, every lesson of the chapter taught on
//    its own scene, verses that exist in the book, on-screen text that fits;
//  - every built video: listed, matches its script scene for scene, verse
//    text exactly as the book prints it, times add up to the MP3's bytes,
//    scenes follow each other, word times inside their scene, the voice's
//    words line up with the script, every lesson covered;
//  - sceneAt, coverage, cuesFor and tokenAt.
//
// Run: node Shruti/tests/video.test.js
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
const pad = (ref) => { const [c, v] = ref.split('.'); return c + '.' + v.split('-').map((p) => p.padStart(2, '0')).join('-'); };
const XREF = /\s*\((?:also\s+)?see\b[^)]*\)/gi;

(async () => {
  console.log('\nThe files');
  const babel = require('@babel/parser');
  let err = null; try { babel.parse(read('video.js'), { sourceType: 'module' }); } catch (e) { err = e.message; }
  ok('video.js parses as a module', !err, err);
  global.window = { SHRUTI_PROFILES: { tony: { label: 'Tony', doc: 'shruti' }, veda: { label: 'Veda', doc: 'shruti_veda' } }, SHRUTI_PROFILE: 'tony' };
  global.addEventListener = () => {};
  const VID = await import(pathToFileURL(path.join(DIR, 'video.js')).href);
  const T = await import(pathToFileURL(path.join(DIR, 'text.js')).href);
  ok('it loads in Node and names its seven layouts', VID.LAYOUTS.join() === 'title,verse,story,lesson,compare,steps,closing');
  ok('the library lights Watch from videos.json', /VID\.shipped\(id\)/.test(read('library.js')) && /vids && vids\[String\(n\)\]/.test(read('library.js')));

  const lessons = JSON.parse(read('books/gita/lessons.json'));
  const index = JSON.parse(read('books/gita/media/videos.json'));
  const scripts = fs.readdirSync(path.join(DIR, 'books/gita/scripts')).filter((f) => /^ch\d\d-video\.json$/.test(f)).sort();
  const missing = Array.from({ length: 18 }, (_, i) => String(i + 1)).filter((k) => !index[k]);
  ok('all 18 chapters have a video', !missing.length, 'missing: ' + missing.join(','));
  ok('there is a script for every shipped video', Object.keys(index).every((n) => scripts.includes('ch' + String(n).padStart(2, '0') + '-video.json')));

  let total = 0;
  for (const f of scripts) {
    const n = Number(f.slice(2, 4)), sc = JSON.parse(read('books/gita/scripts/' + f));
    const L = (lessons[n] && lessons[n].lessons) || [], ids = L.map((l) => l.id);
    const ch = JSON.parse(read('books/gita/ch' + String(n).padStart(2, '0') + '.json'));
    const verses = {}; ch.blocks.filter((b) => b.k === 'p').forEach((b) => b.s.forEach((s) => { if (s.v) verses[s.v] = s; }));
    console.log('\nChapter ' + n + ' (' + sc.scenes.length + ' scenes)');
    ok('one narrator, an Edge voice', sc.n === n && /^en-[A-Z]{2}-\w+Neural$/.test(sc.narrator.voice) && sc.narrator.name);
    ok('known layouts; a title first and a summary last', sc.scenes.every((s) => VID.LAYOUTS.includes(s.layout)) && sc.scenes[0].layout === 'title' && sc.scenes[sc.scenes.length - 1].layout === 'closing');
    ok('every scene says something (a verse scene at least names its verse)', sc.scenes.every((s) => s.say && s.say.trim().split(/\s+/).length >= (s.layout === 'verse' ? 3 : 8)));
    const tagged = new Set(sc.scenes.flatMap((s) => s.L || []));
    ok('every lesson (' + ids.length + ') is taught', ids.length > 0 && ids.every((id) => tagged.has(id)), ids.filter((id) => !tagged.has(id)).join(','));
    ok('…each on its own lesson scene', ids.every((id) => sc.scenes.some((s) => ['lesson', 'compare', 'steps'].includes(s.layout) && (s.L || [])[0] === id && /^Lesson /.test(s.say.trim()))), ids.filter((id) => !sc.scenes.some((s) => (s.L || [])[0] === id && /^Lesson /.test(s.say.trim()))).join(','));
    ok('…in order', (() => { const firsts = ids.map((id) => sc.scenes.findIndex((s) => (s.L || [])[0] === id && /^Lesson /.test(s.say.trim()))); return firsts.every((x, i) => i === 0 || x > firsts[i - 1]); })());
    ok('tags name only this chapter\'s lessons', [...tagged].every((id) => ids.includes(id)));
    const vs = sc.scenes.filter((s) => s.layout === 'verse');
    ok('verse scenes (' + vs.length + ') name verses in the book and say {verse}', vs.every((s) => verses[pad(s.ref)] && s.say.includes('{verse}')), vs.filter((s) => !verses[pad(s.ref)]).map((s) => s.ref).join(','));
    ok('{verse} only on verse scenes', sc.scenes.every((s) => s.layout === 'verse' || !s.say.includes('{verse}')));
    ok('story scenes mark what goes beyond this rendition', sc.scenes.filter((s) => s.beyond).every((s) => /full Gita|Mahabharata|leaves out|our book (skips|leaves|does not)|not in (this|our) book|beyond (this|our)/i.test(s.say)));
    // A compare row is two sides, each in half the width.
    const long = (s, v) => s.layout === 'compare' ? v.split('|').some((x) => x.trim().length > 48) : v.length > 64;
    ok('on-screen text fits: headlines ≤ 64, items ≤ 64 (≤ 48 a side), ≤ 4 points, ≤ 6 steps', sc.scenes.every((s) => (s.headline || '').length <= 64 && !(s.visual || []).some((v) => long(s, v)) && (s.visual || []).length <= (s.layout === 'steps' ? 6 : s.layout === 'compare' ? 5 : 4)),
      sc.scenes.filter((s) => (s.headline || '').length > 64 || (s.visual || []).some((v) => long(s, v))).map((s) => (s.headline || '').length > 64 ? s.headline : s.visual.find((v) => long(s, v))).join(' | '));
    ok('content scenes have a headline and points; compare rows have two sides', sc.scenes.every((s) => !['story', 'compare', 'steps', 'closing'].includes(s.layout) || (s.headline && s.visual.length >= 2)) && sc.scenes.filter((s) => s.layout === 'compare').every((s) => s.visual.every((r) => r.split('|').length === 2)));

    const e = index[String(n)];
    if (!e) { ok('the video is built and listed', false, 'not in videos.json'); continue; }
    const meta = JSON.parse(read('books/gita/media/' + e.json));
    const mp3 = fs.readFileSync(path.join(DIR, 'books/gita/media', e.mp3));
    total += meta.duration;
    ok('the video matches its script, scene for scene', meta.scenes.length === sc.scenes.length && meta.scenes.every((m, i) => {
      const s = sc.scenes[i];
      const say = s.layout === 'verse' ? s.say.replace('{verse}', verses[pad(s.ref)].t.replace(XREF, '').trim()) : s.say.trim();
      return m.layout === s.layout && m.say === say && JSON.stringify(m.L) === JSON.stringify(s.L || []) && JSON.stringify(m.visual) === JSON.stringify(s.visual || []) &&
        (s.headline ? m.headline === s.headline : s.layout !== 'lesson' || m.headline === L.find((l) => l.id === s.L[0]).title);
    }));
    ok('verses on screen are exactly the book\'s', meta.scenes.filter((m) => m.layout === 'verse').every((m) => m.verse === verses[m.ref].t && m.key === !!verses[m.ref].key));
    ok('…and their words are the ones the voice reads (vs)', meta.scenes.filter((m) => m.layout === 'verse').every((m) => m.say.split(/\s+/).slice(m.vs[0], m.vs[1]).join(' ') === m.verse.replace(XREF, '').trim()));
    ok('its length is its MP3\'s bytes at 48 kbps, and the index agrees', Math.abs(meta.duration - mp3.length / 6000) < 0.01 && Math.abs(e.duration - meta.duration) < 0.01 && e.scenes === meta.scenes.length);
    const fr = frames(mp3);
    ok('the MP3 is whole Edge frames throughout', !!fr && fr.every((h) => /^fff364c[04]$/.test(h)), fr ? fr.find((h) => !/^fff364c[04]$/.test(h)) : 'not frames');
    ok('scenes follow each other with no gap', meta.scenes[0].start === 0 && meta.scenes.every((m, i) => m.end > m.at && m.at > m.start && (i === 0 || Math.abs(m.start - meta.scenes[i - 1].end) < 0.002)) && Math.abs(meta.scenes[meta.scenes.length - 1].end - meta.duration) < 0.002);
    ok('word times stay inside their scene', meta.scenes.every((m) => m.words.length && m.words.every((w) => w[0] >= 0 && m.at + w[0] <= m.end)));
    let all = 0, lined = 0;
    for (const m of meta.scenes) { const map = T.align(m.words.map((w) => w[2]), T.words(m.say)); all += map.length; lined += map.filter((x) => x >= 0).length; }
    ok(`the voice's words line up with the script (${(100 * lined / all).toFixed(1)}%)`, lined / all > 0.97);
    ok('coverage() finds every lesson', VID.coverage(meta, ids).missing.length === 0);
    VID.prepare(meta);
    ok('every scene has captions covering every word in order', meta.scenes.every((m) => { const c = m.cc.cues; return c.length && c[0].from === 0 && c[c.length - 1].to === m.cc.toks.length && c.every((q, i) => q.to > q.from && (i === 0 || (q.from === c[i - 1].to && q.t0 >= c[i - 1].t0))); }));
    ok('…a verse is its own caption piece', meta.scenes.filter((m) => m.vs).every((m) => m.cc.cues.some((q) => q.from === m.vs[0]) && m.cc.cues.some((q) => q.to === m.vs[1])));
  }
  console.log('\nAll videos: ' + (total / 60).toFixed(1) + ' minutes');

  console.log('\nHelpers');
  const scenes = [{ start: 0 }, { start: 4 }, { start: 9.5 }];
  ok('sceneAt finds the scene showing', VID.sceneAt(scenes, 0) === 0 && VID.sceneAt(scenes, 4) === 1 && VID.sceneAt(scenes, 9.4) === 1 && VID.sceneAt(scenes, 99) === 2);
  ok('coverage() names what is missing', JSON.stringify(VID.coverage({ scenes: [{ L: ['L1'] }, { L: ['L3'] }] }, ['L1', 'L2', 'L3']).missing) === '["L2"]');
  const say = 'Verse eleven. You grieve for those — who are not worthy, of grief.';
  const words = ['Verse', 'eleven', 'You', 'grieve', 'for', 'those', 'who', 'are', 'not', 'worthy', 'of', 'grief'].map((w, i) => [i * 0.5, 0.4, w]);
  const cc = VID.cuesFor({ say, words, vs: [2, 12] });
  ok('cuesFor keeps every token, punctuation and dashes too', cc.toks.join(' ') === say && cc.cues[cc.cues.length - 1].to === cc.toks.length);
  ok('…breaks where the verse starts', cc.cues.some((q) => q.to === 2 && q.from === 0));
  ok('…a token the voice skipped (the dash) takes the time before it', cc.at[6] === cc.at[5]);
  ok('tokenAt follows the voice', VID.tokenAt(cc, words, 0) === 0 && VID.tokenAt(cc, words, 1.1) === 2 && VID.tokenAt(cc, words, 3.1) === 7 && VID.tokenAt(cc, words, -1) === -1, [0, 1.1, 3.1].map((t) => VID.tokenAt(cc, words, t)).join());

  console.log('\nThe artwork (art.js) and the music (2026-10-22)');
  const ART = await import(pathToFileURL(path.join(DIR, 'art.js')).href);
  const FMT = await import(pathToFileURL(path.join(DIR, 'formats.js')).href);
  ok('every artwork a unit may name has a drawing', FMT.ART.every((a) => ART.MOTIFS.includes(a)), FMT.ART.filter((a) => !ART.MOTIFS.includes(a)).join());
  ok('a scene\'s own art is used, unknown names dropped', ART.pick({ art: ['lotus', 'zebra', 'conch'] }).join() === 'lotus,conch');
  ok('words choose it for the shipped scripts', ART.pick({ layout: 'story', headline: 'The conches sound', say: 'Krishna blew his conch.' })[0] === 'conch' && ART.pick({ layout: 'story', headline: 'A warrior in tears', say: 'Arjuna sat in his chariot.' }).includes('chariot'));
  let scenesArt = 0, story = 0;
  for (let n = 1; n <= 18; n++) {
    const sc = JSON.parse(fs.readFileSync(path.join(DIR, 'books', 'gita', 'scripts', 'ch' + String(n).padStart(2, '0') + '-video.json'), 'utf8')).scenes.filter((s) => s.layout === 'story');
    story += sc.length; scenesArt += sc.filter((s) => ART.pick(s).every((a) => ART.MOTIFS.includes(a)) && ART.pick(s).length).length;
  }
  ok('every story scene of all 18 shipped videos gets artwork (' + story + ')', scenesArt === story && story > 0);
  const music = JSON.parse(fs.readFileSync(path.join(DIR, 'media', 'music', 'index.json'), 'utf8'));
  ok('the two music loops are there, as video.js names them', VID.BEDS.every((b) => fs.existsSync(path.join(DIR, b)) && fs.statSync(path.join(DIR, b)).size > 500000) && Object.keys(music).length === 2);
  const mp3 = fs.readFileSync(path.join(DIR, 'media', 'music', 'dawn.mp3'));
  ok('…real MP3 (an MPEG frame at the start)', mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
