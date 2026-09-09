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

REFINE_PROMPT = """You are a prompt engineer. Rewrite the request below so that \
it gets a better answer from a large language model.

THE REQUEST
{question}

Rewrite it. Do not answer it -- your entire output is the rewritten request, \
which will be sent on to the models verbatim.

What a good rewrite does:
- Keeps the person's actual intent, subject and scope exactly. You are \
sharpening what they asked, not replacing it with a better question.
- Makes vague terms specific where the intent is obvious, and leaves them \
alone where it is not. Never invent facts, constraints, numbers, names or \
context the person did not give you -- an invented detail is worse than a \
vague one, because it will be answered as though it were true.
- States what form the answer should take, if the request implies one \
(steps, a comparison, a short factual answer, code).
- Adds any context or constraint the person clearly implied but did not say.
- Removes filler and pleasantries.

Keep it proportionate. A short, clear request needs a light touch -- do not \
inflate one plain sentence into a multi-paragraph specification. Most rewrites \
should be one to four sentences. Never use more than one short paragraph plus, \
where the request genuinely has several distinct parts, a few bullets.

If the request is already clear and specific, return it essentially unchanged \
rather than padding it out to look like work was done.

Output ONLY the rewritten request. No preamble, no "Here is the rewritten \
prompt", no quotation marks around it, no explanation of what you changed, no \
headings, no code fences."""

# Openers a model reaches for when it narrates the rewrite instead of just
# emitting it. Stripped rather than rejected: the rewrite itself is usually
# fine, and throwing away a good rewrite over a preamble would be its own bug.
_PREAMBLE = re.compile(
    r"^\s*(?:here(?:'s| is)\b[^\n:]*:|"
    r"(?:the\s+)?(?:rewritten|refined|improved|revised)\s+(?:prompt|request|question)\s*:)",
    re.IGNORECASE,
)

_FENCE = re.compile(r"^\s*```[a-zA-Z]*\s*\n(?P<body>.*?)\n\s*```\s*$", re.DOTALL)


def parse(raw: str) -> str | None:
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
    if len(text) > 4000:
        return None

    return text


async def refine(
    provider: Provider,
    question: str,
    ctx: RunContext,
    *,
    cancel=None,
) -> tuple[str, bool, str | None, int]:
    """Returns (refined_text, ok, error_detail, latency_ms).

    Mirrors chairman.synthesize's return-tuple shape. An unusable response is
    a failure, not an empty success -- the composer must keep the text the
    person typed rather than have it replaced by nothing.
    """
    t0 = time.monotonic()
    result = await provider.ask(
        REFINE_PROMPT.format(question=question.strip()), ctx=ctx, cancel=cancel
    )
    ms = int((time.monotonic() - t0) * 1000)

    if not result.ok:
        return (
            "",
            False,
            f"Refiner ({provider.display_name}) failed: "
            f"{result.failure} -- {result.error_detail}",
            ms,
        )

    cleaned = parse(result.text)
    if cleaned is None:
        return (
            "",
            False,
            f"{provider.display_name} did not return a usable rewrite.",
            ms,
        )

    return cleaned, True, None, ms
