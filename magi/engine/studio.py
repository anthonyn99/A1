"""Studio artifact generation: supplementary outputs derived from a finished
run's question + council answers + verdict, via the same Provider.ask()
browser-automation mechanism every member and the chairman already use.

One (prompt-builder, parser) pair per StudioKind, plus a tiny dispatch table --
same shape as chairman.py's build_prompt/synthesize, fanned out over several
formats instead of one. Video has no entry: there is no generation path for it
(no image/video surface exists on any of the automated chat sites), so the
frontend renders it as a permanently disabled card with no backend round-trip.
"""

from __future__ import annotations

import json
import re
import time
from enum import StrEnum

from ..providers.base import Provider, RunContext
from ..settings import Settings


class StudioKind(StrEnum):
    TABLE = "table"
    REPORT = "report"
    FLASHCARDS = "flashcards"
    QUIZ = "quiz"
    MINDMAP = "mindmap"
    SLIDES = "slides"
    AUDIO = "audio"


def _source_material(question: str, answers: list[dict], verdict: str) -> str:
    """The shared "here is what happened in this run" block every Studio
    prompt opens with -- same raw material chairman.build_prompt embeds,
    reconstructed from DB rows rather than live Answer objects (the run that
    produced them is long finished by the time Studio generation runs)."""
    blocks = []
    for a in answers:
        if a.get("ok") and (a.get("answer_text") or "").strip():
            blocks.append(f"--- {a.get('display_name') or a.get('provider_id')} ---\n{a['answer_text'].strip()}")
    responses = "\n\n".join(blocks) if blocks else "(no member answers retained)"
    return (
        f"THE QUESTION\n{question.strip()}\n\n"
        f"COUNCIL RESPONSES\n{responses}\n\n"
        f"THE VERDICT (the synthesised answer the council settled on)\n{verdict.strip()}"
    )


# ── prompt builders ─────────────────────────────────────────────────────────

_TABLE_PROMPT = """{source}

Turn the material above into a single markdown pipe table -- nothing else. No \
prose before or after it, no heading, no explanation. Choose columns and rows \
that actually fit what was discussed: if options were compared, one row per \
option and one column per criterion; if there were no options to compare, \
tabulate the key facts or figures instead. Keep cells short -- a few words \
each. If the material genuinely has no tabular structure to it, make the best \
reasonable table of its key points rather than refusing."""

_REPORT_PROMPT = """{source}

Write a longer, more thorough report on the question above -- not a terse \
answer but a fuller treatment of it, the way a written report would cover it. \
Use the same structure as before:

ANSWER
The complete report. Unlike a short answer, here you SHOULD use multiple \
`### Sub-heading` sections to cover distinct parts, dimensions, or \
considerations in depth. Go beyond the one-paragraph opener -- add context, \
supporting detail, examples, and reasoning throughout. Use tables and lists \
where they genuinely help. This is the one format where more structure and \
more length are wanted, not a flaw to trim.

NOTES
Caveats, open questions, or conditions worth flagging. Write "None." if there \
are none.

CONFIDENCE
HIGH, MEDIUM, or LOW -- then one sentence of plain justification.

Keep the three headings ANSWER, NOTES and CONFIDENCE exactly as written, each \
alone on its own line. No code fences, no block quotes, no horizontal rules. \
Never mention the council, the members, or that you are synthesising anything."""

_FLASHCARDS_PROMPT = """{source}

Turn the material above into a set of study flashcards -- 6 to 12 cards, each \
covering one distinct fact, term, or idea from the material. Use exactly this \
format, one card per block, nothing else in the response:

CARD 1
FRONT: the term or question
BACK: the explanation or answer

CARD 2
FRONT: ...
BACK: ...

Keep each FRONT short (a term or a one-line question) and each BACK a few \
sentences at most."""

_QUIZ_PROMPT = """{source}

Turn the material above into a multiple-choice quiz -- 5 to 8 questions, each \
testing understanding of one distinct point from the material. Use exactly \
this format, one question per block, nothing else in the response:

Q1. the question text
A. option
B. option
C. option
D. option
CORRECT: B
WHY: one line explaining why that option is correct

Q2. ...

Exactly four lettered options per question, exactly one CORRECT line naming \
the right letter, exactly one WHY line."""

_MINDMAP_PROMPT = """{source}

Turn the material above into a mind map outline -- a central topic with \
branches and sub-branches. Use exactly this format, nothing else in the \
response:

ROOT: the central topic, a few words
- first main branch
  - a sub-point under it
  - another sub-point
- second main branch
  - a sub-point under it

Use a 2-space indent per nesting level, dash bullets, and go no deeper than \
one level of sub-points. Keep each line short -- a few words to one phrase, \
not a sentence."""

_SLIDES_PROMPT = """{source}

Turn the material above into a slide deck -- 5 to 10 slides that walk through \
the question and its answer. Use exactly this format, one block per slide, \
nothing else in the response:

SLIDE 1
TITLE: the slide's title
- first bullet point
- second bullet point

SLIDE 2
TITLE: ...
- ...

Keep bullets short -- a phrase, not a paragraph. The first slide should \
introduce the question; the last should land on the answer."""

