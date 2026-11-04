// Notebook clean sweep (Tony, 2026-11-04): "audit EVERY feature ... Tony and
// Veda". What the audit found broken, proven fixed on BOTH sides:
//
//   • the editor's own dialogs (Page setup, Word count, Shortcuts, Trash,
//     AI Tools ...) close on Escape, the top one only;
//   • the template picker (New entry) closes on Escape;
//   • the search box shows its magnifier (it sat under the input);
//   • nothing open: View/Edit and Export PDF rest dimmed and inert;
//   • hoverfx never decorates a link or checklist box INSIDE a document, so a
//     save can no longer write `class="hoverfx"` / `filter: brightness()` into
//     an entry, and what older saves hold is swept when the entry is touched;
//   • Veda's tags: "Work" and "work" are one tag;
//   • Tony's Journal Entries ribbon: its selects are 12px with a mouse.
//
// Run: node tests/live/notebook-audit.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io', BASE = ORIGIN + '/A1/';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const T0 = Date.now();
const entry = (id, title, html, extra) => Object.assign({ id, title, template: 'page', created: T0 - 86400000, updated: T0 - 3600000,
  tags: [], data: { html, attachments: [] }, rev: 1 }, extra || {});
// Alpha carries what an older save left behind: a lit checklist box and link.
const POLLUTED = '<p>First <a href="https://example.com" class="hoverfx" style="filter: brightness(1.18);">link</a>.</p>'
  + '<ul class="docx-cl"><li class="docx-cl-item"><input type="checkbox" class="docx-cl-box hoverfx" contenteditable="false" style="filter: brightness(1.18);"><span class="docx-cl-text">task one</span></li></ul>';
const SEED = [
  entry('e_1791000000001_alpha00001', 'Alpha plan', POLLUTED, { tags: ['work'] }),
  entry('e_1791000000002_bravo00002', 'Bravo notes', '<p>Bravo body text.</p>'),
];
function seedDoc() { const d = { _order: SEED.map((e) => e.id), activeId: null, savedAt: T0 - 3600000 }; for (const e of SEED) d['e_' + e.id] = e; return d; }
const SIDES = {
  tony: { K: 'tj', doc: 'dashboards/tony_journal', open: "window._tonyNav('brainstormjournal')" },
  veda: { K: 'bj', doc: 'dashboards/journal', open: "window._vedaNav('journal')" },
};

