// Notebook on phones and tablets (Tony, 2026-11-17; Notebook/core/mobile.js and
// "Phones and tablets" at the end of Notebook/notebook.css). Both sides, in
// index.html and in an instance (tests/live/fixtures/notebook-host.html), with
// a real browser and a fake Firestore.
//
// Phone (412x915, touch) and portrait tablet (820x1180, touch):
//   - home is the entry list, full screen, with a + button; the program nav shows
//   - opening an entry gives the editor: back, title, Edit, New, ⋮ in ONE bar,
//     the page edge to edge, no bottom bar; in index.html the nav is covered
//   - back returns to the list; the pencil button enters edit mode
//   - editing: the ribbon is one row docked at the bottom; B I U on screen, Undo
//     and Redo pinned at its right end; a tap on Bold keeps the editor focused
//     and bolds the selection; the swap button shows the menus, whose pop opens
//     ABOVE the dock; with an onscreen keyboard (a stand-in visualViewport) the
//     dock rides right above it and the caret is kept clear of it
//   - ⋮ holds lock / tags / template / Export PDF; Veda's Tags sheet edits her
//     tags and gives the row back to the title bar when it closes
//   - + (bar and round button) opens the template picker
// Landscape tablet (1180x820, touch): the desktop layout, the ribbon docked.
// Desktop (1440x900, mouse): none of it.
//
// Run: node tests/live/notebook-mobile.live.js [tony|veda]   (CDP_PORT=93xx)
'use strict';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');
const fs = require('fs');

const ORIGIN = 'https://anthonyn99.github.io', BASE = ORIGIN + '/A1/';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const T0 = Date.now();
const LONG = '<h2>Alpha</h2><p>First <strong>bold</strong> line.</p>' + '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.</p>'.repeat(14) + '<p id="last">The last line.</p>';
const entry = (id, title, html, extra) => Object.assign({ id, title, template: 'page', created: T0 - 86400000, updated: T0 - 3600000,
  tags: [], data: { html, attachments: [] }, rev: 1 }, extra || {});
const SEED = [
  entry('e_1791000000001_alpha00001', 'Alpha plan', LONG, { tags: ['work'] }),
  entry('e_1791000000002_bravo00002', 'Bravo notes', '<p>Bravo body text.</p>'),
];
function seedDoc() { const d = { _order: SEED.map((e) => e.id), activeId: null, savedAt: T0 - 3600000 }; for (const e of SEED) d['e_' + e.id] = e; return d; }
const SIDES = {
  tony: { K: 'tj', doc: 'dashboards/tony_journal', open: "window._tonyNav('brainstormjournal')" },
  veda: { K: 'bj', doc: 'dashboards/journal', open: "window._vedaNav('journal')" },
};
const only = process.argv[2];

