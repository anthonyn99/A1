"""Turn a finished pipeline job into a real PDF slide deck.

The generation step produces TEXT — one "## Slide N" section per slide, already
coverage-checked by server.missing_slides(). This module is the output stage:
it pairs each of those sections with a picture of the ACTUAL slide it describes
and lays the pair out as one page of a new PDF.

── WHY THE IMAGES COME FROM THE SOURCE PDF, NOT FROM CLAUDE ──────────────────
They have to. Claude's answer never carries images on either route:
  * the API path keeps only `type === 'text'` content blocks
    (workers/studyos-ai/worker.js), and
  * the browser path's DOM→markdown walker (driver.DOM_TO_MARKDOWN_JS) has no
    IMG case at all, so an <img> in a chat reply is silently dropped.
So "the original diagram" can only mean "page N of the file the user uploaded",
re-rendered here. The join key is the slide number Claude already cites in its
"## Slide N" headings — the same numbers the coverage checker enforces, which
is what makes this pairing trustworthy rather than positional guesswork.

── WHY PyMuPDF AND NOT A HEADLESS BROWSER TAB ────────────────────────────────
Chromium will not render a local PDF for a screenshot: navigating a Playwright
page to a .pdf (file:// or http://) raises "Download is starting" instead of
painting it. PyMuPDF rasterises pages directly, ships a prebuilt Windows wheel,
and needs no poppler/ghostscript install. Playwright is still used for the
ASSEMBLY step, where it is rendering ordinary HTML and is perfectly happy.
"""

from __future__ import annotations

import asyncio
import base64
import html as _html
import re
from pathlib import Path

# Import as `pymupdf`, not the deprecated `fitz` alias.
try:
    import pymupdf
except ImportError:  # pragma: no cover - surfaced as a job error, not a crash
    pymupdf = None

# Same shape as server._SLIDE_RE. Duplicated rather than imported to keep this
# module standalone-testable (server.py starts an HTTP server on import-time
# argv parsing); the two must stay in step.
_SLIDE_RE = re.compile(r"^#{1,6}\s*Slide\s*[:#-]?\s*(\d+)", re.I | re.M)

RENDER_DPI = 150          # legible diagrams without ballooning the PDF


# ── 1. Page rendering ─────────────────────────────────────────────────────────
def render_pages(pdf_path, dpi: int = RENDER_DPI) -> dict[int, bytes]:
    """Rasterise every page of `pdf_path` -> {1-indexed page number: PNG bytes}.

    1-indexed to match the "## Slide N" numbering used by the prompt, the
    coverage checker and the Worker alike.

    A page that fails to render is OMITTED rather than raised: one malformed
    page must not cost the user a 95-page generation that otherwise succeeded.
    The caller treats a missing page as "text only" for that slide.
    """
    if pymupdf is None:
        raise RuntimeError("PyMuPDF is not installed — run: pip install pymupdf")

    path = Path(pdf_path)
    if not path.exists():
        raise FileNotFoundError(f"source PDF not found: {path}")

    out: dict[int, bytes] = {}
    with pymupdf.open(path) as doc:
        for i, page in enumerate(doc, start=1):
            try:
                out[i] = page.get_pixmap(dpi=dpi).tobytes("png")
            except Exception:
                continue          # omit, don't fail the job
    return out


# ── 2. Splitting the generated text back into slides ──────────────────────────
def split_slides(text: str) -> list[tuple[int, str]]:
    """["## Slide 3", body…] -> [(3, "body…"), …] in document order.

    Keeps the body only; the heading is re-rendered by the layout so numbering
    stays consistent even when Claude wrote "### Slide 3" or "## Slide: 3".
    Anything before the first heading is preamble and is dropped, matching
    server.trim_to_first_slide().
    """
    if not text:
        return []
    matches = list(_SLIDE_RE.finditer(text))
    slides: list[tuple[int, str]] = []
    for idx, m in enumerate(matches):
        body_start = text.find("\n", m.end())
        body_start = len(text) if body_start == -1 else body_start + 1
        body_end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        slides.append((int(m.group(1)), text[body_start:body_end].strip()))
    return slides


