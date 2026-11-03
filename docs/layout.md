# Where things live in A1

Every file sits in a folder that says what it is for. Only files that cannot
live anywhere else sit at the repo root. `Rules/layout.json` lists what each
level may hold, and `tests/layout.test.js` (part of `npm test`) fails as soon
as a file or folder is left anywhere else. Reorganised on 2026-11-03;
A1-Priv follows the same rules (its own `docs/layout.md`).

## Adding something

- **A new program** gets its own folder at the root (`Name/name.html`), plus a
  line in `Rules/layout.json` and in the table below, in the same change. It
  loads shared files from `../Shared/`, the lock from `../Guardian/guardian.js`
  and LifeHub from `../LifeHub/lifehub.js`.
- **A file every program loads** goes in `Shared/`. A program's own script
  goes in that program's folder.
- **A rule a program reads** (trash registry, Firestore rules, this layout)
  goes in `Rules/`.
- **A test** goes in `tests/` (`tests/live/` when it drives a browser). Shruti
  and the MAGI engine keep their suites in their own folders.
- **A doc, plan or README** goes in `docs/`, in the project's subfolder.
- **A script someone runs** (by hand or from a scheduled task) goes in `tools/`.
- **Veda's programs** go in `V1/`, under the same rules (below).
- **Moving a page** changes its address. Add the old address to `404.html`'s
  `MOVED` list and to LifeHub's `MOVED_PAGES` (it rewrites saved tiles), and
  keep a PWA's manifest `id` unchanged so installed copies stay the same app.

## The root

| Path | What |
|---|---|
| `index.html` | TaskHub and the journals. The site root (`/A1/`) serves it, so it stays. |
| `404.html` | GitHub Pages' not-found page. It forwards every moved page's old address (`magi.html`, `mylist.html`, `shield.html`, ...), keeping the query and hash. |
| `firebase-messaging-sw.js` | The push service worker. Its scope must cover `index.html`, so it sits beside it. |
| `CLAUDE.md`, `README.md`, `package.json` | Read from the root by Claude Code, GitHub and npm. |
| `scrollbar.js`, `popups.js`, `dragsort.js` | **Temporary.** Exact copies of their `Shared/` files for ORCA (Veda's repo), which still loads them from the old root address. `tests/layout.test.js` keeps them identical. Once ORCA's templates and worker load `Shared/...` (one-line URL changes in `app/web/templates/base.html`, `_picker_base.html` and `worker/src/web/html.ts`), delete them and their `Rules/layout.json` entries. |

| Folder | What |
|---|---|
| `Backup/` | A1Backup: `backup.js`, `backup-merge.js`, `backup-restore.html`, `backup-export.html`, and `Index Backups/` (the repo copies `tools/pull-backups.mjs` writes). |
| `docs/` | Every doc, plan and README, one subfolder per project; `docs/README.md` is the index. |
| `Guardian/` | The one lock, `guardian.js`. Every host (A1, A1-Priv, ORCA) loads it from this path, unpinned. |
| `LifeHub/` | The app switcher, `lifehub.js`, loaded from this path by every host. |
| `magi/` | MAGI: the console `magi.html` and the engine, a Python package run as `python -m magi` by scheduled tasks on both PCs (so its modules stay where they are). |
| `MyList/` | MyList, `mylist.html`. |
| `Notebook/` | The journals and the DOCX editor (`docs/Notebook/README.md`). |
| `PriceWatch/` | The Price Watch extension. Brave loads it unpacked from this folder, so its own files stay flat as `manifest.json` names them. |
| `Rules/` | Machine-read rules: `cleanup-rules.json` (the trash registry, read by `Shared/sweep.js`, `magi/sweep.py` and the tests), `firestore.rules`, `layout.json`. |
| `Shared/` | Files every program loads: `scrollbar.js`, `popups.js`, `controls.js`, `dragsort.js`, `resizegrip.js`, `hoverfx.js`, `apphead.js`, `profilepick.js`, `tabsync.js`, `sweep.js`, `tni.js`, `catdebrief.js`. A1-Priv, StudyOS and ORCA load them by URL (`https://anthonyn99.github.io/A1/Shared/...`). |
| `Shield/` | Shield: the page `shield.html` and the desktop agent in `desktop/` (Tauri; its installer workflow builds from there). |
| `Shruti/` | Shruti, as one folder: `shruti.html`, its modules in `app/`, books, media, tools, tests, docs, worker. |
| `TaskHub/` | TaskHub's own scripts (`taskhub-merge.js`). Its page is `index.html` at the root. |
| `tests/` | Every A1 test suite; `tests/live/` drives a real browser. `node tests/run-all.js` runs them all. |
| `tools/` | Scripts run by hand or by a scheduled task, e.g. `tools/trading-auto-launch/launch.py` (the TradingAutoLaunch and TradingDailyAnalysis tasks). |
| `V1/` | Veda's programs (below). |
| `workers/`, `workers2/` | Cloudflare workers. The folder picks the account (1 or 2); a push deploys them. |
| `Vault` | Not tracked: a junction to `..\A1-Priv\Vault`, so the Vault Launcher extension Brave loads from `A1\Vault` keeps working. |

## V1 (Veda's programs)

| Path | What |
|---|---|
| `V1/StudyOS/` | StudyOS: `studyos.html` and everything it loads beside it (`css/`, `js/`, `config/`, `assets/`, `vendor/`, `manifest.webmanifest`, `studyos-sw.js`), plus its desktop app in `desktop/`. `scripts/build.mjs` publishes it at `/studyos/` on the V1 site, so its address did not change. |
| `V1/Wellness/` | Wellness, `wellness.html`. |
| `V1/Finance/` | Finance, `finance.html`. |
| `V1/TradeBoard/` | TradeBoard, `tradeboard.html` (served at the V1 site's root), with its desktop and sync tools. |
| `V1/Launcher/` | The Launcher extension, loaded unpacked from this folder (its files stay flat). |
| `V1/firebase/` | V1's Firebase project: `firebase.json`, `.firebaserc`, `firestore.rules`, the push service worker. |
| `V1/scripts/` | The build (`build.mjs`), the tests, and `Push Changes.bat`. |
| `V1/shared/` | V1's design tokens. |
| `V1/tools/` | Helper programs (`sos-browser`). |
| `V1/workers/` | V1's Cloudflare workers. |

`V1/package.json` stays at V1's top because the build and the V1 worker
workflow run from there.
