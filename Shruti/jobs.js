// Make with AI in the background (Tony, 2026-10-22): what is being made keeps
// going wherever the person goes in Shruti (or another tab), the Make with AI
// button shows it, the header shows how far a batch has come, and a finished
// one says so. "Build everything" (make.js) is a list of these tasks.
//
// One queue per device, kept in this person's localStorage so a reload picks
// up where it was (the task that was running starts again). Two lanes run at
// once: the AI lane (podcast, video, lessons, study sets: written by a unit,
// then spoken) and the voice lane (read-aloud narrations: speech only). Other
// devices see a task through generate.js's synced jobs.<book>.ch<n>.<kind>.
//
// A task: {id, kind: podcast|video|lessons|read|study, book, n, title, opts,
//   state: queued|running|done|failed|skipped|cancelled, stage, text, done,
//   total, model, stream, cov, error, result, group, at}.
// opts: {length, hosts, narrator, voice, extra, models, kinds, scope, onlyIfNone}.

import * as C from './core.js';
import * as O from './orca.js';
import * as M from './media.js';
import * as G from './generate.js';

export const KIND_NAME = { podcast: 'Podcast', video: 'Video', lessons: 'Lessons', read: 'Read-aloud', study: 'Study set' };
const LANE = (k) => (k === 'read' ? 'voice' : 'ai');
const STORE = () => C.lsKey('queue');

let ui = { toast: () => {}, go: () => {}, context: null, made: null };
/** context(book, n) -> {bookTitle, title, ch, lessons, chapters, loadChapter}; made(task) -> bool (already there). */
export function setUI(x) { ui = Object.assign(ui, x); }

export const tasks = [];
const running = { ai: null, voice: null };
const subs = new Set();
export function on(fn) { subs.add(fn); return () => subs.delete(fn); }
let emitT = 0;
function emit(force) {
  // Streamed text arrives many times a second: listeners hear at most ~8 a second.
  const now = Date.now();
  if (!force && now - emitT < 120) { clearTimeout(emit.t); emit.t = setTimeout(() => emit(true), 130); return; }
  emitT = now;
  subs.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
}

const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const keep = (t) => ({ id: t.id, kind: t.kind, book: t.book, n: t.n, title: t.title, opts: t.opts, group: t.group, at: t.at });
function persist() { C.ls.put(STORE(), tasks.filter((t) => t.state === 'queued' || t.state === 'running').map(keep)); }

/** Add a task (deduped: the same kind for the same chapter, still waiting or running, is not added twice). */
export function add(t) {
  const same = tasks.find((x) => x.kind === t.kind && x.book === t.book && x.n === t.n && (x.state === 'queued' || x.state === 'running') && JSON.stringify(x.opts.scope || null) === JSON.stringify((t.opts || {}).scope || null));
  if (same) return same.id;
  const task = Object.assign({ id: newId(), opts: {}, state: 'queued', at: Date.now(), stage: 'queued', text: 'Waiting', stream: '' }, t);
  tasks.push(task);
  persist(); emit(true); pump();
  return task.id;
}
export const get = (id) => tasks.find((t) => t.id === id) || null;
/** Waiting or running here. */
export const active = () => tasks.filter((t) => t.state === 'queued' || t.state === 'running');
/** The tasks for one chapter (newest first), optionally of one kind. */
export const forChapter = (book, n, kind) => tasks.filter((t) => t.book === book && t.n === n && (!kind || t.kind === kind)).sort((a, b) => b.at - a.at);
/** The newest task of a kind for a chapter (any state), for the sheet. */
export const latest = (book, n, kind) => forChapter(book, n, kind)[0] || null;
export function cancel(id) {
  const t = get(id);
  if (!t) return;
  if (t.state === 'queued') { t.state = 'cancelled'; t.text = 'Cancelled'; persist(); emit(true); return; }
  if (t.state === 'running' && t.abort) t.abort.abort();
}
export function cancelGroup(group) { tasks.filter((t) => t.group === group).forEach((t) => cancel(t.id)); }
/** Forget finished ones (the panel's Clear). */
export function clearDone() {
  for (let i = tasks.length - 1; i >= 0; i--) if (!['queued', 'running'].includes(tasks[i].state)) tasks.splice(i, 1);
  emit(true);
}
/** Overall: {total, finished, running, failed, queued, frac} of what is in the list now. */
export function summary(group) {
  const list = group ? tasks.filter((t) => t.group === group) : tasks;
  const fin = list.filter((t) => ['done', 'failed', 'skipped', 'cancelled'].includes(t.state));
  const run = list.filter((t) => t.state === 'running');
  const part = run.reduce((s, t) => s + (t.total ? Math.min(0.95, 0.15 + 0.8 * (t.done / t.total)) : 0.1), 0);
  return { total: list.length, finished: fin.length, running: run.length, failed: list.filter((t) => t.state === 'failed').length, queued: list.filter((t) => t.state === 'queued').length, frac: list.length ? (fin.length + part) / list.length : 0 };
}

