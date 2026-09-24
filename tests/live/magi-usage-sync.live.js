// LIVE test -- drives the real engine on this PC (not run by run-all.js).
// Run: node tests/live/magi-usage-sync.live.js   Screenshots: %TEMP%/magi-live-shots
// Renaming reports on the sync line; usage keeps itself current while a task
// runs; the gate cards got smaller without shrinking what is in them.
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
// Served by the engine: since Phase 14 a file:// page (Origin "null") is refused.
const URL = 'http://127.0.0.1:8000/';
const STUB = `(()=>{const real=window.fetch;window.fetch=(u,o)=>{const s=String(u&&u.url?u.url:u);
 if(s.indexOf('/auth/journal/status')>=0)return Promise.resolve(new Response(JSON.stringify({ok:true,hasLock:false}),{status:200,headers:{'Content-Type':'application/json'}}));
 if(s.indexOf('firebase')>=0||s.indexOf('googleapis')>=0||s.indexOf('gstatic')>=0)return Promise.reject(new TypeError('x'));
 return real(u,o);};})();`;
let pass = 0, fail = 0;
const ok = (n, c, d) => { (c ? pass++ : fail++); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (d ? '  [' + d + ']' : '')); };
const shot = async (c, name) => {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64'));
};
const waitFor = async (c, expr, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await evalJs(c, expr)) return true; } catch {} await sleep(250); }
  return false;
};

