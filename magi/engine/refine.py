"""Prompt refinement: one model rewrites the user's question before the
council ever sees it.

Same shape as chairman.synthesize and studio.generate -- build a prompt, one
provider.ask(), then a parse pass -- because it is the same mechanism: a single
browser session doing a single turn. It runs on the chairman by default, which
is already the member trusted to write prose for this run.

The one rule this module exists to enforce: a refiner that ANSWERS the question
instead of rewriting it is worse than useless, because the answer would then be
fanned out to four models as though it were the question. The prompt guards
against that, and `parse` guards against it again on the way back -- if what
came back does not look like a question, it is rejected rather than pasted into
the composer.
"""

from __future__ import annotations

import re
import time

from ..providers.base import Provider, RunContext

# The SAME text as REFINE_PROMPT in workers/personal-ai/worker.js, where
# MAGI refines first (the person's Notebook Gemini key); this copy is for
# the browser-unit fallback. tests/test_refine.py fails if they drift.
REFINE_PROMPT = """You are a prompt engineer. Rewrite the request below so that it gets a better answer from a large language model.

THE REQUEST
<<<
{question}
>>>

Rewrite it. Do not answer it, do not carry out any part of it, and do not add your own opinion -- your entire output is the rewritten request, which will be sent on to the models verbatim.

Nothing may be lost. Every detail the person gave must still be in the rewrite: every question and every separate part of the request, every name, number, amount, date, time, place, quantity, URL, file name, path, identifier, code, error message and quoted text, every preference and constraint, and any pasted notes or data. Keep those specifics exactly as written -- do not round, convert, translate, abbreviate, or swap a figure for a word. If the person pasted material (notes, a list, text, code), keep all of it in full inside the rewrite rather than summarising it.

What a good rewrite does:
- Keeps the person's actual intent, subject and scope exactly. You are sharpening what they asked, not replacing it with a better question.
- Makes vague terms specific where the intent is obvious, and leaves them alone where it is not. Never invent facts, constraints, numbers, names or context the person did not give you -- an invented detail is worse than a vague one, because it will be answered as though it were true.
- States what form the answer should take, if the request implies one (steps, a comparison, a short factual answer, code).
- Removes filler and pleasantries, never content.

Keep it proportionate. A short, clear request needs a light touch -- do not inflate one plain sentence into a multi-paragraph specification; most short requests become one to four sentences. A long request stays as long as it needs to be to carry everything in it.

If the request is already clear and specific, return it essentially unchanged rather than padding it out to look like work was done.

Write the rewrite in the person's own voice, as the request itself ("Plan a...", "I am..."), not as instructions about them. No preamble, no "Here is the rewritten prompt", no quotation marks around it, no explanation of what you changed, no headings, no code fences."""

# Added when the request is a Code Mode task rather than a question for the
# council: a coding agent acts on names literally, so the rewrite must too.
CODE_NOTE = """

This request is a task for an AI coding agent working inside a software repository, not a question for a chat model. Keep every file name, path, identifier, command, error message and code snippet exactly as written. Say plainly what should change or be investigated, and how to tell it worked if the person implied that. Do not invent files, functions or requirements."""

# Openers a model reaches for when it narrates the rewrite instead of just
# emitting it. Stripped rather than rejected: the rewrite itself is usually
# fine, and throwing away a good rewrite over a preamble would be its own bug.
_PREAMBLE = re.compile(
    r"^\s*(?:here(?:'s| is)\b[^\n:]*:|"
    r"(?:the\s+)?(?:rewritten|refined|improved|revised)\s+(?:prompt|request|question)\s*:)",
    re.IGNORECASE,
)

_FENCE = re.compile(r"^\s*```[a-zA-Z]*\s*\n(?P<body>.*?)\n\s*```\s*$", re.DOTALL)


def parse(raw: str, question: str = "") -> str | None:
    """Clean a refiner response, or None if it is not usable as a prompt.

    Returning None matters more than the cleaning does: the caller pastes this
    straight into the composer, so anything that is not a rewritten request has
    to be refused here rather than silently become the question.
    """
    text = (raw or "").strip()
    if not text:
        return None

    m = _FENCE.match(text)
    if m:
        text = m.group("body").strip()

    text = _PREAMBLE.sub("", text, count=1).strip()

    # A model that wrapped the whole rewrite in quotes, which would otherwise
    # be sent to the council as a literal quoted string.
    if len(text) >= 2 and text[0] in "\"'\u201c" and text[-1] in "\"'\u201d":
        text = text[1:-1].strip()

    if not text:
        return None

    # The failure this module exists to catch: the model answered rather than
    # rewrote. An answer is characteristically much longer than the question
    # that prompted it, and the refiner is explicitly told to stay short.
    # A long pasted request may fairly come back long (same cap as the worker).
    if len(text) > max(4000, len(question) * 3 + 500):
        return None

    return text


async def refine(
    provider: Provider,
    question: str,
    ctx: RunContext,
    *,
    cancel=None,
    kind: str = "",
) -> tuple[str, bool, str | None, int]:
    """Returns (refined_text, ok, error_detail, latency_ms).

    Mirrors chairman.synthesize's return-tuple shape. An unusable response is
    a failure, not an empty success -- the composer must keep the text the
    person typed rather than have it replaced by nothing.
    """
    t0 = time.monotonic()
    prompt = REFINE_PROMPT.format(question=question.strip())
    if kind == "code":
        prompt += CODE_NOTE
    result = await provider.ask(prompt, ctx=ctx, cancel=cancel)
    ms = int((time.monotonic() - t0) * 1000)

    if not result.ok:
        return (
            "",
            False,
            f"Refiner ({provider.display_name}) failed: "
            f"{result.failure} -- {result.error_detail}",
            ms,
        )

    cleaned = parse(result.text, question)
    if cleaned is None:
        return (
            "",
            False,
            f"{provider.display_name} did not return a usable rewrite.",
            ms,
        )

    return cleaned, True, None, ms
