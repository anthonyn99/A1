"""Track W4: what's open -- the viewer's file and selection go with the message."""

from __future__ import annotations

from pathlib import Path

import pytest

from magi.code import editor as E
from magi.code.agents.base import Mode, Task


def _proj(tmp_path: Path) -> Path:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.py").write_text("".join(f"line {i}\n" for i in range(1, 11)), encoding="utf-8")
    (tmp_path / ".env").write_text("KEY=secret\n", encoding="utf-8")
    (tmp_path / "pic.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00")
    return tmp_path


def test_read_a_file(tmp_path):
    root = _proj(tmp_path)
    r = E.read(root, "src/a.py")
    assert r["ok"] and r["path"] == "src/a.py" and r["lines"] == 10
    assert E.read(root, "./src\\a.py")["path"] == "src/a.py"


@pytest.mark.parametrize("rel", ["../outside.txt", "/etc/passwd", "C:/Windows/win.ini",
                                 ".env", "pic.png", "missing.py", "", "src"])
def test_read_refuses_what_an_agent_could_not_see(tmp_path, rel):
    root = _proj(tmp_path)
    (tmp_path.parent / "outside.txt").write_text("no", encoding="utf-8")
    r = E.read(root, rel)
    assert not r["ok"] and "text" not in r, rel


def test_read_refuses_a_link_out(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    out = tmp_path / "secret.py"
    out.write_text("x = 1\n", encoding="utf-8")
    try:
        (root / "link.py").symlink_to(out)
    except OSError:
        pytest.skip("symlinks need privileges here")
    assert not E.read(root, "link.py")["ok"]


def test_files_leave_secrets_out(tmp_path):
    root = _proj(tmp_path)
    got = E.files(root)
    assert "src/a.py" in got and ".env" not in got


def test_clean():
    assert E.clean(None) is None and E.clean({"path": ""}) is None
    assert E.clean({"path": "a.py"}) == {"path": "a.py", "start": 0, "end": 0}
    assert E.clean({"path": "a.py", "start": 7, "end": 3}) == {"path": "a.py", "start": 3, "end": 7}
    assert E.clean({"path": "a.py", "start": 4}) == {"path": "a.py", "start": 4, "end": 4}
    for bad in ("a.py", {"path": "a.py", "start": "x"}, {"path": "a.py", "start": -1},
                {"path": "x" * 600}):
        with pytest.raises(ValueError):
            E.clean(bad)


def test_block_with_and_without_a_selection(tmp_path):
    root = _proj(tmp_path)
    text, ed = E.block(root, {"path": "src/a.py", "start": 3, "end": 4})
    assert ed == {"path": "src/a.py", "start": 3, "end": 4}
    assert text.startswith("OPEN IN THE EDITOR") and "src/a.py (10 lines)" in text
    assert "SELECTED: lines 3-4" in text
    assert "    3  line 3\n    4  line 4\n>>>" in text and "line 5" not in text
    text, ed = E.block(root, {"path": "src/a.py", "start": 0, "end": 0})
    assert ed["start"] == 0 and "No lines are selected" in text and "line 1" not in text
    # A selection past the end is clipped to the file.
    text, ed = E.block(root, {"path": "src/a.py", "start": 9, "end": 50})
    assert ed["end"] == 10 and "lines 9-10" in text
    # A file that cannot be read is not mentioned at all.
    assert E.block(root, {"path": ".env", "start": 1, "end": 1}) == ("", None)
    assert E.block(root, None) == ("", None)


def test_block_caps_a_huge_selection(tmp_path):
    (tmp_path / "big.txt").write_text("".join(f"{i}\n" for i in range(1, 2001)), encoding="utf-8")
    text, ed = E.block(tmp_path, {"path": "big.txt", "start": 1, "end": 2000})
    assert ed["end"] == E.MAX_SEL_LINES and f"the first {E.MAX_SEL_LINES} shown" in text
    (tmp_path / "wide.txt").write_text(("x" * 5000 + "\n") * 50, encoding="utf-8")
    text, ed = E.block(tmp_path, {"path": "wide.txt", "start": 1, "end": 50})
    assert len(text) < E.MAX_SEL_CHARS + 1000 and "shortened to fit" in text and ed["end"] >= 1


def test_every_agent_is_given_it(tmp_path):
    from magi.code.agents.browser import BrowserUnitAgent
    blk, _ = E.block(_proj(tmp_path), {"path": "src/a.py", "start": 2, "end": 2})
    t = Task(id="t", prompt="what does this do?", root=tmp_path, mode=Mode.READ,
             editor=blk, editor_path="src/a.py")
    assert blk in t.full_prompt()
    assert t.full_prompt().index("what does this do?") < t.full_prompt().index("OPEN IN THE EDITOR")
    t.resume = {"agent": "claude:x", "sid": "s", "why": "followup"}
    assert blk in t.resumed_prompt()
    # The open file steers what a browser unit is shown, first.
    assert "src/a.py" in t.gather_text()
    unit = BrowserUnitAgent.__new__(BrowserUnitAgent)
    unit.unit_id = "deepseek"
    assert blk in unit.build_prompt(t, "")