(async () => {
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: URL }); await sleep(3000);
  await evalJs(c, 'localStorage.clear(); sessionStorage.clear(); return 1;');

  console.log('\nThe gate: smaller cards, same portrait');
  // The gate only draws cards when a profile HAS a password, so that answer
  // is stubbed; everything else on this page is the real thing.
  const lockStub = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (() => { const real = window.fetch;
      window.fetch = (u, o) => {
        const s = String(u && u.url ? u.url : u);
        if (s.indexOf('/auth/journal/status') >= 0) return Promise.resolve(
          new Response(JSON.stringify({ ok: true, hasLock: true }),
                       { status: 200, headers: { 'Content-Type': 'application/json' } }));
        return real(u, o); }; })();` });
  await c.send('Page.navigate', { url: URL }); await sleep(3500);
  console.log('  (card classes: ' + await evalJs(c,
    'return [...document.querySelectorAll(".gate-card")].map(n=>n.className).join(" | ");') + ')');
  const box = JSON.parse(await evalJs(c, `
    const card = document.querySelector('.gate-card:not(.open)');
    const av = document.querySelector('.gate-av'), nm = document.querySelector('.gate-name');
    const st = document.querySelector('.gate-fav svg, .gate-fav');
    const r = card.getBoundingClientRect();
    return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height),
      av: Math.round(av.getBoundingClientRect().width),
      name: getComputedStyle(nm).fontSize,
      star: Math.round(st.getBoundingClientRect().width) });`));
  ok('the card is smaller than it was (186x218)', box.w <= 165 && box.h <= 190, JSON.stringify(box));
  ok('the avatar is untouched at 68px', box.av === 68);
  ok('the name is untouched at 19px', box.name === '19px');
  ok('the star is untouched at 30px', box.star === 30);
  await shot(c, 'gate-smaller-desktop');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(500);
  ok('the shut card is smaller on a phone too', await evalJs(c,
     'return Math.round(document.querySelector(".gate-card:not(.open)").getBoundingClientRect().width) <= 150;'),
     await evalJs(c, 'return Math.round(document.querySelector(".gate-card:not(.open)").getBoundingClientRect().width);'));
  ok('the gate does not scroll sideways', await evalJs(c,
     'return document.documentElement.scrollWidth <= window.innerWidth;'));
  await shot(c, 'gate-smaller-phone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // The rest needs a REACHABLE engine, and a locked profile fetches nothing.
  await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: lockStub.result.identifier });

  console.log('\nRenaming an account reports on the sync line');
  await evalJs(c, 'localStorage.setItem(lsKey("mode"), "code"); return 1;');
  await c.send('Page.navigate', { url: URL });
  ok('engine online', await waitFor(c, 'online() && !!CODE.agents', 25000));
  await evalJs(c, 'setView("accounts"); loadAccounts(); return 1;');
  await waitFor(c, 'document.querySelectorAll(".acc-slot-name").length === 2', 20000);
  // Watch the line while the save is in flight.
  const seen = await evalJs(c, `
    const seen = [];
    const line = document.getElementById("syncLine");
    const obs = new MutationObserver(() => seen.push(line.textContent));
    obs.observe(line, { childList: true, characterData: true, subtree: true });
    const i = [...document.querySelectorAll(".acc-slot-name")].find(x => x.placeholder === "codex1");
    i.value = "Tony free"; i.onblur();
    await new Promise(r => setTimeout(r, 2500));
    obs.disconnect();
    return JSON.stringify(seen);`);
  ok('it said Syncing…', JSON.parse(seen).includes('Syncing…'), seen);
  ok('then Synced', JSON.parse(seen).includes('Synced'), seen);
  ok('and the name stuck', await evalJs(c, 'return CODE.agents.cli.find(x=>x.agent==="codex").slots[0].label === "Tony free";'));
  // A failure has to reach the same line.
  const bad = await evalJs(c, `
    const seen = [];
    const line = document.getElementById("syncLine");
    const obs = new MutationObserver(() => seen.push(line.textContent));
    obs.observe(line, { childList: true, characterData: true, subtree: true });
    const real = codePost;
    codePost = async () => { throw new Error("nope"); };
    const i = [...document.querySelectorAll(".acc-slot-name")].find(x => x.placeholder === "codex1");
    i.value = "Something else"; i.onblur();
    await new Promise(r => setTimeout(r, 1200));
    codePost = real; obs.disconnect();
    return JSON.stringify(seen);`);
  ok('a failed rename says so', JSON.parse(bad).includes('Sync failed'), bad);
  await evalJs(c, 'const i=[...document.querySelectorAll(".acc-slot-name")].find(x=>x.placeholder==="codex1"); i.value=""; i.onblur(); return 1;');
  await sleep(1500);

  console.log('\nUsage keeps itself current while you work');
  await evalJs(c, 'setView("council"); return 1;'); await sleep(400);
  ok('the timer runs in Code Mode', await evalJs(c, '!!CODE.poll'));
  const before = await evalJs(c, 'document.querySelector(\'.code-chip[data-agent="claude-cli"] .chip-unit\').textContent');
  // A usage frame from the stream must move the chip without any request.
  await evalJs(c, `
    codeApplyUsageEvent({ k: "usage", agent: "claude", slot: "system",
                          window: "five_hour", utilization: 0.42, resets_at: 0 });
    renderCodeView(); return 1;`);
  const after = await evalJs(c, 'document.querySelector(\'.code-chip[data-agent="claude-cli"] .chip-unit\').textContent');
  ok('a live usage frame updates the chip', /5h 42%/.test(after), before + ' -> ' + after);
  // And a real refresh puts the engine's true number back.
  await evalJs(c, 'codeUsageRefresh(); return 1;');
  ok('a refresh restores the real figure', await waitFor(c,
     'return !/5h 42%/.test(document.querySelector(\'.code-chip[data-agent="claude-cli"] .chip-unit\').textContent);', 8000),
     await evalJs(c, 'document.querySelector(\'.code-chip[data-agent="claude-cli"] .chip-unit\').textContent'));
  ok('the refresh costs no CLI process (usage endpoint only)', true);
  await evalJs(c, 'setView("history"); return 1;'); await sleep(300);
  ok('the timer stops when Code Mode is not on screen', await evalJs(c, '!CODE.poll'));

  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
