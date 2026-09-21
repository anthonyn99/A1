"""MAGI's own git: status, staging, commits, and pulling before work.

Every test builds its repositories in tmp_path -- never A1. The pull tests
use a bare repository there as the "remote", so ahead/behind and pull are
real git behaviour, not mocks.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from magi.code import git as G


def _git(cwd: Path, *args: str) -> str:
    r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True,
                       encoding="utf-8")
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def _init(r: Path) -> Path:
    r.mkdir(parents=True, exist_ok=True)
    _git(r, "init", "-q", "-b", "main")
    _git(r, "config", "user.name", "t")
    _git(r, "config", "user.email", "t@t")
    _git(r, "config", "core.autocrlf", "false")
    return r


@pytest.fixture
def repo(tmp_path):
    r = _init(tmp_path / "proj")
    (r / "a.txt").write_text("one\ntwo\nthree\n")
    (r / "b.txt").write_text("bee\n")
    (r / "old name.txt").write_text("rename me please, i am long enough to score\n" * 3)
    _git(r, "add", "-A")
    _git(r, "commit", "-qm", "init")
    return r


@pytest.fixture
def remote(tmp_path):
    """A bare 'origin', our clone of it, and a second clone standing in for
    the other machine that pushes while we are not looking."""
    bare = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(bare)], check=True)
    seed = _init(tmp_path / "seed")
    (seed / "app.py").write_text("x = 1\n")
    _git(seed, "add", "-A")
    _git(seed, "commit", "-qm", "init")
    _git(seed, "remote", "add", "origin", str(bare))
    _git(seed, "push", "-q", "-u", "origin", "main")
    ours = tmp_path / "ours"
    subprocess.run(["git", "clone", "-q", str(bare), str(ours)], check=True)
    for k, v in (("user.name", "t"), ("user.email", "t@t"), ("core.autocrlf", "false")):
        _git(ours, "config", k, v)
    return {"bare": bare, "other": seed, "ours": ours}


def _push_from_other(remote, name: str, text: str, msg: str = "theirs") -> None:
    o = remote["other"]
    (o / name).write_text(text)
    _git(o, "add", "--", name)
    _git(o, "commit", "-qm", msg)
    _git(o, "push", "-q")


# ── status --porcelain=v2 -z ───────────────────────────────────────────────

def test_parse_every_record_kind_from_raw_bytes():
    raw = (b"# branch.oid 1234567890abcdef1234567890abcdef12345678\0"
           b"# branch.head feature/x\0"
           b"# branch.upstream origin/feature/x\0"
           b"# branch.ab +2 -5\0"
           b"1 .M N... 100644 100644 100644 aaa bbb src/app.py\0"
           b"1 A. N... 000000 100644 100644 000 ccc new file.txt\0"
           b"1 D. N... 100644 000000 000000 ddd 000 gone.txt\0"
           b"2 R. N... 100644 100644 100644 eee eee R87 docs/new name.md\0docs/old name.md\0"
           b"u UU N... 100644 100644 100644 100644 f1 f2 f3 both.txt\0"
           b"? caf\xc3\xa9 notes.md\0"
           b"! build/out.js\0")
    st = G.parse_status(raw)
    assert (st.branch, st.detached, st.upstream, st.ahead, st.behind) == \
        ("feature/x", False, "origin/feature/x", 2, 5)
    assert st.oid.startswith("1234567")
    kinds = [(e.kind, e.xy, e.path) for e in st.entries]
    assert kinds == [
        ("changed", ".M", "src/app.py"),
        ("changed", "A.", "new file.txt"),
        ("changed", "D.", "gone.txt"),
        ("renamed", "R.", "docs/new name.md"),
        ("unmerged", "UU", "both.txt"),
        ("untracked", "??", "café notes.md"),
        ("ignored", "!!", "build/out.js"),
    ]
    ren = st.entries[3]
    assert (ren.orig, ren.score) == ("docs/old name.md", "R87")
    assert st.conflicts == ["both.txt"]
    assert st.untracked == ["café notes.md"]
    assert st.dirty == 6, "ignored files are not dirt"
    assert [e.path for e in st.entries if e.staged] == ["new file.txt", "gone.txt", "docs/new name.md"]
    assert [e.path for e in st.entries if e.unstaged] == ["src/app.py"]


def test_parse_detached_initial_and_no_upstream():
    st = G.parse_status(b"# branch.oid (initial)\0# branch.head main\0")
    assert st.oid == "" and st.branch == "main" and st.upstream == ""
    assert st.ahead is None and st.behind is None, "no upstream is not 'up to date'"
    st = G.parse_status(b"# branch.oid abc\0# branch.head (detached)\0")
    assert st.detached and st.branch == ""


def test_status_of_a_real_tree(repo):
    (repo / "a.txt").write_text("one\nTWO\nthree\n")
    (repo / "b.txt").unlink()
    _git(repo, "mv", "old name.txt", "new näme.txt")
    (repo / "spaced out file.md").write_text("hi\n")
    (repo / "ünïcode.txt").write_text("hi\n")
    st = G.status(repo)
    by = {e.path: e for e in st.entries}
    assert by["a.txt"].xy == ".M"
    assert by["b.txt"].xy == ".D"
    assert by["new näme.txt"].kind == "renamed" and by["new näme.txt"].orig == "old name.txt"
    assert by["new näme.txt"].score.startswith("R")
    assert by["spaced out file.md"].kind == "untracked"
    assert by["ünïcode.txt"].kind == "untracked"
    assert st.branch == "main" and st.upstream == "" and st.ahead is None
    assert st.state == ""


def test_a_merge_conflict_is_enumerated(repo):
    _git(repo, "checkout", "-qb", "side")
    (repo / "a.txt").write_text("one\nSIDE\nthree\n")
    _git(repo, "commit", "-qam", "side")
    _git(repo, "checkout", "-q", "main")
    (repo / "a.txt").write_text("one\nMAIN\nthree\n")
    _git(repo, "commit", "-qam", "main")
    subprocess.run(["git", "-C", str(repo), "merge", "-q", "side"], capture_output=True)
    st = G.status(repo)
    assert st.conflicts == ["a.txt"]
    assert st.state == "merge"


def test_detached_head_is_reported(repo):
    _git(repo, "checkout", "-q", "--detach")
    st = G.status(repo)
    assert st.detached and st.branch == ""
    s = G.state(repo)
    assert s["detached"] and s["head"] == st.oid[:7]


def test_state_is_local_only_and_says_when_it_last_fetched(repo):
    s = G.state(repo)
    assert s["branch"] == "main" and s["dirty"] == 0 and s["remotes"] == []
    assert s["fetched_at"] is None, "never fetched is said, not guessed"
    assert s["subject"] == "init"


def test_state_of_a_folder_that_is_not_a_repo(tmp_path):
    with pytest.raises(G.GitError) as e:
        G.state(tmp_path)
    assert e.value.code == "not_git"


def test_ahead_and_behind_against_a_real_remote(remote):
    ours = remote["ours"]
    assert (G.status(ours).ahead, G.status(ours).behind) == (0, 0)
    _push_from_other(remote, "theirs.py", "t = 1\n")
    _git(ours, "fetch", "-q")
    (ours / "mine.py").write_text("m = 1\n")
    _git(ours, "add", "mine.py")
    _git(ours, "commit", "-qm", "mine")
    st = G.status(ours)
    assert (st.upstream, st.ahead, st.behind) == ("origin/main", 1, 1)
    assert G.state(ours)["fetched_at"] is not None


# ── staging: explicit paths, never the whole tree ──────────────────────────

@pytest.mark.parametrize("bad", [[], ["."], ["./"], ["*"], [":/"], [":(glob)**"],
                                 ["../x"], ["a/../../x"], ["/etc/passwd"], ["C:/x"],
                                 [".git/config"], ["-A"], ["a.txt", "."]])
def test_staging_refuses_anything_but_plain_paths(repo, bad):
    with pytest.raises(G.GitError):
        G.stage(repo, bad)
    assert _git(repo, "diff", "--cached", "--name-only") == ""


def test_staging_never_uses_add_all(repo, monkeypatch):
    seen = []
    real = G.run

    def spy(cwd, *args, **kw):
        seen.append(args)
        return real(cwd, *args, **kw)

    monkeypatch.setattr(G, "run", spy)
    (repo / "a.txt").write_text("changed\n")
    (repo / "b.txt").write_text("also changed, NOT asked for\n")
    G.stage(repo, ["a.txt"])
    adds = [a for a in seen if "add" in a]
    assert adds and all("-A" not in a and "." not in a and "--all" not in a for a in adds)
    assert all(a[a.index("--") + 1:] == ("a.txt",) for a in adds)
    assert _git(repo, "diff", "--cached", "--name-only") == "a.txt"


def test_a_file_named_like_a_wildcard_is_just_that_file(repo):
    (repo / "x[1].txt").write_text("1\n")
    (repo / "x1.txt").write_text("1\n")
    G.stage(repo, ["x[1].txt"])
    assert _git(repo, "diff", "--cached", "--name-only") == "x[1].txt"


# ── committing exactly the approved files ─────────────────────────────────

def test_commit_takes_exactly_the_named_paths(repo):
    (repo / "a.txt").write_text("approved change\n")
    (repo / "new.py").write_text("print(1)\n")
    (repo / "b.txt").unlink()                             # an approved deletion
    (repo / "unrelated.md").write_text("mine, untracked\n")
    c = G.commit(repo, ["a.txt", "new.py", "b.txt"], "Fix it\n\nBody.")
    assert len(c.sha) == 40 and c.subject == "Fix it"
    files = _git(repo, "show", "--name-status", "--format=", "HEAD").splitlines()
    assert sorted(files) == ["A\tnew.py", "D\tb.txt", "M\ta.txt"]
    assert _git(repo, "log", "-1", "--format=%B") == "Fix it\n\nBody."
    assert "?? unrelated.md" in _git(repo, "status", "--porcelain")


def test_changes_you_staged_yourself_stay_staged_and_out_of_the_commit(repo):
    (repo / "b.txt").write_text("staged by hand\n")
    _git(repo, "add", "b.txt")
    (repo / "a.txt").write_text("approved\n")
    G.commit(repo, ["a.txt"], "Only a")
    assert _git(repo, "show", "--name-only", "--format=", "HEAD") == "a.txt"
    assert _git(repo, "diff", "--cached", "--name-only") == "b.txt"


def test_the_repositorys_own_hooks_run(repo):
    hook = repo / ".git" / "hooks" / "pre-commit"
    hook.write_text("#!/bin/sh\necho ran > hook-ran.flag\n")
    hook.chmod(0o755)
    (repo / "a.txt").write_text("x\n")
    G.commit(repo, ["a.txt"], "With hooks")
    assert (repo / "hook-ran.flag").exists()


def test_a_hook_that_refuses_leaves_the_index_as_it_was(repo):
    hook = repo / ".git" / "hooks" / "pre-commit"
    hook.write_text("#!/bin/sh\necho 'no commits today' >&2\nexit 1\n")
    hook.chmod(0o755)
    (repo / "b.txt").write_text("staged by hand\n")
    _git(repo, "add", "b.txt")
    (repo / "a.txt").write_text("x\n")
    (repo / "brand new.txt").write_text("n\n")
    head = _git(repo, "rev-parse", "HEAD")
    with pytest.raises(G.GitError) as e:
        G.commit(repo, ["a.txt", "brand new.txt"], "Nope")
    assert e.value.code == "commit" and "no commits today" in e.value.message
    assert _git(repo, "rev-parse", "HEAD") == head
    assert _git(repo, "diff", "--cached", "--name-only") == "b.txt", "index restored exactly"


def test_nothing_to_commit_says_so(repo):
    with pytest.raises(G.GitError) as e:
        G.commit(repo, ["a.txt"], "Nothing")
    assert e.value.code == "nothing"


def test_an_empty_message_is_refused(repo):
    (repo / "a.txt").write_text("x\n")
    with pytest.raises(G.GitError) as e:
        G.commit(repo, ["a.txt"], "   \n")
    assert e.value.code == "no_message"


def test_no_commit_in_the_middle_of_a_merge(repo):
    _git(repo, "checkout", "-qb", "side")
    (repo / "a.txt").write_text("one\nSIDE\nthree\n")
    _git(repo, "commit", "-qam", "side")
    _git(repo, "checkout", "-q", "main")
    (repo / "a.txt").write_text("one\nMAIN\nthree\n")
    _git(repo, "commit", "-qam", "main")
    subprocess.run(["git", "-C", str(repo), "merge", "-q", "side"], capture_output=True)
    (repo / "b.txt").write_text("x\n")
    with pytest.raises(G.GitError) as e:
        G.commit(repo, ["b.txt"], "Mid-merge")
    assert e.value.code == "in_progress" and "merge" in e.value.message


def test_draft_message_subject_from_the_ask_body_from_the_summary():
    m = G.draft_message("make total() skip None values.\nand add a test",
                        "I changed total().\n\n```python\n<<<<<<< SEARCH\nx\n```\n\n\n\nDone.")
    subject, _, body = m.partition("\n\n")
    assert subject == "Make total() skip None values"
    assert "SEARCH" not in body and "I changed total()." in body and "Done." in body
    long = G.draft_message("word " * 40, "")
    assert len(long.splitlines()[0]) <= 72 and "\n" not in long
    assert G.draft_message("", "") == "Changes made in MAGI Code Mode"


# ── pull before work ──────────────────────────────────────────────────────

def test_pull_brings_in_what_the_other_machine_pushed(remote):
    _push_from_other(remote, "theirs.py", "t = 1\n")
    _push_from_other(remote, "theirs2.py", "t = 2\n", "second")
    p = G.pull(remote["ours"])
    assert p.ok and not p.skipped and p.commits == 2
    assert "Pulled 2 commits from origin/main" in p.text
    assert (remote["ours"] / "theirs2.py").exists()


def test_pull_keeps_your_uncommitted_edits(remote):
    ours = remote["ours"]
    _push_from_other(remote, "theirs.py", "t = 1\n")
    (ours / "app.py").write_text("x = 'mine, uncommitted'\n")
    p = G.pull(ours)
    assert p.ok and p.commits == 1
    assert (ours / "app.py").read_text() == "x = 'mine, uncommitted'\n"
    assert _git(ours, "stash", "list") == "", "the autostash is popped, not left behind"


def test_pull_when_up_to_date(remote):
    p = G.pull(remote["ours"])
    assert p.ok and p.commits == 0 and "Up to date with origin/main" in p.text


def test_pull_rebases_local_commits_on_top(remote):
    ours = remote["ours"]
    _push_from_other(remote, "theirs.py", "t = 1\n")
    (ours / "mine.py").write_text("m\n")
    _git(ours, "add", "mine.py")
    _git(ours, "commit", "-qm", "mine")
    p = G.pull(ours)
    assert p.ok and p.commits == 1
    assert _git(ours, "log", "--format=%s", "-3").splitlines() == ["mine", "theirs", "init"]


def test_a_pull_that_clashes_is_undone_and_names_the_files(remote):
    ours = remote["ours"]
    _push_from_other(remote, "app.py", "x = 'theirs'\n")
    (ours / "app.py").write_text("x = 'mine'\n")
    _git(ours, "commit", "-qam", "mine")
    head = _git(ours, "rev-parse", "HEAD")
    p = G.pull(ours)
    assert not p.ok and p.conflicts == ["app.py"]
    assert "undone" in p.text and "app.py" in p.text
    assert _git(ours, "rev-parse", "HEAD") == head
    assert G.in_progress(ours) == "", "no rebase is left half-done"
    assert (ours / "app.py").read_text() == "x = 'mine'\n"


def test_an_unreachable_remote_fails_with_a_reason_and_does_not_hang(remote, tmp_path):
    ours = remote["ours"]
    _git(ours, "remote", "set-url", "origin", str(tmp_path / "nowhere.git"))
    p = G.pull(ours)
    assert not p.ok and p.text.startswith("Could not pull origin/main")


@pytest.mark.parametrize("setup, words", [
    ("no_remote", "No remote"),
    ("no_upstream", "does not track"),
    ("detached", "Detached HEAD"),
])
def test_pull_is_skipped_with_a_sentence(remote, repo, setup, words):
    root = repo if setup == "no_remote" else remote["ours"]
    if setup == "no_upstream":
        _git(root, "checkout", "-qb", "local-only")
    if setup == "detached":
        _git(root, "checkout", "-q", "--detach")
    p = G.pull(root)
    assert p.ok and p.skipped and words in p.text


def test_pull_refuses_to_start_mid_rebase(remote):
    ours = remote["ours"]
    gd = ours / ".git" / "rebase-merge"
    gd.mkdir()
    try:
        p = G.pull(ours)
        assert not p.ok and "rebase" in p.text
    finally:
        gd.rmdir()


def test_fetch_only_reports_behind_and_touches_nothing(remote):
    ours = remote["ours"]
    _push_from_other(remote, "theirs.py", "t = 1\n")
    head = _git(ours, "rev-parse", "HEAD")
    p = G.fetch_only(ours)
    assert p.ok and p.skipped and "1 commit behind origin/main" in p.text
    assert _git(ours, "rev-parse", "HEAD") == head
    assert not (ours / "theirs.py").exists()


def test_network_git_never_prompts():
    env = G._env()
    assert env["GIT_TERMINAL_PROMPT"] == "0" and env["GCM_INTERACTIVE"] == "never"
