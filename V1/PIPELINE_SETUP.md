# StudyOS Pipeline — how to run it

Drop a lecture deck into a class, walk away, come back to a rewritten PDF
filed in that class — one page per slide, the original slide image paired with
its rewritten explanation.

There are **two interchangeable backends** behind the same `/api/ai/*` contract.
`config.cloudflare.ai.baseUrl` alone decides which one is used.

| | Local browser bridge | Cloudflare Worker |
|---|---|---|
| Cost | **Free** — spends your Pro subscription | Per-token API billing |
| Needs | A logged-in Chrome profile | `ANTHROPIC_API_KEY` + a KV namespace |
| Reachable from | This PC only | Anywhere, including the phone |
| Status | **Active** | Built and tested, dormant |

The local bridge is what ships enabled today.

---

## The local bridge (current setup)

### One time

```bash
cd V1/tools/sos-browser
pip install playwright pyyaml pymupdf
playwright install chromium
python driver.py login --site claude
```

The last command opens a real Chrome window. Sign in by hand, then press Enter
in the terminal. The profile lives in `tools/sos-browser/profiles/claude/` and
stays authenticated for weeks — it is never your everyday Chrome profile, and it
is gitignored.

> **Close that window when you're done.** A browser still holding the profile
> makes the next run fail with `Opening in existing browser session`.

### Every time you want the pipeline

```bash
cd V1/tools/sos-browser
python server.py
```

Leave it running. StudyOS talks to `http://127.0.0.1:8781`. With it stopped, the
Run sheet reports a connection failure — no silent hang, no spend.

### Check it works

```bash
curl http://127.0.0.1:8781/health
# {"ok": true, "bridge": "sos-browser", "driver": true, "jobs": 0}

python driver.py doctor --site claude
# want: "signed_in": true, "challenge": false
```

If `signed_in` is false, run the `login` command again.

---

## Using it

1. Open a class → a Documents module → upload a deck (PDF).
2. Click **⚡** on the file row.
3. Pick a prompt, optionally give the slide count, hit **Run**.
4. The rewritten deck lands as a **PDF file** in a `Generated` documents
   module in that class, created on demand. It opens, downloads and syncs like
   any file you uploaded yourself.

   Each page carries the real slide image (re-rendered from your source PDF by
   PyMuPDF) above Claude's rewritten text for that slide, matched by the
   `## Slide N` numbers. Re-running the same source replaces its previous deck
   rather than stacking copies.

   If the layout step fails, the job still completes with its text and says why
   in `pdfError` — a broken render never costs you the generation.

**Auto-run**: set a module's default prompt (P-4) and anything dropped into it
runs itself. No clicks at all.

**Jobs panel**: progress, retry, cancel. Jobs survive closing the StudyOS tab —
they run in the bridge process, not the page. They do *not* survive stopping the
bridge; a job caught mid-run is marked `interrupted` rather than left claiming to
be running.

---

## When something breaks

| Symptom | Cause | Fix |
|---|---|---|
| `needs_login` | Session expired | `python driver.py login --site claude` |
| `Opening in existing browser session` | A browser still holds the profile | Close it, or kill Chrome processes whose command line contains `sos-browser\profiles` |
| `bot_challenge` | Cloudflare wants a human | `login`, clear it by hand once |
| `rate_limited` | Subscription limit hit | Wait for the reset the message names |
| `slides not covered: N` | The model skipped slides | Retry from the Jobs panel; the chunker resumes, it does not restart |
| Run sheet says connection failed | Bridge isn't running | `python server.py` |
| `no_input` / `doctor` shows missing selectors | The site changed its markup | Add the new selector at the **top** of that list in `selectors.yaml` — never replace the old one, sites roll changes back |

Failure dumps (HTML + screenshot) land in `tools/sos-browser/artifacts/`.

---

## Switching to the Worker backend

Only worth it if you want the pipeline on your phone, and are willing to pay per
token. In `config/config.js`:

```js
baseUrl: 'https://studyos-ai.vedapatel05.workers.dev',
```

Then, from a shell authenticated to the Cloudflare account that owns the other
workers (`b9a33dd573c14d5f446516ea8b46285f`):

```bash
cd workers/studyos-ai
wrangler kv namespace create JOBS      # paste the id into wrangler.toml
                                       # and uncomment the three binding lines
wrangler secret put ANTHROPIC_API_KEY
wrangler deploy
```

Then uncomment the `STUDYOSAI` service binding in
`workers/taskhub-reminders/wrangler.toml` — **only after `studyos-ai` is actually
deployed.** A binding to a worker that does not exist makes
`wrangler deploy` reject `taskhub-reminders` outright, and that worker carries
the whole suite's app locks and password reset codes.

`pipeline.js` detects the localhost URL and attaches file bytes for the bridge;
the Worker fetches them from `studyos-files` itself. Nothing else differs.

---

## Testing

```bash
cd V1
npm run test:studyos          # unit: store, pipeline, prompts, d2l
npm run verify                # real browser: boot + pipeline UI
node scripts/verify-autorun.mjs

cd tools/sos-browser
python test_driver.py         # driver: config, markdown walker, strip patterns
python test_pdfrender.py      # output: slide splitting, layout, PDF assembly
```

The `verify-*` scripts drive the built page in headless Edge and skip cleanly
(exit 0) when no browser is installed.

---

## A note on what this is

The bridge automates a chat UI you are already logged into — the same thing as
typing into the box yourself. It deliberately does **not** solve CAPTCHAs,
automate signing in, or work around a rate limit; any of those stops the run and
asks for a human.

Automating these UIs may be against the site's terms of service. That is the
operator's call for their own account.
