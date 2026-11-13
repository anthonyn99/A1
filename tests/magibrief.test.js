#!/usr/bin/env node
/**
 * Shared/magibrief.js: MAGI's Brief / Text answer views for other programs.
 *
 * WHY THIS FILE EXISTS
 * TradeHub's Debrief draws MAGI's answers and must look exactly like MAGI.
 * The renderer is cut out of magi.html by tools/build-magibrief.js. These
 * checks fail when (1) magi.html changed and the shared file was not rebuilt,
 * or (2) the cut no longer runs on its own (a helper it needs moved outside
 * the cut markers), which would leave the Debrief blank rather than red.
 *
 * Run: node tests/magibrief.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

// 1. It is what the build makes from today's magi.html.
const chk = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-magibrief.js'), '--check'], { encoding: 'utf8' });
t('Shared/magibrief.js matches magi.html (node tools/build-magibrief.js)', chk.status === 0, (chk.stderr || chk.stdout).trim());

// 2. It runs alone and draws both views.
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', url: 'https://example.test/' });
const w = dom.window;
let err = null;
try { w.eval(fs.readFileSync(path.join(ROOT, 'Shared', 'magibrief.js'), 'utf8')); } catch (e) { err = e; }
t('loads without error', !err, err && err.message);
const MB = w.MagiBrief;
t('exposes install / brief / text / render / view / setView',
  MB && ['install', 'brief', 'text', 'render', 'view', 'setView'].every((k) => typeof MB[k] === 'function'));

const SAMPLE = [
  'ANSWER',
  'Stocks rose on softer inflation data. Rate-cut odds for December climbed, and the Nasdaq led.',
  '',
  '### Key drivers',
  '- **CPI:** core came in at 0.2% m/m',
  '- **Yields:** the 10-year fell 9 bp',
  '- **Breadth:** 80% of the S&P rose',
  '',
  '### Risks',
  '1. A hot PPI tomorrow',
  '2. Oil above $100',
  '',
  '**Bullish if:**',
  '- yields keep falling',
  '',
  'Oil ↑ → yields ↑ → Nasdaq ↓',
  '',
  '| Ticker | Move |',
  '|---|---:|',
  '| NVDA | +3.1% |',
  '',
  '```bash',
  'echo hi',
  '```',
  '',
  'NOTES',
  '- PPI is at 8:30 ET.',
  '',
  'CONFIDENCE',
  'HIGH — the data was unambiguous.',
].join('\n');

let brief = null, text = null;
try { brief = MB.brief(SAMPLE); } catch (e) { err = e; }
t('Brief renders', brief && brief.classList.contains('brief'), err && err.stack);
err = null;
try { text = MB.text(SAMPLE); } catch (e) { err = e; }
t('Text renders', text && text.classList.contains('verdict-body') && !text.classList.contains('brief'), err && err.stack);
if (brief) {
  t('Brief: headline, section cards, key-point cards, confidence, notes',
    brief.querySelector('.br-headline') && brief.querySelectorAll('.br-sec').length >= 2 &&
    brief.querySelector('.br-points') && brief.querySelector('.br-conf.high') && brief.querySelector('.br-notes'));
  t('Brief: risks card toned bad, flow row, table, code block with copy',
    brief.querySelector('.br-sec.tone-bad') && brief.querySelector('.br-flow') &&
    brief.querySelector('.v-table') && brief.querySelector('.md-pre-wrap .copybtn'));
}
if (text) t('Text: answer column + notes/confidence aside', text.querySelector('.v-main') && text.querySelector('.v-aside'));

// A minus after a bold lead is the number's sign, not a separator; a spaced
// hyphen still is one.
const signs = MB.brief('### Movers\n1. **TSLA** -2.4% after a delivery cut\n2. **NVDA** +3.1% on orders\n3. **AMD** - beat on revenue');
const bodies = [...signs.querySelectorAll('.br-point-body')].map((b) => b.textContent.trim());
t('"**TSLA** -2.4%" keeps its minus; "**AMD** - beat" drops the separator',
  bodies[0] === '-2.4% after a delivery cut' && bodies[1] === '+3.1% on orders' && bodies[2] === 'beat on revenue', JSON.stringify(bodies));

// A model's markup never becomes markup.
const evil = MB.brief('Hello <img src=x onerror=alert(1)> and <script>alert(2)</script> [x](javascript:alert(3))');
t('no HTML injection', !evil.querySelector('img,script') && !evil.querySelector('a[href^="javascript"]'));

// The view choice: MAGI's key, an event on change.
let seen = null;
w.addEventListener('magibrief:view', (e) => { seen = e.detail; });
t('defaults to brief', MB.view() === 'brief');
MB.setView('text');
t('setView saves under MAGI\'s key and fires magibrief:view',
  MB.view() === 'text' && w.localStorage.getItem('magi.verdict.view') === 'text' && seen === 'text');
t('render follows the view', MB.render(SAMPLE).classList.contains('brief') === false);
MB.setView('brief');

// The CSS goes in once per scope, every rule under it.
MB.install('#root .mb');
MB.install('#root .mb');
const st = w.document.querySelectorAll('style[data-magibrief]');
t('install adds one style per scope', st.length === 1);
const rules = st[0] ? st[0].textContent : '';
t('every rule is scoped', rules.length > 10000 && !/__SCOPE__/.test(rules) &&
  rules.split('\n').filter((l) => l && !l.startsWith('@') && !l.startsWith('}') && l.includes('{'))
    .every((l) => l.split('{')[0].split(',').every((s) => s.trim().startsWith('#root .mb'))),
  rules.split('\n').find((l) => l && !l.startsWith('@') && l.includes('{') && !l.startsWith('#root .mb')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
