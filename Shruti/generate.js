// Make with AI: a podcast, a video, lessons or a read-aloud for any chapter,
// through Orca with the person's own key (Phase 6). The Gita ships with all of
// these; this is for imported books, other voices or lengths, and re-makes.
//
// The pipeline, the same for every kind:
//   1. the chapter's exact text and its lessons go into the prompt (long text
//      as attached .txt files, as StudyOS sends it);
//   2. Orca streams the reply through the person's chain of units;
//   3. the JSON is parsed tolerantly and normalised;
//   4. every lesson must be taught: if any is missing, the same model is asked
//      once to add it (auto-repair), and the checklist shows the result;
//   5. podcast and video are spoken in Edge voices and joined byte for byte
//      (podcast.js build(), video.js build()); read-aloud is narrate.js's;
//   6. uploaded to Drive and kept as a new version that plays at once
//      (media.js); without Drive it plays on this device only;
//   7. while it runs, jobs.<book>.ch<n>.<kind> tells the other devices.
// Verses on screen are copied from the book, never from the model.

import * as C from './core.js';
import * as O from './orca.js';
import * as T from './text.js';
import * as M from './media.js';
import * as POD from './podcast.js';
import * as VID from './video.js';
import * as NR from './narrate.js';

let ui = { toast: () => {}, go: () => {}, openSettings: () => {} };
export function setUI(x) { ui = Object.assign(ui, x); }
const keyOf = () => String(C.me.get('orcaKey', '') || '');

export const LENGTHS = {
  concise: { label: 'Concise', podcast: 30, video: 12, lessons: 6 },
  standard: { label: 'Standard', podcast: 55, video: 20, lessons: 9 },
  deep: { label: 'Deep', podcast: 85, video: 28, lessons: 12 },
};
export const HOST_PRESETS = [
  { name: 'Ava & Andrew', hosts: [['Ava', 'en-US-AvaMultilingualNeural'], ['Andrew', 'en-US-AndrewMultilingualNeural']] },
  { name: 'Emma & Brian', hosts: [['Emma', 'en-US-EmmaMultilingualNeural'], ['Brian', 'en-US-BrianMultilingualNeural']] },
  { name: 'Sonia & Ryan', hosts: [['Sonia', 'en-GB-SoniaNeural'], ['Ryan', 'en-GB-RyanNeural']] },
  { name: 'Neerja & Prabhat', hosts: [['Neerja', 'en-IN-NeerjaNeural'], ['Prabhat', 'en-IN-PrabhatNeural']] },
];
export const prefs = () => Object.assign({ kind: 'podcast', length: 'standard', hosts: 0, hostA: null, hostB: null, narrator: 'en-US-BrianMultilingualNeural', voice: O.DEFAULT_VOICE, extra: '' }, C.me.get('gen', {}) || {});
export function setPref(k, v) { C.me.set({ ['gen.' + k]: v }); }
const voiceName = (id) => NR.voiceName(id);

/* ── the prompt ──────────────────────────────────────────────────────────── */
/** The chapter as the model reads it: headings, [verse] numbers, asides. */
export function sourceText(ch) {
  return (ch && ch.blocks || []).map((b) => {
    if (b.k === 'h') return '## ' + b.t;
    if (b.k === 'a') return '(' + b.t + ')';
    return (b.s || []).map((s) => (s.v ? '[' + s.v + '] ' : '') + s.t).join('\n');
  }).join('\n\n');
}
export const lessonsText = (L) => ((L && L.lessons) || []).map((l) => l.id + ': ' + (l.title || '') + (l.body ? ' — ' + l.body : '')).join('\n');

