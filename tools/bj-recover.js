/* ─────────────────────────────────────────────────────────────────────────────
 * bj-recover — find and restore Brainstorm Journal entries that vanished from
 * the sidebar after opening the journal on another device.
 *
 * WHY THIS EXISTS (the failure it repairs)
 *
 * A journal entry lives in Firestore as its own field, `e_<id>`, inside the one
 * document dashboards/journal. The sidebar, though, is built from the merge in
 * _bjApplyRemote — and that merge can drop an entry from the LIST while the
 * `e_<id>` field is still sitting in Firestore, untouched. Two ways:
 *
 *   1. A LOCAL TOMBSTONE. state.deletedIds is this device's list of "gone for
 *      good" ids. _bjApplyRemote consults it FIRST (`if (_deletedSet.has(id))
 *      return;`) and skips that entry on every future sync, forever, no matter
 *      what the server still holds. _bjForgetDeleted() writes these — including
 *      from the prune branch, where an entry missing from the server key list
 *      at one awkward moment is recorded as a permanent delete on this device.
 *
 *   2. A PRUNE. In authoritative mode the server e_* key list is the truth, and
 *      an entry absent from it is removed locally. A device that wrote while
 *      holding a stale view could republish a key list that did not mention
 *      entries created elsewhere.
 *
 * In BOTH cases the entry bytes are still in Firestore. What was lost is the
 * pointer to them, on this device. That is why this is a recovery, not an
 * undelete: nothing has to be reconstructed, only re-listed.
 *
 * WHAT THIS DOES NOT TOUCH
 *
 * Entries in the Trash (entry.trashed set) are NOT orphans — they are a
 * deliberate delete with a 30-day timer, and the Trash UI already restores
 * them. This tool ignores them so it can never undo a real deletion.
 *
 * SAFETY
 *
 * scan() is strictly read-only. restore() only ever ADDS entries back to the
 * list and removes their tombstones; it never deletes an entry, never
 * overwrites the content of one you still have, and writes nothing to Firestore
 * except through the app own save path.
 *
 * USAGE — paste this file into the DevTools console on the page where the
 * journal is open, then:
 *
 *   await bjRecover.scan()                      // read-only report
 *   await bjRecover.restore({ dryRun: true })   // show the plan, change nothing
 *   await bjRecover.restore()                   // put the orphans back
 * ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  function fail(msg) { console.error('[bj-recover] ' + msg); return null; }

  // The journal module is an IIFE — its `state` is not on window. The cache it
  // writes on every save is, and it is the same object the merge reads back.
  function liveState() {
    try {
      var raw = localStorage.getItem('brainstorm_journal_v3');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  // Read dashboards/journal straight from the SERVER, not the cache. The cache
  // is this device memory of the document and is exactly what a recovery must
  // not trust.
  async function serverDoc() {
    var appMod = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js');
    var fsMod  = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js');
    var apps = appMod.getApps();
    if (!apps.length) throw new Error('Firebase is not initialised on this page');
    var db = fsMod.getFirestore(apps[0]);
    var snap = await fsMod.getDocFromServer(fsMod.doc(db, 'dashboards/journal'));
    if (!snap.exists()) throw new Error('dashboards/journal does not exist');
    return snap.data();
  }

  function textOf(entry) {
    var d = (entry && entry.data) || {}, out = [];
    ['html', 'main', 'links', 'questions', 'topic', 'cues', 'notes', 'summary'].forEach(function (k) {
      if (typeof d[k] === 'string') out.push(d[k]);
    });
    return out.join(' ');
  }

  // A rough "is there anything in here" read, used only for the report so you
  // can tell a real page from an empty stub before restoring it.
  function preview(entry) {
    var t = textOf(entry).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
                         .replace(/\s+/g, ' ').trim();
    return t.length > 90 ? t.slice(0, 90) + '…' : t;
  }

  async function scan() {
    var st = liveState();
    if (!st) return fail('Open the Brainstorm Journal first, then run this again.');

    var data = await serverDoc();
    var localIds   = new Set((st.entries || []).map(function (e) { return e.id; }));
    var tombstoned = new Set(st.deletedIds || []);

    var orphans = [], trashed = [], present = 0;
    Object.keys(data).forEach(function (k) {
      if (k.indexOf('e_') !== 0) return;
      var e = data[k];
      if (!e || typeof e !== 'object' || !e.id) return;
      if (localIds.has(e.id)) { present++; return; }
      // A trashed entry is a deliberate delete with its own UI. Never touch it.
      if (e.trashed) { trashed.push(e); return; }
      orphans.push(e);
    });

    orphans.sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });

    console.log('%c[bj-recover] server has ' + (present + orphans.length + trashed.length) +
                ' entries — ' + present + ' in your sidebar, ' + orphans.length +
                ' missing, ' + trashed.length + ' in Trash.',
                'font-weight:bold');

    if (orphans.length) {
      console.table(orphans.map(function (e) {
        return {
          id: e.id,
          title: e.title || '(untitled)',
          template: e.template,
          updated: e.updated ? new Date(e.updated).toLocaleString() : '',
          bytes: JSON.stringify(e).length,
          blocked: tombstoned.has(e.id) ? 'tombstoned on this device' : '',
          preview: preview(e)
        };
      }));
    } else {
      console.log('[bj-recover] Nothing is missing from the server copy.');
    }

    return { orphans: orphans, trashedCount: trashed.length, present: present,
             tombstoned: orphans.filter(function (e) { return tombstoned.has(e.id); }).length };
  }

  async function restore(opts) {
    opts = opts || {};
    var r = await scan();
    if (!r) return null;
    if (!r.orphans.length) { console.log('[bj-recover] Nothing to restore.'); return r; }

    if (opts.dryRun) {
      console.log('[bj-recover] DRY RUN — would restore ' + r.orphans.length +
                  ' entr' + (r.orphans.length === 1 ? 'y' : 'ies') + '. Nothing was changed.');
      return r;
    }

    var raw = localStorage.getItem('brainstorm_journal_v3');
    var st  = JSON.parse(raw);

    // Keep a copy of the pre-restore cache. If anything about this looks wrong
    // afterwards, this is the way back.
    var backupKey = 'bj_recover_backup_' + Date.now();
    try { localStorage.setItem(backupKey, raw); } catch (e) {}

    // 1. Lift the local tombstones. While an id sits in deletedIds, the merge
    //    skips it on every sync and the entry cannot come back no matter what
    //    the server holds.
    var ids = new Set(r.orphans.map(function (e) { return e.id; }));
    st.deletedIds = (st.deletedIds || []).filter(function (id) { return !ids.has(id); });

    // 2. Put the entries back in the list, marked as already-on-the-server so
    //    the next merge treats them as synced rather than as local-only work.
    r.orphans.forEach(function (e) {
      var copy = Object.assign({}, e);
      delete copy._dirty;
      copy._fbPushed = true;
      st.entries.unshift(copy);
    });

    localStorage.setItem('brainstorm_journal_v3', JSON.stringify(st));

    console.log('%c[bj-recover] Restored ' + r.orphans.length + ' entr' +
                (r.orphans.length === 1 ? 'y' : 'ies') + '. Reload the page to see them.',
                'color:#2e7d32;font-weight:bold');
    console.log('[bj-recover] Pre-restore cache saved at localStorage["' + backupKey + '"]');
    return { restored: r.orphans.length, backupKey: backupKey };
  }

  window.bjRecover = { scan: scan, restore: restore };
  console.log('[bj-recover] ready — run:  await bjRecover.scan()');
})();
