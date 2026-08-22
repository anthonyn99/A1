/* ─────────────────────────────────────────────────────────────────────────────
 * warden-store.js — Warden Password Manager · encrypted storage + sync layer
 *
 * Sits between the crypto core (warden-crypto.js) and whatever persistence
 * backend the host provides. It NEVER sees keys or persistence details directly:
 *
 *   UI ──▶ WardenStore ──(encrypt via DEK)──▶ Backend ──▶ Firestore / memory
 *      ◀── decrypted items ◀──(decrypt)────◀── ciphertext docs
 *
 * ── Data model ──────────────────────────────────────────────────────────────
 * Each credential / note is ONE document so multi-device edits conflict per-item
 * (not whole-warden), sync in real time, and scale past Firestore's 1 MB per-doc
 * limit — "unlimited credentials". A stored item doc is fully opaque to the DB:
 *
 *     { id, kind, enc:{iv,ct}, updatedAt, deleted }
 *
 *   • id        — random, stable across edits
 *   • kind      — 'login' | 'sensitive'  (plaintext: needed to route/filter; not
 *                 secret). Everything else lives ENCRYPTED inside `enc`.
 *   • enc       — AES-GCM ciphertext of the whole item body (title, url, user,
 *                 email, password, notes, tags, category, custom fields, totp…).
 *   • updatedAt — ms epoch; drives last-write-wins conflict resolution.
 *   • deleted   — tombstone flag (kept so deletes propagate to other devices).
 *
 * The warden `config` (salts + wrapped keys + verifier from warden-crypto) is a
 * single separate doc. It too is cloud-safe — no plaintext, no live keys.
 *
 * ── Backend contract ────────────────────────────────────────────────────────
 * The host injects a `backend` object. In the PWA it wraps Firestore
 * (App Check + anon auth + IndexedDB offline cache already handle transport,
 * offline queueing, and real-time). In tests it's a plain in-memory map.
 *
 *   backend.loadConfig()                  → config | null
 *   backend.saveConfig(config)            → void
 *   backend.listItems()                   → [ storedDoc, ... ]   (incl. tombstones)
 *   backend.putItem(storedDoc)            → void
 *   backend.subscribe(onItems, onConfig)? → unsubscribe fn   (optional / live)
 * ──────────────────────────────────────────────────────────────────────────── */

