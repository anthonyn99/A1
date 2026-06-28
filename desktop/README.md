# TaskHub / StudyOS Desktop Shell

A thin Electron wrapper around the live web app (`https://anthonyn99.github.io/A1/`)
that adds **true OS file drag-out**. From inside this shell you can drag a file
out of a StudyOS module and drop the *actual file* into **any** app — Claude
desktop, claude.ai, Windows Explorer, Slack, Word, etc.

A plain browser/PWA can't do this (it can only offer a "virtual file" that some
apps ignore). This shell uses Electron's `webContents.startDrag()`, which hands
the OS a real file path that every app accepts.

Your uploaded files are unaffected: the shell loads the same `github.io` origin,
and IndexedDB is scoped to the origin — so everything you've already uploaded is
right there.

## Run it

```bash
cd desktop
npm install      # first time only (downloads Electron, ~200 MB)
npm start
```

The web drag-out (DownloadURL) still works in a normal browser/PWA — this shell
just upgrades it to native drag when you run the app through Electron.

## Build a standalone .exe (optional)

```bash
cd desktop
npm install
npm run dist     # outputs an installer under desktop/dist/
```

## Point at a different URL

```bash
STUDY_URL="https://your-url-here/" npm start
```
