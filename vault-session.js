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
    async setup(masterPassword) {
      if (await this.hasVault()) throw new Error('vault-exists');
      const { config, dek, recoveryCode } = await VC.createVault(masterPassword);
      this._config = config; this._dek = dek; this._store = null;
      await this.backend.saveConfig(config);
      this._armAutoLock();
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
      const asr = await this.bio.authenticate(this.appId, deviceId);
      if (!asr || !asr.ok) throw new Error(asr && asr.error === 'cancelled' ? 'cancelled' : 'bio-failed');
      const deviceKeyB64 = await this.deviceStore.get(DEVICE_KEY_KEY);
      if (!deviceKeyB64) throw new Error('no-device-key');
      this._dek = await VC.unlockWithBiometric(this._config, deviceId, deviceKeyB64);
      this._afterUnlock();
      return true;
    }

    lock() {
      this._dek = null; this._store = null;
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
      const hasSlot = !!(this._config.biometrics && this._config.biometrics[deviceId]);
      const hasKey = !!(await this.deviceStore.get(DEVICE_KEY_KEY));
      const registered = this.bio ? this.bio.isRegistered(this.appId, deviceId) : false;
      return hasSlot && hasKey && registered;
    }
    async enableBiometric(label) {
      this._requireUnlocked();
      if (!this.bio) throw new Error('bio-unavailable');
      const deviceId = await this._deviceId();
      const reg = await this.bio.register(this.appId, deviceId, {
        rpName: 'Vault', userName: 'vault:' + deviceId, displayName: label || (this.bio.label && this.bio.label()) || 'This device',
      });
      if (!reg || !reg.ok) throw new Error(reg && reg.error === 'cancelled' ? 'cancelled' : 'bio-register-failed');
      const { config, deviceKeyB64 } = await VC.addBiometricSlot(this._config, this._dek, deviceId, { label: label || '' });
      await this.deviceStore.set(DEVICE_KEY_KEY, deviceKeyB64);
      this._config = config;
      await this.backend.saveConfig(config);
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
    async changeMasterPassword(oldPassword, newPassword) {
      this._requireUnlocked();
      // Re-verify the old password before allowing a change.
      await VC.unlockWithPassword(this._config, oldPassword);
      this._config = await VC.changeMasterPassword(this._config, this._dek, newPassword);
      await this.backend.saveConfig(this._config);
      return true;
    }
    async rotateRecovery() {
      this._requireUnlocked();
      const { config, recoveryCode } = await VC.rotateRecoveryKey(this._config, this._dek);
      this._config = config;
      await this.backend.saveConfig(config);
      return { recoveryCode };
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
    _afterUnlock() { this._store = null; this._armAutoLock(); }
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
