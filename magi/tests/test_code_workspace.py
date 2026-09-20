"""Code Mode's workspace registry: what a project is, and where it lives.

Nothing in this phase writes into a project or runs a command. What it does do
is decide **which folder MAGI will later be allowed to change**, and that is
worth being careful about now, while a mistake is still one row in a database
rather than a deleted directory.

The two things this file is really about:

  1. **Path validation refuses the dangerous slips by name.** A drive root, a
     system folder, MAGI's own engine directory. None of these are the real
     containment -- that is the agent's cwd plus a PreToolUse hook, later --
     but a workspace that was never registered cannot be worked in at all.

  2. **The fingerprint is cheap and honest.** It exists so a task never
     re-walks a tree to find out what it is looking at. If it moved on every
     edit the cache would be useless; if it failed to move on a commit the
     cache would be WRONG, which is worse.
"""

from __future__ import annotations

import json
import subprocess

import pytest

from magi.code import workspace as W


# ── path validation ────────────────────────────────────────────────────────

def test_a_real_folder_resolves(tmp_path):
    (tmp_path / "proj").mkdir()
    assert W.resolve_root(str(tmp_path / "proj")) == (tmp_path / "proj").resolve()


def test_quotes_and_whitespace_are_forgiven(tmp_path):
    """Paths get pasted from Explorer, which wraps them in quotes."""
    d = tmp_path / "proj"
    d.mkdir()
    assert W.resolve_root(f'  "{d}"  ') == d.resolve()


def test_a_missing_folder_says_so(tmp_path):
    with pytest.raises(W.WorkspaceError) as e:
        W.resolve_root(str(tmp_path / "nope"))
    assert e.value.code == "missing"


def test_a_file_is_not_a_workspace(tmp_path):
    f = tmp_path / "x.txt"
    f.write_text("hi", encoding="utf-8")
    with pytest.raises(W.WorkspaceError) as e:
        W.resolve_root(str(f))
    assert e.value.code == "not_a_dir"


def test_a_whole_drive_is_refused():
    """The one slip where "delete the build output" could mean the disk."""
    with pytest.raises(W.WorkspaceError) as e:
        W.resolve_root("C:/")
    assert e.value.code == "drive_root"


def test_system_folders_are_refused():
    for bad in ("C:/Windows", "C:/Windows/System32", "C:/Program Files"):
        with pytest.raises(W.WorkspaceError) as e:
            W.resolve_root(bad)
        assert e.value.code == "system_path", bad


def test_magis_own_directory_is_refused():
    """An agent editing the engine it is running inside is a class of problem
    best not opened at all."""
    from magi.settings import ROOT
    for bad in (ROOT, ROOT / "config", ROOT / "providers"):
        with pytest.raises(W.WorkspaceError) as e:
            W.resolve_root(str(bad))
        assert e.value.code == "inside_magi", bad


def test_nothing_is_empty(tmp_path):
    for bad in ("", "   ", '""'):
        with pytest.raises(W.WorkspaceError) as e:
            W.resolve_root(bad)
        assert e.value.code == "empty"


def test_every_refusal_carries_a_sentence():
    """"Invalid path" sends you to check the spelling of a path that is
    spelled correctly."""
    for bad in ("C:/", "C:/Windows", ""):
        try:
            W.resolve_root(bad)
        except W.WorkspaceError as e:
            assert e.message and len(e.message) > 12 and e.code
        else:
            raise AssertionError(f"{bad} was accepted")


# ── the fingerprint ────────────────────────────────────────────────────────

def _git(d, *args):
    subprocess.run(["git", "-C", str(d), *args], capture_output=True, check=False)


@pytest.fixture
def repo(tmp_path):
    d = tmp_path / "repo"
    d.mkdir()
    _git(d, "init", "-q")
    _git(d, "config", "user.email", "t@example.com")
    _git(d, "config", "user.name", "T")
    (d / "a.txt").write_text("one", encoding="utf-8")
    _git(d, "add", "-A")
    _git(d, "commit", "-qm", "first")
    return d


def test_a_repo_is_recognised(repo):
    info = W.git_info(repo)
    assert info["repo"] is True
    assert info["branch"]
    assert len(info["head"]) == 12


def test_a_plain_folder_is_not_a_repo(tmp_path):
    (tmp_path / "plain").mkdir()
    assert W.git_info(tmp_path / "plain") == {"repo": False}


def test_the_fingerprint_is_stable_across_a_no_op(repo):
    assert W.fingerprint(repo) == W.fingerprint(repo)


def test_editing_a_file_does_NOT_move_it(repo):
    """Deliberate. The skeleton caches a project's SHAPE, and editing one file
    does not change the shape -- if it invalidated the cache, the cache would
    be rebuilt on every keystroke and buy nothing."""
    before = W.fingerprint(repo)
    (repo / "a.txt").write_text("changed", encoding="utf-8")
    assert W.fingerprint(repo) == before


def test_adding_a_file_moves_it(repo):
    before = W.fingerprint(repo)
    (repo / "b.txt").write_text("two", encoding="utf-8")
    _git(repo, "add", "-A")
    assert W.fingerprint(repo) != before


def test_committing_moves_it(repo):
    (repo / "b.txt").write_text("two", encoding="utf-8")
    _git(repo, "add", "-A")
    before = W.fingerprint(repo)
    _git(repo, "commit", "-qm", "second")
    assert W.fingerprint(repo) != before


