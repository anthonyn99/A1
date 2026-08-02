# OneInbox

An AI-powered unified inbox for every Gmail account, built as a standalone A1
Suite app alongside TaskHub, TradeBoard, Insight, Vault and MyList.

```
oneinbox.html                   the app — at the A1 root, same as every other
                                A1 program (index / insight / vault / mylist /
                                tradehub). Single file, same pattern as insight.html
OneInbox/                       supporting files for the app (this README)
workers/oneinbox-api/           the backend — the ONLY holder of tokens and keys
```

Live at `https://anthonyn99.github.io/A1/oneinbox.html`.

---

## What it does

**Mail.** Connect any number of Gmail accounts. Unified inbox across all of
them (newest first, an account pip on every row), or one mailbox at a time.
Inbox / Starred / Sent / Drafts / Archive / Trash / user labels. Read, send,
reply, reply-all, forward, draft, archive, delete, star, search. Compose picks
the sending account from a **From** dropdown, applies that account's signature,
supports attachments, a rich-text toolbar, templates and scheduled send.

**AI.** Every incoming message is classified by Gemini into one of eight
categories with its facts extracted — coupon, package, bill, subscription,
travel, appointment, important, general. The reader shows what was found at the
top of the message, with Copy Code / Track Package buttons.

**TaskHub automation.** Detected coupons appear in Tony's TaskHub under
**Short-Term Goals** as rich cards (store, offer, code, expiry, plus Copy Code /
Open Store / View Email). Packages land on the **weekly view** on their delivery
day and move themselves when the ETA changes. Bills, subscriptions, travel and
appointments do the same on their own dates. Cards retire automatically once
they expire or arrive.

---

## Architecture

```
Gmail ──watch──▶ Pub/Sub ──push──▶ oneinbox-api ──▶ Gemini ──▶ Firestore
                                        │                          │
   browser ◀── lock-token'd JSON ────────┘         onSnapshot ──────┤
                                                                    ▼
                                                  index.html (TaskHub cards)
```

**Nothing sensitive ever reaches the browser.** Gmail refresh tokens live only
in Workers KV (`oi:acct:<email>`). The Gemini key, the OAuth client secret and
the Firebase service account are Cloudflare secrets. The front end holds only an
app-lock session token, and every `/gmail/*` and `/ai/*` route refuses to run
without a valid one.

**The app lock** is the suite's existing one: a PBKDF2 record at
`jlock:applock:tony_oneinbox` in taskhub-reminders' KV, created and reset through
the same `/auth/journal/*` and `/auth/reset/*` endpoints index.html uses, with
hints and reset codes emailed via the same Formspree form
(`xeedkebo` → anthonypn99@gmail.com). Biometric unlock (Face ID / Touch ID /
Windows Hello / fingerprint) is offered once after a password unlock and never
replaces the password. Changing the password invalidates every device.

**Firestore layout** — subcollections, never one fat document, because the
suite's dashboards are single docs capped at Firestore's 1 MiB limit and a
mailbox would blow straight through it:

```
dashboards/oneinbox                 meta: settings, lastIngestAt
dashboards/oneinbox/emails/{id}     metadata + AI classification
dashboards/oneinbox/cards/{id}      the TaskHub-bound cards
```

No `firestore.rules` change is needed — the existing `dashboards/{doc=**}`
auth-gated rule already covers these.

**Why OneInbox never writes to `dashboards/main`.** Tony's TaskHub doc is
rewritten *wholesale* from React state on a 500 ms debounce. A field-level write
from another app would race that and could be silently clobbered. So OneInbox
writes only to its own `cards` collection, and index.html merges those in at
**render** time. The worst case for any bug in this app is "a card is missing" —
never "TaskHub lost a task".

**Read budget.** Mail comes from Gmail through the worker, not from Firestore.
Only three bounded listeners run: the meta doc, the newest 150 email
classifications, and the (small, self-pruning) cards collection.

---

## The AI chain, and why it is ordered this way

Benchmarked on 18 real-shaped emails scored on exact field extraction:

| Model | Accuracy | p50 | Notes |
|---|---|---|---|
| `gemini-3.5-flash-lite` | **96–97%** | **660 ms** | best accuracy *and* fastest |
| `gemini-3.1-flash-lite` | 96–97% | 1090 ms | equal quality, separate quota pool |
| `gemini-3.6-flash` | 79% | 1340 ms (p90 14.9 s) | early 429s |
| `gemini-2.5-flash` | 72% | — | quota-limited |
| `gemini-2.5-flash-lite` | — | — | 404 on this key — excluded |
| `gemini-2.0-flash` | — | — | 429 always — excluded |

Three findings shaped the design, two of them against the obvious plan:

1. **Escalating hard emails to a bigger model made results worse.** The
   "Flash → Pro" fallback in the original spec measurably hurt: `3.6-flash` made
   the *same* mistakes as the lite models while being slower and hitting quota
   sooner. There is therefore no Pro tier. The chain is ordered by measured
   accuracy; later entries exist purely for extra free-tier capacity, since
   quota is per-model and each is a fresh daily pool.
