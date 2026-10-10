/* ═══════════════════════════════════════════════════════════════════════════
   Guardian — the one lock for every A1 program.
   Contract: docs/Guardian/README.md

   A program never builds a lock of its own. It loads this ONE live file
   (A1 pages: "Guardian/guardian.js"; A1-Priv / ORCA: the absolute
   https://anthonyn99.github.io/A1/Guardian/guardian.js) with no ?v= pin, and
   only DECLARES its locks:

       Guardian.define('tony_tradehub_standalone', { owner:'tony', label:'TradeHub', root:'#tradeboard-root', hard:true });
       Guardian.gate('tony_tradehub_standalone');        // → Promise<true|false>
       Guardian.manage('tony_tradehub_standalone');      // the lock menu

   Everything else — screens, themes, biometrics, hint and reset mail, the
   password-version rules — lives here, so changing this file changes every
   program at once (GitHub Pages serves it with a 10-minute cache).

   Passwords: the taskhub-reminders worker, KV `jlock:<journal>:<entryId>`
   (PBKDF2-SHA256). Its /auth/journal/status `ver` is a fingerprint of the
   record's salt, and every set/change/reset mints a new salt — so `ver` is the
   ONE password version: a device stays unlocked while its marker equals `ver`,
   and a password change anywhere re-locks every device and voids every
   biometric enrolled under the old password.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';
if (window.Guardian) return;

var WORKER = 'https://taskhub-reminders.av1.workers.dev';
var REFRESH_MIN_MS = 3 * 60 * 1000;   // background status checks, per lock
var MAX_TRIES = 5, COOLDOWN_MS = 30000;
var OWNERS = { tony: 'Tony', veda: 'Veda' };

/* ── Storage ────────────────────────────────────────────────────────────────
   Every call is guarded: Veda's Brave blocks storage outright (every access
   throws), so each value is also mirrored in memory, sessionStorage, and —
   for unlock markers — a 400-day cookie, so eviction of any one store does
   not cost a re-entry. */
var MEM = {};
function sGet(k) {
  try { var v = localStorage.getItem(k); if (v !== null) return v; } catch (e) {}
  try { var s = sessionStorage.getItem(k); if (s !== null) return s; } catch (e) {}
  return Object.prototype.hasOwnProperty.call(MEM, k) ? MEM[k] : null;
}
function sSet(k, v) {
  MEM[k] = v;
  try { localStorage.setItem(k, v); } catch (e) {}
  try { sessionStorage.setItem(k, v); } catch (e) {}
}
function sDel(k) {
  delete MEM[k];
  try { localStorage.removeItem(k); } catch (e) {}
  try { sessionStorage.removeItem(k); } catch (e) {}
}
function jGet(k) { try { return JSON.parse(sGet(k) || 'null'); } catch (e) { return null; } }
function jSet(k, o) { sSet(k, JSON.stringify(o)); }
function cookieName(key) { return 'gdu.' + key.replace(/[^A-Za-z0-9_.-]/g, '_'); }
function cookieGet(key) {
  try {
    var n = cookieName(key) + '=', parts = document.cookie.split('; ');
    for (var i = 0; i < parts.length; i++) if (parts[i].indexOf(n) === 0) return decodeURIComponent(parts[i].slice(n.length));
  } catch (e) {}
  return null;
}
function cookieSet(key, v) {
  try {
    document.cookie = cookieName(key) + '=' + (v == null ? '' : encodeURIComponent(v)) + '; path=/; SameSite=Lax' +
      (location.protocol === 'https:' ? '; Secure' : '') + (v == null ? '; Max-Age=0' : '; Max-Age=' + (400 * 86400));
  } catch (e) {}
}

/* ── Lock definitions ─────────────────────────────────────────────────────── */
var DEFS = {};
function guessOwner(id) { return /veda/i.test(id) ? 'veda' : 'tony'; }
function define(id, o) {
  o = o || {};
  var prev = DEFS[id] || {};
  var d = {
    id: id,
    owner: o.owner || prev.owner || guessOwner(id),
    label: o.label || prev.label || id,
    kind: o.kind || prev.kind || (/^profile_/.test(id) ? 'profile' : 'app'),   // app | profile | entry | tab
    journal: o.journal || prev.journal || 'applock',
    entryId: o.entryId || prev.entryId || id,
    appName: o.appName || prev.appName || '',
    root: o.root !== undefined ? o.root : prev.root,
    hard: o.hard !== undefined ? !!o.hard : !!prev.hard,
    allowRemove: o.allowRemove !== undefined ? !!o.allowRemove : (prev.allowRemove !== undefined ? prev.allowRemove : true),
    offline: o.offline !== undefined ? !!o.offline : !!prev.offline,
    session: o.session || prev.session || null,
    backend: o.backend || prev.backend || null,
    legacy: o.legacy !== undefined ? o.legacy : prev.legacy,
    onChange: o.onChange || prev.onChange || null,
    onBlock: o.onBlock || prev.onBlock || null,
    theme: o.theme || prev.theme || null
  };
  d.key = d.journal + ':' + d.entryId;
  DEFS[id] = d;
  return id;
}
function def(id) {
  if (!DEFS[id]) define(id, {});
  return DEFS[id];
}
function themeOf(d) { return d.theme || (d.owner === 'veda' ? 'veda' : 'tony'); }
function noun(d) { return { profile: 'profile', entry: 'entry', tab: 'tab' }[d.kind] || 'app'; }

/* ── Cached status + per-device marker ──────────────────────────────────────
   gd.c.<key> = {h: hasLock (true|false|null=unknown), v: ver|null, t: fetched-at}
   gd.u.<key> = the ver this device unlocked at ('?' = adopted, ver pending)
   gd.b.<key> = this device's biometric credential {id, ver, prf, prfSalt, created}
   gd.s.<key> = '1' once a password change voided this device's biometric
   gd.o.<key> = offline password verifier (only for locks with offline:true) */
function cacheGet(d) {
  var c = jGet('gd.c.' + d.key);
  if (c) return c;
  // First sight on this device: let the program's old lock state answer
  // "is there a lock?" so nothing flickers before the worker replies.
  var h = null;
  if (d.legacy && typeof d.legacy.locked === 'function') {
    try { var L = d.legacy.locked(); if (L === true || L === false) h = L; } catch (e) {}
  }
  return { h: h, v: null, t: 0 };
}
function cacheSet(d, c) { jSet('gd.c.' + d.key, c); }
function markerGet(d) { var m = sGet('gd.u.' + d.key); return m != null ? m : cookieGet(d.key); }
function markerSet(d, v) { v = v || '?'; sSet('gd.u.' + d.key, v); cookieSet(d.key, v); }
function markerDel(d) { sDel('gd.u.' + d.key); cookieSet(d.key, null); }

/* ── LEGACY ADOPTION (remove in Phase 6, see docs/Guardian/README.md) ──────
   The first time Guardian meets a lock on a device, the program's OLD
   "unlocked here" record decides — so nobody is asked for a password, or to
   re-register biometrics, because of the switch. A program passes
   legacy: { open(): true|false|'<ver>', locked(): bool, bio(): {id,prf,prfSalt}|null }
   open() returning a ver string (MAGI) is compared against the worker's ver. */
