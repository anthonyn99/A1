# MAGI — multi-model council

Ask one question, get independent answers from several AI models, then one
synthesised verdict naming agreements, disagreements and confidence. Named
after the three deliberating supercomputers in *Evangelion*.

```
question ──> ChatGPT  ─┐
        ──> Claude    ─┤
        ──> Gemini    ─┼──> chairman synthesises ──> VERDICT
        ──> DeepSeek  ─┘        (one of the members)
```

Members are queried **independently** — none sees the others' answers — then
one member reads all of them and writes the verdict.

**Except when the question is about the responder.** "Which model are you?",
"what would you prefer?", "how would *you* approach this?" — every member's
answer is correct for itself, there is no disagreement to resolve, and merging
means stating something false about the members you dropped. The chairman is
told to list one line per member for those, naming each; for everything else,
merging is exactly the job. `magi/tests/test_chairman_prompt.py` pins it.

Built by Veda; taken over on 2026-09-09 and reorganised as an A1 program. This
file replaces her `README.md`, `SETUP-FOR-TONY.md` and `magi-setup.md`.

---

## The one thing that makes MAGI different from every other A1 program

Every other program in this repo is a page. MAGI is a page **plus an engine on
this PC**, and the engine cannot move.

It talks to the models through **browser automation of your own logged-in
subscriptions**, not APIs — four real Chrome profiles holding live sessions.
Those profiles cannot leave the machine, so:

| | |
|---|---|
| `magi.html` | the console. Static, at the A1 root, served from GitHub Pages like every other page. |
| `magi/` | the engine. Python + Playwright, runs on this PC only. |
| `workers2/magi-link/` | one KV record saying where the engine currently is. |

**This is against those services' terms of use**, which prohibit automated
access. You are running it on your own accounts at your own risk.

---

## Opening MAGI

Once set up, **bookmark <http://127.0.0.1:8000>** and open it like any other
page. `magi autostart` puts the engine on your logon items, so it is already
running by the time you get there and there is no launcher to remember.

```
magi autostart          install it (and start it now)
magi autostart status   is the shortcut installed, and is the engine up?
magi autostart off      remove it
```

It writes `MAGI.lnk` into your Startup folder — visible and deletable by hand
at `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`. A scheduled
task would be the nicer object (delays, battery policy, run history) but
registering one needs elevation, and an autostart that demands an admin prompt
to install is not an autostart.

It runs `magi cloud`, so the same logon also publishes a tunnel and the page
works from your phone. **The tunnel never holds up local access**: it is
verified and published on a background thread, so `127.0.0.1` is answering
seconds after logon whether or not the tunnel has registered yet.

The engine runs under `pythonw.exe` — no console window — and everything it
would have printed goes to `magi/data/autostart.log`, truncated per run. That
is the first place to look when the console says the engine is offline.

There was a `magi.bat` launcher. It was deleted on 2026-09-12, once the
startup shortcut had made it redundant for daily use: the shortcut runs the
venv's `pythonw.exe` directly and never went through the batch file. Every
command it wrapped is one line of the venv's Python, and they are written out
below.

## First run

Build the environment once. From the repo root:

```
py -3.12 -m venv magi\.venv
magi\.venv\Scripts\python.exe -m pip install -r magi\requirements.txt
magi\.venv\Scripts\python.exe -m playwright install chromium
```

3.12 is pinned deliberately: Veda verified against 3.11, this machine has no
3.11, and `py` on its own picks 3.14 — further from that baseline than 3.12
is. Playwright's Chromium is downloaded even though `config/magi.yaml` runs
`channel: chrome` (your real Chrome), because some Playwright internals expect
the bundled browser to be present regardless.

Then start it:

```
magi\.venv\Scripts\python.exe -m magi serve
```

Or `-m magi autostart` once, and it starts itself at every logon.

Then sign in to each site — one window opens per command, you log in by hand
exactly as you would normally, and the session is saved under `magi/profiles/`:

```
magi login chatgpt
magi login claude
magi login gemini
magi login deepseek
```

MAGI never sees your credentials, and your personal Chrome profile is never
touched — it can stay open the whole time. Skip any site you don't have an
account for and disable it in `magi/config/magi.yaml` under `providers:`.
`chairman.min_members: 2` is the minimum for a verdict to be attempted — but
only ever *out of the units you actually selected*. Tick one unit and MAGI asks
one model and shows you its answer, with no chairman pass at all: the console
says **SOLE UNIT** and "answered directly" rather than calling one voice a
consensus. min_members still does its real job, which is refusing to present a
verdict built from one member when you asked for four.

Finally, `magi doctor` to confirm the selectors still match.

### Prerequisites

