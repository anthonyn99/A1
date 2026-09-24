// LIVE test -- drives the real engine on this PC (not run by run-all.js).
// Run: node tests/live/magi-sync.live.js     Screenshots: %TEMP%/magi-live-shots
//
// Phase 13 end to end: the real page, the real engine, and an in-page fake
// Firestore behind the REAL listener (cloudWatch attaches to it exactly as
// it does to Firebase; every write goes through cloudCountWrites), so each
// write is counted rather than assumed. Real Firestore is never touched.
//   1. seed: an empty cloud gets the engine's projects in ONE write, with
//      no path, token or login in it.
//   2. pref: one switch on the Auto commit sheet -> exactly one write.
//   3. burst: ten rapid chain toggles -> one write.
//   4. phone: another device's rename arrives through the listener, the
//      engine takes it (PUT /sync), and the page writes nothing back.
//   5. a1: a synced copy saying "auto commit A1" leaves A1 off.
//   6. local: a change made on 127.0.0.1 (no sync there) reaches the cloud
//      on the next connect, in one write.
//   7. task: while a task runs, zero writes; at its end one index write and
//      one body doc; Recent lists it; opening it reads the body.
//   8. listener: still exactly one, after everything above.
//   9. narrow: Recent at 390px, no horizontal scroll.
// LIVE_ONLY=seed,pref,burst,phone,a1,local,task,narrow picks sections
// (every section after seed needs seed).
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// The Pages console, served from this working copy (cdp.js): since Phase 14 a
// file:// page (Origin "null") is refused by the engine.
const URL = require('./cdp.js').PAGES_URL;
const API = 'http://127.0.0.1:8000/api/code';
const STUB = `(()=>{const real=window.fetch;window.fetch=(u,o)=>{const s=String(u&&u.url?u.url:u);
 if(s.indexOf('/auth/journal/status')>=0)return Promise.resolve(new Response(JSON.stringify({ok:true,hasLock:false}),{status:200,headers:{'Content-Type':'application/json'}}));
 if(s.indexOf('firebase')>=0||s.indexOf('googleapis')>=0||s.indexOf('gstatic')>=0)return Promise.reject(new TypeError('x'));
 return real(u,o);};})();`;

// The fake Firestore: one map of docs, listeners fired after each write the
// way the real SDK echoes a local write.
const FAKE = `
window.__FS = { docs: {}, listeners: [] };
(() => {
  const clone = (o) => JSON.parse(JSON.stringify(o === undefined ? null : o));
  const snap = (p) => ({ exists: () => !!__FS.docs[p], data: () => clone(__FS.docs[p]) });
  window.__FS.fire = (p) => setTimeout(() => {
    for (const l of __FS.listeners) if (l.path === p) l.cb(snap(p));
  }, 30);
  const FAKE = {
    doc: (db, ...p) => ({ path: p.join('/') }),
    getDoc: async (r) => snap(r.path),
    setDoc: async (r, d, o) => {
      const cur = __FS.docs[r.path] || {};
      __FS.docs[r.path] = o && (o.merge || o.mergeFields) ? { ...cur, ...clone(d) } : clone(d);
      __FS.fire(r.path);
    },
    updateDoc: async (r, d) => { __FS.docs[r.path] = { ...(__FS.docs[r.path] || {}), ...clone(d) }; __FS.fire(r.path); },
    deleteDoc: async (r) => { delete __FS.docs[r.path]; },
    onSnapshot: (r, cb) => { __FS.listeners.push({ path: r.path, cb }); setTimeout(() => cb(snap(r.path)), 10); return () => {}; },
    serverTimestamp: () => 'TS',
  };
  CLOUD.enabled = true; CLOUD.ready = Promise.resolve(true); CLOUD.db = {};
  CLOUD.fs = cloudCountWrites(FAKE); CLOUD.unsub = null; CLOUD.writeLog.length = 0;
})();
return 1;`;

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '  [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  [' + d + ']' : '')); }
};
const shot = async (c, name) => {
  const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64'));
};
const waitFor = async (c, expr, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalJs(c, expr)) return true; } catch {}
    await sleep(300);
  }
  return false;
};
const api = async (p, body, method) => {
  const r = await fetch(API + p, body || method ? {
    method: method || 'POST', headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined } : undefined);
  return r.json();
};
const want = (k) => !process.env.LIVE_ONLY || process.env.LIVE_ONLY.split(',').includes(k);
// Writes this page made to the `code` field, and to task bodies.
const codeWrites = (c) => evalJs(c, 'CLOUD.writeLog.filter(w => w.fields.includes("code")).length');
const bodyWrites = (c) => evalJs(c, 'CLOUD.writeLog.filter(w => /\\/code\\//.test(w.path)).length');
const cloudCode = async (c) => JSON.parse(await evalJs(c, 'JSON.stringify((__FS.docs["dashboards/magi"]||{}).code||null)'));
const quiet = () => sleep(2500);      // past the 900 ms debounce, with room