const SHARED_RULES = [
  'Write for the ear: natural spoken English, no markdown, no stage directions, no emojis. Write numbers and verse numbers as words where they are spoken ("verse forty-seven").',
  'Stay faithful to the source text. When you quote it, quote it exactly. When you add anything that is not in this text (background, the wider tradition, other translations), say so in the words themselves ("this part is not in our book").',
];
/** The messages for one kind. o: {kind, book, title, n, ch, lessons, length, hosts, extra}. */
export function buildPrompt(o) {
  const L = (o.lessons && o.lessons.lessons) || [], len = LENGTHS[o.length] || LENGTHS.standard;
  const what = (o.book === 'gita' ? 'the Bhagavad-Gita (the IGS rendition by Ramananda Prasad)' : 'the book "' + (o.bookTitle || o.book) + '"');
  const head = 'This is chapter ' + o.n + ' ("' + o.title + '") of ' + what + '.';
  const lessonRule = L.length
    ? 'Teach EVERY one of these ' + L.length + ' lessons (they are the readers\' own notes), in order, each in its own part, and tag each part with its lesson id: ' + L.map((l) => l.id).join(', ') + '.'
    : 'There are no lesson notes for this chapter: teach its main ideas clearly.';
  let task, format;
  if (o.kind === 'podcast') {
    const [a, b] = o.hosts;
    task = [
      'Write a two-host podcast episode about this chapter. Host A is ' + a.name + ', host B is ' + b.name + '. They are warm, curious and precise, and they talk with each other, not at the listener.',
      'Start with a short welcome, then tell the chapter\'s story in order, with its key passages quoted exactly, then the lessons, then a short wrap-up that points to the next chapter.',
      lessonRule + ' A lesson part is titled "Lesson N · a short title".',
      'About ' + len.podcast + ' turns in all; each turn one to four sentences.',
    ];
    format = '{"segments":[{"title":"Welcome","turns":[{"s":"A","t":"…","L":[]}]},{"title":"The story","turns":[…]},{"title":"Lesson 1 · …","turns":[{"s":"B","t":"…","L":["L1"]}]},{"title":"Wrap-up","turns":[…]}]}';
  } else if (o.kind === 'video') {
    task = [
      'Write a narrated explainer video about this chapter as a list of scenes. One narrator speaks every scene; the picture is drawn from each scene\'s layout and on-screen text.',
      'Layouts: "title" (first scene: headline = the chapter title, visual = one subtitle), "story" (headline + 2-4 short visual points), "verse" (ref = a verse number from the [brackets] in the source, e.g. "2.47"; its say contains {verse} exactly where the verse is read, and the app fills in the book\'s own words), "lesson" (L = [its id]; visual = 2-3 short points; headline may be left empty), "compare" (headline + visual rows "left | right", the first row being the two column titles), "steps" (headline + 3-6 very short steps), "closing" (last scene: headline + 3 short takeaways).',
      lessonRule + ' A lesson\'s own scene has layout lesson, compare or steps, its L, and its say starts "Lesson N."',
      'Tell the chapter\'s story first, with its most important verses as verse scenes, then the lessons, then the closing. Set "beyond": true on a story scene that tells something not in this text.',
      'On-screen text is short: headlines up to 60 characters, each visual item up to 60 (a compare side up to 45). Each say is 2-5 sentences. About ' + len.video + ' scenes.',
    ];
    format = '{"scenes":[{"layout":"title","headline":"…","visual":["…"],"say":"…"},{"layout":"story","headline":"…","visual":["…","…"],"say":"…","L":[]},{"layout":"verse","ref":"2.47","say":"… {verse}","L":[]},{"layout":"lesson","L":["L1"],"visual":["…","…"],"say":"Lesson one. …"},{"layout":"closing","headline":"…","visual":["…","…","…"],"say":"…"}]}';
  } else {
    task = [
      'Write the lessons a careful reader takes from this chapter: ' + len.lessons + ' or so, in the order the chapter teaches them.',
      'Each lesson has a title (one plain sentence that states it, at most ' + LESSON_TITLE_WORDS + ' words) and a body of one or two short sentences, at most ' + LESSON_BODY_WORDS + ' words: what the chapter teaches there and how to live it.',
      'Be concise, true and to the point: say only what this chapter says, no filler, no flourishes, no retelling, and do not repeat the title in the body.',
      'Then a summary of the chapter in two or three sentences.',
    ];
    format = '{"lessons":[{"id":"L1","title":"…","body":"…"}],"summary":"…"}';
  }
  const sys = 'You write study media for Shruti, a reading app. ' + SHARED_RULES.join(' ') + ' Reply with ONLY the JSON object described, nothing before or after it.';
  const user = head + '\n\n' + task.join('\n') + (o.extra ? '\n\nThe reader also asks: ' + o.extra : '') +
    '\n\nReply format (JSON only):\n' + format +
    '\n\n<source>\n' + sourceText(o.ch) + '\n</source>' +
    (L.length && o.kind !== 'lessons' ? '\n\n<lessons>\n' + lessonsText(o.lessons) + '\n</lessons>' : '');
  return [{ role: 'system', content: sys }, { role: 'user', content: spill(user) }];
}

/* Long asks: the big blocks go as attached .txt files (StudyOS's spillText). */
export const SPILL_CHARS = 12000;
function b64utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function spill(text) {
  if (text.length <= SPILL_CHARS) return text;
  const files = [];
  let out = text;
  for (const tag of ['source', 'lessons']) {
    const m = out.match(new RegExp('<' + tag + '>\\n?([\\s\\S]*?)\\n?</' + tag + '>'));
    if (!m || m[1].length < 2000) continue;
    files.push({ type: 'file', file: { filename: tag + '.txt', file_data: 'data:text/plain;base64,' + b64utf8(m[1]) } });
    out = out.replace(m[0], '<' + tag + '>\n(in the attached file ' + tag + '.txt; read ALL of it)\n</' + tag + '>');
  }
  if (out.length > SPILL_CHARS) {
    files.push({ type: 'file', file: { filename: 'request.txt', file_data: 'data:text/plain;base64,' + b64utf8(out) } });
    out = 'Your complete task is in the attached file request.txt. Read ALL of it, then do exactly what it says, including its reply format.';
  }
  return [{ type: 'text', text: out }, ...files];
}

/* ── reading the reply ───────────────────────────────────────────────────── */
/** The JSON object in a reply: fences, chatter and trailing commas forgiven. */
export function parseJSON(text) {
  let s = String(text || '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('The reply had no JSON in it.');
  s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch (e) {}
  const fixed = s.replace(/[“”]/g, '"').replace(/,\s*([\]}])/g, '$1');
  try { return JSON.parse(fixed); } catch (e) { throw new Error('The reply\'s JSON could not be read (' + e.message + ').'); }
}
const str = (x, max) => { const s = String(x == null ? '' : x).replace(/\s+/g, ' ').trim(); return max && s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : s; };
const ids = (x, known) => (Array.isArray(x) ? x : x ? [x] : []).map((v) => String(v).toUpperCase().replace(/^(\d+)$/, 'L$1')).filter((v) => known.has(v));

