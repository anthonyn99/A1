# StudyOS Pipeline — how to run it

Drop a lecture deck into a class, walk away, come back to a generated deck filed
in that class.

**Two engines, and they do different jobs:**

| | Engine | Produces |
|---|---|---|
| **Slide decks** | NotebookLM | A **new** deck generated from your source under your prompt, downloaded as a PDF |
| Prompts & notes | Claude | Rewritten text, filed as a note |

Deck generation goes to NotebookLM only — the ⚡ button on a file does not ask.
Claude is still the engine everywhere else, and the older Claude *rewrite* path
(your original slide images paired with rewritten text) is still in the code and
still reachable by posting `mode: 'rewrite'` to the bridge directly.

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
pip install -r requirements.txt
playwright install chromium
python driver.py login --site notebooklm    # for slide decks
python driver.py login --site claude        # for prompts and notes
```

Each `login` opens a real Chrome window. Sign in by hand, then press Enter in the
terminal. The profiles live in `tools/sos-browser/profiles/<site>/` and stay
authenticated for weeks — they are never your everyday Chrome profile, and they
are gitignored.

**Both sign-ins are separate and both are needed** if you want decks *and* notes.
A missing one surfaces as `needs_login` naming the site, never as a silent
failure.

> **Close that window when you're done.** A browser still holding the profile
> makes the next run fail with `Opening in existing browser session`.

### Start it at logon (do this once, then forget it)

```bash
cd V1/tools/sos-browser
python server.py autostart
```

Installs a per-user Startup shortcut and starts the bridge immediately, so you
never type a command again — open StudyOS and press ⚡.

It runs under `pythonw.exe`, so there is no console window. A second copy cannot
start: the bridge checks `/health` first and exits if one is already up (two
processes sharing one Chrome profile is the `Opening in existing browser session`
failure).

```bash
python server.py autostart status   # installed? running?
python server.py autostart off      # stop starting at logon
```

A Startup shortcut, not a Scheduled Task — the same call `magi autostart` makes,
for the same reason: `Register-ScheduledTask` needs elevation, and an autostart
that prompts for admin to install is not an autostart. The shortcut lives in
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` and you can delete it
by hand.

### Or run it in the foreground

```bash
cd V1/tools/sos-browser
python server.py
```

Leave it running. StudyOS talks to `http://127.0.0.1:8781`. With it stopped, the
Run sheet says **Bridge not running** and names the autostart command — no silent
hang, no spend.

### Check it works

```bash
curl http://127.0.0.1:8781/health
# {"ok": true, ..., "modes": ["rewrite", "notebooklm"]}

python driver.py doctor --site claude
python driver.py doctor --site notebooklm
# want: "signed_in": true, "challenge": false
```

If `signed_in` is false, run the `login` command again.

`doctor --site notebooklm` also lists `unchecked` selectors. That is expected and
not a fault: most of the wizard does not exist until a notebook is open, so those
are probed by the dry run below instead.

---

## Using it

1. Open a class → a Documents module → upload a deck (PDF).
2. Click **⚡** on the file row.
3. Pick a prompt, hit **Run**. (No slide count — NotebookLM generates the whole
   deck in one pass and never reads it.)
4. NotebookLM creates a notebook, uploads your source, runs Slide Deck with your
   prompt, and the finished PDF is downloaded and filed as
   `<name> — Slides.pdf` in a `Generated` documents module in that class,
   created on demand. It opens, downloads and syncs like any file you uploaded
   yourself.

**It takes a while** — often 10–30 minutes. The job survives closing the tab, and
the Jobs panel shows `running` the whole time rather than a fake progress bar.

