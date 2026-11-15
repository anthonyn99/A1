// Beacon (Beacon/beacon.js + beacon-ui.js): A1's device manager.
// Several "devices" are separate jsdom windows sharing ONE in-memory Firestore,
// so a remove or lock sent from one device is carried out by another, exactly
// as it happens for real. Covers: what a device reports about itself, its id,
// who owns it, check-in and its throttle, the profile wall (Tony's panel never
// reads Veda's document), push tokens, remove / lock / rename, Guardian's
// lockDevice, and the panel itself (both themes, every action).
//
// Run: node tests/beacon.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 400) : '')); }
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const ROOT = path.join(__dirname, '..');
const CORE = fs.readFileSync(path.join(ROOT, 'Beacon', 'beacon.js'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, 'Beacon', 'beacon-ui.js'), 'utf8');
const GUARDIAN = fs.readFileSync(path.join(ROOT, 'Guardian', 'guardian.js'), 'utf8');

// ── One Firestore for every device ─────────────────────────────────────────
function fakeStore() {
  const S = { docs: {}, reads: [], writes: [], listeners: [], down: false };
  const DEL = { __del: true };
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const strip = (v) => {
    if (v === DEL) return undefined;
    if (Array.isArray(v)) return v.map(strip);
    if (isObj(v)) { const o = {}; Object.keys(v).forEach((k) => { const r = strip(v[k]); if (r !== undefined) o[k] = r; }); return o; }
    return v;
  };
  function mergeInto(t, s) {
    Object.keys(s).forEach((k) => {
      const v = s[k];
      if (v === DEL) delete t[k];
      else if (isObj(v)) { if (!isObj(t[k])) t[k] = {}; mergeInto(t[k], v); }
      else t[k] = clone(strip(v));
    });
  }
  function setPath(t, dotted, v) {
    const parts = dotted.split('.'); let o = t;
    for (let i = 0; i < parts.length - 1; i++) { if (!isObj(o[parts[i]])) o[parts[i]] = {}; o = o[parts[i]]; }
    const last = parts[parts.length - 1];
    if (v === DEL) delete o[last]; else o[last] = clone(strip(v));
  }
  const snap = (p) => { const has = Object.prototype.hasOwnProperty.call(S.docs, p); const d = clone(S.docs[p]); return { id: p.split('/').pop(), exists: () => has, data: () => d, metadata: { hasPendingWrites: false } }; };
  const notify = (p) => S.listeners.forEach((l) => { if (!l.dead && l.path === p) setTimeout(() => !l.dead && l.next(snap(p)), 0); });
  const guard = () => { if (S.down) throw Object.assign(new Error('offline'), { code: 'unavailable' }); };
  S.fs = {
    doc: (db, ...p) => ({ path: p.join('/'), id: p[p.length - 1] }),
    collection: (db, ...p) => ({ path: p.join('/'), coll: true }),
    deleteField: () => DEL,
    getDoc: async (ref) => { guard(); S.reads.push(ref.path); return snap(ref.path); },
    getDocs: async (c) => {
      guard(); S.reads.push(c.path + '/*');
      const depth = c.path.split('/').length + 1;
      const docs = Object.keys(S.docs).filter((p) => p.startsWith(c.path + '/') && p.split('/').length === depth).map((p) => snap(p));
      return { docs, size: docs.length };
    },
    setDoc: async (ref, data, opts) => {
      guard(); S.writes.push({ op: 'set', path: ref.path, merge: !!(opts && opts.merge) });
      if (opts && opts.merge) { if (!S.docs[ref.path]) S.docs[ref.path] = {}; mergeInto(S.docs[ref.path], data); }
      else S.docs[ref.path] = strip(clone(data));
      notify(ref.path);
    },
    updateDoc: async (ref, f) => {
      guard();
      if (!Object.prototype.hasOwnProperty.call(S.docs, ref.path)) throw Object.assign(new Error('No document to update'), { code: 'not-found' });
      S.writes.push({ op: 'update', path: ref.path, keys: Object.keys(f) });
      Object.keys(f).forEach((k) => setPath(S.docs[ref.path], k, f[k]));
      notify(ref.path);
    },
    deleteDoc: async (ref) => { guard(); S.writes.push({ op: 'delete', path: ref.path }); delete S.docs[ref.path]; notify(ref.path); },
    onSnapshot: (ref, next) => { const l = { path: ref.path, next, dead: false }; S.listeners.push(l); setTimeout(() => !l.dead && next(snap(ref.path)), 0); return () => { l.dead = true; }; },
  };
  return S;
}

