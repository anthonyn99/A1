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
    # The capture is the prompt MAGI sent -- the user's own message, scraped
    # because a turn selector matched it.
    ECHO = "echo"
    # The site's own canned refusal or error line, not the model's answer.
    REFUSAL = "refusal"


#: The opening words of the instruction MAGI puts before every question
#: (providers/browser_base.DIRECT_ANSWER_PREAMBLE). No model begins its answer
#: with them; a capture that does is the prompt, read back.
ECHO_PREFIX = "reply with your full answer in this chat message"


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


# An offer to do the work, instead of the work.
#
# The rule above only fires under MIN_ANSWER_CHARS, because a long answer
# ending in a question mark is a normal rhetorical device. But a member can
# decline at length: observed at 543 characters --
#
#     "I'm ready to deliver your Daily Macro Snapshot. However, I need current
#      market data... Should I: 1. Search the web for today's macro data?
#      2. Wait for you to provide specific data points? Let me know and I'll
#      deliver the snapshot in your exact format."
#
# -- which sailed past every check and was counted as a full council vote.
#
# These phrases are specific enough to be safe: each is a model asking
# permission to proceed, which in a one-shot council is the same as declining.
# Still bounded by length, because a genuinely long answer may well close with
# "let me know if you want more detail" after having ALREADY answered.
_OFFER_TO_PROCEED = re.compile(
    r"\b(should i|shall i|would you like me to|do you want me to|"
    r"want me to|if you(?:'d| would) like[, ]+i can|i can (?:go ahead and )?"
    # Any characters, not "no sentence punctuation": the real capture put the
    # question mark after a numbered list, and "1." killed a [^.!?] run before
    # it ever reached the "?".
    r"(?:search|look|pull|fetch|gather))\b[\s\S]{0,200}\?",
    re.IGNORECASE | re.DOTALL,
)

# Four times the short-answer bar. Above this there is enough text that the
# member has plainly said something, whatever else it also asked.
MAX_OFFER_CHARS = MIN_ANSWER_CHARS * 4


# A canned refusal or error line: the chat site's stock reply when the model
# declined, crashed, or was cut off by the backend -- not an answer.
#
# Observed 2026-09-21, one run, both from Gemini: as a member, "I'm having a
# hard time fulfilling your request. Can I help you with something else
# instead?" was recorded RESOLVED and counted in a "5/5 resolved" consensus;
# as chairman, "I encountered an error doing what you asked. Could you try
# again?" was published as the verdict. Both are complete sentences, so the
# truncation rule waved them through, and neither is a question about the
# task, so the clarifying rules did too.
#
# Every site has its own wording, so this lists the phrasings by meaning and
# covers all six units. Bounded by length like the offer rule: a stock line is
# one or two sentences, and a real answer that QUOTES "something went wrong"
# in passing is far longer than this.
_CANNED_REFUSAL = re.compile(
    r"("
    # "I'm having a hard time fulfilling your request" (Gemini)
    r"\bhaving (?:a )?(?:hard|difficult) time (?:fulfilling|with|helping|understanding|answering)"
    # "I encountered an error doing what you asked" (Gemini chairman)
    r"|\bi (?:encountered|ran into|hit|experienced) (?:an? )?(?:error|problem|issue|glitch)"
    r"|\b(?:an? )?(?:error|problem) (?:occurred|has occurred|was encountered)"
    r"|\bsomething went wrong"
    r"|\bcould you (?:please )?try again\b|\bplease try again\b|\btry again later\b"
    # "Can I help you with something else instead?"
    r"|\bhelp you with something else\b|\btalk about something else\b"
    # "I'm just a language model, so I can't help you with that." (Gemini)
    r"|\bi'?m (?:just |only )?a language model\b|\bas an? (?:ai|language model)\b[^.]{0,60}\b(?:can'?t|cannot|unable|not able)"
    # "I can't help with that." / "Sorry, I can't assist with that." (all)
    r"|\bi (?:can'?t|cannot|am unable to|'m unable to|am not able to|'m not able to|won'?t be able to) "
    r"(?:help|assist|fulfil+|complete|do|provide|answer|respond|process|comply)\b[^.]{0,60}\b(?:that|this|request|question)\b"
    # "Sorry, that's beyond my current scope." (DeepSeek)
    r"|\bbeyond my (?:current )?scope\b"
    # Backend busy / cut off (DeepSeek, ChatGPT, Grok)
    r"|\bserver is busy\b|\bnetwork error\b|\bthe (?:response|request) (?:was )?(?:interrupted|failed|timed out)\b"
    r"|\bhit (?:the|your) (?:usage |message )?limit\b|\breached (?:the|your) (?:usage |message |daily )?limit\b"
    r"|\bunable to (?:generate|load|complete) (?:a |the )?(?:response|answer)\b"
    r")",
    re.IGNORECASE,
)

# Stock lines measured 60-130 characters. 600 leaves room for a site that
# pads its refusal with a sentence of boilerplate, and sits far below the
# shortest real answer to a research question.
MAX_CANNED_CHARS = 600


def _is_canned_refusal(body: str) -> bool:
    if len(body) >= MAX_CANNED_CHARS:
        return False
    return bool(_CANNED_REFUSAL.search(body.replace("’", "'").replace("‘", "'")))


@dataclass
class Validation:
    ok: bool
    reason: Rejection | None = None
    detail: str = ""

    @property
    def summary(self) -> str:
        """One line naming what was wrong, for the Verdict panel and History."""
        return self.detail


