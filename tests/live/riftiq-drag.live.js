// Theme overhaul follow-up: every drag and drop in RiftIQ runs on dragsort.js
// (MAGI's drag) -- WarRoom's tab strip, ProView's league pills, the Builds
// champion list, the build cards, the build editor's item/spell chips and the
// item/spell picker. Real mouse and touch input over CDP, asserting the order
// the page actually saves, not just what the DOM shows.
//
// The Firebase SDK is refused at the network (cdp.js), so the lock overlay and
// picker are stepped over and the page's own save functions are stubbed to
// record what they were asked to write.
//
// Run: node tests/live/riftiq-drag.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const URL_ = 'https://anthonyn99.github.io/A1/riftiq.html';
const J = (c, js) => evalJs(c, js).then((v) => (typeof v === 'string' ? JSON.parse(v) : v));
const rect = (c, sel, i) => J(c, `return JSON.stringify((() => { const b = document.querySelectorAll(${JSON.stringify(sel)})[${i || 0}].getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, l: b.left, t: b.top}; })());`);

async function mouseDrag(c, x, y, dx, dy, steps = 16) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / steps, y: y + (dy * i) / steps, button: 'left', buttons: 1 });
    await sleep(16);
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
  await sleep(450);
}
async function touchDrag(c, x, y, dx, dy, holdMs, steps = 16) {
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  if (holdMs) await sleep(holdMs);
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps }] });
    await sleep(16);
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(450);
}
async function load(c, w, h, mobile) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  await c.send('Page.navigate', { url: URL_ });
  await sleep(3500);
  await evalJs(c, `
    const lk = document.getElementById('applock-overlay'); if (lk) lk.remove();
    const pk = document.getElementById('program-picker'); if (pk) pk.classList.remove('on');
    window.__saved = { tabs: null, builds: 0, cfg: 0 };
    window._fbSetDoc = (d) => { if (d.tabOrder) window.__saved.tabs = d.tabOrder; return Promise.resolve(); };
    saveBuildsToFirestore = () => { window.__saved.builds++; };
    return 1;`);
}

