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
import os
import random
import re
import shutil
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
    generate_later_button: list[str] = field(default_factory=list)
    artifact_ready: list[str] = field(default_factory=list)
    artifact_generating: list[str] = field(default_factory=list)
    artifact_failed: list[str] = field(default_factory=list)
    artifact_queued: list[str] = field(default_factory=list)
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


@dataclass
class ReelsSite:
    """A saved-collection harvester (Instagram), not a chat box and not a wizard.

    A third shape beside Site and DeckSite, for the same reason those two are
    separate: an infinite-scroll grid harvest has nothing in common with either
    but the browser. Widening one of them would add a dozen fields the other
    paths must know to ignore.

    ── THE ONE SHARED CONTRACT ────────────────────────────────────────────────
    check_blockers() reads exactly five attributes: `id`, `display_name`,
    `login_selectors`, `rate_limit_selectors` and `challenge_selectors`. They
    are spelled identically here so the ethical stop — challenge and rate limit
    detected, never solved — works on this path unmodified. Renaming one here
    silently removes that check from the scraper, so test_driver.py pins it.
    """

    id: str
    display_name: str
    url: str
    headless_ok: bool = False
    saved_url: str = ""

    # The grid.
    grid_container: list[str] = field(default_factory=list)
    reel_link: list[str] = field(default_factory=list)
    reel_thumb: list[str] = field(default_factory=list)
    reel_caption: list[str] = field(default_factory=list)

    # Readiness / end-of-feed. loading_more OUTRANKS everything — see
    # _harvest_reels: a spinner still on screen must never read as "done".
    loading_more: list[str] = field(default_factory=list)
    empty_sentinel: list[str] = field(default_factory=list)

    # Sentinels — the five-attribute contract above.
    login_selectors: list[str] = field(default_factory=list)
    rate_limit_selectors: list[str] = field(default_factory=list)
    challenge_selectors: list[str] = field(default_factory=list)

    # Pacing. Ranges, not constants: a fixed delay is a recognisable pattern.
    scroll_pause_s: list[float] = field(default_factory=lambda: [1.5, 4.0])
    settle_pause_s: list[float] = field(default_factory=lambda: [0.8, 2.0])
    max_scrolls: int = 40
    stall_polls: int = 3
    poll_ms: int = 1200
    nav_timeout_s: int = 60
    # Bounds for the loading-wait branch and for the harvest as a whole. Both
    # exist because `max_scrolls` does not bound a branch that never scrolls.
    max_waits: int = 12
    harvest_timeout_s: int = 600


def load_reels_site(site_id: str) -> ReelsSite:
    with open(CONFIG, encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh)
    raw = (cfg.get("reels") or {}).get(site_id)
    if not raw:
        have = ", ".join((cfg.get("reels") or {}).keys())
        raise SystemExit(f"unknown reels site {site_id!r}; configured: {have}")
    known = {f for f in ReelsSite.__dataclass_fields__ if f != "id"}
    return ReelsSite(id=site_id, **{k: v for k, v in raw.items() if k in known})