var ADOPTED = {};
function adopt(d, c) {
  if (ADOPTED[d.key] || !d.legacy || typeof d.legacy.open !== 'function') return false;
  ADOPTED[d.key] = 1;
  var a = false;
  try { a = d.legacy.open(); } catch (e) { a = false; }
  if (!a) return false;
  var at = typeof a === 'string' ? a : (c.v || '?');
  markerSet(d, at);
  if (!bioRec(d) && typeof d.legacy.bio === 'function') {
    var b = null;
    try { b = d.legacy.bio(); } catch (e) {}
    if (b && b.id) jSet('gd.b.' + d.key, { id: b.id, ver: at, prf: !!b.prf, prfSalt: b.prfSalt || null, created: b.created || Date.now() });
  }
  return true;
}
// Ready-made legacy readers for the shapes the old locks wrote.
var legacy = {
  // index / Shield / TradeHub-style app locks: al_locks[id].v vs al_unlockedat_<id>.
  al: function (id, bioNs) {
    function locks() { try { return JSON.parse(localStorage.getItem('al_locks') || '{}') || {}; } catch (e) { return {}; } }
    function at() {
      var best = -1;
      function rd(store, k) {
        try {
          var raw = store.getItem(k); if (raw === null) return;
          var n = parseInt(String(raw).charAt(0) === 'v' ? String(raw).slice(1) : raw, 10);
          if (!isNaN(n) && n > best) best = n; else if (isNaN(n) && best < 0) best = 0;
        } catch (e) {}
      }
      rd(localStorage, 'al_unlockedat_' + id); rd(localStorage, 'al_unlockedv_' + id);
      try { if (localStorage.getItem('al_unlocked_' + id) === '1' && best < 0) best = 0; } catch (e) {}
      rd(sessionStorage, 'al_unlockedat_' + id);
      // TradeHub-style pages mirrored the marker into a cookie (window.alDur).
      try {
        var m = document.cookie.match(new RegExp('(?:^|; )al_unlockedv_' + id.replace(/[^\w]/g, '\\$&') + '=([^;]*)'));
        if (m) rd({ getItem: function () { return decodeURIComponent(m[1]); } }, 'x');
      } catch (e) {}
      return best;
    }
    return {
      locked: function () { return !!locks()[id]; },
      open: function () {
        var L = locks()[id];
        if (!L) return true;                       // the old system had no lock here → it opened
        var a = at(); return a >= 0 && a >= ((L && L.v) || 0);
      },
      bio: function () { return legacy.bioRec(bioNs || 'applock', id, (locks()[id] || {}).v || 0); }
    };
  },
  // Monotonic "<prefix>unlockedat_<id>" markers against a version the host knows (journals).
  marker: function (prefix, id, v, bioNs) {
    return {
      open: function () {
        var best = -1;
        [prefix + 'unlockedat_' + id, prefix + 'unlockedv_' + id].forEach(function (k) {
          [function(){return localStorage;}, function(){return sessionStorage;}].forEach(function (st) {
            try {
              var raw = st().getItem(k); if (raw === null) return;
              var n = parseInt(String(raw).charAt(0) === 'v' ? String(raw).slice(1) : raw, 10);
              if (!isNaN(n) && n > best) best = n;
            } catch (e) {}
          });
        });
        try { if (localStorage.getItem(prefix + 'unlocked_' + id) === '1' && best < 0) best = 0; } catch (e) {}
        return best >= 0 && best >= (+v || 0);
      },
      bio: function () { return legacy.bioRec(bioNs || prefix.replace(/_$/, ''), id, +v || 0); }
    };
  },
  // The old shared Bio helper's record bio_cred_<ns>_<id>, valid if enrolled at or after v.
  bioRec: function (ns, id, v) {
    var r = null;
    try { r = JSON.parse(localStorage.getItem('bio_cred_' + ns + '_' + id) || 'null'); } catch (e) {}
    if (!r || !r.id) return null;
    v = +v || 0;
    var bound = r.v != null ? (+r.v || 0) : (v > 1e12 ? (+r.created || 0) : 0);
    return (!v || bound >= v) ? r : null;
  }
};

/* ── Verdicts ─────────────────────────────────────────────────────────────── */
function isLocked(id) { return cacheGet(def(id)).h === true; }
function isUnlocked(id) {
  var d = def(id), c = cacheGet(d);
  if (c.h === false) return true;
  var m = markerGet(d);
  if (m) return m === '?' || c.v == null || m === c.v;
  if (adopt(d, c)) return isUnlocked(id);
  return false;
}
// Must this lock stop the user right now? Unknown status fails CLOSED.
function mustBlock(id) { var c = cacheGet(def(id)); return c.h !== false && !isUnlocked(id); }

/* ── Backend (the worker by default; ORCA passes its own) ───────────────── */
function post(path, body) {
  return fetch(WORKER + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (b) { b = b || {}; b._status = r.status; return b; });
  });
}
function idBody(d, extra) { return Object.assign({ journal: d.journal, entryId: d.entryId }, extra || {}); }
function mailBody(d) {
  var lbl = d.kind === 'profile' ? (d.label + "'s profile") : (d.kind === 'entry' ? d.label : ('the ' + d.label + ' ' + noun(d)));
  return { owner: d.owner, appName: d.appName || d.label, label: lbl };
}
var workerBackend = {
  verify: function (d, pw) { return post('/auth/journal/verify', idBody(d, { password: pw })); },
  set: function (d, pw, hint, current) { return post('/auth/journal/set-lock', idBody(d, { password: pw, hint: hint || '', current: current || undefined })); },
  remove: function (d, pw) { return post('/auth/journal/remove-lock', idBody(d, { password: pw })); },
  hint: function (d) { return post('/auth/journal/hint', idBody(d, mailBody(d))); },
  resetRequest: function (d) { return post('/auth/reset/request', idBody(d, mailBody(d))); },
  resetConfirm: function (d, code, pw, hint) { return post('/auth/reset/confirm', idBody(d, { code: code, password: pw, hint: hint || '' })); }
};
function be(d) { return d.backend || workerBackend; }

/* Recovery-mail relay. The worker mails hints and reset codes itself when it
   has a server-side sender (Brevo/Resend). When it can't, it returns a
   `relay` envelope addressed to the OWNER's Formspree form (Tony: xeedkebo,
   Veda: xzdlwaqg — chosen by the worker from `owner`, never by the page), and
   it is posted from here, because Formspree files worker-sent mail as spam. */
function mailRelay(res) {
  if (res && res.emailed) return Promise.resolve(true);
  var r = res && res.relay;
  if (!r || !r.form) return Promise.resolve(false);
  return fetch(r.form, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email: r.email, _subject: r.subject, subject: r.subject, message: r.message })
  }).then(function (out) {
    return out.json().catch(function () { return null; }).then(function (dd) {
      return !!out.ok && !(dd && (dd.ok === false || (dd.errors && dd.errors.length)));
    });
  }).catch(function () { return false; });
}

/* ── Status refresh ───────────────────────────────────────────────────────── */
var LAST = {}, INFLIGHT = null;
function applyStatus(d, h, v) {
  var old = cacheGet(d), m = markerGet(d), b = bioRec(d);
  cacheSet(d, { h: !!h, v: v || null, t: Date.now() });
  if (!h) { return; }
  if (m === '?') markerSet(d, v);
  if (b && b.ver === '?') { b.ver = v; jSet('gd.b.' + d.key, b); }
  var changed = m && m !== '?' && m !== v;
  if (changed) markerDel(d);
  if (b && b.ver !== '?' && b.ver !== v) { sDel('gd.b.' + d.key); sSet('gd.s.' + d.key, '1'); }
  if (changed || (old.h === false && !isUnlocked(d.id))) blocked(d, changed ? 'changed' : 'locked');
}
function refresh(ids, force) {
  var list = (ids == null ? Object.keys(DEFS) : [].concat(ids)).map(def).filter(function (d) {
    return force || !LAST[d.key] || Date.now() - LAST[d.key] > REFRESH_MIN_MS;
  });
  if (!list.length) return Promise.resolve();
  list.forEach(function (d) { LAST[d.key] = Date.now(); });
  var own = list.filter(function (d) { return !d.backend; });
  var custom = list.filter(function (d) { return d.backend; });
  var jobs = [];
  for (var i = 0; i < own.length; i += 60) (function (chunk) {
    jobs.push(post('/auth/journal/status-many', { locks: chunk.map(function (d) { return { journal: d.journal, entryId: d.entryId }; }) })
      .then(function (r) {
        if (!r || !r.ok || !r.locks) throw new Error('status');
        chunk.forEach(function (d) { var s = r.locks[d.key]; if (s) applyStatus(d, s.hasLock, s.ver); });
      }).catch(function () { chunk.forEach(function (d) { LAST[d.key] = 0; }); }));
  })(own.slice(i, i + 60));
  custom.forEach(function (d) {
    if (!d.backend.status) return;
    jobs.push(Promise.resolve(d.backend.status(d)).then(function (s) { if (s) applyStatus(d, s.hasLock, s.ver); })
      .catch(function () { LAST[d.key] = 0; }));
  });
  // A session lock (OneInbox, Insight) is also void once the server forgets its token.
  list.forEach(function (d) {
    if (!d.session || !d.session.check || !markerGet(d)) return;
    jobs.push(Promise.resolve(d.session.check()).then(function (ok) {
      if (ok === false) { markerDel(d); dropBio(d, true); blocked(d, 'session'); }
    }).catch(function () {}));
  });
  return Promise.all(jobs).then(function () { emit('status', { ids: list.map(function (d) { return d.id; }) }); });
}
function refreshOne(d) { return refresh([d.id], true); }

