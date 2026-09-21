"""The throwaway worktree: what goes in, what comes out, and that it goes away.

Every test builds its own small repository in tmp_path -- never A1 -- and
points the sandbox base at tmp_path too, so a failing test cannot leave a
worktree registered in a real repository.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from magi.code import sandbox as SB
from magi.code import security


def _git(cwd: Path, *args: str) -> str:
    r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


@pytest.fixture
def base(tmp_path, monkeypatch):
    b = tmp_path / "sandboxes"
    monkeypatch.setattr(SB, "BASE", b)
    return b


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "proj"
    r.mkdir()
    _git(r, "init", "-q")
    _git(r, "config", "user.name", "t")
    _git(r, "config", "user.email", "t@t")
    _git(r, "config", "core.autocrlf", "false")
    (r / "a.txt").write_text("one\ntwo\nthree\nfour\nfive\nsix\nseven\n")
    (r / "web").mkdir()
    (r / "web" / "app.js").write_text("let x = 1;\n")
    (r / ".gitignore").write_text("build/\n")
    _git(r, "add", "-A")
    _git(r, "commit", "-qm", "init")
    return r


def _worktrees(repo: Path) -> int:
    return sum(1 for ln in _git(repo, "worktree", "list", "--porcelain").splitlines()
               if ln.startswith("worktree "))


# ── what the agent is given ────────────────────────────────────────────────

def test_the_agent_starts_from_your_disk_not_from_head(repo, base):
    (repo / "a.txt").write_text("one\nTWO (uncommitted)\nthree\nfour\nfive\nsix\nseven\n")
    (repo / "notes.md").write_text("untracked notes\n")
    (repo / ".env").write_text("SECRET=1\n")
    (repo / "build").mkdir()
    (repo / "build" / "out.js").write_text("ignored\n")

    sb = SB.create(repo, "t1", "tony")
    try:
        assert "TWO (uncommitted)" in (sb.cwd / "a.txt").read_text()
        assert (sb.cwd / "notes.md").read_text() == "untracked notes\n"
        assert not (sb.cwd / ".env").exists(), "secrets are not copied into a sandbox"
        assert ".env" in sb.skipped
        assert not (sb.cwd / "build").exists(), "ignored files are not copied"
        # Nothing the agent did yet -> nothing to approve, even though MAGI
        # copied untracked files in.
        assert sb.diff() == b""
    finally:
        sb.remove()
    # The real tree is exactly as it was.
    assert "TWO (uncommitted)" in (repo / "a.txt").read_text()
    assert _git(repo, "stash", "list") == ""


def test_the_diff_is_only_what_the_agent_changed(repo, base):
    (repo / "notes.md").write_text("untracked\n")
    sb = SB.create(repo, "t2", "tony")
    try:
        (sb.cwd / "a.txt").write_text("one\ntwo\nTHREE\nfour\nfive\nsix\nseven\n")
        (sb.cwd / "new.py").write_text("print(1)\n")
        (sb.cwd / "web" / "app.js").unlink()
        patch = sb.diff().decode()
        r = security.review(patch, root=repo)
        assert r.ok, r.message
        got = {f.path: f.status for f in r.files}
        assert got == {"a.txt": "modified", "new.py": "added", "web/app.js": "deleted"}
        assert "notes.md" not in patch
        assert sb.changed_files()
    finally:
        sb.remove()


# ── it goes away ───────────────────────────────────────────────────────────

def test_remove_leaves_nothing_behind(repo, base):
    sb = SB.create(repo, "t3", "tony")
    assert _worktrees(repo) == 2
    sb.remove()
    assert _worktrees(repo) == 1
    assert not sb.path.exists()
    assert not sb.marker.exists()


def test_sweep_cleans_up_after_a_crash(repo, base):
    """An engine that died mid-task leaves a worktree and a marker. The next
    start must remove both, and the repository must forget the worktree."""
    sb = SB.create(repo, "t4", "tony")
    assert sb.path.exists() and sb.marker.exists()
    assert SB.sweep("tony") >= 1
    assert not sb.path.exists()
    assert not sb.marker.exists()
    assert _worktrees(repo) == 1


def test_a_failed_create_cleans_up(repo, base, monkeypatch):
    def boom(sb):
        raise RuntimeError("disk full")
    monkeypatch.setattr(SB, "_copy_untracked", boom)
    with pytest.raises(RuntimeError):
        SB.create(repo, "t5", "tony")
    assert _worktrees(repo) == 1
    assert not list((base / "tony").glob("*.json"))


# ── refusals ───────────────────────────────────────────────────────────────

def test_a_folder_that_is_not_a_repo_is_refused(tmp_path, base):
    d = tmp_path / "plain"
    d.mkdir()
    with pytest.raises(SB.SandboxError) as e:
        SB.create(d, "t6", "tony")
    assert e.value.code == "not_git"


def test_a_repo_with_no_commits_is_refused(tmp_path, base):
    d = tmp_path / "empty"
    d.mkdir()
    _git(d, "init", "-q")
    with pytest.raises(SB.SandboxError) as e:
        SB.create(d, "t7", "tony")
    assert e.value.code == "no_commits"


def test_hooks_never_run(repo, base):
    """The worktree shares the real repo's hooks. None may fire."""
    hook = repo / ".git" / "hooks" / "post-checkout"
    fired = repo.parent / "hook-fired"
    hook.write_text(f"#!/bin/sh\necho x > '{fired.as_posix()}'\n")
    hook.chmod(0o755)
    sb = SB.create(repo, "t8", "tony")
    try:
        (sb.cwd / "a.txt").write_text("changed\n")
        sb.diff()
    finally:
        sb.remove()
    assert not fired.exists()


