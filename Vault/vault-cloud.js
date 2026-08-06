/* ============================================================================
 * vault-cloud.js — Vault's Cloud engine
 *
 * The non-visual half of Vault's Cloud tab: a provider registry, the two
 * concrete providers (Google Drive, Dropbox), the Firebase-synced settings
 * store, an upload queue, an offline metadata cache and the AI search client.
 * Everything that paints lives in vault-cloud-ui.js.
 *
 * ── Provider architecture ───────────────────────────────────────────────────
 * Nothing outside this file may branch on which cloud it is talking to. Each
 * provider is an object satisfying the SAME interface (see PROVIDER_CONTRACT
 * below); the UI only ever holds a provider id and calls VaultCloud.op(...).
 * Adding OneDrive or S3 later means writing one more adapter and calling
 * VaultCloud.register() — no UI change, no new branches anywhere.
 *
 * ── Where credentials live, and why they are split ──────────────────────────
 * OAuth *client ids* (Google) and *app keys* (Dropbox) are public identifiers —
 * they ship in every browser app and are safe in Firestore, so they sync and you
 * only ever paste them once. Access/refresh *tokens* are bearer credentials for
 * your actual files: those stay in localStorage on the device that authorized
 * them and are never written to Firestore. A synced token would hand every
 * signed-in device — and anything that could read the doc — live access to the
 * whole Drive. So each device connects once; the connection itself doesn't sync.
 *
 * Both flows are public-client flows with no client secret: Dropbox uses PKCE
 * (S256), Google uses the Identity Services token client. Neither needs a
 * backend, which is what keeps Vault a static page.
 * ========================================================================== */
