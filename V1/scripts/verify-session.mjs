// Drives the session engine (spec S-1, S-2, S-3, M-1) in a real browser.
//
// The claim being tested is the one the whole phase rests on: the timer used to
// record NOTHING, so there was no evidence studying happened and therefore no
// sense of progress. These runs prove a session is actually written down, that
// a review counts as studying too, and that the queue can now be acted on
// rather than only read.
//
// Run:  node scripts/verify-session.mjs      (after npm run build)
import { launch, connect } from './cdp.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist/studyos/index.html');
if (!existsSync(dist)) { console.error('Build first:  npm run build'); process.exit(2); }
const PAGE = 'file:///' + dist.split(String.fromCharCode(92)).join('/');

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 350))); }
};

try {
  await launch();
} catch (e) {
  if (e.code === 'NO_BROWSER') { console.log('SKIP: ' + e.message); process.exit(0); }
  throw e;
}
const { send, evalJs, events } = await connect();
await send('Runtime.enable');
await send('Page.enable');

// Start from a clean log and deck — this file writes both, and a previous run's
// data would make "a session was logged" true before anything ran.
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try {
    Object.keys(localStorage)
      .filter(k => k.indexOf('studyos_cards_') === 0 || k === 'studyos_sessions_v1')
      .forEach(k => localStorage.removeItem(k));
    // This file seeds events and tasks, and both persist. Without clearing
    // them a second run accumulates duplicates and the assertions drift.
    localStorage.setItem('studyos_events', '[]');
    localStorage.setItem('studyos_tasks', '[]');
  } catch (e) {}`,
});
await send('Page.navigate', { url: PAGE });
await new Promise(r => setTimeout(r, 5000));

console.log('\nmodule wiring');
t('sessions module loaded', await evalJs('typeof (window.SOS && window.SOS.sessions) === "object"'));
t('start-session hook defined', await evalJs('typeof window.sosStartSession === "function"'));
t('the log starts empty', (await evalJs('window.SOS.sessions.all().length')) === 0);

// ── S-3: a focus block is written down ────────────────────────────────────
console.log('\nS-3: the timer now records');
const logged = await evalJs(`(() => {
  const s = window.SOS.sessions.log('focus', { classId:'x1', durationMs: 25*60000, completed:true });
  return s && { id: s.id, mins: Math.round(s.durationMs/60000), day: s.day, completed: s.completed };
})()`);
t('a focus session is stored', !!logged && logged.mins === 25, logged);
t('it carries a local day key', /^\d{4}-\d{2}-\d{2}$/.test(logged.day), logged.day);
t('it survives a read-back', (await evalJs('window.SOS.sessions.all().length')) === 1);
t('a ten-second timer is not logged', (await evalJs(
  'window.SOS.sessions.log("focus", { durationMs: 9000 }) === null')));
t('and did not reach the log', (await evalJs('window.SOS.sessions.all().length')) === 1);

// ── The pomodoro path itself ──────────────────────────────────────────────
console.log('\nthe real timer path');
t('timer start records a start time', await evalJs(`(() => {
  if (typeof togglePomo !== 'function') return false;
  if (pomoMode !== 'work') setPomoMode('work');
  if (pomoRunning) togglePomo();
  togglePomo();                        // start
  return pomoRunning === true;
})()`));
const paused = await evalJs(`(async () => {
  await new Promise(r => setTimeout(r, 1200));
  const before = window.SOS.sessions.all().length;
  togglePomo();                        // pause -> logs a partial block
  return { before, after: window.SOS.sessions.all().length, running: pomoRunning };
})()`);
t('pausing stops the timer', paused.running === false);
// Under a minute is intentionally NOT logged, so the count must not move.
t('a sub-minute block is not logged as study', paused.after === paused.before, paused);

// ── M-1: the streak tile ──────────────────────────────────────────────────
console.log('\nM-1: streak');
await evalJs('updateStats(); true;');
t('the streak tile exists', await evalJs('!!document.getElementById("stat-streak")'));
t('it reports the streak', (await evalJs(
  'document.getElementById("stat-streak").textContent')) !== '',
  await evalJs('document.getElementById("stat-streak").textContent'));
t('one logged day reads as 1 day', (await evalJs(
  'window.SOS.sessions.streak()')) === 1, await evalJs('window.SOS.sessions.streak()'));
t('the tile explains itself on hover', (await evalJs(
  '(document.getElementById("stat-card-streak").title||"").length > 0')));

// ── S-1: Start Session ────────────────────────────────────────────────────
console.log('\nS-1: Start Session');
t('the button exists', await evalJs('!!document.getElementById("sos-start-btn")'));
t('"Just 10 min" exists', await evalJs('!!document.getElementById("sos-start-10")'));
t('it is a large target', (await evalJs(
  'Math.round(document.getElementById("sos-start-btn").getBoundingClientRect().height)')) >= 44,
  await evalJs('Math.round(document.getElementById("sos-start-btn").getBoundingClientRect().height)'));

const started = await evalJs(`(() => {
  // Seed one piece of work so the queue has a top item.
  const cls = { id:'sx1', name:'Databases', color:'#9dc0ee', modules:[] };
  classes.push(cls);
  const d = new Date(Date.now() + 3*86400000).toISOString().slice(0,10);
  events.push({ id:'ex1', classId:'sx1', type:'hw', name:'HW3', date:d, weight:15 });
  updateStats();
  document.getElementById('sos-start-btn').click();
  return { view: activeView, running: pomoRunning, cls: currentClassId, mode: pomoMode };
})()`);
t('it switches to the timer', started.view === 'pomodoro', started);
t('it starts the clock', started.running === true, started);
t('it attributes the session to the class', started.cls === 'sx1', started);
t('it starts a WORK block, not a break', started.mode === 'work', started);

// A completed block must reach the log with the right class.
const completed = await evalJs(`(() => {
  const before = window.SOS.sessions.all().length;
  // Backdate the start so the block counts as real, then finish it.
  _sosPomoStartedAt = Date.now() - 26*60000;
  pomoWorker.onmessage({ data: { type: 'done' } });
  const list = window.SOS.sessions.all();
  const last = list[list.length-1];
  return { grew: list.length === before + 1, classId: last && last.classId,
           mins: last && Math.round(last.durationMs/60000), completed: last && last.completed };
})()`);
t('a completed block is logged', completed.grew === true, completed);
t('with its class', completed.classId === 'sx1', completed);
t('with its duration', completed.mins >= 25, completed);
t('marked completed', completed.completed === true);

t('"Just 10 min" sets a short block', (await evalJs(`(() => {
  if (pomoRunning) togglePomo();
  window.sosStartSession(10);
  return document.getElementById('pomo-inp-work').value;
})()`)) === '10');

// ── S-2: the queue is actionable ──────────────────────────────────────────
console.log('\nS-2: the priority queue can be acted on');
await evalJs(`(() => {
  if (pomoRunning) togglePomo();
  switchView('home');
  // Drop any copy left by a previous run: the tasks array is persisted to
  // localStorage, so pushing blindly created a SECOND 'Finish problem set',
  // the tick completed one and the other stayed on screen. The failure looked
  // like the queue not refreshing and was my test leaking state.
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (tasks[i] && tasks[i].id === 'tk1') tasks.splice(i, 1);
  }
  tasks.push({ id:'tk1', name:'Finish problem set', dueDate:new Date(Date.now()+2*86400000).toISOString().slice(0,10),
               classId:'sx1', type:'hw', priority:'high', done:false, createdAt:Date.now() });
  renderPriorityQueue();
  return true;
})()`);
t('rows render', (await evalJs('document.querySelectorAll(".sos-pq-item").length')) > 0);
t('every row offers Start', (await evalJs(
  'Array.from(document.querySelectorAll(".sos-pq-item")).every(r => !!r.querySelector("[data-act=start]"))')));
t('a task row offers Done', (await evalJs(
  'document.querySelectorAll(".sos-pq-item [data-act=done]").length')) >= 1);

const tick = await evalJs(`(() => {
  const row = Array.from(document.querySelectorAll('.sos-pq-item'))
    .find(r => r.textContent.includes('Finish problem set'));
  if (!row) return { found:false };
  row.querySelector('[data-act=done]').click();
  const task = tasks.find(t => t.id === 'tk1');
  return { found:true, done: task.done,
           gone: !Array.from(document.querySelectorAll('.sos-pq-item'))
                    .some(r => r.textContent.includes('Finish problem set')) };
})()`);
t('ticking a row completes the task', tick.found && tick.done === true, tick);
t('and the row leaves the queue', tick.gone === true, tick);

const startBtn = await evalJs(`(() => {
  switchView('home');
  renderPriorityQueue();
  const row = document.querySelector('.sos-pq-item');
  if (!row) return { none:true };
  row.querySelector('[data-act=start]').click();
  return { view: activeView, running: pomoRunning };
})()`);
t('the row Start button starts a session', startBtn.running === true, startBtn);
t('and opens the timer', startBtn.view === 'pomodoro', startBtn);

// A row action must not also open the edit modal underneath.
t('the action does not also open the editor', (await evalJs(
  'document.querySelectorAll(".sos-modal.open").length')) === 0);

// ── Review sessions count as studying ─────────────────────────────────────
console.log('\nreview counts as studying');
const rev = await evalJs(`(() => {
  const before = window.SOS.sessions.all().length;
  window.SOS.sessions.log('review', { classId:'sx1', durationMs: 7*60000, cards: 23, accuracy: 82 });
  const list = window.SOS.sessions.all();
  const last = list[list.length-1];
  return { grew: list.length === before+1, kind: last.kind, cards: last.cards, acc: last.accuracy };
})()`);
t('a review session is logged', rev.grew === true, rev);
t('it records cards and accuracy', rev.cards === 23 && rev.acc === 82, rev);
t('it counts toward the day', (await evalJs('window.SOS.sessions.dayTotals().cards')) >= 23);

const errs = events
  .filter(e => e.method === 'Runtime.exceptionThrown')
  .map(e => e.params.exceptionDetails?.exception?.description || '?')
  .filter(e => !/firebase|firestore|net::|Failed to load|recaptcha|appCheck|installations|FirebaseError|gstatic|ERR_/i.test(e));
t('no uncaught exceptions throughout', errs.length === 0, errs.slice(0, 3));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
