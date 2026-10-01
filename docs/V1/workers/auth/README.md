# V1 Auth Worker (`tradeboard-auth`)

Cloudflare Worker that stores the **App-Lock** passwords for every app in the V1
suite. Passwords are never stored in plaintext — each is stretched with
PBKDF2-SHA256 (50k iterations) over a random 16-byte salt, and only
`{salt, hash, iterations, hint, v}` is persisted in Workers KV.

> The Worker is still *named* `tradeboard-auth` because that hostname is already
> wired into the deployed TradeBoard app. Renaming it would change the URL and
> break the live app, so the name stays and the broader scope is documented here.

## Shared across apps

One Worker serves the whole suite. Each app is a distinct `entryId`, so every app
has its **own independent password** while sharing this one deployment:

| App        | `journal` | `entryId`    |
| ---------- | --------- | ------------ |
| TradeBoard | `applock` | `tradeboard` |
| Finance    | `applock` | `finance`    |

KV keys are `lock:${journal}:${entryId}`, so entries never collide. Changing or
resetting one app's password has no effect on the other.

## Deployment — automatic

Pushing any change under `workers/**` to `main` triggers
`.github/workflows/deploy-workers.yml`, which deploys this Worker in CI.
**You never run `wrangler deploy` by hand.**

Manual fallback, if CI is ever unavailable:

```powershell
cd workers/auth
npx wrangler deploy
```

## Endpoints

| Method | Path                        | Body                                    | Reply                    |
| ------ | --------------------------- | --------------------------------------- | ------------------------ |
| POST   | `/auth/journal/set-lock`    | `{journal,entryId,password,hint?}`      | `{ok,v}`                 |
| POST   | `/auth/journal/verify`      | `{journal,entryId,password}`            | `{ok}`                   |
| POST   | `/auth/journal/remove-lock` | `{journal,entryId,password}`            | `{ok}`                   |
| POST   | `/auth/journal/hint`        | `{journal,entryId}`                     | `{hint}` / `{noLock}`    |
| POST   | `/auth/reset/request`       | `{journal,entryId}`                     | `{ok,code}` / `{noLock}` |
| POST   | `/auth/reset/confirm`       | `{journal,entryId,code,password,hint?}` | `{ok,v}` / `{error}`     |
| GET    | `/health`                   | —                                       | `{ok:true}`              |

Reset codes are 6 characters, single-record, expire in 15 minutes, and lock out
after 5 bad attempts. The **client** (browser) emails the code via Formspree; the
Worker only mints and validates it, so no email credentials live here.

## KV

Binding `LOCKS` — created once via `scripts/setup.ps1`. The namespace id is
committed in `wrangler.toml`; a KV namespace id is not a secret (it is
meaningless without account credentials).
