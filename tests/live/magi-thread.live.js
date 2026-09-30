// LIVE test -- the real console against the real engine (not run by run-all.js).
// Run: node tests/live/magi-thread.live.js   Screenshots: %TEMP%/magi-live-shots
//
// MAGI Track F, phase F2: Deliberation follow-ups in the console. REAL runs on
// ONE cheap unit (UNIT=gemini by default), three questions, ~2-3 min:
//   1. turn 1 by Convene: the composer clears, the button becomes Add to run,
//      the composer docks under the thread
//   2. turn 2 by Follow up, and a real mid-run note ("also name the play")
//      sent through the same box -- applied to the verdict; turn 2 answers
//      about turn 1's moon
//   3. History: ONE entry, "2 turns"; New deliberation undocks; reopening
//      it brings both turns back with an EMPTY composer labelled Follow up
//   4. a pre-Track-F History entry opens as a one-turn session ready to follow
//      up; a turn whose body is gone shows "no longer stored"; a turn read
//      from the CLOUD (fake Firestore behind the real loader) opens too
//   5. a real follow-up sent from the REOPENED session references its turns
//   6. 390px: docked bar on screen, no horizontal scroll
// Its own runs are deleted from the engine at the end.
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');

const URL = require('./cdp.js').PAGES_URL;
const UNIT = process.env.UNIT || 'gemini';
const STUB = `(()=>{if(window.top!==window)return;const real=window.fetch;window.fetch=(u,o)=>{const s=String(u&&u.url?u.url:u);
 if(s.indexOf('/auth/journal/status')>=0)return Promise.resolve(new Response(JSON.stringify({ok:true,hasLock:false}),{status:200,headers:{'Content-Type':'application/json'}}));
 if(s.indexOf('firebase')>=0||s.indexOf('googleapis')>=0||s.indexOf('gstatic')>=0)return Promise.reject(new TypeError('x'));
 return real(u,o);};})();`;

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '  [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  [' + d + ']' : '')); }
};
const shot = async (c, name) => {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64'));
};
const waitFor = async (c, expr, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalJs(c, expr)) return true; } catch {}
    await sleep(250);
  }
  return false;
};
const size = (c, w, h, phone) => c.send('Emulation.setDeviceMetricsOverride',
  { width: w, height: h, deviceScaleFactor: phone ? 2 : 1, mobile: phone });
const type = (c, text) => evalJs(c, `setQuestion(${JSON.stringify(text)}); return 1;`);
const label = (c) => evalJs(c, '$("btnSend").textContent');
const docked = (c) => evalJs(c, '$("qbar").classList.contains("docked")');

