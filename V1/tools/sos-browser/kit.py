"""Structured output for StudyOS: study kits and graded answers.

Pure functions only — no browser, no job state — so every decision here is
testable without spending a single message of the subscription.

── WHY THE FORMAT LIVES HERE AND NOT IN THE PROMPT SHE EDITS ─────────────────
The rewrite presets are hers to edit in the Prompts module. If the JSON shape
were part of that text, one careless edit ("make it friendlier") would break
parsing on the next run, and the failure would surface as a paid generation
that files nothing. So the style comes from her prompt and the SHAPE is
appended here, where only code changes it.

── WHY TWO ASKS AND NOT ONE ──────────────────────────────────────────────────
Fifteen flashcards, eight quiz questions with explanations and a cheat sheet in
one JSON document is long enough that a chat UI may truncate it, or decide to
render it as an artifact instead of inline. Two smaller documents each stay
comfortably inside one answer, and a failure costs half as much to repeat.

── EVERY ASK IS A FRESH CHAT ─────────────────────────────────────────────────
driver.cmd_ask opens site.url (claude.ai/new) on every call, so nothing carries
over between asks. Each prompt built here therefore stands alone and the PDF is
attached to every one of them.
"""

from __future__ import annotations

import json
import re

MIN_CARDS = 15
MIN_QUIZ = 8
QUIZ_TYPES = ("mcq", "short", "trace", "sql")

_INLINE_RULE = (
    "Reply with ONE fenced code block tagged json and nothing else. "
    "Write it inline in the chat — do NOT create an artifact, a file, or a "
    "document, and do not add commentary before or after the block."
)

CARDS_SCHEMA_PROMPT = f"""

---
OUTPUT FORMAT (this part overrides any formatting instructions above):
From the attached lecture, produce flashcards and key terms as JSON of exactly
this shape:

{{
  "flashcards": [
    {{"topic": "short topic name", "front": "question or prompt",
      "back": "concise answer", "slide": 3}}
  ],
  "key_terms": [
    {{"term": "Candidate key", "definition": "one-sentence definition",
      "topic": "short topic name"}}
  ]
}}

Rules:
- At least {MIN_CARDS + 5} flashcards covering every major idea in the lecture,
  in lecture order. One fact per card. Fronts are questions, not headings.
- "slide" is the slide/page number the card comes from (integer), or null.
- "topic" is a 1-4 word topic name; reuse the SAME spelling for cards on the
  same topic so they group together.
- 8-20 key terms.
- {_INLINE_RULE}
"""

QUIZ_SCHEMA_PROMPT = f"""

---
OUTPUT FORMAT (this part overrides any formatting instructions above):
From the attached lecture, write an exam-style practice quiz and a one-page
cheat sheet as JSON of exactly this shape:

{{
  "quiz": [
    {{"topic": "short topic name", "type": "mcq",
      "prompt": "the question", "choices": ["A", "B", "C", "D"],
      "answer": "the correct choice text exactly as it appears in choices",
      "explanation": "why that answer is right and the others are not"}}
  ],
  "cheatsheet_md": "# Cheat sheet\\n..."
}}

Rules:
- At least {MIN_QUIZ + 2} questions. "type" is one of: mcq, short, trace, sql.
  - mcq: 4 choices; "answer" must equal one of the choices exactly.
  - short: a 1-3 sentence answer in "answer"; no "choices".
  - trace: "prompt" contains a short code snippet and asks what it prints or
    returns; "answer" is the exact output.
  - sql: only if the lecture covers SQL; "prompt" asks for a query, "answer"
    is a correct query.
- Mix the types and difficulty the way a real midterm would.
- "topic" is a 1-4 word topic name.
- "cheatsheet_md" is markdown: definitions, formulas, rules of thumb and common
  mistakes — dense enough to fit on one page.
- {_INLINE_RULE}
"""

