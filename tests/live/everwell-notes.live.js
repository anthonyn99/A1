// Everwell Phase 6 (A1-Priv/everwell.html): Tony's notes in Prayer / Goals /
// Mindset, the one-time import link, A1's Notebook as the editor, and the
// Mindset reels. Real page + real Notebook files (served by cdp.js), fake
// Firestore, fake lock worker. The note text here is TEST text, never Tony's.
//
// Run: node tests/live/everwell-notes.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const BASE = 'https://anthonyn99.github.io/A1/';
const PAGE = BASE + 'everwell.html';
const recs = {};
const mock = {
  // The players are faked (a quiet page): a made-up video id would make the
  // real YouTube report an error, and the tile would rightly close it.
  patterns: ['https://taskhub-reminders.av1.workers.dev/*', 'https://www.youtube-nocookie.com/*', 'https://www.instagram.com/*'],
  handle(req) {
    if (!req.url.startsWith('https://taskhub-reminders.av1.workers.dev/')) return { text: '<!doctype html><title>fake player</title>', type: 'text/html' };
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const p = new URL(req.url).pathname, b = req.postData ? JSON.parse(req.postData) : {};
    if (p === '/auth/journal/status-many') { const out = {}; (b.locks || []).forEach((l) => { const k = l.journal + ':' + l.entryId; out[k] = { hasLock: !!recs[k], ver: recs[k] ? 'v1' : null }; }); return { json: { ok: true, locks: out } }; }
    if (p === '/auth/journal/verify') { const r = recs[b.journal + ':' + b.entryId]; return { json: r ? { ok: r === b.password } : { ok: false, noLock: true } }; }
    return { json: { ok: true } };
  },
};
const TEST = {
  v: 1,
  pages: {
    prayer: '<p><strong>Test gratitude line</strong></p><p>Test prayer paragraph one.</p><p><em>(test note)</em></p>',
    'goals-mindset': '<h2>Test heading A</h2><ul><li>alpha</li><li>beta</li></ul><h2>Test heading B</h2><ol><li>one</li><li>two</li><li>three</li></ol>',
    'relationship-principles': '<p># Objective</p><p>**Test** objective, with *care* and a [link](https://example.com/x_y_z).</p><p>- k1<br>- k2</p><p>1. one<br>2. two</p>',
    'with-parents': '<ol>' + Array.from({ length: 40 }, (_, i) => '<li>Parent point number ' + (i + 1) + ' written out long enough to read</li>').join('') + '</ol>',
  },
};
const link = (o) => PAGE + '#ew-import=' + Buffer.from(JSON.stringify(o)).toString('base64url');

