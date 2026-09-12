"""Anything painted over a composer must not be able to kill a unit.

THE RUN THIS COMES FROM
Perplexity served its cookie dialog -- a fixed card pinned bottom-right, over
the composer -- and the unit failed after thirty seconds:

    Could not type: Locator.click: Timeout 30000ms exceeded.
      waiting for locator("div[contenteditable='true']#ask-input").first
      locator resolved to <div id="ask-input" role="textbox" ...>

The selector MATCHED. Playwright's click then waited for the element to pass
its actionability checks, one of which is a hit test, and a click at that point
would have landed on the dialog. MAGI called it SELECTOR_MISS, whose remedy is
"run the doctor and rewrite selectors.yaml" -- advice that would have wasted an
evening on a selector that was perfectly correct.

What is pinned here is that the fix is general, not a patch for one dialog:

  * a known dialog is clicked away before the prompt is typed;
  * an UNKNOWN one still cannot stop the prompt, because focus does no hit
    testing -- this is the half that covers dialogs nobody has seen yet, on
    every unit;
  * focus is never assumed to have worked, because a silent no-op would type
    the whole prompt into the page body;
  * and if it does fail, it is reported as what it is.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from magi.browser import overlay  # noqa: E402
from magi.errors import EXPLANATIONS, FailureKind  # noqa: E402
from magi.settings import SiteSelectors  # noqa: E402

REPO = Path(__file__).resolve().parents[2]


class FakeLocator:
    """One selector's worth of page, with the bits overlay.py touches."""

    def __init__(self, *, count=1, visible=True, text="", clickable=True,
                 focusable=True, on_click=None):
        self._count, self._visible = count, visible
        self._text, self.clickable, self.focusable = text, clickable, focusable
        self._on_click = on_click
        self.focused = False
        self.clicks, self.forced, self.focus_calls = 0, 0, 0

    @property
    def first(self):
        return self

    async def count(self):
        return self._count

    async def is_visible(self):
        return self._visible

    async def inner_text(self):
        return self._text

    async def click(self, timeout=0, force=False):
        self.clicks += 1
        if force:
            self.forced += 1
        if self._on_click:
            self._on_click()
        if not self.clickable and not force:
            raise TimeoutError("Timeout 6000ms exceeded waiting for element")
        self.focused = True

    async def focus(self, timeout=0):
        self.focus_calls += 1
        if not self.focusable:
            raise RuntimeError("cannot focus")
        self.focused = True

    async def evaluate(self, expr, *a):
        # Every evaluate overlay.py makes is either "am I focused?" or the
        # elementFromPoint probe; the tests that care about the latter override
        # this method.
        return self.focused


class FakePage:
    def __init__(self, mapping=None):
        self.mapping = mapping or {}

    def locator(self, sel):
        return self.mapping.get(sel, FakeLocator(count=0, visible=False))


# ── the known dialog: clicked away ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_visible_dismiss_control_is_clicked_and_named():
    btn = FakeLocator(text="Decline optional")
    page = FakePage({"#consent": btn})
    clicked = await overlay.dismiss(page, ["#consent"])
    assert btn.clicks == 1
    assert clicked == ["Decline optional"], "the doctor prints what it closed"


@pytest.mark.asyncio
async def test_nothing_showing_costs_nothing():
    """This runs before EVERY prompt, so the empty case must be free."""
    page = FakePage()
    assert await overlay.dismiss(page, ["#a", "#b", "#c"]) == []


@pytest.mark.asyncio
async def test_an_attached_but_invisible_control_is_left_alone():
    """A consent dialog already dismissed usually stays in the DOM, hidden."""
    btn = FakeLocator(visible=False, text="Got it")
    page = FakePage({"#consent": btn})
    assert await overlay.dismiss(page, ["#consent"]) == []
    assert btn.clicks == 0


@pytest.mark.asyncio
async def test_dismissal_never_raises():
    """Nothing about closing a dialog may fail the run it was clearing."""
    class Exploding(FakeLocator):
        async def click(self, timeout=0, force=False):
            raise RuntimeError("detached mid-click")

    page = FakePage({"#a": Exploding(text="Got it"), "#b": FakeLocator(text="Accept")})
    assert await overlay.dismiss(page, ["#a", "#b"]) == ["Accept"], "it carries on"


# ── the unknown dialog: focus does not hit-test ──────────────────────────────

@pytest.mark.asyncio
async def test_a_clickable_composer_is_simply_clicked():
    box = FakeLocator()
    assert await overlay.focus_composer(FakePage(), box) == "click"
    assert box.focus_calls == 0, "no need to reach for anything else"


@pytest.mark.asyncio
async def test_a_covered_composer_is_uncovered_then_clicked():
    box = FakeLocator(clickable=False)
    btn = FakeLocator(text="Got it", on_click=lambda: setattr(box, "clickable", True))
    page = FakePage({"#consent": btn})
    route = await overlay.focus_composer(page, box, dismiss_selectors=["#consent"])
    assert route.startswith("click, after dismissing")
    assert btn.clicks == 1


