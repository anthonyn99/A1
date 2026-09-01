/* ============================================================================
 * A1Backup — encrypted, offline-first backup for the A1 suite
 * ============================================================================
 *
 * WHY THIS EXISTS
 * 2026-08-25: a full set of goals vanished from BOTH TaskHub profiles at once.
 * Cloud and local agreed exactly, the day archives only ever held task data,
 * and the Firestore free tier has no point-in-time recovery — so there was
 * nothing to restore from. The last surviving copy was on a phone, and opening
 * it synced the empty state down and destroyed that too.
 *
 * Firestore PITR was declined (staying on the free Spark plan), so this file is
 * the ONLY safety net. It has to work the first time, under real failure
 * conditions, unattended. Everything below is built around that.
 *
 * WHAT IT IS NOT
 * Not a sync engine. Firestore keeps that job — its persistent IndexedDB cache
 * already queues offline writes FIFO and flushes them on reconnect, and
 * tests/sync-guard.test.js protects that path. A second writer into the same
 * documents is the exact shape of the last two data-loss bugs, so backups are
 * a RESTORE SOURCE ONLY and never write to Firestore on their own.
 *
 * HOW AN APP OPTS IN
 * This file is inert until registered, so it can never disturb an app's own
 * sync. One line, after the app has its Firestore handle:
 *
 *   window.A1Backup && window.A1Backup.register({
 *     db, projectId: 'task-dashboard-d2b53', appId: 'index',
 *     fs: { doc, getDoc, collection, getDocs, query, orderBy, limit,
 *           startAt, endBefore, startAfter, documentId }
 *   });
 *
 * The Firestore functions are passed in rather than imported because this is a
 * classic script — that keeps it loadable from any page, module or not, and is
 * what will let other apps (and Veda's V1 suite) opt in later with one line.
 *
 * SCOPE TODAY: Index (index.html) only, both profiles.
 *
 * PHASE 0 — this file currently implements MEASUREMENT ONLY (A1Backup.measure).
 * Nothing is captured, encrypted, stored or uploaded yet. The numbers it
 * reports settle two questions before any of that is built:
 *   - how many documents exist, which sets the read budget;
 *   - how many bytes the journal images total, which decides whether the image
 *     blobs can live in git at all.
 * ========================================================================== */