- **Real Google Chrome**, not just Playwright's bundled Chromium.
  `config/magi.yaml` sets `channel: chrome` because a real Chrome fingerprint
  is part of what clears ChatGPT/Claude's Cloudflare challenge.
- **Python 3.11+.** Veda verified against 3.11; this machine has no 3.11, so
  the venv is built from **3.12** — closest to that baseline, and further from
  the 3.14 that `py` would otherwise pick.
- **Windows.** The off-screen window mechanism (`magi/browser/winhide.py`) uses
  Win32 APIs directly.

---

## Everyday use

| Command | What it does |
|---|---|
| `magi` | start the engine and open the console |
| `magi cloud` | ...and publish a tunnel, so the console works off this PC too |
| `magi login <site>` | sign in to a site, or refresh an expired session |
| `magi doctor` | which selectors still match — **run this first when a member stops responding** |
| `magi capture <site>` | find the selectors that only exist mid-answer (costs one real question) |
| `magi ask "…"` | run the council in the terminal, no UI |
| `magi autostart` | run the engine at logon, so there is no launcher to remember |
| `magi setup` | rebuild the venv from scratch |

Runs are **completely invisible** — no windows, no taskbar icons, nothing on
screen. All four sites currently run in **true headless Chrome**
(`headless_ok: true` for each in `selectors.yaml`).

That works because MAGI overrides the user agent. Headless Chrome advertises
`HeadlessChrome/141…` instead of `Chrome/141…`, and that token alone is what
Cloudflare blocks — with it removed, ChatGPT and Claude load and answer
normally. Both sit behind Cloudflare and used to need a workaround: a real
window parked off-screen with its taskbar button hidden via the Win32
`WS_EX_TOOLWINDOW` style (`magi/browser/winhide.py`). That path still exists as
the fallback — if either site starts serving "Just a moment…" again, set
`headless_ok: false` for it and it goes back to a hidden window rather than
failing.

Set `browser.offscreen: false` in `magi/config/magi.yaml` to watch the four
windows tile and answer live — useful when a selector breaks. They tile into
quadrants rather than stacking, and that is not cosmetic: Windows throttles
background work in occluded windows, which would slow the very members launched
in parallel to go faster.

---

## Opening the console from somewhere else

`magi.html` is at `https://anthonyn99.github.io/A1/magi.html`, and there is a
**MAGI** button in Tony's TaskHub. The page finds the engine on its own, in
this order:

1. **Same origin** — you opened `http://127.0.0.1:8000`. The backend is serving
   the page itself. No CORS, no token, nothing to configure.
2. **Hosted, at your desk** — the page is on GitHub Pages but the PC is right
   there. Chrome lets an https page call `http://127.0.0.1` and the backend
   answers the Private Network Access preflight, so this works with no tunnel.
3. **Hosted, away** — `magi cloud` published its quick-tunnel url to
   `magi-link`, and the page asks for it.

Cases 2 and 3 need the API token (below). The console's bottom-left status
shows which one it landed on, and says plainly when it found nothing.

**The PC must be awake and logged in.** A webpage cannot start anything on this
machine — opening the console while the PC is asleep cannot wake it, and every
run will fail.

### The token

`/api/*` is gated on a shared secret, because a quick tunnel **cannot** sit
behind Cloudflare Access — Access binds to a hostname on a zone you own, and
`trycloudflare.com` belongs to Cloudflare. Without the gate, the tunnel url is
the only thing protecting endpoints that drive your paid accounts, and urls
leak.

```powershell
setx MAGI_API_TOKEN "<a long random string>"   # then open a NEW terminal
```

Enter the same value in the console (click the status row at the bottom of the
sidebar). It is kept in that browser's `localStorage`.

**You only type it once, on one device.** A browser that has connected with a
token publishes it into `dashboards/magi` alongside the history it gates, and a
browser that has none reads it from there before reporting itself offline. That
was not a nicety: `magi-link` keys its records by the token's *hash*, so a
phone without the secret cannot even ask where the engine is — and the fix
otherwise was typing a long random string on a phone keyboard. It lives in the
same document, under the same rules, the same App Check and the same sign-in
that already hold every deliberation; Keychain keeps real passwords in this
project, so guarding the token more heavily than the data it protects would be
theatre.

An *unproven* token — one sitting in a desk browser's `localStorage`, used to
reach the engine over `127.0.0.1`, which needs no token at all — only ever
fills a gap. It cannot overwrite a token the phone just proved over a live
tunnel. Proven ones, and one you have just typed in, replace.

The desk console does not even need it typed once: `GET /api/token` hands the
engine's own copy to a loopback caller and 404s over the tunnel, so the console
learns it from the engine and publishes it. That endpoint adds no exposure —
anything that can reach it can already `POST /api/runs` and drive four
logged-in paid accounts, which is strictly worse than reading the string that
authorises exactly that.