/* A lock became required while the program may be showing its content. */
function blocked(d, reason) {
  emit('lock', { id: d.id, reason: reason });
  if (d.onBlock) { try { d.onBlock(d.id, reason); } catch (e) {} return; }
  if (d.root && rootVisible(d)) { hideRoot(d); gate(d.id); }
}

/* ── Roots: the content a lock hides ─────────────────────────────────────── */
var PRE = null;
function rootSel(d) { return [].concat(d.root || []).join(','); }
function hideRoot(d) {
  if (!d.root) return;
  if (!PRE) { PRE = document.createElement('style'); PRE.id = 'guardian-prepaint'; (document.head || document.documentElement).appendChild(PRE); }
  if (PRE.textContent.indexOf('/*' + d.key + '*/') < 0) PRE.textContent += '/*' + d.key + '*/' + rootSel(d) + '{visibility:hidden!important}\n';
}
function showRoot(d) {
  if (!PRE || !d.root) return;
  PRE.textContent = PRE.textContent.split('\n').filter(function (l) { return l.indexOf('/*' + d.key + '*/') !== 0; }).join('\n');
}
function rootVisible(d) {
  try { return [].slice.call(document.querySelectorAll(rootSel(d))).some(function (el) { return el.getClientRects().length > 0; }); } catch (e) { return false; }
}
// Synchronous, before first paint: hide every declared root this device may not show yet.
function prepaint(ids) {
  [].concat(ids || Object.keys(DEFS)).forEach(function (id) { var d = def(id); if (d.root && mustBlock(id)) hideRoot(d); });
}

/* ── Biometrics (WebAuthn platform authenticator) ───────────────────────────
   Client-side presence check, keyed per lock: a lock's unlock only ever
   allows ITS OWN stored credential id, so one profile's fingerprint can never
   open another's. The credential ids are the ones the old per-program helper
   enrolled (adopted above), so the same Face ID / Windows Hello prompt keeps
   working. A credential is bound to the password `ver` it was enrolled under. */