def test_a_subfolder_workspace_works_inside_its_folder(repo, base):
    sb = SB.create(repo / "web", "t9", "tony")
    try:
        assert sb.prefix == "web/"
        assert (sb.cwd / "app.js").exists()
        (sb.cwd / "app.js").write_text("let x = 2;\n")
        r = security.review(sb.diff().decode(), root=repo, prefix=sb.prefix)
        assert r.ok and [f.path for f in r.files] == ["web/app.js"]
    finally:
        sb.remove()


# ── applying ───────────────────────────────────────────────────────────────

def _approve(sb, repo):
    r = security.review(sb.diff().decode(), root=repo)
    assert r.ok, r.message
    return [f.to_dict() for f in r.files]


def test_apply_clean_changes_the_real_tree_and_stages_nothing(repo, base, tmp_path):
    sb = SB.create(repo, "a1", "tony")
    try:
        (sb.cwd / "a.txt").write_text("one\ntwo\nTHREE\nfour\nfive\nsix\nseven\n")
        (sb.cwd / "new.py").write_text("print(1)\n")
        res = SB.apply(sb, _approve(sb, repo), tmp_path / "patches")
    finally:
        sb.remove()
    assert res.ok and res.how == "clean"
    assert "THREE" in (repo / "a.txt").read_text()
    assert (repo / "new.py").read_text() == "print(1)\n"
    assert _git(repo, "diff", "--cached", "--name-only") == "", "nothing is staged"
    assert _git(repo, "rev-list", "--count", "HEAD") == "1", "nothing is committed"


def test_apply_merges_when_you_edited_elsewhere_in_the_same_file(repo, base, tmp_path):
    sb = SB.create(repo, "a2", "tony")
    try:
        (sb.cwd / "a.txt").write_text("one\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n")
        files = _approve(sb, repo)
        # Meanwhile you changed the top of the same file on the real disk,
        # close enough that the patch's context no longer matches.
        (repo / "a.txt").write_text("ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n")
        res = SB.apply(sb, files, tmp_path / "patches")
    finally:
        sb.remove()
    assert res.ok, res.message
    assert (repo / "a.txt").read_text() == "ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n"


def test_a_real_conflict_applies_nothing_and_keeps_the_patch(repo, base, tmp_path):
    sb = SB.create(repo, "a3", "tony")
    try:
        (sb.cwd / "a.txt").write_text("one\ntwo\nAGENT\nfour\nfive\nsix\nseven\n")
        (sb.cwd / "new.py").write_text("print(1)\n")
        files = _approve(sb, repo)
        (repo / "a.txt").write_text("one\ntwo\nYOU\nfour\nfive\nsix\nseven\n")
        res = SB.apply(sb, files, tmp_path / "patches")
    finally:
        sb.remove()
    assert not res.ok
    assert res.conflicts == ["a.txt"]
    assert (repo / "a.txt").read_text() == "one\ntwo\nYOU\nfour\nfive\nsix\nseven\n"
    assert not (repo / "new.py").exists(), "all or nothing"
    saved = Path(res.saved_patch)
    assert saved.exists() and b"AGENT" in saved.read_bytes()


def test_apply_respects_crlf_working_copies(tmp_path, base):
    """autocrlf is on for this machine's git: the real file has CRLF, the
    patch is LF. The applied file must keep CRLF, not flip to LF."""
    r = tmp_path / "crlf"
    r.mkdir()
    _git(r, "init", "-q")
    _git(r, "config", "user.name", "t")
    _git(r, "config", "user.email", "t@t")
    _git(r, "config", "core.autocrlf", "true")
    (r / "a.txt").write_bytes(b"one\r\ntwo\r\nthree\r\n")
    _git(r, "add", "-A")
    _git(r, "commit", "-qm", "init")
    sb = SB.create(r, "c1", "tony")
    try:
        (sb.cwd / "a.txt").write_bytes(b"one\r\nTWO\r\nthree\r\n")
        files = _approve(sb, r)
        res = SB.apply(sb, files, tmp_path / "patches")
    finally:
        sb.remove()
    assert res.ok, res.message
    assert (r / "a.txt").read_bytes() == b"one\r\nTWO\r\nthree\r\n"


def test_the_engine_repo_is_recognised(tmp_path):
    from magi.settings import ROOT
    assert SB.is_engine_repo(ROOT.parent)
    assert not SB.is_engine_repo(tmp_path)