**The field in the setup sheet is read-only until you unlock it.** It holds 43
opaque characters and one stray keystroke takes the console offline with no
symptom but silence. Press **Change** to edit; **Restore last working** puts
back the last token that actually reached the engine — remembered only when
*proven* (handed over by the engine, or used to open the tunnel), never merely
when typed.

Unset, the gate is **off** — so plain `magi` over 127.0.0.1 behaves as before.
`magi cloud` refuses to publish without it, and verifies the tunnel returns
**401** before publishing: a 200 there would mean the server started without
the token and is wide open.

### Why there is no rebuild step any more

Veda's build inlined the tunnel url into the JS bundle, so every PC restart
meant: new url → rewrite `.env.production` → `npm run build` → `firebase
deploy`. `magi.html` looks the url up at load instead, so **nothing is ever
rebuilt or redeployed**. Firebase hosting is gone with it.

`magi-link` holds one KV record per token, keyed by SHA-256 of that token — so
the worker never learns the secret, holds no secrets of its own, and a dump of
its namespace reveals no credential. It costs one KV write per PC boot.
Registering a domain would remove the tunnel churn entirely; see the named-tunnel
note in `magi/config/`.

### The tunnel heals itself, and asks Windows for nothing

A quick tunnel is not durable: cloudflared drops out on a network blip, on
sleep/wake, or when Cloudflare recycles the hostname. `magi cloud` replaces it
rather than serving locally for the rest of the session — each replacement gets
a new hostname, which is exactly what `magi-link` is for, and the phone follows
on its next look. Backoff is capped at a minute.

It also **withdraws the old record before opening the new tunnel**. A quick
tunnel dies with the process that opened it, but magi-link keeps serving that
hostname until the replacement is verified and published — minutes, while
public DNS catches up — and for that whole window the phone follows the record
to something answering 530 and the console says "tunnel is dead". A clean exit
withdraws on its way out; a crash, a power cut or a force-kill does not, and
those are exactly the times MAGI gets restarted.

It is also launched with three flags that exist for one symptom: Windows put up
**"allow cloudflared?"** at every single logon, and clicking Allow did not stop
it — four allow rules were already in place. The prompt is not about the rules,
it is about cloudflared **binding a socket that is not loopback**:

| Flag | Why |
|---|---|
| `--protocol http2` | the default QUIC transport binds an unconnected UDP socket to `0.0.0.0`, which Windows cannot tell from a listener. http2 carries the same tunnel over ordinary outbound TCP. |
| `--metrics 127.0.0.1:0` | pins the metrics server to loopback so it can never land on a routable address. |
| `--no-autoupdate` | cloudflared replacing its own binary underneath the firewall rules is one of the few ways a settled prompt comes back. |

---

## "How it works", inside the app

There is a **?** button in the header — the sidebar's on desktop, the top bar's
on a phone — that opens the explanation of MAGI as a panel: what it is, what
happens when you press Convene, what ticking a unit does, why the engine device
has to be awake, and what the Doctor is for.

**It is part of the contract, not a nicety.** It is the only documentation most
people will ever read, and a confidently wrong explanation is worse than none —
it teaches you to expect behaviour the program does not have, and then the
program looks broken. So: *any change to how a run fans out, how completion is
decided, what unticking a unit does, what the doctor checks, how long history
is kept, or where the engine has to be, updates that panel in the same commit.*

`magi/tests/test_howitworks.py` fails when the checkable claims drift — the
doctor's status words, the units it names, the retention window, the promises
about unticked units and about the single-unit path. It cannot check prose;
that part is on whoever is editing.

The content lives in the `HOW` array in `magi.html`. Numbers are interpolated
from the constants they describe rather than typed, so a retention window
cannot go stale on its own.

## Every member is told the answer goes in the chat

`DIRECT_ANSWER_PREAMBLE` (in `magi/providers/browser_base.py`) is prepended to
every browser turn — council members, the chairman's synthesis, Studio, Refine.
Two sentences, both bought with a lost run:

**"Reply in this chat. Do not create an artifact, canvas, document, file, app
or tool to hold it."** Asked for a ten-section daily trading report, Claude
replied *"I'll help you build a template"*, read its memories, and started
building an interactive generator as a file. MAGI scrapes the conversation — it
cannot read an artifact — so it waited for text that never settled and the run
ended `stall_timeout`. A long structured prompt is exactly the shape that makes
these UIs reach for a tool.

**"This is a single turn and there is no follow-up… look things up if you need
current information."** With the artifact fixed, Claude came back with *"Should
I: 1. Search the web for today's data? 2. Wait for you to provide it?"* — a
reasonable thing to ask a person, and worthless here: nobody is watching that
tab. The other three units simply looked the data up, which is the only reason
they answered and Claude did not.

