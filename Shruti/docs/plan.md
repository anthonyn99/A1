# Shruti — build plan

## §0 — Where we are (read this first in every new session)

**Built one phase per Claude session** (Tony, 2026-10-19). A new session that is told
"continue Shruti" / "next Shruti phase" reads this §0, builds **exactly the phase named
below**, then: runs `npm test` (and the phase's live checks at 390 px and 1280 px on both
profiles), lets the auto-commit push it, and **rewrites this §0** to name the following
phase and record anything the next session must know. Then it stops and tells Tony the
phase is done so he can open a fresh session for the next one.

**Done:**
- **Phase 1: content (2026-10-19).**
  - `books/gita/ch00.json` (introduction) and `ch01`–`ch18.json` hold every verse, section heading, commentary, NOTE and gloss of the IGS PDF. Key (yellow) verses are `key:true`; partial highlights are `hl:[[start,end]]` ranges.
  - `lessons.json` holds all 151 lessons from the 7 notes PDFs, word for word, with each chapter's closing summary (Ch 1–6).
  - `book.json` is the table of contents (per chapter: verses, key, sections, lessons).
  - Tools: `tools/dump.py`, then `tools/extract.py` (it refuses to write unless every letter of the PDF survives), and `tools/lessons.py`. Sources: `C:\Users\antho\Desktop\Gita\`.
  - Test: `tests/content.test.js` (about 3,000 checks), run by the A1 shim `tests/shruti.test.js`.

- **Phase 2: shell and sync (2026-10-19).**
  - `shruti.html` + `app.js` (picker, Guardian gate, hash router, header, Settings, bottom nav, mini-player, in-UI dialogs), `core.js` (profiles, safe storage, Firestore `Doc`), `orca.js` (key check, unit rows, fallback chain, streaming `chat`), `library.js` (library, chapter list with progress rings and mode badges, chapter page with Read (plain exact text, key verses marked) and Lessons), `styles.css`.
  - Profiles: head script resolves pick → `?profile=` → favourite → last → picker; a switch reloads. Locks `tony_shruti` / `veda_shruti`; Firestore starts only after `Guardian.gate`.
  - Docs `dashboards/shruti`, `shruti_veda`, `shruti_shared` (layout in README "Data"). Progress writes are lazy (≤30 s).
  - Drive worker `shruti-drive` deployed to account 2 (KV `SHRUTI_DRIVE`, `SIGN_KEY` set); CI deploys `Shruti/worker` via `deploy-workers2.yml`. Auth = a working Orca key; playback = signed links; Range passes through.
  - LifeHub tile (both profiles; `ADDED_LATER` adds it to existing lists once per device), `apphead.js` `G.shruti` (+ copies, incl. `Vault/` = A1-Priv), every wiring list, `tests/moved.js` accepts `../` script paths.
  - Tests: `shell.test.js` (54), `worker.test.js` (29), live `shell.live.js` (46, both profiles, 390/1280). `npm test` 79/79.
  - Also fixed: `tests/no-tap-box.test.js` now reads ORCA's formatted stylesheet (it failed since ORCA's UI overhaul, though the rules were there).

**Waiting on Tony (not blocking Phase 3's Read work):** the Google client for Drive. Steps are in README "Connecting Google Drive" (enable Drive API, add the redirect URI, two `wrangler secret put`, then Settings → Connect). Until then `/health` says `configured:false` and Settings says so. Also each person pastes their Orca key once in Settings.

**Next: Phase 3 — Orca TTS and Read** (see "Phases" below). Notes for it:
- ORCA first (repo `C:\Users\antho\Desktop\ORCA`, branch `accounts`, its own tests and deploy): `POST /v1/audio/speech` and `GET /v1/audio/voices`, Edge neural voices with word timings, Aura fallback. Test whether Microsoft accepts Cloudflare's addresses before building on it.
- The reader is `renderRead` in `library.js` (plain blocks; `.rd` styles). Phase 3 adds typography settings, aside styling, bookmarks and resume-to-position (`progress.<book>.ch<n>` already holds `f`; add a position). Lessons already render (`renderLessons`); polish only.
- Read-aloud plays through `Shruti.player` (`show({title, sub, onToggle})`, `progress(f)`, `hide()`), which sits above the bottom nav. Media Session, sleep timer and ±15 s go there.
- AI calls: `orca.js` `chat()` and `chain(prefs, models)`; the person's key is `me.get('orcaKey')`, units `me.get('units')`.
- "Save narration" uploads with `PUT https://shruti-drive.av1-2.workers.dev/f?book&chapter&name&owner` (Bearer = the Orca key) and plays via `POST /sign`. Record what exists in `dashboards/shruti_shared` `assets.<book>.ch<n>`; the mode badges read that.
- Live tests copy `Shruti/tests/shell.live.js` (fake Firestore, Orca and Drive answered in the mock).

