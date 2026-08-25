# Warden: "Save does nothing" bug — check & fix

Self-contained. Hand this to a Claude session working on **Veda's Warden repo**.
Found and fixed in Tony's Vault on 2026-08-25; Warden was cloned from Vault
before the fix, so the copy deployed on Veda's GitHub almost certainly has it.

Do not assume line numbers match — her `warden.html` has different config
values. Every edit below is anchored on distinctive code, not position.

---

## The symptom

- Clicking **Save** on Add/Edit Connection does nothing. Modal stays open.
- Reordering cards doesn't stick; a refresh shows the old order.
- Looks exactly like "Firebase is broken" — it isn't. Firebase is never called.
- Link icons may also be missing entirely.

## The cause

`localStorage` here is only an offline **mirror**; Firestore is the real store.
But the mirror write came FIRST and was unguarded:

```js
function save(){
  localStorage.setItem('warden_kc_connections',JSON.stringify(conns));  // ← throws
  if(window._fbSaveKeychain){ ... }                                      // ← never runs
}
```

Every app on an origin shares ONE ~5MB localStorage budget. When it fills,
`setItem` throws `QuotaExceededError`, and because it was the first statement,
the throw killed the whole function — no cloud save, no `kcCloseModal()`, no
`render()`. The Save button looked completely dead.

Two things make it confusing:
- The error **names this app's key** even when a *different* app filled the
  budget. In Tony's case journal undo stacks (2.1MB) filled it and Vault died.
- Other apps keep saving fine, so it looks app-specific.

---

## 1. Is the bug present?

```bash
# A) the save bug — ANY hit means vulnerable
grep -n "localStorage.setItem('warden_kc" warden.html

# B) the guard — no hit means vulnerable
grep -c "_kcMirror" warden.html

# C) icon load-order — no hit means vulnerable
grep -c "kcInitialFaviconSweep" warden.html

# D) uncapped icon cache — no hit means vulnerable
grep -c "KC_ICON_MAX_BYTES" warden.html
```

Vulnerable if A prints anything, or B/C/D print `0`.

Also check the live symptom in the browser console on the deployed site:

```js
Object.keys(localStorage).map(k=>[k,(localStorage[k].length/1024).toFixed(0)+'KB',localStorage[k].length])
  .sort((a,b)=>b[2]-a[2]).slice(0,15).forEach(r=>console.log(r[1].padStart(8),r[0]))
```

---

## 2. Fix — three edits to `warden.html`

### Edit 1 — guard every mirror write

FIND:

```js
function save(){
  localStorage.setItem('warden_kc_connections',JSON.stringify(conns));
  if(window._fbSaveKeychain){
    if(window.kcSetSync)window.kcSetSync('saving');
    window._fbSaveKeychain(()=>({connections:conns,colmap:_loadColMapRaw()}));
  }
}
function saveColMap(map){
  localStorage.setItem('warden_kc_colmap',JSON.stringify(map));
```

REPLACE WITH:

```js
// localStorage here is only an offline MIRROR — Firestore is the real store, so
// a write to it must never be able to stop the cloud save.
//
// Every app on an origin shares ONE ~5MB localStorage budget. When it fills up,
// setItem throws QuotaExceededError, and because that call used to be the FIRST
// line of save(), the throw took out the whole function: _fbSaveKeychain was
// never reached, the modal never closed, and the Save button looked completely
// dead while the cloud sat there never being asked.
function _kcMirror(key,val){
  try{ localStorage.setItem(key,val); return true; }
  catch(e){
    console.warn('[Warden] local mirror failed ('+(e&&e.name||'error')+') — cloud save continues');
    _kcWarnQuota(e);
    return false;
  }
}
let _kcQuotaWarned=false;
function _kcWarnQuota(e){
  if(_kcQuotaWarned) return;
  if(!e||String(e.name||'').indexOf('Quota')<0) return;
  _kcQuotaWarned=true;
  setTimeout(function(){
    try{ alert("This browser's storage for the site is full.\n\nYour changes still save to the cloud and sync to your other devices — but this device can't keep an offline copy until space is freed."); }catch(_){}
  },0);
}
function save(){
  _kcMirror('warden_kc_connections',JSON.stringify(conns));
  if(window._fbSaveKeychain){
    if(window.kcSetSync)window.kcSetSync('saving');
    window._fbSaveKeychain(()=>({connections:conns,colmap:_loadColMapRaw()}));
  }
}
function saveColMap(map){
  _kcMirror('warden_kc_colmap',JSON.stringify(map));
```