It says nothing about content, tone, length or format, so it cannot bend an
answer — only where that answer is put and whether there is one.
`magi/tests/test_tool_use.py` fails if a shaping word creeps in.

**Tool rows are stripped from the capture** (`extract.strip_tool_rows`): "Read
4 memories", "Searched the web", "Creating a file56srunning" — that last one is
the label, the elapsed timer and the status word as three sibling nodes with no
whitespace between them, glued together by `innerText`. Each is matched as a
whole line that contains nothing else, so a sentence that merely mentions
searching the web keeps its line.

**A long non-answer is still a non-answer.** The clarifying-question rule stops
at 300 characters, because a long answer ending in a question mark is a normal
rhetorical device — but a member can decline at length. An offer to proceed
("Should I…?", "Would you like me to…?") under 1,200 characters is now rejected
the same way: in a one-shot council, asking permission is declining.

## Questions handed over by another A1 program

TradeHub's **Analysis** tab no longer opens a chat site and types a prompt into
it. It opens MAGI:

```
magi.html#tb=<base64url of {v, src, q, units, run, t}>
```

The units it ticks are ticked here, and the council convenes on arrival. Its
searches still open as ordinary browser tabs — only the AI half changed.

**The payload is in the fragment, and that is the whole design.** A fragment is
never sent to a server, so a long prompt cannot overflow a request line — that
is the HTTP 431 that made TradeHub fall back to putting the prompt on your
clipboard, and it is why `?q=` was never an option for a real trading prompt.
Nothing is written to a worker, to KV or to Firestore to carry it either: a
hand-off costs zero reads and zero writes. It also works cross-origin, so the
same link opens the console whether it is on GitHub Pages or being served by
the engine.

**It is consumed once.** `takeHandoff()` strips the fragment *before* the
payload is parsed, so a reload cannot fire a second council run against your
paid accounts. `t` is a nonce for the opposite case: re-sending the same prompt
to a console that is already open has to change the url, or the browser fires
no `hashchange` and the launch looks like it did nothing.

**Nothing is ever dropped silently.** The link waits for whichever of these is
in the way and runs when it clears:

| In the way | What happens |
|---|---|
| MAGI is locked | held; `hideLock()` runs it |
| The unit list has not arrived | held; `boot()` runs it |
| A council is already in flight | held; `endRun()` runs it |
| The engine is asleep | the prompt lands in the box and says so; press Convene when it is up |
| It names units this engine has none of | the selection already made here is kept, and the run goes ahead with it |

**It always lands in the one MAGI tab.** TradeHub opens the console exactly
the way TaskHub's MAGI button does — `_tnOpenTab`'s pairing, ported: the window
name `a1tab_magi` first, and when that misses (Chrome restores tabs but not the
opener links that make a name findable) the `tabsync.js` heartbeat and its
`a1tabs` BroadcastChannel. A console that is already open is navigated rather
than duplicated, and because only the fragment differs that is not a reload —
whatever it was doing survives, and it hears `hashchange`.

One message was added to `tabsync.js` for this: **`deliver`**. TaskHub's
handshake ends with the old tab merely coming forward, which for a prompt would
mean focusing a console that never heard the question; `deliver` hands it the
url instead, and it navigates itself. Same-origin only, both sender (the
channel guarantees it) and payload (checked), so it can never send one of these
tabs off-origin.

The morning launcher builds the same link in Python
(`trading-auto-launch/launch.py`, `_magi_link`), from the prompt and unit list
TradeHub pushes to `trade-dashboard`'s `/analysis-config`. A non-empty
`magiUnits` there is exactly what tells it the destination is the council
rather than a chat site — the Vault extension and its `#tbauto` marker are not
in that path at all.

`tests/magi-handoff.test.js` runs the encoder, both decoders and the state
machine above; it also fails if TradeHub offers a unit `selectors.yaml` does
not have.

## Accounts — which account each unit is signed in as

**System → Accounts.** One card per unit: whether a session is saved, whether
it still works, how big the profile is, and a label you write yourself.

Three deliberate omissions, all in `magi/accounts.py`:

- **It does not scrape the account's email.** Seven more selectors, all behind
  logins, each of which would rot into showing the *wrong* account — worse
  than showing none. You label the profile instead; a label you wrote is never
  stale in a way that lies.
- **It does not open a browser to build the list.** Seven Chrome launches to
  render a settings tab is absurd. The listing reads the filesystem; **Check**
  is one unit, on request, and is the only honest answer to "does this session
  still work" — a profile folder existing proves nothing.
