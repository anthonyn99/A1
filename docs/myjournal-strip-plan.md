# MyJournal strip — phased handoff

Kept as a record once the strip is done (Tony, 2026-09-29: old plans cost nothing to keep).

## §0 Status (rewrite at the end of every phase)

- **Done.** Phases 0-4 all finished on 2026-09-29. Nothing is left to build. The strip itself was Phases 1-3; Phase 4 was cleanup plus the self-cleanup system.
- **The self-cleanup system is running in dry-run.** The only item that deletes is `mjd-rail-leftovers`, which the Phase 1 boot purge already deleted on every load. Every other item has `"delete": false`.
  - To turn an item on: set `"delete": true` in `cleanup-rules.json` and add an `"approved"` note (`tests/cleanup-rules.test.js` requires one). For the two KV items, also flip `SWEEP_STALE_TOKENS` in the worker (the test checks that the two match).
  - What would go: in a browser, `A1Sweep.report()` (or `A1Sweep.run({force:true, dryRun:true})`). On a MAGI PC, `data/<profile>/sweep.json`, or `magi.venvScriptspython.exe -m magi.sweep`.
- **How it is built:**
  - `cleanup-rules.json` at the repo root is the one registry. Every item has an owner, a reason, a category, a cap and a delete flag. It also has the limits, a `handledElsewhere` list and a `never` list.
  - `sweep.js` is the browser half, loaded as `<script src="sweep.js" data-program="<page>" defer>`. Only index.html loads it today, because only index owns browser items. A page that gets items must load it (the test checks).
    - Firestore goes only through the page adapter `window._a1SweepFirestore` (index: `ready: () => _tjServerSeen`).
  - `magi/sweep.py` is the disk half. It runs on engine startup and once a day from the watchdog, and reaches PCs through the self-update.
  - The workers delete a stale `locktok` inside `tokenValid()`, on a request that already happens.
- Tests: `tests/cleanup-rules.test.js` (caps, dead keys unused, wiring, and the shipped sweep.js in jsdom) and `magi/tests/test_sweep.py`. Both were mutation-checked.
- Also in Phase 4: deleted the root `debug.log`, the root `.pytest_cache/` (now gitignored) and 116 MAGI artifacts older than 7 days (69 MB). Removed the per-load mjd purge in index.html, because the registry owns it now.
- Verified headless (`file://`, rules handed to `fetch`): `A1Sweep` loads as `index`. A forced run deleted only `mjd_*`, listed warden/fcm_pv/myjournal_docs, made 0 Firestore deletes and left `keep_me`. A MyJournal entry saves, OurJournal enters and leaves, and Brainstorm opens. `npm test` 53/53. MAGI pytest: 1316 passed. `test_model_shown`/`test_morning_run` fail to collect from the repo root (`tests.test_completion` import path), which is unrelated.
- Headless verify notes (still true):
  - Seed storage with `Page.addScriptToEvaluateOnNewDocument`, guarded by a sessionStorage flag so a reload doesn't reseed.
  - TJ sidebar rows (`.entry-item`) have no `data-id`; find a row by its `.entry-item-title` text.
  - Run the test browser on its own port and `--user-data-dir`, and kill it by that dir, never by image name.
  - Pick the CDP target whose url contains index.html: Edge can open an `edge://sync-confirmation-dialog` page first.

### Rules for every phase
- `git pull` first. Tony and Veda both push.
- Change **MyJournal only** (`#tj-root`, `_tj*`, `MJDocs`/`MJDocsUI`).
  - Do NOT change Journal (the `pages` section) or OurJournal. OurJournal keeps Whiteboard and Mind Map.
  - Do NOT change Veda's Brainstorm Journal (`#bj-root`, `_bj*`), and not TaskHub.
