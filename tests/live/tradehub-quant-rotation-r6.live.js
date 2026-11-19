// TradeHub Quant refinements R6 (A1-Priv docs/TradeHub/quant/r1-06.md): the
// redesigned Rotation card and the grouped Macro card in the real page,
// quant-api played here.
//
//   1. Rotation: the sector funds against SPY, 5-day tails by default, worded axes,
//      the ranked list with each name's week move
//   2. the 5 / 10 / 20 switch redraws the tails and is synced (market_prefs.rotTail)
//   3. Semis: its stocks against SOXX once measured; Neo Quant sets the tail
//   4. Macro: next up, four groups each with one line of meaning
//   5. 1280, 820 and 390 px: no sideways scroll, the list stays in its card
//
// Run: node tests/live/tradehub-quant-rotation-r6.live.js   (own CDP_PORT)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const DESK_W = 1280 + 224, TAB_W = 820 + 224;

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
  const R = `document.querySelector('.lay-card[data-card="rotation"]')`;
  const segs = (sym) => js(`var a=${R}.querySelector('.mk-rot-s[data-sym="${sym}"]'); return a ? a.querySelectorAll('.mk-rot-trail').length : -1;`);
  const prefs = () => js(`return JSON.stringify((window.__fakeFs.docs['dashboards/tradehub_layout']||{}).market_prefs||null);`);

  console.log('\n1. Rotation, the S&P 100');
  await size(DESK_W, 900);
  await boot({ quant: true });
  await tab('market');
  ok('the card draws the 12 sector funds against SPY', await until(`${R} && ${R}.querySelectorAll('.mk-rot-s').length === 12 && /sector funds against SPY/.test(${R}.querySelector('[data-mk-rot-of]').innerText)`, 15000),
    await js(`return ${R} ? ${R}.innerText.slice(0, 200) : 'no card';`));
  ok('5-day tails by default (4 segments each), the 5d button pressed', (await segs('XLK')) === 4 && await js(`return ${R}.querySelector('[data-mk-rot-tail="5"]').getAttribute('aria-pressed') === 'true';`), await segs('XLK'));
  ok('the axes say what they mean in words, no numeric grid', await js(`var t=[...${R}.querySelectorAll('.mk-rot-ax')].map(function(e){return e.textContent;}).join('|'); return /Stronger than SPY →/.test(t) && /Gaining ↑/.test(t) && !${R}.querySelector('.mk-rot-tick');`));
  ok('the ranked list: every sector once, grouped by quadrant, each with its week move', await js(`var r=[...${R}.querySelectorAll('.mk-rotlg-row')]; return r.length === 12 && new Set(r.map(function(e){return e.dataset.sym;})).size === 12 && r.every(function(e){ return /% wk$|—$/.test(e.innerText.trim()); });`),
    await js(`return [...${R}.querySelectorAll('.mk-rotlg-row')].map(function(e){return e.innerText.replace(/\\s+/g,' ');}).slice(0, 4).join(' | ');`));
  await js(`${R}.querySelector('.mk-rotlg-row[data-sym="XLK"]').dispatchEvent(new PointerEvent('pointerover',{bubbles:true})); 1`);
  ok('hovering a row picks that name out of the chart', await js(`return ${R}.querySelector('.mk-rotwrap').classList.contains('has-focus') && ${R}.querySelector('.mk-rot-s[data-sym="XLK"]').classList.contains('is-focus');`));
  await js(`${R}.querySelector('.mk-rotwrap').dispatchEvent(new PointerEvent('pointerleave')); 1`);

  console.log('\n2. The tail switch');
  await js(`${R}.querySelector('[data-mk-rot-tail="10"]').click(); 1`);
  ok('10 days: the tails redraw with 9 segments', await until(`${R}.querySelector('.mk-rot-s[data-sym="XLK"]').querySelectorAll('.mk-rot-trail').length === 9`, 3000), await segs('XLK'));
  ok('...synced in the layout doc (market_prefs.rotTail = 10)', await until(`((window.__fakeFs.docs['dashboards/tradehub_layout']||{}).market_prefs||{}).rotTail === 10`, 5000), await prefs());
  await sleep(1200);
  await boot({ keep: true }); await tab('market');
  ok('...and kept after a reload', await until(`${R} && ${R}.querySelector('[data-mk-rot-tail="10"]') && ${R}.querySelector('[data-mk-rot-tail="10"]').getAttribute('aria-pressed') === 'true'`, 15000));

  console.log('\n3. Semis, and Neo Quant');
  await js(`var s=document.querySelector('[data-mk-universe]'); s.value='semis'; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
  ok('once measured, Rotation draws Semis\' own stocks against SOXX', await until(`/Semis: its \\d+ most traded stocks against SOXX/.test(${R}.querySelector('[data-mk-rot-of]').innerText) && [...${R}.querySelectorAll('.mk-rot-ax')].some(function(e){return /Stronger than SOXX/.test(e.textContent);})`, 25000),
    await js(`return ${R}.querySelector('[data-mk-rot-of]').innerText + ' / ' + ${R}.querySelector('.mk-rotnote').innerText;`));
  ok('...at most 20 of them, the list matching the chart', await js(`var n=${R}.querySelectorAll('.mk-rot-s').length; return n > 0 && n <= 20 && ${R}.querySelectorAll('.mk-rotlg-row').length === n;`), await js(`return ${R}.querySelectorAll('.mk-rot-s').length;`));
  const said = JSON.parse(await js(`var Rg = (await import('/A1/TradeHub/neo/registry.js')).Registry; return JSON.stringify(await Rg.get('market').actions.rotationTail.run({ days: 20 }));`));
  ok('Neo Quant: "20-day tails" sets the switch', await until(`${R}.querySelector('[data-mk-rot-tail="20"]').getAttribute('aria-pressed') === 'true'`, 3000) && /20 days/.test(said.shown || ''), JSON.stringify(said));

  console.log('\n4. Macro');
  const M = `document.querySelector('.lay-card[data-card="macro"]')`;
  await js(`${M}.scrollIntoView({ block: 'start' }); 1`); await sleep(500);
  ok('next up first, then four groups each with a line of meaning', await until(`${M} && ${M}.querySelector('[data-cx-next]') && ${M}.querySelectorAll('[data-cx-group]').length === 4 && ${M}.querySelectorAll('[data-cx-read]').length === 4`, 10000),
    await js(`return ${M} ? ${M}.innerText.slice(0, 300) : 'no card';`));
  ok('...every rate row is still there', await js(`return ['curve2s10','curve3m10','y10','real10','hy','dollar','oil'].every(function(k){ return !!${M}.querySelector('[data-cx-macro="'+k+'"]'); });`));

  console.log('\n5. Every width');
  for (const [w, hgt, name] of [[DESK_W, 900, 'desktop'], [TAB_W, 1000, 'tablet'], [390, 844, 'phone']]) {
    await size(w, hgt); await sleep(800);
    ok(`${name}: no sideways scroll`, await js(`return document.scrollingElement.scrollWidth <= innerWidth + 1;`), await js(`return document.scrollingElement.scrollWidth + ' / ' + innerWidth;`));
    ok(`${name}: the chart and the list stay inside the card`, await js(`var card=${R}.getBoundingClientRect(); return [${R}.querySelector('.mk-rotplot'), ${R}.querySelector('[data-mk-rotlg]')].every(function(e){ var r=e.getBoundingClientRect(); return r.left >= card.left - 1 && r.right <= card.right + 1; });`));
  }

  console.log('\nSide effects');
  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
