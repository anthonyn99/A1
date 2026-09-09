"""Brainstorm mode: many rounds of council questions until a plan is ready.

The council run answers a question once. This answers a harder one -- "what
should we actually do?" -- by refusing to answer it in one shot. Each round the
full council reads the running transcript, proposes an approach, and names what
it would need to know; the chairman merges that into one evolving plan draft
plus a consolidated set of questions for the user. The user replies, and the
next round starts from there.

Two properties this depends on:

  * Multi-turn without stateful sessions. Provider.ask() opens a fresh browser
    context every call and no chat thread is ever resumed, so continuity comes
    from replaying the transcript in the prompt -- the same trick the chairman
    already uses to show one member what the others said.

  * The user ends the session, not the model. The chairman reports whether it
    believes further questions have low marginal value, and that is all it is:
    a report. A model deciding it has heard enough is not the same thing as the
    person with the actual problem deciding it.
"""

from __future__ import annotations

import json
import re
import time
from datetime import date

from ..providers.base import Answer, Provider, RunContext

# ── task type ───────────────────────────────────────────────────────────────

# What KIND of question this session is, which decides the shape of the final
# document. The old code had one template -- the coding-agent handoff, with
# Implementation Steps and Files to Touch -- and applied it to every session.
# Asked for advice rather than a build, the chairman still had those headings
# to fill, so it manufactured a build task to fill them.
#
# Deliberately classified in Python, not by an extra council call. Every call
# here is a real browser launch (~10s of startup before a single token), so a
# "cheap classifier call" is not cheap in this system. The heuristic only has
# to pick a document shape, and the chairman is shown the choice and told to
# correct it -- a wrong guess costs a heading, not the session.

BUILD = "build"
ADVICE = "advice"
RESEARCH = "research"

# Ordered by how strongly each signals its type. Matched against the topic
# only, since that is all that exists before round 1.
_BUILD_HINTS = re.compile(
    r"\b(?:build|implement|refactor|migrat|deploy|code|codebase|api|endpoint|"
    r"database|schema|test|bug|fix|feature|app|script|library|module|function|"
    r"repo|frontend|backend|server|ship)\w*\b",
    re.IGNORECASE,
)
_RESEARCH_HINTS = re.compile(
    r"\b(?:research|compare|comparison|survey|landscape|what are the|"
    r"find out|investigate|state of|options for|literature|evidence)\w*\b",
    re.IGNORECASE,
)
_ADVICE_HINTS = re.compile(
    r"\b(?:should i|should we|advice|decide|decision|choose|worth it|"
    r"strategy|invest|budget|career|allocat|plan for|approach to|"
    r"how much|trade-?off)\w*\b",
    re.IGNORECASE,
)

# Domains where a confidently-worded personal directive is the wrong output
# even when the reasoning is sound.
_SENSITIVE = re.compile(
    r"\b(?:invest|portfolio|stock|equit|fund|etf|bond|savings|pension|"
    r"tax|retirement|salary|mortgage|loan|debt|insurance|trading|trade|"
    r"legal|lawsuit|contract law|liabilit|medical|health|"
    r"diagnos|symptom|medication|dosage|therapy|safety|hazard)\w*\b",
    re.IGNORECASE,
)


def classify_topic(topic: str) -> str:
    """Which document shape this session should produce.

    Intent is checked before subject matter. A topic can name technology while
    asking a question that is not a build -- "compare vector databases" is
    research ABOUT databases, not a request to build one -- so matching the
    build vocabulary first would misroute exactly the questions the old
    single-template behaviour handled worst.

    Build is the default when nothing matches: it is the original behaviour,
    and it is the safer error. An advice session wrongly given Files to Touch
    invents busywork to fill the heading, while a build session given the
    advice shape merely loses some structure.
    """
    t = topic or ""
    if _RESEARCH_HINTS.search(t):
        return RESEARCH
    if _ADVICE_HINTS.search(t):
        return ADVICE
    if _BUILD_HINTS.search(t):
        return BUILD
    return BUILD


def is_sensitive(topic: str) -> bool:
    """Whether this session touches a regulated or high-stakes domain."""
    return bool(_SENSITIVE.search(topic or ""))


# Appended to every prompt in a sensitive session. Frames the answer as a
# trade-off the person decides rather than an instruction they follow, and
# forbids silently reframing the goal they actually stated.
GUARDRAIL = """

This topic is in a high-stakes area (money, law, health, or safety). Three things follow, and they override the instructions above wherever they conflict:
- Give the trade-off and what it depends on, not a personal directive. Say what you would weigh and why, not what the person must do.
- Never state a number, threshold, rate, limit, or rule from memory as current fact. Say what it depends on and tell the person to check the live figure. Rules in this area change, and a confidently wrong one is worse than an acknowledged gap.
- If you think the person is asking the wrong question, say so explicitly and let them choose -- do not quietly answer a different, better question instead."""


# ── prompts ─────────────────────────────────────────────────────────────────

MEMBER_ROUND_PROMPT = """You are one member of a council of AI models working \
with a person to turn a rough idea into a plan. Every member sees the same \
material and answers independently.

THE TOPIC
{topic}

THIS SESSION IS A "{task_type}" SESSION.
{task_note}

{corrections}{ledger}{transcript}
This is round {round_no}.

Your job this round is NOT to write the final plan. It is to move the thinking \
forward: say how you would approach this, and name precisely what you would \
need to learn from the person before the plan could be trusted.

Write exactly these three sections, each heading alone on its own line:

APPROACH
How you would actually do this, concretely. If a plan draft is shown above, \
this is where you say what you would keep, what you would change, and what you \
would throw out. Name specific technical choices, not categories of choice -- \
"store it in SQLite alongside the existing tables" rather than "pick a storage \
approach". If you think the draft is heading somewhere wrong, say so plainly \
and say what to do instead. Do not restate the draft back approvingly; \
agreement that adds nothing is worse than useful disagreement, and the person \
convened several models precisely so they would not get one view repeated.

UNKNOWNS
The things you genuinely do not know that would change the plan, as a numbered \
list of direct questions to the person. Order them by how much the answer would \
change what gets built -- a question whose answer redirects the whole approach \
comes before one that settles a detail. Only ask what you actually need: if you \
can make a reasonable default choice yourself, make it in APPROACH and do not \
spend a question on it. Never re-ask anything listed as already settled above, \
and never re-ask something already answered in the transcript. If you have \
nothing left worth asking, write "None."

End any question with ` [BLOCKING]` when you could not write a trustworthy \
plan at all until it is answered -- when the answer changes the plan's \
STRUCTURE rather than its detail. Use it sparingly and only where you mean it: \
a blocking question stops the person being told the plan is finished, so \
tagging a detail wastes their time, while leaving a structural question \
untagged lets them build on a guess. If you would say "I would not finalise \
this until X is known", then X is blocking and must carry the tag.

RISKS
Two to four short bullets: what is most likely to go wrong, be harder than it \
looks, or get discovered late. Be specific about this plan, not generic \
software advice. If you have none, write "None."

Write plainly and briefly. No preamble, no pleasantries, no offers of further \
help. Do not mention the other members or this process."""


MEMBER_CRITIQUE_PROMPT = """You are one member of a council of AI models \
working with a person to turn a rough idea into a plan. Every member has just \
proposed an approach independently. You are now reading what the others said.

THE TOPIC
{topic}

{transcript}\
WHAT EACH MEMBER PROPOSED THIS ROUND
{responses}

YOUR OWN PROPOSAL WAS THE ONE LABELLED "{me}".

Your job now is to attack these proposals -- including your own where it \
deserves it. Do not summarise them, do not praise them, and do not restate \
your own approach. The person convened several models so that each one's \
mistakes would be caught by another; agreement that adds nothing wastes that.

Write exactly these three sections, each heading alone on its own line:

OBJECTIONS
For each OTHER member, one bullet naming the single strongest objection to \
what they proposed -- the thing most likely to make it fail or cost the person \
time. Start the bullet with the member's name and a colon. Be specific about \
their actual proposal: "Balthasar's polling loop re-reads the whole file every \
tick, which stops scaling at a few thousand rows" is useful; "this could have \
performance issues" is not. If a proposal is genuinely sound, say so in a \
single short bullet and move on -- but say it rarely, and never about all of \
them at once.

CORRECTIONS
Statements of FACT any member made that are wrong -- not choices you would \
have made differently, but claims that are untrue. One bullet each, in the \
form: `MEMBER — claimed: <what they said> — actually: <the correction>`. This \
is the only section where you contradict someone on facts rather than \
judgement, so keep opinion out of it. If a claim is one you cannot check from \
your own knowledge, do not list it here -- say it is unverified in OBJECTIONS \
instead. If there are no factual errors, write "None."

CONCEDE
Anything another member raised that you now think is better than what you \
proposed, and what you withdraw as a result. Write "Nothing" only if that is \
honestly true. A council where nobody ever concedes is not deliberating.

Write plainly and briefly. No preamble, no pleasantries. Do not mention this \
process or that you are critiquing anything."""


