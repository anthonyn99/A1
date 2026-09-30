"""Deliberation follow-ups: the memory a follow-up question carries (Track F).

Every council unit turn opens a fresh chat, so nothing on the sites remembers
the previous turn. A follow-up gets its memory the way Brainstorm rounds do:
the earlier turns are replayed into the prompt as a block of data. The console
is the source of truth for the thread and sends the prior turns with each
follow-up; this module turns them into the block, trimmed to fit.

It also holds the notes typed WHILE a run is going (`Steer`): a note that
lands before synthesis starts is handed to the chairman and folded into the
verdict; one that lands after is held for the next follow-up.
"""

from __future__ import annotations

import json
import re

from .chairman import _fit, prompt_budget
from .validate import MAX_REFERENCE_WORDS, _STOP

# The block never grows past this, whatever the unit would accept: a site's
# composer is the tighter limit long before the model's context is.
MAX_CONTEXT_CHARS = 24_000
# Room kept free for the preamble, the new message and slack.
CONTEXT_RESERVE = 6_000
# What POST /api/runs accepts as `context` before it is trimmed.
MAX_CONTEXT_INPUT = 200_000
MAX_CONTEXT_TURNS = 200
# An older question is kept to this; the newest turn keeps its question whole.
OLD_QUESTION_CHARS = 1_500

MAX_NOTE_CHARS = 4_000
MAX_NOTES = 10

HEADER = (
    "CONVERSATION SO FAR (earlier turns of this conversation; the new message "
    "follows)"
)
NEW_MESSAGE = "NEW MESSAGE:\n"

_SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def valid_session_id(sid: str) -> bool:
    return bool(_SESSION_ID.match(sid or ""))


def answer_section(verdict: str) -> str:
    """The verdict's ANSWER body, without its NOTES and CONFIDENCE.

    A verdict that does not have the three headings (a sole unit's answer, a
    chairman that ignored the format) is kept whole.
    """
    text = (verdict or "").strip()
    m = re.match(r"^\s*ANSWER\s*\n", text)
    if m:
        text = text[m.end():]
    cut = re.search(r"^\s*(?:NOTES|CONFIDENCE)\s*$", text, re.MULTILINE)
    if cut:
        text = text[: cut.start()]
    return text.strip()


def parse_context(raw: str) -> list[dict]:
    """Validate the console's `context` field: JSON `[{q, answer}]`.

    Raises ValueError with a message fit for a 400.
    """
    if not raw or not raw.strip():
        return []
    if len(raw) > MAX_CONTEXT_INPUT:
        raise ValueError(f"context is over {MAX_CONTEXT_INPUT:,} characters")
    try:
        data = json.loads(raw)
    except ValueError:
        raise ValueError("context is not valid JSON") from None
    if not isinstance(data, list):
        raise ValueError("context must be a list of turns")
    if len(data) > MAX_CONTEXT_TURNS:
        raise ValueError(f"context has more than {MAX_CONTEXT_TURNS} turns")
    turns = []
    for t in data:
        if not isinstance(t, dict):
            raise ValueError("each context turn must be an object")
        q, a = t.get("q", ""), t.get("answer", "")
        if not isinstance(q, str) or not isinstance(a, str):
            raise ValueError("context q and answer must be strings")
        if q.strip():
            turns.append({"q": q.strip(), "answer": answer_section(a)})
    return turns


def budget_for(provider_id: str, question: str) -> int:
    return max(0, min(
        MAX_CONTEXT_CHARS,
        prompt_budget(provider_id) - len(question) - CONTEXT_RESERVE,
    ))


