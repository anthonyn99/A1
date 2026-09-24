// Live, headless end-to-end check of Vault's API Keys section — the web app
// tab AND the Launcher panel — plus regression checks on the tabs that were
// already there and on the vault_pw sync merge.
//
//   node tests/live/vault-apikey.live.js
//
// Runs this working copy on the real origin through cdp.js (Firebase and all
// Google endpoints are blocked at the network), using two test-only pages:
// tests/live/vault-harness.html and tests/live/vault-popup-harness.html.
'use strict';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');

const BASE = 'https://anthonyn99.github.io/A1/tests/live/';
const MASTER = 'correct horse battery staple';
const KEY = 'sk-ant-api03-' + 'Q7xZ'.repeat(10) + 'LAST';
const KEY2 = 'sk-ant-api03-' + 'N3wK'.repeat(10) + 'ROT8';
const SECRET = 'whsec_' + 'S3cr'.repeat(8);

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

async function nav(c, url) {
  await c.send('Page.enable');
  await c.send('Page.navigate', { url });
  await sleep(900);
}
async function waitFor(c, expr, ms) {
  const end = Date.now() + (ms || 6000);
  while (Date.now() < end) {
    try { if (await evalJs(c, expr)) return true; } catch (e) {}
    await sleep(120);
  }
  return false;
}
async function shot(c, name) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  if (r.result && r.result.data) require('fs').writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64'));
}
async function viewport(c, w, h, mobile) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile });
  await sleep(250);
}
// Set an input's value the way typing does (fires `input`).
const typeJs = (sel, val) => `(() => { const e = ${sel}; e.focus(); e.value = ${JSON.stringify(val)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;
const panelText = `document.getElementById('vault-apikeys-panel').innerText`;
const panelHtml = `document.getElementById('vault-apikeys-panel').innerHTML`;

(async () => {
  const c = await connect();
  await c.send('Runtime.enable');
  const errors = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
  });
  await viewport(c, 1280, 900, false);

  console.log('\nWeb app · first run from the API Keys tab');
  await nav(c, BASE + 'vault-harness.html?vaulttab=apikeys');
  await evalJs(c, `localStorage.clear(); true`);
  await nav(c, BASE + 'vault-harness.html?vaulttab=apikeys');
  ok(await waitFor(c, `!!document.querySelector('.vault-tab[data-tab="apikeys"]')`), 'API Keys tab is injected');
  ok(await evalJs(c, `[...document.querySelectorAll('.vault-tab')].map(t=>t.dataset.tab).join(',')`) === 'links,passwords,payments,iddocs,apikeys,sensitive,cloud', 'tab order: API Keys sits between ID Docs and Sensitive Info');
  ok(await waitFor(c, `!!document.querySelector('#vault-apikeys-panel input[placeholder="Create master password"]')`), 'setup card renders in the API Keys panel');
  await evalJs(c, `const i = document.querySelectorAll('#vault-apikeys-panel input[type=password]'); i[0].value = ${JSON.stringify(MASTER)}; i[1].value = ${JSON.stringify(MASTER)}; [...document.querySelectorAll('#vault-apikeys-panel button')].find(b => /Create Vault/.test(b.textContent)).click(); return true`);
  ok(await waitFor(c, `!!document.querySelector('.vault-recovery-code')`, 15000), 'recovery key shown');
  ok(await evalJs(c, `getComputedStyle(document.getElementById('vault-apikeys-panel')).display === 'none'`), 'setup card is hidden behind the recovery key (showRecovery fix)');
  await evalJs(c, `document.getElementById('vault-rec-ack').click(); [...document.querySelectorAll('button')].find(b => /I saved it/.test(b.textContent)).click(); return true`);
  // First run lands on Passwords; go to API Keys.
  await waitFor(c, `!!document.querySelector('#vault-pw-panel .vault-toolbar')`, 8000);
  await evalJs(c, `document.querySelector('.vault-tab[data-tab="apikeys"]').click(); true`);
  ok(await waitFor(c, `/No API keys yet/.test(${panelText})`), 'empty state with an Add button');
  await shot(c, 'vault-apikeys-empty');

  console.log('\nWeb app · add a key');
  await evalJs(c, `[...document.querySelectorAll('#vault-apikeys-panel button')].find(b => /Add API key/.test(b.textContent)).click(); true`);
  ok(await waitFor(c, `!!document.querySelector('.vak-modal')`), 'editor opens');
  await evalJs(c, typeJs(`document.querySelector('.vak-modal input[placeholder^="Paste the API key"]')`, '  ' + KEY + '\n'));
  ok(await evalJs(c, `document.querySelector('.vak-modal input[data-vc-list]').value`) === 'Anthropic', 'provider auto-detected from the key');
  ok(await evalJs(c, `document.querySelector('.vak-modal input[placeholder="ANTHROPIC_API_KEY"]') != null`), 'env variable suggested (ANTHROPIC_API_KEY)');
  ok(await evalJs(c, `document.querySelector('.vak-modal input[placeholder^="Paste the API key"]').getAttribute('autocapitalize')`) === 'off', 'key input disables autocapitalize (phones)');
  await evalJs(c, typeJs(`document.querySelector('.vak-modal input[placeholder^="Client secret"]')`, SECRET));
  await evalJs(c, typeJs(`document.querySelector('.vak-modal input[placeholder^="Access-key ID"]')`, 'key_01ABC'));
  await evalJs(c, typeJs(`document.querySelector('.vak-modal input[placeholder^="Account"]')`, 'tony@example.com'));
  await evalJs(c, `const s = [...document.querySelectorAll('.vak-modal select')][1]; s.value = 'production'; s.dispatchEvent(new Event('change')); return true`);
  await evalJs(c, typeJs(`document.querySelector('.vak-modal textarea')`, 'Used by MAGI.\nRate limit: 50 rpm'));
  await evalJs(c, `[...document.querySelectorAll('.vak-modal button')].find(b => /Add custom field/.test(b.textContent)).click(); true`);
  await evalJs(c, typeJs(`document.querySelector('.vak-modal .vault-cf-row input[placeholder=Label]')`, 'Org PIN'));
  await evalJs(c, typeJs(`document.querySelector('.vak-modal .vault-cf-row input[placeholder=Value]')`, 'PIN-998877'));
  await evalJs(c, `document.querySelector('.vak-modal .vault-cf-row .vault-icon').click(); true`); // mark hidden
  console.log('\nThemed controls (no browser UI)');
  const ctl = await evalJs(c, `const m = document.querySelector('.vak-modal');
    const inp = m.querySelector('input[placeholder^="Account"]');
    return { selects: m.querySelectorAll('select.vc-native').length, buttons: m.querySelectorAll('.vc-select').length,
      date: !!m.querySelector('.vc-date') && m.querySelector('input[type=date]').classList.contains('vc-native'),
      list: m.querySelector('input[list]') === null, cb: getComputedStyle(m.querySelector('input[type=checkbox]')).appearance,
      sb: getComputedStyle(m).scrollbarWidth, fieldBg: getComputedStyle(inp).backgroundColor, modalBg: getComputedStyle(m).backgroundColor,
      envLabel: [...m.querySelectorAll('.vc-select')][1].textContent.trim() }`);
  ok(ctl.selects === 3 && ctl.buttons === 3, 'every <select> is a themed dropdown', ctl);
  ok(ctl.date, 'date input is a themed date field', ctl);
  ok(ctl.list, 'datalist input has no native list', ctl);
  ok(ctl.cb === 'none', 'checkbox is themed', ctl);
  ok(ctl.sb === 'none', 'native scrollbar hidden in the modal', ctl);
  ok(ctl.fieldBg !== ctl.modalBg, 'fields contrast with the modal', ctl);
  ok(ctl.envLabel === 'Production', 'setting select.value repaints the themed button', ctl);
  await evalJs(c, `[...document.querySelectorAll('.vak-modal .vc-select')][1].click(); true`);
  ok(await waitFor(c, `!!document.querySelector('.vc-pop.on [role=option]')`), 'dropdown opens a themed listbox');
  await evalJs(c, `[...document.querySelectorAll('.vc-pop .vc-opt')].find(o => o.textContent.trim() === 'Staging').click(); true`);
  ok(await waitFor(c, `!document.querySelector('.vc-pop') && [...document.querySelectorAll('.vak-modal select')][1].value === 'staging'`), 'choosing an option sets the real select');
  await evalJs(c, `const s = [...document.querySelectorAll('.vak-modal select')][1]; s.value = 'production'; s.dispatchEvent(new Event('change')); return true`);
  await evalJs(c, `document.querySelector('.vak-modal .vc-date').click(); true`);
  ok(await waitFor(c, `!!document.querySelector('.vc-pop.vc-cal .vc-cal-cell')`), 'date field opens a themed calendar');
  await evalJs(c, `[...document.querySelectorAll('.vc-cal .vc-cal-link')].find(b => b.textContent === 'Today').click(); true`);
  const todayIso = await evalJs(c, `const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')`);
  ok(await waitFor(c, `document.querySelector('.vak-modal input[type=date]').value === '${todayIso}'`), 'Today sets the date');
  ok(/\d/.test(await evalJs(c, `document.querySelector('.vak-modal .vc-date').textContent`)), 'date field shows the formatted date');
  await shot(c, 'vault-controls-date');
  await evalJs(c, `const d = document.querySelector('.vak-modal input[type=date]'); d.value = ''; d.dispatchEvent(new Event('change')); return true`);
  const prov = await evalJs(c, `document.querySelector('.vak-modal input[data-vc-list]').value`);
  await evalJs(c, typeJs(`document.querySelector('.vak-modal input[data-vc-list]')`, 'Anth'));
  ok(await waitFor(c, `[...document.querySelectorAll('.vc-pop .vc-opt')].some(o => o.textContent === 'Anthropic')`), 'provider suggestions are a themed menu');
  await evalJs(c, `const i = document.querySelector('.vak-modal input[data-vc-list]'); i.value = ${JSON.stringify(prov)}; i.dispatchEvent(new Event('input', { bubbles: true })); window.VaultControls.close(); return true`);
  await viewport(c, 1280, 620, false);
  await evalJs(c, `document.querySelector('.vak-modal').scrollTop = 200; true`);
  ok(await waitFor(c, `!!document.querySelector('.vc-rail.v.on')`), 'scrolling shows the themed scrollbar');
  await shot(c, 'vault-controls-scrollbar');
  const rail = await evalJs(c, `const r = document.querySelector('.vc-rail.v.on'); const t = r.querySelector('.vc-thumb').getBoundingClientRect(); const m = document.querySelector('.vak-modal').getBoundingClientRect();
    return { x: t.left + t.width / 2, y: t.top + t.height / 2, inside: t.right <= m.right + 1 && t.left >= m.left, st: document.querySelector('.vak-modal').scrollTop }`);
  ok(rail.inside, 'thumb sits inside the modal edge', rail);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rail.x, y: rail.y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rail.x, y: rail.y, button: 'left', clickCount: 1 });
  for (let k = 1; k <= 6; k++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rail.x, y: rail.y + k * 15, button: 'left', buttons: 1 }); await sleep(16); }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rail.x, y: rail.y + 90, button: 'left', clickCount: 1 });
  const st2 = await evalJs(c, `document.querySelector('.vak-modal').scrollTop`);
  ok(st2 > rail.st + 40, 'dragging the thumb scrolls', { before: rail.st, after: st2 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 });
  ok(await waitFor(c, `!document.querySelector('.vc-rail.on')`, 3000), 'thumb fades out when idle');
  await viewport(c, 1280, 900, false);

  const writesBefore = await evalJs(c, `window.__writes`);
  await evalJs(c, `[...document.querySelectorAll('.vak-modal button')].find(b => b.textContent === 'Add API key').click(); true`);
  ok(await waitFor(c, `!document.querySelector('.vak-modal') && document.querySelectorAll('#vault-apikeys-panel .vak-site').length === 1`), 'saved and listed');
  ok(await waitFor(c, `window.__writes > ${writesBefore}`), 'synced to the cloud doc');
  ok(await evalJs(c, `window.__writes - ${writesBefore}`) === 1, 'exactly one write for one save', await evalJs(c, `window.__writes - ${writesBefore}`));
  const cloud = await evalJs(c, `JSON.stringify(window.__cloud)`);
  ok(cloud.indexOf('apikey') >= 0, 'cloud item carries kind:apikey');
  ok(cloud.indexOf(KEY.slice(14, 30)) < 0 && cloud.indexOf('Anthropic') < 0 && cloud.indexOf('PIN-998877') < 0 && cloud.indexOf('MAGI') < 0, 'no plaintext in the cloud doc');
  ok((await evalJs(c, panelText)).indexOf(KEY) < 0, 'row shows only the masked key');
  ok(/sk-ant-.*•+.*LAST/.test(await evalJs(c, panelText)), 'mask keeps prefix + last 4');

  console.log('\nWeb app · details, reveal, copy');
  // A just-saved key opens expanded, so you see what you saved.
  ok(await evalJs(c, `document.querySelector('#vault-apikeys-panel .vak-body').style.display !== 'none'`), 'new key opens expanded');
  await evalJs(c, `document.querySelector('#vault-apikeys-panel .vak-head').click(); true`);
  ok(await evalJs(c, `document.querySelector('#vault-apikeys-panel .vak-body').style.display === 'none'`), 'row collapses');
  await evalJs(c, `document.querySelector('#vault-apikeys-panel .vak-head').click(); true`);
  ok(await evalJs(c, `document.querySelector('#vault-apikeys-panel .vak-body').style.display !== 'none'`), 'row expands');
  ok((await evalJs(c, panelHtml)).indexOf('PIN-998877') < 0, 'hidden custom field is masked');
  await evalJs(c, `document.querySelector('#vault-apikeys-panel .vak-line button[title="Reveal API key"]').click(); true`);
  ok((await evalJs(c, panelText)).indexOf(KEY) >= 0, 'reveal shows the full key');
  await evalJs(c, `document.querySelector('#vault-apikeys-panel .vak-line button[title="Reveal API key"], #vault-apikeys-panel .vak-line button[title="Hide API key"]').click(); true`);
  ok((await evalJs(c, panelText)).indexOf(KEY) < 0, 'hide re-masks');
  await evalJs(c, `document.querySelector('#vault-apikeys-panel .vak-quick').click(); true`);
  ok(await evalJs(c, `window.__clip`) === KEY, 'quick copy puts the trimmed key on the clipboard');
  await evalJs(c, `[...document.querySelectorAll('#vault-apikeys-panel .vak-act')].find(b => /Copy .env/.test(b.textContent)).click(); true`);
  const envClip = await evalJs(c, `window.__clip`);
  ok(envClip.split('\n')[0] === 'ANTHROPIC_API_KEY=' + KEY, 'Copy .env → ANTHROPIC_API_KEY=…', envClip);
  ok(/_SECRET=whsec_/.test(envClip), '.env block includes the secret', envClip);
  await evalJs(c, `[...document.querySelectorAll('#vault-apikeys-panel .vak-act')].find(b => /Open console/.test(b.textContent)).click(); true`);
  ok((await evalJs(c, `window.__opened.slice(-1)[0]`)) === 'https://console.anthropic.com/settings/keys', 'Open console falls back to the provider console');
  await shot(c, 'vault-apikeys-desktop');

  console.log('\nWeb app · search');
  await evalJs(c, typeJs(`document.querySelector('#vault-apikeys-panel .vault-search')`, 'anthropic'));
  ok(await waitFor(c, `document.querySelectorAll('#vault-apikeys-panel .vak-site').length === 1`), 'search by provider finds it');
  ok(await evalJs(c, `document.activeElement && document.activeElement.classList.contains('vault-search')`), 'search box keeps focus while filtering');
  await evalJs(c, typeJs(`document.querySelector('#vault-apikeys-panel .vault-search')`, 'Q7xZQ7xZ'));
  ok(await waitFor(c, `document.querySelectorAll('#vault-apikeys-panel .vak-site').length === 0`), 'search never matches the key itself');
  await evalJs(c, typeJs(`document.querySelector('#vault-apikeys-panel .vault-search')`, 'PIN-998877'));
  ok(await waitFor(c, `document.querySelectorAll('#vault-apikeys-panel .vak-site').length === 0`), 'search never matches a hidden custom value');
  await evalJs(c, `document.querySelector('#vault-apikeys-panel .vault-search-clear').click(); true`);

  console.log('\nWeb app · rotate');
  await evalJs(c, `document.querySelector('#vault-apikeys-panel .vak-head button[title=Edit]').click(); true`);
  await waitFor(c, `!!document.querySelector('.vak-modal')`);
  ok(await evalJs(c, `document.querySelector('.vak-modal input[placeholder^="Paste the API key"]').type`) === 'password', 'existing key is masked in the editor');
  await evalJs(c, typeJs(`document.querySelector('.vak-modal input[placeholder^="Paste the API key"]')`, KEY2));
  await evalJs(c, `[...document.querySelectorAll('.vak-modal button')].find(b => b.textContent === 'Save').click(); true`);
  await waitFor(c, `!document.querySelector('.vak-modal')`);
  const rotated = await evalJs(c, `const it = Vault.session().getStore().byKind('apikey')[0]; return { k: it.key === ${JSON.stringify(KEY2)}, h: (it.keyHistory || []).length, old: (it.keyHistory || [{}])[0].key === ${JSON.stringify(KEY)}, r: !!it.rotatedAt, notes: it.notes, cf: it.customFields }`);
  ok(rotated.k && rotated.h === 1 && rotated.old && rotated.r, 'old key kept in history, rotatedAt set', rotated);
  ok(rotated.notes === 'Used by MAGI.\nRate limit: 50 rpm', 'multi-line notes preserved', rotated.notes);
  ok(rotated.cf && rotated.cf[0] && rotated.cf[0].hidden === true && rotated.cf[0].value === 'PIN-998877', 'hidden custom field saved', rotated.cf);
  ok(await waitFor(c, `/Previous keys \\(1\\)/.test(${panelText})`), '"Previous keys (1)" shown');

  console.log('\nSync · a second device racing our save');
  const race = await evalJs(c, `
    const store = Vault.session().getStore();
    const other = new VaultStore(VaultStore.memoryBackend(), store.dek);
    const remoteDoc = await other._buildDoc(Object.assign(VaultApiKey.normalize({ provider: 'GitHub', key: 'ghp_' + 'r'.repeat(36), title: 'From phone' }), { id: 'itm_remote_1' }));
    // Our next local save races the other device: their snapshot lacks our new
    // item, ours lacks theirs.
    await store.save(VaultApiKey.normalize({ title: 'Local only', key: 'local-key-1234567890' }));
    const before = window.__writes;
    const snap = JSON.parse(JSON.stringify(window.__cloud || { items: {} }));
    const localIds = Object.keys(snap.items).filter(id => snap.items[id].kind === 'apikey');
    const newest = localIds.sort((a, b) => snap.items[b].updatedAt - snap.items[a].updatedAt)[0];
    delete snap.items[newest];                       // their copy predates our item
    snap.items['itm_remote_1'] = remoteDoc;          // …and has theirs
    snap.savedAt = Date.now() + 1;
    window.dispatchEvent(new CustomEvent('fb-vault-remote-update', { detail: snap }));
    await new Promise(r => setTimeout(r, 400));
    const cloudIds = Object.keys(window.__cloud.items);
    return { listed: store.byKind('apikey').map(i => i.title).sort(), healed: cloudIds.includes('itm_remote_1') && cloudIds.includes(newest), wrote: window.__writes - before };`);
  ok(race.listed.join('|') === 'Anthropic|From phone|Local only', 'both devices\' keys are kept locally', race.listed);
  ok(race.healed, 'cloud copy healed with the union');
  ok(race.wrote === 1, 'exactly one heal write', race.wrote);
  ok(await waitFor(c, `/From phone/.test(${panelText})`), 'remote key appears in the open list');
  const echo = await evalJs(c, `const before = window.__writes; const n0 = document.querySelectorAll('#vault-apikeys-panel .vak-site').length;
    window.dispatchEvent(new CustomEvent('fb-vault-remote-update', { detail: JSON.parse(JSON.stringify(window.__cloud)) }));
    await new Promise(r => setTimeout(r, 300)); return { w: window.__writes - before, n: document.querySelectorAll('#vault-apikeys-panel .vak-site').length === n0 };`);
  ok(echo.w === 0 && echo.n, 'a no-op snapshot writes nothing and repaints nothing', echo);

  console.log('\nWeb app · existing tabs still work');
  await evalJs(c, `document.querySelector('.vault-tab[data-tab="passwords"]').click(); true`);
  ok(await waitFor(c, `!!document.querySelector('#vault-pw-panel .vault-toolbar')`), 'Passwords renders');
  await evalJs(c, `[...document.querySelectorAll('#vault-pw-panel button')].find(b => /\\+ Add/.test(b.textContent)).click(); true`);
  await waitFor(c, `!!document.querySelector('.vault-modal')`);
  await evalJs(c, typeJs(`document.querySelector('.vault-modal input[placeholder="e.g. GitHub"]')`, 'GitHub'));
  await evalJs(c, typeJs(`document.querySelector('.vault-modal input[placeholder="password"]')`, 'hunter2hunter2'));
  await evalJs(c, `[...document.querySelectorAll('.vault-modal button')].find(b => b.textContent === 'Add').click(); true`);
  ok(await waitFor(c, `/GitHub/.test(document.getElementById('vault-pw-panel').innerText)`), 'adding a login still works');
  for (const [tab, panel, probe] of [['payments', 'vault-payments-panel', 'No payment methods yet'], ['iddocs', 'vault-iddocs-panel', ''], ['sensitive', 'vault-sensitive-panel', 'No secure notes yet']]) {
    await evalJs(c, `document.querySelector('.vault-tab[data-tab="${tab}"]').click(); true`);
    ok(await waitFor(c, `!!document.querySelector('#${panel} .vault-toolbar') && getComputedStyle(document.getElementById('${panel}')).display !== 'none'` + (probe ? ` && /${probe}/.test(document.getElementById('${panel}').innerText)` : '')), tab + ' renders');
    ok(await evalJs(c, `getComputedStyle(document.getElementById('vault-apikeys-panel')).display === 'none'`), 'API Keys panel hidden while on ' + tab);
  }
  ok(await evalJs(c, `Vault.session().getStore().byKind('login').length === 1 && Vault.session().getStore().byKind('apikey').length === 3`), 'API keys never leak into other kinds');

  console.log('\nWeb app · settings');
  await evalJs(c, `document.querySelector('.vault-tab[data-tab="apikeys"]').click(); true`);
  await waitFor(c, `!!document.querySelector('#vault-apikeys-panel .vault-toolbar')`);
  await evalJs(c, `document.querySelector('#vault-apikeys-panel .vault-toolbar button[title=Settings]').click(); true`);
  ok(await evalJs(c, `[...document.querySelectorAll('.vault-setting-row')].some(b => b.textContent === 'Delete all API Keys')`), 'Settings offers "Delete all API Keys"');
  await evalJs(c, `[...document.querySelectorAll('.vault-setting-row')].find(b => /Import \\/ Export/.test(b.textContent)).click(); true`);
  ok(await waitFor(c, `[...document.querySelectorAll('.vault-ie-title')].some(t => /\\.env/.test(t.textContent))`), 'Import / Export offers .env import + export');
  const imp = await evalJs(c, `
    const input = [...document.querySelectorAll('.vault-modal input[type=file]')].find(i => /\\.env/.test(i.accept));
    const dt = new DataTransfer();
    dt.items.add(new File(['PORT=3000\\nGROQ_API_KEY=gsk_${'g'.repeat(40)}\\nDEBUG=1\\nexport HF_TOKEN="hf_${'h'.repeat(30)}"\\n'], 'dev.env', { type: 'text/plain' }));
    input.files = dt.files; input.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 600));
    return { status: document.querySelector('.vault-modal .vault-err').textContent, n: Vault.session().getStore().byKind('apikey').length };`);
  ok(imp.n === 5 && /Imported 2/.test(imp.status), '.env import adds only the 2 credentials', imp);
  await evalJs(c, `[...document.querySelectorAll('.vault-modal button')].find(b => b.textContent === 'Close').click(); true`);

  console.log('\nWeb app · mobile layout');
  await viewport(c, 390, 844, true);
  await evalJs(c, `document.querySelector('.vault-tab[data-tab="apikeys"]').click(); true`);
  await sleep(300);
  await evalJs(c, `const h = [...document.querySelectorAll('#vault-apikeys-panel .vak-head')].find(h => /Anthropic/.test(h.innerText)); if (h.getAttribute('aria-expanded') !== 'true') h.click(); return true`);
  const mob = await evalJs(c, `const r = document.getElementById('kc-root'); const offenders = [...document.querySelectorAll('#vault-apikeys-panel *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => e.className).slice(0, 5);
    return { over: r.scrollWidth - r.clientWidth, offenders, chips: [...document.querySelectorAll('.vak-chips')].every(e => getComputedStyle(e).display === 'none'), pin: [...document.querySelectorAll('.vak-pin')].some(e => getComputedStyle(e).display !== 'none') }`);
  ok(mob.over <= 0 && !mob.offenders.length, 'no horizontal overflow at 390px', mob);
  ok(mob.chips && mob.pin, 'chips hidden, Pin moves into the body on phones', mob);
  await shot(c, 'vault-apikeys-mobile');
  await evalJs(c, `document.querySelector('#vault-apikeys-panel .vak-head button[title=Edit]').click(); true`);
  await waitFor(c, `!!document.querySelector('.vak-modal')`);
  const mm = await evalJs(c, `const m = document.querySelector('.vak-modal'); return { w: m.getBoundingClientRect().width, fits: m.getBoundingClientRect().right <= innerWidth, grid: getComputedStyle(document.querySelector('.vak-grid2')).gridTemplateColumns.split(' ').length }`);
  ok(mm.fits && mm.grid === 1, 'editor fits the phone and stacks to one column', mm);
  await shot(c, 'vault-apikeys-mobile-editor');
  await evalJs(c, `[...document.querySelectorAll('.vak-modal button')].find(b => b.textContent === 'Cancel').click(); true`);
  await viewport(c, 1280, 900, false);

  console.log('\nTabs · smooth drag + synced order');
  await evalJs(c, `window.__tabOrderSaved = null; true`);
  const tabsPos = await evalJs(c, `const t = [...document.querySelectorAll('.vault-tab')]; return t.map(e => { const r = e.getBoundingClientRect(); return { k: e.dataset.tab, x: r.left + r.width / 2, y: r.top + r.height / 2 }; })`);
  const src = tabsPos.find((t) => t.k === 'apikeys'), dst = tabsPos.find((t) => t.k === 'passwords');
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: src.x, y: src.y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: src.x, y: src.y, button: 'left', clickCount: 1 });
  const drift = [];
  for (let k = 1; k <= 24; k++) {
    const x = src.x + (dst.x - 30 - src.x) * k / 24;
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: src.y, button: 'left', buttons: 1 });
    await sleep(20);
    const r = await evalJs(c, `const e = document.querySelector('.vault-tab.vdrag'); if (!e) return null; const r = e.getBoundingClientRect(); return r.left + r.width / 2`);
    if (r != null) drift.push(Math.abs(r - x));
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dst.x - 30, y: src.y, button: 'left', clickCount: 1 });
  await sleep(400);
  const maxOff = Math.max.apply(null, drift.slice(2));
  ok(drift.length > 10 && maxOff < 12, 'dragged tab tracks the pointer (max drift ' + Math.round(maxOff) + 'px)', drift.map(Math.round));
  const newOrder = await evalJs(c, `[...document.querySelectorAll('.vault-tab')].map(t => t.dataset.tab).join(',')`);
  ok(newOrder.indexOf('links,apikeys,passwords') === 0, 'drop reorders the tabs', newOrder);
  ok((await evalJs(c, `(window.__tabOrderSaved || []).join(',')`)) === newOrder, 'order saved to the keychain doc for the Launcher');
  ok(await evalJs(c, `document.querySelector('.vault-tab.active').dataset.tab`) === 'apikeys', 'drop did not also switch tabs');
  await evalJs(c, `window.dispatchEvent(new CustomEvent('fb-kc-taborder', { detail: ['links','cloud','sensitive','apikeys','iddocs','payments','passwords'] })); true`);
  ok(await evalJs(c, `[...document.querySelectorAll('.vault-tab')].map(t => t.dataset.tab).join(',')`) === 'links,cloud,sensitive,apikeys,iddocs,payments,passwords', 'an order from another device applies live');
  await evalJs(c, `window.dispatchEvent(new CustomEvent('fb-kc-taborder', { detail: ['links','passwords','payments','iddocs','apikeys','sensitive','cloud'] })); true`);

  console.log('\nWeb app · lock');
  await evalJs(c, `document.querySelector('#vault-apikeys-panel .vault-toolbar button[title="Lock now"]').click(); true`);
  ok(await waitFor(c, `!!document.querySelector('#vault-apikeys-panel input[placeholder="Master password"]')`), 'lock screen drawn in the API Keys panel');
  const lockedHtml = await evalJs(c, `document.getElementById('kc-root').innerHTML`);
  ok(lockedHtml.indexOf(KEY2) < 0 && lockedHtml.indexOf('sk-ant-') < 0 && lockedHtml.indexOf('From phone') < 0, 'no key material left in the DOM when locked');
  await evalJs(c, `document.querySelector('#vault-apikeys-panel input[placeholder="Master password"]').value = ${JSON.stringify(MASTER)}; [...document.querySelectorAll('#vault-apikeys-panel button')].find(b => b.textContent === 'Unlock').click(); return true`);
  ok(await waitFor(c, `document.querySelectorAll('#vault-apikeys-panel .vak-site').length === 5`, 8000), 'unlock returns to API Keys with all 5 keys');

  console.log('\nWeb app · delete');
  await evalJs(c, `const row = [...document.querySelectorAll('#vault-apikeys-panel .vak-site')].find(r => /Local only/.test(r.innerText)); row.querySelector('.vak-head button[title=Edit]').click(); return true`);
  await waitFor(c, `!!document.querySelector('.vak-modal')`);
  await evalJs(c, `[...document.querySelectorAll('.vak-modal button')].find(b => b.textContent === 'Delete').click(); true`);
  ok(await waitFor(c, `document.querySelectorAll('#vault-apikeys-panel .vak-site').length === 4`), 'delete removes it');
  await sleep(200);
  ok(await evalJs(c, `Object.values(window.__cloud.items).filter(d => d.deleted).length === 1`), 'delete syncs as a tombstone');

  // Hand the synced doc to the Launcher harness (same origin → same storage).
  await evalJs(c, `localStorage.setItem('__vaultDoc', JSON.stringify(window.__cloud)); true`);

  console.log('\nLauncher · API Keys panel');
  await nav(c, BASE + 'vault-popup-harness.html');
  await evalJs(c, `VaultApiKeyPanel.render(); true`);
  ok(await waitFor(c, `!!document.querySelector('#panel-apikeys input[placeholder="Master password"]')`), 'locked: asks for the master password');
  await evalJs(c, `const i = document.querySelector('#panel-apikeys .pw-input'); i.value = 'wrong password'; document.querySelector('#panel-apikeys .pw-btn.primary').click(); return true`);
  ok(await waitFor(c, `/Incorrect master password/.test(document.getElementById('panel-apikeys').innerText)`), 'wrong password refused');
  await evalJs(c, `const i = document.querySelector('#panel-apikeys .pw-input'); i.value = ${JSON.stringify(MASTER)}; document.querySelector('#panel-apikeys .pw-btn.primary').click(); return true`);
  ok(await waitFor(c, `document.querySelectorAll('#panel-apikeys .ak-row').length === 4`, 8000), 'unlocked: lists 4 keys');
  ok(await evalJs(c, `window.__fetches`) === 1, 'one Worker fetch for the whole panel', await evalJs(c, `window.__fetches`));
  ok(/For this site · console\.anthropic\.com/.test(await evalJs(c, `document.getElementById('panel-apikeys').innerText`)), 'keys for the current site are listed first');
  ok((await evalJs(c, `document.getElementById('panel-apikeys').innerHTML`)).indexOf(KEY2) < 0, 'popup renders keys masked');
  await evalJs(c, `document.querySelector('#panel-apikeys .ak-row .pw-icon[title="Copy API key"]').click(); true`);
  await sleep(100);
  ok(await evalJs(c, `window.__clip`) === KEY2, 'copy key');
  // Fill with a focused field → that field gets the key.
  await evalJs(c, `document.getElementById('f-note').focus(); document.querySelector('#panel-apikeys .ak-row .pw-fill').click(); true`);
  await sleep(150);
  ok(await evalJs(c, `document.getElementById('f-note').value`) === KEY2, 'Fill writes into the focused field');
  // Fill with nothing focused → fields matched by label.
  await evalJs(c, `['f-id','f-secret','f-key','f-note'].forEach(id => document.getElementById(id).value = ''); document.activeElement.blur(); document.querySelector('#panel-apikeys .ak-row .pw-fill').click(); true`);
  await sleep(150);
  const f = await evalJs(c, `({ id: document.getElementById('f-id').value, secret: document.getElementById('f-secret').value, key: document.getElementById('f-key').value, note: document.getElementById('f-note').value })`);
  ok(f.key === KEY2 && f.secret === SECRET && f.id === 'key_01ABC' && f.note === '', 'Fill matches key / secret / client ID by label', f);
  await evalJs(c, `document.querySelector('#panel-apikeys .ak-head').click(); true`);
  ok(await waitFor(c, `!!document.querySelector('#panel-apikeys .ak-details:not([hidden]) .ak-line')`), 'row expands to details');
  ok(await evalJs(c, `[...document.querySelectorAll('#panel-apikeys .ak-details')].filter(d => d.hidden).every(d => !d.firstChild)`), 'unopened rows hold no detail DOM');
  ok((await evalJs(c, `document.querySelector('#panel-apikeys .ak-details').innerHTML`)).indexOf(SECRET) < 0, 'secret masked in details');
  await evalJs(c, `document.getElementById('f-note').value=''; document.getElementById('f-note').focus(); [...document.querySelectorAll('#panel-apikeys .ak-details:not([hidden]) .ak-line')].find(l => l.querySelector('.ak-label').textContent === 'Secret').querySelector('.ak-fill1').click(); true`);
  await sleep(150);
  ok(await evalJs(c, `document.getElementById('f-note').value`) === SECRET, 'per-field Fill (secret → focused field)');
  await evalJs(c, `[...document.querySelectorAll('#panel-apikeys .ak-details:not([hidden]) .ak-line')].find(l => l.querySelector('.ak-label').textContent === '.env').querySelector('.pw-icon[title^="Copy"]').click(); true`);
  await sleep(100);
  ok((await evalJs(c, `window.__clip`)) === 'ANTHROPIC_API_KEY=' + KEY2, 'copy .env line from the popup');
  await evalJs(c, `document.querySelector('#panel-apikeys .ak-console').click(); true`);
  ok((await evalJs(c, `window.__created.slice(-1)[0]`)) === 'https://console.anthropic.com/settings/keys', 'Open console');
  await evalJs(c, `const s = document.querySelector('#panel-apikeys .pw-search'); s.value = 'github'; s.dispatchEvent(new Event('input')); return true`);
  ok(await waitFor(c, `document.querySelectorAll('#panel-apikeys .ak-row').length === 1`), 'popup search');
  await evalJs(c, `const s = document.querySelector('#panel-apikeys .pw-search'); s.value = 'N3wK'; s.dispatchEvent(new Event('input')); return true`);
  ok(await waitFor(c, `document.querySelectorAll('#panel-apikeys .ak-row').length === 0`), 'popup search never matches key text');
  await evalJs(c, `document.querySelector('#panel-apikeys .pw-icon[title="Lock now"]').click(); true`);
  ok(await waitFor(c, `!!document.querySelector('#panel-apikeys input[placeholder="Master password"]')`), 'popup lock');
  await evalJs(c, `VaultApiKeyPanel.render(); true`);
  ok(await waitFor(c, `!!document.querySelector('#panel-apikeys input[placeholder="Master password"]')`), 'stays locked after lock (session cleared)');

  console.log('\nLauncher · real popup.html');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (function(){
      var doc = JSON.parse(localStorage.getItem('__vaultDoc') || 'null');
      window.fetch = function (url) { var body = /keychain/.test(String(url)) ? { connections: [], colmap: null, savedAt: 1, tabOrder: ['links','cloud','apikeys','sensitive','iddocs','passwords','payments'] } : doc;
        return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } }); };
      var st = {};
      function area(){ return { get: function (k, cb) { var o = {}; (Array.isArray(k) ? k : [k]).forEach(function(x){ o[x] = st[x]; }); cb && cb(o); }, set: function (o, cb) { Object.assign(st, o); cb && cb(); }, remove: function (k, cb) { delete st[k]; cb && cb(); } }; }
      window.chrome = { runtime: { lastError: null, sendMessage: function(){}, onMessage: { addListener: function(){} } },
        storage: { session: area(), local: area() },
        tabs: { query: function (q, cb) { cb([{ id: 7, url: 'https://example.com/', windowId: 1 }]); }, sendMessage: function(){}, create: function(){}, update: function(){} },
        windows: { update: function(){} }, scripting: { executeScript: function (o, cb) { cb && cb([{ result: { filled: 0 } }]); } } };
    })();` });
  await nav(c, BASE + '../../Vault/popup.html');
  await sleep(600);
  ok(await evalJs(c, `!!document.getElementById('tab-api')`), 'popup has an API Keys tab');
  ok(await waitFor(c, `[...document.querySelectorAll('.tab')].map(t => t.dataset.panel).join(',') === 'links,apikeys,iddocs,passwords,payments'`), "popup tabs follow the app's tab order", await evalJs(c, `[...document.querySelectorAll('.tab')].map(t => t.dataset.panel).join(',')`));
  ok(await evalJs(c, `getComputedStyle(document.getElementById('scroll')).scrollbarWidth`) === 'none', 'popup uses the themed scrollbar');
  await evalJs(c, `document.getElementById('tab-api').click(); true`);
  ok(await waitFor(c, `!document.getElementById('panel-apikeys').classList.contains('hidden') && !!document.querySelector('#panel-apikeys .pw-input')`), 'API Keys tab shows the unlock form');
  const tabs = await evalJs(c, `const t = [...document.querySelectorAll('.tab')].map(e => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), clipped: e.scrollWidth > e.clientWidth }; }); return { rows: new Set(t.map(x => x.top)).size, clipped: t.some(x => x.clipped) }`);
  ok(tabs.rows <= 2 && !tabs.clipped, 'five tabs fit in two rows without clipping at 344px', tabs);
  await evalJs(c, `document.querySelector('#panel-apikeys .pw-input').value = ${JSON.stringify(MASTER)}; document.querySelector('#panel-apikeys .pw-btn.primary').click(); return true`);
  ok(await waitFor(c, `document.querySelectorAll('#panel-apikeys .ak-row').length === 4`, 8000), 'real popup lists the keys after unlock');
  await evalJs(c, `document.querySelector('#panel-apikeys .ak-head').click(); true`);
  await sleep(200);
  const pop = await evalJs(c, `const s = document.getElementById('scroll'); return { over: s.scrollWidth - s.clientWidth }`);
  ok(pop.over <= 0, 'no horizontal overflow in the popup', pop);
  await shot(c, 'vault-popup-apikeys');
  await evalJs(c, `document.getElementById('tab-pw').click(); true`);
  ok(await waitFor(c, `document.querySelectorAll('#panel-passwords .pw-row').length === 1`), 'Passwords tab still lists logins (shared unlock)');
  await evalJs(c, `document.getElementById('tab-pay').click(); true`);
  ok(await waitFor(c, `/No payment methods yet/.test(document.getElementById('panel-payments').innerText)`), 'Payments tab still works');

  console.log('\nTabs · touch (phone)');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: '' });
  await viewport(c, 390, 844, true);
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await nav(c, BASE + 'vault-harness.html');
  await sleep(600);
  const touch = (type, x, y) => c.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const tp = await evalJs(c, `const t = [...document.querySelectorAll('.vault-tab')]; return t.map(e => { const r = e.getBoundingClientRect(); return { k: e.dataset.tab, x: r.left + r.width / 2, y: r.top + r.height / 2 }; })`);
  const t0 = await evalJs(c, `[...document.querySelectorAll('.vault-tab')].map(t => t.dataset.tab).join(',')`);
  await touch('touchStart', tp[2].x, tp[2].y);
  for (let k = 1; k <= 8; k++) { await touch('touchMove', tp[2].x - k * 20, tp[2].y); await sleep(16); }
  await touch('touchEnd'); await sleep(300);
  ok((await evalJs(c, `[...document.querySelectorAll('.vault-tab')].map(t => t.dataset.tab).join(',')`)) === t0 && (await evalJs(c, `document.getElementById('vault-tabs').scrollLeft`)) > 0, 'a swipe scrolls the tab strip, never drags');
  ok(await evalJs(c, `!document.querySelector('.vc-rail.h.on')`), 'no scrollbar rail over the tab strip');
  await evalJs(c, `document.getElementById('vault-tabs').scrollLeft = 0; window.__tabOrderSaved = null; true`);
  await sleep(150);
  const lp = await evalJs(c, `const r = document.querySelector('.vault-tab').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }`);
  await touch('touchStart', lp.x, lp.y); await sleep(350);
  ok(await evalJs(c, `!!document.querySelector('.vault-tab.vdrag')`), 'long-press arms the drag');
  const tdrift = [];
  for (let k = 1; k <= 20; k++) {
    const x = lp.x + k * 9;
    await touch('touchMove', x, lp.y); await sleep(20);
    const r = await evalJs(c, `const e = document.querySelector('.vault-tab.vdrag'); if (!e) return null; const r = e.getBoundingClientRect(); return r.left + r.width / 2`);
    tdrift.push(r == null ? 999 : Math.abs(r - x));
  }
  await touch('touchEnd'); await sleep(400);
  ok(Math.max.apply(null, tdrift) < 6, 'tab stays under the finger', tdrift.map(Math.round));
  ok((await evalJs(c, `(window.__tabOrderSaved || []).slice(0, 2).join(',')`)) === 'passwords,links', 'touch drop reorders + saves');
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  ok(!errors.length, 'no uncaught page errors', errors);
  console.log('\n  ' + passed + ' passed, ' + failed + ' failed');
  console.log('  screenshots: ' + require('path').dirname(shotPath('x')));
  c.ws.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
