/* ═══════════════════════════════════════════════════════════════════════════
   Beacon: A1's device manager.
   Contract: docs/Beacon/README.md

   Every program that has profiles or sends notifications loads this ONE live
   file ("Beacon/beacon.js" in A1, the absolute Pages URL elsewhere, never with
   ?v=) and declares itself:

       Beacon.mount('mylist', { label: 'MyList', profileAttr: 'data-profile', push: fn });
       button.onclick = () => Beacon.open({ app: 'mylist' });

   The device then checks in to Firestore: one document per owner,
   dashboards/beacon_tony, beacon_veda and beacon_neutral. Each device lists
   its model, the programs it runs, whether each one can notify it, and the
   state of each Guardian lock there. The panel (beacon-ui.js, loaded the first
   time someone opens it) reads only the viewer's document and the neutral one,
   so it can never show the other person's devices.

   Removing or locking a device from the panel leaves a command in the owner's
   document. The device carries it out the next time any A1 program opens
   there: Guardian drops every unlock on it, and a removed device stops
   checking in for that session. Its push tokens are deleted right away, so
   notifications stop at once.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';
if (window.Beacon) return;

var VERSION = 1;
var SCRIPT = document.currentScript;
var BASE = (SCRIPT && SCRIPT.src) ? SCRIPT.src.replace(/[?#].*$/, '').replace(/[^\/]*$/, '') : 'https://anthonyn99.github.io/A1/Beacon/';
var FB_VER = '12.12.0';
var FB_CONFIG = {
  apiKey: 'AIzaSyC2aKunOKj5WS8NpgZhpyMzOYecBr5t2_4',
  authDomain: 'task-dashboard-d2b53.firebaseapp.com',
  projectId: 'task-dashboard-d2b53',
  storageBucket: 'task-dashboard-d2b53.firebasestorage.app',
  messagingSenderId: '982539604706',
  appId: '1:982539604706:web:e93da1aef499fcee2044bb'
};
var APPCHECK_KEY = '6LeUyAstAAAAAEciRypd1i4Akq6ueFUYfXLaLaUX';
var COLL = 'dashboards';
var DOCS = { tony: 'beacon_tony', veda: 'beacon_veda', neutral: 'beacon_neutral' };
// TaskHub's and MyList's push tokens (index.html ensureFCMToken), keyed by
// this same device id. Read by the panel so a device that gets notifications
// shows up even if it has not opened anything since Beacon arrived.
var FCM = 'fcm_tokens';
var APP_NAMES = { taskhub: 'TaskHub', mylist: 'MyList', magi: 'MAGI', shield: 'Shield', shruti: 'Shruti', studyos: 'StudyOS' };
var READ_GAP = 90 * 1000;              // at most one check-in read per program per 90 s
var WRITE_GAP = 6 * 3600 * 1000;       // an unchanged record is re-stamped every 6 h
var POLL = 5 * 60 * 1000;              // while visible, look for commands every 5 min
var PAGE_START = Date.now();
var ID_RE = /^[A-Za-z0-9_-]{4,80}$/;

/* ── Storage (every call guarded: Veda's Brave can block storage outright) ── */
var MEM = {};
function lsGet(k) {
  try { var v = localStorage.getItem(k); if (v !== null) return v; } catch (e) {}
  return Object.prototype.hasOwnProperty.call(MEM, k) ? MEM[k] : null;
}
function lsSet(k, v) { MEM[k] = String(v); try { localStorage.setItem(k, String(v)); } catch (e) {} }
function lsDel(k) { delete MEM[k]; try { localStorage.removeItem(k); } catch (e) {} }
function jGet(k) { try { return JSON.parse(lsGet(k) || 'null'); } catch (e) { return null; } }
function jSet(k, o) { lsSet(k, JSON.stringify(o)); }
function cookieGet(n) {
  try {
    var parts = document.cookie.split('; ');
    for (var i = 0; i < parts.length; i++) if (parts[i].indexOf(n + '=') === 0) return decodeURIComponent(parts[i].slice(n.length + 1));
  } catch (e) {}
  return null;
}
function cookieSet(n, v) {
  try {
    document.cookie = n + '=' + encodeURIComponent(v) + '; path=/; SameSite=Lax; Max-Age=' + (400 * 86400) +
      (location.protocol === 'https:' ? '; Secure' : '');
  } catch (e) {}
}

/* ── This device's id ─────────────────────────────────────────────────────
   TaskHub's own th_device_id, so a record here and its fcm_tokens doc share
   one key. Mirrored in a 400-day cookie: a browser that evicts localStorage
   gets its old id back instead of turning into a second device. If neither
   store keeps anything, a fingerprint of the browser keeps the id stable. */
var DEV_ID = null;
function hashStr(s) {
  var h1 = 5381, h2 = 52711;
  for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); h1 = (h1 * 33) ^ c; h2 = (h2 * 33) ^ c; }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
