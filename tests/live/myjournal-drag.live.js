// Theme overhaul phase 2: MyJournal's sidebar reorder runs on dragsort.js
// (MAGI's drag) and its resizable boxes on resizegrip.js (MAGI's corner grip).
// Real mouse, keyboard and touch input over CDP, asserting the order MyJournal
// actually SAVES (its localStorage cache, tony_journal_v3), not just the DOM.
//
//   1. desktop: rows carry a real grip button and no HTML5 draggable
//   2. desktop: mouse-drag a row by its title, saved order changes, the
//      drop's click does not open the entry, a plain click does
//   3. desktop: ↑/↓ on a focused grip moves the row and keeps focus on it
//   4. desktop: a search narrows the list and switches reordering off
//   5. phone width: a finger on the row scrolls, a finger on the grip drags
//   6. the AI prompt box has MAGI's grip: drag, click toggle, reload keeps it
//   7. Veda's Brainstorm Journal keeps its own handle (untouched)
//
// Run: node tests/live/myjournal-drag.live.js
'use strict';
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const ORIGIN = 'https://anthonyn99.github.io';

// Four live entries and one trashed one between them: a move must keep the
// trashed entry and must not be thrown off by it.
const T0 = 1790000000000;
const SEED = {
  entries: [
    { id: 'e_a', title: 'Alpha', template: 'page', created: T0, updated: T0, tags: [], data: { html: '<p>a</p>', attachments: [] } },
    { id: 'e_b', title: 'Bravo', template: 'page', created: T0, updated: T0, tags: [], data: { html: '<p>b</p>', attachments: [] } },
    { id: 'e_x', title: 'Trashed', template: 'page', created: T0, updated: T0, tags: [], trashed: T0, trashChangedAt: T0, data: { html: '', attachments: [] } },
    { id: 'e_c', title: 'Charlie', template: 'page', created: T0, updated: T0, tags: [], data: { html: '<p>c</p>', attachments: [] } },
    { id: 'e_d', title: 'Delta', template: 'page', created: T0, updated: T0, tags: [], data: { html: '<p>d</p>', attachments: [] } },
  ],
  activeId: null, deletedIds: [],
};

