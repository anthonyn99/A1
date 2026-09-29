// LIVE test -- reads the real engine; writes nothing (every POST is stubbed).
// The usage popup stays until its X: no timer, not Limits, not a refresh;
// per profile; and restored from the cloud copy when storage is blocked.
// Run: node tests/live/magi-usage-popup.live.js
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
const URL = require('./cdp.js').PAGES_URL;
const STUB = `if (window.top === window) (() => {
  const real = window.fetch;
  const json = (d) => Promise.resolve(new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  window.fetch = (u, o) => {
    const s = String(u && u.url ? u.url : u);
    const m = ((o && o.method) || 'GET').toUpperCase();
    if (s.indexOf('/auth/journal/status') >= 0) return json({ ok: true, hasLock: false });
    if (s.indexOf('firebase') >= 0 || s.indexOf('googleapis') >= 0 || s.indexOf('gstatic') >= 0) return Promise.reject(new TypeError('x'));
    // No real alerts may interfere: the engine's list is whatever the test says.
    if (s.indexOf('/api/code/usage') >= 0) return real(u, o).then((r) => r.json()).then((d) => { d.alerts = []; return json(d); });
    if (m !== 'GET') return json({ ok: false });
    return real(u, o);
  };
})();`;

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + d + ']' : '')); } };
const waitFor = async (c, e, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await evalJs(c, e)) return true; } catch {} await sleep(200); } return false; };
const toastText = 'const t = document.querySelector(".usage-toast"); return t ? t.textContent : "";';
const ALERT = (key, level = 'warn') => `{key: "${key}", agent: "claude", slot: "system", label: "system", window: "seven_day", window_label: "weekly", used: 84, cap: 90, resets_at: Date.now()/1000 + 86400*3, level: "${level}"}`;

(async () => {
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await c.send('Page.navigate', { url: URL }); await sleep(2500);
  await evalJs(c, 'localStorage.clear(); sessionStorage.clear(); return 1;');
  await c.send('Page.navigate', { url: URL });
  ok('engine online', await waitFor(c, 'online()', 25000));

  console.log('\nIt stays');
  await evalJs(c, `codeUsageAlerts([${ALERT('t-warn')}, ${ALERT('t-cap', 'capped')}]); return 1;`);
  ok('the most serious shows first', /stopped at your 90% cap/.test(await evalJs(c, toastText)));
  ok('one at a time', await evalJs(c, 'document.querySelectorAll(".usage-toast").length') === 1);
  ok('it says when it resets (seconds read right)', /Resets /.test(await evalJs(c, toastText)), await evalJs(c, toastText));
  await sleep(13500);
  ok('still there after 13 s (the old fade was 12 s)', await evalJs(c, '!!document.querySelector(".usage-toast")'));
  await evalJs(c, 'document.querySelector(".usage-toast-b").click(); return 1;');
  await sleep(600);
  ok('Limits leaves it open', await evalJs(c, '!!document.querySelector(".usage-toast")'));
  await evalJs(c, 'document.querySelectorAll(".sheet").forEach((s) => s.remove()); return 1;');
  ok('not marked seen while open', await evalJs(c, '!usageSeen().includes("t-cap")'));

  console.log('\nIt survives a refresh');
  await c.send('Page.navigate', { url: URL });
  ok('back after reload, before the engine says anything', await waitFor(c, '/stopped at your 90% cap/.test((document.querySelector(".usage-toast")||{}).textContent||"")', 8000));
  ok('even though the engine no longer reports it', await evalJs(c, 'USAGE.last.length') === 0);

  console.log('\nOnly X closes it');
  await evalJs(c, 'document.querySelector(".usage-toast-x").click(); return 1;');
  ok('gone', await waitFor(c, '!document.querySelector(".usage-toast")', 3000));
  await evalJs(c, `codeUsageAlerts([${ALERT('t-warn')}, ${ALERT('t-cap', 'capped')}]); return 1;`);
  ok('the next one shows once the first is closed', await waitFor(c, '/is at 84% of the weekly/.test((document.querySelector(".usage-toast")||{}).textContent||"")', 3000));
  ok('the closed one is not shown again', await evalJs(c, 'document.querySelectorAll(".usage-toast").length') === 1);
  await evalJs(c, 'document.querySelector(".usage-toast-x").click(); return 1;');
  await c.send('Page.navigate', { url: URL });
  await waitFor(c, 'online()', 25000);
  await sleep(1000);
  ok('closed stays closed after a reload', await evalJs(c, '!document.querySelector(".usage-toast")'));

  console.log('\nPer profile');
  ok('the keys are profile-scoped', await evalJs(c, 'USAGE_OPEN_KEY === lsKey("usage.open") && /^magi\\.[a-z]+\\.usage\\.open$/.test(USAGE_OPEN_KEY)'), await evalJs(c, 'USAGE_OPEN_KEY'));
  await evalJs(c, `codeUsageAlerts([${ALERT('t-prof')}]); return 1;`);
  const other = await evalJs(c, 'const p = PROFILE.id; return p === "tony" ? "veda" : "tony";');
  ok("the other profile's store is untouched", await evalJs(c, `localStorage.getItem("magi.${other}.usage.open") === null`));
  await evalJs(c, 'document.querySelector(".usage-toast-x").click(); return 1;');

  console.log('\nBlocked storage: the cloud copy brings it back');
  await evalJs(c, 'localStorage.clear(); return 1;');
  await c.send('Page.navigate', { url: URL });
  await waitFor(c, 'online()', 25000);
  ok('nothing on screen with empty storage', await evalJs(c, '!document.querySelector(".usage-toast")'));
  await evalJs(c, `usageFromCloud({ open: [${ALERT('t-cloud', 'limit')}], seen: ["t-cap"] }); return 1;`);
  ok('the cloud copy draws it', /has used its weekly limit/.test(await evalJs(c, toastText)));
  ok('and its closed keys are adopted', await evalJs(c, 'usageSeen().includes("t-cap")'));
  await evalJs(c, `usageFromCloud({ open: [${ALERT('t-cloud', 'limit')}], seen: ["t-cap", "t-cloud"] }); return 1;`);
  ok('closed on another device closes it here', await waitFor(c, '!document.querySelector(".usage-toast")', 3000));
  ok('what reaches the cloud has no undefined', await evalJs(c, `const u = 1; return JSON.stringify(usageClean(${ALERT('z')})).indexOf("undefined") < 0 && !("slot" in usageClean(${ALERT('z')}))`));

  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await evalJs(c, `codeUsageAlerts([${ALERT('t-phone', 'near_cap')}]); return 1;`);
  await sleep(300);
  ok('phone: card fits the screen', await evalJs(c, 'return (() => { const r = document.querySelector(".usage-toast").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()'));
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath('usage-popup-phone'), Buffer.from(r.result.data, 'base64'));
  await evalJs(c, 'document.querySelector(".usage-toast-x").click(); localStorage.clear(); return 1;');

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
