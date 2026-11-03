# How MAGI drives chat websites like an API

This documents the actual mechanism MAGI uses to treat ChatGPT, Claude, Gemini,
and DeepSeek's *web UIs* as if they were an API — no API keys, no per-token
billing, just a real (automated) browser using your logged-in subscription.
Everything below is drawn directly from MAGI's source in `backend/magi/browser/`
and `backend/magi/providers/browser_base.py`, so it reflects what is actually
running, not a generic Playwright tutorial.

If another Claude instance says "I can't do browser automation," it likely means
it has no tool wired up for it in that environment — not that the technique is
impossible. This is a normal (if fiddly) Playwright application. Any agent with
shell/Python execution can write and run this code; it just needs the pieces
below.

## The core insight

A chat website's web UI *is* a request/response API once you stop thinking of
it as a page to click through and start thinking of it as:

1. A text box to put a prompt into
2. A button (or Enter key) that submits it
3. Some DOM element that eventually contains the answer, whose growth you can
   poll like you'd poll a job-status endpoint

Everything else — window position, human-like typing, selector fallback lists —
exists to keep step 1–3 reliable across UI redesigns and anti-bot defenses.
None of it is essential to the concept; it's what makes it *robust*.

## Why not just use the real API?

MAGI's answer, specifically: the browser path spends a **paid chat
subscription** (ChatGPT Plus, Claude Pro, etc.) instead of **per-token API
credit**. If your use case is the same — you or your users already pay for
the chat product and want to avoid separate API billing — the browser route is
the reason to do this at all. If you have API budget, use the API; it is far
more reliable than any of the below. This technique is specifically for when
you don't have (or don't want to pay for) API access.

## The five pieces

### 1. Config-driven selectors, not per-site code

Every site's DOM structure differs and changes over time. MAGI keeps this out
of Python entirely — `config/selectors.yaml` holds, per site:

```yaml
sites:
  chatgpt:
    url: https://chatgpt.com/
    headless_ok: true
    input:
      - "textarea.wm-composer-textarea"
      - "textarea[data-mobile-composer-prompt]"
      - "div#prompt-textarea[contenteditable='true']"   # legacy fallback
    submit:
      - "button[data-composer-submit]"
      - "button[aria-label='Send message']"
    send_key: Enter
    assistant_turn:
      - "article[data-testid^='conversation-turn-']"
    stop_button:
      - "button[data-testid='stop-button']"
    streaming_marker:
      - "[data-message-streaming='true']"
    login_selectors: [...]
    challenge_selectors: [...]
    poll_ms: 700
    stability_samples: 4
    confirm_samples: 3
    stall_timeout_s: 45
    hard_timeout_s: 300
```

**Every field is a list, tried in order, first match wins.** When a site
changes its markup, you add a new selector to the *top* of the list rather than
replacing the old one — if the site A/B tests or rolls back the change, the old
selector still works. One generic driver class reads this config; adding a new
site means adding YAML, not a new class or new code.

Selector resolution (`browser/resolve.py`) is intentionally dumb: it tries each
candidate, returns the first that matches and is visible, and reports which one
won. It never guesses or "fixes" a broken selector — a miss is reported as a
miss, because silently matching the wrong element means scraping the wrong text
and presenting it as a real answer.

### 2. Launching a real, persistent browser profile

```python
context = await playwright.chromium.launch_persistent_context(
    user_data_dir=str(profile_dir),   # one directory PER SITE, not shared
    channel="chrome",                  # real Chrome, not bundled Chromium
    headless=False,                    # see below — headless gets blocked
    args=[
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        f"--window-position={x},{y}",
    ],
)
```

Two decisions matter here, both non-obvious:

- **`launch_persistent_context`, not `launch()` + `storage_state`.** A
  persistent user-data directory keeps IndexedDB and refresh tokens; the
  storage-state/cookie-JSON approach drops them, which is why cookie-based
  sessions on these sites expire within days. Log in once per site (headful,
  by hand), and the persistent profile stays logged in like a real browser
  does.
- **Real Chrome (`channel="chrome"`), not bundled Chromium**, and **headful,
  not headless**, wherever the site allows it. The automation "tell" that
  matters most lives at the CDP protocol layer below where a JS init script
  can patch it — headless mode mostly just buys you bot challenges, for no
  reliability gain.
- Each site gets **its own profile directory** (`profiles/<site-id>/`), never
  your personal Chrome profile. That keeps your everyday browsing untouched
  and lets multiple site-sessions run in parallel without colliding.

