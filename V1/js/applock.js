/* ============================================================================
 * StudyOS — App Lock
 * ============================================================================
 * Gates the ENTIRE application behind a password before any data is shown.
 * Rebuilt from the host page's multi-app lock system, reduced to one lock
 * (StudyOS itself) and cut free of every host dependency.
 *
 * FEATURE PARITY with the original:
 *   • create / change / remove password
 *   • password hint, emailed on demand via Formspree
 *   • password reset with a time-limited emailed security code
 *   • lock state synced across all devices through Firestore
 *   • per-device unlock: unlock once per device, stays open until the password
 *     changes (version bump) or the lock is removed
 *   • optional device biometrics (Face ID / Touch ID / Windows Hello /
 *     Android fingerprint) via WebAuthn, with the password always a fallback
 *   • rate limiting: 5 wrong attempts → 30s cooldown
 *
 * SECURITY MODEL — unchanged from the original, and worth stating plainly:
 *   The password is NEVER stored anywhere in the browser and never reaches
 *   Firestore. It is sent to the studyos-api Worker, which stores only a
 *   salted PBKDF2 hash in KV. Firestore holds only WHICH lock is on and at
 *   what version, so a new device knows to prompt.
 *
 *   This gates the UI, not the database. Anyone holding your Firebase config
 *   could still read Firestore directly — the lock stops a person picking up
 *   your unlocked laptop, which is what it is for. Tighten Firestore rules if
 *   you need more than that.
 *
 * BOOT CONTRACT: publishes window.SOS_GATE, a promise js/studyos.js waits on
 * before it renders anything. Resolved when access is granted; left pending
 * while locked. body[data-sos-gate] drives the CSS that hides the app, so no
 * data can flash on screen before the overlay paints.
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';

  var CFG   = window.STUDYOS_CONFIG || {};
  var LOCK  = CFG.appLock || {};
  var API   = (CFG.cloudflare && CFG.cloudflare.apiWorker) || {};
  var FORM  = CFG.formspree || {};

  var APP_ID    = LOCK.id || 'studyos';
  var LABEL     = LOCK.label || 'StudyOS';
  var ACCENT    = LOCK.accent || '#8D769A';
  var WORKER    = String(API.baseUrl || '').replace(/\/+$/, '');
  var NAMESPACE = API.lockNamespace || 'studyos_applock';

  var WORKER_OK = !!(window.STUDYOS_CONFIG_READY && window.STUDYOS_CONFIG_READY('cloudflare')) && !!WORKER;
  var FORM_OK   = !!(window.STUDYOS_CONFIG_READY && window.STUDYOS_CONFIG_READY('formspree'));
  var LOCK_ON   = LOCK.enabled !== false;

  /* ── Gate promise ─────────────────────────────────────────────────────────
   * Resolved exactly once, when the app is allowed to render. */
  var _openGate;
  window.SOS_GATE = new Promise(function (res) { _openGate = res; });
  function setGate(state) { document.body.setAttribute('data-sos-gate', state); }
  function openApp() { setGate('open'); try { _openGate(); } catch (e) {} }

  /* Lock disabled or unconfigured → straight through. A half-migrated project
   * must never lock the owner out of their own data. */
  if (!LOCK_ON || !WORKER_OK) {
    if (LOCK_ON && !WORKER_OK) {
      console.info('[StudyOS] App Lock is on but the studyos-api Worker is not configured — running unlocked. Fill in config/config.js §2 to enable it.');
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', openApp);
    else openApp();
    return;
  }

  /* ── Icons ────────────────────────────────────────────────────────────────
   * Inline so the lock screen never waits on a font or an icon sheet. */
  function I(body) {
    return '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" '
         + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }
  var ICON = {
    lock:   I('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
    unlock: I('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'),
    key:    I('<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8.5-8.5"/><path d="m17 6 3 3"/><path d="m14 9 3 3"/>'),
    shield: I('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>'),
    user:   I('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
    trash:  I('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  };

  /* ── Biometrics (WebAuthn platform authenticator) ─────────────────────────
   * The app never sees or stores biometric data — WebAuthn returns only a
   * public-key credential handle, and unlock is scoped to this credential id
   * alone via allowCredentials. */
  var Bio = (function () {
    var NS = 'sos_bio_';
    function u8(b) { return new Uint8Array(b); }
    function b64u(buf) { var b = u8(buf), s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
    function unb64u(str) { str = String(str).replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; var bin = atob(str), b = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b.buffer; }
    function rand(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
    function keyOf(id) { return NS + id; }
    function supported() { return !!(window.isSecureContext && window.PublicKeyCredential && navigator.credentials && navigator.credentials.create); }
    function available() {
      if (!supported()) return Promise.resolve(false);
      if (!PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return Promise.resolve(false);
      return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(function (v) { return !!v; }).catch(function () { return false; });
    }
    function stored(id) { try { return JSON.parse(localStorage.getItem(keyOf(id)) || 'null'); } catch (e) { return null; } }
    function isRegistered(id) { var r = stored(id); return !!(r && r.id); }
    function unregister(id) { try { localStorage.removeItem(keyOf(id)); } catch (e) {} }
    function label() {
      var ua = navigator.userAgent || '';
      if (/iPhone|iPad|iPod/.test(ua)) return 'Face ID';
      if (/Android/.test(ua)) return 'fingerprint';
      if (/Windows/.test(ua)) return 'Windows Hello';
      if (/Mac/.test(ua)) return 'Touch ID';
      return 'biometrics';
    }
    function register(id) {
      if (!supported()) return Promise.resolve({ ok: false, error: 'unsupported' });
      return navigator.credentials.create({ publicKey: {
        challenge: rand(32),
        rp: { name: LABEL, id: location.hostname || undefined },
        user: { id: rand(16), name: 'studyos:' + id, displayName: LABEL },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        timeout: 60000, attestation: 'none',
      } }).then(function (cred) {
        if (!cred) return { ok: false, error: 'cancelled' };
        localStorage.setItem(keyOf(id), JSON.stringify({ id: b64u(cred.rawId), created: Date.now() }));
        return { ok: true };
      }).catch(function (e) { return { ok: false, error: (e && e.name) || 'error' }; });
    }
    function authenticate(id) {
      if (!supported()) return Promise.resolve({ ok: false, error: 'unsupported' });
      var rec = stored(id);
      if (!rec || !rec.id) return Promise.resolve({ ok: false, error: 'notregistered' });
      return navigator.credentials.get({ publicKey: {
        challenge: rand(32),
        allowCredentials: [{ type: 'public-key', id: unb64u(rec.id) }],
        userVerification: 'required', timeout: 60000, rpId: location.hostname || undefined,
      } }).then(function (asr) { return asr ? { ok: true } : { ok: false, error: 'cancelled' }; })
        .catch(function (e) { return { ok: false, error: (e && e.name) || 'error' }; });
    }
    return { supported: supported, available: available, isRegistered: isRegistered, register: register, authenticate: authenticate, unregister: unregister, label: label };
  })();
  window.SosBio = Bio;

  /* ── Lock state ───────────────────────────────────────────────────────────
   * _locks maps appId → { locked, v }. Synced through Firestore; localStorage
   * caches it so a cold start knows to gate BEFORE Firebase answers. */
  var _locks = {};
  try { _locks = JSON.parse(localStorage.getItem('sos_al_locks') || '{}'); } catch (e) {}

  var _pendingPush = false;
  function saveLocks() {
    try { localStorage.setItem('sos_al_locks', JSON.stringify(_locks)); } catch (e) {}
    if (window._fbSaveAppLocks) { window._fbSaveAppLocks(_locks); _pendingPush = false; }
    else _pendingPush = true;   // Firebase not up yet — push once it is
  }
  function isLocked() { return !!(_locks[APP_ID] && _locks[APP_ID].locked); }
  function lockVersion() { var e = _locks[APP_ID]; return (e && e.v) || 0; }
  function setLock(v) { _locks[APP_ID] = { locked: true, v: v || Date.now() }; saveLocks(); }
  function removeLock() { delete _locks[APP_ID]; saveLocks(); }

  /* ── Per-device unlock ────────────────────────────────────────────────────
   * Records the lock VERSION this device unlocked at, and compares MONOTONICALLY
   * (unlocked-at >= current) rather than for exact equality.
   *
   * That distinction is the whole fix for the old "sometimes asks again" bug:
   * the version replicates through Firestore, so a device can briefly observe a
   * stale, missing, or zero version (cached snapshot before the server one
   * lands, a legacy record with no `v`, an offline start). Exact matching
   * treated every one of those as "different password → re-prompt". Monotonic
   * treats them as "not newer than what I already unlocked" and stays open.
   * Only a real password change — which stamps a strictly greater Date.now() —
   * locks up again.
   *
   * Mirrored across localStorage + sessionStorage + memory so eviction of any
   * one store doesn't cost a re-entry. */
  var _unlockedMem = {};
  function readUnlockAt(id) {
    var best = -1;
    function read(store, key) {
      try {
        var raw = store.getItem(key);
        if (raw === null) return;
        var n = parseInt(String(raw).charAt(0) === 'v' ? String(raw).slice(1) : raw, 10);
        if (!isNaN(n) && n > best) best = n;
      } catch (e) {}
    }
    if (_unlockedMem[id] !== undefined) best = _unlockedMem[id];
    read(localStorage, 'sos_al_unlockedat_' + id);
    read(sessionStorage, 'sos_al_unlockedat_' + id);
    return best;   // -1 = this device has never unlocked it
  }
  function isUnlocked() {
    if (!isLocked()) return true;
    var at = readUnlockAt(APP_ID);
    if (at < 0) return false;
    return at >= lockVersion();
  }
  function markUnlocked() {
    var v = lockVersion();
    // Never regress: if this device already unlocked at a newer version than the
    // one currently visible (stale snapshot), keep the newer.
    var prev = readUnlockAt(APP_ID);
    if (prev > v) v = prev;
    _unlockedMem[APP_ID] = v;
    try { localStorage.setItem('sos_al_unlockedat_' + APP_ID, String(v)); } catch (e) {}
    try { sessionStorage.setItem('sos_al_unlockedat_' + APP_ID, String(v)); } catch (e) {}
  }
  function markLocked() {
    delete _unlockedMem[APP_ID];
    try { localStorage.removeItem('sos_al_unlockedat_' + APP_ID); } catch (e) {}
    try { sessionStorage.removeItem('sos_al_unlockedat_' + APP_ID); } catch (e) {}
  }
  function mustBlock() { return isLocked() && !isUnlocked(); }

  /* ── Worker API ───────────────────────────────────────────────────────────
   * The Worker owns the hash. Every call is a plain JSON POST. */
  function api(path, body) {
    return fetch(WORKER + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ journal: NAMESPACE, entryId: APP_ID }, body || {})),
    }).then(function (r) { return r.json(); });
  }

  /* ── DOM ──────────────────────────────────────────────────────────────── */
  function el(id) { return document.getElementById(id); }

  var _mode = 'unlock';
  var _cb = null;
  var _removeBio = false;
  var _attempts = 0;
  var _cooldownUntil = 0;

  function showOverlay(mode, cb) {
    _mode = mode; _cb = cb || null; _removeBio = false;
    el('applock-err').textContent = '';
    el('applock-pw').value = '';
    el('applock-pw').classList.remove('error');
    el('applock-title').textContent = LABEL;
    el('applock-title').style.color = ACCENT;
    el('applock-submit').style.background = ACCENT;
    el('applock-submit').style.display = '';
    el('applock-pw').style.display = '';
    var m = el('al-menu-btns'); if (m) m.remove();

    if (mode === 'setpw') {
      el('applock-icon').innerHTML = ICON.shield;
      el('applock-sub').textContent = 'Choose a password to lock ' + LABEL + '. Unlock once per device.';
      el('applock-submit').textContent = 'Set Password';
      el('applock-forgot').style.display = 'none';
    } else if (mode === 'remove') {
      el('applock-icon').innerHTML = ICON.unlock;
      el('applock-sub').textContent = 'Enter password to remove the lock.';
      el('applock-submit').textContent = 'Remove Lock';
      el('applock-forgot').style.display = '';
    } else if (mode === 'changepw') {
      el('applock-icon').innerHTML = ICON.key;
      el('applock-sub').textContent = 'Enter your current password first.';
      el('applock-submit').textContent = 'Verify & Continue';
      el('applock-forgot').style.display = '';
    } else {
      el('applock-icon').innerHTML = ICON.lock;
      el('applock-sub').textContent = 'Enter your password to open ' + LABEL + '.';
      el('applock-submit').textContent = 'Unlock';
      el('applock-forgot').style.display = '';
    }
    // Reset link mirrors "Forgot password?" (both hidden while setting a new one),
    // and stays hidden entirely when Formspree isn't configured — offering a
    // reset that cannot send an email is worse than not offering it.
    var showLinks = el('applock-forgot').style.display !== 'none';
    el('applock-forgot').style.display = (showLinks && FORM_OK) ? '' : 'none';
    if (el('applock-reset')) el('applock-reset').style.display = (showLinks && FORM_OK) ? '' : 'none';
    // Cancel is meaningless on an access gate: there is nowhere else to go in a
    // standalone app, and hiding it stops anyone dismissing their way in.
    el('applock-cancel').style.display = (mode === 'unlock' && mustBlock()) ? 'none' : '';

    el('applock-overlay').style.display = 'flex';
    setTimeout(function () { el('applock-pw').focus(); }, 80);
    renderBio();
  }

  function hideOverlay() {
    el('applock-overlay').style.display = 'none';
    var m = el('al-menu-btns'); if (m) m.remove();
    var bio = el('applock-bio'); if (bio) { bio.innerHTML = ''; bio.style.display = 'none'; }
    _removeBio = false;
  }

  function pwErr(msg) {
    el('applock-err').textContent = msg;
    el('applock-pw').classList.add('error');
    var box = el('applock-box');
    box.classList.remove('shake');
    void box.offsetWidth;              // force reflow so the animation restarts
    box.classList.add('shake');
    setTimeout(function () { box.classList.remove('shake'); }, 500);
  }

  function bumpAttempt() {
    _attempts++;
    if (_attempts >= 5) _cooldownUntil = Date.now() + 30000;
  }

  /* ── Biometric unlock button ────────────────────────────────────────────── */
  function showPwFields(show) {
    el('applock-pw').style.display = show ? '' : 'none';
    el('applock-submit').style.display = show ? '' : 'none';
    if (show) setTimeout(function () { el('applock-pw').focus(); }, 60);
  }
  function renderBio() {
    var box = el('applock-bio'); if (!box) return;
    box.innerHTML = ''; box.style.display = 'none';
    if (LOCK.biometrics === false || _mode !== 'unlock') return;
    Bio.available().then(function (avail) {
      if (_mode !== 'unlock') return;
      if (!(avail && Bio.isRegistered(APP_ID))) return;
      box.style.display = 'flex'; box.style.flexDirection = 'column'; box.style.gap = '8px';
      var b = document.createElement('button');
      b.innerHTML = ICON.unlock + '<span>Unlock with ' + Bio.label() + '</span>';
      b.style.cssText = "border:none;border-radius:4px;padding:12px 0;font-size:14px;font-weight:700;cursor:pointer;font-family:'Inter',system-ui,-apple-system,sans-serif;width:100%;background:" + ACCENT + ';color:#fff;';
      b.onclick = bioUnlock;
      box.appendChild(b);
      // Password stays visible alongside: biometrics run ONLY on this button, so
      // both routes are available at all times.
      showPwFields(true);
    });
  }
  function bioUnlock() {
    el('applock-err').textContent = '';
    Bio.authenticate(APP_ID).then(function (r) {
      if (r.ok) {
        if (_removeBio) { doRemoveBio(); return; }
        markUnlocked(); _attempts = 0;
        var cb = _cb; hideOverlay(); openApp(); refreshBtn();
        if (cb) cb();
      } else if (r.error === 'notregistered') { showPwFields(true); }
      else { el('applock-err').textContent = 'Biometric check failed — use your password.'; showPwFields(true); }
    });
  }
  function bioRemovePrompt() {
    showOverlay('unlock');
    _removeBio = true;   // showOverlay resets it; re-set after
    el('applock-icon').innerHTML = ICON.user;
    el('applock-sub').textContent = 'Verify with ' + Bio.label() + ' or your password to remove biometrics from this device.';
  }
  function doRemoveBio() {
    _removeBio = false;
    Bio.unregister(APP_ID);
    hideOverlay(); refreshBtn();
    window.uiAlert('Biometrics removed from this device.');
  }
  function bioRegister(closeAfter) {
    Bio.register(APP_ID).then(function (r) {
      if (r.ok) {
        markUnlocked(); if (closeAfter) hideOverlay();
        refreshBtn();
        window.uiAlert('Biometrics registered. You can now unlock ' + LABEL + ' with ' + Bio.label() + ' on this device.');
      } else if (r.error === 'cancelled' || r.error === 'NotAllowedError') { /* user backed out */ }
      else window.uiAlert('Could not register biometrics on this device.');
    });
  }
  function maybeOfferBio() {
    if (LOCK.biometrics === false) return;
    Bio.available().then(function (avail) {
      if (!avail || Bio.isRegistered(APP_ID)) return;
      window.uiConfirm('Register ' + Bio.label() + ' to unlock ' + LABEL + ' on this device? Your password still works as a fallback.',
        { title: 'Register ' + Bio.label(), okLabel: 'Register' }).then(function (ok) { if (ok) bioRegister(false); });
    });
  }

  /* ── Manage menu ────────────────────────────────────────────────────────── */
  function manage() {
    if (isLocked()) showManageMenu();
    else showOverlay('setpw', refreshBtn);
  }

  function showManageMenu() {
    var unlocked = isUnlocked();
    el('applock-err').textContent = '';
    var mb = el('applock-bio'); if (mb) { mb.innerHTML = ''; mb.style.display = 'none'; }
    el('applock-pw').value = '';
    el('applock-pw').classList.remove('error');
    el('applock-icon').innerHTML = ICON.lock;
    el('applock-title').textContent = LABEL;
    el('applock-title').style.color = ACCENT;
    el('applock-submit').style.display = 'none';
    el('applock-forgot').style.display = 'none';
    if (el('applock-reset')) el('applock-reset').style.display = 'none';
    el('applock-cancel').style.display = unlocked ? '' : 'none';
    el('applock-sub').textContent = unlocked ? (LABEL + ' is locked. Manage:') : (LABEL + ' is locked. Choose:');

    var existing = el('al-menu-btns'); if (existing) existing.remove();
    var menu = document.createElement('div');
    menu.id = 'al-menu-btns';
    menu.style.cssText = 'display:flex;flex-direction:column;gap:8px;width:100%;';
    var s = "border:none;border-radius:4px;padding:10px 0;font-size:13px;font-weight:700;cursor:pointer;font-family:'Inter',system-ui,-apple-system,sans-serif;width:100%;";

    if (!unlocked) {
      var ub = document.createElement('button');
      ub.innerHTML = ICON.unlock + '<span>Unlock</span>';
      ub.style.cssText = s + 'background:' + ACCENT + ';color:#1a1a1d;';
      ub.onclick = function () { menu.remove(); el('applock-submit').style.display = ''; showOverlay('unlock', refreshBtn); };
      menu.appendChild(ub);
    }

    var cb = document.createElement('button');
    cb.innerHTML = ICON.key + '<span>Change password</span>';
    cb.style.cssText = s + 'background:#34343a;color:#f4f3f0;border:1px solid #45454c;';
    cb.onclick = function () { menu.remove(); el('applock-submit').style.display = ''; showOverlay('changepw', null); };
    menu.appendChild(cb);

    if (LOCK.biometrics !== false) Bio.available().then(function (avail) {
      if (!avail) return;
      var bb = document.createElement('button');
      if (Bio.isRegistered(APP_ID)) {
        bb.innerHTML = ICON.user + '<span>Remove biometrics</span>';
        bb.style.cssText = s + 'background:transparent;color:#adadb2;border:1px solid #45454c;';
        bb.onclick = function () { menu.remove(); el('applock-submit').style.display = ''; bioRemovePrompt(); };
      } else {
        bb.innerHTML = ICON.user + '<span>Register ' + Bio.label() + '</span>';
        bb.style.cssText = s + 'background:#34343a;color:#f4f3f0;border:1px solid #45454c;';
        bb.onclick = function () { menu.remove(); el('applock-submit').style.display = ''; bioRegister(true); };
      }
      menu.insertBefore(bb, cb);
    });

    var rb = document.createElement('button');
    rb.innerHTML = ICON.trash + '<span>Remove lock</span>';
    rb.style.cssText = s + 'background:transparent;color:#dda398;border:1px solid #dda398;';
    rb.onclick = function () { menu.remove(); el('applock-submit').style.display = ''; showOverlay('remove', refreshBtn); };
    menu.appendChild(rb);

    (el('applock-form') || el('applock-cancel').parentNode).appendChild(menu);
    el('applock-overlay').style.display = 'flex';
  }

  /* ── Password reset by emailed code ─────────────────────────────────────── */
  async function resetFlow() {
    function post(path, obj) {
      return fetch(WORKER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) })
        .then(function (r) { return r.json(); });
    }
    var reqBody = { journal: NAMESPACE, entryId: APP_ID };
    var rq;
    try { rq = await post('/auth/reset/request', reqBody); }
    catch (e) { await window.uiAlert('Network error while starting the reset. Check your connection and try again.'); return; }
    if (rq && rq.noLock) { await window.uiAlert('There is no password set on the server for ' + LABEL + '.'); return; }
    if (!rq || !rq.ok || !rq.code) { await window.uiAlert('Could not start the reset. Please try again.'); return; }

    // Email the code through the same Formspree form used for hints.
    var emailed = false;
    try {
      var fp = await fetch(FORM.endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          email: FORM.ownerEmail,
          subject: LABEL + ' — Password Reset Code',
          message: 'Your password reset code for ' + LABEL + ' is:\n\n    ' + rq.code
            + '\n\nEnter this code in ' + LABEL + ' to set a new password. It expires in 15 minutes.'
            + '\nIf you did not request this, you can ignore this email.\n\n— ' + LABEL,
        }),
      });
      emailed = fp.ok;
    } catch (e) { emailed = false; }
    if (!emailed) { await window.uiAlert('Could not send the reset email. Please try again in a moment.'); return; }

    var vals = await window.uiForm({
      title: 'Reset password',
      message: 'A 6-character code was emailed to ' + FORM.ownerEmail + '. Enter it below (check spam if it does not arrive within a minute), then choose a new password.',
      okLabel: 'Reset password',
      fields: [
        { name: 'code', label: 'Security code from email', placeholder: '6-character code', autocap: false, required: true },
        { name: 'password', label: 'New password', type: 'password', required: true },
        { name: 'hint', label: 'New password hint (optional)' },
      ],
    });
    if (!vals) return;
    var code = String(vals.code || '').trim();
    var np   = String(vals.password || '').trim();
    if (!code) { await window.uiAlert('No code entered.'); return; }
    if (!np)   { await window.uiAlert('Password cannot be empty.'); return; }

    var cf;
    try { cf = await post('/auth/reset/confirm', Object.assign({ code: code, password: np, hint: vals.hint || '' }, reqBody)); }
    catch (e) { await window.uiAlert('Network error while confirming the reset. Please try again.'); return; }

    if (cf && cf.ok) {
      setLock(); markUnlocked(); hideOverlay(); openApp(); refreshBtn();
      await window.uiAlert('Password reset. It now syncs to all your devices — this one is unlocked, others will ask for the new password once.');
      return;
    }
    if (cf && cf.error === 'badcode') await window.uiAlert('That code is not correct.' + (cf.remaining != null ? (' ' + cf.remaining + ' attempt(s) left before it expires.') : ''));
    else if (cf && cf.error === 'expired') await window.uiAlert('That code has expired or was already used. Start the reset again for a fresh code.');
    else if (cf && cf.error === 'locked') await window.uiAlert('Too many incorrect attempts. Start the reset again for a fresh code.');
    else await window.uiAlert('Reset failed. Please try again.');
  }

  /* ── Header button ──────────────────────────────────────────────────────── */
  function refreshBtn() {
    var b = el('sos-lock-btn');
    if (!b) return;
    // SVG, not 🔒/🔓: those render as a flat black text glyph on most
    // phones, which was unreadable against this button's fill.
    b.innerHTML = isLocked() ? '<svg class="soi" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' : '<svg class="soi" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
    b.title = isLocked() ? (LABEL + ' is locked — manage lock') : ('Lock ' + LABEL);
  }

  /* ── Wire up ────────────────────────────────────────────────────────────── */
  function wire() {
    el('applock-submit').addEventListener('click', async function () {
      var pw = el('applock-pw').value.trim();
      if (!pw) { el('applock-pw').classList.add('error'); el('applock-err').textContent = 'Password required.'; return; }
      if (_attempts >= 5) {
        var wait = Math.ceil((_cooldownUntil - Date.now()) / 1000);
        if (wait > 0) { el('applock-err').textContent = 'Too many attempts. Wait ' + wait + 's.'; return; }
        _attempts = 0;
      }
      el('applock-submit').disabled = true;
      el('applock-submit').textContent = 'Checking…';
      try {
        if (_mode === 'setpw') {
          var hint = (await window.uiPrompt('Optional: a password hint for the recovery email. Leave blank to skip.', { title: 'Password hint' })) || '';
          var d1 = await api('/auth/journal/set-lock', { password: pw, hint: hint });
          if (d1.ok) {
            setLock(); markUnlocked(); hideOverlay(); refreshBtn();
            if (_cb) _cb();
            maybeOfferBio();
          } else el('applock-err').textContent = 'Failed to set lock. Try again.';

        } else if (_mode === 'remove') {
          var d2 = await api('/auth/journal/remove-lock', { password: pw });
          if (d2.ok) { removeLock(); markLocked(); hideOverlay(); openApp(); refreshBtn(); if (_cb) _cb(); }
          else { bumpAttempt(); pwErr('Wrong password.'); }

        } else if (_mode === 'changepw') {
          var d3 = await api('/auth/journal/verify', { password: pw });
          if (d3.ok) {
            var chg = await window.uiForm({
              title: 'Change password', okLabel: 'Change password',
              fields: [
                { name: 'password', label: 'New password', type: 'password', required: true },
                { name: 'hint', label: 'New password hint (optional)' },
              ],
            });
            var np = chg ? String(chg.password || '').trim() : '';
            if (!np) { el('applock-err').textContent = 'New password empty — not changed.'; }
            else {
              // Remove-then-set, so a failure at either step leaves a coherent
              // state rather than two live records.
              var rem = await api('/auth/journal/remove-lock', { password: pw });
              if (rem.ok) {
                var set = await api('/auth/journal/set-lock', { password: np, hint: (chg.hint || '') });
                if (set.ok) {
                  // Fresh version → every OTHER device must re-enter once.
                  setLock(); markUnlocked(); hideOverlay(); refreshBtn();
                  await window.uiAlert('Password changed. Other devices will ask for the new password once.');
                } else el('applock-err').textContent = 'Failed to set the new password.';
              } else el('applock-err').textContent = 'Error removing the old lock. Try again.';
            }
          } else { bumpAttempt(); pwErr('Wrong password.'); }

        } else {   // unlock
          var d4 = await api('/auth/journal/verify', { password: pw });
          if (d4.ok) {
            _attempts = 0;
            if (_removeBio) doRemoveBio();
            else {
              markUnlocked();
              var cb2 = _cb; hideOverlay(); openApp(); refreshBtn();
              if (cb2) cb2();
            }
          } else { bumpAttempt(); pwErr('Wrong password.'); }
        }
      } catch (e) {
        el('applock-err').textContent = 'Network error. Try again.';
      }
      el('applock-submit').disabled = false;
      el('applock-submit').textContent = { setpw: 'Set Password', remove: 'Remove Lock', changepw: 'Verify & Continue' }[_mode] || 'Unlock';
    });

    el('applock-pw').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') el('applock-submit').click();
      if (e.key === 'Escape') { el('applock-err').textContent = ''; el('applock-pw').classList.remove('error'); }
    });

    el('applock-cancel').addEventListener('click', function () {
      var m = el('al-menu-btns'); if (m) m.remove();
      el('applock-submit').style.display = '';
      // Never dismissible into the app while it is genuinely gated.
      if (_mode === 'unlock' && mustBlock()) return;
      hideOverlay();
    });

    el('applock-forgot').addEventListener('click', async function () {
      var btn = el('applock-forgot');
      btn.textContent = 'Sending…'; btn.disabled = true;
      try {
        var hd = await api('/auth/journal/hint', {});
        if (hd.noLock) {
          el('applock-err').textContent = 'No lock on the server. Try re-locking.';
          btn.disabled = false; btn.textContent = 'Forgot password?'; return;
        }
        var fp = await fetch(FORM.endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            email: FORM.ownerEmail,
            subject: LABEL + ' — Password Hint',
            message: 'Hint for "' + LABEL + '":\n\n' + (hd.hint || '(none set)') + '\n\n— ' + LABEL,
          }),
        });
        if (fp.ok) {
          btn.textContent = 'Hint sent!';
          setTimeout(function () { btn.textContent = 'Forgot password?'; btn.disabled = false; }, 3000);
        } else { btn.textContent = 'Failed — try again'; btn.disabled = false; }
      } catch (e) { btn.textContent = 'Failed — try again'; btn.disabled = false; }
    });

    if (el('applock-reset')) el('applock-reset').addEventListener('click', async function () {
      var btn = el('applock-reset');
      var prev = btn.textContent;
      btn.textContent = 'Sending code…'; btn.disabled = true;
      await resetFlow();
      btn.textContent = prev; btn.disabled = false;
    });

    var hb = el('sos-lock-btn');
    if (hb) hb.addEventListener('click', manage);
  }

  /* Remote lock changes from another device. */
  window._alApplyRemoteLocks = function (remote) {
    remote = remote || {};
    var was = mustBlock();
    _locks = remote;
    try { localStorage.setItem('sos_al_locks', JSON.stringify(_locks)); } catch (e) {}
    refreshBtn();
    // Newly locked (or password changed) elsewhere while we sit here open:
    // gate immediately rather than waiting for a reload.
    if (!was && mustBlock()) { setGate('locked'); showOverlay('unlock', refreshBtn); }
  };

  /* ── Boot ─────────────────────────────────────────────────────────────────
   * Decide from the CACHED lock state first, so a cold start gates instantly
   * instead of flashing the app while Firebase answers. The authoritative
   * state arrives moments later and can only ever tighten access. */
  function start() {
    wire();
    refreshBtn();
    if (mustBlock()) { setGate('locked'); showOverlay('unlock', refreshBtn); }
    else openApp();

    function syncFromCloud() {
      if (_pendingPush && window._fbSaveAppLocks) { window._fbSaveAppLocks(_locks); _pendingPush = false; }
      if (!window._fbLoadAppLocks) return;
      window._fbLoadAppLocks().then(function (remote) {
        if (remote) window._alApplyRemoteLocks(remote);
      }).catch(function () {});
    }
    if (window._fbReady) syncFromCloud();
    else window.addEventListener('fb-ready', syncFromCloud, { once: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  /* Public surface, mirroring the original host API. */
  window.alManage = manage;
  window.alIsLocked = isLocked;
})();
