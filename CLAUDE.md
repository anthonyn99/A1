# A1

- **Setting up MAGI on a PC** ("set up MAGI", Veda's PC, a new engine):
  follow [docs/MAGI/magi-setup.md](docs/MAGI/magi-setup.md). It's one command, then the
  sign-ins.
- **MAGI in the cloud** ("the Oracle account is ready", "next cloud phase",
  "MAGI on the phone without the PC"): Track M in
  [docs/MAGI/magi-plan.md](docs/MAGI/magi-plan.md) §8; §0 names the next
  phase and [docs/MAGI/magi-cloud-setup.md](docs/MAGI/magi-cloud-setup.md) is
  the runbook. One phase per session; the PC engine and tunnel must keep working.
- **Checking Veda's MAGI is separate from Tony's** ("do the isolation check",
  "run the Veda check", "check MAGI is separate"), on Veda's PC: follow
  [docs/MAGI/magi-veda-isolation-check.md](docs/MAGI/magi-veda-isolation-check.md)
  start to finish.
- **Retiring the old "tony" engine on Veda's PC** ("read the retire plan",
  "retire the old engine", "do the Veda engine cleanup"), on Veda's PC:
  follow [docs/MAGI/magi-veda-retire-old-engine.md](docs/MAGI/magi-veda-retire-old-engine.md)
  start to finish.
- **Codex's protected sandbox on Veda's PC** ("set up Codex's sandbox",
  "do the Codex sandbox fix", "Veda Codex fix"), on Veda's PC: follow
  [docs/MAGI/magi-veda-codex-sandbox.md](docs/MAGI/magi-veda-codex-sandbox.md)
  start to finish.
- **Orca refinement** ("continue Orca", "next Orca phase", "go"): Orca lives
  at `C:\Users\antho\Desktop\ORCA` (Veda's repo, branch `accounts`), not in
  A1. Read §0 of `C:\Users\antho\Desktop\ORCA\docs\refine-plan.md`, build
  exactly the phase it names, then test, commit, push, deploy and rewrite §0.
- **Everwell** (any Everwell ask): Tony's Mind, Health, Faith program that
  replaced Solace. It lives in A1-Priv (`everwell.html`). **All 9 phases are
  done (2026-10-11).** Read §0 of `C:\Users\antho\Desktop\A1-Priv\docs\Everwell\plan.md`
  (standing rules, what to do with a new ask), then run the tests (A1-Priv
  `npm test` and A1 `node tests/live/everwell.live.js`).
  Never write into TaskHub's documents from Everwell (plan §1).
- **Notebook** (MyJournal, Brainstorm Journal, OurJournal, the DOCX editor):
  one program in `Notebook/`, embedded like LifeHub. index.html mounts both
  journals; TradeHub's Playbook is an instance. **All 7 phases are done
  (2026-10-09).** The contract is [docs/Notebook/README.md](docs/Notebook/README.md)
  (adding it to a program, data layout, why MyJournal names stay `tj`-prefixed);
  [docs/Notebook/plan.md](docs/Notebook/plan.md) is the record. Prove journal
  changes with `node tests/live/notebook-baseline.live.js`. The two sides are
  **T's Notebook** (`profile: 'tony'`) and **V's Notebook** (`profile: 'veda'`):
  the same program, differing only in header, colours/fonts, Veda's extra
  templates and her tags (README, top). A feature reaches both sides; never change Veda's
  look unless asked. **Every Notebook feature reaches every program
  that mounts it:** build it in `Notebook/`, never in a host; a program leaves
  one out only through its mount config (`features`, `templates`). A program
  talks to Notebook only through its API (mount options, `Notebook.open`,
  `attach`/`detach`), never its elements or functions;
  `tests/notebook-hosts.test.js` enforces that for every host in A1 and A1-Priv.
  See the README's "What reaches which program" and "Host rules".
- **Guardian — the one lock** ("add a lock to X", "change the lock screen",
  anything about passwords, biometrics, hints or reset codes): every A1 program,
  A1-Priv and ORCA's gate lock through [Guardian/guardian.js](Guardian/guardian.js).
  Never build a lock in a program; declare one. The contract is
  [docs/Guardian/README.md](docs/Guardian/README.md) (hosts must load the file
  unpinned; legacy adoption is retired after 2026-11-10 by its checklist).
- **Shruti** ("continue Shruti", "next Shruti phase", the Gita reader/podcast/video
  program): everything lives in `Shruti/` (page, data, tools, tests, docs, worker), so it
  moves as one folder; its docs are the exception to "docs go in docs/". **All 9 phases
  are done (2026-10-20).** Read §0 of [Shruti/docs/plan.md](Shruti/docs/plan.md) (what is
  left with Tony, what to do with a new ask), then test and update §0. All AI goes
  through Orca with each person's own key.
- **Theme overhaul** ("continue theme", "next theme phase"): MAGI's look on
  Tony's side of every program, plus MAGI's drag and drop everywhere except
  Tony's TaskHub. **All 11 phases are done (2026-10-03).** §0 of
  [docs/theme-overhaul-plan.md](docs/theme-overhaul-plan.md) says what to do
  with a new theme ask; §2 is the spec. Never change Veda's side.
- **TradeHub, Insight, Vault, RiftIQ, Everwell, OneInbox and the Vault Launcher
  are NOT in A1** (moved 2026-10-10; OneInbox 2026-10-28). They live in the private repo `C:\Users\antho\Desktop\A1-Priv`
  (anthonyn99/A1-Priv), served at `https://a1-priv.av1.workers.dev/<page>.html`.
  Edit them there; its own CLAUDE.md applies. A1 has no copy of them (its old
  redirect stubs were removed 2026-10-22); `Vault/` is a junction into A1-Priv. Shared files (LifeHub, Notebook, tabsync, ...) and
  workers stay here. **Moving another program to A1-Priv** ("move X to the
  private repo"): follow
  [docs/a1-priv-move-plan.md](docs/a1-priv-move-plan.md), section "Moving
  another program later".
- **Every doc, plan and README goes in [docs/](docs/)**, whatever project it
  is for (a project's own subfolder there if it has several). Only this file,
  `.claude/skills/` and the root `README.md` stay outside it.