CHAIRMAN_ROUND_PROMPT = """You are the chairman of a council of AI models \
helping a person turn a rough idea into a plan. Each member independently \
proposed an approach, then read the others and attacked them. Your job is to \
merge all of that into what the person sees this round.

THE TOPIC
{topic}

THIS SESSION IS A "{task_type}" SESSION.
{task_note}

{ledger}{transcript}
COUNCIL RESPONSES THIS ROUND ({responded} of {total} members responded{failure_note})
{responses}

WHAT THE MEMBERS SAID ABOUT EACH OTHER
These are the members' objections to each other's proposals, the factual \
corrections they raised, and what each conceded. Where a member's proposal was \
successfully attacked and they did not defend it, do not carry it into the \
plan. Where two members disagree and neither conceded, that is a real split \
and belongs in AGREEMENT.
{critiques}

Write exactly these five sections, each heading alone on its own line, in this \
order and with these exact names:

PLAN SO FAR
The current best plan, rewritten IN FULL every round -- the person should be \
able to read this section alone and know where things stand, without the \
earlier rounds. Fold in everything settled so far, including the answers the \
person has already given. Where the council converged, state the decision \
directly. Where a question is still open, say what the plan does provisionally \
and mark it as provisional. This section should visibly get sharper each \
round; if it reads the same as the previous round, the round was wasted. Use \
short paragraphs, `### Sub-heading` lines only if there are three or more \
genuinely separate parts, and bullets for real lists.

QUESTIONS
Three to six questions for the person, highest-leverage first -- the one whose \
answer would most change what gets built goes first. Merge duplicate unknowns \
from different members into one question. Drop any question the transcript \
already answers, any you can reasonably decide yourself (decide it in PLAN SO \
FAR instead and say so), and any that is a matter of taste with no real \
consequence. Ask about intent, constraints, and priorities -- not about \
implementation details that are your job to choose. If you genuinely have \
nothing left to ask, write "None."

Write each question as a block in exactly this line format, one field per line, \
with a blank line between blocks:

Q: the question, as one clear sentence
HEADER: a 2-3 word label, at most 14 characters
KIND: choice
BLOCKING: yes
OPTION: Short label -- one line on what choosing this would mean or cause
OPTION: Short label -- one line on what choosing this would mean or cause

Rules for these blocks, which matter as much as the questions themselves:
- BLOCKING is `yes` only when the STRUCTURE of the plan depends on the answer \
-- when you would write a materially different plan depending on how it is \
answered, not merely a more detailed one. Everything else is `no`. Be strict: \
if most of your questions are blocking, none of them are. A blocking question \
left unanswered stops the plan being marked finished, so marking a detail \
blocking wastes the person's time, and marking a structural question `no` \
lets them ship a plan built on a guess.
- KIND is either `choice` or `open`. Use `choice` when the realistic answers \
are a small set you can name, and give 2 to 4 OPTION lines. Use `open` when the \
answer is a number, a name, a date, a path, or a free description -- and then \
give NO option lines at all. Never invent options for a genuinely open \
question: three plausible-looking wrong choices are worse than an empty box, \
because the person will pick one rather than correct you.
- Options must be mutually exclusive, and together they must cover the \
realistic space. If "some of each" is an honest answer, make that its own \
option rather than leaving a gap the person falls through.
- Put the option you would recommend FIRST, and use its description to say why. \
The person is choosing between real trade-offs and a flat list of equals gives \
them nothing to judge by.
- A description says what the choice CAUSES ("headless scripting becomes \
possible"), not what it restates ("uses the CLI").
- The label is short enough to read at a glance; the detail belongs in the \
description after the ` -- `.
- Do not number the questions and do not add any other text inside this \
section. The person may skip any question, so never make one question's \
wording depend on how another was answered.

AGREEMENT
A markdown pipe table with exactly these columns: `Claim | Agreed | Dissented \
| Silent | Call`. One row per load-bearing claim in the plan -- the decisions \
that actually shape it, not every sentence. Name members in the Agreed, \
Dissented and Silent cells, comma-separated, using their names exactly as they \
appear above; write `--` for an empty cell. `Call` is your one-phrase ruling.

This table is the single most valuable thing this process produces, because it \
is the only place the person can see the DIFFERENCE between a decision every \
member reached independently and one that a single member floated. Never \
collapse it into prose, and never leave a claim out because it was unanimous \
-- unanimity is exactly what the person needs to be able to see. If a member \
did not address a claim at all, they are Silent, not Agreed. If there are \
genuinely no load-bearing claims yet, write "None."

CORRECTIONS
Factual errors caught this round, as bullets: `MEMBER — claimed: <what they \
said> — actually: <the correction>`. Take these from the members' own \
CORRECTIONS sections, and add any you can see yourself. Include a correction \
even when you dropped the claim from the plan anyway -- a wrong claim that is \
silently discarded gets repeated next round by the member who made it, which \
is exactly what this section exists to stop. If there were none, write "None."

READY
YES or NO, then one sentence. Answer YES only when the remaining questions \
would not meaningfully change the plan -- when the person could stop here and \
the plan would still be worth building from. Answer NO while an open question \
could still redirect the work. Answer NO whenever any question you marked \
BLOCKING is still unanswered. This is advice; the person decides when to stop.

Write in plain, direct language. Never mention the council, the members, the \
models, or that you are merging anything -- the person wants the plan and the \
questions, not a report on how they were produced. The one exception is the \
AGREEMENT and CORRECTIONS tables, where naming members is the entire point. \
No preamble and no closing offer of help. Keep the five headings exactly as \
written. No code fences around the whole response, no horizontal rules."""


# The finalise document has a shared frame and a per-task body. The old code
# had one template -- the coding handoff -- and used it for every session, so
# an advice session still had "Files to Touch" to fill in and invented a build
# task to fill it. The frame below is what every document needs regardless of
# task; _FINALIZE_BODIES supplies the middle.

FINALIZE_PROMPT = """You are the chairman of a council of AI models. A person \
has just finished a multi-round session with the council and has decided the \
answer is ready. Your job is to write the handoff document: a single Markdown \
file that will be read by someone -- or something -- with no access to any of \
this conversation.

THE TOPIC
{topic}

THIS SESSION IS A "{task_type}" SESSION.
{task_note}

{ledger}{transcript}
FINAL COUNCIL REVIEW ({responded} of {total} members responded{failure_note})
{responses}

WHAT THE MEMBERS SAID ABOUT EACH OTHER
{critiques}

Write the complete Markdown document and nothing else -- no preamble before it, \
no commentary after it. Use exactly this structure:

# <A short, specific title for the work>

## In plain words
The answer, in language a smart reader with no training in this subject can \
follow. Three to six sentences. Say what to do and why, and nothing else -- no \
jargon, no hedging, no lists. Every sentence under about 30 words.

This section is not a summary and not a simplification: it must say the SAME \
thing as the detail below it, only in plainer words. If the person reads only \
this, they must not come away with a different understanding than if they read \
everything. Where the honest answer is conditional, say the condition in plain \
words rather than dropping it -- "this only works if you already have X" is \
plain; silently omitting X is not.

## Context
Why this came up and what problem it solves, for someone who has never seen \
the session. Two or three short paragraphs.

{body}

## What the council disagreed on
The agreement matrix from the session, as a markdown pipe table with the \
columns `Claim | Agreed | Dissented | Silent | Call`. Carry forward the rows \
built during the rounds, updated for anything settled since.

Keep this even when everything was unanimous -- a reader deciding how much to \
trust this document needs to see the difference between a claim every member \
reached independently and one a single member floated. If a member never \
addressed a claim, they are Silent, not Agreed.

## Corrections made during the session
Factual errors caught and fixed, as bullets: `claimed: <what was said> — \
actually: <the correction>`. Include every correction from the rounds, even \
where the claim never reached the final answer -- a reader checking this \
document benefits from knowing which nearby facts are traps. If there were \
none, write "None."

## Open questions
Anything still genuinely undecided, with what you recommend defaulting to and \
why. If a question was marked blocking and never answered, it goes FIRST here \
and is labelled as blocking.

## Glossary
Every specialist term used anywhere above, one line each: the term, then what \
it means in plain language. If a term appears only once and the document reads \
fine without it, remove the term from the document instead of defining it \
here. If there are no specialist terms, write "None."

Rules:
- Address the person as "you" throughout, not as "the person" or "the user". \
They are the reader. Writing about them in the third person reads like a case \
file about them rather than an answer to them.
- Gloss each specialist term where it first appears, in parentheses, AND list \
it in the Glossary. Keep the precise word -- do not delete precision to \
achieve plainness.
- Never mention the council, the members, the rounds, or this process anywhere \
outside the two sections that name members by design.
- Do not invent decisions the session did not make. Where it is genuinely \
undecided, say so and give a default.
- Every claim in this document must trace to something a member said or the \
person answered. If you find yourself adding a fact from your own knowledge to \
fill a gap, mark it as unverified instead.
- Do not drop a caveat, a risk, or a condition to make the document read more \
smoothly. If a rule has an exception, the exception ships with it.
- Do not wrap the document in a code fence. Fences inside it, for real code or \
schema, are fine.
- Do not add a transcript or appendix section; that is appended automatically."""