- index.html is ~46k lines. Line numbers below are approximate as of 2026-09-29, so grep the identifier before you edit.
- Worker edits auto-deploy (see memory `worker-deploy-silent-failures`). Run `node --check` on a worker before pushing it.
- **Delete comments that describe removed features.** When code goes, the comments that explain it go too, wherever they are. If a surviving comment mentions a removed feature in passing, reword it. Comment-only edits in OurJournal code are allowed; its behaviour still must not change.
  - Keep comments that explain code which is still live, such as the boot purge and `prune()`.
  - Leave unrelated uses alone: "cloud doc" meaning a Firestore document (TaskHub and so on), and "paste from Word / Google Docs".
- At the end of each phase:
  1. Run `npm test`.
  2. Run the `/verify` headless check: MyJournal, OurJournal inside MyJournal, and Veda's Brainstorm Journal.
  3. Grep for leftover identifiers.
  4. Rewrite §0.
  5. Commit and push.

## How it is built
- **One engine runs all of it.** Docs, OneNote, Starred, Recent, Find, the gear and the rail all live in `window.MJDocs` (~40976–42642), its CSS `<style id="mjd-css">` (~42656–43236) and `MJDocsUI` (~43239–45003).
- **OurJournal hangs off that rail, so the rail must stay.** `intoMjd`, `_tjModeUI`, `onTab` and `_tjOJEnter` (~33530–33658) need:
  - `#mjd-nav`
  - `.mjd-rail`
  - `[data-sec="pages"]`
  - `#mjd-panel`
  - the capture listener on `[data-sec]`
  - `window._tjCloudMode`
  - `MJDocsUI.release`
- **Firestore doc `dashboards/myjournal_docs`** (listener ~13029–13091) is only used by this engine. It is also referenced in:
  - `backup.js:136` (`GROUP1_COUNT = 11`)
  - `tests/backup-measure.test.js:307`
- **`/docs/ai` in `workers/personal-ai/worker.js`** (~2540, ~2857) is only called from MJDocs Find and its AI panel.
- **Source ids:** `'gdocs'`, `'onenote'`, `'pages'` (the Journal button), and the adapter `mjpages`.
  - `validSection()` maps an unknown saved section to `'pages'`.
- **Template picker:** MyJournal's is `#tj-template-modal` (~30761). The modal at ~25024 is Veda's.
  - OurJournal inside MyJournal uses the SAME modal and the SAME board code: `_tjBoard`, `#tj-wb-*`/`#tj-mm-*`, and the board branches in `showTemplate`/`loadActiveEntry`/save/PDF.
  - VizEngine (~20656–22530) and the JGuard board cases (~20453–20542) are also shared with Brainstorm.
- **`Vault/oauth-silent.html` is used by Vault.** Keep it.

## Phase 1: Remove Google Docs and OneNote
index.html:
- **Delete from MJDocs:**
  - `Tokens`/`usableToken`
  - `renewers`/`keepAlive`: the 4-minute interval, the visibilitychange listener, and the online listener (keep `flushQueue` there if the queue survives)
  - `redirectUri`/`b64url`/`pkcePair`/`oauthPopup`
  - the HTML normalisation helpers (`stripDoc`, `cleanStyles`, `flattenOneNote`, …)
  - the whole `gdocs` provider, including `GIS_SRC`/`loadGis`/`gdocsSilentToken`
  - the whole `onenote` provider
  - `register(gdocs)`, `register(onenote)` and the renewers
  - `providerCfg` and `accountMeta` in `DEFAULTS`
  - `isPermanentRefusal`
  - the `Tokens` and `redirectUri` exports
- **Delete from MJDocsUI:**
  - the connect/not-set-up screens in `renderPanel`
  - the OneNote locked-section message
  - the cloud branch of `openDocument`, plus `flushSave`, the conflict code and the docbar
  - `openActions`/`capFor` and the rename/duplicate/delete/move/picker/`onNew`/export actions
  - `doConnect`/`buildRailDots`/`openAccounts`
  - the rail dots, and the `#mjd-new-btn`/`#mjd-refresh-btn`/`#mjd-acct-btn` buttons
  - the Ctrl+S and pagehide handlers for cloud documents
  - every string that mentions "Google Docs" or "OneNote"
