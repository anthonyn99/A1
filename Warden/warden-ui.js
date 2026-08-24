/* ─────────────────────────────────────────────────────────────────────────────
 * warden-ui.js — Warden Password Manager · UI + Firebase adapter (PWA)
 *
 * Self-contained and self-injecting: it hooks into the existing Keychain view
 * (#kc-root) and turns it into "Warden" with five tabs — Passwords · Payments ·
 * ID Docs · Sensitive Info · Links — WITHOUT requiring edits to the 38k-line
 * index.html beyond a single <script src> include. It reuses the app's
 * already-initialised Firebase instance (App Check + anon auth + offline cache)
 * via getApps(), and the existing window.Bio biometric helper.
 *
 * The Payments and ID Docs tabs' rendering/editors live in warden-pay-ui.js and
 * warden-id-ui.js, driven through the `hostCtx()` contract at the bottom of this
 * file — one warden, one session, one DEK, one sync path, but each section's UI
 * stays its own module.
 *
 * Depends on (loaded before it): warden-crypto.js, warden-store.js, warden-session.js
 * Optional: warden-pay.js + warden-pay-ui.js (Payments tab; degrades gracefully)
 * Optional: warden-id.js + warden-id-files.js + warden-id-ui.js (ID Docs tab; ditto)
 *
 * Data lives E2E-encrypted in a single Firestore doc `dashboards/warden_pw`:
 *     { config:<wrapped-keys/salts/verifier>, items:{ id -> encDoc }, savedAt }
 * The DB only ever sees ciphertext + a routing `kind`. See warden-crypto.js.
 * ──────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';
  if (window.__wardenUiLoaded) return; window.__wardenUiLoaded = true;

  var VC = window.WardenCrypto, WardenStore = window.WardenStore, WardenSession = window.WardenSession;
  var VI = window.WardenIcons || {};   // shared line-icon set (warden-icons.js)
  var FB_VER = '12.12.0';
  var WARDEN_DOC = 'dashboards/warden_pw';
  var CATEGORIES = ['Social', 'Banking', 'Finance', 'Shopping', 'Work', 'School', 'Gaming',
    'Utilities', 'Streaming', 'Development', 'Email', 'Other'];

  // ── tiny DOM helpers ───────────────────────────────────────────────────────
  function el(tag, attrs, kids) {
    var e = document.createElement(tag); attrs = attrs || {};
    for (var k in attrs) {
      if (k === 'style') e.style.cssText = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      // `value` MUST be set as a property, not an attribute — otherwise <textarea>
      // initial content never populates (attributes don't work for textareas).
      else if (k === 'value') e.value = attrs[k] == null ? '' : attrs[k];
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c == null) return; e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function toast(msg) {
    var t = $('kc-toast'); if (!t) { t = el('div', { id: 'warden-toast', style: 'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:var(--s3,#303135);border:1px solid var(--bdl,#4A4B52);color:var(--tx,#ECECEE);font-size:13px;font-weight:600;padding:9px 16px;border-radius:9px;z-index:99999;box-shadow:0 8px 30px rgba(0,0,0,.5)' }); document.body.appendChild(t); }
    t.textContent = msg; t.style.opacity = '1'; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function () { t.style.opacity = '0'; t.classList.remove('show'); }, 1400);
  }
  // Drive the sync-status pill under the Warden title (reuses #kc-sync-status).
  var _syncClearTimer = null;
  function setWardenSync(state) {
    var e = $('kc-sync-status'); if (!e) return;
    clearTimeout(_syncClearTimer);
    e.style.visibility = 'visible'; e.style.display = 'block';
    if (state === 'saving') { e.textContent = 'Syncing…'; e.style.color = 'var(--ac)'; }
    else if (state === 'saved') { e.textContent = 'Synced'; e.style.color = 'var(--txd)'; _syncClearTimer = setTimeout(function () { e.style.visibility = 'hidden'; }, 2000); }
    else if (state === 'error') { e.textContent = 'Sync failed \u2014 retrying'; e.style.color = '#E74C3C'; }
    else if (state === 'synced') { e.textContent = 'Synced'; e.style.color = 'var(--txd)'; _syncClearTimer = setTimeout(function () { e.style.visibility = 'hidden'; }, 1500); }
  }
  // Prefer the app's in-app modal (window.uiConfirm) over the browser's native
  // confirm dialog; fall back to native only if it's unavailable.
  function confirmUI(message, opts) {
    opts = opts || {};
    if (typeof window.uiConfirm === 'function') return window.uiConfirm(message, { title: opts.title, okLabel: opts.okLabel, cancelLabel: opts.cancelLabel, danger: opts.danger });
    return Promise.resolve(window.confirm(message));
  }
  function faviconUrl(url) {
    // Drawn locally. Fetching these from Google disclosed every saved site's
    // domain to a third party each time the list rendered.
    try { var host = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).hostname; return (function(h){h=String(h||'').replace(/^www\./,'');if(!h)return '';var n=0;for(var i=0;i<h.length;i++)n=(n*31+h.charCodeAt(i))>>>0;var c=/^[a-z0-9]/i.test(h)?h.charAt(0).toUpperCase():'#';return 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +'<rect width="64" height="64" rx="14" fill="'+['#f1b0c4','#f6c29e','#f1e19e','#cfe39c','#a9dcb4','#9bd8d0','#a3c8ec','#c3aee6','#e795ae','#f0ac7e','#e7d07e','#b9d683','#8fc99c','#82c6be','#8aafe2','#ab92dc'][n%16]+'"/>' +'<text x="32" y="44" font-family="system-ui,sans-serif" font-size="34" font-weight="600" fill="#2e2833" text-anchor="middle">'+c+'</text></svg>');})(host); } catch (e) { return ''; }
  }
  function copyText(v, label) { try { navigator.clipboard.writeText(v).then(function () { toast((label || 'Copied') + ' — clears in 30s'); scheduleClipboardClear(v); }); } catch (e) { toast('Copy failed'); } }
  // Clear the clipboard after 30s if it still holds the secret we copied.
  function scheduleClipboardClear(v) {
    setTimeout(function () { try { navigator.clipboard.readText().then(function (cur) { if (cur === v) navigator.clipboard.writeText(''); }).catch(function () {}); } catch (e) {} }, 30000);
  }

  // ── master-password hint email ─────────────────────────────────────────────
  // The hint is a plaintext reminder stored beside the (still zero-knowledge)
  // warden config — never the password itself. "Forgot password?" mails it to the
  // owner's inbox through the SAME browser-origin Formspree form index.html uses
  // for the MyJournal / TaskHub hints, so there's no Worker in this path.
  // Recipient comes from the host page's config block rather than being
  // hardcoded here, so the PWA and the extension cannot drift apart and there
  // is a single place to change it. Empty when unconfigured -- emailMasterHint
  // reports that rather than silently posting to nobody.
  var _HCFG = (typeof window !== 'undefined' && window.WARDEN_CONFIG && window.WARDEN_CONFIG.hint) || {};
  var HINT_EMAIL = _HCFG.email || '';
  var HINT_FORM = _HCFG.form || '';
  async function emailMasterHint(btn) {
    var prev = btn.textContent;
    if (!HINT_EMAIL || !HINT_FORM) { toast('Hint email is not configured yet (see SETUP.md).'); return; }
    btn.disabled = true; btn.textContent = 'Sending…';
    function fail(msg) { toast(msg); btn.textContent = prev; btn.disabled = false; }
    try {
      var hint = await session.getHint();
      if (!hint) { fail('No hint was saved for this vault'); return; }
      var r = await fetch(HINT_FORM, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          email: HINT_EMAIL,
          subject: 'Warden - Master Password Hint',
          message: 'Your Warden master password hint:\n\n' + hint +
            '\n\nThis is only the reminder you saved — the password itself is never stored ' +
            'or sent anywhere. If you still can\'t recall it, open Warden and choose ' +
            '"Use recovery key instead" on the lock screen to set a new master password.\n\n- Warden',
        }),
      });
      if (!r.ok) { fail('Couldn\'t send — try again'); return; }
      btn.textContent = 'Hint sent to your email';
      setTimeout(function () { btn.textContent = prev; btn.disabled = false; }, 3000);
    } catch (e) { fail('Network error — try again'); }
  }

  // Deep-clone a value, dropping any `undefined` (Firestore rejects undefined).
  function stripUndefined(v) {
    if (Array.isArray(v)) return v.map(stripUndefined);
    if (v && typeof v === 'object') {
      var o = {};
      for (var k in v) { if (v[k] !== undefined) o[k] = stripUndefined(v[k]); }
      return o;
    }
    return v;
  }

  // ── Firebase adapter — routes through index.html's proven db/setDoc path ────
  // (window._fbSaveWarden / _fbLoadWarden + fb-warden-* events), the SAME mechanism
  // Keychain/TaskHub use to write dashboards/* reliably. No separate Firestore
  // instance, so nothing to diverge from the rest of the app.
  function makeFirebaseBackend() {
    var mirror = { config: null, items: {} };
    var loaded = false, itemSubs = [], errShown = false;

    function saveState() { return { config: mirror.config || null, items: mirror.items || {}, savedAt: Date.now() }; }
    function fbReady() { return typeof window._fbLoadWarden === 'function' && typeof window._fbSaveWarden === 'function'; }
    function waitForFb() {
      if (fbReady()) return Promise.resolve();
      return new Promise(function (res) {
        var t = setInterval(function () { if (fbReady()) { clearInterval(t); res(); } }, 150);
        setTimeout(function () { clearInterval(t); res(); }, 10000);
      });
    }

    // Remote updates from the shared Firestore listener → merge + notify store.
    window.addEventListener('fb-warden-remote-update', function (e) {
      var d = e.detail; if (!d) return;
      mirror.config = d.config || mirror.config;
      mirror.items = d.items || {};
      // Master password changed elsewhere → re-lock this device immediately.
      try { if (session && mirror.config && session.enforceStamp(mirror.config)) { renderLock(true); return; } } catch (err) {}
      var list = Object.keys(mirror.items).map(function (k) { return mirror.items[k]; });
      itemSubs.forEach(function (fn) { try { fn(list); } catch (err) {} });
    });
    window.addEventListener('fb-warden-saved', function () { errShown = false; setWardenSync('saved'); });
    window.addEventListener('fb-warden-error', function (e) {
      setWardenSync('error');
      if (!errShown) { errShown = true; toast('Sync failed (' + (e.detail || 'error') + ') — retrying'); }
    });

    async function ensureLoaded() {
      await waitForFb();
      if (loaded) return;
      loaded = true;
      try { var d = await window._fbLoadWarden(); if (d) { mirror.config = d.config || null; mirror.items = d.items || {}; } } catch (e) {}
    }
    function scheduleWrite() {
      setWardenSync('saving');
      if (fbReady()) window._fbSaveWarden(saveState);
      else waitForFb().then(function () { if (fbReady()) window._fbSaveWarden(saveState); });
    }

    return {
      async loadConfig() { await ensureLoaded(); return mirror.config ? JSON.parse(JSON.stringify(mirror.config)) : null; },
      async saveConfig(c) { await ensureLoaded(); mirror.config = JSON.parse(JSON.stringify(c)); scheduleWrite(); },
      async listItems() { await ensureLoaded(); return Object.keys(mirror.items).map(function (k) { return JSON.parse(JSON.stringify(mirror.items[k])); }); },
      async putItem(doc) { await ensureLoaded(); mirror.items[doc.id] = JSON.parse(JSON.stringify(doc)); scheduleWrite(); },
      subscribe: function (onItems) { itemSubs.push(onItems); ensureLoaded(); return function () { itemSubs = itemSubs.filter(function (f) { return f !== onItems; }); }; },
    };
  }

  // ── password generator ─────────────────────────────────────────────────────
  var GEN = {
    lower: 'abcdefghijkmnpqrstuvwxyz', upper: 'ABCDEFGHJKMNPQRSTUVWXYZ',
    num: '23456789', sym: '!@#$%^&*-_=+?', ambiguousNum: '01', ambiguousSym: "{}[]()/\\'\"`~,;:.<>",
  };
  function genPassword(o) {
    o = o || {}; var len = o.length || 20, pool = '', req = [];
    if (o.lower !== false) { var s = GEN.lower + (o.easy ? '' : 'lo'); pool += s; req.push(s); }
    if (o.upper !== false) { var u = GEN.upper + (o.easy ? '' : 'IO'); pool += u; req.push(u); }
    if (o.num !== false) { var n = GEN.num + (o.easy ? '' : GEN.ambiguousNum); pool += n; req.push(n); }
    if (o.sym) { pool += GEN.sym; req.push(GEN.sym); }
    if (!pool) pool = GEN.lower;
    var rnd = VC.randomBytes(len * 2), out = [], i, ri = 0;
    for (i = 0; i < len; i++) out.push(pool[rnd[ri++ % rnd.length] % pool.length]);
    // guarantee at least one of each required class
    req.forEach(function (cls, idx) { if (idx < len) out[rnd[(ri++) % rnd.length] % len] = cls[rnd[(ri++) % rnd.length] % cls.length]; });
    return out.join('');
  }
  function genPassphrase(words, sep) {
    var LIST = ('able acid aged also area army away baby back ball band bank base bath bear beat been bell belt best bird blow blue boat body bone book born both bowl bulk burn bush busy calm came camp card care case cash cast cell chat chip city clay club coal coat code cold come cook cool cope copy corn cost crew crop dark data date dawn days dead deal dean dear debt deep deny desk dial dirt dish dock does done door dose down draw drew drop drug drum dual duck dust duty each earn ease east easy edge else even ever evil exit face fact fade fail fair fall farm fast fate fear feed feel feet fell felt file fill film find fine fire firm fish five flag flat flow food foot ford form fort four free frog fuel full fund gain game gate gave gear gene gift girl give glad goal goat gold golf gone good gray grew grey grid grip grow gulf hair half hall hand hang hard harm hate have hawk head heal heap hear heat held hell helm help herb herd here hero hide high hill hint hire hold hole holy home hope horn hose host hour huge hull hung hunt hurt icon idea idle inch iron item jack jade jail jazz jean join joke joth jump june junk jury just keel keen keep kept kick kind king kiss kite knee knew knot know lace lack lady laid lake lamb lamp land lane last late lawn lazy lead leaf leak lean leap left lend lens less life lift like limb lime line link lion list live load loan lock loft logo lone long look loop lord lose loss lost loud love luck lump lung made mail main make male mall many mark mars mask mass mast mate math maze meal mean meat meet melt menu mere mesh mild mile milk mill mind mine mint miss mist mode mold mole monk mood moon more moss most moth move much mule name navy near neat neck need neon nest news next nice nick node none noon norm nose note noun nova nude oath obey odds ohio once only onto open oral oval oven over pace pack page paid pain pair pale palm park part pass past path peak pear peer pile pill pine pink pint pipe plan play plot plug plum poem poet pole poll pond pony pool poor pope pore port pose post pour pray prep prey prod prom prop pull pump punk pure push quit race rack rage raid rail rain rank rare rate read real reap rear reef reel rely rent rest rice rich ride ring riot rise risk road roar robe rock rode role roll roof room root rope rose ruby rude rule rush rust sack safe sage said sail sake sale salt same sand save scan seal seat seed seek seem seen self sell send sent ship shoe shop shot show shut side sign silk sing sink site size skin slid slim slip slot slow snap snow soak soap sock soda sofa soft soil sold sole solo some song sons soon sort soul soup sour span spin spot star stay stem step stir stop stow such suit sung sunk sure surf swap tail take tale talk tall tank tape task team tear teen tell tend tent term test text than that thaw them then they thin this thus tick tide tidy tied tile till time tiny tips toll tone tool torn tour town trap tray tree trim trip true tube tuna tune turn twin type unit upon urge used user vary vast veil vein verb very vest veto vice view vine visa vita void vote wade wage wait wake walk wall wand want ward ware warm warn wash wave weak wear webs week weld well went were west what when whip whom wide wife wild will wind wine wing wink wire wise wish with wolf wood wool word wore work worm worn wrap yard yarn yeah year yoga zero zinc zone zoom').split(' ');
    words = words || 4; sep = sep == null ? '-' : sep;
    var rnd = VC.randomBytes(words * 2), out = [];
    for (var i = 0; i < words; i++) { var w = LIST[(rnd[i * 2] << 8 | rnd[i * 2 + 1]) % LIST.length]; out.push(w.charAt(0).toUpperCase() + w.slice(1)); }
    return out.join(sep) + sep + (VC.randomBytes(1)[0] % 90 + 10);
  }
  // Rough strength score 0..4 for the meter.
  function strength(pw) {
    if (!pw) return 0; var s = 0; pw = String(pw);
    if (pw.length >= 8) s++; if (pw.length >= 12) s++; if (pw.length >= 16) s++;
    var classes = (/[a-z]/.test(pw) ? 1 : 0) + (/[A-Z]/.test(pw) ? 1 : 0) + (/[0-9]/.test(pw) ? 1 : 0) + (/[^a-zA-Z0-9]/.test(pw) ? 1 : 0);
    if (classes >= 3) s++; if (classes >= 4 && pw.length >= 12) s++;
    return Math.min(4, s);
  }

  // ── password health analysis (pure, testable) ─────────────────────────────
  var HEALTH_OLD_MS = 365 * 24 * 3600 * 1000; // "old" = not changed in ~1 year
  function analyzeHealth(logins, now) {
    now = now || Date.now();
    logins = logins || [];
    var withPw = logins.filter(function (l) { return l.password; });
    var missing = logins.filter(function (l) { return !l.password; });
    var weak = withPw.filter(function (l) { return strength(l.password) <= 1; });
    // reused: same password across 2+ logins
    var byPw = {};
    withPw.forEach(function (l) { (byPw[l.password] = byPw[l.password] || []).push(l); });
    var reusedGroups = Object.keys(byPw).filter(function (k) { return byPw[k].length > 1; }).map(function (k) { return byPw[k]; });
    var reusedSet = {}; reusedGroups.forEach(function (g) { g.forEach(function (l) { reusedSet[l.id] = true; }); });
    // old: not modified in a year
    var old = withPw.filter(function (l) { return l.modifiedAt && (now - l.modifiedAt) > HEALTH_OLD_MS; });
    // duplicate accounts: same site + same username/email
    var byKey = {};
    logins.forEach(function (l) {
      var site = String(l.url || l.title || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      var who = String(l.username || l.email || '').toLowerCase();
      if (!site && !who) return;
      var k = site + '|' + who;
      (byKey[k] = byKey[k] || []).push(l);
    });
    var duplicates = Object.keys(byKey).filter(function (k) { return byKey[k].length > 1; }).map(function (k) { return byKey[k]; });
    // score: % of passworded logins that are strong, unique, and not old.
    var healthy = withPw.filter(function (l) { return strength(l.password) >= 3 && !reusedSet[l.id] && !(l.modifiedAt && (now - l.modifiedAt) > HEALTH_OLD_MS); });
    var denom = logins.length || 1;
    var score = Math.round(100 * healthy.length / denom);
    return {
      score: score, total: logins.length,
      weak: weak, missing: missing, old: old,
      reusedGroups: reusedGroups, reusedCount: Object.keys(reusedSet).length,
      duplicates: duplicates,
    };
  }

  // ── TOTP (RFC 6238) — live 2FA codes from a stored secret ──────────────────
  function base32Decode(s) {
    s = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    if (!s) return new Uint8Array(0);
    var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', bits = 0, val = 0, out = [];
    for (var i = 0; i < s.length; i++) {
      var idx = A.indexOf(s[i]); if (idx < 0) continue;
      val = (val << 5) | idx; bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
    }
    return new Uint8Array(out);
  }
  // Accept a raw base32 secret OR an otpauth:// URI.
  function totpSecretOf(field) {
    if (!field) return '';
    var m = /[?&]secret=([^&]+)/i.exec(field);
    return m ? decodeURIComponent(m[1]) : field;
  }
  async function totpNow(secretField, opts) {
    opts = opts || {};
    var key = base32Decode(totpSecretOf(secretField));
    if (!key.length) return null;
    var period = opts.period || 30, digits = opts.digits || 6;
    var epoch = typeof opts.now === 'number' ? opts.now : Math.floor(Date.now() / 1000);
    var counter = Math.floor(epoch / period);
    var cbuf = new Uint8Array(8), c = counter;
    for (var i = 7; i >= 0; i--) { cbuf[i] = c & 0xff; c = Math.floor(c / 256); }
    var ck = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    var h = new Uint8Array(await crypto.subtle.sign('HMAC', ck, cbuf));
    var off = h[h.length - 1] & 0xf;
    var bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
    var code = String(bin % Math.pow(10, digits)).padStart(digits, '0');
    return { code: code, remaining: period - (epoch % period), period: period };
  }
  // Live ticker: refresh every visible TOTP element once a second.
  var _totpTicker = false;
  async function refreshTotps() {
    var els = document.querySelectorAll('.warden-totp');
    for (var i = 0; i < els.length; i++) {
      var w = els[i], secret = w.__totpSecret; if (!secret) continue;
      var t = await totpNow(secret);
      var codeEl = w.querySelector('.warden-totp-code'), barEl = w.querySelector('.warden-totp-bar > div');
      if (!t) { if (codeEl) codeEl.textContent = 'invalid secret'; continue; }
      if (codeEl) codeEl.textContent = t.code.replace(/(\d{3})(\d+)/, '$1 $2');
      if (barEl) { barEl.style.width = (t.remaining / t.period * 100) + '%'; barEl.style.background = t.remaining <= 5 ? '#E74C3C' : 'var(--ac)'; }
      w.__totpCode = t.code;
    }
  }
  function ensureTotpTicker() { if (_totpTicker) return; _totpTicker = true; setInterval(refreshTotps, 1000); }

  // ── controller ─────────────────────────────────────────────────────────────
  var session = null, store = null, backend = null, activeTab = 'links', currentQuery = '';
  // Which secure notes are expanded. Survives the re-render a save/live-sync
  // triggers, so a drag-reorder doesn't slam every open note shut. Cleared on
  // lock — a locked warden leaves no trace of what was being read.
  var _senOpen = {};

  function ensureSession() {
    if (session) return session;
    backend = makeFirebaseBackend();
    session = new WardenSession({
      backend: backend, bio: window.Bio || null,
      deviceStore: WardenSession.localStorageDeviceStore('warden.'),
      appId: 'warden', autoLockMs: 30 * 60 * 1000, // lock after 30 min idle (resets on activity)
      onLock: function () { renderLock(); },
    });
    return session;
  }

  // Called whenever the Keychain/Warden view becomes visible.
  async function activate() {
    injectShell();
    relabelNav();
    // Guarantee #kc-root is the scroll container (so the sticky tabs/toolbar pin
    // and the wide scrollbar shows), regardless of any base/app styles.
    var r = $('kc-root'); if (r) { r.style.height = '100dvh'; r.style.overflowY = 'auto'; r.style.overflowX = 'clip'; }
    bindPullToRefresh(r);
    ensureSession();
    // Default to the (non-secret) Links tab — no unlock needed to open Warden.
    // Passwords / Sensitive still require unlock when their tab is selected.
    showTab(activeTab);
  }

  // ── shell: tabs + lock overlay + panels injected into #kc-root ─────────────
  function injectShell() {
    var root = $('kc-root'); if (!root || $('warden-tabs')) return;
    injectStyles();
    // Wrap the existing connections content (everything after the header) as the Links tab.
    var hbar = root.querySelector('.app-hbar');
    var linksWrap = el('div', { id: 'warden-links-panel', class: 'warden-panel' });
    // Move the existing .kc-wrap (Connections) into the Links panel.
    var kcWrap = root.querySelector('.kc-wrap');
    var tabs = el('div', { id: 'warden-tabs', class: 'warden-tabs' }, [
      tabBtn('links', 'Links', VI.link), tabBtn('passwords', 'Passwords', VI.key),
      tabBtn('payments', 'Payments', VI.card), tabBtn('iddocs', 'ID Docs', idCardIcon()),
      tabBtn('sensitive', 'Sensitive Info', VI.archive), tabBtn('cloud', 'Cloud', cloudIcon()),
    ]);
    if (hbar && hbar.nextSibling) root.insertBefore(tabs, hbar.nextSibling); else root.appendChild(tabs);
    enableTabReorder(tabs);
    var pwPanel = el('div', { id: 'warden-pw-panel', class: 'warden-panel' });
    var payPanel = el('div', { id: 'warden-payments-panel', class: 'warden-panel', style: 'display:none' });
    var idPanel = el('div', { id: 'warden-iddocs-panel', class: 'warden-panel', style: 'display:none' });
    var senPanel = el('div', { id: 'warden-sensitive-panel', class: 'warden-panel', style: 'display:none' });
    // Cloud is a secret panel too. It holds no decrypted warden material, but it
    // is a live window onto every connected drive, so it gates on the same
    // master password as Passwords, Payments, ID Docs and Sensitive Info.
    var cloudPanel = el('div', { id: 'warden-cloud-panel', class: 'warden-panel', style: 'display:none' });
    root.appendChild(pwPanel); root.appendChild(payPanel); root.appendChild(idPanel); root.appendChild(senPanel);
    root.appendChild(cloudPanel);
    if (kcWrap) { kcWrap.parentNode.removeChild(kcWrap); linksWrap.appendChild(kcWrap); }
    linksWrap.style.display = 'none'; root.appendChild(linksWrap);
    // Lock overlay (covers everything but tabs stay to switch to Links which is non-secret? No — links are also under Warden; lock gates pw+sensitive only).
    var lock = el('div', { id: 'warden-lock', class: 'warden-lock', style: 'display:none' });
    pwPanel.appendChild(lock);
  }
  // Tab bar drag-to-reorder. The order is Warden-wide UI state, so it rides in
  // the same synced settings object as everything else in Cloud and lands on the
  // other devices through its onSnapshot listener — no separate plumbing.
  function enableTabReorder(tabs) {
    if (!window.WardenDrag) return;
    function VC() { return window.WardenCloud; }

    window.WardenDrag.enable(tabs, {
      item: '.warden-tab',
      key: 'data-tab',
      onDrop: function (order) {
        if (!VC()) return;
        VC().settings().tabOrder = order;
        VC().save();
      }
    });

    // WardenCloud hydrates from localStorage synchronously at load, so the saved
    // order is already there on the first paint; the subscription then catches
    // a reorder made on another device.
    function apply(s) {
      if (!s || !s.tabOrder) return;
      if (tabs.querySelector('.vdrag')) return;      // don't yank a tab mid-drag
      window.WardenDrag.applyOrder(tabs, '.warden-tab', 'data-tab', s.tabOrder);
    }
    function bind() {
      if (!VC()) { setTimeout(bind, 150); return; }
      apply(VC().settings());
      VC().onChange(apply);
    }
    bind();
  }

  function tabBtn(id, label, icon) {
    return el('button', {
      class: 'warden-tab' + (id === activeTab ? ' active' : ''), 'data-tab': id,
      html: (icon || '') + '<span>' + esc(label) + '</span>',
      onclick: function () { showTab(id); }
    });
  }
  function relabelNav() {
    // Rename "Keychain" → "Warden" in the logo + nav without editing index.html.
    try {
      var logo = document.querySelector('#kc-root .kc-logo');
      if (logo && !logo._wardened) { logo.innerHTML = '<span class="dot" style="color:var(--ac)">Warden</span>'; logo._wardened = true; }
      document.querySelectorAll('[data-app="keychain"]').forEach(function (b) { if (/keychain/i.test(b.textContent)) b.textContent = 'Warden'; });
      document.querySelectorAll('option[value="keychain"]').forEach(function (o) { if (/keychain/i.test(o.textContent)) o.textContent = 'Warden'; });
    } catch (e) {}
  }

  // The tabs that hold protected material — each one gates on the SAME session.
  var SECRET_TABS = {
    passwords: renderPasswords, payments: renderPayments, iddocs: renderIdDocs,
    sensitive: renderSensitive, cloud: renderCloud,
  };
  // Every secret tab's panel, so lock/blank logic never has to enumerate them
  // twice (and can't drift when a seventh tab arrives).
  var SECRET_PANELS = {
    passwords: 'warden-pw-panel', payments: 'warden-payments-panel',
    iddocs: 'warden-iddocs-panel', sensitive: 'warden-sensitive-panel',
    cloud: 'warden-cloud-panel',
  };

  function showTab(id) {
    activeTab = id;
    document.querySelectorAll('.warden-tab').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === id); });
    Object.keys(SECRET_PANELS).forEach(function (t) {
      var p = $(SECRET_PANELS[t]); if (p) p.style.display = t === id ? '' : 'none';
    });
    var links = $('warden-links-panel');
    if (links) links.style.display = id === 'links' ? '' : 'none';
    if (SECRET_TABS[id]) {
      if (!session || !session.isUnlocked()) { renderLock(); return; }
      SECRET_TABS[id]();
    }
    updateStickyOffset();
  }

  // Cloud holds none of the warden's own decrypted material, but it is a live
  // window onto every connected drive — file names, previews, downloads,
  // deletions and the accounts themselves — so it unlocks with the rest rather
  // than staying open on a locked warden.
  //
  // Unlike the other four it needs no `store`: it reads the provider APIs, not
  // the encrypted document, so it renders as soon as the session is open.
  function renderCloud() {
    var panel = $('warden-cloud-panel'); if (!panel) return;
    if (!session || !session.isUnlocked()) { renderLock(); return; }
    // Mounted lazily: the first paint kicks off provider quota + folder calls,
    // and doing that on page load would spend the API budget for a tab nobody
    // opened. mount() is idempotent and repaints the panel, which is also what
    // rebuilds it after a lock blanked it.
    if (window.WardenCloudUI) window.WardenCloudUI.mount();
  }
  // Measure the sticky header heights so the tabs pin below the app-hbar and the
  // toolbar pins below the tabs (both app-hbar and tabs are position:sticky).
  // FLOOR, not offsetHeight. offsetHeight ROUNDS a fractional layout height, so a
  // 60.6px header measured as 61 pins the strip below it 0.4px too low — a
  // hairline of scrolled cards shows through the seam ("bleeds through slightly
  // while scrolling"). Flooring always errs toward a sub-pixel OVERLAP instead,
  // and the lower strip's z-index is smaller, so the overlap is invisible.
  function _hFloor(el) { return Math.floor(el.getBoundingClientRect().height); }
  function updateStickyOffset() {
    var root = $('kc-root');
    var hbar = root && root.querySelector('.app-hbar');
    if (hbar) document.documentElement.style.setProperty('--vhbar-h', _hFloor(hbar) + 'px');
    var t = $('warden-tabs'); if (t) document.documentElement.style.setProperty('--vtabs-h', _hFloor(t) + 'px');
    _watchStickyHeights(hbar, t);
  }
  // The tab bar pins at exactly the header's height. If that measurement goes
  // stale — a webfont finishing, the sync line appearing, a rotation — the tabs
  // pin a few pixels low and scrolled content shows through the seam. Observing
  // both elements keeps the offset honest for the life of the page.
  var _stickyRO = null;
  function _watchStickyHeights(hbar, tabs) {
    if (_stickyRO || typeof ResizeObserver === 'undefined') return;
    _stickyRO = new ResizeObserver(function () {
      var root = $('kc-root');
      var h = root && root.querySelector('.app-hbar');
      var t = $('warden-tabs');
      if (h) document.documentElement.style.setProperty('--vhbar-h', _hFloor(h) + 'px');
      if (t) document.documentElement.style.setProperty('--vtabs-h', _hFloor(t) + 'px');
    });
    if (hbar) _stickyRO.observe(hbar);
    if (tabs) _stickyRO.observe(tabs);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { updateStickyOffset(); });
    }
    window.addEventListener('orientationchange', function () { setTimeout(updateStickyOffset, 120); });
  }

  // ── pull to refresh ────────────────────────────────────────────────────────
  // The browser's own pull-to-refresh cannot fire in Warden: `body.warden-active`
  // is `overflow:hidden` and the real scroller is #kc-root, a nested
  // overflow:auto box. Chrome only offers PTR when the overscroll reaches the
  // ROOT scroller, so with the body locked the gesture goes nowhere — on every
  // panel, locked or unlocked. (iOS standalone has no PTR at all, ever.)
  //
  // So Warden brings its own. It lives on the scroll container, which means it
  // works identically on the lock screen, on Sensitive Info, and on every other
  // tab — they are all children of #kc-root.
  var PTR_TRIGGER = 72;     // px of pull before a release refreshes
  var PTR_MAX = 110;        // px the indicator can travel
  function bindPullToRefresh(scroller) {
    if (!scroller || scroller.__ptrBound) return;
    scroller.__ptrBound = true;
    injectStyles();

    var ind = el('div', { class: 'warden-ptr', 'aria-hidden': 'true' }, [
      el('div', { class: 'warden-ptr-spinner', html: ptrIcon() }),
    ]);
    scroller.appendChild(ind);

    var startY = 0, startX = 0, pulling = false, dist = 0, armed = false, refreshing = false;

    // A pull must not start on top of something that owns the gesture itself:
    // a drag handle (card reorder), a zoomable document, or anything inside an
    // open modal/viewer sitting above the page.
    function gestureBlocked(target) {
      if (refreshing) return true;
      if (document.querySelector('.warden-overlay, .vid-viewer')) return true;
      if (scroller.querySelector('.warden-reordering')) return true;
      return !!(target && target.closest && target.closest('.warden-drag, .vid-stage, input, textarea, select'));
    }
    function setPull(px) {
      dist = px;
      var eased = Math.min(PTR_MAX, px * 0.55);       // resistance
      ind.style.transform = 'translateX(-50%) translateY(' + eased + 'px)';
      ind.style.opacity = String(Math.min(1, px / PTR_TRIGGER));
      var spin = ind.firstChild;
      spin.style.transform = 'rotate(' + Math.min(360, px * 2.6) + 'deg)';
      var nowArmed = px >= PTR_TRIGGER;
      if (nowArmed !== armed) {
        armed = nowArmed;
        ind.classList.toggle('armed', armed);
        // A short buzz at the threshold, the same cue the native gesture gives.
        if (armed && navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
      }
    }
    function reset() {
      pulling = false; dist = 0; armed = false;
      ind.classList.remove('armed');
      ind.style.transition = 'transform .22s ease, opacity .22s ease';
      ind.style.transform = 'translateX(-50%) translateY(0)';
      ind.style.opacity = '0';
      setTimeout(function () { ind.style.transition = ''; }, 240);
    }

    scroller.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { pulling = false; return; }
      if (scroller.scrollTop > 0) { pulling = false; return; }
      if (gestureBlocked(e.target)) { pulling = false; return; }
      startY = e.touches[0].clientY; startX = e.touches[0].clientX;
      pulling = true; armed = false;
      ind.style.transition = '';
    }, { passive: true });

    scroller.addEventListener('touchmove', function (e) {
      if (!pulling || e.touches.length !== 1) return;
      var dy = e.touches[0].clientY - startY;
      var dx = e.touches[0].clientX - startX;
      // Scrolled away from the top mid-gesture, pulled upward, or the gesture
      // turned horizontal (a tab swipe) → this is not a refresh.
      if (scroller.scrollTop > 0 || dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
        if (dist) reset(); else pulling = false;
        return;
      }
      // Only now claim the gesture, so a normal downward scroll from mid-page
      // is never stolen. cancelable guards against a scroll already in flight.
      if (e.cancelable) e.preventDefault();
      setPull(dy);
    }, { passive: false });

    function end() {
      if (!pulling) return;
      if (armed && !refreshing) {
        refreshing = true;
        ind.classList.add('spinning');
        ind.style.transition = 'transform .18s ease';
        ind.style.transform = 'translateX(-50%) translateY(' + (PTR_TRIGGER * 0.55) + 'px)';
        ind.style.opacity = '1';
        // Let the indicator paint its committed state before the reload blocks
        // the main thread, so the gesture visibly "took".
        setTimeout(function () { location.reload(); }, 180);
        return;
      }
      reset();
    }
    scroller.addEventListener('touchend', end, { passive: true });
    scroller.addEventListener('touchcancel', function () { if (pulling) reset(); }, { passive: true });
  }
  function ptrIcon() {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>';
  }

  // ── lock / setup screens ───────────────────────────────────────────────────
  function secretPanel(tab) { return $(SECRET_PANELS[tab] || SECRET_PANELS.passwords); }
  async function renderLock(hasWarden) {
    // Any lock closes the Payments reveal-grace window, so unlocking again can
    // never inherit an identity check made before the lock.
    try { if (window.WardenPayUI) window.WardenPayUI.resetGrace(); } catch (e) {}
    // …and tears down ID Docs, which is the one section holding decrypted BYTES
    // (object URLs for scans). Those must not outlive the session.
    try { if (window.WardenIdUI) window.WardenIdUI.reset(); } catch (e) {}
    // Cloud's panel is blanked below like any other secret tab, but half its
    // chrome — upload dock, selection bar, preview, menus — lives on <body> and
    // would otherwise float above the lock card.
    try { if (window.WardenCloudUI) window.WardenCloudUI.lock(); } catch (e) {}
    _senOpen = {};
    // Draw the lock/setup card into whichever secret tab is on screen, and blank
    // every other one — a locked warden must leave no decrypted rows behind in a
    // panel the user can flip back to.
    var target = SECRET_TABS[activeTab] ? activeTab : 'passwords';
    Object.keys(SECRET_PANELS).forEach(function (t) {
      if (t === target) return;
      var p = secretPanel(t); if (p) p.innerHTML = '';
    });
    var pw = secretPanel(target); if (!pw) return;
    if (hasWarden == null) { try { hasWarden = await session.hasWarden(); } catch (e) { hasWarden = false; } }
    var host = el('div', { class: 'warden-lock' });
    if (!hasWarden) { renderSetup(host); }
    else { renderUnlock(host); }
    pw.innerHTML = ''; pw.appendChild(host);
  }

  function card(title, sub, kids) {
    return el('div', { class: 'warden-card' }, [
      el('div', { class: 'warden-lock-icon', html: VI.shield }),
      el('h2', { class: 'warden-h2' }, [title]),
      sub ? el('p', { class: 'warden-sub' }, [sub]) : null,
    ].concat(kids || []));
  }

  function renderSetup(host) {
    var pw1 = el('input', { type: 'password', class: 'warden-input', placeholder: 'Create master password', autocomplete: 'new-password' });
    var pw2 = el('input', { type: 'password', class: 'warden-input', placeholder: 'Confirm master password', autocomplete: 'new-password' });
    var hint = el('input', { type: 'text', class: 'warden-input', placeholder: 'Password hint (optional)', autocomplete: 'off', maxlength: '160' });
    var meter = el('div', { class: 'warden-meter' }, [el('div', { class: 'warden-meter-fill' })]);
    var err = el('div', { class: 'warden-err' });
    pw1.addEventListener('input', function () { var s = strength(pw1.value); var f = meter.querySelector('.warden-meter-fill'); f.style.width = (s / 4 * 100) + '%'; f.style.background = ['#E74C3C', '#8D769A', '#e0b57c', '#5DAF6D', '#5DAF6D'][s]; });
    var btn = el('button', { class: 'warden-btn primary' }, ['Create Warden']);
    btn.addEventListener('click', async function () {
      err.textContent = '';
      if (pw1.value.length < 12) { err.textContent = 'Use at least 12 characters — four random words is the easiest way to get there.'; return; }
      if (pw1.value !== pw2.value) { err.textContent = 'Passwords do not match.'; return; }
      btn.disabled = true; btn.textContent = 'Encrypting…';
      try { var r = await session.setup(pw1.value, hint.value.trim()); showRecovery(r.recoveryCode, true); }
      catch (e) { err.textContent = 'Setup failed: ' + (e.message || e); btn.disabled = false; btn.textContent = 'Create Warden'; }
    });
    host.appendChild(card('Set up your Warden',
      'Your master password encrypts everything on this device before it syncs. It is never sent to the cloud and cannot be recovered by anyone — choose a strong passphrase you will remember.',
      [pw1, meter, pw2, hint,
        el('p', { class: 'warden-fine', style: 'text-align:left;margin:-4px 0 12px;text-transform:none;letter-spacing:0;font-size:11px;line-height:1.5' },
          ['The hint is emailed to you if you tap “Forgot password?”. It is stored in plain text — make it jog your memory, never the password itself.']),
        err, btn,
        el('p', { class: 'warden-fine' }, ['End-to-end encrypted · AES-256-GCM · PBKDF2 600k · zero-knowledge'])]));
  }

  function showRecovery(code, firstRun) {
    var pw = $('warden-pw-panel'); if (!pw) return;
    // Force the passwords panel to be the visible one — otherwise, if Settings
    // was opened from another tab, the new key would render into a hidden panel.
    activeTab = 'passwords';
    document.querySelectorAll('.warden-tab').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === 'passwords'); });
    var sen = $('warden-sensitive-panel'), links = $('warden-links-panel');
    if (sen) sen.style.display = 'none'; if (links) links.style.display = 'none';
    pw.style.display = '';
    var codeBox = el('div', { class: 'warden-recovery-code' }, [code]);
    var copied = el('button', { class: 'warden-btn' }, ['Copy recovery key']);
    copied.addEventListener('click', function () { copyText(code, 'Recovery key copied'); });
    var chk = el('input', { type: 'checkbox', id: 'warden-rec-ack' });
    var cont = el('button', { class: 'warden-btn primary', disabled: 'disabled' }, ['I saved it — continue']);
    chk.addEventListener('change', function () { cont.disabled = !chk.checked; });
    // First run: the store hasn't been initialised yet — afterUnlock() sets it
    // up, loads items, starts live sync, then shows the list. Rotate-recovery
    // (already unlocked): just return to the current tab.
    cont.addEventListener('click', async function () {
      cont.disabled = true;
      if (!store) { await afterUnlock(); }
      else { showTab(activeTab === 'links' ? 'passwords' : activeTab); }
    });
    var host = el('div', { class: 'warden-lock' }, [
      card('Your Recovery Key',
        'This is the ONLY way back in if you forget your master password AND lose your biometric devices. Write it down or store it in a safe place. It will not be shown again.',
        [codeBox, copied,
          el('label', { class: 'warden-ack' }, [chk, el('span', {}, ['I have saved my recovery key somewhere safe'])]),
          cont]),
    ]);
    pw.innerHTML = ''; pw.appendChild(host);
  }

  async function renderUnlock(host) {
    var pwIn = el('input', { type: 'password', class: 'warden-input', placeholder: 'Master password', autocomplete: 'current-password' });
    var err = el('div', { class: 'warden-err' });
    var unlockBtn = el('button', { class: 'warden-btn primary' }, ['Unlock']);
    async function tryPw() {
      err.textContent = ''; unlockBtn.disabled = true; unlockBtn.textContent = 'Unlocking…';
      try { await session.unlockWithPassword(pwIn.value); afterUnlock(); }
      catch (e) { err.textContent = e.message === 'bad-password' ? 'Incorrect master password.' : ('Error: ' + e.message); unlockBtn.disabled = false; unlockBtn.textContent = 'Unlock'; }
    }
    unlockBtn.addEventListener('click', tryPw);
    pwIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') tryPw(); });

    var kids = [pwIn, err, unlockBtn];
    // Biometric button if this device has a slot registered.
    var deviceHasBio = false;
    try { deviceHasBio = await session.biometricEnabled(); } catch (e) {}
    if (deviceHasBio && window.Bio) {
      var bioBtn = el('button', { class: 'warden-btn', html: VI.unlock + '<span>Unlock with ' + (window.Bio.label ? window.Bio.label() : 'biometrics') + '</span>' });
      bioBtn.addEventListener('click', async function () {
        err.textContent = '';
        try { await session.unlockWithBiometric(); afterUnlock(); }
        catch (e) { if (e.message !== 'cancelled') err.textContent = 'Biometric unlock failed — use your password.'; }
      });
      // Never fire on its own — the OS prompt only appears when this button is
      // pressed, so the password field above stays an equal choice.
      kids.splice(2, 0, bioBtn);
    }
    var recov = el('button', { class: 'warden-link-btn' }, ['Use recovery key instead']);
    recov.addEventListener('click', function () { renderRecoveryUnlock(); });
    var forgot = el('button', { class: 'warden-link-btn' }, ['Forgot password?']);
    forgot.addEventListener('click', function () { emailMasterHint(forgot); });
    kids.push(el('div', { style: 'display:flex;justify-content:center;gap:4px;flex-wrap:wrap' }, [recov, forgot]));
    host.appendChild(card('Warden is locked', 'Unlock with your ' + (deviceHasBio ? 'biometrics or ' : '') + 'master password.', kids));
    setTimeout(function () { pwIn.focus(); }, 60);
  }

  function renderRecoveryUnlock() {
    var pw = $('warden-pw-panel'); if (!pw) return;
    var input = el('textarea', { class: 'warden-input', rows: '2', placeholder: 'Enter your recovery key (dashes optional)' });
    var err = el('div', { class: 'warden-err' });
    var btn = el('button', { class: 'warden-btn primary' }, ['Recover access']);
    btn.addEventListener('click', async function () {
      err.textContent = ''; btn.disabled = true; btn.textContent = 'Verifying…';
      try {
        var code = input.value;
        await session.unlockWithRecovery(code);
        await afterUnlock({ skipBioOffer: true });
        // You're here because the master password is gone — offer to replace it
        // right away, with the key you just proved you hold. Skippable.
        openResetWithRecovery({ code: code, skippable: true });
      }
      catch (e) { err.textContent = 'That recovery key did not match.'; btn.disabled = false; btn.textContent = 'Recover access'; }
    });
    var back = el('button', { class: 'warden-link-btn' }, ['← Back']);
    back.addEventListener('click', function () { renderLock(true); });
    var host = el('div', { class: 'warden-lock' }, [card('Recovery', 'Enter the one-time recovery key you saved when you created the warden. You can set a new master password right after.', [input, err, btn, back])]);
    pw.innerHTML = ''; pw.appendChild(host);
  }

  // Reset the master password using the RECOVERY KEY instead of the old one.
  // Two entry points: straight after a recovery unlock (opts.code is already
  // known, so the key field is hidden) and the "forgot it" link inside Change
  // Master Password (key typed here). opts.skippable adds a "Later" escape.
  function openResetWithRecovery(opts) {
    opts = opts || {};
    var overlay = el('div', { class: 'warden-overlay' }); // no backdrop-close — avoids losing in-progress edits
    var key = el('textarea', { class: 'warden-input', rows: '2', placeholder: 'Recovery key (dashes optional)' });
    var nw = el('input', { type: 'password', class: 'warden-input', placeholder: 'New master password', autocomplete: 'new-password' });
    var cf = el('input', { type: 'password', class: 'warden-input', placeholder: 'Confirm new password', autocomplete: 'new-password' });
    var hintIn = el('input', { type: 'text', class: 'warden-input', placeholder: 'Password hint (optional)', autocomplete: 'off', maxlength: '160', value: currentHint() });
    var meter = el('div', { class: 'warden-meter' }, [el('div', { class: 'warden-meter-fill' })]);
    nw.addEventListener('input', function () { var s = strength(nw.value); var f = meter.querySelector('.warden-meter-fill'); f.style.width = (s / 4 * 100) + '%'; f.style.background = ['#E74C3C', '#8D769A', '#e0b57c', '#5DAF6D', '#5DAF6D'][s]; });
    var err = el('div', { class: 'warden-err' });
    var save = el('button', { class: 'warden-btn primary' }, ['Set new password']);
    save.addEventListener('click', async function () {
      err.textContent = '';
      var code = opts.code || key.value;
      if (!String(code).trim()) { err.textContent = 'Enter your recovery key.'; return; }
      if (nw.value.length < 12) { err.textContent = 'New password must be at least 12 characters.'; return; }
      if (nw.value !== cf.value) { err.textContent = 'New passwords do not match.'; return; }
      save.disabled = true; save.textContent = 'Saving…';
      try {
        await session.resetMasterPasswordWithRecovery(code, nw.value, hintIn.value.trim());
        overlay.remove();
        toast('Master password reset — your recovery key still works');
        // The recovery key already handed us a live DEK, so the session stays
        // unlocked: just make sure the item list is up and showing.
        if (!store) await afterUnlock(); else showTab(activeTab === 'links' ? 'passwords' : activeTab);
      } catch (e) {
        err.textContent = e.message === 'bad-recovery' ? 'That recovery key did not match.' : ('Failed: ' + (e.message || e));
        save.disabled = false; save.textContent = 'Set new password';
      }
    });
    var closeBtn = el('button', { class: 'warden-btn', onclick: function () { overlay.remove(); if (opts.onClose) opts.onClose(); } }, [opts.skippable ? 'Later' : 'Cancel']);
    var kids = [
      el('div', { class: 'warden-modal-title' }, ['Reset Master Password']),
      el('p', { class: 'warden-sub', style: 'text-align:left' }, [opts.code
        ? 'Your recovery key checked out. Choose a new master password — the same recovery key and any biometric unlocks keep working.'
        : 'Forgot your current password? Enter your recovery key instead and pick a new master password.']),
    ];
    if (!opts.code) kids.push(el('label', { class: 'warden-flabel' }, ['Recovery key']), key);
    kids.push(
      el('label', { class: 'warden-flabel' }, ['New password']), revealField(nw), meter,
      el('label', { class: 'warden-flabel' }, ['Confirm new password']), revealField(cf),
      el('label', { class: 'warden-flabel' }, ['Password hint (optional)']), hintIn,
      err, el('div', { class: 'warden-modal-actions' }, [save, closeBtn]));
    var box = el('div', { class: 'warden-modal', onclick: function (e) { e.stopPropagation(); } }, kids);
    overlay.appendChild(box); document.body.appendChild(overlay);
    setTimeout(function () { (opts.code ? nw : key).focus(); }, 50);
  }
  // The hint currently stored on the config (blank if none / warden not loaded).
  function currentHint() { try { return (session.getConfig() || {}).hint || ''; } catch (e) { return ''; } }

  async function afterUnlock(opts) {
    store = session.getStore();
    await store.load();
    // One live subscription drives every tab — a card added on another device
    // lands here the same instant a password does.
    // Cloud is excluded on purpose: it draws from the provider APIs, not this
    // document, so a warden sync has nothing new for it and the repaint would
    // fight whatever is on screen (a search being typed, a folder mid-load).
    store.startLive(function () {
      setWardenSync('synced');
      if (activeTab !== 'cloud' && SECRET_TABS[activeTab]) SECRET_TABS[activeTab]();
    });
    bindActivity();
    // Suppressed on the recovery path so the enrol prompt doesn't collide with
    // the "set a new master password" modal; it re-offers on the next unlock.
    if (!(opts && opts.skipBioOffer)) maybeOfferBiometric();
    showTab(activeTab === 'links' ? 'passwords' : activeTab);
  }
  // Reset the idle auto-lock timer on user activity (throttled) so the 1-hour
  // lock is measured from the last interaction, not from unlock.
  var _activityBound = false, _lastTouch = 0;
  function bindActivity() {
    if (_activityBound) return; _activityBound = true;
    ['click', 'keydown', 'pointerdown'].forEach(function (ev) {
      document.addEventListener(ev, function () { var now = Date.now(); if (session && session.isUnlocked() && now - _lastTouch > 10000) { _lastTouch = now; session.touch(); } }, true);
    });
  }
  async function maybeOfferBiometric() {
    try {
      if (!window.Bio) return;
      if (await session.biometricEnabled()) {
        // Already enrolled — but if it is an OLD slot (unlock key sitting in
        // local storage) and this browser can now bind the key to the scan
        // instead, offer the swap once. Declining is remembered so it asks at
        // most once per device.
        if (localStorage.getItem('warden.prfUpgradeDeclined')) return;
        if (!(await session.biometricNeedsPrfUpgrade())) return;
        var bl = window.Bio.label ? window.Bio.label() : 'biometrics';
        var up = await confirmUI(
          'Warden can make your ' + bl + ' unlock stronger on this device.\n\n' +
          'Right now the unlock key is stored on the device and the scan is checked in front of it. ' +
          'Re-registering lets your ' + bl + ' produce the key instead, so nothing is left on disk to copy.\n\n' +
          'Takes one scan. Your master password is unaffected.',
          { title: 'Strengthen ' + bl, okLabel: 'Re-register', cancelLabel: 'Not now' });
        if (!up) { try { localStorage.setItem('warden.prfUpgradeDeclined', '1'); } catch (_) {} return; }
        try {
          await session.enableBiometric(bl);   // replaces the slot, drops the stored key
          toast(bl + ' strengthened on this device');
        } catch (e) {
          if (e && e.message !== 'cancelled') toast('Could not re-register: ' + e.message);
        }
        return;
      }
      if (!(await session.biometricSupported())) return;
      if (localStorage.getItem('warden.bioDeclined')) return;
      var label = window.Bio.label ? window.Bio.label() : 'biometrics';
      var ok = await confirmUI('Enable ' + label + ' to unlock your Warden on this device? Your master password still works as a fallback.',
        { title: 'Enable ' + label, okLabel: 'Enable', cancelLabel: 'Not now' });
      if (!ok) { localStorage.setItem('warden.bioDeclined', '1'); return; }
      await session.enableBiometric(label); toast(label + ' enabled on this device');
    } catch (e) {
      // 'bio-no-prf' means this browser can't tie the unlock key to the
      // fingerprint, so enabling would only put a key in local storage behind
      // an app-level prompt. Don't nag about it on every load — the offer is
      // still available from Settings, where the trade-off is spelled out.
      if (e && e.message === 'bio-no-prf') { try { localStorage.setItem('warden.bioDeclined', '1'); } catch (_) {} }
      console.warn('[warden] biometric enroll skipped', e);
    }
  }

  // ── passwords panel ────────────────────────────────────────────────────────
  // The toolbar (with the search box) is built ONCE per full render; typing only
  // re-fills the list container via refreshList(), so the search input keeps
  // focus and never "stops after one character".
  function renderPasswords() {
    var panel = $('warden-pw-panel'); if (!panel) return;
    if (!session || !session.isUnlocked()) { renderLock(); return; }
    if (!store) { afterUnlock(); return; } // store not ready yet — bootstrap then re-render
    panel.innerHTML = '';
    panel.appendChild(toolbar('Search logins…', 'login'));
    var list = el('div', { class: 'warden-list' });
    fillLoginList(list);
    panel.appendChild(list);
  }
  function fillLoginList(list) {
    list.innerHTML = '';
    var items = currentQuery ? store.search(currentQuery).filter(function (i) { return i.kind === 'login'; }) : store.byKind('login');
    var groups = {};
    items.forEach(function (it) {
      var key = (it.url || it.title || 'other').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      (groups[key] = groups[key] || { key: key, sample: it, items: [] }).items.push(it);
    });
    var groupList = Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) { return (a.sample.title || a.key).localeCompare(b.sample.title || b.key); });
    if (!groupList.length) { list.appendChild(emptyState(currentQuery ? 'No matches.' : 'No logins yet. Add your first one, or import from Chrome/Bitwarden later.')); return; }
    groupList.forEach(function (g) { list.appendChild(siteRow(g)); });
    if (list.querySelector('.warden-totp')) { ensureTotpTicker(); refreshTotps(); }
  }
  function fillSensitiveList(list) {
    list.innerHTML = '';
    var searching = !!currentQuery;
    var items = searching ? store.search(currentQuery).filter(function (i) { return i.kind === 'sensitive'; }) : sortSensitive(store.byKind('sensitive'));
    if (!items.length) { list.appendChild(emptyState('No secure notes yet. Store Wi-Fi passwords, lock combos, recovery codes, license keys…')); return; }
    items.forEach(function (it) { list.appendChild(sensitiveRow(it, searching)); });
    // Reordering a FILTERED list would be a lie: positions 0..n of a search
    // result aren't positions in the warden. So drag is only live on the full
    // list, and the handle explains itself when it isn't.
    if (!searching && items.length > 1) makeReorderable(list, commitSensitiveOrder);
  }
  function fillPaymentList(list) {
    if (!window.WardenPayUI) { list.innerHTML = ''; list.appendChild(emptyState('Payments module not loaded.')); return; }
    window.WardenPayUI.fillList(list, hostCtx());
  }
  function fillIdList(list) {
    if (!window.WardenIdUI) { list.innerHTML = ''; list.appendChild(emptyState('ID Docs module not loaded.')); return; }
    window.WardenIdUI.fillList(list, hostCtx());
  }
  // Re-fill just the list for the active kind (used on every keystroke).
  var KIND_PANELS = { login: 'warden-pw-panel', payment: 'warden-payments-panel', iddoc: 'warden-iddocs-panel', sensitive: 'warden-sensitive-panel' };
  var KIND_RENDER = { login: renderPasswords, payment: renderPayments, iddoc: renderIdDocs, sensitive: renderSensitive };
  var KIND_FILL = { login: fillLoginList, payment: fillPaymentList, iddoc: fillIdList, sensitive: fillSensitiveList };
  function refreshList(kind) {
    var panel = $(KIND_PANELS[kind] || KIND_PANELS.login); if (!panel) return;
    var list = panel.querySelector('.warden-list');
    if (!list) { (KIND_RENDER[kind] || renderPasswords)(); return; }
    (KIND_FILL[kind] || fillLoginList)(list);
  }

  function toolbar(placeholder, kind) {
    var search = el('input', { class: 'warden-search', placeholder: placeholder, value: currentQuery });
    var clear = el('button', { class: 'warden-search-clear', title: 'Clear', html: '&times;', style: currentQuery ? '' : 'display:none' });
    clear.addEventListener('click', function () { currentQuery = ''; search.value = ''; clear.style.display = 'none'; refreshList(kind); search.focus(); });
    search.addEventListener('input', function () { currentQuery = search.value; clear.style.display = search.value ? '' : 'none'; refreshList(kind); });
    var add = el('button', { class: 'warden-btn primary sm', onclick: function () { openAdd(kind); } }, ['+ Add']);
    // Settings + Lock live here (top of the section) so they're always reachable
    // without scrolling to the bottom.
    var kids = [el('div', { class: 'warden-search-wrap' }, [search, clear]), add];
    if (kind === 'login') kids.push(iconBtn('Password health', shieldIcon(), openHealth));
    kids.push(iconBtn('Settings', gearIcon(), openSettings));
    kids.push(iconBtn('Lock now', lockIcon(), function () { session.lock(); renderLock(true); }));
    return el('div', { class: 'warden-toolbar' }, kids);
  }
  function emptyState(msg) { return el('div', { class: 'warden-empty' }, [msg]); }

  function siteRow(g) {
    var multi = g.items.length > 1;
    var subText = multi ? g.items.length + ' accounts' : (g.sample.username || g.sample.email || g.key);
    var head = el('div', { class: 'warden-row' }, [
      favicon(g.sample.url),
      el('div', { class: 'warden-row-main' }, [
        el('div', { class: 'warden-row-title' }, [g.sample.title || g.key]),
        el('div', { class: 'warden-row-sub' }, [subText]),
      ]),
      g.sample.category ? el('span', { class: 'warden-tag' }, [g.sample.category]) : null,
    ]);
    var wrap = el('div', { class: 'warden-site' }, [head]);
    var body = el('div', { class: 'warden-accounts' });
    g.items.forEach(function (it) { body.appendChild(accountRow(it, multi)); });
    if (multi) { head.style.cursor = 'pointer'; body.style.display = 'none'; head.addEventListener('click', function () { body.style.display = body.style.display === 'none' ? '' : 'none'; }); }
    wrap.appendChild(body);
    return wrap;
  }

  // One stacked value line: label + value (no inline buttons — all actions live
  // in the single button row on the right).
  function valLine(label, value, muted) {
    return el('div', { class: 'warden-acc-line' }, [
      el('div', { class: 'warden-acc-field' }, [
        el('span', { class: 'warden-acc-flabel' }, [label]),
        el('span', { class: 'warden-acc-val' + (muted ? ' muted' : '') }, [value]),
      ]),
    ]);
  }
  // A self-updating TOTP line (the ticker refreshes .warden-totp elements).
  function totpLineEl(secret) {
    var codeEl = el('span', { class: 'warden-totp-code' }, ['······']);
    var bar = el('div', { class: 'warden-totp-bar' }, [el('div', {})]);
    var wrap = el('div', { class: 'warden-acc-line warden-totp' }, [
      el('div', { class: 'warden-acc-field' }, [el('span', { class: 'warden-acc-flabel' }, ['One-time code (2FA)']), el('div', { class: 'warden-totp-main' }, [codeEl, bar])]),
      iconBtn('Copy code', copyIcon(), function () { copyText(wrap.__totpCode || '', 'Code copied'); }),
    ]);
    wrap.__totpSecret = secret;
    return wrap;
  }
  function accountRow(it, indented) {
    var shown = false, revBtn;
    var pwText = el('span', { class: 'warden-pw-dots' }, ['••••••••••']);
    function toggle() { shown = !shown; pwText.textContent = shown ? (it.password || '') : '••••••••••'; if (revBtn) revBtn.innerHTML = shown ? eyeOff() : eye(); }
    revBtn = el('button', { class: 'warden-icon', title: 'Reveal password', onclick: toggle, html: eye() });

    var main = el('div', { class: 'warden-acc-main' });
    if (it.username) main.appendChild(valLine('Username', it.username));
    if (it.email) main.appendChild(valLine('Email', it.email));
    if (!it.username && !it.email) main.appendChild(valLine('Username', '(none)', true));
    main.appendChild(el('div', { class: 'warden-acc-line' }, [
      el('div', { class: 'warden-acc-field' }, [el('span', { class: 'warden-acc-flabel' }, ['Password']), el('span', { class: 'warden-acc-pw' }, [pwText])]),
    ]));
    // Live TOTP code (if a 2FA secret is stored).
    if (it.totp) main.appendChild(totpLineEl(it.totp));
    // Custom fields (each independently copyable).
    (Array.isArray(it.customFields) ? it.customFields : []).forEach(function (cf) {
      if (!cf || (!cf.label && !cf.value)) return;
      main.appendChild(el('div', { class: 'warden-acc-line' }, [
        el('div', { class: 'warden-acc-field' }, [el('span', { class: 'warden-acc-flabel' }, [cf.label || 'Field']), el('span', { class: 'warden-acc-val' }, [cf.value || ''])]),
        iconBtn('Copy ' + (cf.label || 'value'), copyIcon(), function () { copyText(cf.value || '', (cf.label || 'Value') + ' copied'); }),
      ]));
    });

    // ONE horizontal row of actions: copy username, copy email, copy password,
    // reveal, open, edit.
    var actions = el('div', { class: 'warden-acc-actions' });
    if (it.username) actions.appendChild(iconBtn('Copy username', userIcon(), function () { copyText(it.username, 'Username copied'); }));
    if (it.email) actions.appendChild(iconBtn('Copy email', mailIcon(), function () { copyText(it.email, 'Email copied'); }));
    actions.appendChild(iconBtn('Copy password', keyIcon(), function () { copyText(it.password || '', 'Password copied'); }));
    actions.appendChild(revBtn);
    if (it.url) actions.appendChild(iconBtn('Open site', extIcon(), function () { window.open(/^https?:/.test(it.url) ? it.url : 'https://' + it.url, '_blank', 'noopener'); }));
    actions.appendChild(iconBtn('Edit', editIcon(), function () { openEditor('login', it); }));

    return el('div', { class: 'warden-account' + (indented ? ' indented' : '') }, [main, actions]);
  }

  // ── drag to reorder (shared: Payments + Sensitive Info) ────────────────────
  // ONE engine for every reorderable list in Warden, so the two sections can
  // never drift apart in feel. Contract: `listEl`'s direct children are the
  // rows, each `.warden-site[data-id]`, each carrying a `.warden-drag` handle and
  // (optionally) a `.warden-rowbody` that collapses mid-drag.
  //
  // Pointer Events, so mouse / touch / pen are ONE code path — HTML5 drag-and-
  // drop is desktop-only and would have needed a separate touch implementation.
  //
  // Dragging is anchored to an explicit handle rather than the whole row: on a
  // phone, "press the row and move" is indistinguishable from "scroll the
  // list", and the row is also the tap target that expands the card. The handle
  // carries `touch-action:none` so the browser hands us the gesture instead of
  // scrolling.
  //
  // While a drag is live the list gets `.warden-reordering`, which collapses
  // every expanded body via CSS (no re-render). That makes all rows the same
  // height, so the target index is exact integer arithmetic instead of
  // per-row hit-testing against ragged heights.
  function scrollParent(node) {
    for (var e = node.parentElement; e; e = e.parentElement) {
      var s = getComputedStyle(e).overflowY;
      if ((s === 'auto' || s === 'scroll') && e.scrollHeight > e.clientHeight) return e;
    }
    return null;
  }
  // Pure array move. Mirrors WardenPay.moveInList (which is unit-tested) but is
  // kept local so the shell never depends on the payments module loading.
  function moveInList(list, from, to) {
    var out = (list || []).slice();
    if (from < 0 || from >= out.length) return out;
    to = Math.max(0, Math.min(out.length - 1, to));
    out.splice(to, 0, out.splice(from, 1)[0]);
    return out;
  }

  function makeReorderable(listEl, onCommit) {
    if (listEl.__reorderBound) return;
    listEl.__reorderBound = true;

    listEl.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button > 0) return;                 // left/primary only
      var handle = e.target.closest && e.target.closest('.warden-drag');
      if (!handle || handle.classList.contains('disabled') || !listEl.contains(handle)) return;
      start(e, handle);
    });

    function start(e, handle) {
      var row = handle.closest('.warden-site');
      var rows = Array.prototype.slice.call(listEl.children);
      var from = rows.indexOf(row);
      if (from < 0 || rows.length < 2) return;

      e.preventDefault();
      e.stopPropagation();                        // never let this reach the row's expand handler
      listEl.classList.add('warden-reordering');   // uniform row heights from here on

      // Measure AFTER collapsing, so `step` reflects what's on screen now.
      var rects = rows.map(function (r) { return r.getBoundingClientRect(); });
      var step = rows.length > 1 ? (rects[1].top - rects[0].top) : rects[0].height;
      if (!step) { listEl.classList.remove('warden-reordering'); return; }

      var scroller = scrollParent(listEl);
      var startY = e.clientY;
      var startScroll = scroller ? scroller.scrollTop : 0;
      var to = from, raf = null, lastY = startY;

      row.classList.add('warden-drag-active');
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}

      function place(dy) {
        row.style.transform = 'translateY(' + dy + 'px)';
        var next = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / step)));
        if (next === to) return;
        to = next;
        rows.forEach(function (r, i) {
          if (i === from) return;
          var shift = 0;
          if (from < to && i > from && i <= to) shift = -step;
          else if (from > to && i >= to && i < from) shift = step;
          r.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
        });
      }
      // Rects are viewport-based, so a scroll moves every row equally; adding
      // the scroll delta back keeps the dragged row under the finger AND keeps
      // the index maths consistent with the original measurements.
      function currentDy() { return (lastY - startY) + ((scroller ? scroller.scrollTop : 0) - startScroll); }

      // Auto-scroll when dragging near the edge — without it you can't move a
      // card past the fold on a phone.
      function edgeScroll() {
        raf = null;
        if (!scroller) return;
        var box = scroller.getBoundingClientRect();
        var zone = 64, speed = 0;
        if (lastY < box.top + zone) speed = -Math.ceil((box.top + zone - lastY) / 6);
        else if (lastY > box.bottom - zone) speed = Math.ceil((lastY - (box.bottom - zone)) / 6);
        if (speed) {
          scroller.scrollTop += speed;
          place(currentDy());
          raf = requestAnimationFrame(edgeScroll);
        }
      }

      function onMove(ev) {
        lastY = ev.clientY;
        place(currentDy());
        if (raf == null) raf = requestAnimationFrame(edgeScroll);
      }
      function onUp() {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        if (raf != null) { cancelAnimationFrame(raf); raf = null; }
        try { handle.releasePointerCapture(e.pointerId); } catch (_) {}

        rows.forEach(function (r) { r.style.transform = ''; });
        row.classList.remove('warden-drag-active');
        listEl.classList.remove('warden-reordering');

        if (to !== from) {
          // Re-append in the new order (appendChild moves an existing child),
          // so the DOM matches the drop immediately — the save is what catches
          // up, not the other way round.
          var ordered = moveInList(rows, from, to);
          ordered.forEach(function (r) { listEl.appendChild(r); });
          onCommit(ordered.map(function (r) { return r.getAttribute('data-id'); }));
        }
      }
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    }

    // Keyboard equivalent — the handle is a real button, so ↑/↓ move the row
    // for anyone not using a pointer at all.
    listEl.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      var handle = e.target.closest && e.target.closest('.warden-drag');
      if (!handle || handle.classList.contains('disabled') || !listEl.contains(handle)) return;
      var rows = Array.prototype.slice.call(listEl.children);
      var row = handle.closest('.warden-site');
      var from = rows.indexOf(row);
      var to = from + (e.key === 'ArrowUp' ? -1 : 1);
      if (from < 0 || to < 0 || to >= rows.length) return;
      e.preventDefault();
      var ordered = moveInList(rows, from, to);
      ordered.forEach(function (r) { listEl.appendChild(r); });
      handle.focus();
      onCommit(ordered.map(function (r) { return r.getAttribute('data-id'); }));
    });
  }
  // The grip glyph every drag handle uses.
  function gripIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>'; }
  // A ready-made handle button. `searching` disables it: positions 0..n of a
  // filtered list aren't positions in the real list, so reordering one would be
  // a lie — the handle says so instead of silently doing the wrong thing.
  function dragHandle(label, searching, onBlocked) {
    return el('button', {
      class: 'warden-icon warden-drag' + (searching ? ' disabled' : ''),
      type: 'button',
      'aria-label': searching ? 'Clear the search to reorder' : 'Reorder ' + label + ' — drag, or use the arrow keys',
      title: searching ? 'Clear the search to reorder' : 'Drag to reorder (or focus and press ↑ / ↓)',
      html: gripIcon(),
      onclick: function (e) { e.stopPropagation(); if (searching && onBlocked) onBlocked(); },
    });
  }

  // ── sensitive info panel ───────────────────────────────────────────────────
  function renderSensitive() {
    var panel = $('warden-sensitive-panel'); if (!panel) return;
    if (!session || !session.isUnlocked()) { renderLock(); return; }
    if (!store) { afterUnlock(); return; } // store not ready yet — bootstrap then re-render
    panel.innerHTML = '';
    panel.appendChild(toolbar('Search secure notes…', 'sensitive'));
    var list = el('div', { class: 'warden-list' });
    fillSensitiveList(list);
    panel.appendChild(list);
  }
  // Manual order first (ascending), then everything that has never been dragged
  // in the order the store already hands back (most recently updated first) —
  // so switching a warden to manual ordering never reshuffles the untouched tail.
  function sortSensitive(items) {
    var manual = items.filter(hasOrder).sort(function (a, b) {
      if (a.order !== b.order) return a.order - b.order;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
    return manual.concat(items.filter(function (i) { return !hasOrder(i); }));
  }
  function hasOrder(i) { return i && typeof i.order === 'number' && isFinite(i.order); }
  // Where a newly added note should sit: the top of an already-ordered list,
  // or undefined (keep the default recency sort) when nothing has been dragged.
  function nextTopOrder(items) {
    var orders = (items || []).filter(hasOrder).map(function (i) { return i.order; });
    return orders.length ? Math.min.apply(null, orders) - 1 : undefined;
  }
  // Persist a new sequence. Only the notes whose position actually moved are
  // re-encrypted and written, and they go out as ONE batch → one repaint, one
  // debounced Firestore write, and other devices pick it up on the same
  // real-time listener that already carries every other warden change.
  async function commitSensitiveOrder(orderedIds) {
    var byId = {};
    store.byKind('sensitive').forEach(function (i) { byId[i.id] = i; });
    var writes = [];
    orderedIds.forEach(function (id, i) {
      var it = byId[id];
      if (it && it.order !== i) writes.push(Object.assign({}, it, { order: i }));
    });
    if (!writes.length) return;
    try { await store.saveMany(writes); }
    catch (e) { toast('Could not save the new order'); refreshList('sensitive'); }
  }
  function sensitiveRow(it, searching) {
    var hasNotes = !!(it.notes && String(it.notes).trim());
    var cfKids = (Array.isArray(it.customFields) ? it.customFields : []).filter(function (cf) { return cf && (cf.label || cf.value); }).map(function (cf) {
      return el('div', { class: 'warden-acc-line' }, [
        el('div', { class: 'warden-acc-field' }, [el('span', { class: 'warden-acc-flabel' }, [cf.label || 'Field']), el('span', { class: 'warden-acc-val' }, [cf.value || ''])]),
        iconBtn('Copy ' + (cf.label || 'value'), copyIcon(), function () { copyText(cf.value || '', (cf.label || 'Value') + ' copied'); }),
      ]);
    });
    // Only show the details box + its copy button when there's actually a note.
    var bodyKids = [];
    if (hasNotes) bodyKids.push(el('div', { class: 'warden-note-text' }, [it.notes]));
    if (cfKids.length) bodyKids.push(el('div', { class: 'warden-note-cf' }, cfKids));
    if (hasNotes) bodyKids.push(el('div', { class: 'warden-note-actions' }, [iconBtn('Copy details', copyIcon(), function (e) { e.stopPropagation(); copyText(it.notes, 'Details copied'); })]));
    if (!bodyKids.length) bodyKids.push(el('div', { class: 'warden-note-text', style: 'color:var(--txm)' }, ['No details yet — tap edit to add.']));
    // .warden-rowbody lets the shared drag engine collapse this while reordering.
    var body = el('div', { class: 'warden-note-body warden-rowbody' }, bodyKids);
    body.style.display = _senOpen[it.id] ? '' : 'none';
    var head = el('div', { class: 'warden-row warden-note-head', style: 'cursor:pointer' }, [
      dragHandle(it.title || 'this note', searching, function () { toast('Clear the search to reorder notes'); }),
      el('div', { class: 'warden-note-icon', html: cabinetIcon() }),
      el('div', { class: 'warden-row-main' }, [
        el('div', { class: 'warden-row-title' }, [it.title || 'Untitled']),
        it.category ? el('div', { class: 'warden-row-sub' }, [it.category]) : null,
      ]),
      iconBtn('Edit', editIcon(), function (e) { e.stopPropagation(); openEditor('sensitive', it); }),
    ]);
    head.addEventListener('click', function () {
      _senOpen[it.id] = body.style.display === 'none';
      body.style.display = _senOpen[it.id] ? '' : 'none';
    });
    return el('div', { class: 'warden-site', 'data-id': it.id }, [head, body]);
  }

  // ── payments panel (rendering delegated to warden-pay-ui.js) ────────────────
  function renderPayments() {
    var panel = $('warden-payments-panel'); if (!panel) return;
    if (!session || !session.isUnlocked()) { renderLock(); return; }
    if (!store) { afterUnlock(); return; } // store not ready yet — bootstrap then re-render
    panel.innerHTML = '';
    if (!window.WardenPayUI) { panel.appendChild(emptyState('Payments module not loaded — check the warden-pay.js / warden-pay-ui.js includes.')); return; }
    panel.appendChild(toolbar('Search cards…', 'payment'));
    var list = el('div', { class: 'warden-list' });
    fillPaymentList(list);
    panel.appendChild(list);
  }

  // ── ID docs panel (rendering delegated to warden-id-ui.js) ──────────────────
  function renderIdDocs() {
    var panel = $('warden-iddocs-panel'); if (!panel) return;
    if (!session || !session.isUnlocked()) { renderLock(); return; }
    if (!store) { afterUnlock(); return; } // store not ready yet — bootstrap then re-render
    panel.innerHTML = '';
    if (!window.WardenIdUI) { panel.appendChild(emptyState('ID Docs module not loaded — check the warden-id.js / warden-id-files.js / warden-id-ui.js includes.')); return; }
    panel.appendChild(toolbar('Search ID documents…', 'iddoc'));
    var list = el('div', { class: 'warden-list' });
    fillIdList(list);
    panel.appendChild(list);
  }

  // ── editor modal ───────────────────────────────────────────────────────────
  // The "+ Add" button routes here so each kind can own its own editor.
  function openAdd(kind) {
    if (kind === 'payment') { if (window.WardenPayUI) window.WardenPayUI.openEditor(null, hostCtx()); return; }
    if (kind === 'iddoc') { if (window.WardenIdUI) window.WardenIdUI.openTypePicker(hostCtx()); return; }
    openEditor(kind);
  }
  function openEditor(kind, item) {
    item = item || {};
    var isLogin = kind === 'login';
    var overlay = el('div', { class: 'warden-overlay' }); // no backdrop-close — avoids losing in-progress edits
    function close() { overlay.remove(); }
    var f = {};
    function field(label, key, opts) {
      opts = opts || {};
      var input = el(opts.textarea ? 'textarea' : 'input', { class: 'warden-input', type: opts.type || 'text', value: item[key] || '', placeholder: opts.ph || '' });
      f[key] = input;
      var row = [el('label', { class: 'warden-flabel' }, [label]), input];
      if (opts.after) row.push(opts.after);
      return el('div', { class: 'warden-field' }, row);
    }
    var body = el('div', { class: 'warden-modal', onclick: function (e) { e.stopPropagation(); } });
    body.appendChild(el('div', { class: 'warden-modal-title' }, [(item.id ? 'Edit ' : 'Add ') + (isLogin ? 'Login' : 'Secure Note')]));
    if (isLogin) {
      body.appendChild(field('Name', 'title', { ph: 'e.g. GitHub' }));
      body.appendChild(field('Website / URL', 'url', { ph: 'github.com' }));
      body.appendChild(field('Username', 'username', { ph: 'username' }));
      body.appendChild(field('Email', 'email', { ph: 'you@example.com' }));
      // password with reveal + generate
      var pwInput = el('input', { class: 'warden-input', type: 'password', value: item.password || '', placeholder: 'password' }); f.password = pwInput;
      var gen = el('button', { class: 'warden-icon', title: 'Generate', html: VI.dice, type: 'button' });
      var rev = el('button', { class: 'warden-icon', title: 'Reveal', html: eye(), type: 'button' });
      var showp = false; rev.addEventListener('click', function () { showp = !showp; pwInput.type = showp ? 'text' : 'password'; rev.innerHTML = showp ? eyeOff() : eye(); });
      gen.addEventListener('click', function () { openGenerator(function (v) { pwInput.value = v; pwInput.type = 'text'; showp = true; rev.innerHTML = eyeOff(); }); });
      body.appendChild(el('div', { class: 'warden-field' }, [el('label', { class: 'warden-flabel' }, ['Password']), el('div', { class: 'warden-pw-input' }, [pwInput, rev, gen])]));
      body.appendChild(catField(f, item));
      body.appendChild(field('Authenticator (2FA) secret', 'totp', { ph: 'base32 secret or otpauth:// — shows a live code' }));
      body.appendChild(field('Tags (comma-separated)', 'tags', { ph: 'work, personal' }));
      body.appendChild(field('Notes', 'notes', { textarea: true }));
    } else {
      body.appendChild(field('Title', 'title', { ph: 'e.g. Home Wi-Fi, Safe combo' }));
      body.appendChild(catField(f, item));
      body.appendChild(field('Details', 'notes', { textarea: true, ph: 'The secret info you want to keep safe…' }));
    }

    // ── custom fields (both kinds) ──
    var customFields = (Array.isArray(item.customFields) ? item.customFields : []).map(function (c) { return { label: c.label || '', value: c.value || '' }; });
    var cfWrap = el('div', {});
    function renderCF() {
      cfWrap.innerHTML = '';
      customFields.forEach(function (cf, i) {
        var lbl = el('input', { class: 'warden-input', placeholder: 'Label', value: cf.label, style: 'margin:0' });
        var val = el('input', { class: 'warden-input', placeholder: 'Value', value: cf.value, style: 'margin:0' });
        lbl.addEventListener('input', function () { customFields[i].label = lbl.value; });
        val.addEventListener('input', function () { customFields[i].value = val.value; });
        var rm = el('button', { class: 'warden-icon', type: 'button', title: 'Remove', html: '&times;', onclick: function () { customFields.splice(i, 1); renderCF(); } });
        cfWrap.appendChild(el('div', { class: 'warden-cf-row' }, [lbl, val, rm]));
      });
    }
    renderCF();
    var addCf = el('button', { class: 'warden-btn', type: 'button', style: 'width:auto;margin:2px 0 0;padding:8px 12px', onclick: function () { customFields.push({ label: '', value: '' }); renderCF(); } }, ['+ Add custom field']);
    body.appendChild(el('div', { class: 'warden-field' }, [el('label', { class: 'warden-flabel' }, ['Custom fields']), cfWrap, addCf]));

    // ── password history (login; view-only) ──
    if (isLogin && Array.isArray(item.passwordHistory) && item.passwordHistory.length) {
      var histWrap = el('div', { class: 'warden-hist', style: 'display:none' });
      item.passwordHistory.forEach(function (h) {
        histWrap.appendChild(el('div', { class: 'warden-hist-row' }, [
          el('span', { class: 'warden-hist-pw' }, [h.password]),
          el('span', { class: 'warden-hist-date' }, [h.at ? new Date(h.at).toLocaleDateString() : '']),
          iconBtn('Copy old password', copyIcon(), function () { copyText(h.password, 'Old password copied'); }),
        ]));
      });
      var histToggle = el('button', { class: 'warden-link-btn', type: 'button', style: 'padding:4px 0', onclick: function () { histWrap.style.display = histWrap.style.display === 'none' ? '' : 'none'; } }, ['Previous passwords (' + item.passwordHistory.length + ')']);
      body.appendChild(el('div', { class: 'warden-field' }, [histToggle, histWrap]));
    }

    var err = el('div', { class: 'warden-err' });
    var save = el('button', { class: 'warden-btn primary' }, [item.id ? 'Save' : 'Add']);
    save.addEventListener('click', async function () {
      var out = { id: item.id, kind: kind, createdAt: item.createdAt };
      Object.keys(f).forEach(function (k) { out[k] = f[k].value; });
      // Manual position is set by dragging, not by this form — carry it across
      // an edit, and drop a brand-new note at the top of an ordered list (you
      // just created it; you want to see it) as Payments does.
      if (kind === 'sensitive') {
        if (hasOrder(item)) out.order = item.order;
        else if (!item.id) { var top = nextTopOrder(store.byKind('sensitive')); if (top !== undefined) out.order = top; }
      }
      if (out.tags != null) out.tags = String(out.tags).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      out.customFields = customFields.filter(function (c) { return (c.label || '').trim() || (c.value || '').trim(); });
      if (isLogin ? (!out.title && !out.url) : !out.title) { err.textContent = 'Give it a name.'; return; }
      save.disabled = true; save.textContent = 'Saving…';
      try { await store.save(out); close(); (isLogin ? renderPasswords : renderSensitive)(); toast('Saved'); }
      catch (e) { err.textContent = 'Save failed: ' + e.message; save.disabled = false; save.textContent = 'Save'; }
    });
    var actions = [save, el('button', { class: 'warden-btn', onclick: close }, ['Cancel'])];
    if (item.id) { var del = el('button', { class: 'warden-btn danger', onclick: async function () { if (await confirmUI('Delete this item? This cannot be undone.', { title: 'Delete item', okLabel: 'Delete', danger: true })) { await store.remove(item.id); close(); (isLogin ? renderPasswords : renderSensitive)(); toast('Deleted'); } } }, ['Delete']); actions.push(del); }
    body.appendChild(err);
    body.appendChild(el('div', { class: 'warden-modal-actions' }, actions));
    overlay.appendChild(body); document.body.appendChild(overlay);
    setTimeout(function () { var first = body.querySelector('input,textarea'); if (first) first.focus(); }, 50);
  }
  function catField(f, item) {
    var sel = el('select', { class: 'warden-input' });
    var cats = CATEGORIES.slice(); if (item.category && cats.indexOf(item.category) < 0) cats.unshift(item.category);
    cats.forEach(function (c) { var o = el('option', { value: c }, [c]); if (item.category === c) o.selected = true; sel.appendChild(o); });
    f.category = sel;
    return el('div', { class: 'warden-field' }, [el('label', { class: 'warden-flabel' }, ['Category']), sel]);
  }

  // ── generator modal ────────────────────────────────────────────────────────
  function openGenerator(onUse) {
    var overlay = el('div', { class: 'warden-overlay' }); // no backdrop-close — avoids losing in-progress edits
    var mode = 'password';
    var out = el('div', { class: 'warden-gen-out' });
    var opts = { length: 20, lower: true, upper: true, num: true, sym: true, easy: false };
    var pass = { words: 4 };
    function regen() { out.textContent = mode === 'password' ? genPassword(opts) : genPassphrase(pass.words); }
    function toggleRow(label, key, obj) {
      var cb = el('input', { type: 'checkbox' }); cb.checked = !!obj[key];
      cb.addEventListener('change', function () { obj[key] = cb.checked; regen(); });
      return el('label', { class: 'warden-gen-opt' }, [cb, el('span', {}, [label])]);
    }
    var body = el('div', { class: 'warden-modal', onclick: function (e) { e.stopPropagation(); } }, [
      el('div', { class: 'warden-modal-title' }, ['Password Generator']),
      el('div', { class: 'warden-gen-tabs' }, [
        genTab('Password', function () { mode = 'password'; buildOpts(); regen(); }, true),
        genTab('Passphrase', function () { mode = 'passphrase'; buildOpts(); regen(); }, false),
      ]),
      out,
    ]);
    var optWrap = el('div', { class: 'warden-gen-opts' });
    function buildOpts() {
      optWrap.innerHTML = '';
      if (mode === 'password') {
        var lenLabel = el('span', {}, ['Length: ' + opts.length]);
        var slider = el('input', { type: 'range', min: '8', max: '64', value: String(opts.length), class: 'warden-range' });
        slider.addEventListener('input', function () { opts.length = +slider.value; lenLabel.textContent = 'Length: ' + opts.length; regen(); });
        optWrap.appendChild(el('div', { class: 'warden-gen-len' }, [lenLabel, slider]));
        optWrap.appendChild(el('div', { class: 'warden-gen-grid' }, [
          toggleRow('a-z', 'lower', opts), toggleRow('A-Z', 'upper', opts),
          toggleRow('0-9', 'num', opts), toggleRow('!@#$', 'sym', opts),
          toggleRow('Easy to read', 'easy', opts),
        ]));
      } else {
        var wl = el('span', {}, ['Words: ' + pass.words]);
        var ws = el('input', { type: 'range', min: '3', max: '8', value: String(pass.words), class: 'warden-range' });
        ws.addEventListener('input', function () { pass.words = +ws.value; wl.textContent = 'Words: ' + pass.words; regen(); });
        optWrap.appendChild(el('div', { class: 'warden-gen-len' }, [wl, ws]));
      }
    }
    body.appendChild(optWrap);
    var useBtn = el('button', { class: 'warden-btn primary' }, ['Use']);
    useBtn.addEventListener('click', function () { onUse(out.textContent); overlay.remove(); });
    var copyBtn = el('button', { class: 'warden-btn', onclick: function () { copyText(out.textContent, 'Password copied'); } }, ['Copy']);
    var reBtn = el('button', { class: 'warden-btn', onclick: regen, html: VI.refresh + '<span>Regenerate</span>' });
    var closeBtn = el('button', { class: 'warden-btn', onclick: function () { overlay.remove(); } }, ['Close']);
    body.appendChild(el('div', { class: 'warden-modal-actions' }, [useBtn, copyBtn, reBtn, closeBtn]));
    buildOpts(); regen();
    overlay.appendChild(body); document.body.appendChild(overlay);
  }
  function genTab(label, onClick, active) { var b = el('button', { class: 'warden-gen-tab' + (active ? ' active' : ''), onclick: function () { body_setActive(b); onClick(); } }, [label]); return b; }
  function body_setActive(b) { var p = b.parentNode; p.querySelectorAll('.warden-gen-tab').forEach(function (x) { x.classList.remove('active'); }); b.classList.add('active'); }

  function footerBar() {
    var lock = el('button', { class: 'warden-link-btn', onclick: function () { session.lock(); renderLock(true); }, html: VI.lock + '<span>Lock now</span>' });
    var settings = el('button', { class: 'warden-link-btn', onclick: openSettings, html: VI.settings + '<span>Settings</span>' });
    return el('div', { class: 'warden-footer' }, [settings, lock]);
  }
  function openSettings() {
    var overlay = el('div', { class: 'warden-overlay' }); // no backdrop-close — avoids losing in-progress edits
    var body = el('div', { class: 'warden-modal', onclick: function (e) { e.stopPropagation(); } }, [el('div', { class: 'warden-modal-title' }, ['Warden Settings'])]);
    var rows = el('div', {});
    rows.appendChild(settingRow('Import / Export & Backup', function () { overlay.remove(); openImportExport(); }));
    rows.appendChild(settingRow('Change master password', function () { overlay.remove(); openChangePassword(); }));
    rows.appendChild(settingRow('Rotate recovery key', async function () {
      if (!(await confirmUI('Generate a NEW recovery key? Your old one stops working immediately.', { title: 'Rotate recovery key', okLabel: 'Generate new', danger: true }))) return;
      // Require identity before minting a new recovery key.
      if (!(await verifyIdentity('rotate your recovery key'))) return;
      session.rotateRecovery().then(function (r) { overlay.remove(); showRecovery(r.recoveryCode); }).catch(function (e) { toast('Failed: ' + e.message); });
    }));
    rows.appendChild(settingRow('Delete all Passwords', async function () {
      var items = store.byKind('login');
      if (!items.length) { toast('No passwords to delete'); return; }
      var n = items.length;
      var ok = await confirmUI('Permanently delete all ' + n + ' saved password' + (n === 1 ? '' : 's') + '? This cannot be undone.',
        { title: 'Delete all Passwords', okLabel: 'Delete all', danger: true });
      if (!ok) return;
      for (var i = 0; i < items.length; i++) await store.remove(items[i].id);
      overlay.remove(); toast('All passwords deleted'); refreshList('login');
    }));
    rows.appendChild(settingRow('Delete all Payment methods', async function () {
      var items = store.byKind('payment');
      if (!items.length) { toast('No payment methods to delete'); return; }
      var n = items.length;
      var ok = await confirmUI('Permanently delete all ' + n + ' saved payment method' + (n === 1 ? '' : 's') + '? This cannot be undone.',
        { title: 'Delete all Payment methods', okLabel: 'Delete all', danger: true });
      if (!ok) return;
      // Deleting cards is as sensitive as revealing them — prove it's you.
      if (!(await verifyIdentity('delete every saved payment method'))) return;
      for (var i = 0; i < items.length; i++) await store.remove(items[i].id);
      overlay.remove(); toast('All payment methods deleted'); refreshList('payment');
    }));
    rows.appendChild(settingRow('Delete all ID Documents', async function () {
      var items = store.byKind('iddoc');
      if (!items.length) { toast('No ID documents to delete'); return; }
      var n = items.length;
      var ok = await confirmUI('Permanently delete all ' + n + ' ID document' + (n === 1 ? '' : 's') + ' and every scan attached to them? This cannot be undone.',
        { title: 'Delete all ID Documents', okLabel: 'Delete all', danger: true });
      if (!ok) return;
      // Destroying identity documents is at least as sensitive as revealing a
      // card — prove it's you.
      if (!(await verifyIdentity('delete every ID document'))) return;
      // Collect the attachments BEFORE the items go, then purge the encrypted
      // blobs from the file host and the local cache.
      var atts = [];
      if (window.WardenId) items.forEach(function (it) { window.WardenId.allAttachments(it).forEach(function (e) { atts.push(e.att); }); });
      for (var i = 0; i < items.length; i++) await store.remove(items[i].id);
      if (window.WardenIdFiles) window.WardenIdFiles.removeMany(atts);
      overlay.remove(); toast('All ID documents deleted'); refreshList('iddoc');
    }));
    rows.appendChild(settingRow('Delete all Sensitive Info', async function () {
      var items = store.byKind('sensitive');
      if (!items.length) { toast('No sensitive info to delete'); return; }
      var n = items.length;
      var ok = await confirmUI('Permanently delete all ' + n + ' secure note' + (n === 1 ? '' : 's') + '? This cannot be undone.',
        { title: 'Delete all Sensitive Info', okLabel: 'Delete all', danger: true });
      if (!ok) return;
      for (var i = 0; i < items.length; i++) await store.remove(items[i].id);
      overlay.remove(); toast('All sensitive info deleted'); refreshList('sensitive');
    }));
    session.biometricEnabled().then(function (on) {
      rows.appendChild(settingRow(on ? 'Disable biometric unlock (this device)' : 'Enable biometric unlock (this device)', async function () {
        if (on) {
          // Verify identity (biometric scan or password) BEFORE disabling.
          if (!(await verifyIdentity('disable biometric unlock'))) return;
          session.disableBiometric().then(function () { toast('Biometrics disabled'); overlay.remove(); });
        } else {
          var bioLabel = window.Bio && window.Bio.label ? window.Bio.label() : 'biometrics';
          session.enableBiometric(bioLabel).then(function () { toast('Biometrics enabled'); overlay.remove(); }).catch(function (e) {
            if (e.message === 'cancelled') return;
            // This browser has no PRF, so the unlock key can't be bound to the
            // scan — it would have to sit in local storage with the prompt only
            // guarding the code path in front of it. Say so plainly and let the
            // user decide rather than enabling something weaker than it looks.
            if (e.message === 'bio-no-prf') {
              confirmUI(
                'This browser can\'t tie the unlock key to your ' + bioLabel + '. Warden would have to keep that key on this device, where anyone who can read the browser\'s storage could bypass the scan.\n\n' +
                'Your master password is unaffected either way. Enable it anyway?',
                { title: 'Weaker on this browser', okLabel: 'Enable anyway', cancelLabel: 'Skip' }
              ).then(function (yes) {
                if (!yes) return;
                session.enableBiometric(bioLabel, { allowStoredKey: true })
                  .then(function () { toast('Biometrics enabled (stored key)'); overlay.remove(); })
                  .catch(function (e2) { if (e2.message !== 'cancelled') toast('Failed: ' + e2.message); });
              });
              return;
            }
            toast('Failed: ' + e.message);
          });
        }
      }));
    });
    body.appendChild(rows);
    body.appendChild(el('div', { class: 'warden-modal-actions' }, [el('button', { class: 'warden-btn', onclick: function () { overlay.remove(); } }, ['Close'])]));
    overlay.appendChild(body); document.body.appendChild(overlay);
  }
  function settingRow(label, onClick) { return el('button', { class: 'warden-setting-row', onclick: onClick }, [label]); }

  // In-app password prompt → resolves to the typed value or null (cancel).
  // Resolved value of promptSecret when the user chose the biometric button and
  // the scan succeeded (a sentinel object, so it can never collide with a password).
  var BIO_OK = {};
  function promptSecret(title, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var overlay = el('div', { class: 'warden-overlay' });
      var input = el('input', { type: 'password', class: 'warden-input', placeholder: opts.placeholder || 'Master password', autocomplete: 'current-password' });
      var err = el('div', { class: 'warden-err' });
      function done(v) { overlay.remove(); resolve(v); }
      var ok = el('button', { class: 'warden-btn primary', onclick: function () { if (!input.value) { err.textContent = 'Required'; return; } done(input.value); } }, [opts.okLabel || 'Confirm']);
      var cancel = el('button', { class: 'warden-btn', onclick: function () { done(null); } }, ['Cancel']);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok.click(); });
      var boxKids = [el('div', { class: 'warden-modal-title' }, [title])];
      if (opts.sub) boxKids.push(el('p', { class: 'warden-sub', style: 'text-align:left;margin-bottom:12px' }, [opts.sub]));
      // Optional biometric route. It runs ONLY on click — never automatically —
      // so the password field below is always an equally valid way through.
      if (opts.bio) {
        var bioBtn = el('button', { class: 'warden-btn', style: 'width:100%;margin-bottom:10px', html: VI.unlock + '<span>Use ' + opts.bio.label + '</span>' });
        bioBtn.addEventListener('click', async function () {
          err.textContent = ''; bioBtn.disabled = true;
          var passed = false;
          try { passed = await opts.bio.run(); } catch (e) {}
          bioBtn.disabled = false;
          if (passed) done(BIO_OK);
          else err.textContent = opts.bio.label + ' check failed — use your password.';
        });
        boxKids.push(bioBtn);
      }
      boxKids.push(input, err, el('div', { class: 'warden-modal-actions' }, [ok, cancel]));
      var box = el('div', { class: 'warden-modal', onclick: function (e) { e.stopPropagation(); } }, boxKids);
      overlay.appendChild(box); document.body.appendChild(overlay);
      setTimeout(function () { input.focus(); }, 50);
    });
  }

  // Confirm the user's identity on an already-unlocked warden. Offers BOTH routes
  // side by side — a biometric button and the master-password field — and never
  // launches the OS prompt on its own. Returns true only on success.
  async function verifyIdentity(actionLabel) {
    var bioOn = false;
    try { bioOn = !!(window.Bio && (await session.biometricEnabled())); } catch (e) {}
    var label = (window.Bio && window.Bio.label) ? window.Bio.label() : 'biometrics';
    var pw = await promptSecret('Confirm it\'s you', {
      sub: (bioOn ? 'Use ' + label + ' or enter your master password to ' : 'Enter your master password to ') + actionLabel + '.',
      okLabel: 'Confirm',
      bio: bioOn ? { label: label, run: function () { return session.confirmBiometric(); } } : null
    });
    if (pw == null) return false;
    if (pw === BIO_OK) return true;
    if (await session.verifyPassword(pw)) return true;
    toast('Incorrect password'); return false;
  }

  // Wrap a password input with a show/hide eye toggle.
  function revealField(input) {
    var shown = false;
    var btn = el('button', { class: 'warden-icon', type: 'button', title: 'Show', html: eye() });
    btn.addEventListener('click', function () { shown = !shown; input.type = shown ? 'text' : 'password'; btn.innerHTML = shown ? eyeOff() : eye(); });
    return el('div', { class: 'warden-pw-input' }, [input, btn]);
  }
  // Change master password — real in-app form with verified current password.
  function openChangePassword() {
    var overlay = el('div', { class: 'warden-overlay' }); // no backdrop-close — avoids losing in-progress edits
    var cur = el('input', { type: 'password', class: 'warden-input', placeholder: 'Current master password', autocomplete: 'current-password' });
    var nw = el('input', { type: 'password', class: 'warden-input', placeholder: 'New master password', autocomplete: 'new-password' });
    var cf = el('input', { type: 'password', class: 'warden-input', placeholder: 'Confirm new password', autocomplete: 'new-password' });
    var hintIn = el('input', { type: 'text', class: 'warden-input', placeholder: 'Password hint (optional)', autocomplete: 'off', maxlength: '160', value: currentHint() });
    var meter = el('div', { class: 'warden-meter' }, [el('div', { class: 'warden-meter-fill' })]);
    nw.addEventListener('input', function () { var s = strength(nw.value); var f = meter.querySelector('.warden-meter-fill'); f.style.width = (s / 4 * 100) + '%'; f.style.background = ['#E74C3C', '#8D769A', '#e0b57c', '#5DAF6D', '#5DAF6D'][s]; });
    var err = el('div', { class: 'warden-err' });
    var save = el('button', { class: 'warden-btn primary' }, ['Change password']);
    save.addEventListener('click', async function () {
      err.textContent = '';
      if (nw.value.length < 12) { err.textContent = 'New password must be at least 12 characters.'; return; }
      if (nw.value !== cf.value) { err.textContent = 'New passwords do not match.'; return; }
      save.disabled = true; save.textContent = 'Verifying…';
      try {
        await session.changeMasterPassword(cur.value, nw.value, hintIn.value.trim()); // throws bad-password if current is wrong
        overlay.remove();
        // Re-lock this device too — you'll unlock again with the new password.
        session.lock(); renderLock(true);
        toast('Master password changed — please unlock with your new password');
      } catch (e) {
        err.textContent = e.message === 'bad-password' ? 'Current password is incorrect.' : ('Failed: ' + e.message);
        save.disabled = false; save.textContent = 'Change password';
      }
    });
    var forgot = el('button', { class: 'warden-link-btn', style: 'display:block;margin:2px 0 0;padding-left:0' },
      ['Forgot your current password? Use your recovery key →']);
    forgot.addEventListener('click', function () { overlay.remove(); openResetWithRecovery({}); });
    var box = el('div', { class: 'warden-modal', onclick: function (e) { e.stopPropagation(); } }, [
      el('div', { class: 'warden-modal-title' }, ['Change Master Password']),
      el('label', { class: 'warden-flabel' }, ['Current password']), revealField(cur), forgot,
      el('label', { class: 'warden-flabel', style: 'margin-top:12px' }, ['New password']), revealField(nw), meter,
      el('label', { class: 'warden-flabel' }, ['Confirm new password']), revealField(cf),
      el('label', { class: 'warden-flabel', style: 'margin-top:12px' }, ['Password hint (optional)']), hintIn,
      el('p', { class: 'warden-fine', style: 'text-align:left;margin:-4px 0 4px;letter-spacing:0;line-height:1.5' },
        ['Emailed to you from the lock screen’s “Forgot password?” — stored in plain text, so never put the password in it.']),
      err, el('div', { class: 'warden-modal-actions' }, [save, el('button', { class: 'warden-btn', onclick: function () { overlay.remove(); } }, ['Cancel'])]),
    ]);
    overlay.appendChild(box); document.body.appendChild(overlay);
    setTimeout(function () { cur.focus(); }, 50);
  }

  // ── password health dashboard ──────────────────────────────────────────────
  function openHealth() {
    var overlay = el('div', { class: 'warden-overlay' });
    var box = el('div', { class: 'warden-modal', onclick: function (e) { e.stopPropagation(); } });
    var h = analyzeHealth(store.byKind('login'));
    var color = h.score >= 80 ? '#5DAF6D' : h.score >= 50 ? '#e0b57c' : '#E74C3C';

    // score ring
    var circ = 2 * Math.PI * 34;
    var ring = '<svg width="92" height="92" viewBox="0 0 80 80" style="transform:rotate(-90deg)">' +
      '<circle cx="40" cy="40" r="34" stroke="var(--bd)" stroke-width="7" fill="none"/>' +
      '<circle cx="40" cy="40" r="34" stroke="' + color + '" stroke-width="7" fill="none" stroke-linecap="round" stroke-dasharray="' + circ + '" stroke-dashoffset="' + (circ * (1 - h.score / 100)) + '"/></svg>';
    var scoreEl = el('div', { class: 'warden-health-score' }, [
      el('div', { class: 'warden-health-ring', html: ring }),
      el('div', { class: 'warden-health-num', style: 'color:' + color }, [String(h.score)]),
    ]);
    box.appendChild(el('div', { class: 'warden-modal-title' }, ['Password Health']));
    box.appendChild(el('div', { class: 'warden-health-top' }, [
      scoreEl,
      el('div', {}, [
        el('div', { class: 'warden-health-label' }, [h.score >= 80 ? 'Looking good' : h.score >= 50 ? 'Room to improve' : 'Needs attention']),
        el('div', { class: 'warden-health-sub' }, [h.total + ' login' + (h.total === 1 ? '' : 's') + ' analyzed']),
      ]),
    ]));

    function section(title, items, tone, describe) {
      if (!items.length) return;
      var listWrap = el('div', { class: 'warden-health-items', style: 'display:none' });
      // items may be a flat list of logins OR groups (arrays)
      var flat = Array.isArray(items[0]) ? [].concat.apply([], items) : items;
      flat.forEach(function (it) {
        listWrap.appendChild(el('div', { class: 'warden-health-item', onclick: function () { overlay.remove(); openEditor('login', it); } }, [
          favicon(it.url),
          el('div', { class: 'warden-row-main' }, [
            el('div', { class: 'warden-row-title' }, [it.title || it.url || '(untitled)']),
            el('div', { class: 'warden-row-sub' }, [it.username || it.email || '']),
          ]),
          el('span', { class: 'warden-mini-edit', html: editIcon() }),
        ]));
      });
      var count = Array.isArray(items[0]) ? flat.length : items.length;
      var head = el('div', { class: 'warden-health-cat warden-health-' + tone }, [
        el('span', { class: 'warden-health-dot' }),
        el('div', { style: 'flex:1' }, [el('div', { class: 'warden-health-cat-title' }, [title + ' · ' + count]), el('div', { class: 'warden-health-cat-desc' }, [describe])]),
        el('span', { class: 'warden-health-chev', html: VI.chevron }),
      ]);
      head.addEventListener('click', function () { listWrap.style.display = listWrap.style.display === 'none' ? '' : 'none'; });
      box.appendChild(head); box.appendChild(listWrap);
    }

    var anyIssue = h.weak.length || h.reusedCount || h.old.length || h.missing.length || h.duplicates.length;
    if (!anyIssue) box.appendChild(el('div', { class: 'warden-empty', style: 'margin-top:8px' }, ['No issues found. Every login has a strong, unique, recent password.']));
    section('Weak', h.weak, 'bad', 'Short or low-complexity — easy to crack. Generate a stronger one.');
    section('Reused', h.reusedGroups, 'bad', 'The same password on multiple sites — one breach exposes them all.');
    section('Old', h.old, 'warn', 'Not changed in over a year — consider rotating.');
    section('Missing password', h.missing, 'warn', 'No password saved on this entry.');
    section('Duplicate accounts', h.duplicates, 'warn', 'Same site and username saved more than once.');

    box.appendChild(el('div', { class: 'warden-modal-actions' }, [el('button', { class: 'warden-btn', onclick: function () { overlay.remove(); } }, ['Close'])]));
    overlay.appendChild(box); document.body.appendChild(overlay);
  }

  // ── import / export / backup ───────────────────────────────────────────────
  function dateStamp() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }
  // RFC-4180-ish CSV parser (handles quotes, escaped quotes, CRLF).
  function parseCSV(text) {
    var rows = [], row = [], cur = '', inQ = false;
    text = String(text).replace(/^﻿/, ''); // strip BOM
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return !(r.length === 1 && r[0].trim() === ''); });
  }
  function csvCell(v) { v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function toCSV(rows) { return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n'); }

  // Import logins from a Chrome/Edge/Firefox or Bitwarden CSV. Returns count.
  async function importFromCSV(text) {
    var rows = parseCSV(text);
    if (rows.length < 2) throw new Error('No rows found');
    var header = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    function col() { for (var i = 0; i < arguments.length; i++) { var j = header.indexOf(arguments[i]); if (j >= 0) return j; } return -1; }
    var ci = {
      title: col('name', 'title'), url: col('url', 'login_uri', 'website', 'uri', 'hostname'),
      username: col('username', 'login_username'), password: col('password', 'login_password'),
      email: col('email'), notes: col('notes', 'note'), totp: col('login_totp', 'totp', 'otpauth'),
    };
    if (ci.password < 0 && ci.username < 0) throw new Error('Unrecognised CSV — no username/password columns');
    var count = 0;
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      var g = function (i) { return i >= 0 && i < row.length ? row[i] : ''; };
      var title = g(ci.title), url = g(ci.url), user = g(ci.username), pass = g(ci.password);
      if (!title && !url && !user && !pass) continue;
      await store.save({ kind: 'login', title: title || url || user || 'Imported', url: url, username: user, email: g(ci.email), password: pass, notes: g(ci.notes), totp: g(ci.totp), category: 'Other' });
      count++;
    }
    return count;
  }

  function openImportExport() {
    var overlay = el('div', { class: 'warden-overlay' });
    var status = el('div', { class: 'warden-err', style: 'color:var(--txd)' });

    // hidden file inputs
    var csvInput = el('input', { type: 'file', accept: '.csv,text/csv', style: 'display:none' });
    csvInput.addEventListener('change', async function () {
      var f = csvInput.files[0]; csvInput.value = ''; if (!f) return;
      status.textContent = 'Importing…';
      try { var n = await importFromCSV(await f.text()); status.style.color = 'var(--txd)'; status.textContent = 'Imported ' + n + ' login' + (n === 1 ? '' : 's') + '.'; toast('Imported ' + n); renderPasswords(); }
      catch (e) { status.style.color = '#E74C3C'; status.textContent = 'Import failed: ' + e.message; }
    });
    // Payment methods — routed through WardenPay's importer REGISTRY, so adding
    // support for another exporter is one entry in warden-pay.js, not new UI.
    var payInput = el('input', { type: 'file', accept: '.csv,.json,text/csv,application/json', style: 'display:none' });
    payInput.addEventListener('change', async function () {
      var f = payInput.files[0]; payInput.value = ''; if (!f) return;
      if (!window.WardenPay) { status.style.color = '#E74C3C'; status.textContent = 'Payments module not loaded.'; return; }
      status.style.color = 'var(--txd)'; status.textContent = 'Importing…';
      try {
        var text = await f.text(), parsed, format;
        if (/\.json$/i.test(f.name) || /^\s*[[{]/.test(text)) { parsed = JSON.parse(text); format = 'json'; }
        else { parsed = parseCSV(text); format = 'csv'; }
        var r = window.WardenPay.importPayments(parsed, format);
        for (var i = 0; i < r.items.length; i++) await store.save(r.items[i]);
        status.textContent = 'Imported ' + r.items.length + ' payment method' + (r.items.length === 1 ? '' : 's') + ' from ' + r.importer.label + '.';
        toast('Imported ' + r.items.length);
        renderPayments();
      } catch (e) { status.style.color = '#E74C3C'; status.textContent = 'Import failed: ' + e.message; }
    });

    var backupInput = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
    backupInput.addEventListener('change', async function () {
      var f = backupInput.files[0]; backupInput.value = ''; if (!f) return;
      try {
        var data = JSON.parse(await f.text());
        if (data.format !== 'warden-encrypted-backup' || !data.config) throw new Error('Not a Warden backup file');
        if (!(await confirmUI('Restore this backup? It MERGES the backup\'s ' + ((data.items || []).length) + ' item(s) into this warden, and replaces your master password/keys with the backup\'s. You will unlock with the backup\'s master password.', { title: 'Restore backup', okLabel: 'Restore', danger: true }))) return;
        await backend.saveConfig(data.config);
        for (var i = 0; i < (data.items || []).length; i++) await backend.putItem(data.items[i]);
        overlay.remove(); session.lock(); toast('Backup restored — unlock with its master password'); renderLock(true);
      } catch (e) { status.style.color = '#E74C3C'; status.textContent = 'Restore failed: ' + e.message; }
    });

    function row(title, desc, btnLabel, danger, onClick) {
      var btn = el('button', { class: 'warden-btn' + (danger ? ' danger' : ''), style: 'width:auto;margin:0;flex-shrink:0', onclick: onClick }, [btnLabel]);
      return el('div', { class: 'warden-ie-row' }, [
        el('div', { style: 'flex:1;min-width:0' }, [el('div', { class: 'warden-ie-title' }, [title]), el('div', { class: 'warden-ie-desc' }, [desc])]),
        btn,
      ]);
    }

    var box = el('div', { class: 'warden-modal', onclick: function (e) { e.stopPropagation(); } }, [
      el('div', { class: 'warden-modal-title' }, ['Import / Export & Backup']),
      row('Import passwords from CSV', 'Chrome, Edge, Firefox, or Bitwarden password export.', 'Import CSV', false, function () { csvInput.click(); }),
      row('Import payment methods', 'Chromium payment export, 1Password card CSV, Bitwarden .json, or any CSV with a card-number column. (Google Wallet cannot export card numbers — no service can read them back out.)', 'Import cards', false, function () { payInput.click(); }),
      row('Encrypted backup', 'Download an encrypted, zero-knowledge backup file — passwords, payments and notes together. Safe to store anywhere; needs your master password to open.', 'Export backup', false, exportBackup),
      row('Restore backup', 'Load a previously exported encrypted backup file.', 'Restore', false, function () { backupInput.click(); }),
      row('Plain CSV export', 'UNENCRYPTED — anyone who opens the file can read every password. Use only for migrating, then delete it.', 'Export CSV', true, exportCSVUnencrypted),
      row('Plain payments export', 'UNENCRYPTED — full card numbers and security codes in a readable file. Use only to migrate, then delete it.', 'Export cards', true, exportPaymentsUnencrypted),
      status,
      el('div', { class: 'warden-modal-actions' }, [el('button', { class: 'warden-btn', onclick: function () { overlay.remove(); } }, ['Close'])]),
    ]);
    box.appendChild(csvInput); box.appendChild(payInput); box.appendChild(backupInput);
    overlay.appendChild(box); document.body.appendChild(overlay);

    async function exportBackup() {
      try {
        var data = { format: 'warden-encrypted-backup', version: 1, exportedAt: Date.now(), config: session.getConfig(), items: await backend.listItems() };
        download('warden-backup-' + dateStamp() + '.json', JSON.stringify(data), 'application/json');
        status.style.color = 'var(--txd)'; status.textContent = 'Encrypted backup downloaded.';
      } catch (e) { status.style.color = '#E74C3C'; status.textContent = 'Export failed: ' + e.message; }
    }
    async function exportCSVUnencrypted() {
      if (!(await confirmUI('This exports every login as PLAIN TEXT — passwords readable by anyone with the file. Continue?', { title: 'Unencrypted export', okLabel: 'Export anyway', danger: true }))) return;
      var logins = store.byKind('login');
      var rows = [['name', 'url', 'username', 'email', 'password', 'notes']];
      logins.forEach(function (it) { rows.push([it.title || '', it.url || '', it.username || '', it.email || '', it.password || '', it.notes || '']); });
      download('warden-passwords-UNENCRYPTED-' + dateStamp() + '.csv', toCSV(rows), 'text/csv');
      status.style.color = '#8D769A'; status.textContent = 'Exported ' + logins.length + ' logins as PLAIN TEXT — delete the file when done.';
    }
    async function exportPaymentsUnencrypted() {
      var cards = store.byKind('payment');
      if (!cards.length) { toast('No payment methods to export'); return; }
      if (!(await confirmUI('This writes every card number AND security code to a plain file that anyone can read. Continue?', { title: 'Unencrypted card export', okLabel: 'Export anyway', danger: true }))) return;
      // Same identity check as revealing a card — an export reveals them all.
      if (!(await verifyIdentity('export your cards unencrypted'))) return;
      var VPay = window.WardenPay;
      var rows = [['nickname', 'type', 'network', 'cardholder', 'card number', 'exp month', 'exp year', 'cvv', 'address1', 'address2', 'city', 'state', 'zip', 'country', 'notes']];
      cards.forEach(function (c) {
        var b = VPay ? VPay.normalizeAddress(c.billing) : (c.billing || {});
        rows.push([c.nickname || '', c.type || '', c.network || '', c.cardholder || '', c.number || '',
          c.expMonth || '', c.expYear || '', c.cvv || '', b.line1 || '', b.line2 || '', b.city || '', b.region || '', b.postal || '', b.country || '', c.notes || '']);
      });
      download('warden-payments-UNENCRYPTED-' + dateStamp() + '.csv', toCSV(rows), 'text/csv');
      status.style.color = '#8D769A'; status.textContent = 'Exported ' + cards.length + ' card(s) as PLAIN TEXT — delete the file when done.';
    }
  }

  // ── host contract for section modules (warden-pay-ui.js, warden-id-ui.js) ───
  // Everything a tab module needs to look and behave like a native part of
  // Warden, WITHOUT reaching into this file's internals or opening a second path
  // to the warden. Note what is deliberately absent: no DEK, no config, no
  // backend — a module can only read/write through the same unlocked `store`,
  // and can only gate an action through the same `verifyIdentity`.
  //
  // ID Docs needs to encrypt raw BYTES (scans), which JSON items can't carry.
  // It still never sees the key: it hands the bytes to session().encryptBytes,
  // which does the work inside the session. Same DEK, same algorithm, same lock.
  function hostCtx() {
    return {
      el: el, esc: esc, toast: toast, copyText: copyText, confirmUI: confirmUI,
      iconBtn: iconBtn, emptyState: emptyState,
      // The one drag-to-reorder engine, shared so Payments and Sensitive Info
      // can never drift apart. See makeReorderable() for the DOM contract.
      makeReorderable: makeReorderable, dragHandle: dragHandle,
      // Rendered SVG STRINGS, not the builder functions — iconBtn() and
      // innerHTML both want markup, and handing over the function instead
      // stringifies its source into the button.
      icons: { eye: eye(), eyeOff: eyeOff(), copy: copyIcon(), edit: editIcon(), lock: lockIcon(), user: userIcon(), ext: extIcon() },
      store: function () { return store; },
      session: function () { return session; },
      verifyIdentity: verifyIdentity,
      query: function () { return currentQuery; },
      refreshList: refreshList,
      categories: CATEGORIES,
    };
  }

  // ── small SVG/icon helpers ─────────────────────────────────────────────────
  function favicon(url) { var i = el('img', { class: 'warden-favicon', src: faviconUrl(url), loading: 'lazy', alt: '' }); i.addEventListener('error', function () { i.style.visibility = 'hidden'; }); return i; }
  function iconBtn(title, svg, fn) { return el('button', { class: 'warden-icon', title: title, html: svg, onclick: fn }); }
  function eye() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'; }
  function eyeOff() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10 10 0 0 1 12 20c-7 0-11-8-11-8a18 18 0 0 1 5.06-5.94M9.9 4.24A9 9 0 0 1 12 4c7 0 11 8 11 8a18 18 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'; }
  function copyIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'; }
  function userIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'; }
  function mailIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 6L2 7"/></svg>'; }
  function cabinetIcon() { return '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="3" width="16" height="18" rx="2"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="10" y1="7.5" x2="14" y2="7.5"/><line x1="10" y1="16.5" x2="14" y2="16.5"/></svg>'; }
  function gearIcon() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'; }
  function lockIcon() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'; }
  function shieldIcon() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>'; }
  function keyIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.778-7.778zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>'; }
  function extIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>'; }
  function editIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'; }
  // Kept local rather than added to warden-icons.js: that file is also loaded by
  // the browser extension, and ID Docs is a PWA-only section.
  function cloudIcon() { return '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.3 9.4 4.2 4.2 0 0 0 7 19z"/><path d="M12 12v6"/><path d="m9.5 14.5 2.5-2.5 2.5 2.5"/></svg>'; }
  function idCardIcon() { return '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M5 16c.6-1.3 1.8-2 3-2s2.4.7 3 2"/><path d="M14 10h5"/><path d="M14 13.5h5"/></svg>'; }

  // ── styles ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    if ($('warden-ui-styles')) return;
    var css = [
      // #kc-root is the warden view's scroll container (a viewport-tall box). The
      // tabs + toolbar are position:sticky INSIDE it, so they pin while the list
      // scrolls beneath — and it carries a wide, grabbable scrollbar. (Also set
      // inline in activate() so nothing can override it.)
      'body.warden-active{overflow:hidden}', // only #kc-root scrolls (no competing body scroll)
      // ── pull to refresh ──
      // Fixed, not absolute: #kc-root is the scroll container, so an absolutely
      // positioned child would scroll away with the content instead of hanging
      // under the header.
      '.warden-ptr{position:fixed;top:calc(env(safe-area-inset-top,0px) + 6px);left:50%;transform:translateX(-50%);',
      '  width:34px;height:34px;border-radius:50%;background:var(--s2);border:1px solid var(--bd);',
      '  display:flex;align-items:center;justify-content:center;color:var(--txd);',
      '  opacity:0;pointer-events:none;z-index:8;box-shadow:0 6px 18px rgba(0,0,0,.45)}',
      '.warden-ptr.armed{color:var(--acs,#8D769A);border-color:var(--ac)}',
      '.warden-ptr svg{display:block}',
      '@keyframes warden-ptr-spin{to{transform:rotate(360deg)}}',
      '.warden-ptr.spinning .warden-ptr-spinner{animation:warden-ptr-spin .7s linear infinite}',
      '.warden-ptr-spinner{line-height:0;display:flex}',
      // Pointer-fine devices never see it; this is a touch gesture only.
      '@media (pointer:fine){.warden-ptr{display:none}}',
      '@media (prefers-reduced-motion:reduce){.warden-ptr.spinning .warden-ptr-spinner{animation:none}}',
      '#kc-root{height:100dvh;overflow-y:auto;overflow-x:clip;scrollbar-width:auto;scrollbar-color:#4A4B52 var(--s1)}',
      '#kc-root::-webkit-scrollbar{width:15px}',
      '#kc-root::-webkit-scrollbar-track{background:var(--s1)}',
      '#kc-root::-webkit-scrollbar-thumb{background:#4A4B52;border-radius:var(--radius-sm);border:3px solid var(--bg);min-height:50px}',
      '#kc-root::-webkit-scrollbar-thumb:hover,#kc-root::-webkit-scrollbar-thumb:active{background:var(--ac)}',
      // The app-hbar (branding) is already sticky top:0; the tabs stick BELOW it,
      // and the toolbar below the tabs — offsets measured live in updateStickyOffset.
      '#kc-root .app-hbar{position:sticky;top:0;z-index:7}',
      // --vpad is the one horizontal gutter every full-width strip (tabs,
      // panels, toolbars) shares, so they stay optically aligned at every width
      // — and it never dips under the notch/rounded corner in landscape.
      '#kc-root{--vpad:clamp(10px,3vw,24px)}',
      '#kc-root{--vpadl:max(var(--vpad),env(safe-area-inset-left,0px));--vpadr:max(var(--vpad),env(safe-area-inset-right,0px))}',
      '.warden-tabs{display:flex;gap:8px;padding:12px var(--vpadr) 10px var(--vpadl);max-width:1100px;margin:0 auto;width:100%;position:sticky;top:var(--vhbar-h,60px);z-index:6;background:var(--bg)}',
      // Bleed guard: extends the bar's own background 4px upward so no seam
      // can open between it and the sticky header above.
      '.warden-tabs::before{content:"";position:absolute;left:0;right:0;bottom:100%;height:5px;background:var(--bg);pointer-events:none}',
      '.warden-tab{flex:0 0 auto;background:transparent;border:1px solid var(--bd);color:var(--txd);font-size:11px;font-weight:500;letter-spacing:1.2px;text-transform:uppercase;padding:0 14px;height:34px;border-radius:var(--radius-sm);cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:border-color .18s,color .18s}',
      '.warden-tab:hover{color:var(--tx);border-color:var(--txd)}.warden-tab.active{background:transparent;color:var(--acs,#8D769A);border-color:var(--ac)}',
      /* Tabs are draggable to reorder. `manipulation` keeps the browser's own
         horizontal panning (so the strip still scrolls on touch) while dropping
         the 300ms double-tap delay; a reorder drag arms from a long press and
         suppresses that scrolling only once armed. */
      '.warden-tab{touch-action:manipulation;-webkit-user-select:none;user-select:none}',
      '.warden-tab.vdrag{z-index:5;cursor:grabbing;opacity:.97;border-color:var(--ac);color:var(--acs,#8D769A);background:transparent;box-shadow:0 10px 26px var(--shadow)}',
      '.warden-tab svg{display:block;width:15px;height:15px;flex-shrink:0}',
      '.warden-panel{max-width:1100px;margin:0 auto;width:100%;padding:0 var(--vpadr) calc(28px + env(safe-area-inset-bottom,0px)) var(--vpadl)}',
      // Search + Add + Settings + Lock stay pinned just below the tabs.
      '.warden-toolbar{display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap;position:sticky;top:calc(var(--vhbar-h,60px) + var(--vtabs-h,54px));z-index:5;background:var(--bg);padding:8px 0 10px}',
      '.warden-toolbar .warden-icon{width:38px;height:38px}',
      '.warden-search-wrap{position:relative;flex:1;display:flex}',
      '.warden-search{flex:1;background:var(--s1);border:1px solid var(--bd);color:var(--tx);border-radius:var(--radius);padding:10px 38px 10px 14px;font-size:14px;outline:none;width:100%}',
      '.warden-search:focus{border-color:var(--ac)}',
      '.warden-search-clear{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:26px;height:26px;border:none;background:var(--s3);color:var(--txd);border-radius:50%;font-size:17px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}.warden-search-clear:hover{color:var(--tx);background:var(--bdl)}',
      '.warden-list{display:flex;flex-direction:column;gap:8px}',
      '.warden-site{background:var(--s1);border:1px solid var(--bd);border-radius:var(--radius);overflow:hidden}',
      '.warden-row{display:flex;align-items:center;gap:12px;padding:12px 14px}',
      '.warden-favicon{width:26px;height:26px;border-radius:6px;object-fit:contain;background:var(--s3);flex-shrink:0}',
      '.warden-lock-icon{font-size:22px}',
      '.warden-note-icon{width:26px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--ac)}.warden-note-icon svg{width:16px;height:16px;display:block}',
      '.warden-row-main{flex:1;min-width:0}.warden-row-title{font-size:14px;font-weight:500;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.warden-row-sub{font-size:12px;color:var(--txd);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}',
      '.warden-tag{background:transparent;border:1px solid var(--bd);color:var(--txd);font-size:10.5px;font-weight:500;letter-spacing:.2px;padding:3px 9px;border-radius:5px;flex-shrink:0}',
      '.warden-accounts{border-top:1px solid var(--bd)}',
      '.warden-account{display:flex;align-items:center;gap:12px;padding:11px 14px;border-top:1px solid var(--bd)}.warden-account:first-child{border-top:none}',
      '.warden-account.indented{padding-left:22px;background:var(--bg)}',
      '.warden-acc-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:7px}',
      '.warden-acc-line{display:flex;align-items:center;gap:8px}',
      '.warden-acc-field{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}',
      '.warden-acc-flabel{font-size:9.5px;font-weight:500;color:var(--txm);text-transform:uppercase;letter-spacing:1.4px}',
      '.warden-acc-val{font-size:13px;color:var(--tx);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.warden-acc-val.muted{color:var(--txm);font-weight:400}',
      '.warden-acc-pw{font-size:13px;color:var(--txd);font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.warden-pw-dots{letter-spacing:2px}',
      // Capped so a long action row can never squeeze the values it belongs to
      // down to an ellipsis; below 720px it drops to its own full-width row.
      '.warden-acc-actions{display:flex;flex-direction:row;flex-wrap:wrap;gap:4px;flex-shrink:0;justify-content:flex-end;max-width:min(50%,320px)}',
      '.warden-note-body{padding:0 14px 14px}',
      '.warden-note-text{color:var(--tx);font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;background:var(--s2);border:1px solid var(--bd);border-radius:var(--radius-sm);padding:12px}',
      '.warden-note-actions{display:flex;justify-content:flex-end;margin-top:8px}',
      '.warden-icon{background:transparent;border:1px solid var(--bd);color:var(--txd);width:30px;height:30px;border-radius:var(--radius-sm);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:border-color .18s,color .18s;padding:0}',
      '.warden-icon svg{display:block;width:15px;height:15px}',
      '.warden-icon:hover{color:var(--acs,#8D769A);border-color:var(--ac)}',
      '.warden-icon.vpay-on,.warden-icon.warden-on{color:var(--acs,#8D769A);border-color:var(--acl,rgba(141,118,154,.36))}',
      // ── drag to reorder (Payments + Sensitive Info share this) ──
      // touch-action:none is what stops the browser from treating a drag on the
      // handle as a scroll gesture; without it, mobile reordering is impossible.
      '.warden-drag{cursor:grab;touch-action:none;flex-shrink:0;background:transparent;border-color:transparent;color:var(--txm)}',
      '.warden-drag:hover{color:var(--tx);background:var(--s3);border-color:var(--bd)}',
      '.warden-drag:focus-visible{outline:2px solid var(--ac);outline-offset:1px;color:var(--tx)}',
      '.warden-drag.disabled{opacity:.3;cursor:not-allowed}',
      '.warden-drag.disabled:hover{color:var(--txm);background:transparent;border-color:transparent}',
      // Non-dragged rows glide to their new slot; the dragged row tracks the
      // finger with no transition so it never lags behind the pointer.
      '.warden-reordering .warden-site{transition:transform .16s cubic-bezier(.2,.7,.3,1)}',
      '.warden-reordering .warden-rowbody{display:none!important}',  // uniform row heights → exact index maths
      '.warden-reordering{cursor:grabbing}',
      '.warden-reordering .warden-site.warden-drag-active{transition:none;z-index:3;position:relative;cursor:grabbing;',
      '  border-color:var(--ac);box-shadow:0 12px 28px rgba(0,0,0,.5);transform-origin:center}',
      '.warden-reordering .warden-site.warden-drag-active .warden-drag{cursor:grabbing;color:var(--ac)}',
      '@media (prefers-reduced-motion:reduce){.warden-reordering .warden-site{transition:none}}',
      '.warden-empty{border:1px dashed var(--bd);border-radius:var(--radius);padding:34px 20px;text-align:center;color:var(--txd);font-size:13px;line-height:1.7}',
      '.warden-footer{display:flex;justify-content:space-between;margin-top:18px;padding-top:12px;border-top:1px solid var(--bd)}',
      '.warden-link-btn{background:none;border:none;color:var(--txd);font-size:12px;font-weight:500;cursor:pointer;padding:4px 8px;display:inline-flex;align-items:center;gap:7px;transition:color .15s}.warden-link-btn:hover{color:var(--acs,#8D769A)}',
      '.warden-link-btn svg{display:block;width:14px;height:14px}',
      // lock/setup
      '.warden-lock{display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;min-height:300px}',
      '.warden-card{background:var(--s1);border:1px solid var(--bd);border-radius:var(--radius);padding:30px 26px;max-width:400px;width:100%;text-align:center}',
      '.warden-lock-icon{line-height:0;margin-bottom:10px;color:var(--ac)}.warden-lock-icon svg{width:32px;height:32px;display:inline-block}',
      '.warden-h2{font-family:var(--display,inherit);font-size:22px;font-weight:600;letter-spacing:-.2px;color:var(--tx);margin:6px 0}',
      '.warden-sub{font-size:12.5px;color:var(--txd);line-height:1.6;margin-bottom:18px}',
      '.warden-input{width:100%;background:var(--s2);border:1px solid var(--bd);color:var(--tx);border-radius:var(--radius);padding:11px 13px;font-size:14px;outline:none;margin-bottom:10px;font-family:inherit}',
      '.warden-input:focus{border-color:var(--ac)}textarea.warden-input{resize:vertical;min-height:52px}',
      '.warden-btn{width:100%;background:transparent;border:1px solid var(--bd);color:var(--tx);border-radius:var(--radius-sm);padding:12px;font-size:13.5px;font-weight:500;letter-spacing:.2px;cursor:pointer;margin-bottom:8px;display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:border-color .18s,color .18s}',
      '.warden-btn svg{display:block;width:15px;height:15px;flex-shrink:0}',
      '.warden-btn:hover{border-color:var(--txd)}.warden-btn.primary{background:transparent;color:var(--acs,#8D769A);border-color:var(--acl,rgba(141,118,154,.36))}.warden-btn.primary:hover{border-color:var(--ac)}',
      '.warden-btn.primary:disabled{opacity:.5;cursor:not-allowed}.warden-btn.sm{width:auto;padding:10px 16px;margin:0}.warden-btn.danger{background:transparent;color:#E74C3C;border-color:#E74C3C44}',
      '.warden-err{color:#E74C3C;font-size:12px;min-height:16px;margin-bottom:6px;text-align:left}',
      '.warden-fine{font-size:10px;color:var(--txm);margin-top:8px;letter-spacing:.3px}',
      '.warden-meter{height:5px;background:var(--s3);border-radius:3px;overflow:hidden;margin-bottom:10px}.warden-meter-fill{height:100%;width:0;background:#E74C3C;transition:width .2s,background .2s}',
      '.warden-recovery-code{font-family:ui-monospace,monospace;font-size:16px;font-weight:500;color:var(--ac);background:var(--s2);border:1px dashed var(--bdl);border-radius:var(--radius);padding:16px;letter-spacing:1px;word-break:break-all;margin-bottom:12px;line-height:1.7}',
      '.warden-ack{display:flex;align-items:center;gap:9px;font-size:12px;color:var(--txd);margin:12px 0;text-align:left;cursor:pointer}',
      // modal
      // 100dvh (not vh) so a phone's collapsing URL bar can't push the modal's
      // action buttons off-screen; the insets keep it clear of notch + home bar.
      '.warden-overlay{position:fixed;inset:0;background:rgba(14,14,16,.66);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;z-index:99998;overflow-y:auto;',
      '  padding:max(16px,env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) max(16px,env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px))}',
      '.warden-modal{background:var(--s2);border:1px solid #5b5b64;border-radius:var(--radius);padding:22px;width:440px;max-width:100%;max-height:calc(100dvh - 32px);overflow-y:auto;overscroll-behavior:contain;box-shadow:0 0 0 1px rgba(141,118,154,.10),0 24px 70px rgba(0,0,0,.6)}',
      '.warden-modal-title{font-family:var(--display,inherit);font-size:20px;font-weight:600;letter-spacing:-.2px;color:var(--tx);margin-bottom:18px}',
      '.warden-field{margin-bottom:12px}.warden-flabel{display:block;font-size:10px;font-weight:500;color:var(--txm);text-transform:uppercase;letter-spacing:1.4px;margin-bottom:7px}',
      '.warden-field .warden-input{margin-bottom:0}select.warden-input{cursor:pointer}',
      '.warden-pw-input{display:flex;gap:6px}.warden-pw-input .warden-input{flex:1}',
      // flex-basis 120px: a 4-button row (the generator) wraps to 2x2 rather
      // than shrinking every label into an ellipsis on a phone.
      '.warden-modal-actions{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}.warden-modal-actions .warden-btn{width:auto;flex:1 1 120px;margin:0;white-space:nowrap}',
      '.warden-setting-row{display:block;width:100%;text-align:left;background:var(--s2);border:1px solid var(--bd);color:var(--tx);border-radius:var(--radius);padding:13px 15px;font-size:13.5px;font-weight:600;cursor:pointer;margin-bottom:8px}.warden-setting-row:hover{border-color:var(--ac)}',
      '.warden-ie-row{display:flex;align-items:center;gap:12px;background:var(--s2);border:1px solid var(--bd);border-radius:var(--radius);padding:12px 14px;margin-bottom:8px}',
      '.warden-ie-title{font-size:13px;font-weight:500;color:var(--tx)}.warden-ie-desc{font-size:11px;color:var(--txd);line-height:1.5;margin-top:2px}',
      // health dashboard
      '.warden-health-top{display:flex;align-items:center;gap:16px;margin-bottom:18px}',
      '.warden-health-score{position:relative;width:92px;height:92px;flex-shrink:0}',
      '.warden-health-num{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:600}',
      '.warden-health-label{font-size:16px;font-weight:600;color:var(--tx)}.warden-health-sub{font-size:12px;color:var(--txd);margin-top:2px}',
      '.warden-health-cat{display:flex;align-items:center;gap:10px;background:var(--s2);border:1px solid var(--bd);border-radius:var(--radius);padding:11px 13px;margin-bottom:6px;cursor:pointer}',
      '.warden-health-cat:hover{border-color:var(--bdl)}',
      '.warden-health-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}',
      '.warden-health-bad .warden-health-dot{background:#E74C3C}.warden-health-warn .warden-health-dot{background:#8D769A}',
      '.warden-health-cat-title{font-size:13px;font-weight:500;color:var(--tx)}.warden-health-cat-desc{font-size:11px;color:var(--txd);margin-top:2px;line-height:1.5}',
      '.warden-health-chev{color:var(--txd);line-height:0;transition:transform .18s}.warden-health-chev svg{width:15px;height:15px;display:block}',
      '.warden-health-items{margin:0 0 8px}',
      '.warden-health-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:var(--radius-sm);cursor:pointer}.warden-health-item:hover{background:var(--s2)}',
      '.warden-mini-edit{color:var(--txd);display:flex}',
      // totp / custom fields / history
      '.warden-totp-main{display:flex;align-items:center;gap:8px}',
      '.warden-totp-code{font-family:ui-monospace,monospace;font-size:15px;font-weight:500;letter-spacing:1px;color:var(--ac)}',
      '.warden-totp-bar{width:34px;height:4px;background:var(--s3);border-radius:2px;overflow:hidden;flex-shrink:0}.warden-totp-bar>div{height:100%;width:100%;background:var(--ac);transition:width 1s linear}',
      '.warden-cf-row{display:flex;gap:6px;margin-bottom:6px}.warden-cf-row .warden-input{flex:1;min-width:0}',
      '.warden-hist-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--bd)}',
      '.warden-hist-pw{flex:1;font-family:ui-monospace,monospace;font-size:12px;color:var(--txd);word-break:break-all}',
      '.warden-hist-date{font-size:10px;color:var(--txm);flex-shrink:0}',
      '.warden-note-cf{margin-top:10px;display:flex;flex-direction:column;gap:6px}',
      '.warden-note-cf .warden-acc-flabel{color:var(--txm)}',
      // generator
      '.warden-gen-out{font-family:ui-monospace,monospace;font-size:16px;color:var(--ac);background:var(--s2);border:1px solid var(--bd);border-radius:var(--radius);padding:16px;word-break:break-all;text-align:center;margin-bottom:14px;min-height:24px}',
      '.warden-gen-tabs,.warden-gen-len{display:flex;gap:8px;margin-bottom:12px}.warden-gen-len{align-items:center;justify-content:space-between;font-size:12px;color:var(--txd)}',
      '.warden-gen-tab{flex:1;background:var(--s2);border:1px solid var(--bd);color:var(--txd);border-radius:var(--radius-sm);padding:8px;font-size:12px;font-weight:500;cursor:pointer}.warden-gen-tab.active{background:transparent;color:var(--acs,#8D769A);border-color:var(--ac)}',
      '.warden-gen-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.warden-gen-opt{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--txd);cursor:pointer}',
      '.warden-range{width:100%;accent-color:var(--ac)}.warden-gen-len .warden-range{flex:1;margin-left:12px}',
      '.warden-toast.show{opacity:1!important}',
      // ── responsive ────────────────────────────────────────────────────────
      // Four steps, each one a real device class rather than an arbitrary width:
      //   ≤1024  tablets & foldables opened — roomy, but no hover to lean on
      //   ≤720   the action row stops competing with the values beside it
      //   ≤640   phones — one column, 16px inputs, thumb-sized controls
      //   ≤380   small/folded phones — the last of the horizontal padding goes
      // Touch ergonomics are keyed off pointer:coarse (a touch laptop needs the
      // big targets too), never off width.
      '@media (max-width:1024px){',
      '  .warden-toolbar{padding:8px 0}',
      '  .warden-health-top{gap:12px}',
      '}',
      // The stacked value lines and the action row stop fighting for the same
      // row: actions move under the fields and get the full width to sit in.
      '@media (max-width:720px){',
      '  .warden-account{flex-wrap:wrap;align-items:flex-start;gap:8px}',
      '  .warden-acc-actions{max-width:none;width:100%;justify-content:flex-end}',
      '}',
      '@media (max-width:640px){',
      // Tabs scroll horizontally instead of wrapping into a second sticky row
      // that would eat a third of a phone screen.
      '  .warden-tabs{padding-top:10px;padding-bottom:8px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}',
      '  .warden-tabs::-webkit-scrollbar{display:none}',
      '  .warden-tab{font-size:11px;padding:0 12px;height:36px;letter-spacing:.9px;white-space:nowrap}',
      // Search takes a row of its own; Add sits left, the icon cluster right.
      '  .warden-toolbar{gap:8px;margin-bottom:10px}',
      '  .warden-search-wrap{flex:1 0 100%}',
      '  .warden-toolbar .warden-btn.sm{margin-right:auto;padding:9px 14px}',
      '  .warden-row{gap:10px;padding:11px 12px}',
      '  .warden-account{padding:11px 12px}',
      '  .warden-account.indented{padding-left:16px}',
      '  .warden-note-body{padding:0 12px 12px}',
      '  .warden-modal{width:100%;border-radius:14px;padding:18px 16px}',
      '  .warden-modal-title{font-size:18px;margin-bottom:14px}',
      '  .warden-card{padding:24px 18px}',
      '  .warden-lock{padding:24px 4px}',
      '  .warden-search{font-size:16px}',              // 16px stops iOS input zoom
      '  .warden-input{font-size:16px}',
      '  .warden-empty{padding:26px 16px}',
      '  .warden-health-top{flex-direction:column;align-items:flex-start;text-align:left}',
      '  .warden-gen-out{font-size:15px;padding:14px}',
      '  .warden-ie-row{flex-wrap:wrap}',
      '  .warden-hist-row{flex-wrap:wrap}',
      '}',
      // Small and folded phones: the label/value/remove trio can't hold three
      // columns, so custom fields stack and the gutters go to a hairline.
      '@media (max-width:380px){',
      '  #kc-root{--vpad:8px}',
      '  .warden-row{gap:8px;padding:10px}',
      '  .warden-row-title{font-size:13.5px}',
      '  .warden-tab{padding:0 10px;gap:6px}',
      '  .warden-cf-row{flex-wrap:wrap}.warden-cf-row .warden-input{flex:1 1 100%}',
      '  .warden-cf-row .warden-icon{margin-left:auto}',
      '  .warden-modal{padding:16px 13px}',
      '  .warden-modal-actions .warden-btn{flex:1 1 100%}',
      '  .warden-gen-grid{grid-template-columns:1fr}',
      '  .warden-acc-actions{gap:6px}',
      '}',
      // Touch: every tappable thing gets a ≥38px target and hover styling is
      // dropped (it sticks after a tap on touch devices).
      '@media (pointer:coarse){',
      '  .warden-icon{width:38px;height:38px}',
      '  .warden-toolbar .warden-icon{width:40px;height:40px}',
      '  .warden-tab{height:38px}',
      '  .warden-search-clear{width:30px;height:30px}',
      '  .warden-link-btn{padding:8px 10px}',
      '  .warden-setting-row{padding:15px}',
      '  .warden-icon:hover{color:var(--txd);border-color:var(--bd)}',
      '  .warden-drag{color:var(--txd)}',   // visible without a hover to reveal it
      '  .warden-drag:hover{color:var(--txd);background:transparent;border-color:transparent}',
      '}',
    ].join('');
    document.head.appendChild(el('style', { id: 'warden-ui-styles', html: css }));
  }

  // ── activation: watch for the Keychain/Warden view becoming visible ─────────
  function isWardenVisible() { var r = $('kc-root'); return r && r.style.display !== 'none' && r.offsetParent !== null; }
  function tick() {
    var vis = isWardenVisible();
    document.body.classList.toggle('warden-active', !!vis); // scopes the wide page scrollbar to Warden
    if (vis && !$('warden-tabs')) activate();
  }
  function boot() {
    if (!window.WardenCrypto || !window.WardenStore || !window.WardenSession) { return setTimeout(boot, 200); }
    VC = window.WardenCrypto; WardenStore = window.WardenStore; WardenSession = window.WardenSession;
    // Deep link: ?wardentab=passwords|payments|sensitive (e.g. from the Warden
    // extension's gear) opens Warden directly on that tab.
    try { var vt = new URLSearchParams(location.search).get('wardentab'); if (SECRET_TABS[vt] || vt === 'links') activeTab = vt; } catch (e) {}
    // Poll for visibility (the nav toggles #kc-root display); cheap + robust
    // against the many code paths that can switch programs.
    setInterval(tick, 500);
    window.addEventListener('resize', updateStickyOffset);
    // Also hook the known switch fn if present.
    var orig = window._kcSwitchTo;
    if (typeof orig === 'function') window._kcSwitchTo = function () { var r = orig.apply(this, arguments); setTimeout(activate, 60); return r; };
    tick();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.Warden = { activate: activate, session: function () { return session; }, genPassword: genPassword, genPassphrase: genPassphrase, strength: strength, analyzeHealth: analyzeHealth, totpNow: totpNow, parseCSV: parseCSV, toCSV: toCSV, importFromCSV: importFromCSV, hostCtx: hostCtx, _setStore: function (s) { store = s; } };
})();