- **It never sees your credentials.** *Sign in* opens the real site in a real
  window **on the engine device** — the only place it can open, since that is
  where the profiles live — and MAGI watches the page until the composer
  appears. *Sign out* deletes MAGI's copy of that session so you can sign in
  as somebody else; it is not a sign-out at the provider, and your personal
  Chrome is never touched.

A phone can start a sign-in. The window still opens at the engine device, and
the panel says so rather than leaving you watching a phone for a window that
is never coming.

## Adding a unit

Three files, and the two that are easy to forget are both in `magi.html`:

1. `magi/config/selectors.yaml` — the site block. **Discover the selectors
   against the live page**; a guess ships a unit that looks configured and
   never answers. `magi doctor <site>` then confirms them and names anything
   that does not match.
2. `magi/config/magi.yaml` — `providers.<id>.enabled`.
3. `magi.html` — a codename in `UNIT` and a stagger in `PHASE`. Neither throws
   when missing, so neither gets noticed: `magi/tests/test_units.py` fails
   instead, and also refuses two units sharing an accent colour.

A fourth place names units, outside MAGI: **TradeHub's Analysis tab**
(`TB_MAGI_UNITS` in `tradehub.html`) and the allow-list that carries its choice
through `workers2/trade-dashboard`. A unit missing there is simply one you
cannot tick from TradeHub; a unit *misspelled* there is a tick box that does
nothing at all. `tests/magi-handoff.test.js` fails on either.

### The seven

| Unit | Codename | Verified |
|---|---|---|
| ChatGPT | MELCHIOR·01 | yes |
| Claude | BALTHASAR·02 | yes |
| Gemini | CASPER·03 | yes |
| DeepSeek | ADAM·04 | yes |
| Perplexity | LILITH·05 | composer, submit, answer and stop probed live |
| Grok | TABRIS·06 | composer and submit probed live; answer and stop **not** — logged out, Grok accepts the question and never answers |

Perplexity earns its place by being the one member that is search-grounded by
default: where the others reason from training data, it reads today's page.
That is exactly the disagreement a council exists to surface.

Copilot was a member until 2026-09-11 and is gone. It showed a sign-in wall
with no reachable composer, and the only input selector loose enough to match
anything on that wall matched a hidden decoy — so it reported itself usable
and then answered nothing. A member that cannot answer is worse than one that
is absent: it costs a browser, a timeout, and a slot in the quorum.

For Grok: sign in from the Accounts tab, then `magi doctor grok`. It primes
the composer, names every field that does not match and prints the line to
change.

## When a site changes its UI

This is the routine maintenance task, and it does not require touching Python.

```
magi doctor        # OK / FALLBACK / MISS per selector
```

Then open the site, inspect the element, and add the working selector to the
**top** of that field's list in `magi/config/selectors.yaml`. Every field is a
list tried in order, so old entries stay as fallbacks and you keep a rollback
path if the site reverts or is A/B testing.

### What the report tells you

A verdict line first — *"all 4 units healthy"*, or *"1 unit needs attention ·
3 fine"* — then one card per unit, then the full field table folded away. It
used to be a single flat table of every field of every unit, about thirty rows
and almost all of them OK, which answered "what matched?" when the question is
"is anything broken, and what do I do?".

A stale or missing field now prints the fix: the file, the key, the selector
that matched and the one it should be moved above. That is the whole repair,
and it was previously something you inferred from two table columns.

The units are checked **in parallel**, for the same reason the council fans out
in parallel — each drives its own profile against a different service, so
nothing is being hammered. Sequentially, four units meant about two minutes of
staring at a spinner, which is long enough that the doctor stopped being
something you just run. Each card also reports how long that unit took: one
that is "fine" but took fifty seconds is on its way to timing out mid-run, and
nothing else would tell you.

It checks the units you have **selected**. A unit you are not using is a unit
whose selectors you do not need to know about — and it opens a real signed-in
browser per unit, which is not something an unticked model should get.

### Dialogs that land on the composer

A cookie banner cost a run. Perplexity served its consent card — fixed,
bottom-right, over the composer — and the unit failed after thirty seconds with
`Could not type: Locator.click: Timeout 30000ms exceeded … locator resolved to
<div id="ask-input" …>`.

Read that closely: the selector **matched**. Playwright's click then waits for
the element to pass its actionability checks, one of which is a hit test, and a
click at that point would have landed on the dialog. It was reported as
`selector_miss`, whose remedy is "rewrite selectors.yaml" — against a selector
that was perfectly correct.

`magi/browser/overlay.py` makes that class of thing a non-event, in two halves:

