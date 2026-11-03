# Where things live in A1

Every program's page sits at the top: A1's root, or V1's top for Veda's
programs. That is also its address (`anthonyn99.github.io/A1/<page>.html`).
Every other file sits in a folder that says what it is for. `Rules/layout.json`
lists what each level may hold, and `tests/layout.test.js` (part of `npm test`)
fails as soon as anything is left anywhere else. Set up on 2026-11-03; A1-Priv
follows the same rules (its own `docs/layout.md`).

## Adding something

- **A new program**: its page at the root (`name.html`), listed under `pages`
  in `Rules/layout.json`; its own files (if it has more than the page) in a
  folder named after it, listed under `folders`; a row in the tables below. All
  in the same change. It loads shared files from `Shared/`, the lock from
  `Guardian/guardian.js` and LifeHub from `LifeHub/lifehub.js`.
- **A file every program loads** goes in `Shared/`. A program's own script
  goes in that program's folder.
- **A rule a program reads** (trash registry, Firestore rules, this layout)
  goes in `Rules/`.
- **A test** goes in `tests/` (`tests/live/` when it drives a browser). Shruti
  and the MAGI engine keep their suites in their own folders.
- **A doc, plan or README** goes in `docs/`, in the project's subfolder.
- **A script someone runs** (by hand or from a scheduled task) goes in `tools/`.
- **Veda's programs** follow the same rules inside `V1/` (below).
- **Moving a page** changes its address. Add the old address to `404.html`'s
  `MOVED` list, to LifeHub's `MOVED_PAGES` and to TaskHub's `_MOVED_LINKS`
  (they rewrite saved tiles and links), and keep a PWA manifest's `id`
  unchanged so installed copies stay the same app.

## The root

| Path | What |
|---|---|
| `index.html` | TaskHub and the journals. The site root (`/A1/`) serves it. |
| `magi.html` | MAGI's console (its engine is `magi/`). |
| `mylist.html` | MyList. |
| `shield.html` | Shield's page (its desktop agent is `Shield/desktop/`). |
| `shruti.html` | Shruti (everything else of it is `Shruti/`). |
| `backup-restore.html`, `backup-export.html` | Restore or export TaskHub from A1Backup (`Backup/`). |
| `404.html` | GitHub Pages' not-found page. It forwards a moved page's old address to the new one, keeping the query and hash. |
| `firebase-messaging-sw.js` | The push service worker. Its scope must cover `index.html`, so it sits beside it. |
| `CLAUDE.md`, `README.md`, `package.json` | Read from the root by Claude Code, GitHub and npm. |
| `scrollbar.js`, `popups.js`, `dragsort.js` | Copies of their `Shared/` files for ORCA (Veda's repo), which loads them from these old root addresses. **Edit `Shared/`, never these:** the pre-commit hook rewrites each copy from `Shared/` in the same commit, so ORCA gets every change in the same push, and `tests/layout.test.js` checks they match. Once ORCA's templates and worker load `Shared/...` (one-line URL changes in `app/web/templates/base.html`, `_picker_base.html` and `worker/src/web/html.ts`), delete them and their `Rules/layout.json` entries. |

| Folder | What |
|---|---|
| `Backup/` | A1Backup: `backup.js`, `backup-merge.js`, and `Index Backups/` (the repo copies `tools/pull-backups.mjs` writes). |
| `docs/` | Every doc, plan and README, one subfolder per project; `docs/README.md` is the index. |
| `Guardian/` | The one lock, `guardian.js`. Every host (A1, A1-Priv, ORCA) loads it from this path, unpinned. |
| `LifeHub/` | The app switcher, `lifehub.js`, loaded from this path by every host. |
| `magi/` | MAGI's engine, a Python package run as `python -m magi` by scheduled tasks on both PCs (so its modules stay where they are). |
| `Notebook/` | The journals and the DOCX editor (`docs/Notebook/README.md`). |
| `PriceWatch/` | The Price Watch extension. Brave loads it unpacked from this folder, so its own files stay flat as `manifest.json` names them. |
| `Rules/` | Machine-read rules: `cleanup-rules.json` (the trash registry, read by `Shared/sweep.js`, `magi/sweep.py` and the tests), `firestore.rules`, `layout.json`. |
| `Shared/` | Files every program loads: `scrollbar.js`, `popups.js`, `controls.js`, `dragsort.js`, `resizegrip.js`, `hoverfx.js`, `apphead.js`, `profilepick.js`, `tabsync.js`, `sweep.js`, `tni.js`, `catdebrief.js`. A1-Priv and StudyOS load them by URL (`https://anthonyn99.github.io/A1/Shared/...`). |
| `Shield/` | The Shield desktop agent in `desktop/` (Tauri; its installer workflow builds from there). |
| `Shruti/` | Everything of Shruti but its page: its modules in `app/`, books, media, tools, tests, docs, worker. |
| `TaskHub/` | TaskHub's own scripts (`taskhub-merge.js`). |
| `tests/` | Every A1 test suite; `tests/live/` drives a real browser. `node tests/run-all.js` runs them all. |
| `tools/` | Scripts run by hand or by a scheduled task, e.g. `tools/trading-auto-launch/launch.py` (the TradingAutoLaunch and TradingDailyAnalysis tasks). |
| `V1/` | Veda's programs (below). |
| `workers/`, `workers2/` | Cloudflare workers. The folder picks the account (1 or 2); a push deploys them. |
| `Vault` | Not tracked: a junction to `..\A1-Priv\Vault`, so the Vault Launcher extension Brave loads from `A1\Vault` keeps working. |

## V1 (Veda's programs)

| Path | What |
|---|---|
| `V1/studyos.html` | StudyOS. Its service worker (`studyos-sw.js`) and manifest (`manifest.webmanifest`) sit beside it: the worker's scope must cover the page. `scripts/build.mjs` publishes it at `/studyos/` on the V1 site. |
| `V1/wellness.html` | Wellness. |
| `V1/finance.html` | Finance (published at `/finance/` on the V1 site). |
| `V1/tradeboard.html` | TradeBoard (published at the V1 site's root). |
| `V1/StudyOS/` | What StudyOS loads: `css/`, `js/`, `config/`, `assets/`, `vendor/`, plus its desktop app in `desktop/`. |
| `V1/TradeBoard/` | TradeBoard's desktop app, sync and scripts. |
| `V1/Launcher/` | The Launcher extension, loaded unpacked from this folder (its files stay flat). |
| `V1/firebase/` | V1's Firebase project: `firebase.json`, `.firebaserc`, `firestore.rules`, the push service worker. |
| `V1/scripts/` | The build (`build.mjs`), the tests, and `Push Changes.bat`. |
| `V1/shared/` | V1's design tokens. |
| `V1/tools/` | Helper programs (`sos-browser`). |
| `V1/workers/` | V1's Cloudflare workers. |

`V1/package.json` stays at V1's top because the build and the V1 worker
workflow run from there.