const saved = (c) => evalJs(c, "return JSON.stringify(JSON.parse(localStorage.getItem('tony_journal_v3')||'{\"entries\":[]}').entries.map(e=>e.id));").then(JSON.parse);
const shown = (c) => evalJs(c, "return JSON.stringify([...document.querySelectorAll('#tj-entries-list .entry-item')].map(r=>r.dataset.entryId));").then(JSON.parse);
const rect = async (c, js) => JSON.parse(await evalJs(c, `return JSON.stringify((() => { const b = (${js}).getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, top: b.top}; })());`));
const row = (id) => `document.querySelector('#tj-entries-list .entry-item[data-entry-id="${id}"]')`;

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
async function click(c, x, y) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(400);
}
async function touchDrag(c, x, y, dy, steps = 16) {
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * i) / steps }] });
    await sleep(16);
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(450);
}
async function load(c, w, h, mobile, keepStorage) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  if (!keepStorage) {
    await c.send('Page.navigate', { url: ORIGIN + '/A1/oneinbox.html' }); await sleep(800);
    await evalJs(c, `localStorage.clear(); localStorage.setItem('td6_mainDash','tony'); localStorage.setItem('tony_journal_v3', ${JSON.stringify(JSON.stringify(SEED))}); 1`);
  }
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  await sleep(9000);
  await evalJs(c, "var l=document.getElementById('th-boot-loader'); if(l) l.remove(); window._tonyNav('brainstormjournal'); 1");
  await sleep(2500);
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

  console.log('\nDesktop: the entry list');
  await load(c, 1440, 900, false);
  ok('the seeded entries are listed (trash hidden)', JSON.stringify(await shown(c)) === '["e_a","e_b","e_c","e_d"]', JSON.stringify(await shown(c)));
  ok('the list is an A1Drag list', await evalJs(c, "return document.getElementById('tj-entries-list').classList.contains('dsort');"));
  ok('every row has a real grip button', await evalJs(c, "return [...document.querySelectorAll('#tj-entries-list .entry-item')].every(r=>r.querySelector(':scope > button.dsort-grip.tj-grip'));"));
  ok('no HTML5 draggable or old handle left', await evalJs(c, "return !document.querySelector('#tj-entries-list [draggable=\"true\"], #tj-entries-list .entry-drag-handle');"));

  // Alpha by its title, down until its bottom edge passes Charlie's middle.
  const a = await rect(c, row('e_a') + ".querySelector('.entry-item-title')");
  const ra = await rect(c, row('e_a'));
  const rc = await rect(c, row('e_c'));
  await mouseDrag(c, a.x, a.y, 0, (rc.y + 4) - (ra.y + ra.h / 2));
  ok('mouse: Alpha dragged past Charlie lands after it (shown)', JSON.stringify(await shown(c)) === '["e_b","e_c","e_a","e_d"]', JSON.stringify(await shown(c)));
  ok('mouse: and that is the SAVED order, trashed entry kept', JSON.stringify(await saved(c)) === '["e_b","e_x","e_c","e_a","e_d"]', JSON.stringify(await saved(c)));
  ok('nothing left lifted', await evalJs(c, "return !document.querySelector('.dsort-drag') && !document.documentElement.classList.contains('dsort-grabbing');"));
  ok('the drop did not open the entry (its click was swallowed)', (await evalJs(c, "return JSON.parse(localStorage.getItem('tony_journal_v3')).activeId;")) == null);
  const d = await rect(c, row('e_d') + ".querySelector('.entry-item-title')");
  await click(c, d.x, d.y);
  ok('a plain click still opens an entry', await evalJs(c, "return !!document.querySelector('#tj-entries-list .entry-item.active[data-entry-id=e_d]');"));

  console.log('\nDesktop: keyboard');
  await evalJs(c, row('e_b') + ".querySelector('.tj-grip').focus(); 1");
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await sleep(400);
  ok('↓ on Bravo\'s grip moves it one place down (saved)', JSON.stringify(await saved(c)) === '["e_x","e_c","e_b","e_a","e_d"]', JSON.stringify(await saved(c)));
  ok('focus stays on Bravo\'s grip after the redraw', await evalJs(c, "var g=document.activeElement; return !!(g && g.classList.contains('tj-grip') && g.closest('.entry-item').dataset.entryId==='e_b');"));

  console.log('\nDesktop: a search turns reordering off');
  await evalJs(c, "var s=document.getElementById('tj-search-box'); s.value='a'; s.dispatchEvent(new Event('input',{bubbles:true})); 1");
  await sleep(400);
  ok('no grips while searching', await evalJs(c, "return document.querySelectorAll('#tj-entries-list .entry-item').length>0 && !document.querySelector('#tj-entries-list .tj-grip');"));
  await evalJs(c, "var s=document.getElementById('tj-search-box'); s.value=''; s.dispatchEvent(new Event('input',{bubbles:true})); 1");
  await sleep(300);

  console.log('\nDesktop: the AI prompt box grip');
  await evalJs(c, "var b=document.querySelector('#tj-root .docx-ai-btn'); if(b) b.click(); 1");
  await sleep(400);
  await evalJs(c, "var m=[...document.querySelectorAll('.docx-mi')].find(x=>/Edit prompts/.test(x.textContent)); if(m) m.click(); 1");
  await sleep(700);
  const hasGrip = await evalJs(c, "return !!document.querySelector('.docx-ait-pane .docx-ta-wrap > .a1-grip');");
  ok('the prompt box carries MAGI\'s grip (a real button)', hasGrip && await evalJs(c, "var g=document.querySelector('.docx-ait-pane .a1-grip'); return g.tagName==='BUTTON' && /Drag to resize/.test(g.title);"));
  if (hasGrip) {
    ok('the native resize corner is off', await evalJs(c, "return getComputedStyle(document.querySelector('.docx-ait-pane .docx-prompt-ta')).resize==='none';"));
    const ta0 = await rect(c, "document.querySelector('.docx-ait-pane .docx-prompt-ta')");
    const g = await rect(c, "document.querySelector('.docx-ait-pane .a1-grip')");
    await mouseDrag(c, g.x, g.y, 0, -80);
    const ta1 = await rect(c, "document.querySelector('.docx-ait-pane .docx-prompt-ta')");
    ok('drag up 80px shrinks the box by about that much', Math.abs((ta0.h - ta1.h) - 80) <= 4, `${ta0.h} -> ${ta1.h}`);
    ok('the height is remembered', await evalJs(c, "return localStorage.getItem('a1.h.mj.ai-prompt');") === String(Math.round(ta1.h)), await evalJs(c, "return localStorage.getItem('a1.h.mj.ai-prompt');"));
    await c.send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(shotPath('p2-prompt-grip'), Buffer.from(r.result.data, 'base64')));
    // The dialog is centred, so the grip moves by half the change: re-measure.
    const g1 = await rect(c, "document.querySelector('.docx-ait-pane .a1-grip')");
    await click(c, g1.x, g1.y);
    ok('a click hands a sized box back to auto', await evalJs(c, "var t=document.querySelector('.docx-ait-pane .docx-prompt-ta'); return t.style.height==='' && !t.hasAttribute('data-user-h') && localStorage.getItem('a1.h.mj.ai-prompt')===null;"));
    const g2 = await rect(c, "document.querySelector('.docx-ait-pane .a1-grip')");
    await click(c, g2.x, g2.y);
    const h2 = await evalJs(c, "return document.querySelector('.docx-ait-pane .docx-prompt-ta').style.height;");
    ok('a second click expands it', /px$/.test(h2) && parseInt(h2, 10) >= 260, h2);

    console.log('\nDesktop: reload keeps the chosen height');
    await load(c, 1440, 900, false, true);
    await evalJs(c, "var b=document.querySelector('#tj-root .docx-ai-btn'); if(b) b.click(); 1"); await sleep(400);
    await evalJs(c, "var m=[...document.querySelectorAll('.docx-mi')].find(x=>/Edit prompts/.test(x.textContent)); if(m) m.click(); 1"); await sleep(700);
    ok('after a reload the prompt box opens at the height chosen', await evalJs(c, "var t=document.querySelector('.docx-ait-pane .docx-prompt-ta'); return t ? t.style.height : null;") === h2, await evalJs(c, "var t=document.querySelector('.docx-ait-pane .docx-prompt-ta'); return t ? t.style.height : null;"));
  }

  console.log('\nPhone width: touch');
  await load(c, 390, 844, true);
  await evalJs(c, "var h=document.getElementById('tj-hamburger'); if(h) h.click(); 1");
  await sleep(600);
  const o1 = await saved(c);
  const t0 = await rect(c, row('e_a') + ".querySelector('.entry-item-title')");
  const r0 = await rect(c, row('e_a'));
  await touchDrag(c, t0.x, t0.y, r0.h * 2 + 6);
  ok('a finger on the row (not the grip) does not reorder', JSON.stringify(await saved(c)) === JSON.stringify(o1), JSON.stringify(await saved(c)));
  await evalJs(c, "var h=document.getElementById('tj-hamburger'); var sb=document.getElementById('tj-sidebar'); if(h && sb && sb.getBoundingClientRect().right<=0) h.click(); 1");
  await sleep(500);
  ok('the grip shows on touch without hover', parseFloat(await evalJs(c, `return getComputedStyle(${row('e_a')}.querySelector('.tj-grip')).opacity;`)) > 0.3);
  const gp = await rect(c, row('e_a') + ".querySelector('.tj-grip')");
  await touchDrag(c, gp.x, gp.y, r0.h * 2 + 6);
  ok('a finger on the grip drags: Alpha two rows down lands third (saved)', JSON.stringify(await saved(c)) === '["e_b","e_x","e_c","e_a","e_d"]', JSON.stringify(await saved(c)));
  await c.send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(shotPath('p2-journal-touch-after'), Buffer.from(r.result.data, 'base64')));

  console.log('\nVeda\'s Brainstorm Journal is untouched');
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 0 });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/oneinbox.html' }); await sleep(800);
  await evalJs(c, "localStorage.clear(); localStorage.setItem('td6_mainDash','veda'); 1");
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' }); await sleep(9000);
  await evalJs(c, "var l=document.getElementById('th-boot-loader'); if(l) l.remove(); window._vedaNav('journal'); 1"); await sleep(2000);
  ok('her list is not an A1Drag list', await evalJs(c, "var l=document.getElementById('bj-entries-list'); return !!l && !l.classList.contains('dsort');"));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