def is_reels_site(site_id: str) -> bool:
    """True when this id names a saved-collection harvester.

    Same role as is_deck_site: without it `login --site instagram` would hit
    load_site(), die with "unknown site", and make the one sanctioned way to
    authenticate this path impossible.
    """
    try:
        with open(CONFIG, encoding="utf-8") as fh:
            cfg = yaml.safe_load(fh)
    except Exception:
        return False
    return site_id in (cfg.get("reels") or {})


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

    The poll order is the contract, and it is not arbitrary:

      1. GENERATING wins over everything, ready included. While the Studio
         says it is building, no other row on the page can mean 'done' — see
         the measured failure at that check. This is what makes a drifted
         readiness selector cost a timeout instead of a wrong menu click.
      2. READY beats FAILED. A notebook keeps every artifact it has produced,
         so a failed deck from an earlier attempt sits in the same list as the
         one that just succeeded; failure only matters when nothing is usable.
      3. QUEUED is its own verdict, neither progress nor failure.

    Two further differences from the chat poller:

      * Polls every gen_poll_ms (5s), not 700ms. A 30-minute wait at 700ms is
        ~2,500 DOM queries that tell us nothing new, and it reads as automation.
      * No stall timeout. There is no growth signal to stall on; the only
        honest bound is the hard deadline.
    """
    deadline = time.monotonic() + site.gen_timeout_s
    while time.monotonic() < deadline:
        await asyncio.sleep(site.gen_poll_ms / 1000)

        # The ethical stop, on every poll: a challenge or a limit appearing
        # mid-generation is reported, never worked around.
        await check_blockers(page, site, pre_send=False)

        # STILL BUILDING beats every other verdict, including ready.
        #
        # MEASURED, 2026-09-14: a readiness selector matched the GENERATING
        # placeholder row (it carries .artifact-primary-content and has no
        # failure subtitle), so this loop returned while the deck was still
        # being built. _download_deck then found the page's only 'More' button
        # — the SOURCE row's kebab in the left panel — and opened
        # 'Remove source / Rename source', failing with a message that blamed
        # the menu selector. The readiness selector has been tightened, but
        # the ordering is the structural fix: while NotebookLM says it is
        # generating, nothing else on the page can mean 'done'. A selector
        # that drifts again costs a timeout, not a wrong menu.
        #
        # Deliberately BEFORE the ready check, and `continue` rather than a
        # verdict: generating is a transient state, and the only honest
        # response is to keep waiting until the hard deadline.
        if await any_matches(page, site.artifact_generating):
            continue

        # A READY row wins over a failed one, always.
        #
        # Order reversed on purpose from the earlier version. A notebook keeps
        # every artifact it has produced, so a failed deck from a previous
        # attempt lives in the same list as the one that just succeeded —
        # and checking failure first aborted runs whose own deck was sitting
        # right there, finished. Failure only matters when nothing is usable.
        if await resolve(page, site.artifact_ready, timeout_ms=0,
                         require_visible=True):
            return

        if await any_matches(page, site.artifact_failed):
            # Do not give up while something is still being built: the failed
            # row may be old news and this run's deck may still be coming.
            if await any_matches(page, site.artifact_generating):
                continue
            path = await save_artifacts(page, f"{site.id}-generation-failed")
            raise DriverError(
                "nlm_generation_failed",
                f"{site.display_name} reported that generation failed. "
                f"Artifacts: {path}")

        # DEFERRED, which is neither progress nor failure. Out of quota,
        # NotebookLM schedules the deck for the next window instead of
        # refusing, and the row then sits still for hours. Polling it to the
        # deadline would report a timeout that blames the ready selector, so
        # this is checked every round and reported for what it is.
        if await any_matches(page, site.artifact_queued):
            path = await save_artifacts(page, f"{site.id}-queued")
            # The row names the window ("Scheduled for after 12am"). Lift it
            # into the message: "re-run later" is useless without a when, and
            # the one fact the user needs is already on screen.
            when = ""
            try:
                row = page.locator(site.artifact_queued[0]).first
                when = ((await row.inner_text()) or "").strip()[:60]
            except Exception:
                pass
            raise DriverError(
                "nlm_queued",
                f"{site.display_name} has deferred this deck to a later quota "
                f"window rather than generating it now"
                + (f" ({when})" if when else "")
                + ". The Studio row says it is scheduled, not running. This is "
                f"a usage limit, not a bug, and waiting here cannot make it "
                f"start. Re-run after the reset. Artifacts: {path}")


    path = await save_artifacts(page, f"{site.id}-timeout")
    raise DriverError(
        "nlm_timeout",
        f"no finished deck after {site.gen_timeout_s}s. If the deck DID finish "
        f"on screen, `artifact_ready` is the wrong selector — fix that before "
        f"raising gen_timeout_s. Artifacts: {path}")


def _canonical_notebook_url(url: str, site_url: str) -> str:
    """Repair the notebook URL read off the live page.

    MEASURED, 2026-09-14 (job sb_fdf7b00723): the URL recorded for recovery was
    `https://notebook.google.com/notebook/<id>` — note the missing "lm". Google
    bounces through that host while the app boots, and page.url was sampled
    during the bounce. The id is right, the host is not, so `fetch` would have
    navigated somewhere useless and the whole recovery path would have failed at
    the one moment it is needed.

    Rebuilds the URL from the configured site host whenever the path carries a
    notebook id, and otherwise leaves it alone rather than inventing one.
    """
    try:
        m = re.search(r"/notebook/([A-Za-z0-9_-]{8,})", url or "")
        if not m:
            return url or ""
        host = (site_url or "").rstrip("/")
        if not host:
            return url
        # site.url is the app root ("https://notebooklm.google.com/"), so its
        # scheme+host is the authority every notebook link must carry.
        m2 = re.match(r"^(https?://[^/]+)", host)
        if not m2:
            return url
        return f"{m2.group(1)}/notebook/{m.group(1)}"
    except Exception:                               # noqa: BLE001
        return url or ""


# How long the bytes on disk may sit unchanged before the transfer is treated as
# dead rather than slow, and how many times it may be restarted.
#
# 45s is deliberately generous: NotebookLM's own server can pause for a while
# mid-deck on a large export, and a false restart costs a wasted click. The real
# failure this catches wrote nothing for ~590s, so anything in this range
# distinguishes it cleanly.
STALL_S = 45
MAX_RESTARTS = 3


async def _click_download_item(page, site: DeckSite) -> None:
    """Open the finished artifact's menu and click "Download PDF".

    Split out of _download_deck so a stalled transfer can be RESTARTED by
    clicking it again. The scoping below is the hard-won part and must stay
    identical between the first click and any retry.
    """
    trigger = await resolve(page, site.download_trigger, timeout_ms=10000)
    if not trigger:
        path = await save_artifacts(page, f"{site.id}-no-download")
        raise DriverError(
            "nlm_no_download",
            f"nothing matched `download_trigger` on {site.display_name}. "
            f"Artifacts: {path}")
    # Scoped to the ARTIFACT ROW, not "the last More button on the page".
    # The sources list has its own kebab ("Remove source / Rename source"), and
    # when only one artifact exists that source menu is the only match .last
    # finds — so the flow opened it, found no download, and blamed the menu
    # selector. Anchor to the row that owns the deck instead.
    # Scoped to a row that is finished and NOT failed — the same predicate
    # readiness uses. A bare ".artifact-primary-content More" would happily
    # open the failed deck's menu, which holds no download.
    # The menu is a SIBLING of the row, both inside .artifact-button-content,
    # so scope to that wrapper — and exclude a failed artifact, whose menu
    # holds no download.
    scoped = page.locator(
        ".artifact-button-content:not(:has(.artifact-failed-subtitle)) "
        "button[aria-label='More']")
    if await scoped.count():
        await scoped.last.click()
    else:
        await trigger["locator"].last.click()
    await asyncio.sleep(2.0)

    menu = await resolve(page, site.download_menu_item, timeout_ms=5000)
    if not menu:
        path = await save_artifacts(page, f"{site.id}-no-download-item")
        raise DriverError(
            "nlm_no_download",
            f"the artifact menu opened but held no PDF download item. "
            f"Artifacts: {path}")
    await menu["locator"].first.click()


async def _download_deck(page, site: DeckSite, dest: Path) -> Path:
    """Click through to the PDF and save it where the caller asked.

    ── WHY THIS IS NOT page.expect_download() ─────────────────────────────────
    MEASURED. NotebookLM serves the deck into a NEW PAGE that Chrome closes the
    instant the transfer starts, and that produces two separate failures:

      * expect_download() on the clicked page never fires, because the download
        belongs to the popup. It waits out its full timeout and reports
        "waiting for event download" — which reads like a broken selector even
        though every selector was correct.
      * Every Playwright download API (save_as, path) proxies through the
        browser connection that is being torn down, so all of them lose the
        race even when called from inside the download handler.

    So the bytes are collected as FILES, with no browser round-trip:
    CDP Browser.setDownloadBehavior points Chrome at a private, empty directory
    created for this one call, and the finished file is taken from there.

    ── WHY A PRIVATE DIRECTORY AND NOT "THE NEWEST PDF" ───────────────────────
    An earlier version scanned a shared directory for the newest PDF. Twice it
    returned a file it had never downloaded — once an unrelated generated deck,
    once one of the user's own files out of ~/Downloads — and reported success
    both times. A collector that can return something it did not fetch is worse
    than one that fails, because it fails silently and plausibly. An empty
    directory makes that mistake unrepresentable: anything in it came from this
    download.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)

    # A private landing zone for exactly this download.
    #
    # NAMED, NOT HIDDEN, AND IT SAYS WHAT IT IS. This used to be ".dl-<ts>-<rand>",
    # which is indistinguishable from leftover junk: a partially downloaded PDF
    # sits there not growing for minutes at a time (NotebookLM streams a large
    # deck slowly), and anything tidying the outputs folder — a person, a script,
    # an agent — reads "hidden dot-directory containing a stale .crdownload" as
    # garbage and deletes it. That happened, mid-transfer, and cost a full
    # generation: the download died with WinError 3 and the finished deck was
    # stranded in its notebook.
    #
    # So the directory announces that it is live and must not be touched, and
    # _RunLock's pid is written inside it so anyone (or anything) cleaning up can
    # check whether the owner is still alive instead of guessing from mtime.
    stage = dest.parent / f"ACTIVE-DOWNLOAD-do-not-delete-{os.getpid()}"
    if stage.exists():
        # A previous run with this pid died; its bytes are worthless (a partial
        # PDF is unreadable) and reusing the directory would make "newest file"
        # ambiguous.
        shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True, exist_ok=True)
    try:
        (stage / "README.txt").write_text(
            "A slide deck is downloading into this folder right now.\n"
            f"Owner process id: {os.getpid()}\n\n"
            "Do NOT delete this folder while that process is alive: doing\n"
            "so kills the transfer, and the generated deck (which costs\n"
            "real NotebookLM quota) then has to be fetched again from\n"
            "its notebook.\n\n"
            "The folder is removed automatically once the download\n"
            "completes.\n",
            encoding="utf-8")
    except OSError:
        pass
    # Absolute: Chrome resolves downloadPath against its OWN working directory,
    # not this process's, so a relative path silently lands somewhere else.
    stage = stage.resolve()

    # Browser.setDownloadBehavior WITHOUT a browserContextId applies to the
    # whole browser, which is what makes it cover the popup NotebookLM opens.
    # Page.setDownloadBehavior (and a context-scoped call) binds to the page
    # that is clicked, and the download belongs to the new one — so the popup
    # falls back to Chrome's default directory and the staging dir stays empty.
    cdp = await page.context.new_cdp_session(page)
    await cdp.send("Browser.setDownloadBehavior",
                   {"behavior": "allowAndName", "downloadPath": str(stage),
                    "eventsEnabled": True})

    # LISTEN to what Chrome says about the transfer, rather than inferring it
    # from the filesystem.
    #
    # MEASURED, 2026-09-14 (job sb_fdf7b00723): a deck began downloading, wrote
    # 47KB, and then never advanced again. The poll loop below watches for a
    # %%EOF that was never going to arrive, so it waited the full 600s and
    # reported "no complete PDF appeared" — a timeout message for what was
    # actually an ABORTED transfer that Chrome knew about within a second.
    #
    # `eventsEnabled: True` was already set above but nothing subscribed, so
    # every one of these verdicts was being thrown away.
    dl_state: dict[str, object] = {"state": None, "received": 0, "total": 0,
                                   "guid": None}

    def _on_begin(evt):
        dl_state["guid"] = evt.get("guid")
        dl_state["state"] = "inProgress"

    def _on_progress(evt):
        # states: inProgress | completed | canceled
        dl_state["state"] = evt.get("state") or dl_state["state"]
        dl_state["received"] = evt.get("receivedBytes") or dl_state["received"]
        dl_state["total"] = evt.get("totalBytes") or dl_state["total"]

    cdp.on("Browser.downloadWillBegin", _on_begin)
    cdp.on("Browser.downloadProgress", _on_progress)

    # Also catch the popup as it is created and point IT at the same directory,
    # for builds where the browser-wide call does not reach an already-opening
    # target.
    #
    # `Page.setDownloadBehavior` with plain `allow` — DO NOT "upgrade" this to
    # the browser-wide `allowAndName` call used above.
    #
    # MEASURED, and learned the hard way twice. On 2026-09-15 this was changed
    # to Browser.setDownloadBehavior/allowAndName on the theory that one owner
    # and one naming scheme was tidier. The result was that NO BYTES ARRIVED AT
    # ALL: the staging directory was created and stayed empty through a full
    # 600s window, on two consecutive runs, where the previous build had
    # downloaded the same kind of deck successfully. Re-issuing the
    # browser-scoped command from the popup's own session evidently re-binds
    # the download the popup is already performing, and it is dropped.
    #
    # The page-scoped `allow` is what worked on 2026-09-13 and 2026-09-14.
    # The filename disagreement it causes (site name vs GUID) is cosmetic and
    # is handled downstream by scanning the directory rather than by name.
    async def _route_popup(new_page):
        try:
            c = await new_page.context.new_cdp_session(new_page)
            await c.send("Page.setDownloadBehavior",
                         {"behavior": "allow", "downloadPath": str(stage)})
        except Exception:                           # noqa: BLE001
            pass
    page.context.on("page", lambda np: asyncio.create_task(_route_popup(np)))

    await _click_download_item(page, site)

    # Wait for a COMPLETE PDF, judged by its own trailer.
    #
    # MEASURED, after two wrong guesses:
    #
    #   * Waiting for Chrome to rename away ".crdownload" hangs forever — the
    #     popup that owns the transfer is already gone, so the rename never
    #     happens and a finished file sits there under a UUID with no suffix.
    #   * Waiting for the size to settle copied half-written files. A partial
    #     PDF still starts with %PDF-, so every cheap check passed and the
    #     pages rendered as pure noise: a corrupt deck reported as a success.
    #
    # %%EOF is the last thing written to a PDF, so its presence IS completion.
    # Cheap to poll (last 2KB), and it cannot fire early the way a size
    # heuristic can. The real download lands in about two seconds; this loop
    # exists for the slow case, not the normal one.
    def _candidates() -> list[Path]:
        """Files in the staging dir that could be the deck, newest first.

        Skips README.txt (this function's own do-not-delete marker) and tolerates
        the directory disappearing: iterdir() raises FileNotFoundError if the
        folder is removed mid-poll, which used to escape as a bare WinError and
        abort the run with a message about a missing path rather than about the
        download.
        """
        try:
            entries = [f for f in stage.iterdir()
                       if f.is_file() and f.name != "README.txt"]
        except OSError:
            return []
        try:
            return sorted(entries, key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            return entries

    deadline = time.monotonic() + site.download_timeout_s
    got = None
    # Stall tracking: bytes-on-disk and when they last changed.
    last_size, last_growth, restarts = 0, time.monotonic(), 0
    while time.monotonic() < deadline:
        await asyncio.sleep(1.0)
        if not stage.exists():
            # Someone removed the landing zone while Chrome was writing into it.
            # Say so precisely: this is not a NotebookLM failure, and the deck
            # itself is fine and still in the notebook.
            raise DriverError(
                "nlm_staging_gone",
                f"the download folder {stage} was deleted while the deck was "
                f"still transferring, so the transfer died. The generated deck "
                f"is UNHARMED and still in its notebook — recover it with "
                f"`driver.py fetch --url <notebook-url>` rather than "
                f"regenerating, which would spend quota again.")
        for f in _candidates():
            try:
                if f.stat().st_size < 1024:
                    continue
                if b"%%EOF" in f.read_bytes()[-2048:]:
                    got = f
                    break
            except OSError:
                continue          # still being written; look again next poll
        if got:
            break

        # ── The transfer died rather than being slow ────────────────────────
        #
        # MEASURED (job sb_fdf7b00723): 47KB arrived at 22:29:18 and the file
        # was never written again; the loop then waited out the remaining ~590s
        # looking for a trailer that could not come, and blamed a timeout.
        #
        # Two independent signals, because they fail in different ways:
        #   * Chrome SAYS canceled — authoritative, act immediately.
        #   * Chrome says nothing (the popup owning the transfer was torn down
        #     before reporting), but the bytes on disk have not grown for
        #     STALL_S. The popup teardown is the common case here, so the
        #     filesystem signal is the one that actually fires.
        #
        # The response is to re-click the download item, which restarts the
        # transfer on the page that is still open. Bounded retries: a genuinely
        # unreachable deck must still fail rather than loop to the deadline.
        now = time.monotonic()
        sizes = []
        for f in _candidates():
            try:
                sizes.append(f.stat().st_size)
            except OSError:
                pass
        total_now = sum(sizes)
        if total_now != last_size:
            last_size, last_growth = total_now, now

        # `total_now > 0` is NOT required, and requiring it was a real bug.
        #
        # MEASURED (job sb_49fbc5a20e, 2026-09-15): the click on "Download PDF"
        # did not take — the staging directory was created and then stayed
        # EMPTY, so total_now was 0 forever and this guard never fired. The run
        # sat out the full 600s and reported a timeout, which is the same
        # misleading message the stall detection was added to remove. A download
        # that never starts is just as dead as one that dies at 47KB, and it is
        # fixed by the same re-click.
        #
        # The `sum() == 0` case is safe to treat as a stall because last_growth
        # is initialised at loop start: a legitimately slow FIRST byte still has
        # the whole STALL_S window to arrive.
        stalled = now - last_growth > STALL_S
        canceled = dl_state.get("state") == "canceled"
        if (stalled or canceled) and restarts < MAX_RESTARTS:
            restarts += 1
            waited = int(now - last_growth)
            if canceled:
                why = "Chrome reported it canceled"
            elif total_now == 0:
                why = f"the download never started ({waited}s)"
            else:
                why = f"no new bytes for {waited}s"
            print(f"[deck] download stalled ({why}); "
                  f"re-clicking Download ({restarts}/{MAX_RESTARTS})",
                  file=sys.stderr, flush=True)
            # Drop the dead partial so it cannot be mistaken for the real file
            # (and so growth detection starts clean).
            for f in _candidates():
                try:
                    f.unlink()
                except OSError:
                    pass
            dl_state["state"] = None
            last_size, last_growth = 0, time.monotonic()
            try:
                await _click_download_item(page, site)
            except DriverError:
                # The menu is gone or changed; fall through and let the loop
                # time out with its own message rather than masking this one.
                pass

    if not got:
        partial = _candidates()
        hint = ""
        if partial:
            try:
                hint = (f" {partial[0].stat().st_size} bytes had arrived but "
                        f"the file never completed.")
            except OSError:
                pass
        if restarts:
            hint += (f" The transfer was restarted {restarts} time(s) and "
                     f"stalled again each time.")
        raise DriverError(
            "nlm_no_download",
            f"no complete PDF appeared within {site.download_timeout_s}s.{hint}"
            f" The deck itself is still in its notebook, so recover it with "
            f"`driver.py fetch --url <notebook-url>` instead of regenerating.")

    shutil.move(str(got), str(dest))
    try:
        shutil.rmtree(stage, ignore_errors=True)
    except Exception:                               # noqa: BLE001
        pass

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

    # A TRUNCATED pdf still starts with %PDF-, so the magic bytes alone are not
    # enough. A half-written download once passed every cheap check and
    # rendered as pure noise. %%EOF is the trailer Chrome writes last, so its
    # absence means the transfer was cut short.
    tail = dest.read_bytes()[-2048:]
    if b"%%EOF" not in tail:
        size = dest.stat().st_size
        dest.unlink(missing_ok=True)
        raise DriverError(
            "nlm_empty_download",
            f"the download is truncated: {size} bytes with no %%EOF trailer. "
            f"The transfer was cut short, and a partial PDF renders as noise "
            f"while still looking valid.")
    return dest


async def run_notebooklm_flow(page, site: DeckSite, source: Path, prompt: str,
                              dest: Path, dry_run: bool = False,
                              on_notebook_url=None) -> dict:
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

    # "Generate NOW", never "Generate later" — see the note in selectors.yaml.
    # Clicking the wrong one queues the deck and returns nothing, and the
    # symptom (a deck scheduled for hours away) is indistinguishable from an
    # exhausted quota, which is how it went unnoticed for a whole day.
    r = await _step(page, site, "generate_button", "nlm_no_generate")
    walked["generate_button"] = r["selector"]
    if "later" in (r["selector"] or "").lower():
        raise DriverError(
            "nlm_no_generate",
            "refusing to click 'Generate later' — that defers the deck instead "
            "of building it. Fix decks.notebooklm.generate_button.")

    # RECORD THE NOTEBOOK NOW — quota has just been spent.
    #
    # MEASURED, 2026-09-14: a run generated its deck, the download began, and
    # the bridge was killed mid-transfer. The deck was finished and sitting in
    # the notebook, but nothing had stored WHERE, and `deck` always creates a
    # new notebook — so the only way to get it back was to generate it a second
    # time and pay the quota twice.
    #
    # Published here rather than at creation because this is the instant the run
    # becomes expensive to lose. Everything before Generate is cheap to redo.
    # Failure to record must never break a run that is otherwise fine, so this
    # is best-effort.
    notebook_url = _canonical_notebook_url(page.url, site.url)
    try:
        if on_notebook_url:
            on_notebook_url(notebook_url)
    except Exception:                               # noqa: BLE001
        pass

    # The queue verdict lands within a few seconds of pressing Generate, so
    # look before settling into a poll loop measured in tens of minutes.
    await asyncio.sleep(6.0)
    await _wait_for_deck(page, site)
    out = await _download_deck(page, site, dest)
    return {"dryRun": False, "matched": walked, "pdfPath": str(out),
            "bytes": out.stat().st_size, "notebookUrl": notebook_url}


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


class _RunLock:
    """One deck run at a time, enforced across PROCESSES.

    Two overlapping runs each create their own notebook and each consume
    generation quota, and the second one also fights the first for the Chrome
    profile. That happened for real: a run was launched while an earlier one
    was still alive, and the account ended up with two notebooks built from
    the same source within a minute of each other.

    The bridge already serialises its own jobs, but the CLI is a separate
    entry point and had no such guard — so this lives at the lowest level that
    both share. A stale lock (the process died without releasing) is detected
    by checking whether that pid is still alive, rather than by a timeout.
    """

    def __init__(self, path: Path):
        self.path = path

    def _stale(self) -> bool:
        try:
            pid = int(self.path.read_text(encoding="utf-8").strip())
        except Exception:
            return True
        if pid == os.getpid():
            return True
        try:
            # Signal 0 checks liveness without touching the process.
            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 f"(Get-Process -Id {pid} -ErrorAction SilentlyContinue) -ne $null"],
                capture_output=True, text=True, timeout=10)
            return "True" not in (out.stdout or "")
        except Exception:
            return True

    def __enter__(self):
        if self.path.exists() and not self._stale():
            raise DriverError(
                "already_running",
                f"another deck run is already in progress (pid "
                f"{self.path.read_text(encoding='utf-8').strip()}). Two runs "
                f"create two notebooks and spend twice the quota, so this one "
                f"is refusing to start. Wait for it, or stop it first.")
        self.path.write_text(str(os.getpid()), encoding="utf-8")
        return self

    def __exit__(self, *exc):
        try:
            if self.path.exists() and \
                    self.path.read_text(encoding="utf-8").strip() == str(os.getpid()):
                self.path.unlink()
        except Exception:
            pass
        return False


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
    # Refuse to run alongside another deck run — see _RunLock.
    with _RunLock(HERE / ".deck-run.lock"):
      async with async_playwright() as pw:
        # downloads_dir is what turns on Playwright download handling; only
        # this path passes it.
        ctx = await launch(pw, site, headless=headless,
                           downloads_dir=dest.parent)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        try:
            out = await run_notebooklm_flow(
                page, site, source, prompt, dest,
                dry_run=bool(getattr(args, "dry_run", False)),
                # Lets the caller (the bridge) persist the notebook URL the
                # moment quota is spent, so a run killed mid-download can be
                # recovered with `fetch` instead of regenerating. Optional:
                # the CLI passes nothing and behaves exactly as before.
                on_notebook_url=getattr(args, "on_notebook_url", None))
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


