// ─────────────────────────────────────────────────────────────────────────────
// warden-bio-sync.js — runs ONLY on her Pages origin (see manifest.json).
// The origin comes from warden-config.js so the check and the manifest match.
//
// Lets the Warden extension unlock with the SAME biometric (Windows Hello / Touch
// ID / Face ID / fingerprint) that was registered for the password warden in
// Index, instead of enrolling a separate credential inside the extension.
//
// WebAuthn credentials are scoped to their relying-party ID (this site's
// hostname). A browser extension can assert that same RP ID from its own
// chrome-extension:// origin ONLY if it declares host_permissions for the site
// (Chrome 122+) — see manifest.json. It still cannot read this page's
// localStorage directly, so this content script relays the three small,
// non-secret-until-combined pieces the extension needs to complete the SAME
// biometric gate Index uses:
//   • warden.warden.deviceId   — this device's id
//   • warden.warden.deviceKey  — the device key that wraps the warden's DEK,
//                              released only after a live WebAuthn assertion
//   • bio_cred_warden_<id>    — the WebAuthn credential id + label
//
// None of this weakens the model: the extension still cannot unwrap the warden
// without a fresh, successful biometric assertion against this exact credential
// (see warden-pw-core.js unlockWithBiometric). It's the same trust boundary,
// just readable from a second place the user already controls (their own
// browser, same device).
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  // Her Pages origin, from warden-config.js. Empty would make the origin
  // checks below reject everything, which is the safe direction to fail.
  var _ORIGIN = String((self.WARDEN_CFG || {}).APP_ORIGIN || '');
  var DEVICE_ID_KEY = 'warden.warden.deviceId';
  var DEVICE_KEY_KEY = 'warden.warden.deviceKey';
  var BIO_APP = 'warden';

  function read() {
    var deviceId = null, deviceKeyB64 = null, credId = null, label = null;
    try { deviceId = localStorage.getItem(DEVICE_ID_KEY) || null; } catch (e) {}
    try { deviceKeyB64 = localStorage.getItem(DEVICE_KEY_KEY) || null; } catch (e) {}
    if (deviceId) {
      try {
        var rec = JSON.parse(localStorage.getItem('bio_cred_' + BIO_APP + '_' + deviceId) || 'null');
        if (rec && rec.id) { credId = rec.id; label = rec.label || null; }
      } catch (e) {}
    }
    return { deviceId: deviceId, deviceKeyB64: deviceKeyB64, credId: credId, label: label };
  }

  var last = null;
  function sync() {
    var cur = read();
    var complete = !!(cur.deviceId && cur.deviceKeyB64 && cur.credId);
    var payload = complete ? cur : null;
    var key = JSON.stringify(payload);
    if (key === last) return;
    last = key;
    try { chrome.runtime.sendMessage({ action: 'wardenBioSync', link: payload }, function () { void chrome.runtime.lastError; }); } catch (e) {}
  }

  sync();
  // Catch changes made while this tab stays open (e.g. enabling biometrics in
  // Settings without a reload). Cheap: three localStorage reads.
  var poll = setInterval(sync, 3000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) sync(); });
  window.addEventListener('storage', sync);
  window.addEventListener('pagehide', function () { clearInterval(poll); });

  // (The Trading Auto Launch tab-grouping relay that used to sit here was removed
  // along with the "Trading Analysis" tab group itself.)

  // ── TradeHub "Launch Analysis" relay ──
  // The page can open the AI tab itself, but it can never TYPE into it — a
  // cross-origin site is off-limits to page JS. So it hands us the prompt and
  // the tab list; the background opens them and parks the prompt against the AI
  // tab, where warden-ai-prompt.js pastes and sends it.
  //
  // The capability ping matters: TradeHub has to know whether we can do this
  // BEFORE the button is clicked, because its fallback (window.open) is only
  // allowed inside the click's own user gesture.
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    if (e.origin && e.origin.indexOf(_ORIGIN) !== 0) return;
    var d = e.data;
    if (!d || d.source !== 'tradehub-warden') return;

    if (d.action === 'aiLaunchPing') {
      try {
        chrome.runtime.sendMessage({ action: 'aiLaunchCapability' }, function (resp) {
          var ok = !chrome.runtime.lastError && resp && resp.ok;   // older builds answer nothing → ok:false
          window.postMessage({ source: 'warden-extension', action: 'aiLaunchPong', ok: !!ok }, e.origin || '*');
        });
      } catch (err) {}
      return;
    }

    if (d.action === 'launchAnalysis') {
      try {
        chrome.runtime.sendMessage(
          {
            action: 'launchAnalysis',
            aiUrl: d.aiUrl || '',
            text: d.text || '',
            searches: Array.isArray(d.searches) ? d.searches.filter(Boolean) : [],
          },
          function () { void chrome.runtime.lastError; }
        );
        // Ack immediately so the page never also opens its own fallback tabs.
        window.postMessage({ source: 'warden-extension', action: 'launchAnalysisAck' }, e.origin || '*');
      } catch (err) {}
    }
  });

  // ── Keychain "Open all" relay ──
  // The Warden web app's connection cards launch their links as one named,
  // coloured tab group — identical to what the popup does — by handing the
  // request to the background service worker through this same bridge. The page
  // waits for our ack; if the extension isn't installed nothing answers and the
  // page falls back to opening plain tabs on its own.
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    if (e.origin && e.origin.indexOf(_ORIGIN) !== 0) return;
    var d = e.data;
    if (!d || d.source !== 'warden-page' || d.action !== 'openLinkGroup') return;
    var urls = Array.isArray(d.urls) ? d.urls.filter(Boolean) : [];
    if (!urls.length) return;
    try {
      chrome.runtime.sendMessage(
        {
          action: 'openLinks',
          urls: urls,
          group: urls.length > 1,
          groupName: d.name || 'Links',
          groupColor: d.color || '',
        },
        function () { void chrome.runtime.lastError; }
      );
      // Ack immediately — the request is in flight, so the page must not also
      // open its fallback tabs and double every link.
      window.postMessage({ source: 'warden-extension', action: 'openLinkGroupAck' }, e.origin || '*');
    } catch (err) {}
  });
})();
