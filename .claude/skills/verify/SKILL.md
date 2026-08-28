---
name: verify
description: Drive index.html (TaskHub/MyJournal/Brainstorm Journal) in a real headless browser via CDP to verify a change end-to-end.
---

This is a single-file client app (`index.html`, ~36k lines) with Firebase
**anonymous** auth (no login/password needed) and a profile switcher (Tony /
Veda). Cloudflare Workers under `workers/*` are separate deploy targets — see
`auto-commit-push-deploy` project memory (edits auto-push and auto-deploy).

## Launching a real browser via CDP

No `node_modules`/test framework here. Drive it with raw CDP over Node's
global `WebSocket` (Node 22+):

1. Launch headless Edge/Chrome with a **dedicated `--user-data-dir`** (keeps
   it fully isolated from the user's real browser windows/profile — there
   are usually a dozen+ real `msedge.exe` processes already running, so
   never `taskkill`/`Stop-Process` by image name alone):
   ```
   msedge.exe --remote-debugging-port=9333 --headless=new --disable-gpu
     --window-size=1440,900 --user-data-dir=<temp-dir> --no-first-run about:blank
   ```
2. Get a **page** target's websocket URL from `http://127.0.0.1:9333/json/list`
   (find `{type:"page"}`) — NOT `/json/version`, which returns the
   browser-level target and doesn't support `Page.enable`/navigation.
3. `Page.navigate` to `file:///c:/Users/antho/Desktop/A1/index.html`
   (forward slashes, no URL-encoding needed for this path).
4. `Runtime.evaluate` with `returnByValue:true` to drive/inspect the page.

A minimal reusable `connect()`/`evalJs()` pair (reuse-if-already-running via
`portAlive()` check) lived at `scratchpad/cdp.js` in past sessions — it's
scratch-dir-scoped so it doesn't persist between sessions; recreate it from
this recipe (~40 lines, five minutes) rather than searching for it.

**Gotcha:** functions defined inside the DOCX module's big IIFE (`aiFormat`,
`_aiSegmentRuns`, `saveSel`, etc.) are **not** on `window` — you cannot call
them from a fresh `Runtime.evaluate`. To test internal helpers, either (a)
paste a standalone copy of the function into the page via eval and call
that copy against the same live DOM, or (b) drive the real UI (click the
real button) and assert on the resulting DOM/toast. Prefer (b) — it's what
actually proves the feature works, and (a) can silently test different logic
than what's wired to the button (this is exactly how a `mousedown`-vs-`click`
selection bug was found in 2026-07-09: the internal function worked fine in
isolation, but the real button never captured the selection).

## Reaching the journal editors

```js
window._profileGoTony();       // or a Veda equivalent if one exists
window.showTonyJournal();
document.getElementById('tj-new-entry-btn').click();
// wait ~400ms for the template modal, then:
document.querySelector('.template-card[data-template="page"]').click();
// entry is created in edit mode automatically; editor is #tj-page-editor
```

**Gotcha:** `document.querySelector('.docx-ai-btn')` (and other `.docx-*`
ribbon classes) matches **Brainstorm Journal's button first** — `bj-root`'s
markup appears before `tj-root`'s in the DOM, even when Tony's journal is
the one currently visible. Always scope: `#tj-root .docx-ai-btn` /
`#bj-root .docx-ai-btn`.

**Gotcha:** toolbar buttons that need the user's text selection (AI Format,
bold, font, etc.) capture it on `mousedown` into `ctx._savedSel`
(`saveSel(ctx)`/`savedSelFor(ctx)`, ~line 24601), because a plain `.click()`
already lost the live `window.getSelection()` by the time the click handler
runs. To test a selection-scoped feature, dispatch a **real mousedown before
the click**, not just `el.click()`:
```js
var r = el.getBoundingClientRect(), x = r.left+r.width/2, y = r.top+r.height/2;
var opts = {bubbles:true, cancelable:true, clientX:x, clientY:y, button:0};
el.dispatchEvent(new MouseEvent('mousedown', opts));
el.dispatchEvent(new MouseEvent('click', opts));
```
A bare `.click()` skips `mousedown`, so it will never exercise the
selection-capture path — it'll look like "no selection" even when one exists.

## AI Format specifically

- Whole-doc format: click `#tj-root .docx-ai-btn` (or `#bj-root ...`) with NO
  prior selection. Wait for `!document.querySelector('.docx-ai-veil')` (the
  overlay) to confirm completion (real Gemini call, can take several
  seconds; poll, don't fixed-sleep).
- Selection format: programmatically select via `document.createRange()` +
  `window.getSelection().addRange(range)` BEFORE the real mousedown+click on
  the button (see gotcha above).
- This hits the **real production** `personal-ai.av1.workers.dev` Cloudflare
  Worker and a real Gemini free-tier key — each test run consumes quota.
  Keep test iterations to what's needed to prove the change, not a stress
  suite (there's a 6s client-side cooldown between calls too).
- After a run, `data-ai-fmt="1"`/`data-ai-hash="..."` attributes appear on
  top-level blocks the AI touched — a solid, inspectable signal of what the
  feature did.

## Cleanup

Kill only the isolated test browser (match on its `--user-data-dir` in the
command line, via PowerShell `Get-CimInstance Win32_Process`), never by
image name — the user has many real `msedge.exe` windows open. Delete the
temp profile dir afterward.
