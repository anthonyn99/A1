"""MAGI's half of the A1 self-cleanup.

What counts as trash is not decided here. It is listed in cleanup-rules.json
at the repo root, which the browser sweeper (sweep.js) and the tests read too.
This runs that file's "disk" items whose program is "magi", for the active
profile:

* on engine startup (app.py lifespan), and
* once a day from the watchdog, off the engine's own process.

Local disk costs no quota, so the only limits are the safety ones:

* Fail closed. Rules that won't load, or a shape this code does not know (an
  unknown `test`, a glob that leaves magi/artifacts or magi/data), delete
  nothing that run.
* An item with "delete": false is a dry run. Its files are listed in
  data/<profile>/sweep.json and left where they are.
* Never the database, uploads or browser profiles, whatever a glob says.
  The one thing under magi/profiles it may touch is a Codex slot's session
  rollouts (`CODEX_ROLLOUTS`): since Track F they persist so a follow-up
  can resume, and nothing else ever removes them.
"""

from __future__ import annotations

import json
import time
from datetime import datetime
from pathlib import Path

from . import settings as S

DAY = 86400
_TESTS = ("zero-bytes", "no-sibling:")
_NEVER_SUFFIXES = (".db", ".db-wal", ".db-shm", ".sqlite")
# The only glob allowed under magi/profiles: Codex rollouts, nothing beside
# them (auth.json and config live one level up, browser profiles elsewhere).
CODEX_ROLLOUTS = "profiles/{profile}/cli/codex-*/sessions/"


def _codex_rollout(p: Path) -> bool:
    parts = p.relative_to(S.ROOT).parts
    return (len(parts) >= 6 and parts[0] == "profiles" and parts[2] == "cli"
            and parts[3].startswith("codex-") and parts[4] == "sessions"
            and p.name.startswith("rollout-") and p.suffix.lower() == ".jsonl")


def rules_path() -> Path:
    return S.ROOT.parent / "cleanup-rules.json"


def _state_path() -> Path:
    return S.data_dir() / "sweep.json"


def load_rules(path: Path | None = None) -> list[dict]:
    """The MAGI disk items, checked. Raises ValueError on anything unexpected."""
    rules = json.loads((path or rules_path()).read_text(encoding="utf-8"))
    if rules.get("version") != 1 or not isinstance(rules.get("items"), list):
        raise ValueError("cleanup-rules.json: bad shape")
    out = []
    for it in rules["items"]:
        if it.get("program") != "magi":
            continue
        if it.get("store") != "disk":
            raise ValueError(f"{it.get('id')}: MAGI only sweeps disk")
        if not isinstance(it.get("delete"), bool) or not isinstance(it.get("capDays"), (int, float)):
            raise ValueError(f"{it.get('id')}: lacks delete/capDays")
        if it["capDays"] < 1:
            raise ValueError(f"{it.get('id')}: a disk item needs an age of at least a day")
        glob = it.get("glob") or ""
        rollouts = glob.startswith(CODEX_ROLLOUTS) and glob.endswith(".jsonl")
        if not (glob.startswith("artifacts/") or glob.startswith("data/") or rollouts) \
                or ".." in glob:
            raise ValueError(f"{it.get('id')}: glob leaves magi/artifacts and magi/data")
        test = it.get("test")
        if test is not None and not any(test.startswith(t) for t in _TESTS):
            raise ValueError(f"{it.get('id')}: unknown test {test!r}")
        out.append(it)
    return out


def _is_trash(it: dict, p: Path, now: float) -> bool:
    st = p.stat()
    if now - st.st_mtime < it["capDays"] * DAY:
        return False
    test = it.get("test")
    if test == "zero-bytes":
        return st.st_size == 0
    if test and test.startswith("no-sibling:"):
        return not p.with_name(p.stem + test[len("no-sibling:"):]).exists()
    return True


def _protected(p: Path) -> bool:
    if _codex_rollout(p):
        return False
    parts = {x.lower() for x in p.relative_to(S.ROOT).parts}
    return p.suffix.lower() in _NEVER_SUFFIXES or "uploads" in parts or "profiles" in parts


def plan(items: list[dict], profile: str, now: float) -> list[tuple[dict, Path]]:
    found: dict[Path, dict] = {}
    for it in items:
        for p in S.ROOT.glob(it["glob"].replace("{profile}", profile)):
            if p in found or not p.is_file() or p.is_symlink() or _protected(p):
                continue
            if _is_trash(it, p, now):
                found[p] = it
    return [(it, p) for p, it in found.items()]


def run(force: bool = False, dry_run: bool = False, now: float | None = None) -> dict:
    """One sweep. Without `force`, at most once a calendar day per profile."""
    now = time.time() if now is None else now
    day = datetime.fromtimestamp(now).strftime("%Y-%m-%d")
    try:
        state = json.loads(_state_path().read_text(encoding="utf-8"))
    except Exception:
        state = {}
    if not force and state.get("day") == day:
        return {"skipped": "already swept today"}
    rep: dict = {"day": day, "at": datetime.fromtimestamp(now).isoformat(timespec="seconds"),
                 "deleted": [], "would_delete": [], "skipped": [], "error": None}
    # Stamp first: a sweep that dies half-way must not rerun on every tick.
    try:
        _state_path().write_text(json.dumps({"day": day, "report": rep}), encoding="utf-8")
    except OSError as e:
        return {"error": f"cannot stamp: {e}"}
    try:
        targets = plan(load_rules(), S.active_profile(), now)
    except Exception as e:  # noqa: BLE001 -- fail closed
        rep["error"] = f"{type(e).__name__}: {e}"
        targets = []
    for it, p in targets:
        rel = f"{it['id']}: {p.relative_to(S.ROOT).as_posix()}"
        if not it["delete"] or dry_run:
            rep["would_delete"].append(rel)
            continue
        try:
            p.unlink()
            rep["deleted"].append(rel)
        except OSError as e:            # e.g. a log another process holds open
            rep["skipped"].append(f"{rel} ({e.strerror})")
    try:
        _state_path().write_text(json.dumps({"day": day, "report": rep}, indent=1), encoding="utf-8")
    except OSError:
        pass
    return rep


def summary(rep: dict) -> str:
    if rep.get("skipped") == "already swept today":
        return ""
    if rep.get("error"):
        return f"sweep stopped: {rep['error']}"
    return (f"sweep: deleted {len(rep.get('deleted', []))}, "
            f"would delete {len(rep.get('would_delete', []))} (dry run)")


if __name__ == "__main__":          # python -m magi.sweep  -> dry-run report now
    print(json.dumps(run(force=True, dry_run=True), indent=1))
