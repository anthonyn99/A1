"""The gate between an agent's throwaway copy and the real workspace.

Written BEFORE the code it tests, on purpose: this is the one check that
stands between "an agent edited a copy" and "a file on disk changed". Every
case below is refused before an approval card is ever drawn -- a person should
not be asked whether to allow a write into .git/ or an SSH key, because the
right answer never depends on the diff.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from magi.code import security as S


def _patch(path: str, body: str = "+hello\n", *, new: bool = True,
           mode: str = "100644", b_path: str | None = None) -> str:
    b = b_path or path
    head = f"diff --git a/{path} b/{b}\n"
    if new:
        head += f"new file mode {mode}\nindex 0000000..e69de29\n--- /dev/null\n+++ b/{b}\n"
    else:
        head += f"index e69de29..ce01362 {mode}\n--- a/{path}\n+++ b/{b}\n"
    n = body.count("\n")
    return head + f"@@ -0,0 +1,{n} @@\n" + body


OK_EDIT = (
    "diff --git a/src/app.py b/src/app.py\n"
    "index 1111111..2222222 100644\n"
    "--- a/src/app.py\n"
    "+++ b/src/app.py\n"
    "@@ -1,3 +1,3 @@\n"
    " one\n"
    "-two\n"
    "+TWO\n"
    " three\n"
)


# ── the happy path, so the refusals below mean something ──────────────────

def test_an_ordinary_edit_passes_and_is_counted():
    r = S.review(OK_EDIT)
    assert r.ok, r.message
    assert [f.path for f in r.files] == ["src/app.py"]
    f = r.files[0]
    assert (f.status, f.adds, f.dels) == ("modified", 1, 1)
    assert "+TWO" in f.diff


def test_new_and_deleted_files_are_labelled():
    deleted = ("diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n"
               "index ce01362..0000000\n--- a/old.txt\n+++ /dev/null\n"
               "@@ -1 +0,0 @@\n-bye\n")
    r = S.review(_patch("new.txt") + deleted)
    assert r.ok, r.message
    assert {f.path: f.status for f in r.files} == {"new.txt": "added", "old.txt": "deleted"}


def test_an_empty_diff_is_not_an_error():
    r = S.review("")
    assert r.ok and r.files == []


# ── paths that leave the workspace ─────────────────────────────────────────

@pytest.mark.parametrize("path", [
    "../x.txt", "src/../../x.txt", "..\\x.txt", "a/..",
])
def test_parent_traversal_is_refused(path):
    r = S.review(_patch(path))
    assert not r.ok
    assert r.refused and "outside" in r.refused[0][1].lower()


@pytest.mark.parametrize("path", [
    "/etc/passwd", "C:/Windows/win.ini", "C:\\Users\\x\\a.txt", "//server/share/a",
])
def test_absolute_paths_are_refused(path):
    r = S.review(_patch(path))
    assert not r.ok, path


def test_alternate_data_streams_are_refused():
    # "file.txt:hidden" writes a stream Explorer never shows you.
    assert not S.review(_patch("notes.txt:hidden")).ok


def test_a_rename_that_lands_outside_is_refused():
    """Both halves of a diff header are checked, not just the first."""
    r = S.review(_patch("ok.txt", b_path="../escaped.txt", new=False))
    assert not r.ok


# ── the deny-list: never, whatever the diff says ───────────────────────────

@pytest.mark.parametrize("path", [
    ".git/config", ".git/hooks/pre-commit", "sub/.git/HEAD",
    ".env", ".env.local", "api/.env.production",
    "home/.ssh/authorized_keys", ".ssh/config",
    "id_rsa", "keys/id_rsa.pub", "id_ed25519",
    ".claude/settings.json", ".claude/hooks/stop.sh", "pkg/.claude/x.md",
    ".codex/config.toml",
    "server.pem", "tls/private.key", ".npmrc", ".git-credentials",
    "credentials.json", "secrets.yaml",
])
def test_denied_paths_are_refused_before_approval(path):
    r = S.review(_patch(path))
    assert not r.ok, f"{path} should be refused"
    assert r.refused[0][0] == path.replace("\\", "/")


def test_one_bad_file_refuses_the_whole_diff():
    """No partial approval: a diff that tries one forbidden thing is not a
    diff with one file to untick, it is a diff not to trust."""
    r = S.review(OK_EDIT + _patch(".git/config"))
    assert not r.ok
    assert [p for p, _ in r.refused] == [".git/config"]


def test_names_that_merely_contain_a_denied_word_are_fine():
    for path in ("docs/environment.md", "src/git_utils.py", "claude_notes.txt",
                 "keyboard.py", "envelope.js"):
        assert S.review(_patch(path)).ok, path


# ── things a diff can do besides change text ───────────────────────────────

def test_creating_a_symlink_is_refused():
    r = S.review(_patch("link", body="+/etc/passwd\n", mode="120000"))
    assert not r.ok and "link" in r.refused[0][1].lower()


def test_turning_a_file_into_a_symlink_is_refused():
    p = ("diff --git a/a b/a\nold mode 100644\nnew mode 120000\n")
    assert not S.review(p).ok


def test_a_submodule_pointer_is_refused():
    p = ("diff --git a/vendor/x b/vendor/x\nnew file mode 160000\n"
         "index 0000000..1234567\n--- /dev/null\n+++ b/vendor/x\n"
         "@@ -0,0 +1 @@\n+Subproject commit 1234567\n")
    assert not S.review(p).ok


def test_symlink_in_the_real_tree_pointing_out_is_refused(tmp_path):
    """The diff looks harmless -- 'shared/notes.txt' -- but in the REAL tree
    'shared' is a link to somewhere else, so applying it would write there."""
    root = tmp_path / "ws"
    outside = tmp_path / "elsewhere"
    root.mkdir()
    outside.mkdir()
    try:
        os.symlink(outside, root / "shared", target_is_directory=True)
    except (OSError, NotImplementedError):
        # Symlinks need Developer Mode on Windows; a junction does not, and
        # is the same hazard -- a folder that is really somewhere else.
        try:
            import _winapi
            _winapi.CreateJunction(str(outside), str(root / "shared"))
        except Exception:
            pytest.skip("this machine can create neither symlinks nor junctions")
    r = S.review(_patch("shared/notes.txt"), root=root)
    assert not r.ok
    assert "outside" in r.refused[0][1].lower()


def test_real_tree_containment_passes_for_a_normal_file(tmp_path):
    (tmp_path / "src").mkdir()
    assert S.review(OK_EDIT, root=tmp_path).ok


def test_prefix_confines_a_subfolder_workspace():
    """A workspace that is a subfolder of a bigger repo may only change files
    under that subfolder."""
    assert S.review(_patch("web/app.js"), prefix="web/").ok
    r = S.review(_patch("server/app.py"), prefix="web/")
    assert not r.ok and "outside" in r.refused[0][1].lower()


# ── size ───────────────────────────────────────────────────────────────────

def test_an_oversized_diff_is_refused_with_a_sentence_not_truncated():
    big = _patch("big.txt", body="+" + "x" * 100 + "\n") * 1
    huge = big + "".join(_patch(f"f{i}.txt", body="+" + "y" * 5000 + "\n")
                         for i in range(S.MAX_PATCH_BYTES // 5000 + 5))
    r = S.review(huge)
    assert not r.ok
    assert r.files == []                    # nothing half-shown
    assert "too large" in r.message.lower()


def test_too_many_files_is_refused():
    p = "".join(_patch(f"f{i}.txt") for i in range(S.MAX_FILES + 1))
    r = S.review(p)
    assert not r.ok and str(S.MAX_FILES) in r.message


# ── quoting ────────────────────────────────────────────────────────────────

def test_git_quoted_paths_are_unquoted_before_checking():
    # git writes a path with odd characters as a C string: "a/.git\\x" etc.
    p = ('diff --git "a/.git/con\\146ig" "b/.git/con\\146ig"\n'
         "new file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n"
         '+++ "b/.git/con\\146ig"\n@@ -0,0 +1 @@\n+x\n')
    r = S.review(p)
    assert not r.ok
    assert r.refused[0][0] == ".git/config"


def test_paths_with_spaces_parse():
    r = S.review(_patch("my docs/read me.txt"))
    assert r.ok and r.files[0].path == "my docs/read me.txt"


def test_per_file_diff_is_capped_for_the_card_but_counts_are_exact():
    body = "".join(f"+line {i}\n" for i in range(12000))
    r = S.review(_patch("long.txt", body=body))
    f = r.files[0]
    assert f.adds == 12000
    assert len(f.diff) <= S.CARD_DIFF_BYTES + 200
    assert f.truncated
