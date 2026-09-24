"""The "How it works" panel has to stay true.

It is the only documentation most people will ever read, and a confidently
wrong explanation is worse than none: it teaches you to expect behaviour the
program does not have, and then the program looks broken.

Prose cannot be tested. What CAN be tested is that the specific, checkable
claims it makes still describe the code -- the status words the doctor
actually emits, the units that actually exist, the retention window, the
places it promises an unticked unit is never used. Each assertion below fails
loudly enough to say which sentence has gone stale.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import yaml  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
PAGE = (REPO / "magi.html").read_text(encoding="utf-8")


def _panel() -> str:
    """The HOW array only -- claims elsewhere in the file are not this test's."""
    start = PAGE.index("const HOW = [")
    end = PAGE.index("let _howOpen", start)
    return PAGE[start:end]


HOW = _panel()


def test_the_panel_exists_and_is_reachable_from_both_headers():
    """A help panel only in the sidebar is help you must already know to find.

    On a phone the sidebar is a shut drawer.
    """
    assert 'id="helpBtn"' in PAGE and 'id="helpBtnM"' in PAGE
    assert '"helpBtn", "helpBtnM"' in PAGE
    assert "b.onclick = openHow" in PAGE


def test_the_background_is_frozen_while_it_is_open():
    """Asked for explicitly: no scrolling and no interacting behind the panel.

    `overflow: hidden` on the root is not enough on iOS, which scrolls the
    nearest scrollable ancestor anyway -- and .page IS that ancestor here.
    """
    assert "modal-open" in PAGE
    assert "html.modal-open .page" in PAGE
    assert "backdrop-filter: blur" in PAGE


def test_the_retention_window_is_not_typed_out():
    """A number written twice is a number that will disagree with itself."""
    assert "__DAYS__" in HOW, "the history section should interpolate HISTORY_DAYS"
    assert re.search(r"const HISTORY_DAYS = \d+", PAGE)
    # ...and nowhere in the panel is a day count spelled out by hand.
    assert not re.search(r"\b\d+ days\b", HOW.replace("__DAYS__ days", "")), (
        "spell the retention window as __DAYS__, not as a literal"
    )


def test_the_doctor_status_words_are_the_ones_the_doctor_emits():
    """The panel teaches four labels. The table must still show those four."""
    for label in ("OK", "FALLBACK", "MISS", "n/a"):
        assert f">{label}<" in HOW or f"<b>{label}</b>" in HOW or f'"{label}"' in HOW, label
        assert f'"{label}"' in PAGE, f"renderDoctor no longer emits {label}"


def test_every_unit_the_panel_names_still_exists():
    """Naming a model MAGI cannot drive is the most embarrassing kind of stale."""
    sites = yaml.safe_load(
        (REPO / "magi" / "config" / "selectors.yaml").read_text(encoding="utf-8")
    )["sites"]
    names = {s.get("display_name", sid) for sid, s in sites.items()}
    # Substring, not equality: a display name may qualify the account it is
    # signed in to ("Claude (free)", "Claude (Pro)") and that is still Claude.
    # Exact matching read those as Claude being unconfigured, which is the
    # opposite of true and would have had someone deleting it from the panel.
    def configured(model: str) -> bool:
        return any(model in n for n in names)

    for claimed in ("ChatGPT", "Claude", "Gemini", "DeepSeek"):
        assert configured(claimed) == (claimed in HOW), (
            f"{claimed} is named in the panel but not configured, or vice versa"
        )


def test_the_selectors_file_it_points_you_at_is_where_it_says():
    assert "magi/config/selectors.yaml" in HOW
    assert (REPO / "magi" / "config" / "selectors.yaml").exists()


def test_it_does_not_promise_a_chairman_pass_for_a_single_unit():
    """The panel says SOLE UNIT and "no chairman pass". Both must hold."""
    assert "SOLE UNIT" in HOW
    assert "SOLE UNIT" in PAGE, "updateCore no longer renders SOLE UNIT"
    orch = (REPO / "magi" / "engine" / "orchestrator.py").read_text(encoding="utf-8")
    assert "elif len(responded) == 1:" in orch, (
        "the single-unit short circuit is gone; the panel still promises it"
    )


def test_it_promises_the_doctor_runs_in_parallel_and_scoped():
    assert "in parallel" in HOW
    app = (REPO / "magi" / "app.py").read_text(encoding="utf-8")
    doctor = app[app.index('@app.post("/api/doctor")'):]
    doctor = doctor[: doctor.index("# ── the UI")]
    assert "asyncio.gather" in doctor, "the doctor is sequential again"
    assert "providers.split" in doctor, "the doctor no longer takes a selection"