/** A podcast script from a parsed reply: hosts A/B, empty turns dropped. */
export function normPodcast(obj, hosts, lessonIds) {
  const known = new Set(lessonIds);
  const segs = (Array.isArray(obj && obj.segments) ? obj.segments : []).map((sg, i) => ({
    title: str(sg.title, 80) || (i ? 'Part ' + (i + 1) : 'Welcome'),
    turns: (Array.isArray(sg.turns) ? sg.turns : []).map((t, k) => {
      const who = String(t.s || t.speaker || '').trim();
      const s = /^b$/i.test(who) || (hosts[1] && who === hosts[1].name) ? 'B' : /^a$/i.test(who) || (hosts[0] && who === hosts[0].name) ? 'A' : (k % 2 ? 'B' : 'A');
      return { s, t: str(t.t || t.text), L: ids(t.L || t.lessons, known) };
    }).filter((t) => t.t.length > 1),
  })).filter((sg) => sg.turns.length);
  if (!segs.length) throw new Error('The reply had no podcast turns.');
  return { segments: segs };
}
/** A video script from a parsed reply (layouts checked; text trimmed to fit). */
export function normVideo(obj, lessonIds) {
  const known = new Set(lessonIds);
  const scenes = (Array.isArray(obj && obj.scenes) ? obj.scenes : []).map((sc) => {
    const layout = VID.LAYOUTS.includes(String(sc.layout || '').toLowerCase()) ? String(sc.layout).toLowerCase() : 'story';
    const vis = (Array.isArray(sc.visual) ? sc.visual : sc.visual ? [sc.visual] : []).map((v) => str(v, layout === 'compare' ? 100 : 64)).filter(Boolean);
    const out = { layout, headline: str(sc.headline, 64), visual: vis.slice(0, layout === 'steps' ? 6 : layout === 'compare' ? 5 : 4), say: str(sc.say || sc.narration), L: ids(sc.L || sc.lessons, known) };
    if (layout === 'verse') out.ref = str(sc.ref);
    if (sc.beyond) out.beyond = true;
    return out;
  }).filter((s) => s.say);
  if (!scenes.length) throw new Error('The reply had no video scenes.');
  return { scenes };
}
/** How long a made lesson may be (Tony, 2026-10-20: "concise, true, to the
 *  point"). The prompt asks for it; a reply over it is sent back once to shorten. */
export const LESSON_TITLE_WORDS = 12, LESSON_BODY_WORDS = 40;
const wordCount = (t) => String(t || '').split(/\s+/).filter(Boolean).length;
/** The lessons that run long (a little slack over the asked-for limits). */
export function longLessons(script) {
  return ((script && script.lessons) || []).filter((l) => wordCount(l.body) > LESSON_BODY_WORDS + 15 || wordCount(l.title) > LESSON_TITLE_WORDS + 4).map((l) => l.id);
}
/** Lessons from a parsed reply, numbered L1… in order. */
export function normLessons(obj) {
  const lessons = (Array.isArray(obj && obj.lessons) ? obj.lessons : []).map((l) => ({ title: str(l.title, 160), body: str(l.body) })).filter((l) => l.title)
    .map((l, i) => Object.assign({ id: 'L' + (i + 1) }, l));
  if (!lessons.length) throw new Error('The reply had no lessons.');
  return { lessons, summary: str(obj.summary) };
}
/** Which lessons a script teaches. */
export function coverage(kind, script, lessonIds) {
  const have = new Set(kind === 'podcast' ? script.segments.flatMap((s) => s.turns.flatMap((t) => t.L)) : kind === 'video' ? script.scenes.flatMap((s) => s.L) : lessonIds);
  return { covered: lessonIds.filter((id) => have.has(id)), missing: lessonIds.filter((id) => !have.has(id)) };
}

/* ── one run ─────────────────────────────────────────────────────────────── */
/** Make one thing. o: {kind, book, bookTitle, n, title, ch, lessons, length,
 *  hosts:[{id,name,voice}], narrator:{name,voice}, voice, extra, models}.
 *  on: {stage(id, text), delta(t), model(m), coverage(cov), step(done, total)}.
 *  Resolves {kind, script?, rec?, local?, model?}. */
