# StudyOS UI overhaul (2026-10-29)

Tony's brief, for Veda: an ultramodern, elegant StudyOS on desktop, tablet and phone, with every feature kept. This file records what changed and the rules that came with it, so a later change keeps them.

## The look

- **Palette:** pastels only, on a plum-charcoal ground (`--bg #131216`). Veda's mauve `#8D769A` fills primary buttons, pastel lavender `#C9B4D8` is the light accent, and pastel pink `#F0B3CB` is the second voice. Peach, mint, sky and rose are the semantic pastels. The tokens are on `:root` in `css/studyos.css` §1.
- **Fonts:** hers, unchanged. Lora for titles and big numbers (with lining figures, since Lora's old-style "0" reads as an "o"), Nunito for everything else. IBM Plex Mono is used only for code in lessons and prompts.
- **Icons:** SVG only. `SOI` in `js/studyos.js` is the one set, and the feature modules draw from it through `js/modules/icons.js`. `showNotif()` turns any emoji a caller passes into its SVG, so no toast shows one. The OS notification titles lost their emoji too.
- **App icon:** the mortarboard with a pink tassel dot (Tony's pick from six). Files: `assets/icon.svg`, `assets/icon-192.png`, `assets/icon-512.png`.

## Structure

| Piece | Where | Notes |
|---|---|---|
| Cover page | `js/intro.js`, `#sos-intro` | Shown on every launch, as Everwell's intro is. The sidebar mark brings it back. Skipped for `?class=` links, `?ingest=` and shared files. A Guardian card sits above it. |
| Sidebar | `studyos.html`, `js/shell.js` | Collapses to a 72px rail, as MAGI's does. The choice is kept per device (`sos_side_collapsed`). A tablet starts collapsed. |
| Tab entrances | `css/studyos.css` §3 | One short entrance per view. Always `backwards`, never `both`, so no transform is held on a view (the Notebook's phone drawer is `position:fixed`). |
| Form controls | `js/controls.js` (`window.SosControls`) | Every `<select>`, date, time and number field gets StudyOS's own control. The native field stays in the DOM, hidden, as the source of truth: `.value` has an own setter that repaints, option lists are watched, and a pick fires real `input` and `change` events. V's Notebook and `[data-native]` are skipped. |
| Dialogs | `js/ui.js` | `uiConfirm`, `uiPrompt`, `uiForm`, `uiAlert`, plus `uiChoice` (several answers and Cancel) and `sosConfirmDelete(what, detail)`. |
| Timer | `js/studyos.js` POMODORO | Modelled on TaskHub Veda's timer: the ring runs every frame with a dot at its end, there is a length stepper, and it uses TaskHub's sounds (`_tmBell` chime, `playTimerCue` start, resume and pause). Lengths are kept per device (`sos_pomo_lengths`). |
| Lock | `js/applock.js` | Guardian. See "The lock" below. |

## Rules that came with it

- **No browser UI anywhere.** That means no native `confirm`, `alert` or `prompt`, no native select, date, time or number control, and no native checkbox. The four native `confirm()` calls in the feature modules now go through `uiConfirm`.
- **Every delete asks first**, through `sosConfirmDelete` or a `uiConfirm` with `danger`. A repeating event or task asks with `uiChoice`: Only this one, This and all future, or Cancel. Cancel and Escape delete nothing. Before this change, Cancel was relabelled "This only" and deleted an occurrence.
- **No popup closes on a click outside it.** Only its own Cancel, Close, Back or Save buttons close it, or Escape (`_sosOpen`/`_sosClose` and the key handler in `js/studyos.js`). The same applies to the cards editor, the pipeline sheet and the Brightspace import.
- **Drag is A1's** (`dragsort.js`, loaded from Pages), wired by `sosDragList()` the way Everwell wires its cards. A mouse takes any part of a card that isn't a control, and a finger holds it for 300ms. There are no grip dots. This covers class cards on the dashboard, module cards (class and KSU), and document and prompt rows in a module's Edit mode. In Edit mode a document row reorders, so its drag-out to the desktop is off there. In View mode drag-out works as before.

## The lock

StudyOS is on Guardian (`veda_studyos`, owner Veda), declared in `js/applock.js` with a custom `backend`. Its backend is still StudyOS's own:

- the `studyos-api` worker on Veda's account (record `jlock:studyos_applock:studyos`);
- the Firestore lock doc (which lock is on, at what version `v`), with its live snapshot;
- Veda's Formspree, for hints and reset codes.

The move to Guardian asked nobody anything. Legacy adoption reads `sos_al_unlockedat_studyos` and the `sos_bio_studyos` credential. If Firestore can't answer, the cached `sos_al_locks` decides, as it always did. `tests/guardian-wiring.test.js` lists `V1/studyos.html` as a host. `V1/js/applock.js` is its one `BACKENDS` file, allowed to call its own worker's routes inside the backend and nothing else of a lock.

## Bugs fixed along the way

- "Today" was computed in UTC (`toISOString`). After about 8pm Eastern, an exam due today dropped out of the countdown and new items defaulted to tomorrow. Now `sosLocalDate()` is used throughout, including in `cards-ui` and `deck`.
- Next or Previous month from the 31st skipped a month, because `setMonth` overflowed.
- The Sync to Cloud label printed raw `<svg …>` text after a sync.
- In the KSU module popup, the stand-in class lacked `_ksu`, so a file reorder saved to the classes store and was lost.
- "+ Event" on a class page kept the last event's grade weight and repeat settings.
- The pipeline jobs panel kept polling every 5s after it was closed with its own button.
- Removing a file used its row index, which goes stale after a reorder. It now uses the file id.
- Class names stored HTML-escaped ("Computer Organization &amp") showed as "& amp". `sosClassName()` decodes them for display.
- Deleting a resource, a file, a prompt, a single event, a pipeline job or a card in review asked nothing.