function u8(b) { return new Uint8Array(b); }
function b64u(buf) { var b = u8(buf), s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(str) { str = String(str).replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; var bin = atob(str), b = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b.buffer; }
function rand(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
function bioSupported() { return !!(window.isSecureContext && window.PublicKeyCredential && navigator.credentials && navigator.credentials.create); }
var BIO_AVAIL = null;
function bioAvailable() {
  if (BIO_AVAIL) return BIO_AVAIL;
  if (!bioSupported() || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return (BIO_AVAIL = Promise.resolve(false));
  return (BIO_AVAIL = PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(function (v) { return !!v; }).catch(function () { return false; }));
}
function bioLabel() {
  var ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua)) return 'Face ID';
  if (/Android/.test(ua)) return 'fingerprint';
  if (/Windows/.test(ua)) return 'Windows Hello';
  if (/Mac/.test(ua)) return 'Touch ID';
  return 'biometrics';
}
function bioRec(d) { return jGet('gd.b.' + d.key); }
function bioValid(d) {
  var b = bioRec(d); if (!b || !b.id) return false;
  var c = cacheGet(d), m = markerGet(d);
  if (b.ver === '?' || c.v == null) return true;
  if (b.ver === c.v) return true;
  // Enrolled under an older password: void it, and remember to offer re-enrolment.
  sDel('gd.b.' + d.key); sSet('gd.s.' + d.key, '1');
  return false;
}
function bioIsRegistered(id) {
  var d = def(id);
  if (d.backend && d.backend.bio) return !!d.backend.bio.registered(d);
  return bioValid(d);
}
function dropBio(d, stale) { sDel('gd.b.' + d.key); if (stale) sSet('gd.s.' + d.key, '1'); }
function takeStale(d) { var s = sGet('gd.s.' + d.key) === '1'; sDel('gd.s.' + d.key); return s; }
function bioRegister(d) {
  if (d.backend && d.backend.bio) return Promise.resolve(d.backend.bio.register(d));
  if (!bioSupported()) return Promise.resolve({ ok: false, error: 'unsupported' });
  var salt = rand(32);
  return navigator.credentials.create({ publicKey: {
    challenge: rand(32),
    rp: { name: document.title || 'A1', id: location.hostname || undefined },
    user: { id: rand(16), name: 'a1-' + d.key, displayName: d.label + (d.kind === 'profile' ? ' profile' : '') },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    timeout: 60000, attestation: 'none', extensions: { prf: {} }
  } }).then(function (cred) {
    if (!cred) return { ok: false, error: 'cancelled' };
    var ext = {}; try { ext = cred.getClientExtensionResults() || {}; } catch (e) {}
    var c = cacheGet(d);
    sDel('gd.s.' + d.key);
    jSet('gd.b.' + d.key, { id: b64u(cred.rawId), ver: c.v || markerGet(d) || '?', created: Date.now(), prf: !!(ext.prf && ext.prf.enabled), prfSalt: b64u(salt) });
    return { ok: true };
  }).catch(function (e) { return { ok: false, error: (e && e.name) || 'error' }; });
}
function bioAuth(d, withPrf) {
  if (d.backend && d.backend.bio) return Promise.resolve(d.backend.bio.authenticate(d));
  if (!bioSupported()) return Promise.resolve({ ok: false, error: 'unsupported' });
  if (!bioValid(d)) return Promise.resolve({ ok: false, error: sGet('gd.s.' + d.key) === '1' ? 'stale' : 'notregistered' });
  var rec = bioRec(d), want = !!(withPrf && rec.prf && rec.prfSalt);
  var pk = { challenge: rand(32), allowCredentials: [{ type: 'public-key', id: unb64u(rec.id) }], userVerification: 'required', timeout: 60000, rpId: location.hostname || undefined };
  if (want) pk.extensions = { prf: { eval: { first: unb64u(rec.prfSalt) } } };
  return navigator.credentials.get({ publicKey: pk }).then(function (a) {
    if (!a) return { ok: false, error: 'cancelled' };
    if (!want) return { ok: true };
    var ext = {}; try { ext = a.getClientExtensionResults() || {}; } catch (e) {}
    var first = ext.prf && ext.prf.results && ext.prf.results.first;
    return first ? { ok: true, prf: b64u(first) } : { ok: false, error: 'noprf' };
  }).catch(function (e) { return { ok: false, error: (e && e.name) || 'error' }; });
}
function bioRemove(d) {
  if (d.backend && d.backend.bio && d.backend.bio.remove) return Promise.resolve(d.backend.bio.remove(d));
  dropBio(d, false); return Promise.resolve({ ok: true });
}

/* ── Offline verifier (offline:true — Shield, which must still let its owner
   lift Emergency Mode when the worker is unreachable). Same PBKDF2 shape as
   the KV record; adopts Shield's old sh_offline_<id>. ──────────────────── */
function b64(buf) { var b = u8(buf), s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
function unb64(str) { var bin = atob(str), b = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }
function pbkdf2(pw, salt, iter) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits'])
    .then(function (k) { return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' }, k, 256); })
    .then(b64);
}
function offlineWrite(d, pw) {
  if (!d.offline) return Promise.resolve();
  var salt = rand(16);
  return pbkdf2(pw, salt, 100000).then(function (h) { jSet('gd.o.' + d.key, { hash: h, salt: b64(salt), iter: 100000 }); }).catch(function () {});
}
function offlineVerify(d, pw) {
  var r = jGet('gd.o.' + d.key);
  if (!r) { try { r = JSON.parse(localStorage.getItem('sh_offline_' + d.entryId) || 'null'); } catch (e) {} }
  if (!r || !r.hash) return Promise.resolve({ ok: false, offlineUnavailable: true });
  return pbkdf2(pw, unb64(r.salt), r.iter || 100000).then(function (got) {
    var a = got, b = r.hash, diff = a.length ^ b.length;
    for (var i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return { ok: diff === 0, offline: true };
  }).catch(function () { return { ok: false }; });
}

/* ── Events ───────────────────────────────────────────────────────────────── */
function emit(name, detail) {
  try { window.dispatchEvent(new CustomEvent('guardian:' + name, { detail: detail || {} })); } catch (e) {}
}
function changed(d, what) {
  emit('change', { id: d.id, what: what });
  if (d.onChange) { try { d.onChange(d.id, what); } catch (e) {} }
}

/* ── Successful unlock bookkeeping ───────────────────────────────────────── */
var TRIES = {}, COOL = {};
function tooMany(d) {
  if ((TRIES[d.key] || 0) < MAX_TRIES) return 0;
  var w = Math.ceil(((COOL[d.key] || 0) - Date.now()) / 1000);
  if (w > 0) return w;
  TRIES[d.key] = 0; return 0;
}
function failed(d) { TRIES[d.key] = (TRIES[d.key] || 0) + 1; if (TRIES[d.key] >= MAX_TRIES) COOL[d.key] = Date.now() + COOLDOWN_MS; }
function markOpen(d) {
  TRIES[d.key] = 0;
  var c = cacheGet(d);
  markerSet(d, c.v || '?');
  showRoot(d);
  emit('unlock', { id: d.id });
  // Learn the current ver right away so the marker never stays '?' long.
  if (!c.v && !d.backend) refreshOne(d);
}

/* ═══════════════════════════════════ UI ═══════════════════════════════════ */
var FONT_HREF = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Manrope:wght@600;700;800&family=Lora:wght@500;600;700&display=swap';
function ensureFonts() {
  try {
    if (document.querySelector('link[data-guardian-fonts]')) return;
    var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = FONT_HREF; l.setAttribute('data-guardian-fonts', '');
    (document.head || document.documentElement).appendChild(l);
  } catch (e) {}
}
var CSS = [
':host{all:initial}',
'*{box-sizing:border-box}',
'.ov{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.62);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);font-family:var(--f);color:var(--tx);-webkit-font-smoothing:antialiased}',
/* Tony: MAGI tokens (magi.html :root, docs/theme-overhaul-plan.md §2). */
'.ov[data-theme=tony]{--bg:#1a1a1d;--s1:#232327;--s2:#2c2c31;--s3:#34343a;--bd:rgba(255,255,255,.06);--bdl:#45454c;--tx:#f4f3f0;--txd:#adadb2;--txm:#8d8d94;--ac:#c0aeea;--acl:#dbd0f5;--onac:#1a1a1d;--red:#d68a7c;--ring:rgba(192,174,234,.16);--f:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;--fd:"Manrope","Inter",system-ui,sans-serif;--r:8px;--rb:6px;--btn-fs:10px;--btn-tt:uppercase;--btn-ls:1px;--title-fs:22px;--title-w:800;--title-ls:-.3px}',
/* Veda: her TaskHub palette (index.html VD_T, Notebook/apps/brainstorm.css) — Lora titles, Inter body. */
'.ov[data-theme=veda]{--bg:#1B1C1E;--s1:#26272A;--s2:#2E2F33;--s3:#303135;--bd:#3D3E43;--bdl:#4A4B51;--tx:#ECECEE;--txd:#AFB0B5;--txm:#76777C;--ac:#8D769A;--acl:#A892B0;--onac:#ffffff;--red:#E07A6F;--ring:rgba(141,118,154,.24);--f:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;--fd:"Lora",Georgia,serif;--r:6px;--rb:6px;--btn-fs:13px;--btn-tt:none;--btn-ls:0;--title-fs:24px;--title-w:700;--title-ls:-.2px}',
'.card{position:relative;width:360px;max-width:100%;max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);overflow-y:auto;background:var(--s1);border:1px solid var(--bd);border-radius:var(--r);box-shadow:0 24px 64px rgba(0,0,0,.5);padding:30px 26px 18px;display:flex;flex-direction:column;align-items:center;gap:16px}',
'.card.shake{animation:gd-shake .4s ease}',
'@keyframes gd-shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}',
'.ic{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--ac);background:var(--s2);border:1px solid var(--bd)}',
'.ic svg{width:20px;height:20px}',
'.head{text-align:center;display:flex;flex-direction:column;gap:6px;width:100%}',
'.kick{font:700 10px/1 var(--f);letter-spacing:1.6px;text-transform:uppercase;color:var(--acl)}',
'.title{font-family:var(--fd);font-size:var(--title-fs);font-weight:var(--title-w);letter-spacing:var(--title-ls);color:var(--tx);line-height:1.2;word-break:break-word}',
'.sub{font:400 13px/1.5 var(--f);color:var(--txm)}',
'.body{width:100%;display:flex;flex-direction:column;gap:10px}',
'label.fl{display:flex;flex-direction:column;gap:5px;font:700 9px/1 var(--f);letter-spacing:1px;text-transform:uppercase;color:var(--txm);text-align:left}',
'.pw{position:relative;display:flex}',
'input{width:100%;background:var(--bg);border:1px solid var(--bdl);border-radius:var(--rb);color:var(--tx);font:600 15px var(--f);padding:12px 14px;outline:none;transition:border-color .18s,box-shadow .18s}',
'input.big{text-align:center;letter-spacing:3px;padding:13px 44px}',
'input:focus{border-color:var(--ac);box-shadow:0 0 0 3px var(--ring)}',
'input.bad{border-color:var(--red)}',
'.eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:0;color:var(--txm);cursor:pointer;padding:6px;display:flex;border-radius:4px}',
'.eye:hover{color:var(--txd)}.eye svg{width:16px;height:16px}',
'.err{font:600 12px/1.4 var(--f);color:var(--red);text-align:center;min-height:16px}',
'.note{font:500 12px/1.45 var(--f);color:var(--txd);text-align:center}',
'button.b{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:42px;padding:10px 14px;border-radius:var(--rb);border:1px solid var(--bdl);background:var(--s2);color:var(--tx);font:700 var(--btn-fs) var(--f);letter-spacing:var(--btn-ls);text-transform:var(--btn-tt);cursor:pointer;transition:filter .15s,border-color .15s,box-shadow .15s,transform .05s}',
'button.b svg{width:15px;height:15px;flex:none}',
'button.b.pri{background:var(--ac);border-color:var(--ac);color:var(--onac)}',
'button.b.ghost{background:transparent}',
'button.b.dg{background:transparent;color:var(--red);border-color:var(--red)}',
'button.b:disabled{opacity:.55;cursor:default}',
'button.b:focus-visible,.lk:focus-visible,.eye:focus-visible{outline:2px solid var(--ac);outline-offset:1px}',
'@media (hover:hover) and (pointer:fine){button.b:hover:not(:disabled){filter:brightness(1.15);border-color:var(--ac)}button.b.dg:hover:not(:disabled){border-color:var(--red);box-shadow:0 0 0 3px rgba(214,138,124,.16)}}',
'button.b:active:not(:disabled){filter:brightness(.94);transform:translateY(1px)}',
'.menu{display:flex;flex-direction:column;gap:8px;width:100%}',
'.menu button.b{justify-content:flex-start}',
'.links{display:flex;justify-content:center;flex-wrap:wrap;gap:4px 16px}',
'.lk{background:none;border:0;padding:2px 0;color:var(--txm);font:500 12px var(--f);cursor:pointer;text-decoration:underline;text-underline-offset:3px}',
'.lk:hover:not(:disabled){color:var(--txd)}.lk:disabled{cursor:default;opacity:.8}',
'.foot{width:100%;padding-top:12px;border-top:1px solid var(--bd);display:flex;justify-content:center}',
'.row2{display:flex;gap:8px;width:100%}',
'@media (max-width:520px){.card{width:100%;padding:26px 18px 16px}button.b{min-height:46px;font-size:max(var(--btn-fs),12px)}input{min-height:48px}}'
].join('\n');

var I = {
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2m-4 4 3 3m-6 0 2 2"/></svg>',
  bio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11c0 3.5-1 6.5-3 9"/><path d="M8.5 6.6A6 6 0 0 1 18 11c0 2-.2 4-.7 5.8"/><path d="M6 9a6 6 0 0 0-.5 2.4c0 1.6-.4 3.1-1 4.4"/><path d="M15 11.5c0 2.6-.5 5.1-1.6 7.3"/><path d="M12 8a3 3 0 0 0-3 3c0 1.2-.1 2.4-.4 3.5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.8-1.3M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>'
};

var HOST = null, ROOT = null, OPEN = null;   // OPEN = { d, resolve, value }
function mount() {
  if (HOST && HOST.isConnected) return;
  HOST = document.createElement('guardian-lock');
  HOST.setAttribute('data-guardian', '');
  ROOT = HOST.attachShadow ? HOST.attachShadow({ mode: 'open' }) : HOST;
  var st = document.createElement('style'); st.textContent = CSS; ROOT.appendChild(st);
  (document.body || document.documentElement).appendChild(HOST);
  ensureFonts();
}
function h(tag, attrs, kids) {
  var el = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function (k) {
    var v = attrs[k];
    if (v == null || v === false) return;
    if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  });
  [].concat(kids || []).forEach(function (c) { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return el;
}
function btn(cls, icon, text, onclick) { return h('button', { 'class': 'b ' + (cls || ''), type: 'button', onclick: onclick, html: (icon ? I[icon] : '') + '<span></span>' }); }
function setBtnText(b, t) { b.querySelector('span').textContent = t; return b; }
function B(cls, icon, text, onclick) { return setBtnText(btn(cls, icon, text, onclick), text); }
function pwField(ph, opts) {
  opts = opts || {};
  var inp = h('input', { type: 'password', placeholder: ph, autocomplete: opts.autocomplete || 'off', 'class': opts.big ? 'big' : '', spellcheck: 'false' });
  var eye = h('button', { 'class': 'eye', type: 'button', 'aria-label': 'Show password', html: I.eye });
  eye.onclick = function () { var show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; eye.innerHTML = show ? I.eyeOff : I.eye; eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); inp.focus(); };
  var wrap = h('div', { 'class': 'pw' }, [inp, eye]);
  wrap.input = inp;
  return wrap;
}
function field(label, el) { return h('label', { 'class': 'fl' }, [label, el]); }

/* Opens the card. Exactly one is open at a time: a new request settles the
   previous one as cancelled. `screen(d, card, done)` fills the card. */
function open(d, screen, onClose) {
  mount();
  if (OPEN) settle(OPEN.cancelValue);
  return new Promise(function (resolve) {
    var ov = h('div', { 'class': 'ov', 'data-theme': themeOf(d), role: 'dialog', 'aria-modal': 'true' });
    var card = h('div', { 'class': 'card' });
    ov.appendChild(card);
    [].slice.call(ROOT.querySelectorAll('.ov')).forEach(function (o) { o.remove(); });
    ROOT.appendChild(ov);
    OPEN = { d: d, ov: ov, card: card, resolve: resolve, cancelValue: onClose && onClose.cancelValue !== undefined ? onClose.cancelValue : false };
    ov.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && OPEN && OPEN.ov === ov && OPEN.escapable) { e.preventDefault(); settle(OPEN.cancelValue); }
    });
    screen(d, card);
    emit('open', { id: d.id });
  });
}
function settle(v) {
  if (!OPEN) return;
  var o = OPEN; OPEN = null;
  try { o.ov.remove(); } catch (e) {}
  emit('close', { id: o.d.id });
  o.resolve(v);
}
function fill(card, parts) {
  card.innerHTML = '';
  card.classList.remove('shake');
  parts.forEach(function (p) { if (p) card.appendChild(p); });
  var f = card.querySelector('input'); if (f) setTimeout(function () { try { f.focus(); } catch (e) {} }, 60);
}
function shake(card) { card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); }
function header(d, icon, kicker, sub) {
  return [
    h('div', { 'class': 'ic', html: I[icon] }),
    h('div', { 'class': 'head' }, [
      kicker ? h('div', { 'class': 'kick', text: kicker }) : null,
      h('div', { 'class': 'title', text: d.label }),
      sub ? h('div', { 'class': 'sub', text: sub }) : null
    ])
  ];
}
function footer(label, onclick) {
  return h('div', { 'class': 'foot' }, [h('button', { 'class': 'lk', type: 'button', text: label || 'Cancel', onclick: onclick })]);
}
function busy(b, on, text) { b.disabled = !!on; if (text) setBtnText(b, text); }
function netErr(r) {
  if (r && (r._status === 429 || r.error === 'throttled')) return 'Too many attempts. Try again in ' + Math.ceil((r.retryAfter || 900) / 60) + ' min.';
  return null;
}
function enterSubmits(inputs, b) {
  inputs.forEach(function (i) { i.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); b.click(); } }); });
}

