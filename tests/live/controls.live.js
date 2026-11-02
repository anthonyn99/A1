/**
 * A1's own form controls (controls.js), in a real browser.
 *
 * Fixture: selects open A1's list (mouse, keys, touch) and still fire change
 * and inline onchange; date / time / datetime-local pick through A1's
 * calendar and clock; datalists, checkboxes, radios, ranges, <details> and
 * tooltips; a page's own toggle switch is left alone, a gold box stays gold,
 * Veda's light side gets a light list in her mauve, a clipping modal can't cut
 * the list off, and React-controlled controls round-trip both ways.
 *
 * Every program, Tony's side and Veda's: nothing in the page is still drawn by
 * the browser.
 *
 *   node tests/live/controls.live.js
 */
const { connect, evalJs, sleep } = require('./cdp');

const BASE = 'https://anthonyn99.github.io/A1/';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}
async function go(c, url, wait) {
  await c.send('Page.navigate', { url });
  await sleep(wait || 1500);
}
async function center(c, sel) {
  return evalJs(c, `var e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
    var r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };`);
}
async function click(c, sel) {
  const p = await center(c, sel);
  if (!p) return false;
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(180);
  return true;
}
async function tap(c, sel) {
  const p = await center(c, sel);
  if (!p) return false;
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(250);
  return true;
}
async function key(c, k, code) {
  const vk = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27, ' ': 32 }[k];
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: code || k, windowsVirtualKeyCode: vk });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code || k, windowsVirtualKeyCode: vk });
  await sleep(120);
}
// Click the open popover's row / cell whose text is `text`.
async function pick(c, text, cls) {
  const p = await evalJs(c, `var all = document.querySelectorAll('.a1c-pop.on ${cls || '.a1c-opt'}');
    var e = Array.prototype.find.call(all, function (x) { return x.textContent.trim() === ${JSON.stringify(text)}; });
    if (!e) return null; e.scrollIntoView({ block: 'nearest' }); var r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
  if (!p) return false;
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(200);
  return true;
}
const POP = `var p = document.querySelector('.a1c-pop.on'); if (!p) return null;
  return { rows: Array.prototype.map.call(p.querySelectorAll('.a1c-opt'), function (r) { return r.textContent.trim() + (r.getAttribute('aria-disabled') ? '!' : '') + (r.classList.contains('sel') ? '*' : ''); }),
    light: p.classList.contains('light'), ac: p.style.getPropertyValue('--p-ac'), parent: p.parentNode.id || p.parentNode.tagName,
    top: p.matches(':popover-open'), h: p.getBoundingClientRect().height };`;
const trigText = (id) => `var b = document.getElementById('${id}').nextElementSibling; return b && b.classList.contains('a1c-trig') ? b.querySelector('.a1c-lbl').textContent : null;`;

// Every control in the page the browser still draws itself. Hidden ones
// count too: a modal not open yet is still part of the program.
const AUDIT = `var bad = [];
  function name(e) { return e.tagName.toLowerCase() + (e.id ? '#' + e.id : e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/)[0] : '') + (e.type ? '[' + e.type + ']' : ''); }
  function out(e) { return e.closest('[data-native]') || e.classList.contains('sosc-native'); }
  document.querySelectorAll('select').forEach(function (s) {
    if (s.multiple || s.size > 1 || out(s)) return;
    if (!s.hasAttribute('data-a1c')) bad.push(name(s));
  });
  document.querySelectorAll('input[type=date],input[type=time],input[type=datetime-local],input[type=month],input[type=week],input[type=color]').forEach(function (i) {
    if (out(i) || i.classList.contains('a1c-src')) return;
    bad.push(name(i));
  });
  document.querySelectorAll('input[type=checkbox],input[type=radio],input[type=range]').forEach(function (i) {
    if (out(i)) return;
    if (getComputedStyle(i).appearance !== 'none') bad.push(name(i));
  });
  document.querySelectorAll('input[list]').forEach(function (i) { if (!out(i)) bad.push(name(i) + '[list]'); });
  document.querySelectorAll('summary').forEach(function (s) { if (getComputedStyle(s).display === 'list-item' && !s.hasAttribute('data-a1c') && !out(s)) bad.push('summary'); });
  document.querySelectorAll('input[type=number]').forEach(function (i) {
    if (!out(i) && getComputedStyle(i, '::-webkit-inner-spin-button').webkitAppearance !== 'none' && getComputedStyle(i).appearance !== 'textfield') bad.push(name(i));
  });
  return { on: !!window.A1Controls || !!window.VaultControls || !!window.SosControls, bad: bad };`;

const PAGES = ['index.html', 'magi.html', 'mylist.html', 'shield.html', 'Shruti/shruti.html', 'wellness.html',
  'backup-restore.html', 'backup-export.html', 'V1/studyos.html',
  'oneinbox.html', 'insight.html', 'tradehub.html', 'riftiq.html', 'everwell.html', 'vault.html'];
const VEDA = [
  ['index.html', "document.body.setAttribute('data-th-profile', 'veda')"],
  ['magi.html', "document.documentElement.setAttribute('data-profile', 'veda')"],
  ['mylist.html', "document.body.setAttribute('data-profile', 'veda')"],
  ['shield.html', "document.body.setAttribute('data-profile', 'veda')"],
  ['Shruti/shruti.html', "document.body.setAttribute('data-profile', 'veda')"],
];

(async () => {
  const c = await connect();
  await c.send('Page.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  console.log('Fixture — selects');
  await go(c, BASE + 'tests/live/fixtures/controls.html', 2500);
  ok('A1Controls is on', await evalJs(c, '!!window.A1Controls'));
  const marks = await evalJs(c, `return ['plain','own','inline','native','multi'].map(function (id) { return document.getElementById(id).getAttribute('data-a1c'); });`);
  ok('native-looking select marked sel, page-drawn one own, opted-out and multiple left alone', JSON.stringify(marks) === JSON.stringify(['sel', 'own', 'sel', null, null]), marks);
  ok("the native-looking select wears A1's chevron", await evalJs(c, "/svg/.test(getComputedStyle(document.getElementById('plain')).backgroundImage)"));
  await evalJs(c, "window.changes = 0; document.getElementById('plain').addEventListener('change', function () { window.changes++; }); return 1;");
  await click(c, '#plain');
  let pop = await evalJs(c, POP);
  ok('clicking a select opens the A1 list: every option, the chosen one marked, disabled one marked', pop && JSON.stringify(pop.rows) === JSON.stringify(['Apple*', 'Banana', 'Cherry!', 'Date']), pop);
  ok('the list is in the top layer', pop && pop.top, pop);
  ok('the list takes the page colours (dark) and Tony\'s purple', pop && !pop.light && pop.ac === '#c0aeea', pop);
  await pick(c, 'Cherry');
  ok('a disabled option cannot be picked', (await evalJs(c, "document.getElementById('plain').value")) === 'a');
  await pick(c, 'Date');
  ok('picking sets the value, fires change once and closes', (await evalJs(c, "document.getElementById('plain').value + ':' + window.changes + ':' + !document.querySelector('.a1c-pop.on')")) === 'd:1:true');
  await click(c, '#plain');
  await click(c, '#plain');
  ok('clicking the select again closes its list', (await evalJs(c, "!document.querySelector('.a1c-pop.on')")) === true);
  // Keyboard.
  await evalJs(c, "document.getElementById('plain').focus(); return 1;");
  await key(c, 'ArrowDown');
  ok('ArrowDown on a focused select opens the list', !!(await evalJs(c, POP)));
  await key(c, 'ArrowUp'); await key(c, 'ArrowUp');
  await key(c, 'Enter');
  ok('arrows + Enter pick (skipping the disabled one)', (await evalJs(c, "document.getElementById('plain').value")) === 'b');
  await key(c, ' ');
  await key(c, 'Escape');
  ok('Escape closes it, focus stays on the select', (await evalJs(c, "!document.querySelector('.a1c-pop.on') && document.activeElement.id")) === 'plain');
  await click(c, '#inline');
  await pick(c, 'Y');
  ok('an inline onchange="" still runs', (await evalJs(c, 'window.inlineFired')) === 'y');
  await click(c, '#own');
  ok("a page-drawn select keeps its look but opens the A1 list", !!(await evalJs(c, POP)));
  await key(c, 'Escape');

  console.log('Fixture — pickers');
  ok('date input hidden, A1 button shows the date', (await evalJs(c, "getComputedStyle(document.getElementById('date')).display")) === 'none' && /2026/.test(await evalJs(c, trigText('date'))), await evalJs(c, trigText('date')));
  const wide = await center(c, '#wide-date + .a1c-trig');
  ok('a width:100% date field stays full width', wide && Math.abs(wide.w - 400) < 2, wide);
  await click(c, '#date + .a1c-trig');
  const cal = await evalJs(c, "var p = document.querySelector('.a1c-pop.on.a1c-cal'); if (!p) return null; var d = Array.prototype.find.call(p.querySelectorAll('.a1c-cell'), function (x) { return x.textContent === '1' && !x.classList.contains('out'); }); return { title: p.querySelector('.a1c-cal-title').textContent, sel: (p.querySelector('.a1c-cell.sel') || {}).textContent, firstDisabled: d && d.disabled };");
  ok('the calendar opens on the value\'s month, the day chosen, min respected', cal && /2026/.test(cal.title) && cal.sel === '4' && cal.firstDisabled === true, cal);
  await evalJs(c, "window.dchg = 0; document.getElementById('date').addEventListener('change', function () { window.dchg++; }); return 1;");
  await evalJs(c, "var p = document.querySelector('.a1c-pop.on.a1c-cal'); var d = Array.prototype.find.call(p.querySelectorAll('.a1c-cell'), function (x) { return x.textContent === '10' && !x.classList.contains('out'); }); d.click(); return 1;");
  await sleep(200);
  ok('picking a day sets the value, fires change, closes', (await evalJs(c, "document.getElementById('date').value + ':' + window.dchg + ':' + !document.querySelector('.a1c-pop.on')")) === '2026-03-10:1:true');
  await evalJs(c, "document.getElementById('date').value = '2026-12-25'; return 1;");
  ok('code setting .value repaints the button', /Dec/.test(await evalJs(c, trigText('date'))), await evalJs(c, trigText('date')));
  ok('a time shows as 2:35 PM', (await evalJs(c, trigText('time'))) === '2:35 PM');
  await click(c, '#time + .a1c-trig');
  await pick(c, '9', '.a1c-col.h .a1c-cell');
  ok('the clock: tapping 9 keeps PM (21:35)', (await evalJs(c, "document.getElementById('time').value")) === '21:35');
  await pick(c, 'AM', '.a1c-col.ap .a1c-cell');
  ok('…and AM makes it 09:35', (await evalJs(c, "document.getElementById('time').value")) === '09:35');
  await key(c, 'Escape');
  await click(c, '#dtl + .a1c-trig');
  ok('datetime-local: calendar plus clock', (await evalJs(c, "!!document.querySelector('.a1c-pop.on.a1c-cal .a1c-cols')")) === true);
  await evalJs(c, "var p = document.querySelector('.a1c-pop.on.a1c-cal'); Array.prototype.find.call(p.querySelectorAll('.a1c-cal-grid .a1c-cell'), function (x) { return x.textContent === '15' && !x.classList.contains('out'); }).click(); return 1;");
  await sleep(150);
  ok('picking a day gives the day at 9:00 and keeps the picker open', /-15T09:00$/.test(await evalJs(c, "document.getElementById('dtl').value")) && !!(await evalJs(c, "document.querySelector('.a1c-pop.on')")));
  await key(c, 'Escape');
  await click(c, '#dl');
  await c.send('Input.insertText', { text: 'M' });
  await sleep(200);
  pop = await evalJs(c, POP);
  ok('a datalist input suggests in an A1 list, no list attribute left', pop && pop.rows.join() === 'Mango,Melon' && (await evalJs(c, "document.getElementById('dl').hasAttribute('list')")) === false, pop);
  await pick(c, 'Melon');
  ok('picking a suggestion fills the input', (await evalJs(c, "document.getElementById('dl').value")) === 'Melon');

  console.log('Fixture — boxes, ranges, details, tooltips');
  const boxes = await evalJs(c, `function s(id) { var e = document.getElementById(id), cs = getComputedStyle(e); return { a: e.hasAttribute('data-a1c'), app: cs.appearance, w: e.offsetWidth, bg: cs.backgroundColor }; }
    document.getElementById('cb').checked = true; return { cb: s('cb'), gold: s('gold'), sw: s('sw'), r1: s('r1'), rng: s('rng'), ce: s('ce-cb'), vcb: s('vcb'),
      pct: document.getElementById('rng').style.getPropertyValue('--a1c-pct'), sum: document.getElementById('sum').hasAttribute('data-a1c'),
      spin: getComputedStyle(document.getElementById('num')).appearance };`);
  ok('a plain checkbox is A1\'s: 16px, Tony\'s purple when ticked', boxes.cb.a && boxes.cb.app === 'none' && boxes.cb.w === 16 && boxes.cb.bg === 'rgb(192, 174, 234)', boxes.cb);
  ok('a gold box stays gold', boxes.gold.a && boxes.gold.bg === 'rgb(224, 184, 116)', boxes.gold);
  ok("the page's own toggle switch is left alone", !boxes.sw.a && boxes.sw.w === 40, boxes.sw);
  ok('radio and range are A1\'s, the range fill tracks', boxes.r1.a && boxes.rng.a && boxes.pct === '50%', boxes);
  ok('a checkbox inside an editor is restyled without a mark written into the document', !boxes.ce.a && boxes.ce.app === 'none', boxes.ce);
  ok("Veda's side: her mauve", boxes.vcb.bg === 'rgb(141, 118, 154)', boxes.vcb);
  ok('details marker replaced, number spinners off', boxes.sum && boxes.spin === 'textfield', boxes);
  const tp = await center(c, '#tipped');
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tp.x, y: tp.y });
  await sleep(700);
  const tip = await evalJs(c, "var t = document.querySelector('.a1c-tip.on'); return { text: t && t.textContent, title: document.getElementById('tipped').getAttribute('title') };");
  ok('hovering shows an A1 tooltip, the title is off while over it', tip.text === 'Hello tip' && tip.title === null, tip);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 880 });
  await sleep(250);
  ok('leaving hides it and puts the title back', (await evalJs(c, "!document.querySelector('.a1c-tip.on') && document.getElementById('tipped').getAttribute('title')")) === 'Hello tip');

  console.log('Fixture — Veda light, modal, React');
  await click(c, '#vsel');
  pop = await evalJs(c, POP);
  ok("Veda's light side: a light list in her mauve", pop && pop.light && pop.ac === '#8D769A', pop);
  await key(c, 'Escape');
  await click(c, '#msel');
  pop = await evalJs(c, POP);
  ok('inside a clipping modal: the list lives in the modal but is not cut off', pop && pop.parent === 'modal' && pop.top && pop.h > 120, pop);
  await key(c, 'Escape');
  await click(c, '#rsel');
  await pick(c, 'Home');
  ok('React select: a pick reaches onChange and state', (await evalJs(c, 'window.reactState.cat + "|" + window.reactLog.join()')) === 'home|cat:home', await evalJs(c, 'window.reactLog'));
  await evalJs(c, "window.reactSet.cat('work'); return 1;");
  await sleep(100);
  ok('React setting state shows in the select', (await evalJs(c, "var s = document.getElementById('rsel'); return s.options[s.selectedIndex].text;")) === 'Work');
  ok('React date: button shows its value', /May/.test(await evalJs(c, trigText('rdate'))), await evalJs(c, trigText('rdate')));
  await click(c, '#rdate + .a1c-trig');
  await evalJs(c, "Array.prototype.find.call(document.querySelectorAll('.a1c-pop.on .a1c-cal-grid .a1c-cell'), function (x) { return x.textContent === '20' && !x.classList.contains('out'); }).click(); return 1;");
  await sleep(150);
  ok('React date: a pick reaches onChange and state', (await evalJs(c, 'window.reactState.date')) === '2026-05-20', await evalJs(c, 'window.reactLog'));
  await evalJs(c, "window.reactSet.date('2026-07-01'); return 1;");
  await sleep(100);
  ok('React setting the date repaints the button', /Jul/.test(await evalJs(c, trigText('rdate'))), await evalJs(c, trigText('rdate')));
  await click(c, '#rtime + .a1c-trig');
  await pick(c, '30', '.a1c-col.m .a1c-cell');
  ok('React time: a pick reaches state', (await evalJs(c, 'window.reactState.time')) === '09:30', await evalJs(c, 'window.reactLog'));
  await key(c, 'Escape');
  await click(c, '#rcb');
  ok('React checkbox: A1\'s and still toggles state', (await evalJs(c, "window.reactState.prep && document.getElementById('rcb').hasAttribute('data-a1c')")) === true);
  await evalJs(c, "window.reactSet.show(false); return 1;");
  await sleep(150);
  ok('React removing the date input removes its button', (await evalJs(c, "document.querySelectorAll('#react .a1c-trig').length")) === 1);
  await evalJs(c, "window.reactSet.show(true); return 1;");
  await sleep(150);
  ok('…and bringing it back gives one button', (await evalJs(c, "document.querySelectorAll('#react .a1c-trig').length")) === 2);

  console.log('Fixture — phone (touch)');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await go(c, BASE + 'tests/live/fixtures/controls.html', 2500);
  await tap(c, '#plain');
  pop = await evalJs(c, POP);
  ok('tapping a select opens the A1 list', !!pop, pop);
  const row = await evalJs(c, "var r = Array.prototype.find.call(document.querySelectorAll('.a1c-pop.on .a1c-opt'), function (x) { return x.textContent.trim() === 'Banana'; }); var b = r.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2, h: b.height };");
  ok('rows are finger-sized', row.h >= 44, row);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: row.x, y: row.y }] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(250);
  ok('tapping a row picks it', (await evalJs(c, "document.getElementById('plain').value")) === 'b');
  await tap(c, '#date + .a1c-trig');
  ok('tapping a date opens the calendar', (await evalJs(c, "!!document.querySelector('.a1c-pop.on.a1c-cal')")) === true);
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  console.log('Every program — nothing left that the browser draws');
  for (const [label, metrics] of [['desktop', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }],
    ['phone', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }]]) {
    await c.send('Emulation.setDeviceMetricsOverride', metrics);
    for (const p of PAGES) {
      await go(c, BASE + p, 3500);
      const r = await evalJs(c, AUDIT);
      ok(`${p} (${label}): controls on, none native`, r.on && r.bad.length === 0, r);
    }
  }
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  for (const [p, flip] of VEDA) {
    await go(c, BASE + p, 3500);
    await evalJs(c, flip + '; return 1;');
    await sleep(300);
    const r = await evalJs(c, AUDIT);
    const ac = await evalJs(c, "var i = document.createElement('input'); i.type = 'checkbox'; i.checked = true; document.body.appendChild(i); return new Promise(function (res) { setTimeout(function () { var bg = getComputedStyle(i).backgroundColor; i.remove(); res(bg); }, 50); });");
    ok(`${p} (Veda): controls on, none native, her mauve`, r.on && r.bad.length === 0 && ac === 'rgb(141, 118, 154)', { r, ac });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
