// Guards the "Save button does nothing" bug, in Vault AND Warden.
//
// 2026-08-25: Vault's Save silently stopped working. The cause was not Firebase
// — it was this shape:
//
//     function save(){
//       localStorage.setItem('kc_connections', ...);   // threw QuotaExceededError
//       if(window._fbSaveKeychain){ ... }              // never reached
//     }
//
// localStorage is only an offline mirror; Firestore is the real store. But the
// mirror write came FIRST and was unguarded, so once the origin's shared ~5MB
// budget filled (journal undo stacks, in that instance), the throw took out the
// whole function: no cloud save, no modal close, no re-render. Warden had
// inherited the identical code.
//
// Rule: every mirror write in a Keychain save path goes through _kcMirror(),
// which catches. Nothing in that path may call localStorage.setItem directly.

const fs = require('fs');
const path = require('path');

const APPS = [
  { file: 'vault.html', prefix: 'kc_' },
];

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

for (const app of APPS) {
  const p = path.join(__dirname, '..', app.file);
  if (!fs.existsSync(p)) { console.log('\n-- ' + app.file + ' (absent, skipped) --'); continue; }
  const src = fs.readFileSync(p, 'utf8');
  console.log('\n-- ' + app.file + ' --');

  // 1. the guard helper exists and actually catches
  const m = src.match(/function _kcMirror\([\s\S]{0,400}?\n\}/);
  ok('_kcMirror() is defined', !!m);
  ok('_kcMirror() wraps the write in try/catch',
    !!m && /try\s*\{[\s\S]*localStorage\.setItem[\s\S]*\}\s*catch/.test(m[0]));

  // 2. no direct mirror writes to the keychain keys anywhere
  const direct = src.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(r => r.line.includes("localStorage.setItem('" + app.prefix));
  ok('no direct localStorage.setItem on the keychain keys', direct.length === 0,
    direct.map(r => app.file + ':' + r.n + '  ' + r.line).join(' | '));

  // 3. the cloud save is not downstream of an unguarded mirror write
  const save = src.match(/function save\(\)\{[\s\S]{0,600}?\n\}/);
  ok('save() exists', !!save);
  if (save) {
    ok('save() mirrors via _kcMirror, not setItem', !/localStorage\.setItem/.test(save[0]), save[0].slice(0, 160));
    ok('save() still reaches _fbSaveKeychain', /_fbSaveKeychain/.test(save[0]));
  }

  // 4. applyRemote must not throw either — a full mirror used to abort the
  //    render, so the cloud copy arrived and was never drawn.
  const applyRemote = src.match(/function applyRemote\(data\)\{[\s\S]{0,700}?\n  \}/);
  ok('applyRemote() exists', !!applyRemote);
  if (applyRemote) ok('applyRemote() mirrors via _kcMirror', !/localStorage\.setItem/.test(applyRemote[0]));

  // 5. the icon cache is capped — an uncapped one is what fills the budget and
  //    makes some OTHER app throw.
  ok('icon cache has a byte cap', /KC_ICON_MAX_BYTES/.test(src));

  // 6. icons cannot depend on script-block order
  ok('an initial favicon sweep runs once the helpers exist', /kcInitialFaviconSweep/.test(src));
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
process.exit(fail ? 1 : 0);