# The task-specific middle of the document.
_FINALIZE_BODIES = {
    BUILD: """## Goal
The outcome, stated concretely enough to tell when it has been achieved.

## Decisions & Constraints
The choices locked in during the session, as bullets, each with a brief \
reason. This is what stops the agent re-opening questions you already \
settled. Include the choices you made in your answers and the calls the \
council made on your behalf. Where something was deliberately left open, say \
so and say what to default to.

End each bullet with its provenance in square brackets: `[proposed by \
<member>; dissent: <member or none>; depends on: <which of your answers, or \
"no answer">]`. When one of your answers later turns out to be wrong, this is \
what makes it possible to find exactly which decisions have to be revisited \
instead of re-running the whole session.

## Implementation Steps
Numbered and ordered. Each step says what changes and why it comes where it \
does. Concrete enough to act on -- name the actual components, files, tables, \
endpoints, or functions the session established. Where existing code should be \
reused rather than rewritten, say which.

## Files to Touch
A markdown pipe table: one row per file, a `File` column and a `Change` column \
describing its role in one phrase. Include new files, marked as new.

## Verification
Numbered steps for confirming the work is correct end to end -- what to run, \
what to look at, and what the right result looks like. Include the failure \
cases worth checking, not just the happy path.

Then, under the sub-heading `### Checks on this document itself`, these \
checks, each answered explicitly rather than merely listed:
- Does every decision above trace to one of your answers or to a member's \
stated reasoning? Name any that does not.
- Does anything in this document contradict an answer you gave? Name it or \
write "nothing".
- Does any rule here reference something a later section removed or changed?
- Is any number, threshold, or date stated as fact without a source? List them \
as things to check.
- Is any load-bearing assumption left unstated? State it now.

## Out of Scope
What this deliberately does not cover, so the agent does not wander into it. \
If the session raised something worth doing later, put it here rather than \
dropping it.""",

    ADVICE: """## What we recommend
The recommendation itself, stated directly enough to act on. Lead with the \
answer, not the reasoning.

## Why
The reasoning, as short paragraphs or bullets. Each point says what it is \
based on. Where the council's confidence rests on something you told them, say \
so.

End each recommendation bullet with its provenance in square brackets: \
`[proposed by <member>; dissent: <member or none>; depends on: <which of your \
answers, or "no answer">]`.

## What would change this
The conditions under which this recommendation stops being right, as bullets. \
Be specific and observable -- "if your time horizon drops below two years", \
not "if circumstances change". This is the most useful section for a reader \
whose situation is about to shift.

## How sensitive this is
Which inputs the answer actually turns on, and how much they would have to \
move before the recommendation flips. Where one input dominates, say so \
plainly -- a reader who knows which single number matters most can check that \
one number rather than all of them.

## Facts this depends on
A markdown pipe table with columns `Fact | Status | Check`. Status is \
`verified`, `unverified`, or `changes over time`. Every number, date, \
threshold, rate, and named rule stated anywhere in this document appears as a \
row.

Nothing here was checked against a live source during the session, so almost \
nothing qualifies as `verified` -- mark it honestly. The `Check` column says \
where the reader should confirm it. Anything that changes year to year must \
say so rather than being stated as current fact.

## Out of Scope
What this deliberately does not address, and anything raised that is worth \
returning to later.""",

    RESEARCH: """## What we found
The findings, as short paragraphs or bullets, most important first.

## Claims and confidence
A markdown pipe table with columns `Claim | Confidence | Basis | Check`. One \
row per substantive claim in this document. Confidence is `high`, `medium`, or \
`low`. Basis says what it rests on -- a member's stated knowledge, your own \
answers, or inference. Check says how a reader could confirm it.

No member had access to a live source during this session, so no claim here is \
independently verified. Say that plainly in the table rather than implying \
these were checked. A confident-looking table of unverified claims is worse \
than an honestly hedged one.

## Where the evidence is weakest
The claims most likely to be wrong, and why. Include anything only one member \
raised, anything that depends on a number that changes over time, and anything \
no member could support beyond asserting it.

## What we could not determine
Questions the session could not settle, and what it would take to settle them.

## Out of Scope
What this deliberately does not cover, and anything worth returning to later.""",
}


# The review pass. One extra chairman call over the finished document, doing
# the three checks that have to happen AFTER the whole thing exists: internal
# contradictions, material dropped in synthesis, and readability.
#
# Combined into one call on purpose. The evaluation this implements asked for
# three separate "cheap" passes, but nothing here is cheap: every call is a
# real Chrome launch against a logged-in web UI, ~10s of startup before a
# single token. Three passes would add roughly a minute to every finalise for
# checks that share the same input and produce one edited document either way.
#
# It returns the CORRECTED document rather than a report, because a report the
# person has to apply by hand is a report nobody applies.

REVIEW_PROMPT = """Below is a document that was just written for a person, \
followed by the material it was built from. Your job is to find what is wrong \
with it and return a corrected version.

Make these four checks, in this order.

1. CONTRADICTIONS. Find places where the document disagrees with itself: a \
rule stated in one section and broken in another, a rule that references \
something a later section removed or renamed, a total that does not match its \
parts, or a question raised in the material and never resolved either way. \
Arithmetic is checked, not trusted -- recompute every total and every \
percentage and fix what does not add up.

2. DROPPED MATERIAL. Compare the document against the council material below. \
List anything that two or more members raised, or that any member called \
important, which does not appear in the document. For each one, either fold it \
back in where it belongs, or add a single line to the nearest section saying \
it was considered and why it was dropped. Do not silently leave it out -- \
material lost in synthesis is invisible to the reader, which is what makes it \
dangerous.

3. UNSUPPORTED CLAIMS. Find statements of fact that trace to nothing -- no \
member said them and the person never confirmed them. Numbers, dates, \
thresholds, rates, limits and named rules especially. Do not delete them: mark \
each one as unverified in the document, in the place it appears, so the reader \
knows which facts to check. A confidently stated figure nobody checked is the \
most damaging thing a document like this can contain.

4. READABILITY. The "In plain words" section must be understandable by a smart \
reader with no training in this subject: no undefined specialist term, and no \
sentence longer than about 30 words. Every specialist term used anywhere in \
the document must be glossed where it first appears and listed in the \
Glossary. Every decision's reason must be statable in one sentence -- if you \
cannot, the reason is missing and you should say so rather than inventing one. \
The document must address the reader as "you", never as "the person" or "the \
user".

Hard limits on what you may change:
- Never drop a caveat, condition, risk, exception, or hedge to make the text \
read more smoothly. If a rule has an exception, the exception stays. Softening \
a hard rule is the standard way this kind of pass makes a document worse, and \
it is worse than leaving the text alone.
- Never change a recommendation, a decision, or a number to something else. \
You are fixing contradictions and clarity, not re-deciding the content. If you \
think a decision is wrong, leave it and note it under Open questions.
- Never remove a section required by the document's structure, and never \
delete the tables.
- Where you make plain words out of jargon, keep the precise term too and \
gloss it. Plainness is achieved by adding an explanation, not by removing \
precision.

THE DOCUMENT
{document}

THE COUNCIL MATERIAL IT CAME FROM
{material}

Return the corrected document in full as Markdown, and nothing else -- no \
preamble, no list of what you changed, no commentary after it. If you found \
nothing to fix, return the document unchanged. Do not wrap it in a code \
fence."""


def build_review_prompt(document: str, turns: list[dict], answers: list[Answer]) -> str:
    """The review pass over a finished document."""
    responses, _note, _r, _t = _response_blocks(answers)
    material = "\n\n".join(
        part for part in (_build_transcript(turns).strip(), responses) if part.strip()
    )
    return REVIEW_PROMPT.format(
        document=(document or "").strip(),
        material=material or "(No council material available.)",
    )


# A review that returns far less than it was given has not reviewed the
# document, it has replaced it -- a summary, a refusal, or a truncated capture.
# The document is the thing the person is about to keep, so a suspicious review
# is discarded in favour of the original rather than trusted.
REVIEW_MIN_RATIO = 0.6


def accept_review(original: str, reviewed: str) -> tuple[str, bool, str]:
    """Whether to keep a reviewed document. Returns (text, accepted, reason).

    Guards the failure mode this pass would otherwise introduce: the reviewer
    is a language model told to make a document clearer, and the cheapest way
    to make text clearer is to make it shorter. Losing the caveats is exactly
    what the prompt forbids, so the length floor enforces what the instruction
    only asks for -- the same instruct-then-enforce shape as cap_confidence.
    """
    orig = (original or "").strip()
    rev = (reviewed or "").strip()
    if not rev:
        return orig, False, "the review pass returned nothing"
    if not orig:
        return rev, True, ""
    ratio = len(rev) / len(orig)
    if ratio < REVIEW_MIN_RATIO:
        return orig, False, (
            f"the review pass returned {int(ratio * 100)}% of the original "
            "length, which means content was dropped rather than corrected"
        )
    return rev, True, ""


