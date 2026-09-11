"""What the chairman is told, and why each instruction is load-bearing.

The prompt is the only thing standing between four independent answers and a
verdict that misreports them, and it is not covered by any other test -- so
the two claims that have actually been got wrong in use are pinned here.
"""

from magi.engine.chairman import build_prompt
from magi.providers.base import Answer, ProviderState


def _ok(pid: str, name: str, text: str) -> Answer:
    return Answer(
        provider_id=pid, display_name=name, text=text,
        ok=True, state=ProviderState.DONE, chars=len(text),
    )


def _prompt(*answers: Answer) -> str:
    return build_prompt("what ai are you?", list(answers))


def test_per_member_questions_are_not_merged():
    """Asked "what ai are you?", the verdict read "I'm GPT-5.6 Luna".

    Both members had answered, each correctly about ITSELF. The chairman
    resolved the "disagreement" by picking one, which states something false
    about the other. A question about the responder has no disagreement to
    resolve, and the prompt has to say so -- the merge instruction two
    paragraphs above is otherwise an explicit instruction to do the wrong
    thing.
    """
    p = _prompt(_ok("chatgpt", "ChatGPT", "I'm GPT."), _ok("gemini", "Gemini", "I'm Gemini."))
    assert "WHEN THE MEMBERS ARE NOT ANSWERING THE SAME QUESTION" in p
    assert "one short line per member" in p
    # And it must lift the blanket ban on naming members, or the two
    # instructions contradict each other and the model picks one.
    assert "overrides the rule below" in p
    # Without this, "most questions are like that" is a live misreading.
    assert "Most questions are NOT of this kind" in p


def test_the_headcount_is_always_stated():
    """A verdict built from 2 of 4 must never read as though built from 4."""
    p = _prompt(
        _ok("chatgpt", "ChatGPT", "a"),
        _ok("gemini", "Gemini", "b"),
        Answer.failed("claude", "Claude", None, "timed out"),
    )
    assert "2 of 3 members responded" in p
    assert "Claude" in p


def test_a_degraded_member_caps_confidence_and_its_text_is_withheld():
    """Excluded text must not come back in through the chairman's prompt.

    It is the thing validation judged unusable; pasting it in would reintroduce
    exactly what was excluded.
    """
    bad = Answer.degraded_capture(
        "deepseek", "DeepSeek", "Could you clarify what you mean?", "asked a question back"
    )
    p = _prompt(_ok("chatgpt", "ChatGPT", "a"), _ok("gemini", "Gemini", "b"), bad)
    assert "Could you clarify" not in p
    assert "at most MEDIUM" in p
    assert "excluded for an unusable response: DeepSeek" in p
