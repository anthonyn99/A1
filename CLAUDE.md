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
- **Theme overhaul** ("continue theme", "next theme phase"): MAGI's look on
  Tony's side of every program, plus MAGI's drag and drop everywhere except
  Tony's TaskHub. **All 11 phases are done (2026-10-03).** §0 of
  [docs/theme-overhaul-plan.md](docs/theme-overhaul-plan.md) says what to do
  with a new theme ask; §2 is the spec. Never change Veda's side.
- **Every doc, plan and README goes in [docs/](docs/)**, whatever project it
  is for (a project's own subfolder there if it has several). Only this file,
  `.claude/skills/` and the root `README.md` stay outside it.