function fingerprint() {
  var n = navigator, s = window.screen || {};
  var tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
  return hashStr([n.userAgent, n.language, n.platform, n.hardwareConcurrency, n.maxTouchPoints, s.width, s.height, window.devicePixelRatio, tz].join('|'));
}
function deviceId() {
  if (DEV_ID) return DEV_ID;
  var id = null;
  try { id = localStorage.getItem('th_device_id'); } catch (e) {}
  if (!id || !ID_RE.test(id)) id = cookieGet('a1dev');
  if (!id || !ID_RE.test(id)) {
    id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    var kept = false;
    try { localStorage.setItem('th_device_id', id); kept = localStorage.getItem('th_device_id') === id; } catch (e) {}
    cookieSet('a1dev', id);
    if (cookieGet('a1dev') === id) kept = true;
    if (!kept) id = 'fp_' + fingerprint();
  } else {
    try { if (localStorage.getItem('th_device_id') !== id) localStorage.setItem('th_device_id', id); } catch (e) {}
    if (cookieGet('a1dev') !== id) cookieSet('a1dev', id);
  }
  return (DEV_ID = id);
}

/* ── What this device is ─────────────────────────────────────────────────
   Browsers never reveal a device's own name, so the name is the model until
   someone renames it. detect() is pure (the tests feed it user agents). */
var IPHONES = {
  '320x568': 'iPhone SE (1st gen)', '375x667': 'iPhone SE / 8', '414x736': 'iPhone 8 Plus',
  '375x812': 'iPhone X / 11 Pro / mini', '414x896': 'iPhone 11 / XR', '390x844': 'iPhone 12 / 13 / 14',
  '428x926': 'iPhone 13 Pro Max / 14 Plus', '393x852': 'iPhone 15 / 16', '430x932': 'iPhone 15 Pro Max / 16 Plus',
  '402x874': 'iPhone 16 Pro / 17', '420x912': 'iPhone Air', '440x956': 'iPhone 16 / 17 Pro Max'
};
function brandOf(n, ua, extra) {
  var brands = (n.userAgentData && n.userAgentData.brands) || [];
  var names = brands.map(function (b) { return b.brand; }).join('|');
  if (/EdgA?\/|EdgiOS\/|Edg\//.test(ua) || /Microsoft Edge/.test(names)) return 'Edge';
  if (/OPR\/|OPiOS\/|Opera/.test(ua) || /Opera/.test(names)) return 'Opera';
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/DuckDuckGo\//.test(ua)) return 'DuckDuckGo';
  if (/FxiOS\/|Firefox\//.test(ua)) return 'Firefox';
  if (extra.brave || /Brave/.test(names)) return 'Brave';
  if (/CriOS\/|Chrome\//.test(ua) || /Google Chrome|Chromium/.test(names)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return '';
}
function detect(n, scr, extra) {
  n = n || navigator; scr = scr || window.screen || {}; extra = extra || {};
  var ua = String(n.userAgent || ''), uad = n.userAgentData || null, he = extra.he || null;
  var touch = (n.maxTouchPoints || 0) > 1;
  var r = { kind: 'computer', os: '', osVer: '', browser: brandOf(n, ua, extra), model: '', hint: '', app: !!extra.standalone };
  var m;
  if (/iPhone|iPod/.test(ua)) { r.os = 'iOS'; r.kind = 'phone'; r.model = 'iPhone'; }
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) { r.os = 'iPadOS'; r.kind = 'tablet'; r.model = 'iPad'; }
  else if (/Android/.test(ua)) { r.os = 'Android'; r.kind = (/Mobile/.test(ua) || (uad && uad.mobile)) ? 'phone' : 'tablet'; }
  else if (/CrOS/.test(ua)) { r.os = 'ChromeOS'; r.kind = 'laptop'; r.model = 'Chromebook'; }
  else if (/Windows/.test(ua)) { r.os = 'Windows'; }
  else if (/Macintosh|Mac OS X/.test(ua)) { r.os = 'macOS'; r.model = 'Mac'; }
  else if (/Linux|X11/.test(ua)) { r.os = 'Linux'; }

  if (r.os === 'iOS' || r.os === 'iPadOS') {
    // Safari 26 freezes "OS 18_6" in the agent string but tells the truth in Version/.
    var os = /OS (\d+)[_.](\d+)/.exec(ua), ver = /Version\/(\d+)(?:\.(\d+))?/.exec(ua);
    if (ver && (+ver[1] >= 26 || !os || r.os === 'iPadOS')) r.osVer = ver[1] + (ver[2] && ver[2] !== '0' ? '.' + ver[2] : '');
    else if (os) r.osVer = os[1] + (os[2] !== '0' ? '.' + os[2] : '');
    if (r.os === 'iOS') {
      var w = Math.min(scr.width || 0, scr.height || 0), h = Math.max(scr.width || 0, scr.height || 0);
      r.hint = IPHONES[w + 'x' + h] || '';
    }
  } else if (r.os === 'Android') {
    m = /Android (\d+(?:\.\d+)?)/.exec(ua);
    // Chrome's reduced agent string is always "Android 10; K": neither is real.
    var reduced = /Android 10; K\)/.test(ua);
    if (m && !reduced) r.osVer = m[1].replace(/\.0$/, '');
    m = /Android [^;)]*; ([^;)]+?)(?: Build[^;)]*)?\)/.exec(ua);
    if (m && m[1] !== 'K' && !/^wv$/.test(m[1])) r.model = m[1].trim();
    if (he && he.model) r.model = he.model;
    if (he && he.platformVersion) r.osVer = String(he.platformVersion).split('.')[0];
    if (/^SM-/.test(r.model)) r.model = 'Samsung ' + r.model;
  } else if (r.os === 'Windows') {
    if (he && he.platformVersion) r.osVer = (+String(he.platformVersion).split('.')[0] >= 13) ? '11' : '10';
    if (touch || extra.laptop) r.kind = 'laptop';
  } else if (r.os === 'macOS') {
    if (he && he.platformVersion) r.osVer = String(he.platformVersion).split('.').slice(0, 2).join('.').replace(/\.0$/, '');
    if (extra.laptop) { r.kind = 'laptop'; r.model = 'MacBook'; }
  } else if (r.os === 'Linux' && extra.laptop) r.kind = 'laptop';
  return r;
}
function defaultName(d) {
  d = d || {};
  if (d.model) return d.model;
  if (d.os === 'Android') return d.kind === 'tablet' ? 'Android tablet' : 'Android phone';
  if (d.os === 'Windows') return d.kind === 'laptop' ? 'Windows laptop' : 'Windows PC';
  if (d.os === 'Linux') return d.kind === 'laptop' ? 'Linux laptop' : 'Linux PC';
  if (d.os === 'macOS') return 'Mac';
  return d.kind === 'phone' ? 'Phone' : d.kind === 'tablet' ? 'Tablet' : 'Computer';
}
function isStandalone() {
  try {
    if (navigator.standalone) return true;
    return ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'].some(function (m) {
      return window.matchMedia && window.matchMedia('(display-mode: ' + m + ')').matches;
    });
  } catch (e) { return false; }
}
var FULL = null;
function detectFull() {
  if (FULL) return FULL;
  FULL = (async function () {
    var extra = { standalone: isStandalone(), brave: false, laptop: lsGet('a1.beacon.laptop') === '1' };
    try { if (navigator.brave && navigator.brave.isBrave) extra.brave = !!(await navigator.brave.isBrave()); } catch (e) {}
    try {
      var uad = navigator.userAgentData;
      if (uad && uad.getHighEntropyValues) extra.he = await uad.getHighEntropyValues(['model', 'platformVersion']);
    } catch (e) {}
    // A battery that is below full or running down means a laptop; a desktop
    // reports a full, charging "battery". Once seen, remembered.
    try {
      if (!extra.laptop && navigator.getBattery) {
        var b = await navigator.getBattery();
        if (b && (b.level < 0.995 || b.charging === false)) { extra.laptop = true; lsSet('a1.beacon.laptop', '1'); }
      }
    } catch (e) {}
    return detect(navigator, window.screen, extra);
  })();
  return FULL;
}

