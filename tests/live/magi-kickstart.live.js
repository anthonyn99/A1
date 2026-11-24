// LIVE test -- the real console against the real engine (not run by run-all.js).
// Run: node tests/live/magi-kickstart.live.js   Screenshots: %TEMP%/magi-live-shots
// VERIFY_ONLY=1 uses a read-only snapshot from the engine and mocks button responses.
//
// The daily Claude (Pro) kickstart section in the Units sheet. Sends nothing
// unless RUN=1 (then one ~670-token Haiku message through "Send now").
//   1. Claude (Pro) has a switch, a status line and Send now, alongside Codex when signed in
//   2. Not before / the weekly cap / the message save to the engine and come back
//   3. switching it off folds the options away; on brings them back
//   4. at 390px it fits: no sideways scroll, 36px+ fields
// Every setting is put back as it was.
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');

const URL = require('./cdp.js').PAGES_URL;
const API = 'http://127.0.0.1:8000/api/units/claude-pro/kickstart';
const VERIFY_ONLY = process.env.VERIFY_ONLY === '1';
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
const BOX = `document.querySelector('.unit-kick[data-unit="claude-pro"]')`;
const enginePanels = async () => {
  const r = await fetch('http://127.0.0.1:8000/api/units/usage');
  const d = await r.json();
  return Object.fromEntries(d.units.filter((u) => u.kickstart).map((u) => [u.id, u.kickstart]));
};
const engineCfg = async () => (await enginePanels())['claude-pro'];
const setField = (sel, value) => `(() => { const i = ${BOX}.querySelector(${JSON.stringify(sel)});
  i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event("change")); return 1; })()`;