const BASE = path.join(os.tmpdir(), 'magi-sync-live');
function makeRepo() {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(BASE, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', BASE]);
  fs.writeFileSync(path.join(BASE, 'README.md'), '# sync scratch\n');
  execFileSync('git', ['-C', BASE, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
  execFileSync('git', ['-C', BASE, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
}

(async () => {
  makeRepo();
  const made = await api('/projects', { name: 'magi-sync-live', root: BASE });
  if (!made.ok) { console.error('could not register the scratch repo', made); process.exit(2); }
  const PID = made.project.id;
  const A1 = (await api('/sync')).projects;
  const A1_ID = Object.keys(A1).find((k) => A1[k].name === 'A1');
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: URL }); await sleep(3000);
  await evalJs(c, `localStorage.clear(); sessionStorage.clear(); localStorage.setItem(lsKey("mode"), "code"); localStorage.setItem(lsKey("code.project"), JSON.stringify(${JSON.stringify(PID)})); return 1;`);
  await c.send('Page.navigate', { url: URL });
  ok('engine online', await waitFor(c, 'online()', 25000));
  ok('state + agents loaded', await waitFor(c, '!!(CODE.state && CODE.agents)'));

  try {
    // ── 1. seed ───────────────────────────────────────────────────────────
    console.log('\nSeed');
    await evalJs(c, FAKE);
    await evalJs(c, 'cloudWatch(); return 1;');
    ok('one listener attached', await waitFor(c, '__FS.listeners.length === 1', 5000));
    ok('the empty cloud is seeded', await waitFor(c, '!!((__FS.docs["dashboards/magi"]||{}).code)', 10000));
    await quiet();
    ok('in exactly one write', (await codeWrites(c)) === 1, await codeWrites(c));
    let cc = await cloudCode(c);
    const blob = JSON.stringify(cc);
    ok('it holds the scratch project and A1', !!(cc.projects[PID] && cc.projects[A1_ID]));
    ok('no path, token or login in it', !/"root"|Desktop|AppData|Users|token|password/i.test(blob),
       blob.slice(0, 200));
    ok('A1 is held by this PC (presence only)', !!Object.values(cc.projects[A1_ID].bindings)[0]
       && JSON.stringify(cc.projects[A1_ID].bindings).indexOf('Desktop') < 0);

    // ── 2. one preference ─────────────────────────────────────────────────
    if (want('pref')) {
      console.log('\nOne preference');
      const before = await codeWrites(c);
      await evalJs(c, '[...document.querySelectorAll("#codeStrip .code-pill")].find(p=>p.textContent.startsWith("Auto commit")).click(); return 1;');
      ok('the sheet opens', await waitFor(c, '!!document.querySelector(".ac-sheet")', 4000));
      await evalJs(c, 'document.querySelector(\'.ac-row[data-auto="commit"]\').click(); return 1;');
      ok('Auto commit switches on', await waitFor(c, 'document.querySelector(\'.ac-row[data-auto="commit"]\').getAttribute("aria-checked")==="true"', 8000));
      await quiet();
      ok('exactly one write', (await codeWrites(c)) - before === 1, (await codeWrites(c)) - before);
      cc = await cloudCode(c);
      ok('the cloud copy has it on', cc.projects[PID].prefs.autoCommit === true);
      await evalJs(c, 'document.querySelector(\'.ac-row[data-auto="commit"]\').click(); return 1;');
      await waitFor(c, 'document.querySelector(\'.ac-row[data-auto="commit"]\').getAttribute("aria-checked")==="false"', 8000);
      await quiet();
      ok('and off again: one more', (await codeWrites(c)) - before === 2, (await codeWrites(c)) - before);
      await evalJs(c, '(document.querySelector(".ac-sheet")||{closest(){return null}}).closest(".sheet")?.remove(); return 1;');
    }

    // ── 3. a burst ────────────────────────────────────────────────────────
    if (want('burst')) {
      console.log('\nTen rapid toggles');
      const before = await codeWrites(c);
      const id = await evalJs(c, 'codeMembers()[0].id');
      for (let i = 0; i < 10; i++) await evalJs(c, `codeToggle(${JSON.stringify(id)}); return 1;`);
      await quiet();
      ok('ten chain toggles -> one write', (await codeWrites(c)) - before === 1, (await codeWrites(c)) - before);
      cc = await cloudCode(c);
      ok('the chain travelled', !!(cc.chain && cc.chain.updatedAt && cc.chain.picks));
    }

    // ── 4. another device ─────────────────────────────────────────────────
    if (want('phone')) {
      console.log('\nA rename from another device');
      const before = await codeWrites(c);
      const at = new Date(Date.now() + 1000).toISOString();
      await evalJs(c, `const d = __FS.docs["dashboards/magi"]; d.code = JSON.parse(JSON.stringify(d.code));
        d.code.projects[${JSON.stringify(PID)}].name = "renamed-on-phone";
        d.code.projects[${JSON.stringify(PID)}].updatedAt = ${JSON.stringify(at)};
        d.code.rev++; __FS.fire("dashboards/magi"); return 1;`);
      ok('the page shows it', await waitFor(c, `(CODE.state.projects.find(p=>p.id===${JSON.stringify(PID)})||{}).name === "renamed-on-phone"`, 10000));
      const eng = await api('/sync');
      ok('the engine took it, with the phone\'s time', eng.projects[PID].name === 'renamed-on-phone'
         && Date.parse(eng.projects[PID].updatedAt) === Date.parse(at));
      await quiet();
      ok('and nothing was written back', (await codeWrites(c)) === before, (await codeWrites(c)) - before);
      await shot(c, 'sync-renamed');
    }

    // ── 5. A1 stays off ───────────────────────────────────────────────────
    if (want('a1') && A1_ID) {
      console.log('\nA1 against a synced "on"');
      const at = new Date(Date.now() + 2000).toISOString();
      await evalJs(c, `const d = __FS.docs["dashboards/magi"]; d.code = JSON.parse(JSON.stringify(d.code));
        const p = d.code.projects[${JSON.stringify(A1_ID)}];
        p.prefs = { ...p.prefs, autoCommit: true, autoPush: true }; p.updatedAt = ${JSON.stringify(at)};
        d.code.rev++; __FS.fire("dashboards/magi"); return 1;`);
      await quiet();
      const eng = await api('/sync');
      ok('the engine took the copy (same time)…', Date.parse(eng.projects[A1_ID].updatedAt) === Date.parse(at));
      ok('…and A1 is still off', eng.projects[A1_ID].prefs.autoCommit === false && eng.projects[A1_ID].prefs.autoPush === false,
         JSON.stringify(eng.projects[A1_ID].prefs));
      const pills = await evalJs(c, `CODE.state.projects.find(p=>p.id===${JSON.stringify(A1_ID)}).prefs.autoCommit`);
      ok('the page reads off too', pills === false);
    }

    // ── 6. a change on 127.0.0.1 ──────────────────────────────────────────
    if (want('local')) {
      console.log('\nA change made where there is no sync');
      await api(`/projects/${PID}/prefs`, { name: 'set-on-localhost' });
      const before = await codeWrites(c);
      await evalJs(c, 'codeLoad(true); return 1;');
      ok('the next connect carries it to the cloud', await waitFor(c,
        `((__FS.docs["dashboards/magi"].code.projects[${JSON.stringify(PID)}])||{}).name === "set-on-localhost"`, 10000));
      await quiet();
      ok('in one write', (await codeWrites(c)) - before === 1, (await codeWrites(c)) - before);
    }

    // ── 7. a task ─────────────────────────────────────────────────────────
    if (want('task')) {
      console.log('\nA task in flight');
      const before = await codeWrites(c);
      // A running task, as the SSE handler holds it. 400 events arrive and
      // everything that could write is pressed meanwhile.
      await evalJs(c, `CODE.task = { id: "live-sync-task", prompt: "What does README.md say?", events: [], done: false,
                                     result: null, es: null, projectId: ${JSON.stringify(PID)} };
        for (let i = 0; i < 400; i++) CODE.task.events.push({ k: i % 4 ? "tool" : "text", tool: "Read", text: "line " + i });
        renderCodeView(); return 1;`);
      await api(`/projects/${PID}/prefs`, { name: 'changed-mid-task' });
      await evalJs(c, `codeToggle(codeMembers()[0].id); codeLoad(true); return 1;`);
      await sleep(4000);
      ok('zero writes while it runs', (await codeWrites(c)) === before && (await bodyWrites(c)) === 0,
         `${(await codeWrites(c)) - before} code, ${await bodyWrites(c)} body`);
      await evalJs(c, `const t = CODE.task; t.done = true; t.result = { outcome: "ok", by_label: "Claude", write: false };
        codeSyncTaskEnd(t); renderCodeView(); return 1;`);
      await quiet();
      ok('its end: one index write', (await codeWrites(c)) - before === 1, (await codeWrites(c)) - before);
      ok('and one body doc', (await bodyWrites(c)) === 1);
      cc = await cloudCode(c);
      ok('the index row is there, and what was held went with it',
         cc.tasks[0].id === 'live-sync-task' && cc.projects[PID].name === 'changed-mid-task');
      await evalJs(c, 'codeClearTask(); return 1;');
      ok('Recent lists it', await waitFor(c, '[...document.querySelectorAll(".code-recent-q")].some(n => /README/.test(n.textContent))', 5000));
      await shot(c, 'sync-recent');
      await evalJs(c, 'document.querySelector(".code-recent-row").click(); return 1;');
      ok('opening it reads the saved transcript', await waitFor(c, 'CODE.task && CODE.task.archived && CODE.task.events.length === 400', 5000));
      ok('marked as a saved copy', await waitFor(c, '/a saved copy/.test(document.querySelector(".code-task-hd").textContent)', 3000));
      await shot(c, 'sync-opened');
      await evalJs(c, 'codeClearTask(); return 1;');
    }

    // ── 8. one listener ───────────────────────────────────────────────────
    console.log('\nThe listener');
    await evalJs(c, 'cloudWatch(); codeLoad(true); return 1;');
    await sleep(1500);
    ok('still exactly one listener', (await evalJs(c, '__FS.listeners.length')) === 1, await evalJs(c, '__FS.listeners.length'));
    ok('every write went to this profile\'s doc', await evalJs(c,
      'CLOUD.writeLog.every(w => w.path === "dashboards/magi" || w.path.startsWith("dashboards/magi/"))'));

    // ── 9. narrow ─────────────────────────────────────────────────────────
    if (want('narrow') && want('task')) {
      console.log('\nPhone width');
      await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await sleep(800);
      await evalJs(c, 'renderCodeView(); return 1;');
      ok('Recent shows at 390px', await waitFor(c, '!!document.querySelector(".code-recent-row")', 3000));
      ok('no horizontal scroll', await evalJs(c, 'document.documentElement.scrollWidth <= window.innerWidth + 1'),
         await evalJs(c, 'document.documentElement.scrollWidth'));
      ok('a row fits the screen', await evalJs(c, 'document.querySelector(".code-recent-row").getBoundingClientRect().right <= window.innerWidth'));
      await shot(c, 'sync-phone');
    }

    ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    await api(`/projects/${PID}`, undefined, 'DELETE');
    fs.rmSync(BASE, { recursive: true, force: true });
    c.close && c.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