/* ── Unlock ──────────────────────────────────────────────────────────────────
   opts.purpose: 'unlock' (default) | 'verify' (always asks; resolves the
   password) | 'removeBio' (identity check before dropping the biometric). */
function scrUnlock(d, card, opts) {
  opts = opts || {};
  var purpose = opts.purpose || 'unlock';
  if (OPEN) OPEN.escapable = !opts.hard;
  var sub = opts.message || (purpose === 'removeBio'
    ? 'Verify with ' + bioLabel() + ' or your password to remove biometrics from this device.'
    : purpose === 'verify' ? 'Enter your password to continue.'
    : 'Enter your password to open this ' + noun(d) + '.');
  var pw = pwField('Password', { big: true, autocomplete: 'current-password' });
  var err = h('div', { 'class': 'err' });
  var go = B('pri', null, purpose === 'removeBio' ? 'Verify' : purpose === 'verify' ? 'Continue' : 'Unlock');
  var bioBox = h('div', { 'class': 'menu' });
  var hint = h('button', { 'class': 'lk', type: 'button', text: 'Email me my hint' });
  var reset = h('button', { 'class': 'lk', type: 'button', text: 'Reset password' });
  var parts = header(d, purpose === 'removeBio' ? 'bio' : 'lock', OWNERS[d.owner] ? (OWNERS[d.owner] + ' · Locked') : 'Locked', sub)
    .concat([h('div', { 'class': 'body' }, [bioBox, pw, err, go, h('div', { 'class': 'links' }, [hint, reset])])]);
  if (!opts.hard) parts.push(footer('Cancel', function () { settle(OPEN ? OPEN.cancelValue : false); }));
  fill(card, parts);
  if (opts.error) err.textContent = opts.error;

  function success(password) {
    if (purpose === 'verify') { settle(password); return; }
    if (purpose === 'removeBio') {
      bioRemove(d).then(function () { emit('change', { id: d.id, what: 'bio' }); info(d, 'Biometrics removed', bioLabel() + ' no longer unlocks ' + d.label + ' on this device.', true); });
      return;
    }
    markOpen(d);
    var stale = takeStale(d);
    settle(true);
    if (password && stale) offerBio(d);
  }
  function wrong(msg) {
    failed(d);
    pw.input.value = ''; pw.input.classList.add('bad'); shake(card);
    err.textContent = tooMany(d) ? 'Too many attempts. Wait 30s.' : (msg || 'Wrong password.');
    setTimeout(function () { pw.input.classList.remove('bad'); }, 400);
  }
  go.onclick = function () {
    var p = pw.input.value;
    if (!p.trim()) { pw.input.classList.add('bad'); err.textContent = 'Password required.'; return; }
    var w = tooMany(d); if (w) { err.textContent = 'Too many attempts. Wait ' + w + 's.'; return; }
    busy(go, true, 'Checking…'); err.textContent = '';
    be(d).verify(d, p).then(function (r) {
      busy(go, false, purpose === 'removeBio' ? 'Verify' : purpose === 'verify' ? 'Continue' : 'Unlock');
      if (netErr(r)) { err.textContent = netErr(r); return; }
      if (r && r.noLock) {
        if (purpose === 'verify') { settle(p); return; }
        cacheSet(d, { h: false, v: null, t: Date.now() }); markOpen(d); settle(true); return;
      }
      if (!(r && r.ok)) { wrong(); return; }
      var after = function () {
        offlineWrite(d, p);
        if (purpose === 'unlock' && d.session && d.session.mint) {
          return Promise.resolve(d.session.mint(p)).then(function (ok) {
            if (ok === false) { err.textContent = 'Signed in, but the server session could not start. Try again.'; return; }
            success(p);
          });
        }
        success(p);
      };
      // Make sure the marker records the CURRENT ver, not a stale cached one.
      if (purpose === 'unlock' && !d.backend) refreshOne(d).then(after, after); else after();
    }).catch(function () {
      busy(go, false, purpose === 'verify' ? 'Continue' : 'Unlock');
      if (purpose === 'verify' && d.offline) {
        offlineVerify(d, p).then(function (o) {
          if (o.ok) settle(p);
          else if (o.offlineUnavailable) err.textContent = 'Offline, and no offline check is stored on this device.';
          else wrong();
        });
        return;
      }
      err.textContent = 'Network error. Try again.';
    });
  };
  enterSubmits([pw.input], go);
  hint.onclick = function () { sendHint(d, hint, err); };
  reset.onclick = function () { scrReset(d, card, opts); };

  // Biometric button: only when this device has a valid credential for this lock.
  if (purpose !== 'verify') bioAvailable().then(function (avail) {
    if (!OPEN || OPEN.card !== card) return;
    if (!avail) return;
    if (!bioIsRegistered(d.id)) {
      if (sGet('gd.s.' + d.key) === '1' && purpose === 'unlock') err.textContent = 'The password changed — enter the new one. ' + bioLabel() + ' needs registering again on this device.';
      return;
    }
    var bb = B('pri', 'bio', (purpose === 'removeBio' ? 'Verify with ' : 'Unlock with ') + bioLabel(), function () {
      err.textContent = '';
      bioAuth(d).then(function (r) {
        if (r.ok) {
          if (purpose === 'unlock' && d.session && d.session.check) {
            // The biometric only releases this device's server session; if the
            // server has forgotten it, the password has to start a new one.
            return Promise.resolve(d.session.check()).then(function (ok) {
              if (ok === false) { dropBio(d, true); bioBox.innerHTML = ''; err.textContent = 'Your session ended — enter your password.'; return; }
              success(null);
            });
          }
          success(null);
        } else if (r.error === 'stale') { bioBox.innerHTML = ''; err.textContent = 'The password changed — enter the new one. ' + bioLabel() + ' needs registering again on this device.'; }
        else if (r.error !== 'NotAllowedError' && r.error !== 'cancelled') err.textContent = 'Biometric check failed — use your password.';
      });
    });
    bioBox.appendChild(bb);
    go.classList.remove('pri');
  });
}