/* ── Firebase ─────────────────────────────────────────────────────────────
   Same order as LifeHub: the program's own instance when it hands one over
   (mount option `firebase`, or window.LifeHubFirebase), else the page's
   [DEFAULT] app if it is A1's project, else a memory-cache app of our own. */
var OVERRIDE = null;   // Beacon.config({ firebase }) (tests)
var HOSTFB = null;     // the first mount's `firebase` option
function fbVersion() {
  try {
    var r = performance.getEntriesByType('resource');
    for (var i = 0; i < r.length; i++) {
      var m = /firebasejs\/([\d.]+)\/firebase-(?:app|firestore)\.js/.exec(r[i].name);
      if (m) return m[1];
    }
  } catch (e) {}
  return FB_VER;
}
function waitFor(fn, ms) {
  return new Promise(function (res) {
    var t0 = Date.now();
    (function poll() {
      var v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v || Date.now() - t0 >= ms) return res(v || null);
      setTimeout(poll, 150);
    })();
  });
}
var CONN = null;
function connect() {
  if (!CONN) {
    CONN = openFirestore();
    CONN.catch(function () { CONN = null; });
  }
  return CONN;
}
async function fsModule(h) {
  if (h && h.fs) return h.fs;
  return import('https://www.gstatic.com/firebasejs/' + fbVersion() + '/firebase-firestore.js');
}
async function openFirestore() {
  var hook = (OVERRIDE && OVERRIDE.firebase) || HOSTFB;
  // 'lifehub': the program hands its Firebase to LifeHub from a module that
  // may not have run yet (MAGI, Shruti, StudyOS); wait for it, never race it
  // with an app of our own.
  if (hook === 'lifehub') {
    hook = await waitFor(function () { return typeof window.LifeHubFirebase === 'function' ? window.LifeHubFirebase : null; }, 15000);
    if (!hook) throw new Error('LifeHubFirebase never appeared');
  }
  if (!hook && typeof window.LifeHubFirebase === 'function') hook = window.LifeHubFirebase;
  if (hook) {
    var h = await hook();
    if (!h || !h.db) throw new Error('host Firebase unavailable');
    return { db: h.db, fs: await fsModule(h) };
  }
  var V = 'https://www.gstatic.com/firebasejs/' + fbVersion();
  var mods = await Promise.all([import(V + '/firebase-app.js'), import(V + '/firebase-auth.js'), import(V + '/firebase-firestore.js')]);
  var appM = mods[0], authM = mods[1], fs = mods[2];
  function defApp() {
    var a = appM.getApps();
    for (var i = 0; i < a.length; i++) if (a[i].name === '[DEFAULT]') return a[i];
    return null;
  }
  var app = await waitFor(defApp, 4000), db = null, own = false;
  if (app && app.options && app.options.projectId && app.options.projectId !== FB_CONFIG.projectId) app = null;
  if (!app) {
    own = true;
    app = appM.getApps().filter(function (a) { return a.name === 'a1-beacon'; })[0] || appM.initializeApp(FB_CONFIG, 'a1-beacon');
    try {
      var ac = await import(V + '/firebase-app-check.js');
      ac.initializeAppCheck(app, { provider: new ac.ReCaptchaV3Provider(APPCHECK_KEY), isTokenAutoRefreshEnabled: true });
    } catch (e) {}
    try { db = fs.initializeFirestore(app, { localCache: fs.memoryLocalCache() }); } catch (e) { db = fs.getFirestore(app); }
  } else {
    // Never claim the host's Firestore before it has made it (LifeHub's rule).
    var ready = typeof appM._getProvider === 'function'
      ? await waitFor(function () { return appM._getProvider(app, 'firestore').isInitialized(); }, 6000) : true;
    if (ready) db = fs.getFirestore(app);
    else { try { db = fs.initializeFirestore(app, { localCache: fs.memoryLocalCache() }); } catch (e) { db = fs.getFirestore(app); } }
  }
  var auth = authM.getAuth(app);
  try { if (auth.authStateReady) await auth.authStateReady(); } catch (e) {}
  if (!auth.currentUser && !own) {
    await new Promise(function (res) {
      var t = setTimeout(done, 5000), off = null;
      function done() { clearTimeout(t); try { off && off(); } catch (e) {} res(); }
      off = authM.onAuthStateChanged(auth, function (u) { if (u) done(); });
    });
  }
  if (!auth.currentUser) await authM.signInAnonymously(auth);
  return { db: db, fs: fs };
}
function docRef(c, owner) { return c.fs.doc(c.db, COLL, DOCS[owner]); }
// updateDoc replaces exactly the named fields; a missing document is created
// with the same content as a merge.
async function patch(c, owner, fields, nested) {
  var ref = docRef(c, owner);
  try { await c.fs.updateDoc(ref, fields); }
  catch (e) {
    if (!e || e.code !== 'not-found') throw e;
    await c.fs.setDoc(ref, nested, { merge: true });
  }
}
function one(obj, path, v) {   // {'a.b.c': v} → {a:{b:{c:v}}}
  var parts = path.split('.'), o = obj;
  for (var i = 0; i < parts.length - 1; i++) o = o[parts[i]] || (o[parts[i]] = {});
  o[parts[parts.length - 1]] = v;
  return obj;
}
function nest(fields) { var o = {}; Object.keys(fields).forEach(function (k) { one(o, k, fields[k]); }); return o; }

