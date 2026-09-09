"""Post-capture validation: is this text actually an answer?

A scrape can succeed mechanically -- selector matched, text extracted, no
exception -- and still return something that is not an answer to the question.
Observed live (runs 2026-08-12 20:31 and 21:47): Balthasar returned "Where
should this live?" (23 chars) and "How should the long/short call be made?"
(51 chars) while its peers returned 4,000-12,000 char answers. Both were
recorded RESOLVED, both counted toward a "4/4 resolved" quorum, and the verdict
still claimed all four takes converged.

That is the failure this module exists to stop. The mechanism behind it is
known and is NOT randomness: on a long prompt these UIs emit a short clarifying
preamble, drop the streaming flag while the model thinks, then stream the real
answer into the same node. `completion.py` guards against this with
`confirm_samples`, but that guard is timing-based and a long enough think-pause
still slips through. So this is the second line of defence, checking the
artefact rather than the timing -- the two fail independently, which is the
point.

Design rules, both learned from the failure above:

  * A rejected capture must never be silently dropped and must never be
    silently kept. It becomes DEGRADED: excluded from synthesis, named in the
    UI, and capped in confidence. Discarding it quietly would recreate the same
    "4/4 resolved" lie with a different number.

  * Every rejection carries a human-readable reason. "Balthasar was excluded"
    is not actionable; "Balthasar returned a 23-character clarifying question"
    tells the user their prompt was ambiguous.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum


class Rejection(StrEnum):
    EMPTY = "empty"
    # One or two bare words: a stream captured before it finished.
    TRUNCATED = "truncated"
    # The capture is a question, not an answer: the model asked for
    # clarification, or a preamble was scraped before the real answer streamed.
    CLARIFYING_QUESTION = "clarifying_question"
    # The capture does not engage with the question -- typically a leftover
    # turn from a previous conversation.
    OFF_TOPIC = "off_topic"


# The length below which a capture is treated as SUSPICIOUS -- not the length
# below which it is rejected. Nothing is rejected on size alone.
#
# Calibrated against observed runs, not guessed: bad captures measured 23 and
# 51 chars; good ones 4,331 / 11,146 / 12,338. The gap is three orders of
# magnitude, so the exact value barely matters -- 300 sits far below any real
# answer and far above both failures.
#
# Short captures get the two form-based checks (is it a question? does it
# engage with the question at all?) rather than an automatic rejection,
# because a legitimately terse answer is possible -- "No. Postgres handles
# this fine at your volume." is 55 chars and correct. Overruling that would be
# a worse bug than the one this module prevents.
MIN_ANSWER_CHARS = 300

# A capture that is ONE short question is the signature failure: the model asked
# for clarification instead of answering, or a preamble was captured before the
# real answer streamed in. Both observed cases were exactly this.
#
# Bounded to short single-sentence text on purpose. A long answer that happens
# to end in a question mark ("...so which should you pick? Use Postgres.") is a
# normal rhetorical device and must not be rejected.
_QUESTION_LIKE = re.compile(r"^[^.!?]{0,200}\?$", re.DOTALL)

# Openers that mark a clarifying question even when phrased as a statement.
_CLARIFYING_OPENERS = re.compile(
    r"^\s*(could you|can you|would you|do you|are you|just to|before i|"
    r"to make sure|a few questions|one question|quick question|"
    r"which|what|where|when|who|how|should i)\b",
    re.IGNORECASE,
)


@dataclass
class Validation:
    ok: bool
    reason: Rejection | None = None
    detail: str = ""

    @property
    def summary(self) -> str:
        """One line naming what was wrong, for the Verdict panel and History."""
        return self.detail


def _overlap(question: str, text: str) -> float:
    """Fraction of the question's content words that appear in the answer.

    Deliberately crude. This is a smoke alarm for a capture that belongs to a
    different conversation entirely (a stale turn from a previous run, the
    single nastiest failure mode because it looks perfectly valid). It is NOT a
    relevance grader -- a good answer can legitimately share little vocabulary
    with its question, which is why a low score alone never rejects anything
    long enough to be a real answer.
    """
    stop = {
        "the", "a", "an", "and", "or", "but", "if", "then", "than", "that",
        "this", "these", "those", "is", "are", "was", "were", "be", "been",
        "to", "of", "in", "on", "for", "with", "as", "at", "by", "from",
        "it", "its", "i", "you", "we", "they", "he", "she", "do", "does",
        "did", "can", "could", "should", "would", "will", "what", "which",
        "how", "why", "when", "where", "who", "my", "your", "our", "me",
    }
    words = {w for w in re.findall(r"[a-z0-9]+", question.lower()) if w not in stop and len(w) > 2}
    if not words:
        return 1.0
    body = set(re.findall(r"[a-z0-9]+", text.lower()))
    return len(words & body) / len(words)


def validate_answer(text: str, question: str, *, display_name: str = "") -> Validation:
    """Decide whether a capture is a usable answer.

    Ordered cheapest-first, and each check is narrow enough to name its own
    reason -- a bare "failed validation" would leave the user unable to tell a
    broken scrape from an ambiguous prompt.
    """
    body = (text or "").strip()
    who = display_name or "This member"

    if not body:
        return Validation(False, Rejection.EMPTY, f"{who} returned no text.")

    # A short capture that is itself a question: the signature preamble/
    # clarification failure. Checked BEFORE the length rule so the reason
    # reported is the specific one, not the generic "too short".
    is_question = bool(_QUESTION_LIKE.match(body)) or bool(_CLARIFYING_OPENERS.match(body))
    # A capture of one or two bare words is a truncated stream, not an answer.
    # Observed repeatedly on DeepSeek, which exposes no streaming marker and no
    # stop button: it emits the first word, pauses ~3s, then streams the rest.
    # Captures of "OK" and "Print" were all recorded as full votes.
    #
    # The bar is set at a handful of words rather than a character count so it
    # cannot catch a real (if terse) sentence.
    if len(body.split()) <= 2 and not body.rstrip().endswith((".", "!", "?")):
        return Validation(
            False,
            Rejection.TRUNCATED,
            f"{who} returned only “{body}” — the response was cut off before it "
            f"finished streaming.",
        )

    if is_question and len(body) < MIN_ANSWER_CHARS:
        preview = body if len(body) <= 80 else body[:77] + "..."
        return Validation(
            False,
            Rejection.CLARIFYING_QUESTION,
            f"{who} asked a clarifying question instead of answering "
            f"({len(body)} chars): “{preview}”",
        )

    # Vocabulary overlap is a WEAK signal and is deliberately not used to judge
    # short answers.
    #
    # Replaying 86 real captures showed why: "Name one underrated engineering
    # practice. One sentence." answered with "Treat observability as a product
    # feature, not merely a debugging tool." is exactly right, and shares
    # almost no vocabulary with the question -- because a good short answer
    # introduces new words rather than echoing the prompt. Rejecting on overlap
    # discarded 20+ correct answers. Brevity is also frequently what the user
    # ASKED for ("One sentence."), so treating it as a defect overrules them
    # twice over.
    #
    # The reliable signal for a bad short capture is FORM -- it is a question
    # rather than an answer -- which is checked above and caught every genuine
    # failure in the same replay.
    #
    # Overlap is therefore consulted only in the narrow band where a capture is
    # too long to be a deliberate one-liner but too short to be a full answer,
    # which is the shape a stale turn from a previous conversation takes.
    if MIN_ANSWER_CHARS <= len(body) < 1200 and _overlap(question, body) < 0.10:
        return Validation(
            False,
            Rejection.OFF_TOPIC,
            f"{who}'s response shares almost no vocabulary with the question, "
            f"which usually means a previous conversation turn was captured.",
        )

    return Validation(True)
