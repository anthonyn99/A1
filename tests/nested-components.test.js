/* No component that holds inputs may be declared inside another component.
 *
 * THE BUG THIS EXISTS FOR (2026-09-17)
 * TradeHub → Analysis → Quick Prompt took one character and then stopped
 * accepting typing. TBAnalysisPage declared `const Card=({children})=>(...)`
 * inside its own body, so every render made a brand-new component type. React
 * compares element types by identity, so it unmounted every card and mounted a
 * fresh one — the textarea included — on each keystroke, and focus was lost.
 *
 * A nested component is only harmless when it renders plain display markup. The
 * moment it wraps `children` or renders a form control, it remounts whatever
 * the user is typing into. This checks every page for that shape.
 *
 * Run: node tests/nested-components.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGES = ['tradehub.html', 'index.html', 'mylist.html', 'magi.html']
  .filter(f => fs.existsSync(path.join(ROOT, f)));

let failures = 0;
const check = (name, pass, detail) => {
  if (!pass) failures++;
  console.log('  ' + (pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
};

/* A capitalised arrow component declared with indentation, i.e. not at top
   level: `  const Name=({...})=>` or `  const Name=props=>`. */
const NESTED = /^[ \t]+const ([A-Z][A-Za-z0-9]*)\s*=\s*(?:\([^)]*\)|[a-z][A-Za-z0-9]*)\s*=>/gm;

for (const page of PAGES) {
  const src = fs.readFileSync(path.join(ROOT, page), 'utf8').replace(/\r\n/g, '\n');
  console.log('\n' + page);
  const bad = [];
  let m;
  while ((m = NESTED.exec(src))) {
    // The declaration's own text: up to the next line at its indent or shallower.
    const indent = m[0].match(/^[ \t]+/)[0].length;
    const rest = src.slice(m.index + m[0].length);
    const stop = rest.search(new RegExp('\\n[ \\t]{0,' + indent + '}\\S'));
    const decl = m[0] + (stop < 0 ? rest : rest.slice(0, stop));
    if (!/<[A-Za-z]/.test(decl)) continue;               // not a component
    if (/\bchildren\b|<(input|textarea|select)\b|contentEditable/.test(decl)) {
      bad.push(m[1] + ' (line ' + src.slice(0, m.index).split('\n').length + ')');
    }
  }
  check('no nested component wraps children or renders an input', bad.length === 0, bad.join(', '));
}

check('the Analysis card lives at top level',
      /^function TBAnalysisCard\(/m.test(fs.readFileSync(path.join(ROOT, 'tradehub.html'), 'utf8')));

console.log('');
if (failures) { console.error(failures + ' check(s) failed.'); process.exit(1); }
console.log('Nested components OK.');
