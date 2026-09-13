"""Read-only check: has the deferred deck finished?

Costs NOTHING. Opens the notebook, reads the Studio row, closes. It never
clicks Generate, never creates a notebook, never uploads. Exists so the state
can be polled without spending the quota that this whole feature is gated on.

    python check_queued.py <notebook-url>
"""
import asyncio, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import driver

URL = (sys.argv[1] if len(sys.argv) > 1 else
       "https://notebooklm.google.com/notebook/b031a334-129f-40c1-988d-7b1a242c5268")


async def main():
    site = driver.load_deck_site("notebooklm")
    async with driver.async_playwright() as pw:
        ctx = await driver.launch(pw, site, headless=False)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        try:
            await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
            await asyncio.sleep(9)
            w = {}
            await driver._dismiss_overlays(page, site, w)
            await asyncio.sleep(2)
            queued = await driver.any_matches(page, site.artifact_queued)
            ready = await driver.any_matches(page, site.artifact_ready)
            failed = await driver.any_matches(page, site.artifact_failed)
            row = ""
            try:
                row = ((await page.locator(site.artifact_queued[0]).first
                        .inner_text()) or "").strip()[:60]
            except Exception:
                pass
            print(json.dumps({"queued": queued, "ready": ready,
                              "failed": failed, "row": row}))
        finally:
            await ctx.close()

asyncio.run(main())