Re-running the same source replaces its previous deck rather than stacking
copies. A Claude rewrite of the same lecture is kept separately (the two are
keyed by engine), so generating one never destroys the other.

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
| `needs_login` | Session expired | `python driver.py login --site <site>` — the message names it |
| `Opening in existing browser session` | A browser still holds the profile | Close it, or kill Chrome processes whose command line contains `sos-browser\profiles` |
| `bot_challenge` | Cloudflare wants a human | `login`, clear it by hand once |
| `rate_limited` | Subscription limit hit | Wait for the reset the message names |
| `slides not covered: N` | The model skipped slides | Retry from the Jobs panel; the chunker resumes, it does not restart |
| `Bridge not running` on the Run sheet | The bridge is down | `python server.py autostart` (once, then never again) |
| It did not come back after a reboot | Startup shortcut missing | `python server.py autostart status` |
| `no_input` / `doctor` shows missing selectors | The site changed its markup | Add the new selector at the **top** of that list in `selectors.yaml` — never replace the old one, sites roll changes back |
| `nlm_no_create`, `nlm_no_studio`, `nlm_no_generate`, any `nlm_no_*` | A NotebookLM selector guess is wrong | The error names the field. See **First-run selector repair** below — do not just retry, the markup will not have changed |
| `nlm_source_timeout` | The upload never finished ingesting | Usually a large PDF; retry. If it completed on screen, `source_ready` is the wrong selector |
| `nlm_timeout` | No finished deck within 30 min | If the deck **did** finish on screen, `artifact_ready` is wrong — fix that before raising `gen_timeout_s` |
| `nlm_generation_failed` | NotebookLM said it failed | Retry from the Jobs panel; often transient |
| `nlm_not_pdf` | The download was not a PDF | Usually a sign-in page. Re-run `login --site notebooklm` |
| A Claude job sat queued for half an hour | A NotebookLM deck was ahead of it | Expected: one job at a time, because two runs cannot share one Chrome profile |

Failure dumps (HTML + screenshot) land in `tools/sos-browser/artifacts/`.

---

## First-run selector repair

**This is the one part of StudyOS that is expected to fail the first time you
use it, by design.**

The Claude and Gemini selectors in `selectors.yaml` were measured against real
logged-in sessions. The NotebookLM ones under `decks:` could not be — it is an
obfuscated Angular app, and they were written without a live session. They are
labelled `UNVERIFIED` in the file for that reason.

Repair them with the dry run, which walks the whole wizard but **stops before
Generate**:

```bash
cd V1/tools/sos-browser
python driver.py deck --site notebooklm \
  --source path/to/any.pdf --out ./outputs/probe.pdf \
  --prompt "test" --dry-run --headful
```

It prints the selector that matched for each step, or names the one that missed:

```json
{"ok": false, "kind": "nlm_no_studio",
 "error": "NotebookLM: no element matched `studio_tab`. ... Artifacts: ..."}
```

Open the newest `artifacts/notebooklm-studio_tab-*.html`, find the real element,
and add its selector at the **top** of that list in `selectors.yaml` — never
replace the existing entries, since Google A/B tests and rolls back. Re-run.

Expect roughly 4–8 iterations at about a minute each. The alternative — finding
each miss by running a real generation — costs ~25 minutes per selector, which is
the entire reason `--dry-run` exists. Stop when it reports:

```json
{"ok": true, "dryRun": true, "stoppedAt": "before Generate", "matched": {...}}
```

Then run it once **without** `--dry-run` and open the resulting PDF by hand. That
last check is manual on purpose: no assertion can tell you whether the deck is
actually about your source.

> Each dry run creates a real notebook with a real uploaded source in your
> NotebookLM account. Eight iterations leaves eight junk notebooks — delete them
> by hand when you are done.

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
python test_driver.py         # driver: config, deck config, markdown walker
python test_server.py         # bridge: mode routing, retry table, pdf guard
python test_pdfrender.py      # output: slide splitting, layout, PDF assembly
```

The `verify-*` scripts drive the built page in headless Edge and skip cleanly
(exit 0) when no browser is installed.

---

## A note on what this is

The bridge automates a UI you are already logged into — the same thing as
clicking through it yourself. It deliberately does **not** solve CAPTCHAs,
automate signing in, or work around a rate limit; any of those stops the run and
asks for a human. Those three failures are also the ones the bridge refuses to
retry, which is pinned by a test rather than left to good intentions.

Automating these UIs may be against the site's terms of service. That is the
operator's call for their own account. Worth knowing that the NotebookLM path is
closer to content *production* than the chat path is — it creates notebooks and
generates artifacts in your account — so it is the more visible of the two.
