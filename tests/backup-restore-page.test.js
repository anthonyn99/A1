#!/usr/bin/env node
/**
 * backup-restore.html, end to end in headless Edge.
 *
 * The backups are real ciphertext made by the shipped backup.js, served the way
 * the index-backups worker serves them (/index with stamps, /s/<device>?at=,
 * /o/<hash>). A second device is encrypted under the OTHER person's passphrase
 * and must be skipped. Firebase is replaced by stubs (served through CDP
 * Fetch), so nothing here can reach real Firestore; the stub keeps every
 * dashboards/* document in window.__fs and records each write.
 *
 * Covers: passphrase gate, both people's tabs, the suggested backup after a
 * reset, restore (prerestore + restored records), undo that keeps edits made
 * after the restore, redo, the "changed while open" re-plan, and the repo
 * fallback when the worker is down.
 *
 * Run: node tests/backup-restore-page.test.js   (SHOT=dir also saves screenshots)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PASS = 'veda test passphrase';
const OTHER = 'tony test passphrase';
const WORKER = 'https://index-backups.av1-2.workers.dev';
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FAIL  ') + m); if (!c) fails++; };

// ── Fixture: encrypt with the shipped backup.js ──────────────────────────────
async function crypter(pass) {
  const store = {};
  const sandbox = {
    window: {}, console, localStorage: {
      getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    Blob, Response, CompressionStream, DecompressionStream, TextEncoder, TextDecoder,
    crypto, btoa, atob, setTimeout, clearTimeout,
    Date, Math, JSON, Object, Error, RegExp, Promise, Array, Uint8Array, String, Number
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'backup.js'), 'utf8'), sandbox);
  const A1 = sandbox.window.A1Backup;
  await A1.unlock(pass, { allowNewPassphrase: true });
  return async (obj) => JSON.stringify(await A1._internals.encryptStr(JSON.stringify(obj)));
}

const day = (n) => '2026-10-' + String(n).padStart(2, '0');
const T0 = Date.UTC(2026, 9, 18, 14);
const reset = {   // what live was reset to (an older state)
  main: { savedAt: T0, goals: [{ id: 'g1', title: 'Tony goal', done: false }], data: { [day(17)]: [{ id: 't1', title: 'Old task' }] } },
  vedasdash: { savedAt: T0, goals: [], data: { [day(17)]: [{ id: 'c', title: 'Cook dinner', done: false }] } }
};
const good = {    // just before the reset: yesterday's added task and goal
  main: { savedAt: T0 + 3600e3, goals: [{ id: 'g1', title: 'Tony goal', done: true }, { id: 'g2', title: 'New Tony goal' }],
          data: { [day(17)]: [{ id: 't1', title: 'Old task' }], [day(18)]: [{ id: 't2', title: 'Added yesterday' }] } },
  vedasdash: { savedAt: T0 + 3600e3, goals: [], data: { [day(17)]: [{ id: 'c', title: 'Cook dinner', done: true }] } }
};

async function makeFixture() {
  const enc = await crypter(PASS), encOther = await crypter(OTHER);
  const worker = {}, repo = {}, stamps = { 'dev-v': [], 'dev-t': [] };
  async function snap(device, e, at, docs) {
    const man = { at, docs: {} };
    for (const [name, d] of Object.entries(docs)) {
      const h = (device + name + d.savedAt).replace(/[^a-z0-9]/gi, '');
      man.docs['dashboards/' + name] = h;
      worker['/o/' + h] = await e(d);
      repo[device + '/objects/' + h + '.enc.json'] = worker['/o/' + h];
    }
    worker['/s/' + device + '?at=' + at] = await e(man);
    repo[device + '/snapshots/' + new Date(at).toISOString().slice(0, 10) + '.enc.json'] = worker['/s/' + device + '?at=' + at];
    stamps[device].push(at);
  }
  await snap('dev-v', enc, T0 - 86400e3, reset);          // the state it was reset to
  await snap('dev-v', enc, T0 + 3600e3 + 60e3, good);     // the good one
  await snap('dev-v', enc, T0 + 7200e3, reset);           // captured after the reset
  await snap('dev-t', encOther, T0 + 7200e3, good);       // the other person's device
  const idx = { devices: {} };
  for (const [d, s] of Object.entries(stamps)) idx.devices[d] = { at: Math.max(...s), count: s.length, stamps: s };
  worker['/index'] = JSON.stringify(idx);
  repo['index.json'] = JSON.stringify({ devices: [{ device: 'dev-v', at: T0 + 3600e3 + 60e3, iso: new Date(T0 + 3600e3 + 60e3).toISOString() }] });
  return { worker, repo };
}

// ── Firebase stubs (the page imports these four modules) ─────────────────────
const STUBS = {
  'firebase-app.js': 'export const initializeApp = () => ({});',
  'firebase-app-check.js': 'export const initializeAppCheck = () => ({}); export class ReCaptchaV3Provider {} export const getToken = async () => ({ token: "tok" });',
  'firebase-auth.js': 'export const getAuth = () => ({}); export const signInAnonymously = async () => ({});',
  'firebase-firestore.js': `
    export const getFirestore = () => ({});
    export const doc = (db, p) => p;
    export const getDocFromServer = async (p) => { const v = window.__fs[p.split('/')[1]]; return { data: () => v === undefined ? undefined : JSON.parse(JSON.stringify(v)) }; };
    export const setDoc = async (p, v) => { (window.__writes = window.__writes || []).push(p); window.__fs[p.split('/')[1]] = JSON.parse(JSON.stringify(v)); };`
};

function findEdge() {
  return ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const edge = findEdge();
  if (!edge) { console.log('  skip  Edge not found'); return; }
  const { worker, repo } = await makeFixture();
  let workerDown = false;
  const port = 9300 + Math.floor(Math.random() * 400);
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-restore-test-'));
  const proc = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port,
                            '--user-data-dir=' + udd, 'about:blank'], { stdio: 'ignore' });
  try {
    let list;
    for (let i = 0; i < 50 && !list; i++) { try { list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); } catch (e) { await sleep(200); } }
    const ws = new WebSocket(list.find((x) => x.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0; const pend = new Map();
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.result.value;
    const until = async (e, n = 80) => { for (let i = 0; i < n; i++) { if (await evalJs(e)) return true; await sleep(150); } return false; };

    ws.onmessage = async (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
      if (d.method !== 'Fetch.requestPaused') return;
      const url = d.params.request.url, rid = d.params.requestId, method = d.params.request.method;
      const cors = [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: 'Content-Type, X-Firebase-AppCheck' }];
      let body = null, type = 'text/html', status = 200;
      const stub = Object.keys(STUBS).find((k) => url.includes('gstatic.com') && url.endsWith('/' + k));
      if (stub) { body = STUBS[stub]; type = 'text/javascript'; }
      else if (url.startsWith(WORKER)) {
        if (method === 'OPTIONS') return send('Fetch.fulfillRequest', { requestId: rid, responseCode: 204, responseHeaders: cors, body: '' });
        const u = new URL(url), key = u.pathname + u.search;
        if (workerDown) { status = 503; body = '{}'; }
        else if (d.params.request.headers['X-Firebase-AppCheck'] !== 'tok') { status = 401; body = '{}'; }
        else body = worker[key];
        type = 'application/json';
      } else if (url.startsWith('https://a1.test/')) {
        const p = decodeURIComponent(new URL(url).pathname.slice(1));
        if (p.startsWith('Index Backups/')) body = repo[p.slice('Index Backups/'.length)];
        else if (fs.existsSync(path.join(ROOT, p))) body = fs.readFileSync(path.join(ROOT, p), 'utf8');
        type = p.endsWith('.js') ? 'text/javascript' : p.endsWith('.json') ? 'application/json' : 'text/html';
      }
      if (body == null) return send('Fetch.fulfillRequest', { requestId: rid, responseCode: 404, responseHeaders: cors, body: '' });
      send('Fetch.fulfillRequest', { requestId: rid, responseCode: status,
        responseHeaders: [{ name: 'Content-Type', value: type }].concat(cors),
        body: Buffer.from(body).toString('base64') });
    };
    await send('Fetch.enable', { patterns: [{ urlPattern: 'https://a1.test/*' }, { urlPattern: '*gstatic.com*' }, { urlPattern: WORKER + '/*' }] });
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__fs = ' + JSON.stringify({ main: reset.main, vedasdash: reset.vedasdash }) + ';' });
    const shot = async (name, w, h) => {
      if (!process.env.SHOT) return;
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
      await sleep(400);
      fs.mkdirSync(process.env.SHOT, { recursive: true });
      fs.writeFileSync(path.join(process.env.SHOT, name + '.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result.data, 'base64'));
      await send('Emulation.clearDeviceMetricsOverride');
    };
    const txt = (sel) => evalJs(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||''`);
    const writes = () => evalJs('window.__writes || []');
    const live = (n) => evalJs('window.__fs[' + JSON.stringify(n) + ']');
    const submit = (p) => evalJs(`(() => { document.getElementById('pw').value = ${JSON.stringify(p)};
      document.getElementById('pf').requestSubmit(); return true; })()`);
    const pressGo = async () => {
      await evalJs('document.getElementById("go").click()');
      ok(await until('!document.getElementById("dlg").hidden', 20), 'a confirm dialog asks first');
      await evalJs('document.getElementById("dlgyes").click()');
    };

    await send('Page.navigate', { url: 'https://a1.test/backup-restore.html?profile=tony' });
    ok(await until('!document.getElementById("passcard").hidden'), 'no saved passphrase → the passphrase box is shown');

    await submit('wrong passphrase');
    ok(await until('/did not open/.test(document.getElementById("st").textContent)'), 'a wrong passphrase is refused');
    ok(!(await writes()).length, 'nothing written after a wrong passphrase');

    await submit(PASS);
    ok(await until('document.querySelectorAll("#tl .row").length >= 2 && !/Reading/.test(document.getElementById("tlaside").textContent)'),
       'the right passphrase lists Tony\u2019s backups from the worker');
    ok(/Tony/.test(await txt('#tabs [aria-pressed=true]')), '?profile=tony opens Tony\u2019s tab');
    ok(await evalJs('document.querySelectorAll("#tl .row").length') === 2, 'one row per distinct version (copies deduped)');
    ok(!/dev-t/.test(await txt('#tl')), 'a device under the other passphrase is skipped');
    ok(/Suggested/.test(await txt('#tl .row[aria-pressed=true]')), 'the pre-reset backup is suggested and selected');
    ok(/Current/.test(await txt('#tl')), 'the version TaskHub holds now is marked Current');
    const plan = await txt('#plan');
    ok(/Brought back/.test(plan) && /Added yesterday/.test(plan) && /New Tony goal/.test(plan), 'the plan lists what comes back');
    ok(!(await evalJs('document.getElementById("bar").hidden')), 'the Restore bar is offered');
    ok(await evalJs('localStorage.getItem("a1b_pass") === null'), 'the typed passphrase is not saved');
    ok(!(await writes()).length, 'nothing written before Restore is confirmed');
    await shot('desktop', 1280, 900);
    await shot('phone', 390, 844);

    await evalJs('document.getElementById("go").click()');
    await until('!document.getElementById("dlg").hidden', 20);
    await evalJs('document.getElementById("dlgno").click()');
    await sleep(200);
    ok(!(await writes()).length, 'Cancel writes nothing');

    await pressGo();
    ok(await until('!document.getElementById("done").hidden'), 'restore reports success');
    let w = await writes();
    ok(w.join() === 'dashboards/main_prerestore,dashboards/main_restored,dashboards/main', 'state before saved first, then the record, then TaskHub');
    let m = await live('main');
    ok(m.goals.find((g) => g.id === 'g1').done === true && m.goals.some((g) => g.id === 'g2') && m.data[day(18)], 'Tony\u2019s TaskHub restored');
    ok(m.savedAt > good.main.savedAt, 'the restored doc gets a fresh savedAt, so every device takes it');
    const pre = await live('main_prerestore');
    ok(pre.kind === 'restore' && pre.doc.savedAt === reset.main.savedAt && pre.from === good.main.savedAt, 'the prerestore record holds the state before');
    ok(!(await evalJs('Object.keys(window.__fs).some(k => k.startsWith("vedasdash_"))')), 'Veda\u2019s TaskHub untouched by Tony\u2019s restore');

    // An edit on another device after the restore, then undo: the edit survives.
    await evalJs(`(() => { const d = window.__fs.main; d.goals.push({ id: 'g3', title: 'Made after restore' }); d.savedAt += 5000; return 1; })()`);
    ok(!(await evalJs('document.getElementById("undo").hidden')), 'an Undo card appears');
    await evalJs('document.getElementById("undobtn").click()');
    await sleep(200);
    await pressGo();
    ok(await until('/changed while this page was open/.test(document.getElementById("st").textContent)'), 'a change since the page loaded is caught and the preview redone');
    ok(/Made after restore/.test(await txt('#plan')) || /kept/.test(await txt('#plan')), 'the redone undo preview knows about the new edit');
    await pressGo();
    ok(await until('/undone/.test(document.getElementById("done").textContent)'), 'undo reports success');
    m = await live('main');
    ok(!m.goals.some((g) => g.id === 'g2') && m.goals.find((g) => g.id === 'g1').done === false && !m.data[day(18)], 'undo puts the pre-restore state back');
    ok(m.goals.some((g) => g.id === 'g3'), 'an edit made after the restore survives the undo');
    ok(/Redo/.test(await txt('#undo')), 'the undo can itself be redone');
    await evalJs('document.getElementById("undobtn").click()');
    await sleep(200);
    await pressGo();
    ok(await until('/Restored/.test(document.getElementById("done").textContent)'), 'redo reports success');
    m = await live('main');
    ok(m.goals.some((g) => g.id === 'g2') && m.goals.some((g) => g.id === 'g3'), 'redo brings the restore back and keeps the later edit');

    // Veda's tab.
    await evalJs('document.querySelector("#tabs [data-doc=vedasdash]").click()');
    ok(await until('document.querySelectorAll("#tl .row").length >= 2 && !/Reading/.test(document.getElementById("tlaside").textContent)'), 'Veda\u2019s tab lists her backups');
    ok(/Cook dinner/.test(await txt('#plan')) || /Check-offs/.test(await txt('#plan')), 'Veda\u2019s plan shows her change');
    await pressGo();
    ok(await until('!document.getElementById("done").hidden && /Veda/.test(document.getElementById("done").textContent)'), 'Veda\u2019s restore reports success');
    ok((await live('vedasdash')).data[day(17)][0].done === true, 'Veda\u2019s TaskHub restored');
    ok((await live('vedasdash_prerestore')).doc.savedAt === reset.vedasdash.savedAt, 'Veda\u2019s state before is kept for undo');

    // Worker down: the repo copy still restores.
    workerDown = true;
    await send('Page.navigate', { url: 'https://a1.test/backup-restore.html?profile=veda' });
    await until('!document.getElementById("passcard").hidden');
    await submit(PASS);
    ok(await until('document.querySelectorAll("#tl .row").length >= 1 && !/Reading/.test(document.getElementById("tlaside").textContent)'), 'with the worker down, the repo copy is listed');
    ok(/could not be reached/.test(await txt('#st')), 'and the page says the server could not be reached');
    ok(/Veda/.test(await txt('#tabs [aria-pressed=true]')), '?profile=veda opens Veda\u2019s tab');
    ws.close();
  } finally {
    proc.kill();
    await sleep(500);
    try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