Then replace the **remaining** direct writes. There are three more; find each with
`grep -n "localStorage.setItem('warden_kc" warden.html` and swap
`localStorage.setItem(` → `_kcMirror(` on each. They are in:

- `applyRemote()` — two calls, connections + colmap
- the delete-card colmap splice — `m.splice(delIdx,1);localStorage.setItem('warden_kc_colmap',…)`
- the cloud-migration block — right before `save();  // push slimmed metadata`

`applyRemote()` matters as much as `save()`: an unguarded write there aborted the
function, so the cloud copy arrived and the list was never rendered.

**When done, `grep -n "localStorage.setItem('warden_kc" warden.html` must return
nothing**, and there should be 7 `_kcMirror` occurrences.

### Edit 2 — icons that don't depend on script order

The row markup calls `window.kcFavicon(...)` inline, but `kcFavicon` is defined
in a LATER `<script>` block than the renderer. On a cold load it's still
undefined, so every row is written with `src=""` and nothing ever revisits it.

FIND (inside `window.kcUpgradeFavicons`):

```js
  Array.prototype.forEach.call(scope.querySelectorAll('img.kc-favicon[data-kcurl]'),function(img){
    if(img._kcTried) return; img._kcTried=1;
    var u=img.getAttribute('data-kcurl'); if(!u) return;
```

REPLACE WITH:

```js
  Array.prototype.forEach.call(scope.querySelectorAll('img.kc-favicon[data-kcurl]'),function(img){
    var u=img.getAttribute('data-kcurl'); if(!u) return;
    // Backfill an EMPTY src first — see the sweep below for why it can be empty.
    if(!img.getAttribute('src') && window.kcFavicon){
      var base=window.kcFavicon(u,img.getAttribute('alt')||'');
      if(base){ img.src=base; img.style.visibility=''; }
    }
    if(img._kcTried) return; img._kcTried=1;
```

Then immediately AFTER the closing `};` of `window.kcUpgradeFavicons`, ADD:

```js
// The renderer lives in an EARLIER <script> block and calls this as
// `if(window.kcUpgradeFavicons) …`, which on a cold load runs before this
// assignment exists — so the first paint got no icons at all. Sweep once now.
(function kcInitialFaviconSweep(){
  function sweep(){ try{ window.kcUpgradeFavicons(document); }catch(_){} }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',sweep);
  else sweep();
  setTimeout(sweep,1500); setTimeout(sweep,4000);   // rows can arrive with the cloud copy
})();
```

### Edit 3 — cap the icon cache

Entries hold a discovered icon's data URI (a few KB each) with only a 7-day TTL
and no size limit, so it grows until it fills the origin's budget — which then
makes some OTHER app's `setItem` throw.

FIND:

```js
function kcSaveIconCache(){ try{localStorage.setItem(KC_ICON_LS,JSON.stringify(window._KC_ICON_CACHE));}catch(_){} }
```

REPLACE WITH:

```js
var KC_ICON_MAX_BYTES = 512 * 1024;
function kcSaveIconCache(){
  try{
    var c=window._KC_ICON_CACHE||{}, s=JSON.stringify(c);
    if(s.length>KC_ICON_MAX_BYTES){
      var keys=Object.keys(c).sort(function(a,b){return (c[a]&&c[a].t||0)-(c[b]&&c[b].t||0);});
      while(keys.length && s.length>KC_ICON_MAX_BYTES){ delete c[keys.shift()]; s=JSON.stringify(c); }
      window._KC_ICON_CACHE=c;
    }
    localStorage.setItem(KC_ICON_LS,s);
  }catch(_){ /* full or unavailable — icons simply re-derive next load */ }
}
```

