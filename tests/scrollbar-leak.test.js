// Shared/scrollbar.js never keeps a removed scroller (Tony 2026-11-21: TradeHub at 1.1 GB; the bars Map held
// every old Market and Charts page). A box removed while its bar is idle is dropped by the sweep.
'use strict';
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + x : '')); } };
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="page"><div id="box" style="overflow:auto"></div></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.eval(fs.readFileSync(path.join(__dirname, '..', 'Shared', 'scrollbar.js'), 'utf8'));
const S = w.A1Scrollbar;
ok('the scrollbar loads and exposes its test hooks', S && typeof S._held === 'function' && typeof S._sweep === 'function');
const box = w.document.getElementById('box');
S.show(box);
ok('a shown box is held', S._held() === 1, S._held());
S.show(box);
ok('...once (showing it again holds no second entry)', S._held() === 1, S._held());
w.document.getElementById('page').remove();
ok('the page removed (a tab switch): the sweep drops its box', S._sweep() === 0, S._held());
const keep = w.document.createElement('div'); w.document.body.appendChild(keep);
S.show(keep);
ok('a box still on the page is kept by the sweep', S._sweep() === 1, S._held());
const src = fs.readFileSync(path.join(__dirname, '..', 'Shared', 'scrollbar.js'), 'utf8');
ok('barFor sweeps (throttled) and a 10 s interval sweeps whatever is left', /function barFor\(el\) \{\n\s+sweep\(false\);/.test(src) && /setInterval\(function \(\) \{ if \(bars\.size\) sweep\(true\); \}, 10000\)/.test(src));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
w.close();
process.exit(fail ? 1 : 0);