(function () {
  'use strict';

  // ── PROVIDER_CONTRACT ─────────────────────────────────────────────────────
  // Every adapter implements these. Optional capabilities are declared in
  // `caps` instead of being probed, so the UI can grey out (rather than offer
  // and then fail) whatever a given cloud can't do.
  //
  //   id, label, accent, icon
  //   caps: { share, move, quota, preview, folders }
  //   configured()                  → bool   — has a client id / app key
  //   connected()                   → bool   — holds a live token
  //   connect()                     → Promise<void>
  //   disconnect()                  → void
  //   list(folderId)                → Promise<Entry[]>
  //   search(query)                 → Promise<Entry[]>
  //   upload(file, parentId, opts)  → Promise<Entry>     opts:{onProgress,signal}
  //   downloadUrl(entry)            → Promise<string>
  //   rename(id, name)              → Promise<void>
  //   remove(id)                    → Promise<void>
  //   move(id, toParentId, fromId)  → Promise<void>
  //   mkdir(name, parentId)         → Promise<Entry>
  //   shareLink(id)                 → Promise<string>
  //   quota()                       → Promise<{used,total}>
  //
  // Entry — the one shape the UI understands, whatever cloud produced it:
  //   { id, name, folder:bool, size:int, modified:ms, mime, parent, provider,
  //     webUrl, thumb }
  var PROVIDER_CONTRACT = ['configured','connected','connect','disconnect','list',
    'search','upload','downloadUrl','rename','remove','move','mkdir','shareLink','quota'];

  var providers = Object.create(null);
  var order = [];

  // ── Settings (Firebase-synced) ────────────────────────────────────────────
  // One object, mirrored to dashboards/vault_cloud. Written through save(),
  // which debounces via _fbSaveCloud and drives the sync indicator.
  var DEFAULTS = {
    hdrOrder: null,          // header action button order — null = file order
    tabOrder: null,          // Vault tab bar order — null = file order
    view: 'list',            // list | grid | compact
    sortKey: 'name',         // name | modified | created | size | type
    sortDir: 'asc',
    providerCfg: {},         // { gdrive:{clientId,openUrl}, dropbox:{appKey,openUrl} }
    favorites: [],           // [{provider,id,name,folder}]
    recents: [],             // [{provider,id,name,at,how}]
    activity: [],            // [{at,action,provider,name}]
    tags: {},                // { "provider:id": [tag,…] }  — from AI auto-tagging
  };
  var S = JSON.parse(JSON.stringify(DEFAULTS));
  var loaded = false;
  var listeners = [];

  function emit() { listeners.forEach(function (f) { try { f(S); } catch (e) {} }); }
  function onChange(f) { listeners.push(f); return function () { listeners = listeners.filter(function (g) { return g !== f; }); }; }

  // Local mirror so the Cloud tab paints instantly on load and still works with
  // no network — Firestore's own cache covers the signed-in case, this covers
  // the cold one.
  var LS_KEY = 'vault_cloud_settings';
  function cacheLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {} }
  function readLocal() {
    try { var r = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (r) S = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), r); } catch (e) {}
  }

  function save() {
    cacheLocal();
    emit();
    if (window._fbSaveCloud) window._fbSaveCloud(function () { return S; });
  }

  // Merge rather than replace: a remote doc written by an older build (or a
  // device that hasn't learned a new key yet) must not delete fields it simply
  // doesn't know about.
  function applyRemote(d) {
    if (!d || typeof d !== 'object') return;
    Object.keys(DEFAULTS).forEach(function (k) { if (d[k] !== undefined && d[k] !== null) S[k] = d[k]; });
    cacheLocal(); emit();
  }

  // Read the local mirror at load time, NOT on first render. The header-reorder
  // module writes settings the moment you drop a button, which can easily happen
  // before the Cloud tab has ever been opened — and save() serialises the whole
  // object, so a save against un-hydrated DEFAULTS silently replaced the real
  // providerCfg/favorites in localStorage. Hydrating synchronously here means
  // settings() is never a blank default while real state exists on disk.
  readLocal();

  async function load() {
    if (!window._fbLoadCloud) { loaded = true; emit(); return; }
    var d = await window._fbLoadCloud();
    if (d) { applyRemote(d); loaded = true; }
  }
  window.addEventListener('fb-cloud-remote-update', function (e) { applyRemote(e.detail); });

  // ── Token store — device-local, never synced (see header note) ────────────
  var TOK_PREFIX = 'vault_cloud_tok_';
  var Tokens = {
    // The stored record, expired or not. `connected` means "this device has been
    // authorised", NOT "the current access token is still valid" — an expired
    // token is renewable (Google silently, Dropbox by refresh token), so
    // dropping the record on expiry is what made Drive appear to disconnect
    // after an hour and demand a fresh consent click.
    get: function (pid) {
      try { return JSON.parse(localStorage.getItem(TOK_PREFIX + pid) || 'null'); } catch (e) { return null; }
    },
    fresh: function (pid) {
      var t = Tokens.get(pid);
      return !!(t && t.access && (!t.expires || Date.now() < t.expires - 120000));
    },
    set: function (pid, t) { try { localStorage.setItem(TOK_PREFIX + pid, JSON.stringify(t)); } catch (e) {} },
    clear: function (pid) { try { localStorage.removeItem(TOK_PREFIX + pid); } catch (e) {} }
  };

  // Proactive renewal. Each provider registers a renewer; we re-mint a couple of
  // minutes before expiry so a long-lived tab never hits a 401 mid-action, and
  // re-check on wake because timers don't fire while a laptop is asleep.
  var renewers = Object.create(null);
  function registerRenewer(pid, fn) { renewers[pid] = fn; }
  async function keepAlive() {
    for (var pid in renewers) {
      if (!Tokens.get(pid)) continue;          // never connected here — nothing to keep alive
      if (Tokens.fresh(pid)) continue;
      try { await renewers[pid](); } catch (e) { console.warn('[VaultCloud] silent renew failed for', pid, e); }
    }
  }
  setInterval(keepAlive, 4 * 60 * 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) keepAlive(); });
  window.addEventListener('online', keepAlive);

  // ── Activity log ──────────────────────────────────────────────────────────
  // Capped hard: this rides inside the 1 MiB Firestore doc alongside favorites
  // and tags, and an uncapped log is the one field here that grows forever.
  var ACTIVITY_MAX = 250;
  function logActivity(action, provider, name) {
    S.activity.unshift({ at: Date.now(), action: action, provider: provider, name: String(name || '').slice(0, 120) });
    if (S.activity.length > ACTIVITY_MAX) S.activity.length = ACTIVITY_MAX;
    save();
  }

  var RECENTS_MAX = 60;
  function touchRecent(entry, how) {
    if (!entry || entry.folder) return;
    var key = entry.provider + ':' + entry.id;
    S.recents = S.recents.filter(function (r) { return r.provider + ':' + r.id !== key; });
    S.recents.unshift({ provider: entry.provider, id: entry.id, name: entry.name, at: Date.now(), how: how || 'opened' });
    if (S.recents.length > RECENTS_MAX) S.recents.length = RECENTS_MAX;
    save();
  }

  function favKey(p, id) { return p + ':' + id; }
  function isFav(p, id) { return S.favorites.some(function (f) { return favKey(f.provider, f.id) === favKey(p, id); }); }
  function toggleFav(entry) {
    if (isFav(entry.provider, entry.id)) {
      S.favorites = S.favorites.filter(function (f) { return favKey(f.provider, f.id) !== favKey(entry.provider, entry.id); });
    } else {
      S.favorites.push({ provider: entry.provider, id: entry.id, name: entry.name, folder: !!entry.folder });
    }
    save();
  }

  // ── OAuth helpers ─────────────────────────────────────────────────────────
  // The redirect target is this page itself. Both providers hand the result back
  // through a popup that posts to its opener, so the Vault tab never navigates
  // away and never loses unsaved state.
  function redirectUri() { return location.origin + location.pathname; }

  function b64url(buf) {
    var s = btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function pkcePair() {
    var bytes = new Uint8Array(48); crypto.getRandomValues(bytes);
    var verifier = b64url(bytes.buffer);
    var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier: verifier, challenge: b64url(digest) };
  }

  // Opens `url` in a popup and resolves with the callback's query/hash params.
  // Polling for `closed` is what turns a user-dismissed popup into a clean
  // rejection instead of a promise that never settles.
  function oauthPopup(url, expect) {
    return new Promise(function (resolve, reject) {
      var w = 520, h = 640;
      var x = window.screenX + (window.outerWidth - w) / 2;
      var y = window.screenY + (window.outerHeight - h) / 2;
      var pop = window.open(url, 'vault_oauth', 'width=' + w + ',height=' + h + ',left=' + x + ',top=' + y);
      if (!pop) { reject(new Error('Popup blocked — allow popups for this site and try again.')); return; }
      var done = false;
      var timer = setInterval(function () {
        // Same-origin reads throw while the popup sits on the provider's domain;
        // that's expected and simply means "not back yet".
        try {
          if (pop.closed) { if (!done) { clearInterval(timer); reject(new Error('Connection cancelled.')); } return; }
          var href = pop.location.href;
          if (!href || pop.location.origin !== location.origin) return;
          var p = new URLSearchParams(pop.location.search.slice(1));
          var hp = new URLSearchParams(pop.location.hash.slice(1));
          var out = {};
          p.forEach(function (v, k) { out[k] = v; });
          hp.forEach(function (v, k) { out[k] = v; });
          if (out.error) { done = true; clearInterval(timer); pop.close(); reject(new Error(out.error_description || out.error)); return; }
          if (out[expect]) { done = true; clearInterval(timer); pop.close(); resolve(out); }
        } catch (e) { /* cross-origin — still on the provider */ }
      }, 250);
    });
  }

  function fmtErr(e) { return (e && (e.message || e.error_description || e.error)) || 'Something went wrong'; }

  /* ══════════════════════════════════════════════════════════════════════════
   * Google Drive
   * ────────────────────────────────────────────────────────────────────────
   * Uses Google Identity Services' token client. Google does not allow the PKCE
   * code flow for browser clients without a secret, so GIS (implicit, ~1h
   * tokens) is the supported public-client path. Tokens are re-minted silently
   * on expiry where the session allows and fall back to a prompt otherwise.
   * ══════════════════════════════════════════════════════════════════════════ */
  var GIS_SRC = 'https://accounts.google.com/gsi/client';
  var gisPromise = null;
  function loadGis() {
    if (gisPromise) return gisPromise;
    gisPromise = new Promise(function (res, rej) {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) return res();
      var s = document.createElement('script');
      s.src = GIS_SRC; s.async = true; s.defer = true;
      s.onload = res;
      s.onerror = function () { rej(new Error('Could not load Google sign-in.')); };
      document.head.appendChild(s);
    });
    return gisPromise;
  }

  var DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
  // Two shapes, and mixing them up is a 400. Endpoints returning a single File
  // (upload, create) take a bare field list; endpoints returning a file LIST
  // take it wrapped in files(…). Google rejects `files(…)` on a single-resource
  // response rather than ignoring it.
  var DRIVE_FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,thumbnailLink,iconLink';
  var DRIVE_FIELDS = 'files(' + DRIVE_FILE_FIELDS + '),nextPageToken';
  var GDRIVE_FOLDER = 'application/vnd.google-apps.folder';

  function driveEntry(f) {
    return {
      id: f.id,
      name: f.name,
      folder: f.mimeType === GDRIVE_FOLDER,
      size: f.size ? parseInt(f.size, 10) : 0,
      modified: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
      created: f.createdTime ? Date.parse(f.createdTime) : 0,
      mime: f.mimeType || '',
      parent: (f.parents && f.parents[0]) || 'root',
      provider: 'gdrive',
      webUrl: f.webViewLink || '',
      thumb: f.thumbnailLink || ''
    };
  }

  var gdrive = {
    id: 'gdrive',
    label: 'Google Drive',
    accent: '#6aa2e0',
    rootId: 'root',
    // purge/emptyTrash are Drive-only — Dropbox reserves permanent deletion for
    // Business accounts, so the UI reads these rather than assuming.
    caps: { share: true, move: true, quota: true, preview: true, folders: true, trash: true, purge: true, emptyTrash: true },
    icon: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 3 6 10-3 5-6-10z"/><path d="m14 3 6 10H8"/><path d="M2 18h13l-3-5"/></svg>',
    // Setup copy lives with the provider so the settings screen stays generic —
    // it renders whatever each adapter declares and branches on nothing.
    setup: {
      field: 'clientId',
      label: 'OAuth client ID',
      placeholder: '…apps.googleusercontent.com',
      openPlaceholder: 'https://drive.google.com/drive/my-drive',
      hint: function (origin, redirect) {
        return 'Google Cloud Console → APIs &amp; Services → Credentials → OAuth client ID (Web application). ' +
          'Add <code>' + origin + '</code> as an authorized JavaScript origin, and enable the Drive API.';
      }
    },

    cfg: function () { return (S.providerCfg && S.providerCfg.gdrive) || {}; },
    configured: function () { return !!this.cfg().clientId; },
    connected: function () { return !!Tokens.get('gdrive'); },

    // Google's browser token client issues 1-hour access tokens and NO refresh
    // token, so staying connected means quietly re-minting. prompt:'' asks GIS
    // to reuse the existing Google session and grant without any UI; it only
    // falls back to a visible prompt when that genuinely can't work (signed out
    // of Google, or consent revoked). `interactive` is what separates a user
    // pressing Connect from the background keep-alive.
    _token: function (interactive) {
      var self = this;
      var clientId = this.cfg().clientId;
      if (!clientId) return Promise.reject(new Error('Add your Google OAuth client ID in Cloud settings first.'));
      return loadGis().then(function () {
        return new Promise(function (resolve, reject) {
          var settled = false;
          var client = window.google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: DRIVE_SCOPE,
            callback: function (resp) {
              if (settled) return; settled = true;
              if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
              Tokens.set('gdrive', { access: resp.access_token, expires: Date.now() + (resp.expires_in || 3600) * 1000 });
              resolve();
            },
            error_callback: function (err) {
              if (settled) return; settled = true;
              reject(new Error(fmtErr(err)));
            }
          });
          client.requestAccessToken({ prompt: interactive ? 'consent' : '' });
        });
      });
    },
    renew: function () { return this._token(false); },

    connect: async function () {
      var first = !Tokens.get('gdrive');
      // Try silent first even on an explicit Connect — if the Google session is
      // still good this completes with no popup at all.
      try { await this._token(false); }
      catch (e) { await this._token(true); }
      if (first) logActivity('Connected', 'gdrive', 'Google Drive');
    },
    disconnect: function () { Tokens.clear('gdrive'); logActivity('Disconnected', 'gdrive', 'Google Drive'); },

    // Every Drive call funnels through here so a 401 is retried once with a
    // fresh token instead of surfacing as a random failure an hour in.
    // Renew BEFORE the call when the token is stale, rather than waiting for a
    // 401. Saves a wasted round trip and, more importantly, means a mid-upload
    // expiry doesn't surface as a failure.
    ready: async function () {
      if (!Tokens.get('gdrive')) throw new Error('Google Drive is not connected.');
      if (!Tokens.fresh('gdrive')) await this.renew();
      return Tokens.get('gdrive');
    },

    api: async function (path, opts, _retried) {
      var t = await this.ready();
      opts = opts || {};
      var headers = Object.assign({ Authorization: 'Bearer ' + t.access }, opts.headers || {});
      var r = await fetch(path.indexOf('http') === 0 ? path : 'https://www.googleapis.com/drive/v3' + path,
        Object.assign({}, opts, { headers: headers }));
      if (r.status === 401 && !_retried) {
        await this.renew();               // keep the record; only the token was stale
        return this.api(path, opts, true);
      }
      if (!r.ok) {
        var msg = '';
        try { var j = await r.json(); msg = j.error && j.error.message; } catch (e) {}
        throw new Error(msg || ('Google Drive error ' + r.status));
      }
      return r.status === 204 ? null : r.json();
    },

    list: async function (folderId) {
      var q = "'" + (folderId || 'root').replace(/'/g, "\\'") + "' in parents and trashed=false";
      var out = [], token = null;
      do {
        var url = '/files?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent(DRIVE_FIELDS) +
          '&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true' + (token ? '&pageToken=' + token : '');
        var j = await this.api(url);
        (j.files || []).forEach(function (f) { out.push(driveEntry(f)); });
        token = j.nextPageToken;
      } while (token);
      return out;
    },

    search: async function (query) {
      var q = "name contains '" + String(query).replace(/'/g, "\\'") + "' and trashed=false";
      var j = await this.api('/files?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent(DRIVE_FIELDS) + '&pageSize=200');
      return (j.files || []).map(driveEntry);
    },

    // Resumable upload: the only Drive path that reports real progress and can
    // survive a dropped connection, which the queue's retry depends on.
    upload: async function (file, parentId, opts) {
      opts = opts || {};
      var t = await this.ready();
      var meta = { name: file.name, parents: [parentId || 'root'] };
      var init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=' + encodeURIComponent(DRIVE_FILE_FIELDS), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + t.access, 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(meta)
      });
      if (!init.ok) throw new Error('Google Drive upload could not start (' + init.status + ')');
      var session = init.headers.get('Location');
      if (!session) throw new Error('Google Drive did not return an upload session.');
      return await xhrPut(session, file, opts, function (txt) {
        try { return driveEntry(JSON.parse(txt)); } catch (e) { return null; }
      });
    },

    // Drive renders almost anything in its own viewer — Office files, RTF, EPUB,
    // CAD, archives, fonts. Falling back to this means "no preview" is reserved
    // for things no one can preview, instead of anything we can't decode inline.
    embedUrl: function (entry) {
      return entry.folder ? null : 'https://drive.google.com/file/d/' + entry.id + '/preview';
    },

    downloadUrl: async function (entry) {
      var t = await this.ready();
      // Google-native docs (Docs/Sheets/Slides) have no byte stream — export.
      if (/application\/vnd\.google-apps\./.test(entry.mime)) return entry.webUrl;
      var r = await fetch('https://www.googleapis.com/drive/v3/files/' + entry.id + '?alt=media',
        { headers: { Authorization: 'Bearer ' + t.access } });
      if (!r.ok) throw new Error('Download failed (' + r.status + ')');
      return URL.createObjectURL(await r.blob());
    },

    rename: function (id, name) { return this.api('/files/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) }); },

    // Soft delete. Drive's HTTP DELETE is PERMANENT and skips the trash entirely
    // — no undo, no recovery, not even from drive.google.com. Vault's confirm
    // dialog tells you the file is recoverable, so remove() must set trashed
    // instead. Permanent deletion is purge(), reachable only from the Trash pane
    // behind its own confirmation.
    remove: function (id) {
      return this.api('/files/' + id + '?supportsAllDrives=true', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true })
      });
    },
    listTrash: async function () {
      var out = [], token = null;
      do {
        var url = '/files?q=' + encodeURIComponent('trashed=true') + '&fields=' +
          encodeURIComponent('files(' + DRIVE_FILE_FIELDS + ',trashedTime),nextPageToken') +
          '&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true' + (token ? '&pageToken=' + token : '');
        var j = await this.api(url);
        (j.files || []).forEach(function (f) {
          var e = driveEntry(f);
          e.deletedAt = f.trashedTime ? Date.parse(f.trashedTime) : 0;
          out.push(e);
        });
        token = j.nextPageToken;
      } while (token);
      return out;
    },
    restore: function (id) {
      return this.api('/files/' + id + '?supportsAllDrives=true', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: false })
      });
    },
    purge: function (id) { return this.api('/files/' + id + '?supportsAllDrives=true', { method: 'DELETE' }); },
    emptyTrash: function () { return this.api('/files/trash', { method: 'DELETE' }); },
    move: function (id, toParent, fromParent) {
      return this.api('/files/' + id + '?addParents=' + encodeURIComponent(toParent) +
        '&removeParents=' + encodeURIComponent(fromParent || 'root') + '&supportsAllDrives=true', { method: 'PATCH' });
    },
    mkdir: async function (name, parentId) {
      var f = await this.api('/files?fields=' + encodeURIComponent(DRIVE_FILE_FIELDS), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, mimeType: GDRIVE_FOLDER, parents: [parentId || 'root'] })
      });
      return driveEntry(f);
    },
    shareLink: async function (id) {
      await this.api('/files/' + id + '/permissions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'anyone' })
      });
      var f = await this.api('/files/' + id + '?fields=webViewLink');
      return f.webViewLink;
    },
    quota: async function () {
      var j = await this.api('/about?fields=storageQuota');
      var q = j.storageQuota || {};
      return { used: parseInt(q.usage || 0, 10), total: parseInt(q.limit || 0, 10) };
    }
  };

  /* ══════════════════════════════════════════════════════════════════════════
   * Dropbox
   * ────────────────────────────────────────────────────────────────────────
   * Full PKCE (S256) with token_access_type=offline, so the refresh token keeps
   * the device connected without re-prompting. Dropbox paths are strings, not
   * ids — root is the empty string, which is why rootId differs from Drive's.
   * ══════════════════════════════════════════════════════════════════════════ */
  // Trash verification budget. Each check is one API call, so this trades scan
  // depth against time and Dropbox's rate limit; 6 at a time keeps well clear of
  // 429s. Anything beyond the cap is reported as "not scanned" rather than
  // silently dropped.
  var VERIFY_CAP = 300, VERIFY_CONC = 6;
  var dbxRevCache = Object.create(null);

  function dbxEntry(f) {
    var folder = f['.tag'] === 'folder';
    return {
      id: f.path_lower || f.path_display || '',
      name: f.name,
      folder: folder,
      size: f.size || 0,
      modified: f.server_modified ? Date.parse(f.server_modified) : 0,
      created: f.client_modified ? Date.parse(f.client_modified) : 0,
      mime: folder ? '' : guessMime(f.name),
      parent: (f.path_lower || '').replace(/\/[^/]*$/, ''),
      provider: 'dropbox',
      webUrl: '',
      thumb: ''
    };
  }

  var dropbox = {
    id: 'dropbox',
    label: 'Dropbox',
    accent: '#7aa6d6',
    rootId: '',
    // No purge: /files/permanently_delete is Business-only, so a personal account
    // gets an "insufficient permissions" error. Dropbox keeps deleted files for
    // 30 days (longer on paid plans) and empties itself.
    caps: { share: true, move: true, quota: true, preview: true, folders: true, trash: true, purge: false, emptyTrash: false },
    icon: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 2 6 4-6 4-6-4z"/><path d="m18 2 6 4-6 4-6-4z"/><path d="m6 10 6 4-6 4-6-4z"/><path d="m18 10 6 4-6 4-6-4z"/><path d="m9 19 3 2 3-2"/></svg>',
    setup: {
      field: 'appKey',
      label: 'App key',
      placeholder: 'Dropbox app key',
      openPlaceholder: 'https://www.dropbox.com/home',
      hint: function (origin, redirect) {
        // Every scope Vault actually calls: metadata.read (list/search),
        // content.read (download/preview), content.write (upload/rename/move/
        // delete/mkdir), sharing.read+write (share links), account_info.read
        // (the storage bar). Miss one and only that feature fails, with a
        // missing_scope error that names it.
        return 'Dropbox App Console → your app. On <b>Settings</b>, add <code>' + redirect + '</code> under OAuth 2 redirect URIs. ' +
          'On <b>Permissions</b>, tick <code>account_info.read</code>, <code>files.metadata.read</code>, <code>files.content.read</code>, ' +
          '<code>files.content.write</code>, <code>sharing.read</code>, <code>sharing.write</code> — then Submit.';
      }
    },

    cfg: function () { return (S.providerCfg && S.providerCfg.dropbox) || {}; },
    configured: function () { return !!this.cfg().appKey; },
    connected: function () { return !!Tokens.get('dropbox'); },

    connect: async function () {
      var appKey = this.cfg().appKey;
      if (!appKey) throw new Error('Add your Dropbox app key in Cloud settings first.');
      var pk = await pkcePair();
      var url = 'https://www.dropbox.com/oauth2/authorize?client_id=' + encodeURIComponent(appKey) +
        '&response_type=code&code_challenge=' + pk.challenge + '&code_challenge_method=S256' +
        '&token_access_type=offline&redirect_uri=' + encodeURIComponent(redirectUri());
      var res = await oauthPopup(url, 'code');
      var body = new URLSearchParams({
        code: res.code, grant_type: 'authorization_code', client_id: appKey,
        code_verifier: pk.verifier, redirect_uri: redirectUri()
      });
      var r = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body
      });
      if (!r.ok) throw new Error('Dropbox rejected the connection (' + r.status + ')');
      var j = await r.json();
      Tokens.set('dropbox', { access: j.access_token, refresh: j.refresh_token || '', expires: Date.now() + (j.expires_in || 14400) * 1000 });
      logActivity('Connected', 'dropbox', 'Dropbox');
    },
    disconnect: function () { Tokens.clear('dropbox'); logActivity('Disconnected', 'dropbox', 'Dropbox'); },

    refresh: async function () {
      var t = Tokens.get('dropbox');
      var appKey = this.cfg().appKey;
      if (!t || !t.refresh || !appKey) return false;
      var r = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: appKey })
      });
      if (!r.ok) return false;
      var j = await r.json();
      Tokens.set('dropbox', { access: j.access_token, refresh: t.refresh, expires: Date.now() + (j.expires_in || 14400) * 1000 });
      return true;
    },

    ready: async function () {
      if (!Tokens.get('dropbox')) throw new Error('Dropbox is not connected.');
      if (!Tokens.fresh('dropbox')) await this.refresh();
      return Tokens.get('dropbox');
    },

    api: async function (endpoint, body, _retried) {
      var t = await this.ready();
      var noArgs = (body === null || body === undefined);
      var headers = { Authorization: 'Bearer ' + t.access };
      // Argument-less RPC endpoints (users/get_space_usage) must be sent with NO
      // Content-Type at all. Dropbox doesn't treat an absent body as "no args" —
      // it sees the JSON content type, tries to parse the empty body and 400s
      // with "could not decode input as JSON", which surfaces here as a storage
      // card that reads "Storage unavailable" while every other call works.
      if (!noArgs) headers['Content-Type'] = 'application/json';
      var r = await fetch('https://api.dropboxapi.com/2' + endpoint, {
        method: 'POST',
        headers: headers,
        body: noArgs ? null : JSON.stringify(body)
      });
      if (r.status === 401 && !_retried && await this.refresh()) return this.api(endpoint, body, true);
      if (!r.ok) {
        var msg = '';
        try { var j = await r.json(); msg = j.error_summary || ''; } catch (e) {}
        throw new Error(msg || ('Dropbox error ' + r.status));
      }
      var txt = await r.text();
      return txt ? JSON.parse(txt) : null;
    },

    list: async function (folderId) {
      var out = [];
      var j = await this.api('/files/list_folder', { path: folderId || '', limit: 2000 });
      (j.entries || []).forEach(function (f) { out.push(dbxEntry(f)); });
      while (j && j.has_more) {
        j = await this.api('/files/list_folder/continue', { cursor: j.cursor });
        (j.entries || []).forEach(function (f) { out.push(dbxEntry(f)); });
      }
      return out;
    },

    search: async function (query) {
      var j = await this.api('/files/search_v2', { query: String(query), options: { max_results: 200 } });
      return (j.matches || []).map(function (m) { return dbxEntry(m.metadata.metadata); }).filter(function (e) { return e.id; });
    },

    upload: async function (file, parentId, opts) {
      opts = opts || {};
      var t = await this.ready();
      var path = (parentId || '') + '/' + file.name;
      var arg = { path: path, mode: 'add', autorename: true, mute: false };
      return await xhrUpload('https://content.dropboxapi.com/2/files/upload', file, opts, {
        Authorization: 'Bearer ' + t.access,
        'Dropbox-API-Arg': asciiJson(arg),
        'Content-Type': 'application/octet-stream'
      }, function (txt) { try { return dbxEntry(JSON.parse(txt)); } catch (e) { return null; } });
    },

    // Dropbox has no embeddable viewer of its own (dropbox.com refuses to frame),
    // so Office files go through Microsoft's public Office viewer. That needs a
    // URL Microsoft's servers can fetch, which is exactly what a temporary link
    // is — unauthenticated and good for ~4 hours.
    embedUrl: async function (entry) {
      if (entry.folder) return null;
      var ext = String(entry.name).split('.').pop().toLowerCase();
      if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'].indexOf(ext) < 0) return null;
      var j = await this.api('/files/get_temporary_link', { path: entry.id });
      if (!j || !j.link) return null;
      return 'https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(j.link);
    },

    downloadUrl: async function (entry) {
      var t = await this.ready();
      var r = await fetch('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + t.access, 'Dropbox-API-Arg': asciiJson({ path: entry.id }) }
      });
      if (!r.ok) throw new Error('Download failed (' + r.status + ')');
      return URL.createObjectURL(await r.blob());
    },

    rename: function (id, name) {
      var to = id.replace(/\/[^/]*$/, '') + '/' + name;
      return this.api('/files/move_v2', { from_path: id, to_path: to, autorename: true });
    },
    // Already soft — Dropbox keeps deleted files ~30 days and restores by rev.
    remove: function (id) { return this.api('/files/delete_v2', { path: id }); },

    // Dropbox has no "list my trash" endpoint, and — the part that matters — its
    // namespace index keeps a `deleted` tombstone for every file ever removed,
    // forever. Listing those raw gives thousands of entries that were purged
    // years ago and cannot be restored (dropbox.com's own Deleted files screen
    // shows only the recoverable ones, which is why the counts didn't match).
    //
    // There is no flag distinguishing the two, and tombstones carry no date. The
    // only reliable test is list_revisions: a file still inside the retention
    // window has revisions, a purged one has none. So we verify, in bounded
    // concurrent batches, and return only what can actually be put back.
    listTrash: async function (onProgress) {
      var self = this;
      var tombs = [], pages = 0;
      var j = await this.api('/files/list_folder', { path: '', recursive: true, include_deleted: true, limit: 2000 });
      var take = function (entries) {
        (entries || []).forEach(function (f) {
          if (f['.tag'] !== 'deleted') return;
          tombs.push({
            id: f.path_lower || f.path_display || '',
            name: f.name, folder: false,
            size: 0, modified: 0, created: 0, deletedAt: 0,
            mime: guessMime(f.name),
            parent: (f.path_lower || '').replace(/\/[^/]*$/, ''),
            provider: 'dropbox', webUrl: '', thumb: ''
          });
        });
      };
      take(j.entries);
      while (j && j.has_more && pages++ < 12 && tombs.length < VERIFY_CAP * 4) {
        j = await this.api('/files/list_folder/continue', { cursor: j.cursor });
        take(j.entries);
      }

      var candidates = tombs.slice(0, VERIFY_CAP);
      var out = [];
      for (var i = 0; i < candidates.length; i += VERIFY_CONC) {
        var batch = candidates.slice(i, i + VERIFY_CONC);
        /* eslint-disable no-loop-func */
        var settled = await Promise.all(batch.map(async function (d) {
          try {
            var r = await self.api('/files/list_revisions', { path: d.id, mode: { '.tag': 'path' }, limit: 1 });
            if (r && r.entries && r.entries.length) {
              var rev = r.entries[0];
              d.size = rev.size || 0;
              d.modified = rev.server_modified ? Date.parse(rev.server_modified) : 0;
              dbxRevCache[d.id] = rev.rev;      // saves a lookup when restoring
              return d;
            }
          } catch (e) { /* unrecoverable or inaccessible — drop it */ }
          return null;
        }));
        settled.forEach(function (r) { if (r) out.push(r); });
        if (onProgress) onProgress(Math.min(i + VERIFY_CONC, candidates.length), candidates.length, out.length);
      }
      out.scanned = candidates.length;
      out.tombstones = tombs.length;
      return out;
    },

    // /files/restore needs the revision to restore TO. listTrash already looked
    // it up, so the cache usually saves a round trip; the lookup stays for a
    // restore attempted without a preceding scan.
    restore: async function (id) {
      var rev = dbxRevCache[id];
      if (!rev) {
        var revs = await this.api('/files/list_revisions', { path: id, mode: { '.tag': 'path' }, limit: 1 });
        rev = revs && revs.entries && revs.entries[0] && revs.entries[0].rev;
      }
      if (!rev) throw new Error('Dropbox no longer has a recoverable version of this file.');
      var r = await this.api('/files/restore', { path: id, rev: rev });
      delete dbxRevCache[id];
      return r;
    },
    move: function (id, toParent) {
      var name = id.split('/').pop();
      return this.api('/files/move_v2', { from_path: id, to_path: (toParent || '') + '/' + name, autorename: true });
    },
    mkdir: async function (name, parentId) {
      var j = await this.api('/files/create_folder_v2', { path: (parentId || '') + '/' + name, autorename: true });
      return dbxEntry(j.metadata);
    },
    shareLink: async function (id) {
      try {
        var j = await this.api('/sharing/create_shared_link_with_settings', { path: id });
        return j.url;
      } catch (e) {
        // Already shared — Dropbox 409s rather than returning the existing link.
        var l = await this.api('/sharing/list_shared_links', { path: id, direct_only: true });
        if (l && l.links && l.links[0]) return l.links[0].url;
        throw e;
      }
    },
    quota: async function () {
      var j = await this.api('/users/get_space_usage', null);
      var total = j.allocation && (j.allocation.allocated || (j.allocation.individual && j.allocation.individual.allocated)) || 0;
      return { used: j.used || 0, total: total };
    }
  };

  // Dropbox-API-Arg must be ASCII — non-Latin filenames otherwise throw when the
  // header is set. Escape everything above 0x7f as \uXXXX.
  var NON_ASCII = new RegExp('[\\u007f-\\uffff]', 'g');
  function asciiJson(o) {
    return JSON.stringify(o).replace(NON_ASCII, function (c) {
      return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
    });
  }

  /* ── Upload transports ─────────────────────────────────────────────────────
   * XHR rather than fetch, because upload progress events are the whole point
   * and fetch still has no equivalent. Both forms honour opts.signal so the
   * queue can cancel, and resolve with a parsed Entry. */
  function xhrPut(url, file, opts, parse) {
    return xhrSend('PUT', url, file, opts, { 'Content-Type': file.type || 'application/octet-stream' }, parse);
  }
  function xhrUpload(url, file, opts, headers, parse) {
    return xhrSend('POST', url, file, opts, headers, parse);
  }
  function xhrSend(method, url, file, opts, headers, parse) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      Object.keys(headers || {}).forEach(function (k) { xhr.setRequestHeader(k, headers[k]); });
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable && opts.onProgress) opts.onProgress(e.loaded, e.total);
      };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) resolve(parse ? parse(xhr.responseText) : null);
        else reject(new Error('Upload failed (' + xhr.status + ')'));
      };
      xhr.onerror = function () { reject(new Error('Upload failed — network error')); };
      xhr.onabort = function () { reject(Object.assign(new Error('Upload cancelled'), { aborted: true })); };
      if (opts.signal) {
        if (opts.signal.aborted) { xhr.abort(); return; }
        opts.signal.addEventListener('abort', function () { xhr.abort(); });
      }
      if (opts.onXhr) opts.onXhr(xhr);
      xhr.send(file);
    });
  }

  /* ── Upload queue ──────────────────────────────────────────────────────────
   * Serial by design: two browser uploads to the same account contend for the
   * same bandwidth and make both progress bars useless. Items carry their own
   * AbortController so cancel/pause are immediate; pause is "abort and keep the
   * item queued", since neither provider exposes a resumable byte offset we can
   * reliably re-enter from a browser. */
  var queue = [];
  var qRunning = false;
  var qListeners = [];
  function onQueue(f) { qListeners.push(f); return function () { qListeners = qListeners.filter(function (g) { return g !== f; }); }; }
  function qEmit() { qListeners.forEach(function (f) { try { f(queue); } catch (e) {} }); }

  var qid = 0;
  function enqueue(file, providerId, parentId) {
    var item = {
      key: 'u' + (++qid), file: file, name: file.name, size: file.size,
      provider: providerId, parent: parentId,
      status: 'queued',       // queued | uploading | paused | done | error | cancelled
      loaded: 0, error: '', ctrl: null
    };
    queue.push(item); qEmit();
    // Lets a dismissed upload dock reappear for genuinely new work without the
    // queue needing to know the dock exists.
    window.dispatchEvent(new CustomEvent('vault-cloud-enqueued'));
    runQueue();
    return item;
  }
  function qFind(key) { return queue.filter(function (i) { return i.key === key; })[0]; }
  function qPause(key) { var i = qFind(key); if (!i) return; if (i.status === 'uploading' && i.ctrl) i.ctrl.abort(); i.status = 'paused'; i.loaded = 0; qEmit(); }
  function qResume(key) { var i = qFind(key); if (!i || i.status !== 'paused') return; i.status = 'queued'; qEmit(); runQueue(); }
  function qRetry(key) { var i = qFind(key); if (!i || (i.status !== 'error' && i.status !== 'cancelled')) return; i.status = 'queued'; i.error = ''; i.loaded = 0; qEmit(); runQueue(); }
  function qCancel(key) { var i = qFind(key); if (!i) return; if (i.ctrl) i.ctrl.abort(); i.status = 'cancelled'; qEmit(); }
  // Everything that isn't still going — errors included, so a failed upload
  // can't wedge the dock open.
  function qClearDone() {
    queue = queue.filter(function (i) { return i.status === 'uploading' || i.status === 'queued' || i.status === 'paused'; });
    qEmit();
  }

  async function runQueue() {
    if (qRunning) return;
    qRunning = true;
    try {
      while (true) {
        var item = queue.filter(function (i) { return i.status === 'queued'; })[0];
        if (!item) break;
        var p = providers[item.provider];
        if (!p) { item.status = 'error'; item.error = 'Unknown provider'; qEmit(); continue; }
        item.status = 'uploading'; item.ctrl = new AbortController(); qEmit();
        try {
          var entry = await p.upload(item.file, item.parent, {
            signal: item.ctrl.signal,
            onProgress: function (loaded) { item.loaded = loaded; qEmit(); }
          });
          item.status = 'done'; item.loaded = item.size; item.entry = entry; qEmit();
          logActivity('Uploaded', item.provider, item.name);
          if (entry) touchRecent(entry, 'uploaded');
          // Drop the cached listing for the folder we just wrote into, or the
          // refresh this event triggers would re-paint the pre-upload contents
          // straight back from cache.
          cacheClear();
          window.dispatchEvent(new CustomEvent('vault-cloud-changed', { detail: { provider: item.provider, parent: item.parent } }));
        } catch (e) {
          if (item.status === 'paused' || item.status === 'cancelled') { qEmit(); continue; }
          item.status = 'error'; item.error = fmtErr(e); qEmit();
        }
      }
    } finally { qRunning = false; }
  }

  /* ── Offline metadata cache ────────────────────────────────────────────────
   * Folder listings keyed by provider+folder, in localStorage. Purely a paint-
   * fast/works-offline layer: a cached listing is shown immediately and replaced
   * the moment the live call returns, so it can never mask a real change. */
  var CACHE_KEY = 'vault_cloud_cache';
  var CACHE_TTL = 1000 * 60 * 60 * 24 * 7;
  function cacheGet(pid, folder) {
    try {
      var all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
      var hit = all[pid + '|' + folder];
      if (hit && Date.now() - hit.at < CACHE_TTL) return hit.entries;
    } catch (e) {}
    return null;
  }
  function cacheSet(pid, folder, entries) {
    try {
      var all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
      all[pid + '|' + folder] = { at: Date.now(), entries: entries };
      var keys = Object.keys(all);
      // Bounded: localStorage is ~5 MB shared with the rest of Vault, and a deep
      // Drive can produce thousands of listings. Oldest out first.
      if (keys.length > 120) {
        keys.sort(function (a, b) { return all[a].at - all[b].at; });
        keys.slice(0, keys.length - 120).forEach(function (k) { delete all[k]; });
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(all));
    } catch (e) { /* quota — cache is optional */ }
  }
  function cacheClear() { try { localStorage.removeItem(CACHE_KEY); } catch (e) {} }

  /* ── Misc helpers shared with the UI ──────────────────────────────────────*/
  var MIME_BY_EXT = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', heic: 'image/heic',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg',
    wav: 'audio/wav', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
    csv: 'text/csv', html: 'text/html', js: 'text/javascript', css: 'text/css',
    zip: 'application/zip', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  };
  function guessMime(name) {
    var ext = String(name).split('.').pop().toLowerCase();
    return MIME_BY_EXT[ext] || '';
  }
  // Coarse buckets — drives the storage breakdown, the type filter and which
  // preview surface an entry gets.
  function kindOf(entry) {
    if (entry.folder) return 'folder';
    var m = entry.mime || guessMime(entry.name);
    if (/^image\//.test(m)) return 'image';
    if (/^video\//.test(m)) return 'video';
    if (/^audio\//.test(m)) return 'audio';
    if (/pdf/.test(m)) return 'pdf';
    if (/^text\/|json|javascript|csv|xml|yaml|x-sh|x-python/.test(m)) return 'text';
    // Extension fallback: plenty of plain-text formats have no registered MIME
    // (or Dropbox reports none), and they preview perfectly as text.
    if (/\.(txt|md|markdown|log|json|jsonl|csv|tsv|xml|yml|yaml|ini|cfg|conf|toml|env|js|mjs|ts|jsx|tsx|css|scss|html|htm|py|rb|go|rs|java|c|h|cpp|sh|bat|ps1|sql|srt|vtt)$/i.test(entry.name || '')) return 'text';
    if (/word|document|spreadsheet|presentation|excel|powerpoint|google-apps/.test(m)) return 'doc';
    if (/zip|compress|tar|rar|7z/.test(m)) return 'archive';
    return 'other';
  }
  function fmtSize(n) {
    if (!n) return '—';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
  }
  function fmtDate(ms) {
    if (!ms) return '—';
    var d = new Date(ms), now = Date.now(), diff = now - ms;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }

  /* ── AI smart search ───────────────────────────────────────────────────────
   * Goes through the personal-ai Worker, which holds the Gemini key as a
   * server-side secret. A key in this file would be published with the page —
   * GitHub Pages serves the repo verbatim — so there is deliberately no key
   * here and no way to set one from the UI.
   *
   * The worker gets file METADATA only (name, kind, size, dates, folder). File
   * contents are never uploaded: Vault can read your whole Drive, and shipping
   * that to an LLM to answer "where's my resume" is not a trade worth making.
   * The model returns ids to surface; ranking happens against the local list. */
  var AI_ENDPOINT = 'https://personal-ai.av1.workers.dev/cloud-search';

  async function aiSearch(query, entries) {
    var slim = entries.slice(0, 400).map(function (e, i) {
      return { i: i, name: e.name, kind: kindOf(e), size: e.size, modified: e.modified ? new Date(e.modified).toISOString().slice(0, 10) : '', folder: !!e.folder, provider: e.provider };
    });
    // Say which key to bill explicitly. Vault has no profile switcher — it is
    // Tony's, single-user — so the worker's `|| 'tony'` fallback already routed
    // here correctly, but only by accident of the default. Naming the profile
    // means a future change to that default (or a second profile arriving in
    // Vault) can't silently start charging the wrong person's Gemini quota.
    var r = await fetch(AI_ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: String(query), files: slim, profile: 'tony' })
    });
    if (!r.ok) throw new Error('AI search is unavailable right now.');
    var j = await r.json();
    var picks = Array.isArray(j.matches) ? j.matches : [];
    var out = [];
    picks.forEach(function (p) {
      var e = entries[typeof p === 'number' ? p : p.i];
      if (e) out.push(Object.assign({}, e, { _why: (p && p.why) || '' }));
    });
    return { entries: out, answer: j.answer || '' };
  }

  // Duplicate detection — local, no AI needed. Same normalised name + same byte
  // size across any provider is a duplicate; size alone is far too noisy.
  function findDuplicates(entries) {
    var by = Object.create(null);
    entries.forEach(function (e) {
      if (e.folder || !e.size) return;
      var k = e.name.toLowerCase().replace(/\s*\((\d+)\)(?=\.|$)/, '').replace(/\s+/g, ' ') + '|' + e.size;
      (by[k] = by[k] || []).push(e);
    });
    return Object.keys(by).map(function (k) { return by[k]; }).filter(function (g) { return g.length > 1; });
  }

  /* ── Registry + dispatch ──────────────────────────────────────────────────*/
  function register(p) {
    var missing = PROVIDER_CONTRACT.filter(function (m) { return typeof p[m] !== 'function'; });
    if (missing.length) { console.warn('[VaultCloud] provider "' + p.id + '" is missing: ' + missing.join(', ')); return; }
    providers[p.id] = p;
    if (order.indexOf(p.id) < 0) order.push(p.id);
  }
  function get(id) { return providers[id] || null; }
  function all() { return order.map(function (id) { return providers[id]; }); }
  function connected() { return all().filter(function (p) { return p.connected(); }); }

  // Single dispatch point. Everything the UI does to a file goes through here,
  // so activity logging and cache invalidation are impossible to forget in a
  // new call site — and a future provider inherits both for free.
  async function op(providerId, method, args, logAs, logName) {
    var p = providers[providerId];
    if (!p) throw new Error('Unknown provider');
    var out = await p[method].apply(p, args || []);
    if (logAs) logActivity(logAs, providerId, logName);
    if (['rename', 'remove', 'move', 'mkdir', 'upload'].indexOf(method) >= 0) {
      cacheClear();
      window.dispatchEvent(new CustomEvent('vault-cloud-changed', { detail: { provider: providerId } }));
    }
    return out;
  }

  // List with cache-first paint: returns cached entries synchronously through
  // onCached (if any), then resolves with the live listing.
  async function list(providerId, folderId, onCached) {
    var cached = cacheGet(providerId, folderId);
    if (cached && onCached) { try { onCached(cached); } catch (e) {} }
    var p = providers[providerId];
    if (!p) throw new Error('Unknown provider');
    var entries = await p.list(folderId);
    cacheSet(providerId, folderId, entries);
    return entries;
  }

  register(gdrive);
  register(dropbox);

  // Keep both connections alive without user involvement. Google is re-minted
  // silently against the existing Google session; Dropbox uses its refresh token
  // (which is why connect() asks for token_access_type=offline). Neither shows
  // UI, so a device stays connected until you explicitly Disconnect or revoke
  // access at the provider.
  registerRenewer('gdrive', function () { return gdrive.renew(); });
  registerRenewer('dropbox', function () { return dropbox.refresh(); });
  keepAlive();

  window.VaultCloud = {
    // registry
    register: register, get: get, all: all, connected: connected, op: op, list: list,
    // settings
    settings: function () { return S; }, save: save, load: load, onChange: onChange,
    loaded: function () { return loaded; },
    setCfg: function (pid, patch) {
      S.providerCfg = S.providerCfg || {};
      S.providerCfg[pid] = Object.assign({}, S.providerCfg[pid] || {}, patch);
      save();
    },
    // favorites / recents / activity
    isFav: isFav, toggleFav: toggleFav, touchRecent: touchRecent, logActivity: logActivity,
    // queue
    enqueue: enqueue, queue: function () { return queue; }, onQueue: onQueue,
    qPause: qPause, qResume: qResume, qRetry: qRetry, qCancel: qCancel, qClearDone: qClearDone,
    // cache
    cacheClear: cacheClear,
    // helpers
    kindOf: kindOf, fmtSize: fmtSize, fmtDate: fmtDate, guessMime: guessMime, fmtErr: fmtErr,
    aiSearch: aiSearch, findDuplicates: findDuplicates,
    Tokens: Tokens
  };
})();
