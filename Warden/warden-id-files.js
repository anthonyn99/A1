/* ─────────────────────────────────────────────────────────────────────────────
 * warden-id-files.js — Warden · ID Documents attachment pipeline
 *
 * The bytes half of the ID Docs feature: taking a photo/scan/PDF from the user
 * and getting it to (and back from) the cloud without a single readable byte
 * ever leaving the device — and without bloating the one Firestore doc the
 * whole warden lives in.
 *
 *   File ──▶ thumbnail ──▶ AES-256-GCM (session DEK) ──▶ IndexedDB cache
 *                                                   └──▶ warden-files Worker (KV)
 *
 * ── Why not put the file in Firestore? ──────────────────────────────────────
 * The warden is ONE document (`dashboards/warden_pw`) and Firestore caps a
 * document at 1 MiB. A single phone photo would eat the entire warden. So the
 * ciphertext goes to the same `warden-files` Worker the Keychain's document
 * attachments already use, and only a tiny descriptor rides in the warden doc:
 * key, IV, mime, size, and a ~3 KB thumbnail. That descriptor is itself inside
 * the item's AES-GCM envelope, so the cloud sees neither the file nor its name.
 *
 * ── Why is the file host allowed to hold this at all? ───────────────────────
 * Because what it holds is indistinguishable from noise. The bytes are
 * encrypted with the SAME DEK as every password and card, via
 * WardenSession.encryptBytes — the key never leaves the unlocked session, and
 * the upload carries no filename, no mime type and no item reference. A dump of
 * the KV namespace yields opaque blobs under random keys.
 *
 * ── Offline / retry ─────────────────────────────────────────────────────────
 * The ciphertext is written to IndexedDB BEFORE the upload is attempted, so:
 *   • a document added offline is fully usable on this device immediately;
 *   • the descriptor is marked `pending` and the upload is retried with backoff,
 *     on the next `online` event, and whenever the tab is shown;
 *   • viewing prefers the local cache, so a re-open costs no network at all.
 *
 * Depends on: warden-id.js (descriptor shape), an unlocked WardenSession
 * (encryptBytes/decryptBytes). No DOM beyond <canvas> for thumbnailing.
 * ──────────────────────────────────────────────────────────────────────────── */