GRADE_SCHEMAS = {
    # Python -> Java translation drill.
    "java": {
        "prompt": f"""

---
OUTPUT FORMAT:
Grade the student's Java against the rubric and the sample input/output above.
Reply as JSON of exactly this shape:

{{"score": 0-100, "passes": ["rubric points the code meets"],
  "issues": ["specific problems: compile errors, wrong output, missed rubric points"]}}

- Mentally run the code on the sample input; a wrong output is an issue.
- Be specific and short. Do not rewrite the whole solution.
- {_INLINE_RULE}
""",
        "lists": ("passes", "issues"),
    },
    # Explain-it-back.
    "explain": {
        "prompt": f"""

---
OUTPUT FORMAT:
Compare the student's explanation with the key points above. Reply as JSON of
exactly this shape:

{{"score": 0-100, "covered": ["key points the explanation got right"],
  "missing": ["key points it left out, each phrased as a short fact"],
  "misconceptions": ["anything it states that is wrong, with the correction"],
  "cards": [{{"front": "a flashcard question", "back": "its answer"}}]}}

- Judge understanding, not wording. Paraphrases count as covered.
- "cards": one flashcard per missing point or misconception, so the gap can
  be practised. The question must make sense on its own.
- {_INLINE_RULE}
""",
        "lists": ("covered", "missing", "misconceptions"),
        "cards": True,
    },
}


class KitError(ValueError):
    """The answer could not be turned into the structure we asked for."""


# ── Extraction ────────────────────────────────────────────────────────────────
_FENCE_RE = re.compile(r"```[ \t]*([\w+-]*)[ \t]*\n(.*?)```", re.S)


def _strip_trailing_commas(s: str) -> str:
    # `[1, 2,]` and `{"a": 1,}` — the commonest way a model's JSON fails.
    return re.sub(r",(\s*[\]}])", r"\1", s)


def _balanced_object(text: str) -> str | None:
    """The first top-level {...} in text, honouring strings and escapes."""
    start = text.find("{")
    while start >= 0:
        depth, in_str, esc = 0, False, False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return text[start:i + 1]
        start = text.find("{", start + 1)
    return None


def extract_json(text: str) -> dict:
    """Pull one JSON object out of a chat answer.

    Tries, in order: the LAST ```json fence (a model that "corrects itself"
    puts the good copy last), any other fence, then the first balanced object
    in the raw text. The last fallback covers a code block whose language
    label the UI rendered as a stray "json" line instead of a fence tag.
    """
    if not text or not text.strip():
        raise KitError("empty answer")

    candidates: list[str] = []
    fences = _FENCE_RE.findall(text)
    candidates += [body for lang, body in reversed(fences) if lang.lower() == "json"]
    candidates += [body for lang, body in reversed(fences) if lang.lower() != "json"]
    obj = _balanced_object(text)
    if obj:
        candidates.append(obj)

    last_err = "no JSON object found"
    for c in candidates:
        c = c.strip()
        # A code block's label can leak in as the first line.
        c = re.sub(r"^\s*json\s*\n", "", c, flags=re.I)
        inner = _balanced_object(c) or c
        for attempt in (inner, _strip_trailing_commas(inner)):
            try:
                v = json.loads(attempt)
            except json.JSONDecodeError as e:
                last_err = f"invalid JSON: {e.msg} at line {e.lineno} col {e.colno}"
                continue
            if isinstance(v, dict):
                return v
            last_err = "JSON is not an object"
    raise KitError(last_err)


# ── Validation ────────────────────────────────────────────────────────────────
def _s(v) -> str:
    return re.sub(r"\s+", " ", str(v if v is not None else "")).strip()


def _slide(v):
    try:
        n = int(v)
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None


