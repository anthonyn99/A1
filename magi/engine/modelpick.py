"""Which Claude model a prompt deserves.

Claude's web composer lets you pick the model per message, and the right pick
is not the same for every prompt: Opus is the one to spend on reasoning,
design, debugging and long material, and Sonnet answers a short factual
question just as well while leaving more of the window for the prompts that
need the bigger model. Choosing by hand every time means either never
changing it or thinking about it constantly, so MAGI chooses a default and
shows its reasoning.

TWO RULES THIS FOLLOWS.

  * The heuristic lives HERE and nowhere else. The console shows the pick but
    does not compute it -- one set of rules in two languages drifts, and the
    drift shows up as the console promising Opus for a prompt the engine then
    sends to Sonnet.

  * It always explains itself. `reason` and `signals` come back with the pick,
    so a suggestion you disagree with can be argued with rather than just
    overridden blindly. An automatic choice nobody can see the basis of is one
    nobody can trust.

An explicit choice on a queue item always wins; this is only consulted when
the item says "auto".
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace

#: The aliases the rest of MAGI passes around. They are deliberately NOT
#: version numbers: the composer shows "Sonnet 5", "Opus 4.5" and so on, and
#: pinning a number here would mean editing Python every time Anthropic ships
#: one. browser_base matches these against whatever the live menu offers.
OPUS = "opus"
SONNET = "sonnet"
HAIKU = "haiku"
AUTO = "auto"
MODELS = (AUTO, OPUS, SONNET, HAIKU)

#: How hard the model thinks, where the site offers it as its own control.
#:
#:  This is the lever that actually WORKS on a plan with one model. Verified
#:  on the account MAGI drives: every other model in Claude's menu is an
#:  upgrade offer, but Low / Medium / High / Extra / Max are all selectable
#:  and land in the trigger's own label ("Sonnet 5 High").
#:
#:  MAX is not in EFFORT_AUTO on purpose. Its own menu row reads "3.5x or more
#:  usage", and a heuristic that can quietly cost three and a half times as
#:  much is not one to leave running by itself -- it is reachable only by
#:  asking for it by name.
EFFORTS = (AUTO, "low", "medium", "high", "extra", "max")
EFFORT_AUTO = ("low", "medium", "high")

#: Above this, length alone is enough: a long prompt is carrying detail that
#: only matters if the model actually holds all of it.
LONG_CHARS = 1200
VERY_LONG_CHARS = 4000

#: Short enough to be a throwaway question -- but see suggest(): shortness
#: only counts against a prompt that asks for nothing hard.
SHORT_CHARS = 120

#: Work that rewards the bigger model. Matched as whole words so "plan" does
#: not fire on "planet" and "why" does not fire on "always".
_HEAVY = (
    r"architect\w*", r"design\w*", r"refactor\w*", r"debug\w*", r"diagnos\w*",
    r"root cause", r"why\b", r"trade-?offs?", r"strategy", r"strategic",
    r"analy[sz]e", r"analysis", r"evaluat\w*", r"compare", r"comparison",
    r"critique", r"review", r"prove", r"deriv\w*", r"optimi[sz]\w*",
    r"algorithm", r"complexity", r"security", r"vulnerab\w*", r"migrat\w*",
    r"schema", r"forecast", r"projections?", r"implications?", r"plan\b",
    r"roadmap", r"report", r"recommend\w*", r"decide", r"decision",
    r"step[- ]by[- ]step", r"reason\w*", r"proof", r"stack trace",
    r"traceback", r"exception", r"failing test",
)

#: Work a smaller model does just as well.
_LIGHT = (
    r"what is", r"who is", r"when (?:is|was|did)", r"defin\w*",
    r"summar\w*", r"tl;?dr", r"list", r"translat\w*", r"rewrite",
    r"rephras\w*", r"reword", r"shorter", r"shorten", r"briefly",
    r"in one (?:line|sentence)", r"quick(?:ly)?", r"simple",
    r"name (?:for|this)",
)

#: Work that is mechanical NO MATTER HOW MUCH of it there is. Separated from
#: _LIGHT because the two behave differently under length: summarising more
#: material is harder, while fixing the spelling of more material is only
#: longer. Four thousand words asking for a typo fix was reaching Opus purely
#: on its size.
_MECHANICAL = (
    r"spelling", r"typos?", r"proofread", r"capitali[sz]e", r"format",
    r"convert", r"title", r"punctuation", r"indent\w*",
)

_HEAVY_RE = re.compile("|".join(_HEAVY), re.I)
_LIGHT_RE = re.compile("|".join(_LIGHT), re.I)
_MECH_RE = re.compile("|".join(_MECHANICAL), re.I)
_CODE_RE = re.compile(r"```|\bdef \w+\(|\bclass \w+\b|;\s*$|\{\s*$", re.M)


@dataclass(frozen=True)
class Pick:
    model: str
    reason: str
    score: int
    signals: tuple[str, ...]
    #: The same judgement expressed as effort, for the plans where that is the
    #: only thing that can actually be changed.
    effort: str = "medium"

    def as_dict(self) -> dict:
        return {
            "model": self.model,
            "effort": self.effort,
            "reason": self.reason,
            "score": self.score,
            "signals": list(self.signals),
        }


def _effort_for(score: int) -> str:
    """One scale, two expressions. A prompt heavy enough for Opus is heavy
    enough to think hard about on Sonnet, and the same is true downwards."""
    if score >= 2:
        return "high"
    if score <= -1:
        return "low"
    return "medium"


def suggest(question: str, *, attachments: int = 0, units: int = 1) -> Pick:
    """The model to use for this prompt, with the reasoning attached.

    Scored rather than decided by one rule, because the signals disagree
    constantly: a short prompt asking why a system deadlocks is Opus work, and
    three thousand words asking for a spelling fix is not.
    """
    q = (question or "").strip()
    score = 0
    signals: list[str] = []

    n = len(q)
    heavy = sorted({m.group(0).lower() for m in _HEAVY_RE.finditer(q)})

    if n >= VERY_LONG_CHARS:
        score += 3
        signals.append(f"{n:,} characters of prompt")
    elif n >= LONG_CHARS:
        score += 2
        signals.append(f"{n:,} characters of prompt")
    elif n <= SHORT_CHARS and not heavy and not attachments:
        # Only when nothing else in it is hard, and nothing came with it.
        # "Why does this deadlock?" is eighty characters and squarely Opus
        # work, and "what do you make of these?" with three files attached is
        # short only because the material is in the files. Shortness means
        # "not much to do" just when there is nothing else to go on.
        score -= 1
        signals.append("a one-line question")

    if heavy:
        # Two apiece, not one: the kind of work asked for outweighs how much
        # of it was typed, and these matches are what actually separate
        # "think about this" from "tidy this up".
        score += min(4, 2 * len(heavy))
        signals.append("asks for " + ", ".join(heavy[:3]))

    light = sorted({m.group(0).lower() for m in _LIGHT_RE.finditer(q)})
    if light:
        score -= min(2, len(light))
        signals.append("reads as " + ", ".join(light[:3]))

    if _CODE_RE.search(q):
        score += 2
        signals.append("contains code")

    if attachments:
        score += 2
        signals.append(f"{attachments} attachment{'s' if attachments != 1 else ''} to read")

    # More than one question in one prompt is more to hold at once.
    questions = q.count("?")
    if questions >= 3:
        score += 1
        signals.append(f"{questions} separate questions")

    # A council answer feeds a chairman that has to reconcile the lot, so a
    # weak member answer costs more than it would on its own.
    if units >= 4:
        score += 1
        signals.append(f"{units} units deliberating")

    mech = sorted({m.group(0).lower() for m in _MECH_RE.finditer(q)})
    if mech and not heavy:
        # A cap rather than a penalty: however long the text, correcting it is
        # not reasoning, and no amount of it should reach for the bigger model.
        signals.append("mechanical: " + ", ".join(mech[:2]))
        capped = min(score, 1)
        return Pick(model=SONNET, reason="mechanical work, whatever its size",
                    score=capped, signals=tuple(signals), effort="low")

    if score >= 2:
        model, reason = OPUS, "heavier reasoning than Sonnet is meant for"
    elif score <= 0:
        model, reason = SONNET, "Sonnet answers this fully, and cheaper"
    else:
        model, reason = SONNET, "no signal that it needs Opus"

    return Pick(model=model, reason=reason, score=score,
                signals=tuple(signals), effort=_effort_for(score))


def resolve(choice: str | None, question: str, *, attachments: int = 0,
            units: int = 1, effort: str | None = None) -> Pick:
    """An explicit choice, or the suggestion when the choice is "auto".

    One entry point for both, so nothing downstream has to remember that
    "auto" is not a model name the composer would recognise. `effort` is
    resolved the same way and independently: choosing a model by hand does not
    mean choosing how hard it thinks.
    """
    c = (choice or AUTO).strip().lower()
    e = (effort or AUTO).strip().lower()
    base = (Pick(model=c, reason="you chose it", score=0, signals=())
            if c in (OPUS, SONNET, HAIKU)
            else suggest(question, attachments=attachments, units=units))
    if e in EFFORTS and e != AUTO:
        return replace(base, effort=e)
    return base
