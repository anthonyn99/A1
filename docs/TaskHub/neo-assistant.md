# Neo — Veda's hands-free TaskHub assistant

**Veda's side only.** Say **"Hey Neo"**, then say what you want. Neo
does it in TaskHub and answers out loud. Tony's TaskHub never loads it into use:
the mic is released whenever the active profile isn't `veda`.

## Using it

- Tap **NEO** in the header (next to the mic). It lights up while it's listening.
  The first time, the browser asks for the microphone, and Neo downloads its
  wake-word model (about 41 MB, once per device; after that it starts at once).
- Say "Hey Neo" and wait for the chime, or say it all in one breath:
  "Hey Neo, add buy milk tomorrow at 5". Stop talking and Neo sends it.
  "Neo" on its own does not wake it (Veda's call, 2026-11-05): only "hey"
  straight before "neo" does (`isWake`).
- Neo answers out loud. For about 6 seconds afterwards it keeps listening without
  the wake phrase, so you can add something ("…and remind me at 4"). It remembers
  that turn for 2 minutes, so "it" and "that" find the right item.
- "Hey Neo, cancel" / "never mind" drops the request. The ✕ on the pill does the same.
- "Hey Neo, stop listening" switches it off. So does tapping NEO again.
- The switch is remembered per device (`localStorage vd_neo_on`).

## The look, the voice, the personality (Jarvis edition, 2026-11-05)

Veda's choices:

- the HUD in **her mauve, as a hologram**
- **Ryan**, a British male voice
- a **Jarvis-style butler** personality

It is Neo's own overlay and button only; the rest of her TaskHub's look is untouched.

### The HUD

`#vd-neo-hud` is built by `veda-assistant.js`. It's a glass panel at the bottom centre; on a
phone, a full-width bottom sheet.

- **The arc-reactor orb** (canvas):
  - a tick ring, three counter-rotating arc segments and an inner ring with a moving bright arc
  - a hexagon core
  - 64 waveform bars that follow her voice while she talks, and Neo's voice while it speaks
    (through an `AnalyserNode`)
  - orbiting particles while it works
  - on boot the rings draw in; on an error they flicker
- **The state label** (Orbitron) glitches in on each change: INITIALISING, ONLINE, LISTENING,
  PROCESSING, RESPONDING, STANDING BY, FAULT.
- **Live captions** ("YOU › …") come from a second, free-form Vosk recognizer that only runs
  during a capture. They are for display only; Gemini's cleaned-up `transcript` replaces them
  when the answer arrives.
- **The reply** types out word by word, in time with the voice (Orca's word timings, or the
  device voice's boundary events).
- **Action cards** (`cardFor`), one per change: `✓ TASK ADDED · Buy milk · FRI 6 NOV`,
  `⏱ TIMER · 25:00`, `☐ RULE ADDED`. A question gets `≡ BRIEFING`.
- **The telemetry strip** shows tasks done today, the next timed item, habits ticked, and the
  voice in use (RYAN or DEVICE).
- **Sound**, all synthesized (WebAudio, quiet): a shimmer on wake, a low pulse while it works,
  a chirp when a change lands, a falling tone on an error, and a power-up sweep on boot.
- **The header button** is a mini reactor that breathes while armed and spins while working.
- **`prefers-reduced-motion`** slows the orb and drops the sweep and glitch.

### The voice

**Ryan** (`en-GB-RyanNeural`) comes through Orca's Edge neural voices, using
`Shruti/app/orca.js` `speak()` and **her own Orca key**.

Neo reads that key from Shruti's cache (`localStorage shruti.veda.orcaKey`). If it isn't cached
on this device, it reads `dashboards/shruti_veda` through `window._fbLoadVedaOrcaKey`.
Both are read-only.

With no key, or when Orca fails, the device voice speaks instead, in this order:
1. Microsoft Ryan
2. Google UK English Male
3. Daniel
4. any en-GB voice
5. any English voice

### The personality

Only Veda's prompt carries this (`vedaNeoRuleLines` in the worker):

- a refined British AI butler: calm, precise, a light dry wit on successes, never on bad news
- it says "Veda" now and then
- "brief me" / "status report" gives a short rundown of her day

When she switches Neo on, it greets her by the time of day from her own data. This needs no API
call: "Good evening, Veda. Neo online. Two tasks remain today; next up, Gym at 5 PM."

## What it can do

Everything the mic and text buttons can do, because it uses the same engine
(`window._THV` in `index.html`) and the same worker route
(`personal-ai /taskhub/parse`, Veda's own Gemini key), plus Veda-only actions.

### It only claims what actually happened (2026-11-05)

The engine's `dispatch()` returns a result per action, `{action, ok, reason, ref}`,
and `later`, a promise for work that finishes after the commit (an AI prep kit, an
app opening or closing, the rules lock, the timer, a plan's fingerprint check).
Reasons include `not_found`, `no_bridge`, `off_pc`, `locked`, `no_reminder`,
`not_flagged`, `prep_failed`, `not_running`, `still_open`, `bridge_down`, `blocked`
and `invalid`.

- A worked action gets its card (`cardFor`). A failed one gets a red
  `✕ COULDN'T · …` card (`failCard`).
- The model's `say` was written before anything ran, so `compose()` trusts it only for
  what worked. If nothing worked, Neo says only the failure lines (`failLine`), never
  "Done". If some worked, it says `say` and then the failures.
- Neo waits up to 0.7 s for `later`. Anything still running is reported when it lands
  (`tellLater`). A rule change behind the `veda_rules` lock says "Unlock it, Veda…" and
  reports the outcome once the lock has.

### Asking first

These are said back as a question, and nothing runs until she says yes or taps YES on
the card ("Shall I clear all two items on Saturday the 7th?"):

- clearing a day or a box
- more than three removals, or removing a whole series
- `shift_range` and `clear_completed`
- `close_all_pc_apps`
- confirming a plan that has no date

The yes/no is decided on the device from Vosk's captions (`isYes`/`isNo`), with no
second API call. `_THV.sendAudio(…, {hold})` holds the actions back, and
`_THV.runActions` runs them.

### Follow-ups

Each turn's transcript, reply and results (with the ids of items added or changed)
go with the next request for 2 minutes as `extra.prev`. The worker shows them as
`previousTurn`, the model copies the id into `match.id` ("…and remind me at 4",
"actually make it 5"), and `locate()` honours it.

### The list

- **Tasks and events:** add, edit, remove, tick off, move, swap, reorder, clear, shift a
  date range, delete completed. Repeating items take `scope: "one" | "future" | "all"`
  on edit and remove. `edit_task set.repeat` fills in the later occurrences, as the
  editor does, and `set.repeatEndDate` is accepted.
- **Moves keep the item:** `move_task` and date edits move the same object, so its id,
  AI prep, repeats and reminders all stay.
- **Reminders:**
  - a changed reminder cancels the old one (series included) before scheduling the new
    one, never both
  - a date or time change moves the reminder with its item ("15 minutes before" stays
    15 minutes before)
  - `clear_reminder` removes one
  - `notify.repeat` / `repeatDays` give repeating reminders
- **AI prep:**
  - `prep_task {match, aiNote?, aiSite?}` sets `aiPrep: true` (plus the note and site)
    on the task, like the editor's box. The ✦ button shows, and the kit is never swept
    as stale. It then builds the kit, and reports `prep_failed` if none comes back.
  - `prep_off` turns it off.
  - `prep_open` ("start my email task") opens the assistant, sites and apps
    (`_vdPrepLaunch`).
  - `prep_show` opens the Prep panel.
  - `add_task` / `edit_task` take `aiPrep`, `aiNote` and `aiSite`.
  - Her items show `aiPrep` / `aiSite` to the model, so "which tasks have prep?" works.
- **Timer:**
  - set, start, stop, reset, open, close
  - `timer_set {minutes, start:true}` sets and starts in one command
  - break modes (`timer_mode`)
  - `timer_add`
  - "how much time is left?" (`state.timer`)
  - Commands queue until the panel has mounted, and each runs on the component's fresh
    state (`timerRun`), so none are dropped or run stale.
- **Trading rules:**
  - add, change, delete and reorder (`rules_move`)
  - the daily pop-up on/off
  - `rules_run` opens the checklist now
  - `rules_check` ticks the next row. It keeps the checklist's own rule: one row at a
    time, in order, each after its 3 s on screen. "All done" is refused.
- **Open:** Gita, Notebook, TaskHub, Plans, Rules, Timer, Shield, the Gita lessons list.
  Also her header links by label (`open_link`, with "Warden" for her links page).
- **Gita lessons:** next, previous, open lesson N.
- **View:** collapse or expand the week, the goals tab, next or previous month, go to
  today.
- **Locks:** `lock_app` locks a program that has a Guardian lock (`Guardian.lockNow`).
  Unlocking is never by voice.
- **Journal:** `journal_entry` writes a page into V's Notebook through
  `Notebook.putPage('bj', …)`, its public API only.
- **Classes:** `start_class` runs a StudyOS class's ▶ (`_sosLaunchClassClick`).
- **Plans with Tony:**
  - `plan_add` (an idea), `plan_propose`, `plan_confirm`, `plan_decline`,
    `plan_cancel_request`, `plan_done`
  - all through `PlansCore`, as Veda only, and inside the `veda_taskhub` lock
  - the stage rules and fingerprint checks are PlansCore's own
- **Questions** (answered from her data, changing nothing):
  - today, the next event, habits, rules, briefings
  - plans waiting on her (`state.plans`)
  - earnings and releases for the next two weeks (`state.marketCal`)
  - her classes
  - AI prep kits ("read me the draft for…", `state.prepKits`)
  - the timer
  - which apps are open (`state.pcRunning`)
- **Apps and websites on her PC:**
  - "open Spotify", "close Spotify", "force quit Word", "close everything but Spotify",
    "open YouTube"
  - Opening goes through `/api/launch`. Closing goes through the bridge's
    **`/api/close`**, and "what's open?" through **`/api/running`** (see below).
  - Each app reports its own outcome: "Spotify wasn't running.", "Word is asking to
    save, so I've left it open.", "I couldn't find Photoshop on your PC."
  - A **website on her phone** opens in a new tab (no bridge needed). Apps need the PC.
  - "Her PC" means the bridge answered (`_vdBridgeUp`), falling back to a Windows
    browser.
  - Browser tabs can't be closed, and Neo says so.
  - Undo covers TaskHub changes only, and Neo says that too.
  - **The worker sees her app names.** Neo sends the names from her PC's app list
    (`dashboards/veda_pc_apps`, published by the StudyOS bridge, Store apps included)
    as `state.pcApps`, so Gemini copies the exact name.
  - **The name becomes an id locally.** `matchApp` in `veda-assistant.js` turns the
    name into the bridge's app id: an exact match first, then a nickname ("VS Code",
    "Chrome"), then the shortest name containing her words, then word overlap.
    `chrome_proxy` never passes for Chrome.
  - The page's calls to `/api/close` and `/api/running` (`_sosBridgeClose`,
    `_sosBridgeRunning`) live in `veda-assistant.js`. In index.html, AI prep stays the
    only caller of the local bridge (`tests/reels-widget.test.js`).

### Closing apps (the bridge, `V1/tools/sos-browser/launcher.py`)

`POST /api/close {apps:[id], force?, browser?}` and `GET /api/running` sit behind the
same TaskHub-only origin gate as `/api/launch`, in both `server.py` and
`prep_bridge.py`. A request names only ids from the bridge's own scan.

- **Finding an app's processes** (`proc_matches`):
  - for a `.lnk`, its target .exe (read through `WScript.Shell`)
  - for a Store app, its package folder (`Get-AppxPackage`)
  - for a desktop AppID, the .exe it names
  - a windowed process whose description *is* the app's name, or the maker plus the
    name ("Microsoft Word" for Word; not "Visual Studio Code" for "Visual Studio")
- **How it closes:**
  - graceful first (`CloseMainWindow`, the same as ✕), then a 2.5 s check
  - an app still open after that is reported `stillOpen` (it is asking to save)
  - only `force` uses `taskkill /F /T`
- **Never closed:** Windows' own processes and Python (the bridge itself). Also the
  default browser, unless she named it (`browser: true`). "Close everything" always
  skips browsers.
- The first `/api/running` takes about 9 s (it resolves every shortcut once). After
  that it's cached per scan.
- **Restart the bridge to load the new routes.** Until then `/api/close` answers 404,
  and Neo says the bridge isn't answering.

## How it works

| Step | Where |
|---|---|
| Wake phrase | `TaskHub/veda-assistant.js` runs Vosk (open source, offline WASM, `vosk-browser@0.0.8`) with a fixed word list: "hey neo", "neo", near-sounding decoys, and `[unk]`. Only "hey" then "neo" wakes it. |
| Capture | The same mic stream. It keeps a 1.5 s pre-roll and stops after 1.4 s of silence (a loudness threshold that adapts to room noise), or after 30 s at most. |
| Understanding | `_THV.sendAudio(b64, {extra:{mode:'neo'}})` posts the WAV with her state. The worker adds Neo's Veda-only actions and rules to the prompt (`vedaNeoActionLines` / `vedaNeoRuleLines`). |
| Doing | The engine's `dispatch` → `applyControl` → Veda's bridge `window._vdVoice` (`changeRules`, `nav`, `prep`, `closeTimer`, …). Tony's `_thVoice` has none of these, so the actions do nothing on his side. |
| Answering | `speechSynthesis`, using a natural en-US voice when the device has one. |

**Why Vosk and not the browser's SpeechRecognition:** Brave (Veda's browser)
blocks it. Vosk runs on the device, costs nothing, and sends no audio anywhere
until after the wake word. The model is stored in IndexedDB by the library,
never in localStorage (A1's localStorage is near full on her Brave).

**Model host:** `ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz`
(`MODEL_URL` in the script). If that host ever disappears, copy the same file
somewhere that serves it with CORS and change `MODEL_URL`. Every device then
downloads it once more.

## Limits (browser rules, not bugs)

- It only hears while TaskHub is open in a tab. On a phone, the screen must also
  be on with TaskHub in front. It sleeps when the tab is hidden and wakes when
  you come back.
- The wake phrase is two words, "Hey Neo", so a stray "Neo" in talk or on TV
  doesn't fire it. A false wake with no speech after
  it times out quietly.
- Shield opens in a new tab. Opened by voice, the browser may block the pop-up
  and ask first.

## Tests

`node tests/veda-assistant.test.js` covers:

- Tony's prompt, schema (`ACTION_SCHEMA`), item fields and state carry nothing of Neo,
  and every Neo action does nothing on Tony's bridge
- the mic never opens off Veda's side
- the wake phrase ("Hey Neo" wakes; "Neo" alone doesn't), the end-point detector and
  the WAV output
- per-action results: not found, missing bridge, partial success, gated rules, failed
  launches, and prep kits that never come
- the state really changing:
  - the AI prep flag is set
  - a reminder is replaced (cancel before schedule), moved with its date and time, and
    cleared
  - moves keep the item, `match.id` works, `scope: "future"` removes, and repeats fill in
- every Neo action has a card, an executor and a prompt line
- what Neo says (`compose`, `failLine`), when it asks first (`needsConfirm`), and the
  timer queue

`py -3.11 V1/tools/sos-browser/test_launcher.py` and `test_prep_bridge.py` cover
`/api/close` and `/api/running`: the matching, graceful vs force, "asking to save", the
denylist, the browser, and the origin gate. Processes are stubbed, so nothing is closed.