**Standing rules:**
- Everything Shruti owns stays in `A1/Shruti/` (see README "Moving Shruti").
- All AI goes through Orca with each person's pasted key; never MAGI units, never logins.
- Never change Veda's side of other programs.
- The reader shows only source text, never AI-retyped text.

---

# Shruti — read / listen / watch / study program — plan

**Name and icon chosen (Tony, 2026-10-19):** `shruti.html`, app name **Shruti**, icon "Heard book" (A1 tile style; picker artifact https://claude.ai/artifact/CAKsfEechSrHDXcTVtki6C). Glyph:
`<path d="M48 40c-6-4-14-6-24-6v38c10 0 18 2 24 6 6-4 14-6 24-6V34c-10 0-18 2-24 6Z"/><path d="M48 40v38"/><path d="M41 28a10 10 0 0 1 14 0"/><path d="M35 21a19 19 0 0 1 26 0"/>`
Favicon: #1a1a1d tile, rx 22, stroke 5, #c0aeea (Veda: #A892B0). Header: `G.shruti` in apphead.js at 4.6.

## Context
Tony and Veda are reading the Bhagavad-Gita (IGS / Ramananda Prasad rendition, `Desktop\Gita\bhagavad-gita-english.pdf`) one chapter at a time, and write lesson notes after each (`Desktop\Gita\Gita 1..6 notes.pdf`, `Gita 7-18 notes.pdf`). They usually want to **listen** (a podcast) or **watch** (a video) instead of reading, and that version must tell the chapter's story **and teach every lesson**. They also want study tools (flashcards, quiz, mind map, slides) for anything they read. Shruti is a general A1 program (A1 repo, not A1-Priv) for this, starting with the Gita and taking imported books later. **All AI goes through Orca** with each person's own pasted key: no unit logins and no PC browser sessions on Shruti's side.

## Requirements
- Library → book → chapters → chapter page with **Read · Listen · Watch · Study · Lessons**.
- Read: the exact text in an elegant reader, plus read-aloud with high-quality voices, word highlighting and a speed control.
- Listen: a two-host podcast, very high quality, with many voices. It has **proper synced subtitles and a clear turn-based view of the back-and-forth** (speaker bubbles, the active turn highlighted, tap to jump).
- Watch: a narrated video covering the story and every lesson.
- **Study (from MAGI's Studio): Flashcards, Quiz, Mind Map, Slide Deck**, for any scope: a chapter, a section, a selection, several chapters or a whole book. The UI is close to MAGI's but more modern and elegant.
- **Ch 1–3 pre-built in all modes** (Listen and Watch tell the full traditional story of each chapter together with this rendition and every lesson, and say when they go beyond this book's text). All 18 chapters are parsed now. Ch 4+ is generated on demand.
- Import books (PDF / EPUB / DOCX / TXT / paste). AI finds the chapters; the text stays exact.
- **The Gita is in a Shared section both profiles see.** Personal books per profile; progress and settings per person, even on shared books.
- **Everything syncs across all devices through Firebase.** Large media goes to Tony's Google Drive through a worker; Veda's Drive or Dropbox can be added later.
- MAGI profile system, Guardian per profile, LifeHub, apphead, scrollbar, dragsort, hoverfx, tabsync, in-UI modals, ui-cap-2000, no-tap-box, single-tab handoff. Tony = MAGI/A1 purple, Veda = StudyOS purple. Desktop and mobile.

## Architecture

### Files — ONE folder (Tony, 2026-10-19)
**Everything Shruti owns lives in `A1/Shruti/`**, so the program moves by moving one folder:
- the page `Shruti/shruti.html`, served at `/A1/Shruti/shruti.html`;
- its modules, book data, media, docs (`Shruti/docs/`), tests (`Shruti/tests/`), dev tools (`Shruti/tools/`);
- its worker (`Shruti/worker/`).

Outside the folder there are only one-line registrations in shared files that list every program: wiring-test page lists, LifeHub tiles, the apphead glyph, the CLAUDE.md pointer, the `docs/README.md` index line, one `tests/shruti.test.js` shim that runs `Shruti/tests/*.test.js`, and the deploy workflow's path for `Shruti/worker`. Each is listed in `Shruti/docs/README.md` under "Moving Shruti", so a move is: move the folder, then update those lines. Shared A1 scripts are loaded relative to the page (`../Guardian/guardian.js`), so a move only changes that prefix.
- (The bullets below give paths relative to `Shruti/`. `docs/Shruti/…` means `Shruti/docs/…` and `workers2/shruti-drive` means `Shruti/worker/`.)
- `shruti.html`: the host page. Head boilerplate comes from `mylist.html` (two-profile template); shared scripts load in MyList's order; `<body data-profile>`.
- `Shruti/` ES modules:
  - `core.js`: profiles, safe storage, Firebase layer.
  - `orca.js`: the AI client.
  - `library.js`, `reader.js`.
  - `narrate.js`: TTS, word cues, read-aloud.
  - `podcast.js`: player, turn transcript, subtitles.
  - `video.js`: canvas player.
  - `study/`: `flashcards.js`, `quiz.js`, `mindmap.js`, `slides.js`, `parse.js`.
  - `generate.js`: the shared generation pipeline.
  - `import.js`, `media.js` (Drive store and offline cache), `styles.css`.
- `Shruti/books/gita/`: `book.json`, `ch01.json`–`ch18.json`, `lessons.json`, and `media/ch0{1,2,3}-*` (pre-built podcast, video and read-aloud audio plus transcripts). These are shipped in the repo, so the Gita works even when Drive is unreachable.
- Docs: `docs/Shruti/README.md` (contract and data layout) and `docs/Shruti/plan.md` (phases; §0 names the next one). Plus a CLAUDE.md pointer, the root `README.md` table row and the `docs/README.md` index.

### Profiles, lock, shell (reused)
- MAGI's profile resolution, copied from magi.html 6210–6304 (handoff → `sessionStorage` pick → `?profile=` → favourite → last → tony), with `lsKey()` giving `shruti.<p>.*`. Also MAGI's picker (`openProfilePicker` / `selectProfile`, 27814–27846) and its storage-guard shim (5644–5761) for Veda's storage-blocking Brave.
- Guardian: `Guardian.define('<p>_shruti', {owner:p, label:'Shruti', appName:'Shruti'})`, then `prepaint`, then `gate` before any network or AI use (MAGI pattern, 27737–27771). The lock button calls `Guardian.manage`; the cross-device bell is `dashboards/applock`.
- LifeHub: `<a1-lifehub>` in the header with `data-lock="guardian" data-profile-attr="data-profile"`. Add the tile to `DEFAULT_APPS` and `VEDA_APPS` plus `ICONS` in `LifeHub/lifehub.js`. Set `window.LifeHubFirebase` to share our Firestore.
- apphead mark and sync pill (`A1Head.sync`). hoverfx `magi` on Tony's side. dragsort for shelf order, chapter queue and the flashcard deck order (`hold:300`, no grip dots on Tony's side). scrollbar.js.
- Themes:
  - Tony: theme-spec §2 tokens (#1a1a1d / #232327 / #2c2c31, ac #c0aeea, Inter with Manrope headings, tabular numbers, **no gradient fills on controls**).
  - Veda: StudyOS tokens (#1B1C1E, #8D769A / #A892B0, Lora titles, Nunito body).
  - Elegance comes from typography, layered surfaces, soft shadows, blur on overlays, View Transitions, FLIP and spring motion, all respecting `prefers-reduced-motion`.

### AI: Orca (only backend) — `Shruti/orca.js`
- Base `https://orca.vedapatel05.workers.dev/v1`. Calls are OpenAI-compatible: `POST /chat/completions` with `Authorization: Bearer orca_sk_…`, streaming over SSE, and `GET /models` with `routable`. GitHub Pages is already in Orca's CORS list (`ORCA/worker/src/index.ts:29`). The client is modelled on `V1/js/modules/ai.js:729-847` (StudyOS) and `workers/personal-ai/worker.js:3541-3645`.
- **Keys:** Settings → "Orca key". Paste once per person; it is checked live with `GET /models`. It is stored in the person's Firestore doc (`dashboards/shruti[_veda]`, field `orcaKey`) so every device works at once, the same way MAGI syncs its engine token. It is mirrored locally and readable only after the Guardian unlock. Tony and Veda each use their own key, which runs on their own Orca accounts.
- **Unit picker** (MAGI-style ticks and order): DeepSeek, ChatGPT, Gemini, Perplexity and Claude, mapped to `deepseek/free`, `chatgpt/free`, `gemini_web/free`, `perplexity/free`, `claude/free` (plus `groq/gpt-oss-120b` when routable).
  - It is filled from `/models`; models that aren't routable show as offline (e.g. the PC running Orca is off).
  - A `model` is always sent explicitly. The client runs its own fallback chain over the ticked units: 404 or another non-OK status tries the next model; 401 stops with "check your key"; 503 or 429 waits out `Retry-After` once, then tries the next model.
  - Default order is DeepSeek → ChatGPT → Gemini → Perplexity → Groq → Claude. Claude is selectable but off by default, so nothing lands on it unless ticked.
- **Long input:** text over 12k characters goes as `.txt` `file` parts (Orca limits: 25 MB per part, 10 per browser chat), as StudyOS does.
- **Streaming UI:** live text while a script is written, a cancel button, and the model that answered shown on the result.
- **TTS goes through Orca too.** Add `POST /v1/audio/speech` to the Orca worker (OpenAI-shaped: `{model:"edge-neural", voice, input, speed}`), plus `GET /v1/audio/voices`. Shruti extends the request with `"timestamps": true` and gets `{audio: base64 mp3, words:[[t,d,w]]}`.
  - Backed by the Edge neural voice service called from the worker (WordBoundary timings, about 20 vetted voices: Multilingual Ava, Andrew, Emma and Brian; Jenny, Guy, Steffan, Michelle; GB Sonia, Ryan, Libby, Thomas; AU Natasha, William; IN Neerja, Prabhat; IE Emily…).
  - Fallback is Workers AI `@cf/deepgram/aura-*` (already bound as `AI`), which has no word timings, so words are spread by character length within each turn.
  - Done in the ORCA repo (branch `accounts`) with its tests and deploy, gated by the same key auth. This works with no PC on.
  - Risk: if Microsoft refuses Cloudflare's addresses, Aura becomes the default, and voice quality and subtitle precision drop to turn level. Phase 3 tests this first.

### Data and sync (Firestore `task-dashboard-d2b53`, anonymous auth plus App Check, init as in mylist.html 1331)
- `dashboards/shruti_shared` holds:
  - the shared library (the Gita and anything imported to Shared);
  - per chapter: generated assets (podcast, video, study sets, lessons) with versions, the featured version, the model used and Drive ids;
  - small study sets inline.
- `dashboards/shruti` (Tony) and `dashboards/shruti_veda` hold:
  - `orcaKey`, the personal library, and progress (read position, listen/watch timestamps, done);
  - bookmarks, flashcard known/learning state, quiz scores;
  - reader settings, voices, speed, host presets, and unit picks and order.
- Field-path merges only (`updateDoc` with `a.b.c`), a first-load write barrier (MyList pattern), and live `onSnapshot`, so another device updates on its own. Progress writes are throttled: on pause, chapter change and `visibilitychange`, and at most once every 30 s while playing.
- Large JSON (imported chapter texts, long scripts) lives as files on Drive (imports) or in the repo (Gita).

### Media storage — `workers2/shruti-drive`
- Server-side Google Drive OAuth: the refresh token lives in worker secrets, and Tony connects once with one consent click. Every device and both profiles stream through the worker, so there is no per-device Drive sign-in (Vault's per-device model is `A1-Priv/Vault/vault-cloud.js`).
- Routes:
  - `PUT /f` → `Shruti/<book>/<chapter>/`
  - `GET /f/<id>` with **Range** support, so audio can seek
  - `DELETE`, `/connect`, `/callback`, `/health`
- Provider adapters: `gdrive` now; Dropbox or Veda's own Drive later. Each file records its `store` and `owner`.
- Auth: a per-profile app token issued after unlock. The mechanism is settled in Phase 2 after reading Guardian's server-session code.
- "Download" keeps a chapter's media in Cache Storage per device for offline listening.

### Generation pipeline (`generate.js`, shared by every kind)
1. Pick the scope (chapter, section, selection, several chapters, or the book).
2. Gather the source text plus that scope's lessons.
3. Build the prompt.
4. Stream from Orca through the chain.
5. Parse.
6. Validate, auto-repairing once if needed.
7. Render audio if the kind has any.
8. Upload.
9. Save the version.

Status is synced, so the other device sees "generating…".

- **Every lesson covered:** podcast turns and video scenes must carry `[L3]` tags. The client checks that every lesson id is present; if any are missing, it asks the same model to add them. A coverage checklist appears beside the result.
- **Exact text:** the reader only ever shows parsed source text.
- **Pronunciation:** a lexicon respells words for TTS only (Arjuna, Krishna, Dharma, Gunas, Samnyasi…). Subtitles keep the true spelling, and word cues are mapped back by token index.

### Study tools (ported from MAGI's Studio)
- Port MAGI's tolerant parsers verbatim: `studioClean` 20129, `numberedBlocks` 20140, `studioParseFlashcards` 20167, `studioParseQuiz` 20181, `studioParseSlides` 20215, `studioParseMindmap` 20251. Port the prompts from `magi/engine/studio.py` (flashcards 99, quiz 116, mindmap 135, slides 152), reworded from "council verdict" to "this reading", with sizes scaled to the scope.
- Port the renderers into self-contained components (per-component state, key handler and dispose, replacing `S.studio.*`):
  - **Flashcards** (`renderFlashcards` 20502–20647): 3D flip, shuffle, got it / still learning with **known state synced per person**, a grid view, swipe and keys, plus spaced-review ordering across sessions.
  - **Quiz** (`renderQuiz` 20650–20794): locked answers, WHY feedback, a results ring, retry missed, scores synced and shown as history.
  - **Mind Map** (`renderMindMap` 20797–20866, flex plus a bezier SVG overlay): **adds** pinch and wheel zoom, pan, collapse/expand branches, fullscreen and PNG export.
  - **Slide Deck** (`slideEl` / `renderSlides` 20872–21040, container-query 16:9): stage, filmstrip, grid and Present mode. Branding becomes "Shruti". **Adds** a "Narrate deck" option that reuses Orca TTS.
- "More modern" means the same layouts in Shruti's tokens, with softer elevation, motion on flip, answer and slide transitions, larger touch targets on mobile, and a Study hub per chapter listing every set built, its scope and its progress.
- MAGI's Data Table and Report aren't included; either can be added later the same way.

### Podcast and video rendering
- **Podcast:**
  - Each turn goes through Orca TTS in its host's voice.
  - Mixed with OfflineAudioContext: natural gaps, a soft intro and outro, and an optional ducked ambient bed.
  - Encoded to MP3 with lamejs (pinned from cdnjs).
  - Uploaded as one MP3 plus `transcript.json`: `{turns:[{speaker,start,end,text,lessonIds,words}],segments:[{title,start}]}`.
  - Playback needs no AI.
- **Video:**
  - The scene script uses MAGI's labelled format, extended with `VERSE`, `STORY` and `LESSON` layouts and lesson tags, plus one narration MP3 with scene timings.
  - The canvas player is adapted from magi.html `renderVideo` / `VIDEO_PAINT` (22012–22619), in profile colours with word-level captions, and plays live on any device.
  - "Export MP4" uses MAGI's MediaRecorder path.

## Phases
Each phase ends with:
- `npm test` passing;
- live checks at 390 px and 1280 px on both profiles;
- the auto commit and push;
- a rewrite of plan §0.

**Phase 1: content.**
- pdfplumber extraction (a scratchpad tool, not shipped) of `bhagavad-gita-english.pdf` into Ch 1–18 JSON:
  - verse ranges (`2.23-24`);
  - red section headings;
  - commentary and NOTE blocks;
  - **key verses** (yellow highlight rectangles), checked against page images.
- Parse all 7 notes PDFs into `lessons.json`.
- `tests/shruti-content.test.js`: every chapter present, verse numbers monotonic, word counts per page match the extraction, and every lesson complete.

**Phase 2: shell and sync.**
- The page, profiles, Guardian, LifeHub, apphead, themes, the Firestore layer, and the Orca key settings with a live check.
- `workers2/shruti-drive`, plus Tony's one Drive consent.
- Library (Shared and personal shelves, covers), the chapter list (progress rings, mode badges), the chapter page skeleton, mobile bottom nav and a persistent mini-player.
- Add `shruti.html` to every wiring test list:
  - guardian, lifehub, apphead, hoverfx, tabsync, ui-width-cap, no-tap-box, nested-components;
  - the live scrollbar test.

**Phase 3: Orca TTS and Read.**
- Orca `/v1/audio/speech` and `/voices` (ORCA repo: tests, deploy; Edge neural voices with timestamps, Aura fallback).
- Reader:
  - typography settings and key-verse marks;
  - commentary asides;
  - the Lessons tab;
  - bookmarks;
  - resume across devices.
- Read-aloud:
  - word highlighting with follow-scroll;
  - 0.5–2.5× speed (`playbackRate` with `preservesPitch`) and a voice picker;
  - "Save narration" to Drive;
  - Media Session lock-screen controls, a sleep timer and ±15 s skips;
  - pre-rendered Ch 1–3 read-aloud.

**Phase 4: Listen.**
- The podcast player:
  - **turn bubbles** (avatar, name, colour per host) with the active turn highlighted and auto-scrolled;
  - the current word lit;
  - tap a turn or word to seek;
  - segment chips (Story, Lesson 1…n) and a subtitles overlay;
  - speed, download and the mini-player.
- The mix, encode and upload pipeline.
- **I write the Ch 1–3 podcast scripts** (full story plus every lesson: 8, 12 and 15, tagged), render them through Orca TTS and ship them.

**Phase 5: Watch.**
- The canvas video player:
  - layouts: title, verse, story, lesson, compare, steps, closing;
  - captions;
  - fullscreen and landscape on mobile;
  - MP4 export.
- **I write the Ch 1–3 video scripts**, render the narration and ship them.

**Phase 6: Generate (Ch 4+ and any book).**
- The per-chapter Generate panel:
  - kind: Podcast, Video, Lessons or Read-aloud;
  - the unit picker and chain, and length (concise, standard or deep);
  - host and voice presets, and an "extra instructions" box.
- Live streaming, coverage check and auto-repair, render and upload progress.
- Versions (feature, delete), with synced status.
- Shared books save to Shared.

**Phase 7: Study.**
- Flashcards, Quiz, Mind Map and Slide Deck, ported and upgraded as above.
- The scope picker (chapter, section, selection, several chapters, book) and the Study hub.
- Synced progress and scores.
- A Study sidebar styled like MAGI's (icon per kind with its accent, status tag).

**Phase 8: Import.**
- Upload or paste. Text is extracted client-side (pdf.js already vendored at `V1/vendor/pdfjs-6.3.289`; JSZip for EPUB and DOCX), and the original goes to Drive.
- Orca returns table-of-contents JSON (titles plus exact start anchors).
- The text is split deterministically.
- Optional cleanup is accepted only if the word-diff stays within typo-level changes.
- A review screen (merge, split, rename), then save to Shared or Mine.
- Lessons, media and study tools then work as for the Gita.

**Phase 9: polish and QA.**
- A mobile pass (iOS Safari, Android Chrome) and a performance pass (lazy modules, `content-visibility`).
- Accessibility.
- Empty and error states: no key, key rejected, models offline, Drive disconnected.
- Live tests for both profiles, the docs, a CLAUDE.md entry and memory notes.

## Verification
- `npm test`: the content validator, the wiring lists including `shruti.html`, and a parser test that runs MAGI-derived fixtures through the study parsers. ORCA: `npm test` in `worker/` for `/v1/audio/*`.
- Live tests `tests/live/shruti-*.live.js` via `cdp.js`, run one at a time:
  - profile and lock gate;
  - library to chapter navigation;
  - the reader renders Ch 2 verses 2.11–2.72 exactly;
  - read-aloud highlighting;
  - podcast turns highlight and seek;
  - the video paints scenes with captions;
  - flashcard flip and synced known state;
  - quiz scoring;
  - mind map zoom and collapse;
  - slides present mode;
  - sync across two tabs;
  - screenshots at 390 / 1280 for both profiles.
- Real end-to-end with Tony's Orca key:
  - generate Ch 4 with DeepSeek, then with ChatGPT;
  - every lesson tag covered;
  - TTS renders and uploads to Drive;
  - plays on Veda's profile on another device;
  - a quiz built from a highlighted selection.

## Manual steps for Tony (only these)
- Paste each Orca key once. He creates them on the Orca Keys page (preset "Quick lookups", models: the free ones plus Claude if wanted). I'll check Orca's existing keys first and only ask if a new one is needed.
- One Google consent click for Drive.
