#!/usr/bin/env node
/**
 * Parses every inline script in index.html.
 *
 * index.html is a single ~39k-line file that ships straight to the browser with
 * no build step, so a stray syntax error is not caught by anything else — it just
 * makes the whole app fail to start on every device. This is the cheap check that
 * stops that reaching a phone.
 *
 * Run: node tests/syntax-check.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(file, 'utf8');

// Strip HTML comments first: several contain the literal text "<script ...>",
// which otherwise gets scanned as if it were real code and reported as a
// bogus syntax error.
const scrubbed = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

let babelParse = null;
try { babelParse = require('@babel/parser').parse; } catch (e) { /* optional */ }

const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
let m, checked = 0, skipped = 0;
const errors = [];

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
      errors.push('index.html:' + (line + (e.loc ? e.loc.line : 0)) +
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
    errors.push('index.html:~' + line + ' — ' + e.message);
  }
}

if (errors.length) {
  console.error('Syntax errors in index.html:\n');
  errors.forEach((e) => console.error('  • ' + e));
  console.error('\nThis would break the app on every device. Fix before shipping.');
  process.exit(1);
}
console.log('Syntax OK — parsed ' + checked + ' inline scripts' +
  (skipped ? ' (' + skipped + ' JSX block(s) skipped: @babel/parser not installed)' : '') + '.');
