"""Track W1: a project's CLAUDE.md / AGENTS.md reach every agent."""

from __future__ import annotations

import asyncio

from magi.code import instructions as I
from magi.code.agents import browser
from magi.code.agents.base import Mode, Task
from tests.test_code_agents import _Ans, _ScriptedUnit


def _tree(tmp_path):
    top = tmp_path / "repo"
    ws = top / "apps" / "web"
    (ws / ".claude").mkdir(parents=True)
    (top / "docs").mkdir()
    (top / "CLAUDE.md").write_text("TOP RULE: tabs not spaces.\nSee @docs/style.md for style.\n")
    (top / "docs" / "style.md").write_text("STYLE RULE: no emoji.\n@docs/deeper.md\n")
    (top / "docs" / "deeper.md").write_text("DEEP RULE.\n@docs/deepest.md\n")
    (top / "docs" / "deepest.md").write_text("TOO DEEP.\n")
    (ws / "CLAUDE.md").write_text("WEB RULE: use pnpm.\n@../../../outside.md\n@.env.md\n")
    (ws / ".claude" / "CLAUDE.md").write_text("WEB2 RULE.\n")
    (ws / "AGENTS.md").write_text("AGENT RULE.\n")
    (ws / "CLAUDE.local.md").write_text("LOCAL RULE.\n")
    (ws / ".env.md").write_text("SECRET=1\n")
    (tmp_path / "outside.md").write_text("OUTSIDE RULE.\n")
    return top, ws


def test_parents_first_then_nearer_with_imports_inside_the_repo_only(tmp_path):
    top, ws = _tree(tmp_path)
    text, files = I.load(ws, top)
    assert files == ["CLAUDE.md", "apps/web/CLAUDE.md", "apps/web/.claude/CLAUDE.md",
                     "apps/web/CLAUDE.local.md", "apps/web/AGENTS.md"]
    order = [text.index(s) for s in ("TOP RULE", "STYLE RULE", "DEEP RULE", "WEB RULE",
                                     "WEB2 RULE", "LOCAL RULE", "AGENT RULE")]
    assert order == sorted(order)
    assert "TOO DEEP" not in text, "imports stop two levels down"
    assert "OUTSIDE RULE" not in text, "never outside the repository"
    assert "SECRET=1" not in text, "never a secret-looking file"


def test_none_and_the_cap(tmp_path):
    assert I.load(tmp_path) == ("", [])
    (tmp_path / "CLAUDE.md").write_text("x" * 50 + "\n" + "y" * 5000)
    text, _ = I.load(tmp_path, limit=1000)
    assert len(text) < 1300 and "did not fit" in text


def test_the_same_text_twice_is_given_once(tmp_path):
    (tmp_path / "CLAUDE.md").write_text("SAME RULE\n")
    (tmp_path / "AGENTS.md").write_text("SAME RULE\n")
    text, files = I.load(tmp_path)
    assert files == ["CLAUDE.md"] and text.count("SAME RULE") == 1


def test_a_cli_agent_is_given_them_before_the_task(tmp_path):
    t = Task("t", "Fix the bug.", tmp_path, Mode.WRITE, instructions="===== CLAUDE.md =====\nUSE PNPM")
    p = t.prompt_for("codex:codex1")
    assert "PROJECT INSTRUCTIONS" in p and "USE PNPM" in p
    assert p.index("USE PNPM") < p.index("Fix the bug.")
    assert "PROJECT INSTRUCTIONS" not in Task("t", "q", tmp_path).prompt_for("x")


def test_a_browser_unit_is_given_them_within_its_share(tmp_path, monkeypatch):
    from magi.providers import registry
    unit = _ScriptedUnit([_Ans("Done.")])
    monkeypatch.setattr(registry, "build_provider", lambda s, u: unit)
    monkeypatch.setattr(browser, "_staging_root", lambda: tmp_path / "stage")
    root = tmp_path / "ws"
    root.mkdir()
    big = "RULE ONE\n" + ("filler line\n" * 2000)
    task = Task("t", "q", root, Mode.READ, instructions=big)

    async def emit(e):
        pass
    asyncio.run(browser.BrowserUnitAgent("deepseek", "DeepSeek", settings=None)
                .run(task, emit=emit, cancel=asyncio.Event()))
    p = unit.asks[0]["prompt"]
    assert "PROJECT INSTRUCTIONS" in p and "RULE ONE" in p and "did not fit" in p
    assert len(p) < len(big)