def _clip(text: str, n: int) -> str:
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def build_context(turns: list[dict], budget: int, header: str = HEADER) -> str:
    """The CONVERSATION SO FAR block, at most `budget` characters.

    Trimmed in this order until it fits, mirroring Brainstorm's transcript:
    older answers are shortened (head + tail, `chairman._fit`), then dropped
    oldest-first so only their questions remain, then the oldest questions go
    too behind "[n earlier turns omitted]". The newest turn is kept whole for
    as long as anything can be, and shortened last.

    `header` names the block: Code Mode's follow-ups (code/followup.py) call
    it "SESSION SO FAR".
    """
    turns = [t for t in turns if (t.get("q") or "").strip()]
    if not turns or budget <= 0:
        return ""
    n = len(turns)
    qs = [
        t["q"].strip() if i == n - 1 else _clip(t["q"].strip(), OLD_QUESTION_CHARS)
        for i, t in enumerate(turns)
    ]
    full = [(t.get("answer") or "").strip() for t in turns]

    def render(answers: list[str], qonly: int = 0, omitted: int = 0) -> str:
        parts = [header]
        if omitted:
            parts.append(
                f"[{omitted} earlier turn{'s' if omitted > 1 else ''} omitted]"
            )
        for i in range(omitted, n):
            block = f"--- Turn {i + 1} ---\nPERSON: {qs[i]}"
            if (i >= qonly or i == n - 1) and answers[i]:
                block += f"\nANSWER:\n{answers[i]}"
            parts.append(block)
        return "\n\n".join(parts)

    out = render(full)
    if len(out) <= budget:
        return out

    # Older answers shortened, then dropped oldest-first.
    for qonly in range(0, n):
        older = full[qonly:n - 1]
        bare = render(full[:qonly] + [""] * len(older) + [full[-1]], qonly)
        label = len("\nANSWER:\n") * sum(1 for a in older if a)
        fitted = _fit(older, budget - len(bare) - label) if older else []
        out = render(full[:qonly] + fitted + [full[-1]], qonly)
        if len(out) <= budget:
            return out

    # Only questions left of the older turns: drop the oldest of those.
    for omitted in range(1, n):
        out = render(full, n - 1, omitted)
        if len(out) <= budget:
            return out

    # The newest turn alone is too long: shorten its answer, then clip.
    omitted = n - 1
    bare = render(full[:-1] + [""], n - 1, omitted)
    newest = _fit([full[-1]], max(0, budget - len(bare)))[0] if full[-1] else ""
    out = render(full[:-1] + [newest], n - 1, omitted)
    return out if len(out) <= budget else out[:budget]


def prompt_with_context(question: str, turns: list[dict], budget: int) -> str:
    block = build_context(turns, budget)
    if not block:
        return question
    return f"{block}\n\n{NEW_MESSAGE}{question}"


def reference(question: str, turns: list[dict]) -> str:
    """What a follow-up's answers are checked against for OFF_TOPIC.

    A follow-up is short ("and the second one?") and its answer talks about
    the conversation, not the follow-up's own few words -- so checking against
    the question alone would throw good answers out. The reference is the new
    question, the earlier questions newest-first, then the latest answer, cut
    to MAX_REFERENCE_WORDS content words: past that `_overlap` stops judging at
    all, and the check must stay on.
    """
    pieces = [question]
    pieces += [t.get("q", "") for t in reversed(turns)]
    if turns:
        pieces.append(turns[-1].get("answer", ""))
    seen: set[str] = set()
    kept: list[str] = []
    budget = MAX_REFERENCE_WORDS - 10
    for piece in pieces:
        for tok in re.findall(r"\S+", piece or ""):
            words = {
                w for w in re.findall(r"[a-z0-9]+", tok.lower())
                if w not in _STOP and len(w) > 2
            }
            if len(seen | words) > budget:
                return " ".join(kept)
            seen |= words
            kept.append(tok)
    return " ".join(kept)


class Steer:
    """Notes typed while a run is going, and which bucket each landed in.

    Every method is synchronous, so under the one event loop a note is either
    in before `close_gather()` snapshots the list or after it -- never both,
    never neither. The orchestrator calls `close_gather()` with no `await`
    between it and the moment synthesis starts.
    """

    def __init__(self) -> None:
        self.phase = "gather"  # gather | synth | done
        self.notes: list[str] = []  # for the verdict
        self.followup: list[str] = []  # arrived too late: the next follow-up

    def add(self, text: str) -> str:
        text = (text or "").strip()
        if not text:
            raise ValueError("note is empty")
        if len(text) > MAX_NOTE_CHARS:
            raise ValueError(f"note is over {MAX_NOTE_CHARS:,} characters")
        if len(self.notes) + len(self.followup) >= MAX_NOTES:
            raise OverflowError(f"at most {MAX_NOTES} notes per run")
        if self.phase == "gather":
            self.notes.append(text)
            return "verdict"
        self.followup.append(text)
        return "followup"

    def close_gather(self) -> list[str]:
        self.phase = "synth"
        return list(self.notes)

    def finish(self) -> None:
        self.phase = "done"
