# Security review — V1 suite

Scope: the Finance app, the Finance API Worker, the shared auth Worker, and the
repository itself. Written against the code as committed.

---

## 1. Trust model

Finance is a **single-user personal app**. The security boundary is deliberately
*not* a Firebase user account:

| Layer | What it actually protects |
| ----- | ------------------------- |
| Firebase **anonymous auth** | Proves a request came from *a* browser session. Not a person. |
| Firebase **App Check** (reCAPTCHA v3) | Attests the request came from the real deployed app, not a script hitting the API directly. This is what makes anonymous auth acceptable. |
| **App-Lock password** (PBKDF2, Worker + KV) | The human boundary. Gates the UI and, more importantly, mints the session token required by every Plaid endpoint. |
| **Firestore rules** | Confine each app to its own path. Finance cannot read TradeBoard's document and vice versa. |
| **Session token** | Required by every privileged Worker route. Stored in KV server-side; revoked by "Lock now". |

An attacker who somehow obtained an anonymous Firebase session still cannot mint
a Plaid session token without the app-lock password, and therefore cannot link
institutions, list them, or trigger a sync.

---

## 2. Secret handling

### What is secret, and where it lives

| Secret | Location | In the repo? |
| ------ | -------- | ------------ |
| Plaid client secret | Cloudflare Worker secret | ❌ never |
| Plaid `access_token` (per bank) | Workers KV only | ❌ never |
| Firebase service-account JSON | Cloudflare Worker secret | ❌ never |
| App-Lock password | Never stored — only PBKDF2(salt, 50k, SHA-256) in KV | ❌ never |
| Webull token | `TradeBoard/conf/token.txt`, gitignored | ❌ never |

### What is public *by design*

The Firebase web config (`apiKey`, `projectId`, …) and the reCAPTCHA **site**
key are in `Finance/finance.html`. This is correct and not a leak:

- A Firebase web `apiKey` **identifies** a project; it authorizes nothing. Access
  is decided by Firestore rules plus App Check.
- A reCAPTCHA *site* key is meant to be public; the *secret* key is the one that
  must stay private, and it lives in Google's console, not here.

### Verified during this build

- `TradeBoard/conf/token.txt` was about to be committed when the repo was
  restructured — the old `.gitignore` pattern `conf/*.txt` is **root-anchored**
  and stopped matching once the file moved into `TradeBoard/`. Caught before the
  commit; confirmed **never present in git history**; patterns rewritten with
  `**/` prefixes so they keep matching regardless of where an app moves.
- `Finance/finance.html` was scanned for the reference app's infrastructure
  (its Firebase project, Worker hostnames, Formspree form, reCAPTCHA key,
  owner email). **Zero matches** — Finance is wired entirely to your own
  infrastructure.
- `workers/finance-api/src/index.js` scanned for hardcoded credentials. **None.**

---

## 3. Finance API Worker

**Good:**

- Every privileged route (`/link/*`, `/items*`, `/sync`) calls `requireSession()`
  first. There is no unauthenticated path to Plaid.
- `/items` explicitly strips `access_token` before responding — the browser is
  structurally unable to obtain it.
- Plaid errors are re-thrown with only Plaid's own error code; the request body
  (which carries the client secret) is never echoed into a response.
- The catch-all handler logs the stack but returns only a message, so internals
  don't reach the client.
- `/transactions/sync` loop is bounded (`guard < 20`) so a malformed cursor
  cannot spin forever and burn CPU/quota.
- Constant-time-ish comparison helper is available for token comparison.

**Accepted limitations (documented, not defects):**

- **CORS defaults to `*`** until `APP_ORIGIN` is set. This is a deliberate
  bootstrap convenience for a Worker deployed before its site URL is known.
  **This has since been set** to the site Worker's origin. Note that
  CORS is a browser-side control only; it is defence-in-depth here, not the
  primary boundary (the session token is).
- **Session fingerprint is stored but not enforced on `/lock/check`.** A session
  survives a password change until it is explicitly ended. For a single-user
  personal app this is the intended trade-off (it keeps trusted devices logged
  in); "Lock now" revokes server-side immediately. If you later want a password
  change to log out every device, enforce `fp` comparison in `checkSession`.
- **No rate limiting** on `/lock/session`. The upstream auth Worker's reset flow
  is rate-limited (5 attempts), but password *verification* is not. Cloudflare's
  default DDoS protection applies. Consider adding a KV-backed attempt counter if
  this ever becomes multi-user.

---

## 4. Client-side

- **No `innerHTML` injection of untrusted data without escaping.** Every
  interpolated value passes through `esc()`, which escapes `& < > " '`.
  Transaction names, merchant strings, categories, notes, institution names and
  CSV-derived fields are all escaped at the point of render.
- **Bank logos** are rendered as `<img src>` from Plaid's CDN with an `onerror`
  that removes the element. URL is escaped; worst case is a broken image.
- **`localStorage`** holds only the session token, the display-mode flag, the
  locked flag, and the WebAuthn credential *handle* — no financial data and no
  password.
- **WebAuthn** returns only a public-key credential handle. Raw biometric data
  never leaves the OS secure enclave and the app cannot read it.
- Biometrics are a **local gate**, not a replacement for the password: they
  release an already-minted session, and the password is what mints one.

---

## 5. Data flow

```
Browser ──password──▶ tradeboard-auth Worker ──PBKDF2──▶ KV  (verify only)
Browser ──password──▶ finance-api Worker ──▶ session token (KV)
Browser ──session───▶ finance-api ──client_secret──▶ Plaid
                              │
                              └──service account──▶ Firestore
Browser ──anon auth + App Check──▶ Firestore (read/write finance/**)

Bank credentials ──────▶ Plaid ONLY. Never touch this app or its Worker.
```

---

## 6. Recommendations, by priority

| # | Priority | Item |
| - | -------- | ---- |
| 1 | ~~High~~ ✅ | `APP_ORIGIN` is set to the site Worker's origin. Add any future custom domain to the list. |
| 2 | ~~High~~ ✅ | Firestore rules deployed to `tradeboard-6b2ea` and verified compiling. |
| 3 | Medium | Delete the downloaded service-account JSON after setting the secret. |
| 4 | Medium | Use a **different** app-lock password for Finance than TradeBoard. They are independent by design (separate `entryId`). |
| 5 | Low | Consider enforcing the session fingerprint if you ever want password changes to log out all devices. |
| 6 | Low | Rotate the Plaid sandbox secret after going to production; it is no longer needed. |

---

## 7. What was explicitly *not* copied from the reference app

Per the brief, the friend's Insight app was used as a **functional reference
only**. None of the following were carried over:

- Their Firebase project, API key, or App Check site key
- Their Worker hostnames (`insight-api`, `taskhub-reminders`)
- Their Formspree form id or notification email
- Their Plaid deployment or any credential

`insight.html` and `tradehub.html` are gitignored so they can never be published
from this repository — they contain a third party's live infrastructure.
