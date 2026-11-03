# A1

Single-file web apps with no build step, served as-is from GitHub Pages
(`anthonyn99.github.io/A1/<folder>/<page>.html`) — open one and it runs. State
lives in Firebase (one document per program under `dashboards/`) with
localStorage as the offline cache. Every program has its own folder; where
everything goes, and why the few root files cannot move, is
[docs/layout.md](docs/layout.md) (`tests/layout.test.js` enforces it).

## Programs

| Page | Program |
| --- | --- |
| `index.html` | **TaskHub** — the suite shell and profile gate (Tony / Veda): weekly grid, daily habits, goals, MyJournal, ProView, Plans, Veda's Links and Rules. The site root serves it, so it stays at the root |
| `MyList/mylist.html` | **MyList** — shopping list with Price Watch |
| `Shield/shield.html` | **Shield** — front end for the desktop agent (`Shield/desktop/`) |
| `magi/magi.html` | **MAGI** — multi-model council: one question to ChatGPT/Claude/Gemini/DeepSeek, one synthesised verdict. The engine beside it (`magi/`, `docs/MAGI/magi.md`) runs on each PC |
| `Shruti/shruti.html` | **Shruti** — read, listen, watch and study a book a chapter at a time (`Shruti/docs/README.md`) |
| `Backup/backup-restore.html` | **Backup** — restore or export TaskHub from A1Backup |
| `V1/StudyOS/studyos.html`, `V1/Wellness/wellness.html`, ... | **Veda's programs** (`V1/`) |

The old root addresses (`magi.html`, `mylist.html`, `shield.html`, ...) still
work: `404.html` forwards them, keeping the query and hash.

### Private programs (A1-Priv)

**TradeHub**, **Insight**, **Vault**, **RiftIQ**, **Everwell** and **OneInbox**, plus
the Vault Launcher extension, live in the private repo `anthonyn99/A1-Priv`
(`Desktop\A1-Priv`), each in its own folder. They are served from
`https://a1-priv.av1.workers.dev/<page>.html` and load this repo's shared files
(`Shared/`, LifeHub, Notebook, Guardian) by URL. `Vault/` here is a git-ignored
junction to `A1-Priv\Vault`, so Brave's unpacked extension keeps its path. See
`docs/A1-Priv/a1-priv-move-plan.md`, which also covers moving another program there.

## Folders

| Path | What it is |
| --- | --- |
| `Shared/` | Files every program loads: scrollbar, popups, controls, dragsort, resizegrip, hoverfx, apphead, profilepick, tabsync, sweep, tni, catdebrief |
| `Guardian/`, `LifeHub/`, `Notebook/` | The one lock, the app switcher and the journals (`docs/Guardian/`, `docs/LifeHub/`, `docs/Notebook/`) |
| `Rules/` | Machine-read rules: `cleanup-rules.json` (the trash registry), `firestore.rules`, `layout.json` |
| `TaskHub/` | TaskHub's own scripts |
| `PriceWatch/` | Price Watch browser extension — reads store pages for MyList |
| `workers/`, `workers2/` | Cloudflare Workers on accounts 1 and 2, deployed on push by `.github/workflows/` |
| `tests/` | Node test suites — `npm test` |
| `tools/` | Scripts run by hand or by a scheduled task (App Check, backups, `trading-auto-launch/`) |
| `docs/` | **Every** doc, plan and README in A1, one subfolder per project, indexed by `docs/README.md`. Only `CLAUDE.md`, `.claude/skills/` and this README stay outside it, because Claude Code and GitHub look for them where they are |

## Tests

```
npm test          # syntax check across the single-file apps + guard suites
                  # (suites guarding TradeHub/Insight/Vault read ../A1-Priv)
```
