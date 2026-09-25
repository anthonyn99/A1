# Setting up MAGI on this PC

**For the Claude session on the PC being set up** (Veda's, for the `veda`
profile). The person only has to say "set up MAGI". You run everything below
and stop only for the steps that need their hands: signing in.

Everything is built and tested identically for Tony and Veda. Her engine is
the same code, the same port (8000), and the same logon tasks, with her own
data, token, accounts and history. Nothing here is copied from Tony's PC, and
nothing needs to be.

## 0. Check where you are

- This must be a clone of A1 (`git remote -v` shows `anthonyn99/A1`), on
  Windows. Run the commands from the A1 folder.
- **Whose PC?** Ask if it is not obvious. On Veda's PC the profile is
  `veda`. If `magi\data\tony\engine.json` exists, this is Tony's PC and he
  already has an engine: stop and ask what they want.
- Claude Code should already be signed in here, because you are running in it.
  MAGI's Code Mode uses that login (the "system" Claude slot).

## 1. The one command

```powershell
powershell -ExecutionPolicy Bypass -File magi\setup.ps1 -Profile veda
```

It prints `[1/8]` to `[8/8]` and takes 2 to 10 minutes on a fresh PC. It:
pulls A1; installs Python 3.12 (exactly; a newer Python is not used), Node.js, Chrome and git with winget if any
are missing; creates `magi\.venv` and installs MAGI's packages; installs the
Claude Code and Codex CLIs (npm, global); runs `magi onboard --profile veda`
(her data folders, engine identity, **port 8000**, her API token in
`MAGI_API_TOKEN_VEDA`, Playwright's Chromium, the logon tasks "MAGI Engine
(veda)" and "MAGI Watchdog (veda)"); starts the engine; registers A1 as a
Code Mode project; and checks that the engine answers as `veda`.

It is safe to run again: it repairs whatever is missing and never regenerates
the token, which would unpair her devices.

**If a step fails**, it says which one and why. The usual causes:

| What | Do |
|---|---|
| winget missing or an install failed | install that one thing by hand (python.org 3.12, nodejs.org LTS, Chrome), then re-run |
| `claude` / `codex` not on PATH after install | open a new terminal, re-run |
| pip errors | re-run once (network); then read the error |
| "Port 8000 is tony's engine" | this PC is running Tony's engine; stop and ask |
| onboard says **port 8001** | something else already holds 8000 (on Veda's PC: her own older MAGI from `Downloads\MAGI`, tasks "MAGI Cloud"/"MAGI Watchdog"). Leave it alone; 8001 is fine: the console tries her spare port on first contact and then remembers it. Use 8001 in the checks below |
| "magi\.venv is Python 3.x, not 3.12" | a venv from an earlier run on another Python. End the tasks "MAGI Engine (veda)" and "MAGI Watchdog (veda)" in Task Scheduler, re-run |
| the engine did not start | read `magi\data\veda\autostart.log` |

## 2. What only she can do (guide her, in this order)

1. Open **https://anthonyn99.github.io/A1/magi.html** in Chrome on this PC.
   Pick **Veda** and unlock with her MAGI password. If Chrome asks to let the
   page reach devices on the local network, she clicks **Allow** (that's the
   engine). The status at the bottom of the sidebar says it's running on this
   PC. The token is shared with her other devices automatically; nothing to
   type.
2. **Accounts → each council unit → Sign in**: a Chrome window opens, she
   signs in by hand, and closes it when the unit shows signed in. She can
   skip any service she doesn't use; untick it on the council instead.
3. **Accounts → Coding agents**:
   - Claude: already signed in (this PC's Claude Code login). To use another
     Claude account for coding, "Add another account".
   - Codex: **Sign in** shows a code and an OpenAI link. She enters the code
     (it works from her phone too) with any ChatGPT account, Free included.
4. **Accounts → GitHub → Add a token**: a fine-grained token from
   github.com/settings/personal-access-tokens, for the repositories she wants
   Code Mode to reach, with **Contents: Read and write** (add **Actions:
   Read-only** to watch a private repo's runs).
5. On her phone, she opens the same URL and picks Veda. It finds her engine
   by itself.

## 3. Check it (you can do all of this)

```powershell
curl.exe -s http://127.0.0.1:8000/api/health        # "profile":"veda" (8001 if onboard chose it)
schtasks /query /tn "MAGI Engine (veda)"             # the logon task exists
```

- In the console: Code Mode lists **A1**, and Accounts shows her sign-ins,
  not Tony's.
- Her history lives in `dashboards/magi_veda`. Tony's console never shows it,
  and hers never shows his.
- Optional, spends two small Codex requests: `node tests\live\magi-guard.live.js`
  proves coding agents can't drive her engine.

## After any change to `magi\`

The engine runs the code it started with. Restart it yourself (it finds
`veda` on its own on her PC) and check it answers:

```powershell
powershell -ExecutionPolicy Bypass -File magi\restart.ps1
```

## Never

- Never run anything with `-Profile tony` on her PC, and never copy
  `magi\data` or `magi\profiles` between PCs. Those folders hold logins and
  are git-ignored for that reason.
- Never type or paste her API token or a GitHub token into a chat, a file or
  a commit.
- Everything else about MAGI is in [docs/magi.md](magi.md). The build history
  and hand-off are in [docs/magi-plan.md](magi-plan.md) §0.
