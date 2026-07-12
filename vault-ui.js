/* ─────────────────────────────────────────────────────────────────────────────
 * vault-ui.js — Vault Password Manager · UI + Firebase adapter (PWA)
 *
 * Self-contained and self-injecting: it hooks into the existing Keychain view
 * (#kc-root) and turns it into "Vault" with three tabs — Passwords · Sensitive
 * Info · Links — WITHOUT requiring edits to the 38k-line index.html beyond a
 * single <script src> include. It reuses the app's already-initialised Firebase
 * instance (App Check + anon auth + offline cache) via getApps(), and the
 * existing window.Bio biometric helper.
 *
 * Depends on (loaded before it): vault-crypto.js, vault-store.js, vault-session.js
 *
 * Data lives E2E-encrypted in a single Firestore doc `dashboards/vault_pw`:
 *     { config:<wrapped-keys/salts/verifier>, items:{ id -> encDoc }, savedAt }
 * The DB only ever sees ciphertext + a routing `kind`. See vault-crypto.js.
 * ──────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';
  if (window.__vaultUiLoaded) return; window.__vaultUiLoaded = true;

  var VC = window.VaultCrypto, VaultStore = window.VaultStore, VaultSession = window.VaultSession;
  var FB_VER = '12.12.0';
  var VAULT_DOC = 'dashboards/vault_pw';
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
    var t = $('kc-toast'); if (!t) { t = el('div', { id: 'vault-toast', style: 'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:var(--s3,#202028);border:1px solid var(--bdl,#323240);color:var(--tx,#ececf0);font-size:13px;font-weight:600;padding:9px 16px;border-radius:9px;z-index:99999;box-shadow:0 8px 30px rgba(0,0,0,.5)' }); document.body.appendChild(t); }
    t.textContent = msg; t.style.opacity = '1'; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function () { t.style.opacity = '0'; t.classList.remove('show'); }, 1400);
  }
  // Drive the sync-status pill under the Vault title (reuses #kc-sync-status).
  var _syncClearTimer = null;
  function setVaultSync(state) {
    var e = $('kc-sync-status'); if (!e) return;
    clearTimeout(_syncClearTimer);
    e.style.visibility = 'visible'; e.style.display = 'block';
    if (state === 'saving') { e.textContent = 'Syncing…'; e.style.color = 'var(--ac)'; }
    else if (state === 'saved') { e.textContent = '✓ Synced'; e.style.color = 'var(--txd)'; _syncClearTimer = setTimeout(function () { e.style.visibility = 'hidden'; }, 2000); }
    else if (state === 'error') { e.textContent = '⚠ Sync failed — retrying'; e.style.color = '#e07070'; }
    else if (state === 'synced') { e.textContent = '✓ Synced'; e.style.color = 'var(--txd)'; _syncClearTimer = setTimeout(function () { e.style.visibility = 'hidden'; }, 1500); }
  }
  // Prefer the app's in-app modal (window.uiConfirm) over the browser's native
  // confirm dialog; fall back to native only if it's unavailable.
  function confirmUI(message, opts) {
    opts = opts || {};
    if (typeof window.uiConfirm === 'function') return window.uiConfirm(message, { title: opts.title, okLabel: opts.okLabel, cancelLabel: opts.cancelLabel, danger: opts.danger });
    return Promise.resolve(window.confirm(message));
  }
  function faviconUrl(url) {
    try { var host = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).hostname; return 'https://www.google.com/s2/favicons?sz=64&domain=' + encodeURIComponent(host); } catch (e) { return ''; }
  }
  function copyText(v, label) { try { navigator.clipboard.writeText(v).then(function () { toast((label || 'Copied') + ' — clears in 30s'); scheduleClipboardClear(v); }); } catch (e) { toast('Copy failed'); } }
  // Clear the clipboard after 30s if it still holds the secret we copied.
  function scheduleClipboardClear(v) {
    setTimeout(function () { try { navigator.clipboard.readText().then(function (cur) { if (cur === v) navigator.clipboard.writeText(''); }).catch(function () {}); } catch (e) {} }, 30000);
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
  // (window._fbSaveVault / _fbLoadVault + fb-vault-* events), the SAME mechanism
  // Keychain/TaskHub use to write dashboards/* reliably. No separate Firestore
  // instance, so nothing to diverge from the rest of the app.
  function makeFirebaseBackend() {
    var mirror = { config: null, items: {} };
    var loaded = false, itemSubs = [], errShown = false;

    function saveState() { return { config: mirror.config || null, items: mirror.items || {}, savedAt: Date.now() }; }
    function fbReady() { return typeof window._fbLoadVault === 'function' && typeof window._fbSaveVault === 'function'; }
    function waitForFb() {
      if (fbReady()) return Promise.resolve();
      return new Promise(function (res) {
        var t = setInterval(function () { if (fbReady()) { clearInterval(t); res(); } }, 150);
        setTimeout(function () { clearInterval(t); res(); }, 10000);
      });
    }

    // Remote updates from the shared Firestore listener → merge + notify store.
    window.addEventListener('fb-vault-remote-update', function (e) {
      var d = e.detail; if (!d) return;
      mirror.config = d.config || mirror.config;
      mirror.items = d.items || {};
      var list = Object.keys(mirror.items).map(function (k) { return mirror.items[k]; });
      itemSubs.forEach(function (fn) { try { fn(list); } catch (err) {} });
    });
    window.addEventListener('fb-vault-saved', function () { errShown = false; setVaultSync('saved'); });
    window.addEventListener('fb-vault-error', function (e) {
      setVaultSync('error');
      if (!errShown) { errShown = true; toast('Sync failed (' + (e.detail || 'error') + ') — retrying'); }
    });

    async function ensureLoaded() {
      await waitForFb();
      if (loaded) return;
      loaded = true;
      try { var d = await window._fbLoadVault(); if (d) { mirror.config = d.config || null; mirror.items = d.items || {}; } } catch (e) {}
    }
    function scheduleWrite() {
      setVaultSync('saving');
      if (fbReady()) window._fbSaveVault(saveState);
      else waitForFb().then(function () { if (fbReady()) window._fbSaveVault(saveState); });
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

  // ── controller ─────────────────────────────────────────────────────────────
  var session = null, store = null, backend = null, activeTab = 'links', currentQuery = '';

  function ensureSession() {
    if (session) return session;
    backend = makeFirebaseBackend();
    session = new VaultSession({
      backend: backend, bio: window.Bio || null,
      deviceStore: VaultSession.localStorageDeviceStore('vault.'),
      appId: 'vault', autoLockMs: 30 * 60 * 1000, // lock after 30 min idle (resets on activity)
      onLock: function () { renderLock(); },
    });
    return session;
  }

  // Called whenever the Keychain/Vault view becomes visible.
  async function activate() {
    injectShell();
    relabelNav();
    ensureSession();
    // Default to the (non-secret) Keychain tab — no unlock needed to open Vault.
    // Passwords / Sensitive still require unlock when their tab is selected.
    showTab(activeTab);
  }

  // ── shell: tabs + lock overlay + panels injected into #kc-root ─────────────
  function injectShell() {
    var root = $('kc-root'); if (!root || $('vault-tabs')) return;
    injectStyles();
    // Wrap existing Keychain content (everything after the header) as the Links tab.
    var hbar = root.querySelector('.app-hbar');
    var linksWrap = el('div', { id: 'vault-links-panel', class: 'vault-panel' });
    // Move the existing .kc-wrap (Connections) into the Links panel.
    var kcWrap = root.querySelector('.kc-wrap');
    var tabs = el('div', { id: 'vault-tabs', class: 'vault-tabs' }, [
      tabBtn('links', '🔗 Keychain'), tabBtn('passwords', '🔑 Passwords'), tabBtn('sensitive', '🗄 Sensitive Info'),
    ]);
    if (hbar && hbar.nextSibling) root.insertBefore(tabs, hbar.nextSibling); else root.appendChild(tabs);
    var pwPanel = el('div', { id: 'vault-pw-panel', class: 'vault-panel' });
    var senPanel = el('div', { id: 'vault-sensitive-panel', class: 'vault-panel', style: 'display:none' });
    root.appendChild(pwPanel); root.appendChild(senPanel);
    if (kcWrap) { kcWrap.parentNode.removeChild(kcWrap); linksWrap.appendChild(kcWrap); }
    linksWrap.style.display = 'none'; root.appendChild(linksWrap);
    // Lock overlay (covers everything but tabs stay to switch to Links which is non-secret? No — links are also under Vault; lock gates pw+sensitive only).
    var lock = el('div', { id: 'vault-lock', class: 'vault-lock', style: 'display:none' });
    pwPanel.appendChild(lock);
  }
  function tabBtn(id, label) {
    return el('button', { class: 'vault-tab' + (id === activeTab ? ' active' : ''), 'data-tab': id, onclick: function () { showTab(id); } }, [label]);
  }
  function relabelNav() {
    // Rename "Keychain" → "Vault" in the logo + nav without editing index.html.
    try {
      var logo = document.querySelector('#kc-root .kc-logo');
      if (logo && !logo._vaulted) { logo.innerHTML = '<span class="dot" style="color:var(--ac)">Vault</span>'; logo._vaulted = true; }
      document.querySelectorAll('[data-app="keychain"]').forEach(function (b) { if (/keychain/i.test(b.textContent)) b.textContent = 'Vault'; });
      document.querySelectorAll('option[value="keychain"]').forEach(function (o) { if (/keychain/i.test(o.textContent)) o.textContent = 'Vault'; });
    } catch (e) {}
  }

  function showTab(id) {
    activeTab = id;
    document.querySelectorAll('.vault-tab').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === id); });
    var pw = $('vault-pw-panel'), sen = $('vault-sensitive-panel'), links = $('vault-links-panel');
    if (pw) pw.style.display = id === 'passwords' ? '' : 'none';
    if (sen) sen.style.display = id === 'sensitive' ? '' : 'none';
    if (links) links.style.display = id === 'links' ? '' : 'none';
    if ((id === 'passwords' || id === 'sensitive')) {
      if (!session || !session.isUnlocked()) { renderLock(); return; }
      if (id === 'passwords') renderPasswords(); else renderSensitive();
    }
    updateStickyOffset();
  }
  // Pin the toolbar exactly below the (variable-height) sticky tabs.
  function updateStickyOffset() {
    var t = $('vault-tabs'); if (t) document.documentElement.style.setProperty('--vtabs-h', t.offsetHeight + 'px');
  }

  // ── lock / setup screens ───────────────────────────────────────────────────
  async function renderLock(hasVault) {
    var pw = $('vault-pw-panel'); if (!pw) return;
    if (hasVault == null) { try { hasVault = await session.hasVault(); } catch (e) { hasVault = false; } }
    var host = el('div', { class: 'vault-lock' });
    if (!hasVault) { renderSetup(host); }
    else { renderUnlock(host); }
    pw.innerHTML = ''; pw.appendChild(host);
    var sen = $('vault-sensitive-panel'); if (sen) sen.innerHTML = '';
  }

  function card(title, sub, kids) {
    return el('div', { class: 'vault-card' }, [
      el('div', { class: 'vault-lock-icon', html: '🔐' }),
      el('h2', { class: 'vault-h2' }, [title]),
      sub ? el('p', { class: 'vault-sub' }, [sub]) : null,
    ].concat(kids || []));
  }

  function renderSetup(host) {
    var pw1 = el('input', { type: 'password', class: 'vault-input', placeholder: 'Create master password', autocomplete: 'new-password' });
    var pw2 = el('input', { type: 'password', class: 'vault-input', placeholder: 'Confirm master password', autocomplete: 'new-password' });
    var meter = el('div', { class: 'vault-meter' }, [el('div', { class: 'vault-meter-fill' })]);
    var err = el('div', { class: 'vault-err' });
    pw1.addEventListener('input', function () { var s = strength(pw1.value); var f = meter.querySelector('.vault-meter-fill'); f.style.width = (s / 4 * 100) + '%'; f.style.background = ['#e05252', '#e0a052', '#e0d052', '#a0d052', '#52e075'][s]; });
    var btn = el('button', { class: 'vault-btn primary' }, ['Create Vault']);
    btn.addEventListener('click', async function () {
      err.textContent = '';
      if (pw1.value.length < 8) { err.textContent = 'Use at least 8 characters (a passphrase is best).'; return; }
      if (pw1.value !== pw2.value) { err.textContent = 'Passwords do not match.'; return; }
      btn.disabled = true; btn.textContent = 'Encrypting…';
      try { var r = await session.setup(pw1.value); showRecovery(r.recoveryCode, true); }
      catch (e) { err.textContent = 'Setup failed: ' + (e.message || e); btn.disabled = false; btn.textContent = 'Create Vault'; }
    });
    host.appendChild(card('Set up your Vault',
      'Your master password encrypts everything on this device before it syncs. It is never sent to the cloud and cannot be recovered by anyone — choose a strong passphrase you will remember.',
      [pw1, meter, pw2, err, btn,
        el('p', { class: 'vault-fine' }, ['End-to-end encrypted · AES-256-GCM · PBKDF2 600k · zero-knowledge'])]));
  }

  function showRecovery(code, firstRun) {
    var pw = $('vault-pw-panel'); if (!pw) return;
    // Force the passwords panel to be the visible one — otherwise, if Settings
    // was opened from another tab, the new key would render into a hidden panel.
    activeTab = 'passwords';
    document.querySelectorAll('.vault-tab').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === 'passwords'); });
    var sen = $('vault-sensitive-panel'), links = $('vault-links-panel');
    if (sen) sen.style.display = 'none'; if (links) links.style.display = 'none';
    pw.style.display = '';
    var codeBox = el('div', { class: 'vault-recovery-code' }, [code]);
    var copied = el('button', { class: 'vault-btn' }, ['Copy recovery key']);
    copied.addEventListener('click', function () { copyText(code, 'Recovery key copied'); });
    var chk = el('input', { type: 'checkbox', id: 'vault-rec-ack' });
    var cont = el('button', { class: 'vault-btn primary', disabled: 'disabled' }, ['I saved it — continue']);
    chk.addEventListener('change', function () { cont.disabled = !chk.checked; });
    // First run: the store hasn't been initialised yet — afterUnlock() sets it
    // up, loads items, starts live sync, then shows the list. Rotate-recovery
    // (already unlocked): just return to the current tab.
    cont.addEventListener('click', async function () {
      cont.disabled = true;
      if (!store) { await afterUnlock(); }
      else { showTab(activeTab === 'links' ? 'passwords' : activeTab); }
    });
    var host = el('div', { class: 'vault-lock' }, [
      card('Your Recovery Key',
        'This is the ONLY way back in if you forget your master password AND lose your biometric devices. Write it down or store it in a safe place. It will not be shown again.',
        [codeBox, copied,
          el('label', { class: 'vault-ack' }, [chk, el('span', {}, ['I have saved my recovery key somewhere safe'])]),
          cont]),
    ]);
    pw.innerHTML = ''; pw.appendChild(host);
  }

  async function renderUnlock(host) {
    var pwIn = el('input', { type: 'password', class: 'vault-input', placeholder: 'Master password', autocomplete: 'current-password' });
    var err = el('div', { class: 'vault-err' });
    var unlockBtn = el('button', { class: 'vault-btn primary' }, ['Unlock']);
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
      var bioBtn = el('button', { class: 'vault-btn' }, ['🔓  Unlock with ' + (window.Bio.label ? window.Bio.label() : 'biometrics')]);
      bioBtn.addEventListener('click', async function () {
        err.textContent = '';
        try { await session.unlockWithBiometric(); afterUnlock(); }
        catch (e) { if (e.message !== 'cancelled') err.textContent = 'Biometric unlock failed — use your password.'; }
      });
      kids.splice(2, 0, bioBtn);
      // Auto-prompt biometrics on open for a Face-ID-like feel.
      setTimeout(function () { bioBtn.click(); }, 250);
    }
    var recov = el('button', { class: 'vault-link-btn' }, ['Use recovery key instead']);
    recov.addEventListener('click', function () { renderRecoveryUnlock(); });
    kids.push(recov);
    host.appendChild(card('Vault is locked', 'Unlock with your ' + (deviceHasBio ? 'biometrics or ' : '') + 'master password.', kids));
    setTimeout(function () { pwIn.focus(); }, 60);
  }

  function renderRecoveryUnlock() {
    var pw = $('vault-pw-panel'); if (!pw) return;
    var input = el('textarea', { class: 'vault-input', rows: '2', placeholder: 'Enter your recovery key (dashes optional)' });
    var err = el('div', { class: 'vault-err' });
    var btn = el('button', { class: 'vault-btn primary' }, ['Recover access']);
    btn.addEventListener('click', async function () {
      err.textContent = ''; btn.disabled = true; btn.textContent = 'Verifying…';
      try { await session.unlockWithRecovery(input.value); toast('Recovered — set a new master password in settings'); afterUnlock(); }
      catch (e) { err.textContent = 'That recovery key did not match.'; btn.disabled = false; btn.textContent = 'Recover access'; }
    });
    var back = el('button', { class: 'vault-link-btn' }, ['← Back']);
    back.addEventListener('click', function () { renderLock(true); });
    var host = el('div', { class: 'vault-lock' }, [card('Recovery', 'Enter the one-time recovery key you saved when you created the vault.', [input, err, btn, back])]);
    pw.innerHTML = ''; pw.appendChild(host);
  }

  async function afterUnlock() {
    store = session.getStore();
    await store.load();
    store.startLive(function () { setVaultSync('synced'); if (activeTab === 'passwords') renderPasswords(); else if (activeTab === 'sensitive') renderSensitive(); });
    bindActivity();
    maybeOfferBiometric();
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
      if (await session.biometricEnabled()) return;
      if (!(await session.biometricSupported())) return;
      if (localStorage.getItem('vault.bioDeclined')) return;
      var label = window.Bio.label ? window.Bio.label() : 'biometrics';
      var ok = await confirmUI('Enable ' + label + ' to unlock your Vault on this device? Your master password still works as a fallback.',
        { title: 'Enable ' + label, okLabel: 'Enable', cancelLabel: 'Not now' });
      if (!ok) { localStorage.setItem('vault.bioDeclined', '1'); return; }
      await session.enableBiometric(label); toast(label + ' enabled on this device');
    } catch (e) { console.warn('[vault] biometric enroll skipped', e); }
  }

  // ── passwords panel ────────────────────────────────────────────────────────
  // The toolbar (with the search box) is built ONCE per full render; typing only
  // re-fills the list container via refreshList(), so the search input keeps
  // focus and never "stops after one character".
  function renderPasswords() {
    var panel = $('vault-pw-panel'); if (!panel) return;
    if (!session || !session.isUnlocked()) { renderLock(); return; }
    if (!store) { afterUnlock(); return; } // store not ready yet — bootstrap then re-render
    panel.innerHTML = '';
    panel.appendChild(toolbar('Search logins…', 'login'));
    var list = el('div', { class: 'vault-list' });
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
  }
  function fillSensitiveList(list) {
    list.innerHTML = '';
    var items = currentQuery ? store.search(currentQuery).filter(function (i) { return i.kind === 'sensitive'; }) : store.byKind('sensitive');
    if (!items.length) { list.appendChild(emptyState('No secure notes yet. Store Wi-Fi passwords, lock combos, recovery codes, license keys…')); return; }
    items.forEach(function (it) { list.appendChild(sensitiveRow(it)); });
  }
  // Re-fill just the list for the active kind (used on every keystroke).
  function refreshList(kind) {
    var panel = $(kind === 'login' ? 'vault-pw-panel' : 'vault-sensitive-panel'); if (!panel) return;
    var list = panel.querySelector('.vault-list');
    if (!list) { (kind === 'login' ? renderPasswords : renderSensitive)(); return; }
    (kind === 'login' ? fillLoginList : fillSensitiveList)(list);
  }

  function toolbar(placeholder, kind) {
    var search = el('input', { class: 'vault-search', placeholder: placeholder, value: currentQuery });
    var clear = el('button', { class: 'vault-search-clear', title: 'Clear', html: '&times;', style: currentQuery ? '' : 'display:none' });
    clear.addEventListener('click', function () { currentQuery = ''; search.value = ''; clear.style.display = 'none'; refreshList(kind); search.focus(); });
    search.addEventListener('input', function () { currentQuery = search.value; clear.style.display = search.value ? '' : 'none'; refreshList(kind); });
    var add = el('button', { class: 'vault-btn primary sm', onclick: function () { openEditor(kind); } }, ['+ Add']);
    // Settings + Lock live here (top of the section) so they're always reachable
    // without scrolling to the bottom.
    var kids = [el('div', { class: 'vault-search-wrap' }, [search, clear]), add];
    if (kind === 'login') kids.push(iconBtn('Password health', shieldIcon(), openHealth));
    kids.push(iconBtn('Settings', gearIcon(), openSettings));
    kids.push(iconBtn('Lock now', lockIcon(), function () { session.lock(); renderLock(true); }));
    return el('div', { class: 'vault-toolbar' }, kids);
  }
  function emptyState(msg) { return el('div', { class: 'vault-empty' }, [msg]); }

  function siteRow(g) {
    var multi = g.items.length > 1;
    var subText = multi ? g.items.length + ' accounts' : (g.sample.username || g.sample.email || g.key);
    var head = el('div', { class: 'vault-row' }, [
      favicon(g.sample.url),
      el('div', { class: 'vault-row-main' }, [
        el('div', { class: 'vault-row-title' }, [g.sample.title || g.key]),
        el('div', { class: 'vault-row-sub' }, [subText]),
      ]),
      g.sample.category ? el('span', { class: 'vault-tag' }, [g.sample.category]) : null,
    ]);
    var wrap = el('div', { class: 'vault-site' }, [head]);
    var body = el('div', { class: 'vault-accounts' });
    g.items.forEach(function (it) { body.appendChild(accountRow(it, multi)); });
    if (multi) { head.style.cursor = 'pointer'; body.style.display = 'none'; head.addEventListener('click', function () { body.style.display = body.style.display === 'none' ? '' : 'none'; }); }
    wrap.appendChild(body);
    return wrap;
  }

  // One stacked value line: label + value (no inline buttons — all actions live
  // in the single button row on the right).
  function valLine(label, value, muted) {
    return el('div', { class: 'vault-acc-line' }, [
      el('div', { class: 'vault-acc-field' }, [
        el('span', { class: 'vault-acc-flabel' }, [label]),
        el('span', { class: 'vault-acc-val' + (muted ? ' muted' : '') }, [value]),
      ]),
    ]);
  }
  function accountRow(it, indented) {
    var shown = false, revBtn;
    var pwText = el('span', { class: 'vault-pw-dots' }, ['••••••••••']);
    function toggle() { shown = !shown; pwText.textContent = shown ? (it.password || '') : '••••••••••'; if (revBtn) revBtn.innerHTML = shown ? eyeOff() : eye(); }
    revBtn = el('button', { class: 'vault-icon', title: 'Reveal password', onclick: toggle, html: eye() });

    var main = el('div', { class: 'vault-acc-main' });
    if (it.username) main.appendChild(valLine('Username', it.username));
    if (it.email) main.appendChild(valLine('Email', it.email));
    if (!it.username && !it.email) main.appendChild(valLine('Username', '(none)', true));
    main.appendChild(el('div', { class: 'vault-acc-line' }, [
      el('div', { class: 'vault-acc-field' }, [el('span', { class: 'vault-acc-flabel' }, ['Password']), el('span', { class: 'vault-acc-pw' }, [pwText])]),
    ]));

    // ONE horizontal row of actions: copy username, copy email, copy password,
    // reveal, open, edit.
    var actions = el('div', { class: 'vault-acc-actions' });
    if (it.username) actions.appendChild(iconBtn('Copy username', userIcon(), function () { copyText(it.username, 'Username copied'); }));
    if (it.email) actions.appendChild(iconBtn('Copy email', mailIcon(), function () { copyText(it.email, 'Email copied'); }));
    actions.appendChild(iconBtn('Copy password', keyIcon(), function () { copyText(it.password || '', 'Password copied'); }));
    actions.appendChild(revBtn);
    if (it.url) actions.appendChild(iconBtn('Open site', extIcon(), function () { window.open(/^https?:/.test(it.url) ? it.url : 'https://' + it.url, '_blank', 'noopener'); }));
    actions.appendChild(iconBtn('Edit', editIcon(), function () { openEditor('login', it); }));

    return el('div', { class: 'vault-account' + (indented ? ' indented' : '') }, [main, actions]);
  }

  // ── sensitive info panel ───────────────────────────────────────────────────
  function renderSensitive() {
    var panel = $('vault-sensitive-panel'); if (!panel) return;
    if (!session || !session.isUnlocked()) { renderLock(); return; }
    if (!store) { afterUnlock(); return; } // store not ready yet — bootstrap then re-render
    panel.innerHTML = '';
    panel.appendChild(toolbar('Search secure notes…', 'sensitive'));
    var list = el('div', { class: 'vault-list' });
    fillSensitiveList(list);
    panel.appendChild(list);
  }
  function sensitiveRow(it) {
    var copyBtn = iconBtn('Copy details', copyIcon(), function (e) { e.stopPropagation(); copyText(it.notes || '', 'Details copied'); });
    var body = el('div', { class: 'vault-note-body' }, [
      el('div', { class: 'vault-note-text' }, [it.notes || '(empty)']),
      el('div', { class: 'vault-note-actions' }, [copyBtn]),
    ]);
    body.style.display = 'none';
    var head = el('div', { class: 'vault-row', style: 'cursor:pointer' }, [
      el('div', { class: 'vault-note-icon', html: cabinetIcon() }),
      el('div', { class: 'vault-row-main' }, [
        el('div', { class: 'vault-row-title' }, [it.title || 'Untitled']),
        it.category ? el('div', { class: 'vault-row-sub' }, [it.category]) : null,
      ]),
      iconBtn('Edit', editIcon(), function (e) { e.stopPropagation(); openEditor('sensitive', it); }),
    ]);
    head.addEventListener('click', function () { body.style.display = body.style.display === 'none' ? '' : 'none'; });
    return el('div', { class: 'vault-site' }, [head, body]);
  }

  // ── editor modal ───────────────────────────────────────────────────────────
  function openEditor(kind, item) {
    item = item || {};
    var isLogin = kind === 'login';
    var overlay = el('div', { class: 'vault-overlay' }); // no backdrop-close — avoids losing in-progress edits
    function close() { overlay.remove(); }
    var f = {};
    function field(label, key, opts) {
      opts = opts || {};
      var input = el(opts.textarea ? 'textarea' : 'input', { class: 'vault-input', type: opts.type || 'text', value: item[key] || '', placeholder: opts.ph || '' });
      f[key] = input;
      var row = [el('label', { class: 'vault-flabel' }, [label]), input];
      if (opts.after) row.push(opts.after);
      return el('div', { class: 'vault-field' }, row);
    }
    var body = el('div', { class: 'vault-modal', onclick: function (e) { e.stopPropagation(); } });
    body.appendChild(el('div', { class: 'vault-modal-title' }, [(item.id ? 'Edit ' : 'Add ') + (isLogin ? 'Login' : 'Secure Note')]));
    if (isLogin) {
      body.appendChild(field('Name', 'title', { ph: 'e.g. GitHub' }));
      body.appendChild(field('Website / URL', 'url', { ph: 'github.com' }));
      body.appendChild(field('Username', 'username', { ph: 'username' }));
      body.appendChild(field('Email', 'email', { ph: 'you@example.com' }));
      // password with reveal + generate
      var pwInput = el('input', { class: 'vault-input', type: 'password', value: item.password || '', placeholder: 'password' }); f.password = pwInput;
      var gen = el('button', { class: 'vault-icon', title: 'Generate', html: '🎲', type: 'button' });
      var rev = el('button', { class: 'vault-icon', title: 'Reveal', html: eye(), type: 'button' });
      var showp = false; rev.addEventListener('click', function () { showp = !showp; pwInput.type = showp ? 'text' : 'password'; rev.innerHTML = showp ? eyeOff() : eye(); });
      gen.addEventListener('click', function () { openGenerator(function (v) { pwInput.value = v; pwInput.type = 'text'; showp = true; rev.innerHTML = eyeOff(); }); });
      body.appendChild(el('div', { class: 'vault-field' }, [el('label', { class: 'vault-flabel' }, ['Password']), el('div', { class: 'vault-pw-input' }, [pwInput, rev, gen])]));
      body.appendChild(catField(f, item));
      body.appendChild(field('TOTP secret (optional)', 'totp', { ph: 'For authenticator codes — future-ready' }));
      body.appendChild(field('Tags (comma-separated)', 'tags', { ph: 'work, personal' }));
      body.appendChild(field('Notes', 'notes', { textarea: true }));
    } else {
      body.appendChild(field('Title', 'title', { ph: 'e.g. Home Wi-Fi, Safe combo' }));
      body.appendChild(catField(f, item));
      body.appendChild(field('Details', 'notes', { textarea: true, ph: 'The secret info you want to keep safe…' }));
    }
    var err = el('div', { class: 'vault-err' });
    var save = el('button', { class: 'vault-btn primary' }, [item.id ? 'Save' : 'Add']);
    save.addEventListener('click', async function () {
      var out = { id: item.id, kind: kind, createdAt: item.createdAt };
      Object.keys(f).forEach(function (k) { out[k] = f[k].value; });
      if (out.tags != null) out.tags = String(out.tags).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (isLogin ? (!out.title && !out.url) : !out.title) { err.textContent = 'Give it a name.'; return; }
      save.disabled = true; save.textContent = 'Saving…';
      try { await store.save(out); close(); (isLogin ? renderPasswords : renderSensitive)(); toast('Saved'); }
      catch (e) { err.textContent = 'Save failed: ' + e.message; save.disabled = false; save.textContent = 'Save'; }
    });
    var actions = [save, el('button', { class: 'vault-btn', onclick: close }, ['Cancel'])];
    if (item.id) { var del = el('button', { class: 'vault-btn danger', onclick: async function () { if (await confirmUI('Delete this item? This cannot be undone.', { title: 'Delete item', okLabel: 'Delete', danger: true })) { await store.remove(item.id); close(); (isLogin ? renderPasswords : renderSensitive)(); toast('Deleted'); } } }, ['Delete']); actions.push(del); }
    body.appendChild(err);
    body.appendChild(el('div', { class: 'vault-modal-actions' }, actions));
    overlay.appendChild(body); document.body.appendChild(overlay);
    setTimeout(function () { var first = body.querySelector('input,textarea'); if (first) first.focus(); }, 50);
  }
  function catField(f, item) {
    var sel = el('select', { class: 'vault-input' });
    var cats = CATEGORIES.slice(); if (item.category && cats.indexOf(item.category) < 0) cats.unshift(item.category);
    cats.forEach(function (c) { var o = el('option', { value: c }, [c]); if (item.category === c) o.selected = true; sel.appendChild(o); });
    f.category = sel;
    return el('div', { class: 'vault-field' }, [el('label', { class: 'vault-flabel' }, ['Category']), sel]);
  }

  // ── generator modal ────────────────────────────────────────────────────────
  function openGenerator(onUse) {
    var overlay = el('div', { class: 'vault-overlay' }); // no backdrop-close — avoids losing in-progress edits
    var mode = 'password';
    var out = el('div', { class: 'vault-gen-out' });
    var opts = { length: 20, lower: true, upper: true, num: true, sym: true, easy: false };
    var pass = { words: 4 };
    function regen() { out.textContent = mode === 'password' ? genPassword(opts) : genPassphrase(pass.words); }
    function toggleRow(label, key, obj) {
      var cb = el('input', { type: 'checkbox' }); cb.checked = !!obj[key];
      cb.addEventListener('change', function () { obj[key] = cb.checked; regen(); });
      return el('label', { class: 'vault-gen-opt' }, [cb, el('span', {}, [label])]);
    }
    var body = el('div', { class: 'vault-modal', onclick: function (e) { e.stopPropagation(); } }, [
      el('div', { class: 'vault-modal-title' }, ['Password Generator']),
      el('div', { class: 'vault-gen-tabs' }, [
        genTab('Password', function () { mode = 'password'; buildOpts(); regen(); }, true),
        genTab('Passphrase', function () { mode = 'passphrase'; buildOpts(); regen(); }, false),
      ]),
      out,
    ]);
    var optWrap = el('div', { class: 'vault-gen-opts' });
    function buildOpts() {
      optWrap.innerHTML = '';
      if (mode === 'password') {
        var lenLabel = el('span', {}, ['Length: ' + opts.length]);
        var slider = el('input', { type: 'range', min: '8', max: '64', value: String(opts.length), class: 'vault-range' });
        slider.addEventListener('input', function () { opts.length = +slider.value; lenLabel.textContent = 'Length: ' + opts.length; regen(); });
        optWrap.appendChild(el('div', { class: 'vault-gen-len' }, [lenLabel, slider]));
        optWrap.appendChild(el('div', { class: 'vault-gen-grid' }, [
          toggleRow('a-z', 'lower', opts), toggleRow('A-Z', 'upper', opts),
          toggleRow('0-9', 'num', opts), toggleRow('!@#$', 'sym', opts),
          toggleRow('Easy to read', 'easy', opts),
        ]));
      } else {
        var wl = el('span', {}, ['Words: ' + pass.words]);
        var ws = el('input', { type: 'range', min: '3', max: '8', value: String(pass.words), class: 'vault-range' });
        ws.addEventListener('input', function () { pass.words = +ws.value; wl.textContent = 'Words: ' + pass.words; regen(); });
        optWrap.appendChild(el('div', { class: 'vault-gen-len' }, [wl, ws]));
      }
    }
    body.appendChild(optWrap);
    var useBtn = el('button', { class: 'vault-btn primary' }, ['Use']);
    useBtn.addEventListener('click', function () { onUse(out.textContent); overlay.remove(); });
    var copyBtn = el('button', { class: 'vault-btn', onclick: function () { copyText(out.textContent, 'Password copied'); } }, ['Copy']);
    var reBtn = el('button', { class: 'vault-btn', onclick: regen }, ['↻ Regenerate']);
    var closeBtn = el('button', { class: 'vault-btn', onclick: function () { overlay.remove(); } }, ['Close']);
    body.appendChild(el('div', { class: 'vault-modal-actions' }, [useBtn, copyBtn, reBtn, closeBtn]));
    buildOpts(); regen();
    overlay.appendChild(body); document.body.appendChild(overlay);
  }
  function genTab(label, onClick, active) { var b = el('button', { class: 'vault-gen-tab' + (active ? ' active' : ''), onclick: function () { body_setActive(b); onClick(); } }, [label]); return b; }
  function body_setActive(b) { var p = b.parentNode; p.querySelectorAll('.vault-gen-tab').forEach(function (x) { x.classList.remove('active'); }); b.classList.add('active'); }

  function footerBar() {
    var lock = el('button', { class: 'vault-link-btn', onclick: function () { session.lock(); renderLock(true); } }, ['🔒 Lock now']);
    var settings = el('button', { class: 'vault-link-btn', onclick: openSettings }, ['⚙ Settings']);
    return el('div', { class: 'vault-footer' }, [settings, lock]);
  }
  function openSettings() {
    var overlay = el('div', { class: 'vault-overlay' }); // no backdrop-close — avoids losing in-progress edits
    var body = el('div', { class: 'vault-modal', onclick: function (e) { e.stopPropagation(); } }, [el('div', { class: 'vault-modal-title' }, ['Vault Settings'])]);
    var rows = el('div', {});
    rows.appendChild(settingRow('Import / Export & Backup', function () { overlay.remove(); openImportExport(); }));
    rows.appendChild(settingRow('Change master password', function () { overlay.remove(); openChangePassword(); }));
    rows.appendChild(settingRow('Rotate recovery key', async function () {
      if (!(await confirmUI('Generate a NEW recovery key? Your old one stops working immediately.', { title: 'Rotate recovery key', okLabel: 'Generate new', danger: true }))) return;
      // Require identity before minting a new recovery key.
      if (!(await verifyIdentity('rotate your recovery key'))) return;
      session.rotateRecovery().then(function (r) { overlay.remove(); showRecovery(r.recoveryCode); }).catch(function (e) { toast('Failed: ' + e.message); });
    }));
    session.biometricEnabled().then(function (on) {
      rows.appendChild(settingRow(on ? 'Disable biometric unlock (this device)' : 'Enable biometric unlock (this device)', async function () {
        if (on) {
          // Verify identity (biometric scan or password) BEFORE disabling.
          if (!(await verifyIdentity('disable biometric unlock'))) return;
          session.disableBiometric().then(function () { toast('Biometrics disabled'); overlay.remove(); });
        } else {
          session.enableBiometric(window.Bio && window.Bio.label ? window.Bio.label() : 'biometrics').then(function () { toast('Biometrics enabled'); overlay.remove(); }).catch(function (e) { if (e.message !== 'cancelled') toast('Failed: ' + e.message); });
        }
      }));
    });
    body.appendChild(rows);
    body.appendChild(el('div', { class: 'vault-modal-actions' }, [el('button', { class: 'vault-btn', onclick: function () { overlay.remove(); } }, ['Close'])]));
    overlay.appendChild(body); document.body.appendChild(overlay);
  }
  function settingRow(label, onClick) { return el('button', { class: 'vault-setting-row', onclick: onClick }, [label]); }

  // In-app password prompt → resolves to the typed value or null (cancel).
  function promptSecret(title, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var overlay = el('div', { class: 'vault-overlay' });
      var input = el('input', { type: 'password', class: 'vault-input', placeholder: opts.placeholder || 'Master password', autocomplete: 'current-password' });
      var err = el('div', { class: 'vault-err' });
      function done(v) { overlay.remove(); resolve(v); }
      var ok = el('button', { class: 'vault-btn primary', onclick: function () { if (!input.value) { err.textContent = 'Required'; return; } done(input.value); } }, [opts.okLabel || 'Confirm']);
      var cancel = el('button', { class: 'vault-btn', onclick: function () { done(null); } }, ['Cancel']);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok.click(); });
      var boxKids = [el('div', { class: 'vault-modal-title' }, [title])];
      if (opts.sub) boxKids.push(el('p', { class: 'vault-sub', style: 'text-align:left;margin-bottom:12px' }, [opts.sub]));
      boxKids.push(input, err, el('div', { class: 'vault-modal-actions' }, [ok, cancel]));
      var box = el('div', { class: 'vault-modal', onclick: function (e) { e.stopPropagation(); } }, boxKids);
      overlay.appendChild(box); document.body.appendChild(overlay);
      setTimeout(function () { input.focus(); }, 50);
    });
  }

  // Confirm the user's identity on an already-unlocked vault: biometric scan if
  // enabled, otherwise master-password entry. Returns true only on success.
  async function verifyIdentity(actionLabel) {
    try { if (window.Bio && (await session.biometricEnabled())) { if (await session.confirmBiometric()) return true; } } catch (e) {}
    var pw = await promptSecret('Confirm it\'s you', { sub: 'Enter your master password to ' + actionLabel + '.', okLabel: 'Confirm' });
    if (pw == null) return false;
    if (await session.verifyPassword(pw)) return true;
    toast('Incorrect password'); return false;
  }

  // Wrap a password input with a show/hide eye toggle.
  function revealField(input) {
    var shown = false;
    var btn = el('button', { class: 'vault-icon', type: 'button', title: 'Show', html: eye() });
    btn.addEventListener('click', function () { shown = !shown; input.type = shown ? 'text' : 'password'; btn.innerHTML = shown ? eyeOff() : eye(); });
    return el('div', { class: 'vault-pw-input' }, [input, btn]);
  }
  // Change master password — real in-app form with verified current password.
  function openChangePassword() {
    var overlay = el('div', { class: 'vault-overlay' }); // no backdrop-close — avoids losing in-progress edits
    var cur = el('input', { type: 'password', class: 'vault-input', placeholder: 'Current master password', autocomplete: 'current-password' });
    var nw = el('input', { type: 'password', class: 'vault-input', placeholder: 'New master password', autocomplete: 'new-password' });
    var cf = el('input', { type: 'password', class: 'vault-input', placeholder: 'Confirm new password', autocomplete: 'new-password' });
    var meter = el('div', { class: 'vault-meter' }, [el('div', { class: 'vault-meter-fill' })]);
    nw.addEventListener('input', function () { var s = strength(nw.value); var f = meter.querySelector('.vault-meter-fill'); f.style.width = (s / 4 * 100) + '%'; f.style.background = ['#e05252', '#e0a052', '#e0d052', '#a0d052', '#52e075'][s]; });
    var err = el('div', { class: 'vault-err' });
    var save = el('button', { class: 'vault-btn primary' }, ['Change password']);
    save.addEventListener('click', async function () {
      err.textContent = '';
      if (nw.value.length < 8) { err.textContent = 'New password must be at least 8 characters.'; return; }
      if (nw.value !== cf.value) { err.textContent = 'New passwords do not match.'; return; }
      save.disabled = true; save.textContent = 'Verifying…';
      try {
        await session.changeMasterPassword(cur.value, nw.value); // throws bad-password if current is wrong
        toast('Master password changed'); overlay.remove();
      } catch (e) {
        err.textContent = e.message === 'bad-password' ? 'Current password is incorrect.' : ('Failed: ' + e.message);
        save.disabled = false; save.textContent = 'Change password';
      }
    });
    var box = el('div', { class: 'vault-modal', onclick: function (e) { e.stopPropagation(); } }, [
      el('div', { class: 'vault-modal-title' }, ['Change Master Password']),
      el('label', { class: 'vault-flabel' }, ['Current password']), revealField(cur),
      el('label', { class: 'vault-flabel' }, ['New password']), revealField(nw), meter,
      el('label', { class: 'vault-flabel' }, ['Confirm new password']), revealField(cf),
      err, el('div', { class: 'vault-modal-actions' }, [save, el('button', { class: 'vault-btn', onclick: function () { overlay.remove(); } }, ['Cancel'])]),
    ]);
    overlay.appendChild(box); document.body.appendChild(overlay);
    setTimeout(function () { cur.focus(); }, 50);
  }

  // ── password health dashboard ──────────────────────────────────────────────
  function openHealth() {
    var overlay = el('div', { class: 'vault-overlay' });
    var box = el('div', { class: 'vault-modal', onclick: function (e) { e.stopPropagation(); } });
    var h = analyzeHealth(store.byKind('login'));
    var color = h.score >= 80 ? '#52e075' : h.score >= 50 ? '#e0d052' : '#e05252';

    // score ring
    var circ = 2 * Math.PI * 34;
    var ring = '<svg width="92" height="92" viewBox="0 0 80 80" style="transform:rotate(-90deg)">' +
      '<circle cx="40" cy="40" r="34" stroke="var(--bd)" stroke-width="7" fill="none"/>' +
      '<circle cx="40" cy="40" r="34" stroke="' + color + '" stroke-width="7" fill="none" stroke-linecap="round" stroke-dasharray="' + circ + '" stroke-dashoffset="' + (circ * (1 - h.score / 100)) + '"/></svg>';
    var scoreEl = el('div', { class: 'vault-health-score' }, [
      el('div', { class: 'vault-health-ring', html: ring }),
      el('div', { class: 'vault-health-num', style: 'color:' + color }, [String(h.score)]),
    ]);
    box.appendChild(el('div', { class: 'vault-modal-title' }, ['Password Health']));
    box.appendChild(el('div', { class: 'vault-health-top' }, [
      scoreEl,
      el('div', {}, [
        el('div', { class: 'vault-health-label' }, [h.score >= 80 ? 'Looking good' : h.score >= 50 ? 'Room to improve' : 'Needs attention']),
        el('div', { class: 'vault-health-sub' }, [h.total + ' login' + (h.total === 1 ? '' : 's') + ' analyzed']),
      ]),
    ]));

    function section(title, items, tone, describe) {
      if (!items.length) return;
      var listWrap = el('div', { class: 'vault-health-items', style: 'display:none' });
      // items may be a flat list of logins OR groups (arrays)
      var flat = Array.isArray(items[0]) ? [].concat.apply([], items) : items;
      flat.forEach(function (it) {
        listWrap.appendChild(el('div', { class: 'vault-health-item', onclick: function () { overlay.remove(); openEditor('login', it); } }, [
          favicon(it.url),
          el('div', { class: 'vault-row-main' }, [
            el('div', { class: 'vault-row-title' }, [it.title || it.url || '(untitled)']),
            el('div', { class: 'vault-row-sub' }, [it.username || it.email || '']),
          ]),
          el('span', { class: 'vault-mini-edit', html: editIcon() }),
        ]));
      });
      var count = Array.isArray(items[0]) ? flat.length : items.length;
      var head = el('div', { class: 'vault-health-cat vault-health-' + tone }, [
        el('span', { class: 'vault-health-dot' }),
        el('div', { style: 'flex:1' }, [el('div', { class: 'vault-health-cat-title' }, [title + ' · ' + count]), el('div', { class: 'vault-health-cat-desc' }, [describe])]),
        el('span', { class: 'vault-health-chev', html: '▾' }),
      ]);
      head.addEventListener('click', function () { listWrap.style.display = listWrap.style.display === 'none' ? '' : 'none'; });
      box.appendChild(head); box.appendChild(listWrap);
    }

    var anyIssue = h.weak.length || h.reusedCount || h.old.length || h.missing.length || h.duplicates.length;
    if (!anyIssue) box.appendChild(el('div', { class: 'vault-empty', style: 'margin-top:8px' }, ['No issues found. Every login has a strong, unique, recent password. 🎉']));
    section('Weak', h.weak, 'bad', 'Short or low-complexity — easy to crack. Generate a stronger one.');
    section('Reused', h.reusedGroups, 'bad', 'The same password on multiple sites — one breach exposes them all.');
    section('Old', h.old, 'warn', 'Not changed in over a year — consider rotating.');
    section('Missing password', h.missing, 'warn', 'No password saved on this entry.');
    section('Duplicate accounts', h.duplicates, 'warn', 'Same site and username saved more than once.');

    box.appendChild(el('div', { class: 'vault-modal-actions' }, [el('button', { class: 'vault-btn', onclick: function () { overlay.remove(); } }, ['Close'])]));
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
    var overlay = el('div', { class: 'vault-overlay' });
    var status = el('div', { class: 'vault-err', style: 'color:var(--txd)' });

    // hidden file inputs
    var csvInput = el('input', { type: 'file', accept: '.csv,text/csv', style: 'display:none' });
    csvInput.addEventListener('change', async function () {
      var f = csvInput.files[0]; csvInput.value = ''; if (!f) return;
      status.textContent = 'Importing…';
      try { var n = await importFromCSV(await f.text()); status.style.color = 'var(--txd)'; status.textContent = 'Imported ' + n + ' login' + (n === 1 ? '' : 's') + '.'; toast('Imported ' + n); renderPasswords(); }
      catch (e) { status.style.color = '#e07070'; status.textContent = 'Import failed: ' + e.message; }
    });
    var backupInput = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
    backupInput.addEventListener('change', async function () {
      var f = backupInput.files[0]; backupInput.value = ''; if (!f) return;
      try {
        var data = JSON.parse(await f.text());
        if (data.format !== 'vault-encrypted-backup' || !data.config) throw new Error('Not a Vault backup file');
        if (!(await confirmUI('Restore this backup? It MERGES the backup\'s ' + ((data.items || []).length) + ' item(s) into this vault, and replaces your master password/keys with the backup\'s. You will unlock with the backup\'s master password.', { title: 'Restore backup', okLabel: 'Restore', danger: true }))) return;
        await backend.saveConfig(data.config);
        for (var i = 0; i < (data.items || []).length; i++) await backend.putItem(data.items[i]);
        overlay.remove(); session.lock(); toast('Backup restored — unlock with its master password'); renderLock(true);
      } catch (e) { status.style.color = '#e07070'; status.textContent = 'Restore failed: ' + e.message; }
    });

    function row(title, desc, btnLabel, danger, onClick) {
      var btn = el('button', { class: 'vault-btn' + (danger ? ' danger' : ''), style: 'width:auto;margin:0;flex-shrink:0', onclick: onClick }, [btnLabel]);
      return el('div', { class: 'vault-ie-row' }, [
        el('div', { style: 'flex:1;min-width:0' }, [el('div', { class: 'vault-ie-title' }, [title]), el('div', { class: 'vault-ie-desc' }, [desc])]),
        btn,
      ]);
    }

    var box = el('div', { class: 'vault-modal', onclick: function (e) { e.stopPropagation(); } }, [
      el('div', { class: 'vault-modal-title' }, ['Import / Export & Backup']),
      row('Import from CSV', 'Chrome, Edge, Firefox, or Bitwarden password export.', 'Import CSV', false, function () { csvInput.click(); }),
      row('Encrypted backup', 'Download an encrypted, zero-knowledge backup file. Safe to store anywhere — needs your master password to open.', 'Export backup', false, exportBackup),
      row('Restore backup', 'Load a previously exported encrypted backup file.', 'Restore', false, function () { backupInput.click(); }),
      row('Plain CSV export', 'UNENCRYPTED — anyone who opens the file can read every password. Use only for migrating, then delete it.', 'Export CSV', true, exportCSVUnencrypted),
      status,
      el('div', { class: 'vault-modal-actions' }, [el('button', { class: 'vault-btn', onclick: function () { overlay.remove(); } }, ['Close'])]),
    ]);
    box.appendChild(csvInput); box.appendChild(backupInput);
    overlay.appendChild(box); document.body.appendChild(overlay);

    async function exportBackup() {
      try {
        var data = { format: 'vault-encrypted-backup', version: 1, exportedAt: Date.now(), config: session.getConfig(), items: await backend.listItems() };
        download('vault-backup-' + dateStamp() + '.json', JSON.stringify(data), 'application/json');
        status.style.color = 'var(--txd)'; status.textContent = 'Encrypted backup downloaded.';
      } catch (e) { status.style.color = '#e07070'; status.textContent = 'Export failed: ' + e.message; }
    }
    async function exportCSVUnencrypted() {
      if (!(await confirmUI('This exports every login as PLAIN TEXT — passwords readable by anyone with the file. Continue?', { title: 'Unencrypted export', okLabel: 'Export anyway', danger: true }))) return;
      var logins = store.byKind('login');
      var rows = [['name', 'url', 'username', 'email', 'password', 'notes']];
      logins.forEach(function (it) { rows.push([it.title || '', it.url || '', it.username || '', it.email || '', it.password || '', it.notes || '']); });
      download('vault-passwords-UNENCRYPTED-' + dateStamp() + '.csv', toCSV(rows), 'text/csv');
      status.style.color = '#e0a060'; status.textContent = 'Exported ' + logins.length + ' logins as PLAIN TEXT — delete the file when done.';
    }
  }

  // ── small SVG/icon helpers ─────────────────────────────────────────────────
  function favicon(url) { var i = el('img', { class: 'vault-favicon', src: faviconUrl(url), loading: 'lazy', alt: '' }); i.addEventListener('error', function () { i.style.visibility = 'hidden'; }); return i; }
  function iconBtn(title, svg, fn) { return el('button', { class: 'vault-icon', title: title, html: svg, onclick: fn }); }
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

  // ── styles ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    if ($('vault-ui-styles')) return;
    var css = [
      // The page body is the scroller (so the wheel works anywhere). We do NOT
      // make #kc-root a scroll container — its overflow-x:clip does not capture
      // sticky, so the tabs/toolbar below pin to the viewport as the body scrolls.
      // Wide, grabbable page scrollbar (scoped to when Vault is active via body class).
      'body.vault-active::-webkit-scrollbar{width:15px}',
      'body.vault-active::-webkit-scrollbar-track{background:var(--s1,#141418)}',
      'body.vault-active::-webkit-scrollbar-thumb{background:#3a3a48;border-radius:8px;border:3px solid #0f0f12;min-height:48px}',
      'body.vault-active::-webkit-scrollbar-thumb:hover,body.vault-active::-webkit-scrollbar-thumb:active{background:#E0607A}',
      // Tabs pinned to the top of the viewport while the list scrolls beneath.
      '.vault-tabs{display:flex;gap:8px;padding:12px clamp(10px,3vw,24px) 10px;max-width:1100px;margin:0 auto;width:100%;position:sticky;top:0;z-index:6;background:var(--bg)}',
      '.vault-tab{flex:0 0 auto;background:var(--s1);border:1px solid var(--bd);color:var(--txd);font-size:13px;font-weight:600;padding:9px 16px;border-radius:10px;cursor:pointer;transition:all .15s}',
      '.vault-tab:hover{color:var(--tx)}.vault-tab.active{background:var(--s3);color:var(--tx);border-color:var(--bdl)}',
      '.vault-panel{max-width:1100px;margin:0 auto;padding:0 clamp(10px,3vw,24px) 28px;width:100%}',
      // Search + Add + Settings + Lock stay pinned just below the tabs.
      '.vault-toolbar{display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap;position:sticky;top:var(--vtabs-h,54px);z-index:5;background:var(--bg);padding:8px 0 10px}',
      '.vault-toolbar .vault-icon{width:38px;height:38px}',
      '.vault-search-wrap{position:relative;flex:1;display:flex}',
      '.vault-search{flex:1;background:var(--s1);border:1px solid var(--bd);color:var(--tx);border-radius:10px;padding:10px 38px 10px 14px;font-size:14px;outline:none;width:100%}',
      '.vault-search:focus{border-color:var(--ac)}',
      '.vault-search-clear{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:26px;height:26px;border:none;background:var(--s3);color:var(--txd);border-radius:50%;font-size:17px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}.vault-search-clear:hover{color:var(--tx);background:var(--bdl)}',
      '.vault-list{display:flex;flex-direction:column;gap:8px}',
      '.vault-site{background:var(--s1);border:1px solid var(--bd);border-radius:12px;overflow:hidden}',
      '.vault-row{display:flex;align-items:center;gap:12px;padding:12px 14px}',
      '.vault-favicon{width:26px;height:26px;border-radius:6px;object-fit:contain;background:var(--s3);flex-shrink:0}',
      '.vault-lock-icon{font-size:22px}',
      '.vault-note-icon{width:26px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--ac)}',
      '.vault-row-main{flex:1;min-width:0}.vault-row-title{font-size:14px;font-weight:700;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.vault-row-sub{font-size:12px;color:var(--txd);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}',
      '.vault-tag{background:var(--s3);color:var(--txd);font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px;flex-shrink:0}',
      '.vault-accounts{border-top:1px solid var(--bd)}',
      '.vault-account{display:flex;align-items:center;gap:12px;padding:11px 14px;border-top:1px solid var(--bd)}.vault-account:first-child{border-top:none}',
      '.vault-account.indented{padding-left:22px;background:var(--bg)}',
      '.vault-acc-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:7px}',
      '.vault-acc-line{display:flex;align-items:center;gap:8px}',
      '.vault-acc-field{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}',
      '.vault-acc-flabel{font-size:9.5px;font-weight:700;color:var(--txm);text-transform:uppercase;letter-spacing:.5px}',
      '.vault-acc-val{font-size:13px;color:var(--tx);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vault-acc-val.muted{color:var(--txm);font-weight:400}',
      '.vault-acc-pw{font-size:13px;color:var(--txd);font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vault-pw-dots{letter-spacing:2px}',
      '.vault-acc-actions{display:flex;flex-direction:row;flex-wrap:wrap;gap:4px;flex-shrink:0;justify-content:flex-end;max-width:50%}',
      '.vault-note-body{padding:0 14px 14px 40px}',
      '.vault-note-text{color:var(--tx);font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:12px}',
      '.vault-note-actions{display:flex;justify-content:flex-end;margin-top:8px}',
      '.vault-icon{background:var(--s3);border:1px solid var(--bd);color:var(--txd);width:30px;height:30px;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:all .15s;padding:0}',
      '.vault-icon:hover{color:var(--tx);border-color:var(--ac)}',
      '.vault-empty{border:1px dashed var(--bd);border-radius:12px;padding:34px 20px;text-align:center;color:var(--txd);font-size:13px;line-height:1.7}',
      '.vault-footer{display:flex;justify-content:space-between;margin-top:18px;padding-top:12px;border-top:1px solid var(--bd)}',
      '.vault-link-btn{background:none;border:none;color:var(--txd);font-size:12px;font-weight:600;cursor:pointer;padding:4px 8px}.vault-link-btn:hover{color:var(--ac)}',
      // lock/setup
      '.vault-lock{display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;min-height:300px}',
      '.vault-card{background:var(--s1);border:1px solid var(--bd);border-radius:16px;padding:30px 26px;max-width:400px;width:100%;text-align:center}',
      '.vault-lock-icon{font-size:38px;margin-bottom:6px}',
      '.vault-h2{font-size:19px;font-weight:800;color:var(--tx);margin:6px 0}',
      '.vault-sub{font-size:12.5px;color:var(--txd);line-height:1.6;margin-bottom:18px}',
      '.vault-input{width:100%;background:var(--s2);border:1px solid var(--bd);color:var(--tx);border-radius:10px;padding:11px 13px;font-size:14px;outline:none;margin-bottom:10px;font-family:inherit}',
      '.vault-input:focus{border-color:var(--ac)}textarea.vault-input{resize:vertical;min-height:52px}',
      '.vault-btn{width:100%;background:var(--s3);border:1px solid var(--bd);color:var(--tx);border-radius:10px;padding:11px;font-size:14px;font-weight:700;cursor:pointer;margin-bottom:8px;transition:all .15s}',
      '.vault-btn:hover{border-color:var(--bdl)}.vault-btn.primary{background:var(--ac);color:#1a0008;border-color:var(--ac)}.vault-btn.primary:hover{filter:brightness(1.08)}',
      '.vault-btn.primary:disabled{opacity:.5;cursor:not-allowed}.vault-btn.sm{width:auto;padding:10px 16px;margin:0}.vault-btn.danger{background:transparent;color:#e07070;border-color:#e0707044}',
      '.vault-err{color:#e07070;font-size:12px;min-height:16px;margin-bottom:6px;text-align:left}',
      '.vault-fine{font-size:10px;color:var(--txm);margin-top:8px;letter-spacing:.3px}',
      '.vault-meter{height:5px;background:var(--s3);border-radius:3px;overflow:hidden;margin-bottom:10px}.vault-meter-fill{height:100%;width:0;background:#e05252;transition:width .2s,background .2s}',
      '.vault-recovery-code{font-family:ui-monospace,monospace;font-size:16px;font-weight:700;color:var(--ac);background:var(--s2);border:1px dashed var(--bdl);border-radius:10px;padding:16px;letter-spacing:1px;word-break:break-all;margin-bottom:12px;line-height:1.7}',
      '.vault-ack{display:flex;align-items:center;gap:9px;font-size:12px;color:var(--txd);margin:12px 0;text-align:left;cursor:pointer}',
      // modal
      '.vault-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:99998;padding:16px}',
      '.vault-modal{background:var(--s1);border:1px solid var(--bd);border-radius:16px;padding:22px;width:440px;max-width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 24px 70px rgba(0,0,0,.6)}',
      '.vault-modal-title{font-size:16px;font-weight:800;color:var(--tx);margin-bottom:16px}',
      '.vault-field{margin-bottom:12px}.vault-flabel{display:block;font-size:11px;font-weight:700;color:var(--txd);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px}',
      '.vault-field .vault-input{margin-bottom:0}select.vault-input{cursor:pointer}',
      '.vault-pw-input{display:flex;gap:6px}.vault-pw-input .vault-input{flex:1}',
      '.vault-modal-actions{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}.vault-modal-actions .vault-btn{width:auto;flex:1;margin:0}',
      '.vault-setting-row{display:block;width:100%;text-align:left;background:var(--s2);border:1px solid var(--bd);color:var(--tx);border-radius:10px;padding:13px 15px;font-size:13.5px;font-weight:600;cursor:pointer;margin-bottom:8px}.vault-setting-row:hover{border-color:var(--ac)}',
      '.vault-ie-row{display:flex;align-items:center;gap:12px;background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:12px 14px;margin-bottom:8px}',
      '.vault-ie-title{font-size:13px;font-weight:700;color:var(--tx)}.vault-ie-desc{font-size:11px;color:var(--txd);line-height:1.5;margin-top:2px}',
      // health dashboard
      '.vault-health-top{display:flex;align-items:center;gap:16px;margin-bottom:18px}',
      '.vault-health-score{position:relative;width:92px;height:92px;flex-shrink:0}',
      '.vault-health-num{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800}',
      '.vault-health-label{font-size:16px;font-weight:800;color:var(--tx)}.vault-health-sub{font-size:12px;color:var(--txd);margin-top:2px}',
      '.vault-health-cat{display:flex;align-items:center;gap:10px;background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:11px 13px;margin-bottom:6px;cursor:pointer}',
      '.vault-health-cat:hover{border-color:var(--bdl)}',
      '.vault-health-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}',
      '.vault-health-bad .vault-health-dot{background:#e05252}.vault-health-warn .vault-health-dot{background:#e0a052}',
      '.vault-health-cat-title{font-size:13px;font-weight:700;color:var(--tx)}.vault-health-cat-desc{font-size:11px;color:var(--txd);margin-top:2px;line-height:1.5}',
      '.vault-health-chev{color:var(--txd);font-size:12px}',
      '.vault-health-items{margin:0 0 8px}',
      '.vault-health-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;cursor:pointer}.vault-health-item:hover{background:var(--s2)}',
      '.vault-mini-edit{color:var(--txd);display:flex}',
      // generator
      '.vault-gen-out{font-family:ui-monospace,monospace;font-size:16px;color:var(--ac);background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:16px;word-break:break-all;text-align:center;margin-bottom:14px;min-height:24px}',
      '.vault-gen-tabs,.vault-gen-len{display:flex;gap:8px;margin-bottom:12px}.vault-gen-len{align-items:center;justify-content:space-between;font-size:12px;color:var(--txd)}',
      '.vault-gen-tab{flex:1;background:var(--s2);border:1px solid var(--bd);color:var(--txd);border-radius:8px;padding:8px;font-size:12px;font-weight:700;cursor:pointer}.vault-gen-tab.active{background:var(--s3);color:var(--tx);border-color:var(--ac)}',
      '.vault-gen-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.vault-gen-opt{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--txd);cursor:pointer}',
      '.vault-range{width:100%;accent-color:var(--ac)}.vault-gen-len .vault-range{flex:1;margin-left:12px}',
      '.vault-toast.show{opacity:1!important}',
      // ── mobile ──
      '@media (max-width:640px){',
      '  .vault-panel{padding:12px 12px 28px}',
      '  .vault-tabs{padding:10px 12px 0;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}',
      '  .vault-tabs::-webkit-scrollbar{display:none}',
      '  .vault-tab{font-size:12px;padding:8px 13px;white-space:nowrap}',
      '  .vault-row{gap:10px;padding:12px}',
      '  .vault-account{flex-wrap:wrap;gap:8px}',
      '  .vault-acc-actions{flex-direction:row;width:100%;justify-content:flex-end}',
      '  .vault-modal{width:100%;border-radius:14px;padding:18px 16px;max-height:92vh}',
      '  .vault-modal-actions{gap:8px}',
      '  .vault-card{padding:24px 18px}',
      '  .vault-icon{width:34px;height:34px}',        // bigger touch targets
      '  .vault-search{font-size:16px}',              // 16px stops iOS input zoom
      '  .vault-input{font-size:16px}',
      '  .vault-note-body{padding-left:22px}',
      '}',
    ].join('');
    document.head.appendChild(el('style', { id: 'vault-ui-styles', html: css }));
  }

  // ── activation: watch for the Keychain/Vault view becoming visible ─────────
  function isVaultVisible() { var r = $('kc-root'); return r && r.style.display !== 'none' && r.offsetParent !== null; }
  function tick() {
    var vis = isVaultVisible();
    document.body.classList.toggle('vault-active', !!vis); // scopes the wide page scrollbar to Vault
    if (vis && !$('vault-tabs')) activate();
  }
  function boot() {
    if (!window.VaultCrypto || !window.VaultStore || !window.VaultSession) { return setTimeout(boot, 200); }
    VC = window.VaultCrypto; VaultStore = window.VaultStore; VaultSession = window.VaultSession;
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

  window.Vault = { activate: activate, session: function () { return session; }, genPassword: genPassword, genPassphrase: genPassphrase, strength: strength, analyzeHealth: analyzeHealth, parseCSV: parseCSV, toCSV: toCSV, importFromCSV: importFromCSV, _setStore: function (s) { store = s; } };
})();
