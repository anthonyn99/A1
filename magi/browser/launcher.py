"""Launching Chrome with a persistent per-site profile.

Two decisions worth stating, because both differ from the original sketch:

  * launch_persistent_context, not launch + storage_state. Persistent profiles
    keep IndexedDB and refresh tokens; storage_state drops them, which is why
    cookie-JSON sessions on these sites expire within days.

  * headful, not headless. The automation tell that matters sits at the CDP
    layer, below where an init script can patch it, so headless mainly buys you
    challenges. Real Chrome (channel="chrome") over bundled Chromium for the
    same reason.

MAGI never touches your personal Chrome profile. Each site gets its own
directory under profiles/, so your normal browser can stay open.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path

from playwright.async_api import BrowserContext, async_playwright

from .. import proc
from ..errors import FailureKind, ProviderError
from ..settings import BrowserConfig
from . import winhide


# Files Chrome uses to claim a profile. Names differ across platforms and
# Chrome versions -- Windows uses "lockfile", POSIX uses the Singleton* set.
_LOCK_FILES = ("SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile")


def _clear_stale_locks(profile_dir: Path) -> list[str]:
    """Remove lock files left behind by a crashed or killed Chrome.

    A lock only means something while a live process holds the profile. If the
    owning Chrome died (or was killed by MAGI.bat freeing the port), the file
    survives and every later run fails with Playwright's opaque "already in use
    by another instance" error. Since each profile here belongs solely to MAGI
    and is used by one run at a time, a leftover lock is safe to clear.

    Callers must confirm no live Chrome owns the profile before calling this.
    """
    cleared = []
    for name in _LOCK_FILES:
        p = profile_dir / name
        try:
            if p.exists() or p.is_symlink():
                p.unlink()
                cleared.append(name)
        except OSError:
            # Still held by a running process -- leave it and let the caller
            # report the profile as genuinely locked.
            pass
    return cleared


def _chrome_pids_using(profile_dir: Path) -> list[int]:
    """PIDs of live Chrome processes holding this profile.

    Uses PowerShell's CIM rather than wmic: wmic is deprecated and no longer
    present on current Windows 11, where it returns nothing at all -- which
    silently reported every locked profile as free and produced a confusing
    "browser_crash" instead of an actionable message.
    """
    target = str(profile_dir).lower().replace("/", "\\")
    ps = (
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "
        "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"
    )
    out = proc.powershell(ps)

    pids: list[int] = []
    for line in out.splitlines():
        pid, _, cmd = line.partition("\t")
        if target in cmd.lower() and pid.strip().isdigit():
            pids.append(int(pid.strip()))
    return pids


def _profile_in_use(profile_dir: Path) -> bool:
    return bool(_chrome_pids_using(profile_dir))


def _kill_pids(pids: list[int]) -> None:
    """Close orphaned MAGI browser processes holding a profile."""
    for pid in pids:
        try:
            proc.run(
                ["taskkill", "/f", "/t", "/pid", str(pid)],
                capture_output=True, timeout=15,
            )
        except Exception:
            pass


def _headless_user_agent(cfg: BrowserConfig) -> str:
    """A user agent with the headless giveaway removed.

    Headless Chrome advertises itself: its UA contains "HeadlessChrome/141..."
    instead of "Chrome/141...". That single token is what Cloudflare keys on --
    with it, chatgpt.com and claude.ai serve an unclearable "Just a moment..."
    page; with it stripped, both load and answer normally in headless.

    The version is read from the installed Chrome rather than hardcoded, so
    this does not silently rot into a mismatched (and therefore suspicious)
    fingerprint every time Chrome updates.
    """
    if cfg.headless_user_agent:
        return cfg.headless_user_agent

    # Read the version out of Chrome's own layout rather than shelling out for
    # it. Chrome keeps a version-named folder beside chrome.exe
    # ("Application\141.0.7390.55\"), so the answer is a directory listing --
    # no PowerShell, no console window, and nothing to wait on. This ran once
    # per provider launch: four process spawns a run, for one string.
    version = "141.0.0.0"
    roots = [
        os.environ.get("PROGRAMFILES", r"C:\Program Files"),
        os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"),
        os.environ.get("LOCALAPPDATA", ""),
    ]
    for root in roots:
        if not root:
            continue
        app = Path(root) / "Google" / "Chrome" / "Application"
        try:
            names = [
                d.name for d in app.iterdir()
                if d.is_dir() and d.name[:1].isdigit()
            ]
        except OSError:
            continue
        if names:
            names.sort(key=lambda n: [int(x) for x in n.split(".") if x.isdigit()])
            version = names[-1]
            break

    return (
        f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        f"(KHTML, like Gecko) Chrome/{version} Safari/537.36"
    )


def _window_position(site_id: str, cfg: BrowserConfig) -> tuple[int, int]:
    """Where to put this site's window.

    Off-screen mode parks every window far outside the desktop, which is how
    MAGI runs invisibly. It has to work this way because real headless mode is
    not an option: ChatGPT and Claude sit behind Cloudflare, which serves
    headless Chrome an unclearable challenge page. An off-screen headful window
    keeps the browser fingerprint that passes, while showing nothing.

    Otherwise windows tile into quadrants rather than stacking -- overlapping
    windows get occluded, and Windows throttles occluded windows, which would
    slow the members we launched in parallel to go faster.
    """
    if cfg.offscreen:
        # Far enough out that it misses any plausible multi-monitor layout.
        return (-32000, -32000)
    order = cfg.window_order or []
    idx = order.index(site_id) if site_id in order else 0
    w, h = cfg.window_size
    col, row = idx % 2, idx // 2
    return (col * (w + 12), row * (h + 12))


@asynccontextmanager
async def launch(
    site_id: str,
    cfg: BrowserConfig,
    *,
    headless: bool | None = None,
    force_visible: bool = False,
):
    """Yield a BrowserContext bound to this site's persistent profile.

    `force_visible` overrides off-screen mode. Anything the user has to
    interact with -- signing in, clearing a challenge by hand -- must appear on
    screen, or they are being asked to type into a window they cannot see.
    """
    profile_dir = cfg.profile_dir(site_id)

    # An orphaned MAGI browser -- left behind when a run was interrupted --
    # holds the profile forever and blocks every later run for that member.
    # These windows belong solely to MAGI (never the user's own Chrome, which
    # uses a different profile directory), so closing them is safe and saves
    # the user from hunting down a stray window.
    pids = _chrome_pids_using(profile_dir)
    if pids and cfg.reclaim_orphaned_profiles:
        _kill_pids(pids)
        await asyncio.sleep(1.0)
        pids = _chrome_pids_using(profile_dir)

    if pids:
        raise ProviderError(
            FailureKind.PROFILE_LOCKED,
            f"A Chrome window is already using the {site_id} profile "
            f"(PID {', '.join(str(p) for p in pids)}). Close that window and "
            f"retry. It is a MAGI browser window, not your personal Chrome.",
        )

    # No live owner, so any lock file is stale -- from a crashed run or a
    # process killed mid-flight. Clear it rather than making the user hunt
    # down a file to delete by hand.
    _clear_stale_locks(profile_dir)

    w, h = cfg.window_size
    async with async_playwright() as p:

        if force_visible:
            # Copy with off-screen disabled, so the window lands on the desktop.
            visible_cfg = replace(cfg, offscreen=False)
            pos_x, pos_y = _window_position(site_id, visible_cfg)
        else:
            pos_x, pos_y = _window_position(site_id, cfg)

        # Headless Chrome leaks "HeadlessChrome" in its user agent, which is
        # what gets it challenged. Override it whenever running headless.
        effective_headless = cfg.headless if headless is None else headless
        extra_args = (
            [f"--user-agent={_headless_user_agent(cfg)}"] if effective_headless else []
        )

        async def _try_launch() -> BrowserContext:
            return await p.chromium.launch_persistent_context(
                user_data_dir=str(profile_dir),
                channel=cfg.channel,
                headless=cfg.headless if headless is None else headless,
                slow_mo=cfg.slow_mo_ms or 0,
                viewport={"width": w, "height": h},
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-first-run",
                    "--no-default-browser-check",
                    f"--window-size={w},{h}",
                    f"--window-position={pos_x},{pos_y}",
                    # Four Chromes starting at once contend for CPU, and page
                    # load degraded from 1.0s to 8.2s under that contention.
                    # Trimming startup work makes simultaneous launches viable.
                    "--disable-background-networking",
                    "--disable-client-side-phishing-detection",
                    "--disable-component-update",
                    "--disable-domain-reliability",
                    "--disable-sync",
                    "--no-pings",
                    "--metrics-recording-only",
                    "--disable-breakpad",
                    # Windows throttles work in occluded/minimised windows.
                    # Four overlapping windows means most of them ARE occluded,
                    # which would otherwise slow the very members we launched
                    # in parallel to speed up.
                    "--disable-backgrounding-occluded-windows",
                    "--disable-renderer-backgrounding",
                    "--disable-background-timer-throttling",
                    *extra_args,
                ],
            )

        try:
            try:
                context: BrowserContext = await _try_launch()
            except Exception as first:
                # "Opening in existing browser session" means a lock file was
                # present. The pre-flight check above can miss it: a Chrome
                # killed moments earlier writes its lock before dying, and the
                # process list is already clear by the time we look. Since no
                # live process owns the profile, clear the lock and retry once.
                if "existing browser session" not in str(first).lower():
                    raise
                if _profile_in_use(profile_dir):
                    raise ProviderError(
                        FailureKind.PROFILE_LOCKED,
                        f"A Chrome window is already using the {site_id} profile. "
                        f"Close it and retry.",
                    ) from first
                _clear_stale_locks(profile_dir)
                await asyncio.sleep(0.6)
                context = await _try_launch()
        except ProviderError:
            raise
        except Exception as e:
            msg = str(e)
            if "executable doesn't exist" in msg.lower() or "channel" in msg.lower():
                raise ProviderError(
                    FailureKind.BROWSER_CRASH,
                    f"Could not launch Chrome (channel={cfg.channel!r}). Install Google "
                    f"Chrome, or set browser.channel to 'chromium' in config/magi.yaml. "
                    f"Original error: {msg}",
                ) from e
            raise ProviderError(FailureKind.BROWSER_CRASH, msg) from e

        # Off-screen windows still get a taskbar button. Hide it at the Win32
        # level so a run leaves no visible trace. Skipped when the window is
        # meant to be seen (login), and unnecessary in true headless.
        if cfg.offscreen and not force_visible:
            effective_headless = cfg.headless if headless is None else headless
            if not effective_headless:
                # Chrome can create its window a moment after launch returns,
                # so retry briefly rather than racing it.
                for _ in range(6):
                    if winhide.hide_windows_for_profile(profile_dir):
                        break
                    await asyncio.sleep(0.25)

        try:
            yield context
        finally:
            try:
                await context.close()
            except Exception:
                pass
