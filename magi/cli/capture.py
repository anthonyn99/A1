"""`magi capture <site>` -- find the selectors that only exist while generating.

`doctor` can only ever probe an IDLE page, so three of the fields it reports
are permanently unverifiable: `stop_button`, `streaming_marker` and
`assistant_turn` do not exist until a model is actually answering. That gap is
not academic -- DeepSeek ships with `stop_button: []` and
`streaming_marker: []`, so its completion detection rests on text stability
alone. Every DeepSeek answer is therefore flagged "end of response inferred,
not confirmed" and pays a 14-second silence before MAGI will call it finished,
whether or not it actually was.

Filling those in needs a DOM captured mid-answer, which is what this does:

    magi capture deepseek

It asks one short throwaway question, snapshots the page before, repeatedly
during, and after the answer, then reports what was present ONLY while
generating. Those are the stop-button and streaming-marker candidates, and they
go into `config/selectors.yaml`.

It costs one real question against your account, so it is a command you run
deliberately rather than something `doctor` does on every pass.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path

from ..browser import completion, humanize, launcher, resolve
from ..settings import Settings

DEFAULT_QUESTION = "In one short paragraph, what is a hash table?"

# Build-hashed class names churn on every deploy, so a selector built from one
# is worse than none: it works today, breaks silently at the next release, and
# looks like a site redesign when it does. DeepSeek's are the reason this
# exists -- `_4f3769f`, `d05a0287`.
_HASHED = re.compile(r"^_?[0-9a-f]{6,}$|^[a-zA-Z]+_[0-9a-z]{5,}$")

# One JS expression, so the page is sampled atomically rather than across a
# series of round trips that could each see a different frame.
_SNAPSHOT_JS = r"""
() => {
  const out = [];
  const hashed = (c) => /^_?[0-9a-f]{6,}$/.test(c) || /^[a-zA-Z]+_[0-9a-z]{5,}$/.test(c);
  for (const el of document.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const aria = el.getAttribute('aria-label') || '';
    const clickable = tag === 'button' || role === 'button';
    const data = [];
    for (const a of el.attributes) {
      if (a.name.startsWith('data-')) data.push(a.value ? `${a.name}="${a.value}"` : a.name);
    }
    // Only elements that could plausibly BE a signal: a control, or something
    // carrying a data-attribute or aria-label. Everything else is layout.
    if (!clickable && !data.length && !aria) continue;
    const classes = [...el.classList].filter((c) => !hashed(c));
    out.push(JSON.stringify({
      tag, role, aria, data,
      cls: classes,
      text: (el.textContent || '').trim().slice(0, 24),
      visible: !!(el.offsetParent || el.getClientRects().length),
    }));
  }
  return out;
}
"""


def _selectors_for(item: dict) -> list[str]:
    """Plausible CSS selectors for one snapshot entry, most stable first."""
    out = []
    tag = item["tag"]
    if item["aria"]:
        out.append(f"{tag}[aria-label='{item['aria']}']")
        out.append(f"[aria-label*='{item['aria'].split()[0]}' i]")
    for d in item["data"]:
        out.append(f"[{d}]" if "=" in d else f"[{d}]")
    for c in item["cls"]:
        out.append(f"{tag}.{c}")
    if item["role"] and not out:
        out.append(f"{tag}[role='{item['role']}']")
    return out


def _key(item: dict) -> str:
    """Identity of an element for set arithmetic across snapshots."""
    return json.dumps(
        {k: item[k] for k in ("tag", "role", "aria", "data", "cls")}, sort_keys=True
    )


async def run(settings: Settings, site_id: str, question: str | None = None) -> int:
    site = settings.site(site_id)
    q = (question or DEFAULT_QUESTION).strip()

    print(f"\nCapturing {site.display_name} mid-answer.")
    print("This asks ONE real question against your account, so the page has")
    print("something to generate. Nothing is saved to the run history.\n")

    async with launcher.launch(
        site_id, settings.browser, headless=True if site.headless_ok else None
    ) as ctx:
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(site.url, timeout=site.nav_timeout_s * 1000)
        await asyncio.sleep(3)

        if await resolve.signed_out(page, site.login_selectors):
            print(f"  [X] {site.display_name} is signed out. Run `magi login {site_id}` first.")
            return 1
        box = await resolve.resolve(page, site.input, timeout_ms=site.ready_timeout_s * 1000)
        if box is None:
            print(f"  [X] No composer found. Run `magi doctor {site_id}`.")
            return 1

        async def snap() -> dict[str, dict]:
            raw = await page.evaluate(_SNAPSHOT_JS)
            items = [json.loads(r) for r in raw]
            return {_key(i): i for i in items}

        print("  snapshotting idle page…")
        before = await snap()

        baseline = await completion.capture_baseline(page, site)
        await humanize.insert_text(page, box.locator.first, q, settings.pacing)
        submit = await resolve.resolve(page, site.submit, timeout_ms=3000)
        await humanize.send(
            page, submit.locator.first if submit else None, site.send_key,
            settings.pacing, composer=box.locator.first,
        )
        print("  sent. sampling while it answers…")

        during: dict[str, dict] = {}
        seen_text = ""
        t0 = time.monotonic()
        # Sample fast and for long enough to cover a slow first token. Stops
        # early once the text has been stable for a few samples, which is the
        # same weak signal this command exists to replace -- good enough to
        # know when to stop LOOKING.
        stable = 0
        while time.monotonic() - t0 < 90:
            await asyncio.sleep(0.6)
            for k, v in (await snap()).items():
                during.setdefault(k, v)
            text, _turns = await completion._read_latest(page, site)
            if text and text == seen_text:
                stable += 1
                if stable >= 8:
                    break
            elif text:
                stable = 0
                seen_text = text
                print(f"    …{len(text)} chars", end="\r")

        print("\n  answer settled. snapshotting idle page again…")
        await asyncio.sleep(2)
        after = await snap()

    # Present ONLY while generating: that is the whole point.
    only_during = [during[k] for k in during if k not in before and k not in after]
    if not only_during:
        print("\n  Nothing appeared only while generating. Either the answer was")
        print("  too fast to sample, or this site genuinely exposes no signal.")
        return 1

    print(f"\n{'=' * 70}")
    print(f"Present ONLY while {site.display_name} was generating")
    print(f"{'=' * 70}\n")
    for item in sorted(only_during, key=lambda i: (not i["visible"], i["tag"])):
        sels = _selectors_for(item)
        if not sels:
            continue
        label = item["aria"] or item["text"] or item["tag"]
        kind = "stop_button" if (item["tag"] == "button" or item["role"] == "button") else "streaming_marker"
        print(f"  {label!r}  ({kind} candidate, visible={item['visible']})")
        for s in sels:
            print(f"      - \"{s}\"")
        print()

    print("Add the ones that look right to config/selectors.yaml, newest FIRST.")
    print("A stop_button tells MAGI the model is still going; a streaming_marker")
    print("is better still. Either one replaces the text-stability guess and its")
    print("14-second silence.")
    return 0
