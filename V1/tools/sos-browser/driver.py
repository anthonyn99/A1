"""StudyOS browser driver — run a prompt against a logged-in chat UI.

Drives Claude (or Gemini) as *yourself*, using the subscription you already pay
for, instead of a per-token API key. It attaches a lecture deck, sends a prompt,
waits for the answer to actually finish, and returns it as markdown.

── WHY THIS EXISTS SEPARATELY FROM MAGI ───────────────────────────────────────
MAGI (in this same repo) does this already, and this file deliberately does NOT
import from it or call its HTTP API. Two reasons:

  1. MAGI is a *council* — it fans one question out to four providers and
     synthesises them. StudyOS wants one good answer from one provider, chunked
     across a long deck. Different shape, different failure modes.
  2. Coupling StudyOS's pipeline to MAGI's server means StudyOS breaks whenever
     MAGI is mid-refactor, not running, or on a different port.

What IS taken from MAGI is the hard-won *mechanism*: the selector fallback
lists, the four-layer completion gate, the DOM→markdown walker, and the specific
timing constants that were measured against real failures. Those are documented
at each use site. Re-deriving them would mean re-discovering the same bugs.

── THE ETHICAL LINE ───────────────────────────────────────────────────────────
This automates "type into a box I am already logged into". It does NOT:
  - solve CAPTCHAs or bot challenges
  - automate logging in
  - bypass a rate limit
Any of those appearing is a hard stop with a message asking for a human. That
line is deliberate; keep it.

Note that automating a chat web UI may violate the site's terms of service. That
is the operator's call to make for their own account.

── USAGE ──────────────────────────────────────────────────────────────────────
    python driver.py login  --site claude
    python driver.py ask    --site claude --prompt-file p.txt --attach deck.pdf
    python driver.py doctor --site claude

Slide decks come from NotebookLM instead, which is a wizard rather than a chat
box — a different command with its own selector block (`decks:` in the yaml):

    python driver.py login  --site notebooklm
    python driver.py deck   --site notebooklm --source deck.pdf --out out.pdf \
                            --prompt-file p.txt [--dry-run]

--dry-run walks every step except Generate and reports which selectors matched.
Use it to repair a guessed selector in about a minute instead of ~25.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

try:
    import yaml
except ImportError:
    print(json.dumps({"ok": False, "error": "pyyaml missing — pip install pyyaml"}))
    sys.exit(2)

try:
    from playwright.async_api import async_playwright
except ImportError:
    print(json.dumps({"ok": False, "error": "playwright missing — pip install playwright && playwright install chromium"}))
    sys.exit(2)

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "selectors.yaml"
PROFILES = HERE / "profiles"          # one per site; never your real Chrome profile
ARTIFACTS = HERE / "artifacts"        # HTML/screenshot dumps when something fails

# Long prompts are pasted rather than typed: typing 2,000+ characters at "human
# speed" is both implausible and glacially slow.
PASTE_THRESHOLD = 800


# ── Config ────────────────────────────────────────────────────────────────────
@dataclass
class Site:
    id: str
    display_name: str
    url: str
    headless_ok: bool = False
    input: list[str] = field(default_factory=list)
    submit: list[str] = field(default_factory=list)
    send_key: str = "Enter"
    file_input: list[str] = field(default_factory=list)
    assistant_turn: list[str] = field(default_factory=list)
    stop_button: list[str] = field(default_factory=list)
    streaming_marker: list[str] = field(default_factory=list)
    ready_selector: list[str] = field(default_factory=list)
    strip_patterns: list[str] = field(default_factory=list)
    login_selectors: list[str] = field(default_factory=list)
    rate_limit_selectors: list[str] = field(default_factory=list)
    challenge_selectors: list[str] = field(default_factory=list)
    poll_ms: int = 700
    stability_samples: int = 4
    confirm_samples: int = 3
    stall_timeout_s: int = 90
    hard_timeout_s: int = 600


def load_site(site_id: str) -> Site:
    with open(CONFIG, encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh)
    raw = (cfg.get("sites") or {}).get(site_id)
    if not raw:
        have = ", ".join((cfg.get("sites") or {}).keys())
        raise SystemExit(f"unknown site {site_id!r}; configured: {have}")
    known = {f for f in Site.__dataclass_fields__ if f != "id"}
    return Site(id=site_id, **{k: v for k, v in raw.items() if k in known})


@dataclass
class DeckSite:
    """A multi-step deck generator (NotebookLM), not a chat composer.

    Kept SEPARATE from Site rather than widening it with a dozen optional
    fields. Site is the contract cmd_ask, wait_for_completion and cmd_doctor all
    read; every field added there is a field those three have to know to ignore.
    The two shapes have nothing in common but the browser.

    ── THE ONE SHARED CONTRACT ────────────────────────────────────────────────
    check_blockers() — the ethical stop — reads exactly five attributes:
    `id`, `display_name`, `login_selectors`, `rate_limit_selectors` and
    `challenge_selectors`. They are spelled identically here so that function,
    and the refusal it enforces, works on both classes unmodified. Renaming one
    here silently removes the challenge/rate-limit check from this path, so
    test_driver.py pins it.
    """

    id: str
    display_name: str
    url: str
    headless_ok: bool = False

    # The wizard, in click order.
    dismiss_dialog: list[str] = field(default_factory=list)
    create_notebook: list[str] = field(default_factory=list)
    add_source_button: list[str] = field(default_factory=list)
    upload_files_button: list[str] = field(default_factory=list)
    source_file_input: list[str] = field(default_factory=list)
    source_ready: list[str] = field(default_factory=list)
    ingest_spinner: list[str] = field(default_factory=list)
    studio_tab: list[str] = field(default_factory=list)
    slide_deck_button: list[str] = field(default_factory=list)
    customize_button: list[str] = field(default_factory=list)
    prompt_input: list[str] = field(default_factory=list)
    generate_button: list[str] = field(default_factory=list)

    # Completion, and its opposite.
    artifact_ready: list[str] = field(default_factory=list)
    artifact_failed: list[str] = field(default_factory=list)
    download_trigger: list[str] = field(default_factory=list)
    download_menu_item: list[str] = field(default_factory=list)

    # Sentinels — the five-attribute contract above.
    login_selectors: list[str] = field(default_factory=list)
    rate_limit_selectors: list[str] = field(default_factory=list)
    challenge_selectors: list[str] = field(default_factory=list)

    gen_poll_ms: int = 5000
    gen_timeout_s: int = 1800
    source_timeout_s: int = 300
    download_timeout_s: int = 120


def load_deck_site(deck_id: str) -> DeckSite:
    with open(CONFIG, encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh)
    raw = (cfg.get("decks") or {}).get(deck_id)
    if not raw:
        have = ", ".join((cfg.get("decks") or {}).keys())
        raise SystemExit(f"unknown deck {deck_id!r}; configured: {have}")
    known = {f for f in DeckSite.__dataclass_fields__ if f != "id"}
    return DeckSite(id=deck_id, **{k: v for k, v in raw.items() if k in known})


def is_deck_site(site_id: str) -> bool:
    """True when this id names a deck generator rather than a chat site.

    Used by login and doctor to dispatch. Without it `login --site notebooklm`
    hits load_site() and dies with "unknown site", which would make the one
    sanctioned way to authenticate this path impossible.
    """
    try:
        with open(CONFIG, encoding="utf-8") as fh:
            cfg = yaml.safe_load(fh)
    except Exception:
        return False
    return site_id in (cfg.get("decks") or {})


class DriverError(Exception):
    """Carries a machine-readable `kind` so callers can branch without regexes."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind
        self.message = message


