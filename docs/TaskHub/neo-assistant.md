# Neo — the hands-free TaskHub assistant

**Both sides since 2026-11-06** (it was Veda's alone before). Say **"Hey Neo"**,
then say what you want. Neo does it in TaskHub and answers out loud. One script
(`TaskHub/veda-assistant.js`) serves whichever TaskHub is in front; each side has
its own switch, name, voice key, colours, bridge and reach. Most of this page was
written for Veda's Neo and still describes it; **Tony's Neo** (below) lists what
differs on his side.

## Tony's Neo (2026-11-06)

The same assistant, wired to Tony's TaskHub and contents:

- **His switch:** the NEO button in his header (beside the input-device button).
  Remembered per device as `localStorage th_neo_on`; Veda's is `vd_neo_on`. One
  side being on never turns the other on, and switching sides releases the mic.
- **His look:** the same HUD, orb and spotlight in MAGI's purple on a solid panel
  (`#vd-neo-hud.p-tony`, generated from Veda's rules by `tonySheet()` so the two
  never drift). Docked, it takes his quote's slot between weather and Tesla at
  exactly the quote's height, so nothing below moves (`placeHud`).
- **His voice:** Ryan through Orca with HIS key (`shruti.tony.orcaKey`, else
  `dashboards/shruti` via `window._fbLoadTonyOrcaKey`, read-only); the device's
  British voice when there is no key. He is greeted by name, and called "Tony" or
  "sir" now and then.
- **His reach** (`window._thVoice` in index.html): tasks, habits and goals with
  the spotlight; reminders, repeats and scopes; AI prep (`_thPrepRequest`,
  `_thPrepLaunch`, his Prep panel); the timer; week collapse, goals tab, month;
  Notebook, Plans, Shield and his header programs (TradeHub, WarRoom, Keychain);
  locks (`tony_taskhub`, `tony_myjournal`, `tony_shield`); journal entries into
  T's Notebook (`tj`); plans with Veda as Tony; earnings and releases from his
  market calendar; and apps on his PC through his A1 Prep Bridge
  (`V1/tools/sos-browser/prep_bridge.py`, port 8781, his app list `_thPcApps`).
- **Not on his side:** Veda's trading rules, Gita lessons, StudyOS classes and
  reels. The worker never offers them to him and his bridge has no method for them.
- **His mic and text buttons are unchanged.** The worker gives Tony the Neo prompt
  (`tonyNeoActionLines` / `tonyNeoRuleLines`), the wider schema and the extra
  state ONLY for requests marked `mode:"neo"`, which only Neo sends.

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

`#vd-neo-hud` is built by `veda-assistant.js`.

**Docked (2026-11-06, Veda's call).** When her TaskHub's Gita quote banner is on screen, Neo
takes its slot in the weather band instead of popping up at the bottom (`placeHud`): the HUD is
inserted beside the banner and `body.vn-docked` hides the banner (React owns the banner, so its
own classes are never touched). Docked, it's dressed as the quote card itself (same border,
mauve left edge, IBM Plex Mono, the quote's font for the reply), with none of the hologram
extras (scanlines, sweep, brackets, glitch, hex ticker, telemetry) and the orb replaced by a
row of 11 rounded bars that follow her voice and Neo's (`drawBars`). Banner and Neo crossfade.
When the banner isn't on screen (scrolled away, another view), the floating panel below is
used: a glass panel at the bottom centre; on a phone, a full-width bottom sheet.

- **The arc-reactor orb** (canvas):
  - a tick ring, three counter-rotating arc segments and an inner ring with a moving bright arc
  - a hexagon core
  - 64 waveform bars that follow her voice while she talks, and Neo's voice while it speaks
    (through an `AnalyserNode`)
  - orbiting particles while it works
  - on boot the rings draw in; on an error they flicker
- **The state label** (Orbitron) glitches in on each change: INITIALISING, ONLINE, LISTENING,
  PROCESSING, RESPONDING, STANDING BY, FAULT.
- **Live captions** ("YOU › …") come from the browser's own recognizer (Web Speech: Chrome,
  Edge) when it works, else a second, free-form Vosk recognizer that only runs during a
  capture (Brave reports `network` and is remembered as broken for the session). Either way
  `fixCaption` snaps runs of words that sound like her own names (task titles near today,
  habits, goals, PC apps, Neo's views) to those names: same first letter, close spelling or
  the same consonant skeleton, so ordinary words stay. They are for display only; Gemini's
  `transcript` (told to prefer her own names from state and the conversation over
  similar-sounding words) replaces them when the answer arrives.
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

**A conversation, not one command (2026-11-06).** The last 8 turns from the past 15 minutes
also go as `extra.history`; the worker shows the earlier ones as `conversation` (Veda only).
The prompt's CONVERSATION rule lets Neo follow a change of mind (edit or delete what an
earlier turn did, by id), ask ONE clarifying question when a request is genuinely ambiguous,
take her next turn as the answer, and just talk. After every reply it keeps listening without
the wake word for 10 s, or 16 s when the reply ended in a question.

### Spotlight: watching the change happen (2026-11-06)

When Neo adds, edits, ticks, moves or removes something, it shows the change on screen,
then goes back to the view she had.

```
reply ─► spotlightBefore(actions)        veda-assistant.js, via send()'s `before` hook
           · _THV.preview(actions): the same matching as dispatch(), on a copy
           · save the view (week, goals tab, phone day, scroll)
           · go to the first place (week fades out/in; goals tab; phone day)
           · ring rows about to change (red for a remove), ~450 ms
      ─► dispatch(actions)               index.html, unchanged
      ─► spotlightAfter(results)         alongside the spoken reply
           · ring what landed; up to 4 places, ~1.2 s each, the last 1.4 s
           · fade the rings, go back to the saved view
```

- The rings are fixed elements drawn over the rows (`[data-dkey=<id>]`) and follow
  them each frame, so React re-renders can't disturb them and nothing in the layout
  moves. A ring whose row has gone fades where it was.
- A tap, scroll, wheel or key ends it at once and leaves her where she is. Turning Neo
  off goes back to the saved view.
- It only runs while her TaskHub is the screen in front of her, and only for task,
  habit and goal changes (apps, the timer, questions show nothing). With reduced
  motion turned on, nothing scales; the rings just appear.
- Tony's side: `send()`'s `before` and `_THV.preview` are only used by Neo; his mic and
  text paths never pass them. `mobDay` is on Veda's bridge only.

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

### Programs: every program linked from her TaskHub (Veda only, 2026-11-06)

Goal (Veda's call): Neo can **open, read and act inside** every program linked
from her TaskHub. Tony's Neo is unchanged. This is built in phases, one per session:

| Phase | Programs | Status |
|---|---|---|
| 0 | Foundation; every linked program opens | **done 2026-11-06** |
| 1 | V's Notebook, Plans, Shruti, MAGI (T) (`TaskHub/neo-connectors.js`) | **done 2026-11-06** |
| 2 | STUDY (StudyOS) | **done 2026-11-06** |
| 3 | LIST (MyList) | **done 2026-11-06** |
| 4 | TRADE (TradeBoard) and FINANCE (Shield left out: Veda's call) | **done 2026-11-07** |
| 5 | SYSTEM (Solo-Leveling), RESERV, WARDEN | **built 2026-11-07**; SYSTEM's and RESERV's worker changes committed in their repos, deployed once Veda approves |

Veda's calls (2026-11-06):
- **EVERWELL is out**, and so are **Wellness, RIFTIQ and ORCA** (her call, later the same day). Neo never
  lists, opens or touches them (`off` in `KNOWN`), and `NEO_DOCS` has none of their documents.
- **MAGI means MAGI (T)**, the A1 page (`magi.html`, her `dashboards/magi_veda`). Her council
  link (`magi-council-4f7a…`, source not in A1, A1-Priv or Downloads) is only opened, as "council".

```
worker sees state.programs [{id, label, ops?, summary?}]
  → {type:"open_program", program}  |  {type:"program", program, op, args:[{k,v}]}
  → index.html applyControl → _vdVoice.openProgram / .program
  → TaskHub/neo-programs.js  window._vdNeoPrograms  (open · run · state · register)
  → a connector's ops → _fbNeoGet / _fbNeoPatch / _fbNeoTx (index.html)
```

- **The list** starts with the programs inside her TaskHub (`BUILTINS`: V's Notebook and
  Plans), then her header links (`_navGetLinks('veda')`), her LifeHub
  list (`LifeHub.list('veda')`, hidden tiles left out) and Warden. Each address is
  listed once, and TaskHub itself is left out. Known programs keep stable ids:
  `studyos`, `finance`, `tradeboard`, `mylist`, `magi_council`, `magi`, `shruti`,
  `shield`, `system`, `reserv`, `warden` (`everwell`, `wellness`, `orca` and `riftiq` are known only to be left out). Anything else gets
  `link:<id>` or `lh:<id>`, and so does a second link to the same kind of page.
- **Names:** a known program's id wins, so "MAGI" is MAGI (T). Then her own label, an
  alias ("solo leveling", "study", "council"), then part of a label.
- **Opening** works the way its own button or tile does: `_navOpenLink` for a header
  link (its lock and named tab included) and `LifeHub.launch` for a tile. Warden replaces
  the page 2.6 s later, so Neo finishes speaking first. `open_link` falls back to this
  list, so "open StudyOS" works either way.
- **Acting inside** a program: a connector,
  `_vdNeoPrograms.register(id, {summary(), ops:{name:{args, confirm?, run(args)}}, deep?(x)})`.
  - Each op answers like every Neo action: `true`, `{ok:false, reason}`, or a promise.
  - With no such op, the answer is `no_op`, and Neo says "I can open X, but I can't do
    that inside it yet."
  - An op with `confirm` is asked first (`needsConfirm`).
  - `summary()` is cached and refreshed every 5 minutes and after Neo's own writes, so
    reading costs no extra call.
- **Locks:** a connector names its Guardian lock (`lock`, one id or several), and an op may
  add its own (a TradeBoard section). While a lock is on, Neo reads nothing behind it (the
  summary says "Locked"), and an op asks for the unlock through `alGate`, Guardian's card.
  - **Each program's own lock, on its own record** (`LOCKDEFS` in `neo-connectors.js`,
    2026-11-07). A lock this page didn't declare would be looked up under the wrong record
    and could read as "no lock": MyList's (`mylist` / `profile_veda`) was, in phases 0 to 3.
    So every lock Neo leans on is declared with the record and backend its own program
    uses:
    - MyList, Shruti and MAGI on Guardian's worker;
    - StudyOS: its Firestore `dashboards/studyos_lock` for whether the lock is on, and
      `studyos-api` for the password;
    - TradeBoard's app lock and its Portfolio, Journal and Control section locks: their
      versions from TradeBoard's own `_applock`, the password checked on `tradeboard-auth`;
    - Finance on `tradeboard-auth`.
  - From TaskHub a password is only checked. Setting, changing, resetting it and hint
    emails stay in the program.
  - Before a card comes up, the lock's status is asked again (`gated` → `Guardian.refresh`),
    so a lock that isn't set never asks for a password. Every status is fetched once when
    TaskHub opens on her side, and with the summaries.
- **Reading aloud:** an op that reads answers `{ok:true, say}`. The engine's `settle`
  carries the `say`, and Neo speaks it after its reply. The prompt tells the model that,
  for these ops, `say` is only a short lead-in.
- **Deep links** (`deep`) open in the tab the program's own button uses (`tab`), and that
  tab is sent there even when it is already open on the page (`openDeep`).
- **Firestore** (`_fbNeo*`): Veda's side only, and only the documents her programs keep
  (`NEO_DOCS` in index.html). Every write is a field-path patch or a transaction. Neo never saves a whole document rebuilt from a stale copy.
#### Phase 1 connectors (`TaskHub/neo-connectors.js`)

| Program | Reads (summary, ops) | Acts | How it writes |
|---|---|---|---|
| V's Notebook (`notebook`, lock `veda_journal`) | page count and the latest titles; `read_page(title)`, `find(words)` | `open_page`, `new_page`, `append`, `tag` | Notebook's API only: `Notebook.pages` / `Notebook.page` (new, read-only, in `Notebook/` so every host has it) and `putPage`. A page with its own lock is never read or changed. Only an ordinary page takes an append or a tag. |
| Plans (`plans`, lock `veda_taskhub`) | (already in `state.plans`) | `edit`, `reschedule`, `remove_idea` (asks first; an idea only) | `PlansCore.applyEdit` / `proposeReschedule` / `removePlan`. An agreed plan's change goes to Tony to approve, and Neo says so. |
| Shruti (`shruti`, lock `veda_shruti`) | last opened, chapters read, in progress, next unread, bookmarks | `open_chapter(chapter, mode?)`, `continue`, `mark_read`, `mark_unread` | Field-path patches on `dashboards/shruti_veda` (`progress.gita.chN.{f,done,modes.read,at}`, `last`), as Shruti's own `setProgress` does. Deep link `shruti.html?profile=veda#/b/gita/N/mode`. |
| MAGI (T) (`magi`, lock `veda_magi`) | her recent questions; `read_answer(question?)` (the verdict) | `ask(question)` (asks first: it uses her AI accounts) | Reads `dashboards/magi_veda` and its `runs/<id>`. Asking writes nothing: MAGI gets the question through its own `#tb=` link (`A1Debrief.openMagi`, `p:"veda"`, `run:1`) and runs it. |

#### Phase 2: StudyOS (`studyos`, lock `veda_studyos`)

**Reads (the summary):**
- her classes and each class's Notes modules
- open tasks due in the next two weeks, with how many are overdue
- events in the next two weeks
- flashcards due and new, per class (`studyos_cards/<class>`: live, active, `sched.state` not new, `sched.due` passed)
- minutes studied this week (`dashboards/studyos_sessions`)

**Acts:** `add_task`, `complete_task`, `move_task`, `remove_task`, `add_event`, `remove_event`, `add_note`, `add_card` and `open_class` (`studyos/?class=<id>`).

How each write stays safe:
- **Tasks and events:** StudyOS saves `dashboards/studyos` whole, and an open tab takes a remote copy's arrays wholesale. So each write is `_fbNeoTx` on the server copy. It changes one item by id and updates only `tasks` or `events`. Each object is built exactly as StudyOS's forms build it (`saveTask`/`saveEvent` field names: `name`, `dueDate`, `dueTime`; never `undefined`).
- **The tab race:** an open tab saving in the same moment can still write over Neo's change. `sosWrite` therefore looks again 3 s later and puts the change back, by id so never twice.
- **TaskHub's calendar:** StudyOS's mirror updates when StudyOS next runs, so a task Neo adds shows on her TaskHub calendar once StudyOS has been open.
- **Notes** are pages in StudyOS's Notebook (`dashboards/studyos_notebook`). Each is a new `e_<id>` field, with `_order` taken from the server copy in the same transaction and the new page on top. A note goes only into a **Notes** module's folder: a note in a documents module would render nowhere. With no class it goes to Quick Notes. A class with several Notes modules gets a question back.
- **Cards** follow cards v2:
  - a random `cd_` id and StudyOS's own FNV-1a fingerprint (tested against `cards.js`)
  - `sched: null`, so the card is new; `source: 'neo'`
  - no duplicate by fingerprint
  - a class with no deck yet is left for StudyOS to make: Neo never creates a deck document, which would lack its `meta`.

#### Phase 3: MyList (`mylist`, lock `mylist:profile_veda`)

**Reads:**
- the summary: her lists, each list's type, and how many items are left and done, with up to 10 open items each
- `read_list(list?)`

**Acts:** `add_item` (with qty and store, the store added to the list's stores as MyList does), `check_item`, `uncheck_item`, `remove_item`, `clear_checked` (asks first) and `new_list`.

**How it writes:**
- `dashboards/mylist` holds Tony's lists as well, and MyList saves it whole. Neo changes only the field path `veda.lists` (plus `savedAt`), in a transaction on the server copy. Tony's lists, the locks and `lockV` are never in a write.
- If her lists can't be read, nothing is written.
- An open MyList tab ignores snapshots for 8 s after its own save. Neo therefore looks again at 3 s and 12 s and puts its change back (by id, once).
- With two or more lists and none named, Neo asks which.

#### Phase 4: TRADE and FINANCE (`tradeboard`, `finance`)

Both live in another Firebase project, `tradeboard-6b2ea`. TaskHub reaches it through a
second, named app (`neo-tradeboard`), signed in anonymously as those programs are, with
`_fbTbGet` / `_fbTbList` / `_fbTbTx` in index.html. They work on Veda's side only and on the
documents in `NEO_TB_DOCS` only. Checked 2026-11-06:
- **That project has no App Check.** Its App Check API is off ("has not been used in project
  … or it is disabled"), so nothing is attached and nothing can be refused for it.
- **Its API key accepts anthonyn99.github.io.** An invalid sign-in lookup from there was
  refused for the token, not the site.

**TRADE** (lock `veda_tradeboard`):
- **Reads:**
  - portfolio: total, cash, day P&L, positions (needs the Portfolio section lock)
  - journal: trade count, open trades, the latest eight with P&L (needs the Journal lock)
  - watchlist (needs the Control lock)
- **Acts:** `watch_add` and `watch_remove`, with Control's lock:
  - a removed ticker goes to TradeBoard's 30-day trash, as its own Remove does
  - at most 40 tickers
  - a watchlist never saved is left alone (Neo would otherwise replace TradeBoard's default)
- **Writes:**
  - each field is TradeBoard's JSON string, written in a transaction with `_updated`, and
    looked for again 3 s later
  - it never writes trades, positions or the account (the Webull sync owns them)
  - **it never places, changes or cancels an order:** there is no such op

**FINANCE** (lock `veda_finance`, Finance's own password):
- **Reads:**
  - net worth: assets and debts from `finance/meta/accounts`
  - cash on hand
  - this month's spending and income: card payments and transfers left out, by category
  - budgets against what was spent
  - the ten latest transactions (Plaid's and manual)
- **Acts:** `add_expense` and `add_income`. Each makes Finance's own manual record as a new
  document in `manual_transactions` (an `m_<time>_<rand>` id, Plaid's sign: an expense is
  positive, a category from Finance's lists). Plaid's transactions, accounts and the ledger
  are never written.

#### Phase 5: SYSTEM, RESERV, WARDEN

**SYSTEM and RESERV: signing in from TaskHub.** Both are cookie-only workers on Veda's
account. Their cookie is SameSite=Lax and `*.workers.dev` is a public suffix, so a page on
anthonyn99.github.io never sends it. Each worker therefore got the same small change in its
own repo:
- CORS on `/api/*` for `https://anthonyn99.github.io` only.
- A login from there that asks for `token: true` also gets its 30-day session token in the
  body.
- That token is accepted as `Authorization: Bearer`: same token, same check, cookie path
  unchanged.
- RESERV's relay drops `Authorization`, so the token never reaches the PC.

The commits:
- `SOLO-LEVELING` (branch `fix/audit-p0`, which is what is live): `f1b40eb`. Deploy with
  `cd worker && npm run deploy`.
- `RESERV` (`main`): `68018be`. Deploy with `deploy-worker.bat`.

In TaskHub:
- The token is Neo's "lock": `veda_system` / `veda_reserv`, a Guardian backend
  (`sessionLock`).
- Her password is asked once per device on Guardian's card, checked by the program's own
  `/api/login`, and the token is kept as `localStorage neo.tok.<id>`.
- A token the program no longer takes is dropped, and the card asks again.

**SYSTEM** (`system`):
- **Reads (summary):** today's focus and why, the lesson and its XP, done today, XP today,
  lessons this week, streak, every stat's level. `read_review` asks SYSTEM's own AI for its
  weekly review (slow).
- **Acts:** `log_activity(stat, xp?, description?)` (says a level-up), `notebook_lesson(prompt,
  stat?)`, `reminder(on, time?)`.

**RESERV** (`reserv`):
- **Reads (summary):** whether the PC is online, the shopping list (as last saved when the PC
  is off), unread notifications. `read_notifications` reads them out.
- **Acts:**
  - `add_item(name, when?, qty?, brand?, size?, target_price?)` (needs the PC on)
  - `mark_notifications_read`
  - nothing touches RESERV's store accounts

**WARDEN** (`warden`, Warden's own lock `veda_warden_standalone`):
- **How it is reached:** through its links worker (`warden-links`, the `X-Warden-Key` Warden's
  config calls not a secret), as Warden's extension reaches it. Warden's own Firestore has App
  Check on its Pages domain.
- **Reads (summary):** connection and link names only. Emails, phones and usernames never go
  to the model. `read_connection` reads them aloud.
- **Acts:** `open_link`, and `add_link(connection, name, url)`:
  - that worker REPLACES the document on every save, so Neo saves only a list it has just
    read whole, with one link added and the layout kept
  - an empty or failed read is never written back
- The vault (passwords) is never touched.

- **The traps each program has, which the later phases must keep to:**
  - StudyOS: whole-doc saves; cards v2 tombstones; never write `studyos_mirror`.
  - MyList: the doc also holds Tony's lists, so only `veda.lists` is touched.
  - V's Notebook: never republish `_order`.
  - Shield: a lockdown also needs its Worker signal.
  - TradeBoard: another Firebase project. It never places, changes or cancels an order.

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
| Capture | The same mic stream. It keeps a 1.5 s pre-roll and stops after 1.1 s of silence (a loudness threshold that adapts to room noise), or after 30 s at most. |
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

`node tests/live/neo-tony.live.js` drives Tony's side in a real browser (fake
Firestore): his button and switch, a Neo-mode request as Tony landing on his
TaskHub with the spotlight in his purple, timer/week/goals through his bridge, the
HUD docked in his quote's slot with zero pixel shift, and Veda's switch staying hers.


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
- the spotlight: `_THV.preview` names each action's row and date without changing
  state, `before` is awaited ahead of the change, and the stops are grouped and capped

`node tests/neo-connectors.test.js` covers Phase 1: Notebook's read API, and each
connector against fakes (what it reads, the shape it writes, what Neo says, locks, a
page's own lock, Tony's side).

`node tests/live/neo-programs.live.js` drives the program list in a real browser
(fake Firestore): what is listed, `state.programs` reaching the worker, opening one,
and `_fbNeo*` reaching only her programs' documents, only on her side. Phase 1: the real
Notebook store read and appended to, Shruti's progress patched, a MAGI verdict read and
a question handed to MAGI (T).

`node tests/live/neo-spotlight.live.js` drives it in a real browser (fake Firestore):
an add two weeks out, a remove, a goal on the other tab, and a tap that stops it.

`py -3.11 V1/tools/sos-browser/test_launcher.py` and `test_prep_bridge.py` cover
`/api/close` and `/api/running`: the matching, graceful vs force, "asking to save", the
denylist, the browser, and the origin gate. Processes are stubbed, so nothing is closed.
