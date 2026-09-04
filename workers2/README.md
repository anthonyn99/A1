# workers2 — Cloudflare "My Account 2"

Every worker in this folder deploys to the **second** Cloudflare account
(`av1-2.workers.dev`), not the one the rest of A1 uses.

## Why a separate folder

The account a worker lands on is decided by which workflow deploys it, and each
workflow carries exactly one API token:

| Folder         | Workflow                  | Cloudflare account            | Subdomain             |
| -------------- | ------------------------- | ----------------------------- | --------------------- |
| `workers/`     | `deploy-workers.yml`      | anthonypn99@gmail.com         | `av1.workers.dev`     |
| `V1/workers/`  | `deploy-v1-workers.yml`   | Veda's                        | `vedapatel05.workers.dev` |
| `workers2/`    | `deploy-workers2.yml`     | **My Account 2**              | `av1-2.workers.dev`   |

The folder IS the routing. A worker put in `workers/` deploys to account 1 no
matter what its config says, so the split has to be physical.

Free-tier limits (100k requests/day, KV quotas) are per account, which is the
whole point of this folder: new projects here don't eat account 1's budget.

## Adding a worker

1. `mkdir workers2/<name>` with `worker.js`, `wrangler.toml`, `package.json`.
   Copy `package.json` from any existing worker — it must declare
   `"wrangler": "^4.0.0"` or the deploy silently falls back to the runner's
   cached wrangler v3 and fails on a v4 config.
2. Do **not** put `account_id` in `wrangler.toml`. The workflow supplies it from
   the `CF_ACCOUNT_ID_2` secret. (Workers under `workers/` pin theirs inline
   because that workflow does not pass one.)
3. Push. `deploy-workers2.yml` discovers the folder automatically — unlike
   `deploy-workers.yml`, there is no per-worker job to remember to add.
4. The worker comes up at `https://<name>.av1-2.workers.dev`.

## Deploying by hand

`wrangler` picks the account from its OAuth login, which currently only has
account 1 in scope. Either re-run `wrangler login` and grant both accounts, or
just name the account for the one command:

    CLOUDFLARE_ACCOUNT_ID=<account 2 id> npx wrangler deploy

## What cannot cross the line

KV namespaces, D1, R2, Durable Objects and Queues belong to one account. A
worker here **cannot** bind account 1's KV — including `TOKEN_CACHE`, which
`personal-ai` and `taskhub-reminders` share. A new project that needs to share
state with the existing suite either stays in `workers/`, or talks to it over
HTTP. Secrets (`wrangler secret put`) are per account too and must be re-set here.

## canary

`workers2/canary` is the smoke test for this lane, not a real project. It holds
no data, no secrets and no bindings, so it is safe to redeploy or delete.

    curl https://canary.av1-2.workers.dev/health

Keep it. When a future `workers2/` deploy fails, one request to the canary
separates "the lane is broken" (token expired, account access revoked,
subdomain changed) from "my new worker is broken" — which otherwise costs an
afternoon of guessing.
