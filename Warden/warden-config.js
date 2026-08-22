// ═════════════════════════════════════════════════════════════════════════════
// warden-config.js — the ONE place the Warden Launcher's own values live.
//
// The PWA has an equivalent block at the top of warden.html. This is the
// extension's half. Everything that is Veda's rather than Tony's is here and
// nowhere else, so a value can never be half-changed across the popup, the
// background worker and the content scripts.
//
// Loaded FIRST everywhere: first <script> in popup.html, first content script in
// manifest.json, and importScripts()'d at the top of background.js. It defines a
// plain global on `self`, which is the one object those three contexts share.
//
// ── Why a shipped key is not a contradiction ─────────────────────────────────
// WORKER_KEY is compiled into a distributable extension, so it is not a secret
// in the usual sense — anyone with the .zip has it. It is a gate in front of a
// proxy to CIPHERTEXT, not a lock on plaintext:
//   • warden-pw-sync only ever serves the AES-GCM vault document. Without the
//     master password it is noise.
//   • warden-files only ever serves file ciphertext under random keys, and is
//     open by design (no key at all).
// What the key actually buys is that a stranger cannot cheaply enumerate or
// overwrite her documents. Treat it as rotatable, not as a secret.
//
// This value is FRESHLY GENERATED for Warden and is deliberately NOT the key
// Tony's Vault Launcher ships. Never paste his here — that would put her vault
// behind the same gate as his.
// ═════════════════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  global.WARDEN_CFG = {

    // ── 1. Her Cloudflare Workers ────────────────────────────────────────────
    // A chrome-extension:// page cannot satisfy Firebase App Check, which is the
    // whole reason these proxies exist: the extension never talks to Firestore
    // directly. The workers authenticate with a Firebase service account, which
    // bypasses App Check and rules, and gate access behind WORKER_KEY.
    //
    // Deploy all three from Warden/workers/ (see SETUP.md), then paste the URLs
    // Wrangler prints. Keep the path suffixes exactly as shown.
    LINKS_URL: '__WARDEN_LINKS_WORKER__',   // e.g. https://warden-links.<sub>.workers.dev/links
    VAULT_URL: '__WARDEN_VAULT_WORKER__',   // e.g. https://warden-pw-sync.<sub>.workers.dev/warden
    FILES_URL: '__WARDEN_FILES_WORKER__',   // e.g. https://warden-files.<sub>.workers.dev

    // Bucket the files worker stores attachments under. Must match the BUCKETS
    // map in Warden/workers/warden-files/worker.js.
    FILES_BUCKET: 'warden',

    // ── 2. Shared header key ─────────────────────────────────────────────────
    // Sent as X-Warden-Key. Set the SAME value as the WARDEN_KEY secret on both
    // warden-links and warden-pw-sync (SETUP.md step 6). To rotate: change it
    // here, re-run the two `wrangler secret put` commands, reload the extension.
    WORKER_KEY: 'wd-xn50F95KAByggSLQ5-aNcYZb1-zGsv',

    // ── 3. Her GitHub Pages origin ───────────────────────────────────────────
    // Used for: the "open Warden" button, the WebAuthn RP id that biometric
    // credentials are bound to, and the origin check in warden-bio-sync.js.
    //
    // ⚠ APP_ORIGIN must match manifest.json's host_permissions and both
    // content_scripts origin lists. manifest.json cannot read this file, so
    // those are the one place a value is repeated — change them together.
    //
    // ⚠ BIO_RP_ID is the WebAuthn Relying Party id. Changing it AFTER she has
    // enrolled a biometric silently invalidates every enrolled credential:
    // the authenticator will simply not offer them, with no error that says why.
    // Set it once, before she enables biometrics.
    APP_ORIGIN: '__WARDEN_PAGES_ORIGIN__',        // e.g. https://vedaapatel.github.io
    APP_URL:    '__WARDEN_APP_URL__',             // e.g. https://vedaapatel.github.io/A1/warden.html
    BIO_RP_ID:  '__WARDEN_PAGES_HOST__',          // e.g. vedaapatel.github.io  (host only, no scheme)

    // ── 4. Optional / off by default ─────────────────────────────────────────
    // Cloud tab AI search. The Cloud tab ships present but unconfigured; leaving
    // this empty simply disables the AI search box inside it.
    AI_ENDPOINT: '',

    // TradeHub AI-prompt bridge. This is a feature of Tony's trading setup that
    // rides in the same extension; it is inert for Warden and left empty on
    // purpose. Its host permission has been removed from the manifest.
    TD_WORKER_URL: ''
  };

  // Resolved once so callers do not have to reassemble it. Ends with a slash.
  global.WARDEN_CFG.FILES_BASE =
    (global.WARDEN_CFG.FILES_URL || '').replace(/\/+$/, '') +
    '/' + global.WARDEN_CFG.FILES_BUCKET + '/f/';

  // True when every value the extension cannot work without has been filled in.
  // Callers use this to show "not set up yet" instead of a confusing network
  // error against a literal "__WARDEN_LINKS_WORKER__" URL.
  global.WARDEN_CFG.isConfigured = function (which) {
    var c = global.WARDEN_CFG;
    var need = which === 'links' ? [c.LINKS_URL]
             : which === 'vault' ? [c.VAULT_URL]
             : which === 'files' ? [c.FILES_URL]
             : [c.LINKS_URL, c.VAULT_URL, c.FILES_URL];
    return need.every(function (v) { return v && !/^__[A-Z0-9_]+__$/.test(v); });
  };

})(typeof self !== 'undefined' ? self : this);