async def cmd_fetch(args) -> dict:
    """Download a deck that ALREADY EXISTS in a notebook. Spends no quota.

    ── WHY THIS COMMAND EXISTS ────────────────────────────────────────────────
    MEASURED, 2026-09-14: a run generated its deck (11 minutes of real quota),
    the download started, and the bridge process was killed mid-transfer. The
    staged file was left truncated — 801KB, no %%EOF, no xref — so the
    completion gate correctly refused it, and the job sat at 'running' until the
    next start marked it interrupted.

    The deck itself was FINE. It was sitting in the notebook, finished. But
    `deck` always creates a NEW notebook, so the only way to get it was to
    generate it a second time and spend the quota again.

    This is the recovery path: point it at the notebook that already holds the
    finished deck and it walks only the last two steps — wait for ready, then
    download. No notebook is created, no source uploaded, no Generate pressed.

    Same output shape as cmd_deck, so _run_notebooklm_job can file the result
    through the identical path.
    """
    site = load_deck_site(args.site)
    dest = Path(args.out)
    headless = site.headless_ok and not args.headful

    # The same lock as cmd_deck: this drives the one logged-in Chrome profile,
    # so it must not run beside a generation.
    with _RunLock(HERE / ".deck-run.lock"):
      async with async_playwright() as pw:
        ctx = await launch(pw, site, headless=headless,
                           downloads_dir=dest.parent)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        try:
            # Repaired on the way in too, so a URL recorded by an older build
            # (or pasted by hand off the address bar mid-redirect) still works.
            # notebook.google.com — no "lm" — is a real thing Google bounces
            # through, and navigating there finds no notebook at all.
            await page.goto(_canonical_notebook_url(args.url, site.url),
                            wait_until="domcontentloaded", timeout=60000)
            await check_blockers(page, site, pre_send=True)
            # The Studio panel paints its rows a beat after the shell loads.
            await asyncio.sleep(8.0)
            walked: dict[str, str] = {}
            await _dismiss_overlays(page, site, walked)
            await asyncio.sleep(1.5)

            # Reuses the real waiter, so a deck still generating here is waited
            # out (and a deferred one is reported as deferred) exactly as it is
            # on the generate path.
            await _wait_for_deck(page, site)
            out = await _download_deck(page, site, dest)
            return {"dryRun": False, "matched": walked, "pdfPath": str(out),
                    "bytes": out.stat().st_size, "fetched": True}
        except DriverError:
            raise
        except Exception as e:
            path = await save_artifacts(page, f"{site.id}-fetch-unexpected")
            raise DriverError(
                "unexpected", f"{str(e)[:220]} Artifacts: {path}")
        finally:
            await ctx.close()


