# Warden — setup

Everything that could be wired up automatically already is. What is left is the
list below: the things that need a human because they need an account, a
console, or a value that does not exist yet.

Work top to bottom. Each step names exactly what to paste and where. Nothing
later works until the step before it does.

**Two files hold every value you will paste:**

| File | Holds |
|---|---|
| `warden.html` — the `WARDEN_CONFIG` block at the very top | everything the web app needs |
| `Warden/warden-config.js` | everything the browser extension needs |

Anything still reading `__LIKE_THIS__` has not been filled in yet. A placeholder
is never a working default — it is deliberately obvious so a half-finished setup
fails loudly instead of quietly pointing at the wrong project.

> **When something breaks, open Warden and tap the sync pill under the title.**
> It runs a per-layer diagnostic — config, origin, auth, App Check, Firestore,
> files worker — and tells you which one failed and what to change. Four
> different problems all look like "Sync failed" without it.

---

## 1. Create the Firebase project

1. <https://console.firebase.google.com> → **Add project**. Disable Analytics.
2. Inside it: **Add app → Web** (`</>`). Call it Warden.
3. Copy the six values from the `firebaseConfig` it shows you into the
   `firebase: { … }` block at the top of `warden.html`:

   ```
   __FIREBASE_API_KEY__              → apiKey
   __FIREBASE_AUTH_DOMAIN__          → authDomain
   __FIREBASE_PROJECT_ID__           → projectId
   __FIREBASE_STORAGE_BUCKET__       → storageBucket
   __FIREBASE_MESSAGING_SENDER_ID__  → messagingSenderId
   __FIREBASE_APP_ID__               → appId
   ```

These are not secrets — they identify the project, they do not authorise access.
Rules and App Check do that.

## 2. Enable Anonymous sign-in

**Authentication → Sign-in method → Anonymous → Enable.**

Warden never asks for an email or password to *sync*; the master password
encrypts the data locally. Firestore only ever sees ciphertext, and every rule
requires `request.auth != null`, so without this nothing can read or write.

## 3. Create the Firestore database

**Firestore Database → Create database → Production mode.** Pick the region
closest to her. The region cannot be changed later.

## 4. Publish the Firestore rules

**Firestore → Rules**, replace everything with this, then **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Warden's four documents. Anonymous auth is enough BECAUSE the vault
    // document holds only AES-GCM ciphertext -- the master password never
    // leaves the device and Firestore cannot decrypt anything it stores.
    match /dashboards/{doc} {
      allow read, write: if request.auth != null
                         && doc in ['warden_pw', 'warden_cloud', 'warden_links', 'applock'];
    }
  }
}
```

## 5. Register App Check — the step that fails silently

⚠ **Read this one properly.** A wrong App Check key keeps working for about an
hour and then starts failing while sign-in still succeeds, so "it worked when I
tested it" proves nothing.

1. <https://www.google.com/recaptcha/admin/create>
   - Type: **reCAPTCHA v3**
   - Domains: **her GitHub Pages host** (step 8 — e.g. `vedaapatel.github.io`),
     and `localhost` if she wants to run it locally.
2. Copy the **site key** (not the secret key) into `warden.html`:
   `appCheckSiteKey: "__RECAPTCHA_V3_SITE_KEY__"`.
3. Firebase console → **App Check → Apps → your web app → reCAPTCHA v3**, paste
   the **secret key** there, and **Register**.
4. Leave enforcement **off** until step 9 confirms everything works, then turn it
   on.

Warden must have **its own** key registered to **her** origin. Do not reuse a key
from another project — every A1 app sharing one key is exactly the mistake this
avoids.

## 6. Create a Firebase service account

**Project settings → Service accounts → Generate new private key.** A JSON file
downloads. From it you need:

- `project_id`
- `client_email`
- `private_key` (the whole thing, `-----BEGIN PRIVATE KEY-----` to
  `-----END PRIVATE KEY-----`)

Keep this file somewhere safe — it is a real credential, and Cloudflare will not
let you read the secrets back once set.

## 7. Deploy the three Workers

A `chrome-extension://` page **cannot** satisfy App Check, ever. That is why the
extension never talks to Firestore directly: these Workers authenticate with the
service account from step 6 and gate access behind a shared header key.

