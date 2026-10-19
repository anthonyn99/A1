# A1 docs

Every doc, plan and README in A1 lives here, one subfolder per project. Plans
are kept after they are finished: they are the record of why things are the
way they are. Docs for the private programs (TradeHub, Insight, Vault, RiftIQ,
Everwell) are in A1-Priv's own `docs/`.

## Across the suite

| Doc | What it is |
| --- | --- |
| [a1-priv-move-plan.md](a1-priv-move-plan.md) | Moving programs to the private repo. Done 2026-10-10; its last section is the recipe for moving another one |
| [apphead.md](apphead.md) | The app mark beside every title and Everwell's sync pill, shared through `apphead.js` (2026-10-13) |
| [theme-overhaul-plan.md](theme-overhaul-plan.md) | MAGI's look and drag on Tony's side. Done 2026-10-03; §0 says what to do with a new theme ask, §2 is the spec |

## By project

| Folder | Contents |
| --- | --- |
| [Guardian/](Guardian/) | The one lock: `README.md` (the contract), `plan.md` (the build record) |
| [LifeHub/](LifeHub/) | The app switcher |
| [MAGI/](MAGI/) | `magi.md` (the runbook), `magi-plan.md` (the living plan; §0 is the session hand-off), `magi-accounts.md`, `magi-setup.md`, `magi-cloud-setup.md` (Track M: the always-on cloud engine, so phones work with the PC off) and the three runbooks for Veda's PC |
| [Notebook/](Notebook/) | The journals: `README.md` (the contract), `plan.md` (done 2026-10-09), `myjournal-strip-plan.md` (done 2026-09-29) |
| [PriceWatch/](PriceWatch/) | The extension, and `STORE_NOTES.md` (per-store notes; read before touching a store module) |
| [TaskHub/](TaskHub/) | `notifications.md` (how a reminder reaches a phone; live vs dead series; worker timing), `taskhub-archive-handoff.md` (read before touching the day-archiver), `plans-section-design.md` (the Plans section's spec), `catalyst-debrief.md` (the Catalysts ▶ that debriefs an event in MAGI), `ai-prep.md` (AI prep on both TaskHubs: who owns which doc, the generated TH-PREP block), `backup-restore.md` (Settings → Restore: where backups come from, what a restore writes, undo), `versioned-save.md` (how a save checks the version it was built on and merges instead of overwriting; the 2026-10-19 reset) |
| [shield/](shield/) | The Shield desktop agent |
| [tools/](tools/) | App Check maintenance |
| [workers2/](workers2/) | The Cloudflare account-2 deploy lane |
| [V1/](V1/) | Veda's earlier suite (StudyOS, Finance, TradeBoard, Launcher) |
| [archive/](archive/) | Plans for projects that have left A1: `warden-handoff.md` (Warden moved to VedaCPatel/warden, 2026-08-25) |