# ── transcript assembly ─────────────────────────────────────────────────────

# The transcript is replayed into a chat composer every round, so it cannot
# grow without bound. Past ~12k the paste starts to be a problem for the site's
# own composer long before it is a problem for the model's context.
MAX_TRANSCRIPT_CHARS = 12_000

# How many rounds of questions/splits to keep verbatim. The plan draft is
# cumulative -- each round rewrites it in full -- so old drafts carry nothing
# the latest one does not. Questions are different: they are the record of what
# the user was actually asked, which is what stops the council re-asking.
KEEP_QUESTION_ROUNDS = 2


def question_text(q) -> str:
    """The question's wording, whether it is a dict or a legacy plain string.

    Rounds recorded before questions became structured are still in the
    database and still have to render, so every read of a question goes
    through here rather than assuming a shape.
    """
    if isinstance(q, dict):
        return (q.get("q") or "").strip()
    return str(q or "").strip()


def _latest_attempts(turns: list[dict]) -> list[dict]:
    """Only the newest attempt at each round.

    Everything is retained in the database; this is about what the council is
    shown. A superseded attempt is real history but stale context.
    """
    best: dict[int, int] = {}
    for t in turns:
        rn = t.get("round_no", 0)
        at = t.get("attempt") or 1
        if at > best.get(rn, 0):
            best[rn] = at
    return [t for t in turns if (t.get("attempt") or 1) == best.get(t.get("round_no", 0), 1)]


def _build_transcript(turns: list[dict]) -> str:
    """Compose prior rounds into the block both prompts embed.

    Deliberately asymmetric about what it keeps. The user's own replies are
    never summarised or dropped -- they are the whole point of the session, and
    a council that forgets an answer will ask for it again. Everything else is
    reconstructable from the latest plan draft.

    Superseded attempts are excluded. A round that failed and was retried is
    kept in the database (see `attempt`), but replaying a failed attempt's
    questions here would have the council answering a round that was already
    redone -- history keeps it, the prompt does not.
    """
    if not turns:
        return ""

    turns = _latest_attempts(turns)

    chairman_rounds: list[tuple[int, dict]] = []
    user_replies: list[tuple[int, str]] = []

    for t in turns:
        if t.get("role") == "chairman" and t.get("parsed_json"):
            try:
                parsed = json.loads(t["parsed_json"])
            except (TypeError, ValueError):
                continue
            # The finalise turn holds the finished plan, not a round merge.
            if parsed.get("kind") == "plan":
                continue
            chairman_rounds.append((t["round_no"], parsed))
        elif t.get("role") == "user" and (t.get("content") or "").strip():
            user_replies.append((t["round_no"], t["content"].strip()))

    parts: list[str] = []

    if chairman_rounds:
        latest_round, latest = chairman_rounds[-1]
        draft = (latest.get("plan_so_far") or "").strip()
        if draft:
            parts.append(f"THE PLAN SO FAR (as of round {latest_round})\n{draft}")

    # Oldest first so trimming can drop from the front: the earliest exchanges
    # are the ones the latest draft has most thoroughly absorbed.
    exchanges: list[str] = []
    recent = chairman_rounds[-KEEP_QUESTION_ROUNDS:] if chairman_rounds else []
    replies_by_round = dict(user_replies)

    for round_no, parsed in recent:
        block = [f"--- round {round_no} ---"]
        questions = parsed.get("questions") or []
        if questions:
            block.append("Asked:")
            block.extend(
                f"  {i}. {question_text(q)}" for i, q in enumerate(questions, 1)
            )
        split = (parsed.get("council_split") or "").strip()
        if split and split.lower().rstrip(".") != "none":
            block.append(f"Council was split on:\n{split}")
        # The reply to round N's questions arrives as round N+1's user turn.
        reply = replies_by_round.get(round_no + 1)
        if reply:
            block.append(f"The person answered:\n{reply}")
        exchanges.append("\n".join(block))

    # Any reply not already shown above still has to reach the council -- an
    # answer the user typed must never silently vanish because its round fell
    # outside the questions window.
    shown_rounds = {r + 1 for r, _ in recent}
    older = [(r, txt) for r, txt in user_replies if r not in shown_rounds]
    if older:
        earlier = ["EARLIER ANSWERS FROM THE PERSON"]
        earlier.extend(f"  (round {r}) {txt}" for r, txt in older)
        parts.append("\n".join(earlier))

    if exchanges:
        parts.append("RECENT EXCHANGES\n" + "\n\n".join(exchanges))

    out = "\n\n".join(p for p in parts if p.strip())

    # Trim from the front of the exchanges, never from the plan draft or the
    # user's answers -- losing either would change what the council is working
    # from, while losing an old question only risks it being asked twice.
    while len(out) > MAX_TRANSCRIPT_CHARS and exchanges:
        exchanges.pop(0)
        rebuilt = [p for p in parts if not p.startswith("RECENT EXCHANGES")]
        if exchanges:
            rebuilt.append("RECENT EXCHANGES\n" + "\n\n".join(exchanges))
        out = "\n\n".join(p for p in rebuilt if p.strip())

    if len(out) > MAX_TRANSCRIPT_CHARS:
        out = out[:MAX_TRANSCRIPT_CHARS].rsplit("\n", 1)[0] + "\n[earlier detail trimmed]"

    return out + "\n\n" if out else ""


# ── answered-facts ledger ───────────────────────────────────────────────────

# Both prompts already tell the council never to re-ask an answered question,
# and both were observed re-asking one anyway -- the same question landed in
# three consecutive rounds of one session. Instruction is not enforcement, so
# the ledger is both: the answered set is stated in the prompt AND matching
# questions are dropped from the parsed round afterwards.
#
# This mirrors how the rest of the engine treats guarantees. `cap_confidence`
# instructs the chairman not to write HIGH and then rewrites it if it does;
# `validate` re-checks the capture the completion detector already approved.

_STOPWORDS = frozenset(
    """a an the is are was were do does did should would could can will shall
    what which who whom whose when where why how of for to from in on at by
    with without about into over under this that these those it its as if then
    than or and but not no yes you your we our i my me be been being have has
    had there here any some most more much many one two both each per""".split()
)

# A reply line the user never actually filled in. `format_reply` writes these
# for skipped questions, and a skipped question is NOT an answered one -- it
# means "you decide", so the question is settled but carries no fact.
_UNANSWERED_MARK = "(not answered"


def _keywords(text: str) -> frozenset[str]:
    """Content words of a question, for comparing two questions' subjects."""
    words = re.sub(r"[^a-z0-9 ]+", " ", (text or "").lower()).split()
    return frozenset(w for w in words if len(w) > 2 and w not in _STOPWORDS)


def _same_question(a: str, b: str) -> bool:
    """Whether two questions are asking the same thing.

    Jaccard overlap on content words. Deliberately blunt: the cost of a false
    positive is one dropped question the council can re-ask next round, while
    the cost of a false negative is the behaviour this exists to stop. The
    threshold is high enough that merely sharing a topic is not enough --
    "which database?" and "which database migration tool?" stay distinct.
    """
    ka, kb = _keywords(a), _keywords(b)
    if not ka or not kb:
        return False
    overlap = len(ka & kb) / len(ka | kb)
    return overlap >= 0.6


def answered_questions(turns: list[dict]) -> list[tuple[str, str]]:
    """Every question the person actually answered, as (question, answer).

    Read back out of the user reply turns, which `format_reply` wrote in a
    fixed shape: the question on one line, the answer on the next after `->`.
    Skipped questions are excluded -- they were asked and declined, which the
    council still needs to not re-ask, but they carry no fact to state.
    """
    out: list[tuple[str, str]] = []
    for t in _latest_attempts(turns):
        if t.get("role") != "user":
            continue
        lines = (t.get("content") or "").splitlines()
        for i, line in enumerate(lines):
            m = re.match(r"^\s*\d+\.\s+(.*\S)\s*$", line)
            if not m:
                continue
            question = m.group(1).strip()
            nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
            if not nxt.startswith("->"):
                continue
            answer = nxt[2:].strip()
            if not answer or answer.startswith(_UNANSWERED_MARK):
                continue
            out.append((question, answer))
    return out


def asked_questions(turns: list[dict]) -> list[str]:
    """Every question already PUT to the person, answered or not.

    Broader than `answered_questions` on purpose: a question the person
    deliberately skipped must not come back either. Skipping is an answer --
    it says "decide this yourself".
    """
    out: list[str] = []
    for t in _latest_attempts(turns):
        if t.get("role") != "chairman" or not t.get("parsed_json"):
            continue
        try:
            parsed = json.loads(t["parsed_json"])
        except (TypeError, ValueError):
            continue
        if parsed.get("kind") == "plan":
            continue
        for q in parsed.get("questions") or []:
            text = question_text(q)
            if text:
                out.append(text)
    return out


