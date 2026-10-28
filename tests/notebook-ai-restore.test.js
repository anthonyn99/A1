#!/usr/bin/env node
/**
 * Notebook AI tools never lose an image, file or link (Notebook/core/docx.js
 * aiRestoreImages).
 *
 * Before an AI tool runs, every image, file chip and link becomes an opaque
 * [[IMGn]] token. A model that dropped a token used to delete that image from
 * the page without a word. The worker now prefers an answer that kept every
 * token; this pins the editor-side backstop: a lost token's original HTML goes
 * back at the end of its piece, a kept one is restored in place, and a
 * duplicated one cannot double it.
 *
 * Run: node tests/notebook-ai-restore.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'Notebook', 'core', 'docx.js'), 'utf8');
const a = src.indexOf('function aiRestoreImages(');
const b = src.indexOf('\n}\n', a) + 3;
const sb = { document: { createElement: () => ({ innerHTML: '', querySelector: () => null }) } };
vm.createContext(sb);
vm.runInContext(src.slice(a, b) + '\nthis.aiRestoreImages = aiRestoreImages;', sb);
const R = sb.aiRestoreImages;

const IMG = { n: 1, html: '<div class="pg-img-wrap"><img src="a.png"></div>' };
const LINK = { n: 2, html: '<a href="https://x.test">x</a>' };

console.log('\nNotebook AI restore');
t('a kept token is restored in place', R('<p>a</p>[[IMG1]]<p>b</p>', [IMG]) === '<p>a</p>' + IMG.html + '<p>b</p>');
t('a size hint still restores', R('[[IMG1|large]]', [IMG]).includes('pg-img-wrap'));
t('a dropped image comes back at the end', R('<p>a</p>', [IMG]) === '<p>a</p>' + IMG.html);
t('a dropped link comes back in its own paragraph', R('<p>a</p>', [LINK]) === '<p>a</p><p>' + LINK.html + '</p>');
t('a duplicated token cannot double an image', R('[[IMG1]][[IMG1]]', [IMG]) === IMG.html);
t('a token for another section restores to nothing here', R('[[IMG9]]<p>a</p>', [IMG]) === '<p>a</p>' + IMG.html);
t('no images: the html is untouched', R('<p>a</p>', []) === '<p>a</p>');
t('sections restore their own images (whole-doc run)', /aiRestoreImages\(m\[1\], chunks\[i\]\.imgs\)/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
