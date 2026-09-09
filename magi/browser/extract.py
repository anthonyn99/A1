"""Cleaning scraped answer text.

Scraping a rendered chat UI picks up chrome that is not part of the model's
answer: screen-reader labels, citation chips, "Copy"/"Share" affordances, and
(on logged-out sessions) injected ads. Left alone, that text flows into the
synthesis prompt and then into the verdict -- so an ad slogan can end up quoted
as though a council member said it.

Rules are config-driven per site (`strip_patterns`), so fixing new cruft is a
YAML edit rather than a code change.
"""

from __future__ import annotations

import re

# Trailing chrome common to several sites, stripped everywhere.
GENERIC_TRAILING = [
    r"\n\s*(Copy|Share|Retry|Regenerate|Good response|Bad response)\s*$",
    r"\n\s*Sources?\s*$",
    r"\n\s*\+\s*\d+\s*$",          # Gemini citation pills: "+ 2"
]

# Leading chrome: status banners the UI renders INSIDE the response container,
# above the answer. Claude prints "Recalled N memories" (twice -- once for the
# icon's accessible label) and "Thought for 12s"; ChatGPT prints "Thinking...".
# These are anchored to the very start and each may repeat, so they are peeled
# one at a time in the same loop as the trailing rules.
GENERIC_LEADING = [
    r"^\s*Recalled\s+\d+\s+memor(y|ies)\s*",
    r"^\s*(Thought|Thinking|Reasoned|Analyzed|Searched|Pondered)\b[^\n]{0,60}\s*\n",
    r"^\s*\d+\s*step[s]?\s+completed\s*\n",
]


# Code-block toolbars render as their own lines INSIDE the answer, between the
# language label and the code. Observed on DeepSeek: a block arrives as
# "text\nCopy\nDownload\n<code>". These cannot be handled by the leading/
# trailing rules below, which by design never touch the middle of an answer.
#
# Safe to strip mid-string only because the match is anchored to a whole line
# AND the line must be exactly one known button word -- an answer line reading
# precisely "Copy" and nothing else is a toolbar, not prose. A line like
# "Copy the file to /etc" has other content and is left alone.
_CODE_TOOLBAR_LINE = re.compile(
    r"^[ \t]*(Copy|Download|Copy code|Edit|Run|Share|Wrap|Preview)[ \t]*$\n?",
    re.IGNORECASE | re.MULTILINE,
)


def strip_toolbars(text: str) -> str:
    """Remove code-block toolbar button labels that render as their own lines."""
    return _CODE_TOOLBAR_LINE.sub("", text)


def clean(text: str, strip_patterns: list[str] | None = None) -> str:
    """Remove UI chrome from a scraped answer.

    Conservative by design: only strips things anchored at the very start or
    end. Never touches the middle of an answer, because a false positive there
    would silently corrupt the model's actual words.
    """
    if not text:
        return ""
    out = text.strip()

    for pat in strip_patterns or []:
        out = re.sub(pat, "", out, flags=re.IGNORECASE | re.MULTILINE).strip()

    # Private-use and zero-width characters: chat UIs use them as icon glyphs
    # (Claude's memory banner carries ). They render as tofu and are
    # never part of an answer. Stripped in the middle too -- unlike the
    # patterns above -- because a glyph is unambiguous where a word is not.
    out = re.sub(r"[​-‏⁠﻿-]", "", out).strip()

    # Code-block toolbars, which sit mid-answer and so are missed by the
    # start/end-anchored rules below.
    out = strip_toolbars(out).strip()

    # Repeat: removing one element often exposes another.
    for _ in range(4):
        before = out
        for pat in GENERIC_TRAILING:
            out = re.sub(pat, "", out, flags=re.IGNORECASE).strip()
        for pat in GENERIC_LEADING:
            out = re.sub(pat, "", out, flags=re.IGNORECASE).strip()
        if out == before:
            break

    return out.strip()