_AUDIO_PROMPT = """{source}

Turn the material above into a short spoken dialogue between two hosts \
discussing the question and its answer, the way a podcast segment would cover \
it -- conversational, back-and-forth, explaining the material to a listener \
who has not seen it. 8 to 16 lines total. Use exactly this format, nothing \
else in the response, no markdown, no stage directions:

HOST A: line of dialogue
HOST B: line of dialogue
HOST A: line of dialogue
...

Write plain spoken sentences only -- this text will be read aloud by a \
speech synthesiser, so avoid anything that only makes sense written down \
(no bullet points, no bold, no parentheticals)."""

_PROMPTS: dict[StudioKind, str] = {
    StudioKind.TABLE: _TABLE_PROMPT,
    StudioKind.REPORT: _REPORT_PROMPT,
    StudioKind.FLASHCARDS: _FLASHCARDS_PROMPT,
    StudioKind.QUIZ: _QUIZ_PROMPT,
    StudioKind.MINDMAP: _MINDMAP_PROMPT,
    StudioKind.SLIDES: _SLIDES_PROMPT,
    StudioKind.AUDIO: _AUDIO_PROMPT,
}


def build_prompt(kind: StudioKind, *, question: str, answers: list[dict], verdict: str) -> str:
    source = _source_material(question, answers, verdict)
    return _PROMPTS[kind].format(source=source)


# ── parsers ──────────────────────────────────────────────────────────────
# Each is a small regex-driven state machine against the exact delimiter
# vocabulary the corresponding prompt asks for -- never a generic markdown
# parser, since the input is LLM prose that only loosely follows instructions.
# A parser that finds nothing usable returns None rather than raising: the
# caller falls back to showing raw text, same "never fabricate, degrade
# visibly" discipline as Answer.degraded_capture.

_CARD_SPLIT_RE = re.compile(r"(?mi)^\s*CARD\s*\d+\s*$")
_CARD_FRONT_RE = re.compile(r"^\s*FRONT:\s*(.+)$", re.IGNORECASE | re.MULTILINE)
_CARD_BACK_RE = re.compile(r"^\s*BACK:\s*(.+)$", re.IGNORECASE | re.MULTILINE)


def _parse_flashcards(text: str) -> dict | None:
    blocks = [b.strip() for b in _CARD_SPLIT_RE.split(text) if b.strip()]
    cards = []
    for block in blocks:
        front_m = _CARD_FRONT_RE.search(block)
        back_m = _CARD_BACK_RE.search(block)
        if front_m and back_m:
            cards.append({"front": front_m.group(1).strip(), "back": back_m.group(1).strip()})
    if not cards:
        return None
    return {"cards": cards}


_QUIZ_SPLIT_RE = re.compile(r"(?m)^\s*Q\d+\.\s*")
_OPTION_LINE_RE = re.compile(r"^\s*([A-D])[.)]\s*(.+)$", re.IGNORECASE)
_QUIZ_CORRECT_RE = re.compile(r"^\s*CORRECT:\s*([A-D])\s*$", re.IGNORECASE | re.MULTILINE)
_QUIZ_WHY_RE = re.compile(r"^\s*WHY:\s*(.+)$", re.IGNORECASE | re.MULTILINE)


def _parse_quiz(text: str) -> dict | None:
    # Split on the Q-number marker first (a delimiter split, not one big
    # regex) -- simpler to reason about than nested greedy groups, and immune
    # to one question's body accidentally swallowing the next.
    blocks = [b.strip() for b in _QUIZ_SPLIT_RE.split(text) if b.strip()]
    questions = []
    for block in blocks:
        lines = block.splitlines()
        if not lines:
            continue
        q_text = lines[0].strip()
        options: dict[str, str] = {}
        for line in lines[1:]:
            om = _OPTION_LINE_RE.match(line)
            if om:
                options[om.group(1).upper()] = om.group(2).strip()
        correct_m = _QUIZ_CORRECT_RE.search(block)
        why_m = _QUIZ_WHY_RE.search(block)
        if not q_text or len(options) < 2 or not correct_m:
            continue
        questions.append({
            "text": q_text,
            "options": options,
            "correct": correct_m.group(1).upper(),
            "why": why_m.group(1).strip() if why_m else "",
        })
    if not questions:
        return None
    return {"questions": questions}


_MM_BULLET_RE = re.compile(r"^(\s*)-\s+(.*)$")
_MM_ROOT_RE = re.compile(r"^\s*ROOT:\s*(.+)$", re.IGNORECASE)


