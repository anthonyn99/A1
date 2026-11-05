# Neo — Veda's hands-free TaskHub assistant

**Veda's side only.** Say **"Neo"** (or "Hey Neo"), then say what you want. Neo
does it in TaskHub and answers out loud. Tony's TaskHub never loads it into use:
the mic is released whenever the active profile isn't `veda`.

## Using it

- Tap **NEO** in the header (next to the mic). It lights up while it's listening.
  The first time, the browser asks for the microphone, and Neo downloads its
  wake-word model (about 41 MB, once per device; after that it starts at once).
- Say "Neo" and wait for the chime, or say it all in one breath:
  "Neo, add buy milk tomorrow at 5". Stop talking and Neo sends it.
- Neo answers out loud. For about 6 seconds afterwards it keeps listening without
  the wake word, so you can add something ("…and remind me at 4").
- "Neo, cancel" / "never mind" drops the request. The ✕ on the pill does the same.
- "Neo, stop listening" switches it off. So does tapping NEO again.
- The switch is remembered per device (`localStorage vd_neo_on`).

## What it can do

Everything the mic and text buttons can do, because it uses the same engine
(`window._THV` in `index.html`) and the same worker route
(`personal-ai /taskhub/parse`, Veda's own Gemini key):

- Tasks and events: add, edit, remove, tick off, move, swap, reorder, clear,
  shift a date range, delete completed, reminders, repeats.
- Daily habits, short-term and long-term goals.
- Timer: set, start, stop, reset, open, close.
- Go to a date, edit mode, new quote, undo / redo ("Neo, undo").
- **Questions:** "what's on today?", "what's my next event?", "did I do my
  habits?", "what are my rules?". These are answered from her data and change
  nothing.
- **Trading rules:** add, change or delete a rule, and turn the daily rules
  pop-up on or off. These honour the `veda_rules` lock, and voice changes to
  rules can be undone.
- **Open:** Gita, Notebook, TaskHub, Plans, Rules, Timer, Shield.
- AI prep for a task ("Neo, prep my email to the professor").

## How it works

| Step | Where |
|---|---|
| Wake word | `TaskHub/veda-assistant.js` runs Vosk (open source, offline WASM, `vosk-browser@0.0.8`) with a fixed word list: "neo", near-sounding decoys, and `[unk]`. Only "neo" wakes it. |
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
- "Neo" is one short syllable. If it fires by accident, say "Hey Neo" instead;
  it hears that more reliably in a noisy room. A false wake with no speech after
  it times out quietly.
- Shield opens in a new tab. Opened by voice, the browser may block the pop-up
  and ask first.

## Tests

`node tests/veda-assistant.test.js` covers:

- Tony's prompt and state carry nothing of Neo
- the new actions do nothing on Tony's bridge
- the mic never opens off Veda's side
- the wake word, the end-point detector and the WAV output
