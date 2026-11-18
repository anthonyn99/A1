// Guards Beacon's wiring (docs/Beacon/README.md): every program with profiles
// or notifications loads the ONE live Beacon/beacon.js, unpinned, declares
// itself with its app id, and has a button that opens the panel.
//
// Ways this rots without anything erroring:
//  1. A host pins a version (beacon.js?v=…) or keeps a copy: an upgrade no
//     longer reaches it.
//  2. A host loads Beacon but forgets mount(): its devices silently never
//     appear, and nobody notices because the panel still opens elsewhere.
//  3. The button goes in a refactor: the devices are recorded but nobody can
//     manage them from that program.
//  4. Someone builds a device list inside a program again.
//
// Run: node tests/beacon-wiring.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('./moved');

const ROOT = M.ROOT;
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// page → { app, files: extra scripts holding its button }
const HOSTS = {
  'index.html': { app: 'taskhub' },
  'mylist.html': { app: 'mylist' },
  'magi.html': { app: 'magi' },
  'shield.html': { app: 'shield' },
  'shruti.html': { app: 'shruti', files: ['Shruti/app/app.js'] },
  'V1/studyos.html': { app: 'studyos', noButton: true }, // no profiles: managed from TaskHub (2026-11-17)
};

console.log('\nThe folder');
ok('Beacon/ holds beacon.js and beacon-ui.js only', fs.readdirSync(path.join(ROOT, 'Beacon')).sort().join() === 'beacon-ui.js,beacon.js');
ok('its README lives in docs/Beacon/', fs.existsSync(path.join(ROOT, 'docs', 'Beacon', 'README.md')));
ok('Rules/layout.json lists the folder', /"Beacon"\s*:/.test(read('Rules/layout.json')));

console.log('\nThe hosts');
for (const page of Object.keys(HOSTS)) {
  const h = HOSTS[page];
  const src = read(page);
  const all = [src].concat((h.files || []).map(read)).join('\n');
  const tags = src.match(/<script[^>]+src="[^"]*beacon\.js[^"]*"[^>]*>/g) || [];
  ok(page + ': loads beacon.js exactly once', tags.length === 1, tags.join(' '));
  const t = tags[0] || '';
  ok(page + ': unpinned, from the one live path', /src="(?:Beacon\/beacon\.js|https:\/\/anthonyn99\.github\.io\/A1\/Beacon\/beacon\.js)"/.test(t), t);
  ok(page + ': not deferred or async (mount runs right after it)', !/\b(defer|async)\b/.test(t), t);
  const gi = src.indexOf('guardian.js'), bi = src.indexOf(t);
  ok(page + ': after Guardian, so the locks it reports exist', gi >= 0 && bi > gi);
  ok(page + ": mounts as '" + h.app + "'", new RegExp("Beacon\\.mount\\(\\s*'" + h.app + "'").test(src));
  if (h.noButton) ok(page + ': has no devices button (managed from TaskHub)', !/Beacon\.open\(/.test(all));
  else ok(page + ': has a button that opens the panel for it', new RegExp("Beacon\\.open\\(\\s*\\{\\s*app:\\s*'" + h.app + "'").test(all));
}
// TaskHub: the panel lives in Settings, on both sides.
const idx = read('index.html');
ok('TaskHub: a Devices section in Settings', /thset-sec-title">Devices</.test(idx) && /renderDevicesRow\(document\.getElementById\('thset-devices'\),profile\)/.test(idx));
ok('TaskHub: Settings opens it for the profile whose Settings it is', /Beacon\.open\(\{app:'taskhub',profile:profile\}\)/.test(idx));
ok('TaskHub: hands Beacon the notification app’s Firestore and push state', /window\._thBeaconFirebase\s*=/.test(idx) && /window\._thBeaconPush\s*=/.test(idx));
ok('TaskHub: a new push token or main re-checks in', (idx.match(/Beacon\.refresh\('taskhub'\)/g) || []).length >= 3);
ok('StudyOS: reports its own push token', /window\._sosPushToken = token/.test(read('V1/StudyOS/js/push.js')));

// ORCA (Veda's repo, ../ORCA): both UIs load Beacon unpinned on signed-in
// pages, beacon-host.js declares it with its own lock, and the header has the button.
const ORCA = path.join(ROOT, '..', 'ORCA');
if (fs.existsSync(ORCA)) {
  console.log('\nORCA');
  const o = (rel) => fs.readFileSync(path.join(ORCA, rel), 'utf8');
  const ts = o('worker/src/web/html.ts'), py = o('app/web/templates/base.html'), host = o('app/web/static/beacon-host.js');
  ok('Worker layout loads the one live beacon.js and beacon-host.js', /BEACON_SRC = "https:\/\/anthonyn99\.github\.io\/A1\/Beacon\/beacon\.js"/.test(ts) && /<script src="\$\{BEACON_SRC\}"><\/script>/.test(ts) && /beacon-host\.js" defer/.test(ts));
  ok('Python layout too, signed-in pages only', /\{% if profile %\}<script src="https:\/\/anthonyn99\.github\.io\/A1\/Beacon\/beacon\.js"><\/script>/.test(py) && /beacon-host\.js" defer/.test(py));
  ok('both headers have the devices button', /data-beacon-open/.test(ts) && /data-beacon-open/.test(py));
  ok("beacon-host mounts 'orca' with its server lock (lockState + lockNow)", /Beacon\.mount\("orca"/.test(host) && /lockState:/.test(host) && /\/lock\/status/.test(host) && /lockNow:/.test(host) && /\/lock\/lock/.test(host));
  ok('and opens the panel from the button', /Beacon\.open\(\{ app: "orca"/.test(host));
}

console.log('\nNothing else builds it');
const scan = (dir, out) => {
  for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    if (/^(node_modules|\.git|Backup|tests)$/.test(f)) continue;
    const rel = dir ? dir + '/' + f : f, st = fs.statSync(path.join(ROOT, rel));
    if (st.isDirectory()) { if (!/^(V1\/StudyOS\/vendor|Shruti\/media|magi)$/.test(rel)) scan(rel, out); }
    else if (/\.(html|js)$/.test(f) && st.size < 3e6) out.push(rel);
  }
  return out;
};
const owners = scan('', []).filter((f) => /window\.Beacon\s*=|window\.BeaconUI\s*=/.test(read(f)));
ok('only Beacon/ defines window.Beacon / window.BeaconUI', owners.sort().join() === 'Beacon/beacon-ui.js,Beacon/beacon.js', owners.join());
const copies = scan('', []).filter((f) => f !== 'Beacon/beacon.js' && /beacon_neutral/.test(read(f)));
ok('no program reads the device documents itself', copies.length === 0, copies.join());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
