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
    # Track F: notes added mid-run send even a sole answer through synthesis.
    assert "elif len(responded) == 1 and not additions:" in orch, (
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
    import inspect
    from magi.code import security, tasks
    assert "Read or Write.</b> A page opens in <b>Read</b>" in HOW
    assert "__APPROVE_MIN__" in HOW, "spell the approval window as __APPROVE_MIN__"
    m = re.search(r"const APPROVE_MIN = (\d+);", PAGE)
    assert m and int(m.group(1)) * 60 == tasks.APPROVAL_TIMEOUT
    # "refused before you are asked" -- the deny-list the sentence names.
    for d in (".git", ".ssh", ".claude", ".codex"):
        assert d in security._DENY_DIRS, d
    assert security.check_path(".env") and security.check_path("../x")
    # "A1 is writable too, but never committed or pushed from here ... MAGI
    # only fetches it" (Phase 14b) -- one policy, asked by the engine.
    from magi.code import sandbox as SB
    assert "A1 is writable too, but never committed or pushed from here" in HOW
    assert SB.ENGINE_REPO == {"write": True, "commit": False, "push": False,
                              "pull": False, "auto": False}
    src = inspect.getsource(tasks)
    assert src.count("engine_repo_allows") >= 4       # pull, apply, commit, push
    # "A change to the engine's own code under magi/ says so on the card",
    # "approving a change in A1 ships it -- the card says so, and names
    # anything that deploys", "refuses edits under .github/".
    assert '"engine_files"' in src and "ev.engine_files" in PAGE
    assert '"deploy_files"' in src and "ev.ships && open" in PAGE
    assert ".github/" in SB.ENGINE_REPO_DENY and "deny=sandbox.review_deny(sb.repo)" in src
    # "A page opens in Read ... stays on ... until you switch back".
    assert 'rw: "read",' in PAGE
    assert 'CODE.rw = "read";' not in PAGE.split("async function codeRun()", 1)[1][:2000]
    # "Manual or Auto ... a file MAGI's review refuses is still refused, and if
    # the project's automatic check fails the card comes back".
    routes = (Path(__file__).resolve().parents[1] / "code" / "routes.py").read_text(encoding="utf-8")
    assert '"auto_approve"' in routes and 'ap: "manual",' in PAGE
    tsrc = (Path(__file__).resolve().parents[1] / "code" / "tasks.py").read_text(encoding="utf-8")
    assert 'failed_check = t.check_result is not None' in tsrc
    assert tsrc.index("security.review") < tsrc.index('t.approve == "auto"')
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
    assert "G.pull if pull else G.fetch_only" in src and G.fetch_only
    from magi.code import sandbox as _SB
    assert _SB.ENGINE_REPO["pull"] is False, "A1 is fetched, never pulled"
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
    assert 'engine_repo_allows, root, "push"' in push_route and "read_only_project" in push_route
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


def test_the_auto_commit_claims_still_hold():
    """Phase 12: off by default, magi: prefix, window, refusals, clean pull,
    never A1."""
    import inspect
    from magi.code import autocommit as AC, workspace as W
    assert "Auto commit and Auto push are off until you switch them on" in HOW
    # "off until you switch them on".
    assert W.DEFAULT_PREFS["autoCommit"] is False and W.DEFAULT_PREFS["autoPush"] is False
    # "a “magi:” message" and "3 minutes unless you pick another".
    assert AC.PREFIX == "magi: " and AC.DEFAULT_WINDOW_MIN == 3
    assert W.DEFAULT_PREFS["batchWindowMin"] == 3
    # "Commit now and Cancel" on the line.
    assert '"Commit now"' in PAGE and "/auto/${what}" in PAGE
    # "refused ... other files staged, a merge or rebase, HEAD detached".
    src = inspect.getsource(AC.check)
    assert '"staged"' in src and '"in_progress"' in src and '"detached"' in src
    # "pushes only if the pull came back clean; never forced".
    push = inspect.getsource(AC._push)
    assert push.index("G.pull(") < push.index("G.push(") and "if not pl.ok" in push
    # "Both stay off for A1": the guard and the route both check.
    assert "_engine_repo(root)" in inspect.getsource(AC.guard_prefs)
    routes = (REPO / "magi" / "code" / "routes.py").read_text(encoding="utf-8")
    assert "is_engine_repo" in routes.split("async def set_auto(")[1].split("@router")[0]

def test_the_engine_guard_claims_still_hold():
    """Phase 14: agents are refused, except the GitHub tools; foreign pages
    are refused before anything runs; a file:// copy is not let in."""
    import inspect
    from magi import agent_guard as G, app as A
    from magi.code.agents import _proc
    assert "Coding agents cannot drive MAGI" in HOW
    # "every agent runs in a Windows job".
    assert "agent_guard.adopt(self.p)" in inspect.getsource(_proc.Stream.__init__)
    # "any request from a process in that job is turned away, except
    # Claude's read-only GitHub tools".
    mw = inspect.getsource(A._require_token)
    assert "agent_guard.decide(" in mw
    assert G._READ_OK.match("/api/code/projects/p1/repo/issues/3")
    assert not G._READ_OK.match("/api/code/tasks/t1/approve")
    # "A web page from anywhere but MAGI's own is turned away ... before
    # anything runs": checked first in the middleware.
    assert mw.index("_foreign_origin(request)") < mw.index("await call_next(request)")
    # "a copy opened straight from disk is no longer let in".
    assert "null" not in A._allowed_origins()
    assert "http://127.0.0.1:8000/" in HOW


def test_the_workspace_tools_claims_still_hold():
    """Track V: what each agent can do in Write."""
    from magi.code import ws_mcp as W
    from magi.code.agents import browser as B, claude_cli as CC, edits as E
    assert "What each agent can do in Write" in HOW
    # "moves, renames, copies and deletes files and folders ... no shell".
    assert {t["name"] for t in W.TOOLS} == {"move_path", "copy_path", "delete_path", "make_dir"}
    assert "Bash" not in CC.WRITE_TOOLS and "Bash" not in CC.READ_TOOLS
    # "DELETE, MOVE and COPY lines" and "a FIND across the whole project".
    for w in ("DELETE: ", "MOVE: ", "COPY: "):
        assert w in E.FORMAT_HELP
    assert "FIND: " in B._READ_FRAME
    # "that one command, never another": run_check takes no arguments.
    assert W.RUN_CHECK["inputSchema"]["properties"] == {}
    # The switch exists in the sheet and is what is sent.
    assert "Agents may run it" in PAGE and "timeout_min: mins, agents }" in PAGE


def test_the_also_read_claims_still_hold():
    """Track V: reference folders are read, never changed."""
    import inspect
    from magi.code import routes as RT, ws_mcp as W
    from magi.code.agents import claude_cli as CC
    assert "Also read other workspaces" in HOW
    # "never changed": no reference tool writes, and Write mode adds no --add-dir.
    assert all(t["annotations"].get("readOnlyHint") for t in W.REF_TOOLS)
    assert "if not write:" in inspect.getsource(CC.build_argv)
    # "Only workspaces you added, with a folder on the engine's PC".
    src = inspect.getsource(RT._task_refs)
    assert "code_project(pid, eng)" in src and 'b.get("here")' in src
    # "the choice is kept on each device": localStorage, not the synced field.
    assert 'const CODE_REFS_KEY = lsKey("code.refs");' in PAGE


def test_the_sync_claims_still_hold():
    """Phase 13: what travels, what never does, one write per change, no
    listener of its own, nothing while a task runs, A1 still off."""
    import inspect
    from magi.code import routes as RT, sync as S
    assert "Your projects follow you between devices" in HOW
    # "Folder paths, tokens and logins never leave the PC": the view has none.
    view = inspect.getsource(S.view)
    assert "root" not in view and "token" not in view
    # "no extra listener": one onSnapshot in the whole page.
    assert PAGE.count(".onSnapshot(") == 1
    # "nothing is written while a task runs".
    assert "if (codeBusy()) { CODE_SYNC.held = true; return; }" in PAGE
    # "one write per change however fast you tap": the debounce.
    assert "_codeT = setTimeout(codeFlush, 900);" in PAGE
    # "A1's switches stay off whatever a synced copy says".
    assert "await _guarded(here, row[\"prefs\"])" in inspect.getsource(RT.sync_apply)
    # "Model choices and caps stay on each engine": not in the field.
    blk = PAGE[PAGE.index("/* ══ CODE MODE, ACROSS YOUR DEVICES"):PAGE.index("/** Share a token this browser has.")]
    assert "code_models" not in blk and "/models/" not in blk
    # "Open a task from Code Mode's History".
    assert "codeOpenHistory(r)" in PAGE and 'id="navCodeHistory"' in PAGE


def test_the_one_word_exemption_is_what_the_panel_says():
    """Step 3: bare words are not counted -- unless you asked for one word."""
    from magi.engine.validate import Rejection, validate_answer
    assert "when &ldquo;Four&rdquo; is exactly the answer" in HOW
    assert validate_answer("Four", "What is 2+2? One word.").ok
    assert validate_answer("Four", "Explain TCP.").reason is Rejection.TRUNCATED
    assert validate_answer("Searching", "What is 2+2? One word.").reason is Rejection.TRUNCATED


def test_the_brainstorm_step_line_is_what_the_panel_says():
    """Every step it names is one the engine announces, and init replays it."""
    assert "Reloading the page mid-round shows the same step" in HOW
    app = (REPO / "magi" / "app.py").read_text(encoding="utf-8")
    for phase in ("critique", "merging", "writing", "reviewing"):
        assert f'_bs_phase(state, "{phase}"' in app or f'state, "{phase}",' in app, phase
    assert '"phase": state.get("phase", "council")' in app


def test_the_model_chip_claims_still_hold():
    """Phase U2: which units have a chip, and what makes it amber."""
    assert "Each card names the model that answered" in HOW
    sites = yaml.safe_load((REPO / "magi" / "config" / "selectors.yaml").read_text(encoding="utf-8"))["sites"]
    # "Perplexity's free plan and DeepSeek name no model anywhere".
    assert sites["perplexity"]["model_label"] == [] and sites["deepseek"]["model_label"] == []
    for sid in ("claude", "gemini", "grok", "chatgpt"):
        assert sites[sid]["model_label"], sid
    # "only on the site's own evidence".
    from magi.providers.browser_base import fallback_note
    assert fallback_note("", "gpt-5-6-mini") == ""
    assert fallback_note("Sonnet 5.5 Medium", "Haiku 4.5")
    # "reported as Prompt too long".
    assert 'prompt_too_long: "Prompt too long"' in PAGE
    assert "Your own words are never read as a limit" in HOW


def test_the_units_limits_claims_still_hold():
    """Phase U3: the Units sheet's limits, and what it promises not to do."""
    assert "limits are in the Units sheet" in HOW
    from magi.engine import units
    # The five words it names are the engine's own headlines.
    for word in ("OK", "Limited", "Near limit", "Fell back", "Signed out"):
        assert word in units.HEADLINE.values(), word
    # "no browser is opened for it, and nothing checks on a timer": the one
    # route that launches is a POST the console sends only from a tap.
    assert PAGE.count("/api/units/${encodeURIComponent(id)}/check") == 1
    assert "chk.onclick = () => unitCheckNow(id)" in PAGE
    # "Only Claude (Pro) has real numbers".
    assert units.PRO_UNIT == "claude-pro"
    # "The Doctor's limit section reads the same verdict".
    assert "if (d.unit) {" in PAGE[PAGE.index("function docActiveLimits"):][:600]


def test_the_model_choice_claims_still_hold():
    """Phase U4: the Units sheet's Model dropdown, and what it promises."""
    assert "Choose each unit&rsquo;s model in the Units sheet" in HOW
    from magi.browser import picker
    from magi.settings import load_settings
    s = load_settings()
    # "under Claude, Claude (Pro), Gemini and Grok, the only sites with a
    # picker ... (ChatGPT, Perplexity and DeepSeek answer on their default)".
    have = {u for u in s.sites if picker.has_picker(s.site(u))}
    assert have == {"claude", "claude-pro", "gemini", "grok"}
    # "Site default is first".
    box = PAGE[PAGE.index("function unitPickBox"):][:2000]
    assert box.index('"Site default"') < box.index("for (const m of u.models")
    # "Asked for X, got Y" is the engine's own wording.
    assert picker.asked_note({"name": "X"}, "Y") == "Asked for X, got Y"
    # "Refresh models opens that site once": the one launching route is a
    # POST sent only from its button.
    assert PAGE.count("/models/refresh`") == 1
    assert "ref.onclick = () => unitRefreshModels(id)" in PAGE


def test_the_effort_choice_claims_still_hold():
    """2026-10-01: effort / thinking as part of the pick."""
    assert "Effort and thinking are part of the pick." in HOW
    from magi.browser import picker
    from magi.settings import load_settings
    s = load_settings()
    # "Claude and Claude (Pro) have Effort (Low, Medium, High, Extra, Max),
    # Gemini has Extended thinking, ChatGPT Think and DeepSeek DeepThink".
    got = {u: (picker.effort_label(s.site(u)), picker.effort_options(s.site(u)))
           for u in s.sites if picker.effort_kind(s.site(u))}
    levels = ["Low", "Medium", "High", "Extra", "Max"]
    assert got == {"claude": ("Effort", levels), "claude-pro": ("Effort", levels),
                   "gemini": ("Extended thinking", ["on", "off"]),
                   "chatgpt": ("Think", ["on", "off"]), "deepseek": ("DeepThink", ["on", "off"])}
    assert "(Low, Medium, High, Extra, Max)" in HOW
    # "Site default leaves it as the site has it": first in the dropdown.
    row = PAGE[PAGE.index("function unitEffortRow"):][:1500]
    assert row.index('"Site default"') < row.index("for (const v of e.options")
    # "Asked for ..., left as the site had it" is the engine's wording.
    assert picker._effort_note(s.site("deepseek"), "on") == "Asked for DeepThink on, left as the site had it"
    assert "left as the site had it" in HOW


def test_the_followup_claims_still_hold():
    """Track F2: follow-ups, adding to a run, and continuing from History."""
    assert "Follow-ups: a deliberation is a conversation" in HOW
    from magi.engine import chairman, session
    # "your addition wins where it conflicts with the question".
    assert "they override the question where they conflict" in chairman.ADDITIONS_BLOCK
    # "Up to ten per run" -- the console's cap is the engine's.
    assert session.MAX_NOTES == 10 and "Up to ten per run" in HOW
    assert "const MAX_RUN_NOTES = 10;" in PAGE
    assert f"const MAX_NOTE_CHARS = {session.MAX_NOTE_CHARS};" in PAGE
    # The console keeps the context under the engine's cap.
    cap = int(PAGE.split("const CONTEXT_MAX_CHARS = ")[1].split(";")[0])
    assert cap < session.MAX_CONTEXT_INPUT
    # The three labels it names are the ones the button shows.
    for word in ("Follow up", "Add to run"):
        assert f"<b>{word}</b>" in HOW and f'"{word}"' in PAGE
    # "never after a Halt": a cancelled run's notes are a draft, not a send.
    assert 'msg.status !== "cancelled"' in PAGE
    # "A pin, a name, the 30-day window and Delete all apply to the whole session."
    assert "const isPinned = (r) => PINS.has(sessionKey(r));" in PAGE
    assert "for (const id of ids) await CLOUD.fs.deleteDoc(_runDoc(id));" in PAGE


def test_the_code_followup_claims_still_hold():
    """Track F4: Code Mode follow-ups, messages mid-task, continuing from History."""
    assert "Follow-ups in Code Mode: a task is a conversation too" in HOW
    from magi.code import followup
    # "Up to twenty per task" -- the console's cap is the engine's.
    assert followup.MAX_MESSAGES == 20 and "Up to twenty per task" in HOW
    assert "const MAX_TASK_MESSAGES = 20;" in PAGE
    assert f"const MAX_TASK_MESSAGE_CHARS = {followup.MAX_MESSAGE_CHARS};" in PAGE
    cap = int(PAGE.split("const CODE_SESSION_MAX_CHARS = ")[1].split(";")[0])
    assert cap < followup.MAX_INPUT_CHARS
    # The labels it names are the ones the button shows.
    for word in ("Follow up", "Send"):
        assert f"<b>{word}</b>" in HOW and f'"{word}"' in PAGE
    assert '"Follow up · edits"' in PAGE and "Follow up &middot; edits" in HOW
    # "says what is actually in your folder": the engine's ground-truth note.
    assert "WHAT IS ACTUALLY IN THE PROJECT NOW" in followup.state_note(
        [{"prompt": "p", "mode": "write", "write": "denied"}])
    # "picks up its own session" only on this PC: native goes only to its engine.
    assert "last.engine === engineId" in PAGE
    # "Interrupted -- continuing with your message" is what the log says.
    assert "Interrupted — continuing with your message" in PAGE
    assert "Interrupted &mdash; continuing with your message" in HOW
    # "never after a Halt": a cancelled task's held messages are a draft.
    assert 'r.outcome !== "cancelled" && !t.halting' in PAGE
    # "choosing another workspace does too"
    assert "sess.projectId !== id && !codeBusy()" in PAGE
    # "Pins, names, the 30-day window and Delete apply to the whole session."
    assert "const codePinned = (r) => CODE_PINS.has(codeSessKey(r));" in PAGE
    assert "for (const id of ids) {\n      CLOUD.fs.deleteDoc(_codeTaskDoc(id))" in PAGE.replace("\r\n", "\n")
    # "it says so instead of quietly starting a new session"
    assert "has no folder on this engine" in PAGE


def test_the_change_other_workspaces_claims_still_hold():
    """Track V3: one card, a copy each, whole or not at all, up to 4."""
    import inspect
    from magi.code import routes as RT, sandbox as SB, tasks as TK
    assert "Change other workspaces too" in HOW
    # "Up to 4, each in a git repository of its own".
    assert RT.MAX_TASK_WRITES == 4 and "same repository" in inspect.getsource(RT._task_writes)
    assert "const CODE_WRITES_MAX = 4;" in PAGE
    # "its own private copy": one sandbox per workspace.
    assert "sandbox.create, Path(w.root)" in inspect.getsource(TK.start)
    # "every part is applied together or none of it is".
    src = inspect.getsource(SB.apply_all)
    assert "_restore(sb, saved)" in src and '"held"' in src
    # "In Read mode they are only read".
    assert 'mode == "write" and raw_writes' in inspect.getsource(RT.start_task)
    # "one commit in each repository" / "each as its own project's account".
    assert "G.commit, Path(x[\"repo\"])" in inspect.getsource(TK._commit_parts)
    assert 'x.get("github")' in inspect.getsource(TK._push_parts)