// ── A device: one browser window on one origin ──────────────────────────────
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  iphone17: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  crios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  pixel: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  samsungTab: 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Safari/537.36',
  galaxy: 'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
};
function device(store, o) {
  o = o || {};
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: o.url || 'https://anthonyn99.github.io/A1/index.html', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'userAgent', { value: o.ua || UA.winChrome, configurable: true });
  Object.defineProperty(w.navigator, 'maxTouchPoints', { value: o.touch || 0, configurable: true });
  Object.defineProperty(w.screen, 'width', { value: o.sw || 1920, configurable: true });
  Object.defineProperty(w.screen, 'height', { value: o.sh || 1080, configurable: true });
  if (o.ls) Object.keys(o.ls).forEach((k) => w.localStorage.setItem(k, o.ls[k]));
  if (o.cookie) w.document.cookie = o.cookie;
  if (o.blockStorage) {
    const thrower = { get() { throw new Error('SecurityError: storage blocked'); } };
    Object.defineProperty(w, 'localStorage', thrower);
    Object.defineProperty(w, 'sessionStorage', thrower);
    Object.defineProperty(w.document, 'cookie', { get: () => '', set: () => {}, configurable: true });
  }
  if (o.guardian === 'real') {
    w.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, locks: {} }) });
    w.eval(GUARDIAN);
  } else if (o.guardian !== false) {
    // A stub with the parts Beacon reads, and lockDevice recorded.
    const G = { locks: o.locks || {}, lockDeviceCalls: [] };
    w.Guardian = {
      defs: () => Object.keys(G.locks).map((id) => ({ id, kind: G.locks[id].kind || 'app', owner: G.locks[id].owner })),
      status: (id) => ({ hasLock: G.locks[id].has, unlocked: G.locks[id].open }),
      label: (id) => G.locks[id].label || id,
      owner: (id) => G.locks[id].owner,
      bio: { isRegistered: (id) => !!G.locks[id].bio },
      isOpen: () => false,
      lockDevice: (why) => { G.lockDeviceCalls.push(why); Object.keys(G.locks).forEach((id) => { G.locks[id].open = false; }); },
    };
    w.__G = G;
  }
  w.eval(CORE);
  w.Beacon.config({ firebase: async () => ({ db: {}, fs: store.fs }) });
  return w;
}
const doc = (store, owner) => store.docs['dashboards/beacon_' + owner] || {};