export async function run(o, on = {}, { signal, chat = O.chat, speak = O.speak, saveDrive } = {}) {
  const key = keyOf(), book = o.book, n = o.n, kind = o.kind;
  const stage = (id, text, extra) => { on.stage && on.stage(id, text); M.job(book, n, kind, Object.assign({ kind, stage: id, text }, extra || {}), { now: true }); };
  let lastPct = -1;
  const step = (done, total) => {
    on.step && on.step(done, total);
    const pct = Math.floor(10 * done / total);
    if (pct !== lastPct) { lastPct = pct; M.job(book, n, kind, { kind, stage: 'speak', text: 'Speaking ' + done + ' of ' + total, done, total }, { lazy: done < total }); }
  };
  if (!key) throw Object.assign(new Error('Making needs your Orca key (Settings).'), { code: 'key' });
  const L = (o.lessons && o.lessons.lessons) || [], lessonIds = kind === 'lessons' ? [] : L.map((l) => l.id);
  const drive = saveDrive != null ? saveDrive : await M.driveReady();
  try {
    if (kind === 'read') {
      if (!drive) throw new Error('Google Drive is not connected yet (Settings → Google Drive). A read-aloud is kept there.');
      stage('speak', 'Speaking the chapter in ' + voiceName(o.voice));
      const rec = await NR.saveNarration({ book, n, ch: o.ch, title: o.title }, o.voice, step, () => stage('upload', 'Uploading to Drive'), {});
      stage('done', 'Saved');
      return { kind, rec };
    }
    // 1-2: write.
    stage('write', 'Writing');
    const messages = buildPrompt(o);
    let text = '', model = null;
    const ask = async (msgs, models) => {
      const r = await chat({ key, messages: msgs, models, signal, onDelta: (t) => { on.delta && on.delta(t); }, onModel: (m) => { model = m; on.model && on.model(m); M.job(book, n, kind, { kind, stage: 'write', text: 'Writing', model: m }, { lazy: true }); } });
      return r;
    };
    let r = await ask(messages, o.models);
    text = r.text; model = r.model;
    // 3-4: read, check, repair once.
    stage('check', 'Checking');
    const norm = (t) => {
      const obj = parseJSON(t);
      return kind === 'podcast' ? normPodcast(obj, o.hosts, lessonIds) : kind === 'video' ? normVideo(obj, lessonIds) : normLessons(obj);
    };
    let script = null, problem = null;
    try { script = norm(text); } catch (e) { problem = e.message; }
    let cov = script ? coverage(kind, script, lessonIds) : { covered: [], missing: lessonIds };
    on.coverage && on.coverage(cov);
    const long = !problem && kind === 'lessons' ? longLessons(script) : [];
    if (problem || cov.missing.length || long.length) {
      stage('repair', problem ? 'Asking ' + modelName(model) + ' to fix its reply' : long.length ? 'Asking ' + modelName(model) + ' to shorten ' + long.join(', ') : 'Asking ' + modelName(model) + ' to add ' + cov.missing.join(', '));
      const want = problem
        ? 'Your reply could not be used: ' + problem + ' Reply again with the complete JSON object only, in the format asked for.'
        : long.length
        ? 'These lessons are too long: ' + long.join(', ') + '. Every title is at most ' + LESSON_TITLE_WORDS + ' words and every body at most ' + LESSON_BODY_WORDS + ' words, one or two plain sentences, true to the chapter. Shorten them (keep the others as they are) and reply with the complete JSON object only.'
        : 'Your script does not teach these lessons: ' + cov.missing.map((id) => { const l = L.find((x) => x.id === id); return id + ' (' + (l && l.title || '') + ')'; }).join('; ') +
          '. Add each one in its own ' + (kind === 'podcast' ? 'segment, its turns tagged' : 'scene, tagged') + ' with its id, keep everything else, and reply with the complete JSON object only.';
      on.delta && on.delta('\n\n');
      r = await ask(messages.concat([{ role: 'assistant', content: text }, { role: 'user', content: want }]), [model, ...o.models.filter((m) => m !== model)]);
      text = r.text; model = r.model;
      script = norm(text);   // a second failure is final
      cov = coverage(kind, script, lessonIds);
      on.coverage && on.coverage(cov);
    }
    const extra = { model, length: o.length, ...(o.extra ? { asked: str(o.extra, 300) } : {}) };
    if (kind === 'lessons') {
      const rec = Object.assign({ lessons: script.lessons, summary: script.summary }, extra);
      rec.id = M.record(book, n, 'lessons', rec);
      stage('done', 'Saved');
      return { kind, script, rec, model };
    }
    // 5: speak.
    stage('speak', 'Speaking');
    const full = kind === 'podcast'
      ? Object.assign({ v: 1, book, n, title: o.title, hosts: o.hosts }, script)
      : Object.assign({ v: 1, book, n, title: o.title, narrator: o.narrator }, script);
    const built = kind === 'podcast'
      ? await POD.build(full, { key, onStep: step, speak: (a) => speak(Object.assign({ signal }, a)) })
      : await VID.build(full, { key, ch: o.ch, lessons: o.lessons, onStep: step, speak: (a) => speak(Object.assign({ signal }, a)) });
    // 6: keep.
    if (!drive) {
      (kind === 'podcast' ? POD : VID).useLocal(book, n, o.title, built);
      stage('done', 'Ready on this device');
      return { kind, script: full, local: true, model, built };
    }
    stage('upload', 'Uploading to Drive');
    const rec = await (kind === 'podcast' ? POD.save : VID.save)(book, n, built, extra);
    stage('done', 'Saved');
    return { kind, script: full, rec, model, built };
  } finally {
    M.job(book, n, kind, null);
  }
}
/* ── study sets (Phase 7) ────────────────────────────────────────────────── */
// MAGI Studio's prompts (magi/engine/studio.py), reworded from "the question
// and its answer" to "this reading", sized by length and scope, and asking
// for MAGI's labelled formats so its tolerant parsers (study/parse.js) read
// the reply.
export const STUDY_SIZES = {
  concise: { flashcards: '6 to 10', quiz: '5', mindmap: '3 to 5', slides: '5 to 7' },
  standard: { flashcards: '10 to 16', quiz: '8', mindmap: '4 to 6', slides: '8 to 10' },
  deep: { flashcards: '16 to 24', quiz: '12', mindmap: '5 to 7', slides: '10 to 14' },
};
const STUDY_TASK = {
  flashcards: (z) => 'Turn this reading into study flashcards: ' + z + ' cards, each covering one distinct teaching, term or idea from it. Use exactly this format, one card per block, nothing else in the response:\n\nCARD 1\nFRONT: the term or question\nBACK: the explanation or answer\n\nCARD 2\nFRONT: ...\nBACK: ...\n\nKeep each FRONT short (a term or a one-line question) and each BACK one to three plain sentences. Name a verse number in [brackets] on the BACK when one verse says it.',
  quiz: (z) => 'Turn this reading into a multiple-choice quiz: ' + z + ' questions, each testing understanding of one distinct point from it. Use exactly this format, one question per block, nothing else in the response:\n\nQ1. the question text\nA. option\nB. option\nC. option\nD. option\nCORRECT: B\nWHY: one line explaining why that option is correct\n\nQ2. ...\n\nExactly four lettered options per question, exactly one CORRECT line naming the right letter, exactly one WHY line. Wrong options are plausible, never silly.',
  mindmap: (z) => 'Turn this reading into a mind map outline: a central topic with ' + z + ' main branches and their sub-points. Use exactly this format, nothing else in the response:\n\nROOT: the central topic, a few words\n- first main branch\n  - a sub-point under it\n  - another sub-point\n- second main branch\n  - a sub-point under it\n\nUse a 2-space indent per nesting level, dash bullets, and go no deeper than one level of sub-points. Keep each line short: a few words to one phrase, not a sentence.',
  slides: (z) => 'Turn this reading into a slide deck: ' + z + ' slides that walk through it in order. Use exactly this format, one block per slide, nothing else in the response:\n\nSLIDE 1\nTITLE: the slide\'s title\n- first bullet point\n- second bullet point\n\nSLIDE 2\nTITLE: ...\n- ...\n\nKeep bullets short: a phrase, not a paragraph, two to five per slide. The first slide introduces the reading; the last sums up what it teaches.',
};
/** The messages for one study kind. o: {kind, book, bookTitle, scope:{label}, text, lessons, length, extra}. */
export function studyPrompt(o) {
  const what = o.book === 'gita' ? 'the Bhagavad-Gita (the IGS rendition by Ramananda Prasad)' : 'the book "' + (o.bookTitle || o.book) + '"';
  const z = (STUDY_SIZES[o.length] || STUDY_SIZES.standard)[o.kind];
  const L = (o.lessons && o.lessons.lessons) || [];
  const sys = 'You make study material for Shruti, a reading app. Stay faithful to the reading: be concise, true and to the point, and say only what it teaches. When you add anything that is not in it, say so plainly. Reply with ONLY the format asked for, nothing before or after it.';
  const user = 'This reading is ' + o.scope.label + ' of ' + what + '.\n\n' + STUDY_TASK[o.kind](z) +
    (L.length ? '\n\nThe readers wrote these lessons for it; make sure every one of them is covered.' : '') +
    (o.extra ? '\n\nThe reader also asks: ' + o.extra : '') +
    '\n\n<source>\n' + o.text + '\n</source>' +
    (L.length ? '\n\n<lessons>\n' + lessonsText(o.lessons) + '\n</lessons>' : '');
  return [{ role: 'system', content: sys }, { role: 'user', content: spill(user) }];
}
/** Make the chosen study kinds, one call each, through the person's units.
 *  o: {kinds, book, bookTitle, scope, text, lessons, length, extra, models}.
 *  on: {kind(k, i), delta(t), model(m), done(k, count)}. Resolves {kinds:{k: items}, model}.
 *  A reply nothing can be read from is asked for once more, with its own reply. */