(async () => {
  const c = await connect({ mock: firebaseMock() });
  const js = (e) => evalJs(c, e);
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const shot = async (name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(shotPath('nbm-' + name), Buffer.from(r.result.data, 'base64')); };
  // A real finger: touch events at the element's centre (and the click they make).
  const tap = async (sel) => {
    const p = await js(`var el=document.querySelector(${JSON.stringify(sel)}); if(!el) return null; var r=el.getBoundingClientRect(); if(!r.width||!r.height) return null; return [r.left+r.width/2, r.top+r.height/2];`);
    if (!p) return false;
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p[0], y: p[1] }] });
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(450);
    return true;
  };
  const size = async (w, h, touch) => {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: touch });
    await c.send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 0 });
  };
  const boot = async (who) => {
    const { doc, open } = SIDES[who];
    await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
    await c.send('Page.navigate', { url: BASE + 'LifeHub/lifehub.js' }); await sleep(400);
    await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','${who}'); localStorage.setItem('a1b_disabled','1');
      var d=new Date(); localStorage.setItem('a1_sweep_day:index', d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2));
      sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify({ [doc]: seedDoc() }))}); 1`);
    await c.send('Page.navigate', { url: BASE + 'index.html' }); await sleep(2500);
    for (let i = 0; i < 120; i++) { if (await js(`var l=document.getElementById('th-boot-loader'); return !!window._profileGoTony && (!l || l.classList.contains('th-boot-hide'));`)) break; await sleep(250); }
    await sleep(800); await js(`var l=document.getElementById('th-boot-loader'); if(l) l.remove(); ${open}; 1`); await sleep(2200);
  };
  const cls = (K) => js(`return document.getElementById('${K}-root').className;`);
  const rect = (sel) => js(`var el=document.querySelector(${JSON.stringify(sel)}); if(!el) return null; var r=el.getBoundingClientRect(); return {l:r.left,t:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height};`);
  const navShown = () => js(`var n=document.getElementById('tony-app-nav'); return !!n && getComputedStyle(n).display!=='none' && getComputedStyle(n).visibility!=='hidden';`);

  for (const who of ['tony', 'veda']) {
    if (only && only !== who) continue;
    const { K } = SIDES[who];
    const R = '#' + K + '-root';
    for (const [w, h, label] of [[412, 915, 'phone'], [820, 1180, 'tablet portrait']]) {
      console.log(`\n${who === 'tony' ? "T's" : "V's"} Notebook, ${label} ${w}x${h}`);
      await size(w, h, true);
      await boot(who);
      // ── the list is home ──
      let k = await cls(K);
      ok('nothing open: the list is the screen (nb-mlist), full width', /\bnb-mlist\b/.test(k) && (await rect(`#${K}-sidebar`)).w >= w - 1, k);
      ok('the + button is on the list', await js(`var f=document.querySelector('${R} .nb-fab'); return !!f && f.classList.contains('on') && f.classList.contains('nb-fab-new') && f.getBoundingClientRect().width===56;`));
      ok('no bottom bar, no New Entry button in the list', await js(`return getComputedStyle(document.getElementById('${K}-bottom-bar')).display==='none' && getComputedStyle(document.getElementById('${K}-new-entry-btn')).display==='none';`));
      if (who === 'tony') ok('the program nav shows over the list', await navShown());
      else ok("Veda's header shows over the list", await js(`return getComputedStyle(document.getElementById('bj-nav-header')).display!=='none';`));
      if (label === 'phone') await shot(`${who}-${w}-list`);

      // ── open an entry: the editor ──
      await tap(`#${K}-entries-list .entry-item`); await sleep(500);
      k = await cls(K);
      ok('an entry opened: the editor is the screen (nb-mdoc), the list is gone', /\bnb-mdoc\b/.test(k) && !/\bnb-mlist\b/.test(k) && await js(`return getComputedStyle(document.getElementById('${K}-sidebar')).visibility==='hidden';`), k);
      ok('ONE bar: back, title, Edit, New, ⋮ (lock moved into ⋮)', await js(`var h=document.getElementById('${K}-mobile-header'); var v=[...h.children].filter(x=>x.getClientRects().length && getComputedStyle(x).visibility!=='hidden'); return v.map(x=>x.id||x.className).join(',');`).then((s) => /hamburger.*mobile-title.*nb-mh-mode.*nb-mh-new.*nb-mh-more/.test(s) && !/lock/.test(s)));
      ok('the bar is 56px and the title reads the entry', (await rect(`#${K}-mobile-header`)).h === 56 && await js(`return document.getElementById('${K}-mobile-title').value==='Alpha plan';`));
      if (who === 'tony') ok('index: the open page covers the program nav (it uses the full height)', !(await navShown()) && (await rect(`#${K}-mobile-header`)).t === 0);
      else ok("index: the open page covers Veda's header", await js(`return getComputedStyle(document.getElementById('bj-nav-header')).display==='none';`) && (await rect(`#${K}-mobile-header`)).t === 0);
      const sheet = await rect(`#${K}-page-editor`);
      ok('the page runs edge to edge (no side gutter, no frame)', sheet.l === 0 && Math.abs(sheet.w - w) <= 1, JSON.stringify(sheet));
      ok('the page fills down to the bottom of the screen (no bottom bar)', Math.abs((await rect(`#${K}-page-editor-wrap`)).b - h) <= 1);
      ok('reading: the round button is the pencil', await js(`var f=document.querySelector('${R} .nb-fab'); return f.classList.contains('on') && !f.classList.contains('nb-fab-new');`));

      // ── back, and in again ──
      await tap(`#${K}-hamburger`);
      ok('back shows the list again (and the nav)', /\bnb-mlist\b/.test(await cls(K)) && (who !== 'tony' || await navShown()));
      // OurJournal and back, from the list (an entry was open): the list stays; no page opens by itself.
      await tap(`${R} .oj-tab[data-oj="1"], ${R} .mjd-rail-btn.oj-tab`); await sleep(900);
      ok('the OurJournal tab from the list: still the list', /\bnb-mlist\b/.test(await cls(K)), await cls(K));
      await tap(`${R} .oj-tab[data-oj="0"], ${R} .mjd-rail-btn[data-sec="pages"]`); await sleep(900);
      ok('…and back to MyJournal: still the list, no page opened by itself', /\bnb-mlist\b/.test(await cls(K)) && !/\bnb-mdoc\b/.test(await cls(K)), await cls(K));
      await tap(`#${K}-entries-list .entry-item`);
      ok('tapping the entry returns to it', /\bnb-mdoc\b/.test(await cls(K)) && await js(`return document.getElementById('${K}-mobile-title').value==='Alpha plan';`));

      // ── the pencil: edit mode, the docked ribbon ──
      await tap(`${R} .nb-fab`); await sleep(300);
      k = await cls(K);
      ok('the pencil turns editing on, and the ribbon docks (nb-medit nb-mdock)', /\bnb-medit\b/.test(k) && /\bnb-mdock\b/.test(k) && await js(`return document.getElementById('${K}-btn-edit').checked;`), k);
      ok('…the round button goes away while editing', await js(`return !document.querySelector('${R} .nb-fab').classList.contains('on');`));
      const tb = await rect(`#${K}-page-toolbar`);
      ok('the ribbon is ONE row right under the header, full width', tb && Math.abs(tb.t - (await rect(`#${K}-mobile-header`)).b) <= 1 && tb.h <= 56 && tb.l === 0 && Math.abs(tb.w - w) <= 1, JSON.stringify(tb));
      ok('the menu row is not shown with it (menus are one swap away)', await js(`return getComputedStyle(document.querySelector('#${K}-page-toolbar .docx-menubar')).display==='none';`));
      const vis = await js(`var tb=document.getElementById('${K}-page-toolbar').getBoundingClientRect(); var out={}; ['bold','italic','underline'].forEach(n=>{var b=document.getElementById('${K}-pt-'+n).getBoundingClientRect(); out[n]=b.left>=tb.left && b.right<=tb.right-80 && b.height===40;}); var u=[...document.querySelectorAll('#${K}-page-toolbar .pt-btn')].find(x=>/^Undo/.test(x.title)).getBoundingClientRect(), r=[...document.querySelectorAll('#${K}-page-toolbar .pt-btn')].find(x=>/^Redo/.test(x.title)).getBoundingClientRect(); out.pinned=Math.abs(r.right-(tb.right-4))<=2 && Math.abs(u.right-r.left)<=1; out.ai=document.querySelector('#${K}-page-toolbar .docx-ai-btn').getBoundingClientRect().left < document.getElementById('${K}-pt-bold').getBoundingClientRect().left; return out;`);
      ok('B, I and U are on screen without scrolling, 40px targets', vis.bold && vis.italic && vis.underline, JSON.stringify(vis));
      ok('Undo and Redo sit at the right end', vis.pinned, JSON.stringify(vis));
      // Scroll the row: Undo/Redo stay put.
      const before = await rect(`#${K}-page-toolbar .pt-btn[title^="Redo"]`);
      await js(`document.querySelector('#${K}-page-toolbar .docx-ribbonrow').scrollLeft=200; 1`); await sleep(100);
      const after = await rect(`#${K}-page-toolbar .pt-btn[title^="Redo"]`);
      const scrolled = await js(`return document.querySelector('#${K}-page-toolbar .docx-ribbonrow').scrollLeft;`);
      ok('the row scrolls sideways and Undo/Redo stay pinned while it does', (label !== 'phone' || scrolled > 0) && Math.abs(before.l - after.l) <= 1, scrolled + ' ' + JSON.stringify([before, after]));
      await js(`document.querySelector('#${K}-page-toolbar .docx-ribbonrow').scrollLeft=0; 1`);
      if (label === 'phone') await shot(`${who}-${w}-edit`);

      // Bold from the dock: select "First", tap B, the editor keeps focus.
      await js(`var ed=document.getElementById('${K}-page-editor'); ed.focus(); var p=ed.querySelectorAll('p')[0]; var t=p.firstChild; var r=document.createRange(); r.setStart(t,0); r.setEnd(t,5); var s=getSelection(); s.removeAllRanges(); s.addRange(r); 1`);
      await sleep(150);
      await tap(`#${K}-pt-bold`);
      ok('a tap on Bold keeps the editor focused (the keyboard stays up)', await js(`return document.activeElement===document.getElementById('${K}-page-editor');`), await js(`return document.activeElement && (document.activeElement.id||document.activeElement.className);`));
      ok('…and bolds the selection', await js(`var p=document.getElementById('${K}-page-editor').querySelectorAll('p')[0]; return /^<(b|strong)>First<\\/(b|strong)>/.test(p.innerHTML);`), await js(`return document.getElementById('${K}-page-editor').querySelectorAll('p')[0].innerHTML.slice(0,80);`));

      // The swap button: menus.
      await tap(`#${K}-page-toolbar .nb-dock-tog`);
      ok('the swap button shows the menus in the same row', await js(`var mb=document.querySelector('#${K}-page-toolbar .docx-menubar'); return getComputedStyle(mb).display==='flex' && getComputedStyle(document.querySelector('#${K}-page-toolbar .docx-ribbonrow')).display==='none' && [...mb.querySelectorAll('.docx-menu-btn')].map(b=>b.textContent).join(',').indexOf('File,Edit,View,Insert,Format')===0;`));
      ok('…in one row, still right under the header', Math.abs((await rect(`#${K}-page-toolbar`)).t - (await rect(`#${K}-mobile-header`)).b) <= 1 && (await rect(`#${K}-page-toolbar`)).h <= 56);
      await tap(`#${K}-page-toolbar .docx-menubar .docx-menu-btn:nth-child(5)`);
      const pop = await rect('.docx-pop');
      const dockTop = (await rect(`#${K}-page-toolbar .docx-menubar .docx-menu-btn:nth-child(5)`)).t;
      ok('a menu opens under its button, fully on screen', pop && pop.t >= dockTop && pop.b <= h + 1, JSON.stringify([pop, dockTop]));
      await js(`document.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true})); var p=document.querySelector('.docx-pop'); if(p) p.remove(); 1`);
      await tap(`#${K}-page-toolbar .nb-dock-tog`);
      ok('the swap button brings the formatting row back', await js(`return getComputedStyle(document.querySelector('#${K}-page-toolbar .docx-ribbonrow')).display==='flex';`));

      // The onscreen keyboard: a stand-in visualViewport 320px shorter.
      await js(`window.__vvFake={height:innerHeight-320, offsetTop:0, scale:1, width:innerWidth, addEventListener(){}, removeEventListener(){}}; Object.defineProperty(window,'visualViewport',{configurable:true,get(){return window.__vvFake;}}); window.dispatchEvent(new Event('resize')); 1`);
      await sleep(300);
      const kbTb = await rect(`#${K}-page-toolbar`);
      ok('with the keyboard up the ribbon stays right under the header, and the page gets room to scroll above the keyboard', Math.abs(kbTb.t - (await rect(`#${K}-mobile-header`)).b) <= 1 && /\bnb-kb\b/.test(await cls(K)) && await js(`return getComputedStyle(document.getElementById('${K}-root')).getPropertyValue('--nb-kb-space').trim()==='320px';`), JSON.stringify(kbTb));
      // Typing on the last line: the caret is kept above the dock.
      await js(`var ed=document.getElementById('${K}-page-editor'), last=ed.querySelector('p:last-child'); var r=document.createRange(); r.selectNodeContents(last); r.collapse(false); var s=getSelection(); s.removeAllRanges(); s.addRange(r); 1`);
      await js(`document.getElementById('${K}-page-editor').focus(); 1`);
      await c.send('Input.insertText', { text: ' more' });
      await sleep(400);
      const caret = await js(`var s=getSelection(), n=s.focusNode; var r=s.getRangeAt(0).getClientRects()[0]||(n.nodeType===1?n:n.parentElement).getBoundingClientRect(); return r.bottom;`);
      ok('typing on the last line keeps the caret above the keyboard', caret <= h - 320 - 4 && caret > 56, caret + ' vs keyboard top ' + (h - 320));
      await js(`delete window.visualViewport; window.dispatchEvent(new Event('resize')); 1`); await sleep(300);
      ok('keyboard down: the room goes, the ribbon stays put', !/\bnb-kb\b/.test(await cls(K)) && Math.abs((await rect(`#${K}-page-toolbar`)).t - (await rect(`#${K}-mobile-header`)).b) <= 1);
      // Scrolling up to read while editing: never pulled back to the caret (the browser's bars resizing fire resize events).
      await js(`var w=document.getElementById('${K}-page-editor-wrap'); w.scrollTop=w.scrollHeight; 1`); await sleep(200);
      await js(`document.getElementById('${K}-page-editor-wrap').scrollTop=100; window.dispatchEvent(new Event('resize')); window.visualViewport && window.visualViewport.dispatchEvent(new Event('resize')); 1`); await sleep(400);
      const stUp = await js(`return document.getElementById('${K}-page-editor-wrap').scrollTop;`);
      ok('scrolling up while editing stays where it was put (no snap back)', stUp === 100, stUp + ' ' + await js(`var w=document.getElementById('${K}-page-editor-wrap'); return [w.scrollHeight,w.clientHeight,getComputedStyle(w).overflowY,document.getElementById('${K}-root').className].join(' ');`));
      // The swap button never moves the page to the caret.
      await js(`var ed=document.getElementById('${K}-page-editor'), last=ed.querySelector('p:last-child'); var r=document.createRange(); r.selectNodeContents(last); r.collapse(false); var s=getSelection(); s.removeAllRanges(); s.addRange(r); document.getElementById('${K}-page-editor-wrap').scrollTop=0; 1`);
      await sleep(300);
      const st0 = await js(`return document.getElementById('${K}-page-editor-wrap').scrollTop;`);
      await tap(`#${K}-page-toolbar .nb-dock-tog`); await tap(`#${K}-page-toolbar .nb-dock-tog`); await sleep(300);
      ok('swapping the row with the caret elsewhere leaves the page where it was (no jump)', await js(`return document.getElementById('${K}-page-editor-wrap').scrollTop;`) === st0, st0);

      // The bar's mode button: back to reading.
      await tap(`${R} .nb-mh-mode`);
      ok('the bar\'s book button turns editing off and undocks', !/\bnb-medit\b|\bnb-mdock\b/.test(await cls(K)) && await js(`return !document.getElementById('${K}-btn-edit').checked && getComputedStyle(document.getElementById('${K}-page-toolbar')).display==='none';`));
      ok('…and the document kept the bold', await js(`return /<(b|strong)>First/.test(document.getElementById('${K}-page-editor').innerHTML);`));

      // ⋮
      await tap(`${R} .nb-mh-more`);
      const items = await js(`var m=document.querySelector('${R} .nb-mmenu'); return m ? [...m.querySelectorAll('.nb-mmi')].map(b=>b.textContent.trim()) : null;`);
      const mr = await rect(`${R} .nb-mmenu`);
      ok('⋮ opens its menu under the button, on screen', !!items && mr.t >= 50 && mr.r <= w && mr.l >= 0, JSON.stringify(mr));
      if (who === 'tony') ok('Tony\'s ⋮: Lock entry, Export PDF', items && items.join('|') === 'Lock entry|Export PDF', JSON.stringify(items));
      else ok('Veda\'s ⋮: Lock entry, Tags, Change template, Export PDF', items && items.join('|') === 'Lock entry|Tags|Change template|Export PDF', JSON.stringify(items));
      await js(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); 1`); await sleep(150);
      ok('a tap outside closes it', await js(`return !document.querySelector('${R} .nb-mmenu');`));
      if (who === 'veda') {
        await tap(`${R} .nb-mh-btn.nb-mh-mode`); // editing, so tags can be added
        await tap(`${R} .nb-mh-more`);
        await js(`[...document.querySelectorAll('${R} .nb-mmenu .nb-mmi')].find(b=>/Tags/.test(b.textContent)).click(); 1`); await sleep(300);
        ok('Tags opens a sheet holding her tag row (the "work" chip)', await js(`var s=document.querySelector('${R} .nb-mtags'); return !!s && !!s.querySelector('#bj-tags-row') && /work/.test(s.textContent);`));
        await tap('#bj-add-tag-input');
        await c.send('Input.insertText', { text: 'ideas' });
        await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await sleep(2800);
        ok('…a tag added there is saved', await js(`return (__fakeFs.docs['dashboards/journal']['e_e_1791000000001_alpha00001'].tags||[]).indexOf('ideas')>=0;`), await js(`return JSON.stringify(__fakeFs.docs['dashboards/journal']['e_e_1791000000001_alpha00001'].tags);`));
        if (label === 'phone') await shot(`${who}-${w}-tags`);
        await js(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); 1`); await sleep(150);
        ok('closing the sheet puts the tag row back in the title bar', await js(`var r=document.getElementById('bj-tags-row'); return !!r && r.parentNode.id==='bj-toolbar' && !document.querySelector('${R} .nb-mtags');`));
        await tap(`${R} .nb-mh-btn.nb-mh-mode`);
      }
      // + in the bar, and on the list.
      await tap(`${R} .nb-mh-new`);
      ok('the bar\'s + opens the template picker', await js(`return document.getElementById('${K}-template-modal').classList.contains('open');`));
      await js(`document.getElementById('${K}-close-modal').click(); 1`); await sleep(200);
      await tap(`#${K}-hamburger`);
      await tap(`${R} .nb-fab`);
      ok('the list\'s + opens the template picker, ON TOP of the list (what a finger reaches)', await js(`var m=document.getElementById('${K}-template-modal'); if(!m.classList.contains('open')) return false; var c=m.querySelector('.template-card[data-template="page"]').getBoundingClientRect(); var t=document.elementFromPoint(c.left+c.width/2, c.top+c.height/2); return !!t && !!t.closest('#${K}-template-modal');`));
      await js(`document.querySelector('#${K}-template-modal .template-card[data-template="page"]').click(); 1`); await sleep(1200);
      k = await cls(K);
      ok('a new page opens in the editor, editing, ribbon docked', /\bnb-mdoc\b/.test(k) && /\bnb-mdock\b/.test(k) && await js(`return document.getElementById('${K}-mobile-title').value==='' && document.querySelectorAll('#${K}-entries-list .entry-item').length===3;`), k);
    }

    // ── landscape tablet: the desktop layout, the ribbon docked ──
    console.log(`\n${who === 'tony' ? "T's" : "V's"} Notebook, landscape tablet 1180x820`);
    await size(1180, 820, true);
    await boot(who);
    ok('a touch screen this wide reads as coarse', await js(`return matchMedia('(pointer: coarse)').matches;`));
    let k = await cls(K);
    ok('desktop shell: the sidebar sits beside the page, no list screen', /\bnb-m\b/.test(k) && !/\bnb-shell\b|\bnb-mlist\b/.test(k) && (await rect(`#${K}-sidebar`)).w < 300, k);
    await js(`document.querySelector('#${K}-entries-list .entry-item').click(); 1`); await sleep(800);
    await js(`var b=document.getElementById('${K}-btn-edit'); if(!b.checked) b.click(); 1`); await sleep(500);
    const tb = await rect(`#${K}-page-toolbar`), main = await rect(`#${K}-main`);
    const bar = await rect(`#${K}-toolbar`);
    ok('editing: the ribbon is one row right under the title bar, across the page column', /\bnb-mdock\b/.test(await cls(K)) && Math.abs(tb.t - bar.b) <= 1 && Math.abs(tb.w - main.w) <= 1 && tb.h <= 56, JSON.stringify([tb, bar, main]));
    await shot(`${who}-1180-edit`);

    // ── desktop: untouched ──
    console.log(`\n${who === 'tony' ? "T's" : "V's"} Notebook, desktop 1440x900`);
    await size(1440, 900, false);
    await boot(who);
    k = await cls(K);
    ok('desktop: no phone/tablet classes at all', !/\bnb-(m|shell|mlist|mdoc|mdock)\b/.test(k), k);
    await js(`document.querySelector('#${K}-entries-list .entry-item').click(); 1`); await sleep(800);
    await js(`var b=document.getElementById('${K}-btn-edit'); if(!b.checked) b.click(); 1`); await sleep(500);
    ok('desktop: the ribbon stays on top, in the page (not fixed), menus shown', await js(`var t=document.getElementById('${K}-page-toolbar'); return getComputedStyle(t).position!=='fixed' && getComputedStyle(t.querySelector('.docx-menubar')).display!=='none' && t.getBoundingClientRect().top < 200;`));
    ok('desktop: no round button, no swap button', await js(`return getComputedStyle(document.querySelector('${R} .nb-fab')).display==='none' && (!document.querySelector('${R} .nb-dock-tog') || getComputedStyle(document.querySelector('${R} .nb-dock-tog')).display==='none');`));
  }

  // ── an instance (a host that is not index.html), on a phone ──
  console.log('\nAn instance on a phone (tests/live/fixtures/notebook-host.html)');
  await size(412, 915, true);
  const HOST = 'https://anthonyn99.github.io/A1/tests/live/fixtures/notebook-host.html';
  for (const [side, K, S] of [['tony', 'nb', 'nb_test'], ['veda', 'vn', 'vn_test']]) {
    if (only && only !== side) continue;
    await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
    await c.send('Page.navigate', { url: BASE + 'LifeHub/lifehub.js' }); await sleep(300);
    const seed = { ['dashboards/' + S]: { _order: ['e_1_alpha'], activeId: 'e_1_alpha', savedAt: T0 - 60000,
      e_e_1_alpha: { id: 'e_1_alpha', title: 'Alpha rules', template: 'page', created: T0 - 86400000, updated: T0 - 60000, tags: [], data: { html: '<p>Cut losers fast.</p>', attachments: [] }, rev: 1 } } };
    await js(`localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(seed))}); 1`);
    await c.send('Page.navigate', { url: HOST }); await sleep(1500);
    for (let i = 0; i < 60 && !(await js('return !!window.__hostReady;')); i++) await sleep(200);
    const extra = side === 'veda' ? { profile: 'veda', key: 'vn', store: 'vn_test', title: 'Veda Notes' } : {};
    await js('window.__mount(' + JSON.stringify(extra) + ').then(() => { window.__mounted = true; }, (e) => { window.__mountErr = String(e); }); 1');
    for (let i = 0; i < 75 && !(await js('return !!(window.__mounted || window.__mountErr);')); i++) await sleep(200);
    await sleep(1500);
    const present = await js(`return !!document.getElementById('${K}-root') && !window.__mountErr;`);
    if (!present) { ok(`${side} instance mounted`, false, await js('return window.__mountErr || "no root";')); continue; }
    ok(`${side} instance: home is its list`, /\bnb-mlist\b/.test(await cls(K)), await cls(K));
    await tap(`#${K}-entries-list .entry-item[data-entry-id="e_1_alpha"]`); await sleep(600);
    const k = await cls(K);
    ok(`${side} instance: wired (editor screen, one bar with Edit/New/⋮)`, /\bnb-mdoc\b/.test(k) && await js(`return !!document.querySelector('#${K}-mobile-header .nb-mh-more');`), k);
    ok(`${side} instance: the host page keeps its own header (nothing is covered)`, await js(`return !document.documentElement.hasAttribute('data-nb-doc');`));
    await js(`var b=document.getElementById('${K}-btn-edit'); if(!b.checked){ document.querySelector('#${K}-root .nb-fab').click(); } 1`); await sleep(500);
    const tb = await rect(`#${K}-page-toolbar`);
    ok(`${side} instance: editing puts the ribbon in one row right under its header`, /\bnb-mdock\b/.test(await cls(K)) && Math.abs(tb.t - (await rect(`#${K}-mobile-header`)).b) <= 1 && tb.h <= 56, JSON.stringify(tb));
    await shot(`instance-${side}-412`);
  }

  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
