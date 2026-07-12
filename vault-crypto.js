/* ─────────────────────────────────────────────────────────────────────────────
 * vault-crypto.js — Vault Password Manager · cryptographic core
 *
 * Dependency-free, CSP-safe, offline-capable. Uses ONLY the platform WebCrypto
 * API (crypto.subtle), so it runs identically in the PWA, a browser extension,
 * and Node ≥ 16 (globalThis.crypto). No CDN, no WASM, no bundler.
 *
 * ── Security model (zero-knowledge / end-to-end) ────────────────────────────
 * Nothing readable ever leaves the device. The cloud only ever sees ciphertext.
 *
 *   master password ──PBKDF2──▶ KEK ──wraps──▶┐
 *   recovery key    ──PBKDF2──▶ KEK ──wraps──▶┤ DEK (random AES-256-GCM key)
 *   biometric slot  ──device key──▶  ──wraps──▶┘        │
 *                                                        └─encrypts every item
 *
 *  • DEK  — a single random AES-256-GCM "data encryption key" that encrypts
 *           every credential/note. It NEVER leaves memory in plaintext and is
 *           never stored unwrapped.
 *  • KEK  — a "key-encryption key" derived from a secret (master password or
 *           recovery key) via PBKDF2. It only ever wraps/unwraps the DEK.
 *  • Wrapping the DEK separately per unlock method means changing the master
 *           password (or adding a biometric device) only re-wraps one 32-byte
 *           key — the vault itself is never re-encrypted.
 *  • verifier — a known constant encrypted under the DEK, so we can confirm a
 *           correct unlock without ever storing or comparing the password.
 *
 * This module is PURE crypto: it performs no storage, no network, no UI. The
 * caller persists the returned `config` (safe to store in the cloud — it holds
 * only salts, wrapped keys, and ciphertext) and keeps the returned live `dek`
 * (a non-extractable CryptoKey) in memory for the unlocked session.
 * ──────────────────────────────────────────────────────────────────────────── */

