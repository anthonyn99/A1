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

## What lives here, and why these four

On 2026-09-06 account 1 hit the KV **write** cap (1,000/day) outright. That is
the binding limit for this suite — reads run ~5k/day against a 100k allowance,
while writes had averaged ~510/day for a month and were trending up:

| namespace     | writes/day | worker                       |
| ------------- | ---------- | ---------------------------- |
| TOKEN_CACHE   | ~318       | shared by SIX workers        |
| A1_BACKUPS    | ~105       | index-backups                |
| NEWSHUB_CACHE | ~45        | newshub-api                  |
| TD_KV         | ~39        | trade-dashboard              |
| WX_CACHE      | ~39        | taskhub-weather-api          |
| PV_CACHE      | ~38        | proview-api                  |
| others        | ~13        | tesla / tradeboard / insight |

TOKEN_CACHE is 62% of it and **cannot move**: taskhub-reminders, personal-ai,
keychain-sync, vault-pw-sync, oneinbox-api and insight-api all read each other's
keys out of it (`gat`, `jlock:*`, `auth:*`), and a namespace cannot be shared
across accounts. Splitting those six would mean re-architecting the app-lock
system, not moving a folder.

So the split took the four biggest namespaces that ARE independent:

| worker              | namespace  | secrets to re-set | data           |
| ------------------- | ---------- | ----------------- | -------------- |
| index-backups       | A1_BACKUPS | PULL_SECRET       | migrated       |
| trade-dashboard     | TD_KV      | FINNHUB_KEY       | migrated       |
| proview-api         | PV_CACHE   | none              | pure TTL cache |
| taskhub-weather-api | WX_CACHE   | none              | pure TTL cache |

That leaves ~370 writes/day on account 1 and ~220 on account 2 — both under 40%,
with the spike days (900-1000 writes) landing near 50% on either side rather
than over the cap on one.

newshub-api was deliberately left on account 1: it is a similar size but needs
nine API keys re-set by hand, and moving it would have tipped account 2 past
account 1 on the busiest days rather than balancing them.

## Adding a worker

1. `mkdir workers2/<name>` with `worker.js`, `wrangler.toml`, `package.json`.
   Copy `package.json` from any existing worker — it must declare
   `"wrangler": "^4.0.0"` or the deploy silently falls back to the runner's
   cached wrangler v3 and fails on a v4 config.
2. Do **not** put `account_id` in `wrangler.toml`. The workflow supplies it from
   the `CF_ACCOUNT_ID_2` secret. (Workers under `workers/` pin theirs inline
   because that workflow does not pass one.)
3. Give any KV namespace an `id = "kv:<TITLE>"` placeholder (see below).
4. Push. `deploy-workers2.yml` discovers the folder automatically — unlike
   `deploy-workers.yml`, there is no per-worker job to remember to add.
5. The worker comes up at `https://<name>.av1-2.workers.dev`.

## Deploying by hand

`wrangler` picks the account from its OAuth login, which currently only has
account 1 in scope. Either re-run `wrangler login` and grant both accounts, or
just name the account for the one command:

    CLOUDFLARE_ACCOUNT_ID=<account 2 id> npx wrangler deploy

## KV namespaces: `kv:<TITLE>`, not an id

A namespace belongs to one account, so a worker that moves here cannot keep the
id it had. Those ids can only be minted by something holding account 2's
credentials, and the only thing that does is CI. So configs here name the
namespace instead:

    [[kv_namespaces]]
    binding = "A1_BACKUPS"
    id = "kv:A1_BACKUPS"

`workers2/kv-provision.mjs` resolves that title against account 2 — creating it
on first deploy — and writes the real id into the config **inside the runner's
checkout** just before `wrangler deploy`. Nothing is committed. Add a namespace
by naming it; there is no id to go and fetch.

Two consequences worth knowing:

- `npx wrangler deploy` **by hand from this folder will fail** on the unresolved
  id. Run the provisioner first: `CF_API_TOKEN=… CF_ACCOUNT_ID=… node
  ../kv-provision.mjs`, then deploy — or just push and let CI do it.
- An exact title match is required. The script never fuzzy-matches, because
  silently binding to the wrong namespace deploys green and loses data.

## Moving a worker's DATA here

`workers2/kv-migrate.mjs`, driven by the **Migrate a KV namespace to Account 2**
workflow (manual dispatch). It holds both accounts' tokens, which no laptop
does — wrangler's OAuth login only has account 1 in scope.

It only ever writes to the destination and never deletes from either side, so
the source namespace survives as a rollback and a re-run is harmless. Start with
the dry run; it is the default.

A pure TTL cache does not need this at all — PV_CACHE and WX_CACHE were left to
refill themselves.

## What cannot cross the line

KV namespaces, D1, R2, Durable Objects and Queues belong to one account. A
worker here **cannot** bind account 1's KV — including `TOKEN_CACHE`, which
`personal-ai` and `taskhub-reminders` share. A new project that needs to share
state with the existing suite either stays in `workers/`, or talks to it over
HTTP.

Service bindings do not cross either: `taskhub-reminders` drives `oneinbox-api`
through one, which is a reason both stay on account 1.

Secrets (`wrangler secret put`) are per account too and must be re-set here:

    CLOUDFLARE_ACCOUNT_ID=<account 2 id> npx wrangler secret put PULL_SECRET   # index-backups
    CLOUDFLARE_ACCOUNT_ID=<account 2 id> npx wrangler secret put FINNHUB_KEY   # trade-dashboard

Until those are set, `tools/pull-backups.mjs` gets a 401 and trade-dashboard's
`/calendar` returns no earnings dates. Nothing else is affected.

## canary

`workers2/canary` is the smoke test for this lane, not a real project. It holds
no data, no secrets and no bindings, so it is safe to redeploy or delete.

    curl https://canary.av1-2.workers.dev/health

Keep it. When a future `workers2/` deploy fails, one request to the canary
separates "the lane is broken" (token expired, account access revoked,
subdomain changed) from "my new worker is broken" — which otherwise costs an
afternoon of guessing.