- **Delete the matching CSS:**
  - `.mjd-dot`
  - `.mjd-note.mjd-locked`
  - `.mjd-connect-cta`
  - `#mjd-docbar`, `.mjd-chip`, `#mjd-lastsync`, `#mjd-offline`
  - `.mjd-card`/`.mjd-disclose`/`.mjd-instructions`/`.mjd-acct`/`.mjd-badge`
  - `.mjd-conflict`
  - the mobile overrides
- **Add a one-time purge on boot.** Wrap every storage call in try/catch, because Veda's Brave throws on storage. It removes:
  - `mjd_tok_*` (live OAuth tokens)
  - `mjd_cache` and `mjd_queue`
  - `docx_hist_tj_mjd_*` and `docx_scroll_tj_mjd_*`
  - `providerCfg`/`accountMeta`, deleted from the settings object by name, because `Object.assign(DEFAULTS, r)` would keep them.
- **Bug fix:** filter `favorites`, `recents` and the index to registered providers.
  - Clicking an old Docs/OneNote star makes `paintDocBar` throw on a null provider.
  - That leaves `_tjCloudMode = true`, and journal saves are then skipped silently.

Outside index.html:
- Delete `docs/MYJOURNAL_CLOUD_SETUP.md`.
- In the personal-ai worker, reword the comment at `worker.js` ~100 and the prompt at ~2694, and the comment in `wrangler.toml` ~57. The route itself goes in Phase 2.

**Verify:**
- The rail shows OURJOURNAL and JOURNAL.
- A seeded `mjd_settings` with `section:'gdocs'` lands on Journal.
- OurJournal enters and leaves correctly.
- Journal entries save.
- A grep for `gdocs|onenote|oauth|GIS_SRC` finds nothing left in MJDocs.

## Phase 2: Remove Starred, Recent, Find and the gear
Shrink MJDocs down to a minimal rail module.
- **Keep:**
  - `#mjd-nav > .mjd-rail` with the single `[data-sec="pages"]` Journal button
  - `#mjd-panel`, even if it stays hidden
  - `setSection('pages')`
  - `MJDocsUI.release`, as an export that is safe to call when there is nothing to release
  - `_tjCloudBridge.openLocal`/`localDocs`, only if a grep shows callers
- **Delete:**
  - the `.mjd-quick` row
  - Starred/Recent: `renderFlat`, `favorites`/`recents`, `toggleFav`, `touchRecent`, the row stars, and the "Add to favourites" item
  - the Find overlay: `#mjd-omni`, everything from `ensureOmni` to `runOmniAi`, and `runGroupOp`
  - the Ctrl+Shift+F shortcut
  - `openSettings`
  - the AI panel (`openAiPanel`, `runAiTool`), which is already unreachable
  - the `mjpages` provider, the index and the listing cache, once nothing uses them
  - `view.section` sync and `mjd_settings`
  - the matching CSS: `.mjd-quick`, `#mjd-omni*`, `.mjd-hit*`, and the modal and toast if unused
  - the `_tjCloudMode` hooks in `loadActiveEntry`/`saveCurrentEntry`/`autoSave`/`setEditMode`, once cloud mode can't be entered. If OurJournal code still reads `_tjCloudMode`, keep it as a constant `false` rather than editing OurJournal.
- **Firestore doc:**
  - Delete the `dashboards/myjournal_docs` listener, `_fbLoadMJDocs`/`_fbSaveMJDocs` and the `fb-mjdocs-*` events.
  - Remove `'myjournal_docs'` from `backup.js`, then check what `GROUP1_COUNT` counts before changing it to 10.
  - Update `tests/backup-measure.test.js`.
