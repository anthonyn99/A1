/* ─────────────────────────────────────────────────────────────────────────────
 * vault-session.js — Vault Password Manager · session & auth orchestration
 *
 * The single stateful controller the UI talks to. It owns the in-memory DEK for
 * an unlocked session and coordinates the three moving parts:
 *
 *   vault-crypto.js  (key derivation / wrapping)
 *   window.Bio       (platform biometrics — Face ID / Hello / fingerprint)
 *   a device store   (local, per-device secrets: deviceId + wrapped-DEK key)
 *
 * Dependencies are INJECTED so this file is pure logic and fully testable:
 *
 *   new VaultSession({ backend, bio, deviceStore, appId, autoLockMs })
 *
 *   • backend      — same contract as vault-store.js (loadConfig/saveConfig/…)
 *   • bio          — window.Bio (available/isRegistered/register/authenticate/…)
 *   • deviceStore  — { get(k)/set(k,v)/remove(k) }, sync or async. In the browser
 *                    this wraps localStorage/IndexedDB; it holds ONLY per-device
 *                    material (a random device id and the biometric device key),
 *                    never the master password and never the DEK in the clear.
 *
 * ── Biometric trust model ───────────────────────────────────────────────────
 * A biometric slot works by wrapping the DEK with a random 32-byte "device key"
 * kept in the device store. That device key is only ever *used* after a
 * successful WebAuthn assertion (the OS biometric prompt), so possession of the
 * file at rest is not enough — an attacker also needs to pass the live biometric
 * gate on that specific device. The master password and recovery key remain the
 * portable roots of trust; biometrics are a per-device convenience unlock.
 * ──────────────────────────────────────────────────────────────────────────── */

