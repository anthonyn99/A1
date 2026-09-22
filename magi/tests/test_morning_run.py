"""The three things that broke the 2026-09-22 morning report.

1. Two streams on one run split its events (one asyncio.Queue, two readers).
2. The same prompt started a second council while the first was running.
3. ChatGPT refused a 78k-character synthesis as "too long", and that line
   became the verdict.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from magi.engine import chairman, validate  # noqa: E402
from magi.fanout import Broadcast  # noqa: E402
from magi.providers.base import Answer  # noqa: E402


def test_every_listener_gets_every_event():
    async def go():
        b = Broadcast()
        a, c = b.subscribe(), b.subscribe()
        for i in range(3):
            await b.put({"i": i})
        got_a = [a.get_nowait()["i"] for _ in range(3)]
        got_c = [c.get_nowait()["i"] for _ in range(3)]
        b.unsubscribe(a)
        await b.put({"i": 9})
        assert a.empty() and c.get_nowait()["i"] == 9
        return got_a, got_c

    got_a, got_c = asyncio.run(go())
    assert got_a == got_c == [0, 1, 2]


def test_no_stream_reads_the_shared_queue_directly():
    src = (Path(__file__).resolve().parents[1] / "app.py").read_text(encoding="utf-8")
    assert 'state["queue"].get()' not in src
    assert "asyncio.Queue()" not in src.split("def _live_twin")[1].split("@app.get(\"/api/runs/{run_id}/stream\")")[0]


def test_a_live_identical_run_is_joined():
    from magi import app as app_mod

    async def go():
        app_mod._runs.clear()
        app_mod._runs["r1"] = {
            "done": False, "cancel": asyncio.Event(), "question": "Q",
            "providers": {"chatgpt": {}, "grok": {}},
        }
        hit = app_mod._live_twin("Q", ["grok", "chatgpt"])
        other_units = app_mod._live_twin("Q", ["grok"])
        other_q = app_mod._live_twin("Q2", ["grok", "chatgpt"])
        app_mod._runs["r1"]["done"] = True
        finished = app_mod._live_twin("Q", ["grok", "chatgpt"])
        app_mod._runs.clear()
        return hit, other_units, other_q, finished

    assert asyncio.run(go()) == ("r1", None, None, None)


def _ans(pid, n):
    body = "\n".join(f"line {i} " + "x" * 60 for i in range(n // 68 + 1))[:n]
    return Answer(provider_id=pid, display_name=pid, text=body + "\nFINAL TIER LIST",
                  ok=True, state="done")


def test_synthesis_fits_the_chair_and_keeps_every_conclusion():
    answers = [_ans(p, 20_000) for p in ("chatgpt", "deepseek", "perplexity", "grok")]
    answers.append(_ans("short", 1_500))
    q = "Q" * 5_600
    full = chairman.build_prompt(q, answers)
    fit = chairman.build_prompt(q, answers, max_chars=50_000)
    assert len(full) > 80_000
    assert len(fit) <= 50_000
    # The tail survives the cut: that is where a report's summary lives.
    assert fit.count("FINAL TIER LIST") == 5
    # A short answer is never trimmed to make room for the long ones.
    assert answers[-1].text in fit
    assert "characters trimmed for length" in fit


def test_small_syntheses_are_untouched():
    answers = [_ans(p, 3_000) for p in ("a", "b")]
    assert chairman.build_prompt("Q", answers, max_chars=50_000) == chairman.build_prompt("Q", answers)


def test_the_chair_budget_is_used():
    src = (Path(chairman.__file__)).read_text(encoding="utf-8")
    assert "max_chars=prompt_budget(chairman.id)" in src


def test_todays_stock_lines_are_refusals():
    for line in (
        "The message you submitted was too long, please edit it and resubmit.",
        "I seem to be encountering an error. Can I try something else for you?",
    ):
        v = validate.validate_answer(line, "Daily macro report", display_name="X")
        assert not v.ok and v.reason == validate.Rejection.REFUSAL, line
