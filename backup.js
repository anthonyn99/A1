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
 * PHASE 0 — A1Backup.measure(), read-only sizing. Its results (2026-09-01):
 * core 3785 KB raw / 1064 KB gzipped (3.6x); 17 images totalling 0.7 MB.
 *
 * PHASE 1 — capture, encryption and the local vault (below). Content-addressed:
 * every document is stored under a hash of its plaintext, so an unchanged
 * document is stored exactly once however often it is captured. Nothing is
 * uploaded anywhere yet; phase 2 adds the off-device sink and the repo files.
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
    // How long a device may go without mirroring before it pushes even on a
    // metered connection. Three days of cellular data costs a megabyte; three
    // days of a phone's only backup living on that phone costs everything.
    METERED_GRACE_MS: 3 * 86400000,
    // Delay before the very first push. Long enough not to race the app's own
    // startup, short enough that a brief visit still mirrors once.
    FIRST_PUSH_MS: 15000,
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
    try { scheduleSetupPrompt(); } catch (e) {}
    try { startWatchdog(); } catch (e) {}
    try { flushPushOnHide(); } catch (e) {}
    try { startChip(); } catch (e) {}
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

    // Per-document gzip. Cheap (the data is already in hand) and it is what
    // tells us whether a document is worth committing at all.
    var perDoc = [];
    var coreKeys = Object.keys(core);
    for (var pd = 0; pd < coreKeys.length; pd++) {
      var raw = bytesOf(core[coreKeys[pd]]);
      var gz = await gzipBytes(core[coreKeys[pd]]);
      perDoc.push({ path: coreKeys[pd], raw: raw, gz: gz,
                    ratio: gz ? +(raw / gz).toFixed(1) : null });
    }
    perDoc.sort(function (x, y) { return (y.gz || 0) - (x.gz || 0); });
    report.perDoc = perDoc;
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
      // Ciphertext does not delta-compress, so every commit of the file is a
      // fresh blob — and git keeps every blob ever committed. Pruning the
      // working tree later reclaims nothing. Growth is therefore
      // commits-per-year x blob size, whatever the retention policy says.
      console.log('   git growth (git keeps every blob ever committed):');
      [['daily', 365], ['weekly', 52], ['monthly', 12]].forEach(function (c) {
        console.log('     ' + c[0] + ' commits ... ' + mb(coreGz * c[1]) + '/yr for ONE copy'
                    + '   (' + mb(coreGz * c[1] * 3) + '/yr if all 3 devices commit)');
      });
    }
    var near = (report.perDoc || []).filter(function (d) { return d.raw > 500 * 1024; });
    if (near.length) {
      console.warn('  LARGE DOCUMENTS (Firestore write guard refuses at 900 KB):');
      near.forEach(function (d) {
        console.warn('    ' + d.path + '  ' + kb(d.raw) + ' raw'
                     + (d.raw > 700 * 1024 ? '   <-- ' + (100 * d.raw / 921600).toFixed(0) + '% of the guard' : ''));
      });
    }
    console.log('  compression by document (largest compressed first):');
    (report.perDoc || []).slice(0, 8).forEach(function (d) {
      console.log('    ' + d.path + '  ' + kb(d.raw) + ' -> ' + kb(d.gz)
                  + '  (' + d.ratio + 'x)');
    });
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

  /* ══ PHASE 1 — capture, encrypt, store locally ═══════════════════════════
   *
   * Content-addressed from the start. Every document is compressed, encrypted
   * and stored under a name derived from a hash of its PLAINTEXT, so a document
   * that has not changed keeps the same object name and is stored exactly once
   * — in the vault today, and in git when phase 2 materialises these files.
   * That is what makes the repo cost track real change instead of snapshot size:
   * measured on 2026-09-01, a full core is 1064 KB gzipped, so re-committing it
   * daily would have cost ~379 MB/year for a single copy.
   *
   * A snapshot is therefore just a small manifest: docPath -> objectHash.
   * ====================================================================== */

  // ── Encoding helpers ─────────────────────────────────────────────────────
  var _enc = new TextEncoder(), _dec = new TextDecoder();

  function b64(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }
  function unb64(str) {
    var s = atob(str), b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }
  async function sha256Hex(str) {
    var buf = await crypto.subtle.digest('SHA-256', _enc.encode(str));
    return Array.prototype.map.call(new Uint8Array(buf),
      function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  async function gzipRaw(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    var cs = new CompressionStream('gzip');
    var blob = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).blob();
    return new Uint8Array(await blob.arrayBuffer());
  }
  async function gunzipRaw(bytes) {
    var ds = new DecompressionStream('gzip');
    var blob = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).blob();
    return new Uint8Array(await blob.arrayBuffer());
  }

  // ── Key management ───────────────────────────────────────────────────────
  // The passphrase is entered once per device and kept in localStorage so the
  // backup runs unattended — an attended backup is one that does not happen.
  // The derived key is cached in memory for the session: PBKDF2 at 600k
  // iterations costs a phone about a second, which is fine once and unusable
  // per write.
  //
  // If the passphrase is lost the backups are unreadable. There is no recovery
  // path and there must not be one; that is the price of putting ciphertext in
  // a public repository.
  var _key = null, _keyPass = null;
  // Derived keys cached by passphrase+salt+iterations. A backup is only useful
  // if ANOTHER device can read it, and the salt is per device, so decryption
  // must derive against the salt stored in the envelope rather than the local
  // one. Without this cache that would mean a 600k-iteration PBKDF2 per object.
  var _keyCache = {};

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }

  function getSalt() {
    var s = lsGet(A1B.SALT_KEY);
    if (!s) {
      s = b64(crypto.getRandomValues(new Uint8Array(16)));
      lsSet(A1B.SALT_KEY, s);
    }
    return s;
  }

  async function deriveKeyWith(pass, saltB64, iter) {
    var ck = saltB64 + '|' + iter;
    if (_keyCache[ck] && _keyCache[ck].pass === pass) return _keyCache[ck].key;
    var base = await crypto.subtle.importKey('raw', _enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    var key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: unb64(saltB64), iterations: iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    _keyCache[ck] = { pass: pass, key: key };
    return key;
  }

  var _hmacCache = {};
  async function deriveHmacWith(pass, saltB64, iter) {
    var ck = saltB64 + '|' + iter;
    if (_hmacCache[ck] && _hmacCache[ck].pass === pass) return _hmacCache[ck].key;
    var base = await crypto.subtle.importKey('raw', _enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    var key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: unb64(saltB64), iterations: iter, hash: 'SHA-256' },
      base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
    _hmacCache[ck] = { pass: pass, key: key };
    return key;
  }

  // Object id = HMAC(key, path || NUL || plaintext), hex, truncated.
  // Content-addressed so an unchanged document is stored exactly once; KEYED so
  // the id reveals nothing to anyone without the passphrase. A plain hash would
  // let someone who can see an id confirm a GUESSED document — the same
  // confirmation attack the plaintext hash is hidden inside the ciphertext to
  // avoid. Keying it is also what makes it safe to publish the id list, which
  // the pull script needs in order to fetch anything at all.
  async function objId(path, plain) {
    var pass = lsGet(A1B.PASS_KEY);
    if (!pass) throw new Error('locked');
    var key = await deriveHmacWith(pass, getSalt(), A1B.PBKDF2_ITER);
    var sig = await crypto.subtle.sign('HMAC', key, _enc.encode(path + '\u0000' + plain));
    return Array.prototype.map.call(new Uint8Array(sig),
      function (x) { return ('0' + x.toString(16)).slice(-2); }).join('').slice(0, 32);
  }

  async function deriveKey(pass) {
    if (_key && _keyPass === pass) return _key;
    _key = await deriveKeyWith(pass, getSalt(), A1B.PBKDF2_ITER);
    _keyPass = pass;
    return _key;
  }

  // Returns the cached key, deriving from the stored passphrase if needed.
  // null means "locked" — every write path checks this and does nothing.
  async function activeKey() {
    var p = lsGet(A1B.PASS_KEY);
    if (!p) return null;
    return deriveKey(p);
  }

  async function unlock(pass) {
    // Any length — that is the user's call. An EMPTY passphrase is still
    // refused, for a mechanical reason rather than a policy one: activeKey()
    // reads a falsy stored value as "locked", so an empty passphrase would
    // quietly turn backups OFF rather than protect them.
    if (!pass) throw new Error('passphrase cannot be empty');
    await deriveKey(pass);
    lsSet(A1B.PASS_KEY, pass);
    chipRefresh().catch(function () {});
    // Prove it round-trips before declaring success, so a broken WebCrypto or a
    // storage failure surfaces now rather than at restore time.
    var probe = await encryptStr('a1b-probe');
    var back = await decryptEnv(probe);
    if (back !== 'a1b-probe') throw new Error('encryption self-test failed');
    return true;
  }

  // ── Envelope ─────────────────────────────────────────────────────────────
  // serialize -> gzip -> AES-GCM. The plaintext hash lives INSIDE the
  // ciphertext so a stored file cannot be used to confirm guessed content;
  // only structural metadata sits outside.
  async function encryptStr(plain) {
    var key = await activeKey();
    if (!key) throw new Error('locked');
    var body = _enc.encode(JSON.stringify({ h: await sha256Hex(plain), d: plain }));
    var gz = await gzipRaw(body);
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, gz || body);
    return {
      v: A1B.SCHEMA, alg: 'AES-256-GCM', gz: !!gz,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: A1B.PBKDF2_ITER, salt: getSalt() },
      iv: b64(iv), ct: b64(ct)
    };
  }

  async function decryptEnv(env) {
    var pass = lsGet(A1B.PASS_KEY);
    if (!pass) throw new Error('locked');
    // Derive against the envelope's OWN salt and iteration count, not this
    // device's. Salts are per device, so using the local one would make every
    // backup readable only on the machine that wrote it — and a backup only
    // one device can read is not a backup.
    var kdf = env.kdf || {};
    var key = await deriveKeyWith(pass, kdf.salt || getSalt(),
                                  kdf.iter || A1B.PBKDF2_ITER);
    var raw = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.ct)));
    var body = env.gz ? await gunzipRaw(raw) : raw;
    var obj = JSON.parse(_dec.decode(body));
    // Integrity is verified on every read. A mismatch is a loud failure, never
    // a shrug — a corrupted backup that reads as valid is worse than none.
    var check = await sha256Hex(obj.d);
    if (check !== obj.h) throw new Error('integrity check failed (stored hash does not match content)');
    return obj.d;
  }

  // ── Vault (IndexedDB, one per origin) ────────────────────────────────────
  var _dbp = null;
  function vault() {
    if (_dbp) return _dbp;
    _dbp = new Promise(function (res, rej) {
      var r = indexedDB.open(A1B.DB, 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains('objects')) d.createObjectStore('objects');   // hash -> envelope
        if (!d.objectStoreNames.contains('snapshots')) d.createObjectStore('snapshots'); // ts -> manifest
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');         // key -> value
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return _dbp;
  }
  async function vGet(store, key) {
    var d = await vault();
    return new Promise(function (res, rej) {
      var r = d.transaction(store, 'readonly').objectStore(store).get(key);
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  async function vPut(store, key, val) {
    var d = await vault();
    return new Promise(function (res, rej) {
      var tx = d.transaction(store, 'readwrite');
      tx.objectStore(store).put(val, key);
      tx.oncomplete = function () { res(true); };
      tx.onerror = function () { rej(tx.error); };
    });
  }
  async function vKeys(store) {
    var d = await vault();
    return new Promise(function (res, rej) {
      var r = d.transaction(store, 'readonly').objectStore(store).getAllKeys();
      r.onsuccess = function () { res(r.result || []); };
      r.onerror = function () { rej(r.error); };
    });
  }

  // ── Guards ───────────────────────────────────────────────────────────────
  function killed() { return lsGet(A1B.DISABLED_KEY) === '1'; }

  // Never capture before the cloud has loaded. This is exactly how the archive
  // bug destroyed data: it acted on state that had not arrived yet and wrote
  // the result over something good.
  function gatesOpen() {
    return !!(window._fbReady && window._thCloudLoaded && window._vdCloudLoaded);
  }

  // Refuse to compete with Firestore for storage. On iOS a full origin quota
  // can evict Firestore's own IndexedDB cache and wedge sync outright — the
  // reason _freeWebStorage exists in index.html.
  async function storageOk() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) return true;
      var e = await navigator.storage.estimate();
      if (!e || !e.quota) return true;
      return (e.quota - (e.usage || 0)) / 1048576 > A1B.MIN_STORAGE_MB;
    } catch (e) { return true; }
  }

  // Mirrors _thbAllow in index.html: a snapshot that loses most of its content
  // is refused rather than allowed to overwrite a good one. Biased toward
  // refusing — a blocked good backup costs one retry, a permitted bad one costs
  // everything.
  function shrinkOk(prev, next) {
    if (!prev) return { ok: true };
    var pd = Object.keys(prev.docs || {}).length, nd = Object.keys(next.docs || {}).length;
    if (pd >= 4 && nd < Math.floor(pd * A1B.SHRINK_RATIO)) {
      return { ok: false, why: 'document count fell from ' + pd + ' to ' + nd };
    }
    if (prev.bytes >= 50000 && next.bytes < Math.floor(prev.bytes * A1B.SHRINK_RATIO)) {
      return { ok: false, why: 'size fell from ' + prev.bytes + ' to ' + next.bytes + ' bytes' };
    }
    return { ok: true };
  }

  // ── Capture ──────────────────────────────────────────────────────────────
  // Tier A: index.html hands us documents its EXISTING listeners already
  // deliver, so the hot path costs no Firestore reads at all.
  var observed = {};        // docPath -> data
  var _dirty = false, _capTimer = null;

  function observe(docPath, data) {
    if (killed() || !docPath || data == null) return false;
    observed[docPath] = data;
    _dirty = true;
    if (_capTimer) clearTimeout(_capTimer);
    _capTimer = setTimeout(function () { captureNow().catch(function () {}); },
                           A1B.CAPTURE_DEBOUNCE_MS);
    return true;
  }

  var _lastSummary = null;   // { docs, bytes } of the last accepted snapshot

  async function captureNow(opts) {
    opts = opts || {};
    if (killed()) return { skipped: 'kill switch' };
    var key = await activeKey();
    if (!key) return { skipped: 'locked — call A1Backup.unlock(passphrase)' };
    if (!opts.force && !gatesOpen()) return { skipped: 'cloud not loaded yet' };
    if (!(await storageOk())) {
      console.warn('[A1Backup] storage headroom below ' + A1B.MIN_STORAGE_MB +
                   ' MB — not writing, so Firestore keeps its cache');
      return { skipped: 'low storage' };
    }

    var paths = Object.keys(observed);
    if (!paths.length) return { skipped: 'nothing observed yet' };

    // Content-address every document. Unchanged ones already exist under the
    // same hash, so the write is a no-op and the object is stored once.
    var manifest = { at: Date.now(), schema: A1B.SCHEMA, docs: {}, bytes: 0 };
    var stored = 0, reused = 0;
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      var plain = JSON.stringify(observed[p]);
      var h = await objId(p, plain);
      manifest.docs[p] = h;
      manifest.bytes += plain.length;
      if (await vGet('objects', h)) { reused++; continue; }
      await vPut('objects', h, await encryptStr(plain));
      stored++;
    }

    var guard = shrinkOk(_lastSummary, manifest);
    if (!guard.ok) {
      console.error('[A1Backup] REFUSED a snapshot that loses most of its content — ' +
                    guard.why + '. The previous backup is untouched.');
      try { window._fbSyncAlert && window._fbSyncAlert('Backup',
        'A backup was refused because it would have dropped most of your data (' +
        guard.why + '). Nothing was overwritten.'); } catch (e) {}
      await vPut('snapshots', 'suspect-' + manifest.at, manifest);
      return { refused: guard.why };
    }

    await vPut('snapshots', String(manifest.at), manifest);
    await vPut('meta', 'lastSnapshot', manifest.at);
    _lastSummary = { docs: manifest.docs, bytes: manifest.bytes };
    _dirty = false;
    // Mirror off-device, debounced. Deliberately not awaited: the local vault
    // is the copy that must never be delayed by a network round trip.
    try { schedulePush(); } catch (e) {}
    chipRefresh().catch(function () {});
    return { at: manifest.at, docs: paths.length, stored: stored, reused: reused,
             bytes: manifest.bytes };
  }

  // ── Read back ────────────────────────────────────────────────────────────
  async function listSnapshots() {
    var keys = await vKeys('snapshots');
    return keys.filter(function (k) { return String(k).indexOf('suspect-') !== 0; })
               .map(Number).filter(function (n) { return !isNaN(n); })
               .sort(function (a, b) { return b - a; });
  }

  // Decrypts a stored snapshot back to { docPath: data }. This is also the
  // "verify" path: it exercises the passphrase and the integrity check on real
  // stored bytes. A backup nobody has ever read back is not a backup.
  async function restoreSnapshot(at) {
    var snaps = await listSnapshots();
    var pick = at || snaps[0];
    if (!pick) throw new Error('no snapshots stored');
    var man = await vGet('snapshots', String(pick));
    if (!man) throw new Error('snapshot ' + pick + ' not found');
    var out = {};
    var paths = Object.keys(man.docs);
    for (var i = 0; i < paths.length; i++) {
      var env = await vGet('objects', man.docs[paths[i]]);
      if (!env) throw new Error('missing object for ' + paths[i]);
      out[paths[i]] = JSON.parse(await decryptEnv(env));
    }
    return { at: pick, docs: out };
  }

  async function verify() {
    var r = await restoreSnapshot();
    var n = Object.keys(r.docs).length;
    console.log('[A1Backup] verified snapshot ' + new Date(r.at).toLocaleString() +
                ' — ' + n + ' document(s) decrypted and integrity-checked.');
    return { at: r.at, docs: n };
  }

  async function status() {
    var out = {
      locked: !lsGet(A1B.PASS_KEY),
      killed: killed(),
      gatesOpen: gatesOpen(),
      observed: Object.keys(observed).length,
      dirty: _dirty
    };
    try {
      out.snapshots = (await listSnapshots()).length;
      out.lastSnapshot = await vGet('meta', 'lastSnapshot') || null;
      out.objects = (await vKeys('objects')).length;
      out.ageHours = out.lastSnapshot
        ? +((Date.now() - out.lastSnapshot) / 3600000).toFixed(1) : null;
      out.stale = out.ageHours == null || out.ageHours > 48;
      out.lastPushedAt = await vGet('meta', 'lastPushedAt') || null;
      out.pushedOffDevice = out.lastPushedAt != null && String(out.lastPushedAt) === String(out.lastSnapshot);
      out.pushesToday = pushesToday();
      out.device = deviceSlug();
    } catch (e) { out.vaultError = String(e && (e.message || e)); }
    return out;
  }

  /* ── First-run setup, in the UI ───────────────────────────────────────────
   *
   * The passphrase cannot be set from a console on a phone, and the phone is
   * the device that most needs a backup, so setup has to be a real dialog.
   *
   * WHICH PROFILE IS ASKED
   * Each device asks for exactly one passphrase: the profile whose TaskHub is
   * set as MAIN on that device (`td6_mainDash`, the same flag that already
   * scopes reminder delivery). Tony's PC asks Tony; Veda's phone asks Veda.
   * Nobody is asked to set a passphrase for someone else's profile.
   *
   * Note this is about WHO IS ASKED, not about what gets backed up. Index runs
   * listeners for both profiles, so a backup taken on any device contains both
   * TaskHubs, both journals, plans — everything. Each person's devices simply
   * hold that shared data under their own key, which gives two independent
   * recovery paths rather than one.
   * ===================================================================== */

  var PROFILE_LABEL = { tony: 'Tony', veda: 'Veda' };

  function mainProfile() {
    var m = lsGet('td6_mainDash');
    return m === 'veda' ? 'veda' : 'tony';
  }

  function setupDone() { return !!lsGet(A1B.PASS_KEY); }

  // Returns 'set' | 'skipped' | 'unavailable' | 'already'.
  async function promptSetup(opts) {
    opts = opts || {};
    if (killed()) return 'unavailable';
    if (setupDone() && !opts.force) return 'already';
    if (typeof window.uiForm !== 'function' || typeof window.uiAlert !== 'function') {
      return 'unavailable';
    }

    var who = opts.profile || mainProfile();
    var name = PROFILE_LABEL[who] || 'you';
    var note = '';

    for (;;) {
      var res = await window.uiForm({
        title: 'Turn on backups for ' + name,
        message: note +
          'Index can keep an encrypted backup of everything — both TaskHubs, both ' +
          'journals, plans and settings — so nothing is lost if the cloud ever fails.\n\n' +
          'Choose a passphrase. It is the only thing that can open your backups, and ' +
          'it CANNOT be recovered. Write it down somewhere safe before you continue.',
        okLabel: 'Turn on backups',
        cancelLabel: 'Not now',
        fields: [
          { name: 'p1', label: 'Passphrase', type: 'password', required: true,
            placeholder: 'anything you will remember' },
          { name: 'p2', label: 'Type it again', type: 'password', required: true }
        ]
      });

      if (!res) {                       // "Not now"
        lsSet('a1b_snoozed_at', String(Date.now()));
        return 'skipped';
      }

      var p1 = String(res.p1 || ''), p2 = String(res.p2 || '');
      if (!p1) { note = 'Please enter a passphrase.\n\n'; continue; }
      if (p1 !== p2) { note = 'The two entries did not match. Please try again.\n\n'; continue; }

      try {
        await unlock(p1);               // self-tests encryption before returning
      } catch (e) {
        note = 'Could not turn on backups on this device (' +
               (e && (e.message || e)) + '). Please try again.\n\n';
        continue;
      }

      lsSet('a1b_profile', who);
      lsSet('a1b_setup_at', String(Date.now()));

      await window.uiAlert(
        'Backups are on for ' + name + '.\n\n' +
        'From now on, every change is encrypted and saved on this device — it keeps ' +
        'working with no internet.\n\n' +
        'Two things worth knowing:\n\n' +
        '• Write the passphrase down. There is no way to recover it, and without it ' +
        'the backups cannot be read. That is what makes it safe to store them publicly.\n\n' +
        '• You will set it once on each device you use. Use the SAME passphrase every ' +
        'time, so any device can restore a backup made on another one.',
        { title: 'Backups are on' });

      // Capture immediately so there is a real backup within seconds of setup,
      // rather than whenever the next edit happens to land.
      try { await captureNow(); } catch (e) {}
      return 'set';
    }
  }

  // Ask once per load, once the app is actually up. Deliberately polled rather
  // than fired on a timer: the modal system and the Firebase gates come up at
  // different times on different devices, and a single missed timeout would
  // mean a device that silently never gets a backup.
  function scheduleSetupPrompt() {
    if (setupDone() || killed()) return;
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (setupDone() || killed() || tries > 40) { clearInterval(iv); return; }
      // Wait for the modal system AND for the cloud, so the first thing a
      // person sees on opening Index is their data, not a passphrase box.
      if (typeof window.uiForm !== 'function' || !gatesOpen()) return;
      clearInterval(iv);
      promptSetup().catch(function (e) {
        console.warn('[A1Backup] setup prompt failed:', e && (e.message || e));
      });
    }, 1500);
  }

  /* ── Off-device push ──────────────────────────────────────────────────────
   *
   * The vault so far lives only in this device's IndexedDB. That survives
   * Firebase losing the data, but not the device being lost, wiped or left in
   * a drawer — and no device can see whether any OTHER device is still backing
   * up, which is how a silent failure hides.
   *
   * What goes over the wire is what is already in the vault: envelopes that
   * were encrypted here, against a passphrase the Worker never receives. The
   * Worker stores ciphertext and refuses anything else.
   *
   * Objects are content-addressed, so only genuinely NEW pieces are uploaded.
   * A device that has not changed anything sends one small manifest and no
   * objects at all — which is what keeps this inside KV's ~1000 writes/day on
   * the free plan without ever having to think about it.
   * ===================================================================== */

  var WORKER = 'https://index-backups.av1.workers.dev';

  function deviceSlug() {
    // Reuse the identity the app already has (Plans stamps these) so a device
    // is called the same thing everywhere, rather than inventing a second
    // scheme that has to be reconciled later.
    var id = lsGet('pl_device_id') || lsGet('a1b_device_id') || '';
    if (!id) {
      id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      lsSet('a1b_device_id', id);
    }
    var nm = lsGet('pl_device_name') || '';
    if (!nm) {
      var ua = navigator.userAgent || '';
      nm = /iPhone/i.test(ua) ? 'iPhone' : /iPad/i.test(ua) ? 'iPad'
         : /Android/i.test(ua) ? 'Android' : /Mac/i.test(ua) ? 'Mac'
         : /Windows/i.test(ua) ? 'PC' : 'device';
    }
    var slug = String(nm).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return (slug || 'device') + '-' + String(id).replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
  }

  // Daily push budget. KV's free plan allows ~1000 writes/day across
  // everything, so each device holds itself well under a share of that. The
  // counter is per local day and is surfaced in status(), because a cap that
  // silently stops a backup is the failure this whole system exists to avoid.
  function pushDayKey() { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function pushesToday() {
    var raw = lsGet('a1b_push_count') || '';
    var parts = raw.split('|');
    return parts[0] === pushDayKey() ? (parseInt(parts[1], 10) || 0) : 0;
  }
  function notePush() { lsSet('a1b_push_count', pushDayKey() + '|' + (pushesToday() + 1)); }

  // Connections people pay for by the megabyte are not the place to mirror a
  // backup. The local vault already has it; this can wait for wifi.
  function metered() {
    try {
      var c = navigator.connection;
      if (!c) return false;
      return !!c.saveData || c.type === 'cellular' || /^(slow-2g|2g)$/.test(c.effectiveType || '');
    } catch (e) { return false; }
  }

  async function acHeaders() {
    var h = { 'Content-Type': 'application/json' };
    try {
      if (window._acToken) {
        var t = await window._acToken();
        if (t) h['X-Firebase-AppCheck'] = t;
      }
    } catch (e) {}
    return h;
  }

  var _pushTimer = null, _pushing = false;

  async function pushNow(opts) {
    opts = opts || {};
    if (killed()) return { skipped: 'kill switch' };
    if (!setupDone()) return { skipped: 'locked' };
    if (_pushing) return { skipped: 'already pushing' };
    if (!navigator.onLine) return { skipped: 'offline' };
    // Metered connections are skipped for ROUTINE mirroring — the local vault
    // already holds it, so this can wait for wifi. But "wait for wifi" must not
    // become "never": a phone that lives on cellular is the device most likely
    // to be lost or broken, and its backup would be the one that never left it.
    // After METERED_GRACE_MS with nothing pushed, a megabyte of data is plainly
    // worth less than the copy.
    if (!opts.force && metered()) {
      var lastOk = Number(await vGet('meta', 'lastPushOkAt') || 0);
      if (Date.now() - lastOk < A1B.METERED_GRACE_MS) {
        return { skipped: 'metered connection (will retry on wifi)' };
      }
    }
    if (!opts.force && pushesToday() >= A1B.MAX_PUSH_PER_DAY) {
      return { skipped: 'daily push cap reached (' + A1B.MAX_PUSH_PER_DAY + ')' };
    }

    var snaps = await listSnapshots();
    if (!snaps.length) return { skipped: 'nothing captured yet' };
    var at = snaps[0];
    var man = await vGet('snapshots', String(at));
    if (!man) return { skipped: 'snapshot missing' };
    if (!opts.force && String(await vGet('meta', 'lastPushedAt') || '') === String(at)) {
      return { skipped: 'already pushed' };
    }

    _pushing = true;
    try {
      var headers = await acHeaders();
      // Hashes this device has already seen accepted. Without it every push
      // would re-offer every object and turn a quiet no-change push into two
      // dozen requests.
      var sent = (await vGet('meta', 'pushedObjects')) || {};
      var hashes = Object.keys(man.docs).map(function (k) { return man.docs[k]; });
      var uploaded = 0, deduped = 0, failed = 0;

      for (var i = 0; i < hashes.length; i++) {
        var h = hashes[i];
        if (sent[h]) { deduped++; continue; }
        var env = await vGet('objects', h);
        if (!env) { failed++; continue; }
        var r = await fetch(WORKER + '/o/' + h, {
          method: 'PUT', headers: headers, body: JSON.stringify(env)
        });
        if (!r.ok) { failed++; continue; }
        sent[h] = 1;
        uploaded++;
      }
      await vPut('meta', 'pushedObjects', sent);

      // The manifest is encrypted too — it lists document paths, which is
      // structure worth not publishing. The document COUNT rides outside so the
      // health view can show it without anyone decrypting anything.
      var envMan = await encryptStr(JSON.stringify(man));
      envMan.docs = Object.keys(man.docs).length;
      envMan.at = at;
      // The object ids this snapshot needs, in the clear. They are keyed
      // hashes, so they identify nothing on their own — and pull-backups.mjs
      // cannot read the manifest, so without this list it has no way to fetch
      // the documents themselves. Omitting it is what left the repo copy as an
      // index pointing at nothing.
      envMan.objects = hashes;
      var mr = await fetch(WORKER + '/s/' + deviceSlug(), {
        method: 'PUT', headers: headers, body: JSON.stringify(envMan)
      });
      if (!mr.ok) {
        var why = mr.status === 401 ? 'not authorised (App Check)' : 'HTTP ' + mr.status;
        return { error: why, uploaded: uploaded, failed: failed };
      }
      notePush();
      await vPut('meta', 'lastPushedAt', at);
      await vPut('meta', 'lastPushOkAt', Date.now());
      chipRefresh().catch(function () {});
      return { at: at, uploaded: uploaded, deduped: deduped, failed: failed,
               device: deviceSlug(), pushesToday: pushesToday() };
    } catch (e) {
      return { error: String(e && (e.message || e)) };
    } finally {
      _pushing = false;
    }
  }

  function schedulePush() {
    if (_pushTimer) clearTimeout(_pushTimer);
    // The FIRST push is not debounced the same way. Until something has
    // actually left this device there is nothing off-device at all, and making
    // that wait ten minutes means a phone opened briefly never mirrors even
    // once. After that, the long debounce is what keeps us inside the daily
    // write budget.
    var everPushed = !!lsGet('a1b_pushed_once');
    var wait = everPushed ? A1B.PUSH_DEBOUNCE_MS : A1B.FIRST_PUSH_MS;
    _pushTimer = setTimeout(function () {
      pushNow().then(function (r) {
        if (r && r.at) lsSet('a1b_pushed_once', '1');
      }).catch(function () {});
    }, wait);
  }

  // A debounce with nothing to flush it is a promise that quietly is not kept:
  // close the page before the timer fires and the snapshot never leaves. Phones
  // are opened for seconds at a time, and they are the devices most likely to
  // be lost, so a visit ending is treated as a reason to mirror now.
  //
  // Best-effort by nature — the browser may cut the request short on unload —
  // but an attempt that usually succeeds beats a timer that usually never runs.
  function flushPushOnHide() {
    var fire = function () {
      if (document.visibilityState !== 'hidden') return;
      if (_pushTimer) { clearTimeout(_pushTimer); _pushTimer = null; }
      pushNow().then(function (r) {
        if (r && r.at) lsSet('a1b_pushed_once', '1');
      }).catch(function () {});
    };
    document.addEventListener('visibilitychange', fire);
    window.addEventListener('pagehide', fire);
  }

  // What every device has, so one device can tell that ANOTHER has gone quiet.
  // That cross-device view is the whole reason this leaves the machine.
  async function fleet() {
    try {
      var r = await fetch(WORKER + '/index', { headers: await acHeaders() });
      if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
      var j = await r.json();
      var now = Date.now();
      var out = { ok: true, me: deviceSlug(), devices: [] };
      Object.keys(j.devices || {}).forEach(function (d) {
        var v = j.devices[d];
        out.devices.push({
          device: d, at: v.at, docs: v.docs, bytes: v.bytes,
          ageHours: +((now - v.at) / 3600000).toFixed(1),
          stale: (now - v.at) > 48 * 3600000
        });
      });
      out.devices.sort(function (a, b) { return b.at - a.at; });
      return out;
    } catch (e) { return { ok: false, error: String(e && (e.message || e)) }; }
  }

  /* ── Stale-backup watchdog ────────────────────────────────────────────────
   *
   * Every data incident in this project has been SILENT. The goals that
   * vanished on 2026-08-25, the archived days, the reclaim that hung sync —
   * none of them announced themselves; they were noticed days later, by which
   * point the evidence was gone.
   *
   * A backup system that quietly stops is worse than none, because it is
   * trusted. So this checks itself and says so out loud. Neither person can
   * read a console — Veda has no way to open one on a phone at all — which is
   * why this reports through the same visible alert the sync layer already
   * uses rather than console.warn.
   * ===================================================================== */

  var STALE_HOURS = 48;
  var CHECK_EVERY_MS = 3600000;          // hourly
  var _lastNag = 0;
  var NAG_EVERY_MS = 6 * 3600000;        // at most once every 6 hours

  async function healthCheck(opts) {
    opts = opts || {};
    if (killed()) return { ok: true, why: 'disabled' };
    if (!setupDone()) return { ok: true, why: 'not set up' };

    var st;
    try { st = await status(); }
    catch (e) { return { ok: false, why: 'vault unreadable: ' + (e && (e.message || e)) }; }

    if (st.vaultError) return { ok: false, why: 'vault error: ' + st.vaultError };

    // No snapshot at all, despite being set up and having seen documents, means
    // capture is failing rather than merely idle.
    if (st.lastSnapshot == null) {
      return { ok: false, why: 'backups are on but nothing has ever been saved' };
    }
    if (st.ageHours != null && st.ageHours > STALE_HOURS) {
      return { ok: false, why: 'the last backup on this device is ' +
        Math.round(st.ageHours) + ' hours old' };
    }
    return { ok: true, at: st.lastSnapshot, ageHours: st.ageHours, docs: st.observed };
  }

  async function healthCheckLoud(opts) {
    var r = await healthCheck(opts);
    if (r.ok) return r;
    var now = Date.now();
    if (!opts || !opts.force) {
      if (now - _lastNag < NAG_EVERY_MS) return r;      // do not become noise
    }
    _lastNag = now;
    console.error('[A1Backup] NOT BACKING UP — ' + r.why);
    try {
      if (window._fbSyncAlert) {
        window._fbSyncAlert('Backup',
          'Backups have stopped on this device — ' + r.why + '.\n\n' +
          'Your data is still syncing normally; this is about the extra local ' +
          'copy. Reload Index and it will usually start again.');
      }
    } catch (e) {}
    return r;
  }

  function startWatchdog() {
    // First check well after load, so a slow cold start is never mistaken for
    // a failure, then hourly.
    setTimeout(function () { healthCheckLoud().catch(function () {}); }, 120000);
    setInterval(function () { healthCheckLoud().catch(function () {}); }, CHECK_EVERY_MS);
  }

  // A human-readable summary, for people rather than for code. Exposed so it
  // can be wired to a button later without touching this file again.
  async function report() {
    var st = await status();
    var h = await healthCheck();
    var lines = [
      st.locked ? 'Backups: OFF (no passphrase set on this device)'
                : 'Backups: ON' + (st.killed ? ' but PAUSED' : ''),
      'Last backup: ' + (st.lastSnapshot
        ? new Date(st.lastSnapshot).toLocaleString() +
          '  (' + (st.ageHours < 1 ? 'just now' : Math.round(st.ageHours) + 'h ago') + ')'
        : 'never'),
      'Saved snapshots: ' + (st.snapshots || 0),
      'Documents watched: ' + st.observed,
      'Stored pieces: ' + (st.objects || 0),
      '',
      h.ok ? 'Healthy.' : 'PROBLEM: ' + h.why
    ];
    var text = lines.join('\n');
    try { if (window.uiAlert) await window.uiAlert(text, { title: 'Backup status' }); } catch (e) {}
    console.log(text);
    return st;
  }

  /* ── Restore drill ────────────────────────────────────────────────────────
   *
   * Everything up to here proves a backup was WRITTEN. None of it proves one
   * can be READ BACK, and those are different claims — the repo copy spent its
   * first day holding a manifest with no documents behind it and looked
   * perfectly healthy the whole time.
   *
   * This is the real exercise: fetch the copy from the PUBLIC repo over the
   * internet, exactly as someone would after losing Firebase, Cloudflare and
   * every device, then decrypt it with the passphrase and check that what comes
   * out matches what went in.
   *
   * It reads only. It never writes to Firestore, the vault, or anywhere else —
   * a drill that mutates the thing it is testing is not a drill.
   * ===================================================================== */

  function backupsBaseUrl() {
    // Sibling of the page: .../A1/index.html -> .../A1/Index Backups/
    var dir = location.pathname.replace(/[^/]*$/, '');
    return location.origin + dir + 'Index%20Backups/';
  }

  async function drill(opts) {
    opts = opts || {};
    var base = opts.base || backupsBaseUrl();
    var out = { base: base, ok: false, steps: [] };
    var step = function (name, ok, detail) {
      out.steps.push({ step: name, ok: !!ok, detail: detail || '' });
      console.log((ok ? '  ok    ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
      return ok;
    };

    if (!setupDone()) {
      console.error('[A1Backup] drill needs the passphrase set on this device.');
      out.error = 'locked';
      return out;
    }
    console.log('%c[A1Backup] Restore drill — reading the PUBLIC repo copy',
                'font-weight:bold;font-size:13px');
    console.log('  from ' + base);

    try {
      var idxRes = await fetch(base + 'index.json', { cache: 'no-store' });
      if (!step('fetched index.json', idxRes.ok, 'HTTP ' + idxRes.status)) return out;
      var idx = await idxRes.json();

      var devices = idx.devices || [];
      step('index lists ' + devices.length + ' device(s)', devices.length > 0,
           devices.map(function (d) { return d.device; }).join(', '));

      var pick = opts.device
        ? devices.filter(function (d) { return d.device === opts.device; })[0]
        : devices[0];
      if (!step('chose a device to restore', !!pick, pick ? pick.device : 'none')) return out;

      var stamp = String(pick.iso || '').slice(0, 10);
      var manUrl = base + encodeURIComponent(pick.device) + '/snapshots/' + stamp + '.enc.json';
      var manRes = await fetch(manUrl, { cache: 'no-store' });
      if (!step('fetched the snapshot manifest', manRes.ok, 'HTTP ' + manRes.status)) return out;
      var env = await manRes.json();

      // Decrypting is also the integrity check: a mismatch between the stored
      // hash and the content throws rather than returning plausible rubbish.
      var man;
      try {
        man = JSON.parse(await decryptEnv(env));
        step('decrypted the manifest with this passphrase', true,
             Object.keys(man.docs || {}).length + ' documents listed');
      } catch (e) {
        step('decrypted the manifest with this passphrase', false, String(e && e.message || e));
        out.error = 'decrypt failed — wrong passphrase, or the file is damaged';
        return out;
      }

      var paths = Object.keys(man.docs || {});
      var restored = {}, missing = [], broken = [];
      for (var i = 0; i < paths.length; i++) {
        var p = paths[i], id = man.docs[p];
        var oRes = await fetch(base + encodeURIComponent(pick.device) + '/objects/' + id + '.enc.json',
                               { cache: 'no-store' });
        if (!oRes.ok) { missing.push(p); continue; }
        try {
          restored[p] = JSON.parse(await decryptEnv(await oRes.json()));
        } catch (e) { broken.push(p + ': ' + (e && e.message || e)); }
      }

      step('every document in the manifest is present', missing.length === 0,
           missing.length ? 'MISSING: ' + missing.join(', ') : paths.length + '/' + paths.length);
      step('every document decrypted and passed its integrity check', broken.length === 0,
           broken.length ? broken.join(' | ') : '');

      // Content check, not just "it parsed". A restore that yields empty
      // objects would satisfy every structural test above.
      var nonEmpty = paths.filter(function (p) {
        var v = restored[p];
        return v && typeof v === 'object' && Object.keys(v).length > 0;
      });
      step('restored documents actually contain data', nonEmpty.length === paths.length,
           nonEmpty.length + '/' + paths.length + ' non-empty');

      // Compare against what this device holds right now, where they overlap.
      var live = {};
      Object.keys(observed).forEach(function (k) { live[k] = observed[k]; });
      var compared = 0, matched = 0;
      Object.keys(live).forEach(function (k) {
        if (!(k in restored)) return;
        compared++;
        if (JSON.stringify(live[k]) === JSON.stringify(restored[k])) matched++;
      });
      step('restored content matches this device where they overlap',
           compared === 0 || matched === compared,
           matched + '/' + compared + ' documents identical' +
           (compared === 0 ? ' (nothing to compare yet)' : ''));

      out.restored = paths.length;
      out.devices = devices.length;
      out.ok = missing.length === 0 && broken.length === 0 &&
               nonEmpty.length === paths.length && (compared === 0 || matched === compared);

      console.log(out.ok
        ? '%c  DRILL PASSED — the public repo copy alone can rebuild this data.'
        : '%c  DRILL FAILED — see the steps above. Do not rely on this copy.',
        'font-weight:bold;color:' + (out.ok ? '#3a3' : '#c33'));
      if (out.ok) {
        console.log('  Restored ' + paths.length + ' documents, e.g. ' +
                    paths.slice(0, 4).join(', '));
      }
      return out;
    } catch (e) {
      out.error = String(e && (e.message || e));
      console.error('[A1Backup] drill threw: ' + out.error);
      return out;
    }
  }

  /* ── Status chip ──────────────────────────────────────────────────────────
   *
   * Everything in here has been driveable only from a console, which means it
   * has been driveable only by one person on one device. Phones have no
   * console, and Veda has no way to check her own backup at all — so "is this
   * working?" has been a question only I could answer, by being asked.
   *
   * A small chip fixes that. It is drawn by this file rather than by the app,
   * so it costs Index no markup, cannot disturb its React tree, and appears on
   * any app that registers later without further work.
   *
   * It is quiet by default: a muted dot that says "Backed up". It only demands
   * attention when something is actually wrong, because a warning that is
   * always on is a warning nobody reads.
   * ===================================================================== */

  var CHIP_ID = 'a1b-chip';

  function chipStyles() {
    if (document.getElementById(CHIP_ID + '-css')) return;
    var css = document.createElement('style');
    css.id = CHIP_ID + '-css';
    css.textContent =
      '#' + CHIP_ID + '{position:fixed;left:10px;bottom:10px;z-index:2147483000;' +
      'display:flex;align-items:center;gap:6px;padding:5px 9px;border-radius:999px;' +
      'font:500 11px/1 "Inter",system-ui,-apple-system,sans-serif;letter-spacing:.02em;' +
      'background:rgba(26,26,29,.82);color:#8d8d94;border:1px solid rgba(255,255,255,.09);' +
      'cursor:pointer;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);' +
      'opacity:.55;transition:opacity .18s,color .18s,border-color .18s;' +
      'user-select:none;-webkit-tap-highlight-color:transparent;}' +
      '#' + CHIP_ID + ':hover,#' + CHIP_ID + ':focus-visible{opacity:1;outline:none;' +
      'border-color:rgba(224,184,116,.4);color:#e0b874;}' +
      '#' + CHIP_ID + ' i{width:6px;height:6px;border-radius:50%;background:#5c8d5c;' +
      'flex:0 0 auto;display:block;}' +
      '#' + CHIP_ID + '[data-state="warn"]{opacity:1;color:#d6a35c;' +
      'border-color:rgba(214,163,92,.45);}' +
      '#' + CHIP_ID + '[data-state="warn"] i{background:#d6a35c;}' +
      '#' + CHIP_ID + '[data-state="off"]{opacity:1;color:#d68a7c;' +
      'border-color:rgba(214,138,124,.45);}' +
      '#' + CHIP_ID + '[data-state="off"] i{background:#d68a7c;}' +
      '@media (prefers-reduced-motion:reduce){#' + CHIP_ID + '{transition:none;}}';
    document.head.appendChild(css);
  }

  async function chipRefresh() {
    if (typeof document === 'undefined') return;   // no DOM: tests, workers
    var el = document.getElementById(CHIP_ID);
    if (!el) return;
    if (killed()) { el.setAttribute('data-state', 'off'); el.lastChild.textContent = 'Backups paused'; return; }
    if (!setupDone()) { el.setAttribute('data-state', 'off'); el.lastChild.textContent = 'Backups off'; return; }
    var h = await healthCheck();
    var st = await status();
    if (!h.ok) {
      el.setAttribute('data-state', 'warn');
      el.lastChild.textContent = 'Backup problem';
      return;
    }
    el.setAttribute('data-state', 'ok');
    // "Backed up" is a claim about the LOCAL copy. Say when it has not also
    // left the device, because that is the difference between surviving a
    // Firebase failure and surviving a lost phone.
    el.lastChild.textContent = st.pushedOffDevice ? 'Backed up' : 'Backed up (local)';
  }

  function mountChip() {
    if (document.getElementById(CHIP_ID)) return;
    if (!document.body) return;
    chipStyles();
    var el = document.createElement('div');
    el.id = CHIP_ID;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', 'Backup status');
    el.setAttribute('data-state', 'ok');
    var dot = document.createElement('i');
    var label = document.createElement('span');
    label.textContent = 'Backup';
    el.appendChild(dot);
    el.appendChild(label);
    var open = function () { report().catch(function () {}); };
    el.addEventListener('click', open);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    document.body.appendChild(el);
    chipRefresh().catch(function () {});
    setInterval(function () { chipRefresh().catch(function () {}); }, 60000);
  }

  function startChip() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mountChip);
    } else {
      mountChip();
    }
  }

  window.A1Backup = {
    version: A1B.SCHEMA,
    constants: A1B,
    register: register,
    measure: measure,

    // Phase 1 — capture and local vault.
    unlock: unlock,                 // enter the passphrase once per device
    setup: promptSetup,             // the in-UI first-run dialog
    push: pushNow,                  // mirror to the worker now
    drill: drill,                   // read the PUBLIC repo copy back and check it
    chip: mountChip,                // the on-screen status chip
    fleet: fleet,                   // what every device has, from the worker
    device: deviceSlug,
    health: healthCheck,            // quiet: returns {ok, why}
    report: report,                 // human-readable, shows a dialog
    isSetUp: setupDone,
    profile: mainProfile,
    observe: observe,               // apps feed documents their listeners deliver
    capture: captureNow,            // force a snapshot now
    snapshots: listSnapshots,
    restore: restoreSnapshot,       // decrypt a snapshot back to plain objects
    verify: verify,                 // prove the passphrase and integrity still work
    status: status,
    kill: function (on) {
      lsSet(A1B.DISABLED_KEY, on === false ? '0' : '1');
      chipRefresh().catch(function () {});
      return on !== false;
    },

    _apps: apps,
    // Exposed so tests exercise the SHIPPED functions rather than a copy.
    // tests/backup-measure.test.js loads this file and calls these directly;
    // lifting them out by brace-matching is unreliable here because imageKeys
    // contains a regex literal full of brackets.
    _internals: {
      JOURNALS: JOURNALS, SINGLETONS: SINGLETONS,
      entryIds: entryIds, imageKeys: imageKeys,
      bytesOf: bytesOf, gzipBytes: gzipBytes,
      // Phase 1 pieces that can be tested without a browser.
      encryptStr: encryptStr, decryptEnv: decryptEnv, objId: objId,
      sha256Hex: sha256Hex, shrinkOk: shrinkOk,
      gatesOpen: gatesOpen, killed: killed
    }
  };
})();