Sources are in `Warden/workers/`. Install Wrangler (`npm i -g wrangler`) and
`wrangler login` first.

**a. Create the KV namespaces:**

```bash
wrangler kv namespace create TOKEN_CACHE   # token cache, shared by two workers
wrangler kv namespace create WARDEN        # the encrypted attachment store
```

Paste the printed ids into the `id = "__KV_NAMESPACE_ID__"` lines:
`TOKEN_CACHE`'s id goes in **warden-links** and **warden-pw-sync**;
`WARDEN`'s id goes in **warden-files** (`__KV_NAMESPACE_ID_FILES__`).

**b. Deploy each, and set its secrets:**

```bash
cd Warden/workers/warden-links   && wrangler deploy
wrangler secret put FIREBASE_PROJECT_ID
wrangler secret put FIREBASE_CLIENT_EMAIL
wrangler secret put FIREBASE_PRIVATE_KEY
wrangler secret put WARDEN_KEY

cd ../warden-pw-sync             && wrangler deploy
# same four secrets again
wrangler secret put FIREBASE_PROJECT_ID
wrangler secret put FIREBASE_CLIENT_EMAIL
wrangler secret put FIREBASE_PRIVATE_KEY
wrangler secret put WARDEN_KEY

cd ../warden-files               && wrangler deploy
# no secrets — see below
```

**`WARDEN_KEY` is already generated for you.** It is the `WORKER_KEY` value in
`Warden/warden-config.js`. Paste that exact string when Wrangler prompts, for
both workers. It is fresh, and deliberately **not** the key Tony's Vault
Launcher ships — never paste his.

`warden-files` takes no secrets on purpose. Everything in it is AES-GCM
ciphertext under a random per-file key, uploaded with no filename, no real mime
type and no reference to the item it belongs to. A gate there would protect
nothing that is not already unreadable.

**c. Paste the three URLs Wrangler prints.**

Into `Warden/warden-config.js` — note the path suffixes:

```
LINKS_URL: 'https://warden-links.<sub>.workers.dev/links'
VAULT_URL: 'https://warden-pw-sync.<sub>.workers.dev/warden'
FILES_URL: 'https://warden-files.<sub>.workers.dev'
```

Into `warden.html`, the web app needs the files worker only:

```
filesWorker: 'https://warden-files.<sub>.workers.dev'
```

Into `Warden/manifest.json`, `host_permissions` — origins only, no paths:

```
__WARDEN_LINKS_WORKER_ORIGIN__  → https://warden-links.<sub>.workers.dev
__WARDEN_VAULT_WORKER_ORIGIN__  → https://warden-pw-sync.<sub>.workers.dev
__WARDEN_FILES_WORKER_ORIGIN__  → https://warden-files.<sub>.workers.dev
```

## 8. Create the GitHub repo and turn on Pages

1. New repository, e.g. `vedaapatel/A1`.
2. Copy in `warden.html` and the whole `Warden/` folder, keeping the layout:
   `warden.html` at the repo root, `Warden/` beside it.
3. **Settings → Pages → Deploy from a branch → main → / (root)**.
4. Note the origin it gives you, e.g. `https://vedaapatel.github.io`.

Now fill in the origin everywhere it is needed:

| Placeholder | Where | Example |
|---|---|---|
| `__WARDEN_PAGES_ORIGIN__` | `warden-config.js`, and **three places** in `manifest.json` | `https://vedaapatel.github.io` |
| `__WARDEN_PAGES_HOST__` | `warden-config.js` (`BIO_RP_ID`) | `vedaapatel.github.io` — host only, no `https://` |
| `__WARDEN_APP_URL__` | `warden-config.js` | `https://vedaapatel.github.io/A1/warden.html` |
| `__GITHUB_REPO__` | `warden.html` (`launcherRepo`) | `vedaapatel/A1` |

