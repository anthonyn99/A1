/* ─────────────────────────────────────────────────────────────────────────────
 * vault-id-files.js — Vault · ID Documents attachment pipeline
 *
 * The bytes half of the ID Docs feature: taking a photo/scan/PDF from the user
 * and getting it to (and back from) the cloud without a single readable byte
 * ever leaving the device — and without bloating the one Firestore doc the
 * whole vault lives in.
 *
 *   File ──▶ thumbnail ──▶ AES-256-GCM (session DEK) ──▶ IndexedDB cache
 *                                                   └──▶ vault-files Worker (KV)
 *
 * ── Why not put the file in Firestore? ──────────────────────────────────────
 * The vault is ONE document (`dashboards/vault_pw`) and Firestore caps a
 * document at 1 MiB. A single phone photo would eat the entire vault. So the
 * ciphertext goes to the same `vault-files` Worker the Keychain's document
 * attachments already use, and only a tiny descriptor rides in the vault doc:
 * key, IV, mime, size, and a ~3 KB thumbnail. That descriptor is itself inside
 * the item's AES-GCM envelope, so the cloud sees neither the file nor its name.
 *
 * ── Why is the file host allowed to hold this at all? ───────────────────────
 * Because what it holds is indistinguishable from noise. The bytes are
 * encrypted with the SAME DEK as every password and card, via
 * VaultSession.encryptBytes — the key never leaves the unlocked session, and
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
 * Depends on: vault-id.js (descriptor shape), an unlocked VaultSession
 * (encryptBytes/decryptBytes). No DOM beyond <canvas> for thumbnailing.
 * ──────────────────────────────────────────────────────────────────────────── */

(function (global) {
  'use strict';
  if (global.VaultIdFiles) return;

  var VID = global.VaultId;

  // Same Worker + KV namespace the Keychain's file attachments already use.
  // Sharing it is safe precisely because what we store is ciphertext under a
  // random key: the namespace learns nothing from having both.
  var BASE = 'https://vault-files.av1.workers.dev/keychain/f/';
  var MAX_BYTES = 25 * 1024 * 1024;      // KV free-plan value limit
  var ACCEPT = 'image/*,application/pdf,.pdf';
  var THUMB_MAX = 160;                   // longest edge, px
  var THUMB_BUDGET = 7000;               // bytes of data URL — keeps the vault doc small
  var RETRY_DELAYS = [900, 2500, 6000];  // upload backoff

  // The upload carries no real filename — the host has no business knowing that
  // "passport-scan.jpg" exists. The true name lives encrypted in the item.
  var OPAQUE_NAME = 'blob';

  // ── IndexedDB ciphertext cache ────────────────────────────────────────────
  // Deliberately stores the CIPHERTEXT, never the plaintext: an attacker with
  // the device's storage but not the master password gets nothing, and the
  // cache survives a lock/unlock cycle without ever holding readable bytes.
  var DB_NAME = 'vault_id_files', DB_VER = 1, STORE = 'blobs';
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
  // vault document's 1 MiB budget, not in pixels: a busy photo at q0.6 can be
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
  // Blob exists only for as long as the viewer holds its object URL.
  async function blobFor(att, session) {
    if (!att || !att.key) throw new Error('no-attachment');
    if (!session || !session.isUnlocked()) throw new Error('locked');
    var rec = await idbGet(att.key);
    var ct = rec && rec.ct ? new Uint8Array(rec.ct) : null;
    if (!ct) {
      ct = await get(att.key);
      // Re-seed the cache so the next open is local — and so a document pulled
      // down on a new device keeps working offline afterwards.
      idbPut({ key: att.key, iv: att.iv, ct: ct.buffer, mime: att.mime, size: att.size, uploaded: true });
    }
    var plain = await session.decryptBytes(att.iv || (rec && rec.iv), ct);
    return new Blob([plain], { type: att.mime || 'application/octet-stream' });
  }

  // Object URLs are pooled per attachment key so re-opening a document doesn't
  // decrypt it again, and revoked wholesale on lock (see revokeAll).
  var _urls = {};
  async function objectUrl(att, session) {
    if (!att || !att.key) return '';
    if (_urls[att.key]) return _urls[att.key];
    var blob = await blobFor(att, session);
    var url = URL.createObjectURL(blob);
    _urls[att.key] = url;
    return url;
  }
  function revoke(key) {
    if (_urls[key]) { try { URL.revokeObjectURL(_urls[key]); } catch (_) {} delete _urls[key]; }
  }
  // Called on lock: every decrypted byte the page was holding goes away with it.
  function revokeAll() {
    Object.keys(_urls).forEach(function (k) { try { URL.revokeObjectURL(_urls[k]); } catch (_) {} });
    _urls = {};
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

  global.VaultIdFiles = {
    ACCEPT: ACCEPT, MAX_BYTES: MAX_BYTES, THUMB_MAX: THUMB_MAX,
    attach: attach, blobFor: blobFor, objectUrl: objectUrl, revoke: revoke, revokeAll: revokeAll,
    remove: remove, removeMany: removeMany, retryPending: retryPending,
    makeThumb: makeThumb, humanSize: humanSize, isImageFile: isImageFile, isPdfFile: isPdfFile,
    newKey: newKey,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