function sendHint(d, link, err) {
  link.disabled = true; link.textContent = 'Sending…'; err.textContent = '';
  be(d).hint(d).then(function (r) {
    if (r && r.noLock) { err.textContent = 'No password is set on the server for this ' + noun(d) + '.'; return false; }
    if (netErr(r)) { err.textContent = 'Too many emails just now. Try again in a few minutes.'; return false; }
    return mailRelay(r).then(function (ok) {
      if (!ok) { err.textContent = 'Could not send the hint. Try again.'; return false; }
      return true;
    });
  }).catch(function () { err.textContent = 'Network error. Try again.'; return false; })
    .then(function (ok) {
      link.textContent = ok ? 'Hint sent to ' + (OWNERS[d.owner] || 'your') + "'s email" : 'Email me my hint';
      setTimeout(function () { link.textContent = 'Email me my hint'; link.disabled = false; }, ok ? 4000 : 0);
    });
}

/* ── Reset by emailed code ─────────────────────────────────────────────────── */
function scrReset(d, card, back) {
  if (OPEN) OPEN.escapable = !(back && back.hard);
  var err = h('div', { 'class': 'err' });
  var send = B('pri', 'mail', 'Email me a code');
  var to = (OWNERS[d.owner] || 'the owner') + "'s email";
  var parts = header(d, 'mail', 'Reset password', 'We\'ll email a 6-character code to ' + to + '. Then choose a new password.')
    .concat([h('div', { 'class': 'body' }, [err, send])]);
  parts.push(footer('Back', function () { scrUnlock(d, card, back); }));
  fill(card, parts);
  send.onclick = function () {
    busy(send, true, 'Sending…'); err.textContent = '';
    be(d).resetRequest(d).then(function (r) {
      if (r && r.noLock) throw { msg: 'There is no password set on the server for this ' + noun(d) + '.' };
      if (netErr(r)) throw { msg: 'Too many reset emails just now. Wait a few minutes and try again.' };
      if (!r || !r.ok) throw { msg: 'Could not start the reset. Try again.' };
      return mailRelay(r).then(function (ok) { if (!ok) throw { msg: 'Could not send the reset email. Try again in a moment.' }; return r; });
    }).then(function (r) { scrResetCode(d, card, back, r.to); })
      .catch(function (e) { busy(send, false, 'Email me a code'); err.textContent = (e && e.msg) || 'Network error. Try again.'; });
  };
}
function scrResetCode(d, card, back, to) {
  var code = h('input', { type: 'text', placeholder: '6-character code', autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: 'false', 'class': 'big' });
  var np = pwField('New password', { autocomplete: 'new-password' }), np2 = pwField('Confirm new password', { autocomplete: 'new-password' });
  var hintIn = h('input', { type: 'text', placeholder: 'Optional', autocomplete: 'off' });
  var err = h('div', { 'class': 'err' });
  var go = B('pri', 'key', 'Reset password');
  var parts = header(d, 'mail', 'Check your email', 'A code was sent to ' + (to || ((OWNERS[d.owner] || 'your') + "'s email")) + '. Check spam if it isn\'t there in a minute.')
    .concat([h('div', { 'class': 'body' }, [field('Security code', code), field('New password', np), field('Confirm', np2), field('Password hint', hintIn), err, go])]);
  parts.push(footer('Back', function () { scrUnlock(d, card, back); }));
  fill(card, parts);
  go.onclick = function () {
    var c = code.value.trim(), p = np.input.value, p2 = np2.input.value;
    if (!c) { err.textContent = 'Enter the code from the email.'; return; }
    if (!p.trim()) { err.textContent = 'Choose a new password.'; return; }
    if (p !== p2) { err.textContent = 'The passwords don\'t match.'; np2.input.classList.add('bad'); return; }
    busy(go, true, 'Resetting…'); err.textContent = '';
    var hadBio = !!bioRec(d);
    be(d).resetConfirm(d, c, p, hintIn.value).then(function (r) {
      busy(go, false, 'Reset password');
      if (r && r.ok) {
        return refreshOne(d).catch(function () {}).then(function () {
          dropBio(d, false); markOpen(d); offlineWrite(d, p);
          if (d.session && d.session.mint) return Promise.resolve(d.session.mint(p));
        }).then(function () {
          changed(d, 'reset');
          info(d, 'Password reset', 'This device is unlocked. Every other device will ask for the new password once' + (hadBio ? ', and biometrics need registering again on each.' : '.'), false, function () {
            settle(true); if (hadBio) offerBio(d);
          });
        });
      }
      if (r && r.error === 'badcode') err.textContent = 'That code is not correct.' + (r.remaining != null ? ' ' + r.remaining + ' attempt(s) left.' : '');
      else if (r && r.error === 'expired') err.textContent = 'That code expired or was already used. Start again for a fresh one.';
      else if (r && r.error === 'locked') err.textContent = 'Too many wrong codes. Start again for a fresh one.';
      else err.textContent = 'Reset failed. Try again.';
    }).catch(function () { busy(go, false, 'Reset password'); err.textContent = 'Network error. Try again.'; });
  };
  enterSubmits([code, np.input, np2.input, hintIn], go);
}