def test_it_promises_refine_respects_the_gemini_tick_box():
    """The specific claim: unticking Gemini stops the API refiner too."""
    assert "Gemini API key" in HOW
    app = (REPO / "magi" / "app.py").read_text(encoding="utf-8")
    assert "API_PROVIDER_UNIT" in app
    assert "def _refiner_id(allowed" in app


def test_it_promises_nothing_is_written_mid_run():
    """One finished deliberation is one write -- the whole sync budget rests
    on this, and the panel states it as a fact."""
    assert "while a run is in flight" in HOW
    # cloudPushRun is called from the SSE `done` handler and from backfill, and
    # from nowhere that runs per frame.
    assert PAGE.count("cloudPushRun(") <= 4, (
        "cloudPushRun has new callers; check none of them fire during a run"
    )


def test_the_code_mode_write_claims_still_hold():
    """Write mode's paragraph makes promises about safety. Each is checked
    against the code that keeps it, so the panel cannot drift into claiming a
    protection that no longer exists."""
    from magi.code import security, tasks
    assert "Read or Write, per task" in HOW
    assert "__APPROVE_MIN__" in HOW, "spell the approval window as __APPROVE_MIN__"
    m = re.search(r"const APPROVE_MIN = (\d+);", PAGE)
    assert m and int(m.group(1)) * 60 == tasks.APPROVAL_TIMEOUT
    # "refused before you are asked" -- the deny-list the sentence names.
    for d in (".git", ".ssh", ".claude", ".codex"):
        assert d in security._DENY_DIRS, d
    assert security.check_path(".env") and security.check_path("../x")
    # "A1 itself stays read-only" -- enforced by the engine, not only the switch.
    routes = (REPO / "magi" / "code" / "routes.py").read_text(encoding="utf-8")
    assert "read_only_project" in routes and "is_engine_repo" in routes
    # "Every task starts in Read".
    assert 'rw: "read",' in PAGE
    # "a window whose reset time has passed shows 0%".
    assert "function usageLive(u)" in PAGE


def test_the_code_mode_git_claims_still_hold():
    """Phase 9's paragraphs: pull first, A1 fetched only, commit exactly the
    applied files, hooks run, nothing pushed."""
    from magi.code import git as G, tasks
    assert "Every task starts by pulling" in HOW
    src = (REPO / "magi" / "code" / "tasks.py").read_text(encoding="utf-8")
    # "before any agent reads the folder" -- the pull comes before the chain.
    assert src.index("await _pull_first(t, root)") < src.index("chain.run_chain(")
    # "A1 itself is only fetched, never pulled".
    assert "G.fetch_only if own else G.pull" in src
    # "If the pull clashes ... it is undone".
    gsrc = (REPO / "magi" / "code" / "git.py").read_text(encoding="utf-8")
    assert '"rebase", "--abort"' in gsrc
    # "exactly the files that were applied" + "your hooks run" + "nothing is pushed".
    assert "Commit these files" in HOW and "Commit these files" in PAGE
    assert '"--only"' in gsrc
    # The hooks-off override is set only when a caller asks for it (the
    # sandbox); commit() goes through _run, which never sets it.
    assert gsrc.count("core.hooksPath") == 1 and "if hooks_path is not None" in gsrc
    assert hasattr(tasks, "commit")
    # "Nothing is pushed until you press Push" -- the only push is git.push,
    # called from the two push routes and tasks.push, never from a task run.
    assert "Nothing is pushed until you press Push" in HOW
    assert "G.push" not in src.split("async def push(")[0]


def test_the_code_mode_push_claims_still_hold():
    """Phase 10's paragraphs: a third press, as the chosen account, never
    forced, nothing without an account, A1 never, tokens never shown."""
    from magi.code import git as G
    from magi.github import accounts as A, askpass
    assert "Push is a third press" in HOW and "GitHub tokens stay on the engine PC" in HOW
    gsrc = (REPO / "magi" / "code" / "git.py").read_text(encoding="utf-8")
    routes = (REPO / "magi" / "code" / "routes.py").read_text(encoding="utf-8")
    # "never forced": the refspec is spelled out with no '+', and no force flag exists.
    assert 'f"refs/heads/{st.branch}:refs/heads/{rbranch}"' in gsrc
    assert "--force" not in gsrc and '"-f"' not in gsrc
    # "refused ... if GitHub has commits you do not".
    assert '"behind"' in gsrc
    # "With no account chosen, an HTTPS remote is not pushed at all".
    assert '"no_account"' in gsrc
    # "not as whatever login this PC remembers": helpers cleared first.
    assert G.Auth("x", "s").config()[:2] == ["-c", "credential.helper="]
    # "only for github.com": the askpass refuses any other host.
    env = {"MAGI_GH_SERVICE": "s", "MAGI_GH_LOGIN": "x", "MAGI_GH_HOST": "github.com"}
    assert askpass.answer("Username for 'https://evil.example': ", env) is None
    # "A1 is never pushed from here".
    push_route = routes.split("async def push_project(")[1]
    assert "is_engine_repo" in push_route and "read_only_project" in push_route
    # "never shows it again": the public record has no token field.
    # (behaviourally: test_github_client greps every response for a sentinel)
    import inspect
    assert '"token"' not in inspect.getsource(A.list_accounts)
    assert "token(" not in inspect.getsource(A.list_accounts)
    # The HOW panel names the places the console actually has.
    assert "Accounts &rsaquo; GitHub" in HOW and "function renderGhAccounts()" in PAGE
    assert "Push &uarr;n" in HOW and "`Push ↑${n}`" in PAGE



