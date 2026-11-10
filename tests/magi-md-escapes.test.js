// MAGI showed stray backslashes in answers (Tony, 2026-11-09: "\1. Iran
// de-escalation"). The engine escapes text a chat page showed literally, and
// the console's renderer has to read those escapes back the way markdown does.
//   1. "\1. text" (an old escape, before the digit) renders "1. text", not a list
//   2. "1\. text" (the engine's escape since 2026-11-09) renders the same
//   3. every ASCII punctuation escape renders as the bare character
//   4. a real list still renders as a list; code is left alone
// Runs the real mdParse / inline from magi.html with a tiny DOM stand-in.
// Run: node tests/magi-md-escapes.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(process.env.MAGI_SRC || path.join(__dirname, '..', 'magi.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  -> ' + String(d).slice(0, 300) : '')); } };
const lift = (name) => {
  const at = SRC.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('not found: ' + name);
  let i = SRC.indexOf('{', at), depth = 0;
  for (let j = i; j < SRC.length; j++) { if (SRC[j] === '{') depth++; else if (SRC[j] === '}' && --depth === 0) return SRC.slice(at, j + 1); }
  throw new Error('unbalanced ' + name);
};
const constOf = (name) => { const m = new RegExp('\\nconst ' + name + ' = [\\s\\S]*?;\\n').exec(SRC); if (!m) throw new Error('const ' + name); return m[0]; };
const constBlock = (name) => { const at = SRC.indexOf('\nconst ' + name + ' = '); const end = SRC.indexOf('\n};', at); if (at < 0 || end < 0) throw new Error('block ' + name); return SRC.slice(at, end + 3); };
const inlineRe = (() => { const at = SRC.indexOf('const INLINE_RE = new RegExp(['); const end = SRC.indexOf('].join("|"), "g");', at); return SRC.slice(at, end + '].join("|"), "g");'.length); })();

// A minimal element: text content and children, enough for inline().
class Node { constructor(tag) { this.tag = tag; this.kids = []; } append(...xs) { for (const x of xs) this.kids.push(x); } get text() { return this.kids.map((k) => (typeof k === 'string' ? k : k.text)).join(''); } }
const el = (tag, cls, text) => { const n = new Node(tag); if (text !== undefined) n.append(String(text)); return n; };

const code = [constBlock('MD'), constOf('ESC_BOLD'), constOf('ESC_NUM'), lift('unescapeBold'), inlineRe, constOf('SAFE_HREF'), lift('inline'),
  'const htmlEntity = (e, raw) => raw; const mathEl = (t) => el("span", "m", t);'].join('\n');
const M = new Function('el', code + '\nreturn { MD, unescapeBold, inline };')(el);

console.log('Numbered lines escaped as not-a-list');
const fix = (s) => M.unescapeBold([s])[0];
ok('"\\1. Iran" (old escape) becomes "1\\. Iran"', fix('\\1. Iran de-escalation') === '1\\. Iran de-escalation', fix('\\1. Iran de-escalation'));
ok('…and no longer reads as a list item, nor keeps a backslash', !M.MD.ordered.test(fix('\\1. Iran')) && M.inline(el('p'), fix('\\1. Iran de-escalation')).text === '1. Iran de-escalation', M.inline(el('p'), fix('\\1. Iran de-escalation')).text);
ok('"12\\) twelve" (the engine\'s escape) renders "12) twelve"', M.inline(el('p'), '12\\) twelve').text === '12) twelve');
ok('a real list is still a list', M.MD.ordered.test(fix('1. a real item')) && fix('1. a real item') === '1. a real item');
ok('code is left alone', M.unescapeBold(['```', '\\1. inside code', '```'])[1] === '\\1. inside code');
console.log('\nEvery ASCII punctuation escape');
const punct = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const bad = [...punct].filter((ch) => M.inline(el('p'), 'a\\' + ch + 'b').text !== 'a' + ch + 'b');
ok('each "\\X" renders as X', bad.length === 0, bad.join(' '));
ok('"\\~4.85%" and "A \\/ B" read cleanly', M.inline(el('p'), 'below \\~4.85% and A \\/ B').text === 'below ~4.85% and A / B', M.inline(el('p'), 'below \\~4.85% and A \\/ B').text);
ok('a backslash before a letter stays (it is not an escape)', M.inline(el('p'), 'C:\\Users').text === 'C:\\Users');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