(function (global) {
  'use strict';
  if (global.VaultSession) return;

  const VC = global.VaultCrypto ||
    (typeof require !== 'undefined' ? require('./vault-crypto.js') : null);
  const VaultStore = global.VaultStore ||
    (typeof require !== 'undefined' ? require('./vault-store.js') : null);
  if (!VC || !VaultStore) throw new Error('vault-session.js requires vault-crypto.js + vault-store.js');

  const DEVICE_ID_KEY = 'vault.deviceId';
  const DEVICE_KEY_KEY = 'vault.deviceKey'; // wrapped-DEK key, gated by biometrics

  class VaultSession {
    constructor(opts) {
      opts = opts || {};
      this.backend = opts.backend;
      this.bio = opts.bio || (global.Bio || null);
      this.deviceStore = opts.deviceStore || memoryDeviceStore();
      this.appId = opts.appId || 'vault';
      this.autoLockMs = opts.autoLockMs || 5 * 60 * 1000; // 5 min default
      this.onLock = opts.onLock || null;                  // callback when auto-locked
      this._dek = null;
      this._config = null;
      this._store = null;
      this._lockTimer = null;
    }

    // ── State ────────────────────────────────────────────────────────────────
    async hasVault() {
      if (this._config) return true;
      this._config = await this.backend.loadConfig();
      return !!this._config;
    }
    isUnlocked() { return !!this._dek; }
    getStore() {
      if (!this._dek) throw new Error('locked');
      if (!this._store) this._store = new VaultStore(this.backend, this._dek);
      return this._store;
    }
    getConfig() { return this._config; }

    // ── First-run setup ──────────────────────────────────────────────────────
    // Creates the vault, persists the cloud-safe config, unlocks the session,
    // and returns the one-time recovery code to display to the user ONCE.
    async setup(masterPassword, hint) {
      if (await this.hasVault()) throw new Error('vault-exists');
      const { config, dek, recoveryCode } = await VC.createVault(masterPassword, { hint: hint });
      this._config = config; this._dek = dek;
      await this.backend.saveConfig(config);
      // _afterUnlock (not just _armAutoLock) so the creating device records the
      // securityStamp too — without it, enforceStamp() could never re-lock the
      // very device the vault was made on after a password change elsewhere.
      this._afterUnlock();
      return { recoveryCode };
    }

    // ── Unlock paths ─────────────────────────────────────────────────────────
    async unlockWithPassword(masterPassword) {
      await this._ensureConfig();
      this._dek = await VC.unlockWithPassword(this._config, masterPassword);
      // Transparent KDF forward-migration if params were raised since creation.
      try {
        const upgraded = await VC.upgradeKdf(this._config, this._dek, masterPassword);
        if (upgraded !== this._config) { this._config = upgraded; await this.backend.saveConfig(upgraded); }
      } catch (_) {}
      this._afterUnlock();
      return true;
    }
    async unlockWithRecovery(recoveryCode) {
      await this._ensureConfig();
      this._dek = await VC.unlockWithRecovery(this._config, recoveryCode);
      this._afterUnlock();
      return true;
    }
    async unlockWithBiometric() {
      await this._ensureConfig();
      const deviceId = await this._deviceId();
      const slot = this._config.biometrics && this._config.biometrics[deviceId];
      if (!slot) throw new Error('no-biometric-slot');
      if (!this.bio) throw new Error('bio-unavailable');
      // A PRF slot asks the authenticator for the key as part of the biometric
      // check, so the fingerprint is what produces it. A legacy 'stored' slot
      // reads a key that was already on the device and the check only gates the
      // app's own code path — hence the migration prompt in the UI.
      const wantPrf = slot.kind === 'prf';
      const asr = await this.bio.authenticate(this.appId, deviceId, { withPrf: wantPrf });
      if (!asr || !asr.ok) throw new Error(asr && asr.error === 'cancelled' ? 'cancelled' : 'bio-failed');
      let deviceKeyB64;
      if (wantPrf) {
        if (!asr.prf) throw new Error('bio-prf-failed');
        deviceKeyB64 = asr.prf;
      } else {
        deviceKeyB64 = await this.deviceStore.get(DEVICE_KEY_KEY);
        if (!deviceKeyB64) throw new Error('no-device-key');
      }
      this._dek = await VC.unlockWithBiometric(this._config, deviceId, deviceKeyB64);
      this._afterUnlock();
      return true;
    }

    lock() {
      this._dek = null; this._store = null;
      this._config = null; // drop cached config so the next unlock reloads fresh (e.g. after a remote password change)
      if (this._lockTimer) { clearTimeout(this._lockTimer); this._lockTimer = null; }
    }

    // ── Biometric management (requires an unlocked session) ──────────────────
    async biometricSupported() {
      if (!this.bio) return false;
      try { return !!(await this.bio.available()); } catch { return false; }
    }
    async biometricEnabled() {
      await this._ensureConfig();
      const deviceId = await this._deviceId();
      const slot = this._config.biometrics && this._config.biometrics[deviceId];
      if (!slot) return false;
      const registered = this.bio ? this.bio.isRegistered(this.appId, deviceId) : false;
      if (!registered) return false;
      // A PRF slot deliberately has nothing on disk — the authenticator makes
      // the key at unlock time. Only a legacy 'stored' slot needs a local key.
      if (slot.kind === 'prf') return true;
      return !!(await this.deviceStore.get(DEVICE_KEY_KEY));
    }

    // Enrol this device. PREFERS WebAuthn PRF: the wrapping key is derived by
    // the authenticator on each unlock and never written down, so a copy of the
    // device's storage is worth nothing without the live fingerprint.
    //
    // Without PRF the only option is a random key kept in local storage, where
    // the biometric prompt is an app-level check in front of a key an attacker
    // with the device's storage already has. That is a materially weaker
    // promise than the prompt implies, so it is refused rather than offered
    // quietly — callers can pass {allowStoredKey:true} to take it knowingly.
    async enableBiometric(label, opts) {
      opts = opts || {};
      this._requireUnlocked();
      if (!this.bio) throw new Error('bio-unavailable');
      const deviceId = await this._deviceId();
      const reg = await this.bio.register(this.appId, deviceId, {
        rpName: 'Vault', userName: 'vault:' + deviceId, displayName: label || (this.bio.label && this.bio.label()) || 'This device',
      });
      if (!reg || !reg.ok) throw new Error(reg && reg.error === 'cancelled' ? 'cancelled' : 'bio-register-failed');

      let deviceKeyB64 = null;
      if (reg.prf) {
        // One extra prompt at setup: PRF output is only released by an
        // assertion, so we take one now to learn the key we are wrapping with.
        const asr = await this.bio.authenticate(this.appId, deviceId, { withPrf: true });
        if (!asr || !asr.ok || !asr.prf) {
          this.bio.unregister(this.appId, deviceId);
          throw new Error('bio-prf-failed');
        }
        deviceKeyB64 = asr.prf;
      } else if (!opts.allowStoredKey) {
        this.bio.unregister(this.appId, deviceId);
        throw new Error('bio-no-prf');
      }

      const res = await VC.addBiometricSlot(this._config, this._dek, deviceId, {
        label: label || '',
        deviceKeyB64: deviceKeyB64 || undefined,
      });
      // Only the legacy path has anything to keep.
      if (res.deviceKeyB64) await this.deviceStore.set(DEVICE_KEY_KEY, res.deviceKeyB64);
      else await this.deviceStore.remove(DEVICE_KEY_KEY);
      this._config = res.config;
      await this.backend.saveConfig(res.config);
      return true;
    }
    async disableBiometric() {
      await this._ensureConfig();
      const deviceId = await this._deviceId();
      if (this.bio) { try { this.bio.unregister(this.appId, deviceId); } catch (_) {} }
      await this.deviceStore.remove(DEVICE_KEY_KEY);
      this._config = VC.removeBiometricSlot(this._config, deviceId);
      await this.backend.saveConfig(this._config);
      return true;
    }

    // ── Identity verification (for sensitive actions on an unlocked vault) ───
    // Verify the master password WITHOUT changing the session (returns bool).
    async verifyPassword(pw) {
      await this._ensureConfig();
      try { await VC.unlockWithPassword(this._config, pw); return true; } catch (e) { return false; }
    }
    // Run a live biometric (WebAuthn) assertion against this device's credential.
    async confirmBiometric() {
      await this._ensureConfig();
      if (!this.bio) return false;
      const deviceId = await this._deviceId();
      if (!this.bio.isRegistered(this.appId, deviceId)) return false;
      const r = await this.bio.authenticate(this.appId, deviceId);
      return !!(r && r.ok);
    }

    // ── Master password / recovery rotation (requires unlocked) ──────────────
    async changeMasterPassword(oldPassword, newPassword, hint) {
      this._requireUnlocked();
      // Re-verify the old password before allowing a change.
      await VC.unlockWithPassword(this._config, oldPassword);
      this._config = await VC.changeMasterPassword(this._config, this._dek, newPassword, hint);
      await this.backend.saveConfig(this._config);
      return true;
    }

    // Forgot the master password: prove ownership with the recovery key instead,
    // set a new one, and leave the session UNLOCKED (the recovery key already
    // yielded a live DEK, so making the user re-type the password they just set
    // would be pure friction). Works whether or not the vault is currently
    // unlocked. Throws 'bad-recovery' if the key doesn't match.
    async resetMasterPasswordWithRecovery(recoveryCode, newPassword, hint) {
      await this._ensureConfig();
      const { config, dek } = await VC.resetMasterPasswordWithRecovery(
        this._config, recoveryCode, newPassword, hint);
      this._config = config; this._dek = dek;
      await this.backend.saveConfig(config);
      this._afterUnlock();
      return true;
    }

    // The plaintext password hint, readable WITHOUT unlocking — that's the whole
    // point (it's shown/mailed to someone who is locked out). '' when unset.
    async getHint() {
      await this._ensureConfig();
      return String((this._config && this._config.hint) || '');
    }
    async rotateRecovery() {
      this._requireUnlocked();
      const { config, recoveryCode } = await VC.rotateRecoveryKey(this._config, this._dek);
      this._config = config;
      await this.backend.saveConfig(config);
      return { recoveryCode };
    }

    // ── Binary payloads (attachment bytes) ───────────────────────────────────
    // Items go through VaultStore, which JSON-encodes their body. File bytes
    // can't: base64-ing a 10 MB scan through JSON.stringify would triple it in
    // memory and defeat the whole point of keeping blobs out of the vault doc.
    // So these encrypt/decrypt RAW BYTES under the very same session DEK —
    // one key, one algorithm (AES-256-GCM), one lock. The DEK itself never
    // leaves the session: callers hand over bytes and get bytes back.
    //
    // Returns { iv:<base64>, bytes:<Uint8Array ciphertext> }. Persist both; the
    // ciphertext is safe to hand to any file host, the IV is not a secret.
    async encryptBytes(bytes) {
      this._requireUnlocked();
      const iv = VC.randomBytes(VC.AES.ivBytes);
      const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const ct = await global.crypto.subtle.encrypt({ name: VC.AES.name, iv }, this._dek, buf);
      return { iv: VC.bytesToB64(iv), bytes: new Uint8Array(ct) };
    }
    // Throws (OperationError) if the ciphertext was tampered with — GCM's
    // authentication tag is the integrity check, so a corrupted or swapped
    // blob fails loudly instead of rendering as garbage.
    async decryptBytes(ivB64, bytes) {
      this._requireUnlocked();
      const iv = VC.b64ToBytes(ivB64);
      const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const pt = await global.crypto.subtle.decrypt({ name: VC.AES.name, iv }, this._dek, buf);
      return new Uint8Array(pt);
    }

    // ── Auto-lock ────────────────────────────────────────────────────────────
    setAutoLock(ms) { this.autoLockMs = ms; if (this._dek) this._armAutoLock(); }
    touch() { if (this._dek) this._armAutoLock(); } // call on user activity
    _armAutoLock() {
      if (this._lockTimer) clearTimeout(this._lockTimer);
      if (!this.autoLockMs || this.autoLockMs <= 0) return;
      this._lockTimer = setTimeout(() => { this.lock(); if (this.onLock) try { this.onLock(); } catch (_) {} }, this.autoLockMs);
      if (this._lockTimer && this._lockTimer.unref) this._lockTimer.unref(); // don't hold Node open
    }

    // ── internals ────────────────────────────────────────────────────────────
    _afterUnlock() { this._store = null; this._stamp = (this._config && this._config.securityStamp) || null; this._armAutoLock(); }
    // If the cloud config's securityStamp changed (e.g. master password changed
    // on another device), this session's cached DEK is stale-by-policy → lock.
    enforceStamp(latestConfig) {
      if (!this._dek) return false;
      const cur = latestConfig && latestConfig.securityStamp;
      if (cur && this._stamp && cur !== this._stamp) { this.lock(); return true; }
      return false;
    }
    _requireUnlocked() { if (!this._dek) throw new Error('locked'); }
    async _ensureConfig() { if (!this._config) this._config = await this.backend.loadConfig(); if (!this._config) throw new Error('no-vault'); }
    async _deviceId() {
      let id = await this.deviceStore.get(DEVICE_ID_KEY);
      if (!id) { id = 'dev_' + VC.bytesToB64(VC.randomBytes(12)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16); await this.deviceStore.set(DEVICE_ID_KEY, id); }
      return id;
    }
  }

  // A trivial in-memory device store (tests / SSR). Browser hosts pass one
  // backed by localStorage or IndexedDB.
  function memoryDeviceStore() {
    const m = new Map();
    return { get: (k) => m.get(k) || null, set: (k, v) => { m.set(k, v); }, remove: (k) => { m.delete(k); } };
  }
  // Convenience browser store (localStorage). Only per-device material lives here.
  function localStorageDeviceStore(ns) {
    ns = ns || 'vault.';
    return {
      get: (k) => { try { return global.localStorage.getItem(ns + k); } catch { return null; } },
      set: (k, v) => { try { global.localStorage.setItem(ns + k, v); } catch (_) {} },
      remove: (k) => { try { global.localStorage.removeItem(ns + k); } catch (_) {} },
    };
  }

  VaultSession.memoryDeviceStore = memoryDeviceStore;
  VaultSession.localStorageDeviceStore = localStorageDeviceStore;
  global.VaultSession = VaultSession;
  if (typeof module !== 'undefined' && module.exports) module.exports = VaultSession;
})(typeof globalThis !== 'undefined' ? globalThis : this);
