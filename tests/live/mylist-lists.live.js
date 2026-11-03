// LIVE test -- MyList list types + drag-and-drop, in a real (headless) browser
// with REAL pointer input (CDP Input events). Not run by run-all.js.
// Run: node tests/live/mylist-lists.live.js
//
// Firestore is never reached: the Firebase module is blocked at the network
// (see cdp.js) and the page is handed a fixture through the same window hooks
// the module would install (_mlLoad/_mlSave/_mlReady). Saves land in
// window.__saves so the test can read exactly what would have been written.
//
//   1. Existing lists get an INFERRED type (no data rewrite) — itinerary,
//      packing, to-do, shopping — shown on the header pill.
//   2. "+ New list" opens the type picker: 6 types, the suggested name follows
//      the type until you type your own, Create makes a typed list.
//   3. The pill changes a list's type; Manual + Edit show that type's fields
//      (Days / Time for an itinerary), and a time shows on the row.
//   4. The price-watch eye only appears on shopping lists.
//   5. An AI reply with when + listType + a typed new list is applied.
//   6. Mouse drag reorders items the MAGI way — the real row moves (no copy,
//      no jump on pick-up), neighbours slide aside — and moves an item into
//      another group; Escape mid-drag puts it back.
//   7. Phone width + touch: dragging a list tab to the screen edge scrolls the
//      tab bar so it can be dropped on a list that started off-screen.
//   8. View tabs still drag; no page errors.
'use strict';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');

const URL = 'https://anthonyn99.github.io/A1/mylist.html';
const mk = (name, extra) => Object.assign({ id: 'L_' + name.replace(/\W+/g, '').toLowerCase(), name, stores: [], items: [], createdAt: 1 }, extra || {});
const it = (id, name, extra) => Object.assign({ id, name, qty: '', store: '', desc: '', done: false }, extra || {});
const FIXTURE = {
  tony: { lists: [
    mk('Denver Itinerary', { items: [it('r1', 'Red Rocks Park & Amphitheater'), it('r2', 'Union Station'), it('r3', 'Show 16th St Mall'), it('r4', 'Larimer Sqr & Auraria')] }),
    mk('Shopping', { stores: ['Costco', 'Target'], items: [it('s1', 'Milk', { store: 'Costco' }), it('s2', 'Eggs', { store: 'Costco' }), it('s3', 'Bread', { store: 'Target' }), it('s4', 'Paper Towels')] }),
    mk('Travel Checklist: Items', { items: [it('p1', 'Laptop', { done: true }), it('p2', 'Phone', { done: true })] }),
    mk('Travel Checklist: To Do', { items: [it('t1', 'Check in for flights', { qty: '2', desc: 'both ways' })] }),
    ...['Gifts', 'Movies', 'Books', 'Projects', 'Ideas', 'Errands', 'Garden'].map((n) => mk(n)),
  ] },
  veda: { lists: [] }, locks: {}, lockV: {},
};
const BOOT = `(()=>{ if(window.top!==window) return;
  try{ localStorage.setItem('ml_fav_profile','tony'); localStorage.removeItem('ml_last_list_tony'); }catch(e){}
  window.__saves=[];
  window._mlLoad=()=>Promise.resolve(JSON.parse(${JSON.stringify(JSON.stringify(FIXTURE))}));
  window._mlLoadOk=true;
  window._mlSave=(d)=>{ window.__saves.push(JSON.parse(JSON.stringify(d))); };
  window._mlReady=true;
  window.__errs=[]; window.addEventListener('error', e=>window.__errs.push(String(e.message)));
})();`;

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 200) + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 400) + ']' : '')); }
};
const waitFor = async (c, expr, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await evalJs(c, expr)) return true; } catch {} await sleep(150); }
  return false;
};
const shot = async (c, name) => {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64'));
};
const rect = async (c, sel) => JSON.parse(await evalJs(c, `return JSON.stringify((() => { const e = ${sel}; const b = e.getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2, l: b.left, r: b.right, t: b.top, w: b.width, h: b.height}; })())`));
const click = async (c, sel) => {
  const p = await rect(c, sel);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(150);
};

