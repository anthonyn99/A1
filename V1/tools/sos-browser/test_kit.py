"""Tests for study kits and grading (kit.py + the kit/grade runners in server.py).

Every test here drives a FAKE cmd_ask. A real one spends a message of the
Claude subscription, and the decisions pinned below are exactly the ones that
would otherwise be discovered one paid run at a time:

  "a retry resumes, it does not repay"
      Each stage is journaled when it finishes. A failure in the quiz ask must
      not re-run the rewrite or the cards ask.

  "bad JSON gets one repair ask, then stops"
      Not zero (the content is usually fine and only the syntax is off) and not
      unbounded (a third identical failure is a prompt bug, not bad luck).

  "every ask attaches the deck"
      cmd_ask opens claude.ai/new each time, so an ask without the attachment
      is a fresh chat that has never seen the lecture.

  "grade jobs never hit the cache"
      They carry no fileId; a fingerprint would collide across all of them.

Run:  py -3.11 test_kit.py
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kit  # noqa: E402
import server  # noqa: E402

# Never touch the real journal — see the long note at the top of test_server.py.
_tmp = Path(tempfile.mkdtemp(prefix="sos-test-kit-"))
server.JOBS_FILE = _tmp / "jobs.json"
server.OUTPUTS = _tmp / "outputs"
import atexit  # noqa: E402
atexit.register(lambda: shutil.rmtree(_tmp, ignore_errors=True))

PASS = FAIL = 0


def t(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   " + name)
    else:
        FAIL += 1
        print("  FAIL " + name + (("\n       " + str(extra)[:400]) if extra else ""))


def raises(fn, exc):
    try:
        fn()
    except exc:
        return True
    except Exception:
        return False
    return False


# ── extract_json ──────────────────────────────────────────────────────────────
print("\nextract_json")
t("plain fenced json", kit.extract_json('```json\n{"a": 1}\n```') == {"a": 1})
t("prose around the fence is ignored",
  kit.extract_json('Here you go:\n```json\n{"a": 2}\n```\nHope that helps!') == {"a": 2})
t("the LAST json fence wins (a self-correction goes last)",
  kit.extract_json('```json\n{"a": 1,,}\n```\nOops:\n```json\n{"a": 3}\n```') == {"a": 3})
t("trailing commas are repaired",
  kit.extract_json('```json\n{"a": [1, 2,], "b": {"c": 1,},}\n```') == {"a": [1, 2], "b": {"c": 1}})
t("no fence: first balanced object",
  kit.extract_json('json\n{"a": {"b": "x}"}}\nthanks') == {"a": {"b": "x}"}})
t("a leaked 'json' label line inside the fence is dropped",
  kit.extract_json('```\njson\n{"a": 4}\n```') == {"a": 4})
t("braces inside strings do not end the object",
  kit.extract_json('{"s": "a { b } c", "n": 1}') == {"s": "a { b } c", "n": 1})
t("empty answer raises KitError", raises(lambda: kit.extract_json("   "), kit.KitError))
t("garbage raises KitError", raises(lambda: kit.extract_json("no json here"), kit.KitError))
t("a JSON array is not accepted", raises(lambda: kit.extract_json("```json\n[1,2]\n```"), kit.KitError))


# ── clean_cards / clean_quiz ─────────────────────────────────────────────────
def _cards(n, **over):
    return [dict({"topic": "Keys", "front": f"What is key number {i}?",
                  "back": f"Answer {i}", "slide": i}, **over) for i in range(n)]


def _quiz(n):
    out = []
    for i in range(n):
        out.append({"topic": "SQL", "type": "mcq", "prompt": f"Question {i}?",
                    "choices": ["alpha", "beta", "gamma", "delta"], "answer": "beta",
                    "explanation": "because"})
    return out


print("\nclean_cards")
c, p = kit.clean_cards({"flashcards": _cards(20), "key_terms": [{"term": "PK", "definition": "primary key"}]})
t("20 good cards pass with no problems", len(c["flashcards"]) == 20 and not p, p)
t("key terms are kept", c["key_terms"][0]["term"] == "PK")
c, p = kit.clean_cards({"flashcards": _cards(20) + [{"front": "x", "back": ""}, "junk", {"front": "What?"}]})
t("malformed cards are dropped, not fatal", len(c["flashcards"]) == 20 and not p, p)
c, p = kit.clean_cards({"flashcards": _cards(10) + _cards(10)})
t("exact duplicates collapse", len(c["flashcards"]) == 10)
t("a short count is reported as a problem", p and "only 10" in p[0], p)
c, _ = kit.clean_cards({"flashcards": _cards(1, slide="7")})
t("a string slide number becomes an int", c["flashcards"][0]["slide"] == 7)
c, _ = kit.clean_cards({"flashcards": _cards(1, slide="n/a")})
t("a nonsense slide becomes null", c["flashcards"][0]["slide"] is None)

print("\nclean_quiz")
q, p = kit.clean_quiz({"quiz": _quiz(9), "cheatsheet_md": "# Sheet"})
t("9 good questions + sheet pass", len(q["quiz"]) == 9 and not p, p)
bad = _quiz(1)[0] | {"answer": "B"}
q, _ = kit.clean_quiz({"quiz": [bad], "cheatsheet_md": "x"})
t("a letter answer maps to its choice text", q["quiz"][0]["answer"] == "beta", q)
bad = _quiz(1)[0] | {"answer": "BETA"}
q, _ = kit.clean_quiz({"quiz": [bad], "cheatsheet_md": "x"})
t("answer matching is case-insensitive", q["quiz"][0]["answer"] == "beta")
bad = _quiz(1)[0] | {"answer": "epsilon"}
q, _ = kit.clean_quiz({"quiz": [bad], "cheatsheet_md": "x"})
t("an mcq whose answer is not a choice is dropped", q["quiz"] == [])
q, _ = kit.clean_quiz({"quiz": [{"type": "essay", "prompt": "Discuss.", "answer": "x"}]})
t("unknown question types are dropped", q["quiz"] == [])
q, _ = kit.clean_quiz({"quiz": [{"type": "trace", "prompt": "print(1+1)", "answer": "2"}]})
t("trace questions keep their answer verbatim", q["quiz"][0]["answer"] == "2")
q, p = kit.clean_quiz({"quiz": _quiz(9)})
t("a missing cheat sheet is a problem, not a failure", q["quiz"] and "no cheat sheet" in p)

print("\nclean_grade")
g, p = kit.clean_grade("explain", {"score": "87.6", "covered": ["a"], "missing": ["b", ""], "misconceptions": None})
t("score is coerced and clamped", g["score"] == 88)
t("empty list items are dropped", g["missing"] == ["b"])
t("a null list becomes []", g["misconceptions"] == [])
g, _ = kit.clean_grade("explain", {"score": 50, "cards": [{"front": "What is a superkey?", "back": "Any key set"}, {"front": ""}, "junk"]})
t("explain cards are kept, malformed ones dropped", g["cards"] == [{"front": "What is a superkey?", "back": "Any key set"}], g)
g, _ = kit.clean_grade("java", {"score": 90, "passes": [], "issues": []})
t("java grades carry no cards field", "cards" not in g)
g, p = kit.clean_grade("java", {"score": 140, "passes": [], "issues": ["x"]})
t("score is clamped to 100", g["score"] == 100)
g, p = kit.clean_grade("java", {"passes": []})
t("a missing score is reported", g["score"] is None and p)


# ── The runner, with a fake driver ────────────────────────────────────────────
class FakeAsk:
    """Scripted cmd_ask. Each call pops the next answer; records every call."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = []

    def __call__(self, args):
        self.calls.append({"prompt": args.prompt, "attach": args.attach})
        if not self.answers:
            raise AssertionError("cmd_ask called more times than scripted")
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return {"ok": True, "site": "claude", "text": a, "clean": True}


