#!/usr/bin/env node
/**
 * backup-restore.html, end to end in headless Edge: a browser with NO saved
 * passphrase types one person's passphrase and restores BOTH TaskHubs.
 *
 * The backup fixture is real ciphertext made by the shipped backup.js under a
 * test passphrase. Firebase is replaced by stubs (served through CDP Fetch), so
 * nothing here can reach real Firestore; the stub records what would be written.
 *
 * Run: node tests/backup-restore-page.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PASS = 'veda test passphrase';
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FAIL  ') + m); if (!c) fails++; };

// ── Fixture: encrypt with the shipped backup.js ──────────────────────────────
async function makeFixture() {
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
  await A1.unlock(PASS, { allowNewPassphrase: true });
  const { encryptStr } = A1._internals;

  const reset = {   // what live was reset to (an older day's snapshot)
    main: { savedAt: 100, goals: [{ id: 'g1', title: 'Tony goal', done: false }], data: {} },
    vedasdash: { savedAt: 100, goals: [], data: { '2026-10-02': [{ id: 'c', title: 'Cook', done: false }] } }
  };
  const good = {    // just before the reset
    main: { savedAt: 200, goals: [{ id: 'g1', title: 'Tony goal', done: true }, { id: 'g2', title: 'New Tony goal' }], data: {} },
    vedasdash: { savedAt: 200, goals: [], data: { '2026-10-02': [{ id: 'c', title: 'Cook', done: true }] } }
  };
  const files = {}, at = Date.UTC(2026, 9, 3, 6);
  async function snapshot(day, docs, when) {
    const man = { at: when, docs: {} };
    for (const [name, d] of Object.entries(docs)) {
      const h = (name + day).replace(/[^a-z0-9]/gi, '');
      man.docs['dashboards/' + name] = h;
      files['dev-v/objects/' + h + '.enc.json'] = JSON.stringify(await encryptStr(JSON.stringify(d)));
    }
    files['dev-v/snapshots/' + day + '.enc.json'] = JSON.stringify(await encryptStr(JSON.stringify(man)));
  }
  await snapshot('2026-10-03', good, at);
  await snapshot('2026-10-02', reset, at - 86400000);
  files['index.json'] = JSON.stringify({ devices: [{ device: 'dev-v', at, iso: new Date(at).toISOString() }] });
  return { files, live: reset };
}

// ── Firebase stubs (the page imports these four modules) ─────────────────────
const STUBS = {
  'firebase-app.js': 'export const initializeApp = () => ({});',
  'firebase-app-check.js': 'export const initializeAppCheck = () => ({}); export class ReCaptchaV3Provider {}',
  'firebase-auth.js': 'export const getAuth = () => ({}); export const signInAnonymously = async () => ({});',
  'firebase-firestore.js': `
    export const getFirestore = () => ({});
    export const doc = (db, p) => p;
    export const getDocFromServer = async (p) => ({ data: () => JSON.parse(JSON.stringify(window.__live[p.split('/')[1]])) });
    export const setDoc = async (p, v) => { (window.__writes = window.__writes || []).push([p, v]); };`
};

// ── CDP plumbing ─────────────────────────────────────────────────────────────
function findEdge() {
  return ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const edge = findEdge();
  if (!edge) { console.log('  skip  Edge not found'); return; }
  const { files, live } = await makeFixture();
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

    ws.onmessage = async (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
      if (d.method !== 'Fetch.requestPaused') return;
      const url = d.params.request.url, rid = d.params.requestId;
      let body = null, type = 'text/html';
      const stub = Object.keys(STUBS).find((k) => url.includes('gstatic.com') && url.endsWith('/' + k));
      if (stub) { body = STUBS[stub]; type = 'text/javascript'; }
      else if (url.startsWith('https://a1.test/')) {
        const p = decodeURIComponent(new URL(url).pathname.slice(1));
        if (p.startsWith('Index Backups/')) body = files[p.slice('Index Backups/'.length)];
        else if (fs.existsSync(path.join(ROOT, p))) body = fs.readFileSync(path.join(ROOT, p), 'utf8');
        type = p.endsWith('.js') ? 'text/javascript' : p.endsWith('.json') ? 'application/json' : 'text/html';
      }
      if (body == null) return send('Fetch.fulfillRequest', { requestId: rid, responseCode: 404, body: '' });
      send('Fetch.fulfillRequest', { requestId: rid, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Access-Control-Allow-Origin', value: '*' }],
        body: Buffer.from(body).toString('base64') });
    };
    await send('Fetch.enable', { patterns: [{ urlPattern: 'https://a1.test/*' }, { urlPattern: '*gstatic.com*' }] });
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__live = ' + JSON.stringify(live) + ';' });
    await send('Page.navigate', { url: 'https://a1.test/backup-restore.html?good=dev-v' });
    await sleep(1500);

    ok(await evalJs('!document.getElementById("pf").hidden'), 'no saved passphrase → the passphrase box is shown');

    const submit = (p) => evalJs(`(() => { document.getElementById('pw').value = ${JSON.stringify(p)};
      document.getElementById('pf').requestSubmit(); return true; })()`);
    await submit('wrong passphrase');
    for (let i = 0; i < 40 && !(await evalJs('/did not open/.test(document.getElementById("st").textContent)')); i++) await sleep(250);
    ok(await evalJs('/did not open/.test(document.getElementById("st").textContent)'), 'a wrong passphrase is refused');
    ok(!(await evalJs('window.__writes')), 'nothing written after a wrong passphrase');

    await submit(PASS);
    for (let i = 0; i < 80 && (await evalJs('document.getElementById("go").hidden')); i++) await sleep(250);
    const opened = await evalJs('!document.getElementById("go").hidden');
    ok(opened, 'the right passphrase opens the backup and offers Restore');
    if (!opened) console.log('        page says: ' + await evalJs('document.getElementById("st").textContent'));
    const plan = await evalJs('document.getElementById("plan").textContent');
    ok(/Tony.s TaskHub/.test(plan) && /Veda.s TaskHub/.test(plan), 'one passphrase shows BOTH TaskHubs');
    ok(await evalJs('localStorage.getItem("a1b_pass") === null'), 'the typed passphrase is not saved');
    ok(!(await evalJs('window.__writes')), 'nothing written before Restore is clicked');

    await evalJs('document.getElementById("go").click()');
    for (let i = 0; i < 40 && !(await evalJs('(window.__writes||[]).length >= 4')); i++) await sleep(250);
    const writes = await evalJs('window.__writes') || [];
    const w = Object.fromEntries(writes.map(([p, v]) => [p, v]));
    ok(w['dashboards/main_prerestore'] && w['dashboards/vedasdash_prerestore'], 'the current state is saved before writing');
    const main = w['dashboards/main'], veda = w['dashboards/vedasdash'];
    ok(main && main.goals.find((g) => g.id === 'g1').done === true && main.goals.some((g) => g.id === 'g2'),
       'Tony\u2019s TaskHub restored');
    ok(veda && veda.data['2026-10-02'][0].done === true, 'Veda\u2019s TaskHub restored');
    ws.close();
  } finally {
    proc.kill();
    await sleep(500);
    try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
