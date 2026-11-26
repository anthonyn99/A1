#!/usr/bin/env node
// Notebook does no work of its own while nothing changes.
//
// Typing in a long illustrated page lagged by seconds (Tony, 2026-11-21) and
// the cause was not the typing: core/mobile.js re-queued its own state pass on
// every frame, forever. Its sync() ran root.classList.remove('nb-kb'), and
// classList.remove rewrites the class attribute even when the class is absent,
// which its own MutationObserver (watching the root's class) saw as a change.
// Each pass forced a layout of the whole page and woke every page-wide
// observer, on both sides at once, in every program that mounts Notebook.
//
// This boots mobile.js on a bare journal root (jsdom, desktop and phone
// widths), lets it settle, and requires that the root, its buttons and <html>
// then see no mutation at all over many frames. It also holds Veda's Neo HUD
// (TaskHub/veda-neo.js), which sat invisible over every program with an
// endless animation, to pausing while hidden.
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const MOBILE = fs.readFileSync(path.join(ROOT, 'Notebook/core/mobile.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

async function settle(narrow, editing, noentry) {
  const K = 'tj';
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="${K}-root" class="${noentry ? 'nb-noentry' : ''}">
      <div id="${K}-mobile-header"><button id="${K}-hamburger"></button></div>
      <div id="${K}-sidebar"><div id="${K}-entries-list"><div class="entry-item active" data-entry-id="e1"></div></div></div>
      <input type="checkbox" id="${K}-btn-edit" ${editing ? 'checked' : ''}>
      <div id="${K}-page-area" style="display:flex"><div id="${K}-page-toolbar" class="${editing ? 'edit-mode' : ''}"></div></div>
      <div id="${K}-locked-pane" style="display:none"></div>
    </div></body></html>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: narrow, addEventListener() {}, addListener() {} });
  w.eval(MOBILE);
  const frames = (n) => new Promise((res) => { let i = 0; const f = () => (++i >= n ? res() : w.requestAnimationFrame(f)); w.requestAnimationFrame(f); });
  await frames(10);   // the first passes may set things up
  const seen = [];
  const mo = new w.MutationObserver((l) => l.forEach((m) => seen.push(m.type + ':' + (m.attributeName || '') + ' ' + (m.target.id || m.target.className || m.target.tagName))))
  mo.observe(w.document.documentElement, { subtree: true, attributes: true, childList: true, characterData: true });
  await frames(30);
  mo.disconnect();   // w.close() empties the document: its records are teardown, not idle work
  w.close();
  return seen;
}

(async () => {
  console.log('Notebook idle: no self-sustaining work');
  for (const [label, narrow, editing, noentry] of [
    ['desktop, reading', false, false, false],
    ['desktop, editing', false, true, false],
    ['desktop, no entry', false, false, true],
    ['phone, reading', true, false, false],
    ['phone, editing', true, true, false],
  ]) {
    const seen = await settle(narrow, editing, noentry);
    ok('mobile.js is quiet once settled (' + label + ')', seen.length === 0, seen.slice(0, 6).join(' | '));
  }
  const src = MOBILE.replace(/\/\/.*$/gm, '');
  ok('mobile.js removes nb-kb only when the root has it', !/[^)]\s*root\.classList\.remove\('nb-kb'\)/.test(src.replace(/if \(root\.classList\.contains\('nb-kb'\)\) root\.classList\.remove\('nb-kb'\)/g, '')));

  console.log("Veda's Neo HUD pauses while hidden");
  const neo = fs.readFileSync(path.join(ROOT, 'TaskHub/veda-neo.js'), 'utf8');
  ok('the hidden HUD is not painted', /#vd-neo-hud:not\(\.show\):not\(\.vn-dock\)\{visibility:hidden;/.test(neo));
  ok('its sweep animation pauses while hidden', /#vd-neo-hud:not\(\.show\) \.vn-sweep\{animation-play-state:paused;\}/.test(neo));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