export async function runStudy(o, on = {}, { signal, chat = O.chat, parse } = {}) {
  const key = keyOf();
  if (!key) throw Object.assign(new Error('Making needs your Orca key (Settings).'), { code: 'key' });
  const out = {}, P = parse;
  let model = null;
  for (const [i, kind] of o.kinds.entries()) {
    on.kind && on.kind(kind, i);
    const msgs = studyPrompt(Object.assign({}, o, { kind }));
    const ask = (m, models) => chat({ key, messages: m, models, signal, onDelta: (t) => on.delta && on.delta(t), onModel: (x) => { model = x; on.model && on.model(x); } });
    let r = await ask(msgs, model ? [model, ...o.models.filter((x) => x !== model)] : o.models);
    let it = P.items(kind, r.text);
    if (!P.count(kind, it)) {
      on.delta && on.delta('\n\n');
      r = await ask(msgs.concat([{ role: 'assistant', content: r.text }, { role: 'user', content: 'That could not be read. Reply again in exactly the format asked for, nothing else.' }]), [r.model, ...o.models.filter((x) => x !== r.model)]);
      it = P.items(kind, r.text);
      if (!P.count(kind, it)) throw new Error(modelName(r.model) + '\'s ' + kind + ' could not be read.');
    }
    out[kind] = it;
    on.done && on.done(kind, P.count(kind, it));
  }
  return { kinds: out, model };
}

export const modelName = (id) => { const u = O.UNITS.find((x) => x.id === id); return u ? u.name : String(id || '').split('/')[0]; };

/* ── the sheet ───────────────────────────────────────────────────────────── */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
export const ICON = SPARK;
const TAB = { podcast: 'listen', video: 'watch', lessons: 'lessons', read: '' };
// running: the run on this device; kept after it ends (finished) so the sheet
// can still show how it went, but only an unfinished one blocks another.
let modelsCache = null, running = null;
const isBusy = () => !!(running && !running.finished);
export const busy = isBusy;

