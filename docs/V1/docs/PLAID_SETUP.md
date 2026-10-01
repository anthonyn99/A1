# Plaid setup guide

Everything needed to go from no Plaid account to a live production connection,
using **your own** Plaid credentials throughout.

Plaid is what lets Finance read balances and transactions from your banks. The
connection is **read-only by design** — Finance requests only the `transactions`
product, which cannot move money.

---

## 1. Create your Plaid account — use the TRIAL PLAN link ✅ done

**https://dashboard.plaid.com/trial-plan**

That exact URL matters. The Trial plan gives **10 free production connections**
with real bank data, auto-approved, no billing details and no per-call charges.

> ⚠️ Do **not** go through "Request production access" (`/onboarding/…`). That is
> the full paid-plan application: it asks for business details, an industry, a
> plan, and a card, and quotes per-call pricing ($0.10 per Balance call). It is
> the wrong path for a personal single-user app, and a pending application there
> can block Trial plan eligibility.

---

## 2. Get your API keys

Dashboard → **Developers** → **Keys** (https://dashboard.plaid.com/developers/keys)

You'll see:

| Field | What it is |
| ----- | ---------- |
| **client_id** | Identifies your Plaid account. Same across all environments. |
| **Sandbox secret** | For fake test banks. Use this first. |
| **Production secret** | For real banks. Requires approval (step 6). |

> The `client_id` is not especially sensitive, but the **secrets are**. Neither
> ever goes in the repository — both are stored as Cloudflare Worker secrets.

---

## 3. Store the keys as Worker secrets

```powershell
cd C:\Users\vedap\Desktop\V1\workers\finance-api

npx wrangler secret put PLAID_CLIENT_ID
# paste your client_id, press Enter

npx wrangler secret put PLAID_SECRET
# paste your SANDBOX secret for now, press Enter
```

Cloudflare stores these encrypted. They persist across every future deploy — you
set them once, not per deploy.

Confirm the Worker sees them:

```powershell
curl https://finance-api.vedapatel05.workers.dev/health
```

Expect `"configured":{"plaid":true,"firebase":true,"kv":true}`.

---

## 4. Test with Sandbox (fake banks, no real data)

`PLAID_ENV` is already `"sandbox"` in `workers/finance-api/wrangler.toml`.

1. Open Finance → **Connect** tab → **Connect**
2. Pick any institution (e.g. "First Platypus Bank")
3. Sign in with the universal sandbox credentials:

   | Field | Value |
   | ----- | ----- |
   | Username | `user_good` |
   | Password | `pass_good` |
   | MFA code (if asked) | `1234` |

4. Finance will pull fake transactions within a few seconds.

Useful sandbox variations: `user_bad` (login error), and any username ending in
`_locked` to test the error path.

> Sandbox data is synthetic and safe to delete. Clear it any time by removing the
> institution from the **Connect** tab.

---

## 5. OAuth banks (Chase, Capital One, Wells Fargo…) ✅ done

These banks redirect to their own site to log in, then return to your app. That
round trip only works if the return URL is registered with Plaid — it is:

1. Finance is already deployed at `https://tradeboard.vedapatel05.workers.dev/finance/`.
2. Plaid dashboard → **Developers** → **API** → **Allowed redirect URIs** →
   add exactly:
   ```
   https://tradeboard.vedapatel05.workers.dev/finance/
   ```
3. Set the same value in `workers/finance-api/wrangler.toml`:
   ```toml
   PLAID_REDIRECT_URI = "https://tradeboard.vedapatel05.workers.dev/finance/"
   ```
4. Commit + push (auto-deploys).

**Leave `PLAID_REDIRECT_URI` blank until it is registered.** Sending an
unregistered URI makes Plaid reject *every* link request — including non-OAuth
banks that would otherwise work fine. Finance shows a warning when it detects
this state.

---

## 6. Production ✅ done

Already live. The account is on the **Trial plan**: 10 free production Items,
real bank data, no billing. `PLAID_ENV = "production"` and the production secret
is set.

Verified end to end — a real `link-production-…` token is returned by the Worker.

For reference, this is how the switch was made:

   ```powershell
   cd C:\Users\vedap\Desktop\V1\workers\finance-api
   npx wrangler secret put PLAID_SECRET
   # paste the PRODUCTION secret this time — it replaces the sandbox one
   ```

5. Edit `workers/finance-api/wrangler.toml`:
   ```toml
   PLAID_ENV = "production"
   ```
6. Commit + push.

> ⚠️ Sandbox items do **not** carry over. After switching, reconnect your real
> institutions from the **Connect** tab. Old sandbox transactions can be deleted
> from Firestore if you want a clean slate.

### The free allowance

The Trial plan covers **10 production Items** (linked institutions) at no cost.
Usage shows on the dashboard home as "Free trial — X/10 connections".

Beyond 10 you would need to apply for a paid plan. For personal use, 10 is
normally plenty.

---

## 7. How syncing works

| Trigger | When |
| ------- | ---- |
| Daily cron | 11:00 UTC, in the Worker — no app needed |
| App open | Only if data is >6h stale (avoids burning API calls) |
| Refresh button | On demand, any time |

Syncing uses Plaid's `/transactions/sync` with a per-institution **cursor**, so
each run fetches only what changed. That keeps you well inside rate limits and
minimizes KV writes.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
| ------- | ----------- |
| "Could not reach the Finance server" | Worker not deployed, or KV id still the placeholder. See MANUAL_SETUP steps 2–3. |
| `INVALID_API_KEYS` | Secret doesn't match `PLAID_ENV` (sandbox secret while set to production, or vice versa). |
| OAuth bank fails, others work | Redirect URI not registered — section 5. |
| Link opens then immediately closes | Usually a browser popup blocker; allow popups for your domain. |
| Transactions stop updating | Item needs re-authentication (banks expire consent). Reconnect it in **Connect**. |
| `ITEM_LOGIN_REQUIRED` | Same as above — the bank revoked the session; relink. |

Live Worker logs:

```powershell
cd C:\Users\vedap\Desktop\V1\workers\finance-api
npx wrangler tail
```

---

## Security summary

- The Plaid **secret** exists only in Cloudflare Worker secrets.
- The Plaid **access_token** (the long-lived per-bank credential) exists only in
  Workers KV. `/items` deliberately strips it before responding — the browser
  never receives it.
- Your **bank credentials** go to Plaid alone. Finance and its Worker never see
  them; that is the entire point of the Link flow.
- Every Plaid endpoint requires a valid session token, which requires the
  Finance app-lock password.