---

## 3. Verify

**Static** — drop in the regression test (below) and run it:

```bash
node tests/storage-guard.test.js
```

**Live** — serve the folder and drive it headless. The real assertion is that a
FULL localStorage no longer blocks the cloud save:

1. Fill storage: `var b="x".repeat(256*1024); for(var i=0;i<200;i++) localStorage.setItem("__ballast_"+i,b);`
2. Wrap the cloud call: `window.__tried=false; var _o=window._fbSaveKeychain; window._fbSaveKeychain=function(g){window.__tried=true;return _o&&_o(g);};`
3. Add a connection and click Save.
4. Assert `window.__tried === true` and the modal closed.
5. Clean up: `Object.keys(localStorage).filter(k=>k.startsWith("__ballast_")).forEach(k=>localStorage.removeItem(k))`

Before the fix, step 4 gives `false`. After, `true`.

---

## 4. Regression test

Save as `tests/storage-guard.test.js` (adjust the APPS list to just
`warden.html`) and wire into `npm test`:

```js
const fs = require('fs');
const path = require('path');
const APPS = [{ file: 'warden.html', prefix: 'warden_kc_' }];
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + String(e).slice(0,300) : '')); } };
for (const app of APPS) {
  const p = path.join(__dirname, '..', app.file);
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, 'utf8');
  console.log('\n-- ' + app.file + ' --');
  const m = src.match(/function _kcMirror\([\s\S]{0,400}?\n\}/);
  ok('_kcMirror() is defined', !!m);
  ok('_kcMirror() wraps the write in try/catch',
     !!m && /try\s*\{[\s\S]*localStorage\.setItem[\s\S]*\}\s*catch/.test(m[0]));
  const direct = src.split('\n').map((l,i)=>({l:l.trim(),n:i+1}))
    .filter(r => r.l.includes("localStorage.setItem('" + app.prefix));
  ok('no direct localStorage.setItem on the keychain keys', direct.length === 0,
     direct.map(r=>app.file+':'+r.n).join(' | '));
  const save = src.match(/function save\(\)\{[\s\S]{0,600}?\n\}/);
  ok('save() exists', !!save);
  if (save) {
    ok('save() mirrors via _kcMirror, not setItem', !/localStorage\.setItem/.test(save[0]));
    ok('save() still reaches _fbSaveKeychain', /_fbSaveKeychain/.test(save[0]));
  }
  const ar = src.match(/function applyRemote\(data\)\{[\s\S]{0,700}?\n  \}/);
  ok('applyRemote() exists', !!ar);
  if (ar) ok('applyRemote() mirrors via _kcMirror', !/localStorage\.setItem/.test(ar[0]));
  ok('icon cache has a byte cap', /KC_ICON_MAX_BYTES/.test(src));
  ok('an initial favicon sweep runs once the helpers exist', /kcInitialFaviconSweep/.test(src));
}
console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
process.exit(fail ? 1 : 0);
```

---

## 5. If storage is already full on Veda's device

The code fix stops the *crash*, not existing usage. In the console on her
deployed site, find the hog with the listing snippet in section 1. In Tony's
case it was `docx_hist_*` (journal undo stacks) — but that is an `index.html`
feature and **Warden has none**, so on her origin expect a different key.

Warden's own footprint is only `warden_kc_connections`, `warden_kc_colmap` and
`warden_kc_icon_cache_v1` (now capped).

## 6. Not applicable to Warden

Tony's root cause — `docx_hist_*` journal undo stacks at 900KB per key with no
limit on key count — lives in `index.html`. Confirmed absent from Warden
(`grep -c docx_hist warden.html` → `0`). Don't go looking for it.