# ══════════════════════════════════════════════════════════════════════════════
# Saved-reels harvest (Instagram)
# ══════════════════════════════════════════════════════════════════════════════
# Results are written to outputs/reels.json and served over loopback by
# server.py; the PAGE files them to Firestore. This module holds no Firebase
# credential and must never gain one — see the boundary note at the top of
# V1/js/modules/pipeline.js. A scraper driving a logged-in session is exactly
# the process that should not also hold cloud write access.

REELS_OUT = HERE / "outputs" / "reels.json"

# Bounds the per-run thumbnail work the PAGE will do. The Workers KV namespace
# it uploads into is free-plan (~1000 writes/day) and SHARED with StudyOS file
# uploads, so an unbounded first run could burn the day's quota and break file
# uploads as a side effect. Reels past the cap are still recorded; they just
# collect their thumbnail on a later run.
REELS_THUMB_CAP = 60


def _pace(rng) -> float:
    """Sample a delay from a [lo, hi] pair.

    Ranges, not constants, everywhere a delay is used: the original MAGI sketch
    typed with a fixed 15ms delay, and a metronome is a recognisable pattern. A
    bare number is accepted too, so a config that hardcodes one still works.
    """
    try:
        lo, hi = float(rng[0]), float(rng[1])
    except (TypeError, IndexError, ValueError):
        try:
            return max(0.0, float(rng))
        except (TypeError, ValueError):
            return 0.0
    if hi < lo:
        lo, hi = hi, lo
    return random.uniform(lo, hi)


