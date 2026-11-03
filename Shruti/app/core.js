// Shruti core: who is here (profile), local storage that never throws, and the
// Firestore layer. Nothing here touches the network until boot() is called,
// and shruti.html only calls it after Guardian has opened the profile.
//
// Documents (Firestore task-dashboard-d2b53, the suite's project):
//   dashboards/shruti_shared  both profiles: the shared library and, per chapter,
//                             generated assets (podcast, video, study sets, versions)
//   dashboards/shruti         Tony:  orcaKey, units, progress, bookmarks, settings
//   dashboards/shruti_veda    Veda:  the same, hers
// Writes are field-path merges only (updateDoc with "a.b.c"), so two devices
// editing different fields never overwrite each other, and nothing is written
// before a first successful read of that document (MyList's write barrier).

const FB = 'https://www.gstatic.com/firebasejs/12.12.0/';
const CONFIG = {
  apiKey: 'AIzaSyC2aKunOKj5WS8NpgZhpyMzOYecBr5t2_4',
  authDomain: 'task-dashboard-d2b53.firebaseapp.com',
  projectId: 'task-dashboard-d2b53',
  storageBucket: 'task-dashboard-d2b53.firebasestorage.app',
  messagingSenderId: '982539604706',
  appId: '1:982539604706:web:e93da1aef499fcee2044bb',
};
const RECAPTCHA = '6LeUyAstAAAAAEciRypd1i4Akq6ueFUYfXLaLaUX';

/* ── profile ──────────────────────────────────────────────────────────────── */
// Resolved by the inline script in shruti.html's <head> (before first paint),
// which also declared the Guardian lock. Read back here.
export const PROFILES = window.SHRUTI_PROFILES;
export const P = window.SHRUTI_PROFILE;            // 'tony' | 'veda' | null (picker)
export const prof = () => PROFILES[P];
export const lsKey = (name) => 'shruti.' + P + '.' + name;

/** Books that ship in the repo (books/<id>/); every other book was imported
 *  (books.js) and has no shipped media, study sets or lessons to fetch. */
export const SHIPPED = ['gita'];
export const isShipped = (id) => SHIPPED.includes(id);

/* ── storage that never throws (Veda's Brave blocks it; a full store throws on write) */
export const ls = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, String(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  json(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  put(k, o) { try { localStorage.setItem(k, JSON.stringify(o)); return true; } catch (e) { return false; } },
};

/* ── tiny event bus ───────────────────────────────────────────────────────── */
const subs = {};
export function on(ev, fn) { (subs[ev] = subs[ev] || []).push(fn); return () => { subs[ev] = subs[ev].filter((f) => f !== fn); }; }
export function emit(ev, data) { (subs[ev] || []).slice().forEach((f) => { try { f(data); } catch (e) { console.error(e); } }); }

/* ── paths inside a document ──────────────────────────────────────────────── */
export function getPath(o, path) {
  return String(path).split('.').reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), o);
}
export function setPath(o, path, v) {
  const ks = String(path).split('.');
  let cur = o;
  for (let i = 0; i < ks.length - 1; i++) {
    if (!cur[ks[i]] || typeof cur[ks[i]] !== 'object') cur[ks[i]] = {};
    cur = cur[ks[i]];
  }
  if (v === undefined) delete cur[ks[ks.length - 1]]; else cur[ks[ks.length - 1]] = v;
  return o;
}
// {"a.b": 1, "a.c": 2} -> {a: {b: 1, c: 2}}, for the first write of a missing document.
export function nest(flat) {
  const o = {};
  for (const [k, v] of Object.entries(flat)) setPath(o, k, v);
  return o;
}

/* ── Firestore ────────────────────────────────────────────────────────────── */
let fb = null;                 // { app, db, fs }
let fbReady = null;
export function firebase() {
  if (fbReady) return fbReady;
  fbReady = (async () => {
    const [appM, authM, acM, fs] = await Promise.all([
      import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'),
      import(FB + 'firebase-app-check.js'), import(FB + 'firebase-firestore.js'),
    ]);
    const app = appM.initializeApp(CONFIG);
    try { acM.initializeAppCheck(app, { provider: new acM.ReCaptchaV3Provider(RECAPTCHA), isTokenAutoRefreshEnabled: true }); }
    catch (e) { console.warn('App Check init', e); }
    const auth = authM.getAuth(app);
    const authed = new Promise((res) => authM.onAuthStateChanged(auth, (u) => { if (u) res(); }));
    authM.signInAnonymously(auth).catch((e) => console.warn('Anonymous sign-in failed', e));
    await Promise.race([authed, new Promise((r) => setTimeout(r, 4000))]);
    // Memory cache: every A1 page shares one IndexedDB cache, and TaskHub takes
    // its lease back on wake (shared-firestore-cache-lease).
    const db = fs.initializeFirestore(app, { localCache: fs.memoryLocalCache() });
    fb = { app, db, fs };
    return fb;
  })();
  return fbReady;
}
// Tests hand in a fake Firestore ({db, fs}) instead of the network one.
export function _useFirebase(f) { fb = f; fbReady = Promise.resolve(f); }
// LifeHub shares this Firestore instead of starting its own.
window.LifeHubFirebase = () => firebase().then((f) => ({ db: f.db, fs: f.fs }));

/* The header has one sync pill for both documents: it shows the worse of the two
 * (failed over syncing over synced), so one doc recovering does not hide the other. */
const docSync = {};
function report(name, kind) {
  docSync[name] = kind;
  const v = Object.values(docSync);
  emit('sync', v.includes('err') ? 'err' : v.includes('busy') ? 'busy' : 'ok');
}

