// resizegrip.js (window.A1Resize): MAGI's corner resize grip, shared by every
// A1 program (theme overhaul, docs/theme-overhaul-plan.md §2 "Resize handles").
// Driven in jsdom; the box's height comes from its inline style (or data-h when
// it has none), so the geometry the grip reads is the one written here.
//
// Run: node tests/resizegrip.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'resizegrip.js'), 'utf8');

function boot(storageThrows) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://a1.test/' });
  const { window } = dom;
  Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true });
  window.Element.prototype.getBoundingClientRect = function () {
    const h = parseFloat(this.style.height) || Number(this.dataset.h || 0);
    return { left: 0, top: 0, width: 300, height: h, right: 300, bottom: h, x: 0, y: 0 };
  };
  window.Element.prototype.setPointerCapture = function () {};
  window.Element.prototype.releasePointerCapture = function () {};
  if (storageThrows) {
    const boom = () => { throw new Error('SecurityError'); };
    Object.defineProperty(window, 'localStorage', { get: boom, configurable: true });
  }
  window.eval(src);
  return window;
}

function ptr(window, type, target, y, id) {
  const C = window.PointerEvent || window.MouseEvent;
  const e = new C(type, { bubbles: true, cancelable: true, clientX: 290, clientY: y, button: 0, pointerId: id || 1, pointerType: 'mouse' });
  if (e.pointerId === undefined) Object.defineProperty(e, 'pointerId', { value: id || 1 });
  target.dispatchEvent(e);
  return e;
}

function make(window, key, natural, onAuto) {
  const doc = window.document;
  const wrap = doc.createElement('div'); wrap.style.position = 'relative';
  const ta = doc.createElement('textarea'); ta.dataset.h = String(natural || 100);
  const g = window.A1Resize.grip('the test box');
  wrap.append(ta, g); doc.body.appendChild(wrap);
  window.A1Resize.attach(ta, g, key, onAuto);
  return { ta, g };
}

function dragBy(window, g, dy) {
  ptr(window, 'pointerdown', g, 500);
  ptr(window, 'pointermove', g, 500 + Math.round(dy / 2));
  ptr(window, 'pointermove', g, 500 + dy);
  ptr(window, 'pointerup', g, 500 + dy);
}
function click(window, g) {
  ptr(window, 'pointerdown', g, 500);
  ptr(window, 'pointermove', g, 501);
  ptr(window, 'pointerup', g, 501);
  g.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
const key = (window, g, k) => g.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

console.log('resizegrip.js');
{
  const w = boot();
  const { ta, g } = make(w, null, 100);
  ok('grip is a real button with the MAGI title', g.tagName === 'BUTTON' && g.type === 'button' && /Drag to resize\. Click to expand or compress\./.test(g.title));
  ok('grip aria-label names the box', g.getAttribute('aria-label') === 'Resize the test box');
  ok('CSS injected once', w.document.querySelectorAll('#a1-resizegrip-css').length === 1);
  ok('native resize corner is switched off', ta.classList.contains('a1-grip-box') && /\.a1-grip-box \{ resize: none !important; \}/.test(w.document.getElementById('a1-resizegrip-css').textContent));

  dragBy(w, g, 80);
  ok('drag sets the height', ta.style.height === '180px', ta.style.height);
  ok('drag lifts the max-height cap', ta.style.maxHeight === '180px');
  ok('drag overrides a CSS min-height too (the prompt box has 34vh)', ta.style.minHeight === '180px');
  ok('hand-sized box is marked and the grip is on', ta.getAttribute('data-user-h') === '180' && g.classList.contains('on'));

  dragBy(w, g, 5000);
  ok('drag is capped at 60% of the viewport', ta.style.height === '600px', ta.style.height);
  dragBy(w, g, -5000);
  ok('drag floors at 26px', ta.style.height === '26px', ta.style.height);
}
{
  const w = boot();
  let autos = 0;
  const { ta, g } = make(w, null, 100, () => autos++);
  click(w, g);
  ok('click on a natural box expands to at least 260px', ta.style.height === '260px', ta.style.height);
  click(w, g);
  ok('click on a sized box hands it back to auto', ta.style.height === '' && ta.style.minHeight === '' && ta.style.maxHeight === '' && !ta.hasAttribute('data-user-h') && !g.classList.contains('on'));
  ok('handing back calls onAuto', autos === 1, autos);
  ta.dataset.h = '400';
  click(w, g);
  ok('expand is +120px when that is more than 260', ta.style.height === '520px', ta.style.height);
  click(w, g);
  key(w, g, 'Enter');
  ok('Enter toggles like a click', ta.style.height === '520px', ta.style.height);
  key(w, g, ' ');
  ok('Space toggles back', ta.style.height === '');
  key(w, g, 'a');
  ok('other keys do nothing', ta.style.height === '');
}
{
  const w = boot();
  const a = make(w, 'mj.prompt', 100);
  dragBy(w, a.g, 150);
  ok('height is stored per key', w.localStorage.getItem('a1.h.mj.prompt') === '250');
  const b = make(w, 'mj.prompt', 100);
  ok('a new box with the same key starts at the stored height', b.ta.style.height === '250px' && b.g.classList.contains('on'));
  w.localStorage.setItem('a1.h.big', '9000');
  const c = make(w, 'big', 100);
  ok('a stored height above the cap is clamped', c.ta.style.height === '600px', c.ta.style.height);
  click(w, b.g);
  ok('handing back clears the stored height', w.localStorage.getItem('a1.h.mj.prompt') === null);
  const d = make(w, null, 100);
  dragBy(w, d.g, 40);
  ok('no key, nothing stored', w.localStorage.length === 1, w.localStorage.length);
}
{
  const w = boot(true);
  let threw = null, r;
  try { r = make(w, 'x', 100); dragBy(w, r.g, 60); click(w, r.g); click(w, r.g); } catch (e) { threw = e; }
  ok('storage that throws does not break the grip', !threw && r && r.ta.style.height === '260px', threw || (r && r.ta.style.height));
}
{
  // Every copy of the file is the same file (extensions carry their own).
  const copies = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name === 'resizegrip.js') copies.push(p);
    }
  };
  walk(ROOT);
  ok('every resizegrip.js copy is byte-identical', copies.every((p) => fs.readFileSync(p, 'utf8') === src), copies.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