def _parse_mindmap(text: str) -> dict | None:
    root_text = None
    branches: list[dict] = []
    # indent width -> the node dict currently open at that depth
    stack: list[tuple[int, dict]] = []

    for raw in text.replace("\r", "").splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        rm = _MM_ROOT_RE.match(line)
        if rm:
            root_text = rm.group(1).strip()
            continue
        bm = _MM_BULLET_RE.match(line)
        if not bm:
            continue
        indent = len(bm.group(1).replace("\t", "  "))
        node = {"text": bm.group(2).strip(), "children": []}
        # Cap depth at 2 levels beneath root -- deeper nesting is a badly
        # formatted response, and flattening it is the right failure mode
        # (same philosophy as the frontend verdict list parser).
        while stack and indent <= stack[-1][0]:
            stack.pop()
        if not stack:
            branches.append(node)
        elif len(stack) < 2:
            stack[-1][1]["children"].append(node)
        else:
            # already at max depth -- attach as a sibling of the deepest node
            stack[-1][1]["children"].append(node)
        stack.append((indent, node))

    if root_text is None and not branches:
        return None
    return {"root": root_text or "", "branches": branches}


_SLIDE_SPLIT_RE = re.compile(r"(?mi)^\s*SLIDE\s*\d+\s*$")
_SLIDE_TITLE_RE = re.compile(r"^\s*TITLE:\s*(.+)$", re.IGNORECASE | re.MULTILINE)
_SLIDE_BULLET_RE = re.compile(r"^\s*-\s*(.+)$", re.MULTILINE)


def _parse_slides(text: str) -> dict | None:
    blocks = [b.strip() for b in _SLIDE_SPLIT_RE.split(text) if b.strip()]
    slides = []
    for block in blocks:
        title_m = _SLIDE_TITLE_RE.search(block)
        if not title_m:
            continue
        bullets = [b.strip() for b in _SLIDE_BULLET_RE.findall(block)]
        slides.append({"title": title_m.group(1).strip(), "bullets": bullets})
    if not slides:
        return None
    return {"slides": slides}


_AUDIO_LINE_RE = re.compile(r"^\s*HOST\s*([AB])\s*:\s*(.+)$", re.IGNORECASE | re.MULTILINE)


def _parse_audio(text: str) -> dict | None:
    lines = [
        {"speaker": m.group(1).upper(), "text": m.group(2).strip()}
        for m in _AUDIO_LINE_RE.finditer(text)
    ]
    if not lines:
        return None
    return {"lines": lines}


_PARSERS = {
    StudioKind.FLASHCARDS: _parse_flashcards,
    StudioKind.QUIZ: _parse_quiz,
    StudioKind.MINDMAP: _parse_mindmap,
    StudioKind.SLIDES: _parse_slides,
    StudioKind.AUDIO: _parse_audio,
    # TABLE and REPORT are parsed client-side (Table reuses the existing
    # markdown-table regex already in App.tsx; Report reuses VerdictBody
    # wholesale) -- no backend parser needed, parsed_json stays null.
}


def parse_result(kind: StudioKind, raw_text: str) -> dict | None:
    parser = _PARSERS.get(kind)
    if parser is None:
        return None
    try:
        return parser(raw_text)
    except Exception:
        return None


# ── provider selection ──────────────────────────────────────────────────────

def pick_generator_id(settings: Settings, run_chairman_provider: str | None) -> str:
    """Which provider generates a Studio artifact.

    Simpler than orchestrator._pick_chairman: that method filters against a
    live run's fresh answers, but Studio generation happens long after the
    original run finished and its browser sessions are closed, so there is no
    "answered ok just now" set to check. Preference order: the run's own
    chairman (it worked moments ago), else the configured default chairman,
    else whatever is enabled first.
    """
    if run_chairman_provider and run_chairman_provider in settings.sites:
        return run_chairman_provider
    if settings.chairman.provider_id in settings.sites:
        return settings.chairman.provider_id
    enabled = settings.enabled_site_ids()
    if enabled:
        return enabled[0]
    raise ValueError("No provider available to generate a Studio artifact.")


# ── generation ───────────────────────────────────────────────────────────

async def generate(
    provider: Provider,
    kind: StudioKind,
    *,
    question: str,
    answers: list[dict],
    verdict: str,
    ctx: RunContext,
    cancel=None,
) -> tuple[str, dict | None, bool, str | None, int]:
    """Returns (raw_text, parsed_json, ok, error_detail, latency_ms).

    Mirrors chairman.synthesize's return-tuple shape: one provider.ask() call,
    then (for kinds with a backend parser) a parse pass. A parse failure does
    NOT flip ok to False -- the provider DID respond, so the raw text is kept
    and the frontend falls back to showing it plainly.
    """
    t0 = time.monotonic()
    prompt = build_prompt(kind, question=question, answers=answers, verdict=verdict)
    result = await provider.ask(prompt, ctx=ctx, cancel=cancel)
    ms = int((time.monotonic() - t0) * 1000)

    if not result.ok:
        return (
            "",
            None,
            False,
            f"Generator ({provider.display_name}) failed: "
            f"{result.failure} -- {result.error_detail}",
            ms,
        )

    parsed = parse_result(kind, result.text)
    return result.text, parsed, True, None, ms
