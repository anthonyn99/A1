// Make with AI's engine: a podcast, a video, lessons or a read-aloud for any
// chapter, through Orca with the person's own key (Phase 6). The Gita ships with
// all of these; this is for imported books, other voices or lengths, and
// re-makes. The sheets are make.js's; the queue that runs this in the
// background is jobs.js's; what is asked and how replies are read, formats.js's.
//
// The pipeline, the same for every kind:
//   1. the chapter's exact text and its lessons go into the prompt (long text
//      as attached .txt files, as StudyOS sends it);
//   2. Orca streams the reply from one unit at a time, in the person's order;
//      a reply that stops before its END is continued by the same unit;
//   3. the labelled text is read tolerantly (formats.js; older JSON too);
//   4. every lesson must be taught: a missing one is asked for on its own and
//      put in its place (twice at most), and the checklist shows the result;
//      a unit that still cannot finish hands the job to the next one;
//   5. podcast and video are spoken in Edge voices, whole frames with word
//      timings only (orca.js speakExact), and joined byte for byte
//      (podcast.js build(), video.js build()); read-aloud is narrate.js's;
//   6. uploaded to Drive and kept as a new version that plays at once
//      (media.js); without Drive it plays on this device only;
//   7. while it runs, jobs.<book>.ch<n>.<kind> tells the other devices.
// Verses on screen are copied from the book, never from the model.

import * as C from './core.js';
import * as O from './orca.js';
import * as M from './media.js';
import * as POD from './podcast.js';
import * as VID from './video.js';
import * as NR from './narrate.js';
import * as F from './formats.js';

let ui = { toast: () => {}, go: () => {}, openSettings: () => {} };
export function setUI(x) { ui = Object.assign(ui, x); }
const keyOf = () => C.orcaKey();

/* ── when the AI cannot run: one look and one fix everywhere ─────────────── */
// Make with AI, Study sets and Import show the same box: what is wrong in plain
// words and, when the fix is in Settings, a button that opens it.
/** Ask Orca what the key may use (cached), then say what stops a run, or null. */
export async function aiReady() {
  const key = keyOf();
  if (key) await O.models(key).catch(() => null);
  return O.preflight(key, C.me.get('units', {}) || {}, O.cachedModels(key));
}
/** p: from O.explain / O.preflight (or a plain string). */
export function problemHTML(p) {
  if (!p) return '';
  if (typeof p === 'string') p = { title: '', text: p };
  return '<div class="stat bad ai-prob" role="alert"><i></i><span>' + (p.title && p.title !== 'It stopped' ? '<b>' + esc(p.title) + '.</b> ' : '') + esc(p.text) + '</span>' +
    (p.action === 'settings' ? '<button class="btn sm" data-ai-settings>Open Settings</button>' : '') + '</div>';
}
/** Wire the box's "Open Settings": close the sheet it sits in, then open Settings. */
export function bindProblem(box, close) {
  box.querySelectorAll('[data-ai-settings]').forEach((b) => b.addEventListener('click', () => { if (close) close(); ui.openSettings(); }));
}

