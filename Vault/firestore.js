// ─────────────────────────────────────────────────────────────────────────────
// Vault ⇄ Keychain shared backend.
//
// Vault does NOT keep its own database. It reads and writes the exact same
// Firestore document that the Index app's Keychain uses:
//
//     dashboards/keychain  →  { connections, colmap, savedAt }
//
// A "connection" is a group:  { name, color, items: [ ... ] }
// where items of  type:'link'  are  { type:'link', name, url }.
// (Keychain also stores email / phone / username / info / doc items; Vault
//  preserves those untouched so nothing is ever lost on a round-trip.)
//
// We talk to Firestore over its REST API using anonymous auth — the same auth
// model index.html uses (signInAnonymously). This keeps the extension free of
// the bundled Firebase SDK (MV3 forbids remote script loading) while staying
// fully compatible with the live rules: `allow read, write: if request.auth != null`.
// ─────────────────────────────────────────────────────────────────────────────

const VaultDB = (() => {
  const API_KEY    = "AIzaSyC2aKunOKj5WS8NpgZhpyMzOYecBr5t2_4";
  const PROJECT_ID = "task-dashboard-d2b53";
  const DOC_PATH   = "dashboards/keychain";

  const AUTH_SIGNUP  = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`;
  const AUTH_REFRESH = `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`;
  const DOC_URL      = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${DOC_PATH}`;

  // ── Anonymous auth (token reused across popup opens via storage) ───────────
  // signUp creates a NEW anonymous user every call, so we persist the
  // refreshToken and mint fresh idTokens from it instead of re-signing up.
  async function getIdToken() {
    const now = Date.now();
    const cached = await storageGet(["vault_refreshToken", "vault_idToken", "vault_tokenExp"]);

    if (cached.vault_idToken && cached.vault_tokenExp && cached.vault_tokenExp - now > 60000) {
      return cached.vault_idToken;
    }

    if (cached.vault_refreshToken) {
      try {
        const r = await fetch(AUTH_REFRESH, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(cached.vault_refreshToken)}`
        });
        if (r.ok) {
          const d = await r.json();
          await storageSet({
            vault_idToken: d.id_token,
            vault_refreshToken: d.refresh_token,
            vault_tokenExp: now + Number(d.expires_in || 3600) * 1000
          });
          return d.id_token;
        }
      } catch (_) { /* fall through to fresh sign-up */ }
    }

    // Fresh anonymous sign-up.
    const r = await fetch(AUTH_SIGNUP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true })
    });
    if (!r.ok) throw new Error("Vault auth failed: " + r.status);
    const d = await r.json();
    await storageSet({
      vault_idToken: d.idToken,
      vault_refreshToken: d.refreshToken,
      vault_tokenExp: now + Number(d.expiresIn || 3600) * 1000
    });
    return d.idToken;
  }

  // ── Firestore typed-value <-> plain JS conversion ──────────────────────────
  function encode(val) {
    if (val === null || val === undefined) return { nullValue: null };
    if (typeof val === "boolean") return { booleanValue: val };
    if (typeof val === "number") {
      return Number.isInteger(val)
        ? { integerValue: String(val) }
        : { doubleValue: val };
    }
    if (typeof val === "string") return { stringValue: val };
    if (Array.isArray(val)) {
      return { arrayValue: { values: val.map(encode) } };
    }
    if (typeof val === "object") {
      const fields = {};
      for (const [k, v] of Object.entries(val)) {
        if (v === undefined) continue;
        fields[k] = encode(v);
      }
      return { mapValue: { fields } };
    }
    return { stringValue: String(val) };
  }

  function decode(v) {
    if (!v || typeof v !== "object") return v;
    if ("nullValue" in v)    return null;
    if ("booleanValue" in v) return v.booleanValue;
    if ("integerValue" in v) return Number(v.integerValue);
    if ("doubleValue" in v)  return v.doubleValue;
    if ("stringValue" in v)  return v.stringValue;
    if ("timestampValue" in v) return v.timestampValue;
    if ("arrayValue" in v)   return (v.arrayValue.values || []).map(decode);
    if ("mapValue" in v) {
      const out = {};
      const f = v.mapValue.fields || {};
      for (const [k, val] of Object.entries(f)) out[k] = decode(val);
      return out;
    }
    return v;
  }

  // ── Read the whole Keychain document ───────────────────────────────────────
  // Returns { connections:[...], colmap:[...]|null, savedAt:number } or a
  // safe empty shape if the doc doesn't exist yet.
  async function load() {
    const token = await getIdToken();
    const r = await fetch(DOC_URL, { headers: { Authorization: "Bearer " + token } });
    if (r.status === 404) return { connections: [], colmap: null, savedAt: 0 };
    if (!r.ok) throw new Error("Vault load failed: " + r.status);
    const doc = await r.json();
    const fields = doc.fields || {};
    return {
      connections: fields.connections ? decode(fields.connections) : [],
      colmap: fields.colmap ? decode(fields.colmap) : null,
      savedAt: fields.savedAt ? decode(fields.savedAt) : 0
    };
  }

  // ── Write the whole document back ──────────────────────────────────────────
  // Mirrors index.html's _fbSaveKeychain payload exactly: connections + colmap
  // + savedAt. Keychain's onSnapshot listener picks the change up live.
  async function save(state) {
    const token = await getIdToken();
    const connections = sanitize(Array.isArray(state.connections) ? state.connections : []);
    const colmap = Array.isArray(state.colmap) && state.colmap.length ? state.colmap : null;
    const payload = {
      fields: {
        connections: encode(connections),
        colmap: encode(colmap),
        savedAt: encode(Date.now())
      }
    };
    const r = await fetch(DOC_URL, {
      method: "PATCH",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error("Vault save failed: " + r.status + " " + (await r.text()));
    return true;
  }

  // Drop null/undefined to match index.html's sanitize() so we never write junk.
  function sanitize(obj) {
    if (Array.isArray(obj)) return obj.map(sanitize);
    if (obj && typeof obj === "object") {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (v !== null && v !== undefined) out[k] = sanitize(v);
      }
      return out;
    }
    return obj;
  }

  // ── Convenience: pull just the link items out of a connection (group) ──────
  function linksOf(conn) {
    return (conn.items || [])
      .filter(it => it && it.type === "link" && it.url)
      .map(it => ({ name: it.name || it.url, url: it.url }));
  }

  // ── chrome.storage.local promise wrappers ──────────────────────────────────
  function storageGet(keys) {
    return new Promise(res => chrome.storage.local.get(keys, res));
  }
  function storageSet(obj) {
    return new Promise(res => chrome.storage.local.set(obj, res));
  }

  return { load, save, linksOf, encode, decode };
})();

// Usable from classic scripts (popup.js / options.js) and importScripts (SW).
if (typeof window !== "undefined") window.VaultDB = VaultDB;
if (typeof self !== "undefined") self.VaultDB = VaultDB;