def build_ledger_block(turns: list[dict]) -> str:
    """The ALREADY ANSWERED block injected into every prompt."""
    answered = answered_questions(turns)
    asked = asked_questions(turns)
    if not answered and not asked:
        return ""

    lines = ["ALREADY SETTLED -- DO NOT ASK ANY OF THESE AGAIN"]
    if answered:
        lines.append("Answered by the person:")
        for q, a in answered:
            lines.append(f"  - {q}  ->  {a}")

    answered_texts = {q for q, _ in answered}
    skipped = [
        q for q in asked
        if not any(_same_question(q, aq) for aq in answered_texts)
    ]
    if skipped:
        lines.append(
            "Asked and deliberately skipped (the person wants YOU to decide "
            "these -- make the call and say what you decided):"
        )
        lines.extend(f"  - {q}" for q in skipped)

    return "\n".join(lines) + "\n\n"


def drop_answered_questions(
    questions: list[dict], turns: list[dict]
) -> tuple[list[dict], list[str]]:
    """Remove questions the transcript already covers.

    Returns the kept questions and the dropped wording, so the caller can log
    what was suppressed rather than have it vanish -- a silently dropped
    question and a question that was never asked look identical otherwise.
    """
    prior = [q for q, _ in answered_questions(turns)] + asked_questions(turns)
    if not prior:
        return questions, []

    kept: list[dict] = []
    dropped: list[str] = []
    for q in questions:
        text = question_text(q)
        if text and any(_same_question(text, p) for p in prior):
            dropped.append(text)
        else:
            kept.append(q)
    return kept, dropped


# What each task type tells the council about the document it is working toward.
_TASK_NOTES = {
    BUILD: (
        "The output will be a build brief handed to a coding agent, so aim at "
        "concrete technical choices: components, files, data shapes, and the "
        "order the work happens in."
    ),
    ADVICE: (
        "The person wants a DECISION they can act on, not software. Do not "
        "propose building anything unless they asked for it. Aim at the "
        "recommendation, the reasoning behind it, what would have to be true "
        "for it to be wrong, and which facts it depends on."
    ),
    RESEARCH: (
        "The person wants to UNDERSTAND something, not build it. Aim at "
        "claims and the evidence for them. Mark clearly which of your "
        "statements are things you know, and which you are inferring or "
        "would need to check -- an unmarked guess is the failure mode here."
    ),
}


def corrections_block(turns: list[dict], provider_id: str) -> str:
    """What THIS member was corrected on previously, replayed to it.

    A claim rejected as false used to be dropped from the plan and nowhere
    else -- so the member that made it never learned, and repeated it the next
    round. Injecting its own corrections back into its prompt is what closes
    that loop. Scoped to one member deliberately: showing everyone every
    correction would just be noise, and the member that made the claim is the
    only one that can stop making it.
    """
    hits: list[dict] = []
    for t in _latest_attempts(turns):
        if t.get("role") != "chairman" or not t.get("parsed_json"):
            continue
        try:
            parsed = json.loads(t["parsed_json"])
        except (TypeError, ValueError):
            continue
        for corr in parsed.get("corrections") or []:
            who = (corr.get("who") or "").strip().lower()
            # Matched loosely: the chairman writes display names ("Balthasar")
            # while turns carry provider ids ("claude"), and either may be
            # what ends up in the correction line.
            if who and (who in provider_id.lower() or provider_id.lower() in who):
                hits.append(corr)

    if not hits:
        return ""

    lines = [
        "CORRECTIONS TO YOUR OWN EARLIER CLAIMS",
        "You stated these previously and they were found to be wrong. Do not "
        "repeat them, and do not build on them.",
    ]
    for c in hits:
        lines.append(
            f"  - you claimed: {c.get('claim')}  ->  actually: {c.get('correction')}"
        )
    return "\n".join(lines) + "\n\n"


def build_member_prompt(
    topic: str,
    turns: list[dict],
    round_no: int,
    *,
    provider_id: str = "",
) -> str:
    task = classify_topic(topic)
    prompt = MEMBER_ROUND_PROMPT.format(
        topic=topic.strip(),
        task_type=task,
        task_note=_TASK_NOTES.get(task, _TASK_NOTES[BUILD]),
        corrections=corrections_block(turns, provider_id) if provider_id else "",
        ledger=build_ledger_block(turns),
        transcript=_build_transcript(turns),
        round_no=round_no,
    )
    if is_sensitive(topic):
        prompt += GUARDRAIL
    return prompt


def build_critique_prompt(
    topic: str, turns: list[dict], answers: list[Answer], me: str
) -> str:
    """The critique prompt shown to one member, naming which proposal is its own.

    Every member sees the same proposals verbatim; only `me` differs, so each
    one knows which bullet not to write an objection to itself about.
    """
    responses, _note, _r, _t = _response_blocks(answers)
    prompt = MEMBER_CRITIQUE_PROMPT.format(
        topic=topic.strip(),
        transcript=_build_transcript(turns),
        responses=responses,
        me=me,
    )
    if is_sensitive(topic):
        prompt += GUARDRAIL
    return prompt


_CRITIQUE_HEADINGS = ("OBJECTIONS", "CORRECTIONS", "CONCEDE")

_CRITIQUE_HEADING_RE = re.compile(
    r"^[ \t]*(?:\*\*|##+\s*)?(" + "|".join(_CRITIQUE_HEADINGS) + r")(?:\*\*)?[ \t]*:?[ \t]*$",
    re.IGNORECASE | re.MULTILINE,
)

# `MEMBER — claimed: X — actually: Y`, tolerating the dash the model chose and
# the bullet marker it was told not to add.
_CORRECTION_RE = re.compile(
    r"^[ \t]*(?:[-*\u2022]|\d+[.)])?[ \t]*\**(?P<who>[^\u2014\u2013:*-]{1,40}?)\**[ \t]*"
    r"[\u2014\u2013-]+[ \t]*claimed[ \t]*:[ \t]*(?P<claim>.+?)[ \t]*"
    r"[\u2014\u2013-]+[ \t]*actually[ \t]*:[ \t]*(?P<fix>.+?)[ \t]*$",
    re.IGNORECASE | re.MULTILINE,
)


def parse_critique(raw_text: str) -> dict:
    """One member's critique text -> its three sections.

    Never raises, for the same reason `parse_round` does not: a critique costs
    a real browser round-trip, so a parse miss degrades to keeping the raw
    text rather than throwing the round away.
    """
    result = {
        "objections": "",
        "corrections": [],
        "corrections_text": "",
        "concede": "",
        "parsed": False,
    }
    try:
        raw = raw_text or ""
        sections: dict[str, str] = {}
        matches = list(_CRITIQUE_HEADING_RE.finditer(raw))
        for i, m in enumerate(matches):
            end = matches[i + 1].start() if i + 1 < len(matches) else len(raw)
            sections[m.group(1).upper()] = raw[m.end():end].strip()
        if not sections:
            return result

        result["objections"] = sections.get("OBJECTIONS", "").strip()

        corr = sections.get("CORRECTIONS", "").strip()
        result["corrections_text"] = "" if corr.lower().rstrip(".") == "none" else corr
        for m in _CORRECTION_RE.finditer(result["corrections_text"]):
            result["corrections"].append(
                {
                    "who": m.group("who").strip(),
                    "claim": m.group("claim").strip(),
                    "correction": m.group("fix").strip(),
                }
            )

        concede = sections.get("CONCEDE", "").strip()
        result["concede"] = (
            "" if concede.lower().rstrip(".") in ("nothing", "none") else concede
        )
        result["parsed"] = bool(result["objections"] or result["corrections_text"])
    except Exception:
        return result
    return result


def critique_blocks(critiques: list[dict]) -> str:
    """Every member's critique, shaped for the chairman prompt."""
    blocks = []
    for c in critiques:
        body = (c.get("raw") or "").strip()
        if not body:
            continue
        blocks.append(f"--- {c.get('display_name') or c.get('provider_id')} ---\n{body}")
    return "\n\n".join(blocks)


def collect_corrections(critiques: list[dict]) -> list[dict]:
    """Every factual correction any member raised this round, flattened.

    Carries the accuser's name so the transcript can show who challenged what,
    and so a member's own next-round prompt can be told what it got wrong --
    the mechanism that stops a bad claim recurring round after round.
    """
    out: list[dict] = []
    for c in critiques:
        parsed = c.get("parsed") or {}
        for corr in parsed.get("corrections") or []:
            out.append({**corr, "raised_by": c.get("display_name") or c.get("provider_id")})
    return out


