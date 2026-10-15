"""An attachment the site never took must not go out as a question without it.

2026-10-15: an image went to every unit; ChatGPT's free uploads were used up,
so its general file input dropped the file without a word (the "+" menu said
"Or wait 3 hours to upload again"), the question went out alone, and ChatGPT
answered "I don't see your recipe book attached". MAGI had also been handing
the files to the FIRST input[type=file] -- ChatGPT's disabled "Take a photo"
camera input. Both are pinned here against a page shaped like ChatGPT's.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from magi.browser import resolve
from magi.errors import FailureKind, explain
from magi.providers.browser_base import (
    ATTACH_SIGNS_JS,
    attach_landed,
    attachment_names,
    attachments_landed,
)
from magi.settings import load_settings

# ChatGPT's composer, 2026-10-15: four hidden file inputs, camera first.
CHATGPT_FORM = """
<form><div>
  <input id="cam" class="hidden" accept="image/*" aria-label="Take a photo" capture="environment" type="file" disabled>
  <input id="media" accept="image/*,video/*" multiple type="file" class="hidden">
  <input id="photos" accept="image/*" multiple type="file" class="hidden">
  <input id="any" multiple type="file" class="hidden">
</div><div contenteditable="true" class="ProseMirror"></div>
<div id="previews"></div></form>
"""

# A site that takes the file shows it: a blob: thumbnail.
SHOWS_IT = """<script>
document.getElementById('any').addEventListener('change', e => {
  const img = document.createElement('img');
  img.src = URL.createObjectURL(e.target.files[0]);
  document.getElementById('previews').appendChild(img);
});
</script>"""


@pytest.fixture
def png(tmp_path) -> Path:
    p = tmp_path / "d37bc9f2-recipe.png"
    # A 1x1 PNG.
    p.write_bytes(bytes.fromhex(
        "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
        "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"))
    return p


async def _page():
    pw = pytest.importorskip("playwright.async_api")
    p = await pw.async_playwright().start()
    try:
        browser = await p.chromium.launch()
    except Exception as exc:
        await p.stop()
        pytest.skip(f"chromium unavailable: {exc}")
    return p, browser, await browser.new_page()


def test_names_include_the_stem_gemini_shows():
    assert attachment_names([Path("x/notes-zebra.txt")]) == ["notes-zebra.txt", "notes-zebra"]


def test_landed_needs_something_new():
    base = {"blobs": 1, "inForm": 0, "names": ["a.png"]}
    assert not attach_landed(base, dict(base))
    assert attach_landed(base, {**base, "blobs": 2})
    assert attach_landed(base, {**base, "inForm": 1})
    assert attach_landed(base, {**base, "names": ["a.png", "a"]})


def test_refused_files_have_their_own_kind():
    cause, remedy = explain(FailureKind.ATTACH_REFUSED)
    assert "did not take" in cause and "upload" in remedy


async def test_chatgpt_files_go_to_the_general_uploader_not_the_camera():
    p, browser, page = await _page()
    try:
        await page.set_content(CHATGPT_FORM)
        box = await resolve.resolve(page, load_settings().site("chatgpt").file_input,
                                    timeout_ms=1000, require_visible=False)
        assert box is not None
        assert await box.locator.first.get_attribute("id") == "any"
    finally:
        await browser.close(); await p.stop()


async def test_a_file_the_site_shows_has_landed(png):
    p, browser, page = await _page()
    try:
        await page.set_content(CHATGPT_FORM + SHOWS_IT)
        names = attachment_names([png])
        before = await page.evaluate(ATTACH_SIGNS_JS, names)
        await page.locator("#any").set_input_files([str(png)])
        assert await attachments_landed(page, names, before, wait_s=3)
    finally:
        await browser.close(); await p.stop()


async def test_a_file_the_site_drops_has_not(png):
    p, browser, page = await _page()
    try:
        await page.set_content(CHATGPT_FORM)  # no preview: uploads used up
        names = attachment_names([png])
        before = await page.evaluate(ATTACH_SIGNS_JS, names)
        await page.locator("#any").set_input_files([str(png)])
        assert not await attachments_landed(page, names, before, wait_s=1)
    finally:
        await browser.close(); await p.stop()


async def test_chatgpt_reads_its_upload_cap_from_the_menu():
    p, browser, page = await _page()
    try:
        await page.set_content(
            '<div role="menu"><div role="menuitem">Get Plus for more uploads '
            "Or wait 3 hours to upload again</div></div>")
        said = await resolve.notice(page, load_settings().site("chatgpt").upload_limit)
        assert "wait 3 hours to upload again" in said
    finally:
        await browser.close(); await p.stop()
