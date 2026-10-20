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
| `orca.js` | the AI client: key check, unit picker rows, the fallback chain, streaming chat |
| `library.js` | library, book (chapter list) and chapter views; progress |
| `styles.css` | the one stylesheet (Tony = MAGI look, Veda = StudyOS look) |
| `books/gita/` | the shipped Gita: `book.json` (contents), `ch00.json` (introduction), `ch01.json`–`ch18.json`, `lessons.json` |
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
| `dashboards/shruti` (Tony), `dashboards/shruti_veda` | `orcaKey`; `units.{order,on}`; `progress.<book>.ch<n>.{f, done, modes.<mode>, at}`; `last.{book,n,at}`; `shelf.order`; `lockV` |
| `dashboards/shruti_shared` | the shared library's generated assets, from Phase 4: `assets.<book>.ch<n>.{podcast, video, study}` (a mode badge lights when its asset exists) |

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
- `CDP_ALLOW_FONTS=1 node Shruti/tests/shell.live.js`: headless Edge, both profiles, 390 and 1280
  px, fake Firestore; screenshots in `%TEMP%\magi-live-shots\shruti-*.png`. Never run two live
  tests at once.

## Rebuilding the Gita

```
cd Shruti/tools
python dump.py %TEMP%\gita-lines.json        # needs: pip install pymupdf
python extract.py %TEMP%\gita-lines.json ../books/gita
python lessons.py "C:/Users/antho/Desktop/Gita" ../books/gita/lessons.json
node ../tests/content.test.js
```

The sources are in `C:\Users\antho\Desktop\Gita\` (the IGS PDF and the notes PDFs).

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