async function mouseDrag(c, x, y, x2, y2, { steps = 16, cancel = false, mid = null } = {}) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + ((x2 - x) * i) / steps, y: y + ((y2 - y) * i) / steps, button: 'left', buttons: 1 });
    await sleep(18);
  }
  if (mid) await mid();
  if (cancel) await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(60);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
  await sleep(400);
}

(async () => {
  const c = await connect();
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text); });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  const inj = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOT });
  await c.send('Page.navigate', { url: URL });
  ok('app boots into Tony', await waitFor(c, `document.getElementById('app').style.display==='flex' && !!document.querySelector('#lists-bar .list-chip')`));
  const lastSave = `(window.__saves[window.__saves.length-1]||null)`;   // no ';' — evalJs treats ';' as statements

  // ── 1. inferred types ────────────────────────────────────────────────────
  const pillFor = async (name) => {
    await evalJs(c, `const ch=[...document.querySelectorAll('#lists-bar .list-chip')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(name)})); ch.click(); return 1`);
    await sleep(120);
    return evalJs(c, `document.querySelector('.lt-pill') ? document.querySelector('.lt-pill').textContent.trim() : ''`);
  };
  ok('Denver Itinerary → Itinerary', (await pillFor('Denver Itinerary')) === 'Itinerary');
  ok('Travel Checklist: Items → Packing', (await pillFor('Travel Checklist: Items')) === 'Packing');
  ok('Travel Checklist: To Do → To-Do', (await pillFor('Travel Checklist: To Do')) === 'To-Do');
  ok('Shopping → Shopping', (await pillFor('Shopping')) === 'Shopping');
  ok('inference writes nothing', (await evalJs(c, `window.__saves.length`)) === 0);

  // ── 4. eye only on shopping ───────────────────────────────────────────────
  ok('shopping rows have the price-watch eye', (await evalJs(c, `document.querySelectorAll('#items-container .li-watch-btn').length`)) === 4);
  await pillFor('Denver Itinerary');
  ok('itinerary rows have no price-watch eye', (await evalJs(c, `document.querySelectorAll('#items-container .li-watch-btn').length`)) === 0);
  ok('bar placeholder follows the type', (await evalJs(c, `document.getElementById('float-text').placeholder`)) === 'Add places, times, plans…');

  // ── 2. New list picker ────────────────────────────────────────────────────
  await evalJs(c, `document.getElementById('new-list-btn').click(); return 1`);
  ok('desktop: New list is a labelled button outside the scrolling strip', await evalJs(c, `const n=document.getElementById('new-list-btn'); return !document.getElementById('lists-bar').contains(n) && n.textContent.includes('New list') && getComputedStyle(n.querySelector('.nl-txt')).display!=='none'`));
  ok('picker opens with 6 types', await waitFor(c, `document.getElementById('lt-overlay').classList.contains('show') && document.querySelectorAll('#lt-grid .lt-card').length===6`));
  ok('Shopping preselected, name Groceries', (await evalJs(c, `document.querySelector('.lt-card.on b').textContent+'|'+document.getElementById('lt-name').value`)) === 'Shopping|Groceries');
  await shot(c, 'mylist-picker-desktop');
  await click(c, `[...document.querySelectorAll('.lt-card')].find(e=>e.textContent.includes('Itinerary'))`);
  ok('picking Itinerary swaps the suggested name', (await evalJs(c, `document.getElementById('lt-name').value`)) === 'Trip Itinerary');
  await evalJs(c, `document.getElementById('lt-name').value='Boulder Weekend'; return 1`);
  await click(c, `[...document.querySelectorAll('.lt-card')].find(e=>e.textContent.includes('Packing'))`);
  ok('a typed name survives a type change', (await evalJs(c, `document.getElementById('lt-name').value`)) === 'Boulder Weekend');
  await click(c, `document.getElementById('lt-ok')`);
  ok('picker closes', !(await evalJs(c, `document.getElementById('lt-overlay').classList.contains('show')`)));
  const created = await evalJs(c, `const s=${lastSave}; const l=s&&s.tony.lists.find(x=>x.name==='Boulder Weekend'); return l?JSON.stringify({type:l.type,items:l.items.length}):''`);
  ok('new typed list saved', created === JSON.stringify({ type: 'packing', items: 0 }), created);
  ok('new list is active and its chip is in view', await waitFor(c, `const a=document.querySelector('#lists-bar .list-chip.active'); const b=document.getElementById('lists-bar').getBoundingClientRect(); const r=a.getBoundingClientRect(); return a.textContent.includes('Boulder Weekend') && r.right<=b.right+1 && r.left>=b.left-1`, 2000));
  ok('empty state shows a typed example', (await evalJs(c, `document.querySelector('#list-view .empty').textContent`)).includes('socks'));
  // Escape closes without creating
  await evalJs(c, `document.getElementById('new-list-btn').click(); return 1`);
  await sleep(100);
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(100);
  const escState = await evalJs(c, `JSON.stringify({shown:document.getElementById('lt-overlay').classList.contains('show'), lists:${lastSave}.tony.lists.length})`);
  ok('Escape closes the picker without creating', escState === JSON.stringify({ shown: false, lists: 12 }), escState);

  // ── 3. change type + typed fields ─────────────────────────────────────────
  await pillFor('Gifts');
  await click(c, `document.querySelector('.lt-pill')`);
  ok('pill opens the picker in change mode (no name box)', await evalJs(c, `document.getElementById('lt-overlay').classList.contains('show') && document.getElementById('lt-name-wrap').style.display==='none'`));
  await click(c, `[...document.querySelectorAll('.lt-card')].find(e=>e.textContent.includes('Itinerary'))`);
  const tapState = await evalJs(c, `JSON.stringify({pill:document.querySelector('.lt-pill').textContent.trim(), saved:${lastSave}.tony.lists.find(x=>x.name==='Gifts').type||null})`);
  ok('one tap changes the type', tapState === JSON.stringify({ pill: 'Itinerary', saved: 'itinerary' }), tapState);
  await evalJs(c, `ML.toggleManual(); return 1`);
  ok('Manual shows Days + Time for an itinerary', await evalJs(c, `const t=document.getElementById('manual-pop').textContent; return t.includes('Days') && t.includes('Time') && !document.getElementById('add-qty') && !!document.getElementById('add-when')`));
  await evalJs(c, `document.getElementById('add-name').value='Pearl Street Mall'; document.getElementById('add-when').value='2:00 PM'; document.getElementById('add-store').value='Saturday'; ML.addItem(); return 1`);
  ok('added item shows its time and group', await evalJs(c, `const r=[...document.querySelectorAll('#items-container .item')].find(e=>e.textContent.includes('Pearl Street Mall')); return !!r && r.querySelector('.when-tag').textContent.includes('2:00 PM') && document.querySelector('.store-group-h').textContent.includes('Saturday')`));
  ok('item saved with when', (await evalJs(c, `JSON.stringify(${lastSave}.tony.lists.find(x=>x.name==='Gifts').items[0])`)).includes('"when":"2:00 PM"'));
  await evalJs(c, `ML.toggleManual(); return 1`);
  const gid = await evalJs(c, `${lastSave}.tony.lists.find(x=>x.name==='Gifts').items[0].id`);
  await evalJs(c, `ML.startEdit(${JSON.stringify(gid)}); return 1`);
  ok('edit form has the time field', await evalJs(c, `!!document.getElementById('edit-when-${gid}') && document.getElementById('edit-when-${gid}').value==='2:00 PM'`));
  await evalJs(c, `document.getElementById('edit-when-${gid}').value='3:30 PM'; ML.saveEdit(${JSON.stringify(gid)}); return 1`);
  ok('edit saves the time', (await evalJs(c, `${lastSave}.tony.lists.find(x=>x.name==='Gifts').items[0].when`)) === '3:30 PM');

  // ── 5. AI reply applied (fetch stubbed) ───────────────────────────────────
  await pillFor('Denver Itinerary');
  await evalJs(c, `window.__aiBody=null; const real=window.fetch; window.fetch=(u,o)=>{ if(String(u).includes('/list/parse')){ window.__aiBody=JSON.parse(o.body);
     const items=window.__aiBody.items.map(x=>({...x})); items[0].store='Saturday'; items[0].when='Morning';
     items.push({name:'Dinner at Linger', qty:'', when:'7:30 PM', store:'Saturday', desc:'reservation under Patel', done:false});
     return Promise.resolve(new Response(JSON.stringify({ok:true, items, stores:['Saturday'], note:'Planned Saturday.', newList:{name:'Denver Packing', type:'packing', stores:[], items:[{name:'Sunscreen', when:'', qty:'', store:'', desc:'travel size', done:false}]}}),{status:200,headers:{'Content-Type':'application/json'}})); } return real(u,o); }; return 1`);
  await evalJs(c, `document.getElementById('float-text').value='saturday morning red rocks, dinner at linger at 7:30 under Patel, and start a packing list'; ML.sendFloatText(); return 1`);
  await waitFor(c, `!!window.__aiBody`);
  await sleep(300);
  const sent = await evalJs(c, `JSON.stringify({t:window.__aiBody.listType,n:window.__aiBody.listName,d:!!window.__aiBody.today})`);
  ok('request carries list type, name and today', sent === JSON.stringify({ t: 'itinerary', n: 'Denver Itinerary', d: true }), sent);
  const den = await evalJs(c, `const l=${lastSave}.tony.lists.find(x=>x.name==='Denver Itinerary'); return JSON.stringify({n:l.items.length, w:l.items[0].when, din:l.items.find(i=>i.name==='Dinner at Linger')})`);
  ok('AI items applied with when', /"n":5/.test(den) && /"w":"Morning"/.test(den) && /7:30 PM/.test(den), den);
  ok('AI new list created with its type and switched to', (await evalJs(c, `JSON.stringify(${lastSave}.tony.lists.find(x=>x.name==='Denver Packing'))`)).includes('"type":"packing"') && (await evalJs(c, `document.querySelector('.lt-pill').textContent.trim()`)) === 'Packing');

  // ── 6. mouse drag of items ────────────────────────────────────────────────
  await pillFor('Denver Itinerary');
  // ungrouped items sit under the "Unscheduled" header (Saturday group exists now)
  ok('ungrouped header uses the type label', (await evalJs(c, `[...document.querySelectorAll('.store-group-h')].map(h=>h.textContent.trim()).join('|')`)) === 'Saturday|Unscheduled');
  const order = `[...document.querySelectorAll('#items-container .item')].map(e=>e.querySelector('.nm').textContent).join(' | ')`;
  const before = await evalJs(c, order);
  const a = await rect(c, `[...document.querySelectorAll('#items-container .item')].find(e=>e.textContent.includes('Union Station'))`);
  const z = await rect(c, `[...document.querySelectorAll('#items-container .item')].find(e=>e.textContent.includes('Larimer'))`);
  // pick-up must not jump: press, pull 6px, and the row is still where it was (+6)
  const top0 = a.t;
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y + 6, button: 'left', buttons: 1 });
  await sleep(60);
  const pick = await evalJs(c, `const r=document.querySelector('#items-container .dsort-drag'); return r ? r.getBoundingClientRect().top : null`);
  ok('pick-up does not jump: the row stays under the pointer', pick !== null && Math.abs(pick - (top0 + 6)) <= 2, top0 + ' → ' + pick);
  let slid = null;
  const ty = z.y - 2;                      // inside the list (the row is held within it, as in MAGI)
  for (let i = 1; i <= 16; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y + 6 + ((ty - a.y - 6) * i) / 16, button: 'left', buttons: 1 }); await sleep(18); }
  await sleep(60);
  slid = await evalJs(c, `return JSON.stringify({copies:document.querySelectorAll('body > .item, body > .list-chip').length, src:(()=>{const r=document.querySelector('#items-container .dsort-drag'); if(!r) return null; const b=r.getBoundingClientRect(); return Math.round(b.top+b.height/2);})(), live:!!document.querySelector('#items-container .dsort-on'), moved:[...document.querySelectorAll('#items-container .item:not(.dsort-drag)')].filter(e=>e.style.transform).length})`);
  const sj = JSON.parse(slid);
  ok('while dragging: the real row follows the pointer (no copy), neighbours slide aside', sj.copies === 0 && sj.live && sj.moved > 0 && Math.abs(sj.src - ty) <= 3, slid + ' pointer=' + Math.round(ty));
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x, y: ty, button: 'left', clickCount: 1 });
  await sleep(400);
  const after = await evalJs(c, order);
  ok('drop reorders: Union Station after Larimer', after.indexOf('Larimer') < after.indexOf('Union Station') && after !== before, after);
  ok('drag leaves no transforms behind', await evalJs(c, `!document.querySelector('.dsort-drag') && ![...document.querySelectorAll('#items-container .item')].some(e=>e.style.transform)`));
  // into another group: drag "Show 16th St Mall" up under the Saturday header
  const s = await rect(c, `[...document.querySelectorAll('#items-container .item')].find(e=>e.textContent.includes('16th'))`);
  const h = await rect(c, `document.querySelector('.store-group-h')`);
  await mouseDrag(c, s.x, s.y, s.x, h.y + h.h + 6);
  ok('dragging under a group header moves it into that group', (await evalJs(c, `${lastSave}.tony.lists.find(x=>x.name==='Denver Itinerary').items.find(i=>i.name==='Show 16th St Mall').store`)) === 'Saturday');
  // Escape cancels
  const b2 = await evalJs(c, order);
  const r1 = await rect(c, `document.querySelectorAll('#items-container .item')[0]`);
  const r3 = await rect(c, `document.querySelectorAll('#items-container .item')[3]`);
  await mouseDrag(c, r1.x, r1.y, r1.x, r3.y + 10, { cancel: true });
  ok('Escape mid-drag puts it back', (await evalJs(c, order)) === b2);
  // the first click after a drop still works
  await click(c, `[...document.querySelectorAll('#lists-bar .list-chip')].find(e=>e.textContent.includes('Shopping'))`);
  ok('a click after a drag still opens a list', (await evalJs(c, `document.querySelector('.lt-pill').textContent.trim()`)) === 'Shopping');

  // ── 8. view tab drag (desktop) ────────────────────────────────────────────
  const vt = `[...document.querySelectorAll('#view-switch .vs-tab')].map(e=>e.dataset.id).join(',')`;
  const v0 = await evalJs(c, vt);
  const t0r = await rect(c, `document.querySelectorAll('#view-switch .vs-tab')[0]`);
  const t2r = await rect(c, `document.querySelectorAll('#view-switch .vs-tab')[2]`);
  await mouseDrag(c, t0r.x, t0r.y, t2r.x + t2r.w * 0.3, t0r.y);
  const v1 = await evalJs(c, vt);
  ok('view tabs reorder by drag', v1 !== v0 && v1.split(',')[0] !== v0.split(',')[0], v0 + ' → ' + v1);
  await mouseDrag(c, (await rect(c, `[...document.querySelectorAll('#view-switch .vs-tab')].find(e=>e.dataset.id===${JSON.stringify(v0.split(',')[0])})`)).x, t0r.y, t0r.l + 4, t0r.y);
  ok('…and back', (await evalJs(c, vt)) === v0, await evalJs(c, vt));

  // ── 7. phone width + touch: tab bar auto-scroll ───────────────────────────
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(300);
  await evalJs(c, `document.getElementById('lists-bar').scrollLeft=0; return 1`);
  await sleep(200);
  const chipsOrder = `[...document.querySelectorAll('#lists-bar .list-chip[data-id]')].map(e=>e.textContent.replace(/\\s*\\d+$/,'').trim()).join(' | ')`;
  const c0 = await evalJs(c, chipsOrder);
  const bar = await rect(c, `document.getElementById('lists-bar')`);
  ok('New list stays pinned in view at phone width (a round +)', await evalJs(c, `const n=document.getElementById('new-list-btn').getBoundingClientRect(); return n.left>=0 && n.right<=window.innerWidth && Math.abs(n.width-n.height)<2 && getComputedStyle(document.querySelector('#new-list-btn .nl-txt')).display==='none'`));
  ok('bar overflows at phone width and shows a right fade', await evalJs(c, `const b=document.getElementById('lists-bar'); return b.scrollWidth>b.clientWidth && b.classList.contains('fade-r')`));
  const lastOff = await evalJs(c, `const b=document.getElementById('lists-bar').getBoundingClientRect(); const l=[...document.querySelectorAll('#lists-bar .list-chip[data-id]')].pop().getBoundingClientRect(); return l.left>b.right`);
  ok('the last list starts off-screen', lastOff);
  const first = await rect(c, `document.querySelector('#lists-bar .list-chip[data-id]')`);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: first.x, y: first.y }] });
  await sleep(320);                                   // hold to pick up
  const edgeX = bar.r - 8;
  for (let i = 1; i <= 10; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: first.x + ((edgeX - first.x) * i) / 10, y: first.y }] }); await sleep(20); }
  // hold at the edge — the bar must scroll under the finger
  const sl0 = await evalJs(c, `document.getElementById('lists-bar').scrollLeft`);
  for (let i = 0; i < 90; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: edgeX + (i % 2), y: first.y }] }); await sleep(16); }
  const sl1 = await evalJs(c, `document.getElementById('lists-bar').scrollLeft`);
  ok('holding a dragged tab at the edge scrolls the tab bar', sl1 > sl0 + 100, sl0 + ' → ' + sl1);
  await shot(c, 'mylist-tab-drag-mobile');
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(450);
  const c1 = await evalJs(c, chipsOrder);
  const moved = c0.split(' | ')[0];
  ok('the tab lands among lists that were off-screen', c1.split(' | ').indexOf(moved) >= c1.split(' | ').length - 3 && c1 !== c0, c1);
  ok('tab order saved', (await evalJs(c, `${lastSave}.tony.lists.map(l=>l.name).join(' | ')`)) === c1);
  ok('New list is still in view after the tab bar scrolled', await evalJs(c, `const n=document.getElementById('new-list-btn').getBoundingClientRect(); return n.right<=window.innerWidth && n.left>=0`));
  ok('page did not scroll sideways', (await evalJs(c, `window.scrollX`)) === 0);
  // touch on an item: a quick swipe scrolls, a hold drags
  await pillFor('Denver Itinerary');
  await sleep(200);
  const io = await evalJs(c, order);
  const i0 = await rect(c, `document.querySelectorAll('#items-container .item')[0]`);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: i0.x - 40, y: i0.y }] });
  for (let i = 1; i <= 8; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: i0.x - 40, y: i0.y + i * 12 }] }); await sleep(10); }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
  ok('a quick touch swipe on a row does not drag it', (await evalJs(c, order)) === io);
  const i2 = await rect(c, `document.querySelectorAll('#items-container .item')[2]`);
  const g0 = { x: i0.x - 40, y: i0.y };
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: g0.x, y: g0.y }] });
  await sleep(400);   // a held finger picks the row up (no grips: Tony, 2026-10-02)
  for (let i = 1; i <= 12; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: g0.x, y: g0.y + ((i2.y + 12 - g0.y) * i) / 12 }] }); await sleep(18); }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(450);
  ok('a held finger reorders a row on touch', (await evalJs(c, order)) !== io, await evalJs(c, order));
  // picker at phone width = bottom sheet, 2 columns, fits
  await evalJs(c, `document.getElementById('new-list-btn').click(); return 1`);
  await sleep(250);
  ok('phone picker is a bottom sheet that fits the screen', await evalJs(c, `const b=document.getElementById('lt-box').getBoundingClientRect(); return b.bottom<=window.innerHeight+1 && b.width>=window.innerWidth-1 && getComputedStyle(document.getElementById('lt-grid')).gridTemplateColumns.split(' ').length===2`));
  await shot(c, 'mylist-picker-mobile');
  await evalJs(c, `ML.ltClose(); return 1`);

  const pageErrs = errs.concat(await evalJs(c, `window.__errs`)).filter((e) => !/firebase|gstatic|googleapis|Failed to fetch|import/i.test(String(e)));
  ok('no page errors', pageErrs.length === 0, pageErrs.join(' || '));

  await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.result.identifier });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await c.send('Emulation.clearDeviceMetricsOverride');
  await c.send('Page.navigate', { url: 'about:blank' });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