- **Known dialogs are clicked away** before the prompt is typed, from
  `dismiss_selectors` — a shared list in `defaults` that every site gets, plus
  per-site entries, unioned rather than overridden. They are scoped to a
  `role="dialog"` wherever the site gives us one, and the **refusing** option
  is always listed before the accepting one: "Decline optional" before "Got
  it", "Maybe later" and never its sibling "Get started". MAGI answers a
  consent prompt on your behalf, so it answers conservatively.
- **Unknown dialogs cannot stop a run anyway.** The click is only the first of
  three routes into a composer. The second is `focus()`, which does no hit
  testing at all, so nothing painted on top can block it — and everything after
  that point is keyboard-driven (`Input.insertText`, `keyboard.type`), which
  follows focus and needs no pointer. Focus is read back out of
  `document.activeElement` before it is believed, because a `focus()` that
  silently did nothing would type the whole prompt into the page body.

When it does fail, it fails as `overlay_blocked` and the cause NAMES what was
in front — `elementFromPoint` at the click position, walked up to its dialog.

`magi doctor` reports the same thing: it now says when a dialog was covering
the composer and whether the configured selectors closed it. It also waits for
the composer as long as a run does rather than a flat three seconds — measured
on perplexity.ai with two dialogs to render, that flat wait reported `input`
and `ready_selector` as MISS, which is the same false alarm in a different
place.

`magi/tests/test_overlay.py` pins all of it, including that the shared list
cannot click anything but a dismissal.

### The three fields `doctor` can never check

`doctor` can only probe an **idle** page, so `stop_button`, `streaming_marker`
and `assistant_turn` are permanently unverifiable there — they do not exist
until a model is actually answering. That gap is why DeepSeek ships with
`stop_button: []` and `streaming_marker: []`: its completion detection rests on
text stability alone, so every DeepSeek answer is flagged *"end of response
inferred, not confirmed"* and pays a 14-second silence before MAGI calls it
finished, whether or not it actually was.

```
magi capture deepseek
```

asks one short throwaway question, snapshots the page before, repeatedly during
and after the answer, and reports what existed **only while generating**. Those
are the stop-button and streaming-marker candidates; put the ones that look
right at the top of their lists. It deliberately ignores build-hashed class
names (`_4f3769f`), because a selector built from one works today and breaks
silently at the site's next deploy — looking exactly like a redesign when it
does.

It costs a real question against your account, which is why it is a command you
run deliberately rather than something `doctor` does on every pass.

---

## Troubleshooting

Every failure MAGI can produce has a specific cause and a concrete fix — this
is `magi/errors.py`'s `FailureKind` taxonomy, condensed. The UI shows the same
cause and remedy inline on the failing unit.

| Symptom | Cause | Fix |
|---|---|---|
| `not_logged_in` | Saved session isn't logged in | `magi login <site>` |
| `selector_miss` | Site's UI changed | `magi doctor`, then edit `config/selectors.yaml` |
| `overlay_blocked` | Something is covering the composer | the cause names it; add the button that closes it to that site's `dismiss_selectors` |
| `bot_challenge` | Human-verification challenge served | `magi login <site>` and clear it by hand; consider slowing `pacing` |
| `timeout` | Model didn't finish in time | raise `hard_timeout_s` for that site, or retry |
| `rate_limited` | Usage limit hit | wait, or disable that provider |
| `profile_locked` | That profile is already open elsewhere | close other MAGI browser windows; your personal Chrome is unaffected |
| `browser_crash` | Browser closed unexpectedly | retry; if persistent, delete that site's folder under `profiles/` and log in again |

Every failed attempt also saves a screenshot + DOM dump under
`magi/artifacts/`. The console says **"Engine offline"** with the specific
reason when it cannot find the backend at all — that is a different problem
from any row above, and the fix is in the discovery list further up.

---

## Design notes worth keeping

**Failures are never disguised as answers.** A provider that fails returns a
specific `FailureKind` with a plain-language cause and remedy — never an empty
string or an error message in the answer field. If fewer members respond than
the configured minimum, MAGI refuses to synthesise rather than presenting a
one-model opinion as a council verdict. The verdict always states how many
members actually answered.

**A unit that replied without answering is neither "resolved" nor "offline".**
It is `degraded`, shown as *unusable*, excluded from the synthesis, and named
in the Verdict panel. Conflating it with either of the other two is what once
produced a silent "4/4 resolved" on a run where one member had returned a
clarifying question.

**Completion detection is layered**, because no single signal survives UI
churn: the site's own streaming marker, then the stop-button state, then text
stability, each confirmed by a quiet period, with a turn-count baseline to
guarantee the answer is new. Answers that complete only via the weakest signal
are flagged low-confidence rather than presented as certain.