@pytest.mark.asyncio
async def test_an_unrecognised_overlay_is_survived_by_focusing():
    """The half that matters for units nobody has debugged yet."""
    box = FakeLocator(clickable=False)
    route = await overlay.focus_composer(FakePage(), box, dismiss_selectors=[])
    assert route == "focus"
    assert box.focused, "the caret really is in the composer"
    assert box.forced == 0, "a forced click was not needed"


@pytest.mark.asyncio
async def test_focus_is_verified_not_assumed():
    """A focus() that quietly does nothing would type the prompt into the page."""
    class Liar(FakeLocator):
        async def focus(self, timeout=0):
            self.focus_calls += 1          # says yes, changes nothing

    box = Liar(clickable=False)
    route = await overlay.focus_composer(FakePage(), box)
    assert box.focus_calls == 1
    assert route == "forced click", "the unproven route was not trusted"


@pytest.mark.asyncio
async def test_every_route_failing_raises_the_original_click_error():
    """So the message names the real symptom, not 'focus failed'."""
    class Immovable(FakeLocator):
        async def click(self, timeout=0, force=False):
            raise TimeoutError("Timeout 6000ms exceeded waiting for element")

        async def focus(self, timeout=0):
            raise RuntimeError("nope")

    with pytest.raises(TimeoutError, match="Timeout 6000ms"):
        await overlay.focus_composer(FakePage(), Immovable())


@pytest.mark.asyncio
async def test_a_composer_that_already_has_the_caret_is_left_alone():
    """The run focuses it; the typing helper must not then click it again."""
    box = FakeLocator()
    box.focused = True
    await overlay.enter_composer(FakePage(), box)
    assert box.clicks == 0 and box.focus_calls == 0


@pytest.mark.asyncio
async def test_the_click_timeout_is_not_playwrights_default():
    """Thirty seconds per attempt is what made one dialog cost a whole unit."""
    assert overlay.CLICK_TIMEOUT_MS <= 10_000


# ── the diagnosis ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_the_blocker_is_named_for_the_error_message():
    class Covered(FakeLocator):
        async def evaluate(self, expr, *a):
            return "consent-dialog" if "elementFromPoint" in expr else self.focused

    assert await overlay.blocker(Covered()) == "consent-dialog"


@pytest.mark.asyncio
async def test_an_uncovered_composer_reports_no_blocker():
    class Clear(FakeLocator):
        async def evaluate(self, expr, *a):
            return "" if "elementFromPoint" in expr else self.focused

    assert await overlay.blocker(Clear()) == ""


def test_a_block_is_not_reported_as_a_broken_selector():
    """The whole point: SELECTOR_MISS sends you to rewrite selectors.yaml."""
    assert FailureKind.OVERLAY_BLOCKED in EXPLANATIONS
    cause, remedy = EXPLANATIONS[FailureKind.OVERLAY_BLOCKED]
    assert "covering" in cause.lower()
    assert "dismiss_selectors" in remedy
    assert FailureKind.OVERLAY_BLOCKED is not FailureKind.SELECTOR_MISS


def test_the_run_reports_that_kind_and_saves_a_picture_of_it():
    src = (REPO / "magi" / "providers" / "browser_base.py").read_text(encoding="utf-8")
    assert "FailureKind.OVERLAY_BLOCKED" in src
    assert "composer-blocked" in src, "a blocked run must leave an artifact to look at"
    assert src.index("overlay.dismiss") < src.index("capture_baseline"), (
        "dialogs are cleared BEFORE the baseline, or one closing looks like the "
        "page changing"
    )


# ── the config ───────────────────────────────────────────────────────────────

def _yaml():
    return yaml.safe_load(
        (REPO / "magi" / "config" / "selectors.yaml").read_text(encoding="utf-8")
    )


def test_every_unit_gets_the_shared_dismissal_list():
    """A site that names its own dialogs must not lose the common ones."""
    raw = _yaml()
    shared = raw["defaults"]["dismiss_selectors"]
    assert shared, "the shared list is what covers units nobody has debugged"
    for sid, cfg in raw["sites"].items():
        site = SiteSelectors.from_yaml(sid, cfg, raw["defaults"])
        assert set(shared) <= set(site.dismiss_selectors), sid
        own = cfg.get("dismiss_selectors") or []
        if own:
            assert site.dismiss_selectors[: len(own)] == own, (
                f"{sid}: its own, more specific selectors should be tried first"
            )


def test_perplexitys_cookie_dialog_is_configured():
    """The one that actually cost a run."""
    raw = _yaml()
    own = raw["sites"]["perplexity"].get("dismiss_selectors") or []
    assert any("consent-dialog" in s for s in own), (
        "the dialog from artifacts/perplexity-type-failed-20260912-191946.html"
    )
    assert "Decline optional" in own[0], "refuse before accepting, on your account"


def test_the_shared_list_cannot_click_anything_it_likes():
    """Everything here is clicked automatically on a signed-in page."""
    shared = _yaml()["defaults"]["dismiss_selectors"]
    for sel in shared:
        scoped = any(
            k in sel for k in ("[role='dialog']", "[aria-modal='true']", "aria-label")
        )
        assert scoped, f"{sel!r} is not scoped to a dialog"
    banned = ("Delete", "Remove", "Sign out", "Log out", "Clear", "New chat")
    for sel in shared:
        for word in banned:
            assert word.lower() not in sel.lower(), f"{sel!r} could do real damage"