// The asks and the reading of replies live in formats.js (labelled text, not
// JSON, since 2026-10-22); these names stay here for the rest of Shruti.
export const { LENGTHS, sourceText, lessonsText, buildPrompt, spill, SPILL_CHARS, parseJSON, normPodcast, normVideo, normLessons, coverage, longLessons } = F;
// The host pairs (redone 2026-10-22): each a woman and a man of one accent,
// so the two sound like they belong together. Emma and Brian stay first and
// the default (Ava and Andrew sounded robotic, 2026-10-22; the shipped
// podcasts use Emma and Brian); Sonia (Tony's pick) and Ryan next. A choice is
// kept by its id (gen.hosts); older choices were kept by place in the old
// list of four, which LEGACY_PRESETS reads.
export const HOST_PRESETS = [
  { id: 'emma-brian', name: 'Emma & Brian', hosts: [['Emma', 'en-US-EmmaMultilingualNeural'], ['Brian', 'en-US-BrianMultilingualNeural']] },
  { id: 'sonia-ryan', name: 'Sonia & Ryan', hosts: [['Sonia', 'en-GB-SoniaNeural'], ['Ryan', 'en-GB-RyanNeural']] },
  { id: 'ava-andrew', name: 'Ava & Andrew', hosts: [['Ava', 'en-US-AvaMultilingualNeural'], ['Andrew', 'en-US-AndrewMultilingualNeural']] },
  { id: 'jenny-guy', name: 'Jenny & Guy', hosts: [['Jenny', 'en-US-JennyNeural'], ['Guy', 'en-US-GuyNeural']] },
  { id: 'libby-thomas', name: 'Libby & Thomas', hosts: [['Libby', 'en-GB-LibbyNeural'], ['Thomas', 'en-GB-ThomasNeural']] },
  { id: 'natasha-william', name: 'Natasha & William', hosts: [['Natasha', 'en-AU-NatashaNeural'], ['William', 'en-AU-WilliamMultilingualNeural']] },
  { id: 'neerja-prabhat', name: 'Neerja & Prabhat', hosts: [['Neerja', 'en-IN-NeerjaNeural'], ['Prabhat', 'en-IN-PrabhatNeural']] },
  { id: 'emily-connor', name: 'Emily & Connor', hosts: [['Emily', 'en-IE-EmilyNeural'], ['Connor', 'en-IE-ConnorNeural']] },
];
const LEGACY_PRESETS = ['emma-brian', 'ava-andrew', 'sonia-ryan', 'neerja-prabhat'];
/** A stored choice (an id, or an old list place) as the preset's id. */
export function presetId(v) {
  if (typeof v === 'number') v = LEGACY_PRESETS[v];
  return HOST_PRESETS.some((h) => h.id === v) ? v : HOST_PRESETS[0].id;
}
export const presetOf = (v) => HOST_PRESETS.find((h) => h.id === presetId(v));
/** A video's narrator unless the person picks another (Tony, 2026-10-22: Sonia). */
export const DEFAULT_NARRATOR = 'en-GB-SoniaNeural';
export const prefs = () => Object.assign({ kind: 'podcast', length: 'standard', hosts: HOST_PRESETS[0].id, hostA: null, hostB: null, narrator: DEFAULT_NARRATOR, voice: O.DEFAULT_VOICE, extra: '' }, C.me.get('gen', {}) || {});
export function setPref(k, v) { C.me.set({ ['gen.' + k]: v }); }
const voiceName = (id) => NR.voiceName(id);
const str = (x, max) => { const s = String(x == null ? '' : x).replace(/\s+/g, ' ').trim(); return max && s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : s; };
/** Lessons as the unit wrote them, to hand back for a shortening. */
const lessonsAsText = (script) => script.lessons.map((l, i) => 'LESSON ' + (i + 1) + '\nTITLE: ' + l.title + '\nBODY: ' + l.body).join('\n\n') + (script.summary ? '\n\nSUMMARY: ' + script.summary : '') + '\n\nEND';
/** A script that reached its natural last part, though it never wrote END. */
function looksDone(kind, text, ctx) {
  try {
    const s = F.parseReply(kind, text, ctx);
    if (kind === 'podcast') return /wrap|clos|goodbye|farewell|until next|next time/i.test(s.segments[s.segments.length - 1].title);
    if (kind === 'video') return s.scenes[s.scenes.length - 1].layout === 'closing';
    return !!s.summary;
  } catch (e) { return false; }
}