/* ── Programs on this page ──────────────────────────────────────────────── */
var HOSTS = {};
function validProfile(p) { return p === 'tony' || p === 'veda' ? p : null; }
function profileOf(h) {
  var p = null;
  try {
    if (typeof h.profile === 'function') p = h.profile();
    else if (h.profile) p = h.profile;
    else if (h.profileAttr) {
      p = (document.body && document.body.getAttribute(h.profileAttr)) || document.documentElement.getAttribute(h.profileAttr);
    }
  } catch (e) { p = null; }
  return validProfile(p);
}
// Who a device belongs to. On A1's own origin TaskHub's "main" decides, the
// one link A1 already keeps between a device and a person (index.html
// _thUnsetMainDash): Tony, Veda, or "none", which is a neutral device. A
// device TaskHub never claimed keeps whoever first used it here.
function ownerFor(profile) {
  var md = lsGet('td6_mainDash');
  if (md === 'tony' || md === 'veda') return md;
  if (md === 'none') return 'neutral';
  var c = lsGet('a1.beacon.owner');
  if (c === 'tony' || c === 'veda' || c === 'neutral') return c;
  return profile;
}
function lockList(h, profile) {
  var G = window.Guardian;
  if (!G || typeof G.defs !== 'function') return [];
  var ids;
  try {
    ids = typeof h.locks === 'function' ? h.locks(profile) : G.defs()
      .filter(function (d) { return d.kind === 'app' || d.kind === 'profile' || d.kind === 'tab'; })
      .map(function (d) { return d.id; });
  } catch (e) { ids = []; }
  var out = [];
  (ids || []).forEach(function (id) {
    try {
      var st = G.status(id);
      if (!st || st.hasLock !== true) return;
      out.push({
        id: id, label: G.label(id), owner: G.owner(id),
        open: !!st.unlocked,
        bio: !!(G.bio && G.bio.isRegistered && G.bio.isRegistered(id))
      });
    } catch (e) {}
  });
  out.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
  return out.slice(0, 40);
}
// A program whose lock is not Guardian's markers (ORCA: a server session per
// profile) reports it itself: lockState(profile) -> [{id, label, owner, open, bio}].
async function hostLocks(h, profile) {
  if (typeof h.lockState !== 'function') return [];
  try {
    var list = await h.lockState(profile);
    return (Array.isArray(list) ? list : []).filter(function (l) { return l && l.id; }).map(function (l) {
      return { id: String(l.id), label: String(l.label || l.id), owner: validProfile(l.owner) || profile, open: !!l.open, bio: !!l.bio };
    });
  } catch (e) { return []; }
}
function permission() {
  try { return ('Notification' in window) ? Notification.permission : 'unsupported'; } catch (e) { return 'unsupported'; }
}
async function pushOf(h) {
  if (!h.push) return null;
  var p = {};
  if (typeof h.push === 'function') {
    try { p = (await h.push()) || {}; } catch (e) { p = {}; }
  }
  var out = { perm: p.perm || permission(), on: !!p.on };
  if (p.coll && p.id) { out.coll = String(p.coll); out.id = String(p.id); }
  if (p.route != null) out.route = String(p.route);
  return out;
}

