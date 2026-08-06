# V1 — application suite

Veda's personal application suite. One repository, one deployment pipeline, one
design language, shared infrastructure — with each app fully modular.

| App | What it does | URL |
| --- | ------------ | --- |
| **[TradeBoard](TradeBoard/)** | Trading journal + portfolio, with live Webull sync | site root `/` |
| **[Finance](Finance/)** | Personal finance: accounts, transactions, budgets, insights, recurring payments, cash | `/finance/` |

---

## Layout

```
V1/
├─ TradeBoard/        trading journal (app + Webull sync + Tauri desktop shell)
├─ Finance/           personal finance app
├─ shared/            design tokens shared by every app
├─ workers/           Cloudflare Workers — each subfolder auto-deploys
│  ├─ auth/             App-Lock passwords (PBKDF2 + KV), shared suite-wide
│  └─ finance-api/      Plaid link + sync + sessions for Finance
├─ firebase/          Firestore rules + project config
├─ docs/              setup, deployment, security, testing
└─ scripts/           suite build (emits every app into dist/)
```

---

## Getting started

```powershell
cd C:\Users\vedap\Desktop\V1
npm install
npm run build          # emits dist/ with both apps
```

**Before production, work through [docs/MANUAL_SETUP.md](docs/MANUAL_SETUP.md).**
It lists every action that needs your credentials or a console; everything else
is automated.

---

## Documentation

| Document | Purpose |
| -------- | ------- |
| [MANUAL_SETUP.md](docs/MANUAL_SETUP.md) | One-time actions only you can do. **Start here.** |
| [PLAID_SETUP.md](docs/PLAID_SETUP.md) | Plaid account → API keys → sandbox → production |
| [SECURITY.md](docs/SECURITY.md) | Trust model, secret handling, findings, recommendations |
| [TESTING.md](docs/TESTING.md) | Verification checklist for every feature |

---

## Deployment

Everything deploys from GitHub. There is no manual publishing step.

| Change | Result |
| ------ | ------ |
| Any app's HTML | CI rebuilds `dist/` and redeploys the site Worker |
| Anything under `workers/**` | GitHub Actions deploys that Worker |
| A brand-new Worker | **Auto-discovered** — no workflow changes needed |
| `firebase/firestore.rules` | Manual (`firebase deploy --only firestore:rules`) |

### Adding a future app

1. Create `NewApp/newapp.html`
2. Add one line to the `APPS` array in `scripts/build.mjs`:
   ```js
   { name: "NewApp", src: "NewApp/newapp.html", out: "newapp" },
   ```
3. Push. It deploys at `/newapp/`.

### Adding a future Worker

1. Create `workers/<name>/` containing:
   - `wrangler.toml` (or `.jsonc`)
   - `src/index.js`
   - **`package.json` declaring wrangler** — required:
     ```json
     { "private": true, "devDependencies": { "wrangler": "^4.0.0" } }
     ```
2. Push. `.github/workflows/deploy-workers.yml` finds and deploys it
   automatically — **no workflow edit, no console step.**

> The `package.json` is not optional. Without it the deploy action falls back to
> whatever wrangler the CI runner has cached (v3 at time of writing), which
> cannot parse a v4 config and fails with an opaque "exit code 1". The workflow
> now aborts with a clear message instead, but declaring the dependency is what
> actually prevents it.

---

## Shared infrastructure

| Service | Detail |
| ------- | ------ |
| **Firebase** | Project `tradeboard-6b2ea`. Anonymous auth + App Check (reCAPTCHA v3). Each app is scoped to its own Firestore path. |
| **Auth Worker** | `tradeboard-auth` — one deployment, one password *per app* via distinct `entryId`s. |
| **Formspree** | Form `xrenqnrp` — sends password hints and reset codes. The client sends these, so no email credentials live on any server. |
| **Cloudflare** | A Static-Assets Worker (`workers/site`) serves every app; other Workers hold anything requiring a secret. |

Apps share infrastructure but **not data**: Firestore rules confine each to its
own path, and each has an independent app-lock password.

---

## Daily use

```powershell
cd C:\Users\vedap\Desktop\V1
git add -A
git commit -m "your message"
git push
```

That single push updates GitHub, redeploys the site, and deploys any changed
Worker.