def _response_blocks(answers: list[Answer]) -> tuple[str, str, int, int]:
    """Shared shaping of member answers. Mirrors chairman.build_prompt."""
    ok = [a for a in answers if a.ok and a.text.strip()]
    degraded = [a for a in answers if a.degraded]
    failed = [a for a in answers if not a.ok and not a.degraded]

    blocks = []
    for a in ok:
        caveat = "  [note: this response may be truncated]" if a.low_confidence else ""
        blocks.append(f"--- {a.display_name}{caveat} ---\n{a.text.strip()}")

    note = ""
    if failed:
        names = ", ".join(f"{a.display_name} ({a.failure})" for a in failed)
        note = f"; did not respond: {names}"
    if degraded:
        names = ", ".join(a.display_name for a in degraded)
        note += f"; excluded for an unusable response: {names}"

    return "\n\n".join(blocks), note, len(ok), len(answers)


def build_chairman_prompt(
    topic: str,
    turns: list[dict],
    answers: list[Answer],
    critiques: list[dict] | None = None,
) -> str:
    responses, note, responded, total = _response_blocks(answers)
    task = classify_topic(topic)
    blocks = critique_blocks(critiques or [])
    prompt = CHAIRMAN_ROUND_PROMPT.format(
        topic=topic.strip(),
        task_type=task,
        task_note=_TASK_NOTES.get(task, _TASK_NOTES[BUILD]),
        ledger=build_ledger_block(turns),
        transcript=_build_transcript(turns),
        responded=responded,
        total=total,
        failure_note=note,
        responses=responses,
        critiques=blocks or "(No critiques were returned this round.)",
    )
    if is_sensitive(topic):
        prompt += GUARDRAIL
    return prompt


def unanswered_blocking(turns: list[dict]) -> list[str]:
    """Blocking questions from the latest round that were never answered.

    Read from the newest chairman round only: an earlier round's blocking
    question that a later round stopped asking was resolved or withdrawn, and
    treating it as still-open would block the person forever.
    """
    rounds: list[dict] = []
    for t in _latest_attempts(turns):
        if t.get("role") != "chairman" or not t.get("parsed_json"):
            continue
        try:
            parsed = json.loads(t["parsed_json"])
        except (TypeError, ValueError):
            continue
        if parsed.get("kind") == "plan":
            continue
        rounds.append(parsed)
    if not rounds:
        return []

    blocking = [
        question_text(q) for q in (rounds[-1].get("questions") or []) if q.get("blocking")
    ]
    if not blocking:
        return []

    answered = [q for q, _ in answered_questions(turns)]
    return [b for b in blocking if not any(_same_question(b, a) for a in answered)]


def build_finalize_prompt(
    topic: str,
    turns: list[dict],
    answers: list[Answer],
    critiques: list[dict] | None = None,
) -> str:
    responses, note, responded, total = _response_blocks(answers)
    task = classify_topic(topic)
    blocks = critique_blocks(critiques or [])

    prompt = FINALIZE_PROMPT.format(
        topic=topic.strip(),
        task_type=task,
        task_note=_TASK_NOTES.get(task, _TASK_NOTES[BUILD]),
        ledger=build_ledger_block(turns),
        transcript=_build_transcript(turns),
        responded=responded,
        total=total,
        failure_note=note,
        responses=responses,
        critiques=blocks or "(No critiques were returned in the final round.)",
        body=_FINALIZE_BODIES.get(task, _FINALIZE_BODIES[BUILD]),
    )

    # A plan finalised over an unanswered blocking question is the failure this
    # exists to stop -- the session that shipped "unresolved: default to
    # long-term" for the variable that decided the whole answer. The person is
    # still allowed to finalise; what changes is that the document has to say
    # so at the top instead of burying it.
    still_blocking = unanswered_blocking(turns)
    if still_blocking:
        listed = "\n".join(f"  - {q}" for q in still_blocking)
        prompt += (
            "\n\nTHIS DOCUMENT IS PROVISIONAL.\n"
            "These questions were marked as changing the SHAPE of the answer, "
            "and were never answered:\n" + listed + "\n"
            "You must therefore:\n"
            "- Title the document with the suffix ` (provisional)`.\n"
            "- Immediately under the title, before In plain words, add a line "
            "in bold beginning `**Provisional — blocked on:**` naming each "
            "question above.\n"
            "- For each one, state in that same block what you have assumed "
            "instead, and say plainly that the answer changes if the "
            "assumption is wrong. State the assumption at the TOP, not only in "
            "Open questions -- burying it is what makes a provisional document "
            "read as a finished one."
        )

    if is_sensitive(topic):
        prompt += GUARDRAIL
    return prompt


# ── parsing ─────────────────────────────────────────────────────────────────

# COUNCIL SPLIT is retained purely as a legacy heading: rounds recorded before
# the agreement matrix existed still have to render, and a stored round is not
# re-generatable -- the browser session that produced it is long gone.
_HEADINGS = (
    "PLAN SO FAR",
    "QUESTIONS",
    "AGREEMENT",
    "CORRECTIONS",
    "COUNCIL SPLIT",
    "READY",
)

# Headings must sit alone on a line. Models sometimes bold them or add a colon,
# so both are tolerated -- but a mention of "QUESTIONS" mid-sentence is not a
# heading and must not split the document.
_HEADING_RE = re.compile(
    r"^[ \t]*(?:\*\*|##+\s*)?(" + "|".join(_HEADINGS) + r")(?:\*\*)?[ \t]*:?[ \t]*$",
    re.IGNORECASE | re.MULTILINE,
)

_NUMBERED = re.compile(r"^[ \t]*(?:\d+[.)]|[-*•])[ \t]+(.*)$")

# Field lines inside a question block. Leading markers (a stray "1." or bullet
# the model added despite being told not to) and bold are tolerated, because
# the alternative is discarding a question over punctuation.
_FIELD = re.compile(
    r"^[ \t]*(?:\d+[.)]|[-*•])?[ \t]*\**[ \t]*"
    r"(Q|QUESTION|HEADER|KIND|BLOCKING|OPTION)\**[ \t]*:[ \t]*(.*)$",
    re.IGNORECASE,
)

# Label and description within an OPTION line. Tried in order, not as one
# alternation: the prompt asks for ` -- `, so a label that itself contains a
# colon or a hyphen ("Gated: wait for review -- Safer") must still split on the
# real separator. A single regex would match whichever came first in the
# string and silently cut the label in half.
_OPT_SEPARATORS = (
    re.compile(r"\s+--\s+"),
    re.compile(r"\s*—\s*"),
    re.compile(r"\s+–\s+"),
    re.compile(r"\s+-\s+"),
    re.compile(r"\s*:\s+"),
)

MAX_OPTIONS = 4
MIN_OPTIONS = 2
HEADER_MAX = 14


def _split_sections(raw: str) -> dict[str, str]:
    out: dict[str, str] = {}
    matches = list(_HEADING_RE.finditer(raw))
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(raw)
        out[m.group(1).upper()] = raw[m.end():end].strip()
    return out


def _derive_header(question: str) -> str:
    """A chip label from the question itself, for when HEADER is missing.

    The chip is an identifier, not a summary, so the first few words are as
    good as anything -- and always better than a blank chip.
    """
    words = re.sub(r"[^A-Za-z0-9 ]+", " ", question or "").split()
    out = ""
    for w in words:
        if out and len(out) + 1 + len(w) > HEADER_MAX:
            break
        out = f"{out} {w}".strip()
    return out or "Question"


def _parse_option(text: str) -> dict | None:
    text = text.strip()
    label, desc = text, ""
    for sep in _OPT_SEPARATORS:
        parts = sep.split(text, maxsplit=1)
        if len(parts) > 1 and parts[0].strip():
            label, desc = parts[0], parts[1]
            break
    label = label.strip().strip("*").strip()
    if not label:
        return None
    return {"label": label, "description": desc.strip()}


def _normalise_question(q: dict) -> dict | None:
    text = (q.get("q") or "").strip()
    if not text:
        return None
    options = q.get("options") or []
    # More than four is a runaway list; the reference interaction tops out at
    # four and a longer one stops being scannable.
    options = options[:MAX_OPTIONS]
    # A single option is not a choice. Whatever the model declared, one option
    # renders better as a text box than as a card with nothing to pick between.
    kind = "choice" if len(options) >= MIN_OPTIONS else "open"
    if kind == "open":
        options = []
    header = (q.get("header") or "").strip().strip("*")[:HEADER_MAX].strip()
    return {
        "q": text,
        "header": header or _derive_header(text),
        "kind": kind,
        "blocking": bool(q.get("blocking")),
        "options": options,
    }


def _parse_legacy_questions(block: str) -> list[dict]:
    """The old numbered/bulleted list, as open questions.

    Kept because it is the fallback for two real cases: a chairman that ignores
    the block format, and every session recorded before the format existed.
    """
    questions: list[str] = []
    for line in block.splitlines():
        m = _NUMBERED.match(line)
        if m:
            text = m.group(1).strip()
            if text:
                questions.append(text)
        elif questions and line.strip():
            # A wrapped question continues the one above rather than starting
            # a new item.
            questions[-1] += " " + line.strip()
    if not questions:
        questions = [ln.strip() for ln in block.splitlines() if ln.strip()]
    out = []
    for text in questions:
        norm = _normalise_question({"q": text})
        if norm:
            out.append(norm)
    return out