(async () => {
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await size(c, 1440, 900, false);
  await c.send('Page.navigate', { url: URL });
  ok('engine online', await waitFor(c, 'online() && S.providers.length > 0', 30000));
  ok('the engine advertises followup + steer', await waitFor(c, 'engineHas("followup") && engineHas("steer")', 10000));
  const picks = await evalJs(c, 'JSON.stringify([...S.selected])');
  await evalJs(c, `setMode("deliberation"); newRun(); S.selected = new Set([${JSON.stringify(UNIT)}]); updateEnabled(); return 1;`);
  ok('an empty session: Convene, composer on top', (await label(c)) === 'Convene' && !(await docked(c)));
  const made = [];

  try {
    // -- 1. turn 1 -------------------------------------------------------------
    await type(c, 'Name one moon of Uranus that is named after a Shakespeare character. Just the name, one word.');
    await evalJs(c, 'start(); return 1;');
    ok('turn 1 starts', await waitFor(c, 'S.running && !!S.live && !!S.live.runId', 15000));
    ok('the composer is cleared on send', (await evalJs(c, '$("composer").value')) === '');
    ok('the button says Add to run', (await label(c)) === 'Add to run');
    ok('the composer docks under the run', await docked(c));
    ok('the thread shows the running question', await evalJs(c, '!!document.querySelector("#thread .turn-now .turn-q")'));
    ok('turn 1 lands', await waitFor(c, '!S.running', 4 * 60000));
    const t1 = await evalJs(c, 'JSON.stringify({id: S.session.id, n: S.session.turns.length, run: S.runId, v: turnAnswer(S.session.turns[0])})');
    const T1 = JSON.parse(t1);
    made.push(T1.run);
    console.log('  turn 1: ' + T1.v.replace(/\s+/g, ' ').slice(0, 120));
    ok('one finished turn; the session id is the first run id', T1.n === 1 && T1.id === T1.run);
    ok('then the button says Follow up', (await label(c)) === 'Follow up');
    await shot(c, 'thread-turn1');

    // -- 2. turn 2 + a real mid-run note -----------------------------------------
    await type(c, 'Who is it named after?');
    await evalJs(c, 'start(); return 1;');
    ok('turn 2 starts as a follow-up', await waitFor(c, 'S.running && !!S.live.runId && S.live.turn === 2', 15000));
    ok('turn 1 is now a compact card above', await evalJs(c, 'document.querySelectorAll("#thread .turn:not(.turn-now)").length === 1'));
    await type(c, 'Also name the play that character is from.');
    await evalJs(c, 'start(); return 1;');
    ok('the note lands in a bucket', await waitFor(c, 'S.live.notes.length === 1 && S.live.notes[0].applied !== "sending"', 15000),
       await evalJs(c, 'S.live && S.live.notes[0] && S.live.notes[0].applied'));
    const bucket = await evalJs(c, 'S.live.notes[0].applied');
    ok('it went to the verdict (sent before the chairman started)', bucket === 'verdict', bucket);
    ok('the note shows as a bubble', await evalJs(c, '!!document.querySelector("#thread .turn-now .turn-note")'));
    await shot(c, 'thread-note');
    ok('turn 2 lands', await waitFor(c, '!S.running', 4 * 60000));
    const T2 = JSON.parse(await evalJs(c, 'JSON.stringify({n: S.session.turns.length, run: S.runId, v: turnAnswer(S.session.turns[1]), notes: S.session.turns[1].notes})'));
    made.push(T2.run);
    console.log('  turn 2: ' + T2.v.replace(/\s+/g, ' ').slice(0, 200));
    ok('two turns in the session', T2.n === 2);
    ok('turn 2 answers about turn 1 (memory)', /miranda|ariel|umbriel|oberon|titania|puck|prospero|shakespeare|cordelia|ophelia|juliet|desdemona/i.test(T2.v), T2.v.slice(0, 80));
    ok('the note was applied: the play is named', /tempest|dream|lear|hamlet|othello|romeo|merchant|shrew/i.test(T2.v));
    ok('the note is stored on the turn', (T2.notes || []).some((n) => n.applied === 'verdict'));
    // Only a follow-up with notes held AFTER the chairman started would send
    // itself; ours went to the verdict, so nothing was carried.
    ok('no follow-up fired by itself', await evalJs(c, '!S.running'));

    // -- 3. History ------------------------------------------------------------
    await evalJs(c, 'loadHistory(); return 1;');
    ok('History has ONE entry for the session, 2 turns',
       await waitFor(c, `(S.historyMerged||[]).some(g => g.id === ${JSON.stringify(T1.id)} && g.n === 2)`, 15000));
    ok('its title is the first question', await evalJs(c,
      `/moon of Uranus/.test(S.historyMerged.find(g => g.id === ${JSON.stringify(T1.id)}).question)`));
    await evalJs(c, 'setView("history"); return 1;');
    ok('the row says 2 turns', await evalJs(c, '[...document.querySelectorAll("#historyRows .row .meta")].some(m => /^2 turns/.test(m.textContent))'));
    await shot(c, 'thread-history');
    await evalJs(c, 'navNewDeliberation(); return 1;');
    ok('New deliberation: empty, Convene, undocked',
       (await label(c)) === 'Convene' && !(await docked(c)) && (await evalJs(c, 'S.session.turns.length')) === 0);
    await evalJs(c, `openSession(S.historyMerged.find(g => g.id === ${JSON.stringify(T1.id)})); return 1;`);
    ok('reopened: both turns', await waitFor(c, 'S.session.turns.length === 2 && S.fromHistory', 15000));
    ok('...composer EMPTY, labelled Follow up, docked',
       (await evalJs(c, '$("composer").value')) === '' && (await label(c)) === 'Follow up' && (await docked(c)));
    ok('...turn 2 on the grid, turn 1 in the thread',
       await evalJs(c, `S.runId === ${JSON.stringify(T2.run)} && document.querySelectorAll("#thread .turn:not(.turn-now)").length === 1`));
    ok('...its note is shown on the current turn', await evalJs(c, '!!document.querySelector("#thread .turn-now .turn-note")'));
    await evalJs(c, 'document.querySelector("#thread .turn-units").open = true; return 1;');
    ok('the Units expander lists the earlier turn\'s answers', await waitFor(c, '!!document.querySelector("#thread .turn-unit .md")', 3000));
    await shot(c, 'thread-reopened');

    // -- 4. other kinds of History entry ---------------------------------------
    const oldId = await evalJs(c, `return (() => { const g = (S.historyMerged||[]).find(g => g.n === 1 && !g.cloudOnly && g.turns[0].id === g.id && !g.turns[0].session_id); return g ? g.id : ""; })();`)
      || await evalJs(c, `return (() => { const g = (S.historyMerged||[]).find(g => g.n === 1 && !g.cloudOnly && g.id !== ${JSON.stringify(T1.id)}); return g ? g.id : ""; })();`);
    if (oldId) {
      await evalJs(c, `openRun(${JSON.stringify(oldId)}); return 1;`);
      ok('a pre-Track-F entry opens as a one-turn session', await waitFor(c, `S.session.id === ${JSON.stringify(oldId)} && S.session.turns.length === 1`, 15000));
      ok('...ready to follow up with an empty composer',
         (await evalJs(c, '$("composer").value')) === '' && (await label(c)) === 'Follow up');
      ok('...its turn would travel as context', await evalJs(c, 'JSON.parse(sessionContext(S.session.turns)).length === 1'));
    } else ok('a pre-Track-F entry to open', false, 'none in History');

    await evalJs(c, `openSession({ id: "gonetest01", session_id: "gonetest01", n: 1, turns: [{ id: "gonetest01", question: "A question whose answer was deleted elsewhere", cloudOnly: true }] }); return 1;`);
    ok('a turn with no body left opens', await waitFor(c, 'S.session.id === "gonetest01"', 10000));
    ok('...and says the answer is no longer stored', await evalJs(c, '/no longer stored/.test($("thread").textContent)'));
    ok('...and can still be followed up', (await label(c)) === 'Follow up'
       && await evalJs(c, 'JSON.parse(sessionContext(S.session.turns))[0].q.startsWith("A question whose")'));

    // A turn read from the cloud: the REAL loader behind a fake Firestore that
    // serves turn 1's body (as the other device's push would have left it).
    await evalJs(c, `(async () => {
      const body = await (await fetch(link.api + "/api/runs/${T1.run}", authed())).json();
      window.__realCloudInit = cloudInit;
      cloudInit = async () => true;
      window.__realFs = CLOUD.fs;
      CLOUD.fs = { doc: (...a) => a.join("/"), getDoc: async () => ({ exists: () => true, data: () => body }) };
      openSession({ id: "cloudtest01", session_id: "cloudtest01", n: 1, turns: [{ id: "cloudtest01", question: "x", cloudOnly: true }] });
    })(); return 1;`);
    ok('a cloud-only entry opens from its body', await waitFor(c, 'S.session.id === "cloudtest01" && S.session.turns.length === 1 && !S.session.turns[0].gone', 10000));
    ok('...not local (Studio will not ask this engine)', await evalJs(c, 'S.runLocal === false'));
    ok('...ready to follow up', (await label(c)) === 'Follow up' && (await evalJs(c, '$("composer").value')) === '');
    await evalJs(c, 'cloudInit = window.__realCloudInit; CLOUD.fs = window.__realFs; return 1;');

    // -- 5. a real follow-up from the reopened session --------------------------
    await evalJs(c, `openSession(S.historyMerged.find(g => g.id === ${JSON.stringify(T1.id)})); return 1;`);
    ok('reopened again', await waitFor(c, 'S.session.turns.length === 2 && !S.running', 15000));
    await type(c, 'In which year was that play probably first performed? Just the year.');
    await evalJs(c, 'start(); return 1;');
    ok('turn 3 starts from History', await waitFor(c, 'S.running && S.live.turn === 3', 15000));
    ok('turn 3 lands', await waitFor(c, '!S.running', 4 * 60000));
    const T3 = JSON.parse(await evalJs(c, 'JSON.stringify({n: S.session.turns.length, run: S.runId, v: turnAnswer(S.session.turns[2])})'));
    made.push(T3.run);
    console.log('  turn 3: ' + T3.v.replace(/\s+/g, ' ').slice(0, 120));
    ok('three turns', T3.n === 3);
    ok('turn 3 used the reopened memory (a year)', /1[56]\d\d/.test(T3.v), T3.v.slice(0, 60));

    // -- 6. phone ----------------------------------------------------------------
    await size(c, 390, 844, true);
    await sleep(500);
    await evalJs(c, '$("page").scrollTop = 0; return 1;');
    await sleep(200);
    ok('at 390px the docked bar is on screen while scrolled to the top',
       await evalJs(c, 'return (() => { const r = $("qbar").getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top >= 0 && r.top < innerHeight; })();'));
    ok('no horizontal page scroll at 390px', await evalJs(c, 'document.documentElement.scrollWidth <= innerWidth + 1 && $("page").scrollWidth <= $("page").clientWidth + 1'));
    await shot(c, 'thread-phone-top');
    await evalJs(c, '$("page").scrollTop = $("page").scrollHeight; return 1;');
    await sleep(200);
    await shot(c, 'thread-phone-bottom');
    await size(c, 1440, 900, false);
    await sleep(300);
    await evalJs(c, '$("page").scrollTop = 0; return 1;');
    await shot(c, 'thread-desktop');
  } finally {
    for (const id of made.filter(Boolean)) {
      await evalJs(c, `fetch(link.api + "/api/runs/${id}", authed({ method: "DELETE" })).then(() => 1)`).catch(() => {});
    }
    await evalJs(c, `S.selected = new Set(${picks}); newRun(); return 1;`).catch(() => {});
    console.log(`  deleted ${made.filter(Boolean).length} test runs`);
  }

  ok('no uncaught exceptions', !errs.length, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
