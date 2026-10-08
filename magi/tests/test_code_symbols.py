"""Track V7: the project map browser units are shown -- what is defined where."""

from __future__ import annotations

import os
from pathlib import Path

from magi.code.agents import context as C
from magi.code.agents import symbols as S


def test_python_top_level_and_methods_with_their_class():
    src = ("import x\n\nclass App:\n    def run(self):\n        def inner():\n            pass\n"
           "    async def stop(self):\n        pass\n\ndef main():\n    def helper():\n        pass\n"
           "\nasync def serve():\n    pass\n")
    assert S.outline_text(src, "py") == [("App", 3), ("App.run", 4), ("App.stop", 7),
                                         ("main", 10), ("serve", 14)]


def test_javascript_functions_classes_arrows_and_types():
    src = ("function a() {}\nexport async function b() {}\nclass C {}\n"
           "const d = (x) => x;\nexport const e = async function () {};\nlet f = g => g;\n"
           "const notAFunction = 3;\n      function deeplyNested() {}\nexport interface I {}\n"
           "type T = string;\n")
    assert [n for n, _ in S.outline_text(src, "js")] == ["a", "b", "C", "d", "e", "f", "I", "T"]


def test_go_rust_java_ruby_php_markdown_shell():
    assert [n for n, _ in S.outline_text("func (s *S) Run() {}\ntype S struct {}\nfunc main() {}\n", "go")] \
        == ["Run", "S", "main"]
    assert [n for n, _ in S.outline_text("pub fn a() {}\nstruct B;\nimpl B {\n}\nenum E {}\n", "rs")] \
        == ["a", "B", "B", "E"]
    assert [n for n, _ in S.outline_text("public class Foo {\n  private enum Bar {}\n}\n", "java")] \
        == ["Foo", "Bar"]
    assert [n for n, _ in S.outline_text("module M\n  class K\n    def go!\n", "rb")] == ["M", "K", "go!"]
    assert [n for n, _ in S.outline_text("<?php\nfunction f() {}\nclass G {}\n", "php")] == ["f", "G"]
    assert S.outline_text("# Title\ntext\n## Part two ##\n#### too deep\n", "md") == [
        ("Title", 1), ("Part two", 3)]
    assert [n for n, _ in S.outline_text("deploy() {\n}\nfunction Build-It {\n}\n", "sh")] \
        == ["deploy", "Build-It"]


def test_the_cache_reads_only_what_changed(tmp_path, monkeypatch):
    root = tmp_path / "p"
    root.mkdir()
    (root / "a.py").write_text("def a():\n    pass\n")
    (root / "b.py").write_text("def b():\n    pass\n")
    cache = tmp_path / "map.json"
    assert S.outline(root, ["a.py", "b.py"], cache=cache) == {"a.py": [("a", 1)], "b.py": [("b", 1)]}
    reads = []
    real = Path.read_bytes

    def spy(self):
        reads.append(self.name)
        return real(self)
    monkeypatch.setattr(Path, "read_bytes", spy)
    (root / "b.py").write_text("def b2():\n    pass\n\ndef b3():\n    pass\n")
    got = S.outline(root, ["a.py", "b.py"], cache=cache)
    assert reads == ["b.py"], "only the changed file is read again"
    assert got["b.py"] == [("b2", 1), ("b3", 4)] and got["a.py"] == [("a", 1)]


def test_big_files_and_unknown_kinds_are_left_out(tmp_path, monkeypatch):
    root = tmp_path / "p"
    root.mkdir()
    (root / "data.csv").write_text("a,b\n")
    (root / "huge.py").write_text("def x():\n    pass\n")
    monkeypatch.setattr(S, "MAX_FILE", 5)
    assert S.outline(root, ["data.csv", "huge.py"], cache=tmp_path / "m.json") == {}


def test_a_crowded_file_shows_the_symbols_naming_the_task_first():
    syms = [(f"fn{i}", i) for i in range(1, 500)] + [("renderCodeApproval", 900)]
    chosen, more = S.pick(syms, ["approval"], 10)
    assert ("renderCodeApproval", 900) in chosen and len(chosen) == 10 and more == 490
    assert chosen == sorted(chosen, key=lambda s: s[1]), "shown in file order"


def test_render_leads_with_the_ranking_and_stays_in_budget():
    syms = {f"f{i:03}.py": [("x", 1), ("y", 2)] for i in range(300)}
    syms["z_relevant.py"] = [("target", 7)]
    out = S.render(syms, ["z_relevant.py"], 500)
    assert out.startswith("z_relevant.py: target@7") and len(out) < 600
    assert out.splitlines()[-1].startswith("… ") and "more files not shown" in out


def test_units_get_the_map_in_their_context(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "_cache_file", lambda root: tmp_path / "map.json")
    root = tmp_path / "proj"
    (root / "pkg").mkdir(parents=True)
    (root / "pkg" / "billing.py").write_text("class Invoice:\n    def total(self):\n        pass\n")
    (root / "README.md").write_text("# Proj\n")
    pl = C.plan(root, "how is the invoice total computed")
    assert pl.symbols["pkg/billing.py"] == [("Invoice", 1), ("Invoice.total", 2)]
    text = C.compose(root, pl, [], upload=False, budget=20_000).text
    assert "PROJECT MAP" in text and "pkg/billing.py: Invoice@1, Invoice.total@2" in text


def test_a_broken_map_never_breaks_the_plan(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("x")
    monkeypatch.setattr(S, "outline", boom)
    root = tmp_path / "p"
    root.mkdir()
    (root / "a.py").write_text("def a():\n    pass\n")
    pl = C.plan(root, "a")
    assert pl.symbols == {} and "PROJECT MAP" not in C.compose(root, pl, [], upload=False,
                                                               budget=10_000).text


def test_the_first_run_writes_the_cache_and_old_maps_are_trimmed(tmp_path, monkeypatch):
    """Found in V7: with no cache file yet, nothing was ever written."""
    maps = tmp_path / "maps"
    maps.mkdir()
    monkeypatch.setattr(S, "_cache_file", lambda root: maps / "this.json")
    monkeypatch.setattr(S, "KEEP_MAPS", 3)
    for i in range(5):
        (maps / f"old{i}.json").write_text("{}")
        os.utime(maps / f"old{i}.json", (1000 + i, 1000 + i))
    root = tmp_path / "p"
    root.mkdir()
    (root / "a.py").write_text("def a():\n    pass\n")
    S.outline(root, ["a.py"])
    left = sorted(p.name for p in maps.glob("*.json"))
    assert "this.json" in left and len(left) == 3 and "old0.json" not in left
