// hoverfx.js's MAGI mode (data-hoverfx="magi"), driven in jsdom.
//
// The theme overhaul (docs/theme-overhaul-plan.md) moves one program at a time
// onto MAGI's hover language by putting data-hoverfx="magi" on its root. Two
// promises make that safe to do piecemeal, and both are pinned here:
//
//  1. Inside the attribute a control always LIFTS (brightness 1.15) and sinks on
//     press (brightness .94 + translate 0 1px), then comes back up on release.
//  2. Outside it nothing changes: the measured lift/settle still runs. That is
//     what keeps Veda's roots in the same page exactly as they were. The
//     nearest data-hoverfx wins, so data-hoverfx="classic" opts back out.
//
// Run: node tests/hoverfx-magi.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

const src = fs.readFileSync(path.join(__dirname, '..', 'hoverfx.js'), 'utf8');
const dom = new JSDOM(`<!doctype html><body style="background:#1a1a1d">
  <div id="magi" data-hoverfx="magi"><button id="m" style="background:#f4f3f0">M</button></div>
  <div id="plain"><button id="p" style="background:#f4f3f0">P</button></div>
  <div data-hoverfx="magi"><div data-hoverfx="classic"><button id="c" style="background:#f4f3f0">C</button></div></div>
</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
window.eval(src);
const doc = window.document;

const fire = (type, el, extra) => el.dispatchEvent(new window.MouseEvent(type,
  Object.assign({ bubbles: true, cancelable: true, button: 0 }, extra || {})));

const m = doc.getElementById('m'), p = doc.getElementById('p');

// 1. Outside MAGI: a bright filled control SETTLES (the measured behaviour).
fire('pointerover', p);
ok('outside magi: bright control settles (measured)', p.style.filter === 'brightness(0.86)', p.style.filter);
fire('pointerdown', p);
ok('outside magi: no press effect', p.style.filter === 'brightness(0.86)' && !p.style.translate, p.style.filter + ' ' + p.style.translate);
fire('pointerup', p);
fire('pointerout', p, { relatedTarget: doc.body });
ok('outside magi: cleared on leave', p.style.filter === '', p.style.filter);

// 2. Inside MAGI: the SAME bright control lifts instead.
fire('pointerover', m);
ok('magi: hover lifts 1.15 regardless of luminance', m.style.filter === 'brightness(1.15)', m.style.filter);
fire('pointerdown', m);
ok('magi: press sinks to .94', m.style.filter === 'brightness(0.94)', m.style.filter);
ok('magi: press moves down 1px via translate (never transform)',
   /0(px)? 1px/.test(m.style.translate || m.style.getPropertyValue('translate')) && !m.style.transform,
   (m.style.translate || m.style.getPropertyValue('translate')) + ' / ' + m.style.transform);
fire('pointerup', m);
ok('magi: release returns to the hover lift', m.style.filter === 'brightness(1.15)', m.style.filter);
ok('magi: release clears the translate', !(m.style.translate || m.style.getPropertyValue('translate')));
fire('pointerout', m, { relatedTarget: doc.body });
ok('magi: cleared on leave', m.style.filter === '', m.style.filter);

// 3. The nearest declaration wins: classic nested inside magi stays measured.
//    (index.html: <body> is magi while Tony is open; his journal says classic.)
const cl = doc.getElementById('c');
fire('pointerover', cl);
ok('classic inside magi: measured settle, not the magi lift', cl.style.filter === 'brightness(0.86)', cl.style.filter);
fire('pointerdown', cl);
ok('classic inside magi: no press', !(cl.style.translate || cl.style.getPropertyValue('translate')));
fire('pointerup', cl);
fire('pointerout', cl, { relatedTarget: doc.body });

// 4. The focus ring rule is injected, scoped to the attribute.
const css = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n');
ok('magi: focus-visible ring is scoped to [data-hoverfx="magi"]',
   /\[data-hoverfx="magi"\][^{]*:focus-visible[^{]*\{outline:2px solid var\(--fx-ac,#c0aeea\)/.test(css));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
