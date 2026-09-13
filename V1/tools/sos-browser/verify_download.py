"""Verify the LAST two unproven selectors against an already-generated deck.

artifact_ready and download_trigger are the only steps never exercised, because
verifying them needs a finished deck to exist. This uses the deck NotebookLM
generates from its own deferred queue, so it presses no Generate and spends no
quota — the expensive half already happened on their side.

    python verify_download.py <notebook-url>
"""
import asyncio, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import driver

URL = sys.argv[1]
DEST = Path("./outputs/deck-verified.pdf")


async def main():
    site = driver.load_deck_site("notebooklm")
    async with driver.async_playwright() as pw:
        ctx = await driver.launch(pw, site, headless=False,
                                  downloads_dir=DEST.parent)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        try:
            await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
            await asyncio.sleep(9)
            w = {}
            await driver._dismiss_overlays(page, site, w)
            await asyncio.sleep(2)

            # The generated artifact row usually has to be opened before its
            # download control exists. Click it if the deck title is there.
            try:
                row = page.locator("text=/Boolean Algebra/i").last
                if await row.count():
                    await row.click()
                    await asyncio.sleep(4)
                    await driver._dismiss_overlays(page, site, w)
            except Exception:
                pass

            await driver._wait_for_deck(page, site)
            out = await driver._download_deck(page, site, DEST)
            print(json.dumps({"ok": True, "pdfPath": str(out),
                              "bytes": out.stat().st_size}))
        except driver.DriverError as e:
            print(json.dumps({"ok": False, "kind": e.kind, "error": e.message}))
        finally:
            await ctx.close()

asyncio.run(main())