def _parse_questions(block: str) -> list[dict]:
    """QUESTIONS block -> structured questions.

    Returns dicts of {q, header, kind, options}. Falls back to the old
    numbered-list form when no `Q:` lines are present, so a chairman that
    ignores the block format still produces usable questions rather than none.
    """
    if not block or block.strip().lower().rstrip(".") == "none":
        return []

    raw: list[dict] = []
    current: dict | None = None

    for line in block.splitlines():
        m = _FIELD.match(line)
        if not m:
            # A continuation of the question text, wrapped across lines.
            if current and line.strip() and not current.get("options"):
                current["q"] = (current.get("q", "") + " " + line.strip()).strip()
            continue
        field, value = m.group(1).upper(), m.group(2).strip()
        if field in ("Q", "QUESTION"):
            if current:
                raw.append(current)
            current = {
                "q": value, "header": "", "kind": "",
                "blocking": False, "options": [],
            }
        elif current is None:
            continue  # a field before any Q: has nothing to attach to
        elif field == "HEADER":
            current["header"] = value
        elif field == "KIND":
            current["kind"] = value.lower()
        elif field == "BLOCKING":
            current["blocking"] = value.strip().lower() in (
                "yes", "y", "true", "blocking",
            )
        elif field == "OPTION":
            opt = _parse_option(value)
            if opt:
                current["options"].append(opt)
    if current:
        raw.append(current)

    if not raw:
        return _parse_legacy_questions(block)

    out: list[dict] = []
    for q in raw:
        norm = _normalise_question(q)
        if norm:
            out.append(norm)
    return out


def parse_round(raw_text: str) -> dict:
    """Chairman round text -> the structured round result.

    Never raises. A round costs the user minutes of real browser time, so a
    parse miss degrades to "show the text plainly" rather than discarding it:
    `raw_text` is always present, and `parsed` says whether the structure was
    found. The frontend renders the raw text whenever `parsed` is false.
    """
    result = {
        "plan_so_far": "",
        "questions": [],
        "agreement": "",
        "corrections": [],
        "corrections_text": "",
        "council_split": "",
        "blocking": [],
        "ready": False,
        "ready_note": "",
        "parsed": False,
    }
    try:
        sections = _split_sections(raw_text or "")
        if not sections:
            return result

        result["plan_so_far"] = sections.get("PLAN SO FAR", "").strip()
        result["questions"] = _parse_questions(sections.get("QUESTIONS", ""))

        agreement = sections.get("AGREEMENT", "").strip()
        result["agreement"] = "" if agreement.lower().rstrip(".") == "none" else agreement

        corr = sections.get("CORRECTIONS", "").strip()
        result["corrections_text"] = "" if corr.lower().rstrip(".") == "none" else corr
        for m in _CORRECTION_RE.finditer(result["corrections_text"]):
            result["corrections"].append(
                {
                    "who": m.group("who").strip(),
                    "claim": m.group("claim").strip(),
                    "correction": m.group("fix").strip(),
                }
            )

        # Legacy rounds carry COUNCIL SPLIT instead of AGREEMENT. Keep it so
        # stored sessions still render, and fall back to it for the matrix so
        # an old round is not shown as having no disagreement at all.
        split = sections.get("COUNCIL SPLIT", "").strip()
        result["council_split"] = "" if split.lower().rstrip(".") == "none" else split
        if not result["agreement"]:
            result["agreement"] = result["council_split"]

        result["blocking"] = [
            question_text(q) for q in result["questions"] if q.get("blocking")
        ]

        ready_block = sections.get("READY", "").strip()
        # "YES" must be the verdict, not a word inside the justification --
        # match only at the start, where the contract puts it.
        result["ready"] = bool(re.match(r"^\**\s*YES\b", ready_block, re.IGNORECASE))
        result["ready_note"] = re.sub(
            r"^\**\s*(?:YES|NO)\b[\s.,:;-]*", "", ready_block, count=1, flags=re.IGNORECASE
        ).strip()

        # A blocking question that is still open contradicts READY: YES. The
        # chairman is told this, and it is enforced here too, because "ready"
        # drives what the person is invited to do next and an instruction is
        # not a guarantee. Same instruct-then-enforce shape as cap_confidence.
        if result["ready"] and result["blocking"]:
            result["ready"] = False
            result["ready_note"] = (
                "Not ready: "
                + str(len(result["blocking"]))
                + " question(s) still open whose answer changes the shape of "
                "the plan. " + result["ready_note"]
            ).strip()

        # A round is only usefully "parsed" if the plan draft came through;
        # questions can legitimately be empty once the council is done asking.
        result["parsed"] = bool(result["plan_so_far"])
    except Exception:
        return result
    return result


# ── answers ─────────────────────────────────────────────────────────────────

def format_reply(questions: list, answers: list | None, notes: str = "") -> str:
    """Structured answers -> the prose the council actually reads.

    The council only ever sees a text prompt, so the question/answer mapping
    the cards captured has to be written back out. Two properties matter:

      * Every question appears, answered or not. A skipped question stated as
        skipped is information -- it says "decide this yourself" -- while a
        silently omitted one is indistinguishable from one the person never
        saw, and gets asked again next round.

      * The person's own words are never paraphrased. An Other answer or an
        open question goes through verbatim.
    """
    questions = questions or []
    by_index: dict[int, dict] = {}
    for a in answers or []:
        if isinstance(a, dict) and isinstance(a.get("index"), int):
            by_index[a["index"]] = a

    lines: list[str] = []
    answered_any = False
    shown = 0

    for i, q in enumerate(questions):
        text = question_text(q)
        if not text:
            continue
        entry = by_index.get(i) or {}
        # An explicit Other/open response wins over a selected label: it is the
        # person's own wording, which is always more specific than a chip.
        other = (entry.get("other") or "").strip()
        value = (entry.get("value") or "").strip()
        chosen = other or value

        shown += 1
        lines.append(f"{shown}. {text}")
        if chosen:
            answered_any = True
            lines.append(f"   -> {chosen}")
        else:
            lines.append("   -> (not answered -- decide this one yourself)")

    out: list[str] = []
    if lines:
        out.append("ANSWERS FROM THE PERSON")
        out.extend(lines)
        if not answered_any:
            out.append(
                "\n(The person skipped every question. Do not simply re-ask "
                "them -- make the calls yourself and say what you decided.)"
            )

    notes = (notes or "").strip()
    # With no questions to attach them to, the notes ARE the reply -- passing
    # them through bare is exactly the old free-text behaviour, and what a
    # legacy client (or a round whose questions failed to parse) still sends.
    if not out:
        return notes
    if notes:
        out += ["", "ALSO FROM THE PERSON", notes]

    return "\n".join(out).strip()


# ── plan file ───────────────────────────────────────────────────────────────

_SLUG_STRIP = re.compile(r"[^a-z0-9]+")


def slugify(topic: str, *, max_len: int = 48) -> str:
    slug = _SLUG_STRIP.sub("-", (topic or "").lower()).strip("-")
    if len(slug) > max_len:
        slug = slug[:max_len].rsplit("-", 1)[0] or slug[:max_len]
    return slug or "plan"


def plan_filename(topic: str) -> str:
    return f"{date.today().isoformat()}-{slugify(topic)}.md"


def _question_lines(questions: list) -> list[str]:
    """Questions with their options, so the choices offered are recorded too.

    What the person was NOT offered is part of why they answered as they did,
    and an appendix that shows only the question loses it.
    """
    out: list[str] = []
    for i, q in enumerate(questions, 1):
        out.append(f"{i}. {question_text(q)}")
        if isinstance(q, dict):
            for o in q.get("options") or []:
                label = (o or {}).get("label") if isinstance(o, dict) else str(o)
                desc = (o or {}).get("description", "") if isinstance(o, dict) else ""
                if label:
                    out.append(f"   - {label}{f' — {desc}' if desc else ''}")
    return out


