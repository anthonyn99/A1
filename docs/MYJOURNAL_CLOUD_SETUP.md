# MyJournal Cloud Documents — setup checklist

Everything below is a **manual, one-time** step. The code is already deployed; until
these are done, MyJournal shows a "not set up yet" prompt instead of a broken screen.

Both client IDs are pasted **inside the app**: MyJournal → sidebar → **⚙ (Document
settings)**. They sync through Firebase, so you only paste them on one device.

Two values, and they are **not** the same thing:

```
https://anthonyn99.github.io                    ← JavaScript origin   (Google)
https://anthonyn99.github.io/A1/                ← redirect URI        (Microsoft)
```

Google's Identity Services flow authorises by **origin** and needs no redirect URI
at all. Microsoft matches the **redirect URI exactly**, character for character.

GitHub Pages serves this app at both `/A1/` and `/A1/index.html`, so
`redirectUri()` folds `index.html` back to its directory — there is exactly one
value to register no matter how you navigated. The trailing slash is part of it.

The settings dialog prints the live value at the bottom; copy it from there if you
ever run the app somewhere else.

---

## 1. Google Docs / Google Drive

**APIs to enable** — Google Cloud Console → *APIs & Services* → *Library*:

- [ ] **Google Drive API**
- [ ] **Google Docs API**

**OAuth consent screen** — *APIs & Services* → *OAuth consent screen*:

- [ ] User type: **External**
- [ ] Add your own Google account under **Test users** (avoids the verification queue)
- [ ] Add these scopes:
  - `https://www.googleapis.com/auth/drive`
  - `https://www.googleapis.com/auth/documents`

> `drive.file` is not enough — it only ever sees files this app itself created, so
> your existing documents would be invisible. Full `drive` is what makes browsing,
> moving and trashing your real library possible.

**Credentials** — *APIs & Services* → *Credentials* → *Create credentials* →
*OAuth client ID*:

- [ ] Application type: **Web application**
- [ ] **Authorised JavaScript origins**: `https://anthonyn99.github.io`
- [ ] Authorised redirect URIs: *(leave empty — Google Identity Services uses the
      origin, not a redirect)*
- [ ] Copy the **Client ID** (`…apps.googleusercontent.com`)

**Where it goes**

- [ ] MyJournal → ⚙ → **Google Docs → OAuth client ID** → Save
- [ ] Click **Connect Google Docs**, approve, done

No client secret is used or needed. Nothing is pasted into a file.

---

## 2. Microsoft OneNote

**App registration** — [Entra ID (Azure) portal](https://entra.microsoft.com) →
*App registrations* → *New registration*:

- [ ] Name: anything (e.g. `MyJournal`)
- [ ] Supported account types: **Accounts in any organizational directory and
      personal Microsoft accounts**
- [ ] Redirect URI: platform **Single-page application (SPA)** →
      `https://anthonyn99.github.io/A1/index.html`

> The **SPA** platform type is the one that matters. A "Web" platform demands a
> client secret; SPA enables the PKCE flow a browser can complete on its own.

**API permissions** — *API permissions* → *Add a permission* → *Microsoft Graph* →
**Delegated permissions**:

- [ ] `Notes.ReadWrite`
- [ ] `User.Read`
- [ ] `offline_access`
- [ ] Click **Grant admin consent** (only needed for a work/school account)

> **Use `Notes.ReadWrite`, not `Notes.ReadWrite.All`.** The `.All` OneNote scopes
> are work/school only — Graph will not grant them to a personal Microsoft
> account. Requesting `.All` still signs you in and still issues a token, so the
> connection looks healthy; the first call then fails with *"The request does not
> contain a valid authentication token"*, which looks like a broken token rather
> than a scope that was never granted.

**Credentials**

- [ ] Copy the **Application (client) ID** from the app's Overview page

**Where it goes**

- [ ] MyJournal → ⚙ → **OneNote → Application (client) ID** → Save
- [ ] Click **Connect OneNote**, sign in, done

No client secret. No certificate.

### Known Graph limitation (not a gap in this build)

Microsoft Graph has **no rename or delete operation for notebooks, section groups
or sections** — only for pages. MyJournal greys those two actions out and says why,
rather than offering an action that would fail. Everything else in OneNote works:
create notebooks / section groups / sections / pages, and rename, edit, duplicate,
move and delete pages. Use OneNote itself to rename or delete a notebook.

---

## 3. Gemini

**Nothing to do.** Document AI reuses the key the rest of your personal AI already
uses (`TONY_GEMINI_KEY`), which is verified live in Cloudflare right now. It covers
summarise, rewrite, improve, expand, titles, tags, natural-language search, related
documents, duplicates and organisation suggestions.

**To verify it is working**

```bash
curl -s https://personal-ai.av1.workers.dev/health
```

- [ ] `"tonyKey": true`
- [ ] `"features"` includes `docs-ai`
- [ ] `"version": 16` or higher

Then in the app: open any document → **✨** in the toolbar → *Quick summary*.

**Only if you want to swap the key**

A key is never committed to this repository. It goes in as a Cloudflare secret:

```bash
cd workers/personal-ai
wrangler secret put TONY_GEMINI_KEY
```

Google AI Studio issues keys in the `AQ.…` format (the older `AIza…` keys still
work). Both authenticate against `generativelanguage.googleapis.com` as a plain
`?key=` query parameter, which is what `callGemini` / `geminiOnce` already send —
verified with a live `generateContent` call returning HTTP 200. No code change is
needed to switch between the two formats.

---

## Model fallback chains

Two chains, because the two jobs fail in opposite directions. Both are five deep so
a daily free-tier cap on one model never takes the feature down.

| Chain | Used for | Order |
|---|---|---|
| `DOC_WRITE_MODELS` | summarise, rewrite, improve, expand | `3.5-flash` → `2.5-flash` → `3.1-flash-lite` → `2.5-flash-lite` → `2.0-flash` |
| `DOC_INDEX_MODELS` | search, related, duplicates, organise | `3.1-flash-lite` → `3.5-flash` → `2.5-flash` → `2.5-flash-lite` → `2.0-flash` |

The ordering is inherited from the measurements already encoded in this worker
rather than from a fresh benchmark: on long content the lite models distil and drop
paragraphs (the finding behind `RECIPE_VOICE_MODELS`), so writing leads with the
flagship and keeps `2.5-flash` — the one measured as faithful — directly behind it.
On compact structured work `3.1-flash-lite` is both fastest and most reliable (the
finding behind `TASKHUB_MODELS`), so index work leads with that.

If you want these re-ordered against your own documents, the two arrays are at the
top of `workers/personal-ai/worker.js` and changing them needs no other edits.
