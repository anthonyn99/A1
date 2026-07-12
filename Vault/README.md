# Vault

A browser extension that displays your links in **groups** and launches an entire
group of tabs in one click — reading a single source of truth from the **Keychain**
program in your Index app. Add or edit a site in Keychain and it shows up in Vault
automatically. No separate database.

Rebuilt from the old *D2L Tabs Automate* class project (used only as a template).

---

## What it does

- **Groups & links** — each Keychain "connection" is a group; its `link` items are
  the launchable links. Vault renders them as cards.
- **Open one / open a group** — one click launches a single link or every link in a
  group.
- **Read-only mirror** — reads `dashboards/keychain` in Firestore, the exact document
  Keychain uses, and reflects it live. **All editing** (add/remove links, groups,
  colours, ordering) happens in **TaskHub → Keychain**; Vault only displays & opens.
- **Tab-aware settings button** — on the **Links** tab the ⚙ opens TaskHub deep-linked
  straight to Keychain (`…/A1/#keychain` — the installed PWA if the browser routes it,
  otherwise a tab). On the **Passwords** tab the ⚙ opens Vault's own settings page.
- **Passwords** — an end-to-end **encrypted** credential vault with **autofill**. The
  popup fetches the encrypted `dashboards/vault_pw` document through the
  **`vault-pw-sync`** Worker, unlocks locally with your **master password**
  (`vault-crypto.js`), lists your logins (matches for the current site first), and
  **fills** username/password into the active tab via `chrome.scripting`. Zero-knowledge:
  the Worker and DB only ever see ciphertext. Create/edit credentials in
  TaskHub → **Vault** (the PWA); the extension is a read + autofill client.

### Passwords Worker setup (one-time)

`workers/vault-pw-sync` auto-deploys on push (see `deploy-workers.yml`). Set its
secrets once (the three `FIREBASE_*` are identical to `keychain-sync`; `VAULT_KEY`
is the same shared key already in `vault-sync.js` / `vault-pw.js`):

```bash
cd workers/vault-pw-sync
wrangler secret put FIREBASE_PROJECT_ID     # task-dashboard-d2b53
wrangler secret put FIREBASE_CLIENT_EMAIL   # same as keychain-sync
wrangler secret put FIREBASE_PRIVATE_KEY    # same as keychain-sync
wrangler secret put VAULT_KEY               # vh-Ou55y3rGmjUn_ZGFTdSIFph2xN_OK
```

---

## Architecture — why there's a Worker

The Firebase project (`task-dashboard-d2b53`) enforces **App Check (reCAPTCHA v3)**.
That blocks Firestore access from any origin that can't mint a reCAPTCHA token —
which a `chrome-extension://` page cannot do, even with a valid anonymous login.

So Vault does **not** talk to Firestore directly. It talks to the **`keychain-sync`
Cloudflare Worker** (`workers/keychain-sync`), whose Firebase **service account**
bypasses App Check and security rules (the same pattern `taskhub-reminders` uses).
The Worker reads the shared document and returns plain JSON.

```
  Vault popup ──HTTPS GET(X-Vault-Key)──▶ keychain-sync Worker ──service acct──▶ Firestore
                                                                                     ▲
  Index app · Keychain (all editing) ──────── writes ────────────────────────────────┘
```

Files:

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest (name, icons, permissions) |
| `popup.html` / `popup.js` | View + launch (single link / whole group); Links & Passwords tabs |
| `options.html` | Vault settings page — Passwords placeholder (no link management) |
| `vault-sync.js` | Reads the shared doc via the `keychain-sync` Worker (load / linksOf) |
| `background.js` | Service worker — opens the tabs |
| `icons/` | 16/48/128 px all-pink keyhole icons |

---

## One-time setup

### 1. Deploy the Worker

`workers/keychain-sync` auto-deploys via `.github/workflows/deploy-workers.yml` when
you push changes under `workers/keychain-sync/**`. (Or run `wrangler deploy` inside
that folder.) It ends up at `https://keychain-sync.av1.workers.dev`.

### 2. Set the Worker secrets (once)

From `workers/keychain-sync/`:

```bash
wrangler secret put FIREBASE_PROJECT_ID     # task-dashboard-d2b53
wrangler secret put FIREBASE_CLIENT_EMAIL   # same service-account email as taskhub-reminders
wrangler secret put FIREBASE_PRIVATE_KEY    # same private key as taskhub-reminders
wrangler secret put VAULT_KEY               # vh-Ou55y3rGmjUn_ZGFTdSIFph2xN_OK
```

The three `FIREBASE_*` values are identical to the ones already on the
`taskhub-reminders` worker (they come from your Firebase service-account JSON).
`VAULT_KEY` is the shared secret the extension sends — it already matches the value
baked into `vault-sync.js`. Change both together if you ever rotate it.

> Wrangler can't read existing secrets back, so copy the `FIREBASE_*` values from
> your service-account JSON (the same file used to configure `taskhub-reminders`).

### 3. Load the extension

1. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → select the `Vault` folder.
4. Pin it, click the icon — your Keychain groups appear.

---

## Browser compatibility

Vault is a standard **Manifest V3** extension using only `chrome.tabs`,
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
  Vault works essentially as-is. *Best zero-port option.*
- **Firefox for Android** — supports extensions, but needs the small Firefox
  manifest tweak above and distribution via addons.mozilla.org.
- **Brave / Chrome / Edge on Android** — ❌ no extension support.

### iPhone / iPad

- Every iOS browser (Safari, Chrome, Brave…) is forced onto **WebKit**, and only
  **Safari** supports extensions — as **Safari Web Extensions** that must be
  packaged inside a companion iOS app via Xcode (Apple Developer account required).
  Chrome/Brave on iOS **cannot** run extensions at all.

### Recommended cross-platform approach

You don't actually need to port the extension to get Vault's value on a phone:
**Keychain itself is a web app (`index.html`) that already runs in any mobile
browser**, and it now has the same **"Open all"** group-launch button this project
added. So on mobile:

1. Open the Index app / Keychain in the mobile browser and **Add to Home Screen**.
2. Use the group's **Open all** button to launch its links.

Same shared data, same one-click group launch, zero app-store friction. Reserve a
native Kiwi (Android) / Safari-Web-Extension (iOS) port for later if you want the
toolbar-popup experience specifically.