/** Open "Make with AI" for a chapter. ctx: {book, bookTitle, n, title, ch, lessons, shipped:{podcast, video, read}}. */
export function openSheet(ctx, kind) {
  if (document.getElementById('gen-sheet')) return;
  const p = prefs();
  const st = { kind: kind || (isBusy() && running.ctx.n === ctx.n ? running.kind : p.kind) };
  if (ctx.n === 0 || !M.KINDS.includes(st.kind)) st.kind = 'read';
  const dim = document.createElement('div');
  dim.className = 'sheet-dim'; dim.id = 'gen-sheet';
  dim.innerHTML = '<aside class="sheet gen" role="dialog" aria-modal="true" aria-labelledby="gen-h"><div class="sh-h"><h2 id="gen-h">Make with AI</h2>' +
    '<button class="ib" data-close aria-label="Close">' + CLOSE + '</button></div>' +
    '<p class="gen-sub">Chapter ' + ctx.n + ' · ' + esc(ctx.title) + '</p>' +
    '<div class="chips gen-kinds" role="radiogroup" aria-label="What to make">' + M.KINDS.filter((k) => ctx.n !== 0 || k === 'read').map((k) => '<button class="chip" role="radio" data-kind="' + k + '">' + M.KIND_NAME[k] + '</button>').join('') + '</div>' +
    '<section class="card" id="gen-vers"></section><section class="card" id="gen-opts"></section><section class="card" id="gen-run"></section></aside>';
  document.body.appendChild(dim);
  const off = [];
  const close = () => { dim.remove(); removeEventListener('keydown', onKey); off.forEach((f) => f()); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  addEventListener('keydown', onKey);
  dim.addEventListener('click', (e) => { if (e.target === dim || e.target.closest('[data-close]')) close(); });
  dim.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => { st.kind = b.dataset.kind; setPref('kind', st.kind); draw(); }));
  const draw = () => {
    dim.querySelectorAll('[data-kind]').forEach((b) => { const on = b.dataset.kind === st.kind; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    drawVersions(dim.querySelector('#gen-vers'), ctx, st.kind);
    drawOptions(dim.querySelector('#gen-opts'), ctx, st.kind);
    drawRun(dim.querySelector('#gen-run'), ctx, st.kind, close);
  };
  draw();
  // Another device's job, a version saved elsewhere: redraw (unless typing).
  const redraw = () => { if (!dim.isConnected) return; if (document.activeElement && document.activeElement.closest('#gen-opts')) return; drawVersions(dim.querySelector('#gen-vers'), ctx, st.kind); if (!running) drawRun(dim.querySelector('#gen-run'), ctx, st.kind, close); };
  off.push(C.on('doc:shared', redraw), C.on('doc:me', redraw));
  if (!modelsCache && keyOf()) O.checkKey(keyOf()).then((r) => { if (r.ok) { modelsCache = r.models; if (dim.isConnected) drawOptions(dim.querySelector('#gen-opts'), ctx, st.kind); } });
}

function drawVersions(box, ctx, kind) {
  const list = M.versions(ctx.book, ctx.n, kind), cur = M.featured(ctx.book, ctx.n, kind);
  const shipped = ctx.shipped && ctx.shipped[kind];
  const row = (id, title, meta, canDelete) => '<div class="gv' + ((cur || null) === id ? ' on' : '') + '"><button class="gv-pick" data-feature="' + esc(id || '') + '" role="radio" aria-checked="' + ((cur || null) === id) + '"><span class="dot"></span><span><b>' + esc(title) + '</b><span>' + esc(meta) + '</span></span></button>' +
    (canDelete ? '<button class="ib" data-del="' + esc(id) + '" title="Delete this version" aria-label="Delete this version"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>' : '') + '</div>';
  const when = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
  const desc = (r) => [r.model && modelName(r.model), r.voices && r.voices.filter(Boolean).map(voiceName).join(' & '), r.duration && T.fmtTime(r.duration), r.lessons && r.lessons.length + ' lessons', r.by && (C.PROFILES[r.by] ? C.PROFILES[r.by].label : r.by), when(r.at)].filter(Boolean).join(' · ');
  const job = M.jobOf(ctx.book, ctx.n, kind);
  box.innerHTML = '<h3>Versions</h3>' +
    (job && !(running && running.kind === kind && running.ctx.n === ctx.n) ? '<div class="stat busy gen-other"><i></i><span>' + esc((C.PROFILES[job.by] ? C.PROFILES[job.by].label : job.by) + ' is making this' + (job.text ? ': ' + job.text.toLowerCase() : '') + '…') + '</span></div>' : '') +
    '<div class="gvs">' +
    (shipped ? row(null, kind === 'lessons' ? 'Your own notes' : 'Comes with Shruti', shipped, false) : '') +
    list.map((r) => row(r.id, kind === 'lessons' ? 'Lessons by ' + modelName(r.model) : (M.KIND_NAME[kind] + (r.length ? ' · ' + (LENGTHS[r.length] || {}).label : '')), desc(r), true)).join('') +
    (!shipped && !list.length ? '<p class="hint">Nothing made yet.</p>' : '') + '</div>' +
    (list.length || shipped ? '<p class="hint gv-h">The ticked one is what plays, on every device' + (C.shared === M.docFor(ctx.book) ? ' and for both of you' : '') + '.</p>' : '');
  box.querySelectorAll('[data-feature]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.feature || null;
    if (id === (cur || null)) return;
    if (kind === 'podcast' && POD.active(ctx.book, ctx.n)) POD.stop();
    if (kind === 'video' && VID.active(ctx.book, ctx.n)) VID.stop();
    M.feature(ctx.book, ctx.n, kind, id);
    ui.toast(id ? 'This version plays now' : 'The original plays now');
    drawVersions(box, ctx, kind);
  }));
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!await window.uiConfirm('Delete this version? Its files on Drive are deleted too.', { title: 'Delete version', okLabel: 'Delete' })) return;
    if (kind === 'podcast' && POD.active(ctx.book, ctx.n)) POD.stop();
    if (kind === 'video' && VID.active(ctx.book, ctx.n)) VID.stop();
    await M.remove(ctx.book, ctx.n, kind, b.dataset.del);
    drawVersions(box, ctx, kind);
  }));
}

