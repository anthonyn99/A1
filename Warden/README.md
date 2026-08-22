# Warden Launcher

A browser extension that displays your links in **groups** and launches an entire
group of tabs in one click — reading a single source of truth from the **Keychain**
program in your Warden app. Add or edit a site in Keychain and it shows up in Warden
Launcher automatically. No separate database.

> Formerly just **Warden**. The extension is *Warden Launcher*; the web app at
> `/A1/warden.html` is still **Warden**. They share the `Warden/` folder — the app
> loads `warden-ui.js`, `warden-crypto.js` and friends from here — so the file
> names kept their `warden-` prefix.

Rebuilt from the old *D2L Tabs Automate* class project (used only as a template).

---

## What it does

- **Groups & links** — each Keychain "connection" is a group; its `link` items are
  the launchable links. Warden Launcher renders them as cards.
- **Open one / open a group** — one click launches a single link or every link in a
  group.
- **Rearrange connection cards** — the **Reorder** switch above the Links list turns
  on a drag grip on every card. Drop a card in a new spot (or, at two columns, a
  new column) and the new order is PUT straight to `dashboards/warden_links` through the
  same Worker. Warden's Keychain listens on that document with `onSnapshot`, so an
  open Warden tab re-renders in the new order within a second — and the popup polls
  every 5s, so an edit made in Warden shows up here without reopening. Groups with no
  link items aren't rendered but are round-tripped untouched, and a one-column
  reorder carries each card's existing column forward instead of flattening the
  app's two-column layout. See `warden-card-drag.js` and `persistOrder()` in
  `popup.js`. The switch is off by default and its state is remembered.
- **Read-mostly mirror** — reads `dashboards/warden_links` in Firestore, the exact document
  Keychain uses, and reflects it live. **Card order is the one thing this popup
  writes**; all other editing (add/remove links, groups, colours) happens in the
  **Warden app → Keychain**.
- **Tab-aware settings button** — on the **Links** tab the ⚙ opens TaskHub deep-linked
  straight to Keychain (`…/A1/#keychain` — the installed PWA if the browser routes it,
  otherwise a tab). On the **Passwords** tab the ⚙ opens Warden's own settings page.
- **Passwords** — an end-to-end **encrypted** credential warden with **autofill**. The
  popup fetches the encrypted `dashboards/warden_pw` document through the
  **`warden-pw-sync`** Worker, unlocks locally with your **master password**
  (`warden-crypto.js`), lists your logins (matches for the current site first), and
  **fills** username/password into the active tab via `chrome.scripting`. Zero-knowledge:
  the Worker and DB only ever see ciphertext. Create/edit credentials in
  TaskHub → **Warden** (the PWA); the extension is a read + autofill client.
- **Biometric unlock** — if you've registered Windows Hello / Touch ID / Face ID /
  fingerprint for the warden in TaskHub → Warden (Index), the popup offers the same
  unlock here. `warden-bio-sync.js` (a content script scoped to the Index origin)
  relays this device's `{deviceId, deviceKeyB64, credId}` into `chrome.storage.local`;
  `warden-pw-core.js` then asserts Index's own WebAuthn credential (Chrome 122+ lets
  an extension claim a site's RP ID once it holds `host_permissions` for it — see
  manifest.json) and, only on success, unwraps the warden with the synced device key.
  No separate enrollment, and a live biometric check is still required every time.
- **Payments** — saved cards with **checkout autofill**, sharing the *same* warden,
  the same master password, the same unlock session and the same encrypted
  document as Passwords. A card is just another item with `kind:'payment'`; the
  number, CVV, cardholder, expiry, billing address, brand and last-4 all live
  inside the AES-256-GCM ciphertext. Focus a card field on a checkout and the
  inline dropdown offers your cards; pick one and it fills name / number /
  expiry / CVV / billing address. Create and edit cards in TaskHub → **Warden →
  Payments**; the extension is a read + autofill client, exactly like Passwords.

### How Payments is stricter than Passwords

Passwords hands the content script the actual username/password for the current
domain. Payments does **not**:

| | Passwords | Payments |
|---|---|---|
| What the page-side script receives | the credential to fill | **masked summaries only** — nickname, network, last 4, expiry |
| Who performs the fill | the content script | the **background** decrypts and hands values straight to `warden-cardfill.js` |
| CVV release | n/a | only within **5 min** of a real master-password/biometric check (`authFresh()`) |
| Reveal / copy in the popup | reveal button | requires a **fresh credential check** (`reauth()` or biometrics) |

So a compromised page context has nothing to steal mid-checkout, and a laptop
left open on an unlocked warden still cannot surrender a security code. The idle
session extends on activity as before, but activity never refreshes the CVV
window — only presenting a credential does.

### Card & note order

Cards **and secure notes** carry an `order` integer (inside the ciphertext, like
everything else). Drag the grip handle in TaskHub → Warden → Payments or
Sensitive Info to reorder; for cards the extension list **and** the checkout
dropdown follow, because both call the same `WardenPay.sortCards()`. Reordering
is PWA-only — the extension stays a read + autofill client and never writes to
the warden.

Both sections run on ONE engine, `host.makeReorderable()` in `warden-ui.js`, so
they can't drift apart. Its DOM contract: each list child is a
`.warden-site[data-id]` carrying a `.warden-drag` handle and (optionally) a
`.warden-rowbody` that collapses mid-drag.

- **Desktop, touch and keyboard** are one implementation: Pointer Events on a
  dedicated handle (HTML5 drag-and-drop is desktop-only). The handle sets
  `touch-action:none` so a phone hands us the gesture instead of scrolling, and
  arrow keys move a focused handle for pointer-free use.
- While dragging, `.warden-reordering` collapses expanded row bodies via CSS, so
  every row is the same height and the target index is exact arithmetic rather
  than hit-testing ragged boxes. Dragging near an edge auto-scrolls.
- Only rows that actually moved are rewritten (`WardenPay.reorderPlan` for cards,
  the same minimal-diff in `commitSensitiveOrder` for notes), and they go out
  through `WardenStore.saveMany()` — one repaint, one debounced Firestore write.
  Other devices pick it up on the existing real-time listener; `updatedAt` keeps
  last-write-wins correct if two devices reorder at once.
- `order` is authoritative when present. A wallet that has never been dragged
  has no `order` on any card and sorts exactly as it always did (favourites,
  then expiring/expired, then nickname); an undragged note list likewise keeps
  its recency order. New cards/notes join the top of an ordered list, and "Pin
  to top" now really does move a card to position 0.
- Dragging is disabled while a search filter is active — positions in a filtered
  list aren't positions in the wallet.

### Passwords Worker setup (one-time)

