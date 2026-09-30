"""The workspace inventory (inventory.py): exact sizes a read-only agent
cannot measure, handed over with any task about sizes or rankings.

Found live 2026-09-29: Claude could not rank A1's programs by size (no tool
reports one), then ranked only 15 of 39 .html files because the general list
was cut. These pin both fixes.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from magi.code.agents import inventory as I
from magi.code.agents.base import Mode, Task


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path):
    _git(tmp_path, "init", "-q")
    (tmp_path / ".gitignore").write_text("node_modules/\nprofiles/\n", encoding="utf-8")
    (tmp_path / "big.html").write_text("<p>x</p>\n" * 500, encoding="utf-8")
    (tmp_path / "small.html").write_text("<p>y</p>\n", encoding="utf-8")
    (tmp_path / "app.py").write_text("print(1)\nprint(2)\n", encoding="utf-8")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "deep.html").write_text("<b>z</b>\n" * 50, encoding="utf-8")
    (tmp_path / "sub" / "img.png").write_bytes(b"\x89PNG\0\0binary")
    (tmp_path / ".env").write_text("SECRET=1\n", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "huge.js").write_text("x" * 100000, encoding="utf-8")
    (tmp_path / "profiles").mkdir()
    (tmp_path / "profiles" / "cache.bin").write_bytes(b"\0" * 5000)
    _git(tmp_path, "add", "big.html", "app.py", ".gitignore")
    return tmp_path


@pytest.mark.parametrize("prompt", [
    "Rank the programs by file size", "which file is the largest?", "biggest html files",
    "how big is index.html", "lines of code per folder", "compare the workers",
    "sort by size", "total MB in A1"])
def test_it_is_offered_for_size_and_ranking_questions(prompt):
    assert I.wants(prompt)


@pytest.mark.parametrize("prompt", ["fix the sidebar toggle", "why does login fail",
                                    "add a button to the settings sheet"])
def test_it_stays_out_of_ordinary_tasks(prompt):
    assert not I.wants(prompt)


def test_it_measures_exactly_and_skips_ignored_and_secret_files(repo):
    files = {f["path"]: f for f in I.measure(repo)}
    # Tracked AND untracked-not-ignored; never ignored folders or secrets.
    assert set(files) == {".gitignore", "big.html", "small.html", "app.py",
                          "sub/deep.html", "sub/img.png"}
    assert files["big.html"]["bytes"] == (repo / "big.html").stat().st_size
    assert files["big.html"]["lines"] == 500
    assert files["app.py"]["lines"] == 2
    assert files["sub/img.png"]["lines"] is None, "binary: no line count"
    assert list(files)[0] == "big.html", "largest first"


def test_the_block_lists_root_files_folders_and_types(repo):
    b = I.block(repo)
    assert "WORKSPACE INVENTORY" in b and "not estimated" in b
    assert "TOTAL: 6 files" in b
    root = b.split("FILES AT THE TOP LEVEL", 1)[1].split("BY FOLDER", 1)[0]
    assert "big.html" in root and "small.html" in root and "deep.html" not in root
    assert "sub/" in b.split("BY FOLDER", 1)[1]
    assert ".html" in b.split("BY FILE TYPE", 1)[1]
    # The header NAMES node_modules as excluded; what matters is no file from it.
    assert "huge.js" not in b and "cache.bin" not in b and "  .env" not in b


def test_a_named_type_is_listed_in_full_first(repo):
    assert I.named_types("rank all the .html files by size") == [".html", ".htm"]
    assert I.named_types("which python files are biggest") == [".py"]
    assert ".js" in I.named_types("compare the javascript modules")
    assert I.named_types("e.g. fix Node.js startup") == []
    b = I.block(repo, prompt="rank all the .html files")
    assert b.startswith("EVERY .html / .htm FILE"), "ahead of the general list"
    typed = b.split("WORKSPACE INVENTORY", 1)[0]
    assert "ALL 3 of them" in typed
    for name in ("big.html", "small.html", "sub/deep.html"):
        assert name in typed
    assert "app.py" not in typed


def test_a_named_type_is_never_cut_short_by_the_general_budget(tmp_path):
    # The live failure: 39 .html files, 15 ranked. 60 here, all listed.
    _git(tmp_path, "init", "-q")
    for i in range(60):
        (tmp_path / f"page{i:02}.html").write_text("x" * (i + 1), encoding="utf-8")
    for i in range(300):
        (tmp_path / f"f{i:03}.txt").write_text("y" * 5000, encoding="utf-8")
    b = I.block(tmp_path, prompt="rank the .html pages")
    typed = b.split("WORKSPACE INVENTORY", 1)[0]
    assert typed.count(".html\n") + typed.rstrip().endswith(".html") >= 60 or \
        all(f"page{i:02}.html" in typed for i in range(60))
    assert "cut at" not in typed


def test_a_type_with_no_files_says_so(repo):
    assert "none in this workspace" in I.block(repo, prompt="rank the .rs files")


def test_it_reaches_cli_and_browser_agents():
    t = Task("t", "rank them", Path("."), mode=Mode.READ, inventory="WORKSPACE INVENTORY x")
    assert t.full_prompt().endswith("WORKSPACE INVENTORY x")
    from magi.code.agents.browser import BrowserUnitAgent
    agent = BrowserUnitAgent.__new__(BrowserUnitAgent)
    assert "WORKSPACE INVENTORY x" in agent.build_prompt(t, "ctx")
    assert "WORKSPACE INVENTORY" not in Task("t", "hi", Path(".")).full_prompt()


def test_it_is_fast_enough_on_this_repository():
    import time
    root = Path(__file__).resolve().parents[2]
    t0 = time.monotonic()
    b = I.block(root, prompt="rank the .html files")
    assert time.monotonic() - t0 < 10
    assert "index.html" in b and "magi.html" in b
    assert len(b) < I.MAX_BYTES + I.MAX_TYPE_BYTES + 2000
