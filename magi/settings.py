"""Config loading for MAGI.

Two files, deliberately separate:
  config/magi.yaml      -- behaviour (pacing, which providers, chairman)
  config/selectors.yaml -- per-site CSS selectors

Selectors are split out because they are the thing that breaks when a site
ships a redesign, and the person fixing them should never have to open a .py
file to do it.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

# MAGI's home inside A1 (this file is A1/magi/settings.py). Everything MAGI
# owns -- config, profiles, run history, failure artifacts, .env -- lives under
# here, so the A1 repo root stays the flat page directory it is for every other
# program. Derived once and imported by anything else that needs it, rather
# than each module counting `parents[n]` for itself.
ROOT = Path(__file__).resolve().parent
CONFIG_DIR = ROOT / "config"


def _as_list(value: Any) -> list[str]:
    """Selector fields may be a bare string or a list; normalise to list.

    Being permissive here matters: someone hand-editing selectors.yaml at 1am
    to unbreak a scrape should not have their fix silently ignored because they
    wrote a string where a list was expected.
    """
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    return [str(v) for v in value]


@dataclass
class Pacing:
    mode: str = "parallel"
    max_concurrency: int = 4
    inter_provider_delay_s: tuple[float, float] = (0.4, 1.5)
    typing_delay_ms: tuple[int, int] = (8, 24)
    pre_send_pause_s: tuple[float, float] = (0.25, 0.7)
    post_nav_pause_s: tuple[float, float] = (0.6, 1.4)
    # Prompts at or above this length are inserted in one operation instead of
    # typed. Typing a 2,372-char synthesis prompt took 86s of a 233s run.
    paste_threshold: int = 400

    def sample_typing_delay(self) -> int:
        return random.randint(int(self.typing_delay_ms[0]), int(self.typing_delay_ms[1]))

    def sample_pre_send(self) -> float:
        return random.uniform(*self.pre_send_pause_s)

    def sample_post_nav(self) -> float:
        return random.uniform(*self.post_nav_pause_s)

    def sample_inter_provider(self) -> float:
        return random.uniform(*self.inter_provider_delay_s)


@dataclass
class BrowserConfig:
    channel: str = "chrome"
    headless: bool = False
    slow_mo_ms: int = 0
    # Sized so four windows tile on a 1080p screen without overlapping --
    # overlapping windows get occluded, and Windows throttles occluded windows.
    window_size: tuple[int, int] = (940, 520)
    # Tiling order; a site's index here decides its quadrant.
    window_order: tuple[str, ...] = ("chatgpt", "claude", "gemini", "deepseek")
    # Move browser windows far off-screen so runs are invisible.
    #
    # This exists because true headless does NOT work: ChatGPT and Claude are
    # both Cloudflare-fronted and serve headless Chrome an unclearable "Just a
    # moment..." challenge (verified -- headless never gets past it, headful
    # clears it in ~3s). An off-screen headful window keeps the real browser
    # fingerprint that passes the challenge while showing nothing on screen.
    offscreen: bool = False
    # Overrides the UA used in headless mode. Leave empty to derive it from the
    # installed Chrome version, which keeps it consistent as Chrome updates.
    headless_user_agent: str = ""
    profile_root: str = "profiles"
    # Close orphaned MAGI browser windows still holding a profile. Safe by
    # default: these profiles are used only by MAGI, never by your own Chrome.
    reclaim_orphaned_profiles: bool = True

    def profile_dir(self, site_id: str) -> Path:
        d = ROOT / self.profile_root / site_id
        d.mkdir(parents=True, exist_ok=True)
        return d


@dataclass
class SiteSelectors:
    """Selectors for one site. Every field is a list, tried in order."""

    id: str
    display_name: str
    url: str
    accent: str = "#8D769A"
    input: list[str] = field(default_factory=list)
    submit: list[str] = field(default_factory=list)
    # The underlying <input type="file">. Every site keeps one in the DOM even
    # when the visible "attach" control is a styled button/icon that merely
    # clicks it -- so upload never needs to simulate that click, only find the
    # real input and hand it files via Playwright's set_input_files.
    file_input: list[str] = field(default_factory=list)
    send_key: str = "Enter"
    assistant_turn: list[str] = field(default_factory=list)
    stop_button: list[str] = field(default_factory=list)
    streaming_marker: list[str] = field(default_factory=list)
    copy_button: list[str] = field(default_factory=list)
    ready_selector: list[str] = field(default_factory=list)
    login_selectors: list[str] = field(default_factory=list)
    challenge_selectors: list[str] = field(default_factory=list)
    # Markers for "you have used your quota" -- a DIFFERENT failure from a
    # challenge and from a timeout, with a different remedy (wait, or pay).
    rate_limit_selectors: list[str] = field(default_factory=list)
    # Regexes stripped from scraped answers (citation chips, injected ads, etc).
    strip_patterns: list[str] = field(default_factory=list)
    # Whether this site tolerates true headless Chrome (no window, no taskbar
    # entry at all). Cloudflare-fronted sites do not -- they serve headless an
    # unclearable challenge -- so this is per-site rather than global.
    headless_ok: bool = False
    # Does a visible sign-in control prove you are signed OUT?
    #
    # Usually not: ChatGPT and Gemini render a permanent "Log in" button to
    # signed-in users, so treating it as proof would report every session as
    # dead. Copilot is the opposite -- it shows a sign-in WALL with no usable
    # composer, and MAGI called it "usable" anyway because a bare `textarea`
    # fallback matched a hidden decoy on that wall. So the question has a
    # different answer per site and has to be asked per site.
    login_is_proof: bool = False

    poll_ms: int = 700
    stability_samples: int = 4
    # How many quiet polls must follow a semantic "finished" signal (streaming
    # marker cleared / stop button gone) before we believe it. Guards against
    # models that pause between a preamble and the real answer.
    confirm_samples: int = 3
    stall_timeout_s: int = 45
    hard_timeout_s: int = 300
    nav_timeout_s: int = 45
    ready_timeout_s: int = 30

    @classmethod
    def from_yaml(cls, site_id: str, raw: dict, defaults: dict) -> "SiteSelectors":
        merged = {**defaults, **raw}
        return cls(
            id=site_id,
            display_name=merged.get("display_name", site_id),
            url=merged["url"],
            accent=merged.get("accent", "#8D769A"),
            input=_as_list(merged.get("input")),
            submit=_as_list(merged.get("submit")),
            file_input=_as_list(merged.get("file_input")),
            send_key=merged.get("send_key", "Enter"),
            assistant_turn=_as_list(merged.get("assistant_turn")),
            stop_button=_as_list(merged.get("stop_button")),
            streaming_marker=_as_list(merged.get("streaming_marker")),
            copy_button=_as_list(merged.get("copy_button")),
            ready_selector=_as_list(merged.get("ready_selector")),
            login_selectors=_as_list(merged.get("login_selectors")),
            login_is_proof=bool(merged.get("login_is_proof", False)),
            challenge_selectors=_as_list(merged.get("challenge_selectors")),
            rate_limit_selectors=_as_list(merged.get("rate_limit_selectors")),
            strip_patterns=_as_list(merged.get("strip_patterns")),
            headless_ok=bool(merged.get("headless_ok", False)),
            poll_ms=int(merged.get("poll_ms", 700)),
            stability_samples=int(merged.get("stability_samples", 4)),
            confirm_samples=int(merged.get("confirm_samples", 3)),
            stall_timeout_s=int(merged.get("stall_timeout_s", 45)),
            hard_timeout_s=int(merged.get("hard_timeout_s", 300)),
            nav_timeout_s=int(merged.get("nav_timeout_s", 45)),
            ready_timeout_s=int(merged.get("ready_timeout_s", 30)),
        )


@dataclass
class ChairmanConfig:
    provider_id: str = "claude"
    fallback_order: list[str] = field(default_factory=list)
    min_members: int = 2


@dataclass
class Settings:
    pacing: Pacing
    browser: BrowserConfig
    chairman: ChairmanConfig
    sites: dict[str, SiteSelectors]
    enabled: dict[str, bool]
    artifacts_on_failure: bool = True
    artifacts_dir: Path = ROOT / "artifacts"
    # How many artifact FILES to keep. config/magi.yaml has carried
    # `keep_last: 200` since the beginning and nothing ever read it, so the
    # directory grew without limit -- 93MB in three days of ordinary use,
    # because every doctor probe leaves a screenshot and a full DOM dump.
    artifacts_keep_last: int = 200
    db_path: Path = ROOT / "data" / "magi.db"

    def site(self, site_id: str) -> SiteSelectors:
        if site_id not in self.sites:
            raise KeyError(
                f"No selector config for site {site_id!r}. "
                f"Known sites: {sorted(self.sites)}. Add it to config/selectors.yaml."
            )
        return self.sites[site_id]

    def enabled_site_ids(self) -> list[str]:
        return [s for s in self.sites if self.enabled.get(s, True)]


def load_settings(config_dir: Path | None = None) -> Settings:
    cdir = config_dir or CONFIG_DIR
    magi_raw = yaml.safe_load((cdir / "magi.yaml").read_text(encoding="utf-8")) or {}
    sel_raw = yaml.safe_load((cdir / "selectors.yaml").read_text(encoding="utf-8")) or {}

    p = magi_raw.get("pacing", {})
    pacing = Pacing(
        mode=p.get("mode", "parallel"),
        max_concurrency=int(p.get("max_concurrency", 4)),
        inter_provider_delay_s=tuple(p.get("inter_provider_delay_s", (0.4, 1.5))),
        typing_delay_ms=tuple(p.get("typing_delay_ms", (8, 24))),
        pre_send_pause_s=tuple(p.get("pre_send_pause_s", (0.25, 0.7))),
        post_nav_pause_s=tuple(p.get("post_nav_pause_s", (0.6, 1.4))),
        paste_threshold=int(p.get("paste_threshold", 400)),
    )

    b = magi_raw.get("browser", {})
    browser = BrowserConfig(
        channel=b.get("channel", "chrome"),
        headless=bool(b.get("headless", False)),
        slow_mo_ms=int(b.get("slow_mo_ms", 0)),
        window_size=tuple(b.get("window_size", (940, 520))),
        window_order=tuple(
            b.get("window_order", ("chatgpt", "claude", "gemini", "deepseek"))
        ),
        offscreen=bool(b.get("offscreen", False)),
        headless_user_agent=str(b.get("headless_user_agent", "")),
        profile_root=b.get("profile_root", "profiles"),
        reclaim_orphaned_profiles=bool(b.get("reclaim_orphaned_profiles", True)),
    )

    c = magi_raw.get("chairman", {})
    chairman = ChairmanConfig(
        provider_id=c.get("provider_id", "claude"),
        fallback_order=list(c.get("fallback_order", [])),
        min_members=int(c.get("min_members", 2)),
    )

    defaults = sel_raw.get("defaults", {})
    sites = {
        sid: SiteSelectors.from_yaml(sid, raw, defaults)
        for sid, raw in (sel_raw.get("sites") or {}).items()
    }

    enabled = {
        sid: bool((magi_raw.get("providers") or {}).get(sid, {}).get("enabled", True))
        for sid in sites
    }

    art = magi_raw.get("artifacts", {})
    db = magi_raw.get("database", {})

    return Settings(
        pacing=pacing,
        browser=browser,
        chairman=chairman,
        sites=sites,
        enabled=enabled,
        artifacts_on_failure=bool(art.get("on_failure", True)),
        artifacts_dir=ROOT / art.get("dir", "artifacts"),
        artifacts_keep_last=max(0, int(art.get("keep_last", 200))),
        db_path=ROOT / db.get("path", "data/magi.db"),
    )
