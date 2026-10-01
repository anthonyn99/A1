# Launcher

Veda's browser extension for the **Links** program (Index → Veda → Links).

Click the toolbar icon and every link group in Links is there: open one link, or
launch a whole card as a named, colour-matched browser tab group. Reorder the
cards and the new order goes back to Links.

Launcher is Links *in the toolbar* — nothing more. It has no Passwords,
Payments, ID Docs, Cloud or Sensitive Info sections; those belong to Tony's
Vault extension, which this one is modelled on but does not share code with.

---

## How it syncs

```
Links (index.html, Veda profile)
        ↕  Firestore  dashboards/veda_links   { connections, colmap, savedAt }
        ↕  keychain-sync Worker,  /links route
Launcher (this extension)
```

The Firebase project enforces App Check (reCAPTCHA v3). A browser extension
cannot mint a reCAPTCHA token, so Launcher never touches Firestore directly — it
goes through the **`keychain-sync` Cloudflare Worker**, whose Firebase service
account bypasses App Check and rules. Same document, both directions:

* **Links → Launcher.** The background service worker re-pulls the document on a
  one-minute alarm and caches it, so the popup opens instantly and already
  current. While the popup is *open* it polls every 5 s, so an edit made in Links
  on another screen appears without closing and reopening.
* **Launcher → Links.** Dragging a card writes the reordered `connections` array
  and `colmap` back through the worker. Links listens on the document with
  `onSnapshot`, so an open Links tab picks the change up in about a second.

Only order changes originate in Launcher. Every other field of every connection
(emails, phones, usernames, notes, attached documents) is round-tripped
untouched, so a reorder can never drop data the popup doesn't render.

**Auth.** The worker's `/links` route accepts its `LINKS_KEY` secret if one is
set, otherwise `VAULT_KEY`. Nothing needs provisioning for Launcher to work. If
you later split the two extensions onto separate keys, set `LINKS_KEY` on the
worker *and* change `LAUNCHER_KEY` in `launcher-sync.js` in the same change.

---

## Files

| File | What it does |
| --- | --- |
| `manifest.json` | MV3 manifest. Permissions: `tabs`, `tabGroups`, `storage`, `alarms`. |
| `popup.html` | The popup: Veda's purple/grey theme, one Links section. |
| `popup.js` | Render, launch, copy, reorder, live refresh. |
| `launcher-sync.js` | `LauncherDB` — load / save / cache against the worker. Loaded by both the popup and the service worker. |
| `launcher-drag.js` | `LauncherDrag` — card drag-to-reorder (pointer events, works on touch). |
| `background.js` | Tab-group launching + the one-minute refresh alarm. |
| `icons/launcher.svg` | The mark. `icon16/48/128.png` are rasterised from it. |

The PNGs exist only because Chromium does not accept SVG for `action.default_icon`
or `icons`. Regenerate them from the SVG after any logo edit — headless Chrome
with `--screenshot` at 16, 48 and 128 px is enough.

---

## Installing

Use **Install Launcher** in the top-right of the Links program. It packages the
current contents of this folder straight from GitHub and hands you a ZIP, then
walks through the one-time load. No Web Store account needed.

Manually, the same thing:

1. Download / copy this `Launcher` folder somewhere you'll keep it.
2. Open `chrome://extensions` (or `brave://`, `edge://`, `opera://`).
3. Turn on **Developer mode**.
4. **Load unpacked** → select the `Launcher` folder.
5. Pin it to the toolbar.

**Firefox** does not support `chrome://extensions`-style unpacked loading; use
`about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → pick
`manifest.json`. It is removed when Firefox restarts. Chromium-family browsers
(Chrome, Brave, Edge, Opera) keep it loaded permanently.

### Updating

An unpacked extension does not self-update. To move to a newer build: download
again from **Install Launcher**, replace the old `Launcher` folder with the new
one at the same path, then hit **Reload** on the extensions page.