(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────
  // Every ceiling this system obeys is a named constant, asserted by
  // tests/backup-guard.test.js, so a limit can never drift silently.
  var A1B = {
    SCHEMA: 1,
    DB: 'a1-backups',                  // IndexedDB, one per origin
    PASS_KEY: 'a1b_pass',              // localStorage
    SALT_KEY: 'a1b_salt',
    DISABLED_KEY: 'a1b_disabled',      // kill switch
    CAPTURE_DEBOUNCE_MS: 5000,
    PUSH_DEBOUNCE_MS: 600000,          // 10 min to the worker
    MAX_PUSH_PER_DAY: 60,
    DAILY_PASS_MS: 86400000,
    SCAN_INTERVAL_MS: 604800000,       // weekly discovery scan
    SCAN_PAGE: 200,
    SCAN_MAX: 400,
    BACKFILL_PER_SESSION: 100,
    PBKDF2_ITER: 600000,
    SHRINK_RATIO: 0.5,                 // mirrors THB_KEEP_RATIO (index.html)
    MIN_STORAGE_MB: 200,
    KEEP_CORES: 14,
    ARCHIVE_YEARS_BACK: 8,
    IMG_SAMPLE: 10                     // images sampled to estimate the total
  };

  // ── Registration ─────────────────────────────────────────────────────────
  var apps = {};   // appId -> { db, projectId, fs }

  function register(opts) {
    if (!opts || !opts.db || !opts.fs || !opts.appId) {
      console.warn('[A1Backup] register() ignored — needs { db, fs, appId }.');
      return false;
    }
    apps[opts.appId] = {
      db: opts.db,
      projectId: opts.projectId || '(unknown)',
      fs: opts.fs
    };
    return true;
  }

  function pick(appId) {
    var ids = Object.keys(apps);
    if (!ids.length) throw new Error('A1Backup: no app has registered yet');
    return apps[appId || ids[0]];
  }

  // ── Small helpers ────────────────────────────────────────────────────────
  function bytesOf(obj) {
    try { return new Blob([JSON.stringify(obj === undefined ? null : obj)]).size; }
    catch (e) { try { return JSON.stringify(obj).length; } catch (_) { return 0; } }
  }
  function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }
  function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }

  // Actual gzipped size of a value, via CompressionStream. Returns null where
  // the API is unavailable (older Safari), so callers can say "unknown" rather
  // than silently substituting a guess.
  async function gzipBytes(obj) {
    try {
      if (typeof CompressionStream === 'undefined') return null;
      var blob = new Blob([JSON.stringify(obj)]);
      var cs = new CompressionStream('gzip');
      var out = await new Response(blob.stream().pipeThrough(cs)).blob();
      return out.size;
    } catch (e) { return null; }
  }

  // The document families Index owns. Groups 1 and 2 are fixed paths; groups
  // 3-5 are derived, because their members are unbounded and un-indexed.
  var SINGLETONS = [
    // Group 1 — a live listener already delivers these at runtime, so in
    // production they cost zero extra reads. Measured here only to size the
    // snapshot.
    'main', 'vedasdash', 'journal', 'tony_journal', 'plans', 'navorder',
    'applock', 'tesla_cfg', 'pv_cards', 'studyos_mirror', 'myjournal_docs',
    // Group 2 — no listener; these are what the daily pass actually reads.
    'main_snapshots', 'vedasdash_snapshots', 'market_calendar',
    'studyos_mirror_ack', 'journal_aiprompt', 'journal_aitools',
    'myjournal_aiprompt', 'myjournal_aitools', 'myjournal'
  ];
  var GROUP1_COUNT = 11;   // how many of the above are listener-backed

  // Journal doc -> the placeholder scheme its entry HTML uses for images, and
  // the prefixes of the per-image and per-canvas documents. Whiteboard canvases
  // are stripped out of the entry payload before it is saved, so a backup of
  // the journal document alone would lose every whiteboard.
  var JOURNALS = [
    { doc: 'journal',      scheme: 'bj-fbimg://', imgPrefix: 'journal_img_',      canvasPrefix: 'journal_canvas_' },
    { doc: 'tony_journal', scheme: 'tj-fbimg://', imgPrefix: 'tony_journal_img_', canvasPrefix: 'tony_journal_canvas_' },
    { doc: 'myjournal',    scheme: 'mj-fbimg://', imgPrefix: 'myjournal_img_',    canvasPrefix: 'myjournal_canvas_' }
  ];

  // Entry ids and image keys both come out of the journal document itself:
  // every entry is a field named e_<entryId>, and every image is referenced by
  // an <img src="<scheme><key>"> placeholder inside that entry's HTML. This is
  // the same parse the app's own rehydrators do, and it is precisely why no
  // collection sweep is needed to find the image documents.
  function entryIds(journalData) {
    if (!journalData) return [];
    return Object.keys(journalData)
      .filter(function (k) { return k.indexOf('e_') === 0; })
      .map(function (k) { return k.slice(2); });
  }
  function imageKeys(journalData, scheme) {
    var out = {};
    if (!journalData) return out;
    var lit = scheme.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    Object.keys(journalData).forEach(function (k) {
      if (k.indexOf('e_') !== 0) return;
      var html = '';
      try { html = (journalData[k] && journalData[k].data && journalData[k].data.html) || ''; }
      catch (e) { return; }
      if (!html || html.indexOf(scheme) < 0) return;
      var re = new RegExp(lit + '([A-Za-z0-9._-]+)', 'g');
      var m;
      while ((m = re.exec(html)) !== null) out[m[1]] = true;
    });
    return out;
  }

  // ── Phase 0: measure ─────────────────────────────────────────────────────
  // Read-only and bounded. Reads every singleton once, probes the archive year
  // range, probes one canvas per journal entry, and SAMPLES a handful of images
  // to estimate the image total — downloading every image document to weigh it
  // is exactly the burst this whole design exists to avoid.
  async function measure(appId) {
    var a = pick(appId);
    var fs = a.fs, db = a.db;
    var t0 = Date.now();
    var reads = 0;
    var report = { project: a.projectId, groups: {}, totals: {} };

    async function readDoc(path) {
      reads++;
      try {
        var s = await fs.getDoc(fs.doc(db, 'dashboards/' + path));
        return s.exists() ? (s.data() || {}) : null;
      } catch (e) {
        console.warn('[A1Backup] read failed: ' + path, e && (e.code || e.message));
        return undefined;                 // undefined = error, null = absent
      }
    }

    // Groups 1 + 2 — fixed singletons.
    var singles = [], singleBytes = 0, missing = [], failed = [];
    var journalCache = {}, core = {};
    for (var i = 0; i < SINGLETONS.length; i++) {
      var name = SINGLETONS[i];
      var d = await readDoc(name);
      if (d === undefined) { failed.push(name); continue; }
      if (d === null) { missing.push(name); continue; }
      journalCache[name] = d;             // reused below, so journals cost one read
      core[name] = d;
      var b = bytesOf(d);
      singleBytes += b;
      singles.push({ path: name, bytes: b });
    }
    singles.sort(function (x, y) { return y.bytes - x.bytes; });
    report.groups.singletons = {
      found: singles.length, missing: missing, failed: failed,
      bytes: singleBytes, largest: singles.slice(0, 6)
    };

    // Group 3 — archives, by year probe over the same range the un-archive uses.
    var year = new Date().getFullYear(), archives = [], archiveBytes = 0;
    for (var p = 0; p < 2; p++) {
      var base = p === 0 ? 'main_archive_' : 'vedasdash_archive_';
      for (var y = year - A1B.ARCHIVE_YEARS_BACK; y <= year; y++) {
        var ad = await readDoc(base + y);
        if (!ad) continue;
        core[base + y] = ad;
        var ab = bytesOf(ad);
        archiveBytes += ab;
        archives.push({ path: base + y, bytes: ab,
                        days: ad.data ? Object.keys(ad.data).length : 0 });
      }
    }
    report.groups.archives = { found: archives.length, bytes: archiveBytes, docs: archives };

    // Groups 4 + 5 — derived from the journal documents already read above.
    var canvases = [], canvasBytes = 0;
    var allImageIds = {}, imgByJournal = {}, oddKeys = [];
    for (var j = 0; j < JOURNALS.length; j++) {
      var spec = JOURNALS[j];
      var jd = journalCache[spec.doc];
      if (!jd) { imgByJournal[spec.doc] = 0; continue; }
      var ids = entryIds(jd);
      var keys = imageKeys(jd, spec.scheme);
      imgByJournal[spec.doc] = Object.keys(keys).length;
      // The placeholder value is ALREADY the full document id: the writer
      // builds imgKey = '<prefix>' + entryId + '_' + hash and stores the
      // placeholder as '<scheme>' + imgKey, and the rehydrator reads
      // doc(db,'dashboards', imgKey) with nothing added. Prefixing here again
      // produced journal_img_journal_img_… and silently found nothing.
      Object.keys(keys).forEach(function (k) {
        if (k.indexOf(spec.imgPrefix) !== 0) { oddKeys.push(spec.doc + ':' + k); return; }
        allImageIds[k] = true;
      });
      // One probe per entry — bounded by entry count, which is small.
      for (var e = 0; e < ids.length; e++) {
        var cd = await readDoc(spec.canvasPrefix + ids[e]);
        if (!cd) continue;
        core[spec.canvasPrefix + ids[e]] = cd;
        var cb = bytesOf(cd);
        canvasBytes += cb;
        canvases.push({ path: spec.canvasPrefix + ids[e], bytes: cb });
      }
    }
    report.groups.canvases = { found: canvases.length, bytes: canvasBytes };

    // Images: count them all, but sample for size.
    var imgIds = Object.keys(allImageIds);
    var sampled = [], sampleBytes = 0;
    var step = Math.max(1, Math.floor(imgIds.length / A1B.IMG_SAMPLE));
    for (var s2 = 0; s2 < imgIds.length && sampled.length < A1B.IMG_SAMPLE; s2 += step) {
      var idoc = await readDoc(imgIds[s2]);
      if (!idoc) continue;
      var ib = bytesOf(idoc);
      sampleBytes += ib;
      sampled.push(ib);
    }
    var avg = sampled.length ? Math.round(sampleBytes / sampled.length) : 0;
    // If images exist but none could be sampled, the estimate is UNKNOWN, not
    // zero. Reporting 0 MB here would green-light putting blobs in git on the
    // strength of no evidence at all.
    var imgOk = (imgIds.length === 0) || (sampled.length > 0);
    report.groups.images = {
      count: imgIds.length, perJournal: imgByJournal,
      sampled: sampled.length, avgBytes: avg,
      estTotalBytes: imgOk ? avg * imgIds.length : null,
      estimateValid: imgOk,
      unrecognisedKeys: oddKeys,
      largestSample: sampled.length ? Math.max.apply(null, sampled) : 0
    };

    // A "core" snapshot is everything except the image blobs.
    var coreBytes = singleBytes + archiveBytes + canvasBytes;
    var coreGz = await gzipBytes(core);
    report.totals = {
      readsUsed: reads,
      coreBytesRaw: coreBytes,
      coreBytesGzip: coreGz,
      docCount: singles.length + archives.length + canvases.length,
      imageCount: imgIds.length,
      imageBytesEst: report.groups.images.estTotalBytes,
      elapsedMs: Date.now() - t0
    };

    // ── Print it, together with the decisions it feeds ─────────────────────
    var g = report.groups;
    console.log('%c[A1Backup] Phase 0 measurement — ' + a.projectId,
                'font-weight:bold;font-size:13px');
    console.log('  reads used ......... ' + reads + '   (free tier: 50,000/day)');
    console.log('  singletons ......... ' + g.singletons.found + ' docs, ' + kb(g.singletons.bytes)
                + (g.singletons.missing.length ? '   absent: ' + g.singletons.missing.join(', ') : ''));
    if (g.singletons.failed.length) console.warn('  READ FAILURES ...... ' + g.singletons.failed.join(', '));
    console.log('  archives ........... ' + g.archives.found + ' docs, ' + kb(g.archives.bytes));
    console.log('  canvases ........... ' + g.canvases.found + ' docs, ' + kb(g.canvases.bytes));
    console.log('  images ............. ' + g.images.count + ' docs, '
                + (g.images.estimateValid ? '~' + mb(g.images.estTotalBytes)
                     + ' (avg ' + kb(g.images.avgBytes) + ' from ' + g.images.sampled + ' sampled)'
                   : 'SIZE UNKNOWN — ' + g.images.count + ' ids found but 0 could be read'));
    if (g.images.unrecognisedKeys.length) {
      console.warn('  image ids not matching their journal prefix (scheme changed?):',
                   g.images.unrecognisedKeys.slice(0, 8));
    }
    console.log('  CORE snapshot ...... ' + kb(coreBytes) + ' raw'
                + (coreGz != null
                    ? '  ->  ' + kb(coreGz) + ' gzipped ('
                      + (coreBytes / coreGz).toFixed(1) + 'x). AES adds ~0%.'
                    : '  (gzip unavailable here — compressed size UNKNOWN)'));
    if (coreGz != null) {
      // Ciphertext does not delta-compress, so each committed day is a fresh
      // blob. Retention is 30 daily + 52 weekly + 12 monthly = 94 files/year.
      var perYear = coreGz * 94;
      console.log('   git growth ........ ~' + mb(perYear) + '/device/year'
                  + '  (94 retained files; 3 devices ~= ' + mb(perYear * 3) + '/yr)');
    }
    console.log('  largest singletons . ' + g.singletons.largest.map(function (x) {
      return x.path + ' ' + kb(x.bytes); }).join('  |  '));

    console.log('%c  Decisions', 'font-weight:bold');
    if (!g.images.estimateValid) {
      console.error('   blobs in git? ..... CANNOT DECIDE — ' + g.images.count
        + ' image ids were found but none could be read. Do NOT treat this as 0 MB.');
    } else {
      var imgMB = g.images.estTotalBytes / 1048576;
      console.log('   blobs in git? ..... ' + (imgMB < 500
        ? 'YES — ' + mb(g.images.estTotalBytes) + ' is under the 500 MB threshold'
        : 'NO — ' + mb(g.images.estTotalBytes) + ' exceeds 500 MB; keep blobs local+git only, or move to R2'));
    }
    console.log('   single-file risk .. ' + (g.images.largestSample > 50 * 1048576
      ? 'ONE OR MORE IMAGES OVER 50 MB — exclude those from git'
      : 'ok, largest sampled ' + kb(g.images.largestSample)));
    console.log('   canvas cadence .... ' + (g.canvases.found > 200
      ? 'weekly (over 200 canvases)' : 'daily (' + g.canvases.found + ' canvases)'));
    console.log('   daily read cost ... ~' + Math.max(0, g.singletons.found - GROUP1_COUNT)
                + ' singletons + ' + ((A1B.ARCHIVE_YEARS_BACK + 1) * 2) + ' archive probes'
                + ' + changed canvases   (listeners cover the other '
                + GROUP1_COUNT + ' for free)');
    console.log('  full report object returned — expand it below');
    return report;
  }

  window.A1Backup = {
    version: A1B.SCHEMA,
    constants: A1B,
    register: register,
    measure: measure,
    _apps: apps,
    // Exposed so tests exercise the SHIPPED functions rather than a copy.
    // tests/backup-measure.test.js loads this file and calls these directly;
    // lifting them out by brace-matching is unreliable here because imageKeys
    // contains a regex literal full of brackets.
    _internals: {
      JOURNALS: JOURNALS, SINGLETONS: SINGLETONS,
      entryIds: entryIds, imageKeys: imageKeys,
      bytesOf: bytesOf, gzipBytes: gzipBytes
    }
  };
})();