- **Worker:** delete the `/docs/ai` route and `handleDocsAi` after grepping the whole repo for callers.
- **Stale comments left over from Phase 1.** Grep `google doc|onenote|gdocs|cloud doc|cloud mode|cloud tab|cloud panel` and fix each hit. As of 2026-09-29 they are:
  - ~13029–13071: the `myjournal_docs` Firestore block. It is deleted in this phase anyway.
  - ~20407–20425: the JGuard comment ("Docs / OneNote document MJDocs opens", "cloud mode").
  - ~29392: "Matches the cloud tabs".
  - ~30819, ~31651–31653, ~31726, ~31774: the `saveCurrentEntry`/`loadActiveEntry` cloud-mode notes. They go with the `_tjCloudMode` hooks.
  - ~33291–33293 and ~33373–33377: the autoSave/setEditMode "CLOUD MODE" blocks.
  - ~33532–33534, ~33543, ~33609, ~33639: the OurJournal rail comments (comment-only edits).
  - ~34581–34609: the `_tjCloudBridge` header and `enter()` notes. They go with the bridge, or get reworded if `openLocal`/`localDocs` survive.
  - The MJDocs block's own mentions of the provider contract, folders and notebooks. They go with `CONTRACT`, the listing cache and the index.
- **CSS ~22554–22559:** the comment says the rail is "two rows of two", but it now has two buttons. Lay it out as one row.

**Verify:**
- The rail looks right on desktop and mobile widths.
- OurJournal tab switching works both ways, and `OJ.wasOn('tj')` restores on reload.
- No console errors.
- Brainstorm is unchanged.
- The stale-comment grep above only finds the unrelated uses and the comments on the boot purge and `prune()`.

## Phase 3: Remove Whiteboard and Mind Map from personal MyJournal
- **Hide the two cards outside OurJournal only.** Add CSS next to the rules at ~22575:
  `#tj-root:not(.oj-on) .template-card[data-template="whiteboard"], #tj-root:not(.oj-on) .template-card[data-template="mindmap"] { display:none !important; }`
- **Guard the modal click handler** (~33507) so personal mode can't `createEntry('whiteboard'|'mindmap')`.
- **Delete dead code that only MyJournal uses:**
  - `_fbSaveMyJournal`/`_fbLoadMyJournal` and `_fbSave/Load/Watch/UnwatchMJCanvas` (~12483–12625), plus the unwatch call at ~13406
  - the `#tj-wb-size` code in `tjCheckMobile` (~33665)
  - the whiteboard branch of `_tjStripEntry` (~12701), if the legacy `canvas`/`history` fields can no longer occur
- **Legacy PNG canvas** (`TJ_CANVAS_KEY`, `tony_journal_canvas_*`, ~30805–31097):
  - Remove it only if a live `/verify` check finds no personal whiteboard that lacks `vizRev` (i.e. none still unmigrated).
  - Otherwise keep it, because `migrate()` still needs the PNG.
- **Keep everything shared:** VizEngine, the JGuard cases, `_fbViz`, `_tjBoard`, the board containers, and the board branches.
- Reword the OurJournal comment at ~22573.
- Delete or reword every comment about the personal Whiteboard/Mind Map, the legacy PNG canvas or `_fbSaveMyJournal` that no longer matches the code (see the rule in §0).

**Verify:**
- The personal modal shows Page and Journal Entries.
- The OurJournal modal shows Whiteboard, Page and Mind Map, and a board can be created.
- Old personal boards still open.
- Brainstorm's modal is unchanged.
- `viz-board.test.js` passes.