/* ── Check-in ─────────────────────────────────────────────────────────────── */
var STATE = {};     // app → { reading, lastRead, timer }
var REMOVED = false;
function removedHere() {
  if (REMOVED) return true;
  var at = +lsGet('a1.beacon.removedAt') || 0;
  return at >= PAGE_START;
}
function checkable() {
  // Loopback (MAGI's own console on the PC) and file:// would be a second,
  // differently keyed copy of a device that already checks in from Pages.
  return /^https:$/.test(location.protocol) && !/^(127\.|localhost$|\[::1\]$)/.test(location.hostname);
}
function sigOf(meta, entry) {
  return hashStr(JSON.stringify([meta, entry.label, Object.keys(entry.profs || {}).sort(), entry.locks, entry.push || null]));
}
async function checkIn(app, force) {
  var h = HOSTS[app];
  if (!h || removedHere() || (!checkable() && !(OVERRIDE && OVERRIDE.anyOrigin))) return { skipped: 'origin' };
  var st = STATE[app] || (STATE[app] = {});
  var profile = profileOf(h);
  if (!profile) return { skipped: 'profile' };
  if (st.reading) return st.reading;
  if (!force && st.lastRead && Date.now() - st.lastRead < READ_GAP) return { skipped: 'recent' };
  st.lastRead = Date.now();
  st.reading = (async function () {
    var owner = ownerFor(profile);
    if (!lsGet('a1.beacon.owner')) lsSet('a1.beacon.owner', owner);
    var id = deviceId();
    var c = await connect();
    var snap = await c.fs.getDoc(docRef(c, owner));
    var data = (snap && snap.exists && snap.exists()) ? (snap.data() || {}) : {};
    if (data.gone && data.gone[id]) return applyRemoval(c, owner);
    if (data.cmd && data.cmd[id]) await applyCmd(c, owner, data.cmd[id]);

    // Moved owner (TaskHub's main changed): take the record out of the old document.
    var reg = jGet('a1.beacon.reg') || {};
    if (reg.owner && reg.owner !== owner && DOCS[reg.owner]) {
      var f = {}; f['devices.' + id] = c.fs.deleteField();
      try { await c.fs.updateDoc(docRef(c, reg.owner), f); } catch (e) {}
      reg = {};
    }
    var rec = (data.devices || {})[id] || null;
    var prev = (rec && rec.apps && rec.apps[app]) || {};
    var now = Date.now();
    var profs = {}; Object.keys(prev.profs || {}).forEach(function (k) { if (validProfile(k)) profs[k] = prev.profs[k]; });
    profs[profile] = now;
    var entry = { label: h.label || APP_NAMES[app] || app, seen: now, profs: profs, locks: lockList(h, profile).concat(await hostLocks(h, profile)).slice(0, 40) };
    var push = await pushOf(h);
    if (push) entry.push = push;
    var meta = await detectFull();
    var sig = sigOf(meta, entry);
    var mine = (reg.apps || {})[app] || {};
    var fresh = rec && rec.apps && rec.apps[app] && mine.sig === sig && now - (mine.at || 0) < WRITE_GAP && reg.owner === owner;
    if (fresh && !force) return { wrote: false, owner: owner };
    if (fresh && force && now - (mine.at || 0) < 60 * 1000) return { wrote: false, owner: owner };
    var p = 'devices.' + id;
    var fields = {};
    fields[p + '.meta'] = meta;
    fields[p + '.seen'] = now;
    fields[p + '.apps.' + app] = entry;
    if (!rec || !rec.first) fields[p + '.first'] = now;
    await patch(c, owner, fields, nest(fields));
    reg = jGet('a1.beacon.reg') || {};
    if (reg.owner !== owner) reg = { owner: owner, apps: {} };
    reg.apps = reg.apps || {};
    reg.apps[app] = { sig: sig, at: now };
    jSet('a1.beacon.reg', reg);
    emit('checkin', { app: app, owner: owner });
    return { wrote: true, owner: owner };
  })();
  try { return await st.reading; }
  catch (e) { st.lastRead = 0; return { error: String(e && (e.message || e)) }; }
  finally { st.reading = null; }
}
function schedule(app, ms, force) {
  var st = STATE[app] || (STATE[app] = {});
  clearTimeout(st.timer);
  st.timer = setTimeout(function () { checkIn(app, force); }, ms);
}
function scheduleAll(ms, force) { Object.keys(HOSTS).forEach(function (a) { schedule(a, ms, force); }); }

