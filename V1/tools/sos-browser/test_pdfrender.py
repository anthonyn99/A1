"""Tests for pdfrender — the output stage that turns a job into a PDF deck.

Run:  python test_pdfrender.py

The layout cases here come from REAL generated output, not invented markdown:
the truth tables and "---" separators are what a live Boolean-algebra run
actually produced, and each of them printed wrong before being fixed.
"""

import sys
from pathlib import Path

import pdfrender as pr

HERE = Path(__file__).resolve().parent
_pass = _fail = 0


def t(name, cond, extra=""):
    global _pass, _fail
    if cond:
        _pass += 1
        print(f"  ok   {name}")
    else:
        _fail += 1
        print(f"  FAIL {name} {extra}")


print("split_slides")
t("splits on ## headings", pr.split_slides("## Slide 1\na\n## Slide 2\nb")
  == [(1, "a"), (2, "b")])
t("tolerates ### and 'Slide: N'", [n for n, _ in pr.split_slides("### Slide 3\nx\n#### Slide: 4\ny")]
  == [3, 4])
t("drops preamble before the first heading",
  pr.split_slides("I read 15 files.\n## Slide 1\nbody") == [(1, "body")])
t("empty text yields nothing", pr.split_slides("") == [])
t("no headings yields nothing", pr.split_slides("just prose") == [])
t("keeps non-consecutive numbers as written",
  [n for n, _ in pr.split_slides("## Slide 7\na\n## Slide 9\nb")] == [7, 9])

print("\nmd_to_html")
h = pr.md_to_html("| x | y |\n|---|---|\n| 0 | 1 |")
t("renders a GFM table", "<table>" in h and "<th>x</th>" in h and "<td>0</td>" in h)
t("a horizontal rule is dropped, not printed", pr.md_to_html("---") == "")
t("a dash list is not mistaken for a rule", "<li>a</li>" in pr.md_to_html("- a\n- b"))
t("numbered lists", "<ol>" in pr.md_to_html("1. a"))
t("headings are demoted below the page title", "<h3>" in pr.md_to_html("## Title"))
t("bold and code", "<strong>" in pr.md_to_html("**b**")
  and "<code>" in pr.md_to_html("`c`"))
t("a pipe line without a separator stays prose",
  "<p>" in pr.md_to_html("| not | a table |"))
t("html in the model's text is escaped",
  "&lt;script&gt;" in pr.md_to_html("<script>alert(1)</script>"))

print("\nbuild_html")
html = pr.build_html("Deck", [(1, "one"), (2, "two")], {1: b"\x89PNG-fake"})
t("one section per slide", html.count("class='slide'") == 2)
t("embeds the page image as a data URI", "data:image/png;base64," in html)
t("says so when a slide has no source image", "no source image for slide 2" in html)
t("titles the deck", "<title>Deck</title>" in html)

print("\nrender_pages")
src = next(iter(HERE.glob("uploads/*.pdf")), None)
if not src:
    print("  skip (no source PDF staged in uploads/)")
else:
    pages = pr.render_pages(src, dpi=50)
    t("renders every page 1-indexed",
      len(pages) > 0 and min(pages) == 1 and len(pages) == max(pages))
    t("pages are real PNGs", all(v[:4] == b"\x89PNG" for v in pages.values()))

print("\nbuild_deck_pdf")
try:
    pr.build_deck_pdf(src or "x.pdf", "no headings here", "T")
    t("raises when nothing can be laid out", False, "(did not raise)")
except ValueError:
    t("raises when nothing can be laid out", True)
except Exception as e:
    t("raises when nothing can be laid out", False, f"(wrong error: {e!r})")


print("\nbuild_job_pdf (on-demand rebuild)")
# A job finished BEFORE the layout stage shipped has result text but no deck.
# The idempotency cache refuses to re-run it, so if the bridge cannot build one
# on demand that output is unreachable forever. That was a real reported bug:
# "Already done -- nothing was spent", and nothing appears in the app.
import server as _srv

if not src:
    print("  skip (no source PDF staged in uploads/)")
else:
    _srv.OUTPUTS = HERE / "outputs-test"
    _srv.JOBS_FILE = HERE / "outputs-test" / "jobs.json"
    _srv._jobs.clear()

    legacy = {"id": "t_legacy", "sourceName": src.name, "filePath": str(src),
              "status": "done",
              "result": "## Slide 1\nbody one\n\n## Slide 2\nbody two"}
    _srv._jobs["t_legacy"] = legacy
    t("a legacy job starts with no deck", not legacy.get("hasPdf"))
    t("builds one on demand", _srv.build_job_pdf(legacy, force=True) is True)
    t("and records it", legacy.get("hasPdf") is True and legacy.get("pdfBytes", 0) > 0)
    t("the file is a real PDF", Path(legacy["pdfPath"]).read_bytes()[:5] == b"%PDF-")

    # Second call is a no-op: it must not rebuild what is already on disk.
    stamp = Path(legacy["pdfPath"]).stat().st_mtime_ns
    _srv.build_job_pdf(legacy)
    t("does not rebuild an existing deck",
      Path(legacy["pdfPath"]).stat().st_mtime_ns == stamp)

    # A vanished source is reported, never raised.
    gone = {"id": "t_gone", "sourceName": "x.pdf",
            "filePath": str(HERE / "nope.pdf"), "status": "done",
            "result": "## Slide 1\nbody"}
    _srv._jobs["t_gone"] = gone
    t("a missing source returns False, not an exception",
      _srv.build_job_pdf(gone, force=True) is False)
    t("and says why", "no longer on disk" in (gone.get("pdfError") or ""))

    t("a job with no result builds nothing",
      _srv.build_job_pdf({"id": "t_empty", "result": ""}, force=True) is False)

    import shutil as _sh
    _sh.rmtree(HERE / "outputs-test", ignore_errors=True)

print(f"\n{_pass} passed, {_fail} failed")
sys.exit(1 if _fail else 0)