#: Above this many distinct content words, the reference is not a question.
#: Real questions measured 2-40; the chairman's synthesis prompt measured 600+.
MAX_REFERENCE_WORDS = 120


_STOP = {
    "the", "a", "an", "and", "or", "but", "if", "then", "than", "that",
    "this", "these", "those", "is", "are", "was", "were", "be", "been",
    "to", "of", "in", "on", "for", "with", "as", "at", "by", "from",
    "it", "its", "i", "you", "we", "they", "he", "she", "do", "does",
    "did", "can", "could", "should", "would", "will", "what", "which",
    "how", "why", "when", "where", "who", "my", "your", "our", "me",
}


def _words(question: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", question.lower()) if w not in _STOP and len(w) > 2}


def _content_words(question: str) -> int:
    """How many distinct words of the question the overlap check can use."""
    return len(_words(question))


def _overlap(question: str, text: str) -> float:
    """Fraction of the question's content words that appear in the answer.

    Deliberately crude. This is a smoke alarm for a capture that belongs to a
    different conversation entirely (a stale turn from a previous run, the
    single nastiest failure mode because it looks perfectly valid). It is NOT a
    relevance grader -- a good answer can legitimately share little vocabulary
    with its question, which is why a low score alone never rejects anything
    long enough to be a real answer.
    """
    words = _words(question)
    if not words:
        return 1.0
    # A reference this wide is not a question -- it is an instruction block,
    # and the ratio below stops meaning anything: a correct short answer can
    # only ever contain a sliver of it, so every short answer scores as
    # off-topic. 1.0 is "no signal", which is what this crude check is
    # entitled to say about material it cannot judge. The caller passing the
    # wrong reference is the real bug (see browser_base), and this is the
    # guard that stops the next caller repeating it.
    if len(words) > MAX_REFERENCE_WORDS:
        return 1.0
    body = set(re.findall(r"[a-z0-9]+", text.lower()))
    return len(words & body) / len(words)


def validate_answer(
    text: str, question: str, *, display_name: str = "", has_attachments: bool = False
) -> Validation:
    """Decide whether a capture is a usable answer.

    Ordered cheapest-first, and each check is narrow enough to name its own
    reason -- a bare "failed validation" would leave the user unable to tell a
    broken scrape from an ambiguous prompt.
    """
    body = (text or "").strip()
    who = display_name or "This member"

    if not body:
        return Validation(False, Rejection.EMPTY, f"{who} returned no text.")

    # Checked before anything else can accept it: an echo is long, on topic
    # and punctuated, so every later rule would wave it through as a vote.
    if " ".join(body.lower().split()).startswith(ECHO_PREFIX):
        return Validation(
            False,
            Rejection.ECHO,
            f"{who}: MAGI read back the prompt it sent instead of the reply, "
            f"so this was not counted.",
        )

    # A stock refusal or error line is a complete, punctuated sentence, so it
    # must be caught before the length and question rules can accept it.
    if _is_canned_refusal(body):
        preview = body if len(body) <= 120 else body[:117] + "..."
        return Validation(
            False,
            Rejection.REFUSAL,
            f"{who} returned a refusal or error message instead of an answer: "
            f"“{preview}”",
        )

    # A short capture that is itself a question: the signature preamble/
    # clarification failure. Checked BEFORE the length rule so the reason
    # reported is the specific one, not the generic "too short".
    is_question = bool(_QUESTION_LIKE.match(body)) or bool(_CLARIFYING_OPENERS.match(body))
    # A capture of a few bare words is a truncated stream or a UI placeholder,
    # not an answer. Observed repeatedly on DeepSeek, which exposes no streaming
    # marker and no stop button: it emits the first word, pauses ~3s, then
    # streams the rest. Captures of "OK" and "Print" were all recorded as full
    # votes.
    #
    # Raised from 2 to 4 words after Gemini returned "Searching the web" -- its
    # own loading state, captured on a stall_timeout -- and scored as a full
    # vote at three words, missing the old bar by one. The verdict then claimed
    # HIGH confidence over "three of four members" on the strength of it.
    #
    # The terminal-punctuation exemption is what keeps this safe: a deliberate
    # terse answer is a SENTENCE and ends like one ("Use Postgres.", "No.
    # Postgres handles this fine at your volume."), while a truncated stream and
    # a spinner label both stop mid-air. So the bar counts words rather than
    # characters and never fires on anything punctuated as finished.
    if len(body.split()) <= 4 and not body.rstrip().endswith((".", "!", "?")):
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

    # ...and the same failure dressed up at length: an offer to do the work
    # rather than the work. In a one-shot council, asking permission is
    # declining -- nobody is watching that tab to say yes.
    if len(body) < MAX_OFFER_CHARS and _OFFER_TO_PROCEED.search(body):
        preview = body if len(body) <= 80 else body[:77] + "..."
        return Validation(
            False,
            Rejection.CLARIFYING_QUESTION,
            f"{who} offered to do the work instead of doing it "
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
    #
    # And never when files came with the question, or the question is only a
    # few words: "Describe this environment" with a photo is answered entirely
    # in the photo's vocabulary -- mountains, lake, stars -- and Gemini and
    # Claude were both thrown out for describing it correctly (2026-09-16).
    if (
        MIN_ANSWER_CHARS <= len(body) < 1200
        and not has_attachments
        and _content_words(question) >= 3
        and _overlap(question, body) < 0.10
    ):
        return Validation(
            False,
            Rejection.OFF_TOPIC,
            f"{who}'s response shares almost no vocabulary with the question, "
            f"which usually means a previous conversation turn was captured.",
        )

    return Validation(True)