def fenced(obj):
    return "Sure!\n```json\n" + json.dumps(obj) + "\n```"


CARDS_OK = fenced({"flashcards": _cards(18), "key_terms": [{"term": "FD", "definition": "functional dependency"}]})
QUIZ_OK = fenced({"quiz": _quiz(10), "cheatsheet_md": "# Cheat\n- a"})

_real_ask, _real_run, _real_save = server.driver.cmd_ask, server.asyncio.run, server._save
_real_build = server.build_job_pdf
server.asyncio.run = lambda c: c          # the fakes are plain functions
server._save = lambda: None


def run_kit(job, answers):
    fake = FakeAsk(answers)
    server.driver.cmd_ask = fake
    err = None
    try:
        server._run_kit_job(job)
    except Exception as e:     # noqa: BLE001 — the test inspects it
        err = e
    return fake, err


src = _tmp / "L1.pdf"
src.write_bytes(b"%PDF-1.4 fake")

try:
    print("\nkit runner — happy path, no rewrite")
    job = {"id": "k1", "mode": "kit", "prompt": "STYLE", "filePath": str(src)}
    fake, err = run_kit(job, [CARDS_OK, QUIZ_OK])
    t("no error", err is None, err)
    t("exactly two asks", len(fake.calls) == 2, len(fake.calls))
    t("every ask attaches the deck", all(c["attach"] == [str(src)] for c in fake.calls))
    t("her style prompt leads each ask", all(c["prompt"].startswith("STYLE") for c in fake.calls))
    t("the cards ask carries the cards schema", "flashcards" in fake.calls[0]["prompt"])
    t("the quiz ask carries the quiz schema", "cheatsheet_md" in fake.calls[1]["prompt"])
    t("job is done", job["status"] == "done" and job["progress"] == 100)
    t("kit holds 18 cards", len(job["kit"]["flashcards"]) == 18)
    t("kit holds 10 questions", len(job["kit"]["quiz"]) == 10)
    t("kit holds the cheat sheet", job["kit"]["cheatsheet_md"].startswith("# Cheat"))
    t("result is a non-empty marker", job["result"].startswith("Study kit (18 cards"))
    t("no warnings", job["kitWarnings"] == [], job["kitWarnings"])
    t("a kit without rewrite never builds a PDF", server.build_job_pdf(job) is False)

    print("\nkit runner — bad JSON gets exactly one repair")
    job = {"id": "k2", "mode": "kit", "prompt": "S", "filePath": str(src)}
    fake, err = run_kit(job, ["not json at all", CARDS_OK, QUIZ_OK])
    t("repaired and finished", err is None and job["status"] == "done", err)
    t("the repair ask carries the broken text", "not json at all" in fake.calls[1]["prompt"])
    t("the repair ask does not re-upload the deck", fake.calls[1]["attach"] is None)

    job = {"id": "k3", "mode": "kit", "prompt": "S", "filePath": str(src)}
    fake, err = run_kit(job, ["nope", "still nope"])
    t("two failures -> kit_bad_json", getattr(err, "kind", None) == "kit_bad_json", err)
    t("kit_bad_json is not retryable", not server.is_retryable("kit_bad_json", job))
    t("and it stopped after two asks", len(fake.calls) == 2)

    print("\nkit runner — a retry resumes at the failed stage")
    job = {"id": "k4", "mode": "kit", "prompt": "S", "filePath": str(src)}
    fake, err = run_kit(job, [CARDS_OK, "junk", "junk"])
    t("the quiz stage failed", err is not None and job.get("kitStage") == "quiz", job.get("kitStage"))
    t("the cards survived the failure", len(job["kit"]["flashcards"]) == 18)
    fake, err = run_kit(job, [QUIZ_OK])
    t("the retry made ONE ask (the quiz), not three", len(fake.calls) == 1, len(fake.calls))
    t("and finished with both halves", job["status"] == "done"
      and len(job["kit"]["flashcards"]) == 18 and len(job["kit"]["quiz"]) == 10)

    print("\nkit runner — a short answer gets one 'more' ask")
    short = fenced({"flashcards": _cards(9)})
    job = {"id": "k5", "mode": "kit", "prompt": "S", "filePath": str(src)}
    fake, err = run_kit(job, [short, CARDS_OK, QUIZ_OK])
    t("asked once more and took the fuller answer",
      len(fake.calls) == 3 and len(job["kit"]["flashcards"]) == 18, len(fake.calls))
    t("the extra ask says how many it got", "only 9" in fake.calls[1]["prompt"])
    job = {"id": "k6", "mode": "kit", "prompt": "S", "filePath": str(src)}
    fake, err = run_kit(job, [short, short, QUIZ_OK])
    t("still short -> accepted with a warning, not failed",
      err is None and job["status"] == "done" and "only 9" in job["kitWarnings"][0], job.get("kitWarnings"))

    print("\nkit runner — with the rewrite stage")
    slides = "## Slide 1\nIntro text\n\n## Slide 2\nMore text"
    built = []
    server.build_job_pdf = lambda j, **k: built.append(j["id"]) or True
    job = {"id": "k7", "mode": "kit", "prompt": "S", "filePath": str(src),
           "kitRewrite": True, "slideCount": 2}
    fake, err = run_kit(job, [slides, CARDS_OK, QUIZ_OK])
    t("three asks: rewrite, cards, quiz", err is None and len(fake.calls) == 3, err)
    t("the rewrite ask attaches the deck", fake.calls[0]["attach"] == [str(src)])
    t("result is the rewrite text (for the PDF)", job["result"].startswith("## Slide 1"))
    t("the PDF is built", built == ["k7"])
    server.build_job_pdf = _real_build

    print("\nrewrite path — unchanged: only the FIRST chunk attaches")
    job = {"id": "r1", "prompt": "S", "filePath": str(src), "slideCount": 30}
    chunk1 = "\n".join(f"## Slide {i}\nx" for i in range(1, 16))
    chunk2 = "\n".join(f"## Slide {i}\nx" for i in range(16, 31))
    fake = FakeAsk([chunk1, chunk2])
    server.driver.cmd_ask = fake
    server.build_job_pdf = lambda j, **k: True
    server._run_rewrite_job(job)
    server.build_job_pdf = _real_build
    t("two chunks", len(fake.calls) == 2)
    t("chunk 1 attached, chunk 2 did not (historical behaviour)",
      fake.calls[0]["attach"] and fake.calls[1]["attach"] is None)
    t("job done with both chunks", job["status"] == "done" and len(job["sections"]) == 2)

    print("\nkit path — every chunk attaches")
    job = {"id": "k8", "mode": "kit", "prompt": "S", "filePath": str(src),
           "kitRewrite": True, "slideCount": 30}
    server.build_job_pdf = lambda j, **k: True
    fake, err = run_kit(job, [chunk1, chunk2, CARDS_OK, QUIZ_OK])
    server.build_job_pdf = _real_build
    t("both rewrite chunks attached the deck",
      err is None and fake.calls[0]["attach"] and fake.calls[1]["attach"], err)

    print("\ngrade runner")
    job = {"id": "g1", "mode": "grade", "gradeKind": "explain", "prompt": "KEY POINTS..."}
    fake = FakeAsk([fenced({"score": 70, "covered": ["a"], "missing": ["b"], "misconceptions": []})])
    server.driver.cmd_ask = fake
    server._run_grade_job(job)
    t("graded", job["status"] == "done" and job["graded"]["score"] == 70)
    t("carries the explain schema", "misconceptions" in fake.calls[0]["prompt"])
    t("no attachment", fake.calls[0]["attach"] is None)
    t("marked filed so resumeWatches skips it", job["filed"] is True)
    t("never builds a PDF", server.build_job_pdf(job) is False)
