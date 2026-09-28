// Verifies "Start now" (engagement 5.3) in a real browser.
//
//   one click from the home screen -> a relevant session is open AND a
//   ten-minute focus timer is running behind it, WITHOUT switching to the
//   pomodoro view (which would bury the session under the timer).
//
// Also: the caption under the button previews the choice before the click,
// and "Focus on top task" still does what the old button did.
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
  else { fail++; console.log('  FAIL ' + name, extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 400)); }
};

try { await launch(); }
catch (e) { if (e.code === 'NO_BROWSER') { console.log('SKIP: ' + e.message); process.exit(0); } throw e; }
const { send, evalJs, events } = await connect();
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: PAGE });
await new Promise((r) => setTimeout(r, 3500));

// Isolate from Firestore, drop leftovers, seed two classes: a calm one with a
// few due cards, and one with an exam in 4 days and only NEW cards. Pressure
// should send "Start now" to the exam class.
const seeded = await evalJs(`(async function(){
  window._fbSaveStudyOs = function(){}; window._fbSaveCards = function(){};
  window._fbSaveDoc = function(){}; window._fbSaveSessions = function(){};
  for (var i = classes.length - 1; i >= 0; i--) if (/^vs[12]$/.test(classes[i].id)) classes.splice(i, 1);
  for (var j = events.length - 1; j >= 0; j--) if (events[j].id === 'vse1') events.splice(j, 1);
  classes.push({ id:'vs1', name:'Calm Class', color:'#8fd6ad', modules:[] });
  classes.push({ id:'vs2', name:'Exam Class', color:'#ef9f9f', modules:[] });
  var d = new Date(); d.setDate(d.getDate() + 4);
  events.push({ id:'vse1', name:'Midterm', classId:'vs2', type:'exam', date: d.toISOString().slice(0,10), weight:'25' });
  localStorage.setItem('studyos_cards_vs1', '[]'); localStorage.setItem('studyos_cards_vs2', '[]');
  var deck = window.SOS.deck;
  deck.addExternal('vs1', 'm', [{front:'Calm card one?', back:'a'}, {front:'Calm card two?', back:'b'}], { noteId:'n1' });
  var now = Date.now();
  deck.forClass('vs1').forEach(function(c){ c.sched = { state:'review', stability:1, difficulty:5, reps:1, lapses:0,
    lastReview: now - 20*86400000, due: now - 19*86400000, lastInterval: 1 }; });
  deck.addExternal('vs2', 'm', [{front:'Exam card one?', back:'a'}, {front:'Exam card two?', back:'b'}, {front:'Exam card three?', back:'c'}], { noteId:'n2' });
  window.dispatchEvent(new CustomEvent('sos-changed', { detail:{ entity:'cards' } }));
  await new Promise(function(r){ setTimeout(r, 600); });
  return true;
})()`);
t('seeded two classes', seeded === true);

console.log('\nbefore the click');
const before = await evalJs(`({
  btn: (document.getElementById('sos-start-btn')||{}).textContent || '',
  why: (document.getElementById('sos-start-why')||{}).textContent || '',
  view: (document.querySelector('.view.active')||{}).id,
  pick: window.SOS.startnow.pick(),
})`);
t('the button says what it does', /Start now/.test(before.btn), before.btn);
t('the caption previews the choice', /^Next up:/.test(before.why), before.why);
t('the exam class wins on pressure', before.pick && before.pick.classId === 'vs2', before.pick);
t('...with its new cards', before.pick && before.pick.kind === 'new', before.pick);
t('the caption names the exam', /Exam Class/.test(before.why) && /exam in 4 days/.test(before.why), before.why);

console.log('\none click');
await evalJs(`document.getElementById('sos-start-btn').click(); true;`);
await new Promise((r) => setTimeout(r, 800));
const after = await evalJs(`({
  view: (document.querySelector('.view.active')||{}).id,
  running: typeof pomoRunning !== 'undefined' && pomoRunning,
  minutes: (document.getElementById('pomo-inp-work')||{}).value,
  pomoClass: typeof _sosPomoClassId !== 'undefined' ? _sosPomoClassId : null,
  review: !!document.querySelector('.sos-review'),
  q: (document.querySelector('.sos-review-q')||{}).textContent || '',
})`);
t('a focus timer is running', after.running === true, after);
t('...set to ten minutes', after.minutes === '10', after.minutes);
t('...attributed to the chosen class', after.pomoClass === 'vs2', after.pomoClass);
t('the review session is open', after.review, after);
t('...on the chosen class\'s cards', /Exam card/.test(after.q), after.q);
t('the page did NOT switch to the pomodoro view', after.view === 'view-home', after.view);

// Tear down: close the review, stop the timer.
await evalJs(`window.SOS.review.closeReview(); if (pomoRunning) togglePomo(); resetPomo && resetPomo(); true;`);

console.log('\nthe old button still works');
await evalJs(`document.getElementById('sos-start-10').click(); true;`);
await new Promise((r) => setTimeout(r, 600));
const old = await evalJs(`({ view: (document.querySelector('.view.active')||{}).id, running: pomoRunning })`);
t('"Focus on top task" opens the timer on the top priority item', old.view === 'view-pomodoro' && old.running, old);
await evalJs(`if (pomoRunning) togglePomo(); true;`);

console.log('\nnothing to do');
const empty = await evalJs(`(function(){
  var r = window.SOS.startnow.rank([]);
  return r;
})()`);
t('an empty study set picks nothing (the button then says all caught up)', empty === null);

const errs = events
  .filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params.exceptionDetails?.exception?.description || '?')
  .filter((e) => !/firebase|firestore|net::|Failed to load|recaptcha|appCheck|installations|FirebaseError|gstatic|ERR_/i.test(e));
console.log('\noverall');
t('no uncaught exceptions', errs.length === 0, errs.slice(0, 5));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