function voiceSelect(id, value, label) {
  return '<label class="gen-f"><span>' + esc(label) + '</span><select id="' + id + '">' + O.VOICES.map((v) => '<option value="' + esc(v.id) + '"' + (v.id === value ? ' selected' : '') + '>' + esc(v.name + ' · ' + v.locale.replace('en-', '') + ' ' + v.gender) + '</option>').join('') + '</select></label>';
}
export function hostsOf(p) {
  const pre = HOST_PRESETS[p.hosts] || HOST_PRESETS[0];
  const a = p.hostA || pre.hosts[0][1], b = p.hostB || pre.hosts[1][1];
  return [{ id: 'A', name: voiceName(a), voice: a }, { id: 'B', name: voiceName(b), voice: b }];
}
function drawOptions(box, ctx, kind) {
  const p = prefs();
  const rows = O.unitRows(C.me.get('units', {}) || {}, modelsCache);
  const units = '<div class="gen-f"><span>Units, in order</span><div class="chips gen-units">' + rows.map((r) => '<button class="chip' + (r.on ? ' on' : '') + (r.status === 'offline' || r.status === 'missing' ? ' off' : '') + '" data-unit="' + esc(r.id) + '" role="checkbox" aria-checked="' + r.on + '" title="' + esc(r.status === 'ready' ? 'Ready' : r.status === 'offline' ? 'Offline' : r.status === 'missing' ? 'Not allowed on this key' : '') + '">' + (r.on ? CHECK : '') + esc(r.name) + '</button>').join('') + '</div><button class="lk" data-units>Order them in Settings</button></div>';
  const len = '<div class="gen-f"><span>Length</span><div class="chips">' + Object.entries(LENGTHS).map(([k, v]) => '<button class="chip' + (p.length === k ? ' on' : '') + '" data-len="' + k + '">' + v.label + '</button>').join('') + '</div></div>';
  const hosts = hostsOf(p);
  let voices = '';
  if (kind === 'podcast') voices = '<div class="gen-f"><span>Hosts</span><div class="chips">' + HOST_PRESETS.map((h, i) => '<button class="chip' + (!p.hostA && !p.hostB && p.hosts === i ? ' on' : '') + '" data-preset="' + i + '">' + esc(h.name) + '</button>').join('') + '</div></div>' +
    '<div class="gen-2">' + voiceSelect('gen-a', hosts[0].voice, 'Host A') + voiceSelect('gen-b', hosts[1].voice, 'Host B') + '</div>';
  else if (kind === 'video') voices = voiceSelect('gen-nar', p.narrator, 'Narrator');
  else if (kind === 'read') voices = voiceSelect('gen-voice', p.voice, 'Voice');
  box.innerHTML = '<h3>How</h3>' + (kind === 'read'
    ? '<p class="hint">The whole chapter read in this voice, saved to Drive, then it plays with no Orca calls on every device.</p>' + voices
    : units + len + voices + '<label class="gen-f"><span>Anything else? (optional)</span><textarea id="gen-extra" rows="2" maxlength="600" placeholder="e.g. more about the history; keep it light; explain Sanskrit words">' + esc(p.extra) + '</textarea></label>');
  box.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => {
    const cur = C.me.get('units', {}) || {}, on = Object.assign({}, cur.on || {}), r = rows.find((x) => x.id === b.dataset.unit);
    on[r.id] = !r.on; C.me.set({ 'units.on': on }); drawOptions(box, ctx, kind);
  }));
  const u = box.querySelector('[data-units]'); if (u) u.addEventListener('click', () => { document.getElementById('gen-sheet').remove(); ui.openSettings(); });
  box.querySelectorAll('[data-len]').forEach((b) => b.addEventListener('click', () => { setPref('length', b.dataset.len); drawOptions(box, ctx, kind); }));
  box.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => { C.me.set({ 'gen.hosts': Number(b.dataset.preset), 'gen.hostA': null, 'gen.hostB': null }); drawOptions(box, ctx, kind); }));
  const bind = (id, k) => { const el = box.querySelector('#' + id); if (el) el.addEventListener('change', () => setPref(k, el.value)); };
  bind('gen-a', 'hostA'); bind('gen-b', 'hostB'); bind('gen-nar', 'narrator'); bind('gen-voice', 'voice');
  const ex = box.querySelector('#gen-extra'); if (ex) ex.addEventListener('change', () => setPref('extra', ex.value.trim()));
}