/* ── one run ─────────────────────────────────────────────────────────────── */
/** Make one thing. o: {kind, book, bookTitle, n, title, ch, lessons, length,
 *  hosts:[{id,name,voice}], narrator:{name,voice}, voice, extra, models}.
 *  on: {stage(id, text), delta(t), model(m), coverage(cov), step(done, total), lessons(L)}.
 *  Resolves {kind, script?, rec?, local?, model?}.
 *
 *  Each unit in the person's order gets the whole job: it writes; a reply that
 *  stops before its END is continued by the same unit (up to three times); one
 *  that cannot be read goes back once to be fixed; a lesson it missed is asked
 *  for on its own and put in its place (twice at most). Only when a unit still
 *  cannot finish does the next one start, from the beginning. */
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
  const drive = saveDrive != null ? saveDrive : await M.driveReady(book);

  /** One kind written by the units in turn: {script, model}. */
  const write = async (k, oo) => {
    const L = (oo.lessons && oo.lessons.lessons) || [], ids = k === 'lessons' ? [] : L.map((l) => l.id);
    const pctx = { hosts: oo.hosts, lessonIds: ids };
    const messages = F.buildPrompt(Object.assign({}, oo, { kind: k }));
    const tried = [];
    for (const model of oo.models) {
      if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'abort' });
      const name = modelName(model);
      const ask = async (msgs) => {
        const r = await chat({ key, messages: msgs, models: [model], signal, onDelta: (t) => { on.delta && on.delta(t); }, onModel: (m) => { on.model && on.model(m); M.job(book, n, kind, { kind, stage: k === kind ? 'write' : 'lessons', text: 'Writing', model: m }, { lazy: true }); } });
        return r.text;
      };
      /** Ask, and go on asking the same unit until the reply reaches its END. */
      // A reply that has begun the format but not reached END is continued
      // (one that never began it is sent back to be fixed instead).
      const askAll = async (msgs, label) => {
        let text = await ask(msgs);
        for (let c = 0; c < 3 && F.started(k, text) && !F.finished(k, text) && !(c === 0 && label === 'main' && looksDone(k, text, pctx)); c++) {
          if (label === 'main') stage(k === kind ? 'write' : 'lessons', 'Going on (part ' + (c + 2) + ')');
          on.delta && on.delta('\n');
          text = F.joinReply(k, text, await ask(F.continuePrompt(msgs, text, k)));
        }
        return text;
      };
      try {
        let text = await askAll(messages, 'main');
        if (k === kind) stage('check', 'Checking');
        let script;
        try { script = F.parseReply(k, text, pctx); }
        catch (e) {
          stage('repair', 'Asking ' + name + ' to fix its reply');
          on.delta && on.delta('\n\n');
          text = await askAll(messages.concat([{ role: 'assistant', content: text }, { role: 'user', content: 'Your reply could not be read: ' + e.message + ' Reply again with the whole thing, in exactly the format asked for (plain text, no JSON, no code block), and finish with the line END.' }]), 'fix');
          script = F.parseReply(k, text, pctx);
        }
        if (k === 'podcast' || k === 'video') {
          let cov = F.coverage(k, script, ids);
          on.coverage && on.coverage(cov);
          for (let r = 0; r < 2 && cov.missing.length; r++) {
            stage('repair', 'Asking ' + name + ' to add ' + cov.missing.join(', '));
            on.delta && on.delta('\n\n');
            const more = await askAll(F.missingPrompt(k, messages, text, cov.missing, L), 'more');
            try { script = F.mergeLessons(k, script, F.parseReply(k, more, pctx), cov.missing); } catch (e) {}
            cov = F.coverage(k, script, ids);
            on.coverage && on.coverage(cov);
          }
        } else {
          // Every lesson (Tony, 2026-10-22): a second look for any it missed.
          stage(k === kind ? 'check' : 'lessons', 'Checking for any lesson missed');
          on.delta && on.delta('\n\n');
          const more = await askAll(F.completePrompt(messages, text), 'more');
          try { const found = F.parseLessons(more); if (found.lessons.length) script = F.mergeFound(script, found); } catch (e) {}
          const long = F.longLessons(script, oo.length);
          if (long.length) {
            stage('repair', 'Asking ' + name + ' to shorten ' + long.map((x) => 'L' + x).join(', '));
            on.delta && on.delta('\n\n');
            const sh = await askAll(F.shortenPrompt(messages, lessonsAsText(script), long, oo.length), 'more');
            try { script = F.mergeShort(script, F.parseLessons(sh)); } catch (e) {}
          }
        }
        return { script, model };
      } catch (e) {
        if (e && (e.code === 'abort' || e.code === 'key')) throw e;
        const why = e && e.code === 'none' && e.tried ? e.tried.map((x) => x.split(': ').slice(1).join(': ')).join(', ') : (e && e.message) || String(e);
        tried.push(model + ': ' + why);
        on.delta && on.delta('\n\n[' + name + ' could not finish: ' + why + ']\n\n');
      }
    }
    throw Object.assign(new Error('No unit could make it (' + tried.join('; ') + ').'), { code: 'none', tried });
  };

  try {
    if (kind === 'read') {
      if (!drive) throw Object.assign(new Error('Google Drive is not connected yet (Settings → Google Drive). A read-aloud is kept there.'), { code: 'drive', title: 'Google Drive is not connected', text: 'A made read-aloud is kept on Drive, so it plays on every device. Connect Drive in Settings first.', action: 'settings' });
      stage('speak', 'Speaking the chapter in ' + voiceName(o.voice));
      const rec = await NR.saveNarration({ book, n, ch: o.ch, title: o.title }, o.voice, step, () => stage('upload', 'Uploading to Drive'), {});
      stage('done', 'Saved');
      return { kind, rec };
    }
    const extra = { length: o.length, ...(o.extra ? { asked: str(o.extra, 300) } : {}) };
    let lessons = o.lessons;
    // A podcast or video teaches the chapter's lessons. With none yet (an
    // imported book), every lesson is drawn first and kept as the chapter's.
    if ((kind === 'podcast' || kind === 'video') && !((lessons && lessons.lessons) || []).length) {
      stage('lessons', 'Finding every lesson first');
      const got = await write('lessons', Object.assign({}, o, { kind: 'lessons' }));
      const rec = Object.assign({ lessons: got.script.lessons, summary: got.script.summary, model: got.model }, extra);
      rec.id = M.record(book, n, 'lessons', rec);
      lessons = { lessons: got.script.lessons, summary: got.script.summary, by: got.model };
      on.lessons && on.lessons(lessons);
    }
    stage('write', 'Writing');
    const got = await write(kind, Object.assign({}, o, { lessons }));
    const { script, model } = got;
    extra.model = model;
    if (kind === 'lessons') {
      const rec = Object.assign({ lessons: script.lessons, summary: script.summary }, extra);
      rec.id = M.record(book, n, 'lessons', rec);
      stage('done', 'Saved');
      return { kind, script, rec, model };
    }
    // Speak.
    stage('speak', 'Speaking');
    const full = kind === 'podcast'
      ? Object.assign({ v: 1, book, n, title: o.title, hosts: o.hosts }, script)
      : Object.assign({ v: 1, book, n, title: o.title, narrator: o.narrator }, script);
    const built = kind === 'podcast'
      ? await POD.build(full, { key, onStep: step, speak: (a) => speak(Object.assign({ signal }, a)) })
      : await VID.build(full, { key, ch: o.ch, lessons, onStep: step, speak: (a) => speak(Object.assign({ signal }, a)) });
    // Keep.
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
  const sys = 'You make study material for Shruti, a reading app. Stay faithful to the reading: be concise, true and to the point, and say only what it teaches. When you add anything that is not in it, say so plainly. Reply with ONLY the format asked for, as plain text (no JSON, no code block, no citations like [1]), nothing before or after it. Do not search the web: the reading is below.';
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
/** Perplexity's citations ([1], [2, 3]) are not part of a card or a slide. */
const noCites = (t) => String(t || '').replace(/[ \t]*\[(?:\d{1,3}(?:\s*[,–-]\s*\d{1,3})*)\]/g, '');
export async function runStudy(o, on = {}, { signal, chat = O.chat, parse } = {}) {
  const key = keyOf();
  if (!key) throw Object.assign(new Error('Making needs your Orca key (Settings).'), { code: 'key' });
  const out = {}, P = parse;
  let model = null;
  for (const [i, kind] of o.kinds.entries()) {
    on.kind && on.kind(kind, i);
    const msgs = studyPrompt(Object.assign({}, o, { kind }));
    // The unit that answered last goes first; each unit gets one fix, then the next one tries.
    const order = model ? [model, ...o.models.filter((x) => x !== model)] : o.models.slice();
    const tried = [];
    let it = null;
    for (const m of order) {
      if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'abort' });
      const ask = (msgs2) => chat({ key, messages: msgs2, models: [m], signal, onDelta: (t) => on.delta && on.delta(t), onModel: (x) => { model = x; on.model && on.model(x); } });
      try {
        let r = await ask(msgs);
        it = P.items(kind, noCites(r.text));
        if (!P.count(kind, it)) {
          on.delta && on.delta('\n\n');
          r = await ask(msgs.concat([{ role: 'assistant', content: r.text }, { role: 'user', content: 'That could not be read. Reply again in exactly the format asked for, as plain text (no JSON, no code block), nothing else.' }]));
          it = P.items(kind, noCites(r.text));
        }
        if (P.count(kind, it)) break;
        tried.push(m + ': its ' + kind + ' could not be read');
      } catch (e) {
        if (e && (e.code === 'abort' || e.code === 'key')) throw e;
        tried.push(m + ': ' + (e && e.code === 'none' && e.tried ? e.tried.map((x) => x.split(': ').slice(1).join(': ')).join(', ') : (e && e.message) || e));
      }
      it = null;
      on.delta && on.delta('\n\n[' + modelName(m) + ' could not make the ' + kind + '; trying the next unit]\n\n');
    }
    if (!it) throw Object.assign(new Error('No unit could make the ' + kind + ' (' + tried.join('; ') + ').'), { code: 'none', tried });
    out[kind] = it;
    on.done && on.done(kind, P.count(kind, it));
  }
  return { kinds: out, model };
}

