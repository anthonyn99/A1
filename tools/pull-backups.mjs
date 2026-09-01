#!/usr/bin/env node
/**
 * pull-backups — fold every device's encrypted snapshot into `Index Backups/`.
 *
 * WHY THIS EXISTS
 * A1Backup keeps an encrypted copy in each device's IndexedDB and mirrors it to
 * the index-backups Worker. Both of those are still transient: browser storage
 * gets evicted, and Workers KV is one free-tier account away from being gone.
 * This is the copy that outlives all of it — in git, pushed to GitHub, on every
 * clone.
 *
 * It is also the only way a PHONE's backup ever reaches durable storage. Safari
 * cannot write files, so the phone pushes to the Worker and a desktop folds it
 * in from here.
 *
 * WHAT LANDS IN THE REPO
 * Ciphertext only. Every file was encrypted in a browser against a passphrase
 * that neither the Worker nor this script ever sees, which is what makes it
 * safe for these bytes to sit in a PUBLIC repository. This script cannot read
 * them either — it moves opaque blobs and writes a plaintext index of sizes and
 * timestamps so backup health is visible without decrypting anything.
 *
 * WHY OBJECTS, NOT SNAPSHOTS
 * Files are named by a hash of their own plaintext, so a document that has not
 * changed keeps the same filename and git stores it exactly once however many
 * times it is captured. Ciphertext does not delta-compress, so committing a
 * fresh full snapshot daily would cost ~379 MB a year for a single copy
 * (measured 2026-09-01: a core is 1064 KB gzipped). Content addressing makes
 * the cost track real change instead.
 *
 * USAGE
 *   node tools/pull-backups.mjs            # fetch, write, report
 *   node tools/pull-backups.mjs --commit   # ...and commit if anything changed
 *
 * AUTH
 * The Worker is gated by App Check, which only a browser can mint. Rather than
 * requiring someone to paste a token every time — a backup step that needs a
 * human is a backup step that stops happening — the Worker also accepts a
 * READ-ONLY bearer secret, kept in .a1b-pull-secret (gitignored). It can fetch
 * ciphertext and nothing else: writes and deletes still require App Check.
 *
 * Set up once:
 *   wrangler secret put PULL_SECRET --config workers/index-backups/wrangler.toml
 * then run unattended:
 *   node tools/pull-backups.mjs --commit
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'Index Backups');
const WORKER = process.env.A1B_WORKER || 'https://index-backups.av1.workers.dev';
// Read-only pull secret: env var first, then the gitignored file, so a
// scheduled task needs no arguments and no human.
function readSecret() {
  if (process.env.A1B_PULL_SECRET) return process.env.A1B_PULL_SECRET.trim();
  const f = path.join(ROOT, '.a1b-pull-secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { return ''; }
}
const SECRET = readSecret();
const TOKEN = process.env.A1B_TOKEN || '';
const DO_COMMIT = process.argv.includes('--commit');

const headers = SECRET ? { Authorization: 'Bearer ' + SECRET }
              : TOKEN ? { 'X-Firebase-AppCheck': TOKEN }
              : {};
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

async function getText(p) {
  const r = await fetch(WORKER + p, { headers });
  if (!r.ok) throw new Error('GET ' + p + ' -> ' + r.status);
  return r.text();
}

async function get(p) {
  const r = await fetch(WORKER + p, { headers });
  if (!r.ok) {
    const hint = r.status === 401
      ? (SECRET
          ? ' — the pull secret was rejected. Re-run: wrangler secret put PULL_SECRET' +
            ' --config workers/index-backups/wrangler.toml (and make sure it has no trailing newline).'
          : ' — no credential. Create .a1b-pull-secret and upload it with' +
            ' `wrangler secret put PULL_SECRET`, or pass A1B_TOKEN from `await window._acToken()`.')
      : '';
    throw new Error('GET ' + p + ' -> ' + r.status + hint);
  }
  return r.json();
}

function writeIfChanged(file, body) {
  // Never rewrite an identical file: the auto-commit watcher fires on mtime, so
  // a no-op rewrite would produce a commit and a Pages rebuild for nothing.
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return true;
}

async function main() {
  console.log('Pulling from ' + WORKER);
  if (!SECRET && !TOKEN) {
    console.warn('  (no credential — see the AUTH note at the top of this file)');
  }

  const index = await get('/index');
  const devices = Object.keys(index.devices || {});
  if (!devices.length) {
    console.log('  No device has pushed a snapshot yet. Nothing to pull.');
    return;
  }

  let wroteObjects = 0, reusedObjects = 0, wroteManifests = 0;
  const summary = [];

  for (const device of devices) {
    const meta = index.devices[device];
    // The manifest is itself encrypted. This script cannot read it, so it
    // cannot know which objects a device needs — it stores the manifest and
    // lets a browser resolve it at restore time.
    const man = await get('/s/' + device);
    const at = man.at || meta.at;
    const stamp = new Date(at).toISOString().slice(0, 10);

    const manFile = path.join(OUT, device, 'snapshots', stamp + '.enc.json');
    if (writeIfChanged(manFile, JSON.stringify(man, null, 2))) wroteManifests++;

    // The documents themselves. The manifest is encrypted, so this script
    // cannot work out what a snapshot needs — the ids ride outside it for
    // exactly that reason. Without this loop the repo held a manifest and no
    // data: an index pointing at nothing, which would have looked like a
    // backup right up until someone needed it.
    //
    // Ids are keyed hashes of the content, so an object that has not changed
    // keeps its filename and is fetched once, ever. Steady state is a handful
    // of small files even though the snapshot itself is rewritten constantly.
    const ids = Array.isArray(man.objects) ? man.objects : [];
    if (!ids.length) {
      console.warn('    WARNING: this snapshot lists no objects — it cannot be' +
        ' restored. The device needs a newer version of backup.js.');
    }
    for (const id of ids) {
      const objFile = path.join(OUT, device, 'objects', id + '.enc.json');
      if (fs.existsSync(objFile)) { reusedObjects++; continue; }
      try {
        const body = await getText('/o/' + id);
        if (writeIfChanged(objFile, body)) wroteObjects++;
      } catch (e) {
        console.warn('    could not fetch object ' + id + ': ' + (e && e.message));
      }
    }

    summary.push({
      device,
      at,
      iso: new Date(at).toISOString(),
      ageHours: +((Date.now() - at) / 3600000).toFixed(1),
      docs: man.docs ?? meta.docs ?? null,
      objects: (man.objects || []).length,
      bytes: meta.bytes ?? null,
      stale: Date.now() - at > 48 * 3600000,
    });

    console.log('  ' + device + ': snapshot ' + stamp +
      ' (' + (man.docs ?? '?') + ' docs, ' + (man.objects || []).length + ' objects)' +
      (Date.now() - at > 48 * 3600000 ? '   <-- STALE' : ''));
  }

  // Plaintext, deliberately: it is how backup health is visible at a glance
  // without a passphrase. Counts, sizes and times only — no document names.
  const readme = {
    what: 'Encrypted backups of the Index app. Ciphertext only; unreadable without the passphrase.',
    generatedAt: new Date().toISOString(),
    worker: WORKER,
    devices: summary,
  };
  if (writeIfChanged(path.join(OUT, 'index.json'), JSON.stringify(readme, null, 2))) {
    console.log('  wrote index.json');
  }

  console.log('\n  manifests written: ' + wroteManifests +
    ', objects written: ' + wroteObjects + ', unchanged: ' + reusedObjects);

  const stale = summary.filter((s) => s.stale);
  if (stale.length) {
    console.warn('\n  WARNING: ' + stale.length + ' device(s) have not backed up in over 48h:');
    stale.forEach((s) => console.warn('    ' + s.device + '  ' + s.ageHours + 'h ago'));
  }

  if (DO_COMMIT) {
    const changed = execFileSync('git', ['status', '--porcelain', 'Index Backups'],
      { cwd: ROOT, encoding: 'utf8' }).trim();
    if (!changed) { console.log('\n  Nothing changed; no commit.'); return; }
    execFileSync('git', ['add', 'Index Backups'], { cwd: ROOT });
    execFileSync('git', ['commit', '-m', 'backups: pull ' + new Date().toISOString().slice(0, 10)],
      { cwd: ROOT });
    console.log('\n  Committed.');
  }
}

main().catch((e) => {
  console.error('\npull-backups failed: ' + (e && (e.message || e)));
  process.exit(1);
});
