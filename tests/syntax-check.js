#!/usr/bin/env node
/**
 * Parses every inline script in the single-file apps that ship straight to
 * GitHub Pages with no build step.
 *
 * Nothing else catches a stray syntax error in these files: there is no build,
 * no bundler and no type checker between an edit and the phone that loads it —
 * one bad token just means the whole app fails to start, everywhere. Shield
 * especially: it is the app you reach for when you need something closed RIGHT
 * NOW, so "it did not boot" is the worst possible failure mode. This is the
 * cheap check that stops any of them reaching a phone broken.
 *
 * Run: node tests/syntax-check.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Every page served straight from the repo root. A new single-file app belongs
// in this list the day it ships.
const FILES = [
  'index.html', 'shield.html', 'tradehub.html', 'vault.html', 'insight.html',
  'mylist.html', 'oneinbox.html', 'solace.html', 'riftiq.html', 'wellness.html',
];

let babelParse = null;
try { babelParse = require('@babel/parser').parse; } catch (e) { /* optional */ }

let checked = 0, skipped = 0;
const errors = [];

for (const name of FILES) {
  const file = path.join(__dirname, '..', name);
  if (!fs.existsSync(file)) { errors.push(name + ' — file not found'); continue; }
  const src = fs.readFileSync(file, 'utf8');

  // Strip HTML comments first: several contain the literal text "<script ...>",
  // which otherwise gets scanned as if it were real code and reported as a
  // bogus syntax error.
  const scrubbed = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(scrubbed))) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    const line = scrubbed.slice(0, m.index).split('\n').length;

    if (/\bsrc=/.test(attrs)) continue;              // external, nothing to parse
    if (/type=["']text\/template/.test(attrs)) continue;
    if (!body.trim()) continue;

    const isBabel = /type=["']text\/babel/.test(attrs);
    const isModule = /type=["']module/.test(attrs);

    if (isBabel) {
      if (!babelParse) { skipped++; continue; }      // JSX needs @babel/parser
      try { babelParse(body, { sourceType: 'script', plugins: ['jsx'] }); checked++; }
      catch (e) {
        errors.push(name + ':' + (line + (e.loc ? e.loc.line : 0)) +
          ' (JSX block starting line ' + line + ') — ' + e.message);
      }
      continue;
    }

    // Plain and module scripts: vm can't take import/export, so wrap after
    // removing static import lines. Syntax of the remaining body is what matters.
    const stripped = isModule
      ? body.replace(/^\s*import\s[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, '')
            .replace(/^\s*export\s+/gm, '')
      : body;
    try { new vm.Script('(async function(){' + stripped + '\n})'); checked++; }
    catch (e) {
      errors.push(name + ':~' + line + ' — ' + e.message);
    }
  }
}

if (errors.length) {
  console.error('Syntax errors:\n');
  errors.forEach((e) => console.error('  • ' + e));
  console.error('\nThis would break the app on every device. Fix before shipping.');
  process.exit(1);
}
console.log('Syntax OK — parsed ' + checked + ' inline scripts across ' + FILES.join(', ') +
  (skipped ? ' (' + skipped + ' JSX block(s) skipped: @babel/parser not installed)' : '') + '.');