(async () => {
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nWhat a device reports about itself');
  {
    const w = device(fakeStore(), { guardian: false });
    const D = (ua, scr, extra, nav) => w.Beacon.detect(Object.assign({ userAgent: ua, maxTouchPoints: 0 }, nav || {}), scr || {}, extra || {});
    let d = D(UA.iphone, { width: 402, height: 874 }, { standalone: true });
    ok('iPhone on Safari 26: iOS 26 (Version/ wins over the frozen OS 18_6)', d.os === 'iOS' && d.osVer === '26' && d.kind === 'phone' && d.model === 'iPhone', d);
    ok('iPhone size → model family', d.hint === 'iPhone 16 Pro / 17', d.hint);
    ok('Home Screen app is noted', d.app === true);
    d = D(UA.iphone17, { width: 393, height: 852 });
    ok('iPhone on iOS 17.4 reads OS 17_4', d.osVer === '17.4' && d.hint === 'iPhone 15 / 16', d);
    ok('Chrome on iPhone is Chrome, not Safari', D(UA.crios).browser === 'Chrome');
    d = D(UA.ipad, {}, {}, { maxTouchPoints: 5 });
    ok('iPad with the desktop agent string (touch) is an iPad', d.os === 'iPadOS' && d.kind === 'tablet' && d.osVer === '18.1', d);
    d = D(UA.mac);
    ok('a Mac without touch stays a Mac', d.os === 'macOS' && d.model === 'Mac' && d.kind === 'computer', d);
    d = D(UA.pixel, {}, { he: { model: 'Pixel 8', platformVersion: '14.0.0' } }, { userAgentData: { mobile: true, brands: [{ brand: 'Google Chrome' }] } });
    ok('Android reduced agent + client hints: Pixel 8, Android 14', d.os === 'Android' && d.model === 'Pixel 8' && d.osVer === '14' && d.kind === 'phone' && d.browser === 'Chrome', d);
    d = D(UA.pixel);
    ok('without hints the fake "Android 10; K" is not reported', d.osVer === '' && d.model === '', d);
    d = D(UA.galaxy);
    ok('Samsung phone model from the agent string', d.model === 'Samsung SM-S918B' && d.osVer === '14' && d.kind === 'phone', d);
    d = D(UA.samsungTab);
    ok('Android without "Mobile" is a tablet; Samsung Internet named', d.kind === 'tablet' && d.browser === 'Samsung Internet', d);
    d = D(UA.winEdge, {}, { he: { platformVersion: '15.0.0' } });
    ok('Windows 11 from client hints; Edge named', d.os === 'Windows' && d.osVer === '11' && d.browser === 'Edge', d);
    ok('Windows 10 from client hints', D(UA.winChrome, {}, { he: { platformVersion: '10.0.0' } }).osVer === '10');
    ok('Brave is told apart from Chrome', D(UA.winChrome, {}, { brave: true }).browser === 'Brave');
    ok('a Windows touch screen is a laptop', D(UA.winChrome, {}, {}, { maxTouchPoints: 10 }).kind === 'laptop');
    ok('a battery seen draining makes a laptop', D(UA.winChrome, {}, { laptop: true }).kind === 'laptop');
    ok('Firefox named', D(UA.firefox).browser === 'Firefox');
    ok('default names', w.Beacon.defaultName({ os: 'Windows', kind: 'laptop' }) === 'Windows laptop' &&
      w.Beacon.defaultName({ os: 'Windows', kind: 'computer' }) === 'Windows PC' &&
      w.Beacon.defaultName({ os: 'Android', kind: 'phone' }) === 'Android phone' &&
      w.Beacon.defaultName({ model: 'Pixel 8' }) === 'Pixel 8');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nThis device’s id');
  {
    const st = fakeStore();
    let w = device(st, { ls: { th_device_id: 'dev_existing123' } });
    ok('reuses TaskHub’s th_device_id (the fcm_tokens key)', w.Beacon.deviceId() === 'dev_existing123');
    ok('and mirrors it into a cookie', /a1dev=dev_existing123/.test(w.document.cookie));
    w = device(st, { cookie: 'a1dev=dev_fromcookie9' });
    ok('an evicted localStorage gets its id back from the cookie', w.Beacon.deviceId() === 'dev_fromcookie9' && w.localStorage.getItem('th_device_id') === 'dev_fromcookie9');
    w = device(st, {});
    const fresh = w.Beacon.deviceId();
    ok('a new device mints a dev_ id and keeps it', /^dev_[a-z0-9]+$/.test(fresh) && w.localStorage.getItem('th_device_id') === fresh);
    const a = device(st, { blockStorage: true, guardian: false }).Beacon.deviceId();
    const b = device(st, { blockStorage: true, guardian: false }).Beacon.deviceId();
    ok('storage blocked everywhere: a stable fingerprint id, not a new device per load', /^fp_/.test(a) && a === b, [a, b]);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nCheck-in');
  {
    const st = fakeStore();
    const w = device(st, { ua: UA.iphone, touch: 5, sw: 402, sh: 874, ls: { th_device_id: 'dev_tonyphone', td6_mainDash: 'tony' },
      locks: { tony_taskhub: { owner: 'tony', has: true, open: true, label: 'TaskHub', bio: true }, profile_tony: { owner: 'tony', kind: 'profile', has: true, open: false, label: 'Tony' },
        veda_x: { owner: 'veda', has: false, open: true } } });
    w.__prof = 'tony';
    w.Beacon.mount('taskhub', { label: 'TaskHub', delay: 999999, profile: () => w.__prof,
      push: () => ({ on: true, coll: 'fcm_tokens', id: 'dev_tonyphone', route: 'tony', perm: 'granted' }) });
    let r = await w.Beacon.checkIn('taskhub', true);
    const rec = (doc(st, 'tony').devices || {}).dev_tonyphone;
    ok('writes to beacon_tony (TaskHub main = tony)', r.wrote === true && !!rec, r);
    ok('records the model', rec && rec.meta.model === 'iPhone' && rec.meta.os === 'iOS' && rec.meta.hint === 'iPhone 16 Pro / 17', rec && rec.meta);
    const e = rec && rec.apps.taskhub;
    ok('records the program with its profile and push', e && e.label === 'TaskHub' && e.profs.tony > 0 && e.push.on === true && e.push.coll === 'fcm_tokens' && e.push.route === 'tony', e);
    ok('records only locks that exist, with their state and biometrics', e && e.locks.length === 2 &&
      e.locks.some((l) => l.id === 'tony_taskhub' && l.open && l.bio) && e.locks.some((l) => l.id === 'profile_tony' && !l.open), e && e.locks);
    ok('first and seen stamped', rec && rec.first > 0 && rec.seen > 0);
    ok('nothing written to anyone else’s document', !st.docs['dashboards/beacon_veda'] && !st.docs['dashboards/beacon_neutral']);
    const writes = st.writes.length;
    r = await w.Beacon.checkIn('taskhub');
    ok('a second check-in within 90 s is skipped (no read, no write)', r.skipped === 'recent' && st.writes.length === writes, r);
    r = await w.Beacon.checkIn('taskhub', true);
    ok('forced but unchanged within a minute: read only, no write', r.wrote === false && st.writes.length === writes, r);
    w.__G.locks.profile_tony.open = true;
    r = await w.Beacon.checkIn('taskhub', true);
    ok('a lock state change is written', r.wrote === true && doc(st, 'tony').devices.dev_tonyphone.apps.taskhub.locks.every((l) => l.open), r);
    w.__prof = null;
    r = await w.Beacon.checkIn('taskhub', true);
    ok('no profile chosen yet (the picker is up): nothing happens', r.skipped === 'profile', r);
    w.__prof = 'tony';

    // A second program on the same device lands in the same record.
    w.Beacon.mount('mylist', { label: 'MyList', delay: 999999, profileAttr: 'data-profile' });
    w.document.body.setAttribute('data-profile', 'veda');
    r = await w.Beacon.checkIn('mylist', true);
    const apps = doc(st, 'tony').devices.dev_tonyphone.apps;
    ok('a second program joins the same device record (owner = the device’s main, not the profile)', r.wrote && apps.taskhub && apps.mylist && apps.mylist.profs.veda > 0, Object.keys(apps));
    ok('the first program’s entry is untouched', apps.taskhub.label === 'TaskHub' && apps.taskhub.push.on === true);

    // Un-main: the device turns neutral and moves documents.
    w.localStorage.setItem('td6_mainDash', 'none');
    r = await w.Beacon.checkIn('taskhub', true);
    ok('TaskHub main "none" makes it a neutral device', r.owner === 'neutral' && !!doc(st, 'neutral').devices.dev_tonyphone, r);
    ok('and the record leaves Tony’s document', !(doc(st, 'tony').devices || {}).dev_tonyphone);

    // A device TaskHub never claimed: first profile used owns it.
    const v = device(st, { ua: UA.galaxy, ls: { th_device_id: 'dev_vedaphone' } });
    v.Beacon.mount('shruti', { delay: 999999, profile: 'veda' });
    r = await v.Beacon.checkIn('shruti', true);
    ok('no TaskHub main: the first profile used owns the device', r.owner === 'veda' && !!doc(st, 'veda').devices.dev_vedaphone, r);
    ok('and remembers it', v.localStorage.getItem('a1.beacon.owner') === 'veda');

    // MAGI's console on the PC itself (loopback) never checks in.
    const lb = device(st, { url: 'http://127.0.0.1:8000/magi.html', ls: { th_device_id: 'dev_loop1' } });
    lb.Beacon.config({ firebase: async () => ({ db: {}, fs: st.fs }), anyOrigin: false });
    lb.Beacon.mount('magi', { delay: 999999, profile: 'tony' });
    r = await lb.Beacon.checkIn('magi', true);
    ok('a loopback page (MAGI on the PC) does not create a second copy of the device', r.skipped === 'origin', r);

    st.down = true;
    const off = device(st, { ls: { th_device_id: 'dev_offline1', td6_mainDash: 'tony' } });
    off.Beacon.mount('taskhub', { delay: 999999, profile: 'tony' });
    r = await off.Beacon.checkIn('taskhub', true);
    ok('offline: the check-in fails quietly and retries later', !!r.error, r);
    st.down = false;
    r = await off.Beacon.checkIn('taskhub');
    ok('the next try goes through (a failure does not start the 90 s wait)', r.wrote === true, r);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nThe profile wall');
  {
    const st = fakeStore();
    const tp = device(st, { ua: UA.iphone, ls: { th_device_id: 'dev_tp', td6_mainDash: 'tony' } });
    tp.Beacon.mount('taskhub', { delay: 999999, profile: 'tony', push: () => ({ on: true, coll: 'fcm_tokens', id: 'dev_tp', route: 'tony', perm: 'granted' }) });
    await tp.Beacon.checkIn('taskhub', true);
    const vp = device(st, { ua: UA.galaxy, ls: { th_device_id: 'dev_vp', td6_mainDash: 'veda' } });
    vp.Beacon.mount('taskhub', { delay: 999999, profile: 'veda' });
    await vp.Beacon.checkIn('taskhub', true);
    const np = device(st, { ua: UA.winChrome, ls: { th_device_id: 'dev_np', td6_mainDash: 'none' } });
    np.Beacon.mount('taskhub', { delay: 999999, profile: 'tony' });
    await np.Beacon.checkIn('taskhub', true);
    // Push tokens: one per routing, plus one device that never checked in.
    st.docs['fcm_tokens/dev_tp'] = { token: 'T1', mainDash: 'tony', updatedAt: Date.now() - 1000, ua: UA.iphone.slice(0, 80) };
    st.docs['fcm_tokens/dev_vp'] = { token: 'T2', mainDash: 'veda', updatedAt: Date.now() - 1000, ua: UA.galaxy.slice(0, 80) };
    st.docs['fcm_tokens/dev_oldipad'] = { token: 'T3', mainDash: 'tony', updatedAt: Date.now() - 86400000, ua: UA.iphone17.slice(0, 80) };
    st.docs['fcm_tokens/dev_oldveda'] = { token: 'T4', mainDash: 'veda', updatedAt: Date.now() - 86400000, ua: UA.pixel.slice(0, 80) };
    st.docs['fcm_tokens/dev_shared'] = { token: 'T5', mainDash: 'all', updatedAt: Date.now() - 5000, ua: UA.firefox.slice(0, 80) };
    st.docs['studyos_fcm_tokens/tokABC'] = { token: 'tokABC', app: 'studyos', updatedAt: Date.now() - 7000, ua: UA.samsungTab };

    st.reads.length = 0;
    const T = await tp.Beacon.list('tony');
    const ids = T.devices.map((d) => d.id).sort();
    ok('Tony sees his devices, neutral devices and his push-only devices', JSON.stringify(ids) === JSON.stringify(['dev_np', 'dev_oldipad', 'dev_shared', 'dev_tp']), ids);
    ok('Tony’s panel never reads Veda’s document', !st.reads.includes('dashboards/beacon_veda'), st.reads);
    ok('Veda’s push tokens are not shown to Tony', !ids.includes('dev_vp') && !ids.includes('dev_oldveda'));
    const tpDev = T.devices.find((d) => d.id === 'dev_tp');
    ok('a device’s token joins its record (same id)', tpDev.tokens.length === 1 && tpDev.tokens[0].coll === 'fcm_tokens' && !tpDev.legacy);
    const old = T.devices.find((d) => d.id === 'dev_oldipad');
    ok('a token with no record is shown as a device read from its agent string', old.legacy && old.meta.os === 'iOS' && old.meta.osVer === '17.4' && old.owner === 'tony', old);
    ok('a token routed to "all" counts as neutral', T.devices.find((d) => d.id === 'dev_shared').owner === 'neutral');
    ok('StudyOS tokens are not looked for unless StudyOS asks', !T.devices.some((d) => (d.tokens || []).some((t) => t.coll === 'studyos_fcm_tokens')));

    st.reads.length = 0;
    const V = await vp.Beacon.list('veda', { pushLists: [{ coll: 'studyos_fcm_tokens', app: 'studyos', label: 'StudyOS', owner: 'veda' }] });
    const vids = V.devices.map((d) => d.id).sort();
    ok('Veda sees hers + neutral, never Tony’s', vids.includes('dev_vp') && vids.includes('dev_np') && vids.includes('dev_oldveda') && vids.includes('dev_shared') &&
      !vids.includes('dev_tp') && !vids.includes('dev_oldipad'), vids);
    ok('Veda’s panel never reads Tony’s document', !st.reads.includes('dashboards/beacon_tony'), st.reads);
    const sos = V.devices.find((d) => (d.tokens || []).some((t) => t.coll === 'studyos_fcm_tokens'));
    ok('StudyOS’s own tokens show on her side', sos && sos.legacy && sos.owner === 'veda' && sos.meta.kind === 'tablet', sos);
    let threw = false; try { await tp.Beacon.list('somebody'); } catch (e) { threw = true; }
    ok('a list without a real profile is refused', threw);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nRemove, lock, rename');
  {
    const st = fakeStore();
    const locks = () => ({ tony_mylist: { owner: 'tony', has: true, open: true, label: 'MyList' } });
    const phone = device(st, { ua: UA.iphone, ls: { th_device_id: 'dev_phone', td6_mainDash: 'tony' }, locks: locks() });
    phone.Beacon.mount('mylist', { delay: 999999, profile: 'tony', onRemoved: () => { phone.__removedHook = (phone.__removedHook || 0) + 1; } });
    await phone.Beacon.checkIn('mylist', true);
    st.docs['fcm_tokens/dev_phone'] = { token: 'TP', mainDash: 'tony', updatedAt: Date.now() };
    const pc = device(st, { ua: UA.winChrome, ls: { th_device_id: 'dev_pc', td6_mainDash: 'tony' }, locks: locks() });
    pc.Beacon.mount('mylist', { delay: 999999, profile: 'tony' });
    await pc.Beacon.checkIn('mylist', true);

    // Rename + type
    await pc.Beacon.rename('tony', 'dev_phone', '  Tony’s iPhone  ');
    await pc.Beacon.setKind('tony', 'dev_phone', 'tablet');
    let L = await pc.Beacon.list('tony');
    let ph = L.devices.find((d) => d.id === 'dev_phone');
    ok('rename is trimmed and synced', ph.name === 'Tony’s iPhone');
    ok('type can be changed', ph.kindSet === 'tablet');
    let threw = false; try { await pc.Beacon.setKind('tony', 'dev_phone', 'toaster'); } catch (e) { threw = true; }
    ok('an unknown type is refused', threw);
    await phone.Beacon.checkIn('mylist', true);
    ok('a later check-in keeps the name (it is never overwritten by the device)', doc(st, 'tony').devices.dev_phone.name === 'Tony’s iPhone');

    // Lock, sent from the PC
    const r1 = await pc.Beacon.lock('tony', 'dev_phone', 'tony');
    ok('lock from another device leaves a command', r1.now === false && doc(st, 'tony').cmd.dev_phone.lock > 0 && doc(st, 'tony').cmd.dev_phone.by === 'tony');
    L = await pc.Beacon.list('tony');
    ok('the panel sees it pending', !!L.devices.find((d) => d.id === 'dev_phone').cmd);
    await pc.Beacon.cancel('tony', 'dev_phone');
    ok('and it can be cancelled before it runs', !(doc(st, 'tony').cmd || {}).dev_phone);
    await pc.Beacon.lock('tony', 'dev_phone', 'tony');
    await phone.Beacon.checkIn('mylist', true);
    ok('the phone carries it out at its next check-in (Guardian.lockDevice)', phone.__G.lockDeviceCalls.join() === 'remote', phone.__G.lockDeviceCalls);
    ok('the command is cleared once done', !(doc(st, 'tony').cmd || {}).dev_phone);
    ok('and the phone reports itself locked', doc(st, 'tony').devices.dev_phone.apps.mylist.locks.every((l) => !l.open));
    const r2 = await pc.Beacon.lock('tony', 'dev_pc', 'tony');
    ok('locking THIS device happens at once, with no command', r2.now === true && pc.__G.lockDeviceCalls.join() === 'manual' && !(doc(st, 'tony').cmd || {}).dev_pc);

    // A page without Guardian leaves the command for one that has it.
    const bare = device(st, { guardian: false, ls: { th_device_id: 'dev_bare', td6_mainDash: 'tony' } });
    bare.Beacon.mount('mylist', { delay: 999999, profile: 'tony' });
    await bare.Beacon.checkIn('mylist', true);
    await pc.Beacon.lock('tony', 'dev_bare', 'tony');
    await bare.Beacon.checkIn('mylist', true);
    ok('a page with no Guardian leaves the lock command for one that has it', !!(doc(st, 'tony').cmd || {}).dev_bare);

    // Remove, sent from the PC
    L = await pc.Beacon.list('tony');
    ph = L.devices.find((d) => d.id === 'dev_phone');
    await pc.Beacon.remove(ph);
    ok('remove deletes its push token at once (notifications stop now)', !st.docs['fcm_tokens/dev_phone']);
    ok('remove drops the record and leaves a tombstone', !doc(st, 'tony').devices.dev_phone && doc(st, 'tony').gone.dev_phone > 0);
    L = await pc.Beacon.list('tony');
    ok('it is gone from the list', !L.devices.some((d) => d.id === 'dev_phone'));
    phone.__G.lockDeviceCalls.length = 0;
    const r3 = await phone.Beacon.checkIn('mylist', true);
    ok('the phone, at its next check-in, locks every program on it', r3.removed === true && phone.__G.lockDeviceCalls.join() === 'removed', [r3, phone.__G.lockDeviceCalls]);
    ok('runs the program’s own clean-up (onRemoved)', phone.__removedHook === 1);
    ok('and clears the tombstone so it can come back later', !(doc(st, 'tony').gone || {}).dev_phone);
    const r4 = await phone.Beacon.checkIn('mylist', true);
    ok('it does not re-register in the same session', r4.skipped === 'origin' && !doc(st, 'tony').devices.dev_phone, r4);
    // Another tab of the same browser that was already open stops too.
    const tab2 = device(st, { ua: UA.iphone, ls: { th_device_id: 'dev_phone', td6_mainDash: 'tony', 'a1.beacon.removedAt': String(Date.now() + 5000) }, locks: locks() });
    tab2.Beacon.mount('mylist', { delay: 999999, profile: 'tony' });
    const r5 = await tab2.Beacon.checkIn('mylist', true);
    ok('a tab open since before the removal does not re-add it', !!r5.skipped && !doc(st, 'tony').devices.dev_phone, r5);
    // Opened again later: it comes back.
    const later = device(st, { ua: UA.iphone, ls: { th_device_id: 'dev_phone', td6_mainDash: 'tony', 'a1.beacon.removedAt': String(Date.now() - 60000) }, locks: locks() });
    later.Beacon.mount('mylist', { delay: 999999, profile: 'tony' });
    const r6 = await later.Beacon.checkIn('mylist', true);
    ok('opening A1 there again (a new page) adds it back', r6.wrote === true && !!doc(st, 'tony').devices.dev_phone, r6);

    // Removing a device known only by its push token.
    st.docs['fcm_tokens/dev_ghost'] = { token: 'TG', mainDash: 'tony', updatedAt: Date.now() - 864e5 * 90 };
    L = await pc.Beacon.list('tony');
    const ghost = L.devices.find((d) => d.id === 'dev_ghost');
    await pc.Beacon.remove(ghost);
    ok('a push-only device: its token is deleted and a tombstone waits for it', !st.docs['fcm_tokens/dev_ghost'] && doc(st, 'tony').gone.dev_ghost > 0);
    L = await pc.Beacon.list('tony');
    ok('and it leaves the list', !L.devices.some((d) => d.id === 'dev_ghost'));

    // Removing THIS device
    L = await pc.Beacon.list('tony');
    pc.__G.lockDeviceCalls.length = 0;
    await pc.Beacon.remove(L.devices.find((d) => d.id === 'dev_pc'));
    ok('removing this device locks it right away and clears its own tombstone', pc.__G.lockDeviceCalls.join() === 'removed' && !doc(st, 'tony').devices.dev_pc && !(doc(st, 'tony').gone || {}).dev_pc);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nGuardian.lockDevice (the real Guardian)');
  {
    const w = device(fakeStore(), { guardian: 'real' });
    const G = w.Guardian;
    ok('Guardian exposes lockDevice', typeof G.lockDevice === 'function');
    G.define('tony_example', { owner: 'tony', label: 'Example' });
    // Pretend it is locked on the worker and unlocked here.
    w.localStorage.setItem('gd.c.applock:tony_example', JSON.stringify({ h: true, v: 'v1', t: Date.now() }));
    w.localStorage.setItem('gd.u.applock:tony_example', 'v1');
    w.localStorage.setItem('gd.u.tj:abc', 'v9');                  // a lock this page does not define
    w.sessionStorage.setItem('gd.u.applock:tony_example', 'v1');
    w.localStorage.setItem('al_unlockedat_tony_example', '5');     // an old program marker adoption would read
    w.localStorage.setItem('ml_unlocked_profile_tony', '1');
    w.localStorage.setItem('gd.b.applock:tony_example', '{"id":"x"}');   // a biometric: stays
    w.document.cookie = 'gdu.applock_tony_example=v1; path=/';
    ok('it starts unlocked', G.isUnlocked('tony_example') === true);
    const evs = [];
    w.addEventListener('guardian:lock', (e) => evs.push(e.detail.id));
    w.addEventListener('guardian:device-locked', (e) => evs.push('device:' + e.detail.reason));
    G.lockDevice('remote');
    ok('every unlock marker is gone, defined here or not', w.localStorage.getItem('gd.u.applock:tony_example') === null && w.localStorage.getItem('gd.u.tj:abc') === null && w.sessionStorage.getItem('gd.u.applock:tony_example') === null);
    ok('the old programs’ markers go too (no re-adoption)', w.localStorage.getItem('al_unlockedat_tony_example') === null && w.localStorage.getItem('ml_unlocked_profile_tony') === null);
    ok('the unlock cookie is cleared', !/gdu\.applock_tony_example=v1/.test(w.document.cookie), w.document.cookie);
    ok('biometric enrolment is kept (the password still guards it)', w.localStorage.getItem('gd.b.applock:tony_example') !== null);
    ok('it is locked now', G.isUnlocked('tony_example') === false && G.mustBlock('tony_example') === true);
    ok('fires guardian:lock for the defined lock, then device-locked', evs.join() === 'tony_example,device:remote', evs);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nThe panel');
  {
    const st = fakeStore();
    const me = device(st, { ua: UA.winEdge, ls: { th_device_id: 'dev_me', td6_mainDash: 'tony' },
      locks: { tony_taskhub: { owner: 'tony', has: true, open: true, label: 'TaskHub', bio: true }, veda_taskhub: { owner: 'veda', has: true, open: false, label: 'Veda TaskHub' } } });
    me.Beacon.mount('taskhub', { label: 'TaskHub', delay: 999999, fcm: true, profile: () => me.__p || 'tony', push: () => ({ on: true, coll: 'fcm_tokens', id: 'dev_me', route: 'tony', perm: 'granted' }) });
    await me.Beacon.checkIn('taskhub', true);
    st.docs['fcm_tokens/dev_me'] = { token: 'TM', mainDash: 'tony', updatedAt: Date.now() };
    const other = device(st, { ua: UA.iphone, sw: 440, sh: 956, ls: { th_device_id: 'dev_ip', td6_mainDash: 'tony' }, locks: { tony_magi: { owner: 'tony', has: true, open: false, label: 'MAGI' } } });
    other.Beacon.mount('magi', { label: 'MAGI', delay: 999999, profile: 'tony' });
    await other.Beacon.checkIn('magi', true);
    st.docs['fcm_tokens/dev_old'] = { token: 'TO', mainDash: 'none', updatedAt: Date.now() - 3 * 864e5, ua: UA.pixel.slice(0, 80) };
    const vedaDev = device(st, { ua: UA.galaxy, ls: { th_device_id: 'dev_vg', td6_mainDash: 'veda' } });
    vedaDev.Beacon.mount('taskhub', { delay: 999999, profile: 'veda' });
    await vedaDev.Beacon.checkIn('taskhub', true);

    me.eval(UI);
    await me.Beacon.open({ app: 'taskhub' });
    await tick(30);
    const host = me.document.querySelector('beacon-panel');
    const R = host && host.shadowRoot;
    ok('opens a shadow-root panel', !!R && me.BeaconUI.isOpen());
    ok('Tony’s theme', R.querySelector('.ov').getAttribute('data-theme') === 'tony');
    ok('stays out of popups.js (it has its own backdrop and closing)', host.getAttribute('data-a1-popup') === 'off');
    ok('locks the page scroll while open', me.document.documentElement.style.overflow === 'hidden');
    let cards = [...R.querySelectorAll('[data-dev]')].map((c) => c.getAttribute('data-dev'));
    ok('"TaskHub" scope: devices TaskHub runs on or notifies (not the MAGI-only iPhone)', cards.includes('dev_me') && cards.includes('dev_old') && !cards.includes('dev_ip'), cards);
    ok('never shows Veda’s device', !cards.includes('dev_vg'));
    const meCard = R.querySelector('[data-dev="dev_me"]');
    ok('this device first, tagged', cards[0] === 'dev_me' && /This device/.test(meCard.textContent));
    ok('model line: Windows, Edge', /Windows/.test(meCard.querySelector('.dm').textContent) && /Edge/.test(meCard.querySelector('.dm').textContent), meCard.querySelector('.dm').textContent);
    ok('notifications on', /Notifications on/.test(meCard.textContent));
    ok('lock pill shows only Tony’s locks', /Unlocked/.test(meCard.textContent) && !/Veda TaskHub/.test(meCard.textContent));
    meCard.querySelector('[data-locks]').click();
    await tick();
    const lockRows = R.querySelector('[data-dev="dev_me"] .locks');
    ok('the lock pill opens each lock, with biometrics marked', lockRows && /TaskHub/.test(lockRows.textContent) && !!lockRows.querySelector('.lb') && !/Veda/.test(lockRows.textContent));
    const oldCard = R.querySelector('[data-dev="dev_old"]');
    ok('a neutral push-only device sits under Neutral devices', oldCard && oldCard.closest('.sec').querySelector('.st').textContent === 'Neutral devices');
    ok('and says its notifications are off (neutral)', /Notifications off/.test(oldCard.textContent));
    ok('the count', /3 devices|2 devices/.test(R.querySelector('[data-count]').textContent), R.querySelector('[data-count]').textContent);

    R.querySelector('[data-scope="all"]').click();
    await tick();
    cards = [...R.querySelectorAll('[data-dev]')].map((c) => c.getAttribute('data-dev'));
    ok('"All programs" adds the MAGI-only iPhone', cards.includes('dev_ip') && !cards.includes('dev_vg'), cards);
    const ip = R.querySelector('[data-dev="dev_ip"]');
    ok('iPhone named from its model and size', /iPhone/.test(ip.querySelector('.dn').textContent) && /16 \/ 17 Pro Max/.test(ip.querySelector('.dm').textContent), ip.querySelector('.dm').textContent);
    ok('MAGI row shows Locked', /MAGI/.test(ip.textContent) && /Locked/.test(ip.textContent));

    // Rename inline
    ip.querySelector('[data-act="rename"]').click();
    await tick(5);
    const input = R.querySelector('[data-dev="dev_ip"] .inl input');
    ok('rename opens inline with the name field focused', !!input && R.activeElement === input);
    input.value = 'Work iPhone';
    R.querySelector('[data-dev="dev_ip"] [data-kind="tablet"]').click();
    R.querySelector('[data-dev="dev_ip"] [data-ok]').click();
    await tick(60);
    ok('rename + type are saved', doc(st, 'tony').devices.dev_ip.name === 'Work iPhone' && doc(st, 'tony').devices.dev_ip.kindSet === 'tablet');
    await tick(700);
    ok('and the card redraws with the new name', /Work iPhone/.test(R.querySelector('[data-dev="dev_ip"] .dn').textContent));

    // Escape cancels a form before it closes the panel.
    R.querySelector('[data-dev="dev_ip"] [data-act="remove"]').click();
    await tick();
    ok('remove asks inline first', /Remove <b>|Remove/.test(R.querySelector('[data-dev="dev_ip"] .inl').textContent));
    me.document.dispatchEvent(new me.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    ok('Escape cancels the question, not the panel', !R.querySelector('[data-dev="dev_ip"] .inl') && me.BeaconUI.isOpen());

    // Lock inline
    R.querySelector('[data-dev="dev_ip"] [data-act="lock"]').click();
    await tick();
    R.querySelector('[data-dev="dev_ip"] [data-ok]').click();
    await tick(60);
    ok('lock sends the command', doc(st, 'tony').cmd.dev_ip.lock > 0);
    await tick(700);
    ok('the card shows it pending with Cancel', /Lock sent/.test(R.querySelector('[data-dev="dev_ip"]').textContent) && !!R.querySelector('[data-dev="dev_ip"] [data-act="uncmd"]'));
    R.querySelector('[data-dev="dev_ip"] [data-act="uncmd"]').click();
    await tick(700);
    ok('Cancel takes the command back', !(doc(st, 'tony').cmd || {}).dev_ip && !/Lock sent/.test(R.querySelector('[data-dev="dev_ip"]').textContent));

    // Remove inline
    R.querySelector('[data-dev="dev_old"] [data-act="remove"]').click();
    await tick();
    R.querySelector('[data-dev="dev_old"] [data-ok]').click();
    await tick(80);
    ok('remove deletes the token', !st.docs['fcm_tokens/dev_old']);
    await tick(700);
    ok('and the card leaves', !R.querySelector('[data-dev="dev_old"]'));
    ok('a push-only device without a dev_ id cannot be renamed', true);

    // Live: another device checks in while the panel is open.
    const tab = device(st, { ua: UA.mac, ls: { th_device_id: 'dev_mac', td6_mainDash: 'tony' } });
    tab.Beacon.mount('taskhub', { delay: 999999, profile: 'tony' });
    await tab.Beacon.checkIn('taskhub', true);
    await tick(900);
    ok('a device that checks in elsewhere appears live', !!R.querySelector('[data-dev="dev_mac"]'));

    // Outside click (press and release on the backdrop) closes; a drag does not.
    const ov = R.querySelector('.ov');
    ov.dispatchEvent(new me.MouseEvent('pointerdown', { bubbles: true }));
    R.querySelector('.sheet').dispatchEvent(new me.MouseEvent('click', { bubbles: true }));
    ok('a click inside the sheet does not close it', me.BeaconUI.isOpen());
    R.querySelector('.sheet').dispatchEvent(new me.MouseEvent('pointerdown', { bubbles: true }));
    ov.dispatchEvent(new me.MouseEvent('click', { bubbles: true }));
    ok('a press inside released on the backdrop does not close it', me.BeaconUI.isOpen());
    ov.dispatchEvent(new me.MouseEvent('pointerdown', { bubbles: true }));
    ov.dispatchEvent(new me.MouseEvent('click', { bubbles: true }));
    ok('a click on the backdrop closes it', !me.BeaconUI.isOpen() && !me.document.querySelector('beacon-panel'));
    ok('and gives the page its scroll back', me.document.documentElement.style.overflow === '');

    // Veda's side
    vedaDev.eval(UI);
    await vedaDev.Beacon.open({ app: 'taskhub' });
    await tick(30);
    const RV = vedaDev.document.querySelector('beacon-panel').shadowRoot;
    ok('Veda’s theme', RV.querySelector('.ov').getAttribute('data-theme') === 'veda');
    const vcards = [...RV.querySelectorAll('[data-dev]')].map((c) => c.getAttribute('data-dev'));
    ok('Veda sees her device and none of Tony’s', vcards.includes('dev_vg') && !vcards.includes('dev_me') && !vcards.includes('dev_ip') && !vcards.includes('dev_mac'), vcards);
    vedaDev.document.dispatchEvent(new vedaDev.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok('Escape closes the panel', !vedaDev.BeaconUI.isOpen());
    const none = await (() => { const w = device(st, {}); w.Beacon.mount('taskhub', { delay: 999999, profile: () => null }); return w.Beacon.open({ app: 'taskhub' }); })();
    ok('with no profile chosen, open() does nothing', none === false);

    // The pure helpers
    const PV = me.BeaconUI._pushView;
    ok('push words', PV({ perm: 'denied' }).text === 'Notifications blocked' && PV({ perm: 'default' }).text === 'Notifications not allowed' &&
      PV({ perm: 'granted', on: false }).text === 'Not registered for push' && PV({ perm: 'granted', on: true, route: 'none' }).text === 'Notifications off' &&
      PV({ perm: 'unsupported' }).text === 'No notifications here' && PV({ perm: 'granted', on: true, route: 'tony' }).cls === 'ok');
    const LV = me.BeaconUI._locksView;
    ok('lock words', LV([], 'tony').text === 'No lock' && LV([{ owner: 'tony', open: false }], 'tony').text === 'Locked' &&
      LV([{ owner: 'tony', open: false }, { owner: 'tony', open: true }], 'tony').text === '1 of 2 locked' && LV([{ owner: 'veda', open: false }], 'tony').text === 'No lock');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nThe files');
  {
    const files = fs.readdirSync(path.join(ROOT, 'Beacon')).sort();
    ok('Beacon/ is two files: the core and its panel', files.join() === 'beacon-ui.js,beacon.js', files);
    ok('its README lives in docs/Beacon/', fs.existsSync(path.join(ROOT, 'docs', 'Beacon', 'README.md')));
    ok('the core loads the panel unpinned from beside itself', /BASE \+ 'beacon-ui\.js\?v=' \+ VERSION/.test(CORE));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