def clean_cards(obj: dict) -> tuple[dict, list[str]]:
    """Normalise the flashcards/key_terms answer. Returns (clean, problems).

    Drops malformed items instead of failing the whole answer: one card with a
    missing back must not throw away nineteen good ones. `problems` names what
    was dropped and whether the count still meets the minimum.
    """
    problems: list[str] = []
    cards, seen = [], set()
    for c in obj.get("flashcards") or []:
        if not isinstance(c, dict):
            continue
        front, back = _s(c.get("front") or c.get("q")), _s(c.get("back") or c.get("a"))
        if len(front) < 4 or len(back) < 1:
            continue
        key = (front.lower(), back.lower())
        if key in seen:
            continue
        seen.add(key)
        cards.append({"topic": _s(c.get("topic"))[:60], "front": front[:400],
                      "back": back[:800], "slide": _slide(c.get("slide"))})
    terms = []
    for t in obj.get("key_terms") or []:
        if not isinstance(t, dict):
            continue
        term, d = _s(t.get("term")), _s(t.get("definition"))
        if term and d:
            terms.append({"term": term[:80], "definition": d[:400],
                          "topic": _s(t.get("topic"))[:60]})
    if len(cards) < MIN_CARDS:
        problems.append(f"only {len(cards)} usable flashcards (need {MIN_CARDS})")
    return {"flashcards": cards, "key_terms": terms}, problems


def clean_quiz(obj: dict) -> tuple[dict, list[str]]:
    """Normalise the quiz/cheatsheet answer. Returns (clean, problems)."""
    problems: list[str] = []
    out = []
    for q in obj.get("quiz") or []:
        if not isinstance(q, dict):
            continue
        typ = _s(q.get("type")).lower()
        prompt, answer = str(q.get("prompt") or "").strip(), str(q.get("answer") or "").strip()
        if typ not in QUIZ_TYPES or len(prompt) < 4 or not answer:
            continue
        item = {"topic": _s(q.get("topic"))[:60], "type": typ, "prompt": prompt[:2000],
                "answer": answer[:2000], "explanation": str(q.get("explanation") or "").strip()[:2000]}
        if typ == "mcq":
            choices = [_s(c) for c in (q.get("choices") or []) if _s(c)]
            if len(choices) < 2:
                continue
            # "answer" may be the letter ("B") rather than the text.
            if answer not in choices and re.fullmatch(r"[A-Ha-h]", answer):
                idx = ord(answer.upper()) - 65
                if idx < len(choices):
                    answer = choices[idx]
            if answer not in choices:
                low = {c.lower(): c for c in choices}
                answer = low.get(answer.lower(), "")
            if not answer:
                continue
            item["choices"], item["answer"] = choices[:6], answer
        out.append(item)
    cheat = str(obj.get("cheatsheet_md") or "").strip()
    if len(out) < MIN_QUIZ:
        problems.append(f"only {len(out)} usable quiz questions (need {MIN_QUIZ})")
    if not cheat:
        problems.append("no cheat sheet")
    return {"quiz": out, "cheatsheet_md": cheat[:20000]}, problems


def clean_grade(kind: str, obj: dict) -> tuple[dict, list[str]]:
    spec = GRADE_SCHEMAS[kind]
    problems: list[str] = []
    try:
        score = max(0, min(100, int(round(float(obj.get("score"))))))
    except (TypeError, ValueError):
        score = None
        problems.append("no numeric score")
    out = {"score": score}
    for key in spec["lists"]:
        v = obj.get(key) or []
        out[key] = [_s(x)[:400] for x in v if _s(x) and not isinstance(x, dict)] if isinstance(v, list) else []
    if spec.get("cards"):
        cards = []
        for c in obj.get("cards") or []:
            if isinstance(c, dict) and _s(c.get("front")) and _s(c.get("back")):
                cards.append({"front": _s(c["front"])[:400], "back": _s(c["back"])[:800]})
        out["cards"] = cards[:15]
    return out, problems


# ── Prompts ───────────────────────────────────────────────────────────────────
def repair_prompt(error: str, answer: str) -> str:
    """Stand-alone, because the repair ask is a fresh chat too."""
    return (
        "The text below was meant to be a single valid JSON object but it could "
        f"not be parsed ({error}). Fix it and return ONLY the corrected JSON. "
        "Keep every item; do not summarise or shorten.\n\n"
        f"{_INLINE_RULE}\n\n<broken>\n{answer[:60000]}\n</broken>"
    )


def more_prompt(base: str, kind: str, have: int, need: int) -> str:
    what = "flashcards" if kind == "cards" else "quiz questions"
    return (base + f"\n\nIMPORTANT: a previous attempt produced only {have} usable "
            f"{what}. Produce at least {need + 3} this time.")
