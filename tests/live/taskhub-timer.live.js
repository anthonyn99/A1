// The TaskHub timer (function Pomodoro in index.html, shared by both TaskHubs).
//
//   1. Tony: opens in his MAGI colors, Inter tabular numbers
//   2. Veda: her header button is the clock icon (no "Timer" text) and the
//      panel wears her own palette
//   3. mouse drag moves it, the spot is saved per profile and survives a reload;
//      a plain click on a button does not drag; double-click sends it home
//   4. phone width: a finger drags it, and it stays inside the viewport
//   5. Start / Pause still drive the timer
//   6. the new chime is louder than the old one (rendered offline, no speakers)
//
// Run: node tests/live/taskhub-timer.live.js
'use strict';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const ORIGIN = 'https://anthonyn99.github.io';
const J = async (c, js) => JSON.parse(await evalJs(c, `return JSON.stringify((() => { ${js} })());`));
const box = (c) => J(c, "const b=document.querySelector('.a1-timer'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height};");
const timerBtn = "[...document.querySelectorAll('button[title=\"Timer\"]')].find(b=>b.offsetParent)";

async function load(c, who, w, h, mobile, keepStorage) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  if (!keepStorage) {
    await c.send('Page.navigate', { url: ORIGIN + '/A1/oneinbox.html' }); await sleep(800);
    await evalJs(c, `localStorage.clear(); localStorage.setItem('td6_mainDash','${who}'); 1`);
  }
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  await sleep(9000);
  await evalJs(c, "var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
}
async function openTimer(c) {
  await evalJs(c, `const b=${timerBtn}; b && b.click(); 1`);
  await sleep(500);
}
async function mouseDrag(c, x, y, dx, dy, steps = 14) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx * i / steps, y: y + dy * i / steps, button: 'left', buttons: 1 });
    await sleep(16);
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
  await sleep(300);
}
async function touchDrag(c, x, y, dx, dy, steps = 14) {
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / steps, y: y + dy * i / steps }] });
    await sleep(16);
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
}

// The chime as it was before 2026-10-13, with its context injected so it can
// render offline. Kept here only as the loudness baseline.
const OLD_ALARM = `function(ctx){const notes=[523.25,659.25,783.99,659.25,783.99,1046.5,783.99,1046.5,783.99,659.25];const dur=0.45,gap=0.05;notes.forEach((freq,i)=>{const osc=ctx.createOscillator();const gain=ctx.createGain();const t=ctx.currentTime+i*(dur+gap);osc.type="sine";osc.frequency.setValueAtTime(freq,t);const osc2=ctx.createOscillator();osc2.type="triangle";osc2.frequency.setValueAtTime(freq*2,t);const g2=ctx.createGain();g2.gain.setValueAtTime(0.08,t);osc2.connect(g2);g2.connect(ctx.destination);osc2.start(t);osc2.stop(t+dur);gain.gain.setValueAtTime(0,t);gain.gain.linearRampToValueAtTime(0.18,t+0.05);gain.gain.setValueAtTime(0.18,t+dur*0.6);gain.gain.linearRampToValueAtTime(0,t+dur);osc.connect(gain);gain.connect(ctx.destination);osc.start(t);osc.stop(t+dur);});}`;

