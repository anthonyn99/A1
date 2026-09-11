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


async def launch(pw, site: Site, headless: bool, visible: bool = False):
    """Persistent per-site profile, real Chrome.

    launch_persistent_context (not launch() + storage_state) because a persistent
    user-data dir keeps IndexedDB and refresh tokens; the cookie-JSON approach
    drops them, which is why those sessions die within days. Log in once by hand
    and the profile stays authenticated for weeks, like a normal browser.
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

    ctx = await pw.chromium.launch_persistent_context(
        user_data_dir=str(profile),
        channel="chrome",
        headless=headless,
        args=args,
        viewport={"width": 1280, "height": 900},
    )
    return ctx


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


async def cmd_login(args) -> dict:
    """Open the site visibly so a human can sign in once. Never automated."""
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


async def cmd_doctor(args) -> dict:
    """Report which selectors still match — the early warning for UI churn."""
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

    lo = sub.add_parser("login", help="open the site so a human can sign in")
    lo.add_argument("--site", default="claude")

    d = sub.add_parser("doctor", help="check which selectors still match")
    d.add_argument("--site", default="claude")
    d.add_argument("--headful", action="store_true")

    args = ap.parse_args()
    fn = {"ask": cmd_ask, "login": cmd_login, "doctor": cmd_doctor}[args.cmd]
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