def test_the_repository_panel_claims_still_hold():
    """Phase 11: read-only, fetched on open, the watch stops, no token for Claude."""
    assert "The Repository pill opens the repository itself" in HOW
    routes = (REPO / "magi" / "code" / "routes.py").read_text(encoding="utf-8")
    repo_routes = routes.split("# ── the Repository panel (Phase 11)")[1].split("# ── models, credits, caps")[0]
    # "Nothing in it can change the repository": the panel's routes are all GETs.
    assert "@router.get(" in repo_routes and "@router.post(" not in repo_routes
    assert "@router.delete(" not in repo_routes
    # "every 20 seconds only while one is still going, then stops".
    assert "const WATCH_EVERY_MS = 20000;" in PAGE and "every 20 seconds" in HOW
    assert 'w.state === "pending" || (w.state === "none"' in PAGE
    # "never holds a token": the MCP server is stdlib, talks to loopback only.
    mcp = (REPO / "magi" / "github" / "mcp_server.py").read_text(encoding="utf-8")
    assert "http://127.0.0.1:" in mcp and "keyring" not in mcp and "accounts" not in mcp
    assert "Diagnose" in HOW and "Watch" in HOW


def test_the_model_claims_still_hold():
    """Phase 11B: Auto is local, credits gate models, caps stop mid-task."""
    from magi.code.agents import models as M
    assert "Each agent has a model, or Auto" in HOW
    # "without asking a model which model to ask": classify is pure.
    assert M.classify("what does x do?")["tier"] == 1
    import inspect
    src = inspect.getsource(M.classify) + inspect.getsource(M.choose)
    assert "urlopen" not in src and "_http_json" not in src and "Stream" not in src
    # "Fable runs only on usage credits" on Pro, seeded and live-verified.
    assert "fable" in M.CREDIT_FAMILIES and "pro" in M.CREDIT_PLANS
    # "notices within a few minutes": credits come from the usage read.
    fetch = (REPO / "magi" / "code" / "agents" / "usage_fetch.py").read_text(encoding="utf-8")
    assert "limits.note_account(agent, slot, acct)" in fetch
    # "even mid-task": both agents run the cap watch and trip on it.
    for f in ("claude_cli.py", "codex_cli.py"):
        src = (REPO / "magi" / "code" / "agents" / f).read_text(encoding="utf-8")
        assert "models.cap_watch(" in src and "trip(" in src
    # "a free account: one 30-day window" -- named as the UI names it.
    assert M.window_label("30d") == "30-day"
    # "once per window per reset": the alert key carries the reset time.
    assert "resets_at') or ''}:{level}" in inspect.getsource(M.alerts)
    assert "Stop at" in HOW and '"Stop at"' in PAGE


def test_the_cli_update_claims_still_hold():
    """Claude Code and Codex keep themselves current -- never mid-task."""
    import inspect
    from magi.code.agents import models as M, updates as U
    assert "keep themselves current" in HOW and "Update now" in HOW
    # "Auto-update on (the default)".
    assert M.default_prefs()["auto_update"] is True
    # "never while a task or a sign-in is running".
    src = inspect.getsource(U.busy)
    assert "tasks.running()" in src and "login.JOBS" in src
    assert "busy()" in inspect.getsource(U.start) and "busy()" in inspect.getsource(U.auto_tick)
    # "the agent sits out new tasks for the minute it takes".
    for f in ("claude_cli.py", "codex_cli.py"):
        assert "updates.updating(" in (REPO / "magi" / "code" / "agents" / f).read_text(encoding="utf-8")
    # "every few hours -- at once when a model is waiting".
    assert U.LATEST_TTL <= 6 * 3600 and "waiting or now" in inspect.getsource(U.auto_tick)
    # "Update now" is really on the sheet.
    assert '"Update now"' in PAGE and "function renderCliCard(" in PAGE
