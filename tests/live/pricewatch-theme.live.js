// LIVE test -- the PriceWatch extension popup in MAGI's theme (theme overhaul
// phase 11), in a real headless browser over CDP (not run by run-all.js).
// chrome.* is stubbed, so it needs no extension install and touches nothing.
// Run: node tests/live/pricewatch-theme.live.js   Screenshots: %TEMP%/magi-live-shots
//
//   tokens and fonts (Inter UI, Manrope titles), the wordmark solid (no
//   gradient text), MAGI's .btn (10px / 700 / uppercase, bdl outline), the
//   switch and select in purple, numbers Inter 500 tabular (the log's times
//   were mono), hoverfx magi (lift + press), no gold and no gradient anywhere.
'use strict';
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');

const POPUP = 'https://anthonyn99.github.io/A1/PriceWatch/popup.html';

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '  [' + JSON.stringify(d).slice(0, 200) + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + JSON.stringify(d).slice(0, 300) + ']' : '')); }
};
const shot = async (c, name) => {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64'));
};

const STUB = `
  if (location.pathname.endsWith('/PriceWatch/popup.html')) {
    var now = Date.now();
    var STATE = { ok: true, domains: ['walmart.com', 'amazon.com', 'cvs.com', 'walgreens.com'],
      cfg: { minIntervalHours: 3, autoEveryMin: 240, autoEnabled: true },
      log: [{ at: now - 125000, msg: 'Checked 12 item(s) at walmart.com' }, { at: now - 7400000, msg: 'cvs.com in cooldown, cached prices used' }] };
    window.chrome = { runtime: {
      getManifest: function () { return { version: '1.1.0' }; },
      sendMessage: function (m, cb) { setTimeout(function () { cb(m.type === 'PW_GET_STATE' ? STATE : { ok: true, cleared: 2, ran: 3 }); }, 0); } } };
  }`;

(async () => {
  const c = await connect();
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 330, height: 640, deviceScaleFactor: 2, mobile: false });
  await c.send('Page.navigate', { url: POPUP });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) { try { if (await evalJs(c, '!!document.querySelector("#log time")')) break; } catch {} await sleep(200); }
  await evalJs(c, 'return document.fonts.ready.then(() => 1);');

  try {
    const th = JSON.parse(await evalJs(c, `
      const cs = (s) => getComputedStyle(document.querySelector(s));
      const btn = cs('#run'), h1 = cs('h1'), lbl = cs('.lbl'), t = cs('#log time'), body = cs('body');
      return JSON.stringify({
        ac: getComputedStyle(document.documentElement).getPropertyValue('--ac').trim(),
        bg: body.backgroundColor, font: body.fontFamily, num: body.fontVariantNumeric,
        selNum: cs('select').fontVariantNumeric,
        h1: { c: h1.color, f: h1.fontFamily, bg: h1.backgroundImage, fill: h1.webkitTextFillColor },
        lbl: { c: lbl.color, f: lbl.fontFamily, w: lbl.fontWeight, tt: lbl.textTransform },
        btn: { fs: btn.fontSize, fw: btn.fontWeight, tt: btn.textTransform, ls: btn.letterSpacing, bd: btn.borderTopColor, r: btn.borderTopLeftRadius, bg: btn.backgroundColor },
        time: { f: t.fontFamily, w: t.fontWeight, n: t.fontVariantNumeric },
        sw: getComputedStyle(document.querySelector('.sw i'), '::before').backgroundColor,
        swBd: cs('.sw i').borderTopColor,
        hover: document.body.getAttribute('data-hoverfx'),
      });`));
    ok('tokens: MAGI purple accent on #1a1a1d', th.ac === '#c0aeea' && th.bg === 'rgb(26, 26, 29)', th);
    ok('UI face is Inter', /^'?Inter/.test(th.font) || /^Inter/.test(th.font), th.font);
    ok('the wordmark is Manrope in acl, solid (no gradient text)',
       /Manrope/.test(th.h1.f) && th.h1.c === 'rgb(219, 208, 245)' && th.h1.bg === 'none' && th.h1.fill === 'rgb(219, 208, 245)', th.h1);
    ok('panel titles: Manrope 800 uppercase in acl', /Manrope/.test(th.lbl.f) && th.lbl.w === '800' && th.lbl.tt === 'uppercase' && th.lbl.c === 'rgb(219, 208, 245)', th.lbl);
    ok('buttons are MAGI\'s .btn: 10px / 700 / uppercase / 1px, bdl outline, radius 6',
       th.btn.fs === '10px' && th.btn.fw === '700' && th.btn.tt === 'uppercase' && th.btn.ls === '1px' && th.btn.bd === 'rgb(69, 69, 76)' && th.btn.r === '6px' && th.btn.bg === 'rgba(0, 0, 0, 0)', th.btn);
    ok('the switch, on, is a purple outline with a solid purple knob', th.sw === 'rgb(192, 174, 234)' && th.swBd === 'rgb(192, 174, 234)', th);
    ok('numbers: body and controls tabular', th.num === 'tabular-nums' && th.selNum === 'tabular-nums', th);
    ok('the log\'s times are Inter 500 tabular, not mono', /Inter/.test(th.time.f) && !/mono/i.test(th.time.f) && th.time.w === '500' && th.time.n === 'tabular-nums', th.time);
    ok('hover mechanics: <body data-hoverfx="magi">', th.hover === 'magi');

    const scan = JSON.parse(await evalJs(c, `
      const gold = /224, 184, 116|212, 166, 89|237, 200, 132|176, 141, 74|200, 180, 137/;
      const bad = [];
      for (const n of document.querySelectorAll('*')) {
        const s = getComputedStyle(n);
        for (const p of ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'backgroundImage', 'boxShadow'])
          if (gold.test(s[p]) || /gradient/.test(s[p])) bad.push(n.tagName + '.' + n.className + ' ' + p + '=' + s[p]);
      }
      return JSON.stringify(bad);`));
    ok('no gold and no gradient anywhere', scan.length === 0, scan);

    // hoverfx: hover lift, accent outline, press.
    const r = JSON.parse(await evalJs(c, 'const b = document.getElementById("clear").getBoundingClientRect(); return JSON.stringify({x: b.left + b.width / 2, y: b.top + b.height / 2});'));
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    await sleep(250);
    const hv = JSON.parse(await evalJs(c, 'const b = document.getElementById("clear"); return JSON.stringify({f: b.style.filter, bd: getComputedStyle(b).borderTopColor});'));
    ok('hover: brightness(1.15) and the outline turns purple', /brightness\(1\.15\)/.test(hv.f) && hv.bd === 'rgb(192, 174, 234)', hv);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(60);
    const pr = JSON.parse(await evalJs(c, 'const b = document.getElementById("clear"); return JSON.stringify({f: b.style.filter, t: b.style.translate});'));
    ok('press: brightness(.94) and 1px down', /brightness\(0?\.94\)/.test(pr.f) && /1px/.test(pr.t), pr);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    ok('the button still works (Clear cooldowns -> Cleared 2)', await (async () => { for (let i = 0; i < 20; i++) { if (/Cleared 2/.test(await evalJs(c, 'document.getElementById("clear").textContent'))) return true; await sleep(100); } return false; })());
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await sleep(200);
    await shot(c, 'pricewatch-popup');
    ok('fits 330px (no horizontal scroll)', await evalJs(c, 'document.documentElement.scrollWidth <= 330'));
  } catch (e) {
    fail++;
    console.log('  FAIL  crashed: ' + (e.stack || e));
  } finally {
    ok('no page errors', errs.length === 0, errs);
    try { c.close && c.close(); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
