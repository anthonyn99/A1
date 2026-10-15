// LIVE test -- MyList links, on BOTH sides (Tony and Veda), in a real
// (headless) browser against the deployed page and the real personal-ai worker.
// Run: node tests/live/mylist-links.live.js
//
// Firestore is never reached (fixture through the _mlLoad/_mlSave hooks, as in
// mylist-lists.live.js). Checks:
//   1. A linked item shows its photo, a store chip that opens the page in a new
//      tab, and its price; an item without a link is unchanged.
//   2. Manual: a pasted link with no name adds an item that fills in its name,
//      photo and store from the page.
//   3. Edit shows the link; clearing it removes the link.
//   4. Rich text pasted into the bar keeps its hyperlinks as URLs.
//   5. Sending links to the AI adds clean items carrying their links.
//   Screenshots at 390 and 1280 for each side.
'use strict';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');

const URL = 'https://anthonyn99.github.io/A1/mylist.html';
const SAMS = 'https://www.samsclub.com/ip/members-mark-italian-herb-grilled-chicken-breast-5-count/13590050893';
const WALMART = 'https://www.walmart.com/ip/Great-Value-Large-White-Eggs-12-Count/145051970';
const TARGET = 'https://www.target.com/p/good-gather-large-grade-a-eggs-12ct/-/A-14713534';
const list = () => ({ id: 'L_shop', name: 'Groceries', type: 'shopping', stores: ["Sam's Club"], createdAt: 1, items: [
  { id: 'a', name: 'Italian Herb Grilled Chicken Breasts', qty: '', store: "Sam's Club", desc: '', done: false,
    link: { url: SAMS, title: "Member's Mark Italian Herb Grilled Chicken Breasts", image: 'https://i5.samsclubimages.com/asr/5cfbe04b-9ef5-4ab2-8aea-1a659ce01462.b0ab5affda49f73ea9daa3160feacc9d.jpeg', price: '$12.94', site: "Sam's Club" } },
  { id: 'b', name: 'Tofu', qty: '', store: '', desc: 'find somewhere to get', done: false },
] });
const boot = (who) => `(()=>{ if(window.top!==window) return;
  try{ localStorage.setItem('ml_fav_profile','${who}'); localStorage.removeItem('ml_last_list_${who}'); }catch(e){}
  window.__saves=[];
  window._mlLoad=()=>Promise.resolve(${JSON.stringify({ tony: { lists: [list()] }, veda: { lists: [list()] }, locks: {}, lockV: {} })});
  window._mlLoadOk=true;
  window._mlSave=(d)=>{ window.__saves.push(JSON.parse(JSON.stringify(d))); };
  window._mlReady=true;
})();`;

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 200) + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 400) + ']' : '')); }
};
const waitFor = async (c, expr, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await evalJs(c, expr)) return true; } catch {} await sleep(200); }
  return false;
};
const shot = async (c, name) => {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64'));
  return shotPath(name);
};
const items = `(()=>{ const s=window.__saves[window.__saves.length-1]; const p=s&&(s.tony||s.veda); return s ? (s[window.__who]||p).lists[0].items : null; })()`;

(async () => {
  const c = await connect();
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text); });

  for (const who of ['tony', 'veda']) {
    console.log('\n── ' + who);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const inj = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: boot(who) });
    await c.send('Page.navigate', { url: URL + '?t=' + Date.now() });
    ok('boots into ' + who, await waitFor(c, `document.getElementById('app').style.display==='flex' && document.body.dataset.profile===${JSON.stringify(who)} && !!document.querySelector('#items-container .item')`));
    await evalJs(c, `window.__who=${JSON.stringify(who)}; return 1`);

    // 1. linked row
    const row = await evalJs(c, `const r=document.querySelector('.item[data-id="a"]'); const a=r.querySelector('.lk-chip'); return JSON.stringify({img:!!r.querySelector('img.lk-thumb'), href:a&&a.href, tgt:a&&a.target, site:a&&a.textContent.trim(), price:(r.querySelector('.lk-price')||{}).textContent})`);
    const R = JSON.parse(row);
    ok('linked row: photo, store chip opening the page in a new tab, price', R.img && R.href === SAMS && R.tgt === '_blank' && R.site === "Sam's Club" && R.price === '$12.94', row);
    ok('plain row unchanged (no photo, no chip)', await evalJs(c, `const r=document.querySelector('.item[data-id="b"]'); return !r.querySelector('.lk-thumb') && !r.querySelector('.lk-chip')`));
    ok('photo loads', await waitFor(c, `const i=document.querySelector('.item[data-id="a"] img.lk-thumb'); return !!i && i.complete && i.naturalWidth>0`, 10000));
    await shot(c, 'mylist-links-' + who + '-1280');

    // 2. manual add from a link only
    await evalJs(c, `document.getElementById('manual-fab').click(); return 1`);
    ok('manual form has a Link field', await waitFor(c, `!!document.getElementById('add-link')`));
    await evalJs(c, `document.getElementById('add-link').value=${JSON.stringify(TARGET)}; ML.addItem(); return 1`);
    ok('link-only add fills name, photo and store from the page', await waitFor(c, `const it=${items}; const x=it&&it.find(i=>i.link&&i.link.url===${JSON.stringify(TARGET)}); return !!(x && x.link.image && x.link.site==='Target' && x.name==='Grade A Large Eggs' && !x.pendingName)`, 25000),
      await evalJs(c, `return JSON.stringify((${items}||[]).slice(-1))`));
    await evalJs(c, `document.getElementById('manual-fab').click(); return 1`);

    // 3. edit shows the link; clearing it removes it
    await evalJs(c, `ML.startEdit('a'); return 1`);
    ok('edit shows the link', (await evalJs(c, `document.getElementById('edit-link-a').value`)) === SAMS);
    await evalJs(c, `document.getElementById('edit-link-a').value=''; ML.saveEdit('a'); return 1`);
    ok('clearing the link removes it', await waitFor(c, `const it=${items}; const a=it&&it.find(i=>i.id==='a'); return !!a && !a.link`));

    // 4. rich paste
    const pasted = await evalJs(c, `const ta=document.getElementById('float-text'); ta.value=''; ta.focus();
      const dt=new DataTransfer(); dt.setData('text/html','<h3>Proteins</h3><ul><li>Italian Herb Chicken – <a href="${SAMS}">Sam\\'s Club</a></li><li>Tofu</li></ul>'); dt.setData('text/plain','x');
      ta.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true})); return ta.value`);
    ok('rich paste keeps the hyperlink as a URL, one line per bullet', pasted === "Proteins\n- Italian Herb Chicken – Sam's Club " + SAMS + "\n- Tofu", JSON.stringify(pasted));

    // 5. AI with a link (only once — it spends Gemini quota)
    if (who === 'tony') {
      await evalJs(c, `const ta=document.getElementById('float-text'); ta.value='Breakfast: ${WALMART}'; ML.sendFloatText(); return 1`);
      ok('AI adds the link as a clean item carrying its link', await waitFor(c, `const it=${items}; return !!(it && it.filter(i=>i.link&&i.link.url===${JSON.stringify(WALMART)} && !/walmart|https?:/i.test(i.name)).length)`, 40000),
        await evalJs(c, `return JSON.stringify((${items}||[]).map(i=>[i.name,i.store,i.link&&i.link.site]))`));
    }

    await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(500);
    ok('no horizontal scroll at 390', await evalJs(c, `document.documentElement.scrollWidth<=391`));
    await shot(c, 'mylist-links-' + who + '-390');
    await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.result.identifier });
  }
  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
