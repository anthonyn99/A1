"""Which account each unit is signed in as, and how to change it.

MAGI drives your own logged-in sessions, so "which account is this?" is a real
question with real consequences: a unit signed in to a free personal account
answers a run you thought was going to your subscription, and nothing on screen
would say so. Until now the only way to find out was to run the doctor, read
`signed_in`, and infer.

THREE THINGS THIS DELIBERATELY DOES NOT DO
------------------------------------------
**It does not scrape the account's email.** Every site puts it somewhere
different, behind a menu, and all seven are behind logins -- so seven more
selectors to discover and maintain, each of which would silently rot into
showing the WRONG account, which is worse than showing none. You label the
profile yourself instead; a label you wrote is never stale in a way that lies.

**It does not open a browser to build the list.** Seven real Chrome launches to
render a settings tab is absurd. The listing reads the filesystem, which is
instant, and a live check is one unit at a time, on request.

**It does not touch your credentials.** Signing in opens the real site in a real
window and you type into it exactly as you normally would. Signing out deletes
MAGI's copy of the session and nothing else -- it is not a sign-out at the
provider, and your personal Chrome is never involved.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .browser import launcher, resolve
from .settings import ROOT, Settings

PROFILES = ROOT / "profiles"
STATE_FILE = ROOT / "data" / "accounts.json"

# Long enough for a password manager, a 2FA code and a slow challenge; short
# enough that a forgotten window does not hold the profile lock all day.
LOGIN_TIMEOUT_S = 15 * 60
POLL_S = 1.5


# ── the notes you keep about each profile ───────────────────────────────────

def _load() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=1), encoding="utf-8")


def set_label(site_id: str, label: str) -> dict:
    state = _load()
    entry = state.setdefault(site_id, {})
    entry["label"] = label.strip()[:80]
    _save(state)
    return entry


def _record_check(site_id: str, signed_in: bool, detail: str = "") -> None:
    state = _load()
    entry = state.setdefault(site_id, {})
    entry["signed_in"] = signed_in
    entry["checked_at"] = datetime.now(timezone.utc).isoformat()
    entry["detail"] = detail
    _save(state)


def _dir_bytes(p: Path) -> int:
    total = 0
    try:
        for f in p.rglob("*"):
            if f.is_file():
                try:
                    total += f.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


def _profile_dir(site_id: str) -> Path:
    return PROFILES / site_id


def listing(settings: Settings) -> list[dict]:
    """Every configured unit and the state of its saved session.

    Filesystem only. `signed_in` is whatever the last live check found, and is
    None when there has never been one -- reported as "not checked" rather
    than guessed, because "there is a profile folder" and "that session still
    works" are different claims.
    """
    state = _load()
    out = []
    for sid, site in settings.sites.items():
        d = _profile_dir(sid)
        exists = d.exists() and any(d.iterdir()) if d.exists() else False
        entry = state.get(sid, {})
        mtime = None
        if exists:
            try:
                mtime = datetime.fromtimestamp(
                    d.stat().st_mtime, tz=timezone.utc
                ).isoformat()
            except OSError:
                pass
        out.append({
            "id": sid,
            "display_name": site.display_name,
            "accent": site.accent,
            "url": site.url,
            "enabled": settings.enabled.get(sid, True),
            "profile": exists,
            "label": entry.get("label", ""),
            "signed_in": entry.get("signed_in"),
            "checked_at": entry.get("checked_at"),
            "detail": entry.get("detail", ""),
            "last_used": mtime,
            "size_mb": round(_dir_bytes(d) / 1_048_576, 1) if exists else 0.0,
        })
    return out


# ── is this session still good? ─────────────────────────────────────────────

async def check(settings: Settings, site_id: str) -> dict:
    """Open the site once, headless, and see whether the saved session holds.

    The composer alone is NOT proof. Gemini and ChatGPT both render a working
    message box to logged-OUT visitors, so checking only for that reports
    success for a session that is anonymous -- and MAGI then runs the whole
    council against a free tier instead of the subscription it was pointed at.
    `login_selectors` is the per-site "you are not signed in" sentinel.
    """
    site = settings.site(site_id)
    detail = ""
    signed_in = False
    try:
        async with launcher.launch(
            site_id, settings.browser, headless=True if site.headless_ok else None
        ) as ctx:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            await page.goto(site.url, timeout=site.nav_timeout_s * 1000)
            await asyncio.sleep(3)
            if await resolve.is_challenge_page(page, site.challenge_selectors):
                detail = "A bot-verification page is showing; sign in again to clear it."
            elif not await resolve.resolve(page, site.input, timeout_ms=1500):
                detail = "No message box on the page — either signed out or the selector is stale."
            elif await resolve.signed_out(page, site.login_selectors):
                # Both branches below are "a sign-in control is on the page";
                # only the wording differs, because on a site that shows a wall
                # that IS the answer, and on one that shows a permanent Log in
                # button it is not.
                detail = "The page still offers a sign-in control."
            else:
                signed_in = True
                detail = "Signed in."
    except Exception as e:  # noqa: BLE001 -- the cause is the whole point here
        detail = f"Could not check: {str(e)[:200]}"
    _record_check(site_id, signed_in, detail)
    return {"id": site_id, "signed_in": signed_in, "detail": detail}


# ── signing out ─────────────────────────────────────────────────────────────

def sign_out(site_id: str) -> dict:
    """Delete MAGI's copy of the session, so a different account can be used.

    Not a sign-out at the provider and nothing to do with your personal
    Chrome: it removes profiles/<site>/ and that is all. Windows will refuse
    while a browser still holds the profile lock, which is the correct
    outcome -- deleting a live profile half-way would leave a session that
    loads but cannot be trusted.
    """
    d = _profile_dir(site_id)
    if not d.exists():
        return {"id": site_id, "removed": False, "detail": "There was no saved session."}
    try:
        shutil.rmtree(d)
    except OSError as e:
        return {
            "id": site_id, "removed": False,
            "detail": f"Could not remove it — a browser may still have it open ({e.strerror or e}).",
        }
    state = _load()
    entry = state.setdefault(site_id, {})
    entry.pop("signed_in", None)
    entry.pop("checked_at", None)
    entry["detail"] = "Signed out."
    _save(state)
    return {"id": site_id, "removed": True, "detail": "Signed out."}


# ── signing in ──────────────────────────────────────────────────────────────

@dataclass
class LoginJob:
    site_id: str
    state: str = "opening"        # opening | waiting | done | failed | cancelled
    detail: str = ""
    started: float = field(default_factory=time.monotonic)
    cancel: asyncio.Event = field(default_factory=asyncio.Event)

    def snapshot(self) -> dict:
        return {
            "site_id": self.site_id,
            "state": self.state,
            "detail": self.detail,
            "elapsed_s": int(time.monotonic() - self.started),
        }


async def _signed_in(page, site) -> bool:
    if await resolve.is_challenge_page(page, site.challenge_selectors):
        return False
    if not await resolve.resolve(page, site.input, timeout_ms=800):
        return False
    return not await resolve.signed_out(page, site.login_selectors)


async def run_login(settings: Settings, job: LoginJob) -> None:
    """Open a real window on THIS machine and wait for the sign-in to land.

    Polls the page rather than asking anyone to confirm. There is nobody at
    the keyboard of a phone that started this, and the person at the engine
    device is busy typing a password -- so "the composer appeared and the
    sign-in control did not" is the only signal that can end this wait.
    """
    site = settings.site(job.site_id)
    try:
        # force_visible: you cannot sign in to a window parked off-screen, so
        # this ignores the off-screen/headless settings normal runs use.
        async with launcher.launch(
            job.site_id, settings.browser, headless=False, force_visible=True
        ) as ctx:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            await page.goto(site.url, timeout=site.nav_timeout_s * 1000)
            job.state = "waiting"
            job.detail = f"Sign in to {site.display_name} in the window on the engine device."

            deadline = time.monotonic() + LOGIN_TIMEOUT_S
            while time.monotonic() < deadline:
                if job.cancel.is_set():
                    job.state, job.detail = "cancelled", "Cancelled."
                    _record_check(job.site_id, False, "Sign-in was cancelled.")
                    return
                if page.is_closed():
                    job.state = "failed"
                    job.detail = "The window was closed before the sign-in finished."
                    _record_check(job.site_id, False, job.detail)
                    return
                try:
                    if await _signed_in(page, site):
                        job.state, job.detail = "done", f"Signed in to {site.display_name}."
                        _record_check(job.site_id, True, "Signed in.")
                        return
                except Exception:
                    # Mid-navigation the page is torn down under the query.
                    # Not a failure: the next poll runs on the new document.
                    pass
                await asyncio.sleep(POLL_S)

            job.state = "failed"
            job.detail = "Timed out waiting for the sign-in."
            _record_check(job.site_id, False, job.detail)
    except Exception as e:  # noqa: BLE001
        job.state = "failed"
        job.detail = f"Could not open the window: {str(e)[:200]}"
        _record_check(job.site_id, False, job.detail)


# ── who chairs the council ──────────────────────────────────────────────────
# The chairman is the member that reads every answer and writes the verdict,
# and which one it is genuinely changes the result -- so it belongs in the
# console next to the units, not only in a YAML file on one machine.
#
# Stored as an OVERRIDE rather than by rewriting magi.yaml. Rewriting config
# means a program editing a file a person also edits, and the first comment or
# blank line it eats is gone for good; an override is one key that is either
# set or absent, and deleting it restores whatever the config says.
#
# It is stored on the ENGINE, not in Firestore, because unlike the unit order
# this is not a per-person preference: it decides how a run is actually
# conducted, and a run happens in exactly one place.

def chairman_override() -> str:
    return str(_load().get("_chairman", "") or "")


def set_chairman(site_id: str) -> dict:
    """Set the chairman, or clear it with an empty id."""
    state = _load()
    if site_id:
        state["_chairman"] = site_id
    else:
        state.pop("_chairman", None)
    _save(state)
    return {"chairman": chairman_override()}