def shortcode_of(href: str):
    """The stable id in an Instagram permalink, or None.

    /reel/<code>/, /reels/<code>/ and /p/<code>/ all appear in a saved grid — a
    saved reel is sometimes filed under /p/ — and all three carry the same
    shortcode, which is what makes it a safe dedup key across them.

    A pure function so the dedup rule is testable without a browser.
    """
    if not href:
        return None
    m = re.search(r"/(?:reel|reels|p)/([A-Za-z0-9_-]{5,})", href)
    return m.group(1) if m else None


def merge_reels(old, new):
    """Union by shortcode, newest metadata winning, order preserved.

    MERGE, never replace. A harvest that IG cut short mid-scroll returns a
    partial list, and replacing on that would silently drop reels the widget was
    already showing. New entries append, so the feed keeps a stable order
    between runs instead of reshuffling whenever IG reorders its grid.

    A field that came back empty this run does NOT clobber a good stored value:
    that is how a thumbKey collected on an earlier run survives a later harvest
    which skipped thumbnails because it hit the cap.
    """
    out = []
    index = {}
    for r in list(old or []) + list(new or []):
        code = (r or {}).get("shortcode")
        if not code:
            continue
        if code in index:
            merged = dict(out[index[code]])
            for k, v in r.items():
                if v not in (None, "", []):
                    merged[k] = v
            out[index[code]] = merged
        else:
            index[code] = len(out)
            out.append(dict(r))
    return out


