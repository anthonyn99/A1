// LIVE test -- the real console against the real engine (not run by run-all.js).
// Run: node tests/live/magi-units.live.js   Screenshots: %TEMP%/magi-live-shots
//
// MAGI Phase U3: the Units sheet's limits. Sends NO question. Checks:
//   1. /api/units/usage feeds every chip; a limited/near/fallback/signed-out
//      unit carries its dot, and its tooltip is the sheet's line
//   2. the sheet: one row per unit, each with a state line, a Check now, a
//      "checked" line; a limited unit says "Limited until <time> (in …)" when
//      the engine has a reset time; Claude (Pro) shows Code Mode's bars
//   3. Check now on ONE unit (CHECK=deepseek by default; a real headless
//      browser, nothing sent, ~20-40s): the row says Checking…, then
//      "checked just now"
//   4. choosing a chairman from the sheet still works (and is put back)
//   5. at 390px the rows fit and the page does not scroll sideways
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');

const URL = require('./cdp.js').PAGES_URL;
const CHECK = process.env.CHECK === undefined ? 'deepseek' : process.env.CHECK;
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
const ROW = (id) => `document.querySelector('.unit-lim[data-unit="${id}"]')`;

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
  ok('the units verdict loads at boot', await waitFor(c, 'Object.keys(UNITS_USE.byId).length === S.providers.length && S.providers.length > 0', 30000));
  const states = await evalJs(c, 'JSON.stringify(Object.fromEntries(Object.values(UNITS_USE.byId).map(u => [u.id, u.state])))');
  console.log('  states ' + states);

  // -- 1. chips -------------------------------------------------------------
  const dots = await evalJs(c, `return JSON.stringify([...document.querySelectorAll("#unitChips .chip")].map(b => {
    const u = UNITS_USE.byId[b.dataset.unit]; const d = b.querySelector(".chip-lim");
    return { id: b.dataset.unit, want: !!(u && CHIP_LIM[u.state]), has: !!d, title: b.title, line: u ? unitLimLine(u) : "" };
  }));`);
  const dl = JSON.parse(dots);
  ok('a dot on exactly the units that need one', dl.every((x) => x.want === x.has), JSON.stringify(dl.filter((x) => x.has).map((x) => x.id)));
  ok("a dotted chip's tooltip is the sheet's line", dl.filter((x) => x.has).every((x) => x.title.endsWith(x.line)));

  // -- 2. the sheet ---------------------------------------------------------
  await evalJs(c, 'openChairPicker(); return 1;');
  ok('the Units sheet opens with a row per unit', await waitFor(c, `document.querySelectorAll(".unit-row").length === S.providers.length`, 5000));
  const rows = await evalJs(c, `return JSON.stringify([...document.querySelectorAll(".unit-lim[data-unit]")].map(b => ({
    id: b.dataset.unit, state: (b.querySelector(".unit-lim-state") || {}).textContent || "",
    check: !!b.querySelector(".unit-lim-check"), seen: [...b.querySelectorAll(".unit-lim-sub")].map(x => x.textContent).join(" / ") })));`);
  const rl = JSON.parse(rows);
  ok('every row has a state line and a Check now', rl.every((r) => r.state && r.check));
  ok('every row says when it was last checked', rl.every((r) => /checked/i.test(r.seen)));
  for (const u of Object.values(JSON.parse(await evalJs(c, 'JSON.stringify(UNITS_USE.byId)')))) {
    const r = rl.find((x) => x.id === u.id);
    if (u.state === 'limited' && u.limit && u.limit.resets_at && Date.parse(u.limit.resets_at) > Date.now()) {
      ok(`${u.id}: "Limited until <time> (in …)"`, /^Limited until .+\(in .+\)$/.test(r.state), r.state);
    }
  }
  const pro = await evalJs(c, `return (() => { const u = UNITS_USE.byId["claude-pro"]; if (!u || !u.account) return "none";
    return document.querySelectorAll('.unit-lim[data-unit="claude-pro"] .unit-lim-bar').length + "|" + Object.keys(u.account.windows).length; })()`);
  if (pro !== 'none') {
    const [bars, wins] = pro.split('|');
    ok("Claude (Pro) shows Code Mode's usage bars", +bars > 0 && bars === wins, pro);
  } else console.log('  (no Pro account in Code Mode on this engine: no bars to check)');
  await shot(c, 'units-sheet');

  // -- 3. Check now ---------------------------------------------------------
  if (CHECK) {
    const before = await evalJs(c, `JSON.stringify(UNITS_USE.byId[${JSON.stringify(CHECK)}] || null)`);
    await evalJs(c, `${ROW(CHECK)}.querySelector(".unit-lim-check").click(); return 1;`);
    ok('Check now says Checking…', await waitFor(c, `${ROW(CHECK)}.querySelector(".unit-lim-check").textContent.includes("Checking")`, 3000));
    const t0 = Date.now();
    ok('the check lands', await waitFor(c, `!UNITS_USE.checking.has(${JSON.stringify(CHECK)})`, 120000), `${Math.round((Date.now() - t0) / 1000)}s`);
    const after = JSON.parse(await evalJs(c, `JSON.stringify(UNITS_USE.byId[${JSON.stringify(CHECK)}])`));
    const err = await evalJs(c, `UNITS_USE.err[${JSON.stringify(CHECK)}] || ""`);
    ok('it was kept as a check', !!after.checked_at && (!before || after.checked_at !== JSON.parse(before).checked_at), err || after.checked_at);
    const line = await evalJs(c, `${ROW(CHECK)}.textContent`);
    ok('the row says "checked just now"', /checked just now/.test(line), line.slice(0, 160));
    console.log(`  ${CHECK} after the check: ${after.state} (${after.headline}) model=${after.model || '-'}`);
    await shot(c, 'units-checked');
  }

  // -- 4. the chair still works --------------------------------------------
  const chair = await evalJs(c, 'CHAIR.id');
  const other = await evalJs(c, `(S.providers.find(p => p.id !== CHAIR.id) || {}).id`);
  await evalJs(c, `[...document.querySelectorAll(".unit-row")].find(r => r.querySelector('.unit-lim[data-unit="${other}"]')).querySelector(".chair-pick").click(); return 1;`);
  ok('picking a chairman from the sheet works and closes it', await waitFor(c, `CHAIR.id === "${other}" && !CHAIR.busy && !document.querySelector(".unit-row")`, 10000));
  await evalJs(c, `setChair("${chair}"); return 1;`);
  ok('the chair is put back', await waitFor(c, `CHAIR.id === "${chair}" && !CHAIR.busy`, 10000));

  // -- 5. phone -------------------------------------------------------------
  await size(c, 390, 844, true);
  await sleep(300);
  await evalJs(c, 'openChairPicker(); return 1;');
  await waitFor(c, 'document.querySelectorAll(".unit-row").length > 0', 5000);
  await sleep(300);
  const fits = await evalJs(c, `return [...document.querySelectorAll(".unit-row")].every(r => {
    const b = r.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth + 1 && r.scrollWidth <= r.clientWidth + 1; })`);
  ok('at 390px every row fits', fits);
  ok('no horizontal page scroll at 390px', await evalJs(c, 'document.documentElement.scrollWidth <= innerWidth + 1'));
  await shot(c, 'units-phone');
  await evalJs(c, 'document.querySelector(".sheet").remove(); return 1;');
  // The chips live on the council screen; this browser may remember Code Mode.
  await evalJs(c, 'setMode("deliberation"); return 1;');
  await sleep(400);
  ok('the chips are on screen', await evalJs(c, 'document.querySelector("#unitChips .chip").getBoundingClientRect().width > 0'));
  const chipsFit = await evalJs(c, 'document.querySelector("#unitChips").scrollWidth <= document.querySelector("#unitChips").clientWidth + 1');
  ok('the chips with dots still fit at 390px', chipsFit);
  await shot(c, 'units-chips-phone');

  ok('no uncaught exceptions', !errs.length, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