/* ── Set a new lock ──────────────────────────────────────────────────────── */
function scrSet(d, card) {
  if (OPEN) OPEN.escapable = true;
  var np = pwField('New password', { autocomplete: 'new-password' }), np2 = pwField('Confirm password', { autocomplete: 'new-password' });
  var hintIn = h('input', { type: 'text', placeholder: 'Optional — emailed to you if you forget', autocomplete: 'off' });
  var err = h('div', { 'class': 'err' });
  var go = B('pri', 'lock', 'Set password');
  var sub = d.kind === 'profile' ? 'Choose a password for this profile. Each device asks for it once.'
    : 'Choose a password for this ' + noun(d) + '. Each device asks for it once.';
  fill(card, header(d, 'shield', 'New lock', sub).concat([
    h('div', { 'class': 'body' }, [field('Password', np), field('Confirm', np2), field('Password hint', hintIn), err, go]),
    footer('Cancel', function () { settle(false); })
  ]));
  go.onclick = function () {
    var p = np.input.value, p2 = np2.input.value;
    if (!p.trim()) { err.textContent = 'Choose a password.'; np.input.classList.add('bad'); return; }
    if (p !== p2) { err.textContent = 'The passwords don\'t match.'; np2.input.classList.add('bad'); return; }
    busy(go, true, 'Saving…'); err.textContent = '';
    be(d).set(d, p, hintIn.value).then(function (r) {
      busy(go, false, 'Set password');
      if (r && r.error === 'needs-current') { err.textContent = 'This ' + noun(d) + ' already has a password. Use Change password instead.'; return; }
      if (!(r && r.ok)) { err.textContent = netErr(r) || 'Could not set the password. Try again.'; return; }
      return refreshOne(d).catch(function () {}).then(function () {
        if (cacheGet(d).h !== true) cacheSet(d, { h: true, v: cacheGet(d).v, t: Date.now() });
        markOpen(d); offlineWrite(d, p);
        if (d.session && d.session.mint) return Promise.resolve(d.session.mint(p));
      }).then(function () { changed(d, 'set'); settle(true); offerBio(d); });
    }).catch(function () { busy(go, false, 'Set password'); err.textContent = 'Network error. Try again.'; });
  };
  enterSubmits([np.input, np2.input, hintIn], go);
}

/* ── Change password (ONE atomic set-lock with `current`) ──────────────────── */
function scrChange(d, card) {
  if (OPEN) OPEN.escapable = true;
  var cur = pwField('Current password', { autocomplete: 'current-password' });
  var np = pwField('New password', { autocomplete: 'new-password' }), np2 = pwField('Confirm new password', { autocomplete: 'new-password' });
  var hintIn = h('input', { type: 'text', placeholder: 'Optional', autocomplete: 'off' });
  var err = h('div', { 'class': 'err' });
  var go = B('pri', 'key', 'Change password');
  fill(card, header(d, 'key', 'Change password', 'Other devices will ask for the new password once. Biometrics must be registered again on every device.').concat([
    h('div', { 'class': 'body' }, [field('Current password', cur), field('New password', np), field('Confirm', np2), field('Password hint', hintIn), err, go]),
    footer('Back', function () { scrMenu(d, card); })
  ]));
  go.onclick = function () {
    var c = cur.input.value, p = np.input.value, p2 = np2.input.value;
    if (!c) { err.textContent = 'Enter your current password.'; cur.input.classList.add('bad'); return; }
    if (!p.trim()) { err.textContent = 'Choose a new password.'; return; }
    if (p !== p2) { err.textContent = 'The new passwords don\'t match.'; np2.input.classList.add('bad'); return; }
    var w = tooMany(d); if (w) { err.textContent = 'Too many attempts. Wait ' + w + 's.'; return; }
    busy(go, true, 'Changing…'); err.textContent = '';
    var hadBio = !!bioRec(d);
    be(d).set(d, p, hintIn.value, c).then(function (r) {
      busy(go, false, 'Change password');
      if (netErr(r)) { err.textContent = netErr(r); return; }
      if (r && r.error === 'needs-current') { failed(d); cur.input.value = ''; cur.input.classList.add('bad'); shake(card); err.textContent = tooMany(d) ? 'Too many attempts. Wait 30s.' : 'Current password is wrong.'; return; }
      if (!(r && r.ok)) { err.textContent = 'Could not change the password. Try again.'; return; }
      return refreshOne(d).catch(function () {}).then(function () {
        dropBio(d, false); markOpen(d); offlineWrite(d, p);
        if (d.session && d.session.mint) return Promise.resolve(d.session.mint(p));
      }).then(function () {
        changed(d, 'change');
        info(d, 'Password changed', 'Every other device will ask for the new password once' + (hadBio ? ', and biometrics need registering again on each — including this one.' : '.'), false, function () {
          settle(true); if (hadBio) offerBio(d);
        });
      });
    }).catch(function () { busy(go, false, 'Change password'); err.textContent = 'Network error. Try again.'; });
  };
  enterSubmits([cur.input, np.input, np2.input, hintIn], go);
}

/* ── Remove the lock ─────────────────────────────────────────────────────── */
function scrRemove(d, card) {
  if (OPEN) OPEN.escapable = true;
  var pw = pwField('Password', { big: true, autocomplete: 'current-password' });
  var err = h('div', { 'class': 'err' });
  var go = B('dg', 'trash', 'Remove lock');
  fill(card, header(d, 'unlock', 'Remove lock', 'Enter the password to remove this lock from every device.').concat([
    h('div', { 'class': 'body' }, [pw, err, go]),
    footer('Back', function () { scrMenu(d, card); })
  ]));
  go.onclick = function () {
    var p = pw.input.value;
    if (!p) { err.textContent = 'Password required.'; return; }
    var w = tooMany(d); if (w) { err.textContent = 'Too many attempts. Wait ' + w + 's.'; return; }
    busy(go, true, 'Removing…'); err.textContent = '';
    be(d).remove(d, p).then(function (r) {
      busy(go, false, 'Remove lock');
      if (netErr(r)) { err.textContent = netErr(r); return; }
      if (!(r && r.ok)) { failed(d); pw.input.value = ''; shake(card); err.textContent = tooMany(d) ? 'Too many attempts. Wait 30s.' : 'Wrong password.'; return; }
      cacheSet(d, { h: false, v: null, t: Date.now() }); markerDel(d); dropBio(d, false);
      sDel('gd.o.' + d.key); showRoot(d);
      if (d.session && d.session.end) { try { d.session.end(); } catch (e) {} }
      changed(d, 'remove'); settle(true);
    }).catch(function () { busy(go, false, 'Remove lock'); err.textContent = 'Network error. Try again.'; });
  };
  enterSubmits([pw.input], go);
}