(function (global) {
  'use strict';
  if (global.WardenIdFiles) return;

  var VID = global.WardenId;

  // Same Worker + KV namespace the Keychain's file attachments already use.
  // Sharing it is safe precisely because what we store is ciphertext under a
  // random key: the namespace learns nothing from having both.
  // This module loads in BOTH the page and the extension, which configure
  // themselves differently: the page has window.WARDEN_CONFIG, the extension
  // has self.WARDEN_CFG (warden-config.js). Read whichever is present rather
  // than forcing one context to fake the other's global.
  var _EC = (typeof self !== 'undefined' && self.WARDEN_CFG) || null;
  var _PC = (typeof window !== 'undefined' && window.WARDEN_CONFIG) || null;
  var BASE = _EC ? (_EC.FILES_BASE || '')
           : _PC ? String(_PC.filesWorker || '').replace(/\/+$/, '') + '/warden/f/'
           : '';
  var MAX_BYTES = 25 * 1024 * 1024;      // KV free-plan value limit
  var ACCEPT = 'image/*,application/pdf,.pdf';
  var THUMB_MAX = 160;                   // longest edge, px
  var THUMB_BUDGET = 7000;               // bytes of data URL — keeps the warden doc small
  var RETRY_DELAYS = [900, 2500, 6000];  // upload backoff

  // The upload carries no real filename — the host has no business knowing that
  // "passport-scan.jpg" exists. The true name lives encrypted in the item.
  var OPAQUE_NAME = 'blob';

  // ── IndexedDB ciphertext cache ────────────────────────────────────────────
  // Deliberately stores the CIPHERTEXT, never the plaintext: an attacker with
  // the device's storage but not the master password gets nothing, and the
  // cache survives a lock/unlock cycle without ever holding readable bytes.
  var DB_NAME = 'warden_id_files', DB_VER = 1, STORE = 'blobs';
  var _db = null;
  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (res, rej) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = function (e) { _db = e.target.result; res(_db); };
      req.onerror = function (e) { rej(e.target.error); };
    });
  }
  function idbPut(rec) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(rec);
        tx.oncomplete = function () { res(true); };
        tx.onerror = function (e) { rej(e.target.error); };
      });
    }).catch(function () { return false; });   // a full/blocked IDB must not break an upload
  }
  function idbGet(key) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readonly');
        var r = tx.objectStore(STORE).get(key);
        r.onsuccess = function (e) { res(e.target.result || null); };
        r.onerror = function (e) { rej(e.target.error); };
      });
    }).catch(function () { return null; });
  }
  function idbDel(key) {
    return openDB().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { res(false); };
      });
    }).catch(function () { return false; });
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  function newKey() {
    var r = '';
    var rnd = (global.crypto && global.crypto.getRandomValues)
      ? global.crypto.getRandomValues(new Uint8Array(8)) : null;
    if (rnd) for (var i = 0; i < rnd.length; i++) r += rnd[i].toString(36);
    else r = Math.random().toString(36).slice(2);
    // Must satisfy the Worker's key rule: /^[A-Za-z0-9._-]{1,200}$/
    return ('vid_' + Date.now().toString(36) + '_' + r).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 120);
  }
  function readBytes(file) {
    if (file.arrayBuffer) return file.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function (e) { res(new Uint8Array(e.target.result)); };
      fr.onerror = function () { rej(new Error('read-failed')); };
      fr.readAsArrayBuffer(file);
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function isImageFile(f) { return !!f && /^image\//i.test(f.type || ''); }
  function isPdfFile(f) { return !!f && (/pdf$/i.test(f.type || '') || /\.pdf$/i.test(f.name || '')); }
  function humanSize(n) {
    n = +n || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  // ── thumbnails ────────────────────────────────────────────────────────────
  // A ~3 KB JPEG that rides INSIDE the encrypted item body. This is what makes
  // the grid instant and offline-capable, and what lets the card show a blurred
  // preview without ever pulling the full-resolution scan down.
  //
  // The quality ladder exists because the thumbnail's cost is measured in the
  // warden document's 1 MiB budget, not in pixels: a busy photo at q0.6 can be
  // 4x a flat scan, so we step down until it fits the byte budget or give up
  // (an item with no thumb still works — it just shows a type glyph).
  function makeThumb(file) {
    if (!isImageFile(file) || typeof document === 'undefined') return Promise.resolve(null);
    return loadBitmap(file).then(function (img) {
      if (!img) return null;
      var w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
      if (!w || !h) return null;
      var scale = Math.min(1, THUMB_MAX / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      var c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      var ctx = c.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, cw, ch);
      if (img.close) try { img.close(); } catch (_) {}
      var out = null;
      var ladder = [0.62, 0.48, 0.36, 0.26];
      for (var i = 0; i < ladder.length; i++) {
        var url = c.toDataURL('image/jpeg', ladder[i]);
        if (url.length <= THUMB_BUDGET) { out = url; break; }
        out = url;
      }
      if (out && out.length > (VID ? VID.MAX_INLINE_THUMB : 9000)) out = null;
      return out ? { thumb: out, w: w, h: h } : { thumb: null, w: w, h: h };
    }).catch(function () { return null; });
  }
  function loadBitmap(file) {
    if (global.createImageBitmap) {
      return global.createImageBitmap(file).catch(function () { return loadViaImg(file); });
    }
    return loadViaImg(file);
  }
  function loadViaImg(file) {
    return new Promise(function (res) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); res(null); };
      img.src = url;
    });
  }

  // ── transport ─────────────────────────────────────────────────────────────
  // XHR rather than fetch() purely for `upload.onprogress` — fetch still can't
  // report request-body progress, and a 12 MB scan with no progress bar reads
  // as a hang.
  function put(key, bytes, onProgress) {
    return new Promise(function (res, rej) {
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', BASE + encodeURIComponent(key), true);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-File-Name', OPAQUE_NAME);
      if (onProgress && xhr.upload) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable && e.total) onProgress(Math.min(0.99, e.loaded / e.total));
        };
      }
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) res(true);
        else { var err = new Error('upload-' + xhr.status); err.status = xhr.status; rej(err); }
      };
      xhr.onerror = function () { rej(new Error('network')); };
      xhr.ontimeout = function () { rej(new Error('timeout')); };
      xhr.timeout = 120000;
      // `bytes` is a Uint8Array view; XHR wants the underlying buffer.
      xhr.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    });
  }
  function get(key) {
    return fetch(BASE + encodeURIComponent(key), { cache: 'force-cache' }).then(function (r) {
      if (!r.ok) throw new Error('download-' + r.status);
      return r.arrayBuffer();
    }).then(function (b) { return new Uint8Array(b); });
  }
  function del(key) {
    return fetch(BASE + encodeURIComponent(key), { method: 'DELETE' })
      .then(function () { return true; }).catch(function () { return false; });
  }
  // A 4xx means the server understood and refused — retrying is pointless and
  // just burns the KV write budget. 5xx / network faults are worth another go.
  function retryable(e) { return !(e && e.status >= 400 && e.status < 500); }

  async function putWithRetry(key, bytes, onProgress) {
    var last = null;
    for (var attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try { await put(key, bytes, onProgress); return true; }
      catch (e) {
        last = e;
        if (!retryable(e) || attempt === RETRY_DELAYS.length) break;
        await sleep(RETRY_DELAYS[attempt]);
      }
    }
    throw last || new Error('upload-failed');
  }

  // ── public: add a file ────────────────────────────────────────────────────
  // Returns the descriptor to store on the item. It ALWAYS returns — a failed
  // upload comes back marked `pending:true` with the ciphertext safe in IDB, so
  // the document is saved and usable and the bytes catch up later. Losing an ID
  // scan because the network blipped would be the worst possible outcome here.
  //
  // opts: { onProgress(0..1), onStage('encrypting'|'uploading'|'done'|'queued') }
  async function attach(file, session, opts) {
    opts = opts || {};
    if (!file) throw new Error('no-file');
    if (file.size > MAX_BYTES) { var e = new Error('too-large'); e.tooLarge = true; e.max = MAX_BYTES; throw e; }
    if (!session || !session.isUnlocked()) throw new Error('locked');

    var stage = opts.onStage || function () {};
    var prog = opts.onProgress || function () {};

    stage('encrypting'); prog(0.02);
    var thumbInfo = await makeThumb(file);
    var bytes = await readBytes(file);
    var sealed = await session.encryptBytes(bytes);
    bytes = null;                                   // drop the plaintext copy promptly

    var key = newKey();
    var att = {
      key: key,
      name: String(file.name || 'document'),
      mime: String(file.type || (isPdfFile(file) ? 'application/pdf' : 'application/octet-stream')),
      size: file.size,
      iv: sealed.iv,
      addedAt: Date.now(),
    };
    if (thumbInfo) {
      if (thumbInfo.thumb) att.thumb = thumbInfo.thumb;
      if (thumbInfo.w) att.w = thumbInfo.w;
      if (thumbInfo.h) att.h = thumbInfo.h;
    }

    // Cache first: from here on the file is safe on this device no matter what
    // the network does.
    await idbPut({ key: key, iv: sealed.iv, ct: sealed.bytes.buffer, mime: att.mime, size: file.size, uploaded: false });

    stage('uploading'); prog(0.05);
    try {
      await putWithRetry(key, sealed.bytes, function (p) { prog(0.05 + p * 0.95); });
      await idbPut({ key: key, iv: sealed.iv, ct: sealed.bytes.buffer, mime: att.mime, size: file.size, uploaded: true });
      prog(1); stage('done');
    } catch (err) {
      att.pending = true;
      prog(1); stage('queued');
    }
    return att;
  }

  // ── public: read a file back ──────────────────────────────────────────────
  // Cache first (instant, offline, no KV read), network second. The plaintext
  // Blob exists only for as long as the session is unlocked — revokeAll() drops
  // every one of these on lock.
  var _blobs = {};   // key -> decrypted Blob (memory only, cleared on lock)
  var _urls = {};    // key -> object URL for the same Blob

  async function blobFor(att, session) {
    if (!att || !att.key) throw new Error('no-attachment');
    if (!session || !session.isUnlocked()) throw new Error('locked');
    if (_blobs[att.key]) return _blobs[att.key];
    var rec = await idbGet(att.key);
    var ct = rec && rec.ct ? new Uint8Array(rec.ct) : null;
    if (!ct) {
      ct = await get(att.key);
      // Re-seed the cache so the next open is local — and so a document pulled
      // down on a new device keeps working offline afterwards.
      idbPut({ key: att.key, iv: att.iv, ct: ct.buffer, mime: att.mime, size: att.size, uploaded: true });
    }
    var plain = await session.decryptBytes(att.iv || (rec && rec.iv), ct);
    var blob = new Blob([plain], { type: att.mime || 'application/octet-stream' });
    _blobs[att.key] = blob;
    return blob;
  }

  // The decrypted Blob if we already hold it, SYNCHRONOUSLY. This exists for one
  // reason: navigator.share() must be called inside the user gesture that
  // triggered it, and iOS drops transient activation across an await. So the
  // save path checks here first and only falls back to the async route.
  function cachedBlob(att) { return (att && _blobs[att.key]) || null; }
  // Warm the cache ahead of a likely save — the viewer calls this when it draws
  // a page, so the Download button is already synchronous by the time it's hit.
  function prefetch(att, session) {
    if (!att || !att.key || _blobs[att.key]) return Promise.resolve(null);
    return blobFor(att, session).catch(function () { return null; });
  }
  // Android's MediaStore decides whether a saved file shows up in Gallery/Photos
  // by looking at the FILE EXTENSION, not the mime type. A scan saved as
  // "scan" instead of "scan.jpg" lands in Downloads and never appears in the
  // gallery — so every name that leaves here gets a correct extension.
  var EXT_FOR_MIME = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif', 'image/avif': 'avif',
    'image/bmp': 'bmp', 'image/tiff': 'tiff', 'application/pdf': 'pdf',
  };
  var KNOWN_EXTS = { jpg: 1, jpeg: 1, png: 1, webp: 1, heic: 1, heif: 1, gif: 1, avif: 1, bmp: 1, tif: 1, tiff: 1, pdf: 1 };
  // `override` is a caller-supplied base name (no extension). Scans arrive named
  // after whatever the camera called them - "34228.jpg" - so every document
  // saved to the same folder collided with the last one and the browser had to
  // stop and ask "file name already exists" on EVERY save. Naming the file after
  // the document it belongs to makes saves collision-free and, just as
  // important, makes the file findable in the gallery afterwards.
  function safeFileName(att, override) {
    if (override) att = { name: String(override), mime: (att && att.mime) || '' };
    return baseSafeName(att);
  }
  function baseSafeName(att) {
    // Strip only what a filesystem actually rejects (path separators, reserved
    // punctuation, control characters). Spaces and hyphens are legal, and
    // mangling them makes a saved scan unrecognisable in the gallery.
    var name = String((att && att.name) || 'document')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']', 'g'), '')
      .trim() || 'document';
    var want = EXT_FOR_MIME[String((att && att.mime) || '').toLowerCase()];
    if (!want) return name;
    var has = /\.([A-Za-z0-9]{1,5})$/.exec(name);
    // Any recognised image/PDF extension already does the job — never turn
    // "scan.jpeg" into "scan.jpeg.jpg".
    if (has && KNOWN_EXTS[has[1].toLowerCase()]) return name;
    return name + '.' + want;
  }
  function fileFrom(att, blob, name) {
    var type = (att && att.mime) || blob.type || 'application/octet-stream';
    try { return new File([blob], safeFileName(att, name), { type: type }); }
    catch (e) { return blob; }   // very old browsers: File ctor unavailable
  }

  async function objectUrl(att, session) {
    if (!att || !att.key) return '';
    // Same reason as saveFile: a pooled URL must not outlive the unlock.
    if (!session || !session.isUnlocked()) throw new Error('locked');
    if (_urls[att.key]) return _urls[att.key];
    var blob = await blobFor(att, session);
    var url = URL.createObjectURL(blob);
    _urls[att.key] = url;
    return url;
  }
  // ── display-sized copies ──────────────────────────────────────────────────
  // A phone camera scan of a birth certificate is routinely 4000px+ on its long
  // edge. Handing that straight to an <img> costs ~48 MB of decoded bitmap and,
  // once the compositor promotes it, a texture it cannot keep resident — so it
  // is discarded and re-rasterised repeatedly, which shows up as the image and
  // everything around it glitching while you scroll. Smaller documents never hit
  // the limit, which is why only the biggest one misbehaved.
  //
  // So the VIEWER gets a right-sized copy. The original is untouched and is
  // still what "Open Full Size", Download and Share hand over — this only
  // affects what is painted on screen.
  var DISPLAY_CAP = 2400;          // longest edge, px
  var _display = {};               // key -> object URL of the resized copy

  async function makeDisplayCopy(blob, cap) {
    if (typeof document === 'undefined' || !global.createImageBitmap) return null;
    var bmp = null;
    try {
      bmp = await global.createImageBitmap(blob);
      var w = bmp.width, h = bmp.height, longest = Math.max(w, h);
      if (!longest || longest <= cap) return null;      // already a sensible size
      var scale = cap / longest;
      var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      var c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      var ctx = c.getContext('2d');
      if (!ctx) return null;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, cw, ch);
      var out = await new Promise(function (r) { c.toBlob(r, 'image/jpeg', 0.9); });
      // Free the canvas backing store promptly on mobile.
      c.width = c.height = 0;
      return out ? URL.createObjectURL(out) : null;
    } catch (e) { return null; }
    finally { if (bmp && bmp.close) { try { bmp.close(); } catch (_) {} } }
  }

  // The URL the viewer should paint. Falls back to the original whenever a
  // resized copy isn't possible or isn't needed.
  async function displayUrl(att, session) {
    if (!att || !att.key) return '';
    if (_display[att.key]) return _display[att.key];
    var full = await objectUrl(att, session);
    if (!/^image\//i.test(att.mime || '')) return full;
    var blob = cachedBlob(att) || await blobFor(att, session);
    var small = await makeDisplayCopy(blob, DISPLAY_CAP);
    if (!small) return full;
    _display[att.key] = small;
    return small;
  }

  function revoke(key) {
    if (_urls[key]) { try { URL.revokeObjectURL(_urls[key]); } catch (_) {} delete _urls[key]; }
    if (_display[key]) { try { URL.revokeObjectURL(_display[key]); } catch (_) {} delete _display[key]; }
    delete _blobs[key];
  }
  // Called on lock: every decrypted byte the page was holding goes away with it.
  function revokeAll() {
    Object.keys(_urls).forEach(function (k) { try { URL.revokeObjectURL(_urls[k]); } catch (_) {} });
    Object.keys(_display).forEach(function (k) { try { URL.revokeObjectURL(_display[k]); } catch (_) {} });
    _urls = {};
    _display = {};
    _blobs = {};
  }

  // ── public: SAVE a file to the device ─────────────────────────────────────
  // "Download" means three different things on the three platforms this has to
  // work on, so this is a ladder rather than one call:
  //
  //   1. navigator.share({files})  — iOS and Android. This is the ONLY reliable
  //      way to get a file out of Safari, and the only one at all inside an
  //      installed PWA (standalone iOS has no downloads UI and ignores the
  //      `download` attribute). It opens the native sheet: Save Image → Photos,
  //      or Save to Files. Android gets the same sheet plus Drive/Keep/etc.
  //   2. <a download>              — desktop Chrome/Edge/Firefox/Safari and
  //      Android Chrome. Straight to the Downloads folder, no sheet.
  //   3. open in a new tab         — last resort, so the file is at least on
  //      screen and can be long-pressed / saved manually.
  //
  // Returns { ok, how, cancelled } — `cancelled` is a user dismissing the share
  // sheet, which is NOT an error and must not surface as one.
  //
  // ── the transient-activation trap ──
  // iOS only allows share() inside the gesture that triggered it, and an `await`
  // in between throws NotAllowedError. Decrypting is inevitably async the first
  // time, so: if the Blob is already cached we go straight to share (fully
  // synchronous path); if it isn't, we decrypt, try anyway, and on
  // NotAllowedError report `needsRetap` so the caller can say "tap again" — the
  // second tap hits the warm cache and succeeds.
  function canShareFile(file) {
    try {
      return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));
    } catch (e) { return false; }
  }
  // Should this device go through the native share sheet rather than a plain
  // download?
  //
  // Support is NOT the right question. Desktop Windows/Edge and macOS/Safari
  // both implement navigator.share, but on a desktop "Download" means a file in
  // the Downloads folder — routing that through an OS share sheet would be a
  // worse answer to the same request. The share sheet is the right (and on iOS
  // the only) answer on a phone or tablet, so that is exactly where we use it.
  function isMobileLike() {
    if (isIOS()) return true;
    var ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return true;
    try {
      // A touch-primary device that isn't a desktop — covers Android tablets
      // and Windows tablets in tablet mode.
      return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0);
    } catch (e) { return false; }
  }
  // Used to LABEL the button ("Save to device" vs "Download"); the per-file
  // decision is still made inside saveFile().
  function prefersShare() {
    if (!isMobileLike()) return false;
    try { return canShareFile(new File([new Uint8Array(1)], 'p.png', { type: 'image/png' })); }
    catch (e) { return false; }
  }
  function anchorDownload(blob, name) {
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name || 'document';
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (_) {} }, 20000);
      return true;
    } catch (e) { return false; }
  }
  // `download` is a no-op in an installed iOS PWA, so we must not claim success
  // by taking that branch there.
  function anchorDownloadWorks() {
    try {
      if (typeof document === 'undefined') return false;
      var standalone = (navigator.standalone === true) ||
        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
      if (isIOS() && standalone) return false;
      return 'download' in document.createElement('a');
    } catch (e) { return false; }
  }
  function isIOS() {
    var ua = (navigator.userAgent || '');
    // iPadOS 13+ reports as a Mac; the touch-point check is what separates them.
    return /iPad|iPhone|iPod/.test(ua) ||
      (/Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1);
  }

  // Which route actually puts the file in the user's photo gallery?
  //
  //   iOS      → share. The sheet's "Save Image" writes straight to Photos, and
  //              inside an installed PWA it is the only route that works at all.
  //   Android  → download. Samsung Gallery and Google Photos index the Downloads
  //              folder, so a downloaded .jpg turns up in the gallery within
  //              seconds. The share sheet does NOT help here: Android galleries
  //              are not ACTION_SEND receivers, which is exactly why sharing
  //              offered no "save to gallery" option and listed messaging and
  //              cloud apps instead.
  //   Desktop  → download.
  //
  // So this is a per-platform decision, not "share wherever share exists".
  function saveStrategy() { return isIOS() ? 'share' : 'download'; }

  function canShareFiles(files) {
    try { return !!(navigator.canShare && navigator.share && navigator.canShare({ files: files })); }
    catch (e) { return false; }
  }
  // One share call for one OR many files. Web Share takes an array, which is
  // what makes "Save all" possible in a single gesture.
  //
  // The return value distinguishes NEVER ATTEMPTED from ATTEMPTED AND NOT
  // COMPLETED, and that distinction is load-bearing: if a sheet was actually put
  // on screen and the user dismissed it, falling back to a download would save
  // the file they just declined to save. Only a share that was never viable may
  // fall through.
  //
  //   { ok:true }                    shared
  //   { attempted:false }            no Web Share for files here — fall through
  //   { attempted:true, cancelled }  user dismissed the sheet — STOP
  //   { attempted:true, notAllowed } no transient activation, or blocked
  //   { attempted:true, failed }     genuine error — STOP, let the user retry
  async function shareBlobs(atts, blobs, title, names) {
    if (typeof File === 'undefined') return { ok: false, attempted: false, how: 'share' };
    var files = atts.map(function (a, i) { return fileFrom(a, blobs[i], names && names[i]); });
    if (!canShareFiles(files)) return { ok: false, attempted: false, how: 'share' };
    try {
      await navigator.share({ files: files, title: title || files[0].name });
      return { ok: true, how: 'share', count: files.length };
    } catch (e) {
      var n = (e && e.name) || '';
      // AbortError is the spec'd "user dismissed". Chrome on Android and Samsung
      // Internet have both been seen to use NotAllowedError for the same thing,
      // so neither may be treated as "try a download instead".
      if (n === 'AbortError') return { ok: false, attempted: true, cancelled: true, how: 'share' };
      if (n === 'NotAllowedError') return { ok: false, attempted: true, notAllowed: true, how: 'share' };
      // NotSupportedError/TypeError mean the sheet never opened — safe to fall through.
      if (n === 'NotSupportedError' || n === 'TypeError') return { ok: false, attempted: false, how: 'share' };
      return { ok: false, attempted: true, failed: true, how: 'share' };
    }
  }

  // Save ONE file. `opts.prefer` ('share' | 'download') overrides the platform
  // default, which is what the viewer's separate Share button uses.
  async function saveFile(att, session, opts) {
    opts = opts || {};
    // Checked here and not only in blobFor: a warm cache would otherwise let a
    // LOCKED warden still hand over plaintext. The shell clears the cache on
    // lock, but this must not depend on the caller having remembered to.
    if (!session || !session.isUnlocked()) throw new Error('locked');
    var blob = cachedBlob(att);
    var warm = !!blob;
    if (!blob) blob = await blobFor(att, session);
    var name = safeFileName(att, opts.name);
    var want = opts.prefer || saveStrategy();

    if (want === 'download' && anchorDownloadWorks() && anchorDownload(blob, name)) {
      return { ok: true, how: 'download' };
    }
    var r = await shareBlobs([att], [blob], name, [opts.name]);
    if (r.ok) return r;
    if (r.attempted) {
      // The sheet was shown. Whatever happened next, do NOT quietly download the
      // file behind the user's back.
      if (r.cancelled) return { ok: false, cancelled: true, how: 'share' };
      // Warm means share() ran inside the gesture, so this cannot be a lost
      // activation — treat it as a dismissal rather than retrying forever.
      if (r.notAllowed) return warm ? { ok: false, cancelled: true, how: 'share' }
                                    : { ok: false, needsRetap: true, how: 'share' };
      return { ok: false, how: 'share' };
    }
    // Share was never viable here — a download is the honest fallback.
    if (anchorDownloadWorks() && anchorDownload(blob, name)) return { ok: true, how: 'download' };
    // Last resort — put it on screen so it can still be saved by hand.
    try {
      var url = await objectUrl(att, session);
      var w = window.open(url, '_blank', 'noopener,noreferrer');
      if (w) return { ok: true, how: 'opened' };
    } catch (e) {}
    return { ok: false, how: 'none' };
  }

  // ── saving SEVERAL files at once ──────────────────────────────────────────
  // Looping saveFile() is what made "Download all" stop after one file on a
  // phone: the first navigator.share() consumes the page's transient
  // activation, so every later call throws NotAllowedError — and Android Chrome
  // likewise blocks a burst of programmatic downloads as a download bomb. Both
  // platforms need ONE gesture to move all the files:
  //
  //   share    → Web Share takes an ARRAY. One sheet, "Save 3 Images", done.
  //   download → sequential anchors with a gap, which desktop allows.
  //
  // Returns { ok, saved, total, how, cancelled, needsRetap }.
  async function saveFiles(atts, session, opts) {
    opts = opts || {};
    atts = (atts || []).filter(Boolean);
    if (!atts.length) return { ok: false, saved: 0, total: 0, how: 'none' };
    if (!session || !session.isUnlocked()) throw new Error('locked');
    if (atts.length === 1) {
      var one = await saveFile(atts[0], session, opts);
      return {
        ok: !!one.ok, saved: one.ok ? 1 : 0, total: 1,
        how: one.how, cancelled: one.cancelled, needsRetap: one.needsRetap,
      };
    }
    // Decrypt everything up front so the share itself is a single step.
    var blobs = [];
    for (var i = 0; i < atts.length; i++) blobs.push(await blobFor(atts[i], session));

    var want = opts.prefer || saveStrategy();
    if (want === 'share') {
      var r = await shareBlobs(atts, blobs, opts.title, opts.names);
      if (r.ok) return { ok: true, saved: atts.length, total: atts.length, how: 'share' };
      // Same rule as saveFile: once the sheet has been shown, dismissing it must
      // not be answered by downloading every file anyway.
      if (r.attempted) {
        if (r.notAllowed) return { ok: false, saved: 0, total: atts.length, how: 'share', needsRetap: true };
        return { ok: false, saved: 0, total: atts.length, how: 'share', cancelled: !!r.cancelled };
      }
    }
    // Sequential downloads. The gap matters: fired back to back, Chrome keeps
    // the first and silently drops the rest.
    var saved = 0;
    if (anchorDownloadWorks()) {
      for (var j = 0; j < atts.length; j++) {
        if (anchorDownload(blobs[j], safeFileName(atts[j], opts.names && opts.names[j]))) saved++;
        if (j < atts.length - 1) await sleep(350);
      }
    }
    if (saved) return { ok: true, saved: saved, total: atts.length, how: 'download' };
    // Nothing downloaded (installed iOS PWA) — try the multi-file sheet anyway.
    var s2 = await shareBlobs(atts, blobs, opts.title, opts.names);
    if (s2.ok) return { ok: true, saved: atts.length, total: atts.length, how: 'share' };
    return { ok: false, saved: 0, total: atts.length, how: 'none', cancelled: !!s2.cancelled };
  }

  // ── public: delete ────────────────────────────────────────────────────────
  // Local cache first (guaranteed), then the host (best effort — an orphaned
  // ciphertext blob is unreadable anyway, so a failed DELETE is not a leak).
  async function remove(att) {
    if (!att || !att.key) return;
    revoke(att.key);
    await idbDel(att.key);
    await del(att.key);
  }
  async function removeMany(atts) {
    for (var i = 0; i < (atts || []).length; i++) { try { await remove(atts[i]); } catch (_) {} }
  }

  // ── public: flush queued uploads ──────────────────────────────────────────
  // Walks every ID document, re-uploads the ciphertext of anything still marked
  // `pending`, and hands the caller the items whose descriptors changed so they
  // can be saved in ONE batch (one repaint, one debounced Firestore write).
  async function retryPending(items, session, opts) {
    opts = opts || {};
    if (!session || !session.isUnlocked()) return { uploaded: 0, failed: 0, items: [] };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return { uploaded: 0, failed: 0, items: [] };
    var uploaded = 0, failed = 0, changed = [];
    for (var i = 0; i < (items || []).length; i++) {
      var it = items[i];
      var entries = VID.allAttachments(it).filter(function (e) { return e.att.pending; });
      if (!entries.length) continue;
      var dirty = false;
      for (var j = 0; j < entries.length; j++) {
        var att = entries[j].att;
        var rec = await idbGet(att.key);
        if (!rec || !rec.ct) { failed++; continue; }   // ciphertext gone — nothing to send
        try {
          await putWithRetry(att.key, new Uint8Array(rec.ct), null);
          await idbPut({ key: att.key, iv: rec.iv, ct: rec.ct, mime: rec.mime, size: rec.size, uploaded: true });
          delete att.pending;
          uploaded++; dirty = true;
        } catch (e) { failed++; }
      }
      if (dirty) changed.push(it);
    }
    if (changed.length && opts.onChanged) { try { await opts.onChanged(changed); } catch (_) {} }
    return { uploaded: uploaded, failed: failed, items: changed };
  }

  global.WardenIdFiles = {
    ACCEPT: ACCEPT, MAX_BYTES: MAX_BYTES, THUMB_MAX: THUMB_MAX,
    attach: attach, blobFor: blobFor, objectUrl: objectUrl, revoke: revoke, revokeAll: revokeAll,
    remove: remove, removeMany: removeMany, retryPending: retryPending,
    makeThumb: makeThumb, humanSize: humanSize, isImageFile: isImageFile, isPdfFile: isPdfFile,
    newKey: newKey,
    // saving to the device
    saveFile: saveFile, saveFiles: saveFiles, displayUrl: displayUrl, DISPLAY_CAP: DISPLAY_CAP, safeFileName: safeFileName, saveStrategy: saveStrategy, cachedBlob: cachedBlob, prefetch: prefetch, fileFrom: fileFrom,
    canShareFile: canShareFile, prefersShare: prefersShare, isMobileLike: isMobileLike,
    anchorDownloadWorks: anchorDownloadWorks, isIOS: isIOS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