**Hiding the window without going headless:** for sites that tolerate true
headless mode (verified per-site, not assumed), MAGI runs headless and
strips the headless "tell" from the user agent — see the Cloudflare section
below. For sites that don't tolerate headless at all, MAGI instead launches a
normal headful window but positions it **off-screen** (`--window-position=-32000,-32000`)
and hides its taskbar entry at the Win32 level. The browser is fully real and
rendering, it's just parked somewhere nobody's monitor covers. This is the
practical answer to "how do you automate a site that detects headless mode":
you don't go headless, you go invisible instead.

### 3. Clearing Cloudflare's headless detection (where possible)

This is the part most people get stuck on. Sites behind Cloudflare (ChatGPT,
Claude) serve headless Chrome an unclearable "Just a moment..." challenge page.
MAGI's finding, verified against live pages:

> Headless Chrome's user agent string literally contains the substring
> `HeadlessChrome/141...` instead of `Chrome/141...`. **That single token is
> what Cloudflare's check keys on.** Strip it — override the user agent to the
> plain `Chrome/...` string — and the exact same headless browser loads and
> answers normally.

```python
def _headless_user_agent() -> str:
    version = get_installed_chrome_version()  # read from the real binary,
                                                 # so it never silently drifts
                                                 # out of sync after a Chrome update
    return (
        f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        f"(KHTML, like Gecko) Chrome/{version} Safari/537.36"
    )

# passed as a launch arg only when running headless:
args = [f"--user-agent={_headless_user_agent()}"]
```

This is a documented, narrowly-scoped workaround for a specific fingerprinting
signal — not an attempt to defeat CAPTCHAs or anti-automation systems broadly.
If a real challenge page *does* appear (it still can), MAGI does not try to
solve it — it detects the challenge and fails loudly, asking a human to clear
it once by hand (see §5).

Whether this specific UA trick still works depends on Cloudflare's current
rules and can change without notice; treat it as "true as of when this was
last verified," not a permanent guarantee.

### 4. Human-paced typing and submission

Fixed-delay typing (e.g., a flat 15ms per keystroke) is a recognizable bot
signature. MAGI samples timing from ranges instead:

```python
# short prompts: type char-by-char in irregular bursts
for chunk in random_sized_chunks(text, lo=18, hi=60):
    await page.keyboard.type(chunk, delay=random_delay_ms())
    if random.random() < 0.25:
        await pause(0.12, 0.45)   # occasional human-like hesitation

# long prompts: typing 2,000+ characters at "human speed" is implausible
# anyway — a real person would paste. Use CDP's Input.insertText for a
# single-shot insert that still fires the input events React/ProseMirror
# need (setting .value directly does NOT — the framework never sees it,
# and the send button stays disabled).
if len(text) >= paste_threshold:
    cdp = await page.context.new_cdp_session(page)
    await cdp.send("Input.insertText", {"text": text})
```

Two gotchas worth calling out explicitly because they cause silent, confusing
failures:

- **Real keyboard events only, never `element.value = text`.** These editors
  (React/ProseMirror/Quill-based) listen for input events; setting `.value`
  directly leaves the framework's internal state unaware, so the send button
  stays disabled and nothing happens.
- **Newlines must be sent as Shift+Enter, never a literal `\n`.** In these
  composers, plain Enter *submits the message*. Typing a multi-line prompt
  with `\n` sends only the first line and abandons the rest — verified live:
  typing `"a\nb\nc"` sent `"a"` and left `"bc"` sitting in the box, unsent.

