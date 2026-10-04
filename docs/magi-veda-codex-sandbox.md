# MAGI — Codex's protected sandbox on Veda's PC (run ON VEDA'S PC)

**For Claude.** If someone said *"set up Codex's sandbox"*, *"do the Codex
sandbox fix"* or *"Veda Codex fix"*, this file is the whole job. Do every step
yourself. Veda's only part is clicking **Yes** on one Windows prompt.

## Why (one paragraph)

On 2026-10-04 we found that Codex's old Windows sandbox let a command delete
files anywhere on the PC. MAGI now runs Codex only in its *protected*
(elevated) sandbox, which blocks that. The protected sandbox needs a one-time
setup per PC, and Windows requires an admin **Yes** for it; nothing can skip
that click. Until it's done, MAGI simply doesn't use Codex on this PC (every
other agent works), and it asks Windows for the setup by itself when Code Mode
is opened.

## Steps

1. **Check it's Veda's PC.** `curl http://127.0.0.1:8000/api/health` (or
   8001) must say `"profile":"veda"`. If it says `tony`, stop and say so.
2. **Update.** `git pull --rebase --autostash` in A1, then
   `powershell -ExecutionPolicy Bypass -File magi\restart.ps1 -Profile veda`.
3. **Set it up.** Run `magi\Codex sandbox setup.cmd` (or have Veda
   double-click it in File Explorer). If a Windows prompt appears, tell her:
   *"Please click Yes on the Windows prompt."* It ends with **Done** (or says
   to run it again). If it says Done with no prompt, it was already set up.
4. **Prove it** (no account, nothing spent):
   `cd magi; $env:PYTHONPATH = (Resolve-Path ..).Path; .venv\Scripts\python -m pytest tests/test_codex_sandbox.py -q`.
   All pass; the two `real_sandbox` tests must PASS, not be skipped.
5. **Confirm MAGI sees it.** In her MAGI console, Code Mode: the Codex CLI
   chip no longer says *sandbox not set up* (it updates by itself within a
   minute).
6. Tell Veda it's done, and tell Tony the result of step 4.

## If something goes wrong

- She clicked No, or nothing happened: run step 3 again.
- Step 3 says Codex is not installed: `npm install -g @openai/codex`, then step 3.
- Never switch MAGI back to the old (`unelevated`) sandbox; that reopens the hole.
