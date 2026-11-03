# Manual setup checklist

Everything in this file is a **one-time** action that cannot be done from code,
because it requires your credentials or a console. Ordered by dependency —
do them top to bottom.

After this checklist, every future change deploys automatically on `git push`.

Legend: ☐ = you do it · ✅ = already done for you

---

## 0. Already done ✅

| Thing | State |
| ----- | ----- |
| Repo restructured into the V1 suite | ✅ committed and pushed |
| TradeBoard moved to `TradeBoard/`, still builds to the site root | ✅ verified |
| Webull sync repointed to the new path | ✅ Task Scheduler updated + verified running |
| Finance app written | ✅ `Finance/finance.html` |
| Finance API Worker written | ✅ `workers/finance-api/` |
| Auto-deploy for **all** current and future Workers | ✅ `.github/workflows/deploy-workers.yml` |
| Firestore rules extended for Finance | ✅ deployed to `tradeboard-6b2ea` |

---

## 1. ✅ GitHub repo — renamed to V1

The repo is `https://github.com/VedaCPatel/V1` and the local remote already
points at it. Nothing to do.

---

## 2. ✅ GitHub Actions secrets — done

Without these two, the deploy workflow fails and no Worker updates.

1. Get a Cloudflare API token — https://dash.cloudflare.com/profile/api-tokens
   → **Create Token** → template **Edit Cloudflare Workers** → Continue → Create
   → copy it (shown once).
2. Get your Account ID — Cloudflare dashboard → **Workers & Pages** → right sidebar.
3. In GitHub: repo → **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret**, twice:

   | Name | Value |
   | ---- | ----- |
   | `CLOUDFLARE_API_TOKEN` | the token from step 1 |
   | `CLOUDFLARE_ACCOUNT_ID` | the id from step 2 |

---

## 3. ✅ Finance KV namespace — done

Stores Plaid access tokens, sync cursors, and session tokens.

```powershell
cd C:\Users\vedap\Desktop\V1\workers\finance-api
npx wrangler login          # first time only
npx wrangler kv namespace create FINANCE
```

Copy the printed `id` into `workers/finance-api/wrangler.toml`, replacing
`REPLACE_WITH_YOUR_FINANCE_KV_NAMESPACE_ID`. Commit and push — that alone
deploys the Worker.

> A KV namespace id is **not** a secret; it is meaningless without your account
> credentials, so it is safe in the repo.

---

## 4. ✅ Firestore rules — deployed

Finance's data is denied by default until these are live.

```powershell
cd C:\Users\vedap\Desktop\V1\firebase
npx firebase-tools deploy --only firestore:rules
```

If it asks you to log in: `npx firebase-tools login`.

> Verify afterwards in the Firebase console → Firestore → Rules that you see a
> `match /finance/{document=**}` block.

---

## 5. ✅ Firebase service account — done (rotate recommended, see SECURITY.md)

1. https://console.firebase.google.com → project **tradeboard-6b2ea**
2. ⚙️ **Project settings** → **Service accounts** → **Generate new private key**
3. A `.json` downloads. **Do not put it in the repo** — it is a full-access credential.
4. Set it as a Worker secret (paste the whole file contents when prompted):
   ```powershell
   cd C:\Users\vedap\Desktop\V1\workers\finance-api
   npx wrangler secret put FIREBASE_SA_JSON
   ```
5. Delete the downloaded file afterwards.

---

## 6. ✅ Plaid credentials — done

Production credentials are set and verified. The account is on Plaid's **Trial
plan** (`https://dashboard.plaid.com/trial-plan`): 10 free production
connections, real bank data, no billing, no per-call charges.

- `PLAID_CLIENT_ID` / `PLAID_SECRET` — set as Worker secrets
- `PLAID_ENV = "production"`
- `PLAID_REDIRECT_URI` set and registered, so OAuth banks work

Verified: the Worker returns a real `link-production-…` token.

> ⚠️ The Trial plan is at `/trial-plan`. Do **not** use "Request production
> access" (`/onboarding/…`) — that is the paid application, which asks for a
> card and quotes per-call pricing.

---

## 7. ✅ Website hosting — nothing to do

There is **no Cloudflare Pages project**, and none is needed. The site is served
by a Worker using Static Assets (`workers/site`), which was already how
TradeBoard was deployed.

That Worker serves every app in the suite from one hostname:

| App | URL |
| --- | --- |
| TradeBoard | https://tradeboard.vedapatel05.workers.dev/ |
| Finance | https://tradeboard.vedapatel05.workers.dev/finance/ |

It deploys through the same GitHub Actions pipeline as every other Worker — the
workflow runs `npm run build` first, then deploys `dist/`. So a push publishes
the apps *and* the Workers together, with no console step anywhere.

> The Worker is still *named* `tradeboard` because that hostname is already
> bookmarked and installed as a PWA. Renaming it would break every install.

---

## 8. ✅ CORS — already set

`APP_ORIGIN` is set to `https://tradeboard.vedapatel05.workers.dev` in
`workers/finance-api/wrangler.toml`, so only the real app can call the API from
a browser.

If you later add a custom domain, add it to that comma-separated list.

---

## 9. ☐ First run

1. Open https://tradeboard.vedapatel05.workers.dev/finance/
2. You'll be asked to **create the Finance app-lock password** (independent of
   TradeBoard's — a different password is fine and recommended).
3. Optionally enable Face ID / Windows Hello when offered.
4. **Connect** tab → **Connect** → link a **real bank**. Plaid is on production,
   so use your actual online-banking credentials. They go to Plaid only — never
   to this app or its Worker.

You have **10 free connections** on the Trial plan.

---

## Ongoing: how deployment works now

| You change… | What happens |
| ----------- | ------------ |
| `Finance/finance.html` or `TradeBoard/tradeboard.html` | CI rebuilds `dist/` and redeploys the site Worker |
| Anything under `workers/**` | GitHub Actions deploys that Worker |
| **A brand-new Worker** you add later | Auto-discovered and deployed — **no workflow edits needed** |
| `firebase/firestore.rules` | Manual: re-run step 4 (rules deploy is not automated) |

To add a future Worker: create `workers/<name>/wrangler.toml` + `src/index.js`,
push, done.
