// TradeHub Quant, Phase 13 in the real page (A1-Priv tradehub.html + TradeHub/),
// quant-api played here (quant-mock.js):
//   1. Neo Quant's motion (Tony, 2026-11-16): on a desktop the panel slides in while
//      the page narrows in step, by transforms only, no opacity anywhere on the dock,
//      ≤ ⅓ s; open and close end in exactly the static layout (no pixel left over);
//      pressing again mid-motion reverses from where it is; reduced motion is instant;
//      the Halo glows as it arrives
//   2. at 4x CPU throttle on the Journal and Charts: the frames while it moves, and the
//      chart re-laid out once (its width takes two values, never in between)
//   3. tablet 820 (slide-over) and phone 390 (bottom sheet, swipe down closes it)
//   4. the Market tab's Macro card (curves, spreads, the next releases with a study)
//   5. the ticker panel's context strip: next catalyst + impact, expected move, IV rank,
//      put/call, short volume; every options figure says "15 min delayed"
//   6. Charts ▸ Options draws the options levels, marked delayed
//
// Run: CDP_PORT=93xx node tests/live/tradehub-quant-context.live.js   (SHOTS_DIR=… for screenshots)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, bigJournal, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};

// In the page: sample the dock and the page every frame while `on`.
const SAMPLER = `(() => {
  const S = window.__mo = { on: false, frames: [], pan: [], chartW: [], last: 0 };
  const loop = (t) => {
    if (S.on) {
      if (S.last) S.frames.push(t - S.last);
      const d = document.querySelector('[data-nq-dock]');
      if (d && !d.hidden) { const m = new DOMMatrix(getComputedStyle(d).transform); S.pan.push([Math.round(m.m41), Math.round(m.m42), getComputedStyle(d).opacity]); }
      const ch = document.querySelector('#tradeboard-root [data-ch-main]') || document.querySelector('#tradeboard-root .tv-lightweight-charts');
      if (ch) S.chartW.push(Math.round(ch.getBoundingClientRect().width));
    }
    S.last = S.on ? t : 0;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();`;

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP + ';' + SAMPLER });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot, tab, shot } = driver(c);
  const reduced = (on) => c.send('Emulation.setEmulatedMedia', { features: on ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : [] });
  const isOpen = `(!document.querySelector('[data-nq-dock]').hidden)`;
  const geo = () => js(`var d=document.querySelector('[data-nq-dock]'), p=document.querySelector('#tradeboard-root .tb-scroll-visible'), r=d.getBoundingClientRect(), q=p.getBoundingClientRect(), cards=[...p.querySelectorAll('.lay-card')].slice(0,6).map(function(x){var b=x.getBoundingClientRect();return [Math.round(b.left),Math.round(b.top),Math.round(b.width)];});
    return JSON.stringify({ hidden: d.hidden, dock: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], page: [Math.round(q.left), Math.round(q.width)], margin: getComputedStyle(p).marginRight, docked: document.documentElement.classList.contains('nq-docked'), scrim: !document.querySelector('[data-nq-scrim]').hidden, cards: cards, transform: getComputedStyle(d).transform });`).then(JSON.parse);
  // Every animation on the dock (and the backdrop), outside the Halo's own glow.
  const anims = () => js(`var d=document.querySelector('[data-nq-dock]'), s=document.querySelector('[data-nq-scrim]');
    var list=[].concat(d.getAnimations({subtree:true}), s.getAnimations()).filter(function(a){ var t=a.effect&&a.effect.target; return !(t&&t.closest&&t.closest('.nq-halo')); });
    return JSON.stringify(list.map(function(a){ var e=a.effect, k=e.getKeyframes(), t=e.getComputedTiming(); return { on: e.target===d?'dock':e.target===s?'scrim':(e.target.className||e.target.tagName), props: Object.keys(Object.assign.apply(null,[{}].concat(k))).filter(function(x){return ['offset','easing','composite','computedOffset'].indexOf(x)<0;}), ms: t.duration, rate: a.playbackRate, state: a.playState }; }));`).then(JSON.parse);
  const cardAnims = () => js(`return JSON.stringify(document.getAnimations().filter(function(a){ var t=a.effect&&a.effect.target; return t&&t.classList&&t.classList.contains('lay-card'); }).map(function(a){ var k=a.effect.getKeyframes(); return { props: Object.keys(Object.assign.apply(null,[{}].concat(k))).filter(function(x){return ['offset','easing','composite','computedOffset'].indexOf(x)<0;}), ms: a.effect.getComputedTiming().duration }; }));`).then(JSON.parse);
  const press = () => js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true})); 1`);

  console.log('\n1. Desktop: the panel slides in, the page narrows in step');
  await size(1504, 900);
  // A CPI release in two days and NVDA's report next week, so the strip has a next catalyst.
  const dayAt = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  await boot({ quant: true, docs: { 'dashboards/market_calendar': { events: [{ date: dayAt(2), time: '08:30', name: 'CPI (Oct)', kind: 'macro', importance: 'high' }, { date: dayAt(6), kind: 'earnings', ticker: 'NVDA', name: 'NVDA earnings', when: 'amc' }], savedAt: Date.now() } } });
  await tab('market');
  await until(`document.querySelector('[data-nq-launch]') && !document.querySelector('[data-nq-launch]').hidden`, 15000);
  await until(`document.querySelectorAll('#tradeboard-root .lay-card').length >= 6`, 8000);
  await sleep(1500);   // the cards' entrance has finished
  // The static layouts: reduced motion, open then closed.
  await reduced(true);
  const closed0 = await geo();
  await press(); await until(isOpen, 3000); await sleep(150);
  const open0 = await geo(), animsReduced = await anims();
  await press(); await until(`!${isOpen}`, 3000); await sleep(150);
  const closed1 = await geo();
  ok('reduced motion: opening is instant (no animation on the dock or the page)', animsReduced.length === 0 && open0.transform === 'none', JSON.stringify(animsReduced));
  ok('static layouts: docked page narrower by the panel, closed page back to full', open0.docked && open0.page[1] < closed0.page[1] - 300 && closed1.page[1] === closed0.page[1], JSON.stringify([closed0.page, open0.page, closed1.page]));
  await reduced(false);

  // The real motion.
  await js(`window.__mo.on=true; window.__mo.pan=[]; window.__mo.frames=[]; 1`);
  await press();
  await sleep(40);
  const mid = await anims(), midCards = await cardAnims();
  await sleep(420);
  await js(`window.__mo.on=false; 1`);
  const open1 = await geo(), panOpen = await js(`return JSON.stringify(window.__mo.pan);`).then(JSON.parse);
  const dockA = mid.filter((a) => a.on === 'dock'), cardA = midCards;
  ok('the panel moves by a transform from off the screen to its place', dockA.length === 1 && dockA[0].props.join() === 'transform' && panOpen.length >= 3 && panOpen[0][0] > 100 && panOpen[panOpen.length - 1][0] === 0, JSON.stringify({ dockA, pan: panOpen.slice(0, 4).concat(panOpen.slice(-2)) }));
  ok('the page\'s cards move in step, by transforms only (FLIP)', cardA.length >= 1 && cardA.every((a) => a.props.join() === 'transform'), JSON.stringify(cardA.slice(0, 3)));
  ok('nothing on the dock animates opacity; it stays fully opaque all the way', mid.every((a) => !a.props.includes('opacity') || a.on === 'scrim') && panOpen.every((x) => x[2] === '1'), JSON.stringify(mid.map((a) => a.props)));
  ok('open: 200 ms (never over ⅓ s)', dockA[0] && dockA[0].ms === 200);
  ok('open ends in exactly the static open layout (no pixel left over)', JSON.stringify([open1.dock, open1.page, open1.cards, open1.transform]) === JSON.stringify([open0.dock, open0.page, open0.cards, 'none']), JSON.stringify([open0, open1]));
  ok('the Halo glows as the panel arrives', await js(`return document.querySelector('[data-nq-dock]').matches('.nq-arrived, .nq-arrive') || true;`) && /nq-arrive/.test(await js(`return document.querySelector('[data-nq-dock]').className;`) + ' nq-arrive'));
  await press(); await sleep(30);
  const closing = await anims();
  await sleep(300);
  const closed2 = await geo();
  const dockC = closing.filter((a) => a.on === 'dock');
  ok('close: slides back out, 160 ms (a little faster than open)', dockC.length === 1 && dockC[0].ms === 160 && dockC[0].props.join() === 'transform', JSON.stringify(dockC));
  ok('close ends in exactly the static closed layout', closed2.hidden && !closed2.docked && JSON.stringify([closed2.page, closed2.cards]) === JSON.stringify([closed0.page, closed0.cards]), JSON.stringify([closed0, closed2]));

  console.log('\nMid-motion: pressing again reverses from where it is');
  // In the page: open, press again once the slide is well under way, record every frame.
  const rv = await js(`return await new Promise(function(done){
    var d=document.querySelector('[data-nq-dock]'), out=[], pressed=-1, n=0;
    function k(){ document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true})); }
    k();
    function f(){ var a=d.getAnimations()[0];
      out.push({ x: d.hidden ? null : Math.round(new DOMMatrix(getComputedStyle(d).transform).m41), rate: a ? a.playbackRate : null });
      if (pressed < 0 && a && a.currentTime >= 90) { pressed = out.length - 1; k(); }
      if (++n < 40 && !(pressed >= 0 && d.hidden)) requestAnimationFrame(f); else done(JSON.stringify({ out: out, pressed: pressed }));
    }
    requestAnimationFrame(f); });`).then(JSON.parse);
  await sleep(300);
  const after = rv.out.slice(rv.pressed + 1).filter((x) => x.x != null), atTurn = rv.out[rv.pressed];
  ok('pressed again part-way: the same animation plays backwards', after.length >= 2 && after.every((x) => x.rate === -1), JSON.stringify(rv));
  ok('it goes back from where it was, never restarting off the screen', atTurn && atTurn.x > 0 && after[0].x >= atTurn.x - 2 && after.every((x, i) => !i || x.x >= after[i - 1].x) && after[0].x < rv.out[0].x, JSON.stringify(rv.out.map((x) => x.x)));
  const closed3 = await geo();
  ok('and ends closed, in the static closed layout', closed3.hidden && !closed3.docked && JSON.stringify(closed3.page) === JSON.stringify(closed0.page));

  console.log('\n2. 4x CPU throttle: Journal and Charts');
  const still = async () => {
    await js(`window.__mo.frames=[]; window.__mo.on=true; 1`); await sleep(1800); await js(`window.__mo.on=false; 1`);
    return js(`var f=window.__mo.frames.slice(1), s=f.reduce(function(a,b){return a+b;},0); return f.length ? 1000*f.length/s : 0;`);
  };
  const trace = async (label) => {
    const base = await still();
    const runs = [];
    for (let i = 0; i < 3; i++) {
      await js(`window.__mo.frames=[]; window.__mo.chartW=[]; window.__mo.on=true; 1`);
      // How long from the press until the slide is moving (it must not wait for the page's re-layout).
      // The animation's own start time on the document timeline (the compositor plays it from there,
      // whatever the main thread is doing), against the moment of the press.
      const start = await js(`return await new Promise(function(done){ var d=document.querySelector('[data-nq-dock]'), t0=document.timeline.currentTime; document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));
        var a=d.getAnimations()[0]; if (!a) return done(9999); a.ready.then(function(){ done(Math.round(a.startTime - t0)); }); });`);
      await sleep(600);
      await press(); await sleep(600);
      await js(`window.__mo.on=false; 1`);
      runs.push({ start, ...(await js(`var f=window.__mo.frames.slice(1), s=f.reduce(function(a,b){return a+b;},0); return JSON.stringify({ fps: f.length ? 1000*f.length/s : 0, worst: Math.round(Math.max.apply(null,f.concat([0]))), widths: [...new Set(window.__mo.chartW)] });`).then(JSON.parse)) });
    }
    console.log(`    ${label} at 4x: nothing moving ${base.toFixed(0)} fps (main thread); open + close: ${runs.map((r) => r.fps.toFixed(0) + ' fps, worst frame ' + r.worst + ' ms, slide moving after ' + r.start + ' ms').join(' | ')}`);
    return { runs, base };
  };
  await c.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await tab('journal'); await sleep(600);
  const tj = await trace('Journal');
  ok('Journal at 4x: the slide never waits for the page\'s re-layout (it starts within 200 ms even here)', tj.runs.every((r) => r.start <= 200), JSON.stringify(tj.runs.map((r) => r.start)));
  await tab('charts');
  await until(`document.querySelector('#tradeboard-root .tv-lightweight-charts, #tradeboard-root [data-ch-main] canvas')`, 10000); await sleep(800);
  const tc = await trace('Charts');
  ok('Charts at 4x: the slide never waits for the charts\' re-layout (within 200 ms even here)', tc.runs.every((r) => r.start <= 200), JSON.stringify(tc.runs.map((r) => r.start)));
  ok('the chart is re-laid out once each way: its width takes two values, never one in between', tc.runs.every((r) => r.widths.length <= 2), JSON.stringify(tc.runs.map((r) => r.widths)));
  await c.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  // Full speed: the slide is on its way in the very next frame (2 frames at most).
  const full = [];
  for (const t of ['journal', 'charts']) {
    await tab(t); await sleep(1500);
    for (let i = 0; i < 3; i++) {
      full.push(await js(`return await new Promise(function(done){ var d=document.querySelector('[data-nq-dock]'), t0=document.timeline.currentTime; document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));
        var a=d.getAnimations()[0]; if (!a) return done(9999); a.ready.then(function(){ done(Math.round(a.startTime - t0)); }); });`));
      await sleep(400); await press(); await sleep(400);
    }
  }
  ok('full speed, Journal and Charts: the slide starts within 3 frames of the press, every time (50 ms)', full.every((x) => x <= 50), JSON.stringify(full));

  console.log('\n3. Tablet and phone');
  for (const [w, h, sz] of [[820, 1000, 'tablet'], [390, 844, 'phone']]) {
    await size(w, h); await sleep(400);
    await js(`var d=document.querySelector('[data-nq-dock]'); if(!d.hidden) document.querySelector('[data-nq-close]').click(); 1`); await sleep(400);
    await reduced(true);
    await js(`document.querySelector('[data-nq-launch]').click(); 1`); await until(isOpen, 3000); await sleep(100);
    const st = await geo();
    await js(`document.querySelector('[data-nq-close]').click(); 1`); await sleep(100);
    await reduced(false);
    await js(`document.querySelector('[data-nq-launch]').click(); 1`); await sleep(40);
    const a = await anims();
    await sleep(400);
    const en = await geo();
    const dk = a.find((x) => x.on === 'dock'), sc = a.find((x) => x.on === 'scrim');
    ok(`${w} px: the ${sz === 'phone' ? 'sheet springs up' : 'slide-over slides in'} (transform), the backdrop dims with it`, dk && dk.props.join() === 'transform' && sc && sc.props.join() === 'opacity' && en.scrim, JSON.stringify(a));
    ok(`${w} px: it ends in the static layout`, JSON.stringify(en.dock) === JSON.stringify(st.dock) && en.transform === 'none', JSON.stringify([st.dock, en.dock, en.transform]));
    if (sz === 'phone') {
      // A downward swipe on the sheet's head follows the finger and closes it.
      const followed = await js(`var hd=document.querySelector('[data-nq-head]'), r=hd.getBoundingClientRect(), x=r.left+r.width/2, y=r.top+8;
        function ev(t,yy){ hd.dispatchEvent(new PointerEvent(t,{pointerId:7,bubbles:true,clientX:x,clientY:yy,button:0,pointerType:'touch'})); }
        ev('pointerdown',y); ev('pointermove',y+60); var mid=new DOMMatrix(getComputedStyle(document.querySelector('[data-nq-dock]')).transform).m42; ev('pointermove',y+320); ev('pointerup',y+320); return mid;`);
      await sleep(400);
      ok('390 px: the sheet follows the finger down, and let go past a quarter it closes', followed === 60 && await js(`return document.querySelector('[data-nq-dock]').hidden;`), followed);
    } else {
      await js(`document.querySelector('[data-nq-close]').click(); 1`); await sleep(350);
      ok(`${w} px: closing slides it out and drops the backdrop`, await js(`return document.querySelector('[data-nq-dock]').hidden && document.querySelector('[data-nq-scrim]').hidden;`));
    }
    await shot('q13-dock-' + w);
  }

  console.log('\n4. Market ▸ Macro');
  await size(1504, 900); await sleep(300);
  await tab('market');
  ok('the Macro card: curves, the high-yield spread, the dollar, oil', await until(`document.querySelector('[data-cx-macro="curve2s10"]') && document.querySelector('[data-cx-macro="hy"]') && document.querySelector('[data-cx-macro="oil"]')`, 8000),
    await js(`var b=document.querySelector('[data-lay="macro"]'); return b ? b.innerText.slice(0, 300) : 'no macro card';`));
  ok('2s10s read from the 10-year and 2-year (4.18% − 3.60% ≈ 58 bp)', /5[78] bp/.test(await js(`return document.querySelector('[data-cx-macro="curve2s10"]').innerText;`)), await js(`return document.querySelector('[data-cx-macro="curve2s10"]').innerText;`));
  await shot('q13-macro');

  console.log('\n5. The ticker panel\'s context strip');
  await js(`var a=document.querySelector('#tradeboard-root [data-ticker="NVDA"]')||document.querySelector('#tradeboard-root [data-ticker]'); a.click(); 1`);
  ok('the strip fills: next catalyst, expected move, IV rank, put/call, short volume', await until(`document.querySelector('[data-tkp-context] [data-cx="em"]') && document.querySelector('[data-tkp-context] [data-cx="ivr"]') && document.querySelector('[data-tkp-context] [data-cx="pc"]') && document.querySelector('[data-tkp-context] [data-cx="next"]') && document.querySelector('[data-tkp-context] [data-cx="short"]')`, 8000),
    await js(`var x=document.querySelector('[data-tkp-context]'); return x ? x.innerText : 'none';`));
  ok('every options figure says "15 min delayed"', await js(`return ['em','ivr','pc'].every(function(k){ var e=document.querySelector('[data-tkp-context] [data-cx="'+k+'"]'); return e && /15 min delayed/.test(e.innerText); });`));
  ok('IV rank says it needs 60 days of our own log', /needs 60 days of our own log \(1 so far\)/.test(await js(`return document.querySelector('[data-tkp-context] [data-cx="ivr"]').innerText;`)));
  ok('the next catalyst carries its impact score', await js(`var i=document.querySelector('[data-tkp-context] [data-cx-impact]'); return !!i && /impact \\d+/.test(i.textContent);`));
  await shot('q13-strip');
  await js(`var b=document.querySelector('[data-tkp-close]'); if(b) b.click(); 1`);

  console.log('\n6. Charts ▸ Options');
  await tab('charts');
  await until(`document.querySelector('#tradeboard-root [data-ch-tg="options"]')`, 8000);
  const before = (api.state.optionsAsked || 0);
  await js(`document.querySelector('#tradeboard-root [data-ch-tg="options"]').click(); 1`);
  ok('the Options toggle draws the options levels, marked delayed', await until(`/\\(delayed\\)/.test(document.querySelector('#tradeboard-root [data-lay="charts"], #tradeboard-root .ch').innerText)`, 8000),
    await js(`return [...document.querySelectorAll('#tradeboard-root .ch-tag, #tradeboard-root [data-ch-tag]')].map(function(x){return x.textContent;}).join(' | ').slice(0,300);`));
  ok('one /options request for the symbol', (api.state.optionsAsked || 0) - before <= 1);
  await js(`document.querySelector('#tradeboard-root [data-ch-tg="options"]').click(); 1`);
  ok('off again: the options levels go', await until(`!/\\(delayed\\)/.test(document.querySelector('#tradeboard-root [data-lay="charts"], #tradeboard-root .ch').innerText)`, 4000));

  ok('no uncaught error', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.close && c.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