def read_reels_cache() -> dict:
    try:
        return json.loads(REELS_OUT.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_reels_cache(doc: dict) -> None:
    REELS_OUT.parent.mkdir(parents=True, exist_ok=True)
    REELS_OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=2),
                         encoding="utf-8")


async def resolve_ig_user(page) -> str:
    """The signed-in account's handle, read off the session itself.

    Asking for --user was friction with a sharp edge: the obvious placeholder
    (<your-handle>) is a PowerShell parse error, and the handle is something the
    logged-in profile already knows. So it is auto-detected and the flag becomes
    an override rather than a requirement.

    Two sources, cheapest first, and NEITHER navigates anywhere new:
      1. the `ds_user_id` cookie plus IG's own web_profile_info endpoint, read
         from inside the authenticated page so no separate auth is involved;
      2. the profile link IG renders in its own nav.
    Returns "" when neither works, and the caller then asks for --user rather
    than guessing.
    """
    # 1. IG's own bootstrap payload names the viewer. Read from the page's own
    #    fetch so the session cookies ride along automatically.
    try:
        handle = await page.evaluate("""async () => {
          const pick = (o) => (o && (o.username || (o.user && o.user.username))) || '';
          // The shared-data blob, when this build still ships it.
          try {
            if (window._sharedData && window._sharedData.config
                && window._sharedData.config.viewer) {
              const u = pick(window._sharedData.config.viewer);
              if (u) return u;
            }
          } catch (e) {}
          // Otherwise ask the endpoint the app itself uses.
          try {
            const r = await fetch('/api/v1/users/web_profile_info/?username=',
                                  {headers: {'x-ig-app-id': '936619743392459'}});
            if (r.ok) {
              const j = await r.json();
              const u = pick(j && j.data);
              if (u) return u;
            }
          } catch (e) {}
          return '';
        }""")
        if handle:
            return str(handle).strip().lstrip("@")
    except Exception:
        pass

    # 2. The profile link in IG's own nav — /<handle>/ with nothing after it.
    for sel in ("a[href^='/'][role='link'] img[alt*='profile picture' i]",
                "nav a[href^='/']"):
        try:
            loc = page.locator(sel)
            for i in range(min(await loc.count(), 12)):
                el = loc.nth(i)
                href = await el.get_attribute("href")
                if not href:
                    anc = el.locator("xpath=ancestor::a[1]")
                    if await anc.count():
                        href = await anc.first.get_attribute("href")
                m = re.fullmatch(r"/([A-Za-z0-9._]{1,30})/", href or "")
                if m and m.group(1) not in (
                        "explore", "reels", "direct", "accounts", "p"):
                    return m.group(1)
        except Exception:
            continue
    return ""