def build_transcript_appendix(turns: list[dict]) -> str:
    """The complete session record appended to the plan file.

    The Decisions section records what was decided; this records everything
    that produced it -- every question with its options, every answer the
    person gave, and what each council member actually said, verbatim.

    It is deliberately exhaustive. The plan above it is the readable brief;
    this is the evidence, folded into <details> so it does not compete with
    the brief for the reader's attention but is never lost either.
    """
    # Keyed by phase as well as round/attempt. The finalise pass reuses the
    # round number it was launched from, so keying on (round, attempt) alone
    # put the round's user reply and the finalise reply in the SAME entry --
    # and `entry["user"] = ...` below silently overwrote the first. That lost
    # a real answer from a document whose summary promises "every answer
    # given", which is exactly the claim this appendix has to keep.
    rounds: dict[tuple[int, int, str], dict] = {}

    for t in turns:
        phase = t.get("phase") or "round"
        key = (t.get("round_no", 0), t.get("attempt") or 1, phase)
        entry = rounds.setdefault(key, {"council": [], "phase": phase})
        role = t.get("role")
        if role == "chairman" and t.get("parsed_json"):
            try:
                parsed = json.loads(t["parsed_json"])
            except (TypeError, ValueError):
                continue
            if parsed.get("kind") == "plan":
                # The finished plan is the document this appendix hangs off;
                # repeating it whole inside itself helps nobody.
                entry["plan"] = True
                continue
            entry["chairman"] = parsed
            entry["chairman_by"] = t.get("provider_id")
        elif role == "user" and (t.get("content") or "").strip():
            entry["user"] = t["content"].strip()
        elif role == "council":
            entry["council"].append(t)
        elif role == "critique":
            entry.setdefault("critique", []).append(t)

    rounds = {
        k: v for k, v in rounds.items()
        if v.get("chairman") or v.get("user") or v["council"] or v.get("critique")
    }
    if not rounds:
        return ""

    # Which attempt at each round is the one that counted. Scoped per phase:
    # a finalise pass and the round it followed share a number but are not
    # attempts at the same thing, so one must never mark the other superseded.
    latest: dict[tuple[int, str], int] = {}
    for rn, at, ph in rounds:
        latest[(rn, ph)] = max(latest.get((rn, ph), 0), at)

    lines = [
        "",
        "---",
        "",
        "<details>",
        "<summary>Brainstorm transcript — the full session this plan came from</summary>",
        "",
        "*Every question asked, every answer given, what each council member "
        "said in full, and what they said about each other.*",
        "",
    ]

    # Round before finalise when they share a number: the finalise pass always
    # happens after the round it was launched from.
    for rn, at, ph in sorted(rounds, key=lambda k: (k[0], k[2] == "finalize", k[1])):
        entry = rounds[(rn, at, ph)]
        superseded = at < latest.get((rn, ph), 1)
        label = "Finalise pass" if ph == "finalize" else f"Round {rn}"
        if at > 1 or superseded:
            label += f" · attempt {at}"
        if superseded:
            label += " (superseded — this attempt did not complete)"
        lines += [f"### {label}", ""]

        if reply := entry.get("user"):
            lines += ["**What the person answered:**", "", "```", reply, "```", ""]

        parsed = entry.get("chairman") or {}
        if questions := parsed.get("questions"):
            by = entry.get("chairman_by")
            lines.append(
                f"**Questions put to the person**{f' (merged by {by})' if by else ''}**:**"
            )
            lines.append("")
            lines += _question_lines(questions)
            lines.append("")

        if agreement := (parsed.get("agreement") or "").strip():
            lines += ["**Where the council agreed and split:**", "", agreement, ""]
        elif split := (parsed.get("council_split") or "").strip():
            lines += ["**Where the council was split:**", "", split, ""]

        if corrections := (parsed.get("corrections_text") or "").strip():
            lines += ["**Factual errors caught this round:**", "", corrections, ""]

        # A question the ledger suppressed is shown rather than dropped: the
        # person seeing "this was not re-asked because you already answered it"
        # is the point, and a silently filtered question is indistinguishable
        # from one that was never proposed.
        if dropped := parsed.get("dropped_questions"):
            lines += ["**Questions dropped as already settled:**", ""]
            lines += [f"- {q}" for q in dropped]
            lines.append("")

        if draft := (parsed.get("plan_so_far") or "").strip():
            lines += [
                "<details>",
                f"<summary>Plan draft as of {label.split(' ·')[0].lower()}</summary>",
                "",
                draft,
                "",
                "</details>",
                "",
            ]

        if entry["council"]:
            lines += [
                "<details>",
                "<summary>What each member said in full</summary>",
                "",
            ]
            for t in entry["council"]:
                name = t.get("provider_id") or "member"
                ok = t.get("ok")
                meta = []
                if t.get("latency_ms"):
                    meta.append(f"{t['latency_ms'] / 1000:.1f}s")
                if t.get("char_count"):
                    meta.append(f"{t['char_count']}c")
                suffix = f" — {', '.join(meta)}" if meta else ""

                if t.get("degraded"):
                    lines += [
                        f"**{name}** — excluded: "
                        f"{t.get('degraded_reason') or 'unusable response'}{suffix}",
                        "",
                    ]
                elif ok == 0:
                    why = t.get("failure_kind") or "failed"
                    detail = (t.get("error_detail") or "").strip()
                    if detail:
                        why += f" ({detail})"
                    lines += [f"**{name}** — did not respond: {why}", ""]
                    continue
                else:
                    lines += [f"**{name}**{suffix}", ""]

                if body := (t.get("content") or "").strip():
                    lines += [body, ""]
            lines += ["</details>", ""]

        if entry.get("critique"):
            lines += [
                "<details>",
                "<summary>What each member said about the others</summary>",
                "",
            ]
            for t in entry["critique"]:
                name = t.get("provider_id") or "member"
                if t.get("ok") == 0:
                    why = t.get("failure_kind") or "failed"
                    lines += [f"**{name}** — did not critique: {why}", ""]
                    continue
                lines += [f"**{name}**", ""]
                if body := (t.get("content") or "").strip():
                    lines += [body, ""]
            lines += ["</details>", ""]

    lines += ["</details>", ""]
    return "\n".join(lines)


def strip_code_fence(text: str) -> str:
    """Unwrap a whole-document ```markdown fence if the model added one.

    Only when the fence encloses everything -- fences around real code inside
    the document are meant to be there.
    """
    s = (text or "").strip()
    if not s.startswith("```"):
        return s
    lines = s.splitlines()
    if len(lines) < 2 or not lines[-1].strip().startswith("```"):
        return s
    if any(ln.strip().startswith("```") for ln in lines[1:-1]):
        return s
    return "\n".join(lines[1:-1]).strip()


def build_plan_markdown(body: str, turns: list[dict]) -> str:
    """The chairman's plan body plus the transcript appendix.

    Deliberately does NOT touch the filesystem. Finalising produces a document,
    not a file: where that document lands is the person's decision, made in a
    save dialog, not something this should quietly settle by writing into a
    folder they never chose.
    """
    return strip_code_fence(body) + "\n" + build_transcript_appendix(turns)


# ── drivers ─────────────────────────────────────────────────────────────────

async def merge_round(
    chairman: Provider,
    topic: str,
    turns: list[dict],
    answers: list[Answer],
    ctx: RunContext,
    *,
    critiques: list[dict] | None = None,
    cancel=None,
) -> tuple[str, dict, bool, str | None, int]:
    """Chairman merges one round. Returns (raw, parsed, ok, error, ms)."""
    t0 = time.monotonic()
    prompt = build_chairman_prompt(topic, turns, answers, critiques)
    result = await chairman.ask(prompt, ctx=ctx, cancel=cancel)
    ms = int((time.monotonic() - t0) * 1000)

    if not result.ok:
        return (
            "",
            parse_round(""),
            False,
            f"Chairman ({chairman.display_name}) failed: "
            f"{result.failure} -- {result.error_detail}",
            ms,
        )
    return result.text, parse_round(result.text), True, None, ms


async def write_plan(
    chairman: Provider,
    topic: str,
    turns: list[dict],
    answers: list[Answer],
    ctx: RunContext,
    *,
    critiques: list[dict] | None = None,
    cancel=None,
) -> tuple[str, bool, str | None, int]:
    """Chairman writes the final plan body. Returns (markdown, ok, error, ms)."""
    t0 = time.monotonic()
    prompt = build_finalize_prompt(topic, turns, answers, critiques)
    result = await chairman.ask(prompt, ctx=ctx, cancel=cancel)
    ms = int((time.monotonic() - t0) * 1000)

    if not result.ok:
        return (
            "",
            False,
            f"Chairman ({chairman.display_name}) failed to write the plan: "
            f"{result.failure} -- {result.error_detail}",
            ms,
        )
    return result.text, True, None, ms

async def review_plan(
    chairman: Provider,
    document: str,
    turns: list[dict],
    answers: list[Answer],
    ctx: RunContext,
    *,
    cancel=None,
) -> tuple[str, bool, str | None, int]:
    """One pass over the finished document. Returns (markdown, changed, note, ms).

    Never fails the finalise. The document already exists and is already worth
    keeping by the time this runs, so every failure path returns the original
    text -- a review that errors, returns nothing, or comes back suspiciously
    short leaves the person with the unreviewed document rather than nothing.
    """
    t0 = time.monotonic()
    original = document or ""
    try:
        prompt = build_review_prompt(original, turns, answers)
        result = await chairman.ask(prompt, ctx=ctx, cancel=cancel)
    except Exception as e:
        ms = int((time.monotonic() - t0) * 1000)
        return original, False, f"The review pass could not run: {str(e)[:200]}", ms

    ms = int((time.monotonic() - t0) * 1000)
    if not result.ok:
        return original, False, (
            f"The review pass did not complete ({result.failure}), so the "
            "document is as first written."
        ), ms

    text, accepted, reason = accept_review(original, strip_code_fence(result.text))
    if not accepted:
        return original, False, (
            f"The review pass was discarded because {reason}; the document is "
            "as first written."
        ), ms
    return text, True, None, ms
