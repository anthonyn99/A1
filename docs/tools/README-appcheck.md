# App Check on the Workers

## What this protects

`tradeboard-api` (a live Webull brokerage account + the trade journal),
`trade-dashboard` (the watchlist) and `newshub-api`'s diagnostics were readable
by anyone who knew the URL. This repo is **public**, so no key committed
anywhere can ever be a credential — an App Check token is the only thing a
public browser app can hold, because it is minted at runtime against the
registered origin and never stored.

App Check attests *"this request came from your app"*, not *"this is Tony"*.
It stops strangers. It does not separate T from V — that still needs the
passcode.

## Layout

| | |
|---|---|
| `workers/_shared/appcheck.js` | the one real copy — **edit here** |
| `tools/sync-appcheck.js` | writes it into each worker's generated block |
| `tests/appcheck-verify.test.js` | 22 checks, incl. real-token and forgery cases |

After editing the verifier: `node tools/sync-appcheck.js && npm test`, then
redeploy each worker with `npx wrangler deploy`.

`node tools/sync-appcheck.js --check` fails if a worker has drifted.

## Testing the positive path

A genuine token cannot be committed (public repo, and it expires in about an
hour), so the test skips its positive half unless one is supplied:

```
APPCHECK_TOKEN="<token>" node tests/appcheck-verify.test.js   # 22/22
node tests/appcheck-verify.test.js                            # 14/14, forgeries only
```

Minting one needs a **headed** browser on `https://anthonyn99.github.io` —
reCAPTCHA v3 refuses headless ones, and repeated failures throttle that browser
profile for 24h (`appCheck/initial-throttle`). That refusal is the protection
working; it is also why this cannot be fully automated in CI.

## Deliberately left open

- `trade-dashboard/analysis-config` — the Vault browser extension reads it and
  cannot hold a credential. It returns a prompt template, not personal data.
- `/health`, `/usage`, `/news`, `/quotes`, `/calendar` on newshub — liveness and
  public market data.
