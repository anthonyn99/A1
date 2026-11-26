// TradeHub Quant refinements R9 (A1-Priv docs/TradeHub/quant/r1-09.md): Control's
// sub-tabs, the popup audit (the calendar first, the Alerts popup rebuilt), A1's
// resize grip on the text boxes, the thicker Neo Quant and mic buttons, and the
// Notebook Trash's "Restore selected" hover, in the real page, quant-api played here.
//
// Run: node tests/live/tradehub-quant-control-r9.live.js   (own CDP_PORT)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const DESK_W = 1280 + 224;

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Network.enable'); await c.send('Network.clearBrowserCache');   // the shared profile's cache has been seen corrupt
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot, tab } = driver(c);
  const shown = () => js(`return [...document.querySelectorAll('[data-ctl-pane]')].filter(function(p){ return !p.hidden && p.offsetParent; }).map(function(p){ return p.dataset.ctlPane; }).join(',');`);
  const click = async (sel) => { const r = JSON.parse(await js(`var e=document.querySelector('${sel}'); if(!e) return 'null'; e.scrollIntoView({block:'center'}); var b=e.getBoundingClientRect(); return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2});`)); if (!r) return false; await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y }); await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 }); return true; };

  console.log('\n1. Control\'s sub-tabs');
  await size(DESK_W, 900);
  await boot({ quant: true });
  await tab('prompt');
  ok('six sub-tabs: Watchlists, Prompts, Quant, Neo Quant, Neo Cortex, Alerts (Rules went in TR7, Neo Cortex came in N6)', await until(`[...document.querySelectorAll('[data-ctl-sub]')].map(function(b){return b.textContent;}).join('|') === 'Watchlists|Prompts|Quant|Neo Quant|Neo Cortex|Alerts'`, 10000),
    await js(`return [...document.querySelectorAll('[data-ctl-sub]')].map(function(b){return b.textContent;}).join('|');`));
  ok('...Watchlists first, only its section shown', (await shown()) === 'watchlists', await shown());
  for (const [id, want] of [['prompts', 'prompts'], ['quant', 'quant'], ['neo', 'neo'], ['cortex', 'cortex'], ['alerts', 'alerts']]) {
    await js(`document.querySelector('[data-ctl-sub="${id}"]').click(); 1`); await sleep(250);
    ok(`"${id}" shows only its section, its tab pressed`, (await shown()) === want && await js(`return document.querySelector('[data-ctl-sub="${id}"]').getAttribute('aria-selected') === 'true';`), await shown());
  }
  ok('Quant: the switch and the data status together', await js(`var p=document.querySelector('[data-ctl-pane="quant"]'); return !!p.querySelector('.ctl-quant') && !!p.querySelector('.ctl-status');`));
  await js(`document.querySelector('[data-ctl-sub="neo"]').click(); 1`); await sleep(300);
  ok('Neo Quant: voice and memory side by side on a wide screen', await js(`var p=document.querySelector('[data-ctl-pane="neo"]'), v=p.querySelector('.ctl-voice').getBoundingClientRect(), m=p.querySelector('.ctl-memory').getBoundingClientRect(); return Math.abs(v.top - m.top) < 2 && m.left > v.right;`));
  await js(`document.querySelector('[data-ctl-sub="alerts"]').click(); 1`); await sleep(300);
  ok('Alerts: its sections in two columns on a wide screen', await js(`var c=document.querySelector('[data-ctl-pane="alerts"] .tal-card'); return getComputedStyle(c).gridTemplateColumns.split(' ').length === 2;`), await js(`return getComputedStyle(document.querySelector('[data-ctl-pane="alerts"] .tal-card')).gridTemplateColumns;`));
  await sleep(300);
  await boot({ keep: true }); await tab('prompt');
  ok('the last sub-tab is remembered after a reload', await until(`document.querySelector('[data-ctl-sub="alerts"]') && document.querySelector('[data-ctl-sub="alerts"]').getAttribute('aria-selected') === 'true'`, 10000) && (await shown()) === 'alerts', await shown());
  await tab('market'); await sleep(500);
  await js(`window.tbControlShow('cortex'); 1`); await tab('prompt');
  ok('tbControlShow (the bell, Neo Quant) opens a section from another tab', await until(`(function(){ var b=document.querySelector('[data-ctl-sub="cortex"]'); return b && b.getAttribute('aria-selected') === 'true'; })()`, 8000));
  const said = JSON.parse(await js(`var R=(await import('/A1/TradeHub/neo/registry.js')).Registry; return JSON.stringify(await R.get('control').actions.section.run({ name: 'neo' }));`));
  ok('Neo Quant: "open Control\'s voice settings" (control.section neo)', await until(`document.querySelector('[data-ctl-sub="neo"]').getAttribute('aria-selected') === 'true'`, 5000) && /neo/.test(said.shown || ''), JSON.stringify(said));
  await js(`document.querySelector('[data-ctl-sub="watchlists"]').click(); 1`); await sleep(400);
  ok('no stray "null" in Watchlists (a missing child used to print as text)', await js(`return !/\\bnull\\b/.test(document.querySelector('[data-ctl-pane="watchlists"]').innerText);`));

  console.log('\n2. Popups');
  await js(`var i=document.createElement('input'); i.type='date'; i.value='2026-11-19'; i.id='r9cal'; i.style.cssText='position:fixed;left:300px;top:140px;z-index:5'; document.querySelector('#tradeboard-root').append(i); 1`); await sleep(500);
  const trig = await js(`var e=document.getElementById('r9cal'); var t=e.nextElementSibling && /a1c-trig/.test(e.nextElementSibling.className) ? e.nextElementSibling : null; if(t) t.id='r9caltrig'; return !!t;`);
  if (trig) await click('#r9caltrig');
  ok('the calendar: padded inside (nothing touches its edge)', await until(`(function(){ var p=document.querySelector('.a1c-pop.a1c-cal.on'); return p && parseFloat(getComputedStyle(p).paddingLeft) >= 8 && parseFloat(getComputedStyle(p).paddingTop) >= 8; })()`, 4000),
    await js(`var p=document.querySelector('.a1c-pop.a1c-cal'); return p ? getComputedStyle(p).padding : 'no calendar (trigger ' + ${JSON.stringify(trig)} + ')';`));
  ok('...Clear and Today are bordered buttons', await js(`var l=[...document.querySelectorAll('.a1c-pop.a1c-cal .a1c-link')]; return l.length >= 2 && l.every(function(b){ var c=getComputedStyle(b).borderTopColor; return c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'; });`));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1`); await sleep(200);
  await js(`document.getElementById('r9cal').remove(); var t=document.getElementById('r9caltrig'); if(t) t.remove(); 1`);
  await js(`document.querySelector('[data-tal-bell]').click(); 1`);
  ok('the Alerts popup (C3: the notification center): a centred card, its head padded', await until(`(function(){ var b=document.querySelector('[data-tal-list]'); if(!b) return false; var r=b.getBoundingClientRect(); var hd=b.querySelector('.tac-head'); return hd && parseFloat(getComputedStyle(hd).paddingLeft) >= 16 && Math.abs((r.top + r.bottom) / 2 - innerHeight / 2) < 80 && r.top > 16; })()`, 4000),
    await js(`var b=document.querySelector('[data-tal-list]'); return b ? getComputedStyle(b).padding + ' ' + JSON.stringify(b.getBoundingClientRect()) : 'no popup';`));
  ok('...A1\'s backdrop (dim and blur)', await js(`var s=document.querySelector('.tal-scrim'); var cs=getComputedStyle(s); return /blur/.test(cs.backdropFilter || cs.webkitBackdropFilter || '') && /rgba\\(0, 0, 0, 0\\.6\\)/.test(cs.backgroundColor);`));
  ok('...an empty state that says what to do, with a bordered button', await js(`var e=document.querySelector('[data-tal-empty]'); var b=e && e.querySelector('[data-tal-empty-settings]'); return !!e && /No alerts yet/.test(e.innerText) && !!b && getComputedStyle(b).borderTopStyle === 'solid';`));
  await js(`document.querySelector('[data-tal-empty-settings]').click(); 1`);
  ok('...its button opens Control ▸ Alerts', await until(`!document.querySelector('[data-tal-list]') && document.querySelector('[data-ctl-sub="alerts"]') && document.querySelector('[data-ctl-sub="alerts"]').getAttribute('aria-selected') === 'true'`, 6000));

  console.log('\n3. Text boxes, buttons, Notebook');
  await js(`document.querySelector('[data-nq-launch]').click(); 1`);
  ok('Neo Quant\'s question box has A1\'s resize grip', await until(`(function(){ var g=document.querySelector('.nq-compose .a1-grip-wrap > .a1-grip'); return g && !!document.querySelector('.nq-compose .a1-grip-wrap > [data-nq-input]'); })()`, 6000));
  await js(`var x=document.querySelector('[data-nq-close]'); if(x) x.click(); 1`); await sleep(300);
  ok('the Neo Quant and mic buttons: heavier strokes and a 2 px border', await js(`var l=document.querySelector('[data-nq-launch]'), m=document.querySelector('[data-nq-mic]'); var ring=l.querySelector('svg circle'), mp=m.querySelector('svg path'); return parseFloat(getComputedStyle(l).borderTopWidth) === 2 && parseFloat(getComputedStyle(m).borderTopWidth) === 2 && parseFloat(getComputedStyle(ring).strokeWidth) >= 4.4 && parseFloat(getComputedStyle(mp).strokeWidth) >= 2.2;`),
    await js(`var l=document.querySelector('[data-nq-launch]'); return getComputedStyle(l).borderTopWidth + ' ' + getComputedStyle(l.querySelector('svg circle')).strokeWidth;`));
  const nb = await js(`var r=await fetch('/A1/Notebook/notebook.css'); return await r.text();`);
  ok('Notebook (both sides): the primary button, Trash\'s "Restore selected" included, has a hover and a press', /\.docx-btn\.pri:not\(:disabled\):hover \{ filter: brightness\(1\.1\)/.test(nb) && /\.docx-btn\.pri:not\(:disabled\):active \{[^}]*translateY\(1px\)/.test(nb));

  console.log('\n4. Phone, and Quant off');
  await size(390, 844); await sleep(900); await tab('prompt'); await sleep(600);
  ok('390 px: the sub-tabs scroll sideways inside their row; the page does not', await js(`var s=document.querySelector('.ctl-subs'); return s.scrollWidth > s.clientWidth && getComputedStyle(s).overflowX === 'auto' && document.documentElement.scrollWidth <= innerWidth + 1;`));
  ok('390 px: each sub-tab is big enough for a finger (32 px)', await js(`return [...document.querySelectorAll('[data-ctl-sub]')].every(function(b){ return b.getBoundingClientRect().height >= 32; });`));
  await size(DESK_W, 900);
  await boot({ quant: false }); await tab('prompt');
  ok('Quant off: Watchlists, Prompts, Quant and Alerts (no Neo Quant, no Neo Cortex)', await until(`[...document.querySelectorAll('[data-ctl-sub]')].map(function(b){return b.textContent;}).join('|') === 'Watchlists|Prompts|Quant|Alerts'`, 10000),
    await js(`return [...document.querySelectorAll('[data-ctl-sub]')].map(function(b){return b.textContent;}).join('|');`));

  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