/* ── Commands left by the panel ──────────────────────────────────────────── */
function guardianLockDevice(reason) {
  var G = window.Guardian;
  if (!G || typeof G.lockDevice !== 'function') return false;
  try { G.lockDevice(reason); return true; } catch (e) { return false; }
}
// Programs that lock this device their own way (lockNow, e.g. ORCA ending its
// server session). Run LAST: one may leave the page.
function hostLockers() {
  return Object.keys(HOSTS).map(function (a) { return HOSTS[a]; }).filter(function (h) { return typeof h.lockNow === 'function'; });
}
async function runHostLocks(list, reason) {
  for (var i = 0; i < list.length; i++) { try { await list[i].lockNow(reason); } catch (e) {} }
}
async function applyCmd(c, owner, cmd) {
  if (!cmd || !cmd.lock) return;
  // Only a page that can drop the unlocks (Guardian, or a program's own
  // lockNow) carries it out; otherwise it waits for one that can.
  var hosts = hostLockers();
  if (!guardianLockDevice('remote') && !hosts.length) return;
  var f = {}; f['cmd.' + deviceId()] = c.fs.deleteField();
  try { await c.fs.updateDoc(docRef(c, owner), f); } catch (e) {}
  emit('locked', { by: cmd.by || '' });
  await runHostLocks(hosts, 'remote');
}
async function applyRemoval(c, owner) {
  REMOVED = true;
  lsSet('a1.beacon.removedAt', Date.now());
  var hosts = hostLockers();
  var locked = guardianLockDevice('removed') || hosts.length > 0;
  Object.keys(HOSTS).forEach(function (a) {
    var h = HOSTS[a];
    if (typeof h.onRemoved === 'function') { try { h.onRemoved(); } catch (e) {} }
  });
  lsDel('a1.beacon.reg'); lsDel('a1.beacon.owner');
  // The tombstone goes once the unlocks are gone, so the device can come back
  // (password first) the next time A1 is opened on it.
  if (locked) {
    var f = {}; f['gone.' + deviceId()] = c.fs.deleteField();
    f['cmd.' + deviceId()] = c.fs.deleteField();
    try { await c.fs.updateDoc(docRef(c, owner), f); } catch (e) {}
  }
  emit('removed', {});
  await runHostLocks(hosts, 'removed');
  return { removed: true };
}

