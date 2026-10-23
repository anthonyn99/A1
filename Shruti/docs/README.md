# Shruti

Tony and Veda's reader: read, listen to (two-host podcast), watch (narrated video) and
study (flashcards, quiz, mind map, slides) any book, one chapter at a time. It starts
with the Bhagavad-Gita in a Shared section both profiles see. All AI goes through Orca
with each person's own key. The build plan, and where it stands, is [plan.md](plan.md);
its §0 names the next phase.

Live: https://anthonyn99.github.io/A1/Shruti/shruti.html

## Folder layout (everything lives here)

| Path | What |
|---|---|
| `shruti.html` | the page: head boilerplate, profile resolution, the Guardian declaration, the shell markup |
| `app.js` | the shell: picker, lock gate, router, header, Settings (Orca key, AI units, Drive), bottom nav, mini-player, in-UI dialogs |
| `core.js` | profiles, storage that never throws, the Firestore layer (`Doc`: snapshot, field-path writes, write barrier) |
| `orca.js` | the AI client: key check, unit picker rows, the fallback chain, streaming chat, speech (`speak`, `voices`) |
| `library.js` | library, book (chapter list, bookmarks) and chapter views; progress |
| `reader.js` | the Read tab: the exact text, the person's look (Aa), key-verse marks, bookmarks, "back where you were", read-aloud hooks |
| `narrate.js` | read-aloud: one narrator per page; live Orca speech or a ready-made MP3; word lighting, follow-scroll, mini-player, lock screen, sleep timer, voice/speed sheet, Save narration |
| `podcast.js` | Listen: the two-host episode player (turn bubbles, lit word, part chips, subtitles, lessons covered, speed, download, mini-player, lock screen) and `build()`/`save()`, which make an episode in the browser from a script (Phase 6 uses them) |
| `video.js` | Watch: the canvas video player (MAGI Studio's painters in Shruti's colours plus verse, story and lesson layouts; word-level captions; the verse lit as it is read; scrubber, scene board, lessons covered, speed, full screen with landscape on phones, MP4 export, mini-player, lock screen) and `save()` for videos made in Shruti (Phase 6) |
| `generate.js` | Make with AI's engine: `run()` (one unit at a time, continuation, missing-lesson repairs, then the next unit), `runStudy`, `testUnit` (Settings → Test each unit), presets, prefs |
| `formats.js` | the labelled reply formats (PART/A:/B:, SCENE n, LESSON n, each ending END), their prompts, tolerant parsers and merges; lengths (`LENGTHS`) |
| `make.js` | the Make with AI sheet, one per tab (only what that tab makes), the header's "Being made" pill and panel, Build everything |
| `jobs.js` | the background queue (an AI lane and a voice lane, kept in localStorage, resumed on load); "Play it" / "Open" when a task is done |
| `art.js` | the video's animated pictures: 49 canvas motifs picked from each scene's words, drawn beside the story text |
| `lexicon.json` | Sanskrit respellings for the voice only (Gita → Geeta, …); the page and captions keep the book's spelling |
| `media/music/` | the video music beds (`stillness.mp3`, `dawn.mp3`, made by `tools/music.js`) |
| `media/voices/` | a short preview clip per offered voice (`tools/voices.py`), played with no key |
| `ptools.js` | what Listen and Watch share under the picture: the speed pill and its speeds, the tool group, a section that folds |
| `media.js` | Drive uploads to each person's own Drive (`acct`), permanent links, versions (keep, feature, delete with their files) and the synced job status |
| `study/` | the Study tab (Phase 7): `hub.js` (the row of sets, the kind tabs, Focus, the tool pane, "Make a study set" with its scope picker), `parse.js` (MAGI Studio's tolerant parsers, verbatim, plus Shruti's JSON shape), `flashcards.js`, `quiz.js`, `mindmap.js`, `slides.js` (one self-contained tool each: own state, keys, dispose), `ui.js` (icons, swipe, keys, synced progress) |
| `import.js` | Import (Phase 8): the sheet (a file or pasted text, chapters from the file or by AI, the review screen with rename, split, merge, leave out and drag, a typo-level AI tidy-up, save to Mine or Shared) and `rename()` |
| `extract.js` | Import's page-free core: text, PDF (pdf.js text items), Word and EPUB to paragraphs; chapter detection; the AI table-of-contents ask and its check; the cut; the tidy-up's word-diff gate |
| `books.js` | imported books: `books.<id>` in the shared doc or the person's own, each chapter's text in `dashboards/<doc>/texts/<book>_<file>` (cut into `~1`, `~2` parts over 700 KB); list, get, chapter, save, rename, delete |
| `order.js` | drag to reorder, the one way: `sortable()` (A1Drag, 300 ms touch hold, no grip dots, Alt + arrows), each person's order in `order.*` |
| `pdf.js` | Save as PDF for the Lessons tab (jsPDF 2.5.1 from cdnjs, loaded on the first press) |
| `text.js` | DOM-free helpers: a block's spoken text, segments, words, lining the voice's words up with the page's |
| `styles.css` | the one stylesheet (Tony = MAGI look, Veda = StudyOS look) |
| `books/gita/` | the shipped Gita: `book.json` (contents), `ch00.json` (introduction), `ch01.json`–`ch18.json`, `lessons.json`, `lessons-more.json` (each lesson's popup detail) |
| `books/gita/media/` | ready-made media: read-aloud for the introduction and all 18 chapters (Sonia, the default read-aloud voice since 2026-10-22; before that Ava; `chNN-read.mp3/.json`, listed in `index.json`) the podcast for all 18 chapters (Sonia and Brian; `chNN-podcast.mp3/.json`, listed in `podcasts.json`) and the video narration for all 18 chapters (Sonia; `chNN-video.mp3/.json`, listed in `videos.json`) |
| `books/gita/study/`, `books/gita/study.json` | the ready-made study sets, written by Claude: `chNN.json` = `{n, title, flashcards:[{front, back, ref, L}], quiz:[{text, options:{A..D}, correct, why, L}], mindmap:{root, branches:[{text, L, children:[{text, L}]}]}, slides:[{title, bullets, L}]}` for the introduction and all 18 chapters; every lesson tagged (`L`) in the flashcards, the slides and the mind map. `study.json` lists them with their counts (`node Shruti/tools/study-index.js`) |
| `books/gita/scripts/` | the podcast and video scripts, written by Claude: `chNN-podcast.json` = `{hosts, segments:[{title, turns:[{s, t, L}]}]}`; `chNN-video.json` = `{narrator, scenes:[{layout, headline, visual, say, L, ref, beyond}]}`. Every lesson of the chapter is tagged (`L`) where it is taught and has its own part or scene |
| `worker/` | `shruti-drive`, the Google Drive media worker (deployed to account 2) |
| `tools/` | dev tools that build `books/gita` from the PDFs (not loaded by the page) |
| `tests/` | `*.test.js` run by A1's `npm test` through `tests/shruti.test.js`; `*.live.js` run by hand |
| `docs/` | this README and the plan |

Shared A1 scripts load relative to the page (`../Guardian/guardian.js`, `../LifeHub/lifehub.js`,
`../apphead.js`, `../scrollbar.js`, `../dragsort.js`, `../tabsync.js`, `../hoverfx.js`). The
wiring tests accept that `../` form (`tests/moved.js` `src()`).

## Profiles and the lock

- Who is here is decided in `<head>` before first paint: this tab's pick (`sessionStorage
  shruti.pick`), `?profile=`, this device's favourite (`shruti.favProfile`), the last person
  (`shruti.lastProfile`). None: the picker.
- Choosing the other person reloads the page, so every key, listener and lock id belongs to one
  person from the first line (MAGI's rule).
- Each person's Shruti is a Guardian lock, `tony_shruti` / `veda_shruti`, declared and painted over
  in `<head>`. `app.js` calls `Guardian.gate` first and starts Firestore only after it opens.
- A password set, changed or removed writes `lockV` into the person's doc; their other devices see
  it and ask the worker at once (`Guardian.refresh`).

## Data (Firestore `task-dashboard-d2b53`)

| Document | Holds |
|---|---|
| `dashboards/shruti` (Tony), `dashboards/shruti_veda` | `orcaKey`; `units.{order,on}`; `progress.<book>.ch<n>.{f, done, modes.<mode>, pos, ra.{i,t}, pod.t, at}` (`pos` = the block at the top of the reader, `ra` = the read-aloud segment and seconds into it, `pod.t` = seconds into the episode, `vid.t` = seconds into the video); `podcast.{speed,subs}`; `video.{speed,cc}`; `gen.{kind,length,hosts,hostA,hostB,narrator,voice,extra,studyKinds}` (Make with AI choices); `study.<book>.<set>.flashcards.{b.<card>: box 0-5, d.<card>: due ms}`, `study…quiz.{picked, i, scores:[{s,n,at}]}`, `study…mindmap.closed`, `study…slides.i` (each person's own study progress; `<set>` is `ch<n>` for a ready-made set, else the set's id, `<card>` a hash of its front); `last.{book,n,at}`; `reader.{size,lead,font,width}`; `narration.{voice,speed,follow}`; `bookmarks.<book>.ch<n>.b<block>.{label,at}`; `shelf.order` (the Shared shelf), `shelf.mine` (the Mine shelf); `order.bmk.<book>` (bookmark keys `ch<n>.b<block>`), `order.sets.<book>` (study set ids), `order.kinds.<book>.<set>`, `order.items.<book>.<set>.<kind>` (item keys: a hash of the card front, question, slide title or branch), `order.items.<book>.<set>.mmkids.<branch key>` (a branch's points), `order.ver.<book>.ch<n>.<kind>` (version ids, `orig` = the shipped one): each person's own order, never written into the shared thing; `study…mindmap.closedK` (folded branch keys); `books.<id>` for the person's own imported books (below); `lockV` |
| `dashboards/shruti_shared` | the shared library's assets: `assets.<book>.ch<n>.read.{voice, engine, duration, mp3:{id}, json:{id}, by, at}` (a narration saved to Drive), `assets.<book>.ch<n>.podcast.{hosts, duration, mp3:{id}, json:{id}, by, at}` (an episode made in Shruti; it wins over the shipped one); `assets.<book>.ch<n>.video.{narrator, duration, scenes, mp3:{id}, json:{id}, by, at}` (the same for a video); `assets.<book>.ch<n>.lessons.{lessons, summary, model}` (lessons drawn with AI, inline). Every `assets…<kind>` is the **featured version**: all versions live in `versions.<book>.ch<n>.<kind>.<id>` (same fields plus `id, by, at, model, length, asked`), and with nothing featured the shipped one plays. `jobs.<book>.ch<n>.<kind>.{by, at, stage, text, done, total, model}` says who is making what (ignored after 10 minutes). `sets.<book>.<id>.{id, kinds:{flashcards, quiz, mindmap, slides}, scope:{t, ch:[n], label}, model, by, at, length, asked}` are study sets made with AI (inline; `t` = chapter, section, selection, chapters or book; shown on every chapter in `ch`, or all for `book`). `books.<id>` = an imported Shared book: `{id, title, author, unit, chapters:[{n, title, file, words}], words, src:{name, kind, size, drive?}, how, imported, at, by}`. A personal book (one of Mine) keeps `books`, `versions`, `assets`, `jobs` and `sets` in the person's own doc instead (`media.js docFor`). A mode badge lights when its asset exists, shipped or saved |
| `dashboards/<doc>/texts/<book>_<file>` | an imported chapter's text: `{s, n, v, at}`, `s` = the chapter file's JSON (or its first part; parts `~1`… hold `{s}`), `n` = how many parts |

Writes are field-path merges (`updateDoc` with `a.b.c`); the first write of a missing document is a
`setDoc` merge. Nothing is written before the document's first snapshot arrives (the write
barrier). Reading progress is "lazy": shown at once, sent within 30 s, with the next write, or when
the page is hidden.

## Chapter file format

```json
{ "n": 2, "title": "Spiritual knowledge", "blocks": [
  { "k": "h", "t": "Duty of a warrior" },
  { "k": "h", "t": "Commentary", "minor": true },
  { "k": "p", "s": [ { "t": "The Supreme Lord said: …", "v": "2.11", "key": true },
                     { "t": "…", "v": "2.23-24", "key": false, "hl": [[0, 42]] } ] },
  { "k": "a", "style": "commentary|note|gloss|marker|closing", "t": "…" } ] }
```

- `p` blocks are the book's paragraphs, split at its verse references. `v` is the verse or range the text belongs to, and is `null` for unnumbered text such as Chapter 1's summary.
- `key` marks verses the source highlights for first-time readers.
- `hl` gives the exact highlighted character ranges when only part of a verse is highlighted.
- `a` blocks are the book's asides, never verses.

Text is exactly the source's. `tools/extract.py` only joins lines, removes line-break hyphens and normalises spaces, and it refuses to write unless every letter of the PDF survives.

`lessons.json` is `{ "<chapter>": { "lessons": [{ "id": "L1", "title", "body" }], "summary" } }`: Tony and Veda's own notes, word for word. Generated podcasts and videos must cover every lesson id.

## Read-aloud

- **Voices:** Orca's `POST /v1/audio/speech` with `timestamps: true` (ORCA repo, `worker/src/tts.ts`):
  Microsoft Edge's neural voices spoken from the Worker, word timings included; Deepgram Aura
  when Edge refuses (no timings: `text.js spreadWords` spreads the words by length). Speech is not
  counted against an Orca key's limits.
- **Segments:** one per block (headings, verses, the book's asides), long blocks cut at sentence ends
  at 1,500 characters (`text.js segmentsFor`). Live, each is one request, two fetched ahead.
- **Ready-made first:** a narration in the chosen voice (shipped in `books/<book>/media/`, or saved to
  Drive and recorded in `shruti_shared`) plays as one MP3 with no Orca call; with no key, any
  ready-made one plays. A narration file is `{v, book, n, voice, engine, duration, segs:[{b, part,
  text, start, dur, words:[[t, d, w]]}]}`, times in seconds, words relative to their segment.
- **On the page:** the reader wraps a block's words in spans when the voice reaches it and lines the
  voice's words up with them (`text.js align`), so the text stays exactly the source's. The page
  follows the voice; scrolling away stops that until "Back to the voice" or the word is in view again.
  While read-aloud is on, tapping a word reads from there.
- **Controls:** mini-player (−15 s, play/pause, +15 s, settings, close), Space, the lock screen (Media
  Session), speed 0.5–2.5× (`playbackRate`, pitch kept), voices, a sleep timer.
- **Save narration:** speaks the whole chapter in the chosen voice, uploads one MP3 and its timings
  to Drive (`read-<voice>.mp3/.json`), and records it in `shruti_shared`.

## Listen (the podcast)

- **Voices (2026-10-22, evening):** Sonia (British) and Brian (Tony: Sonia for the woman and Brian for every man; before that Emma and Brian, and before them Ava and Andrew, which sounded read-out), spoken 5% slower (`RATE` in `tools/podcast.py`), with `lexicon.json` respelling Sanskrit names for the voice only (`orca.js respell`/`unspell`, `tools/speech.py`): the words shown keep the book's spelling. Every episode is about 10 minutes (1,420 to 1,590 words); made ones aim at 7/10/13 minutes by length. Edge has no more human voice than these; a different engine (e.g. Kokoro) would be its own piece of work.
- **Episodes:** every chapter ships one: two hosts (Sonia, Brian; Edge voices) tell the chapter's story with this rendition's key verses, say when they add something from the full Gita or the Mahabharata, and teach every lesson in its own part.
- **Built byte for byte:** Edge's MP3 is 24 kHz mono 48 kbps CBR (144-byte frames). Turns are joined with `tools/silence.mp3` (0.288 s, the same format, made with lamejs; embedded in `podcast.js` as `SILENCE_B64`): one clip between turns, three between parts. Nothing is decoded or re-encoded; every time is a byte count / 6000.
- **Transcript:** `{v, book, n, title, hosts, duration, segments:[{title, start}], turns:[{s, start, end, text, L, words:[[t, d, w]]}]}`, word times relative to the turn. The page shows the script's own text (punctuation kept) and lines the voice's words up with it (`text.js align`).
- **Player (one card, 2026-10-22):** who and what, a bar with the parts marked (tap or drag to a place; ← → step 5 s), −15 / Play / +15, a speed pill that opens the speeds only when pressed (`ptools.js`, `podcast.speed`), and one group of tools: Subtitles (`podcast.subs`) and Download. Then part chips, tap a turn or a word, the lessons list folded away (each jumps to the first turn that teaches it; open or closed is remembered per person on the device, `fold.podLessons`), the mini-player and the lock screen (previous/next = parts). One thing plays at a time: read-aloud and the episode pause each other (`shruti:playing` event); the mini-player has one `owner`.
- **Rebuilding:** edit a script, then `magi\.venv\Scripts\python -I Shruti\tools\podcast.py <chapters>` and `node Shruti/tests/podcast.test.js`.

## Watch (the video)

- **Pictures and music (2026-10-22):** story, title and closing scenes draw animated motifs from `art.js` (chosen from the scene's words: chariot, conch, lotus, lamp, battlefield, …) beside the text, not slides of bullet points. A soft music bed plays under every video (`media/music/stillness.mp3` or `dawn.mp3` by chapter, ducked while the voice speaks, in exports too; the ♪ button turns it off, `video.music`). The beds are synthesised (tanpura, pad, bansuri in Bhupali) by `node Shruti/tools/music.js` with lamejs 1.2.1.
- **Videos:** every chapter ships one: a single narrator (Sonia, `en-GB-SoniaNeural`, the default for made videos too) tells the story with this rendition's verses on screen, flags what comes from the full Gita or the Mahabharata (`beyond`, shown as "The story · beyond this rendition"), and teaches every lesson on its own scene, in order. 5 to 9 minutes each.
- **Scripts** (`books/gita/scripts/chNN-video.json`): scenes `{layout, headline, visual, say, L, ref, beyond}`. Layouts: `title`, `verse`, `story`, `lesson`, `compare` (rows `left | right`), `steps`, `closing`. A verse scene names `ref`; `tools/video.py` copies the verse from the chapter file exactly as printed (the reader rule: no retyped source text) and puts it where `{verse}` is in `say`, dropping "(Also see …)" for the voice. A lesson scene with no headline takes the lesson's own title from `lessons.json`.
- **Built byte for byte** like the podcast (`tools/video.py`): each scene is 2 silent clips, the narration, then 3 clips (5 after a verse, so it can be read), padded to a minimum for the title and summary; one MP3 per chapter. Built file: `{v, book, n, title, narrator, duration, scenes:[{…the script…, verse, key, vs, say, start, at, end, words}]}`; `at` is when the voice begins, `words` are relative to it, `vs` are the tokens of `say` that are the verse.
- **Player:** the pictures are painted live on a 1920×1080 canvas (drawn at the stage's own size, full size for export); each frame is a pure function of the time, so pausing, scrubbing and export land on exactly what played. Word-level captions (`video.cc`) come from the narration's word timings; on a verse scene the verse itself lights word by word instead. Scrubber with scene ticks (lessons gold), previous/next scene, scene board, the lessons list folded away (each jumps to the first scene that teaches it; `fold.vidLessons`), under the picture the speed pill (`video.speed`, speeds open only from it) and one group of tools (Music, Captions, Export, Full screen; labels from tablet width up), full screen (a phone turns to landscape; where it can't, the picture turns sideways), keys Space/←/→/F/C, the mini-player and the lock screen (previous/next = scenes). Progress `progress…vid.t`; finishing sets `modes.watch`.
- **Export:** MediaRecorder records the canvas and the narration (through an AudioContext made on the first export) in real time at 1×, as MP4 where the browser can (Chrome, Edge), else WebM. Browsers without it (iPhone Safari) get a note instead of the button.
- **Rebuilding:** edit a script, then `magi\.venv\Scripts\python -I Shruti\tools\video.py <chapters>` and `node Shruti/tests/video.test.js`.

## Make with AI (`generate.js`, `media.js`)

Every chapter page has **Make with AI** (and an empty Listen, Watch or Lessons tab has **Make it now**). It makes a podcast, a video, lessons or a read-aloud through Orca with the person's own key, for imported books, other voices and lengths, or a re-make.

**Since the refinements (2026-10-22)** the bullets below are history where they disagree with this:
- The sheet (`make.js`) shows only what the current tab makes (Listen → podcast, Watch → video, Lessons → lessons, Read → read-aloud, Study → a study set). Switching versions updates the tab at once.
- Work runs in the background (`jobs.js`): the sheet can close, the header pill shows a ring and "Being made", and the made thing has **Play it**/**Open**, which plays the new version.
- Replies are labelled text, not JSON (`formats.js`, MAGI's rule): `PART`/`A:`/`B:`, `SCENE n` with `LAYOUT`/`HEADLINE`/`VISUAL`/`ART`/`VERSE`/`NARRATION`, `LESSON n`/`TITLE`/`BODY`, ending `END`. A cut-off reply is continued, missing lessons are asked for on their own (twice at most), and a unit that still fails hands over to the next one. That is the fix for Perplexity and Gemini, which mangle JSON (proven on unit-style replies in `generate.test.js`; Test each unit checks the live ones). Every lesson is always made; length sets only how much each says.
- **Build everything** (book page): a popup to choose kinds, voices and a unit per kind or one for all, then everything queues in the background with progress; what is already made is skipped, lessons only where a chapter has none.
- **Settings → Test each unit** runs a tiny podcast, video, lessons and study ask on every ticked unit and says which pass.

- **The sheet:** the kind; its versions (the shipped one, "Comes with Shruti" / "Your own notes", and every one made, with unit, voices, length, who and when; tick one to play it everywhere, or delete it with its Drive files); the units in the person's order (same ticks as Settings; offline ones struck through); length (concise, standard, deep: about 30/55/85 podcast turns, 12/20/28 video scenes, 6/9/12 lessons); host pairs (redone 2026-10-22, the default Sonia & Brian, the rest each a woman and a man of one accent: Sonia & Brian (the default, as the shipped episodes), Sonia & Ryan, Emma & Brian, Ava & Andrew, Jenny & Guy, Libby & Thomas, Natasha & William, Neerja & Prabhat, Emily & Connor; kept by id in `gen.hosts`, older choices by place in the old list of four still read, `generate.js presetId`) or any two voices, every one of them heard before choosing (see "Hearing a voice"), the video narrator, the read-aloud voice; and an optional extra ask. Choices are kept per person (`gen.*`).
- **The run:** the chapter's exact text (headings, `[verse]` numbers, asides) and its lessons go into the prompt; over 12,000 characters they go as attached `.txt` files (StudyOS's way). The reply streams into the sheet with the unit that answered. It is read as JSON however it arrives (fences, chatter, trailing commas), normalised (`normPodcast`, `normVideo`, `normLessons`) and checked: if a lesson is missing or the JSON is unusable, the same unit gets its own reply back and is asked once to fix it. The checklist shows each lesson id. Then it is spoken (`podcast.js build()`, `video.js build()`, which follow `tools/podcast.py` and `tools/video.py` byte for byte; verses come from the book, never the model) and uploaded to Drive as a new version that plays at once, for both profiles on a shared book. Lessons need no Drive (they are kept inline). Without Drive a podcast or video still plays on the device that made it until the page reloads; a read-aloud needs Drive.
- **Lessons:** a featured AI set replaces the notes on the Lessons tab (saying which unit drew it) and is what new podcasts and videos must teach; tick "Your own notes" to go back. Made lessons are concise (Tony, 2026-10-20): a title of at most 12 words and a body of one or two sentences, at most 40 words, true to the chapter; a reply over that (with a little slack, `longLessons`) goes back to the same unit once to be shortened. The Lessons tab has **Save as PDF** (`pdf.js`) for the notes and for any AI set.
- **A unit that fails mid-stream** (Orca's error frame, or a 200 that ends empty) counts as failed and the chain moves to the next unit (`orca.js chat`).
- **One at a time:** a device makes one thing at a time; while it runs, `jobs…` shows the other devices "Tony is making this: speaking 12 of 40…" and holds their Make button for that kind.

## Hearing a voice (2026-10-22)

Every voice Shruti offers has a short clip in `media/voices/<voice id>.mp3` ("Hello, I'm Sonia. Welcome to Shruti…"), made by `magi\.venv\Scripts\python -I Shruti\tools\voices.py` from `orca.js VOICES` through the lexicon, so a preview needs no key and no Orca call; a voice without a clip is asked of Orca live. `narrate.js preview(ids, button)` plays one voice or a pair in turn (a podcast pair: each host introduces themselves), lights the button with a square to stop, stops when pressed again, when another preview starts, when anything else plays (`shruti:playing`) or when the sheet closes (`stopPreview`). Every place a voice is chosen has it: the read-aloud sheet, Make with AI's narrator and read-aloud lists, its host pairs and "any two voices" lists, Build everything's voice and host chips (`tryChip`), and Slides' Narrate picker. Add a voice to `VOICES`, then run `tools/voices.py`.

## When the AI cannot run (`orca.js`, Phase 9)

Make with AI, Make a study set and Import's AI steps all say the same thing in the same box (`generate.js problemHTML`), in plain words, with **Open Settings** when the fix is there. Nothing is sent to Orca when it cannot work.

- **What Orca says the key may use** is asked once per key per page and shared by Settings and every maker (`O.models(key)`, `O.cachedModels(key)`, 5 minutes; `O.forget()` when the key is removed, replaced or refused).
- **A unit's state** (`O.STATUS`): ready, offline (Orca has it but cannot reach it now), **not allowed on this key** (`in_key_scope: false`: the key is limited on Orca's Keys page), not on Orca. The chain (`O.chain`) tries ready units first, then offline ones (one may be back), never a unit the key may not use.
- **Before a run** (`O.preflight`, shown as soon as a maker opens): no key; a key Orca refused (401/403); no unit ticked; no ticked unit this key may use (names them).
- **After a run fails** (`O.explain`): the key refused mid-run; Orca unreachable; every unit down, each named with why ("DeepSeek busy, ChatGPT offline"), with Try again.
- **Drive not connected:** Make with AI → Read-aloud says so with Open Settings; the read-aloud sheet's Save narration is off and says why. Podcasts and videos made without Drive still play on that device until reload.
- **Read-aloud** with no key or a refused key opens one dialog that leads to Settings.

## Study (`study/`)

- **The tab (one concise row since 2026-10-22):** on the left the chosen set's kinds as a compact segmented control, each with an icon in the kind's accent and a short tag that follows you as you study (a count like "16" for a fresh kind, its word kept for screen readers; "3 due", "1 of 16 known", "Best 8/9", "Slide 3 of 8"; on a phone the kinds take the whole row, icon over name, tags hidden). On the right: the sets as small pills (the ready-made one, then every AI set covering this chapter, newest first; who and when in the pill's title; AI sets have a delete ×; the pills scroll sideways and drag), ✦ Make a study set, and Focus. The tool is below. **Focus** (beside the tabs) hides every header (the app bar, the chapter header, the mode tabs, the sets and the tabs) so only the tool and its own bar show, with the tool given the room (taller cards, a taller map); Esc, the button again or leaving Study brings them back. The introduction has Read and Study.
- **Flashcards:** a 3D flip card (Space), Still learning / Got it (1 / 2), swipe and ← →, shuffle, a grid of every card. The card's mark shows lit on its button; pressed again it is taken back and the card is new again (2026-10-22); the bar's ↺ clears every mark in the set. Spaced review: Got it moves a card up a Leitner box and away for 1, 3, 7, 16, then 35 days; Still learning puts it back in box 0. "Review N" goes through what is due or still being learned, due first.
- **Quiz:** one question at a time (1–4 or A–D, Enter), the answer locks and WHY shows, segment bar, results ring, every finished attempt logged (last 20) with a little history and the best score, retry the missed ones. The attempt in progress is synced, so it carries on on another device.
- **Mind map:** MAGI's tree with curved links (its nodes opt out of `hoverfx.js`: a hover filter on a node inside the scaled canvas re-drew its text and made it flash, 2026-10-22), a colour per branch; drag to pan, pinch or ctrl/trackpad scroll to zoom, + − 0, fit, tap a branch to fold it (synced), full screen (F), Save as a picture (PNG, drawn from the laid-out map), copy the outline. On a phone it starts readable with the root at the left.
- **Slides:** MAGI's 16:9 slide in container units (one layout for the stage, thumbnails and the projector), branded Shruti; filmstrip, grid (G), Present (P, real full screen where there is one; click left third to go back), ← →, and **Narrate deck** (N): each slide read aloud through Orca's speech in the person's read-aloud voice and speed, moving on by itself (the next slide's voice is fetched while one plays). It pauses the other players and they pause it.
- **Make a study set** (the sidebar, an empty Study tab, or Make with AI → Study set): from this chapter, a section (its headings, with the verse span), what you selected in Read (8 words or more, until reload), several chapters, or the whole book; any of the four kinds; length; an extra ask. One Orca call per kind with MAGI Studio's prompts reworded for "this reading" (sizes: concise 6–10 cards, 5 questions, 3–5 branches, 5–7 slides; standard 10–16, 8, 4–6, 8–10; deep 16–24, 12, 5–7, 10–14), the readers' lessons named for a whole chapter, and a reply nothing can be read from sent back once. Saved inline as `sets.<book>.<id>`, for both of you on a shared book.

## The Drive worker (`worker/`, https://shruti-drive.av1-2.workers.dev)

Media (podcasts, videos, narrations, transcripts, imported originals) goes to Google Drive,
folder `Shruti/<book>/<chapter>/`, through this worker. **Two Drives (2026-10-22):** Veda's own
things go to her Drive (`acct=veda`, KV key `google:veda`), Tony's and everything shared to his
(`acct=tony`, KV key `google`); `media.js acctFor(book)` decides. Each person connects theirs in
Settings → Google Drive. Uploads return a **permanent** signed link (`e=0`), stored with the file,
so a shared book plays the same on both sides without signing again; older records are upgraded
once on load (`M.upgradeLinks`). Scope is `drive.file`, so it sees only the files it made.

- **Who may call it:** a working Orca key (`Authorization: Bearer orca_sk_…`), checked against
  Orca's `/v1/models` and cached for 10 minutes. Optional `ALLOWED_KEYS` (SHA-256 hex, comma
  separated) narrows it to named keys.
- **Playback:** `<audio>` cannot send a header, so `POST /sign {ids, acct, permanent}` returns
  `/f/<id>?a=&e=&s=` links (6 hours, or permanent with `e=0`). `GET /f/<id>` passes `Range` through, so audio seeks.
  `/health` lists both accounts (`accounts.tony`, `accounts.veda`).
- **Routes:** `GET /health`, `POST /connect`, `GET /callback`, `POST /disconnect`,
  `PUT /f?book&chapter&name&owner`, `POST /sign`, `GET|HEAD|DELETE /f/<id>`.
- **Deploy:** pushes to `Shruti/worker/**` deploy it through `.github/workflows/deploy-workers2.yml`.
  By hand: `CLOUDFLARE_ACCOUNT_ID=<account 2 id> npx wrangler deploy` (with the KV id filled in).
- **Secrets:** `SIGN_KEY` is set. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are Tony's to add.

### Connecting Google Drive (Tony, once)

In Google Cloud Console, project `task-dashboard-d2b53` (the one OneInbox uses):
1. APIs & Services → Library → enable **Google Drive API**.
2. Credentials → the OAuth 2.0 **Web application** client (OneInbox's, or a new one) → add the
   authorized redirect URI `https://shruti-drive.av1-2.workers.dev/callback`.
3. Give the worker that client's id and secret: `powershell -ExecutionPolicy Bypass -File Shruti\tools\connect-drive.ps1` asks for both and stores them. By hand (in `Shruti/worker`):
   `CLOUDFLARE_ACCOUNT_ID=dbde452fc0d60264a7e9339460b7188c npx wrangler secret put GOOGLE_CLIENT_ID`
   and the same for `GOOGLE_CLIENT_SECRET`.
4. In Shruti: Settings → Google Drive → **Connect Google Drive**, and allow it.

`curl https://shruti-drive.av1-2.workers.dev/health` then says `configured` and `connected`.

## Tests

- `node Shruti/tests/content.test.js`: the Gita's text and lessons (Phase 1).
- `node Shruti/tests/shell.test.js`: profiles, lock order, the sync layer, the Orca client.
- `node Shruti/tests/worker.test.js`: the Drive worker offline (fake Orca, Google and KV).
- `node Shruti/tests/reader.test.js`: every module parses, the text helpers, the shipped narrations
  (every block, times that add up to the MP3, words that line up with the text), the speech client.
- `CDP_ALLOW_FONTS=1 node Shruti/tests/shell.live.js`: headless Edge, both profiles, 390 and 1280
  px, fake Firestore; screenshots in `%TEMP%\magi-live-shots\shruti-*.png`. Never run two live
  tests at once.
- `node Shruti/tests/reader.live.js`: the reader and read-aloud (Aa, partial highlights, bookmarks,
  resume, the shipped narration playing and lighting words, seek, speed, sleep, live Orca speech,
  Save narration), Tony at 1280 and Veda at 390. Clicks that start audio are real mouse events.
- `node Shruti/tests/podcast.test.js`: the silent clip's format, every script (two hosts, every lesson tagged and given a part), every episode (matches its script, times from bytes, word timings), `build()` with a fake voice.
- `node Shruti/tests/podcast.live.js`: the Listen tab (turns, parts, lessons, play, lit turn and word, part chips, tap a word, subtitles, speed, read-aloud and the episode pausing each other, `build()`/`save()`), Tony at 1280 and Veda at 390.
- `node Shruti/tests/video.test.js`: every video script (one narrator, layouts, every lesson on its own scene in order, verses that exist, text that fits) and every built video (matches its script, verses exactly the book's, times from bytes, whole Edge frames, words line up, captions cover every word), and the timing helpers.
- `node Shruti/tests/video.live.js`: the Watch tab (cover, play, scene board, lesson jumps, the verse lit as read, every layout drawn and saved as `shruti-frame-*.png`, speed, captions, the video and the podcast pausing each other, `vid.t`, full screen, export start and cancel), Tony at 1280 and Veda at 390.
- `node Shruti/tests/generate.test.js`: the prompt (exact text, every lesson, file parts when long), reading replies, a full run with a fake unit (write, check, repair with the same unit, speak, local), `video.js fill()` giving exactly the shipped scenes for all 18 chapters, `build()` timing, and versions (record, feature, original, delete with files, jobs, personal books).
- `node Shruti/tests/generate.live.js`: the sheet, a podcast made without Drive (streaming, repair, Emma and Brian, plays), a video made with Drive (uploaded, a version, played from Drive), featuring the original, deleting, lessons drawn and undone, and Veda at 390 seeing Tony's job.
- `node Shruti/tests/study.test.js`: every study module parses; MAGI's parsers on MAGI-style replies (bold labels, lost newlines, a draft then the answer); Leitner boxes, the review order, quiz scores; every ready-made set (sizes, four options and a WHY per question, answers spread over A–D, verse refs that exist, every lesson covered by the flashcards, the slides and the mind map, concise text, `study.json`); the study prompts and a run that asks once more.
- `node Shruti/tests/study.live.js`: the Study tab for real: badges, the sets row and the kind tabs with their tags, flashcards (flip, got it, still learning, synced boxes, review, grid), the quiz (keys, lock, WHY, results, the logged score, best in the sidebar), the mind map (fit, zoom, pan, fold synced), slides (keys, Present, Narrate deck through Orca speech), a section set made with a fake unit and saved, a selection from Read, the introduction, Veda's progress kept apart, Tony's following him; 390 and 1280, both profiles.
- `node Shruti/tests/import.test.js`: text, PDF, Word and EPUB to paragraphs; chapter detection; the AI's chapters checked (kept, moved, dropped); the cut keeps every word; the tidy-up's typo gate; books in a fake Firestore (parts, Mine and Shared, read back, rename, delete); each person's order.
- `node Shruti/tests/import.live.js`: Import for real (a text paste, a Word file and an EPUB built in the page with JSZip, a PDF made with jsPDF, AI chapters through a fake Orca, split, merge, leave out, drag, save to Mine and Shared, read it, Make with AI on it, rename, delete) and drag to reorder on every list, by mouse, by a held finger and by Alt + arrows; Tony at 1280, Veda at 390.
- `node Shruti/tests/lessons-pdf.live.js`: Save as PDF on the Lessons tab (the notes and an AI set, both profiles; every lesson title in the file, diacritics kept readable). The page loads jsPDF from cdnjs itself: serving it through the test's network mock crashed headless Edge's renderer (2026-10-20).
- `node Shruti/tests/qa.live.js` (Phase 9): every empty and error state above (no key, a refused key, a key limited to other units, every unit down, Drive not connected), Import's code loading only when Import opens, and an **accessibility audit** of every view and sheet for both profiles at 390 and 1280: every control named, text at WCAG AA contrast (4.5:1, 3:1 when large), controls at least 24 px (WCAG 2.2; inline verse numbers and a checkbox inside a bigger label excepted), the keyboard focus ring, unique ids, no sideways scroll. Also times the reader (chapter 2 paints in about 120 ms, so the reader needs no `content-visibility`, which would also clip the bookmark ribbon and the read-aloud glow).
- `node Shruti/tests/refine2.test.js` (2026-10-22): every lesson's popup detail (concise, verses that exist), a preview clip for every voice, host pairs by id (old choices still read), the player pieces.
- `node Shruti/tests/refine2.live.js` (2026-10-22, 198 checks): the Lessons popup (open, arrows, → and a swipe, dots, Esc, the verse and Read it in the chapter), dropping text on each shelf, the small Import tile, the picker title, Listen's card (speed pill, ±15, the bar), Watch's tools and folded lessons (remembered), Study's rows and Focus, a flashcard mark taken back, no hover filter on mind map nodes, voice previews (pair plays, stops, does not pick), no sideways scroll, no page errors; both profiles at 1280 and 390.
- ORCA's side: `npx vitest run src/tts.test.ts` in `ORCA/worker`.

## The Lessons tab (2026-10-22)

Each lesson is a card that opens a popup (`library.js openLesson`; like Veda's TaskHub lessons, a bit further): the lesson as the notes have it, **What it means**, **In real life** (an example from ordinary life), **Try this** (one thing to do) and **In the book**: the verse it stands on, in this rendition's exact words, with **Read it in the chapter** (opens Read at that block). Arrows at the foot name the previous and next lesson; ← →, a sideways swipe and the dots move too; Esc or the backdrop closes. On a phone it is a full sheet. The detail lives in `books/gita/lessons-more.json` (`{"<chapter>": {"L1": {verses, meaning, example, practice}}}`, written by Claude for all 141 lessons; the notes in `lessons.json` stay word for word). An AI-made set has no detail, so its popup shows the lesson and the arrows only. `tests/refine2.test.js` checks every lesson has its detail, concise, and every verse exists.

## Drop to import (2026-10-22)

Text (or a file) dragged anywhere on the library imports it: the shelf nearer the pointer lights ("Drop to import to Shared / Mine": above the line between the two shelves is Shared, below is Mine) and the Import sheet opens straight at its review with that shelf chosen (`library.js dropImport`, `import.js open({file, text})`). The Import tile at the end of each shelf is a small card, much smaller than a book, saying only "Import a book"; what it takes is said in the sheet it opens.

## Import (`import.js`, `extract.js`, `books.js`)

Library → **Import a book** (on the Mine shelf). A PDF, EPUB, Word (.docx), text or markdown file, or pasted text.

- **Reading, in the browser:** PDF through A1's vendored pdf.js (`../V1/vendor/pdfjs-6.3.289/`): text items become lines and paragraphs (gaps, indents, a sentence carried over a page), bigger type is a heading, running heads and feet that repeat on a third of the pages and bare page numbers are left out, words broken over a line are put back. EPUB and Word through JSZip 3.10.1 (cdnjs, loaded on first use): EPUB in spine order with its nav or NCX contents; Word with its Heading and Title styles, tracked deletions left out. Text: blank lines split paragraphs; `#` lines and lines like "Chapter 2" or all capitals are headings. A scanned PDF (no text) says so.
- **Chapters:** first from the file itself: its contents (EPUB nav/NCX, PDF outline), else a printed contents page (dot-leader entries "1. Title ........ 3"; numbered entries are the chapters, each found where its title starts a paragraph, with a "CHAPTER N" line before it), else the heading level that repeats (contents lines never count) (a Word "Title" never counts), else "Chapter N" lines. **Find chapters with AI** sends Orca each paragraph's number and first 160 characters (a very long book: headings, short lines and every 20th) and asks for `{title, author, chapters:[{title, start, anchor}]}`; every start is checked against the text (`checkToc`): kept where its anchor begins, moved to where it really does, or dropped. The text is then cut there, deterministically; pages before the first chapter become "Opening pages" so no word is lost.
- **Tidy the text with AI** (optional): each part under 40,000 characters goes to Orca paragraph by paragraph; a changed paragraph is taken only if every change is a word or two fixed (a split, joined or misread word, a broken hyphen) and there are at most max(2, 3 %) of them (`tidyCheck`, a Myers word diff). Anything else is refused and counted.
- **Review:** title and author; every part with its words and first words; rename, split (at any paragraph), merge with the next, leave out (title pages, contents, an index), drag into order. Then **Mine** or **Shared**, and whether the parts are Chapters, Parts or Sections.
- **Saving:** each chapter becomes a chapter file (README "Chapter file format": headings `k:'h'`, paragraphs `k:'p'` with `v:null`; its own title line dropped) in `texts/`, then the book in `books.<id>`. The original goes to Drive too when Drive is connected (`Shruti/<book>/source/`). Read, read-aloud (live voices), Make with AI and Study then work on it like the Gita; it has no shipped media or study sets.
- **A book's page:** Rename, Delete (its texts and everything made from it; each person's progress stays).

## Drag to reorder (`order.js`)

Every list that has an order drags, on both profiles: the Shared and Mine shelves, bookmarks on a book's page, the study sets in the Study sidebar and the kinds inside a set, flashcards (the grid of all cards; the deck then follows it, shuffle and review still on top), quiz questions ("All questions" list), slides (the filmstrip, sideways, and the grid), the mind map's branches and the points under each ("Arrange"), versions in Make with AI, the AI units in Settings, and the parts on Import's review screen. A mouse takes a row by any part that is not a control, a finger after a 300 ms hold, the keyboard with Alt + an arrow on a focused row. No grip dots (Tony's rule). An order is the person's own (`order.*` in their doc), so Tony's never moves Veda's and a shared or ready-made set is never rewritten; a quiz's answers are kept by each question's place in the set, so they survive a reorder.

## Rebuilding the Gita

```
cd Shruti/tools
python dump.py %TEMP%\gita-lines.json        # needs: pip install pymupdf
python extract.py %TEMP%\gita-lines.json ../books/gita
python lessons.py "C:/Users/antho/Desktop/Gita" ../books/gita/lessons.json
node ../tests/content.test.js
```

The sources are in `C:\Users\antho\Desktop\Gita\` (the IGS PDF and the notes PDFs).

The ready-made narrations (need edge-tts 7.3.1 or newer, which MAGI's venv has):

```
magi\.venv\Scripts\python -I Shruti\tools\narrate.py            # introduction + Ch 1-3 in Sonia (pass all 19 numbers for every chapter)
magi\.venv\Scripts\python -I Shruti\tools\narrate.py 4 5 --voice en-GB-RyanNeural
node Shruti/tests/reader.test.js
```

## Moving Shruti

Move the `Shruti/` folder, then update the lines outside it that name it:
- `tests/shruti.test.js`: the path to `Shruti/tests`.
- `CLAUDE.md`: the Shruti pointer. `docs/README.md`: the index line. Root `README.md`: the Folders row.
- The wiring-test page lists: `tests/syntax-check.js` (`FILES`, `WORKER_DIRS`),
  `guardian-wiring`, `lifehub-wiring` (`HOSTS`, `PAGES`), `apphead-wiring`, `hoverfx-wiring`,
  `tabsync-wiring`, `ui-width-cap` (`PAGES`, `SHEETS`), `no-tap-box`, `nested-components`,
  `worker-url-wiring` (`CLIENT`, `ACCT2`).
- `LifeHub/lifehub.js`: the Shruti tile's URL in `DEFAULT_APPS` and `VEDA_APPS`.
- `apphead.js` `G.shruti` (and its copies) only if the glyph changes.
- `.github/workflows/deploy-workers2.yml`: the `Shruti/worker` path (push paths and `find`), and
  `docs/workers2/README.md`'s table.
- If the page's depth changes, its `../` script prefixes, and `import.js` `PDFJS` (`../V1/vendor/pdfjs-6.3.289/`, A1's vendored pdf.js, used by Import; copy it into `Shruti/vendor/` if Shruti leaves A1).

Each phase that adds such a line adds it to this list.
