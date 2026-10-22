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
import * as OR from './order.js';
import * as F from './formats.js';

let ui = { toast: () => {}, go: () => {}, openSettings: () => {} };
export function setUI(x) { ui = Object.assign(ui, x); }
const keyOf = () => String(C.me.get('orcaKey', '') || '');

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
export const HOST_PRESETS = [
  { name: 'Ava & Andrew', hosts: [['Ava', 'en-US-AvaMultilingualNeural'], ['Andrew', 'en-US-AndrewMultilingualNeural']] },
  { name: 'Emma & Brian', hosts: [['Emma', 'en-US-EmmaMultilingualNeural'], ['Brian', 'en-US-BrianMultilingualNeural']] },
  { name: 'Sonia & Ryan', hosts: [['Sonia', 'en-GB-SoniaNeural'], ['Ryan', 'en-GB-RyanNeural']] },
  { name: 'Neerja & Prabhat', hosts: [['Neerja', 'en-IN-NeerjaNeural'], ['Prabhat', 'en-IN-PrabhatNeural']] },
];
/** A video's narrator unless the person picks another (Tony, 2026-10-22: Sonia). */
export const DEFAULT_NARRATOR = 'en-GB-SoniaNeural';
export const prefs = () => Object.assign({ kind: 'podcast', length: 'standard', hosts: 0, hostA: null, hostB: null, narrator: DEFAULT_NARRATOR, voice: O.DEFAULT_VOICE, extra: '' }, C.me.get('gen', {}) || {});
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
      const askAll = async (msgs, label) => {
        let text = await ask(msgs);
        for (let c = 0; c < 3 && !F.finished(k, text) && !(c === 0 && label === 'main' && looksDone(k, text, pctx)); c++) {
          if (label === 'main') stage(k === kind ? 'write' : 'lessons', 'Going on (part ' + (c + 2) + ')');
          on.delta && on.delta('\n');
          text += '\n' + await ask(F.continuePrompt(msgs, text));
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
            try { script = F.mergeLessons(k, script, F.parseReply(k, more, pctx)); } catch (e) {}
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
    // The unit that answered last goes first; each unit gets one fix, then the next one tries.
    const order = model ? [model, ...o.models.filter((x) => x !== model)] : o.models.slice();
    const tried = [];
    let it = null;
    for (const m of order) {
      if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'abort' });
      const ask = (msgs2) => chat({ key, messages: msgs2, models: [m], signal, onDelta: (t) => on.delta && on.delta(t), onModel: (x) => { model = x; on.model && on.model(x); } });
      try {
        let r = await ask(msgs);
        it = P.items(kind, r.text);
        if (!P.count(kind, it)) {
          on.delta && on.delta('\n\n');
          r = await ask(msgs.concat([{ role: 'assistant', content: r.text }, { role: 'user', content: 'That could not be read. Reply again in exactly the format asked for, as plain text (no JSON, no code block), nothing else.' }]));
          it = P.items(kind, r.text);
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

/* ── the sheet ───────────────────────────────────────────────────────────── */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
export const ICON = SPARK;
const TAB = { podcast: 'listen', video: 'watch', lessons: 'lessons', read: '' };
// running: the run on this device; kept after it ends (finished) so the sheet
// can still show how it went, but only an unfinished one blocks another.
let running = null;
const modelsNow = () => O.cachedModels(keyOf());
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
    '<div class="chips gen-kinds" role="radiogroup" aria-label="What to make">' + M.KINDS.filter((k) => ctx.n !== 0 || k === 'read').map((k) => '<button class="chip" role="radio" data-kind="' + k + '">' + M.KIND_NAME[k] + '</button>').join('') +
    '<button class="chip" data-study title="Flashcards, a quiz, a mind map or slides">Study set</button></div>' +
    '<section class="card" id="gen-vers"></section><section class="card" id="gen-opts"></section><section class="card" id="gen-run"></section></aside>';
  document.body.appendChild(dim);
  const off = [];
  const close = () => { dim.remove(); removeEventListener('keydown', onKey); off.forEach((f) => f()); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  addEventListener('keydown', onKey);
  dim.addEventListener('click', (e) => { if (e.target === dim || e.target.closest('[data-close]')) close(); });
  dim.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => { st.kind = b.dataset.kind; setPref('kind', st.kind); draw(); }));
  // Study sets have their own maker, with a scope picker, on the Study tab.
  dim.querySelector('[data-study]').addEventListener('click', () => { close(); dispatchEvent(new CustomEvent('shruti:make-study', { detail: { book: ctx.book, n: ctx.n } })); });
  const draw = () => {
    dim.querySelectorAll('[data-kind]').forEach((b) => { const on = b.dataset.kind === st.kind; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    drawVersions(dim.querySelector('#gen-vers'), ctx, st.kind);
    drawOptions(dim.querySelector('#gen-opts'), ctx, st.kind);
    drawRun(dim.querySelector('#gen-run'), ctx, st.kind, close);
  };
  draw();
  // Another device's job, a version saved elsewhere: redraw (unless typing).
  const redraw = () => { if (!dim.isConnected) return; if (window.A1Drag && A1Drag.active) { A1Drag.later(redraw); return; } if (document.activeElement && document.activeElement.closest('#gen-opts')) return; drawVersions(dim.querySelector('#gen-vers'), ctx, st.kind); if (!running) drawRun(dim.querySelector('#gen-run'), ctx, st.kind, close); };
  off.push(C.on('doc:shared', redraw), C.on('doc:me', redraw));
  // What the key may use, so the unit chips say ready / offline / not allowed.
  if (keyOf() && !modelsNow()) O.models(keyOf()).then(() => { if (dim.isConnected && !running) { drawOptions(dim.querySelector('#gen-opts'), ctx, st.kind); drawRun(dim.querySelector('#gen-run'), ctx, st.kind, close); } });
}

function drawVersions(box, ctx, kind) {
  const list = M.versions(ctx.book, ctx.n, kind), cur = M.featured(ctx.book, ctx.n, kind);
  const orderKey = 'ver.' + ctx.book + '.ch' + ctx.n + '.' + kind;
  const shipped = ctx.shipped && ctx.shipped[kind];
  // The pick is a radio div, not a button, so a mouse can take the row by it
  // to drag (each person's own order of versions, order.ver.<book>.ch<n>.<kind>).
  const row = (id, title, meta, canDelete) => '<div class="gv' + ((cur || null) === id ? ' on' : '') + '" data-dkey="' + esc(id || 'orig') + '" title="' + esc(OR.HINT) + '"><div class="gv-pick" tabindex="0" data-feature="' + esc(id || '') + '" role="radio" aria-checked="' + ((cur || null) === id) + '"><span class="dot"></span><span><b>' + esc(title) + '</b><span>' + esc(meta) + '</span></span></div>' +
    (canDelete ? '<button class="ib" data-del="' + esc(id) + '" title="Delete this version" aria-label="Delete this version"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>' : '') + '</div>';
  const when = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
  const desc = (r) => [r.model && modelName(r.model), r.voices && r.voices.filter(Boolean).map(voiceName).join(' & '), r.duration && T.fmtTime(r.duration), r.lessons && r.lessons.length + ' lessons', r.by && (C.PROFILES[r.by] ? C.PROFILES[r.by].label : r.by), when(r.at)].filter(Boolean).join(' · ');
  const job = M.jobOf(ctx.book, ctx.n, kind);
  box.innerHTML = '<h3>Versions</h3>' +
    (job && !(running && running.kind === kind && running.ctx.n === ctx.n) ? '<div class="stat busy gen-other"><i></i><span>' + esc((C.PROFILES[job.by] ? C.PROFILES[job.by].label : job.by) + ' is making this' + (job.text ? ': ' + job.text.toLowerCase() : '') + '…') + '</span></div>' : '') +
    '<div class="gvs">' +
    OR.arrange([...(shipped ? [{ k: 'orig', html: row(null, kind === 'lessons' ? 'Your own notes' : 'Comes with Shruti', shipped, false) }] : []),
      ...list.map((r) => ({ k: r.id, html: row(r.id, kind === 'lessons' ? 'Lessons by ' + modelName(r.model) : (M.KIND_NAME[kind] + (r.length ? ' · ' + (LENGTHS[r.length] || {}).label : '')), desc(r), true) }))],
    (x) => x.k, OR.get(orderKey)).map((x) => x.html).join('') +
    (!shipped && !list.length ? '<p class="hint">Nothing made yet.</p>' : '') + '</div>' +
    (list.length || shipped ? '<p class="hint gv-h">The ticked one is what plays, on every device' + (C.shared === M.docFor(ctx.book) ? ' and for both of you' : '') + '.</p>' : '');
  OR.sortable(box.querySelector('.gvs'), { row: '.gv', onMove: (ks) => { OR.put(orderKey, ks); drawVersions(box, ctx, kind); } });
  box.querySelectorAll('[data-feature]').forEach((b) => b.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.altKey) { e.preventDefault(); b.click(); } }));
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
  const rows = O.unitRows(C.me.get('units', {}) || {}, modelsNow());
  const units = '<div class="gen-f"><span>Units, in order</span><div class="chips gen-units">' + rows.map((r) => '<button class="chip' + (r.on ? ' on' : '') + (r.status !== 'ready' && r.status !== 'unknown' ? ' off' : '') + '" data-unit="' + esc(r.id) + '" role="checkbox" aria-checked="' + r.on + '" title="' + esc(O.STATUS[r.status] ? r.name + ': ' + O.STATUS[r.status] : '') + '" aria-label="' + esc(r.name + (O.STATUS[r.status] ? ', ' + O.STATUS[r.status] : '')) + '">' + (r.on ? CHECK : '') + esc(r.name) + '</button>').join('') + '</div><button class="lk" data-units>Order them in Settings</button></div>';
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

const STAGES = { lessons: 'Find every lesson', write: 'Write', check: 'Check every lesson', repair: 'Repair', speak: 'Speak', upload: 'Save to Drive', done: 'Done' };
function drawRun(box, ctx, kind, close) {
  const mine = running && running.ctx.n === ctx.n && running.ctx.book === ctx.book && running.kind === kind;
  const other = !mine && M.jobOf(ctx.book, ctx.n, kind);
  if (!mine) {
    const L = (ctx.lessons && ctx.lessons.lessons) || [];
    // Said before pressing Make: no key, a refused key, no unit this key may use.
    const pre = isBusy() || other ? null : kind === 'read' ? (keyOf() ? null : O.preflight('')) : O.preflight(keyOf(), C.me.get('units', {}) || {}, modelsNow());
    box.innerHTML = problemHTML(pre) + '<div class="gen-go"><button class="btn solid" data-make' + (isBusy() || other ? ' disabled' : '') + '>' + SPARK + 'Make ' + M.KIND_NAME[kind].toLowerCase() + '</button>' +
      '<span class="hint">' + esc(isBusy() ? 'One thing at a time: ' + M.KIND_NAME[running.kind].toLowerCase() + ' for chapter ' + running.ctx.n + ' is being made.' : kind === 'read' ? 'Takes a few minutes.' : kind === 'lessons' ? 'About a minute.' : 'A few minutes: written, checked' + (L.length ? ' for all ' + L.length + ' lessons' : '') + ', then spoken.') + '</span></div>';
    const b = box.querySelector('[data-make]');
    b.addEventListener('click', () => start(ctx, kind, box, close));
    bindProblem(box, close);
    return;
  }
  paintRun(box, running);
}
function paintRun(box, R) {
  if (!box || !box.isConnected) return;
  const L = (R.ctx.lessons && R.ctx.lessons.lessons) || [];
  const stages = R.kind === 'read' ? ['speak', 'upload', 'done'] : R.kind === 'lessons' ? ['write', 'check', 'done'] : ['write', 'check', 'speak', R.local ? 'done' : 'upload', 'done'].filter((s, i, a) => a.indexOf(s) === i);
  if (R.repaired && !stages.includes('repair')) stages.splice(2, 0, 'repair');
  if (R.lessonsFirst) stages.unshift('lessons');
  const idx = stages.indexOf(R.stage);
  box.innerHTML = '<h3>' + (R.error ? 'It stopped' : R.stage === 'done' ? 'Made' : 'Making ' + M.KIND_NAME[R.kind].toLowerCase()) + (R.model ? '<span class="gen-model">' + esc(modelName(R.model)) + '</span>' : '') + '</h3>' +
    '<ol class="gen-steps">' + stages.map((s, i) => '<li class="' + (R.error && i === idx ? 'bad' : i < idx || R.stage === 'done' ? 'done' : i === idx ? 'cur' : '') + '">' + esc(STAGES[s]) + (s === R.stage && R.text && !/^(Writing|Checking|Saved)$/.test(R.text) ? ' <span>' + esc(R.text) + '</span>' : '') + '</li>').join('') + '</ol>' +
    (R.total ? '<div class="gen-bar"><i style="width:' + (100 * R.done / R.total).toFixed(1) + '%"></i></div>' : '') +
    (R.cov && L.length && R.kind !== 'lessons' && R.kind !== 'read' ? '<div class="gen-cov">' + L.map((l) => '<span class="' + (R.cov.covered.includes(l.id) ? 'ok' : 'no') + '" title="' + esc(l.title || '') + '">' + esc(l.id) + '</span>').join('') + '<em>' + R.cov.covered.length + ' of ' + L.length + ' lessons</em></div>' : '') +
    (R.text && R.stream ? '<details class="gen-live"' + (R.stage === 'write' || R.stage === 'repair' ? ' open' : '') + '><summary>What ' + esc(modelName(R.model) || 'the unit') + ' wrote</summary><pre>' + esc(R.stream.slice(-6000)) + '</pre></details>' : '') +
    (R.error ? problemHTML(R.error) : '') +
    (R.stage === 'done' && !R.error ? '<div class="stat good"><i></i><span>' + esc(R.local ? 'Made. Google Drive is not connected, so it plays on this device only, until the page is reloaded.' : 'Saved, and it plays now on every device.') + '</span></div>' : '') +
    '<div class="gen-go">' + (R.stage === 'done' || R.error ? (TAB[R.kind] !== undefined && !R.error ? '<button class="btn solid" data-open>' + (R.kind === 'lessons' ? 'See the lessons' : R.kind === 'read' ? 'Read along' : 'Play it') + '</button>' : '') + '<button class="btn" data-again>' + (R.error ? 'Try again' : 'Make another') + '</button>' : '<button class="btn" data-cancel>Cancel</button>') + '</div>';
  const pre = box.querySelector('.gen-live pre'); if (pre) pre.scrollTop = pre.scrollHeight;
  const c = box.querySelector('[data-cancel]'); if (c) c.addEventListener('click', () => R.abort.abort());
  const o = box.querySelector('[data-open]'); if (o) o.addEventListener('click', () => { const sh = document.getElementById('gen-sheet'); if (sh) sh.remove(); running = null; if (R.kind === 'podcast') POD.playWhenShown(R.ctx.book, R.ctx.n); if (R.kind === 'video') VID.playWhenShown(R.ctx.book, R.ctx.n); ui.go('#/b/' + R.ctx.book + '/' + R.ctx.n + (TAB[R.kind] ? '/' + TAB[R.kind] : '')); });
  bindProblem(box, () => { const sh = document.getElementById('gen-sheet'); if (sh) sh.remove(); });
  const a = box.querySelector('[data-again]'); if (a) a.addEventListener('click', () => { running = null; drawRun(box, R.ctx, R.kind, R.close); });
}
async function start(ctx, kind, box, close) {
  if (isBusy()) return;
  // Nothing is sent when it cannot work: no key, a refused key, no unit allowed.
  const stop = kind === 'read' ? (keyOf() ? null : O.preflight('')) : await aiReady();
  if (stop) { const p = box.querySelector('.ai-prob'); if (p) p.remove(); box.insertAdjacentHTML('afterbegin', problemHTML(stop)); bindProblem(box, close); return; }
  const models = O.chain(C.me.get('units', {}) || {}, O.cachedModels(keyOf()));
  const p = prefs();
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
      stage: (id, text) => { R.stage = id; R.text = text; if (id === 'repair') R.repaired = true; if (id === 'lessons' && kind !== 'lessons') R.lessonsFirst = true; paint(true); },
      delta: (d) => { R.stream += d; paint(); },
      model: (m) => { R.model = m; paint(true); },
      coverage: (cov) => { R.cov = cov; paint(true); },
      step: (done, total) => { R.done = done; R.total = total; paint(done === total); },
    }, { signal: R.abort.signal });
    R.local = !!res.local; R.stage = 'done'; R.total = 0;
    ui.toast(M.KIND_NAME[kind] + ' for chapter ' + ctx.n + (res.local ? ' is ready on this device' : ' is saved'));
  } catch (e) {
    R.error = O.explain(e);
    if (e && e.code === 'key') O.forget();
  }
  R.finished = true;
  paintRun(box2(), R);
}