(function (global) {
  'use strict';
  if (global.WardenStore) return;

  const VC = global.WardenCrypto ||
    (typeof require !== 'undefined' ? require('./warden-crypto.js') : null);
  if (!VC) throw new Error('warden-store.js requires warden-crypto.js');

  function newId() {
    return 'itm_' + Date.now().toString(36) + '_' +
      VC.bytesToB64(VC.randomBytes(9)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
  }

  class WardenStore {
    // `dek` is the live (non-extractable) DEK from an unlocked session.
    constructor(backend, dek) {
      if (!backend) throw new Error('backend required');
      if (!dek) throw new Error('dek required (warden must be unlocked)');
      this.backend = backend;
      this.dek = dek;
      this._items = new Map();      // id -> { ...decryptedBody, id, kind, updatedAt, deleted }
      this._raw = new Map();        // id -> stored doc (for merge bookkeeping)
      this._listeners = new Set();  // change subscribers (UI)
      this._unsub = null;
    }

    // ── Load everything once, decrypting into the in-memory index ────────────
    async load() {
      const docs = await this.backend.listItems();
      for (const doc of docs) await this._ingest(doc);
      return this.all();
    }

    // Start a live subscription if the backend supports it. onChange fires with
    // the current decrypted item list whenever remote data changes.
    startLive(onChange) {
      if (onChange) this._listeners.add(onChange);
      if (this.backend.subscribe && !this._unsub) {
        this._unsub = this.backend.subscribe(
          async (docs) => {
            for (const doc of docs) await this._ingest(doc);
            this._emit();
          },
          null
        );
      }
      return () => this.stopLive(onChange);
    }
    stopLive(onChange) {
      if (onChange) this._listeners.delete(onChange);
      if (!this._listeners.size && this._unsub) { this._unsub(); this._unsub = null; }
    }
    _emit() { const list = this.all(); this._listeners.forEach((fn) => { try { fn(list); } catch (_) {} }); }

    // Merge a stored doc into memory using last-write-wins (skip if we already
    // hold a newer version — this is what makes concurrent multi-device edits
    // converge deterministically).
    async _ingest(doc) {
      if (!doc || !doc.id) return;
      const prev = this._raw.get(doc.id);
      if (prev && prev.updatedAt >= doc.updatedAt) return;
      this._raw.set(doc.id, doc);
      if (doc.deleted) { this._items.delete(doc.id); return; }
      try {
        const body = await VC.decrypt(this.dek, doc.enc);
        this._items.set(doc.id, { ...body, id: doc.id, kind: doc.kind, updatedAt: doc.updatedAt, deleted: false });
      } catch (_) {
        // Undecryptable (corrupt or wrong key) — skip rather than crash the app.
      }
    }

    // ── Reads (operate purely on the decrypted in-memory index) ──────────────
    all() {
      return Array.from(this._items.values())
        .filter((it) => !it.deleted)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }
    get(id) { return this._items.get(id) || null; }
    byKind(kind) { return this.all().filter((it) => it.kind === kind); }

    // Fuzzy, zero-plaintext-in-cloud search — runs entirely on decrypted memory.
    // Matches across the fields relevant to logins & notes, subsequence-fuzzy so
    // "gh" matches "github". Returns items ranked by match quality.
    // Ranked, zero-plaintext-in-cloud search — runs entirely on decrypted
    // memory. Each field is scored by MATCH QUALITY (exact > prefix > word-start
    // > substring > subsequence-fuzzy) and FIELD IMPORTANCE (title weighs most,
    // notes least), so the best match sorts first.
    search(query) {
      const q = String(query || '').trim().toLowerCase();
      if (!q) return this.all();
      const scored = [];
      for (const it of this.all()) {
        const s = scoreItem(it, q);
        if (s > 0) scored.push({ it, s });
      }
      return scored.sort((a, b) => b.s - a.s || (b.it.updatedAt - a.it.updatedAt)).map((x) => x.it);
    }

    // Monotonic clock for LOCAL writes: guarantees each new write gets a strictly
    // greater `updatedAt` than the previous one — even two writes in the same
    // millisecond (e.g. edit-then-delete). Without this, _ingest's `>=` staleness
    // guard would reject the second write and the change (e.g. a delete) would be
    // silently lost.
    _now() { this._clock = Math.max(Date.now(), (this._clock || 0) + 1); return this._clock; }

    // ── Writes ───────────────────────────────────────────────────────────────
    // Encrypt one item into its stored doc. Shared by save() and saveMany() so
    // history/timestamp semantics can never diverge between the two.
    async _buildDoc(item) {
      const id = item.id || newId();
      const kind = item.kind || 'login';
      const body = { ...item };
      delete body.id; delete body.kind; delete body.updatedAt; delete body.deleted;
      const prev = this._items.get(id);
      if (!body.createdAt) body.createdAt = (prev || {}).createdAt || Date.now();
      // Password history: when the password changes on an existing item, keep the
      // old one (capped at 10). Carry the existing history forward otherwise.
      if (prev && prev.password && body.password && prev.password !== body.password) {
        const hist = Array.isArray(prev.passwordHistory) ? prev.passwordHistory.slice() : [];
        hist.unshift({ password: prev.password, at: prev.modifiedAt || prev.createdAt || Date.now() });
        body.passwordHistory = hist.slice(0, 10);
      } else if (prev && Array.isArray(prev.passwordHistory) && !body.passwordHistory) {
        body.passwordHistory = prev.passwordHistory;
      }
      const ts = this._now();
      body.modifiedAt = ts;
      return { id, kind, enc: await VC.encrypt(this.dek, body), updatedAt: ts, deleted: false };
    }

    // Create/replace an item. `body` is the plaintext object (everything except
    // id/kind/updatedAt/deleted). Returns the stored decrypted item.
    async save(item) {
      const doc = await this._buildDoc(item);
      await this.backend.putItem(doc);
      await this._ingest(doc);
      this._emit();
      return this.get(doc.id);
    }

    // Batch write. Same per-item semantics as save(), but the change event
    // fires ONCE at the end — so a drag-reorder that touches eight cards
    // repaints the list once instead of eight times. Backends that debounce
    // their flush (the PWA's does) also coalesce this into a single cloud write.
    async saveMany(items) {
      const list = items || [];
      if (!list.length) return [];
      const docs = [];
      for (const item of list) docs.push(await this._buildDoc(item));
      for (const doc of docs) { await this.backend.putItem(doc); await this._ingest(doc); }
      this._emit();
      return docs.map((d) => this.get(d.id));
    }

    // Soft-delete (tombstone) so the deletion syncs to other devices.
    async remove(id) {
      const doc = { id, kind: (this._raw.get(id) || {}).kind || 'login', enc: null, updatedAt: this._now(), deleted: true };
      await this.backend.putItem(doc);
      await this._ingest(doc);
      this._emit();
    }

    // ── Config passthrough ───────────────────────────────────────────────────
    loadConfig() { return this.backend.loadConfig(); }
    saveConfig(config) { return this.backend.saveConfig(config); }
    destroy() { if (this._unsub) { this._unsub(); this._unsub = null; } this._listeners.clear(); }
  }

  // Field-weighted relevance scorer. Returns the best weighted match across an
  // item's fields; 0 = no match. Higher = better.
  //
  // Payment items (kind:'payment') contribute their own fields — nickname reads
  // like a title, and the LAST FOUR digits are searchable because that's how
  // people identify a card. The full card number and the CVV are deliberately
  // NOT searchable: otherwise typing digits would let a shoulder-surfer confirm
  // a PAN one guess at a time.
  //
  // ID documents (kind:'iddoc') add issuer, state/country, type and the
  // expiration YEAR — the things people actually recall about a licence. A
  // PARTIAL document number matches too, but only from three characters up:
  // that's enough to find "the passport ending 904" while still refusing to
  // confirm a number one keystroke at a time.
  const IDDOC_TYPE_LABELS = {
    drivers_license: 'driver license drivers licence dl', passport: 'passport',
    state_id: 'state id identification', ssn_card: 'social security ssn',
    birth_certificate: 'birth certificate', vehicle_registration: 'vehicle registration car auto',
    insurance_card: 'insurance health', student_id: 'student school',
    work_id: 'work employee badge', custom: 'custom document',
  };
  function scoreItem(it, q) {
    const fields = [
      [it.title, 20], [it.username, 9], [it.email, 9], [it.url, 7],
      [it.category, 4], [Array.isArray(it.tags) ? it.tags.join(' ') : '', 4],
      [Array.isArray(it.customFields) ? it.customFields.map((f) => (f && f.label) + ' ' + (f && f.value)).join(' ') : '', 3],
      [it.notes, 2],
    ];
    if (it.kind === 'payment') {
      fields.push(
        [it.nickname, 20], [it.last4, 12], [it.cardholder, 9],
        [it.network, 6], [it.type, 4],
        [it.billing ? [it.billing.line1, it.billing.city, it.billing.region, it.billing.postal, it.billing.country].filter(Boolean).join(' ') : '', 3]
      );
    }
    if (it.kind === 'iddoc') {
      fields.push(
        [it.issuer, 12], [it.region, 8], [it.country, 8],
        [IDDOC_TYPE_LABELS[it.docType] || it.docType, 7],
        [String(it.expirationDate || '').slice(0, 4), 6],   // expiration year
        [String(it.issueDate || '').slice(0, 4), 3],
        [it.description, 5], [it.group, 3]
      );
      if (q.length >= 3) fields.push([it.number, 10]);
    }
    let best = 0;
    for (const [val, weight] of fields) {
      if (!val) continue;
      const f = String(val).toLowerCase();
      let s = 0;
      if (f === q) s = 100;                                   // exact field match
      else if (f.startsWith(q)) s = 82;                       // field prefix
      else {
        const words = f.split(/[\s._@/\-]+/).filter(Boolean);
        if (words.some((w) => w.startsWith(q))) s = 66;       // a word starts with q
        else if (f.includes(q)) s = 52 - Math.min(20, f.indexOf(q)); // substring (earlier=better)
        else { const fz = fuzzyScore(f, q); if (fz > 0) s = Math.min(28, 8 + fz / 3); } // fuzzy
      }
      if (s > 0) { const ws = s * weight; if (ws > best) best = ws; }
    }
    return best;
  }

  // Subsequence-fuzzy score: rewards contiguous runs and word-start hits.
  function fuzzyScore(hay, q) {
    if (hay.includes(q)) return 1000 - hay.indexOf(q); // exact substring wins
    let hi = 0, score = 0, streak = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      let found = -1;
      for (let i = hi; i < hay.length; i++) { if (hay[i] === c) { found = i; break; } }
      if (found === -1) return 0;
      streak = found === hi ? streak + 1 : 0;
      score += 1 + streak * 2 + (found === 0 || hay[found - 1] === ' ' ? 3 : 0);
      hi = found + 1;
    }
    return score;
  }

  // ── In-memory backend (tests, and a template for the Firestore adapter) ────
  function memoryBackend() {
    let config = null;
    const items = new Map();
    const subs = new Set();
    const fire = () => subs.forEach((s) => { try { s(Array.from(items.values())); } catch (_) {} });
    return {
      async loadConfig() { return config ? JSON.parse(JSON.stringify(config)) : null; },
      async saveConfig(c) { config = JSON.parse(JSON.stringify(c)); },
      async listItems() { return Array.from(items.values()).map((d) => JSON.parse(JSON.stringify(d))); },
      async putItem(doc) { items.set(doc.id, JSON.parse(JSON.stringify(doc))); fire(); },
      subscribe(onItems) { subs.add(onItems); return () => subs.delete(onItems); },
      _raw: items, // test hook
    };
  }

  global.WardenStore = WardenStore;
  global.WardenStore.memoryBackend = memoryBackend;
  global.WardenStore.newId = newId;
  global.WardenStore._fuzzyScore = fuzzyScore;
  global.WardenStore._scoreItem = scoreItem;

  if (typeof module !== 'undefined' && module.exports) module.exports = global.WardenStore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
