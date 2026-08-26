# A1

Single-file web apps with no build step. Every `.html` at the repo root is served
as-is from GitHub Pages (`anthonyn99.github.io/A1/<page>.html`) — open one and it
runs. State lives in Firebase (one document per program under `dashboards/`) with
localStorage as the offline cache. The browser extensions, the desktop agent and
the Cloudflare Workers each have their own folder.

## Programs (repo root)

| File | Program |
| --- | --- |
| `index.html` | **TaskHub** — the suite shell and profile gate (Tony / Veda): weekly grid, daily habits, goals, MyJournal, ProView, Plans, Veda's Links and Rules |
| `tradehub.html` | **TradeHub** — portfolio, trade journal, catalysts, playbook, news, analysis |
| `insight.html` | **Insight** — personal finance and institution sync |
| `vault.html` | **Vault** — keychain: passwords, IDs, payment cards, cloud files |
| `mylist.html` | **MyList** — shopping list with Price Watch |
| `oneinbox.html` | **OneInbox** — unified mail inbox |
| `solace.html` | **Solace** — fitness (MotionCore) and nutrition (recipes) |
| `riftiq.html` | **RiftIQ** — WarRoom (League) + ProView (esports) (`dashboards/lol_warroom`, `dashboards/proview`) |
| `wellness.html` | **Wellness** — Veda's tracker |
| `shield.html` | **Shield** — front end for the desktop agent |

`firestore.rules`, `firebase-messaging-sw.js` and `.nojekyll` are deployment
files and belong at the root.

## Folders

| Path | What it is |
| --- | --- |
| `Vault/` | Vault Launcher browser extension, and the modules `vault.html` loads |
| `PriceWatch/` | Price Watch browser extension — reads store pages for MyList |
| `desktop/shield/` | Shield desktop agent (Tauri / Rust). Rebuild and reinstall with `powershell -File desktop\shield\launch.ps1`; the installed copy has its own Start-menu shortcut |
| `trading-auto-launch/` | Python helper that opens TradeHub on a schedule |
| `auto-shutdown/` | Scheduled task that shuts this PC down nightly at 00:00 local, unless it is in use. Install/repair: `powershell -File auto-shutdown\auto-shutdown.ps1` |
| `workers/` | Cloudflare Workers. Every directory here is deployed by `.github/workflows/deploy-workers.yml` |
| `V1/` | Veda's earlier suite — StudyOS, Finance, TradeBoard. Still deployed, by `deploy-v1-workers.yml`; self-contained, with its own README and workers |
| `tests/` | Node test suite for the root apps — `npm test` |
| `tools/` | App Check maintenance scripts (see `tools/README-appcheck.md`) |
| `docs/` | Setup checklists and design notes |

## Tests

```
npm test          # syntax check across the single-file apps + guard suites
node Vault/vault-cloud.test.js      # (and the other Vault/*.test.js)
```