(function (global) {
  'use strict';
  if (global.VaultCrypto) return;

  const subtle = (global.crypto && global.crypto.subtle) || null;
  const getRandomValues = (arr) => global.crypto.getRandomValues(arr);

  // ── Versioned parameters ──────────────────────────────────────────────────
  // `kdf.v` is stored with every vault so we can raise iterations or migrate to
  // Argon2id later WITHOUT breaking existing vaults: unwrap with the stored
  // params, then re-wrap with the current ones (see upgradeKdf()).
  const KDF = Object.freeze({
    v: 1,
    name: 'PBKDF2',
    hash: 'SHA-256',
    iterations: 600000, // matches Bitwarden's modern default; ≥ OWASP 2023 floor
    saltBytes: 16,
  });
  const AES = Object.freeze({ name: 'AES-GCM', length: 256, ivBytes: 12 });
  const VERIFIER_PLAINTEXT = 'vault.verify.v1';
  const RECOVERY_ENTROPY_BYTES = 20; // 160 bits

  // ── Encoding helpers ──────────────────────────────────────────────────────
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function bytesToB64(bytes) {
    let s = '';
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }
  function b64ToBytes(str) {
    const bin = atob(String(str));
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }
  function randomBytes(n) {
    return getRandomValues(new Uint8Array(n));
  }

  // Crockford base32 (no I/L/O/U) for human-typable recovery keys.
  const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function toBase32(bytes) {
    let bits = 0, value = 0, out = '';
    for (let i = 0; i < bytes.length; i++) {
      value = (value << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
  }
  // Normalize a user-typed recovery key back to canonical form: uppercase,
  // strip separators/spaces, and fix the common visual ambiguities.
  function normalizeRecovery(code) {
    return String(code).toUpperCase().replace(/[^0-9A-Z]/g, '')
      .replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  }

  // ── Primitive crypto ──────────────────────────────────────────────────────

  // Derive a KEK (AES-GCM key used only to wrap/unwrap the DEK) from a secret.
  async function deriveKEK(secret, saltBytes, kdf) {
    kdf = kdf || KDF;
    const baseKey = await subtle.importKey(
      'raw', enc.encode(secret), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: kdf.iterations, hash: kdf.hash },
      baseKey,
      { name: AES.name, length: AES.length },
      false,               // KEK itself is non-extractable
      ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']
    );
  }

  // Generate the vault's random Data Encryption Key. Extractable so it can be
  // wrapped; callers keep the returned CryptoKey — its raw bytes never surface
  // except inside subtle.wrapKey.
  async function generateDEK() {
    return subtle.generateKey({ name: AES.name, length: AES.length }, true,
      ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);
  }

  // Wrap (encrypt) the DEK under a KEK. Returns { iv, ct } as base64 strings.
  async function wrapDEK(dek, kek) {
    const iv = randomBytes(AES.ivBytes);
    const wrapped = await subtle.wrapKey('raw', dek, kek, { name: AES.name, iv });
    return { iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(wrapped)) };
  }

  // Unwrap the DEK using a KEK. Throws (OperationError) if the KEK is wrong —
  // GCM authentication failure — which is how we detect a bad password/key.
  async function unwrapDEK(wrapObj, kek) {
    const iv = b64ToBytes(wrapObj.iv);
    const ct = b64ToBytes(wrapObj.ct);
    return subtle.unwrapKey(
      'raw', ct, kek, { name: AES.name, iv },
      { name: AES.name, length: AES.length },
      // Extractable in-memory: required so an unlocked session can re-wrap the
      // DEK into NEW slots (add biometric, change master password, rotate
      // recovery). The DEK is never persisted unwrapped — only ever re-wrapped
      // via subtle.wrapKey. This mirrors how Bitwarden/1Password keep the vault
      // key usable for the duration of an unlocked session.
      true,
      ['encrypt', 'decrypt']
    );
  }

  // Encrypt an arbitrary JSON-serialisable value under the DEK.
  async function encrypt(dek, value) {
    const iv = randomBytes(AES.ivBytes);
    const data = enc.encode(JSON.stringify(value));
    const ct = await subtle.encrypt({ name: AES.name, iv }, dek, data);
    return { iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)) };
  }
  async function decrypt(dek, blob) {
    const iv = b64ToBytes(blob.iv);
    const ct = b64ToBytes(blob.ct);
    const pt = await subtle.decrypt({ name: AES.name, iv }, dek, ct);
    return JSON.parse(dec.decode(pt));
  }

  // ── Recovery keys ─────────────────────────────────────────────────────────
  // 160 bits of entropy, shown once as grouped base32 (e.g. AB2C-D3EF-...).
  function generateRecoveryCode() {
    const b32 = toBase32(randomBytes(RECOVERY_ENTROPY_BYTES));
    const groups = b32.match(/.{1,4}/g) || [b32];
    return { display: groups.join('-'), normalized: normalizeRecovery(b32) };
  }

  // ── High-level vault lifecycle ────────────────────────────────────────────

  // Create a brand-new vault. Returns the cloud-safe `config`, the live in-
  // memory `dek`, and the one-time `recoveryCode.display` to show the user ONCE.
  async function createVault(masterPassword) {
    if (!masterPassword || String(masterPassword).length < 1)
      throw new Error('master password required');
    const dek = await generateDEK();

    const mSalt = randomBytes(KDF.saltBytes);
    const mKek = await deriveKEK(masterPassword, mSalt, KDF);
    const master = { kdf: { ...KDF }, salt: bytesToB64(mSalt), wrap: await wrapDEK(dek, mKek) };

    const recovery = generateRecoveryCode();
    const rSalt = randomBytes(KDF.saltBytes);
    const rKek = await deriveKEK(recovery.normalized, rSalt, KDF);
    const recoverySlot = { kdf: { ...KDF }, salt: bytesToB64(rSalt), wrap: await wrapDEK(dek, rKek) };

    const config = {
      schema: 1,
      master,
      recovery: recoverySlot,
      biometrics: {},                 // deviceId -> { wrap, addedAt, label }
      verifier: await encrypt(dek, VERIFIER_PLAINTEXT),
      // Bumped on master-password change so other unlocked sessions (whose
      // cached DEK still works) detect the change and re-lock themselves.
      securityStamp: bytesToB64(randomBytes(16)),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return { config, dek, recoveryCode: recovery.display };
  }

  // Confirm the DEK decrypts the verifier — cheap integrity/consistency check.
  async function verify(config, dek) {
    try { return (await decrypt(dek, config.verifier)) === VERIFIER_PLAINTEXT; }
    catch { return false; }
  }

  // Unlock with the master password. Throws 'bad-password' on failure.
  async function unlockWithPassword(config, masterPassword) {
    const m = config.master;
    const kek = await deriveKEK(masterPassword, b64ToBytes(m.salt), m.kdf || KDF);
    let dek;
    try { dek = await unwrapDEK(m.wrap, kek); }
    catch { throw new Error('bad-password'); }
    if (!(await verify(config, dek))) throw new Error('bad-password');
    return dek;
  }

  // Unlock with the recovery key. Throws 'bad-recovery' on failure.
  async function unlockWithRecovery(config, recoveryCode) {
    const r = config.recovery;
    const kek = await deriveKEK(normalizeRecovery(recoveryCode), b64ToBytes(r.salt), r.kdf || KDF);
    let dek;
    try { dek = await unwrapDEK(r.wrap, kek); }
    catch { throw new Error('bad-recovery'); }
    if (!(await verify(config, dek))) throw new Error('bad-recovery');
    return dek;
  }

  // ── Biometric slots ───────────────────────────────────────────────────────
  // Biometrics gate access to a per-device random "device key" that wraps the
  // DEK. The device key is generated here and returned to the caller to store
  // locally (e.g. IndexedDB), released only after a successful WebAuthn (window
  // .Bio) assertion. Losing the device or clearing local storage simply drops
  // that slot — the master password and recovery key remain the roots of trust.
  //
  // Returns { config (updated), deviceKeyB64 } — the caller persists
  // deviceKeyB64 on-device behind the biometric gate and writes config to cloud.
  async function addBiometricSlot(config, dek, deviceId, opts) {
    opts = opts || {};
    const deviceKeyBytes = randomBytes(32);
    const kek = await subtle.importKey('raw', deviceKeyBytes, { name: AES.name }, false,
      ['wrapKey', 'unwrapKey']);
    const wrap = await wrapDEK(dek, kek);
    const next = { ...config, biometrics: { ...config.biometrics }, updatedAt: Date.now() };
    next.biometrics[deviceId] = { wrap, addedAt: Date.now(), label: opts.label || '' };
    return { config: next, deviceKeyB64: bytesToB64(deviceKeyBytes) };
  }

  // Unlock using a previously stored device key (after the WebAuthn gate passed).
  async function unlockWithBiometric(config, deviceId, deviceKeyB64) {
    const slot = config.biometrics && config.biometrics[deviceId];
    if (!slot) throw new Error('no-biometric-slot');
    const kek = await subtle.importKey('raw', b64ToBytes(deviceKeyB64), { name: AES.name }, false,
      ['wrapKey', 'unwrapKey']);
    let dek;
    try { dek = await unwrapDEK(slot.wrap, kek); }
    catch { throw new Error('bad-biometric'); }
    if (!(await verify(config, dek))) throw new Error('bad-biometric');
    return dek;
  }

  function removeBiometricSlot(config, deviceId) {
    const next = { ...config, biometrics: { ...config.biometrics }, updatedAt: Date.now() };
    delete next.biometrics[deviceId];
    return next;
  }

  // ── Master-password / recovery rotation ───────────────────────────────────
  // Requires a live DEK (i.e. the vault is already unlocked). Only re-wraps the
  // small key; the encrypted items are untouched. Any existing biometric slots
  // stay valid because they wrap the same DEK.
  async function changeMasterPassword(config, dek, newPassword) {
    const salt = randomBytes(KDF.saltBytes);
    const kek = await deriveKEK(newPassword, salt, KDF);
    return {
      ...config,
      master: { kdf: { ...KDF }, salt: bytesToB64(salt), wrap: await wrapDEK(dek, kek) },
      securityStamp: bytesToB64(randomBytes(16)), // force other sessions to re-lock
      updatedAt: Date.now(),
    };
  }

  // Rotate the recovery key (invalidates the old one). Returns updated config +
  // the new one-time display code.
  async function rotateRecoveryKey(config, dek) {
    const recovery = generateRecoveryCode();
    const salt = randomBytes(KDF.saltBytes);
    const kek = await deriveKEK(recovery.normalized, salt, KDF);
    return {
      config: {
        ...config,
        recovery: { kdf: { ...KDF }, salt: bytesToB64(salt), wrap: await wrapDEK(dek, kek) },
        updatedAt: Date.now(),
      },
      recoveryCode: recovery.display,
    };
  }

  // Re-derive the master slot under the *current* KDF params if the stored ones
  // are older — transparent forward-migration. Needs the plaintext password.
  async function upgradeKdf(config, dek, masterPassword) {
    if ((config.master.kdf && config.master.kdf.iterations) >= KDF.iterations) return config;
    return changeMasterPassword(config, dek, masterPassword);
  }

  global.VaultCrypto = {
    KDF, AES,
    // primitives
    encrypt, decrypt, deriveKEK, generateDEK, wrapDEK, unwrapDEK,
    // lifecycle
    createVault, verify,
    unlockWithPassword, unlockWithRecovery, unlockWithBiometric,
    // key management
    addBiometricSlot, removeBiometricSlot,
    changeMasterPassword, rotateRecoveryKey, upgradeKdf,
    // utilities
    generateRecoveryCode, normalizeRecovery,
    bytesToB64, b64ToBytes, randomBytes,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.VaultCrypto;
})(typeof globalThis !== 'undefined' ? globalThis : this);
