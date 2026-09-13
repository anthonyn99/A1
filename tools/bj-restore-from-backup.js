/* ─────────────────────────────────────────────────────────────────────────────
 * bj-restore-from-backup — put Brainstorm Journal entries back from the
 * A1Backup vault when they are no longer in Firestore at all.
 *
 * WHEN THIS IS THE RIGHT TOOL
 *
 * tools/bj-recover.js handles the case where the entry is still IN Firestore
 * and only the sidebar lost track of it. This one handles the harder case:
 * the e_<id> field is gone from dashboards/journal, so there is nothing on the
 * server to re-list. The only surviving copy is in the encrypted local vault
 * that A1Backup has been writing all along.
 *
 * HOW IT CHOOSES A VERSION
 *
 * The vault holds hundreds of dated snapshots, and an entry usually appears in
 * many of them at different sizes — a page mid-edit, then finished, then
 * (sometimes) emptied. Picking the NEWEST snapshot would therefore be exactly
 * wrong: the newest copy of a page that was being blanked is the blank one.
 * So for each id this keeps the LARGEST version found across every snapshot,
 * which is the fullest the entry ever was. scan() shows you that choice, with
 * its date and a text preview, BEFORE anything is written.
 *
 * WHY IT UPLOADS ONE ENTRY AT A TIME
 *
 * dashboards/journal is a single document with a hard write ceiling (the app
 * refuses payloads over ~880 KB, and Firestore itself stops at 1 MiB). It was
 * measured at 689 KB when this was written. Restoring several large pages in
 * one write would push it past that and wedge ALL journal saving, so each
 * entry goes through the app's own _fbSaveJournalEntry, which:
 *   - extracts inline base64 images into their own documents first, so a
 *     188 KB page lands as a few KB of HTML plus separate image docs;
 *   - writes one e_<id> field by merge, never replacing the document.
 * The size is re-checked between entries and the run STOPS if the document is
 * approaching the ceiling, rather than being the thing that breaks saving.
 *
 * WHAT IT WILL NOT DO
 *
 * - It never touches an entry that is currently on the server. Only ids that
 *   are genuinely absent are candidates.
 * - It skips anything whose best surviving version was in the Trash, unless
 *   you pass { includeTrashed: true }. Those were deliberate deletions.
 * - It writes nothing at all under { dryRun: true }.
 *
 * USAGE — paste into the DevTools console with the journal open:
 *
 *   await bjVault.scan()                    // what is recoverable, and from when
 *   await bjVault.restore({ dryRun: true }) // the plan, in order, no writes
 *   await bjVault.restore()                 // do it
 * ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // Stay well under the app's own FB_MAX_WRITE_BYTES (900 KB) — this is the
  // point at which we stop adding entries rather than risk wedging the doc.
  var DOC_CEILING = 820 * 1024;

  async function fs() {
    var appMod = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js');
    var fsMod  = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js');
    var apps = appMod.getApps();
    if (!apps.length) throw new Error('Firebase is not initialised on this page');
    return { m: fsMod, db: fsMod.getFirestore(apps[0]) };
  }

  async function serverDoc() {
    var f = await fs();
    var snap = await f.m.getDocFromServer(f.m.doc(f.db, 'dashboards/journal'));
    return snap.exists() ? snap.data() : {};
  }

  function docBytes(d) { return JSON.stringify(d).length; }

  function textOf(e) {
    var d = (e && e.data) || {}, out = [];
    ['html', 'main', 'links', 'questions', 'topic', 'cues', 'notes', 'summary'].forEach(function (k) {
      if (typeof d[k] === 'string') out.push(d[k]);
    });
    if (d.dates) Object.keys(d.dates).forEach(function (k) {
      if (d.dates[k] && typeof d.dates[k].html === 'string') out.push(d.dates[k].html);
    });
    return out.join(' ');
  }

  function preview(e) {
    var t = textOf(e).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
                     .replace(/\s+/g, ' ').trim();
    return t.length > 100 ? t.slice(0, 100) + '…' : t;
  }

  /* Walk every snapshot and keep, per entry id, the LARGEST version seen —
   * see the header: newest is not the same as fullest, and for an entry that
   * was emptied the newest copy is the empty one. */
  async function survey() {
    if (!window.A1Backup) throw new Error('A1Backup is not loaded on this page');
    var st = await window.A1Backup.status();
    if (st.locked) throw new Error('The backup vault is locked — run A1Backup.unlock("passphrase") first');

    var live = await serverDoc();
    var onServer = new Set(Object.keys(live)
      .filter(function (k) { return k.indexOf('e_') === 0; })
      .map(function (k) { return k.slice(2); }));

    var snaps = await window.A1Backup.snapshots();
    var best = new Map();
    var scanned = 0;

    for (var i = 0; i < snaps.length; i++) {
      var at = snaps[i];
      try {
        var docs = (await window.A1Backup.restore(at)).docs;
        var d = docs['dashboards/journal'];
        scanned++;
        if (!d) continue;
        Object.keys(d).forEach(function (k) {
          if (k.indexOf('e_') !== 0) return;
          var e = d[k];
          if (!e || !e.id) return;
          if (onServer.has(e.id)) return;              // still live, not lost
          var size = JSON.stringify(e).length;
          var prev = best.get(e.id);
          if (!prev || size > prev.size) best.set(e.id, { entry: e, size: size, at: at });
        });
      } catch (err) { /* a snapshot that will not decrypt is skipped, not fatal */ }
      if (scanned % 100 === 0) console.log('  … scanned ' + scanned + '/' + snaps.length);
    }

    var list = [...best.values()].sort(function (a, b) { return b.size - a.size; });
    return { list: list, liveBytes: docBytes(live), snapshots: snaps.length };
  }

  async function scan() {
    var r = await survey();
    console.log('%cjournal document is ' + Math.round(r.liveBytes / 1024) +
                ' KB — writes are refused near 880 KB', 'font-weight:bold');
    console.log('%c' + r.list.length + ' entr' + (r.list.length === 1 ? 'y' : 'ies') +
                ' recoverable from ' + r.snapshots + ' snapshots', 'font-weight:bold;font-size:14px');
    console.table(r.list.map(function (x) {
      return {
        title: x.entry.title || '(untitled)',
        type: x.entry.template,
        bytes: x.size,
        trashed: x.entry.trashed ? 'yes — skipped by default' : '',
        from: new Date(x.at).toLocaleString(),
        preview: preview(x.entry)
      };
    }));
    window.__bjVaultScan = r;
    return r;
  }

  async function restore(opts) {
    opts = opts || {};
    var r = window.__bjVaultScan && !opts.rescan ? window.__bjVaultScan : await survey();

    var picked = r.list.filter(function (x) {
      if (x.entry.trashed && !opts.includeTrashed) return false;
      if (opts.only && opts.only.length) {
        return opts.only.some(function (want) {
          return (x.entry.title || '').toLowerCase().indexOf(String(want).toLowerCase()) >= 0;
        });
      }
      return true;
    });

    if (!picked.length) { console.log('[bj-vault] nothing to restore'); return null; }

    console.log('%cPlan — ' + picked.length + ' entr' + (picked.length === 1 ? 'y' : 'ies') +
                ', smallest first so the document grows gently:',
                'font-weight:bold');
    picked.sort(function (a, b) { return a.size - b.size; });
    console.table(picked.map(function (x) {
      return { title: x.entry.title || '(untitled)', bytes: x.size,
               from: new Date(x.at).toLocaleString() };
    }));

    if (opts.dryRun) { console.log('%cDRY RUN — nothing was written.', 'font-weight:bold'); return picked; }
    if (!window._fbSaveJournalEntry) return console.error('[bj-vault] _fbSaveJournalEntry missing — open the journal first');

    var done = [], skipped = [], failed = [];
    for (var i = 0; i < picked.length; i++) {
      var x = picked[i];
      var title = x.entry.title || '(untitled)';

      // Re-read the real size between writes. Inline images are extracted out
      // of each entry on the way up, so the document usually grows far less
      // than the raw byte count suggests — but never assume it.
      var liveNow = await serverDoc();
      var bytesNow = docBytes(liveNow);
      if (bytesNow > DOC_CEILING) {
        console.warn('[bj-vault] STOPPING at ' + Math.round(bytesNow / 1024) +
                     ' KB — too close to the write ceiling. Not restored: ' +
                     picked.slice(i).map(function (y) { return y.entry.title || '(untitled)'; }).join(', '));
        skipped = picked.slice(i).map(function (y) { return y.entry.title || '(untitled)'; });
        break;
      }

      try {
        var entry = Object.assign({}, x.entry);
        delete entry._dirty;
        delete entry._fbPushed;
        entry.updated = Date.now();

        await window._fbSaveJournalEntry(entry, []);
        // Give the write (and any image extraction it triggered) a moment to
        // land before measuring the document again for the next one.
        await new Promise(function (res) { setTimeout(res, 1200); });
        done.push(title);
        console.log('  ✓ ' + title + '  (' + Math.round(bytesNow / 1024) + ' KB doc before this one)');
      } catch (e) {
        failed.push(title);
        console.warn('  ✗ ' + title + ' — ' + (e && e.message || e));
      }
    }

    console.log('%cRestored ' + done.length + ' entr' + (done.length === 1 ? 'y' : 'ies') +
                '. Reload the page to see them.', 'color:#2e7d32;font-weight:bold;font-size:14px');
    if (skipped.length) console.warn('Skipped (document near its limit): ' + skipped.join(', '));
    if (failed.length)  console.warn('Failed: ' + failed.join(', '));
    return { done: done, skipped: skipped, failed: failed };
  }

  window.bjVault = { scan: scan, restore: restore, survey: survey };
  console.log('[bj-vault] ready — run:  await bjVault.scan()');
})();