finally:
    server.driver.cmd_ask = _real_ask
    server.asyncio.run = _real_run
    server._save = _real_save
    server.build_job_pdf = _real_build


# ── _create: validation, cache, queue order ──────────────────────────────────
print("\n_create")


class _H(server.Handler):
    def __init__(self):
        self.sent = None

    def _send(self, obj, status=200):
        self.sent = (obj, status)
        return obj


def create(body):
    h = _H()
    h._create(body)
    return h.sent


_real_jobs, _real_queue, _real_worker = server._jobs, server._queue, server._ensure_worker
server._save = lambda: None
server._ensure_worker = lambda: None
server.UPLOADS = _tmp / "uploads"
try:
    server._jobs, server._queue = {}, ["deck_job"]
    obj, st = create({"prompt": "p", "mode": "grade", "gradeKind": "java"})
    t("a grade job is accepted", st == 200 and obj["job"]["mode"] == "grade", obj)
    t("and jumps the queue", server._queue[0] == obj["job"]["id"], server._queue)
    obj2, _ = create({"prompt": "p", "mode": "grade", "gradeKind": "java"})
    t("two identical grade requests are two jobs (never cached)",
      obj2["job"]["id"] != obj["job"]["id"] and not obj2.get("cached"))
    obj, st = create({"prompt": "p", "mode": "grade", "gradeKind": "poetry"})
    t("an unknown gradeKind is refused", st == 400)
    obj, st = create({"prompt": "p", "mode": "kit", "fileId": "f"})
    t("a kit without the file is refused", st == 400, obj)
    import base64
    b64 = base64.b64encode(b"%PDF-1.4 x").decode()
    obj, st = create({"prompt": "p", "mode": "kit", "fileId": "f", "fileB64": b64,
                      "sourceName": "L.pdf", "kitRewrite": True})
    t("a kit with the file is queued at the back",
      st == 200 and server._queue[-1] == obj["job"]["id"], server._queue)
    # The fake bytes are not a real PDF, so the rewrite is dropped honestly.
    t("a non-PDF source drops the rewrite", obj["job"]["kitRewrite"] is False)
    t("...and its fingerprint says so", obj["job"]["fingerprint"].endswith("|kit"))
    t("...and the job carries a warning", "not a PDF" in obj["job"]["kitWarnings"][0])
    fixture = Path(__file__).resolve().parent / "uploads" / "_fixture-2page.pdf"
    if fixture.exists():
        b64 = base64.b64encode(fixture.read_bytes()).decode()
        obj, st = create({"prompt": "p", "mode": "kit", "fileId": "f2", "fileB64": b64,
                          "sourceName": "L.pdf", "kitRewrite": True})
        t("a real PDF keeps the rewrite", obj["job"]["kitRewrite"] is True, obj)
        t("the rewrite flag is part of the fingerprint", obj["job"]["fingerprint"].endswith("|kit|rewrite"))
        t("slideCount is the true page count", obj["job"]["slideCount"] == 2, obj["job"].get("slideCount"))
finally:
    server._jobs, server._queue, server._ensure_worker = _real_jobs, _real_queue, _real_worker
    server._save = _real_save


print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