# ── Selector resolution ───────────────────────────────────────────────────────
async def resolve(page, candidates, timeout_ms=0, require_visible=True):
    """First candidate that matches (and is visible, if required). None if none.

    Deliberately dumb: it never guesses or repairs a selector. A miss is reported
    as a miss, because silently matching the wrong element means scraping the
    wrong text and presenting it as a real answer.
    """
    deadline = time.monotonic() + (timeout_ms / 1000)
    while True:
        for sel in candidates or []:
            try:
                loc = page.locator(sel)
                count = await loc.count()
                if count == 0:
                    continue
                if require_visible and not await loc.first.is_visible():
                    continue
                return {"selector": sel, "locator": loc, "count": count}
            except Exception:
                continue
        if time.monotonic() >= deadline:
            return None
        await asyncio.sleep(0.15)


async def any_matches(page, candidates) -> bool:
    for sel in candidates or []:
        try:
            if await page.locator(sel).count() > 0:
                return True
        except Exception:
            continue
    return False


# ── DOM → markdown ────────────────────────────────────────────────────────────
# Read the DOM, not inner_text(). The site already rendered the model's markdown
# into real elements; flattening to text destroys every structural marker the
# slide-coverage verifier keys on ("## Slide 7"). Runs as ONE evaluate call so
# the page is walked atomically — a React re-render mid-walk either throws or is
# invisible, never stitches a half-updated tree together.
DOM_TO_MARKDOWN_JS = r"""
(el) => {
  const SKIP = new Set(['BUTTON','SVG','PATH','SCRIPT','STYLE','NOSCRIPT']);
  const inline = (n) => {
    if (n.nodeType === 3) return n.nodeValue;
    if (n.nodeType !== 1 || SKIP.has(n.tagName)) return '';
    const kids = () => Array.from(n.childNodes).map(inline).join('');
    switch (n.tagName) {
      case 'BR':     return '\n';
      case 'B': case 'STRONG': return '**' + kids() + '**';
      case 'I': case 'EM':     return '*' + kids() + '*';
      case 'CODE':   return n.closest('pre') ? kids() : '`' + kids() + '`';
      case 'MARK':   return '==' + kids() + '==';
      case 'A': {
        const h = n.getAttribute('href');
        return h ? '[' + kids() + '](' + h + ')' : kids();
      }
      default: return kids();
    }
  };
  const block = (n, depth) => {
    if (n.nodeType === 3) return n.nodeValue.trim() ? n.nodeValue : '';
    if (n.nodeType !== 1 || SKIP.has(n.tagName)) return '';
    const kids = () => Array.from(n.childNodes).map(c => block(c, depth)).join('');
    switch (n.tagName) {
      case 'H1': return '\n# '      + inline(n).trim() + '\n';
      case 'H2': return '\n## '     + inline(n).trim() + '\n';
      case 'H3': return '\n### '    + inline(n).trim() + '\n';
      case 'H4': return '\n#### '   + inline(n).trim() + '\n';
      case 'H5': return '\n##### '  + inline(n).trim() + '\n';
      case 'H6': return '\n###### ' + inline(n).trim() + '\n';
      case 'P':  return '\n' + inline(n).trim() + '\n';
      case 'BLOCKQUOTE':
        return '\n' + inline(n).trim().split('\n').map(l => '> ' + l).join('\n') + '\n';
      case 'PRE': {
        const code = n.querySelector('code');
        const lang = code ? (code.className.match(/language-([\w+-]+)/) || [,''])[1] : '';
        return '\n```' + lang + '\n' + (n.innerText || '').replace(/\n$/, '') + '\n```\n';
      }
      case 'UL': case 'OL': {
        const ordered = n.tagName === 'OL';
        let i = 0, out = '\n';
        for (const li of Array.from(n.children)) {
          if (li.tagName !== 'LI') continue;
          i++;
          const pad = '  '.repeat(depth);
          const nested = Array.from(li.children).filter(c => c.tagName === 'UL' || c.tagName === 'OL');
          const own = Array.from(li.childNodes)
            .filter(c => !(c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')))
            .map(inline).join('').trim();
          out += pad + (ordered ? i + '. ' : '- ') + own + '\n';
          for (const sub of nested) out += block(sub, depth + 1);
        }
        return out;
      }
      case 'TABLE': {
        const rows = Array.from(n.querySelectorAll('tr'));
        if (!rows.length) return '';
        let out = '\n';
        rows.forEach((tr, ri) => {
          const cells = Array.from(tr.children).map(td => inline(td).trim().replace(/\|/g, '\\|'));
          out += '| ' + cells.join(' | ') + ' |\n';
          if (ri === 0) out += '| ' + cells.map(() => '---').join(' | ') + ' |\n';
        });
        return out + '\n';
      }
      case 'HR': return '\n---\n';
      default:   return kids();
    }
  };
  return block(el, 0).replace(/\n{3,}/g, '\n\n').trim();
}
"""


