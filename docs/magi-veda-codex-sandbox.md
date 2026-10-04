# MAGI — Codex's protected sandbox on Veda's PC (run ON VEDA'S PC)

**For Claude.** If someone said *"set up Codex's sandbox"*, *"do the Codex
sandbox fix"* or *"Veda Codex fix"*, this file is the whole job. Do every
step yourself; the only thing Veda does is click **Yes** on one Windows
prompt (step 4), and only if step 3 says it is needed.

## Why

Found on Tony's PC on 2026-10-04 and fixed in MAGI the same day: in Codex's
`unelevated` Windows sandbox, which MAGI used until then, a command could
**delete files anywhere the user can** (a scratch file on the Desktop went,
from read-only and write mode alike). Writes and renames outside were
blocked; deletes were not. A Code Mode task that followed hidden
instructions in a project's files could have deleted her files.

MAGI now runs Codex only in its `elevated` sandbox, where that delete is
"Access is denied" and everything Codex needs still works. Elevated needs a
**one-time setup per PC**, which Windows asks an admin to approve. Until it is
done on her PC, her engine **does not use Codex**: Codex shows as unavailable
with a sentence saying how to set it up, and tasks go to the next agent in
her chain. Nothing hangs: the engine's check gives up after a minute.

## Steps

1. **Check you are on Veda's PC.** `hostname` should be `VedaHPENVY`, and
   `curl http://127.0.0.1:8000/api/health` (or port 8001) must answer
   `"profile":"veda"`. If the profile is `tony`, you are on Tony's PC; stop
   and say so. Never run anything with `-Profile tony` here.

2. **Bring A1 up to date and make sure her engine runs the new code.**
   `git pull --rebase --autostash` in A1. Her engine updates itself when
   idle; to be sure, run `powershell -ExecutionPolicy Bypass -File
   magi\restart.ps1 -Profile veda`. Confirm the file
   `magi\code\agents\codex_sandbox.py` exists.

3. **Is the sandbox already set up?** Run:

   ```powershell
   codex sandbox -c windows.sandbox=elevated -- cmd /c echo magi-sandbox-ok
   ```

   - Prints `magi-sandbox-ok` with no prompt: already set up. Skip to step 5.
   - A Windows prompt appears ("Do you want to allow this app to make
     changes"): go to step 4.
   - `codex` not found: install it (`npm install -g @openai/codex`) and
     repeat.

4. **Veda clicks Yes.** Tell her, in one line: *"A Windows prompt is asking
   to let Codex set up its safe sandbox. Please click Yes."* Then run the
   command from step 3 again until it prints `magi-sandbox-ok`. The setup
   creates two local Windows accounts, `CodexSandboxOffline` and
   `CodexSandboxOnline`, and firewall rules that keep the sandbox off the
   network and off 127.0.0.1. That is expected; do not remove them.

5. **Prove the hole is closed** (no account, nothing spent):

   ```powershell
   cd magi; $env:PYTHONPATH = (Resolve-Path ..).Path
   .venv\Scripts\python -m pytest tests/test_codex_sandbox.py -q
   ```

   All pass (7). The two `real_sandbox` tests delete-test a scratch file in
   `%TEMP%`; if they are *skipped*, the sandbox is still not set up: go back
   to step 3.

6. **Prove Codex works in MAGI again.** Restart her engine (step 2's
   command) so it re-checks, then:
   `curl http://127.0.0.1:<port>/api/code/agents` and confirm the Codex
   slot is available (no "protected sandbox is not set up" text). Optional,
   spends two small Codex requests on her account:
   `node tests\live\magi-guard.live.js` against her port.

7. **Tell Veda it's done** in one line, and tell Tony the result of step 5.

## If something goes wrong

- The prompt never appears and the command hangs: press Ctrl+C. Check
  `%USERPROFILE%\.codex\.sandbox\sandbox.<date>.log` for the last line and
  report it. Do not switch MAGI back to `unelevated`: that reopens the hole.
- Veda says no to the prompt: nothing breaks. Her MAGI keeps working with
  every agent except Codex. Run step 3 again whenever she is ready.