2. **A wide response schema silently destroyed extraction.** With one property
   per category (`expiration`, `deliveryDate`, `dueDate`, `renewalDate`,
   `startDate`, …) every model dropped fields and scored 68–72%. Collapsing to a
   single shared `date` / `merchant` / `amount` vocabulary took the *same*
   models to 97% with no other change. Don't widen `PARSE_SCHEMA` without
   re-running the benchmark.
3. **`thinkingLevel:'high'` makes Gemini 3.x emit unparseable JSON.** Pinned low.

One prompt bug was also found and fixed this way: every model classified a paid
receipt ("thanks for your payment, nothing is due") as a **bill**, which would
have created a phantom reminder card. An explicit "nothing left to do → general"
rule fixed it across all models.

When every cloud model is exhausted, a local regex + carrier-pattern parser
still returns a usable record, so ingestion degrades instead of failing.

---

## Setup

Steps 1–3 are required. Step 4 (real-time push) is optional — without it the
5-minute history poll still ingests everything, just not instantly.

### 1. Google Cloud — OAuth client

1. <https://console.cloud.google.com> → the **task-dashboard-d2b53** project.
2. **APIs & Services → Library** → enable **Gmail API**.
3. **OAuth consent screen** → External → add `anthonypn99@gmail.com` (and any
   other address you'll connect) as a **Test user**. Staying in "Testing" is
   fine; it just means refresh tokens expire every 7 days, so **Publish** the
   app once it works to make them permanent.
4. **Credentials → Create credentials → OAuth client ID → Web application**:
   - Authorized redirect URI:
     `https://oneinbox-api.av1.workers.dev/oauth/callback`
   - Authorized JavaScript origin: `https://anthonyn99.github.io`
5. Keep the client ID and secret for step 3.

### 2. Deploy the worker

Pushing to `main` deploys it automatically (`.github/workflows/deploy-workers.yml`
has a `deploy-oneinbox-api` job). Or manually:

```bash
cd workers/oneinbox-api && npx wrangler deploy
```

### 3. Secrets

```bash
cd workers/oneinbox-api
npx wrangler secret put GOOGLE_CLIENT_ID        # from step 1
npx wrangler secret put GOOGLE_CLIENT_SECRET    # from step 1
npx wrangler secret put ONEINBOX_GEMINI_KEY     # your Gemini API key
npx wrangler secret put PUBSUB_TOKEN            # any long random string you invent
npx wrangler secret put FIREBASE_PROJECT_ID     # task-dashboard-d2b53
npx wrangler secret put FIREBASE_CLIENT_EMAIL   # same service account as taskhub-reminders
npx wrangler secret put FIREBASE_PRIVATE_KEY    # same service account PEM
```

> The Gemini key is deliberately **not** committed. This repo publishes to
> GitHub Pages, so anything committed here is world-readable and the key would
> be scraped and drained within days — which is exactly the failure the
> "never expose API keys in frontend code" rule exists to prevent. Setting it as
> a secret takes one command and it persists across every future deploy.

Check it: `curl https://oneinbox-api.av1.workers.dev/` should report
`ai:true, firestore:true, oauth:true`.

### 4. Real-time push (optional)

```bash
gcloud pubsub topics create oneinbox-gmail
gcloud pubsub topics add-iam-policy-binding oneinbox-gmail \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
gcloud pubsub subscriptions create oneinbox-push \
  --topic=oneinbox-gmail \
  --push-endpoint="https://oneinbox-api.av1.workers.dev/pubsub/push?token=<PUBSUB_TOKEN>"
```

Then set the topic in `workers/oneinbox-api/wrangler.toml`:

```toml
PUBSUB_TOPIC = "projects/task-dashboard-d2b53/topics/oneinbox-gmail"
```

and redeploy. Gmail watches are re-armed daily by the cron tick (registrations
expire after 7 days).

### 5. First run

Open the app → set the OneInbox password (first launch only) → **Connect
Gmail** → repeat per account.

---

## Scheduling

The Cloudflare account's 5-cron free-plan limit is full, so this worker has no
cron trigger of its own. `taskhub-reminders`' every-minute cron POSTs to
`/cron` every 5 minutes — the same piggyback pattern `insight-api` uses. That
tick drives scheduled sends, the Gmail history poll that backstops a dropped
Pub/Sub push, the daily watch re-arm, and the daily card sweep. The worker
rate-limits the expensive parts against timestamps in KV, so most ticks return
almost immediately.

Five minutes is also the KV budget floor: the free plan allows only 1,000 LIST
operations a day, and a counter key (`oi:schedn`) keeps an empty send queue at
one cheap read and zero lists.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Lock service unreachable" | The worker CORS-allows only `https://anthonyn99.github.io`. Opening the file directly (`file://`) or from another host will always fail — use the Pages URL. |
| "Google did not return a refresh token" | The account was authorized before. Remove OneInbox at <https://myaccount.google.com/permissions> and connect again. |
| An account stops syncing after 7 days | The OAuth consent screen is still in "Testing". Publish it. |
| Cards don't appear in TaskHub | Check `dashboards/oneinbox/cards` in the Firebase console. Empty means ingestion hasn't run — hit `/cron` or press Refresh in OneInbox. |
| AI shows `engine: local` | Every Gemini model in the chain is out of quota for the day; the regex parser took over. Extraction is thinner but nothing is lost. |
