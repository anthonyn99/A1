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
| `mylist.html` | **MyList** — shopping list with Price Watch |
| `oneinbox.html` | **OneInbox** — unified mail inbox |
| `wellness.html` | **Wellness** — Veda's tracker |
| `shield.html` | **Shield** — front end for the desktop agent |
| `magi.html` | **MAGI** — multi-model council: one question to ChatGPT/Claude/Gemini/DeepSeek, one synthesised verdict. The console only — the engine runs on Tony's PC (`magi/`, `docs/magi.md`) |

`firestore.rules`, `firebase-messaging-sw.js` and `.nojekyll` are deployment
files and belong at the root.

### Private programs (A1-Priv)

**TradeHub**, **Insight**, **Vault**, **RiftIQ** and **Solace**, plus the Vault Launcher extension, live
in the private repo `anthonyn99/A1-Priv` (`Desktop\A1-Priv`). They are served
from `https://a1-priv.av1.workers.dev/<page>.html` and still load this repo's
shared files (LifeHub, Notebook, tabsync, ...) by URL. Here, `tradehub.html`,
`insight.html`, `vault.html`, `riftiq.html` and `solace.html` are redirect stubs that keep old links working,
and `Vault/` is a git-ignored junction to `A1-Priv\Vault`, so Brave's unpacked
extension keeps its path. See `docs/a1-priv-move-plan.md`, which also covers
moving another program there.

## Folders

| Path | What it is |
| --- | --- |
| `LifeHub/` | **LifeHub** — the A1 app switcher, built once (`lifehub.js`) and dropped into each program with an `<a1-lifehub>` tag + one script. Not in Index or any Veda profile. See `docs/LifeHub/README.md` |
| `PriceWatch/` | Price Watch browser extension — reads store pages for MyList |
| `desktop/shield/` | Shield desktop agent (Tauri / Rust). Rebuild and reinstall with `powershell -File desktop\shield\launch.ps1`; the installed copy has its own Start-menu shortcut |
| `trading-auto-launch/` | Python helper that opens TradeHub on a schedule |
| `workers/` | Cloudflare Workers. Every directory here is deployed by `.github/workflows/deploy-workers.yml` |
| `V1/` | Veda's earlier suite — StudyOS, Finance, TradeBoard. Still deployed, by `deploy-v1-workers.yml`; self-contained, with its own README and workers |
| `tests/` | Node test suite for the root apps — `npm test` |
| `tools/` | App Check maintenance scripts (see `docs/tools/README-appcheck.md`) |
| `magi/` | MAGI's engine — Python + Playwright, driving four logged-in Chrome profiles. Local-only by nature; it starts itself at logon. See `docs/magi.md` |
| `docs/` | **Every** doc, plan and README in A1, whatever project it is for -- one place to look. Each project away from the top level keeps its own subfolder (`docs/V1/`, `docs/LifeHub/`, `docs/PriceWatch/`, `docs/shield/`, `docs/workers2/`, `docs/tools/`). Only `CLAUDE.md`, `.claude/skills/` and this README stay outside it, because Claude Code and GitHub look for them where they are |

## Tests

```
npm test          # syntax check across the single-file apps + guard suites
                  # (suites guarding TradeHub/Insight/Vault read ../A1-Priv)
```