(async () => {
  const c = await connect();
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });

  console.log('\nTony, desktop');
  await load(c, 'tony', 1440, 900, false);
  await openTimer(c);
  let b = await box(c);
  ok('timer opens', !!b);
  ok('starts bottom-right', b && Math.abs(1440 - (b.x + b.w) - 22) <= 2 && Math.abs(900 - (b.y + b.h) - 22) <= 2, JSON.stringify(b));
  const tLook = await J(c, "const r=document.querySelector('.a1-timer'); const p=r.querySelector('button[aria-label=Start]'); const n=[...r.querySelectorAll('div')].find(d=>/^\\d\\d:\\d\\d$/.test(d.textContent)); const cs=getComputedStyle(n); return {bg:getComputedStyle(p).backgroundColor, font:cs.fontFamily, num:cs.fontVariantNumeric, fx:!!r.querySelector('[data-hoverfx=magi]')};");
  ok("Tony's Start is MAGI purple #c0aeea", tLook.bg === 'rgb(192, 174, 234)', tLook.bg);
  ok("Tony's numbers are Inter tabular", /Inter/.test(tLook.font) && /tabular/.test(tLook.num), JSON.stringify(tLook));
  ok("Tony's buttons carry MAGI hover fx", tLook.fx);
  await c.send('Page.captureScreenshot', { format: 'png' }).then(r => require('fs').writeFileSync(shotPath('timer-tony'), Buffer.from(r.result.data, 'base64')));

  // Drag from the header (not a button) up and left.
  await mouseDrag(c, b.x + 120, b.y + 20, -600, -400);
  let b2 = await box(c);
  ok('mouse drag moves it', b2 && Math.abs(b2.x - (b.x - 600)) <= 3 && Math.abs(b2.y - (b.y - 400)) <= 3, JSON.stringify({ b, b2 }));
  ok('spot saved for tony', await J(c, "return !!localStorage.getItem('a1_timer_pos_tony') && !localStorage.getItem('a1_timer_pos_veda');"));
  // A click on Start must start, not drag.
  const before = await box(c);
  await evalJs(c, "document.querySelector('.a1-timer button[aria-label=Start]').click(); 1");
  await sleep(1600);
  const st = await J(c, "const r=document.querySelector('.a1-timer'); return {t:r.textContent, pause:!!r.querySelector('button[aria-label=Pause]')};");
  ok('Start runs the timer', st.pause && /Focusing/.test(st.t) && /24:5\d/.test(st.t), st.t);
  ok('clicking a button does not move it', JSON.stringify(await box(c)) === JSON.stringify(before));
  await evalJs(c, "document.querySelector('.a1-timer button[aria-label=Pause]').click(); 1");
  await sleep(300);
  ok('Pause pauses', await J(c, "return /Paused/.test(document.querySelector('.a1-timer').textContent);"));
  // Drag past the edge: it stays inside.
  b = await box(c);
  await mouseDrag(c, b.x + 120, b.y + 20, -2000, -2000);
  b2 = await box(c);
  ok('cannot be dragged off-screen', b2.x >= 6 && b2.y >= 6 && b2.x <= 8 && b2.y <= 8, JSON.stringify(b2));

  // Reload: the spot comes back.
  await load(c, 'tony', 1440, 900, false, true);
  await openTimer(c);
  b = await box(c);
  ok('position survives a reload', b && b.x <= 8 && b.y <= 8, JSON.stringify(b));
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x + 120, y: b.y + 20 });
  for (const n of [1, 2]) {
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x + 120, y: b.y + 20, button: 'left', clickCount: n });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x + 120, y: b.y + 20, button: 'left', clickCount: n });
  }
  await sleep(300);
  b = await box(c);
  ok('double-click sends it home', b && Math.abs(1440 - (b.x + b.w) - 22) <= 2, JSON.stringify(b));

  console.log('\nVeda, desktop');
  await load(c, 'veda', 1440, 900, false);
  const vBtn = await J(c, `const b=${timerBtn}; return b ? {txt:b.textContent.trim(), svg:!!b.querySelector('svg')} : null;`);
  ok('Veda\'s header button is the clock icon, no text', vBtn && vBtn.svg && vBtn.txt === '', JSON.stringify(vBtn));
  await openTimer(c);
  const vLook = await J(c, "const r=document.querySelector('.a1-timer'); if(!r) return null; const p=r.querySelector('button[aria-label=Start]'); const n=[...r.querySelectorAll('div')].find(d=>/^\\d\\d:\\d\\d$/.test(d.textContent)); return {bg:getComputedStyle(p).backgroundColor, card:getComputedStyle(r).backgroundColor, font:getComputedStyle(n).fontFamily};");
  ok("Veda's Start is her mauve #8D769A", vLook && vLook.bg === 'rgb(141, 118, 154)', JSON.stringify(vLook));
  ok("Veda's card is her S1 #26272A", vLook && vLook.card === 'rgb(38, 39, 42)', vLook && vLook.card);
  ok("Veda's numbers are IBM Plex Mono", vLook && /Plex Mono/.test(vLook.font), vLook && vLook.font);
  await c.send('Page.captureScreenshot', { format: 'png' }).then(r => require('fs').writeFileSync(shotPath('timer-veda'), Buffer.from(r.result.data, 'base64')));
  ok('voice hook still wired', await J(c, "return typeof window._vdTimerExec === 'function';"));
  await evalJs(c, "window._vdTimerExec('set', '10'); 1"); await sleep(300);
  ok('voice "set 10" sets 10:00', await J(c, "return /10:00/.test(document.querySelector('.a1-timer').textContent);"));

  console.log('\nVeda, phone');
  await load(c, 'veda', 390, 844, true);
  await openTimer(c);
  b = await box(c);
  ok('fits the phone', b && b.x >= 6 && b.x + b.w <= 384, JSON.stringify(b));
  await touchDrag(c, b.x + 140, b.y + 20, -40, -300);
  b2 = await box(c);
  ok('finger drag moves it', b2 && Math.abs(b2.y - (b.y - 300)) <= 3, JSON.stringify({ b, b2 }));
  await c.send('Page.captureScreenshot', { format: 'png' }).then(r => require('fs').writeFileSync(shotPath('timer-veda-phone'), Buffer.from(r.result.data, 'base64')));

  console.log('\nSound');
  const lvl = await J(c, `
    window.__lv = null;
    (async () => {
      const meas = async (fn, secs) => {
        const ctx = new OfflineAudioContext(1, 44100 * secs, 44100);
        fn(ctx);
        const d = (await ctx.startRendering()).getChannelData(0);
        let peak = 0, sum = 0; for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
        // loudest 300ms window RMS
        const W = 13230; let best = 0;
        for (let s = 0; s + W < d.length; s += 2205) { let q = 0; for (let i = s; i < s + W; i++) q += d[i] * d[i]; best = Math.max(best, Math.sqrt(q / W)); }
        return { peak, rms: best };
      };
      const oldA = await meas(${OLD_ALARM}, 6);
      const newA = await meas((ctx) => playAlarm(ctx), 7);
      window.__lv = { oldA, newA };
    })();
    return 1;`);
  await sleep(4000);
  const lv = await J(c, 'return window.__lv;');
  console.log('       ' + JSON.stringify(lv));
  ok('new chime is louder than the old (300ms RMS)', lv && lv.newA.rms > lv.oldA.rms * 1.15, JSON.stringify(lv));
  ok('…but only somewhat (under 1.7x)', lv && lv.newA.rms < lv.oldA.rms * 1.7, JSON.stringify(lv));
  ok('no clipping', lv && lv.newA.peak < 1, JSON.stringify(lv));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