def test_a_folder_with_no_git_still_fingerprints(tmp_path):
    d = tmp_path / "plain"
    d.mkdir()
    (d / "x").write_text("x", encoding="utf-8")
    fp = W.fingerprint(d)
    assert fp.startswith("nogit:")
    assert W.fingerprint(d) == fp


# ── the shape ──────────────────────────────────────────────────────────────

def test_the_tree_skips_the_enormous_and_uninteresting(tmp_path):
    d = tmp_path / "p"
    (d / "node_modules" / "left-pad").mkdir(parents=True)
    (d / ".git" / "objects").mkdir(parents=True)
    (d / "src").mkdir()
    (d / "src" / "main.py").write_text("x", encoding="utf-8")
    t = W.build_tree(d)
    names = [n["n"] for n in t["tree"]]
    assert "src" in names
    assert "node_modules" not in names, "40,000 files would drown the listing"
    assert ".git" not in names


def test_the_tree_is_capped_and_says_when_it_truncates(tmp_path):
    d = tmp_path / "big"
    d.mkdir()
    for i in range(50):
        (d / f"f{i}.txt").write_text("x", encoding="utf-8")
    t = W.build_tree(d, cap=20)
    assert t["truncated"] is True
    assert t["entries"] <= 20, "a cap that is a suggestion is not a cap"


def test_dotfolders_worth_seeing_are_kept(tmp_path):
    d = tmp_path / "p"
    (d / ".github" / "workflows").mkdir(parents=True)
    (d / ".hidden").mkdir()
    names = [n["n"] for n in W.build_tree(d)["tree"]]
    assert ".github" in names
    assert ".hidden" not in names


def test_the_stack_is_detected_from_the_top_level(tmp_path):
    d = tmp_path / "p"
    d.mkdir()
    (d / "package.json").write_text("{}", encoding="utf-8")
    (d / "pyproject.toml").write_text("", encoding="utf-8")
    stack = W.detect_stack(d)
    assert "node" in stack and "python" in stack


# ── the picker ─────────────────────────────────────────────────────────────

def test_browse_lists_folders_only(tmp_path):
    d = tmp_path / "here"
    d.mkdir()
    (d / "sub").mkdir()
    (d / "file.txt").write_text("x", encoding="utf-8")
    out = W.browse(str(d))
    names = [x["name"] for x in out["dirs"]]
    assert names == ["sub"]
    assert out["up"] == str(tmp_path)


def test_browse_flags_repositories(tmp_path, repo):
    out = W.browse(str(repo.parent))
    hit = next(x for x in out["dirs"] if x["name"] == "repo")
    assert hit["repo"] is True, "'which of these is the project' is nearly always 'the repo'"


def test_browse_never_returns_file_contents(tmp_path):
    d = tmp_path / "p"
    d.mkdir()
    (d / "secret.txt").write_text("SHOULD-NOT-APPEAR", encoding="utf-8")
    assert "SHOULD-NOT-APPEAR" not in json.dumps(W.browse(str(d)))


def test_browse_refuses_a_file(tmp_path):
    f = tmp_path / "x.txt"
    f.write_text("x", encoding="utf-8")
    with pytest.raises(W.WorkspaceError) as e:
        W.browse(str(f))
    assert e.value.code == "not_a_dir"


# ── resolving a phrase ─────────────────────────────────────────────────────

PROJECTS = [
    {"id": "p1", "name": "A1", "aliases": ["the suite"],
     "bindings": [{"root": "C:/Users/t/Desktop/A1"}]},
    {"id": "p2", "name": "Aardvark", "aliases": [], "bindings": []},
    {"id": "p3", "name": "Project B", "aliases": ["pb"],
     "bindings": [{"root": "C:/code/beta"}]},
]


def test_an_exact_name_wins():
    assert W.resolve_project(PROJECTS, "A1")["id"] == "p1"
    assert W.resolve_project(PROJECTS, "a1")["id"] == "p1"


def test_an_alias_resolves():
    assert W.resolve_project(PROJECTS, "the suite")["id"] == "p1"
    assert W.resolve_project(PROJECTS, "pb")["id"] == "p3"


def test_a_folder_name_resolves():
    assert W.resolve_project(PROJECTS, "beta")["id"] == "p3"


def test_an_ambiguous_prefix_resolves_to_nothing():
    """Guessing which project someone meant is the one place where being
    clever picks the wrong folder to edit."""
    assert W.resolve_project(PROJECTS, "a") is None


def test_an_unambiguous_prefix_is_allowed():
    assert W.resolve_project(PROJECTS, "aard")["id"] == "p2"


def test_nothing_resolves_to_nothing():
    assert W.resolve_project(PROJECTS, "") is None
    assert W.resolve_project(PROJECTS, "nonsense") is None


# ── defaults ───────────────────────────────────────────────────────────────

def test_a_new_project_starts_read_only_and_never_commits():
    """A new project's first agent must not be able to change anything, and
    auto-commit must never arrive switched on -- A1 already commits through
    its own Stop hook, and two systems staging one tree is how one silently
    absorbs the other."""
    assert W.DEFAULT_PREFS["permissionMode"] == "plan"
    assert W.DEFAULT_PREFS["autoCommit"] is False
    assert W.DEFAULT_PREFS["autoPush"] is False


def test_project_ids_are_unique():
    assert len({W.new_project_id() for _ in range(200)}) == 200


def test_a_name_is_required():
    for bad in ("", "   ", "x" * 61, "bad\x00name"):
        with pytest.raises(W.WorkspaceError):
            W.check_name(bad)
    assert W.check_name("  A1  ") == "A1"
