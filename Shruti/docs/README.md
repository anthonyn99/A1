# Shruti

Tony and Veda's reader: read, listen to (two-host podcast), watch (narrated video) and
study (flashcards, quiz, mind map, slides) any book, one chapter at a time. It starts
with the Bhagavad-Gita in a Shared section both profiles see. All AI goes through Orca
with each person's own key. The build plan, and where it stands, is [plan.md](plan.md);
its §0 names the next phase.

## Folder layout (everything lives here)

| Path | What |
|---|---|
| `shruti.html` | the page (Phase 2) |
| `books/gita/` | the shipped Gita: `book.json` (contents), `ch00.json` (introduction), `ch01.json`–`ch18.json`, `lessons.json` |
| `tools/` | dev tools that build `books/gita` from the PDFs (not loaded by the page) |
| `tests/` | Shruti's tests, run by A1's `npm test` through `tests/shruti.test.js` |
| `docs/` | this README and the plan |
| `worker/` | the Drive media worker (Phase 2) |

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

Move the `Shruti/` folder, then update the few lines outside it that name it:
- `tests/shruti.test.js`: the path to `Shruti/tests`.
- `CLAUDE.md`: the Shruti pointer.
- `docs/README.md`: the index line.
- From Phase 2 on: the wiring-test page lists (guardian, lifehub, apphead, hoverfx, tabsync, ui-width-cap, no-tap-box, nested-components, live scrollbar), LifeHub's tile URL, the apphead glyph and the deploy workflow path for `worker/`.

Each phase that adds such a line adds it to this list.
