// LIVE test -- the real console against the real engine (not run by run-all.js).
// Run: node tests/live/magi-model-pick.live.js   Screenshots: %TEMP%/magi-live-shots
//
// MAGI Phase U4: choosing each unit's model in the Units sheet. Sends NO
// question (a live run with non-default models is done by hand; see
// docs/magi-plan.md "Phase U4"). Checks:
//   1. every unit's /api/units/usage entry says whether it has a picker; the
//      sheet shows a Model dropdown on exactly those (Claude, Claude (Pro),
//      Gemini, Grok) and a "no picker" line on the rest
//   2. "Site default" is the first option; locked models are shown, disabled
//   3. choosing a model saves it on the engine (read back through the API),
//      and choosing Site default clears it -- the unit is put back as found
//   4. the 30-second limits redraw never replaces the dropdown
//   5. Refresh models on ONE unit (REFRESH=gemini by default; a real
//      headless browser, nothing sent, ~15 s): "Reading…", then "List read
//      from your account just now"
//   6. at 390px the rows fit and the page does not scroll sideways
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
const http = require('http');

const URL = require('./cdp.js').PAGES_URL;
const REFRESH = process.env.REFRESH === undefined ? 'gemini' : process.env.REFRESH;
const PICK = process.env.PICK || 'claude';
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
// The engine itself, not through the page: what it really stored.
const engine = (id) => new Promise((res, rej) => {
  http.get(`http://127.0.0.1:8000/api/units/${id}/models`, (r) => {
    let b = ''; r.on('data', (x) => (b += x)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const BOX = (id) => `document.querySelector('.unit-pick[data-unit="${id}"]')`;

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
  ok('engine online', await waitFor(c, 'online()', 30000));
  ok('the units list loads with picker facts', await waitFor(c,
    'S.providers.length > 0 && S.providers.every(p => UNITS_USE.byId[p.id] && UNITS_USE.byId[p.id].pickable !== undefined)', 30000));
  const was = await engine(PICK);

  // -- 1. dropdowns on exactly the units with a picker ------------------------
  await evalJs(c, 'openChairPicker(); return 1;');
  ok('the Units sheet opens', await waitFor(c, 'document.querySelectorAll(".unit-pick[data-unit]").length === S.providers.length', 5000));
  const boxes = JSON.parse(await evalJs(c, `return JSON.stringify([...document.querySelectorAll(".unit-pick[data-unit]")].map(b => ({
    id: b.dataset.unit, pickable: UNITS_USE.byId[b.dataset.unit].pickable, sel: !!b.querySelector("select"),
    text: b.textContent })));`));
  ok('a dropdown on every unit with a picker, none on the others', boxes.every((b) => b.sel === b.pickable),
    boxes.filter((b) => b.sel).map((b) => b.id).join(','));
  ok('the others say they answer on their default', boxes.filter((b) => !b.pickable).every((b) => /answers on its default/.test(b.text)));
  const pickable = boxes.filter((b) => b.sel).map((b) => b.id).sort().join(',');
  ok('Claude, Claude (Pro), Gemini and Grok are the pickable ones',
    boxes.filter((b) => b.sel).every((b) => ['claude', 'claude-pro', 'gemini', 'grok'].includes(b.id)), pickable);

  // -- 2. Site default first, locked shown but disabled -------------------------
  const opts = JSON.parse(await evalJs(c, `return JSON.stringify([...${BOX(PICK)}.querySelectorAll("option")].map(o => ({ t: o.textContent, v: o.value, d: o.disabled, s: o.selected })));`));
  ok('"Site default" is the first option', opts[0].t === 'Site default' && opts[0].v === '');
  ok('the selected option is what the engine has', (was.pick && (was.pick.id || was.pick.name))
    ? opts.find((o) => o.s).v === (was.pick.id || was.pick.name) : opts[0].s);
  const locked = opts.filter((o) => /locked/.test(o.t));
  if (locked.length) ok('locked models are listed and cannot be chosen', locked.every((o) => o.d), locked.map((o) => o.t).join('; '));
  else console.log('  (no locked models in this unit\'s list)');
  await shot(c, 'pick-sheet');

  // -- 3. choose, read back from the engine, put back ---------------------------
  const target = opts.find((o) => o.v && !o.d && !o.s);
  await evalJs(c, `const s = ${BOX(PICK)}.querySelector("select"); s.value = ${JSON.stringify(target.v)}; s.dispatchEvent(new Event("change")); return 1;`);
  ok('choosing a model saves it', await waitFor(c, `!UNITS_PICK.busy.has(${JSON.stringify(PICK)}) && (UNITS_USE.byId[${JSON.stringify(PICK)}].pick || {}).name === ${JSON.stringify(target.t)}`, 10000), target.t);
  const saved = await engine(PICK);
  ok('the engine has it', saved.pick && saved.pick.name === target.t, JSON.stringify(saved.pick));
  ok('the row says what will be asked for', await evalJs(c, `${BOX(PICK)}.textContent.includes("Asked for ${target.t}")`));
  ok('and the dropdown shows it', await evalJs(c, `${BOX(PICK)}.querySelector("select").value === ${JSON.stringify(target.v)}`));
  await shot(c, 'pick-chosen');
  // -- 4. the limits redraw leaves the dropdown alone ---------------------------
  const same = await evalJs(c, `return (() => { const s = ${BOX(PICK)}.querySelector("select"); s.focus(); refreshUnitSheet(); return s.isConnected; })()`);
  ok('the 30-second limits redraw does not replace the dropdown', same);
  await evalJs(c, `const s = ${BOX(PICK)}.querySelector("select"); s.value = ""; s.dispatchEvent(new Event("change")); return 1;`);
  ok('Site default clears it', await waitFor(c, `!UNITS_PICK.busy.has(${JSON.stringify(PICK)}) && !pickKey(UNITS_USE.byId[${JSON.stringify(PICK)}].pick)`, 10000));
  const back = await engine(PICK);
  ok('the engine is back to Site default', !back.pick || !(back.pick.id || back.pick.name), JSON.stringify(back.pick));
  if (was.pick && (was.pick.id || was.pick.name)) {
    // It had a pick before the test: restore it through the API the page uses.
    await evalJs(c, `const s = ${BOX(PICK)}.querySelector("select"); s.value = ${JSON.stringify(was.pick.id || was.pick.name)}; s.dispatchEvent(new Event("change")); return 1;`);
    await waitFor(c, `!UNITS_PICK.busy.has(${JSON.stringify(PICK)})`, 10000);
  }

  // -- 5. Refresh models ---------------------------------------------------------
  if (REFRESH) {
    await evalJs(c, `${BOX(REFRESH)}.querySelector(".unit-lim-check").click(); return 1;`);
    ok('Refresh models says Reading…', await waitFor(c, `${BOX(REFRESH)}.querySelector(".unit-lim-check").textContent.includes("Reading")`, 3000));
    const t0 = Date.now();
    ok('the refresh lands', await waitFor(c, `!UNITS_PICK.busy.has(${JSON.stringify(REFRESH)})`, 120000), `${Math.round((Date.now() - t0) / 1000)}s`);
    const err = await evalJs(c, `UNITS_PICK.err[${JSON.stringify(REFRESH)}] || ""`);
    ok('"List read from your account just now"', await evalJs(c, `${BOX(REFRESH)}.textContent.includes("List read from your account just now")`), err);
    console.log('  ' + REFRESH + ' offers: ' + await evalJs(c, `(UNITS_USE.byId[${JSON.stringify(REFRESH)}].models || []).map(m => m.name + (m.locked ? " (locked)" : "")).join(", ")`));
  }

  // -- 6. phone ------------------------------------------------------------------
  await evalJs(c, 'document.querySelector(".sheet").remove(); return 1;');
  await size(c, 390, 844, true);
  await sleep(300);
  await evalJs(c, 'openChairPicker(); return 1;');
  await waitFor(c, 'document.querySelectorAll(".unit-pick select").length > 0', 5000);
  await sleep(300);
  const fits = await evalJs(c, `return [...document.querySelectorAll(".unit-row")].every(r => {
    const b = r.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth + 1 && r.scrollWidth <= r.clientWidth + 1; })`);
  ok('at 390px every row fits', fits);
  ok('every dropdown sits inside its row', await evalJs(c, `return [...document.querySelectorAll(".unit-pick select")].every(s => {
    const a = s.getBoundingClientRect(), r = s.closest(".unit-row").getBoundingClientRect(); return a.left >= r.left - 1 && a.right <= r.right + 1; })`));
  ok('no horizontal page scroll at 390px', await evalJs(c, 'document.documentElement.scrollWidth <= innerWidth + 1'));
  await evalJs(c, `${BOX(PICK)}.scrollIntoView(); return 1;`);
  await shot(c, 'pick-phone');

  ok('no uncaught exceptions', !errs.length, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