const STAGES = { write: 'Write', check: 'Check every lesson', repair: 'Repair', speak: 'Speak', upload: 'Save to Drive', done: 'Done' };
function drawRun(box, ctx, kind, close) {
  const mine = running && running.ctx.n === ctx.n && running.ctx.book === ctx.book && running.kind === kind;
  const other = !mine && M.jobOf(ctx.book, ctx.n, kind);
  if (!mine) {
    const L = (ctx.lessons && ctx.lessons.lessons) || [];
    box.innerHTML = '<div class="gen-go"><button class="btn solid" data-make' + (isBusy() || other ? ' disabled' : '') + '>' + SPARK + 'Make ' + M.KIND_NAME[kind].toLowerCase() + '</button>' +
      '<span class="hint">' + esc(isBusy() ? 'One thing at a time: ' + M.KIND_NAME[running.kind].toLowerCase() + ' for chapter ' + running.ctx.n + ' is being made.' : kind === 'read' ? 'Takes a few minutes.' : kind === 'lessons' ? 'About a minute.' : 'A few minutes: written, checked' + (L.length ? ' for all ' + L.length + ' lessons' : '') + ', then spoken.') + '</span></div>';
    const b = box.querySelector('[data-make]');
    b.addEventListener('click', () => start(ctx, kind, box, close));
    return;
  }
  paintRun(box, running);
}
function paintRun(box, R) {
  if (!box || !box.isConnected) return;
  const L = (R.ctx.lessons && R.ctx.lessons.lessons) || [];
  const stages = R.kind === 'read' ? ['speak', 'upload', 'done'] : R.kind === 'lessons' ? ['write', 'check', 'done'] : ['write', 'check', 'speak', R.local ? 'done' : 'upload', 'done'].filter((s, i, a) => a.indexOf(s) === i);
  if (R.repaired && !stages.includes('repair')) stages.splice(2, 0, 'repair');
  const idx = stages.indexOf(R.stage);
  box.innerHTML = '<h3>' + (R.error ? 'It stopped' : R.stage === 'done' ? 'Made' : 'Making ' + M.KIND_NAME[R.kind].toLowerCase()) + (R.model ? '<span class="gen-model">' + esc(modelName(R.model)) + '</span>' : '') + '</h3>' +
    '<ol class="gen-steps">' + stages.map((s, i) => '<li class="' + (R.error && i === idx ? 'bad' : i < idx || R.stage === 'done' ? 'done' : i === idx ? 'cur' : '') + '">' + esc(STAGES[s]) + (s === R.stage && R.text && !/^(Writing|Checking|Saved)$/.test(R.text) ? ' <span>' + esc(R.text) + '</span>' : '') + '</li>').join('') + '</ol>' +
    (R.total ? '<div class="gen-bar"><i style="width:' + (100 * R.done / R.total).toFixed(1) + '%"></i></div>' : '') +
    (R.cov && L.length && R.kind !== 'lessons' && R.kind !== 'read' ? '<div class="gen-cov">' + L.map((l) => '<span class="' + (R.cov.covered.includes(l.id) ? 'ok' : 'no') + '" title="' + esc(l.title || '') + '">' + esc(l.id) + '</span>').join('') + '<em>' + R.cov.covered.length + ' of ' + L.length + ' lessons</em></div>' : '') +
    (R.text && R.stream ? '<details class="gen-live"' + (R.stage === 'write' || R.stage === 'repair' ? ' open' : '') + '><summary>What ' + esc(modelName(R.model) || 'the unit') + ' wrote</summary><pre>' + esc(R.stream.slice(-6000)) + '</pre></details>' : '') +
    (R.error ? '<div class="stat bad"><i></i><span>' + esc(R.error) + '</span></div>' : '') +
    (R.stage === 'done' && !R.error ? '<div class="stat good"><i></i><span>' + esc(R.local ? 'Made. Google Drive is not connected, so it plays on this device only, until the page is reloaded.' : 'Saved, and it plays now on every device.') + '</span></div>' : '') +
    '<div class="gen-go">' + (R.stage === 'done' || R.error ? (TAB[R.kind] !== undefined && !R.error ? '<button class="btn solid" data-open>' + (R.kind === 'lessons' ? 'See the lessons' : R.kind === 'read' ? 'Read along' : 'Play it') + '</button>' : '') + '<button class="btn" data-again>' + (R.error ? 'Try again' : 'Make another') + '</button>' : '<button class="btn" data-cancel>Cancel</button>') + '</div>';
  const pre = box.querySelector('.gen-live pre'); if (pre) pre.scrollTop = pre.scrollHeight;
  const c = box.querySelector('[data-cancel]'); if (c) c.addEventListener('click', () => R.abort.abort());
  const o = box.querySelector('[data-open]'); if (o) o.addEventListener('click', () => { const sh = document.getElementById('gen-sheet'); if (sh) sh.remove(); running = null; ui.go('#/b/' + R.ctx.book + '/' + R.ctx.n + (TAB[R.kind] ? '/' + TAB[R.kind] : '')); });
  const a = box.querySelector('[data-again]'); if (a) a.addEventListener('click', () => { running = null; drawRun(box, R.ctx, R.kind, R.close); });
}
async function start(ctx, kind, box, close) {
  if (isBusy()) return;
  if (!keyOf()) { const go = await window.uiConfirm('Making uses Orca with your own key. Paste it once in Settings.', { title: 'Your Orca key is needed', okLabel: 'Open Settings' }); if (go) { close(); ui.openSettings(); } return; }
  const p = prefs();
  const models = O.chain(C.me.get('units', {}) || {}, modelsCache);
  const R = running = { ctx, kind, stage: kind === 'read' ? 'speak' : 'write', text: '', stream: '', model: null, cov: null, done: 0, total: 0, abort: new AbortController(), close };
  const box2 = () => document.querySelector('#gen-run') || box;
  let t = 0;
  const paint = (force) => { if (force || Date.now() - t > 120) { t = Date.now(); paintRun(box2(), R); } };
  paint(true);
  try { box2().scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
  const o = {
    kind, book: ctx.book, bookTitle: ctx.bookTitle, n: ctx.n, title: ctx.title, ch: ctx.ch, lessons: ctx.lessons, length: p.length, extra: p.extra,
    hosts: hostsOf(p), narrator: { name: voiceName(p.narrator), voice: p.narrator }, voice: p.voice, models,
  };
  try {
    const res = await run(o, {
      stage: (id, text) => { R.stage = id; R.text = text; if (id === 'repair') R.repaired = true; paint(true); },
      delta: (d) => { R.stream += d; paint(); },
      model: (m) => { R.model = m; paint(true); },
      coverage: (cov) => { R.cov = cov; paint(true); },
      step: (done, total) => { R.done = done; R.total = total; paint(done === total); },
    }, { signal: R.abort.signal });
    R.local = !!res.local; R.stage = 'done'; R.total = 0;
    ui.toast(M.KIND_NAME[kind] + ' for chapter ' + ctx.n + (res.local ? ' is ready on this device' : ' is saved'));
  } catch (e) {
    R.error = e && e.code === 'abort' ? 'Cancelled.' : (e && e.message) || String(e);
  }
  R.finished = true;
  paintRun(box2(), R);
}