/* ── The lock menu ───────────────────────────────────────────────────────── */
function scrMenu(d, card) {
  if (OPEN) OPEN.escapable = true;
  var open_ = isUnlocked(d.id);
  var menu = h('div', { 'class': 'menu' });
  if (!open_) menu.appendChild(B('pri', 'unlock', 'Unlock this device', function () { scrUnlock(d, card, {}); }));
  else menu.appendChild(B('pri', 'lock', 'Lock this device now', function () { lockNow(d.id); settle('locked'); }));
  var bioSlot = h('div', { 'class': 'menu' }); menu.appendChild(bioSlot);
  menu.appendChild(B('', 'key', 'Change password', function () { scrChange(d, card); }));
  if (d.allowRemove) menu.appendChild(B('dg', 'trash', 'Remove lock', function () { scrRemove(d, card); }));
  fill(card, header(d, 'lock', 'Lock settings', open_ ? 'Unlocked on this device.' : 'Locked on this device.').concat([
    menu, footer('Cancel', function () { settle(false); })
  ]));
  bioAvailable().then(function (avail) {
    if (!avail || !OPEN || OPEN.card !== card) return;
    if (bioIsRegistered(d.id)) bioSlot.appendChild(B('ghost', 'bio', 'Remove ' + bioLabel(), function () { scrUnlock(d, card, { purpose: 'removeBio' }); }));
    else bioSlot.appendChild(B('', 'bio', 'Register ' + bioLabel(), function () {
      var go = function () {
        bioRegister(d).then(function (r) {
          if (r.ok) { emit('change', { id: d.id, what: 'bio' }); info(d, bioLabel() + ' registered', 'You can now unlock ' + d.label + ' with ' + bioLabel() + ' on this device. Your password still works too.', true); }
          else if (r.error !== 'NotAllowedError' && r.error !== 'cancelled') info(d, 'Not registered', 'Could not register ' + bioLabel() + ' on this device.', true);
        });
      };
      // Only someone who can open the lock may enrol a fingerprint for it.
      if (isUnlocked(d.id)) go();
      else scrUnlock(d, card, {}), OPEN && (OPEN.afterUnlock = go);
    }));
  });
}

/* A one-button message inside the same card. */
function info(d, title, text, closeOnOk, then) {
  if (!OPEN) return;
  var card = OPEN.card; OPEN.escapable = true;
  var ok = B('pri', null, 'OK', function () { if (then) then(); else if (closeOnOk) settle(true); else settle(true); });
  fill(card, [h('div', { 'class': 'ic', html: I.shield }), h('div', { 'class': 'head' }, [h('div', { 'class': 'title', text: title }), h('div', { 'class': 'sub', text: text })]), h('div', { 'class': 'body' }, [ok])]);
  setTimeout(function () { try { ok.focus(); } catch (e) {} }, 60);
}

/* After a password proves who this is, offer to (re-)enrol biometrics. */
function offerBio(d) {
  bioAvailable().then(function (avail) {
    if (!avail || bioIsRegistered(d.id) || OPEN) return;
    open(d, function (dd, card) {
      OPEN.escapable = true;
      fill(card, header(d, 'bio', 'Biometrics', 'Use ' + bioLabel() + ' to unlock ' + d.label + ' on this device? Your password still works too.').concat([
        h('div', { 'class': 'body' }, [
          B('pri', 'bio', 'Register ' + bioLabel(), function () {
            bioRegister(d).then(function (r) { if (r.ok) emit('change', { id: d.id, what: 'bio' }); settle(true); });
          }),
          B('ghost', null, 'Not now', function () { settle(false); })
        ])
      ]));
    });
  });
}

/* ═════════════════════════════ Public API ════════════════════════════════ */

/* Resolves true once the lock is open on this device (immediately if it
   already is), false if the user cancels. opts: { hard, message } */
function gate(id, opts) {
  opts = opts || {};
  var d = def(id);
  var hard = opts.hard !== undefined ? !!opts.hard : d.hard;
  var c = cacheGet(d);
  var decide = function () {
    if (!mustBlock(id)) { showRoot(d); return Promise.resolve(true); }
    hideRoot(d);
    return open(d, function (dd, card) {
      scrUnlock(d, card, { hard: hard, message: opts.message });
    }).then(function (ok) {
      if (ok === true) { showRoot(d); var f = OPEN === null && d._after; }
      return ok === true;
    });
  };
  // Never seen this lock on this device: ask the worker first (fails closed).
  if (c.h === null && !markerGet(d)) return refreshOne(d).catch(function () {}).then(decide);
  // Known: answer from the cache now, and check for a newer password in the background.
  var p = decide();
  refresh([id]);
  return p;
}
/* The lock menu, or "set a password" when the lock doesn't exist yet. */
function manage(id) {
  var d = def(id);
  var run = function () {
    return open(d, function (dd, card) {
      if (isLocked(id)) scrMenu(d, card); else scrSet(d, card);
    }).then(function (v) {
      if (OPEN === null && v === true) { /* closed via a finished action */ }
      return v;
    });
  };
  var c = cacheGet(d);
  if (c.h === null) return refreshOne(d).catch(function () {}).then(run);
  return run();
}
function setLock(id) { var d = def(id); return open(d, function (dd, card) { scrSet(d, card); }).then(function (v) { return v === true; }); }
function changePassword(id) { var d = def(id); return open(d, function (dd, card) { scrChange(d, card); }).then(function (v) { return v === true; }); }
function removeLock(id) { var d = def(id); return open(d, function (dd, card) { scrRemove(d, card); }).then(function (v) { return v === true; }); }
/* Always asks — ignores the device marker. Resolves the password, or null. */
function verify(id, opts) {
  opts = opts || {};
  var d = def(id);
  return open(d, function (dd, card) { scrUnlock(d, card, { purpose: 'verify', message: opts.message, hard: opts.hard }); }, { cancelValue: null })
    .then(function (v) { return typeof v === 'string' ? v : null; });
}
/* Drop THIS device's unlock (password and other devices untouched). */
function lockNow(ids) {
  [].concat(ids).forEach(function (id) {
    var d = def(id);
    markerDel(d);
    // The old per-program markers too, so a page still reading them agrees.
    try { ['al_unlockedat_', 'al_unlockedv_', 'al_unlocked_'].forEach(function (p) { localStorage.removeItem(p + d.entryId); }); sessionStorage.removeItem('al_unlockedat_' + d.entryId); } catch (e) {}
    if (d.session && d.session.end) { try { d.session.end(); } catch (e) {} }
    emit('lock', { id: id, reason: 'manual' });
    if (d.onBlock) { try { d.onBlock(id, 'manual'); } catch (e) {} }
    else if (d.root && rootVisible(d)) { hideRoot(d); gate(id); }
  });
}

// Background: a password changed on another device re-locks this one.
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refresh(); });
window.addEventListener('focus', function () { refresh(); });
// Two tabs of the same origin: a lock/unlock in one is reflected in the other.
window.addEventListener('storage', function (e) {
  if (!e.key || e.key.indexOf('gd.') !== 0) return;
  emit('status', { ids: [] });
  Object.keys(DEFS).forEach(function (id) { var d = DEFS[id]; if (e.key === 'gd.u.' + d.key && e.newValue == null) lockNow(id); });
});

window.Guardian = {
  version: 1,
  define: define,
  defs: function () { return Object.keys(DEFS).map(function (k) { return Object.assign({}, DEFS[k]); }); },
  label: function (id) { return def(id).label; },
  owner: function (id) { return def(id).owner; },
  gate: gate,
  manage: manage,
  setLock: setLock,
  changePassword: changePassword,
  removeLock: removeLock,
  verify: verify,
  lockNow: lockNow,
  isLocked: isLocked,
  isUnlocked: isUnlocked,
  mustBlock: mustBlock,
  status: function (id) { var c = cacheGet(def(id)); return { hasLock: c.h, ver: c.v, unlocked: isUnlocked(id) }; },
  refresh: function (ids, force) { return refresh(ids, force !== false); },
  prepaint: prepaint,
  hideRoot: function (id) { hideRoot(def(id)); },
  showRoot: function (id) { showRoot(def(id)); },
  isOpen: function () { return !!OPEN; },
  close: function () { settle(OPEN ? OPEN.cancelValue : false); },
  bio: {
    available: bioAvailable,
    label: bioLabel,
    isRegistered: bioIsRegistered,
    authenticate: function (id, o) { return bioAuth(def(id), o && o.withPrf); },
    hasPrf: function (id) { var b = bioRec(def(id)); return !!(b && b.prf && b.prfSalt); }
  },
  mailRelay: mailRelay,
  legacy: legacy,
  WORKER: WORKER
};
emit('ready');
})();