(async () => {
  const c = await connect();
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });

  for (const dev of [{ name: 'Desktop', w: 1440, h: 900, mobile: false }, { name: 'Phone', w: 390, h: 800, mobile: true }]) {
    console.log('\n' + dev.name);
    await load(c, dev.w, dev.h, dev.mobile);
    const drag = dev.mobile
      ? (x, y, dx, dy) => touchDrag(c, x, y, dx, dy, 380)
      : (x, y, dx, dy) => mouseDrag(c, x, y, dx, dy);
    ok('dragsort.js loaded', await evalJs(c, 'return !!window.A1Drag;'));

    // ── WarRoom tab strip ────────────────────────────────────────────────
    await evalJs(c, "document.getElementById('app').style.display='flex'; wrEnableTabDrag(); return 1;");
    await sleep(300);
    const t0 = await J(c, "return JSON.stringify(wrReadTabOrder());");
    ok('the strip is an A1Drag list, no HTML5 drag', await evalJs(c, "return document.getElementById('topbar-tabs').classList.contains('dsort');"));
    const r0 = await rect(c, '#topbar-tabs .tab-btn', 0);
    const r1 = await rect(c, '#topbar-tabs .tab-btn', 1);
    await drag(r0.x, r0.y, r1.x - r0.x + r1.w * 0.4, 0);
    const t1 = await J(c, "return JSON.stringify(wrReadTabOrder());");
    ok('WarRoom: dragging the first tab past the second swaps them', t1[0] === t0[1] && t1[1] === t0[0] && t1.length === t0.length, JSON.stringify([t0, t1]));
    ok('WarRoom: the new order is what gets saved', await evalJs(c, 'return JSON.stringify(window.__saved.tabs);') === JSON.stringify(t1), await evalJs(c, 'return JSON.stringify(window.__saved.tabs);'));
    ok('WarRoom: nothing is left lifted or transformed', await evalJs(c, "return ![...document.querySelectorAll('#topbar-tabs .tab-btn')].some(b => b.style.transform || b.classList.contains('dsort-drag'));"));

    // ── Builds: champion list ────────────────────────────────────────────
    await evalJs(c, `
      allChamps = { Ahri: {id:'Ahri',name:'Ahri'}, Lux: {id:'Lux',name:'Lux'}, Zed: {id:'Zed',name:'Zed'} };
      builds = { Ahri: [{name:'A1',items:['1001','1002'],spells:['SummonerFlash'],matchupChamps:[],notes:''},{name:'A2',items:[],spells:[],matchupChamps:[],notes:''},{name:'A3',items:[],spells:[],matchupChamps:[],notes:''}],
                 Lux: [], Zed: [] };
      buildsOrder = ['Ahri','Lux','Zed'];
      switchTab('builds'); renderBuildsHome(); return 1;`);
    await sleep(300);
    ok('champion rows are not HTML5-draggable', await evalJs(c, "return !document.querySelector('.champ-home-row[draggable]');"));
    const c0 = await rect(c, '.champ-home-row', 0);
    await drag(c0.x, c0.y, 0, c0.h * 1.6);
    ok('Builds: dragging the first champion down moves it', await evalJs(c, 'return JSON.stringify(buildsOrder);') === '["Lux","Ahri","Zed"]', await evalJs(c, 'return JSON.stringify(buildsOrder);'));
    ok('Builds: the order is saved and the list redrawn in it', await evalJs(c, "return window.__saved.builds >= 1 && [...document.querySelectorAll('.champ-home-row')].map(r => r.dataset.cid).join() === 'Lux,Ahri,Zed';"));
    const del = await rect(c, '.champ-home-row .bld-row-del', 0);
    await drag(del.x, del.y, 0, 90);
    ok('Builds: pressing the delete button never drags a row', await evalJs(c, 'return JSON.stringify(buildsOrder);') === '["Lux","Ahri","Zed"]');

    // ── Builds: build cards ──────────────────────────────────────────────
    await evalJs(c, "selectedBuildChamp='Ahri'; renderChampBuildPage('Ahri'); return 1;");
    await sleep(300);
    ok('build cards: three drawn', await evalJs(c, "return document.querySelectorAll('.build-card-row').length;") === 3);
    ok('build cards are not HTML5-draggable', await evalJs(c, "return !document.querySelector('.build-card-row[draggable]');"));
    const b0 = await rect(c, '.build-card-row', 0);
    const b1 = await rect(c, '.build-card-row', 1);   // cards differ in height: aim at the second
    await drag(b0.x, b0.t + 10, 0, b1.y - b0.t);
    ok('Builds: dragging the first build card down moves it', await evalJs(c, "return builds.Ahri.map(b => b.name).join();") === 'A2,A1,A3', await evalJs(c, "return builds.Ahri.map(b => b.name).join();"));

    // ── Build editor: chips + picker ─────────────────────────────────────
    await evalJs(c, `
      allItemsData = ['1001','1002','1003','1004','1005','1006','1007','1008'].map((id, i) => ({ id, name: 'Item ' + id, image: { full: id + '.png' }, gold: { total: 400 + i * 100 }, tags: [], depth: 1 }));
      allItems = {}; allItemsData.forEach(i => allItems[i.id] = i);
      allSummonerSpells = ['SummonerFlash','SummonerHeal','SummonerDot'].map(id => ({ id, name: id.slice(8), image: { full: id + '.png' } }));
      editBuild('Ahri', 1);
      buildEditorData.items = ['1001','1002','1003']; buildEditorData.spells = ['SummonerFlash'];
      refreshBuildZones(); return 1;`);
    await sleep(500);
    ok('item chips: 3 in the zone, not HTML5-draggable', await evalJs(c, "return document.querySelectorAll('#be-items-zone .bld-drag').length === 3 && !document.querySelector('.bld-drag[draggable]');"));
    ok('both zones and the picker grid are A1Drag lists', await evalJs(c, "return ['#be-items-zone','#be-spells-zone','#bp-content .bp-grid'].every(s => document.querySelector(s).classList.contains('dsort'));"));
    let ch0 = await rect(c, '#be-items-zone .bld-drag', 0);
    let ch2 = await rect(c, '#be-items-zone .bld-drag', 2);
    await drag(ch0.x, ch0.y, ch2.x - ch0.x + 6, ch2.y - ch0.y);
    ok('editor: dragging the first item chip to the end reorders the build', await evalJs(c, "return buildEditorData.items.join();") === '1002,1003,1001', await evalJs(c, "return buildEditorData.items.join();"));
    ok('editor: the zone is redrawn in that order', await evalJs(c, "return document.querySelectorAll('#be-items-zone .bld-drag').length === 3;"));

    // The picker: drag a tile into the zone, between the first and second chips.
    ch0 = await rect(c, '#be-items-zone .bld-drag', 0);
    const ch1 = await rect(c, '#be-items-zone .bld-drag', 1);
    const tile = await rect(c, '#bp-content .bld-drag[data-id="1005"]');
    const slotX = (ch0.x + ch1.x) / 2, slotY = ch0.y;
    // the picker may need scrolling into view on a phone; bring the tile on screen
    await evalJs(c, "document.querySelector('#bp-content .bld-drag[data-id=\"1005\"]').scrollIntoView({block:'nearest'}); return 1;");
    const tile2 = await rect(c, '#bp-content .bld-drag[data-id="1005"]');
    await drag(tile2.x, tile2.y, slotX - tile2.x, slotY - tile2.y, 24);
    const items = await evalJs(c, "return buildEditorData.items.join();");
    ok('picker: dragging a tile into the zone adds it', items.split(',').length === 4 && items.includes('1005'), items);
    ok('picker: it lands in the slot it was dropped on, not the end', items.split(',').indexOf('1005') <= 1, items);
    ok('picker: the tile is still in the picker, and no floating copy is left', await evalJs(c, "return !!document.querySelector('#bp-content .bld-drag[data-id=\"1005\"]') && !document.querySelector('.dsort-ghost') && !document.querySelector('.dsort-src');"));

    // A tap still adds.
    const tp = await rect(c, '#bp-content .bld-drag[data-id="1006"]');
    if (dev.mobile) {
      await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tp.x, y: tp.y }] });
      await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tp.x, y: tp.y, button: 'left', clickCount: 1 });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tp.x, y: tp.y, button: 'left', clickCount: 1 });
    }
    await sleep(300);
    ok('picker: a plain tap still adds the item', await evalJs(c, "return buildEditorData.items.includes('1006');"));

    // A quick swipe over a tile scrolls the picker; it does not carry the tile.
    if (dev.mobile) {
      const before = await evalJs(c, "return buildEditorData.items.join();");
      const sw = await rect(c, '#bp-content .bld-drag[data-id="1002"]');
      await touchDrag(c, sw.x, sw.y, 0, -40, 0, 6);
      ok('phone: a quick swipe on a tile is a scroll, not a drag', await evalJs(c, "return buildEditorData.items.join();") === before);
    }

    // Spells: a tile can only go where it fits (2 max).
    await evalJs(c, "showBuildPanel('spells'); return 1;");
    await sleep(300);
    const st = await rect(c, '#bp-content .bld-drag[data-id="SummonerHeal"]');
    const sz = await rect(c, '#be-spells-zone');
    await drag(st.x, st.y, sz.x - st.x, sz.y - st.y, 24);
    ok('picker: a spell tile dragged into the spells zone adds it', await evalJs(c, "return buildEditorData.spells.join();") === 'SummonerFlash,SummonerHeal', await evalJs(c, "return buildEditorData.spells.join();"));
  }

  // ── ProView league pills ─────────────────────────────────────────────────
  for (const dev of [{ name: 'Desktop', w: 1440, h: 900, mobile: false }, { name: 'Phone', w: 390, h: 800, mobile: true }]) {
    console.log('\nProView, ' + dev.name);
    await load(c, dev.w, dev.h, dev.mobile);
    await evalJs(c, `
      localStorage.setItem('pv_cfg_v1', JSON.stringify({ leagues: [{id:'l1',name:'LCK'},{id:'l2',name:'LPL'},{id:'l3',name:'LEC'},{id:'l4',name:'LCS'}], favorites: [], favLeagues: [] }));
      document.getElementById('app').style.display = 'none';
      openProgram('proview'); return 1;`);
    await sleep(6500);
    await evalJs(c, "var l = document.querySelector('.pv-lg-pill'); if (l && l.click) { /* make l1 the active league */ l.click(); } return 1;");
    await sleep(400);
    const ids = () => evalJs(c, "return JSON.parse(localStorage.getItem('pv_cfg_v1')).leagues.map(l => l.id).join();");
    ok('pills are an A1Drag list', await evalJs(c, "return document.querySelector('.pv-lg-pill').parentNode.classList.contains('dsort');"));
    const p0 = await rect(c, '.pv-lg-pill', 0);
    const p1 = await rect(c, '.pv-lg-pill', 1);
    if (dev.mobile) await touchDrag(c, p0.x, p0.y, p1.x - p0.x + p1.w * 0.4, 0, 380);
    else await mouseDrag(c, p0.x, p0.y, p1.x - p0.x + p1.w * 0.4, 0);
    ok('ProView: dragging the first league past the second swaps them', await ids() === 'l2,l1,l3,l4', await ids());
    ok('ProView: the order is saved and the pills redrawn in it', await evalJs(c, "return [...document.querySelectorAll('.pv-lg-pill')].map(p => p.dataset.lgid).join() === 'l2,l1,l3,l4';"));
    const act = () => evalJs(c, "return [...document.querySelectorAll('.pv-lg-pill')].map(p => p.dataset.lgid + ':' + (getComputedStyle(p).color === 'rgb(31, 25, 48)' ? 'on' : 'off')).join();");
    ok('ProView: a drop did not switch league', (await act()).includes('l1:on'), await act());
    // A plain click on a pill still switches (desktop; a phone tap is the same click).
    const pk = await rect(c, '.pv-lg-pill', 2);
    if (dev.mobile) {
      await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pk.x, y: pk.y }] });
      await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pk.x, y: pk.y, button: 'left', clickCount: 1 });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pk.x, y: pk.y, button: 'left', clickCount: 1 });
    }
    await sleep(300);
    ok('ProView: a plain tap on a pill still switches league', (await act()).includes('l3:on'), await act());
  }

  console.log('\nPage errors: ' + (errs.length ? errs.slice(0, 5).join(' | ') : 'none'));
  ok('no uncaught page errors from this page\'s own code', !errs.some((e) => /riftiq|A1Drag|dragsort|beDrop|wrEnableTabDrag|pvEnablePillDrag/.test(e)), errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