/* ── What the panel reads and does ───────────────────────────────────────── */
function ownerOfToken(t) {
  var md = t && t.mainDash;
  if (md === 'tony' || md === 'veda') return md;
  return 'neutral';     // 'none' (un-mained), 'all' or unset: nobody's in particular
}
async function readDoc(c, owner) {
  try {
    var s = await c.fs.getDoc(docRef(c, owner));
    return (s && s.exists && s.exists()) ? (s.data() || {}) : {};
  } catch (e) { return null; }
}
// The viewer's devices plus the neutral ones. The other person's document is
// never read, and a push token that routes to them is skipped.
async function list(profile, opts) {
  opts = opts || {};
  profile = validProfile(profile);
  if (!profile) throw new Error('no profile');
  var c = await connect();
  var owners = [profile, 'neutral'];
  var docs = await Promise.all(owners.map(function (o) { return readDoc(c, o); }));
  var out = [], byId = {}, pending = {};
  owners.forEach(function (owner, i) {
    var d = docs[i] || {};
    Object.keys(d.devices || {}).forEach(function (id) {
      var r = d.devices[id] || {};
      // A device mid-move (its owner just changed) can sit in both documents
      // until it next checks in: show it once, where it was seen last.
      if (byId[id]) {
        if ((byId[id].seen || 0) >= (r.seen || 0)) return;
        out.splice(out.indexOf(byId[id]), 1);
      }
      var dev = { id: id, owner: owner, name: r.name || '', kindSet: r.kindSet || '', meta: r.meta || null,
        first: r.first || 0, seen: r.seen || 0, apps: r.apps || {}, cmd: (d.cmd || {})[id] || null, tokens: [] };
      out.push(dev); byId[id] = dev;
    });
    Object.keys(d.gone || {}).forEach(function (id) { pending[id] = { removed: d.gone[id], owner: owner }; });
  });
  var sources = [{ coll: FCM, app: 'taskhub', label: 'TaskHub & MyList', keyed: true, owner: ownerOfToken }];
  (opts.pushLists || []).forEach(function (s) { if (s && s.coll && s.coll !== FCM) sources.push(s); });
  for (var si = 0; si < sources.length; si++) {
    var src = sources[si], snap;
    try { snap = await c.fs.getDocs(c.fs.collection(c.db, src.coll)); } catch (e) { continue; }
    (snap.docs || []).forEach(function (ds) {
      var t = ds.data() || {};
      if (src.filter && !src.filter(t)) return;
      var owner = typeof src.owner === 'function' ? src.owner(t) : (src.owner || 'neutral');
      if (owner !== profile && owner !== 'neutral') return;
      var tok = { coll: src.coll, id: ds.id, app: src.app, label: src.label, on: !!t.token, updated: +t.updatedAt || 0, route: t.mainDash || '', ua: t.ua || '' };
      var dev = src.keyed ? byId[ds.id] : null;
      if (!dev) {
        for (var k = 0; k < out.length && !dev; k++) {
          var apps = out[k].apps || {};
          Object.keys(apps).forEach(function (a) { var p = apps[a].push; if (p && p.coll === src.coll && p.id === ds.id) dev = out[k]; });
        }
      }
      if (dev && dev.owner !== owner && dev.owner !== 'neutral' && owner !== 'neutral') return;
      if (!dev) {
        if (pending[ds.id]) return;   // removed; its token is on its way out
        var meta = detect({ userAgent: tok.ua, maxTouchPoints: /iPad|iPhone|Android/.test(tok.ua) ? 5 : 0 }, {}, {});
        dev = { id: src.keyed ? ds.id : 'tok_' + hashStr(src.coll + ds.id), owner: owner, name: '', kindSet: '', meta: meta,
          first: 0, seen: tok.updated, apps: {}, cmd: null, tokens: [], legacy: true };
        out.push(dev); byId[dev.id] = dev;
      }
      dev.tokens.push(tok);
      if (tok.updated > dev.seen && dev.legacy) dev.seen = tok.updated;
    });
  }
  out.sort(function (a, b) { return (b.seen || 0) - (a.seen || 0); });
  return { devices: out, self: deviceId(), profile: profile };
}
async function rename(owner, id, name) {
  if (!DOCS[owner]) throw new Error('bad owner');
  var c = await connect(), f = {};
  f['devices.' + id + '.name'] = String(name || '').trim().slice(0, 60);
  await patch(c, owner, f, nest(f));
}
async function setKind(owner, id, kind) {
  if (!DOCS[owner] || ['phone', 'tablet', 'laptop', 'desktop', 'computer'].indexOf(kind) < 0) throw new Error('bad kind');
  var c = await connect(), f = {};
  f['devices.' + id + '.kindSet'] = kind;
  await patch(c, owner, f, nest(f));
}
async function lockDevice(owner, id, by) {
  if (!DOCS[owner]) throw new Error('bad owner');
  if (id === deviceId()) { guardianLockDevice('manual'); await runHostLocks(hostLockers(), 'manual'); return { now: true }; }
  var c = await connect(), f = {};
  f['cmd.' + id] = { lock: Date.now(), by: validProfile(by) || '' };
  await patch(c, owner, f, nest(f));
  return { now: false };
}
async function cancelCmd(owner, id) {
  if (!DOCS[owner]) throw new Error('bad owner');
  var c = await connect(), f = {};
  f['cmd.' + id] = c.fs.deleteField();
  try { await c.fs.updateDoc(docRef(c, owner), f); } catch (e) {}
}
// Remove: its push tokens are deleted now (notifications stop at once), its
// record goes, and a tombstone tells the device to lock itself next time.
async function remove(dev) {
  if (!dev || !DOCS[dev.owner]) throw new Error('bad device');
  var c = await connect();
  var refs = {};
  (dev.tokens || []).forEach(function (t) { refs[t.coll + '/' + t.id] = [t.coll, t.id]; });
  Object.keys(dev.apps || {}).forEach(function (a) {
    var p = dev.apps[a] && dev.apps[a].push;
    if (p && p.coll && p.id) refs[p.coll + '/' + p.id] = [p.coll, p.id];
  });
  await Promise.all(Object.keys(refs).map(function (k) {
    return c.fs.deleteDoc(c.fs.doc(c.db, refs[k][0], refs[k][1])).catch(function () {});
  }));
  if (!dev.legacy || /^dev_|^fp_/.test(dev.id) || dev.tokens.some(function (t) { return t.coll === FCM; })) {
    var f = {};
    f['devices.' + dev.id] = c.fs.deleteField();
    f['cmd.' + dev.id] = c.fs.deleteField();
    f['gone.' + dev.id] = Date.now();
    await patch(c, dev.owner, f, nest(f));
  }
  if (dev.id === deviceId()) await applyRemoval(c, dev.owner);
  return true;
}
function watch(profile, cb) {
  profile = validProfile(profile);
  var offs = [], dead = false;
  connect().then(function (c) {
    if (dead) return;
    [profile, 'neutral'].forEach(function (o) {
      try { offs.push(c.fs.onSnapshot(docRef(c, o), function (s) { if (!s.metadata || !s.metadata.hasPendingWrites) cb(o); }, function () {})); } catch (e) {}
    });
  }).catch(function () {});
  return function () { dead = true; offs.forEach(function (f) { try { f(); } catch (e) {} }); };
}