async def _harvest_reels(page, site: ReelsSite) -> dict:
    """Scroll the saved grid, collecting tiles until the feed is exhausted.

    ── POLL ORDER IS THE CONTRACT ─────────────────────────────────────────────
    `loading_more` is checked BEFORE any end-of-feed verdict, and while it
    matches, nothing else can mean "done". This is the ordering a deck run
    learned the hard way: a readiness selector matched a *generating*
    placeholder, the loop returned early, and the failure surfaced somewhere
    else entirely. Here the equivalent bug returns a truncated list that looks
    like a complete one — no error, just missing reels. A drifting selector
    should cost a stall timeout, not silent data loss.

    ── DEAD vs SLOW ───────────────────────────────────────────────────────────
    The only honest end-of-feed signal is growth: the tile count not moving
    across `stall_polls` consecutive polls while nothing is loading. Note the
    guard fires at a count of ZERO too. Requiring count > 0 first was a real bug
    on the download path (a transfer that never started sat out the whole 600s
    budget reporting a misleading timeout) — a harvest that never starts is just
    as dead as one that dies mid-scroll, and both are bounded the same way.
    """
    seen = {}
    scrolls = 0
    stalled = 0
    last_count = -1
    stopped = "exhausted"
    deadline = time.monotonic() + site.harvest_timeout_s

    grid = await resolve(page, site.grid_container, timeout_ms=8000)
    if not grid:
        path = await save_artifacts(page, f"{site.id}-grid")
        raise DriverError(
            "ig_grid_missing",
            f"{site.display_name}: no element matched `grid_container`. The "
            f"selector guess is wrong — repair it in selectors.yaml under "
            f"reels.{site.id}.grid_container. Artifacts: {path}")

    while scrolls < site.max_scrolls:
        # A wall clock over the whole harvest. `max_scrolls` alone is not a
        # bound: any branch that continues without scrolling escapes it, which
        # is precisely the hang this loop shipped with. A deadline holds
        # regardless of which branch misbehaves.
        if time.monotonic() > deadline:
            stopped = "harvest_timeout"
            break

        await check_blockers(page, site, pre_send=False)

        # 1. Read whatever has mounted.
        #
        #    THERE IS NO "STILL LOADING" GATE, deliberately. Measured against
        #    the live saved grid: IG's infinite-scroll sentinel is permanent
        #    (count=1 forever), is never CSS-hidden (is_visible()=True forever)
        #    and sits far below the fold (top=3043, moving as you scroll). No
        #    form of that check can separate "fetching" from "that element
        #    exists", and two harvests returned 0 reels proving it.
        #
        #    GROWTH is the signal, and it is sufficient: while IG is fetching,
        #    the tile count rises; `stall_polls` consecutive polls with no new
        #    tiles is the only honest end-of-feed verdict. `stall_polls` is what
        #    absorbs a slow fetch — each poll costs one scroll-pause, so a page
        #    that is merely slow gets several beats before it is called done.
        for sel in site.reel_link or []:
            try:
                anchors = page.locator(sel)
                for i in range(await anchors.count()):
                    a = anchors.nth(i)
                    href = await a.get_attribute("href")
                    code = shortcode_of(href or "")
                    if not code or code in seen:
                        continue
                    thumb, caption = None, None
                    for tsel in site.reel_thumb or []:
                        img = a.locator(tsel).first
                        if await img.count():
                            thumb = (await img.get_attribute("src")
                                     or await img.get_attribute("srcset"))
                            break
                    for csel in site.reel_caption or []:
                        cap = a.locator(csel).first
                        if await cap.count():
                            caption = await cap.get_attribute("alt")
                            break
                    seen[code] = {
                        "shortcode": code,
                        "url": f"https://www.instagram.com/reel/{code}/",
                        "thumbSrc": thumb or "",
                        "caption": (caption or "").strip()[:400],
                    }
            except Exception:
                continue

        # 2. Growth check — the end-of-feed verdict. See above.
        count = len(seen)
        stalled = stalled + 1 if count == last_count else 0
        last_count = count
        if stalled >= site.stall_polls:
            break

        # 3. Scroll on, at human pace.
        try:
            await page.mouse.wheel(0, random.randint(600, 1100))
        except Exception:
            await page.keyboard.press("PageDown")
        scrolls += 1
        await asyncio.sleep(_pace(site.scroll_pause_s))
    else:
        # Hit the cap rather than the end of the feed. Reported, never silent:
        # the caller needs to know this list is a prefix, not the whole set.
        stopped = "scroll_cap"

    return {"reels": list(seen.values()), "scrolls": scrolls, "stoppedAt": stopped}


async def cmd_reels(args) -> dict:
    """Harvest one saved collection into outputs/reels.json.

    --dry-run stops after navigation and selector resolution, before the scroll
    harvest. That is the whole repair loop for a guessed selector and it costs
    one page load instead of a full scrape. More page visits is precisely the
    cost this design exists to avoid, so repairing by re-running a real harvest
    is the wrong move.
    """
    site = load_reels_site(args.site)
    headless = site.headless_ok and not args.headful
    collection = args.collection or "all-posts"

    # --user is now an OVERRIDE, not a requirement: when it is absent the handle
    # is read off the logged-in session inside _reels_run, which also avoids the
    # placeholder-in-a-shell trap that <your-handle> creates in PowerShell.
    user = (args.user or "").strip().lstrip("@")
    target = None if not user else (
        (site.saved_url or site.url).replace("{user}", user)
                                    .replace("{collection}", collection))

    # One harvest at a time, across PROCESSES — the CLI and the bridge are
    # separate entry points, exactly as for deck runs. Two overlapping harvests
    # would fight over the single Instagram browser profile AND double the
    # automated traffic to a logged-in personal account. Staleness is judged by
    # PID liveness rather than a timeout: the bridge runs as pythonw, so a lock
    # left behind by a crash must not block every later run forever.
    with _RunLock(HERE / ".reels-run.lock"):
        return await _reels_run(site, args, target, collection, headless, user)


