// TradeHub Quant Batch 2, B7's last asks (A1-Priv docs/TradeHub/quant/r2-07.md):
//   [11] an × on every text box: shown with text, one press clears it (React's state too) and the focus stays;
//        a box with its own clear button (the Journal's search) shows only that one.
//   [7]  Neo Quant opens ABOVE its launchers; they stay where they were; the same Halo closes it (1280, 820, 390).
//   [8]  the page's content and A1's scrollbar end above the launchers.
//
// Run: CDP_PORT=93xx node tests/live/tradehub-quant-chrome-b7.live.js
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot, tab } = driver(c);
  const rect = async (sel) => JSON.parse(await js(`var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'null'; var r=e.getBoundingClientRect(); return JSON.stringify({l:r.left,t:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height});`));
  const xBtn = () => rect('[data-tb-clearbox-x].is-on');
  const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
  const typeInto = async (sel, text) => {
    await js(`var e=document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({block:'center'}); e.focus(); 1`);
    await sleep(150);
    await c.send('Input.insertText', { text });
    await sleep(250);
  };

  await size(1504, 900);
  await boot({ quant: true });
  await until(`window.__tbClearbox || document.querySelector('[data-tb-clearbox-x]')`, 15000);

  console.log('\n[11] the × on every text box');
  // A React box: Analysis's one-off prompt is a controlled textarea, so a clear React did not hear snaps back.
  await tab('analysis');
  const ana = 'textarea.ana-quick';
  if (await until(`document.querySelector('${ana}')`, 15000)) {
    await js(`var e=document.querySelector('${ana}'); var d=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value'); d.set.call(e,''); e.dispatchEvent(new Event('input',{bubbles:true})); 1`);
    await sleep(200);
    ok('an empty box shows no ×', !(await xBtn()));
    await typeInto(ana, 'NVDA earnings');
    const x = await xBtn(), box = await rect(ana);
    ok('typing shows the × at the box\'s right end, inside it', x && x.r <= box.r && x.r >= box.r - 32 && x.t >= box.t && x.b <= box.b, JSON.stringify({ x, box }));
    if (x) await click(x.l + x.w / 2, x.t + x.h / 2);
    await sleep(500);
    const after = JSON.parse(await js(`var e=document.querySelector('${ana}'); return JSON.stringify({v:e.value, focus: document.activeElement===e});`));
    ok('one press clears it and React keeps it clear (a controlled box)', after.v === '', JSON.stringify(after));
    ok('...the focus stays in the box', after.focus);
    ok('...and the × goes away', !(await xBtn()));
  } else ok('Analysis prompt box found', false);

  // Notebook (the Playbook) is Notebook's own: a host never touches its boxes.
  await tab('playbook');
  if (await until(`[...document.querySelectorAll('[data-notebook-side] input')].some(function(e){return e.getBoundingClientRect().width>0;})`, 15000)) {
    const nbSel = await js(`var e=[...document.querySelectorAll('[data-notebook-side] input')].find(function(e){return e.getBoundingClientRect().width>0;}); e.setAttribute('data-test-nb',''); return '[data-test-nb]';`);
    await typeInto(nbSel, 'test');
    ok('Notebook\'s boxes (the Playbook) get no ×', !(await xBtn()) && !(await js(`return document.querySelector('${nbSel}').hasAttribute('data-tb-clearbox');`)));
    await js(`var e=document.querySelector('${nbSel}'); var d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value'); d.set.call(e,''); e.dispatchEvent(new Event('input',{bubbles:true})); e.removeAttribute('data-test-nb'); 1`);
  } else ok('Playbook box found', false);

  // The Journal's search has its own ×: no second one.
  await tab('journal');
  if (await until(`document.querySelector('.tbj-search input')`, 15000)) {
    await typeInto('.tbj-search input', 'MU');
    ok('a box with its own clear button (the Journal\'s search) shows only that one', !(await xBtn()) && await js(`return !!document.querySelector('.tbj-search button[aria-label="Clear search"]');`));
    await js(`var b=document.querySelector('.tbj-search button[aria-label="Clear search"]'); b && b.click(); 1`);
  } else ok('Journal search found', false);

  // Neo Quant's composer (a textarea, plain DOM): the × at its top right.
  await tab('market');
  await js(`var d=document.querySelector('[data-nq-dock]'); if(d.hidden) document.querySelector('[data-nq-launch]').click(); 1`);
  await until(`!document.querySelector('[data-nq-dock]').hidden && document.querySelector('[data-nq-dock] [data-nq-input]')`, 8000);
  await sleep(500);
  await typeInto('[data-nq-dock] [data-nq-input]', 'Is NVDA a buy here?');
  const nx = await xBtn(), nb = await rect('[data-nq-dock] [data-nq-input]');
  ok('Neo Quant\'s composer shows the × at its top right', nx && nx.r <= nb.r && nx.t >= nb.t && nx.t <= nb.t + 12, JSON.stringify({ nx, nb }));
  if (nx) await click(nx.l + nx.w / 2, nx.t + nx.h / 2);
  await sleep(300);
  ok('...one press clears it, the focus stays', await js(`var e=document.querySelector('[data-nq-dock] [data-nq-input]'); return e.value==='' && document.activeElement===e;`));
  await js(`document.querySelector('[data-nq-close]').click(); 1`); await sleep(600);

  console.log('\n[7] [8] the launchers');
  for (const [w, h] of [[1504, 900], [820, 1100], [390, 844]]) {
    await size(w, h);
    await sleep(600);
    await tab('market'); await sleep(500);
    if (!(await js(`return !document.querySelector('[data-nq-dock]').hidden;`)) === false) { await js(`document.querySelector('[data-nq-close]').click(); 1`); await sleep(700); }
    const L0 = await rect('[data-nq-launch]'), M0 = await rect('[data-nq-mic]');
    await click(L0.l + L0.w / 2, L0.t + L0.h / 2);
    await until(`!document.querySelector('[data-nq-dock]').hidden`, 4000); await sleep(900);
    const L1 = await rect('[data-nq-launch]'), M1 = await rect('[data-nq-mic]'), D = await rect('[data-nq-dock]');
    const same = (a, b) => a && b && Math.abs(a.l - b.l) < 1 && Math.abs(a.t - b.t) < 1;
    ok(`${w} px: opening leaves the Halo and the mic exactly where they were, showing`, same(L0, L1) && same(M0, M1) && L1.w > 0 && M1.w > 0, JSON.stringify({ L0, L1, M0, M1 }));
    ok(`${w} px: the dock sits above them (its bottom over the launchers' top)`, D && D.b <= Math.min(L1.t, M1.t) - 4, JSON.stringify({ D, L1 }));
    const top = await js(`var r=document.querySelector('[data-nq-launch]').getBoundingClientRect(); var e=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return !!(e && e.closest('[data-nq-launch]'));`);
    ok(`${w} px: the Halo is in front (nothing covers it, not even the backdrop)`, top);
    await click(L1.l + L1.w / 2, L1.t + L1.h / 2);
    ok(`${w} px: the same Halo closes it`, await until(`document.querySelector('[data-nq-dock]').hidden`, 3000));
    await sleep(500);
    // [8] the page ends above the launchers: its bottom padding covers their footprint, and A1's bar stops above them.
    const pad = Number(await js(`return parseFloat(getComputedStyle(document.querySelector('#tradeboard-root .tb-scroll-visible')).paddingBottom);`));
    const vh = Number(await js(`return innerHeight;`));
    ok(`${w} px: the page can scroll its content clear of the launchers (bottom room ${pad} px)`, pad >= vh - L1.t - 2, `${pad} < ${vh - L1.t}`);
    await js(`var s=document.querySelector('#tradeboard-root .tb-scroll-visible'); s.scrollTop = 200; s.dispatchEvent(new Event('scroll')); 1`);
    await sleep(400);
    const rail = JSON.parse(await js(`var best=null; document.querySelectorAll('.vc-rail.v').forEach(function(r){ var b=r.getBoundingClientRect(); if(b.height>0 && b.right > innerWidth-40 && (!best || b.height>best.h)) best={t:b.top,b:b.bottom,h:b.height}; }); return JSON.stringify(best);`));
    ok(`${w} px: A1's page scrollbar ends above the launchers`, rail && rail.b <= L1.t - 4, JSON.stringify({ rail, launcherTop: L1.t }));
  }
  ok('no page errors', !errs.length, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
