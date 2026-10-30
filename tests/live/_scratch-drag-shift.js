'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const URL_ = process.argv[2] || 'file:///c:/Users/antho/Desktop/A1/index.html';
const WHO = process.argv[3] || 'tony';
(async () => {
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: URL_ }); await sleep(1500);
  await evalJs(c, `localStorage.setItem('td6_mainDash','${WHO}'); 1`);
  await c.send('Page.navigate', { url: URL_ }); await sleep(9000);
  await evalJs(c, "var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
  const snap = `function snap(root){const rb=root.getBoundingClientRect();return [...root.querySelectorAll('*')].filter(n=>n.getClientRects().length).map(n=>{const b=n.getBoundingClientRect(),cs=getComputedStyle(n);return {tag:n.tagName,t:(n.childNodes[0]&&n.childNodes[0].nodeType===3?n.childNodes[0].nodeValue:'').slice(0,20),x:+(b.left-rb.left).toFixed(1),y:+(b.top-rb.top).toFixed(1),w:+b.width.toFixed(1),h:+b.height.toFixed(1),f:cs.fontFamily.slice(0,20)+'/'+cs.fontSize+'/'+cs.fontWeight+'/'+cs.letterSpacing+'/'+cs.lineHeight+'/'+cs.fontVariantNumeric+'/'+cs.textTransform+'/'+cs.whiteSpace};});}`;
  const rows = JSON.parse(await evalJs(c, `return JSON.stringify([...document.querySelectorAll('[data-thz^="week:"] > [data-dkey]')].filter(r=>r.getClientRects().length&&r.getBoundingClientRect().top>0&&r.getBoundingClientRect().bottom<900).slice(0,8).map(r=>{const b=r.getBoundingClientRect();return {k:r.dataset.dkey,x:b.left+8,y:b.top+b.height/2,txt:r.textContent.slice(0,30)};}));`));
  console.log('rows', rows.length);
  for (const r of rows) {
    const before = JSON.parse(await evalJs(c, `${snap};const row=document.querySelector('[data-dkey="${r.k}"]');return JSON.stringify({rw:row.getBoundingClientRect().width,rh:row.getBoundingClientRect().height,s:snap(row)});`));
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 4; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y + i * 2, button: 'left', buttons: 1 }); await sleep(30); }
    await sleep(100);
    const after = JSON.parse(await evalJs(c, `${snap};const g=document.querySelector('.dsort-ghost');if(!g)return 'null';const t=g.tagName==='TABLE'?g.querySelector('tr'):g;return JSON.stringify({rw:t.getBoundingClientRect().width,rh:t.getBoundingClientRect().height,s:snap(t)});`));
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'left', buttons: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(500);
    console.log('\n== ' + r.txt, 'row', before.rw, before.rh, 'ghost', after && after.rw, after && after.rh);
    if (!after) { console.log('  no ghost'); continue; }
    before.s.forEach((b, i) => {
      const a = after.s[i]; if (!a) { console.log('  missing', b.tag, b.t); return; }
      const d = ['x', 'y', 'w', 'h'].filter(k => Math.abs(a[k] - b[k]) > 0.6);
      if (d.length || a.f !== b.f) console.log('  ', b.tag, JSON.stringify(b.t), d.map(k => k + ':' + b[k] + '->' + a[k]).join(' '), a.f !== b.f ? '\n      F ' + b.f + '\n     -> ' + a.f : '');
    });
  }
  process.exit(0);
})();