/* ── The panel (beacon-ui.js, loaded on first open) ─────────────────────── */
var UI = null;
function loadUI() {
  if (window.BeaconUI) return Promise.resolve(window.BeaconUI);
  if (UI) return UI;
  UI = new Promise(function (res, rej) {
    var s = document.createElement('script');
    s.src = BASE + 'beacon-ui.js?v=' + VERSION;
    s.onload = function () { window.BeaconUI ? res(window.BeaconUI) : rej(new Error('Beacon UI missing')); };
    s.onerror = function () { UI = null; rej(new Error('Beacon UI failed to load')); };
    (document.head || document.documentElement).appendChild(s);
  });
  return UI;
}
// open({ app, profile }) — profile defaults to the program's current one.
function open(o) {
  o = o || {};
  var app = o.app || Object.keys(HOSTS)[0] || '';
  var h = HOSTS[app] || {};
  var profile = validProfile(o.profile) || profileOf(h);
  if (!profile) return Promise.resolve(false);
  checkIn(app, true);
  return loadUI().then(function (U) {
    var pushLists = [];
    Object.keys(HOSTS).forEach(function (a) { if (HOSTS[a].pushList) pushLists.push(HOSTS[a].pushList); });
    return U.open({ app: app, appLabel: h.label || APP_NAMES[app] || app, profile: profile, pushLists: pushLists, fcm: !!h.fcm });
  });
}

function emit(name, detail) {
  try { window.dispatchEvent(new CustomEvent('beacon:' + name, { detail: detail || {} })); } catch (e) {}
}

/* ── Wiring ───────────────────────────────────────────────────────────────── */
var WIRED = false;
function wire() {
  if (WIRED) return;
  WIRED = true;
  var lockT = 0;
  function soon() { clearTimeout(lockT); lockT = setTimeout(function () { scheduleAll(0, true); }, 1500); }
  ['guardian:unlock', 'guardian:lock', 'guardian:change'].forEach(function (e) { window.addEventListener(e, soon); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') scheduleAll(400); });
  window.addEventListener('focus', function () { scheduleAll(400); });
  setInterval(function () { if (document.visibilityState === 'visible') scheduleAll(0); }, POLL);
}
function mount(app, opts) {
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(String(app || ''))) throw new Error('Beacon.mount: bad app id');
  opts = Object.assign({}, opts || {}, { app: app });
  HOSTS[app] = opts;
  if (opts.firebase && !HOSTFB) HOSTFB = opts.firebase;
  if (opts.profileAttr && window.MutationObserver) {
    var mo = new MutationObserver(function () { schedule(app, 800, true); });
    var watchAttr = function () {
      [document.documentElement, document.body].forEach(function (el) { if (el) mo.observe(el, { attributes: true, attributeFilter: [opts.profileAttr] }); });
    };
    if (document.body) watchAttr(); else document.addEventListener('DOMContentLoaded', watchAttr);
  }
  wire();
  // After the program has booted: Beacon never competes with first paint.
  schedule(app, opts.delay != null ? opts.delay : 3000);
  return app;
}

window.Beacon = {
  version: VERSION,
  mount: mount,
  open: open,
  refresh: function (app) { if (app) schedule(app, 300, true); else scheduleAll(300, true); },
  deviceId: deviceId,
  detect: detect,
  detectFull: detectFull,
  defaultName: defaultName,
  owner: function (profile) { return ownerFor(validProfile(profile)); },
  list: list,
  rename: rename,
  setKind: setKind,
  lock: lockDevice,
  cancel: cancelCmd,
  remove: remove,
  watch: watch,
  checkIn: checkIn,
  apps: function () { return Object.keys(HOSTS); },
  appName: function (a) { return (HOSTS[a] && HOSTS[a].label) || APP_NAMES[a] || a; },
  config: function (o) { OVERRIDE = Object.assign(OVERRIDE || {}, o || {}); CONN = null; },
  DOCS: DOCS,
  BASE: BASE
};
emit('ready');
})();