/** One synced document: live snapshot, local echo, throttled field-path writes. */
export class Doc {
  constructor(path, name) {
    this.path = path; this.name = name;
    this.data = {}; this.loaded = false; this.error = null;
    this.pending = {}; this.timer = null; this.writing = null; this.unsub = null;
    this.retries = 0; this.retryTimer = null;
  }
  async start() {
    const { db, fs } = await firebase();
    this.ref = fs.doc(db, this.path);
    this.listen();
  }
  /** A snapshot error ends Firestore's listener for good, so listen again after
   *  a pause (2, 4, 8 … 30 s), and at once when the network comes back. Without
   *  this, one slow start (sign-in late, the network briefly gone) left "Sync
   *  failed" up until the next reload, which often failed the same way. */
  listen() {
    const { fs } = fb;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    if (this.unsub) this.unsub();
    this.unsub = fs.onSnapshot(this.ref, (snap) => {
      // A delivered snapshot proves reads work: that alone lifts the write barrier.
      const first = !this.loaded, back = !!this.error;
      this.loaded = true; this.error = null; this.retries = 0;
      if ((first || back) && !this.writing) report(this.name, 'ok');
      const d = snap.exists() ? snap.data() : {};
      // Keep what this device has not sent yet on top of the server copy.
      for (const [k, v] of Object.entries(this.pending)) setPath(d, k, v === DELETE ? undefined : v);
      this.data = d;
      emit('doc:' + this.name, { remote: !snap.metadata.hasPendingWrites, data: d });
      if (Object.keys(this.pending).length && !this.timer) this.flushSoon(400);
    }, (err) => {
      console.warn('Shruti snapshot ' + this.path, err);
      this.error = err; this.unsub = null;
      // Still starting: say "syncing" while it tries again, "failed" only once it keeps failing.
      report(this.name, this.retries < 2 && !this.loaded ? 'busy' : 'err');
      this.retryTimer = setTimeout(() => this.listen(), Math.min(30000, 2000 * 2 ** this.retries++));
    });
  }
  stop() { clearTimeout(this.retryTimer); this.retryTimer = null; if (this.unsub) this.unsub(); this.unsub = null; }
  get(path, d) { const v = getPath(this.data, path); return v === undefined ? d : v; }
  /** Change fields: {"progress.gita.ch2.f": 0.4, ...}. Applied here at once; sent
   *  soon, at once (now), or for progress (lazy) within 30 s, riding along with
   *  any sooner write. Hiding the page sends whatever is waiting. */
  set(fields, { now = false, lazy = false } = {}) {
    for (const [k, v] of Object.entries(fields)) { this.pending[k] = v; setPath(this.data, k, v === DELETE ? undefined : v); }
    emit('doc:' + this.name, { remote: false, data: this.data });
    if (lazy) { if (!this.timer) this.flushSoon(30000); }
    else this.flushSoon(now ? 0 : 1200);
  }
  flushSoon(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, ms);
  }
  async flush() {
    if (!this.ref || !Object.keys(this.pending).length) return;
    // The write barrier: never write a document we have not read. The first
    // snapshot sends what is waiting, so this is not a failure.
    if (!this.loaded) return;
    if (this.writing) { await this.writing.catch(() => {}); return this.flush(); }
    const batch = this.pending; this.pending = {};
    const { fs } = fb;
    const out = {};
    for (const [k, v] of Object.entries(batch)) out[k] = v === DELETE ? fs.deleteField() : v;
    report(this.name, 'busy');
    this.writing = (async () => {
      try { await fs.updateDoc(this.ref, out); }
      catch (e) {
        if (e && e.code === 'not-found') {
          const first = {};
          for (const [k, v] of Object.entries(batch)) if (v !== DELETE) first[k] = v;
          await fs.setDoc(this.ref, nest(first), { merge: true });
        } else throw e;
      }
    })();
    try { await this.writing; report(this.name, this.error ? 'err' : 'ok'); }
    catch (e) {
      console.warn('Shruti save ' + this.path, e);
      // Put it back (unless something newer replaced it) and try again later.
      for (const [k, v] of Object.entries(batch)) if (!(k in this.pending)) this.pending[k] = v;
      report(this.name, 'err');
      this.flushSoon(15000);
    } finally { this.writing = null; }
  }
}
export const DELETE = { __delete: true };

export const me = new Doc('dashboards/' + (P ? PROFILES[P].doc : 'shruti'), 'me');
export const shared = new Doc('dashboards/shruti_shared', 'shared');

/** The person's Orca key. It syncs in their doc; this device keeps a copy so the
 *  AI and read-aloud work while sync is still starting or cannot reach Firestore
 *  (before, Settings then said "No key yet"). Once the doc has loaded, the doc wins. */
export function orcaKey() {
  const k = String(me.get('orcaKey', '') || '');
  if (!me.loaded) return k || ls.get(lsKey('orcaKey'), '') || '';
  if (k !== (ls.get(lsKey('orcaKey'), '') || '')) { if (k) ls.set(lsKey('orcaKey'), k); else ls.del(lsKey('orcaKey')); }
  return k;
}

let booted = false;
export async function boot() {
  if (booted) return; booted = true;
  emit('sync', 'busy');
  try { await Promise.all([me.start(), shared.start()]); }
  catch (e) { console.warn('Shruti Firebase', e); emit('sync', 'err'); }
}
// Leaving or hiding the page sends what is waiting.
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { me.flush(); shared.flush(); } });
addEventListener('pagehide', () => { me.flush(); shared.flush(); });
// Back online: a listener that failed tries again now, not after its pause.
addEventListener('online', () => { for (const d of [me, shared]) if (d.ref && d.error) d.listen(); });