async def _reels_run(site, args, target, collection, headless, user="") -> dict:
    """The harvest proper. Split out of cmd_reels so the run lock wraps it.

    Same shape as the deck path: the lock is acquired by the command, and the
    body that actually drives the browser is a separate function.
    """
    async with async_playwright() as pw:
        ctx = await launch(pw, site, headless=headless)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        try:
            # Land on the site root first when the handle is unknown: the
            # session names its own account, so one navigation both proves we
            # are signed in and tells us where the saved page lives.
            await page.goto(target or site.url, wait_until="domcontentloaded",
                            timeout=site.nav_timeout_s * 1000)
            await asyncio.sleep(_pace(site.settle_pause_s))

            # Sentinels before anything else: a logged-out page renders an empty
            # grid indistinguishable from an empty collection.
            await check_blockers(page, site, pre_send=True)

            if not target:
                user = await resolve_ig_user(page)
                if not user:
                    path = await save_artifacts(page, f"{site.id}-nouser")
                    raise DriverError(
                        "ig_no_user",
                        "could not read the signed-in handle off the session. "
                        "Pass it explicitly:  python driver.py reels --user "
                        "yourhandle   (no angle brackets — PowerShell treats "
                        f"'<' as an operator). Artifacts: {path}")
                target = (site.saved_url or site.url) \
                    .replace("{user}", user).replace("{collection}", collection)
                await page.goto(target, wait_until="domcontentloaded",
                                timeout=site.nav_timeout_s * 1000)
                await asyncio.sleep(_pace(site.settle_pause_s))
                await check_blockers(page, site, pre_send=True)

            walked = {}
            for fname in ("grid_container", "reel_link", "reel_thumb", "reel_caption"):
                r = await resolve(page, getattr(site, fname), timeout_ms=6000,
                                  require_visible=(fname == "grid_container"))
                walked[fname] = r["selector"] if r else "(no match)"

            is_empty = await any_matches(page, site.empty_sentinel)

            if args.dry_run:
                path = await save_artifacts(page, f"{site.id}-dryrun")
                return {"ok": True, "dryRun": True, "matched": walked,
                        "emptySentinel": is_empty, "url": target, "user": user,
                        "stoppedAt": "before harvest", "artifacts": path}

            # ── probe: the change gate, one screen, no scrolling ────────────
            # Reads only what has already mounted and compares the newest
            # shortcodes against the cache. Cheap relative to a harvest (one
            # screen vs up to 40 scrolls) but NOT free: it is still a page
            # visit to a logged-in account, which is why the watcher that uses
            # it is opt-in and rate-floored rather than on by default.
            #
            # "Changed" is deliberately conservative: a NEW top-of-grid
            # shortcode, or a count that grew. A reel merely being unsaved does
            # not trigger a harvest, because the merge would not remove it
            # anyway and a visit that cannot change the outcome is a visit not
            # worth making.
            if getattr(args, "probe", False):
                seen = []
                for sel in site.reel_link or []:
                    try:
                        anchors = page.locator(sel)
                        for i in range(await anchors.count()):
                            code = shortcode_of(
                                await anchors.nth(i).get_attribute("href") or "")
                            if code and code not in seen:
                                seen.append(code)
                    except Exception:
                        continue
                cached = [r.get("shortcode") for r in
                          (read_reels_cache().get("reels") or [])]
                fresh = [c for c in seen if c not in set(cached)]
                return {"ok": True, "probe": True, "user": user,
                        "collection": collection,
                        "seen": len(seen), "cached": len(cached),
                        "newOnScreen": len(fresh),
                        "changed": bool(fresh) or not cached,
                        "stoppedAt": "probe only"}

            if is_empty:
                # An explicitly empty collection is a real answer, but it still
                # must not overwrite a good cached list — see the refusal below.
                got = {"reels": [], "scrolls": 0, "stoppedAt": "empty_sentinel"}
            else:
                got = await _harvest_reels(page, site)
        finally:
            await ctx.close()

    cache = read_reels_cache()
    stored = cache.get("reels") or []

    # ── The empty-result refusal ──────────────────────────────────────────────
    # A logged-out page, a changed selector and a genuinely empty collection all
    # produce zero tiles, and only the last is not a bug. Overwriting a good list
    # with [] on any of them would delete the widget's contents for a reason
    # nobody could reconstruct afterwards, so zero results never persist over a
    # non-empty cache. The cached list keeps serving; the run says why.
    if not got["reels"] and stored:
        return {"ok": False, "kind": "ig_empty_harvest",
                "error": f"harvested 0 reels but {len(stored)} are cached — "
                         f"refusing to overwrite. Usually a changed selector or "
                         f"an expired session: run  python driver.py reels "
                         f"--dry-run  to see which.",
                "kept": len(stored), "stoppedAt": got["stoppedAt"]}

    merged = merge_reels(stored, got["reels"])
    doc = {
        "savedAt": int(time.time() * 1000),
        "site": site.id,
        "user": user,
        "collection": collection,
        "count": len(merged),
        "thumbCap": REELS_THUMB_CAP,
        "stoppedAt": got["stoppedAt"],
        "reels": merged,
    }
    write_reels_cache(doc)
    return {"ok": True, "count": len(merged), "new": len(merged) - len(stored),
            "scrolls": got["scrolls"], "stoppedAt": got["stoppedAt"],
            "out": str(REELS_OUT)}


async def cmd_login(args) -> dict:
    """Open the site visibly so a human can sign in once. Never automated.

    Dispatches on whether the id names a chat site or a deck generator. Without
    this, `login --site notebooklm` dies with "unknown site" and the one
    sanctioned way to authenticate that path would not exist.
    """
    if is_reels_site(args.site):
        site = load_reels_site(args.site)
    elif is_deck_site(args.site):
        site = load_deck_site(args.site)
    else:
        site = load_site(args.site)
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

    ft = sub.add_parser(
        "fetch", help="download a deck that already exists (spends no quota)")
    ft.add_argument("--site", default="notebooklm")
    ft.add_argument("--url", required=True,
                    help="the notebook URL holding the finished deck")
    ft.add_argument("--out", required=True, help="where to save the PDF")
    ft.add_argument("--headful", action="store_true")

    rl = sub.add_parser(
        "reels", help="harvest a saved Instagram collection into outputs/reels.json")
    rl.add_argument("--site", default="instagram")
    rl.add_argument("--user", default="",
                    help="your Instagram handle; auto-detected from the "
                         "signed-in session when omitted")
    rl.add_argument("--collection", default="all-posts",
                    help="the collection slug as it appears in the saved URL")
    rl.add_argument("--headful", action="store_true", help="force a real window")
    rl.add_argument("--dry-run", action="store_true",
                    help="navigate and resolve selectors, stopping BEFORE the "
                         "scroll harvest — the cheap repair loop")
    rl.add_argument("--probe", action="store_true",
                    help="read the first screen only and report whether the "
                         "collection changed; no scrolling, no write")

    lo = sub.add_parser("login", help="open the site so a human can sign in")
    lo.add_argument("--site", default="claude")

    d = sub.add_parser("doctor", help="check which selectors still match")
    d.add_argument("--site", default="claude")
    d.add_argument("--headful", action="store_true")

    args = ap.parse_args()
    fn = {"ask": cmd_ask, "deck": cmd_deck, "fetch": cmd_fetch,
          "reels": cmd_reels, "login": cmd_login, "doctor": cmd_doctor}[args.cmd]
    # flush=True on every exit path. A deck run takes minutes and its single
    # line of JSON is the whole result; buffered behind a pipe it arrives only
    # at process exit, and a caller reading the stream early sees nothing at
    # all. That cost several debugging cycles looking at empty output files.
    try:
        print(json.dumps(asyncio.run(fn(args)), ensure_ascii=False), flush=True)
    except DriverError as e:
        print(json.dumps({"ok": False, "kind": e.kind, "error": e.message},
                         ensure_ascii=False), flush=True)
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"ok": False, "kind": "unexpected", "error": str(e)[:500]},
                         ensure_ascii=False), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
