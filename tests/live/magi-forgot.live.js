// MAGI's "Forgot password?" used to mail BOTH the hint and a reset code on one
// click. It now opens two buttons, and each asks the lock service for only its
// own email. Drives the real lock screen headless for Tony and Veda, with the
// lock service mocked, and checks which endpoints each button called.
//
// Run: node tests/live/magi-forgot.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const ORIGIN = 'https://anthonyn99.github.io';

(async () => {
  let calls = [];
  const mock = {
    patterns: ['https://taskhub-reminders.av1.workers.dev/*'],
    handle: (req) => {
      const path = new URL(req.url).pathname;
      if (/\/auth\/journal\/status/.test(path)) return { status: 200, json: { ok: true, hasLock: true, noLock: false, ver: 'vvvvvvvvvvvvvvvv' } };
      if (req.method === 'OPTIONS') return { status: 200, text: '' };
      calls.push(path);
      return { status: 200, json: { ok: true, emailed: true } };
    },
  };
  const m = await connect({ mock });
  await m.send('Page.enable');

  for (const profile of ['tony', 'veda']) {
    console.log('\nmagi.html — ' + profile);
    const q = profile === 'tony' ? '' : '?profile=veda';
    await m.send('Page.navigate', { url: ORIGIN + '/A1/magi.html?blank' }); await sleep(800);
    await evalJs(m, `localStorage.clear(); sessionStorage.clear(); return 1;`);
    await m.send('Page.navigate', { url: ORIGIN + '/A1/magi.html' + q }); await sleep(4000);

    const shown = JSON.parse(await evalJs(m, `var s = document.getElementById('lockScreen');
      var f = [...document.querySelectorAll('.lock-link')].find(b => /Forgot/.test(b.textContent));
      return JSON.stringify({ locked: !!s && !s.hidden, forgot: !!f,
        hintBtn: !!document.getElementById('lockHintBtn'), visible: getComputedStyle(document.querySelector('.lock-forgot')).display });`));
    ok('locked, with a Forgot button', shown.locked && shown.forgot, JSON.stringify(shown));
    ok('the two choices start hidden', shown.hintBtn && shown.visible === 'none', JSON.stringify(shown));

    calls = [];
    await evalJs(m, `[...document.querySelectorAll('.lock-link')].find(b => /Forgot/.test(b.textContent)).click(); return 1;`);
    const opened = JSON.parse(await evalJs(m, `return JSON.stringify({ visible: getComputedStyle(document.querySelector('.lock-forgot')).display });`));
    ok('Forgot opens the two choices and sends nothing', opened.visible !== 'none' && calls.length === 0, JSON.stringify({ opened, calls }));

    await evalJs(m, `document.getElementById('lockHintBtn').click(); return 1;`); await sleep(800);
    const afterHint = JSON.parse(await evalJs(m, `return JSON.stringify({ msg: document.getElementById('lockMsg').textContent, code: !!document.getElementById('lockCode') });`));
    ok('"Email my hint" calls only /hint', calls.length === 1 && /\/auth\/journal\/hint$/.test(calls[0]), JSON.stringify(calls));
    ok('says the hint was emailed and stays on unlock', /Hint emailed/.test(afterHint.msg) && !afterHint.code, JSON.stringify(afterHint));

    calls = [];
    await evalJs(m, `document.getElementById('lockResetBtn').click(); return 1;`); await sleep(800);
    const afterReset = JSON.parse(await evalJs(m, `return JSON.stringify({ msg: document.getElementById('lockMsg').textContent, code: !!document.getElementById('lockCode') });`));
    ok('"Reset password" calls only /reset/request', calls.length === 1 && /\/auth\/reset\/request$/.test(calls[0]), JSON.stringify(calls));
    ok('opens the reset-code form', afterReset.code && /Reset code emailed/.test(afterReset.msg), JSON.stringify(afterReset));
  }
  m.ws.close();

  console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' checks');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
