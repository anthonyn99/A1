# A1

- **Setting up MAGI on a PC** ("set up MAGI", Veda's PC, a new engine):
  follow [docs/magi-setup.md](docs/magi-setup.md). It's one command, then the
  sign-ins.
- **Checking Veda's MAGI is separate from Tony's** ("do the isolation check",
  "run the Veda check", "check MAGI is separate"), on Veda's PC: follow
  [docs/magi-veda-isolation-check.md](docs/magi-veda-isolation-check.md)
  start to finish.
- **Retiring the old "tony" engine on Veda's PC** ("read the retire plan",
  "retire the old engine", "do the Veda engine cleanup"), on Veda's PC:
  follow [docs/magi-veda-retire-old-engine.md](docs/magi-veda-retire-old-engine.md)
  start to finish.
- **Codex's protected sandbox on Veda's PC** ("set up Codex's sandbox",
  "do the Codex sandbox fix", "Veda Codex fix"), on Veda's PC: follow
  [docs/magi-veda-codex-sandbox.md](docs/magi-veda-codex-sandbox.md)
  start to finish.
- **Orca refinement** ("continue Orca", "next Orca phase", "go"): Orca lives
  at `C:\Users\antho\Desktop\ORCA` (Veda's repo, branch `accounts`), not in
  A1. Read §0 of `C:\Users\antho\Desktop\ORCA\docs\refine-plan.md`, build
  exactly the phase it names, then test, commit, push, deploy and rewrite §0.
- **Notebook** (MyJournal, Brainstorm Journal, OurJournal, the DOCX editor):
  one program in `Notebook/`, embedded like LifeHub. index.html mounts both
  journals; TradeHub's Playbook is an instance. **All 7 phases are done
  (2026-10-09).** The contract is [docs/Notebook/README.md](docs/Notebook/README.md)
  (adding it to a program, data layout, why MyJournal names stay `tj`-prefixed);
  [docs/Notebook/plan.md](docs/Notebook/plan.md) is the record. Prove journal
  changes with `node tests/live/notebook-baseline.live.js`. Never change how
  Veda's side looks or works.
- **Theme overhaul** ("continue theme", "next theme phase"): MAGI's look on
  Tony's side of every program, plus MAGI's drag and drop everywhere except
  Tony's TaskHub. **All 11 phases are done (2026-10-03).** §0 of
  [docs/theme-overhaul-plan.md](docs/theme-overhaul-plan.md) says what to do
  with a new theme ask; §2 is the spec. Never change Veda's side.
- **TradeHub, Insight, Vault, RiftIQ, Solace and the Vault Launcher are NOT
  in A1** (moved 2026-10-10). They live in the private repo `C:\Users\antho\Desktop\A1-Priv`
  (anthonyn99/A1-Priv), served at `https://a1-priv.av1.workers.dev/<page>.html`.
  Edit them there; its own CLAUDE.md applies. A1's `tradehub.html`,
  `insight.html`, `vault.html`, `riftiq.html` and `solace.html` are only redirect stubs, and `Vault/` is a
  junction into A1-Priv. Shared files (LifeHub, Notebook, tabsync, ...) and
  workers stay here. **Moving another program to A1-Priv** ("move X to the
  private repo"): follow
  [docs/a1-priv-move-plan.md](docs/a1-priv-move-plan.md), section "Moving
  another program later".
- **Every doc, plan and README goes in [docs/](docs/)**, whatever project it
  is for (a project's own subfolder there if it has several). Only this file,
  `.claude/skills/` and the root `README.md` stay outside it.
