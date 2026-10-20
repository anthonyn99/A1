/**
 * Shruti keeps its own tests inside its folder (Shruti/tests/) so the program
 * moves as one folder. This shim runs every Shruti/tests/*.test.js as part of
 * `npm test`; it is one of the few lines outside Shruti/ that name it
 * (see Shruti/docs/README.md, "Moving Shruti").
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'Shruti', 'tests');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.test.js')).sort();
let failed = 0;
for (const f of files) {
  console.log(`  · Shruti/tests/${f}`);
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log(`  ✗ Shruti/tests/${f} (exit ${r.status})`); }
}
if (!files.length) { console.log('no Shruti tests found'); process.exit(1); }
process.exit(failed ? 1 : 0);