# ── 3. Markdown -> HTML ───────────────────────────────────────────────────────
# A deliberately small subset, mirroring _sosMdToHtml in js/studyos.js: headings,
# bullets, numbered lists, bold/italic/code. This is a one-way render, so it does
# not need to share code with the JS version — it needs to AGREE with it.
def _inline(s: str) -> str:
    s = _html.escape(s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", s)
    return s


def _is_table_sep(line: str) -> bool:
    """A GFM header separator: | --- | :---: |"""
    s = line.strip()
    return bool(s.startswith("|") and re.fullmatch(r"[|\s:-]+", s) and "-" in s)


def _split_row(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def md_to_html(md: str) -> str:
    """Markdown -> HTML for the subset real answers actually contain.

    Tables are supported because the decks this runs on are full of them — a
    Boolean-algebra chapter is mostly truth tables, and without this they
    printed as literal "| 0 | 1 |" pipe soup.
    """
    out: list[str] = []
    list_kind: str | None = None
    lines = (md or "").split("\n")

    def close_list() -> None:
        nonlocal list_kind
        if list_kind:
            out.append(f"</{list_kind}>")
            list_kind = None

    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        if not line.strip():
            close_list()
            i += 1
            continue

        # ── GFM table: a header row followed by a |---|---| separator ────────
        if (line.strip().startswith("|") and i + 1 < len(lines)
                and _is_table_sep(lines[i + 1])):
            close_list()
            header = _split_row(line)
            i += 2
            body: list[list[str]] = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                body.append(_split_row(lines[i]))
                i += 1
            out.append("<table><thead><tr>"
                       + "".join(f"<th>{_inline(c)}</th>" for c in header)
                       + "</tr></thead><tbody>")
            for row in body:
                out.append("<tr>" + "".join(f"<td>{_inline(c)}</td>" for c in row)
                           + "</tr>")
            out.append("</tbody></table>")
            continue

        # A horizontal rule. Claude uses "---" to separate slides, so without
        # this it printed as a literal "---" line at the top of the next page.
        if re.fullmatch(r"(-{3,}|\*{3,}|_{3,})", line.strip()):
            close_list()
            i += 1
            continue

        i += 1
        h = re.match(r"^(#{1,6})\s+(.*)$", line)
        if h:
            close_list()
            lvl = min(len(h.group(1)) + 1, 6)   # demote: page title owns <h1>
            out.append(f"<h{lvl}>{_inline(h.group(2))}</h{lvl}>")
            continue

        ul = re.match(r"^\s*[-*+]\s+(.*)$", line)
        if ul:
            if list_kind != "ul":
                close_list()
                out.append("<ul>")
                list_kind = "ul"
            out.append(f"<li>{_inline(ul.group(1))}</li>")
            continue

        ol = re.match(r"^\s*\d+[.)]\s+(.*)$", line)
        if ol:
            if list_kind != "ol":
                close_list()
                out.append("<ol>")
                list_kind = "ol"
            out.append(f"<li>{_inline(ol.group(1))}</li>")
            continue

        close_list()
        out.append(f"<p>{_inline(line)}</p>")

    close_list()
    return "\n".join(out)


# ── 4. Deck layout ────────────────────────────────────────────────────────────
_CSS = """
@page { size: Letter; margin: 0.5in; }
* { box-sizing: border-box; }
body { margin: 0; font: 11pt/1.5 -apple-system, "Segoe UI", Roboto, sans-serif;
       color: #1a1a1a; }
.slide { page-break-after: always; }
.slide:last-child { page-break-after: auto; }
.slide-no { font-size: 9pt; letter-spacing: .08em; text-transform: uppercase;
            color: #8D769A; font-weight: 600; margin: 0 0 .35em; }
/* max-height, not just width: a full-width slide image eats ~5in of a 10in
   text column, and a wordy slide then pushed its own notes onto a second page —
   which broke the one-page-per-slide promise that makes this deck skimmable.
   Capped at 42vh the picture stays legible and the notes stay beside it. */
.shot { display: block; width: 100%; max-height: 42vh; object-fit: contain;
        object-position: left top; border: 1px solid #e3e0e6;
        border-radius: 6px; margin: 0 0 .8em; }
.missing { font-size: 9pt; color: #96909c; font-style: italic; margin: 0 0 1em; }
.body h2 { font-size: 14pt; margin: .8em 0 .3em; }
.body h3, .body h4 { font-size: 12pt; margin: .7em 0 .25em; }
.body p { margin: .45em 0; }
.body ul, .body ol { margin: .45em 0; padding-left: 1.4em; }
.body li { margin: .2em 0; }
.body code { background: #f4f2f6; border-radius: 3px; padding: .1em .3em;
             font-family: "Cascadia Code", Consolas, monospace; font-size: .92em; }
/* Truth tables are most of what these decks contain, so they get real borders
   rather than the pipe soup they printed as before. */
.body table { border-collapse: collapse; margin: .5em 0; font-size: 9.5pt; }
.body th, .body td { border: 1px solid #d8d4dd; padding: .22em .55em;
                     text-align: center; }
.body th { background: #f4f2f6; font-weight: 600; }
/* NOTE: deliberately NOT `overflow: hidden` on .slide. Clipping would make a
   wordy slide silently lose its last lines, which is far worse than letting it
   run onto a continuation page. Every slide still STARTS its own page, so the
   image/text pairing holds either way. */
.cover { page-break-after: always; }
.cover h1 { font-size: 22pt; margin: 0 0 .3em; }
.cover .sub { color: #6b6472; font-size: 10pt; }
"""


def build_html(title: str, slides: list[tuple[int, str]],
               pages: dict[int, bytes]) -> str:
    """One page per slide: the real slide image above its rewritten text."""
    parts = [
        "<!doctype html><meta charset='utf-8'>",
        f"<title>{_html.escape(title)}</title>",
        f"<style>{_CSS}</style>",
        "<section class='cover'>"
        f"<h1>{_html.escape(title)}</h1>"
        f"<p class='sub'>Rewritten study notes &middot; {len(slides)} slides</p>"
        "</section>",
    ]

    for num, body in slides:
        parts.append("<section class='slide'>")
        parts.append(f"<p class='slide-no'>Slide {num}</p>")
        png = pages.get(num)
        if png:
            b64 = base64.b64encode(png).decode("ascii")
            parts.append(
                f"<img class='shot' alt='Slide {num}' "
                f"src='data:image/png;base64,{b64}'>"
            )
        else:
            # Said out loud rather than silently omitted, so a mismatch between
            # cited slide numbers and real pages is visible instead of puzzling.
            parts.append(
                f"<p class='missing'>[no source image for slide {num}]</p>")
        parts.append(f"<div class='body'>{md_to_html(body)}</div>")
        parts.append("</section>")

    return "".join(parts)


# ── 5. HTML -> PDF bytes ──────────────────────────────────────────────────────
async def _assemble_async(html: str) -> bytes:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        try:
            page = await browser.new_page()
            # wait_until='load' so the base64 <img> tags are decoded before the
            # PDF is taken; without it a big deck can print blank frames.
            await page.set_content(html, wait_until="load")
            return await page.pdf(format="Letter", print_background=True)
        finally:
            await browser.close()


def assemble_pdf(html: str) -> bytes:
    """Render `html` to real PDF bytes via Playwright (already a dependency)."""
    return asyncio.run(_assemble_async(html))


# ── 6. The one call server.py makes ───────────────────────────────────────────
def build_deck_pdf(source_pdf, result_text: str, title: str) -> bytes:
    """Full output stage: source PDF + generated text -> PDF bytes.

    Raises if there is nothing to lay out — an empty deck is a failure worth
    surfacing, not a valid 0-page file.
    """
    slides = split_slides(result_text)
    if not slides:
        raise ValueError("no '## Slide N' sections found in the generated text")
    pages = render_pages(source_pdf)
    return assemble_pdf(build_html(title, slides, pages))