# ── Browser launch ────────────────────────────────────────────────────────────
def chrome_version() -> str:
    """Read the installed Chrome version so the spoofed UA never drifts stale."""
    for cmd in (
        r'(Get-Item "C:\Program Files\Google\Chrome\Application\chrome.exe").VersionInfo.ProductVersion',
        r'(Get-Item "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe").VersionInfo.ProductVersion',
    ):
        try:
            out = subprocess.run(["powershell", "-NoProfile", "-Command", cmd],
                                 capture_output=True, text=True, timeout=10)
            v = (out.stdout or "").strip()
            if re.match(r"^\d+\.", v):
                return v
        except Exception:
            continue
    return "141.0.0.0"


def headless_user_agent() -> str:
    """Headless Chrome's UA literally contains 'HeadlessChrome/141...' instead of
    'Chrome/141...', and that single token is what Cloudflare's check keys on.
    Strip it and the same headless browser loads normally.

    Narrowly scoped to one fingerprinting signal — this is not a CAPTCHA solver.
    Whether it still works depends on Cloudflare's current rules; if a real
    challenge appears anyway, we stop and ask for a human.
    """
    return (f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            f"(KHTML, like Gecko) Chrome/{chrome_version()} Safari/537.36")


async def launch(pw, site, headless: bool, visible: bool = False,
                 downloads_dir: Path | None = None):
    """Persistent per-site profile, real Chrome.

    launch_persistent_context (not launch() + storage_state) because a persistent
    user-data dir keeps IndexedDB and refresh tokens; the cookie-JSON approach
    drops them, which is why those sessions die within days. Log in once by hand
    and the profile stays authenticated for weeks, like a normal browser.

    `site` is a Site OR a DeckSite: only `.id` is read off it, which is why the
    annotation is bare. That is now load-bearing — keep it that way.

    downloads_dir turns on Playwright's download handling, and ONLY the deck
    path passes it. The chat path stays byte-identical: a download appearing
    while scraping a chat answer is a symptom, not a feature, and accepting it
    globally would hide that.
    """
    profile = PROFILES / site.id
    profile.mkdir(parents=True, exist_ok=True)
    args = [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    if headless:
        args.append(f"--user-agent={headless_user_agent()}")
    elif not visible:
        # Headful but parked off-screen: fully real and rendering, just not on
        # anyone's monitor. The practical answer to a site that detects headless.
        args.append("--window-position=-32000,-32000")

    extra = {}
    if downloads_dir is not None:
        downloads_dir.mkdir(parents=True, exist_ok=True)
        extra = {"accept_downloads": True, "downloads_path": str(downloads_dir)}

    ctx = await pw.chromium.launch_persistent_context(
        user_data_dir=str(profile),
        channel="chrome",
        headless=headless,
        args=args,
        viewport={"width": 1280, "height": 900},
        **extra,
    )
    return ctx


def looks_like_pdf(head: bytes) -> bool:
    """True when these first bytes are a real PDF header.

    A pure function so it is testable without a browser. The failure it catches
    is specific and silent: a site that answers an expired-session redirect or
    an error page, saved under a .pdf name. Without this the job reports success
    and files an HTML document into the class as a slide deck.
    """
    return bool(head) and head[:5] == b"%PDF-"


async def save_artifacts(page, tag: str) -> str:
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    base = ARTIFACTS / f"{tag}-{stamp}"
    try:
        (base.with_suffix(".html")).write_text(await page.content(), encoding="utf-8")
        await page.screenshot(path=str(base.with_suffix(".png")), full_page=False)
    except Exception:
        pass
    return str(base)


# ── Sentinels ─────────────────────────────────────────────────────────────────
async def check_blockers(page, site: Site, *, pre_send: bool):
    """Fail fast and loudly. Never try to solve a challenge or log in."""
    if await any_matches(page, site.challenge_selectors):
        raise DriverError("bot_challenge",
                          f"{site.display_name} showed a human-verification challenge. "
                          f"Run:  python driver.py login --site {site.id}")
    if await any_matches(page, site.rate_limit_selectors):
        raise DriverError("rate_limited",
                          f"{site.display_name} says the usage limit is reached. Wait for the reset.")
    # Only pre-send: several UIs keep a permanent "Log in" control visible in the
    # sidebar even while happily answering, so checking mid-answer aborts healthy
    # runs. A session that genuinely dies mid-generation surfaces as a stall.
    if pre_send and await any_matches(page, site.login_selectors):
        raise DriverError("needs_login",
                          f"Not signed in to {site.display_name}. Run:  python driver.py login --site {site.id}")


# ── Send ──────────────────────────────────────────────────────────────────────
async def type_prompt(page, box, text: str):
    """Real keyboard events only.

    NEVER set .value / .textContent: these composers are React/ProseMirror/Quill
    based and listen for input events. Assigning directly leaves the framework's
    state unaware, so the send button stays disabled and nothing sends.

    Newlines go as Shift+Enter — plain Enter SUBMITS. Typing "a\\nb\\nc" with
    literal newlines sends "a" and abandons "bc" in the box.
    """
    await box.click()
    # Clear any stale draft the profile kept from a previous run.
    await page.keyboard.press("Control+A")
    await page.keyboard.press("Delete")

    if len(text) >= PASTE_THRESHOLD:
        # A person would paste this much. CDP insertText fires the input events
        # the framework needs, unlike a direct value assignment.
        cdp = await page.context.new_cdp_session(page)
        for i, line in enumerate(text.split("\n")):
            if i:
                await page.keyboard.press("Shift+Enter")
            if line:
                await cdp.send("Input.insertText", {"text": line})
        return

    for line_i, line in enumerate(text.split("\n")):
        if line_i:
            await page.keyboard.press("Shift+Enter")
        i = 0
        while i < len(line):
            n = random.randint(18, 60)
            await page.keyboard.type(line[i:i + n], delay=random.uniform(8, 26))
            i += n
            if random.random() < 0.25:
                await asyncio.sleep(random.uniform(0.12, 0.45))


async def attach_files(page, site: Site, paths: list[Path]):
    """Attach before typing — how a person uses the composer."""
    if not paths:
        return
    box = await resolve(page, site.file_input, timeout_ms=3000, require_visible=False)
    if not box:
        raise DriverError("no_file_input",
                          f"No file input matched on {site.display_name}; "
                          f"{len(paths)} attachment(s) could not be sent.")
    await box["locator"].first.set_input_files([str(p) for p in paths])
    # The site renders the preview and finishes reading the file asynchronously
    # after set_input_files resolves; sending immediately can drop the upload.
    await asyncio.sleep(2.5)


# ── Completion ────────────────────────────────────────────────────────────────
async def read_latest(page, site: Site) -> tuple[str, int]:
    r = await resolve(page, site.assistant_turn, timeout_ms=0, require_visible=False)
    if not r or r["count"] == 0:
        return "", 0
    node = r["locator"].nth(r["count"] - 1)
    try:
        return ((await node.evaluate(DOM_TO_MARKDOWN_JS)) or "").strip(), r["count"]
    except Exception:
        # Node swapped mid-read by a re-render: treat as "not ready", fall back
        # to plain text so a serializer failure degrades rather than losing it.
        try:
            return (await node.inner_text()).strip(), r["count"]
        except Exception:
            return "", r["count"]


async def wait_for_completion(page, site: Site, baseline: tuple[str, int],
                              saw_active: bool = False) -> dict:
    """Four layered gates. See the module docstring of MAGI's completion.py.

    1. BASELINE. Snapshot turn count AND last-turn text before sending. Two UI
       shapes exist: append-style (a new node per answer -> count grows) and
       fill-style (an empty node pre-rendered, answer streams into it -> count
       never changes). Without checking BOTH, a race returns the PREVIOUS
       answer and it looks completely valid. This is the nastiest failure here.
    2. STREAMING MARKER / STOP BUTTON appearing then clearing — the site telling
       us directly that it finished. The only semantically clean signals.
    3. CONFIRM WINDOW. A cleared signal is necessary but not sufficient: some
       UIs emit a preamble, clear the flag while thinking, then stream the real
       answer into the same node. Require N consecutive identical polls AFTER
       the signal clears.
    4. STALL / HARD TIMEOUT so nothing hangs forever.
    """
    base_text, base_turns = baseline
    started = time.monotonic()
    last_text, last_growth = "", time.monotonic()
    stable = 0
    poll = site.poll_ms / 1000

    while True:
        await asyncio.sleep(poll)
        elapsed = time.monotonic() - started

        if elapsed > site.hard_timeout_s:
            return {"text": last_text, "reason": "hard_timeout", "clean": False}

        await check_blockers(page, site, pre_send=False)

        text, turns = await read_latest(page, site)

        # Gate 1 — must be a genuinely NEW answer, by either UI shape.
        is_new = turns > base_turns or (text and text != base_text)
        if not is_new:
            if time.monotonic() - last_growth > site.stall_timeout_s:
                return {"text": "", "reason": "stall_timeout", "clean": False}
            continue

        if text != last_text:
            last_text, last_growth, stable = text, time.monotonic(), 0
        else:
            stable += 1

        # Gate 2 — is the site still generating?
        active = False
        if site.streaming_marker and await any_matches(page, site.streaming_marker):
            active = True
        if not active and site.stop_button:
            r = await resolve(page, site.stop_button, timeout_ms=0, require_visible=True)
            active = bool(r)
        if active:
            saw_active = True
            stable = 0
            last_growth = time.monotonic()
            continue

        # Gate 3 — signal cleared; require sustained quiet before believing it.
        if saw_active:
            if stable >= site.confirm_samples and last_text:
                return {"text": last_text, "reason": "stream_marker", "clean": True}
        elif stable >= site.stability_samples and last_text:
            # Never saw a semantic signal — probably fine, but say so.
            return {"text": last_text, "reason": "stability", "clean": False}

        if time.monotonic() - last_growth > site.stall_timeout_s:
            return {"text": last_text, "reason": "stall_timeout", "clean": bool(last_text)}


def strip_trailing(text: str, patterns: list[str]) -> str:
    """Remove known chrome from an answer.

    Applied REPEATEDLY until nothing more matches, because the prefix patterns
    are anchored to the start of the text: Claude narrates several tool-use
    lines in a row when a file is attached, and a single pass removes only the
    first, leaving the rest at the top of the generated note.

    Bounded so a pattern that can match its own output cannot spin forever.
    """
    for _ in range(10):
        before = text
        for p in patterns or []:
            text = re.sub(p, "", text)
        if text == before:
            break
    return text.strip()


# ── Deck generation (NotebookLM) ──────────────────────────────────────────────
# EVERYTHING GOOGLE-SPECIFIC LIVES BELOW THIS LINE.
#
# The chat path scrapes text; this one drives a seven-step wizard and catches a
# real file download. Sharing wait_for_completion between them was considered
# and rejected: its four gates exist to answer "text is streaming into a node,
# has it stopped?" — a question with no meaning here, where there is no text and
# no stream, only a state that flips.
#
# The point of this section being one flat sequence is that when Google changes
# the UI, you read it top to bottom against the artifacts/ dump and fix one
# selector. Keep it flat. Resist extracting clever helpers.


async def _dismiss_overlays(page, site: DeckSite, walked: dict) -> None:
    """Close any announcement modal sitting over the app.

    Google ships product-announcement dialogs that cover the whole UI and
    swallow every click behind them — the first live run of this flow hit one
    ("We are giving you more flexibility...") and failed three steps later
    pointing at an innocent selector.

    Best-effort by design: no dialog is the normal case, so a miss is silence,
    never an error. Loops because dismissing one can reveal another.
    """
    for _ in range(3):
        hit = await resolve(page, site.dismiss_dialog, timeout_ms=1200)
        if not hit:
            return
        try:
            await hit["locator"].first.click()
            walked.setdefault("dismiss_dialog", hit["selector"])
            await asyncio.sleep(0.8)
        except Exception:
            return


async def _step(page, site: DeckSite, field_name: str, kind: str, *,
                timeout_ms: int = 15000, require_visible: bool = True,
                click: bool = True):
    """Resolve one wizard selector, optionally click it, or fail by name.

    Each step carries its OWN error kind and its OWN artifact tag. A single
    generic nlm_step_failed would leave the repair loop guessing which of seven
    steps broke, which is most of the cost of fixing a guessed selector.
    """
    r = await resolve(page, getattr(site, field_name), timeout_ms=timeout_ms,
                      require_visible=require_visible)
    if not r:
        path = await save_artifacts(page, f"{site.id}-{field_name}")
        raise DriverError(
            kind,
            f"{site.display_name}: no element matched `{field_name}`. "
            f"The selector guess is wrong — repair it in selectors.yaml under "
            f"decks.{site.id}.{field_name}. Artifacts: {path}")
    if click:
        await r["locator"].first.click()
    return r


async def _wait_for_deck(page, site: DeckSite):
    """Block until the generated artifact exists, or say why it never will.

    State-based, never a fixed sleep: generation time is genuinely unpredictable
    and a sleep long enough to be safe wastes that long on every run.

    Three deliberate differences from the chat poller:

      * Polls every gen_poll_ms (5s), not 700ms. A 30-minute wait at 700ms is
        ~2,500 DOM queries that tell us nothing new, and it reads as automation.
      * Checks FAILURE BEFORE SUCCESS. If a failed artifact row still matches
        the ready selector — plausible, same row with a different badge —
        checking ready first reports success and then hands back a download
        that never comes. Failure wins ties.
      * No stall timeout. There is no growth signal to stall on; the only
        honest bound is the hard deadline.
    """
    deadline = time.monotonic() + site.gen_timeout_s
    while time.monotonic() < deadline:
        await asyncio.sleep(site.gen_poll_ms / 1000)

        # The ethical stop, on every poll: a challenge or a limit appearing
        # mid-generation is reported, never worked around.
        await check_blockers(page, site, pre_send=False)

        if await any_matches(page, site.artifact_failed):
            path = await save_artifacts(page, f"{site.id}-generation-failed")
            raise DriverError(
                "nlm_generation_failed",
                f"{site.display_name} reported that generation failed. "
                f"Artifacts: {path}")

        if await resolve(page, site.artifact_ready, timeout_ms=0,
                         require_visible=True):
            return

    path = await save_artifacts(page, f"{site.id}-timeout")
    raise DriverError(
        "nlm_timeout",
        f"no finished deck after {site.gen_timeout_s}s. If the deck DID finish "
        f"on screen, `artifact_ready` is the wrong selector — fix that before "
        f"raising gen_timeout_s. Artifacts: {path}")


async def _download_deck(page, site: DeckSite, dest: Path) -> Path:
    """Click through to the PDF and save it where the caller asked.

    expect_download WRAPS the click rather than listening after it: the download
    event can fire before a post-click await resolves, and a listener attached
    afterwards races it and hangs until timeout.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    async with page.expect_download(
            timeout=site.download_timeout_s * 1000) as dl_info:
        trigger = await resolve(page, site.download_trigger, timeout_ms=10000)
        if not trigger:
            path = await save_artifacts(page, f"{site.id}-no-download")
            raise DriverError(
                "nlm_no_download",
                f"nothing matched `download_trigger` on {site.display_name}. "
                f"Artifacts: {path}")
        await trigger["locator"].first.click()

        # Optional: only if the Download control opened a menu. Whether it is a
        # direct button or an overflow item differs between UI revisions, so
        # tolerate both rather than guessing one.
        menu = await resolve(page, site.download_menu_item, timeout_ms=3000)
        if menu:
            await menu["locator"].first.click()

    download = await dl_info.value
    # save_as, not download.path(): the latter points into a temp area that is
    # cleaned up when the browser context closes.
    await download.save_as(str(dest))

    # Validate HERE, where the bytes first exist, not only at the client.
    if not dest.exists() or dest.stat().st_size == 0:
        raise DriverError("nlm_empty_download",
                          "the download saved zero bytes")
    head = dest.read_bytes()[:5]
    if not looks_like_pdf(head):
        raise DriverError(
            "nlm_not_pdf",
            f"the downloaded file is not a PDF (starts {head!r}) — "
            f"probably an error or sign-in page saved under a .pdf name")
    return dest


async def run_notebooklm_flow(page, site: DeckSite, source: Path, prompt: str,
                              dest: Path, dry_run: bool = False) -> dict:
    """Source PDF + prompt -> a generated slide deck on disk.

    The ONLY function that knows what NotebookLM's UI looks like. When Google
    changes it, this is the blast radius.
    """
    walked: dict[str, str] = {}

    await page.goto(site.url, wait_until="domcontentloaded", timeout=60000)
    await check_blockers(page, site, pre_send=True)

    # 0. Announcement modals cover the app and swallow every click behind them.
    #    Best-effort and deliberately NOT a _step: it is absent on most runs,
    #    and a missing dialog is the normal case, not a failure.
    await _dismiss_overlays(page, site, walked)

    # 1. A fresh notebook per run: reusing one would mix sources, and the deck
    #    is generated from everything the notebook contains.
    r = await _step(page, site, "create_notebook", "nlm_no_create")
    walked["create_notebook"] = r["selector"]
    await asyncio.sleep(2.0)
    # Creating the notebook can raise its own first-run dialog.
    await _dismiss_overlays(page, site, walked)

    # 2. Open the upload dialog. THE FILE INPUT DOES NOT EXIST UNTIL THIS IS
    #    CLICKED — waiting for one on the bare notebook page waits forever.
    r = await _step(page, site, "add_source_button", "nlm_no_add_source")
    walked["add_source_button"] = r["selector"]
    await asyncio.sleep(1.5)

    # 3. The source itself.
    #
    #    "Upload files" opens a NATIVE OS file chooser; it does not put an
    #    input[type=file] in the DOM, which is why waiting for one timed out.
    #    expect_file_chooser intercepts that dialog — it must WRAP the click,
    #    because the event fires during it.
    #
    #    Some layouts do expose a hidden input instead, so that is kept as a
    #    fallback rather than deleted.
    upload_btn = await resolve(page, site.upload_files_button, timeout_ms=8000)
    if upload_btn:
        walked["upload_files_button"] = upload_btn["selector"]
        try:
            async with page.expect_file_chooser(timeout=15000) as fc_info:
                await upload_btn["locator"].first.click()
            chooser = await fc_info.value
            await chooser.set_files(str(source))
            walked["source_file_input"] = "(native file chooser)"
        except Exception as e:
            path = await save_artifacts(page, f"{site.id}-file-chooser")
            raise DriverError(
                "nlm_no_file_input",
                f"the file chooser never opened or rejected the file: "
                f"{str(e)[:120]}. Artifacts: {path}")
    else:
        r = await _step(page, site, "source_file_input", "nlm_no_file_input",
                        timeout_ms=20000, require_visible=False, click=False)
        walked["source_file_input"] = r["selector"]
        await r["locator"].first.set_input_files([str(source)])

    # 4. Wait for INGEST TO FINISH, which is not the same as the file appearing.
    #
    #    The source row shows up the instant the upload starts. Treating that as
    #    ready meant clicking Studio controls that were still greyed out: the
    #    click silently did nothing (they are styled divs, so Playwright reports
    #    them enabled and does not complain) and the run failed later pointing
    #    at an innocent selector. The spinner going away is the honest signal.
    r = await resolve(page, site.source_ready,
                      timeout_ms=site.source_timeout_s * 1000)
    if not r:
        path = await save_artifacts(page, f"{site.id}-source-ready")
        raise DriverError(
            "nlm_source_timeout",
            f"the source never appeared after {site.source_timeout_s}s. "
            f"Artifacts: {path}")
    walked["source_ready"] = r["selector"]

    deadline = time.monotonic() + site.source_timeout_s
    while time.monotonic() < deadline:
        if not await any_matches(page, site.ingest_spinner):
            break
        await asyncio.sleep(2.5)
    else:
        path = await save_artifacts(page, f"{site.id}-ingest-stuck")
        raise DriverError(
            "nlm_source_timeout",
            f"the source was still processing after {site.source_timeout_s}s. "
            f"Artifacts: {path}")
    # The panel enables its controls a beat after the spinner clears.
    await asyncio.sleep(3.0)

    # 4. Into the Studio panel and onto the Slide Deck generator.
    #
    #    studio_tab is OPTIONAL: the Studio is a panel that is already open on
    #    the right in the current layout, so there is nothing to click. Treating
    #    a miss as failure would break a working run over a control that only
    #    exists when the panel is collapsed.
    opt = await resolve(page, site.studio_tab, timeout_ms=2000)
    if opt:
        walked["studio_tab"] = opt["selector"]
        await opt["locator"].first.click()
        await asyncio.sleep(1.0)
    else:
        walked["studio_tab"] = "(already open — nothing to click)"

    r = await _step(page, site, "slide_deck_button", "nlm_no_slide_deck")
    walked["slide_deck_button"] = r["selector"]
    await asyncio.sleep(3.0)

    # Customize is OPTIONAL: on the current layout Slide Deck opens its prompt
    # directly. Required here would fail a run that is working fine.
    opt = await resolve(page, site.customize_button, timeout_ms=3000)
    if opt:
        walked["customize_button"] = opt["selector"]
        await opt["locator"].first.click()
        await asyncio.sleep(2.0)
    else:
        walked["customize_button"] = "(not needed — prompt opens directly)"

    # 5. The custom prompt. type_prompt() is reused deliberately: above 800
    #    chars it pastes via CDP insertText, which is exactly the case a real
    #    study prompt hits, and assigning .value to an Angular control leaves
    #    the framework unaware so Generate stays disabled.
    r = await _step(page, site, "prompt_input", "nlm_no_prompt_input",
                    click=False)
    walked["prompt_input"] = r["selector"]
    await type_prompt(page, r["locator"].first, prompt)

    # 6. The dry-run stop. Everything above is cheap, and every selector above
    #    has now been proven against the live page; Generate is the expensive,
    #    slow, account-visible part. Stopping here is what makes repairing a
    #    guessed selector a one-minute loop instead of a 25-minute one.
    if dry_run:
        path = await save_artifacts(page, f"{site.id}-dryrun")
        return {"dryRun": True, "matched": walked,
                "stoppedAt": "before Generate", "artifacts": path}

    r = await _step(page, site, "generate_button", "nlm_no_generate")
    walked["generate_button"] = r["selector"]

    await _wait_for_deck(page, site)
    out = await _download_deck(page, site, dest)
    return {"dryRun": False, "matched": walked, "pdfPath": str(out),
            "bytes": out.stat().st_size}


# ── Commands ──────────────────────────────────────────────────────────────────
async def cmd_ask(args) -> dict:
    site = load_site(args.site)
    prompt = Path(args.prompt_file).read_text(encoding="utf-8") if args.prompt_file else args.prompt
    if not prompt or not prompt.strip():
        raise DriverError("bad_input", "empty prompt")

    attachments = []
    for a in args.attach or []:
        p = Path(a)
        if not p.exists():
            raise DriverError("bad_input", f"attachment not found: {a}")
        attachments.append(p)

    headless = site.headless_ok and not args.headful
    async with async_playwright() as pw:
        ctx = await launch(pw, site, headless=headless)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        try:
            await page.goto(site.url, wait_until="domcontentloaded", timeout=60000)
            if site.ready_selector:
                await resolve(page, site.ready_selector, timeout_ms=30000, require_visible=False)
            await check_blockers(page, site, pre_send=True)

            box = await resolve(page, site.input, timeout_ms=20000)
            if not box:
                path = await save_artifacts(page, f"{site.id}-no-input")
                raise DriverError("no_input", f"Composer not found on {site.display_name}. Artifacts: {path}")

            baseline = await read_latest(page, site)
            await attach_files(page, site, attachments)
            await type_prompt(page, box["locator"].first, prompt)

            sent = await resolve(page, site.submit, timeout_ms=4000)
            if sent:
                await sent["locator"].first.click()
            else:
                await page.keyboard.press(site.send_key)

            # Catch the generation signal before the main poll loop starts.
            # Measured against live Claude: both signals DO fire, but a short
            # answer can finish inside one 700ms poll, so the loop never sees
            # them and the result is downgraded to low-confidence "stability"
            # even though generation completed cleanly. Sampling fast for the
            # first couple of seconds closes that window. A long deck rewrite
            # never needed this; a short one silently lost its clean signal.
            saw_signal = False
            for _ in range(20):                       # 2s at 100ms
                await asyncio.sleep(0.1)
                if site.streaming_marker and await any_matches(page, site.streaming_marker):
                    saw_signal = True
                    break
                if site.stop_button and await resolve(page, site.stop_button, timeout_ms=0):
                    saw_signal = True
                    break

            out = await wait_for_completion(page, site, baseline, saw_active=saw_signal)
            text = strip_trailing(out["text"], site.strip_patterns)
            if not text:
                path = await save_artifacts(page, f"{site.id}-empty")
                raise DriverError("empty_answer", f"No answer captured ({out['reason']}). Artifacts: {path}")
            return {"ok": True, "site": site.id, "text": text,
                    "reason": out["reason"], "clean": out["clean"], "chars": len(text)}
        finally:
            await ctx.close()


async def cmd_deck(args) -> dict:
    """Generate a slide deck through a multi-step site and save the PDF.

    Same shape as cmd_ask — one JSON line out, ctx closed in a finally — so it
    slots into main()'s dispatch and error wrapper unchanged.
    """
    site = load_deck_site(args.site)
    prompt = (Path(args.prompt_file).read_text(encoding="utf-8")
              if args.prompt_file else args.prompt)
    if not prompt or not prompt.strip():
        raise DriverError("bad_input", "empty prompt")

    source = Path(args.source)
    if not source.exists():
        raise DriverError("bad_input", f"source not found: {args.source}")
    dest = Path(args.out)

    headless = site.headless_ok and not args.headful
    async with async_playwright() as pw:
        # downloads_dir is what turns on Playwright download handling; only
        # this path passes it.
        ctx = await launch(pw, site, headless=headless,
                           downloads_dir=dest.parent)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        try:
            out = await run_notebooklm_flow(
                page, site, source, prompt, dest,
                dry_run=bool(getattr(args, "dry_run", False)))
            return {"ok": True, "site": site.id, **out}
        except DriverError:
            # Already carries its own artifact path from _step / the waiters.
            raise
        except Exception as e:
            # A raw Playwright error (a click timing out on a control that
            # resolved but never became clickable) would otherwise escape with
            # no HTML and no screenshot — which is exactly the failure that is
            # hardest to diagnose, because the message names a selector that
            # matched rather than the step that was actually wrong.
            path = await save_artifacts(page, f"{site.id}-unexpected")
            raise DriverError(
                "unexpected", f"{str(e)[:220]} Artifacts: {path}")
        finally:
            await ctx.close()


async def cmd_login(args) -> dict:
    """Open the site visibly so a human can sign in once. Never automated.

    Dispatches on whether the id names a chat site or a deck generator. Without
    this, `login --site notebooklm` dies with "unknown site" and the one
    sanctioned way to authenticate that path would not exist.
    """
    site = load_deck_site(args.site) if is_deck_site(args.site) else load_site(args.site)
    async with async_playwright() as pw:
        ctx = await launch(pw, site, headless=False, visible=True)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(site.url, wait_until="domcontentloaded", timeout=60000)
        print(f"\n  A browser window is open for {site.display_name}.")
        print("  Sign in (and clear any challenge) by hand, then press Enter here.\n")
        await asyncio.get_event_loop().run_in_executor(None, input)
        logged_in = not await any_matches(page, site.login_selectors)
        await ctx.close()
        return {"ok": True, "site": site.id, "logged_in": logged_in,
                "profile": str(PROFILES / site.id)}


async def _doctor_deck(args) -> dict:
    """Which deck selectors match on the LANDING page — and, honestly, which
    cannot be checked from there at all.

    Only create_notebook and the sentinels exist before a notebook is open.
    Reporting studio_tab or prompt_input as "missing" here would be a false
    alarm on every single run, and a check that always cries wolf is a check
    you learn to ignore. They are listed as `unchecked` instead, pointing at
    the dry-run probe that CAN verify them.
    """
    site = load_deck_site(args.site)
    headless = site.headless_ok and not args.headful
    async with async_playwright() as pw:
        ctx = await launch(pw, site, headless=headless)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        try:
            await page.goto(site.url, wait_until="domcontentloaded", timeout=60000)
            r = await resolve(page, site.create_notebook, timeout_ms=15000)
            return {
                "ok": True, "site": site.id, "kind": "deck",
                "signed_in": not await any_matches(page, site.login_selectors),
                "challenge": await any_matches(page, site.challenge_selectors),
                "matched": {"create_notebook": r["selector"] if r else None},
                "missing": [] if r else ["create_notebook"],
                "unchecked": ["source_file_input", "source_ready", "studio_tab",
                              "slide_deck_button", "customize_button",
                              "prompt_input", "generate_button",
                              "artifact_ready", "artifact_failed",
                              "download_trigger", "download_menu_item"],
                "note": ("the unchecked selectors only exist once a notebook is "
                         "open — probe them with:  deck --dry-run"),
            }
        finally:
            await ctx.close()


async def cmd_doctor(args) -> dict:
    """Report which selectors still match — the early warning for UI churn."""
    if is_deck_site(args.site):
        return await _doctor_deck(args)
    site = load_site(args.site)
    headless = site.headless_ok and not args.headful
    async with async_playwright() as pw:
        ctx = await launch(pw, site, headless=headless)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        try:
            await page.goto(site.url, wait_until="domcontentloaded", timeout=60000)
            if site.ready_selector:
                await resolve(page, site.ready_selector, timeout_ms=20000, require_visible=False)
            report = {}
            for field_name in ("input", "submit", "file_input", "assistant_turn",
                               "stop_button", "streaming_marker", "ready_selector"):
                cands = getattr(site, field_name)
                r = await resolve(page, cands, timeout_ms=0,
                                  require_visible=field_name in ("input", "submit"))
                report[field_name] = r["selector"] if r else None
            return {
                "ok": True, "site": site.id,
                "signed_in": not await any_matches(page, site.login_selectors),
                "challenge": await any_matches(page, site.challenge_selectors),
                "matched": report,
                "missing": [k for k, v in report.items() if v is None and getattr(site, k)],
            }
        finally:
            await ctx.close()


def main():
    ap = argparse.ArgumentParser(description="StudyOS browser driver")
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("ask", help="run a prompt and print the answer as JSON")
    a.add_argument("--site", default="claude")
    a.add_argument("--prompt")
    a.add_argument("--prompt-file")
    a.add_argument("--attach", action="append")
    a.add_argument("--headful", action="store_true", help="force a real window")

    dk = sub.add_parser("deck", help="generate a slide deck and save the PDF")
    dk.add_argument("--site", default="notebooklm")
    dk.add_argument("--prompt")
    dk.add_argument("--prompt-file")
    dk.add_argument("--source", required=True, help="the source PDF to upload")
    dk.add_argument("--out", required=True, help="where to save the generated PDF")
    dk.add_argument("--headful", action="store_true", help="force a real window")
    dk.add_argument("--dry-run", action="store_true",
                    help="walk the wizard and stop before Generate, reporting "
                         "which selectors matched — the cheap repair loop")

    lo = sub.add_parser("login", help="open the site so a human can sign in")
    lo.add_argument("--site", default="claude")

    d = sub.add_parser("doctor", help="check which selectors still match")
    d.add_argument("--site", default="claude")
    d.add_argument("--headful", action="store_true")

    args = ap.parse_args()
    fn = {"ask": cmd_ask, "deck": cmd_deck,
          "login": cmd_login, "doctor": cmd_doctor}[args.cmd]
    try:
        print(json.dumps(asyncio.run(fn(args)), ensure_ascii=False))
    except DriverError as e:
        print(json.dumps({"ok": False, "kind": e.kind, "error": e.message}, ensure_ascii=False))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"ok": False, "kind": "unexpected", "error": str(e)[:500]}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