/* ── the runner ──────────────────────────────────────────────────────────── */
function pump() {
  for (const lane of ['ai', 'voice']) {
    if (running[lane]) continue;
    const next = tasks.find((t) => t.state === 'queued' && LANE(t.kind) === lane);
    if (next) exec(next, lane);
  }
}
async function exec(t, lane) {
  running[lane] = t;
  Object.assign(t, { state: 'running', stage: 'start', text: 'Starting', stream: '', error: null, done: 0, total: 0, abort: new AbortController(), started: Date.now() });
  persist(); emit(true);
  const set = (k) => { Object.assign(t, k); emit(); };
  try {
    if (!ui.context) throw new Error('Shruti is still starting');
    const ctx = await ui.context(t.book, t.n);
    if (t.opts.onlyIfNone && ui.made && ui.made(t, ctx)) { Object.assign(t, { state: 'skipped', text: 'Already made' }); return; }
    const o = t.opts;
    // The units for this task: its own list (Build everything can name one), else the person's chain.
    const models = (o.models && o.models.length ? o.models : O.chain(C.me.get('units', {}) || {}, O.cachedModels(String(C.me.get('orcaKey', '') || ''))));
    if (t.kind === 'study') {
      const P = await import('./study/parse.js');
      const H = await import('./study/hub.js');
      const sc = await H.scopeText(ctx, o.scope);
      set({ stage: 'write', text: 'Writing' });
      const res = await G.runStudy({ kinds: o.kinds, book: t.book, bookTitle: ctx.bookTitle, scope: sc, text: sc.text, lessons: sc.lessons, length: o.length, extra: o.extra, models }, {
        kind: (k, i) => set({ stage: 'write', text: 'Writing the ' + k, done: i, total: o.kinds.length }),
        delta: (d) => { t.stream += d; emit(); },
        model: (m) => set({ model: m }),
        done: (k, cnt) => set({ text: 'Made the ' + k + ' (' + cnt + ')' }),
      }, { signal: t.abort.signal, parse: P });
      const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      H.saveSet(t.book, { id, kinds: res.kinds, model: res.model, by: C.P, at: Date.now(), length: o.length, scope: { t: sc.t, ch: sc.ch, label: sc.label }, ...(o.extra ? { asked: o.extra.slice(0, 300) } : {}) });
      t.result = { set: id, kinds: o.kinds };
      // The Study tab opens on the new set (its first kind), as the old maker did.
      C.ls.put(C.lsKey('study.' + t.book + '.' + t.n), { set: id, kind: o.kinds[0] });
    } else {
      const res = await G.run({
        kind: t.kind, book: t.book, bookTitle: ctx.bookTitle, n: t.n, title: ctx.title, ch: ctx.ch, lessons: ctx.lessons,
        length: o.length || 'standard', hosts: o.hosts, narrator: o.narrator, voice: o.voice, extra: o.extra, models,
      }, {
        stage: (id, text) => set({ stage: id, text, repaired: t.repaired || id === 'repair', lessonsFirst: t.lessonsFirst || (id === 'lessons' && t.kind !== 'lessons') }),
        delta: (d) => { t.stream += d; emit(); },
        model: (m) => set({ model: m }),
        coverage: (cov) => set({ cov }),
        step: (done, total) => set({ done, total }),
      }, { signal: t.abort.signal });
      t.result = { local: !!res.local, model: res.model };
    }
    Object.assign(t, { state: 'done', stage: 'done', text: t.result && t.result.local ? 'Ready on this device' : 'Saved' });
  } catch (e) {
    const ex = O.explain(e);
    if (e && e.code === 'key') O.forget();
    Object.assign(t, { state: e && e.code === 'abort' ? 'cancelled' : 'failed', error: e && e.code === 'abort' ? null : ex, text: e && e.code === 'abort' ? 'Cancelled' : ex.title });
  } finally {
    t.abort = null; t.ended = Date.now();
    running[lane] = null;
    persist(); emit(true);
    tell(t);
    pump();
  }
}
/** A finished task says so wherever the person is (not for a batch's every item). */
function tell(t) {
  if (t.group && active().some((x) => x.group === t.group)) return;
  if (t.group) {
    const s = summary(t.group);
    ui.toast('Build everything finished: ' + (s.total - s.failed) + ' of ' + s.total + ' made' + (s.failed ? ', ' + s.failed + ' could not be' : ''), !!s.failed);
    return;
  }
  const what = KIND_NAME[t.kind] + (t.n != null ? ' for chapter ' + t.n : '');
  if (t.state === 'done') ui.toast(what + (t.result && t.result.local ? ' is ready on this device' : ' is ready'), false, { label: 'Open', fn: () => openResult(t) });
  else if (t.state === 'failed') ui.toast(what + ' could not be made: ' + (t.error && t.error.title || 'it stopped'), true, { label: 'See why', fn: () => ui.openJobs && ui.openJobs() });
}
export const TAB = { podcast: 'listen', video: 'watch', lessons: 'lessons', read: '', study: 'study' };
/** Go to what a task made, and play a podcast or video. */
export function openResult(t) {
  if (t.kind === 'podcast' || t.kind === 'video') ui.playWhenShown && ui.playWhenShown(t.kind, t.book, t.n);
  ui.go('#/b/' + t.book + '/' + t.n + (TAB[t.kind] ? '/' + TAB[t.kind] : ''));
}

/** After a reload: what was waiting (or running) on this device starts again. */
export function resume() {
  const saved = C.ls.json(STORE(), []) || [];
  if (!saved.length || tasks.length) return 0;
  saved.forEach((t) => tasks.push(Object.assign({ state: 'queued', stage: 'queued', text: 'Waiting', stream: '' }, t)));
  emit(true);
  pump();
  return saved.length;
}