**Long prompts are inserted in one operation** rather than typed. The synthesis
prompt carries every member's full answer, and typing 2,372 characters at human
speed took 86 seconds — a third of a whole run.

**Refine is a separate button, not a step inside Convene.** Refining on the way
to a run would send the council a question the person never read. It lands in
the composer instead, where it can be read, edited or undone first. It runs on
the Gemini **API** rather than a browser session (~4s vs a Chrome launch plus a
scrape-until-stable poll), with the model pinned to an exact version — the
`gemini-flash-latest` alias measured 14–30s with intermittent 503s, so "newest"
is not "fastest". Optional: without `GEMINI_API_KEY` in `magi/.env` it falls
back to the slow browser path.

---

## Configuration

| File | What it controls |
|---|---|
| `magi/config/selectors.yaml` | per-site selectors, timeouts and `dismiss_selectors` — **edit this when a site changes** |
| `magi/config/magi.yaml` | pacing, which members are enabled, who chairs, artifact settings |
| `magi/.env` | `GEMINI_API_KEY` for Refine (gitignored) |
| `MAGI_API_TOKEN` | env var; gates `/api/*` (see above) |

The two YAML files are deliberately **not** merged. Selectors are what break
when a site ships a redesign, and the person fixing them at 1am should not have
to scroll past pacing and chairman config to do it.

---

## Layout

```
magi.html               the console — single file, no build step
magi/
  app.py                FastAPI + SSE
  __main__.py           the CLI
  providers/            Provider interface + browser implementation + registry
  browser/              launch, typing, completion detection, text cleaning
  engine/               orchestrator, chairman, brainstorm, studio, refine
  cli/                  serve/cloud, doctor, login, ask
  config/               selectors.yaml, magi.yaml
  tests/                147 tests — `magi\.venv\Scripts\python -m pytest magi/tests`
  profiles/  data/  artifacts/  .venv/      gitignored, created at runtime
workers2/magi-link/     where the engine currently is (Cloudflare account 2)
```

`profiles/`, `data/` and `artifacts/` are gitignored and **must stay that
way** — this repo is public, and they hold live login sessions, the full text
of every question and answer, and screenshots taken from logged-in pages.

The `Provider` interface in `magi/providers/base.py` is the seam: an API-backed
provider can be dropped in with no change to the engine, UI or database, if the
scraping ever becomes too brittle.

---

## What the A1 port changed, and what is still to do

Carried over unchanged: the whole Python engine, all 147 tests, both config
files, the Evangelion console styling.

Consolidated or dropped:

| Before | After |
|---|---|
| `README.md` + `SETUP-FOR-TONY.md` + `magi-setup.md` | this file |
| `MAGI.bat` + `MAGI-Login.bat` + `MAGI-Doctor.bat` + `MAGI-Cloud.ps1` | one `magi.bat`, and then nothing — the startup shortcut runs the venv directly |
| `backend/magi/` | `magi/` |
| React + Vite + TypeScript frontend (23 files, a build step) | `magi.html` |
| Firebase Hosting | GitHub Pages, with the rest of A1 |
| Interpreter probing across four candidate Pythons | a pinned `.venv` |
| Tunnel url compiled into the bundle | looked up at load from `magi-link` |
| A stale 2.4MB copy of TaskHub's `index.html` | deleted |

**Studio is ported.** Seven cards derived from a finished verdict — Data
Table, Report, Flashcards, Quiz, Mind Map, Slide Deck and Audio Overview — in
the sidebar under *Studio*, disabled until a run has a verdict. Clicking a card
generates it if it has never run and opens it either way; an open card replaces
the grid and verdict rather than stacking above them. Generated cards are
stored, so reopening a past run from History brings its cards back rather than
regenerating them. Audio Overview is read aloud by the browser's own
SpeechSynthesis — MAGI has no audio generation surface, so the two-host script
is spoken client-side, with a second voice where the platform has one and a
pitch offset where it does not. Video is a permanently disabled tile: there is
no video surface reachable through a browser-automated chat UI.

**Brainstorm is ported.** Its own section in the sidebar, and it takes over the
content area when open — it brings its own topic box and its own reply box, so
the council's question bar is hidden rather than stacked above a second textarea
that submits somewhere else. Rounds stream the same per-member events a council
run does, so they drive the same grid with no changes to it.

Questions come back as cards, modelled on Claude Code's own AskUserQuestion: a
header chip, the question, then either options to pick from or a text box. One
marked *shapes the plan* is blocking — while it is unanswered the session cannot
report itself ready. Every answer is optional; skipping one means "you decide".
The plan is never written to disk on its own: **Save as…** opens a real file
dialog where the browser supports one and falls back to a download otherwise.

Rounds that were retried are kept and labelled rather than hidden — a round that
failed still happened, and what the members said before it failed is part of the
record.