(async () => {
  const c = await connect({ mock: firebaseMock(mock) });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text || '').slice(0, 300)); });
  const js = (e) => evalJs(c, e);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const tap = async () => { await js(`document.getElementById('ew-intro-overlay').click(); return 1;`); await sleep(1000); };
  const fresh = async (url, seed) => {
    await c.send('Page.navigate', { url: BASE + 'LifeHub/lifehub.js' }); await sleep(300);
    await js(`localStorage.clear(); sessionStorage.clear(); ${seed || ''} return 1;`);
    await c.send('Page.navigate', { url }); await sleep(2800);
  };
  const doc = () => js(`return JSON.stringify(__fakeFs.docs['dashboards/everwell_notes'] || null);`).then(JSON.parse);

  console.log('\nThe import link');
  await fresh(link(TEST));
  ok('the import link is stripped from the address at once', (await js(`return location.href;`)) === PAGE);
  ok('â€¦and nothing is written before Tony is in (intro still up)', (await doc()) === null);
  await tap(); await sleep(1500);
  let d = await doc(), a, b;
  ok('after the intro, the four pages are written as Notebook entries', !!d && ['prayer', 'goals-mindset', 'relationship-principles', 'with-parents'].every((id) => d['e_' + id] && d['e_' + id].template === 'page' && d['e_' + id].data.html === TEST.pages[id]) && d._order.length === 4,
    JSON.stringify(d).slice(0, 300));
  ok('titles are the page names', d['e_goals-mindset'].title === 'Goals & Mindset' && d['e_with-parents'].title === 'With Parents');

  console.log('\nRead views');
  await js(`EWApp.go('prayer'); return 1;`); await sleep(900);
  ok('Prayer shows the prayer first, then the Buddhist quote, typeset (bold first line, italic note), above Today', await js(`const n = document.querySelector('#pray-note .ew-doc'); const g = document.querySelector('.pray-grid');
    return !!n && n.querySelector('strong').textContent === 'Test gratitude line' && !!n.querySelector('em') && g.firstElementChild.id === 'pray-note' && g.children[1].id === 'pray-bq';`));
  ok('the prayer card can open in the reader too', await js(`return !!document.querySelector('#pray-note [data-note-read="prayer"]');`));
  await js(`document.querySelector('#pray-note [data-note-read="prayer"]').click(); return 1;`); await sleep(900);
  ok('on a desktop, Read opens the prayer as a card where the Goals stage sits (Prayer title above, no kicker), not the whole screen', await js(`const o = document.getElementById('ew-reader'), r = o.getBoundingClientRect(), b = document.getElementById('ew-body-prayer').getBoundingClientRect(), h = document.querySelector('#ew-pane-prayer .ew-hero h1').getBoundingClientRect();
    return o.classList.contains('rd-box') && !!document.querySelector('.rd-dim') && Math.abs(r.left - b.left) < 2 && Math.abs(r.width - b.width) < 2 && Math.abs(r.top - b.top) < 2 && h.bottom <= r.top && !o.querySelector('.rd-kicker');`));
  await js(`document.querySelector('#ew-reader [data-rd="close"]').click(); return 1;`); await sleep(800);
  await js(`EWApp.go('goals'); return 1;`); await sleep(900);
  ok('Goals shows Goals & Mindset on the reading stage: section heads, bullets and numbered steps', await js(`const h = document.getElementById('goals-notes'), n = h.querySelector('.lyric'); return h.classList.contains('rd-stage') && !!n && n.querySelectorAll('h2').length === 2 && n.querySelectorAll('ul li').length === 2 && n.querySelectorAll('ol li').length === 3;`));
  ok('â€¦large type over a DARK, blurred field of pastel colour (Apple Music lyrics)', await js(`const t = getComputedStyle(document.querySelector('#goals-notes .lyric')), bg = getComputedStyle(document.querySelector('#goals-notes .rd-bg i')), st = getComputedStyle(document.getElementById('goals-notes'));
    const blob = getComputedStyle(document.querySelector('#goals-notes .rd-bg i'));
    return parseFloat(t.fontSize) >= 19 && parseFloat(t.fontSize) <= 26 && parseInt(t.fontWeight, 10) >= 700 && bg.backgroundImage.indexOf('radial-gradient') >= 0 && bg.filter === 'none' && document.querySelectorAll('#goals-notes .rd-bg i').length === 4 &&
      st.backgroundColor === 'rgb(17, 17, 20)' && parseFloat(blob.opacity) <= 0.25;`),
    await js(`return getComputedStyle(document.querySelector('#goals-notes .lyric')).fontSize + ' ' + getComputedStyle(document.getElementById('goals-notes')).backgroundColor + ' ' + getComputedStyle(document.querySelector('#goals-notes .rd-bg i')).opacity;`));
  ok('scrolled all the way up, nothing fades at the top (the first line is clear), and no "Goals" kicker above the title', await js(`const h = document.querySelector('#goals-notes .lyric h2'), f = getComputedStyle(document.querySelector('#goals-notes .rd-fade'));
    return h.textContent === 'Test heading A' && !h.style.filter && f.getPropertyValue('--rd-ft').trim() === '0px' && !document.querySelector('#goals-notes .rd-kicker');`));
  ok('numbered steps keep their numbers', await js(`const li = document.querySelector('#goals-notes .lyric ol li'); return getComputedStyle(li, '::before').content.indexOf('counter') >= 0;`));
  ok('the stage has its own Edit (Tony) and no Close', await js(`return !!document.querySelector('#goals-notes [data-rd="edit"]') && !document.querySelector('#goals-notes [data-rd="close"]');`));
  await js(`EWApp.go('mindset'); return 1;`); await sleep(900);
  ok('Mindset leads with the quote of the day (same line as the Dashboard)', await js(`return EWQuote.today().then(q => document.querySelector('#mind-quote .quote-text').textContent === q.text);`));
  ok('â€¦then two sub-tabs, Content and Principles', await js(`return [...document.querySelectorAll('#mind-seg [data-seg]')].map(b => b.textContent).join() === 'Content,Principles' && document.querySelector('#mind-writings .wr-ttl').textContent === 'Principles';`));
  await js(`document.getElementById('mind-tab-writings').click(); return 1;`); await sleep(500);
  ok('Writings: one card per page, by name; Content is hidden; the quote stays on top', await js(`return [...document.querySelectorAll('#wr-grid .wr-card .wr-title')].map(e => e.textContent).join() === 'Relationship Principles,With Parents' &&
    document.getElementById('mind-content').hidden && !document.getElementById('mind-writings').hidden && document.getElementById('mind-quote').getBoundingClientRect().height > 0 &&
    document.getElementById('mind-quote').getBoundingClientRect().top < document.getElementById('mind-writings').getBoundingClientRect().top;`));
  ok('each principle card wears its own pastel: a soft wash, a band on top, a tinted title', await js(`const c = document.querySelector('.wr-card'), g = getComputedStyle(c), band = getComputedStyle(c, '::before'), t = getComputedStyle(c.querySelector('.wr-title'));
    return g.backgroundColor !== getComputedStyle(document.body).getPropertyValue('--s1') && band.height === '3px' && band.content !== 'none' && t.color !== 'rgb(255, 255, 255)';`));
  ok('principle cards never share a colour on the board', await js(`const c = [...document.querySelectorAll('.wr-card')].map(e => e.style.getPropertyValue('--wr-a')); return c.length >= 2 && new Set(c).size === c.length;`));
  ok('principle cards have no coloured circles at the top', await js(`return !document.querySelector('.wr-card .wr-orb') && document.querySelector('.wr-card').firstElementChild.classList.contains('wr-title');`));
  ok('a card shows an excerpt and no count (no "40 points")', await js(`const c = document.querySelector('.wr-card[data-wr="with-parents"]'); return /Parent point number 1/.test(c.querySelector('.wr-ex').textContent) && !/[0-9]/.test(c.querySelector('.wr-foot').textContent);`));

  console.log('\nThe reader');
  await js(`document.querySelector('.wr-card[data-wr="relationship-principles"] .wr-title').click(); return 1;`); await sleep(900);
  ok('tapping a card opens the reader (a dialog with the card\'s name)', await js(`const r = document.getElementById('ew-reader'); return !!r && r.getAttribute('role') === 'dialog' && r.querySelector('.rd-title').textContent === 'Relationship Principles' && document.documentElement.classList.contains('rd-lock');`));
  ok('on a desktop it is a card where the Goals stage sits (the pane\'s width, from its top, 100vh - 230px tall), over a dimmed page', await js(`const r = document.getElementById('ew-reader').getBoundingClientRect(), b = document.getElementById('ew-body-mindset').getBoundingClientRect(), d = document.querySelector('.rd-dim');
    return document.getElementById('ew-reader').classList.contains('rd-box') && Math.abs(r.left - b.left) < 2 && Math.abs(r.width - b.width) < 2 && Math.abs(r.top - b.top) < 2 && Math.abs(r.height - Math.min(innerHeight - 230, innerHeight - b.top - 16)) < 2 && !!d && getComputedStyle(d).position === 'fixed';`),
    await js(`return JSON.stringify([document.getElementById('ew-reader').getBoundingClientRect(), document.getElementById('ew-body-mindset').getBoundingClientRect(), innerHeight]);`));
  ok('the open reader shows no focus ring (no purple outline)', await js(`const r = document.getElementById('ew-reader'), s = r.querySelector('.rd-scroll'); s.focus(); const a = getComputedStyle(s).outlineStyle; r.focus(); return document.activeElement === r && getComputedStyle(r).outlineStyle === 'none' && a === 'none';`));
  ok('...with the Mindset title showing above it, and no "Mindset" kicker inside', await js(`const h = document.querySelector('#ew-pane-mindset .ew-hero h1').getBoundingClientRect(), r = document.getElementById('ew-reader').getBoundingClientRect();
    return h.bottom <= r.top && h.top >= 0 && !document.querySelector('#ew-reader .rd-kicker');`));
  ok('Markdown typed into a note is typeset: heading, bold, italic, link, bullets, numbers', await js(`const t = document.querySelector('#ew-reader .lyric');
    return t.querySelector('h1').textContent === 'Objective' && t.querySelector('strong').textContent === 'Test' && t.querySelector('em').textContent === 'care' &&
      t.querySelector('a').getAttribute('href') === 'https://example.com/x_y_z' && t.querySelector('a').target === '_blank' &&
      [...t.querySelectorAll('ul li')].map(l => l.textContent).join() === 'k1,k2' && [...t.querySelectorAll('ol li')].map(l => l.textContent).join() === 'one,two' && !/[#*]/.test(t.textContent);`),
    await js(`return document.querySelector('#ew-reader .lyric').innerHTML;`));
  ok('a heading reads LARGER than the text under it (Notebook order), never a small uppercase label', await js(`const h = getComputedStyle(document.querySelector('#ew-reader .lyric h1')), p = getComputedStyle(document.querySelector('#ew-reader .lyric p'));
    return parseFloat(h.fontSize) > parseFloat(p.fontSize) * 1.4 && h.textTransform === 'none';`));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.getElementById('ew-reader').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1;`); await sleep(800);
  ok('Escape closes it, back to the cards', await js(`return !document.getElementById('ew-reader') && !document.documentElement.classList.contains('rd-lock');`));
  ok('â€¦and the card it grew out of is back (it hides while its reader is open)', await js(`return document.querySelector('.wr-card[data-wr="relationship-principles"]').style.visibility === '';`));
  await js(`document.querySelector('.wr-card[data-wr="with-parents"] .wr-title').click(); return 1;`); await sleep(1100);
  const fade = () => js(`const f = getComputedStyle(document.querySelector('#ew-reader .rd-fade')); return JSON.stringify({ t: parseFloat(f.getPropertyValue('--rd-ft')), b: parseFloat(f.getPropertyValue('--rd-fb')), m: f.maskImage || f.webkitMaskImage || 'none' });`).then(JSON.parse);
  let f = await fade();
  ok('the reader fades the text at the edges with ONE mask (no blur on any line)', /linear-gradient/.test(f.m) && await js(`return [...document.querySelectorAll('#ew-reader .lyric *')].every(l => !l.style.filter && !l.style.opacity);`), JSON.stringify(f));
  ok('...a NARROW band: at the top nothing fades above, the bottom fade is 24-56px', f.t === 0 && f.b >= 24 && f.b <= 56, JSON.stringify(f));
  // Smooth scrolling: a scroll frame reads no layout and the scroller has no mask.
  await js(`window.__n = 0; window.__o = Element.prototype.getBoundingClientRect; Element.prototype.getBoundingClientRect = function(){ if (this.closest && this.closest('.lyric')) window.__n++; return window.__o.call(this); };
    const sc = document.querySelector('#ew-reader .rd-scroll'); sc.scrollTop += 60; return 1;`); await sleep(350);
  const reads = await js(`Element.prototype.getBoundingClientRect = window.__o; return window.__n;`);
  ok('scrolling the reader reads no layout of its lines per frame (no getBoundingClientRect on the text)', reads === 0, reads + ' reads');
  ok('...and its scroller carries no mask (keeps the fast scroll path)', await js(`const c = getComputedStyle(document.querySelector('#ew-reader .rd-scroll')); return (c.maskImage || 'none') === 'none' && (c.webkitMaskImage || 'none') === 'none';`));
  f = await fade();
  ok('scrolled down, the top fades too', f.t > 0 && f.t <= 56, JSON.stringify(f));
  await js(`const sc = document.querySelector('#ew-reader .rd-scroll'); sc.scrollTop = sc.scrollHeight; return 1;`); await sleep(400);
  f = await fade();
  ok('scrolled to the very end, nothing fades below (the last line is clear)', f.b === 0 && f.t > 0, JSON.stringify(f));
  await js(`document.querySelector('#ew-reader [data-rd="close"]').click(); return 1;`); await sleep(800);
  ok('Close closes it', await js(`return !document.getElementById('ew-reader');`));
  await js(`document.querySelector('.wr-card[data-wr="relationship-principles"] .wr-title').click(); return 1;`); await sleep(900);
  await js(`history.back(); return 1;`); await sleep(900);
  ok("a phone's Back swipe closes the reader and stays in Everwell", await js(`return !document.getElementById('ew-reader') && EWApp.current() === 'mindset' && /everwell\.html$/.test(location.pathname);`));
  await js(`document.querySelector('.wr-card[data-wr="relationship-principles"] .wr-title').click(); return 1;`); await sleep(900);
  await js(`document.querySelector('.rd-dim').click(); return 1;`); await sleep(800);
  ok('a click on the dimmed page closes it too, dim and all', await js(`return !document.getElementById('ew-reader') && !document.querySelector('.rd-dim') && !document.documentElement.classList.contains('rd-lock');`));
  // Paging (Tony, 2026-10-12): the reader's left and right edges go to the previous / next card, in the board's order.
  // A real tap: press and release in the same place (pointerdown, then click).
  const edge = (side, moveY) => js(`const o = document.getElementById('ew-reader'), b = o.getBoundingClientRect(), x = '${side}' === 'r' ? b.right - 40 : b.left + 40, y = b.top + b.height / 2;
    o.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y })); o.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y + ${moveY || 0} })); return 1;`);
  const rdTitle = () => js(`return document.querySelector('#ew-reader [data-rd-title]').textContent;`);
  const board = await js(`return [...document.querySelectorAll('#wr-grid .wr-card')].map(c => c.querySelector('.wr-title').textContent).join('|');`);
  await js(`document.querySelector('#wr-grid .wr-card .wr-title').click(); return 1;`); await sleep(900);
  const seen = [await rdTitle()];
  for (let k = 0; k < 5; k++) { await edge('r'); await sleep(450); seen.push(await rdTitle()); }
  ok('a click on the right edge goes to the next card, in the board\'s order, and stops at the last', seen.join('|').startsWith(board) && seen[seen.length - 1] === board.split('|').pop(), seen.join('|') + ' vs ' + board);
  await edge('l'); await sleep(450);
  ok('...the left edge goes back one', (await rdTitle()) === board.split('|').slice(-2)[0], await rdTitle());
  await js(`document.getElementById('ew-reader').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); return 1;`); await sleep(450);
  ok('...and so do the arrow keys', (await rdTitle()) === board.split('|').slice(-3)[0], await rdTitle());
  ok('...with the new card\'s text, from its top', await js(`const sc = document.querySelector('#ew-reader .rd-scroll'); return sc.scrollTop === 0 && document.getElementById('ew-reader').getAttribute('aria-label') === document.querySelector('#ew-reader [data-rd-title]').textContent;`));
  let before = await rdTitle();
  await edge('r', 200); await sleep(450);
  ok('a drag that ends on the right edge (the scrollbar thumb, a selection) does not page', (await rdTitle()) === before, await rdTitle());
  await js(`const o = document.getElementById('ew-reader'), rail = o.querySelector('.vc-rail') || (() => { const d = document.createElement('div'); d.className = 'vc-rail y'; d.style.cssText = 'position:absolute;right:4px;top:80px;bottom:10px;width:12px;z-index:5'; o.appendChild(d); return d; })();
    const b = rail.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height * .7;
    rail.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y })); rail.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y })); return 1;`); await sleep(450);
  ok('a click on the scrollbar track (jump to that spot) does not page', (await rdTitle()) === before, await rdTitle());
  const touchTurn = await js(`const o = document.getElementById('ew-reader'), b = o.getBoundingClientRect(), x = b.right - 40, y = b.top + b.height / 2, t0 = document.querySelector('#ew-reader [data-rd-title]').textContent;
    o.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y })); o.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y })); o.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    const shown = o.getAttribute('data-edge'); return new Promise(res => setTimeout(() => { o.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y })); res(JSON.stringify({ shown, after: o.getAttribute('data-edge'), turned: document.querySelector('#ew-reader [data-rd-title]').textContent !== t0 })); }, 600));`).then(JSON.parse);
  ok('a finger tap on an edge turns the page and the chevron flashes, then fades (it never hangs there)', touchTurn.shown === 'r' && touchTurn.after === '' && touchTurn.turned, JSON.stringify(touchTurn));
  await edge('l'); await sleep(450);
  // Rapid clicks (Tony, 2026-10-12): every one turns a page, none selects text.
  await js(`document.getSelection().removeAllRanges(); return 1;`);
  const startAt = await rdTitle(), names = board.split('|');
  await js(`const o = document.getElementById('ew-reader'), b = o.getBoundingClientRect(), x = b.left + 40, y = b.top + b.height / 2;
    for (let k = 0; k < 2; k++) { o.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, detail: k + 1 })); o.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y })); o.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, detail: k + 1 })); }
    return 1;`); await sleep(500);
  const want = names[Math.max(0, names.indexOf(startAt) - 2)];
  ok('rapid clicks each turn a page (two quick clicks = two cards back), mid-slide too', (await rdTitle()) === want, (await rdTitle()) + ' want ' + want + ' from ' + startAt);
  ok('...and a press on an edge never starts a text selection', await js(`const o = document.getElementById('ew-reader'), b = o.getBoundingClientRect(); const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: b.left + 40, clientY: b.top + b.height / 2 }); o.dispatchEvent(ev); return ev.defaultPrevented && getComputedStyle(o).touchAction === 'manipulation';`));
  ok('...the edge under the cursor shows a chevron', await js(`const o = document.getElementById('ew-reader'), b = o.getBoundingClientRect(); o.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: b.right - 20, clientY: b.top + b.height / 2 })); return o.getAttribute('data-edge') === 'r';`));
  await js(`document.querySelector('#ew-reader [data-rd="close"]').click(); return 1;`); await sleep(800);
  ok('closing after paging leaves every card visible', await js(`return !document.getElementById('ew-reader') && [...document.querySelectorAll('.wr-card')].every(c => c.style.visibility === '');`));
  await c.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 860, deviceScaleFactor: 1, mobile: true }); await sleep(400);
  await js(`document.querySelector('.wr-card[data-wr="relationship-principles"] .wr-title').click(); return 1;`); await sleep(900);
  ok('on a phone it stays the full-screen reader (with its kicker)', await js(`const r = document.getElementById('ew-reader'), b = r.getBoundingClientRect(); return !r.classList.contains('rd-box') && !document.querySelector('.rd-dim') && b.width === innerWidth && b.height === innerHeight && r.querySelector('.rd-kicker').textContent === 'Mindset';`));
  await js(`document.querySelector('#ew-reader [data-rd="close"]').click(); return 1;`); await sleep(800);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await sleep(400);

  console.log('\nNew cards (Notebook pages)');
  ok('New principle is a solid button in the header, not a blank card', await js(`const b = document.querySelector('#mind-writings .wr-head [data-wr-add]'); return !!b && b.classList.contains('btn') && b.classList.contains('solid') && b.textContent === '+ New principle' && !document.querySelector('#wr-grid [data-wr-add]');`));
  await js(`document.querySelector('[data-wr-add]').click(); return 1;`); await sleep(400);
  await js(`document.querySelector('#uim-fields input').value = 'Discipline'; document.getElementById('uim-ok').click(); return 1;`); await sleep(2500);
  const newId = await js(`const m = (__fakeFs.docs['dashboards/everwell_tony'] || {}).mindsetPages || []; return (m[2] || {}).id || '';`);
  ok('"+ New principle" (a header button, like New recipe) asks a name, then adds the card at the end (synced list)', /^m-discipline-[a-z0-9]{4}$/.test(newId) && await js(`return [...document.querySelectorAll('#wr-grid .wr-title')].map(e => e.textContent).join() === 'Relationship Principles,With Parents,Discipline';`),
    newId + ' ' + await js(`return JSON.stringify((__fakeFs.docs['dashboards/everwell_tony'] || {}).mindsetPages);`));
  ok('â€¦as an empty Notebook page in the notes store', await js(`const e = __fakeFs.docs['dashboards/everwell_notes']['e_${newId}']; return !!e && e.title === 'Discipline' && e.template === 'page' && e.data.html === '' && __fakeFs.docs['dashboards/everwell_notes']._order.includes('${newId}');`));
  for (let i = 0; i < 40 && !(await js(`return !!document.querySelector('#ewn-entries-list .entry-item.active');`)); i++) await sleep(250);
  ok('â€¦and Notebook opens on it, ready to write', await js(`return document.getElementById('ew-nb-overlay').classList.contains('on') && document.getElementById('ew-nb-title').textContent === 'Discipline';`) &&
    (await js(`const a = document.querySelector('#ewn-entries-list .entry-item.active'); return a && a.dataset.entryId;`)) === newId);
  const typed2 = await js(`const ed = [...document.querySelectorAll('#ewn-root [contenteditable="true"]')].find(e => e.offsetParent); if (!ed) return 'no editor';
    ed.focus(); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.execCommand('insertHTML', false, '<p>Show up daily.</p>'); ed.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';`);
  await sleep(2500); await js(`document.getElementById('ew-nb-done').click(); return 1;`); await sleep(2500);
  ok('what is written there shows on the new card (the same beautiful reader)', typed2 === 'ok' && await js(`return /Show up daily/.test(document.querySelector('.wr-card[data-wr="${newId}"] .wr-ex').textContent);`), typed2);
  await js(`document.querySelector('[data-wr-rename="${newId}"]').click(); return 1;`); await sleep(400);
  await js(`document.querySelector('#uim-fields input').value = 'Discipline Rules'; document.getElementById('uim-ok').click(); return 1;`); await sleep(1800);
  ok('Rename renames the card, its list entry and its page', await js(`return document.querySelector('.wr-card[data-wr="${newId}"] .wr-title').textContent === 'Discipline Rules' &&
    __fakeFs.docs['dashboards/everwell_tony'].mindsetPages[2].title === 'Discipline Rules' && __fakeFs.docs['dashboards/everwell_notes']['e_${newId}'].title === 'Discipline Rules';`));
  a = await js(`const r = document.querySelector('.wr-card[data-wr="${newId}"] .wr-title').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });`).then(JSON.parse);
  b = await js(`const r = document.querySelector('.wr-card[data-wr="relationship-principles"]').getBoundingClientRect(); return JSON.stringify({ x: r.left + 20, y: r.top + r.height / 2 });`).then(JSON.parse);
  const mouse = (type, x, y) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= 16; i++) { await mouse('mouseMoved', a.x + (b.x - a.x) * i / 16, a.y + (b.y - a.y) * i / 16); await sleep(16); }
  await sleep(200); await mouse('mouseReleased', b.x, b.y); await sleep(1800);
  ok('cards drag to reorder (the new one to the front), saved', await js(`return __fakeFs.docs['dashboards/everwell_tony'].mindsetPages[0].id === '${newId}' && document.querySelector('#wr-grid .wr-card').dataset.wr === '${newId}';`),
    await js(`return JSON.stringify(__fakeFs.docs['dashboards/everwell_tony'].mindsetPages.map(p => p.id));`));
  await js(`document.querySelector('[data-wr-rm="${newId}"]').click(); return 1;`); await sleep(400);
  ok('Delete asks first, naming the principle', await js(`return document.getElementById('uim-title').textContent === 'Delete principle?' && /Discipline Rules/.test(document.getElementById('uim-msg').textContent);`));
  await js(`document.getElementById('uim-ok').click(); return 1;`); await sleep(1800);
  ok('â€¦then the card and its page are gone', await js(`return !document.querySelector('.wr-card[data-wr="${newId}"]') && !__fakeFs.docs['dashboards/everwell_tony'].mindsetPages.some(p => p.id === '${newId}') && !__fakeFs.docs['dashboards/everwell_notes']['e_${newId}'];`));
  await js(`document.getElementById('mind-tab-content').click(); return 1;`); await sleep(300);

  console.log('\nRe-import never overwrites');
  // fresh() clears sessionStorage, which holds the fake Firestore: carry the notes doc over.
  d = await doc();
  await fresh(link({ v: 1, pages: { prayer: '<p>OVERWRITE ATTEMPT</p>' } }), `sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify({ 'dashboards/everwell_notes': d }))});`);
  await tap(); await sleep(1500);
  d = await doc();
  ok('a second import leaves the existing page untouched', d.e_prayer.data.html === TEST.pages.prayer);

  console.log('\nThe recovery copy (#ew-backup, Phase 9)');
  // Catch the download in the page: the anchor's click is recorded with the
  // blob's text instead of saving a file.
  const { identifier: dlHook } = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && this.href.startsWith('blob:')) { const a = this; fetch(a.href).then(r => r.text()).then(t => { window.__dl = { name: a.download, text: t }; }); return; }
      return click.call(this);
    };
  })();` });
  const seedDocs = { 'dashboards/everwell_notes': await doc(), 'dashboards/main': { dashboard: { tasks: ['t1'] } }, 'dashboards/motioncore': { circuits: [{ id: 'c1' }] }, 'dashboards/mealsuite': { recipes: [] } };
  await fresh(PAGE + '#ew-backup', `sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(seedDocs))});`);
  ok('the backup link is stripped from the address at once', (await js(`return location.href;`)) === PAGE);
  ok('â€¦and nothing is saved before Tony is in (intro still up)', await js(`return !window.__dl;`));
  await tap(); await sleep(1500);
  const dl = await js(`return window.__dl ? JSON.stringify(window.__dl) : null;`).then((s) => s && JSON.parse(s));
  const bk = dl && JSON.parse(dl.text);
  ok('after the intro, a recovery file downloads', !!dl && /^everwell-recovery-\d{4}-\d{2}-\d{2}\.json$/.test(dl.name), dl && dl.name);
  ok('â€¦holding the server copies of main, motioncore and mealsuite', !!bk && bk.kind === 'everwell-recovery' && bk.docs['dashboards/main'].dashboard.tasks[0] === 't1' && bk.docs['dashboards/motioncore'].circuits[0].id === 'c1' && !!bk.docs['dashboards/mealsuite']);
  ok('â€¦and naming the doc it could not find (everwell_tony was never written here)', !!bk && bk.missing.join() === 'dashboards/everwell_tony', bk && bk.missing);
  ok('the copies are unchanged in Firestore', await js(`return JSON.stringify(__fakeFs.docs['dashboards/main']);`) === JSON.stringify(seedDocs['dashboards/main']));
  await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: dlHook });

  console.log('\nThe editor: A1\'s Notebook');
  d = await doc();
  await fresh(PAGE, `sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify({ 'dashboards/everwell_notes': d }))});`);
  await tap(); await sleep(1500);
  await js(`EWApp.go('goals'); return 1;`); await sleep(800);
  await js(`document.querySelector('#goals-notes [data-rd="edit"]').click(); return 1;`);
  for (let i = 0; i < 40 && !(await js(`return !!document.querySelector('#ewn-entries-list .entry-item.active');`)); i++) await sleep(250);
  ok('Edit opens the Notebook editor (instance ewn) full-screen', await js(`return document.getElementById('ew-nb-overlay').classList.contains('on') && !!document.getElementById('ewn-root');`));
  ok('â€¦on the Goals & Mindset page', (await js(`const a = document.querySelector('#ewn-entries-list .entry-item.active'); return a && a.dataset.entryId;`)) === 'goals-mindset');
  ok("â€¦with Notebook's page list hidden (no other tab's page shows)", await js(`return getComputedStyle(document.getElementById('ewn-sidebar')).display === 'none';`));
  const typed = await js(`const ed = [...document.querySelectorAll('#ewn-root [contenteditable="true"]')].find(e => e.offsetParent); if (!ed) return 'no editor';
    ed.focus(); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.execCommand('insertHTML', false, '<p>Added in Notebook</p>'); ed.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';`);
  ok('the page is editable', typed === 'ok', typed);
  await sleep(2500);
  await js(`document.getElementById('ew-nb-done').click(); return 1;`); await sleep(2500);
  d = await doc();
  ok('the edit is saved to dashboards/everwell_notes by Notebook', /Added in Notebook/.test(d['e_goals-mindset'].data.html), d['e_goals-mindset'].data.html.slice(-200));
  ok('Done closes the editor, and the Goals tab shows the edit', await js(`return !document.getElementById('ew-nb-overlay').classList.contains('on') && /Added in Notebook/.test(document.querySelector('#goals-notes .lyric').textContent);`));

  console.log('\nLocks');
  await js(`document.querySelector('#goals-notes [data-rd="edit"]').click(); return 1;`); await sleep(800);
  recs['applock:tony_everwell_tab_goals'] = 'g';
  await js(`Guardian.refresh(['tony_everwell_tab_goals'], true); return 1;`); await sleep(1500);
  ok('locking Goals closes the editor and empties the tab', await js(`return !document.getElementById('ew-nb-overlay').classList.contains('on') && !document.querySelector('#goals-notes') && document.getElementById('ew-body-goals').dataset.state === 'locked';`));
  ok('with no note on screen, the notes listener is stopped and the text dropped', await js(`return !EWNotes.state().listening && !EWNotes.state().loaded;`), await js(`return JSON.stringify(EWNotes.state());`));
  delete recs['applock:tony_everwell_tab_goals'];

  console.log('\nMindset reels');
  await js(`EWApp.go('mindset'); return 1;`); await sleep(900);
  const addLink = async (url, title) => { await js(`document.getElementById('media-url').value = ${JSON.stringify(url)}; document.getElementById('media-title').value = ${JSON.stringify(title || '')}; document.getElementById('media-add').requestSubmit(); return 1;`); await sleep(300); };
  await addLink('https://example.com/not-a-video');
  ok('a non-YouTube/Instagram link is refused with a message', /not a YouTube or Instagram/.test(await js(`return document.getElementById('media-err').textContent;`)));
  await addLink('https://www.youtube.com/watch?v=abcdefghijk', 'Morning talk');
  await addLink('https://youtube.com/shorts/ABCDEFGHIJK');
  await addLink('https://www.instagram.com/reel/Cxyz123abc/');
  await addLink('https://www.youtube.com/playlist?list=PLabcdefghijklmnop');
  ok('four tiles: Short and Reel are tall, the video and playlist wide', await js(`const t = [...document.querySelectorAll('.media-tile')]; return t.length === 4 && t.filter(x => x.classList.contains('tall')).length === 2;`));
  ok('nothing plays on open (no player until a tap)', await js(`return !document.querySelector('.media-tile iframe');`));
  await sleep(1500);
  ok('saved with the settings (dashboards/everwell_tony)', await js(`const m = (__fakeFs.docs['dashboards/everwell_tony'] || {}).mindsetMedia || []; return m.length === 4 && m[3].title === 'Morning talk';`), await js(`return JSON.stringify((__fakeFs.docs['dashboards/everwell_tony'] || {}).mindsetMedia);`));
  await js(`document.querySelector('.media-tile:last-child [data-play]').click(); return 1;`); await sleep(400);
  ok('tapping plays it through youtube-nocookie with autoplay', await js(`const f = document.querySelector('.media-tile iframe'); return !!f && /^https:\\/\\/www\\.youtube-nocookie\\.com\\/embed\\/abcdefghijk\\?autoplay=1/.test(f.src);`));
  await js(`document.querySelector('.media-tile:nth-child(2) [data-play]').click(); return 1;`); await sleep(400);
  // A reel opens Everwell's Instagram player in place of its tile (2026-10-12).
  ok('playing another stops the first (one player at a time)', await js(`return !document.querySelector('.media-tile iframe') && !!document.querySelector('#media-grid .ig-host [data-igstage]');`));
  await js(`EWApp.go('dashboard'); return 1;`); await sleep(500);
  ok('leaving Mindset KEEPS it playing (Tony, 2026-10-11)', await js(`return !!document.querySelector('#media-grid [data-igstage]') && EWMindset.playing() !== null;`));
  ok('â€¦and the "now playing" pill says what and where, at the bottom', await js(`const n = document.getElementById('ew-now'); return n.classList.contains('on') && /Playing in Mindset/.test(n.textContent);`));
  await js(`document.getElementById('ew-now-go').click(); return 1;`); await sleep(500);
  ok('the pill takes you back to Mindset (and hides there)', await js(`return EWApp.current() === 'mindset' && !document.getElementById('ew-now').classList.contains('on') && !!document.querySelector('#media-grid iframe');`));
  await js(`EWApp.go('goals'); return 1;`); await sleep(400);
  await js(`document.getElementById('ew-now-stop').click(); return 1;`); await sleep(400);
  ok('its Stop stops it, and the pill goes', await js(`return !document.querySelector('#media-grid iframe') && !document.getElementById('ew-now').classList.contains('on');`));

  console.log('\nDisplay');
  await fresh(PAGE, `sessionStorage.setItem('ew.profile', 'display'); sessionStorage.setItem('ew.skipIntro', '1');`);
  await js(`EWApp.go('goals'); return 1;`); await sleep(600);
  ok('Display shows demo pages, with no Edit and no Firebase', await js(`return !!document.querySelector('#goals-notes .lyric h2') && !document.querySelector('[data-note-edit], [data-rd="edit"]') && typeof window.__fakeFs === 'undefined';`));
  await js(`EWApp.go('mindset'); return 1;`); await sleep(500);
  ok('Display Mindset has no add form', await js(`return !document.getElementById('media-add') && /appear here/.test(document.getElementById('media-grid').textContent);`));

  console.log('\nPage errors');
  ok('no uncaught exceptions', errs.length === 0, errs.join(' | '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
