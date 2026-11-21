// TradeHub Quant Batch 2, B9 (Tony's pick 2026-11-20: option B's answer, option A's lighter grey, option C's sidebar):
//   the conversation sidebar collapses fully and expands from its button, remembered after a reload; an × on a
//   conversation asks first, deletes, and Undo brings it back (ask 22); Recent conversations on the Neo Quant tab too.
//
// Run: CDP_PORT=93xx node tests/live/tradehub-quant-neo-b9.live.js
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};
(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const { js, until, size, boot, tab } = driver(c);
  const D = `document.querySelector('[data-nq-dock]')`;
  const openDock = async () => { await js(`if(${D}.hidden) document.querySelector('[data-nq-launch]').click(); 1`); await until(`!${D}.hidden && ${D}.querySelector('[data-nq-side-btn]')`, 8000); await sleep(400); };

  await size(1504, 900);
  await boot({ quant: true }); await tab('market');
  await openDock();
  ok('the dock has the conversation sidebar, open on a desktop, with New conversation', await js(`var s=${D}.querySelector('[data-nq-side]'); return !!s && !s.hidden && !!s.querySelector('[data-nq-newconv]');`));
  const w0 = Number(await js(`return ${D}.getBoundingClientRect().width;`));
  await js(`${D}.querySelector('[data-nq-side-btn]').click(); 1`); await sleep(400);
  const shut = JSON.parse(await js(`return JSON.stringify({hidden: ${D}.querySelector('[data-nq-side]').hidden, w: ${D}.getBoundingClientRect().width, exp: ${D}.querySelector('[data-nq-side-btn]').getAttribute('aria-expanded')});`));
  ok('its button collapses it fully (the dock narrows back)', shut.hidden && shut.exp === 'false' && shut.w < w0 - 100, JSON.stringify({ w0, shut }));
  await boot({ quant: true }); await tab('market'); await openDock();
  ok('...and it stays collapsed after a reload', await js(`return ${D}.querySelector('[data-nq-side]').hidden;`));
  await js(`${D}.querySelector('[data-nq-side-btn]').click(); 1`); await sleep(400);
  ok('the same button brings it back', await js(`return !${D}.querySelector('[data-nq-side]').hidden;`));

  // A conversation the mock's history holds: x, confirm, Undo.
  const has = await until(`${D}.querySelector('[data-nq-crow]')`, 8000);
  ok('the sidebar lists the conversations by day', has, await js(`return ${D}.querySelector('[data-nq-side]').innerText.slice(0,200);`));
  if (has) {
    const id = await js(`return ${D}.querySelector('[data-nq-crow]').getAttribute('data-nq-crow');`);
    const dels = () => api.asked.filter((a) => a.p && a.p.indexOf('/history/') === 0 && a.m === 'DELETE').length;
    const d0 = dels();
    await js(`${D}.querySelector('[data-nq-crow="${id}"] [data-nq-del]').click(); 1`); await sleep(200);
    ok('× asks first ("Delete …?" with Cancel and Delete)', await js(`var r=${D}.querySelector('[data-nq-crow="${id}"]'); return r.classList.contains('is-asking') && !!r.querySelector('[data-nq-del-yes]') && !!r.querySelector('[data-nq-del-no]');`));
    await js(`${D}.querySelector('[data-nq-crow="${id}"] [data-nq-del-yes]').click(); 1`); await sleep(300);
    ok('Delete takes the row away and offers Undo', await js(`return !${D}.querySelector('[data-nq-crow="${id}"]') && !!document.querySelector('[data-nq-undo-del="${id}"] [data-nq-undo-btn]');`));
    await js(`document.querySelector('[data-nq-undo-del="${id}"] [data-nq-undo-btn]').click(); 1`); await sleep(300);
    ok('Undo brings it back, and nothing was deleted at the worker', await js(`return !!${D}.querySelector('[data-nq-crow="${id}"]');`) && dels() === d0, dels() - d0);
  }
  ok('no page errors', !errs.length, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