(async () => {
  const c = await connect({ mock: firebaseMock() });
  const js = (e) => evalJs(c, e);
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const key = async (k, code, mods) => {
    const vk = { Escape: 27, Enter: 13 }[k] || 0;
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: code || k, windowsVirtualKeyCode: vk, modifiers: mods || 0 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code || k, windowsVirtualKeyCode: vk, modifiers: mods || 0 });
    await sleep(200);
  };
  const click = (sel) => js(`var el=document.querySelector(${JSON.stringify(sel)}); if(!el) return false; var r=el.getBoundingClientRect(),o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0};
    el.dispatchEvent(new MouseEvent('mousedown',o)); el.dispatchEvent(new MouseEvent('mouseup',o)); if(/INPUT|TEXTAREA/.test(el.tagName)) el.focus(); el.click(); return true;`).then((r) => sleep(450).then(() => r));
  const saved = (doc) => js(`return __fakeFs.docs['${doc}']['e_e_1791000000001_alpha00001'].data.html;`);

  for (const who of ['tony', 'veda']) {
    const { K, doc, open } = SIDES[who];
    console.log('\n' + (who === 'tony' ? "T's Notebook" : "V's Notebook"));
    await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
    await c.send('Page.navigate', { url: BASE + 'LifeHub/lifehub.js' }); await sleep(500);
    await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','${who}'); localStorage.setItem('a1b_disabled','1');
      var d=new Date(); localStorage.setItem('a1_sweep_day:index', d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2));
      sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify({ [doc]: seedDoc() }))}); 1`);
    await c.send('Page.navigate', { url: BASE + 'index.html' }); await sleep(3000);
    for (let i = 0; i < 120; i++) { if (await js(`var l=document.getElementById('th-boot-loader'); return !!window._profileGoTony && (!l || l.classList.contains('th-boot-hide'));`)) break; await sleep(250); }
    await sleep(1000); await js(`var l=document.getElementById('th-boot-loader'); if(l) l.remove(); ${open}; 1`); await sleep(2500);

    // Search magnifier: on top of the input, so it shows. (pointer-events:none
    // hides it from elementFromPoint, never from the eye: lifted for the check.)
    ok('the search box shows its magnifier', await js(`const s=document.getElementById('${K}-search-box'), i=s.parentNode.querySelector('svg'), r=i.getBoundingClientRect();
      i.style.pointerEvents='auto'; const top=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); i.style.pointerEvents=''; return !!top && (top===i || i.contains(top));`));

    // Nothing open: View/Edit and Export PDF dimmed and inert.
    const dim = (id) => `(e => { const w = e.closest('.mode-toggle-wrap') || e, cs = getComputedStyle(w); return +cs.opacity < .5 && cs.pointerEvents === 'none'; })(document.getElementById('${id}'))`;
    ok('nothing open: View/Edit and Export PDF rest dimmed and inert', await js(`return document.getElementById('${K}-empty-state').style.display !== 'none' && ${dim(K + '-btn-edit')} && ${dim(K + '-btn-export-pdf')};`));

    // Template picker: Escape closes it.
    await click(`#${K}-new-entry-btn`);
    ok('New entry opens the template picker', await js(`return document.getElementById('${K}-template-modal').classList.contains('open');`));
    await key('Escape');
    ok('Escape closes the template picker (no entry made)', await js(`return !document.getElementById('${K}-template-modal').classList.contains('open') && document.querySelectorAll('#${K}-entries-list .entry-item').length === 2;`));

    // Open Alpha: the controls come back.
    await click(`#${K}-entries-list .entry-item`); await sleep(600);
    ok('an entry open: View/Edit and Export PDF are live again', await js(`return !document.getElementById('${K}-root').classList.contains('nb-noentry') && +getComputedStyle(document.getElementById('${K}-btn-export-pdf')).opacity > .9;`));

    // Edit mode: touching the document sweeps the old hover artefacts, and
    // hovering the checklist box / link adds none.
    await click(`#${K}-btn-edit`); await sleep(400);
    await js(`const e=document.getElementById('${K}-page-editor'); e.focus(); 1`); await sleep(200);
    const pt = await js(`const b=document.querySelector('#${K}-page-editor .docx-cl-box'), r=b.getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2];`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt[0], y: pt[1] }); await sleep(300);
    const lk = await js(`const a=document.querySelector('#${K}-page-editor a'), r=a.getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2];`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lk[0], y: lk[1] }); await sleep(300);
    ok('hovering a checklist box or link in the document adds no hover class or filter', await js(`return !document.querySelector('#${K}-page-editor .hoverfx, #${K}-page-editor [style*="brightness("]');`),
      await js(`return document.getElementById('${K}-page-editor').innerHTML;`));
    // Tick the box (an edit), so the entry saves.
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt[0], y: pt[1], button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt[0], y: pt[1], button: 'left', clickCount: 1 }); await sleep(3200);
    const h = await saved(doc);
    ok('the saved entry holds the tick and no hover artefacts (old ones swept)', /checked/.test(h) && !/hoverfx|brightness\(/.test(h), h);

    // Editor dialogs close on Escape: Word count (Tools), then the top one only.
    const menu = async (m, item) => js(`const b=[...document.querySelectorAll('#${K}-page-toolbar .docx-menu-btn')].find(x=>x.textContent===${JSON.stringify(m)}); b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true})); b.click();
      await new Promise(r=>setTimeout(r,250)); const i=[...document.querySelectorAll('.docx-pop .docx-mi')].find(x=>x.textContent.indexOf(${JSON.stringify(item)})===0); if(!i) return false; i.click(); await new Promise(r=>setTimeout(r,300)); return true;`);
    ok('Tools → Word count opens its dialog', await menu('Tools', 'Word count') && await js(`return document.querySelectorAll('.docx-veil').length === 1;`));
    await key('Escape');
    ok('Escape closes it', await js(`return document.querySelectorAll('.docx-veil').length === 0;`));
    ok('…and the editor is still in edit mode (Escape went no further)', await js(`return document.getElementById('${K}-btn-edit').checked === true;`));
    await menu('Format', 'Page setup'); await menu('Help', 'Keyboard shortcuts');
    const two = await js(`return document.querySelectorAll('.docx-veil').length;`);
    await key('Escape');
    ok('two dialogs open: Escape closes only the top one', two === 2 && await js(`return document.querySelectorAll('.docx-veil').length === 1 && /Page setup/.test(document.querySelector('.docx-veil').textContent);`),
      two + ' then ' + await js(`return [...document.querySelectorAll('.docx-veil')].map(v=>v.textContent.slice(0,20)).join(' | ');`));
    await key('Escape');
    ok('a second Escape closes the other', await js(`return document.querySelectorAll('.docx-veil').length === 0;`));

    if (who === 'veda') {
      await click('#bj-add-tag-input'); await c.send('Input.insertText', { text: 'Work' }); await key('Enter'); await sleep(2800);
      const tags = await js(`return __fakeFs.docs['${doc}']['e_e_1791000000001_alpha00001'].tags;`);
      ok('a tag that differs only in case ("Work" beside "work") is not added again', tags.filter((t) => t.toLowerCase() === 'work').length === 1, JSON.stringify(tags));
    }
    if (who === 'tony') {
      await click('#tj-new-entry-btn'); await js(`document.querySelector('#tj-template-modal .template-card[data-template="journal-entries"]').click(); 1`); await sleep(1200);
      ok("Journal Entries' ribbon selects are 12px with a mouse (not the phone's 16px)", await js(`const s=[...document.querySelectorAll('#tj-je-toolbar select')].filter(x=>x.getBoundingClientRect().width>0); return s.length > 0 && s.every(x => getComputedStyle(x).fontSize === '12px');`),
        await js(`return [...document.querySelectorAll('#tj-je-toolbar select')].map(x=>getComputedStyle(x).fontSize).join(',');`));
    }
  }
  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
