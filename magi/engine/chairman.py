"""The synthesis step: one member reads the others and writes the verdict.

The chairman goes through the same Provider interface as everyone else -- it is
just another browser session receiving a longer prompt. That keeps the swap to
an API-backed chairman free.

Non-negotiable: the prompt states exactly how many members answered and which
ones failed. A verdict built from 2 of 4 members must never read as though it
were built from 4.
"""

from __future__ import annotations

import asyncio
import re
import time

from ..providers.base import Answer, Provider, RunContext

SYNTHESIS_PROMPT = """You are the chairman of a council of AI models. Each member \
was asked the SAME question independently, with no knowledge of the others.

THE QUESTION
{question}

COUNCIL RESPONSES ({responded} of {total} members responded{failure_note})
{responses}

Your job is to produce THE ANSWER to the question -- the one the person who \
asked it actually wanted. The council responses are your raw material, not your \
subject. Use them to get the answer right: keep what they agree on, resolve \
what they differ on by judging which position is better supported, drop what is \
padding or wrong, and merge the rest into something better than any single one \
of them.

WHEN THE MEMBERS ARE NOT ANSWERING THE SAME QUESTION
Some questions are about the responder rather than about the world: "which model are you?", "what is your name?", "which do you prefer?", "how would YOU approach this?", "what is your opinion?". Every member's answer to a question like that is correct for itself. There is no disagreement to resolve, and choosing one and dropping the rest does not produce a better answer -- it states something false about the members you dropped.

For questions of that kind ONLY, do not merge. Under ANSWER, write one short line per member: the member's name, then its own answer, using exactly the names in the COUNCIL RESPONSES headings above. Naming the members is required here, and overrides the rule below that says never to mention them. Judge CONFIDENCE on whether each answer was reported faithfully, not on how much they agreed -- members differing is the expected outcome, not a weakness.

Everything else in this prompt applies as written. Most questions are NOT of this kind, and for those, merging is exactly the job.

Write it like this:

ANSWER
The complete answer to the question, written directly to the person who asked. \
This is the main body and should carry essentially all of the substance -- if \
they read only this, they should be fully served.

Open with one short paragraph that answers the question outright, before any \
detail. Then match the rest to what the question actually needs -- and only \
what it needs:
- A factual or narrow question: stop after that opening paragraph, or add one \
more. Do not pad it out with structure it does not need.
- A how-to or sequential question: a numbered list of steps.
- A question with several distinct parts or dimensions: short paragraphs, and \
`### Sub-heading` lines only if there are three or more genuinely separate \
parts to label.
- A question comparing two or more named options on shared criteria: a \
markdown pipe table, one row per option, one column per criterion, cells kept \
to a few words. Use a table only when there really is a grid to fill; never for \
a single option or a plain list.

Within that, use bullets for genuine lists, indent a bullet by two spaces to \
hang it under the one above, and start a bullet with **Label:** when each item \
is a named thing plus its explanation. Use **bold** sparingly, for the few \
phrases that matter most. Do not use headings, tables, or nesting to decorate a \
short answer -- an answer with more structure than substance is worse than a \
plain one.

NOTES
Two to four short bullets, only for things the reader genuinely benefits from \
knowing: a real caveat, a point the council was split on and how you called it, \
a condition under which the answer would change. If there is nothing worth \
saying, write "None." Do not narrate the council or name its members here.

CONFIDENCE
HIGH, MEDIUM, or LOW -- then one sentence of plain justification. Weigh both \
how much the members agreed and that {responded} of {total} answered.\
{confidence_ceiling}

Rules for how it should read:
- Write in plain, clear language. Short sentences. No jargon the question did \
not already use, and no filler.
- Never mention the council, the members, the models, this process, or that you \
are synthesising anything. No "the models agree", no "based on the responses". \
The reader wants an answer, not a report about how it was made.
- Do not open with pleasantries, restate the question, or close with an offer \
of further help.
- State things directly. If something is genuinely uncertain, say so once, in \
the NOTES.
- Keep the three headings ANSWER, NOTES and CONFIDENCE exactly as written, each \
alone on its own line. Everything else is plain text with the light markdown \
above -- no code fences, no block quotes, no horizontal rules."""


# How long a synthesis prompt each chat site will accept in one message.
#
# Measured, not guessed, for ChatGPT: it chaired a 57k-character synthesis
# fine and refused a 73k one with "The message you submitted was too long,
# please edit it and resubmit." (2026-09-22, the morning trading report: five
# members answering a 5.6k prompt with ~20k characters each). That line was
# then published as the verdict. The default is held to the same measured
# figure because no other site has been measured and every one has SOME cap.
MAX_PROMPT_CHARS = {
    "chatgpt": 50_000,
    "claude": 120_000,
    "claude-pro": 120_000,
}
DEFAULT_MAX_PROMPT_CHARS = 50_000


def prompt_budget(provider_id: str) -> int:
    return MAX_PROMPT_CHARS.get(provider_id, DEFAULT_MAX_PROMPT_CHARS)


