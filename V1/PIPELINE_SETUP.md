# StudyOS Pipeline — one-time setup

The pipeline (upgrade spec Phase 1) is **built, tested, and shipped switched
off**. Three manual steps turn it on. They need Cloudflare credentials, which is
why they were not done automatically — `wrangler kv namespace create` fails from
the dev machine with `Authentication error [code: 10000]`, because the logged-in
OAuth token does not cover the `account_id` pinned in the worker configs.

Everything below is a one-time cost. After it, dropping a deck into a class is
the whole workflow.

---

## What it does once it is on

She drops a lecture deck into a Documents module and walks away. The deck is
rewritten slide-by-slide with her existing prompt, filed into the class as an
editable note, and a push notification says it is ready. The tab can be closed
the whole time — jobs live in the Worker, not the page.

This replaces the current loop: open StudyOS → copy prompt → open the other app
→ find the PDF → upload → paste → wait → download → come back → upload → file it.

---

## Step 1 — create the job store

```bash
cd workers/studyos-ai
wrangler kv namespace create JOBS
```

It prints a 32-character hex id. Open `workers/studyos-ai/wrangler.toml`, find
the commented `[[kv_namespaces]]` block near the top, paste the id in, and
uncomment all three lines:

```toml
[[kv_namespaces]]
binding = "JOBS"
id = "<the 32-hex id>"
```

**Why it ships commented out rather than with a placeholder:**
`tests/worker-deploy.test.js` rejects placeholder KV ids, because a fake id
deploys perfectly and then fails at runtime — the exact silent failure that test
exists to catch. With the block absent the Worker returns a 503 that names the
missing step instead.

## Step 2 — set the API key

```bash
cd workers/studyos-ai
wrangler secret put ANTHROPIC_API_KEY
```

**The key must never go anywhere else.** `V1/config/config.js` is served
publicly at `/studyos/config/config.js`, so anything in it is world-readable.
The key is used only inside the Worker's own route handlers and is never
returned to a client. `npm run test:pipeline` fails the build if a key literal
or a direct `api.anthropic.com` call ever appears in a client file.

## Step 3 — deploy and switch on

```bash
# from the repo root
wrangler deploy --config workers/studyos-ai/wrangler.toml
wrangler deploy --config workers/taskhub-reminders/wrangler.toml   # picks up the new service binding
```

Then in `V1/config/config.js`, set:

```js
ai: { enabled: true, ... }
```

Check it came up:

```bash
curl https://studyos-ai.<your-subdomain>.workers.dev/health
# { "ok": true, "worker": "studyos-ai", "kv": true, "apiKey": true }
```

`kv: false` or `apiKey: false` means step 1 or 2 did not take; the response
carries a `setup` field naming which.

> **Check the subdomain.** `config.js` currently points at
> `vedapatel05.workers.dev` while the worker configs deploy to
> `av1.workers.dev`. Whichever is right, the `ai.baseUrl` in config.js must
> match the URL `wrangler deploy` actually prints.

---

## How it runs

- **Queue:** jobs live in KV. The spec preferred Durable Objects, but those need
  a paid Workers plan and every worker on this account is free-plan — so this
  uses the spec's own stated fallback, KV + a cron drain.
- **Drain:** `taskhub-reminders` already ticks every minute and is the account's
  fan-out point; it POSTs `/cron` here over a **service binding**. Not a plain
  fetch — a same-account worker-to-worker fetch can be silently dropped, a bug
  that already cost this repo a debugging session.
- **One job per tick** by design. A backlog clears at one a minute, so a bulk
  import costs a predictable trickle rather than a burst against the cap.
- **Chunking:** long decks are processed in 15-slide segments with a running
  outline for continuity. The stitcher verifies slide-number coverage and fails
  loudly on a gap, because her prompt forbids skipping slides and a note that
  quietly lost slide 23 still *looks* complete.
- **Checkpointing:** a job that dies at slide 40 of 60 resumes at 41 rather than
  re-paying for the first 40.
- **Idempotency:** the same file + prompt + prompt version returns the cached
  result and spends nothing.

## Cost control

`MONTHLY_CAP_USD` in `workers/studyos-ai/wrangler.toml` (default `20`) is
re-read **before every single model call** and blocks there. The number in
`config.js` is only a display mirror — the enforcement is server-side, per the
spec's non-negotiable. Month-to-date spend shows in the Run sheet before a batch
and at `GET /api/ai/budget`.

To change it: edit the var and redeploy. It takes effect on the next call.

## Security

Every `/api/ai/*` route requires a Firebase App Check token, verified against
the canonical `workers/_shared/appcheck.js` (this worker is registered in
`tools/sync-appcheck.js`, so the verifier is never a hand-copied fork that can
drift weaker). `/cron` is deliberately **not** gated: it arrives over a service
binding and carries no token.

---

## Turning it off

Set `ai.enabled: false` in `config.js`. The feature is fully inert when off —
`boot.js` imports nothing, no run hooks are defined, and the ⚡ button does not
render. Nothing else in StudyOS is affected either way.

## Tests

```bash
node workers/studyos-ai/test-worker.mjs   # 27 — queue, chunking, cap, refusals, resume
cd V1 && npm run test:studyos             # 144 — store, pipeline client, prompts, d2l
```