## Phase 4: Cleanup
- **Keep old plan and handoff docs** (Tony, 2026-09-29: they are a few KB each and cost nothing). That includes this file, `docs/plans-section-design.md` and `docs/warden-handoff.md`. At the end, mark §0 "Done" instead of deleting this file, and change the memory `myjournal-strip-phases.md` and its MEMORY.md line from IN PROGRESS to done.
- Also keep `magi*.md`, `taskhub-archive-handoff.md`, `tradehub-journal-handoff.md`, `STORE_NOTES.md` and `README.md`. Code, tests or memory depend on them.
- Leave V1/ alone (Veda's folder). Tell Tony which of its files are candidates:
  - `2026-08-07-wellness-tracker-design.md`
  - `browser-automation-mechanism.md`
  - `README_FOR_CLAUDE.md`
- Delete the root `debug.log` and the root `.pytest_cache/`, and add `.pytest_cache/` to the root `.gitignore`.
- Delete `magi/artifacts/tony/` screenshots older than 7 days.
- **Self-cleanup system** (Tony's request, 2026-09-29): every program deletes its own trash, with no spike in Firebase or Cloudflare usage. Build it as one shared set of rules. Don't write a separate script per program.
  - **What counts as trash.** Each item needs a named owner and a reason. When in doubt, keep it.
    - *Failed:* error logs, debug dumps, crash and failure screenshots, failed-job records, dead retry queues, dead-letter docs.
    - *Unused:* storage keys, docs, KV keys and files left behind by removed features. Examples are the `mjd_*` keys and `dashboards/myjournal_docs`. Keep a `DEAD_KEYS` registry of those prefixes and add to it whenever a feature is removed.
    - *Outdated:* caches, tokens and temp data past their useful life, such as expired OAuth tokens and stale listing caches. Also old screenshots under `magi/artifacts/<profile>/` and old logs.
    - *Corrupt:* a cache entry that won't parse, or a temp or artifact file that is half-written or zero bytes. Delete it only when a good copy exists elsewhere (Firestore, git, or a rebuild). **Never delete corrupt user data** (journal entries, TaskHub, vault items). Log it and show it to Tony instead.
    - *Never trash:* anything tracked in git (plans, handoff docs, notes: git already versions them, and they cost nothing), A1Backup and its objects (that GC already exists and must keep failing closed, see memory `index-backups-object-gc`), TradeHub journal snapshots, the TaskHub archive, trashed-but-restorable items inside their own 30-day TTL, and anything in V1/.
  - **Age caps:** screenshots and debug dumps 7 days, error logs 14 days, failed-job records and dead queues 30 days. Dead-feature keys go on the first sweep. Record the cap for each item in the registry.
  - **Usage guarantees.** These are hard rules. A test must enforce them where the code allows.
    - *Firestore:*
      - Zero extra reads on boot.
      - A sweep only deletes docs whose ids are already known from reads the page makes anyway, or from a fixed id list. It never runs a query or a listener to discover trash.
      - At most one sweep per device per day, stamped in localStorage, which is try/caught for Veda's Brave.
      - At most 25 deletes per sweep.
      - It never runs during the boot write-guard window.
    - *Cloudflare KV:*
      - Write-once trash gets `expirationTtl` when it is written, so Cloudflare expires it for free.
      - Explicit deletes count as writes, so cap them at 20/day/account, which is 2% of the 1000/day cap. Use `list` with a prefix and one page only.
      - Check both accounts with `kv-usage.mjs` before and after (memory `kv-write-budget`).
    - *Workers:* no new cron triggers and no extra requests per page load. Piggy-back on an existing cron or request, or don't clean that store.
    - *Local disk and localStorage:* free, so no cap. Still sweep at most once a day, off the hot path (idle callback, or the MAGI watchdog when idle).
  - **Safety.**
    - Every sweep has a dry-run mode that only lists what it would delete.
    - Ship dry-run first. Show Tony the list, then turn deletion on.
    - Fail closed: on any error or an unexpected shape, delete nothing that run.
    - A test pins the caps: max deletes per sweep, once a day, no reads on boot.
  - **MAGI:** the engine does its own disk sweep on startup and once a day from the watchdog. It reaches PCs through the self-update (memory `magi-self-update`).
  - **Inventory first.** Before writing any cleanup, go through each program (index, tradehub, vault, mylist, magi, studyos, riftiq, wellness, workers, workers2) and list what it stores in localStorage/IndexedDB, Firestore, KV and on disk. Classify each item with the rules above.
  - List what was found, the category and the cap for each item in the Phase 4 commit message.
- Run `npm test`, then commit and push.
- Mention one optional item: the `trading-auto-launch` logs.
