# StudyOS desktop shell

A thin Tauri window around the built StudyOS web app, existing for **one**
reason: dragging a class resource straight into another application.

## Why the browser could not do this

Dragging a file out of a web page into *another web page* is impossible, and
that is not a bug in StudyOS:

* `dataTransfer.items.add(new File(...))` — a `File` constructed in script is
  never serialised across browsing contexts. The target page sees an item of
  kind `file` (so its dropzone **highlights**, which is what made this look like
  it should work) and then reads an empty `dataTransfer.files` on drop.
* `setData('DownloadURL', ...)` — a Chrome hook for the **OS shell only**.
  Explorer and the desktop honour it; a web page cannot read it at all.

So dragging a PDF onto Gemini or NotebookLM highlighted their upload box and
delivered nothing, no matter how many times it was retried. Nothing in the page
can fix that. A native window can: it starts a real OS drag carrying a real
path, which every app accepts because it is indistinguishable from a drag out
of Explorer.

## How it works

1. `dragcache.rs` exposes `stage_drag_file`. StudyOS resources live in
   IndexedDB, never on disk, but a native drag must name a path that already
   exists the instant the drag starts — the OS reads the file, we cannot stream
   it. So the webview hands over the bytes and the shell writes them to
   `%LOCALAPPDATA%\StudyOS\dragcache\<id>\<name>`.
2. Staging runs on **hover**, so by the time the pointer moves the file is
   already there and the drag starts without a stall.
3. `studyos.js` starts the drag from a *pointer* gesture, not `dragstart`:
   `startDrag` takes over the pointer, so an HTML5 drag must never have begun.
   In the shell `item.draggable` is therefore `false`.
4. The cache is purged at every launch. A staged file from an earlier session
   can have no live drag holding it.

`tauri.conf.json` sets `"dragDropEnabled": false` — Tauri's own drag-drop
handler otherwise intercepts webview drag events and the drag never starts.

## Security

`stage_drag_file` writes a **caller-supplied name** to disk, and that name rides
along with a file record that syncs from the cloud, so it is treated as hostile
input. `sanitize_name` keeps only the final path component, strips reserved and
control characters, rejects dot-only names and Windows device names (`CON`,
`NUL`, `COM1`…), and bounds the length. `sanitize_id` does the same for the
directory. A staged path is then re-checked to confirm it landed inside the
cache directory. The unit tests in `dragcache.rs` pin all of this — they live
in-crate because an integration-test binary links the whole WebView2 stack and
cannot start under the harness.

The webview is granted `core:default` plus `drag:default` and **no filesystem
permission**; all writing goes through the one typed command above.

## Running it

    npm run studyos:dev       # build the frontend + run the shell
    npm run studyos:test      # path-safety tests
    npm run studyos:bundle    # NSIS installer (needs `cargo install tauri-cli`)

The shell loads `V1/dist/studyos/`, so `npm run build` runs first automatically.

## The browser build is unaffected

Every native path is behind `SOS_NATIVE_DRAG`, which is
`!!(window.__TAURI__ && window.__TAURI__.drag)`. In a plain browser it is false,
none of this code runs, and the existing HTML5 drag, the paperclip **Copy**
button and the "nothing accepted that drop" hint remain exactly as they were.
