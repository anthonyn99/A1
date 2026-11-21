// Tony 2026-11-21: Neo Quant's backend picker (A1-Priv TradeHub/neo/backend.js) in the real page, quant-api
// and Orca played here: the chip beside Send, its menu (Auto, the providers with a key, Gemini, the browser
// units that are up), a pick sent with the next typed question, Escape and a click outside close it, the menu
// inside the screen at 1280, 820 and 390 px.
//
// Run: node tests/live/tradehub-quant-neo-backend.live.js   (own CDP_PORT)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
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
  const CHIP = `${D}.querySelector('[data-nq-backend]')`, MENU = `${D}.querySelector('[data-nq-be-menu]')`;
  const openDock = async () => { await js(`if(${D}.hidden) document.querySelector('[data-nq-launch]').click(); 1`); await until(`!${D}.hidden && ${CHIP}`, 8000); await sleep(400); };
  const openMenu = async () => { await js(`if(${MENU}.hidden) ${CHIP}.click(); 1`); await until(`!${MENU}.hidden && ${MENU}.querySelector('[data-nq-be="unit:deepseek/free"]')`, 8000); };
  const askTyped = async (q) => js(`var i=${D}.querySelector('[data-nq-input]'); i.value=${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); ${D}.querySelector('[data-nq-send]').click(); 1`);
  const lastChat = () => (api.posted.ai || []).filter((x) => x.p === '/ai/chat').slice(-1)[0];

  await size(1280 + 224, 900);
  await boot({ quant: true }); await tab('market');
  await openDock();

  console.log('\n1. The chip and its menu');
  ok('the chip beside Send reads Auto', await js(`return ${CHIP}.textContent.indexOf('Auto') === 0 && ${MENU}.hidden;`), await js(`return ${CHIP} ? ${CHIP}.textContent : 'no chip';`));
  await openMenu();
  const rows = JSON.parse(await js(`return JSON.stringify([...${MENU}.querySelectorAll('[data-nq-be]')].map(function(b){return b.getAttribute('data-nq-be');}));`));
  ok('the menu: Auto, the providers with a key (Groq), Gemini, the units that are up (DeepSeek, Perplexity)', ['auto', 'fast:groq', 'gemini', 'unit:deepseek/free', 'unit:perplexity/free'].every((x) => rows.includes(x)) && !rows.includes('fast:cerebras'), rows.join());
  ok('...Auto is ticked', await js(`return ${MENU}.querySelector('[data-nq-be="auto"]').getAttribute('aria-selected') === 'true';`));
  ok('...it sits inside the screen, above the composer', await js(`var r=${MENU}.getBoundingClientRect(), s=${D}.querySelector('[data-nq-send]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= s.top + 1;`), await js(`return JSON.stringify(${MENU}.getBoundingClientRect());`));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1`); await sleep(150);
  ok('Escape closes it, and only it (the dock stays open)', await js(`return ${MENU}.hidden && !${D}.hidden;`));
  await openMenu();
  await js(`document.querySelector('.tb-page, main, body').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); 1`); await sleep(150);
  ok('a click outside closes it', await js(`return ${MENU}.hidden;`));

  console.log('\n2. A pick goes with the next typed question');
  await openMenu();
  await js(`${MENU}.querySelector('[data-nq-be="fast:groq"]').click(); 1`); await sleep(150);
  ok('Groq picked: the chip says Groq, the menu shut, the pick kept on the device', await js(`return ${CHIP}.textContent.indexOf('Groq') === 0 && ${MENU}.hidden && JSON.parse(localStorage.getItem('tradehub.neoBackend')).id === 'groq';`));
  const n0 = (api.posted.ai || []).length;
  await askTyped('How is the market today?');
  await until(`${D}.querySelectorAll('[data-nq-turn]').length > 0`, 4000);
  for (let i = 0; i < 40 && (api.posted.ai || []).length === n0; i++) await sleep(200);
  ok('the question went to /ai/chat with provider groq', lastChat() && lastChat().body.provider === 'groq', JSON.stringify(lastChat() && lastChat().body.provider));
  await sleep(1200);
  await openMenu();
  await js(`${MENU}.querySelector('[data-nq-be="unit:deepseek/free"]').click(); 1`); await sleep(150);
  const o0 = (api.posted.orca || []).length;
  await askTyped('Is NVDA a buy here?');
  for (let i = 0; i < 40 && !(api.posted.orca || []).slice(o0).some((x) => /chat\/completions/.test(x.p)); i++) await sleep(200);
  const oc = (api.posted.orca || []).slice(o0).find((x) => /chat\/completions/.test(x.p));
  ok('DeepSeek picked: the typed question went to that browser unit through Orca', !!oc && /deepseek\/free/.test(oc.body || ''), JSON.stringify((api.posted.orca || []).slice(o0).map((x) => x.p)));
  await sleep(1500);
  await openMenu();
  await js(`${MENU}.querySelector('[data-nq-be="auto"]').click(); 1`); await sleep(150);
  const n1 = (api.posted.ai || []).length;
  await askTyped('Why is the VIX up today?');
  for (let i = 0; i < 40 && (api.posted.ai || []).length === n1; i++) await sleep(200);
  // The question's own request (a follow-up check of the answer names the provider that answered, by design).
  const firstAuto = (api.posted.ai || []).slice(n1).find((x) => x.p === '/ai/chat');
  ok('back on Auto: no provider sent, and nothing kept on the device', firstAuto && !firstAuto.body.provider && localStorage_none(await js(`return localStorage.getItem('tradehub.neoBackend');`)), JSON.stringify(firstAuto && firstAuto.body.provider));
  await sleep(1200);

  console.log('\n3. Every width');
  for (const [w, hgt, name] of [[1280 + 224, 900, 'desktop'], [820 + 224, 1000, 'tablet'], [390, 844, 'phone']]) {
    await size(w, hgt); await sleep(700); await openDock();
    if (name === 'desktop') console.log('   debug:', await js(`return JSON.stringify({dock: .hidden, launch: !!document.querySelector('[data-nq-launch]'), lv: document.querySelector('[data-nq-launch]') && getComputedStyle(document.querySelector('[data-nq-launch]')).display, tab: location.hash});`));
    await openMenu();
    ok(`${name}: the menu inside the screen, no sideways scroll`, await js(`var r=${MENU}.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.height > 120 && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;`), await js(`return JSON.stringify(${MENU}.getBoundingClientRect()) + ' / ' + innerWidth;`));
    ok(`${name}: the chip fits in the composer row`, await js(`var c=${CHIP}.getBoundingClientRect(), s=${D}.getBoundingClientRect(); return c.width > 40 && c.left >= s.left - 1 && c.right <= s.right + 1;`));
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1`); await sleep(100);
  }

  ok('no page errors', !errs.length, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function localStorage_none(v) { return v === null || v === 'null' || v === ''; }
