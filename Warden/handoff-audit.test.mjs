// Warden handoff audit — the definition of done from docs/warden-handoff.md,
// enforced rather than eyeballed.
//
// Warden is a 1.2 MB duplicate of Vault produced largely by a scripted rename.
// The failure mode that matters is not a crash: it is one of Tony's real values
// surviving the copy, so Veda's app quietly reads his project, mails his inbox,
// or sits behind the same shared key as his extension. None of that shows up as
// a broken page — it shows up as her data in the wrong place.
//
//   node Warden/handoff-audit.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// This file is excluded from its own scan: it necessarily contains every
// literal it searches for, so including it would make every rule self-trip.
const SELF = fileURLToPath(import.meta.url);
const files = [path.join(ROOT, 'warden.html'), ...walk(HERE)]
  .filter(f => /\.(js|mjs|html|json|toml|md)$/i.test(f))
  .filter(f => path.resolve(f) !== path.resolve(SELF))
  .filter(f => fs.existsSync(f));

let fails = 0;
function rule(name, hits, allow = []) {
  const bad = hits.filter(h => !allow.some(a => h.includes(a)));
  if (bad.length) {
    fails++;
    console.log('  ✗ ' + name);
    bad.slice(0, 6).forEach(h => console.log('      ' + h));
    if (bad.length > 6) console.log('      …and ' + (bad.length - 6) + ' more');
  } else console.log('  ✓ ' + name);
}

function scan(re, opts = {}) {
  const out = [];
  for (const f of files) {
    if (opts.skipTests && /\.test\.(js|mjs)$/.test(f)) continue;
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (re.test(line)) {
        out.push(path.relative(ROOT, f).replace(/\\/g, '/') + ':' + (i + 1) + '  ' + line.trim().slice(0, 96));
      }
    });
  }
  return out;
}

console.log('\nWarden handoff audit');

// ── 1. None of Tony's real values survived the copy ─────────────────────────
rule("Tony's Firebase project absent",
     scan(/task-dashboard-d2b53|AIzaSyC2aKunOKj5WS8NpgZhpyMzOYecBr5t2_4|982539604706/));
rule("Tony's App Check site key absent", scan(/6LeUyAst/));
rule("Tony's Pages origin absent", scan(/anthonyn99/));
rule("Tony's email / Formspree form absent", scan(/anthonypn99|xeedkebo/));
rule("Tony's worker hostnames absent",
     scan(/(vault-pw-sync|vault-files|keychain-sync|trade-dashboard|personal-ai)\.av1\.workers\.dev/));

// The migration must name where her Links live TODAY, and one Worker test
// asserts Warden never reaches Tony's vault document. Both are deliberate.
rule("Tony's document paths absent",
     scan(/dashboards\/(vault_pw|vault_cloud|keychain|veda_links)/),
     ['SETUP.md', 'routing.test.mjs', 'currently live in dashboards/veda_links']);

// ── 2. The shared key must not be carried forward ───────────────────────────
// Both existing launchers ship the same hardcoded key. Warden gets its own.
rule('shared X-Vault-Key VALUE absent', scan(/vh-Ou55y3rGmjUn_ZGFTdSIFph2xN_OK/));
rule('X-Vault-Key header name absent', scan(/X-Vault-Key/));

// ── 3. Fixes that must not regress ──────────────────────────────────────────
// Each of these was a real hole that was closed; copying an older pattern
// reopens it.
rule('no google.com/s2/favicons (leaked every saved domain)',
     scan(/google\.com\/s2\/favicons/));
rule('no rq.code — the reset code is emailed, never returned', scan(/\brq\.code\b/));
rule('no hd.hint — the hint is emailed, never returned', scan(/\bhd\.hint\b/));

// ── 4. Nothing still NAMED Vault ────────────────────────────────────────────
// Lowercase "vault" as a common noun ("the encrypted vault") is correct English
// and stays. The PROGRAM name must not, except where the text deliberately
// explains what not to reuse from Tony's copy.
rule('no remaining Vault program name', scan(/Vault/, { skipTests: true }),
     ['warden-config.js', 'workers/warden-links/worker.js', 'SETUP.md', 'README.md',
      'the way Vault does', 'inherited from Vault']);

// ── 5. Decisions from the handoff ───────────────────────────────────────────
const ui = fs.readFileSync(path.join(HERE, 'warden-ui.js'), 'utf8');
rule('password floor is 12, not 8', /length < 8\b/.test(ui) ? ['warden-ui.js still has a < 8 check'] : []);

const cfg = fs.readFileSync(path.join(HERE, 'warden-config.js'), 'utf8');
rule('extension config exists and declares a key',
     /WORKER_KEY:\s*'(?!__)[^']{8,}'/.test(cfg) ? [] : ['warden-config.js has no concrete WORKER_KEY']);

// ── 6. Same-origin storage isolation ────────────────────────────────────────
// Warden inherited Vault's browser-storage keys along with everything else, and
// those are NOT namespaced by program: kc_connections, kc_colmap,
// kc_icon_cache_v1 and the kc_file_store IndexedDB database are the literal
// names index.html and vault.html use. Served from the same origin -- which is
// exactly what happens while Warden still lives in Tony's repo -- Warden read
// his cached Keychain and painted his links into her Links tab before Firebase
// was configured at all. It looked like a wrong document path; it was the cache.
//
// This is invisible once Warden sits alone on her own Pages origin, which is
// what makes it worth pinning: it would come back silently on any shared host.
const page = fs.readFileSync(path.join(ROOT, 'warden.html'), 'utf8');
const SHARED_KEYS = ['kc_connections', 'kc_colmap', 'kc_icon_cache_v1', 'kc_file_store'];
rule('browser-storage keys namespaced away from Vault/Index',
     SHARED_KEYS.flatMap(k => {
       const bare = new RegExp(`['"]${k}['"]`, 'g');
       const hits = page.match(bare) || [];
       return hits.length ? [`warden.html uses unprefixed '${k}' (${hits.length}x) — collides with vault.html/index.html on a shared origin`] : [];
     }));

// ── 6. Placeholders are obvious, and none silently holds a real value ───────
const ph = new Set();
for (const f of files) {
  (fs.readFileSync(f, 'utf8').match(/__[A-Z0-9_]+__/g) || []).forEach(m => ph.add(m));
}
// Prose in SETUP.md uses these two to explain the convention itself.
const real = [...ph].filter(p => !['__LIKE_THIS__', '__PLACEHOLDER__'].includes(p));
console.log('\n  ' + real.length + ' placeholder(s) still awaiting a human (expected before setup):');
real.sort().forEach(p => console.log('      ' + p));

console.log('\n' + '='.repeat(52));
console.log(fails ? fails + ' RULE(S) FAILED' : 'all rules passed');
process.exit(fails ? 1 : 0);
