"""`magi login <site>` -- one-time manual sign-in per site.

Opens a real browser window against this site's persistent profile and waits
until you are actually logged in. The session lives in profiles/<site>/ and is
reused by every later run.

MAGI never asks for or stores your credentials -- you type them into the real
site in a real browser, exactly as you normally would.

WHY THIS WATCHES THE PAGE INSTEAD OF ASKING YOU TO PRESS ENTER
--------------------------------------------------------------
It used to block on input() and check the page once, whenever that returned.
That made a single stray keystroke fatal: typing the NEXT command while the
window was still open (`magi login gemini` queued up behind `magi login
claude`) satisfied the prompt instantly, so MAGI checked a page nobody had
logged into yet, reported "no message box found", and closed the window. From
the outside the browser just flashed open and shut, with no hint that the
terminal had eaten the keystroke -- and once one line was buffered it cascaded
into every following attempt.

So the composer is now POLLED, and appearing is what ends the wait. Typing
ahead is harmless, ENTER is only an override, and the console buffer is drained
before the wait starts so anything already queued cannot end it early.
"""

from __future__ import annotations

import asyncio
import sys

from ..browser import launcher, resolve
from ..settings import Settings

# Long enough for a password manager, a 2FA code and a slow challenge; short
# enough that a forgotten window does not hold the profile lock all day.
WAIT_TIMEOUT_S = 15 * 60
POLL_S = 1.5


def _drain_console() -> None:
    """Throw away anything already typed, so it cannot satisfy the override."""
    try:
        import msvcrt

        while msvcrt.kbhit():
            msvcrt.getwch()
    except Exception:
        # Not a Windows console (piped stdin, another OS) -- nothing buffered
        # that we can portably discard, and the poll below is the real path
        # anyway.
        pass


async def _signed_in(page, site) -> bool:
    """True once the page shows a usable composer AND no sign-in control.

    The composer alone is NOT enough. Gemini and ChatGPT both render a working
    message box to logged-OUT visitors, so checking only for that reported a
    successful login for a session that was still anonymous -- and MAGI then
    ran the whole council against a free tier instead of the subscription it
    was pointed at, with nothing anywhere saying so. `login_selectors` is the
    per-site "you are not signed in" sentinel that catches it; the sites that
    require a login to show a composer at all simply never match it.
    """
    if await resolve.is_challenge_page(page, site.challenge_selectors):
        return False
    if not await resolve.resolve(page, site.input, timeout_ms=800):
        return False
    return not await resolve.present(page, site.login_selectors)


async def _await_signed_in(page, site) -> bool:
    """Poll until signed in, the window closes, or the wait times out."""
    deadline = asyncio.get_event_loop().time() + WAIT_TIMEOUT_S
    while asyncio.get_event_loop().time() < deadline:
        if page.is_closed():
            return False
        try:
            if await _signed_in(page, site):
                return True
        except Exception:
            # Mid-navigation the page can be torn down under the query. Not a
            # failure -- the next poll runs against the new document.
            pass
        await asyncio.sleep(POLL_S)
    return False


def _enter_future() -> asyncio.Future:
    """A future that resolves when ENTER is pressed. Manual override, for when
    the composer selector has gone stale and polling can never win.

    Deliberately a DAEMON thread rather than run_in_executor: whichever of the
    two waits loses gets cancelled, but cancelling a future does not unblock
    the thread already sitting in readline(). A default-executor thread is
    non-daemon, and the interpreter joins those at exit -- so the normal,
    successful path (the page poll wins) would print "Logged in" and then hang
    the terminal until someone pressed a key it no longer needed. A daemon
    thread is simply abandoned.
    """
    import threading

    loop = asyncio.get_event_loop()
    fut: asyncio.Future = loop.create_future()

    def wait() -> None:
        try:
            line = sys.stdin.readline()
        except Exception:
            return
        # "" is EOF, not a keypress -- it happens when stdin is closed or
        # redirected (`magi login claude < nul`, a CI runner). Resolving on it
        # would fire the override instantly and skip the polling entirely,
        # turning the reliable path off for anyone not at a live console.
        if line == "":
            return
        loop.call_soon_threadsafe(lambda: fut.done() or fut.set_result(None))

    threading.Thread(target=wait, daemon=True).start()
    return fut


async def run(settings: Settings, site_id: str) -> int:
    site = settings.site(site_id)

    print(f"\nOpening {site.display_name} ({site.url})")
    print("Log in normally in the window that opens.")
    print()
    print("  You do NOT need to come back here -- MAGI watches the page and")
    print("  finishes on its own once the message box appears. Leave this")
    print("  window alone until then; do not type the next command yet.")
    print()
    print("Your session is saved to this site's own profile folder; your personal")
    print("Chrome profile is never touched.\n")

    # force_visible: you cannot sign in to a window parked off-screen, so this
    # ignores the off-screen/headless settings that normal runs use.
    async with launcher.launch(
        site_id, settings.browser, headless=False, force_visible=True
    ) as ctx:
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        try:
            await page.goto(site.url, timeout=site.nav_timeout_s * 1000)
        except Exception as e:
            print(f"Could not load the page: {str(e)[:200]}")
            return 1

        _drain_console()
        print("Waiting for you to sign in... (ENTER here forces a check)")

        watch = asyncio.ensure_future(_await_signed_in(page, site))
        enter = _enter_future()
        done, _ = await asyncio.wait(
            {watch, enter}, return_when=asyncio.FIRST_COMPLETED
        )
        for t in (watch, enter):
            if not t.done():
                t.cancel()

        # The watcher winning means you are genuinely signed in. ENTER winning
        # means check right now and report honestly either way.
        ok = watch in done and watch.result()
        if not ok and page.is_closed():
            print("\n  The browser window was closed before the login completed.")
            print(f"  Nothing was saved. Run `magi login {site_id}` again.")
            return 1

        if not ok:
            ok = await _signed_in(page, site)

        if not ok:
            # Three different problems with three different fixes -- naming the
            # wrong one sends you to edit selectors when you just needed to
            # press "Sign in".
            if await resolve.is_challenge_page(page, site.challenge_selectors):
                print("\n  A verification page is still showing. Clear it fully, then")
                print(f"  run `magi login {site_id}` again.")
            elif await resolve.resolve(page, site.input, timeout_ms=4000):
                print(f"\n  Still signed OUT. {site.display_name} shows a message box to")
                print("  anonymous visitors, so the composer being there does not mean")
                print("  you are in -- and running like this would use the free tier")
                print(f"  rather than your account. Run `magi login {site_id}` and sign in.")
            else:
                print("\n  No message box found on the page. Either the login did not")
                print(f"  complete, or the 'input' selector is stale -- run `magi doctor {site_id}`.")
            return 1

        print(f"\n  Logged in. Session saved to {settings.browser.profile_dir(site_id)}")
        return 0
