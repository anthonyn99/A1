"""`magi login <site>` -- one-time manual sign-in per site.

Opens a real browser window against this site's persistent profile and waits.
You log in by hand; the session lives in profiles/<site>/ and is reused.

MAGI never asks for or stores your credentials -- you type them into the real
site in a real browser, exactly as you normally would.
"""

from __future__ import annotations

import asyncio

from ..browser import launcher, resolve
from ..settings import Settings


async def run(settings: Settings, site_id: str) -> int:
    site = settings.site(site_id)

    print(f"\nOpening {site.display_name} ({site.url})")
    print("Log in normally in the window that opens, then come back here.")
    print("Your session is saved to this site's own profile folder; your personal")
    print("Chrome profile is never touched.\n")

    # force_visible: you cannot sign in to a window parked off-screen, so this
    # ignores the off-screen setting that normal runs use.
    async with launcher.launch(
        site_id, settings.browser, headless=False, force_visible=True
    ) as ctx:
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        try:
            await page.goto(site.url, timeout=site.nav_timeout_s * 1000)
        except Exception as e:
            print(f"Could not load the page: {str(e)[:200]}")
            return 1

        await asyncio.get_event_loop().run_in_executor(
            None, input, "Press ENTER here once you are logged in... "
        )

        # Report what we can actually see, rather than assuming it worked.
        challenged = await resolve.is_challenge_page(page, site.challenge_selectors)
        composer = await resolve.resolve(page, site.input, timeout_ms=8000)

        if challenged:
            print("\n  A verification page is still showing. Try again and clear it fully.")
            return 1
        if composer is None:
            print("\n  No message box found on the page. The login may not have "
                  "completed, or the 'input' selector is stale "
                  f"(run `python -m magi doctor {site_id}`).")
            return 1

        print(f"\n  Logged in. Session saved to {settings.browser.profile_dir(site_id)}")
        return 0