Brainstorm is worth knowing about before porting it — a round is three phases
(propose → critique → merge), and the critique phase is what makes it a debate
rather than a poll: each member reads the others verbatim and attacks them, so
a wrong claim from one member gets challenged by the three that could catch it.
The properties it depends on are enforced in code rather than only asked for in
the prompt (an answered-facts ledger, blocking unknowns that gate the finish,
refutations replayed to the member that made the claim, disagreement as a table
rather than prose, and a review pass that can only improve or no-op). Read
`magi/engine/brainstorm.py` before rebuilding that UI.

---

## Cross-device sync

Every finished deliberation goes to Firestore, so a verdict produced on the PC
opens on the phone. The engine stays where the Chrome profiles are; only the
RESULTS travel.

```
dashboards/magi              one index doc: compact rows, newest first
dashboards/magi/runs/{id}    one body per run: answers, verdict, Studio cards
```

Both sit under the existing `/dashboards/{doc=**}` rule, so `firestore.rules`
needed no change.

**The write budget drove the shape.** The free tier is 20k writes and 50k reads
a day, shared with every other A1 program:

- **Nothing is written while a run is in flight.** A run emits an SSE frame
  every few hundred ms per member; mirroring those would be thousands of
  writes for one question. One completed run is **one body write plus one
  index update**.
- **History reads one document, not a collection.** A collection query costs
  one read per run returned — 30 reads every time the page opens. One index
  doc is one read.
- **Exactly one listener**, on that index doc, so a run finished on the PC
  appears elsewhere without polling. Its cost is bounded by write volume, not
  by time.
- **Bodies are read only when you open that run.** Opening History reads
  nothing extra.
- Index writes are **debounced**, so generating three Studio cards in a row is
  still one index write.

Steady state for heavy use — 30 runs a day, read on three devices — is roughly
90 writes and a few hundred reads. Under half a percent of the allowance.

Studio cards travel with the body deliberately: each one costs a real browser
run, so a phone should open one rather than re-earn it.

### Retention: 30 days, or pinned

History keeps 30 days; everything older is dropped, body document first and
then the index row, so an interruption leaves an invisible orphan rather than a
History entry that opens to nothing. The sweep runs once per load and only when
something has actually expired, so the usual cost is zero writes.

**Pin a deliberation to keep it forever.** Pins live BOTH in that browser and on
the cloud row, and either one counts — a pin has to survive sync being
unavailable (App Check refuses to sign in on `127.0.0.1`) *and* reach your other
devices when sync works. Both paths fail towards keeping the run: the cost of
getting this wrong is deleting something you asked to keep. Backfill skips
expired runs too, or the engine's SQLite — which keeps everything — would
re-upload them on the next load and pruning would be a loop rather than a
policy. The API token travels
in the index doc for the same reason — see **The token** above.

**Every scroller has an overlay scrollbar** — the page, the drawer, and each
open answer. Nothing while you read, a thumb while you move, grabbable with a
finger or a cursor, gone a moment later. They are fixed overlays positioned
from each scroller's rect rather than children of it, so no scroller needed
restructuring to get one.

**Pull down to refresh reloads the page**, exactly like Index and the rest of
A1: the gesture is what people reach for when the page itself looks wrong, and
refetching state in place cannot fix that (or pick up a newly deployed
`magi.html`). The one exception is a deliberation in flight — reloading then
would drop the SSE stream and leave the council running against your paid
accounts with nothing watching — so that case refreshes in place instead. The
gesture is implemented by hand because `body { overflow: hidden }` and an
installed PWA leave the browser's own version nothing to fire on.

**When sync fails it says why.** "Sync failed" alone named no operation, no
cause and no fix, and the detail went to a browser console you cannot open on a
phone. The line is now clickable: it gives the Firestore code, a plain-language
cause, what was being written, and a retry. Backfill also stopped crying wolf —
it used to report failure whenever *zero* runs were pushed, so a batch whose
only missing run had been deleted from the engine showed "Sync failed" with
nothing wrong, and a batch where nine of ten failed showed "Synced".

**App Check is registered per domain.** Sync works on
`https://anthonyn99.github.io/A1/magi.html`; on `http://127.0.0.1:8000` the
App Check token is refused and sync silently stays off. Everything local —
running the council, History, Studio, Brainstorm — is unaffected either way,
and the console degrades to local-only rather than erroring.

## Installing it

`magi.html` carries an inline `data:` manifest, the same pattern every other A1
program uses, so there is no extra file to deploy. Open it and use the
browser's **Install** option to get it as a standalone app with its own icon.
Install from the GitHub Pages URL rather than `127.0.0.1`, so the installed app
has a stable identity and App Check works.
