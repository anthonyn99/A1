# AI prep (both TaskHubs)

Flag a task "AI prep" in the editor, add a note, pick an assistant. Ahead of
time the personal-ai worker (`POST /taskhub/prep`) turns it into a **kit**: a
ready prompt, a first draft (an email gets a Gmail compose link), the sites
and the PC apps the task needs. The ✦ on the row opens the assistant with the
prompt typed in and shows the kit in the Prep panel. Nothing is ever sent for
anyone: every action is a link or a copy button.

Veda had it first (2026-10-03). Tony got the same feature on 2026-10-13.

## Who owns what

Nothing is shared between the two except the code and the worker route.

| | Veda | Tony |
|---|---|---|
| Page logic | `VD-PREP` block in index.html | `TH-PREP` block |
| Editor, panel, ✦ | `Modal`, `VdPrepPanel`, `vdPrepBtn` | `ItemModal`, `ThPrepPanel`, `thPrepBtn` (MAGI look) |
| Kits | `dashboards/veda_taskprep` | `dashboards/tony_taskprep` |
| PC app list | `dashboards/veda_pc_apps` | `dashboards/tony_pc_apps` |
| Gemini key / prompt | `VEDA_GEMINI_KEY`, written for Veda | `TONY_GEMINI_KEY`, written for Tony |
| Default assistant | localStorage `vdAiSite` | localStorage `thAiSite` |
| Events | `vd-prep-update`, `vd-prep-open` | `th-prep-update`, `th-prep-open` |

The task fields (`aiPrep`, `aiNote`, `aiSite`) live on each person's own task
in their own dashboard doc.

## Rules that keep it that way

- **TH-PREP is generated from VD-PREP**: comments removed and every `_vd` /
  `Vd` / `vd-` name moved to `_th` / `Th` / `th-`.
  `tests/taskprep-page.test.js` rebuilds it the same way and fails on any
  difference. So a fix goes into VD-PREP first, then make the same change in
  TH-PREP.
- **Both TaskHubs are mounted on every device** and both probe the one PC
  bridge (`V1/tools/sos-browser`, `127.0.0.1:8781`). Whose PC it is decides
  whose app list may be published: Veda's never from a PC whose
  `td6_mainDash` is `tony`, and Tony's only from one that is. A refused save
  also keeps the list out of memory, so no kit is built from the other
  person's apps.
- **The bridge probe repaints only on a change.** Each App re-runs its prep
  effect on every repaint, and that effect probes again. Before 2026-10-13
  the probe always repainted, so every Windows PC with TaskHub open asked the
  bridge every 3 seconds, forever.
- **"All future repeats"** carries the AI prep fields along with the title
  and type, on both sides. Before, an AI prep change made in that same edit
  was dropped.

## The PC bridge on Tony's PC

Since 2026-10-15 Tony's PC runs the **A1 Prep Bridge**
(`V1/tools/sos-browser/prep_bridge.py`): only the two AI prep routes of the
StudyOS bridge (`/api/apps`, `/api/launch`, same port 8781, same origin gate,
`launcher.py` underneath), standard library only, started at logon by the
"A1 Prep Bridge" shortcut in his Startup folder (`C:\Python314\pythonw.exe`).
It exits quietly if the port is taken. With it, ✦ opens his Gmail draft, the
sites and his PC apps, then the assistant last, and his app list publishes to
`tony_pc_apps` by itself. The first time, Brave asks to let the site reach
"apps on this device": Allow. His panel names this bridge, not StudyOS.

## Assistants

Perplexity, ChatGPT, Claude and Gemini (Gemini since 2026-10-15). The first
three take the prompt in their URL. **Gemini takes none** (tested signed in
and out: `?q=`, `?prompt=`, `?text=`, Chrome's `/prompt?q=` all leave the box
empty), so its `SITES` entry has `paste: true`: ✦ and "Open in Gemini" put
the prompt on the clipboard in the same click, and the panel says to press
Ctrl+V. The worker tells every assistant it has no access to the person's
email, calendar, files or accounts, so the prompt asks only for text (before,
Perplexity answered "I don't have access to Gmail").

## The Gmail draft link

Built as `https://mail.google.com/mail/u/0/?fs=1&tf=cm&to=&su=&body=`, by the
worker (`prepGmailUrl`) and again by the page from the kit's draft
(`_vdPrepKitSites`), so kits saved earlier are fixed too. The old
`/mail/?view=cm` link is redirected by Gmail when signed in, and that redirect
drops every line break: the email opened as one run-on paragraph (2026-10-15).

## Without a bridge

A click may open one tab, or several where the site may open pop-ups. The
page learns which (`a1PrepTabs` in localStorage, one answer per browser):
until known, the assistant opens first and then the sites; once known, the
sites first and the assistant last, so it is the tab in front. Blocked tabs
go to the bridge in case it answers, and the panel says how to allow pop-ups.

## The note box

The AI prep note in both editors has A1's corner grip (`resizegrip.js`),
tinted per profile, remembered as `a1.h.th.prepnote` / `a1.h.vd.prepnote`.

## Tests

- `node tests/taskprep-page.test.js`: page logic for both sides, no drift,
  separation, the loop fix.
- `node tests/taskprep-kit.test.js`: the worker's kit rules and the
  per-profile prompt.
- `node tests/live/taskprep.live.js`: both TaskHubs in a real browser
  against fake Firestore, a fake worker and a fake bridge (also Gemini, the
  Gmail link, the grip drag and the no-bridge tabs).
- `python V1/tools/sos-browser/test_prep_bridge.py`: Tony's bridge.