See **[SETUP.md](SETUP.md) step 6**. The Worker source lives in
`Warden/workers/warden-pw-sync/` and its four secrets (`FIREBASE_PROJECT_ID`,
`FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `WARDEN_KEY`) are set with
`wrangler secret put`.

`WARDEN_KEY` must equal `WORKER_KEY` in `warden-config.js`. It is generated
fresh for Warden and must **never** be the key Tony's Vault Launcher ships —
reusing his would put both vaults behind one gate.

---

## Architecture — why there's a Worker

Her Firebase project enforces **App Check (reCAPTCHA v3)**.
That blocks Firestore access from any origin that can't mint a reCAPTCHA token —
which a `chrome-extension://` page cannot do, even with a valid anonymous login.

So Warden does **not** talk to Firestore directly. It talks to the **`keychain-sync`
Cloudflare Worker** (`workers/keychain-sync`), whose Firebase **service account**
bypasses App Check and security rules (the same pattern `taskhub-reminders` uses).
The Worker reads the shared document and returns plain JSON.

```
  Warden popup ──HTTPS GET(X-Warden-Key)──▶ keychain-sync Worker ──service acct──▶ Firestore
                                                                                     ▲
  Index app · Keychain (all editing) ──────── writes ────────────────────────────────┘
```

Files:

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest (name, icons, permissions) |
| `popup.html` / `popup.js` | View + launch links; Links, Passwords & Payments tabs. Each warden tab's ⚙ deep-links to the matching TaskHub → Warden tab (where items are managed) |
| `warden-sync.js` | Reads the shared Keychain doc via the `keychain-sync` Worker (load / linksOf) |
| `warden-crypto.js` | Zero-knowledge crypto core (PBKDF2 + AES-GCM); decrypts locally after unlock |
| `warden-pay.js` | Payment-methods core — networks/Luhn/masking/expiry, the method + importer **registries**, and `autofillValues()`. Pure logic, no DOM; shared with the PWA |
| `warden-pw-core.js` | Warden data layer: fetch (via `warden-pw-sync` Worker), unlock, decrypt logins **and payments**, domain match, 30-min idle session, biometric unlock, CVV auth-freshness |
| `warden-pw.js` | Passwords popup UI (unlock, list, copy/reveal, autofill, biometric button) |
| `warden-pay-panel.js` | Payments popup UI (unlock, card list, masked numbers, step-up reveal/copy, Fill) |
| `warden-cardfill.js` | Checkout field detection + filling. Content script in **all frames** (hosted Stripe/Braintree card fields live in iframes) |
| `warden-bio-sync.js` | Content script on the Index origin only — relays this device's biometric link (deviceId/deviceKey/credential id) into `chrome.storage.local` |
| `content.js` | Inline "Warden Autofill" (logins, **top frame only**) and "Warden Payments" (cards, any frame) dropdowns |
| `background.js` | Service worker — opens tabs; decrypts login matches and masked card summaries; performs the card fill itself |
| `icons/` | 16/48/128 px all-pink keyhole icons |

> **Re-load the unpacked extension after this change.** `manifest.json` gained
> `all_frames` and a new content-script file, which only takes effect on reload.
> No new *permissions* were added — the card fill deliberately routes through
> `chrome.tabs.sendMessage` to the already-injected content script rather than
> `chrome.scripting.executeScript`, which would have required `<all_urls>` host
> permissions and a re-approval prompt. Same isolated world either way.

The extension ships only the files listed above (see `WARDEN_FILES` in the Index
app's packager). This folder also holds the **Index app's PWA warden modules**,
which the extension does not package but which live here so both the app and the
extension share a single `warden-crypto.js` (identical crypto core):

| File | Role |
|------|------|
| `warden-crypto.js` | Shared crypto core — loaded by the extension **and** by `index.html` |
| `warden-pay.js` | Shared payments core — loaded by the extension **and** by `index.html` |
| `warden-store.js` | PWA: encrypted storage + sync layer (Index app only) |
| `warden-session.js` | PWA: session & auth orchestration (Index app only) |
| `warden-ui.js` | PWA: Passwords / Payments / Sensitive Info / Links tabs injected into Keychain (Index app only) |
| `warden-pay-ui.js` | PWA: the Payments tab itself — card faces, editor, gated reveal (Index app only) |
| `warden-*.test.js` | Node verification for the modules above (`node warden-crypto.test.js`, …) |

### Why Payments needed almost no new architecture

`warden-store.js` already stores each item as `{ id, kind, enc, updatedAt, deleted }`
with `kind` as the **only** plaintext field. So a payment method is just
`kind:'payment'`, and it inherits — with zero changes to the crypto, storage,
sync or session layers — the same DEK, the same per-item last-write-wins
conflict handling, the same real-time Firestore listener, the same offline
queueing, the same master-password / recovery-key / biometric unlock paths, the
same auto-lock, and the same encrypted backup file.

What *was* added: the payment logic itself (`warden-pay.js`), a tab
(`warden-pay-ui.js`), a popup panel (`warden-pay-panel.js`) and the checkout
filler (`warden-cardfill.js`). `warden-ui.js` gained only tab wiring plus a
`hostCtx()` contract so the Payments tab is a module rather than another
thousand lines in an already-large file.

Two hardening fixes landed alongside, both pre-existing and both affecting
Passwords too:

- `touchSession()` in `warden-pw-core.js` was rewriting the session record
  without `stamp`, which silently disabled the "master password changed on
  another device → drop this cached key" check on every later resume.
- `renderLock()` in `warden-ui.js` always drew the lock screen into the Passwords
  panel, so locking while on another tab left that tab blank instead of locked.

### Adding another payment method type or importer

Both are registries in `warden-pay.js` — append one object, nothing else changes:

```js
METHODS   // 'card' today; a 'bank'/'paypal' entry brings its own fields + autofill
IMPORTERS // { id, label, format:'csv'|'json', detect(input), extract(input) }
```

`IMPORTERS` ships Chromium payment exports, 1Password card CSV, Bitwarden JSON
and a generic CSV fallback. Google Wallet is intentionally absent: it exposes no
card-number export (nor does any issuer wallet), so no importer can exist — the
registry is there so the ones that *are* possible stay one object each.

`index.html` loads these via `<script src="Warden/…">`; the extension loads its
copy of `warden-crypto.js` locally from this same folder.

---

## One-time setup

Warden is set up **once**, end to end, by following
**[SETUP.md](SETUP.md)** — it is the single ordered checklist and covers the
Firebase project, App Check, the Firestore rules, all three Workers, GitHub
Pages, and loading the extension.

What follows is only the shape of it; SETUP.md has the actual commands.

### 1. Deploy the three Workers

Sources are in `Warden/workers/`:

| Worker | Serves | Needs |
|---|---|---|
| `warden-links` | Links — `dashboards/warden_links` | service account + `WARDEN_KEY` |
| `warden-pw-sync` | the vault — `dashboards/warden_pw` | service account + `WARDEN_KEY` |
| `warden-files` | encrypted attachments (KV) | a KV namespace, no key |

`cd` into each and run `wrangler deploy`.

### 2. Set the Worker secrets (once)

```bash
wrangler secret put FIREBASE_PROJECT_ID     # her Firebase project id
wrangler secret put FIREBASE_CLIENT_EMAIL   # her service-account email
wrangler secret put FIREBASE_PRIVATE_KEY    # her service-account private key (full PEM)
wrangler secret put WARDEN_KEY              # must equal WORKER_KEY in warden-config.js
```

`warden-files` takes no secrets — everything it stores is ciphertext under a
random per-file key, so a gate there would protect nothing.

> Wrangler cannot read secrets back, so keep the service-account JSON somewhere
> safe when it is first downloaded.

### 3. Load the extension

1. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → select the `Warden` folder.
4. Pin it, click the icon — your Keychain groups appear.

---

## Browser compatibility

Warden is a standard **Manifest V3** extension using only `chrome.tabs`,
`chrome.runtime`, an action popup, an options page, and a background service
worker — the common Chromium subset.

| Browser | Status |
|---------|--------|
| **Brave** | ✅ Works (primary target) |
| **Chrome** | ✅ Works, no changes |
| **Edge** | ✅ Works, no changes |
| **Opera / Arc / Comet** (Chromium) | ✅ Works, no changes |
| **Firefox** | ⚠️ Minor change: swap `background.service_worker` for `background.scripts`, and either use the `browser.*` namespace or bundle the `webextension-polyfill`. Everything else is compatible. |
| **Safari** | ⚠️ Requires conversion to a Safari Web Extension (`xcrun safari-web-extension-converter`) and a small wrapper app in Xcode. |

Because the extension only reads/writes public-shaped JSON through the Worker
(no bundled Firebase SDK, no remote scripts), it stays within MV3's
"no remotely hosted code" rule everywhere.

---

## Mobile

**Can browser extensions run on mobile?** Partially — it depends on the browser's
engine, not the OS alone.

### Android

- **Kiwi Browser** (Chromium) — loads Chrome extensions, including unpacked/CRX.
  Warden works essentially as-is. *Best zero-port option.*
- **Firefox for Android** — supports extensions, but needs the small Firefox
  manifest tweak above and distribution via addons.mozilla.org.
- **Brave / Chrome / Edge on Android** — ❌ no extension support.

### iPhone / iPad

- Every iOS browser (Safari, Chrome, Brave…) is forced onto **WebKit**, and only
  **Safari** supports extensions — as **Safari Web Extensions** that must be
  packaged inside a companion iOS app via Xcode (Apple Developer account required).
  Chrome/Brave on iOS **cannot** run extensions at all.

### Recommended cross-platform approach

You don't actually need to port the extension to get Warden's value on a phone:
**Keychain itself is a web app (`index.html`) that already runs in any mobile
browser**, and it now has the same **"Open all"** group-launch button this project
added. So on mobile:

1. Open the Index app / Keychain in the mobile browser and **Add to Home Screen**.
2. Use the group's **Open all** button to launch its links.

Same shared data, same one-click group launch, zero app-store friction. Reserve a
native Kiwi (Android) / Safari-Web-Extension (iOS) port for later if you want the
toolbar-popup experience specifically.