export const modelName = (id) => { const u = O.UNITS.find((x) => x.id === id); return u ? u.name : String(id || '').split('/')[0]; };

/* ── "Test each unit" (Settings) ─────────────────────────────────────────── */
// A small real ask of each kind through one unit, read by the same parsers a
// real run uses: whether this unit can make a podcast, a video, lessons and a
// study set right now, and if not, why (Tony, 2026-10-22: "ensure ALL units
// can create anything").
const TEST_SOURCE = { blocks: [{ k: 'h', t: 'Karma-yoga' }, { k: 'p', s: [{ v: '2.47', t: 'You have control over doing your respective duty, but no control or claim over the result. Fear of failure, from being emotionally attached to the fruits of work, is the greatest impediment to success.' }, { v: '2.48', t: 'Do your duty to the best of your ability, O Arjuna, with your mind attached to the Lord, abandoning worry and attachment to the results, and remaining calm in both success and failure.' }] }] };
const TEST_LESSONS = { lessons: [{ id: 'L1', title: 'Do the work; let go of its fruits.' }] };
export const TEST_KINDS = ['podcast', 'video', 'lessons', 'study'];
function testAsk(kind) {
  const base = { book: 'gita', n: 2, title: 'A short passage', ch: TEST_SOURCE, lessons: TEST_LESSONS, length: 'concise', hosts: [{ id: 'A', name: 'Ava' }, { id: 'B', name: 'Andrew' }] };
  if (kind === 'study') return studyPrompt({ kind: 'flashcards', book: 'gita', scope: { label: 'two verses of chapter two' }, text: F.sourceText(TEST_SOURCE), lessons: null, length: 'concise' });
  const m = F.buildPrompt(Object.assign({ kind }, base, kind === 'lessons' ? { lessons: null } : {}));
  // The same format, kept tiny: a test, not an episode.
  const small = kind === 'podcast' ? 'Keep it tiny: only a Welcome part and the one lesson part, two lines each.' : kind === 'video' ? 'Keep it tiny: only three scenes (title, the lesson, closing).' : 'Keep it tiny: two lessons at most.';
  const u = m[1].content;
  m[1].content = typeof u === 'string' ? small + '\n\n' + u : [{ type: 'text', text: small + '\n\n' + u[0].text }, ...u.slice(1)];
  return m;
}
/** Try one unit at every kind. on(kind, result) as each ends. Resolves {kind: {ok, why}}. */
export async function testUnit(model, on, { signal, chat = O.chat } = {}) {
  const key = keyOf(), out = {};
  for (const kind of TEST_KINDS) {
    let res;
    try {
      const r = await chat({ key, messages: testAsk(kind), models: [model], signal });
      if (kind === 'study') {
        const P = await import('./study/parse.js');
        const n = P.count('flashcards', P.items('flashcards', noCites(r.text)));
        res = n >= 2 ? { ok: true } : { ok: false, why: 'its cards could not be read' };
      } else {
        const s = F.parseReply(kind, r.text, { hosts: [{ name: 'Ava' }, { name: 'Andrew' }], lessonIds: kind === 'lessons' ? [] : ['L1'] });
        const n = kind === 'podcast' ? s.segments.reduce((a, g) => a + g.turns.length, 0) : kind === 'video' ? s.scenes.length : s.lessons.length;
        res = n >= (kind === 'lessons' ? 1 : 2) ? { ok: true } : { ok: false, why: 'its reply was too short' };
      }
    } catch (e) {
      if (e && e.code === 'abort') throw e;
      const ex = O.explain(e);
      res = { ok: false, why: e && e.code === 'none' && e.tried ? ex.text.replace(/^Tried /, '').replace(/\. Try again.*$/, '') : (e && e.message) || ex.title };
    }
    out[kind] = res;
    on && on(kind, res);
  }
  return out;
}

/* ── shared bits for the makers (the sheets are make.js's) ───────────────── */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';
export const ICON = SPARK;
/** The two hosts the person chose: a preset pair, or any two voices. */
export function hostsOf(p) {
  const pre = presetOf(p.hosts);
  const a = p.hostA || pre.hosts[0][1], b = p.hostB || pre.hosts[1][1];
  return [{ id: 'A', name: voiceName(a), voice: a }, { id: 'B', name: voiceName(b), voice: b }];
}
