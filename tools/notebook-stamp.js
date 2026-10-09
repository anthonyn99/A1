#!/usr/bin/env node
// Rewrites every host page's `Notebook/notebook.js?v=<stamp>` to a hash of the
// Notebook/ folder, so GitHub Pages' 10-minute cache can never serve a host a
// mix of old and new Notebook files (notebook.js stamps every file it loads
// with its own ?v=). Run it after any change under Notebook/:
//   node tools/notebook-stamp.js           rewrite the stale stamps
//   node tools/notebook-stamp.js --check   exit 1 if any stamp is stale
// tests/notebook-wiring.test.js runs the check.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const NB = path.join(ROOT, 'Notebook');
const TAG = /(Notebook\/notebook\.js\?v=)([^"'&#\s]*)/g;

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : [p];
  });
}

// Content hash of the folder. CRLF is folded to LF so a Windows checkout and
// the deployed (LF) files agree.
function stamp() {
  const h = crypto.createHash('sha1');
  for (const f of files(NB).sort()) {
    h.update(path.relative(NB, f).split(path.sep).join('/') + '\0');
    h.update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n') + '\0');
  }
  return h.digest('hex').slice(0, 10);
}

// Host pages: any .html in the repo that loads notebook.js.
function hosts() {
  const skip = new Set(['.git', 'node_modules', 'Notebook']);
  const out = [];
  (function walk(dir) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(d.name)) continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.endsWith('.html') && fs.readFileSync(p, 'utf8').includes('Notebook/notebook.js')) out.push(p);
    }
  })(ROOT);
  return out;
}

function run(check) {
  const want = stamp();
  const stale = [];
  for (const f of hosts()) {
    const src = fs.readFileSync(f, 'utf8');
    const next = src.replace(TAG, (m, a) => a + want);
    if (next !== src) {
      stale.push(path.relative(ROOT, f));
      if (!check) fs.writeFileSync(f, next);
    }
  }
  return { want, stale, hosts: hosts().map((f) => path.relative(ROOT, f)) };
}

module.exports = { stamp, hosts, run };

if (require.main === module) {
  const check = process.argv.includes('--check');
  const r = run(check);
  if (check) {
    if (r.stale.length) { console.error(`stale Notebook stamp (want ${r.want}) in: ${r.stale.join(', ')}\nrun: node tools/notebook-stamp.js`); process.exit(1); }
    console.log(`Notebook stamp ${r.want} current in ${r.hosts.join(', ')}`);
  } else {
    console.log(r.stale.length ? `stamped ${r.want} into ${r.stale.join(', ')}` : `Notebook stamp ${r.want} already current`);
  }
}