def _fit(texts: list[str], room: int) -> list[str]:
    """Shorten the longest answers until they fit in `room` characters in total.

    Water-filling: every answer is entitled to an equal share, an answer
    shorter than its share keeps all of it, and what it leaves unused goes to
    the rest. So a short answer is never cut to make room, and the long ones
    are cut to the same length rather than the last one losing everything.

    A cut keeps the head AND the tail. These are structured reports, and the
    end is where the summary sits (the trading report's tier list and final
    call) -- cutting only the tail would feed the chairman every member's
    preamble and none of their conclusions.
    """
    total = sum(len(t) for t in texts)
    if total <= room or not texts:
        return texts
    room = max(room, 2000 * len(texts))
    caps = {}
    left, pending = room, sorted(range(len(texts)), key=lambda i: len(texts[i]))
    while pending:
        share = left // len(pending)
        i = pending[0]
        if len(texts[i]) <= share:
            caps[i] = len(texts[i])
            left -= caps[i]
            pending.pop(0)
        else:
            for j in pending:
                caps[j] = share
            break
    out = []
    for i, t in enumerate(texts):
        cap = caps[i]
        if len(t) <= cap:
            out.append(t)
            continue
        marker = f"\n\n[... {len(t) - cap:,} characters trimmed for length ...]\n\n"
        keep = max(0, cap - len(marker))
        head_n = int(keep * 0.7)
        head = t[:head_n]
        cut = head.rfind("\n")
        if cut > head_n * 0.8:
            head = head[:cut]
        tail = t[len(t) - (keep - len(head)):] if keep > len(head) else ""
        nl = tail.find("\n")
        if 0 <= nl < len(tail) * 0.2:
            tail = tail[nl + 1:]
        out.append(head.rstrip() + marker + tail.lstrip())
    return out


def build_prompt(
    question: str, answers: list[Answer], max_chars: int | None = None
) -> str:
    ok = [a for a in answers if a.ok and a.text.strip()]
    degraded = [a for a in answers if a.degraded]
    # Genuine failures only -- a degraded member DID respond, and describing it
    # as "did not respond" would misreport what happened.
    failed = [a for a in answers if not a.ok and not a.degraded]

    texts = [a.text.strip() for a in ok]
    if max_chars:
        # Everything that is not an answer: the template, the question, the
        # headings and notes. Measured from the untrimmed prompt, so a
        # template edit can never silently break the budget.
        frame = len(build_prompt(question, answers)) - sum(len(t) for t in texts)
        texts = _fit(texts, max_chars - frame)

    blocks = []
    for a, text in zip(ok, texts):
        caveat = ""
        if a.low_confidence:
            caveat = "  [note: this response may be truncated]"
        blocks.append(f"--- {a.display_name}{caveat} ---\n{text}")

    note = ""
    if failed:
        names = ", ".join(f"{a.display_name} ({a.failure})" for a in failed)
        note = f"; did not respond: {names}"
    if degraded:
        # The degraded member's TEXT is deliberately withheld -- it is the
        # thing we judged unusable, and pasting it in would reintroduce exactly
        # what validation excluded.
        names = ", ".join(a.display_name for a in degraded)
        note += f"; excluded for an unusable response: {names}"

    # An excluded member means one fewer independent check on the answer, and
    # the reason for exclusion (a clarifying question) often means the question
    # itself was ambiguous. Neither is compatible with HIGH confidence, so the
    # ceiling is stated to the chairman and enforced on its output afterwards.
    ceiling = ""
    if degraded:
        ceiling = (
            "\nOne or more members were excluded because what they returned was "
            "not a usable answer, so you are working from fewer independent "
            "responses than were asked. Your confidence must therefore be at "
            "most MEDIUM -- do not write HIGH, however well the remaining "
            "responses agree."
        )

    return SYNTHESIS_PROMPT.format(
        question=question.strip(),
        responded=len(ok),
        total=len(answers),
        failure_note=note,
        responses="\n\n".join(blocks),
        confidence_ceiling=ceiling,
    )


# The chairman is instructed not to write HIGH when a member was excluded, but
# it is a language model and instructions are not guarantees. The ceiling is a
# correctness property of the verdict, so it is also enforced on the text --
# instruction for a well-phrased result, rewrite for the guarantee.
_CONFIDENCE_LINE = re.compile(
    r"^(?P<head>\s*CONFIDENCE\s*\n+\s*)(?P<level>HIGH)\b",
    re.IGNORECASE | re.MULTILINE,
)


def cap_confidence(verdict: str, *, reason: str) -> str:
    """Force a HIGH confidence rating down to MEDIUM, explaining why."""
    if not verdict:
        return verdict

    def _sub(m: re.Match) -> str:
        return f"{m.group('head')}MEDIUM"

    out, n = _CONFIDENCE_LINE.subn(_sub, verdict, count=1)
    if n:
        out = out.rstrip() + f"\n\nConfidence was capped at MEDIUM because {reason}"
    return out


async def synthesize(
    chairman: Provider,
    question: str,
    answers: list[Answer],
    ctx: RunContext,
    *,
    cancel: asyncio.Event | None = None,
) -> tuple[str, bool, str | None, int]:
    """Returns (verdict_text, ok, error_detail, latency_ms)."""
    t0 = time.monotonic()
    prompt = build_prompt(question, answers, max_chars=prompt_budget(chairman.id))
    result = await chairman.ask(prompt, ctx=ctx, cancel=cancel)
    ms = int((time.monotonic() - t0) * 1000)

    if not result.ok:
        return (
            "",
            False,
            f"Chairman ({chairman.display_name}) failed: "
            f"{result.failure} -- {result.error_detail}",
            ms,
        )

    text = result.text
    degraded = [a for a in answers if a.degraded]
    if degraded:
        names = ", ".join(a.display_name for a in degraded)
        text = cap_confidence(
            text,
            reason=(
                f"{names} did not return a usable answer, so this verdict rests "
                f"on fewer independent responses than were asked for."
            ),
        )
    return text, True, None, ms