Submission prefers a real click on the resolved submit-button selector, falling
back to pressing the configured send key (usually Enter) if no button selector
matched — some sites (DeepSeek, in MAGI's config) have no stable submit-button
selector at all and are driven by Enter alone.

### 5. Knowing when the answer is "done" (the hard part)

There's no universal "done" event. MAGI layers four signals, from best to
worst evidence:

1. **Baseline-before-send.** Before typing anything, snapshot the current
   assistant-turn count *and* the text of the last turn. This matters because
   two different UI shapes exist:
   - *append-style*: a brand-new DOM node is added per answer → turn count
     growing means "new answer."
   - *fill-style*: the page pre-renders an *empty* assistant node and the
     answer streams into that existing node (ChatGPT's logged-out shell does
     this) → turn count never changes, so you must instead watch the *text* of
     that node change from what it was before you sent.
   Without this baseline check, a broken selector or race condition silently
   returns the *previous* answer, and it looks completely valid — this is
   called out in MAGI's code as the single nastiest failure mode.

2. **Stop-button / streaming-marker transition (best signal).** Most of these
   UIs swap a "Send" button for a "Stop" button while generating (or expose a
   `data-message-streaming="true"`-style attribute). Watch for that control to
   appear, then disappear — that's the site telling you directly it finished.

3. **Confirm-window after the signal.** A semantic "finished" signal is
   necessary but *not sufficient* on its own. Some sites emit a short preamble,
   clear the streaming flag while "thinking," then stream the real answer into
   the same node. Trusting the first clear signal captures just the preamble.
   Fix: only accept "done" once the text has also held **identical for N
   consecutive polls** after the signal clears (MAGI uses `confirm_samples`,
   tuned per site — Claude needs ~10s of quiet specifically to outlast its
   pause between an opening clarifying question and the real answer).

4. **Text-stability fallback**, for sites with no reliable stop/streaming
   signal: poll the text every `poll_ms`; once it's stopped changing for N
   consecutive samples, call it done. This is the weakest gate — identical
   text for a couple of polls can just mean the model paused mid-answer — so a
   result resting only on this is flagged **low-confidence** in the output
   rather than treated as a clean answer.

5. **Stall and hard timeouts**, so nothing hangs forever: give up if no new
   characters appear for `stall_timeout_s`, and absolutely bail at
   `hard_timeout_s` regardless of what's happening.

On every poll, also check for a **challenge or login wall** appearing mid-run
(page title containing "just a moment", "attention required", etc.) and fail
fast with a clear cause rather than burning the full timeout waiting for text
that will never arrive.

### Reading the answer, not just detecting it's done

Read the *DOM*, not `element.innerText()`. The site has already rendered the
model's Markdown into real HTML (headings, lists, tables, code blocks);
`innerText` flattens all of that back into undifferentiated prose. MAGI
serializes the assistant-turn node back into Markdown in-browser via
`page.evaluate()` with a small DOM-to-Markdown walker, so headings/bullets/code
fences survive intact. Falls back to `innerText` only if that serialization
throws (e.g., the node got swapped out mid-read by a React re-render).

## Bot-challenge and login handling: fail loud, don't fight it

If a challenge page is detected (Cloudflare interstitial) or a login control is
present where the composer should be, MAGI does not attempt to solve or bypass
it. It fails immediately with an explicit message telling a human to run a
one-off `login <site>` command — which opens that site's profile headful and
on-screen so a person can log in or clear a CAPTCHA by hand once. After that,
the persistent profile (see §2) stays authenticated for weeks, same as your
normal browser would.

This is a deliberate ethical/practical line, not just a MAGI quirk: automating
"click through the login form" or "solve the CAPTCHA" is a different (and much
more fragile, more abuse-adjacent) problem than automating "type into a box I'm
already logged into." Keep that line if you port this.

## Porting this to your own project — minimal checklist

1. **Pick sites you can legitimately automate as yourself** — this drives your
   own paid/logged-in session, the same as you opening a tab. Read each site's
   ToS; some prohibit automation even of your own account.
2. Per site, hand-inspect the DOM (DevTools) once to find: the input box, the
   submit control (or note it has none and uses Enter), whatever marks "still
   generating" (a stop button, a streaming attribute), and the container for
   each assistant turn. Write these as **ordered fallback lists**, not single
   selectors.
3. Launch via `launch_persistent_context` with a **dedicated profile directory
   per site**, real Chrome channel, headful by default.
4. Log in once, by hand, in that same profile (headful/on-screen).
5. Implement send as: click the input → clear stale draft text → type (or CDP
   paste for long text) → click submit or press the configured key.
6. Implement "wait for done" as the layered gates in §5 above — at minimum,
   baseline-before-send + text-stability with a confirm window. Skipping the
   baseline check is the single most likely bug to hit early ("it returns
   yesterday's answer").
7. Only if you specifically need it invisible: try true headless with the
   user-agent string fixed up first (§3); if the site still challenges you,
   fall back to headful-but-off-screen instead of trying harder to hide
   headless mode.
8. On any challenge/login-wall detection, stop and surface it to a human —
   don't build a solver.

## Source map (in this repo, for reference)

| Concern | File |
|---|---|
| Orchestrating one site end-to-end | `backend/magi/providers/browser_base.py` |
| Per-site selector config | `config/selectors.yaml` |
| Launching Chrome + persistent profiles + off-screen hiding | `backend/magi/browser/launcher.py` |
| Selector fallback resolution | `backend/magi/browser/resolve.py` |
| Human-paced typing/pasting/submitting | `backend/magi/browser/humanize.py` |
| "Is it done yet" polling state machine | `backend/magi/browser/completion.py` |
| DOM → Markdown extraction | `backend/magi/browser/markdown.py` |
