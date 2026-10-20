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
| `text.js` | DOM-free helpers: a block's spoken text, segments, words, lining the voice's words up with the page's |
| `styles.css` | the one stylesheet (Tony = MAGI look, Veda = StudyOS look) |
| `books/gita/` | the shipped Gita: `book.json` (contents), `ch00.json` (introduction), `ch01.json`–`ch18.json`, `lessons.json` |
| `books/gita/media/` | ready-made media: read-aloud for the introduction and all 18 chapters (Ava; `chNN-read.mp3/.json`, listed in `index.json`) the podcast for all 18 chapters (Ava and Andrew; `chNN-podcast.mp3/.json`, listed in `podcasts.json`) and the video narration for all 18 chapters (Brian; `chNN-video.mp3/.json`, listed in `videos.json`) |
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
| `dashboards/shruti` (Tony), `dashboards/shruti_veda` | `orcaKey`; `units.{order,on}`; `progress.<book>.ch<n>.{f, done, modes.<mode>, pos, ra.{i,t}, pod.t, at}` (`pos` = the block at the top of the reader, `ra` = the read-aloud segment and seconds into it, `pod.t` = seconds into the episode, `vid.t` = seconds into the video); `podcast.{speed,subs}`; `video.{speed,cc}`; `last.{book,n,at}`; `reader.{size,lead,font,width}`; `narration.{voice,speed,follow}`; `bookmarks.<book>.ch<n>.b<block>.{label,at}`; `shelf.order`; `lockV` |
| `dashboards/shruti_shared` | the shared library's assets: `assets.<book>.ch<n>.read.{voice, engine, duration, mp3:{id}, json:{id}, by, at}` (a narration saved to Drive), `assets.<book>.ch<n>.podcast.{hosts, duration, mp3:{id}, json:{id}, by, at}` (an episode made in Shruti; it wins over the shipped one); `assets.<book>.ch<n>.video.{narrator, duration, scenes, mp3:{id}, json:{id}, by, at}` (the same for a video); later `study`. A mode badge lights when its asset exists, shipped or saved |

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

- **Episodes:** every chapter ships one: two hosts (Ava, Andrew; Edge voices) tell the chapter's story with this rendition's key verses, say when they add something from the full Gita or the Mahabharata, and teach every lesson in its own part.
- **Built byte for byte:** Edge's MP3 is 24 kHz mono 48 kbps CBR (144-byte frames). Turns are joined with `tools/silence.mp3` (0.288 s, the same format, made with lamejs; embedded in `podcast.js` as `SILENCE_B64`): one clip between turns, three between parts. Nothing is decoded or re-encoded; every time is a byte count / 6000.
- **Transcript:** `{v, book, n, title, hosts, duration, segments:[{title, start}], turns:[{s, start, end, text, L, words:[[t, d, w]]}]}`, word times relative to the turn. The page shows the script's own text (punctuation kept) and lines the voice's words up with it (`text.js align`).
- **Player:** Play / Resume (from `progress…pod.t`), part chips, tap a turn or a word, subtitles (`podcast.subs`), speed (`podcast.speed`), download, the lessons list (each jumps to the first turn that teaches it), the mini-player and the lock screen (previous/next = parts). One thing plays at a time: read-aloud and the episode pause each other (`shruti:playing` event); the mini-player has one `owner`.
- **Rebuilding:** edit a script, then `magi\.venv\Scripts\python -I Shruti\tools\podcast.py <chapters>` and `node Shruti/tests/podcast.test.js`.

## Watch (the video)

- **Videos:** every chapter ships one: a single narrator (Brian, an Edge voice that is neither podcast host) tells the story with this rendition's verses on screen, flags what comes from the full Gita or the Mahabharata (`beyond`, shown as "The story · beyond this rendition"), and teaches every lesson on its own scene, in order. 5 to 9 minutes each.
- **Scripts** (`books/gita/scripts/chNN-video.json`): scenes `{layout, headline, visual, say, L, ref, beyond}`. Layouts: `title`, `verse`, `story`, `lesson`, `compare` (rows `left | right`), `steps`, `closing`. A verse scene names `ref`; `tools/video.py` copies the verse from the chapter file exactly as printed (the reader rule: no retyped source text) and puts it where `{verse}` is in `say`, dropping "(Also see …)" for the voice. A lesson scene with no headline takes the lesson's own title from `lessons.json`.
- **Built byte for byte** like the podcast (`tools/video.py`): each scene is 2 silent clips, the narration, then 3 clips (5 after a verse, so it can be read), padded to a minimum for the title and summary; one MP3 per chapter. Built file: `{v, book, n, title, narrator, duration, scenes:[{…the script…, verse, key, vs, say, start, at, end, words}]}`; `at` is when the voice begins, `words` are relative to it, `vs` are the tokens of `say` that are the verse.
- **Player:** the pictures are painted live on a 1920×1080 canvas (drawn at the stage's own size, full size for export); each frame is a pure function of the time, so pausing, scrubbing and export land on exactly what played. Word-level captions (`video.cc`) come from the narration's word timings; on a verse scene the verse itself lights word by word instead. Scrubber with scene ticks (lessons gold), previous/next scene, scene board, lessons list (each jumps to the first scene that teaches it), speed (`video.speed`), full screen (a phone turns to landscape; where it can't, the picture turns sideways), keys Space/←/→/F/C, the mini-player and the lock screen (previous/next = scenes). Progress `progress…vid.t`; finishing sets `modes.watch`.
- **Export:** MediaRecorder records the canvas and the narration (through an AudioContext made on the first export) in real time at 1×, as MP4 where the browser can (Chrome, Edge), else WebM. Browsers without it (iPhone Safari) get a note instead of the button.
- **Rebuilding:** edit a script, then `magi\.venv\Scripts\python -I Shruti	oolsideo.py <chapters>` and `node Shruti/tests/video.test.js`.

## The Drive worker (`worker/`, https://shruti-drive.av1-2.workers.dev)

Media (podcasts, videos, narrations, transcripts, imported originals) goes to Tony's Google Drive,
folder `Shruti/<book>/<chapter>/`, through this worker. The refresh token lives only in its KV
(`SHRUTI_DRIVE`); scope is `drive.file`, so it sees only the files it made.

- **Who may call it:** a working Orca key (`Authorization: Bearer orca_sk_…`), checked against
  Orca's `/v1/models` and cached for 10 minutes. Optional `ALLOWED_KEYS` (SHA-256 hex, comma
  separated) narrows it to named keys.
- **Playback:** `<audio>` cannot send a header, so `POST /sign {ids}` returns `/f/<id>?e=&s=` links
  good for 6 hours. `GET /f/<id>` passes `Range` through, so audio seeks.
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
3. Give the worker that client's id and secret (in `Shruti/worker`):
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
- ORCA's side: `npx vitest run src/tts.test.ts` in `ORCA/worker`.

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
magi\.venv\Scripts\python -I Shruti\tools\narrate.py            # introduction + Ch 1-3 in Ava
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
- If the page's depth changes, its `../` script prefixes.

Each phase that adds such a line adds it to this list.