(async () => {
  const panels = await enginePanels();
  const before = panels['claude-pro'];
  if (!before) { console.log('  no kickstart on this engine (no Claude Pro account in Code Mode)'); process.exit(1); }
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
  if (VERIFY_ONLY) {
    if (!(await waitFor(c, 'typeof openChairPicker === "function"', 10000))) throw new Error('MAGI console did not load');
    await evalJs(c, `
      const sample = ${JSON.stringify(panels)};
      const actual = window.fetch;
      const origin = 'https://kickstart.example.test';
      window.kickRequests = [];
      window.fetch = (url, init) => {
        if (!String(url).startsWith(origin)) return actual(url, init);
        const path = new URL(url).pathname;
        window.kickRequests.push(path);
        const reply = (data) => Promise.resolve(new Response(JSON.stringify(data)));
        if (path === '/api/units/usage')
          return reply({ units: Object.keys(sample).map(id => ({ id, state: 'ready', kickstart: sample[id] })) });
        if (path === '/api/units/chatgpt/kickstart/run') {
          sample.chatgpt.state = {status:'sent', sent_at:Date.now()/1000};
          return reply({ kickstart: sample.chatgpt });
        }
        return Promise.resolve(new Response('{}', {status:404}));
      };
      link.api = origin; link.where = 'local';
      S.providers = Object.keys(sample).map(id => ({id, display_name:id === 'chatgpt' ? 'ChatGPT' : 'Claude (Pro)'}));
      await loadUnitsUsage(); return 1;`);
  }
  ok('engine online', await waitFor(c, 'online()', 30000));
  ok('the units verdict loads', await waitFor(c, '!!(UNITS_USE.byId["claude-pro"] && UNITS_USE.byId["claude-pro"].kickstart)', 30000));

  // -- 1. where it is --------------------------------------------------------
  await evalJs(c, 'openChairPicker(); return 1;');
  ok('the Units sheet opens', await waitFor(c, `document.querySelectorAll(".unit-row").length === S.providers.length`, 5000));
  const where = await evalJs(c, `JSON.stringify([...document.querySelectorAll(".unit-kick")].filter(b => b.children.length).map(b => b.dataset.unit))`);
  ok('kickstart panels match the signed-in Code Mode accounts',
    JSON.stringify(JSON.parse(where).sort()) === JSON.stringify(Object.keys(panels).sort()), where);
  if (panels.chatgpt) {
    ok('Codex is under ChatGPT with Claude’s start time', await evalJs(c, `
      return document.querySelector('.unit-kick[data-unit="chatgpt"] .kick-title').textContent === 'Codex daily kickstart' &&
        UNITS_USE.byId.chatgpt.kickstart.not_before === UNITS_USE.byId['claude-pro'].kickstart.not_before;`));
  }
  const parts = await evalJs(c, `return JSON.stringify({ sw: !!${BOX}.querySelector(".kick-sw input"), st: (${BOX}.querySelector(".kick-st")||{}).textContent,
    now: (${BOX}.querySelector(".unit-lim-check")||{}).textContent })`);
  const p = JSON.parse(parts);
  ok('switch, status line and Send now', p.sw && !!p.st && p.now === 'Send now', p.st);
  await evalJs(c, `${BOX}.scrollIntoView(); return 1;`);
  await shot(c, 'kick-desktop');

  if (VERIFY_ONLY) {
    if (panels.chatgpt) {
      await evalJs(c, `document.querySelector('.unit-kick[data-unit="chatgpt"] .unit-lim-check').click(); return 1;`);
      ok('Codex Send now uses the Codex route and shows its result', await waitFor(c, `
        return window.kickRequests.includes('/api/units/chatgpt/kickstart/run') &&
          document.querySelector('.unit-kick[data-unit="chatgpt"] .kick-st').textContent.startsWith('Sent ');`, 3000));
    }
    await size(c, 390, 844, true);
    await sleep(400);
    ok('at 390px the kickstart panels fit inside the sheet', await evalJs(c, `
      return [...document.querySelectorAll('.unit-kick')].filter(b => b.children.length).every(b =>
        b.getBoundingClientRect().right <= b.closest('.sheet-box').getBoundingClientRect().right + 1) &&
        document.documentElement.scrollWidth <= innerWidth + 1;`));
    ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  // -- 2. settings save ------------------------------------------------------
  if (!before.enabled) {
    await evalJs(c, `(() => { const i = ${BOX}.querySelector(".kick-sw input"); i.checked = true; i.dispatchEvent(new Event("change")); return 1; })()`);
    await waitFor(c, `!!${BOX}.querySelector(".kick-opts")`, 10000);
  }
  await evalJs(c, setField('.kick-time', '07:45'));
  ok('Not before saves', await waitFor(c, `UNITS_USE.byId["claude-pro"].kickstart.not_before === "07:45"`, 10000));
  await evalJs(c, setField('input[type=range]', '65'));
  ok('the weekly cap saves', await waitFor(c, `UNITS_USE.byId["claude-pro"].kickstart.week_cap === 65`, 10000));
  await evalJs(c, setField('.kick-msg input', 'ok'));
  ok('the message saves', await waitFor(c, `UNITS_USE.byId["claude-pro"].kickstart.message === "ok"`, 10000));
  await evalJs(c, setField('.kick-msg input', '   '));
  await sleep(800);
  ok('an empty message is put back, not saved', (await engineCfg()).message === 'ok'
     && await evalJs(c, `${BOX}.querySelector(".kick-msg input").value === "ok"`));
  const eng = await engineCfg();
  ok('the engine holds all three', eng.not_before === '07:45' && eng.week_cap === 65 && eng.message === 'ok',
     JSON.stringify({ nb: eng.not_before, cap: eng.week_cap, msg: eng.message }));
  ok('the slider shows its value', await evalJs(c, `${BOX}.querySelector(".use-val").textContent === "65%"`));

  // -- 3. off / on -----------------------------------------------------------
  await evalJs(c, `(() => { const i = ${BOX}.querySelector(".kick-sw input"); i.checked = false; i.dispatchEvent(new Event("change")); return 1; })()`);
  ok('off folds the options away and says Off', await waitFor(c,
    `!${BOX}.querySelector(".kick-opts") && ${BOX}.querySelector(".kick-st").textContent === "Off"`, 10000));
  ok('the engine has it off', (await engineCfg()).enabled === false);
  await evalJs(c, `(() => { const i = ${BOX}.querySelector(".kick-sw input"); i.checked = true; i.dispatchEvent(new Event("change")); return 1; })()`);
  ok('on brings them back', await waitFor(c, `!!${BOX}.querySelector(".kick-opts")`, 10000));

  if (process.env.RUN === '1') {
    await evalJs(c, `${BOX}.querySelector(".unit-lim-check").click(); return 1;`);
    ok('Send now lands', await waitFor(c, '!UNITS_KICK["claude-pro"].busy', 120000));
    const st = await evalJs(c, `${BOX}.querySelector(".kick-st").textContent`);
    ok('it says Sent', /^Sent /.test(st), st);
  }

  // -- 4. phone --------------------------------------------------------------
  await size(c, 390, 844, true);
  await sleep(400);
  await evalJs(c, `${BOX}.scrollIntoView(); return 1;`);
  const fit = JSON.parse(await evalJs(c, `return JSON.stringify({
    doc: document.documentElement.scrollWidth, vw: innerWidth,
    box: Math.round(${BOX}.getBoundingClientRect().right),
    sheet: Math.round(${BOX}.closest(".sheet-box").getBoundingClientRect().right),
    field: Math.round(${BOX}.querySelector(".kick-time").getBoundingClientRect().height),
    msg: Math.round(${BOX}.querySelector(".kick-msg input").getBoundingClientRect().height) })`));
  ok('no sideways scroll at 390px', fit.doc <= fit.vw, JSON.stringify(fit));
  ok('the section stays inside the sheet', fit.box <= fit.sheet + 1);
  ok('fields are 36px tall on a phone', fit.field >= 36 && fit.msg >= 36);
  await shot(c, 'kick-phone');

  // -- put everything back ---------------------------------------------------
  await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: before.enabled, not_before: before.not_before,
                           week_cap: before.week_cap, message: before.message }) });
  const back = await engineCfg();
  ok('settings put back', back.enabled === before.enabled && back.not_before === before.not_before
     && back.week_cap === before.week_cap && back.message === before.message);
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
