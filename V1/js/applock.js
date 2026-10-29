/* ============================================================================
 * StudyOS — App Lock, on Guardian
 * ============================================================================
 * Gates the ENTIRE application behind a password before any data is shown.
 *
 * Since 2026-10-29 the lock itself is A1's Guardian (Guardian/guardian.js,
 * docs/Guardian/README.md): the same card, eye, Caps Lock warning, biometrics,
 * lock menu, hint and emailed reset code as every other A1 program, in Veda's
 * theme. What stays StudyOS's own is the BACKEND, unchanged (Tony: "preserve
 * how it works backend for her"):
 *
 *   • the password hash lives on StudyOS's own worker (studyos-api, on Veda's
 *     Cloudflare account): /auth/journal/{verify,set-lock,remove-lock,hint}
 *     and /auth/reset/{request,confirm}, record jlock:studyos_applock:studyos;
 *   • WHICH lock is on, at what version, lives in StudyOS's Firestore doc
 *     (firebase-sync _fbSaveAppLocks / _fbLoadAppLocks, a live snapshot), so a
 *     password change on one device locks every other one;
 *   • hints and reset codes are emailed through StudyOS's Formspree form
 *     (config.js formspree), as before.
 *
 * Guardian talks to all three through `backend` below. Its version model is
 * the Firestore stamp `v` (a password change stamps a new Date.now()).
 *
 * Moving over asked nobody anything (Guardian's legacy adoption, once per
 * device): a device that had unlocked StudyOS at the current version opens,
 * and the Face ID / Windows Hello credential it registered is kept.
 *
 * BOOT CONTRACT (unchanged): publishes window.SOS_GATE, a promise js/studyos.js
 * waits on before it renders anything, resolved when access is granted, and
 * drives body[data-sos-gate] = pending | locked | open, which hides the app in
 * CSS and which file ingest waits on.
 *
 * SECURITY MODEL (unchanged): this gates the UI, not the database. The
 * password never reaches the browser's storage or Firestore.
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';

  var CFG   = window.STUDYOS_CONFIG || {};
  var LOCK  = CFG.appLock || {};
  var API   = (CFG.cloudflare && CFG.cloudflare.apiWorker) || {};
  var FORM  = CFG.formspree || {};

  var APP_ID    = LOCK.id || 'studyos';
  var LABEL     = LOCK.label || 'StudyOS';
  var WORKER    = String(API.baseUrl || '').replace(/\/+$/, '');
  var NAMESPACE = API.lockNamespace || 'studyos_applock';
  var GID       = 'veda_studyos';      // the Guardian lock id (owner: Veda)

  var WORKER_OK = !!(window.STUDYOS_CONFIG_READY && window.STUDYOS_CONFIG_READY('cloudflare')) && !!WORKER;
  var FORM_OK   = !!(window.STUDYOS_CONFIG_READY && window.STUDYOS_CONFIG_READY('formspree'));
  var LOCK_ON   = LOCK.enabled !== false;
  var G         = window.Guardian;

  /* ── Gate promise ─────────────────────────────────────────────────────────
   * Resolved exactly once, when the app is allowed to render. */
  var _openGate;
  window.SOS_GATE = new Promise(function (res) { _openGate = res; });
  function setGate(state) { document.body.setAttribute('data-sos-gate', state); }
  function openApp() { setGate('open'); try { _openGate(); } catch (e) {} }

  /* Lock disabled, unconfigured, or Guardian unreachable → straight through. A
   * half-migrated project must never lock the owner out of her own data. */
  if (!LOCK_ON || !WORKER_OK || !G) {
    if (LOCK_ON && !WORKER_OK) console.info('[StudyOS] App Lock is on but the studyos-api Worker is not configured — running unlocked.');
    if (LOCK_ON && WORKER_OK && !G) console.warn('[StudyOS] Guardian did not load — running unlocked.');
    var lb = function () { var b = document.getElementById('sos-lock-btn'); if (b) b.style.display = 'none'; };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { lb(); openApp(); });
    else { lb(); openApp(); }
    return;
  }

  /* ── Lock state (Firestore) ───────────────────────────────────────────────
   * _locks maps appId → { locked, v }. localStorage caches it so the first
   * paint knows there IS a lock before Firebase answers. */
  var _locks = {};
  try { _locks = JSON.parse(localStorage.getItem('sos_al_locks') || '{}') || {}; } catch (e) { _locks = {}; }
  var _cloudSeen = false;
  var _pendingPush = false;

  function cacheLocks() { try { localStorage.setItem('sos_al_locks', JSON.stringify(_locks)); } catch (e) {} }
  function saveLocks() {
    cacheLocks();
    if (window._fbSaveAppLocks) { window._fbSaveAppLocks(_locks); _pendingPush = false; }
    else _pendingPush = true;   // Firebase not up yet: push once it is
  }
  function entry() { return _locks[APP_ID] || null; }
  function stampLock() { _locks[APP_ID] = { locked: true, v: Date.now() }; saveLocks(); }
  function dropLock() { delete _locks[APP_ID]; saveLocks(); }

  /* The authoritative state, once: the Firestore doc. Later changes arrive by
   * the live snapshot (_alApplyRemoteLocks) and by this device's own writes. */
  function whenFirebase() {
    return new Promise(function (res) {
      if (window._fbReady) { res(true); return; }
      var done = false;
      var finish = function (ok) { if (!done) { done = true; res(ok); } };
      window.addEventListener('fb-ready', function () { finish(true); }, { once: true });
      window.addEventListener('fb-unconfigured', function () { finish(false); }, { once: true });
      setTimeout(function () { finish(!!window._fbReady); }, 12000);
    });
  }
  function loadCloud() {
    if (_cloudSeen) return Promise.resolve(true);
    return whenFirebase().then(function (up) {
      if (!up || !window._fbLoadAppLocks) return false;
      if (_pendingPush && window._fbSaveAppLocks) { window._fbSaveAppLocks(_locks); _pendingPush = false; }
      return window._fbLoadAppLocks().then(function (remote) {
        if (remote) { _locks = remote; cacheLocks(); }
        _cloudSeen = true;
        return true;
      });
    });
  }

  /* ── Worker + mail ────────────────────────────────────────────────────── */
  function post(path, body) {
    return fetch(WORKER + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ journal: NAMESPACE, entryId: APP_ID }, body || {})),
    }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function mail(subject, message) {
    if (!FORM_OK || !FORM.endpoint) return Promise.resolve(false);
    return fetch(FORM.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: FORM.ownerEmail, subject: subject, _subject: subject, message: message }),
    }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  /* ── Guardian backend: StudyOS's worker + Firestore + Formspree ────────── */
  var backend = {
    // Firestore first. When it cannot answer (offline, blocked storage), the
    // cached copy decides, as the old lock did: a lock it knows of still
    // gates, and a device that has seen no lock opens rather than locking its
    // owner out over a network hiccup. The live snapshot tightens it later.
    status: function () {
      return loadCloud().then(function () {
        var e = entry();
        return { hasLock: !!(e && e.locked), ver: e && e.locked ? String(e.v || 0) : null };
      });
    },
    verify: function (d, pw) { return post('/auth/journal/verify', { password: pw }); },
    // Change password carries `current`: verify it by removing the old record,
    // then write the new one (the worker has no single "change" route).
    set: function (d, pw, hint, current) {
      var first = current
        ? post('/auth/journal/remove-lock', { password: current }).then(function (r) { if (!(r && r.ok)) throw { needsCurrent: true }; })
        : Promise.resolve();
      return first.then(function () {
        return post('/auth/journal/set-lock', { password: pw, hint: hint || '' });
      }).then(function (r) {
        if (r && r.ok) stampLock();
        return r;
      }, function (e) {
        if (e && e.needsCurrent) return { ok: false, error: 'needs-current' };
        throw e;
      });
    },
    remove: function (d, pw) {
      return post('/auth/journal/remove-lock', { password: pw }).then(function (r) {
        if (r && r.ok) dropLock();
        return r;
      });
    },
    hint: function () {
      return post('/auth/journal/hint', {}).then(function (r) {
        if (!r || r.noLock) return { noLock: true };
        return mail(LABEL + ' — Password Hint', 'Hint for "' + LABEL + '":\n\n' + (r.hint || '(none set)') + '\n\n— ' + LABEL)
          .then(function (sent) { return { ok: true, emailed: sent }; });
      });
    },
    resetRequest: function () {
      return post('/auth/reset/request', {}).then(function (r) {
        if (r && r.noLock) return { ok: false, noLock: true };
        if (!r || !r.ok || !r.code) return { ok: false };
        return mail(LABEL + ' — Password Reset Code',
          'Your password reset code for ' + LABEL + ' is:\n\n    ' + r.code
          + '\n\nEnter this code in ' + LABEL + ' to set a new password. It expires in 15 minutes.'
          + '\nIf you did not request this, you can ignore this email.\n\n— ' + LABEL)
          .then(function (sent) { return { ok: true, emailed: sent, to: FORM.ownerEmail }; });
      });
    },
    resetConfirm: function (d, code, pw, hint) {
      return post('/auth/reset/confirm', { code: code, password: pw, hint: hint || '' }).then(function (r) {
        if (r && r.ok) stampLock();
        return r;
      });
    }
  };

  /* ── Legacy adoption (StudyOS's old applock keys) ─────────────────────── */
  function oldUnlockedAt() {
    var best = -1;
    [function () { return localStorage; }, function () { return sessionStorage; }].forEach(function (st) {
      try {
        var raw = st().getItem('sos_al_unlockedat_' + APP_ID);
        if (raw === null) return;
        var n = parseInt(String(raw).charAt(0) === 'v' ? String(raw).slice(1) : raw, 10);
        if (!isNaN(n) && n > best) best = n;
      } catch (e) {}
    });
    return best;
  }
  var legacy = {
    // The cached Firestore copy answers the first paint: a known lock gates at
    // once, a cache with no lock opens at once (as before), and a device with
    // no cache at all asks Firestore first.
    locked: function () {
      var e = entry();
      if (e && e.locked) return true;
      try { return localStorage.getItem('sos_al_locks') !== null ? false : null; } catch (x) { return null; }
    },
    open: function () {
      var e = entry();
      if (!e || !e.locked) return false;
      var at = oldUnlockedAt();
      // Monotonic, as the old lock compared: unlocked at this version or later.
      return at >= 0 && at >= (e.v || 0) ? String(e.v || 0) : false;
    },
    bio: function () {
      try { var r = JSON.parse(localStorage.getItem('sos_bio_' + APP_ID) || 'null'); return r && r.id ? r : null; } catch (e) { return null; }
    }
  };

  G.define(GID, {
    owner: 'veda',
    label: LABEL,
    appName: LABEL,
    journal: NAMESPACE,
    entryId: APP_ID,
    root: '#study-root',
    hard: true,
    backend: backend,
    legacy: legacy,
    onChange: function () { refreshBtn(); },
    // Locked elsewhere (or "Lock this device now") while StudyOS is open:
    // hide it at once and ask again.
    onBlock: function () {
      setGate('locked');
      G.hideRoot(GID);
      refreshBtn();
      G.gate(GID).then(function (ok) { if (ok) { setGate('open'); refreshBtn(); } });
    }
  });
  G.prepaint([GID]);

  /* ── Header button ──────────────────────────────────────────────────────── */
  var ICON_LOCKED = '<svg class="soi" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  var ICON_OPEN   = '<svg class="soi" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
  function refreshBtn() {
    var b = document.getElementById('sos-lock-btn');
    if (!b) return;
    var on = G.isLocked(GID);
    b.innerHTML = on ? ICON_LOCKED : ICON_OPEN;
    b.classList.toggle('locked', on);
    b.title = on ? (LABEL + ' is locked — manage the lock') : ('Lock ' + LABEL);
    b.setAttribute('aria-label', b.title);
  }

  /* Remote lock changes from another device (firebase-sync's live snapshot). */
  window._alApplyRemoteLocks = function (remote) {
    _locks = remote || {};
    _cloudSeen = true;
    cacheLocks();
    G.refresh([GID], true).then(refreshBtn, refreshBtn);
  };

  function start() {
    refreshBtn();
    var btn = document.getElementById('sos-lock-btn');
    // "Lock this device now" in the menu re-gates through onBlock above.
    if (btn) btn.addEventListener('click', function () {
      Promise.resolve(G.manage(GID)).then(refreshBtn, refreshBtn);
    });
    G.gate(GID).then(function (ok) {
      refreshBtn();
      if (ok) openApp();
    });
    window.addEventListener('guardian:status', refreshBtn);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  /* Public surface, mirroring the old host API. */
  window.alManage = function () { return G.manage(GID); };
  window.alIsLocked = function () { return G.isLocked(GID); };
})();