⚠ `BIO_RP_ID` is the WebAuthn Relying Party id. Changing it **after** she enrols
a biometric silently invalidates every enrolled credential — the authenticator
just stops offering them, with no error explaining why. Set it once, now.

## 9. Check step 5 against step 8, then test

Go back to the reCAPTCHA admin page and confirm the domain listed there is
**exactly** the host from step 8. This is the single most common cause of
"it syncs for an hour and then stops".

Open `https://<her-pages-origin>/A1/warden.html` and **tap the sync pill** under
the title. Every row should be green. If one is not, the panel says what to
change.

> Opening `warden.html` from the filesystem always says "sync failed" —
> Firebase rejects `file://` origins. That is expected, not a bug. Test on the
> Pages URL (or `http://localhost`).

Once the diagnostic is all green, go back and turn **App Check enforcement on**
in the Firebase console.

## 10. Load the extension

`chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
the `Warden/` folder.

Chrome will refuse to load it while any `__PLACEHOLDER__` is still in
`manifest.json`, which is the intended behaviour — finish step 7c and 8 first.

## 11. Set the master password

Open Warden → **Passwords** → set the master password.

- Minimum 12 characters. **Four random words** is the easiest way to get a
  strong one that is actually memorable.
- **Write the recovery key down on paper.** It is shown once. It is the only way
  back in if she forgets the master password *and* loses her enrolled devices.
  Nobody — not Firebase, not the Workers, not Tony — can recover it.

## 12. Optional: biometrics

**Settings → Enable biometric unlock**, in a browser that supports WebAuthn PRF
(Chrome/Edge on Windows Hello, Touch ID on macOS).

The key is derived by the authenticator on each unlock and never stored, so a
biometric slot is not a copy of the master password sitting on disk.

---

## Move her existing Links across

Her Links currently live in `dashboards/veda_links` inside **Tony's** Firebase
project, written by `index.html`. Warden reads `dashboards/warden_links` inside
**hers**. The document shape is identical, so this is a one-document copy — but
the two are in different projects, so it has to be exported and re-imported.

**Do this after step 9 is green, and before removing anything from `index.html`.**

**1. Export.** Open Tony's `index.html` where her Links already work, open the
browser console, and run:

```js
const { getFirestore, doc, getDoc } = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js');
const snap = await getDoc(doc(getFirestore(), 'dashboards/veda_links'));
copy(JSON.stringify(snap.data()));   // now on the clipboard
```

**2. Import.** Open her Warden, open the console, and run:

```js
await wardenImportLinks(`<paste the JSON here>`);
```

It refuses to overwrite a Links document that already has connections in it, so
running it twice cannot destroy anything. Reload Warden and her connections
should be there.

**3. Only now** remove the Links section from `index.html`. Removing it any
earlier strands her data in a project Warden does not read.

In its place, put a **Warden** button that opens `warden.html`, mirroring the
Vault button on Tony's Index. Both edits are deliberately left undone here:
`index.html` is a shared file, and touching it before the import above succeeds
is the one ordering that loses data.

---

## What could not be tested before handoff

Everything below needs her accounts or her hardware, so it is unverified until
she runs it. Everything else — every PWA flow, the extension popup, all ported
test suites, the Worker routing and auth gates — was driven and passed here.

- The Firebase project, App Check key and Firestore rules.
- The three Workers actually deployed.
- GitHub Pages, and origin isolation on her real domain.
- The extension loaded unpacked, and autofill on real sites.
- Biometrics / WebAuthn PRF — needs a real authenticator.
- The first genuine cross-device sync.

The sync diagnostic exists precisely because these can only fail on her side.
Tap the pill first; it will name the layer.

---

## Rotating the shared key later

1. Change `WORKER_KEY` in `Warden/warden-config.js`.
2. `wrangler secret put WARDEN_KEY` again in **both** `warden-links` and
   `warden-pw-sync`.
3. Reload the extension at `chrome://extensions`.

Do all three together — the extension and the Workers must always agree.
